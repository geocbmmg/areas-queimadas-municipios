/* =====================================================================
   copernicus.js — acesso ao Copernicus Data Space Ecosystem.

   Dois caminhos de autenticação, porque o suportado e o cômodo não são
   o mesmo:

   A) LOGIN DO USUÁRIO (authorization code + PKCE, cliente `cdse-public`)
      O militar entra na página oficial do Copernicus — o app nunca vê a
      senha dele. É o que dá para pedir da tropa. Só que a documentação
      do Sentinel Hub não promete que um token de usuário seja aceito na
      Process API; por isso o app testa e, se for recusado, cai no B.

   B) CLIENTE OAuth (client_credentials)
      Caminho documentado: o usuário cria um cliente no painel do CDSE e
      cola client_id/secret uma vez. Funciona com certeza, mas exige um
      passo a mais de cada pessoa.

   Nada disso passa por servidor nosso: todos os endpoints do Copernicus
   liberam CORS, então o navegador fala direto com eles.
   ===================================================================== */
(function (glob) {
  "use strict";

  var REALM = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE";
  var URL_TOKEN = REALM + "/protocol/openid-connect/token";
  var URL_AUTORIZA = REALM + "/protocol/openid-connect/auth";
  var URL_LOGOUT = REALM + "/protocol/openid-connect/logout";
  var CLIENTE_PUBLICO = "cdse-public";

  var SH = "https://sh.dataspace.copernicus.eu/api/v1";
  var URL_PROCESSO = SH + "/process";
  var URL_CATALOGO = SH + "/catalog/1.0.0/search";

  var CHAVE_SESSAO = "mg.copernicus.sessao";
  var CHAVE_CLIENTE = "mg.copernicus.cliente";
  var CHAVE_PKCE = "mg.copernicus.pkce";

  /* ---------------- PKCE ---------------- */

  function aleatorio(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return base64url(b);
  }

  function base64url(bytes) {
    var s = "";
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function desafio(verificador) {
    var dados = new TextEncoder().encode(verificador);
    var hash = await crypto.subtle.digest("SHA-256", dados);
    return base64url(hash);
  }

  /* ---------------- sessão ---------------- */

  function guardarSessao(s) {
    try { localStorage.setItem(CHAVE_SESSAO, JSON.stringify(s)); } catch (e) {}
  }

  function lerSessao() {
    try {
      var s = JSON.parse(localStorage.getItem(CHAVE_SESSAO) || "null");
      if (s && s.expira && s.expira > Date.now() + 30000) return s;
    } catch (e) {}
    return null;
  }

  function esquecerSessao() {
    try { localStorage.removeItem(CHAVE_SESSAO); } catch (e) {}
  }

  /** Credencial de cliente OAuth guardada pelo usuário (caminho B). */
  function lerCliente() {
    try { return JSON.parse(localStorage.getItem(CHAVE_CLIENTE) || "null"); } catch (e) { return null; }
  }

  function guardarCliente(id, segredo) {
    try {
      localStorage.setItem(CHAVE_CLIENTE, JSON.stringify({ id: id, segredo: segredo }));
    } catch (e) {}
  }

  function esquecerCliente() {
    try { localStorage.removeItem(CHAVE_CLIENTE); } catch (e) {}
  }

  /* ---------------- A) login do usuário ---------------- */

  function urlRetorno() {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "copernicus-callback.html";
  }

  /* Login único: chamadas concorrentes (ex.: prévia + busca de cenas
     disparadas juntas) aguardam o MESMO popup em vez de abrir dois. */
  var loginEmCurso = null;

  function entrar() {
    if (!loginEmCurso) {
      loginEmCurso = fazerLogin().finally(function () { loginEmCurso = null; });
    }
    return loginEmCurso;
  }

  /**
   * Abre a página oficial de login do Copernicus numa janela e devolve a
   * sessão. A senha é digitada lá, não aqui.
   */
  async function fazerLogin() {
    var verificador = aleatorio(48);
    var estado = aleatorio(12);
    var dsf = await desafio(verificador);

    sessionStorage.setItem(CHAVE_PKCE, JSON.stringify({ verificador: verificador, estado: estado }));

    var url = URL_AUTORIZA +
      "?client_id=" + encodeURIComponent(CLIENTE_PUBLICO) +
      "&response_type=code" +
      "&scope=" + encodeURIComponent("openid profile email") +
      "&redirect_uri=" + encodeURIComponent(urlRetorno()) +
      "&state=" + encodeURIComponent(estado) +
      "&code_challenge=" + encodeURIComponent(dsf) +
      "&code_challenge_method=S256";

    var pop = window.open(url, "loginCopernicus", "width=560,height=700,menubar=no,toolbar=no");
    if (!pop) throw new Error("o navegador bloqueou a janela; libere os pop-ups para este endereço");

    var dados = await new Promise(function (ok, falha) {
      // três canais de retorno: postMessage, BroadcastChannel e storage —
      // os dois últimos sobrevivem quando a página de login corta o opener
      var fim = false;
      var bc = null;
      try { bc = new BroadcastChannel("copernicus-oauth"); } catch (e) {}

      function terminar(fn, arg) {
        if (fim) return;
        fim = true;
        window.removeEventListener("message", ouvirMsg);
        window.removeEventListener("storage", ouvirStorage);
        if (bc) { try { bc.close(); } catch (e) {} }
        clearInterval(vigia);
        fn(arg);
      }
      function tratar(d) {
        d = d || {};
        try { localStorage.removeItem("copernicus-oauth-retorno"); } catch (e) {}
        if (d.code) terminar(ok, d);
        else terminar(falha, new Error(d.error_description || d.error || "login não concluído"));
      }
      function ouvirMsg(ev) {
        if (ev.origin !== location.origin) return;
        var m = ev.data;
        if (m && m.tipo === "copernicus-oauth") tratar(m.dados);
      }
      function ouvirStorage(ev) {
        if (ev.key !== "copernicus-oauth-retorno" || !ev.newValue) return;
        try { tratar(JSON.parse(ev.newValue).dados); } catch (e) {}
      }
      window.addEventListener("message", ouvirMsg);
      window.addEventListener("storage", ouvirStorage);
      if (bc) bc.onmessage = function (ev) {
        if (ev.data && ev.data.tipo === "copernicus-oauth") tratar(ev.data.dados);
      };

      var vigia = setInterval(function () {
        if (!pop.closed) return;
        clearInterval(vigia);
        setTimeout(function () {
          if (fim) return;
          try {
            var bruto = localStorage.getItem("copernicus-oauth-retorno");
            if (bruto) {
              var reg = JSON.parse(bruto);
              if (reg && Date.now() - reg.t < 120000) { tratar(reg.dados); return; }
            }
          } catch (e) {}
          terminar(falha, new Error("janela de login fechada antes de concluir"));
        }, 800);
      }, 700);
    });

    var pkce = JSON.parse(sessionStorage.getItem(CHAVE_PKCE) || "{}");
    sessionStorage.removeItem(CHAVE_PKCE);
    if (!pkce.verificador) throw new Error("perdi o verificador PKCE; tente de novo");
    if (dados.state && pkce.estado && dados.state !== pkce.estado) {
      throw new Error("estado do OAuth não confere — login abortado por segurança");
    }

    var corpo = new URLSearchParams({
      grant_type: "authorization_code",
      code: dados.code,
      redirect_uri: urlRetorno(),
      client_id: CLIENTE_PUBLICO,
      code_verifier: pkce.verificador
    });

    var r = await fetch(URL_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: corpo.toString()
    });
    var j = await r.json();
    if (!r.ok || !j.access_token) {
      throw new Error("troca do código falhou: " + (j.error_description || j.error || r.status));
    }

    var sessao = {
      modo: "usuario",
      token: j.access_token,
      refresh: j.refresh_token || null,
      expira: Date.now() + (j.expires_in || 600) * 1000,
      usuario: nomeDoToken(j.access_token)
    };
    guardarSessao(sessao);
    return sessao;
  }

  /** Lê o nome de usuário de dentro do JWT, sem validar assinatura. */
  function nomeDoToken(jwt) {
    try {
      var p = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      var d = JSON.parse(decodeURIComponent(escape(atob(p + "===".slice((p.length + 3) % 4)))));
      return d.preferred_username || d.email || d.name || null;
    } catch (e) {
      return null;
    }
  }

  /** Claims do token, para diagnóstico. */
  function claims(jwt) {
    try {
      var p = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(decodeURIComponent(escape(atob(p + "===".slice((p.length + 3) % 4)))));
    } catch (e) {
      return null;
    }
  }

  /* ---------------- B) cliente OAuth ---------------- */

  async function entrarComCliente(id, segredo) {
    var corpo = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: segredo
    });
    var r;
    try {
      r = await fetch(URL_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: corpo.toString()
      });
    } catch (e) {
      // "Failed to fetch" aqui quase sempre é CORS: o cliente OAuth foi
      // criado sem marcar que será usado por aplicativo de página única,
      // e aí o Keycloak não autoriza a origem do navegador.
      throw new Error(
        "o navegador não conseguiu falar com o Copernicus (" + (e.message || e) + "). " +
        "No painel do Copernicus, edite este cliente OAuth e marque a opção " +
        '"O cliente será usado por um aplicativo de página única", depois salve e tente de novo.'
      );
    }
    var j = await r.json();
    if (!r.ok || !j.access_token) {
      throw new Error(j.error_description || j.error || ("HTTP " + r.status));
    }
    var sessao = {
      modo: "cliente",
      token: j.access_token,
      expira: Date.now() + (j.expires_in || 600) * 1000,
      usuario: id
    };
    guardarSessao(sessao);
    return sessao;
  }

  /* ---------------- token corrente ---------------- */

  /**
   * Devolve um token válido. Renova pelo refresh, ou refaz o
   * client_credentials, conforme o modo. Nunca abre janela sozinho.
   */
  async function tokenValido() {
    var s = lerSessao();
    if (s) return s;

    var cli = lerCliente();
    if (cli && cli.id && cli.segredo) return entrarComCliente(cli.id, cli.segredo);

    var velha = null;
    try { velha = JSON.parse(localStorage.getItem(CHAVE_SESSAO) || "null"); } catch (e) {}
    if (velha && velha.refresh) {
      try {
        var r = await fetch(URL_TOKEN, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: velha.refresh,
            client_id: CLIENTE_PUBLICO
          }).toString()
        });
        var j = await r.json();
        if (r.ok && j.access_token) {
          var nova = {
            modo: "usuario", token: j.access_token,
            refresh: j.refresh_token || velha.refresh,
            expira: Date.now() + (j.expires_in || 600) * 1000,
            usuario: velha.usuario
          };
          guardarSessao(nova);
          return nova;
        }
      } catch (e) { /* cai fora e pede login */ }
    }
    return null;
  }

  /* ---------------- chamadas à API ---------------- */

  async function autorizacao() {
    var s = await tokenValido();
    if (!s) throw new Error("sem sessão do Copernicus");
    return "Bearer " + s.token;
  }

  /**
   * Busca as cenas Sentinel-2 disponíveis num período, com nuvem.
   * @param {number[]} bbox [oeste, sul, leste, norte] em WGS84
   */
  async function buscarCenas(bbox, de, ate, nuvemMax) {
    var corpoBase = {
      collections: ["sentinel-2-l2a"],
      bbox: bbox,
      datetime: de + "T00:00:00Z/" + ate + "T23:59:59Z",
      limit: 100,
      filter: nuvemMax != null ? ("eo:cloud_cover < " + nuvemMax) : undefined,
      "filter-lang": "cql2-text",
      fields: {
        include: ["id", "properties.datetime", "properties.eo:cloud_cover"],
        exclude: []
      }
    };

    /* O Catalog corta em ~100 registros por página e o token "next"
       pagina o resto. O teto era 5 páginas = 500 cenas: como a UC cai
       em 3–4 tiles do Sentinel-2, 500 cenas acabam por volta de abril e
       o painel parecia dizer que o satélite havia parado de passar.
       Consulta de catálogo não custa PU; o teto agora só existe para o
       caso de o "next" nunca terminar. */
    var todas = [];
    var next = null;
    for (var pagina = 0; pagina < 60; pagina++) {
      var corpo = Object.assign({}, corpoBase);
      if (next != null) corpo.next = next;
      var r = await fetch(URL_CATALOGO, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: await autorizacao() },
        body: JSON.stringify(corpo)
      });
      var j = await r.json();
      if (!r.ok) throw new Error(mensagemErro(j, r.status));
      todas = todas.concat(j.features || []);
      next = j.context && j.context.next;
      if (next == null || !(j.features || []).length) break;
    }

    return todas.map(function (f) {
      return {
        id: f.id,
        data: (f.properties || {}).datetime,
        nuvem: (f.properties || {})["eo:cloud_cover"]
      };
    }).sort(function (a, b) { return a.data < b.data ? 1 : -1; });
  }

  /* B08 (NIR) e B12 (SWIR) em reflectância, mais a máscara de validade.
     Usado no modo de download individual de bandas. */
  var EVAL_BANDAS = [
    "//VERSION=3",
    "function setup() {",
    '  return { input: [{ bands: ["B08", "B12", "dataMask"] }],',
    '           output: { bands: 3, sampleType: "FLOAT32" } };',
    "}",
    "function evaluatePixel(s) {",
    "  return [s.B08, s.B12, s.dataMask];",
    "}"
  ].join("\n");

  /* O NBR já calculado no servidor do Copernicus: 2 bandas (índice +
     máscara) em vez de 3 cruas — um terço a menos de PU por cena e
     metade do trabalho no navegador. Ideia herdada do SentinelaDasGerais.

     Usa B08 (NIR largo, 10 m nativos), que é o pareamento do plugin do
     QGIS e do notebook 1.3 — a referência com a qual os laudos do CBMMG
     precisam bater. O B8A (20 m) é mais "canônico" na literatura, mas
     trocar a banda muda o dNBR e, com ele, a área: paridade vale mais. */
  var EVAL_NBR = [
    "//VERSION=3",
    "function setup() {",
    '  return { input: [{ bands: ["B08", "B12", "dataMask"] }],',
    '           output: { bands: 2, sampleType: "FLOAT32" } };',
    "}",
    "function evaluatePixel(s) {",
    "  var soma = s.B08 + s.B12;",
    "  var nbr = soma > 0 ? (s.B08 - s.B12) / soma : 0;",
    "  return [nbr, s.dataMask];",
    "}"
  ].join("\n");

  /* NBR2 (B11/B12, os dois SWIR): sensível à água na vegetação, não à
     estrutura — em campo, cerrado ralo e pastagem, onde a biomassa é
     pouca e o NBR clássico quase não mexe, o dNBR2 marca melhor a
     cicatriz. Cai depois do fogo como o NBR, então o pipeline
     (antes − depois) segue igual. */
  var EVAL_NBR2 = [
    "//VERSION=3",
    "function setup() {",
    '  return { input: [{ bands: ["B11", "B12", "dataMask"] }],',
    '           output: { bands: 2, sampleType: "FLOAT32" } };',
    "}",
    "function evaluatePixel(s) {",
    "  var soma = s.B11 + s.B12;",
    "  var nbr2 = soma > 0 ? (s.B11 - s.B12) / soma : 0;",
    "  return [nbr2, s.dataMask];",
    "}"
  ].join("\n");

  /* NBR+ (Alcaras et al., 2022) com o sinal invertido para cair depois
     do fogo, como o NBR clássico — assim o resto do pipeline (dNBR =
     antes − depois) funciona sem mudança. O azul e o verde no
     denominador suprimem água e sombra de nuvem, os falsos positivos
     clássicos do dNBR. */
  var EVAL_NBR_PLUS = [
    "//VERSION=3",
    "function setup() {",
    '  return { input: [{ bands: ["B02", "B03", "B08", "B12", "dataMask"] }],',
    '           output: { bands: 2, sampleType: "FLOAT32" } };',
    "}",
    "function evaluatePixel(s) {",
    "  var num = s.B08 + s.B03 + s.B02 - s.B12;",
    "  var den = s.B08 + s.B03 + s.B02 + s.B12;",
    "  var idx = den > 0 ? num / den : 0;",
    "  return [idx, s.dataMask];",
    "}"
  ].join("\n");

  /** Evalscript de uma banda única crua, para download sob demanda. */
  function evalBanda(nome) {
    return [
      "//VERSION=3",
      "function setup() {",
      '  return { input: [{ bands: ["' + nome + '"] }],',
      '           output: { bands: 1, sampleType: "FLOAT32" } };',
      "}",
      "function evaluatePixel(s) {",
      "  return [s." + nome + "];",
      "}"
    ].join("\n");
  }

  /* Realce de queimada: pinta o NBR da cena — vegetação viva fica verde,
     área queimada fica preta. Leitura imediata, sem treino. Água e sombra
     também escurecem (NBR baixo); o contorno do lago denuncia. */
  var EVAL_REALCE = [
    "//VERSION=3",
    "function setup() {",
    '  return { input: [{ bands: ["B08", "B12", "dataMask"] }],',
    '           output: { bands: 3, sampleType: "UINT8" } };',
    "}",
    "function evaluatePixel(s) {",
    "  if (!s.dataMask) return [0, 0, 0];",
    "  var nbr = (s.B08 - s.B12) / (s.B08 + s.B12 + 1e-6);",
    "  var t = Math.max(0, Math.min(1, (nbr + 0.15) / 0.65));",
    "  return [Math.round(26 * (1 - t)), Math.round(24 + 200 * t), Math.round(22 * (1 - t))];",
    "}"
  ].join("\n");

  /* Cor verdadeira (B04/B03/B02): é como o olho veria. Serve para uma
     coisa que nenhum índice resolve — dizer se aquele "queimado" é
     nuvem, sombra de nuvem ou fumaça. Ganho 2,5, o padrão do Sentinel
     Hub para L2A. A 4ª banda é o dataMask virando alfa, para a borda sem
     dado sair transparente em vez de preta. */
  var EVAL_COR_VERDADEIRA = [
    "//VERSION=3",
    "function setup() {",
    '  return { input: [{ bands: ["B04", "B03", "B02", "dataMask"] }],',
    '           output: { bands: 4, sampleType: "UINT8" } };',
    "}",
    "function evaluatePixel(s) {",
    "  var g = 2.5 * 255;",
    "  return [Math.min(255, s.B04 * g), Math.min(255, s.B03 * g),",
    "          Math.min(255, s.B02 * g), s.dataMask * 255];",
    "}"
  ].join("\n");

  /* SCL cru (Scene Classification Layer do L2A), 1 banda de 0 a 11.
     Vem para o navegador como PNG de cinza: o valor da classe É o valor
     do pixel, então dá para contar nuvem no RECORTE em vez de confiar no
     eo:cloud_cover da cena inteira (110×110 km), que é o que hoje manda
     7 de 9 passagens para "nublada" sem olhar a UC.

     Classes: 3 sombra de nuvem · 8 nuvem média · 9 nuvem alta ·
     10 cirrus · 11 neve/gelo · 0 sem dado. */
  var EVAL_SCL = [
    "//VERSION=3",
    "function setup() {",
    '  return { input: [{ bands: ["SCL"] }],',
    '           output: { bands: 1, sampleType: "UINT8" } };',
    "}",
    "function evaluatePixel(s) {",
    "  return [s.SCL];",
    "}"
  ].join("\n");

  var CLASSES_SCL = {
    0: "sem dado", 1: "saturado", 2: "sombra de relevo", 3: "sombra de nuvem",
    4: "vegetação", 5: "solo exposto", 6: "água", 7: "sem classe",
    8: "nuvem média", 9: "nuvem alta", 10: "cirrus", 11: "neve"
  };

  var EVAL_FALSA_COR = [
    "//VERSION=3",
    "function setup() {",
    '  return { input: [{ bands: ["B08", "B04", "B03"] }],',
    '           output: { bands: 3, sampleType: "UINT8" } };',
    "}",
    "function evaluatePixel(s) {",
    "  var g = 2.5 * 255;",
    "  return [Math.min(255, s.B08 * g), Math.min(255, s.B04 * g), Math.min(255, s.B03 * g)];",
    "}"
  ].join("\n");

  /**
   * Baixa um recorte como GeoTIFF.
   *
   * @param {Object} opc {bbox, epsg, largura, altura, data, evalscript}
   * @returns {Promise<Blob>}
   */
  async function baixarRecorte(opc) {
    var corpo = {
      input: {
        bounds: {
          bbox: opc.bbox,
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/" + (opc.epsg || 4326) }
        },
        data: [{
          type: "sentinel-2-l2a",
          dataFilter: {
            timeRange: { from: opc.data + "T00:00:00Z", to: opc.data + "T23:59:59Z" },
            mosaickingOrder: "leastCC"
          }
        }]
      },
      output: {
        width: opc.largura,
        height: opc.altura,
        responses: [{ identifier: "default",
                      format: { type: opc.formato || "image/tiff" } }]
      },
      evalscript: opc.evalscript
    };

    var r = await fetch(URL_PROCESSO, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: opc.formato || "image/tiff",
        Authorization: await autorizacao()
      },
      body: JSON.stringify(corpo)
    });

    if (!r.ok) {
      var texto = await r.text();
      var j = null;
      try { j = JSON.parse(texto); } catch (e) {}
      throw Object.assign(new Error(mensagemErro(j, r.status) || texto.slice(0, 300)),
                          { status: r.status });
    }
    return r.blob();
  }

  function mensagemErro(j, status) {
    if (!j) return "HTTP " + status;
    var e = j.error || j;
    var m = e.message || e.error_description || e.reason || e.error || JSON.stringify(e);
    return "HTTP " + status + " — " + String(m).slice(0, 240);
  }

  glob.Copernicus = {
    entrar: entrar,
    entrarComCliente: entrarComCliente,
    sair: function () { esquecerSessao(); },
    lerSessao: lerSessao,
    tokenValido: tokenValido,
    lerCliente: lerCliente,
    guardarCliente: guardarCliente,
    esquecerCliente: esquecerCliente,
    buscarCenas: buscarCenas,
    baixarRecorte: baixarRecorte,
    claims: claims,
    EVAL_BANDAS: EVAL_BANDAS,
    EVAL_NBR: EVAL_NBR,
    EVAL_NBR2: EVAL_NBR2,
    EVAL_NBR_PLUS: EVAL_NBR_PLUS,
    evalBanda: evalBanda,
    EVAL_FALSA_COR: EVAL_FALSA_COR,
    EVAL_COR_VERDADEIRA: EVAL_COR_VERDADEIRA,
    EVAL_SCL: EVAL_SCL,
    CLASSES_SCL: CLASSES_SCL,
    EVAL_REALCE: EVAL_REALCE,
    URL_PROCESSO: URL_PROCESSO
  };
})(window);
