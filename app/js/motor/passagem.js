/* =====================================================================
   passagem.js — o motor do monitor ESTADUAL.

   Mesma máquina do monitor das UCs, com o recorte trocado: em vez de
   fatiar uma unidade de conservação, ele percorre a malha do estado.

     CÉLULA    2.500 x 2.500 px — o teto de uma requisição do Copernicus.
               A 20 m dá 50 x 50 km. É a unidade de cálculo e de cobrança.
     QUADRANTE bloco de 5 x 5 células (250 km). É a unidade de
               responsabilidade: um militar assume um quadrante.

   O que ele faz, por célula:
     1. pergunta ao catálogo que passagens existem desde o início do
        monitoramento;
     2. confere no controle do Portal o que já foi processado (quadrante ×
        célula × dia × resolução) e processa só o que falta;
     3. anda em ordem cronológica, ENCADEADO — e é aqui que mora a regra
        que dá sentido ao número:

          · o dNBR é uma DIFERENÇA, então a primeira passagem viável de
            uma célula não tem contra o que ser comparada. Ela não produz
            área: ela É a base;
          · da segunda em diante, cada passagem é medida contra a
            ANTERIOR VIÁVEL da mesma célula. Nunca contra uma data solta
            lá atrás.

        Sem isso o cálculo mede estiagem. Foi o que aconteceu na Serra do
        Cabral: 14/02 acabou comparada com 10/01 porque tudo entre as duas
        foi descartado pelo eo:cloud_cover DA CENA, e 35 dias de seca no
        cerrado entram no dNBR com cara de cicatriz.

     4. viabilidade se decide NO RECORTE: uma sonda do SCL a 1/4 da
        resolução custa ~1,6% do índice, diz quanta nuvem existe sobre a
        célula e ainda vira máscara.

   CRS: EPSG:3857 em toda a malha (ver plano/gerar_quadrantes.py).
   ===================================================================== */
(function (glob) {
  "use strict";

  var SDK = null;   // {Polygon, ge} — entregues pelo painel

  /* PU por pixel (Process API): px/262144 × bandas/3 × 2 se float32 */
  var custoPorPx = {
    indice: 4 / 3 / 262144,     // NBR: 2 bandas float32
    falsaCor: 1 / 262144        // RGB 8 bits
  };

  function iniciar(mods) { SDK = mods; }

  function dia(s) { return String(s).slice(0, 10); }
  function epoch(d) { return new Date(d + "T12:00:00Z").getTime(); }

  /* Janela de um dia no where. O serviço do Portal REJEITA comparação
     numérica (epoch) em campo de data — "Tipo de dados inválido". A forma
     padrão TIMESTAMP funciona. data_pass é gravado ao meio-dia UTC, então
     [dia 00:00, dia+1 00:00) pega. */
  function janelaDia(d) {
    var t = new Date(d + "T00:00:00Z").getTime() + 864e5;
    var seg = new Date(t).toISOString().slice(0, 10);
    return "data_pass >= timestamp '" + d + " 00:00:00'" +
           " AND data_pass < timestamp '" + seg + " 00:00:00'";
  }

  /* ---------------- células ---------------- */

  /**
   * As células de um quadrante na resolução pedida.
   *
   * A 20 m são as do plano (50 km, 2.500 px). A 10 m cada uma se parte em
   * 2×2 de 25 km — o mesmo território, quatro vezes o custo. A numeração
   * do filho deriva da do pai ((n-1)*4 + 1..4), então a chave do controle
   * nunca colide entre as duas resoluções.
   */
  function celulasDe(q, res) {
    var lista = [];
    q.celulas.forEach(function (c) {
      if (String(res) === "20") {
        lista.push({
          n: c.n, epsg: 3857, bbox: c.bbox3857.slice(),
          bbox4326: c.bbox4326.slice(),
          largura: c.largura, altura: c.altura,
          area_mg_km2: c.area_mg_km2
        });
        return;
      }
      var b = c.bbox3857;
      var mx = (b[0] + b[2]) / 2, my = (b[1] + b[3]) / 2;
      var quartos = [
        [b[0], b[1], mx, my], [mx, b[1], b[2], my],
        [b[0], my, mx, b[3]], [mx, my, b[2], b[3]]
      ];
      quartos.forEach(function (bb, i) {
        lista.push({
          n: (c.n - 1) * 4 + i + 1, epsg: 3857, bbox: bb,
          bbox4326: bbox4326De(bb),
          largura: c.largura, altura: c.altura,
          area_mg_km2: c.area_mg_km2 / 4
        });
      });
    });
    return lista;
  }

  var R_MERC = 6378137.0;
  function bbox4326De(b) {
    function lon(x) { return x / R_MERC * 180 / Math.PI; }
    function lat(y) {
      return (2 * Math.atan(Math.exp(y / R_MERC)) - Math.PI / 2) * 180 / Math.PI;
    }
    return [lon(b[0]), lat(b[1]), lon(b[2]), lat(b[3])];
  }

  /* ---------------- Portal REST ---------------- */

  async function rest(url, params) {
    var p = new URLSearchParams(params);
    p.set("f", "json");
    p.set("token", Auth.token());
    var r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: p.toString()
    });
    var j = await r.json();
    if (j.error) throw new Error(j.error.message || ("Portal " + j.error.code));
    return j;
  }

  /* applyEdits devolve HTTP 200 com success:false POR LINHA quando uma
     edição é recusada — sem j.error, então rest() não lança. Todo delete/
     update do motor passa por aqui: falha silenciosa numa linha de controle
     é como nascem linhas fantasma e dupla contagem. */
  function conferir(j) {
    var falhas = 0;
    ["addResults", "updateResults", "deleteResults"].forEach(function (k) {
      (j[k] || []).forEach(function (r0) { if (!r0.success) falhas++; });
    });
    if (falhas) throw new Error("applyEdits recusou " + falhas + " linha(s)");
    return j;
  }

  async function consultarTudo(url, where, campos) {
    var saida = [];
    var offset = 0;
    while (true) {
      var j = await rest(url + "/query", {
        where: where, outFields: campos, returnGeometry: "false",
        orderByFields: "objectid", resultOffset: String(offset),
        resultRecordCount: "2000"
      });
      var fs = j.features || [];
      fs.forEach(function (f) { saida.push(f.attributes); });
      if (!j.exceededTransferLimit || !fs.length) break;
      offset += fs.length;
    }
    return saida;
  }

  /* ---------------- pendências ---------------- */

  /**
   * O que falta processar no quadrante: catálogo × controle.
   *
   * O catálogo é consultado CÉLULA A CÉLULA, não pelo quadrante inteiro.
   * Um quadrante de 250 km atravessa várias órbitas do Sentinel-2, e as
   * datas de passagem mudam de uma ponta à outra; perguntar pelo bloco
   * todo faria o motor tentar baixar cena que não existe naquela célula e
   * gravar erro. Consulta de catálogo não custa PU.
   */
  async function pendencias(q, res, aoProgresso) {
    var hoje = dia(new Date().toISOString());
    var d0 = new Date(epoch(CFG.inicioMonitoramento) - 60 * 864e5);
    var desde = dia(d0.toISOString());

    var lista = celulasDe(q, res);

    var feitas = await consultarTudo(CFG.tabelaControle,
      "quad_id = '" + q.id + "' AND res_m = " + Number(res),
      "celula,data_pass,status_proc");
    var chaves = {};
    feitas.forEach(function (f) {
      chaves[f.celula + "|" + dia(new Date(f.data_pass).toISOString())] = f.status_proc;
    });

    var pend = [];
    var dias = {};
    for (var i = 0; i < lista.length; i++) {
      var cl = lista[i];
      aoProgresso && aoProgresso(i, lista.length,
        "catálogo · célula " + cl.n + "/" + lista.length);
      var cenas = await Copernicus.buscarCenas(cl.bbox4326, desde, hoje, null);
      var porDia = {};
      cenas.forEach(function (c) {
        var d = dia(c.data);
        if (!porDia[d] || (c.nuvem != null && c.nuvem < porDia[d].nuvem)) {
          porDia[d] = { dia: d, nuvem: c.nuvem, id: c.id };
        }
      });
      cl.dias = Object.keys(porDia).sort().map(function (d) { return porDia[d]; });
      cl.dias.forEach(function (d) {
        if (d.dia < CFG.inicioMonitoramento) return;
        dias[d.dia] = true;
        var st = chaves[cl.n + "|" + d.dia];
        if (!st) {
          pend.push({ celula: cl, passagem: d });
        } else if (st === "erro") {
          // erro NÃO é terminal: volta à fila. Antes de recalcular, o motor
          // apaga o que a tentativa falhada deixou (polígonos órfãos contam
          // o mesmo fogo duas vezes quando a base pula a linha de erro).
          d.reproc = true;
          pend.push({ celula: cl, passagem: d });
        }
      });
    }

    return {
      dias: Object.keys(dias).sort(),
      celulas: lista, feitas: feitas, pendentes: pend
    };
  }

  /* ---------------- uma passagem de uma célula ---------------- */

  async function nbrDaCelula(cl, diaCena) {
    var blob = await Copernicus.baixarRecorte({
      bbox: cl.bbox, epsg: cl.epsg,
      largura: cl.largura, altura: cl.altura,
      data: diaCena, evalscript: Copernicus.EVAL_NBR
    });
    var cab = await Raster.lerCabecalho(new File([blob], "nbr.tif"));
    var grade = Raster.definirGrade([cab], cab, 0);
    var nbr = await Raster.bandaNaGrade(cab, grade, 0);
    var mascara = cab.bandas >= 2 ? await Raster.bandaNaGrade(cab, grade, 1) : null;
    if (mascara) {
      for (var i = 0; i < nbr.length; i++) if (!mascara[i]) nbr[i] = NaN;
    }
    return { nbr: nbr, grade: grade, cab: cab };
  }

  /**
   * Todos os polígonos já gravados da célula desde `desdeDia` — a memória
   * contra a qual a rede de regeneração recorta. Uma consulta por célula
   * por sessão; as gravações da própria sessão são acrescentadas em
   * memória depois.
   */
  async function carregarAnteriores(q, res, cl, desdeDia) {
    var saida = [], offset = 0;
    var wh = "quad_id = '" + q.id + "' AND celula = " + cl.n +
             " AND res_m = " + Number(res) +
             " AND data_pass >= timestamp '" + desdeDia + " 00:00:00'";
    while (true) {
      var j = await rest(CFG.camadaPoligonos + "/query", {
        where: wh, outFields: "objectid,data_pass",
        returnGeometry: "true", outSR: "4326", geometryPrecision: "6",
        orderByFields: "objectid",
        resultOffset: String(offset), resultRecordCount: "1000"
      });
      var fs = j.features || [];
      fs.forEach(function (f) {
        if (!f.geometry || !f.geometry.rings) return;
        saida.push({
          dia: dia(new Date(f.attributes.data_pass).toISOString()),
          geom: new SDK.Polygon({ rings: f.geometry.rings,
                                  spatialReference: { wkid: 4326 } })
        });
      });
      if (!j.exceededTransferLimit || !fs.length) break;
      offset += fs.length;
    }
    return saida;
  }

  /**
   * A REDE DE SEGURANÇA GEOMÉTRICA (plano §2.2): dentro da janela de
   * regeneração a mesma área nunca conta duas vezes — o polígono novo é
   * recortado (difference) contra tudo que já queimou na célula dentro de
   * CFG.regeneracaoDias. Vencido o prazo, os polígonos velhos saem da
   * janela e a reincidência volta a contar normalmente.
   *
   * Devolve null quando a área inteira já estava contada. Se o difference
   * falhar, LANÇA: dupla contagem silenciosa é pior que uma linha de erro
   * visível e recalculável.
   */
  function recortarRegeneracao(sp, anteriores, diaPass) {
    if (!anteriores || !anteriores.length || !CFG.regeneracaoDias) return sp;
    var d0 = new Date(diaPass + "T00:00:00Z").getTime() -
             CFG.regeneracaoDias * 864e5;
    var e = sp.extent;
    var candidatos = [];
    for (var i = 0; i < anteriores.length; i++) {
      var a = anteriores[i];
      if (a.dia >= diaPass) continue;                       // só o passado
      if (new Date(a.dia + "T00:00:00Z").getTime() < d0) continue;
      var e2 = a.geom.extent;
      if (!e || !e2 || e2.xmin > e.xmax || e2.xmax < e.xmin ||
          e2.ymin > e.ymax || e2.ymax < e.ymin) continue;   // longe: ignora
      candidatos.push(a.geom);
    }
    if (!candidatos.length) return sp;
    try {
      var uniao = candidatos.length === 1
        ? candidatos[0] : SDK.ge.union(candidatos);
      return SDK.ge.difference(sp, uniao);
    } catch (err) {
      throw new Error("recorte de regeneração falhou: " + (err.message || err));
    }
  }

  /* ---------------- municípios (atribuição na gravação) ---------------- */

  var municipios = null;   // [{codigo, nome, geom}]

  async function carregarMunicipios() {
    if (municipios) return municipios;
    var gj = await (await fetch("dados/municipios.geojson")).json();
    municipios = gj.features.map(function (f) {
      var g = f.geometry;
      var rings = g.type === "Polygon" ? g.coordinates
        : g.coordinates.reduce(function (a, p) { return a.concat(p); }, []);
      return { codigo: f.properties.codigo, nome: f.properties.nome,
               geom: new SDK.Polygon({ rings: rings,
                                       spatialReference: { wkid: 4326 } }) };
    });
    return municipios;
  }

  /**
   * O município que ficou com a MAIOR parte do polígono, decidido AQUI e
   * gravado na linha — a consolidação depois só agrupa no servidor. Sem
   * isto, fechar um mês exigiria baixar todos os polígonos com geometria
   * e cruzá-los no navegador, o que não escala para a série inteira.
   */
  function partesMunicipais(sp, haTotal) {
    if (!municipios) return [];
    var e = sp.extent;
    var saida = [];
    for (var i = 0; i < municipios.length; i++) {
      var m = municipios[i], e2 = m.geom.extent;
      if (!e || !e2 || e2.xmin > e.xmax || e2.xmax < e.xmin ||
          e2.ymin > e.ymax || e2.ymax < e.ymin) continue;
      var inter = null;
      try { inter = SDK.ge.intersect(sp, m.geom); } catch (err) { continue; }
      if (!inter) continue;
      var ha = Math.abs(SDK.ge.geodesicArea(inter, "square-meters")) / 10000;
      if (ha <= 0) continue;
      saida.push({ codigo: m.codigo, nome: m.nome, geom: inter, ha: ha,
                   fracao: haTotal ? Math.min(1, ha / haTotal) : null });
    }
    return saida;
  }

  function paraRings(f, grade, conv) {
    var aneis = [f.externo].concat(f.buracos).map(function (anel) {
      return anel.map(function (p) {
        var x = grade.origemX + p[0] * grade.res;
        var y = grade.origemY - p[1] * grade.res;
        return conv(x, y);
      });
    });
    return aneis.filter(function (a) { return a.length >= 4; });
  }

  /* ---------------- processamento ---------------- */

  async function processar(q, res, aoProgresso) {
    if (!SDK) throw new Error("motor sem SDK — chame Motor.iniciar()");
    if (!Auth.token()) throw new Error("entre no Portal antes de processar");
    if (!(await Copernicus.tokenValido())) await Copernicus.entrar();

    var p = await pendencias(q, res, function (i, n, t) {
      aoProgresso && aoProgresso(0, 1, t);
    });
    if (!p.pendentes.length) return { processadas: 0, restantes: 0 };

    var usuario = Auth.usuario() || "desconhecido";
    var conv = Geo.conversorParaWGS84(3857);
    try { await carregarMunicipios(); }
    catch (eM) { console.warn("municipios.geojson:", eM); }
    var totalCelulas = p.celulas.length;

    // agrupa por célula e ordena no tempo: a cadeia se faz DENTRO da célula
    var porCelula = {};
    p.pendentes.forEach(function (pd) {
      (porCelula[pd.celula.n] = porCelula[pd.celula.n] ||
        { celula: pd.celula, dias: [] }).dias.push(pd.passagem);
    });

    var feitas = 0, total = p.pendentes.length;

    for (var chave in porCelula) {
      var grupo = porCelula[chave];
      var cl = grupo.celula;
      grupo.dias.sort(function (a, b) { return a.dia < b.dia ? -1 : 1; });

      var px = cl.largura * cl.altura;
      var puIndice = px * custoPorPx.indice;
      var puFC = px * custoPorPx.falsaCor;
      var puSonda = Nuvem.pu(cl, CFG.divisorSonda);

      var base = null;   // {dia, id, nbr, grade} — a anterior viável

      for (var k = 0; k < grupo.dias.length; k++) {
        var pas = grupo.dias[k];

        if (Pu.usado() + puSonda + 2 * puIndice + puFC > CFG.tetoTrabalhoPU) {
          return { processadas: feitas, restantes: total - feitas, teto: true };
        }

        aoProgresso && aoProgresso(feitas, total,
          q.id + " · célula " + cl.n + "/" + totalCelulas + " · " + pas.dia);

        var oidsAdicionados = [];   // polígonos desta tentativa, p/ rollback
        try {
          // higiene: polígono pré-existente desta célula×dia é sobra de
          // tentativa interrompida (rollback que falhou junto com a linha de
          // erro) — some antes do recálculo, senão duplica
          await apagarPoligonos(q.id, res, cl.n, pas.dia);
          if (grupo.anteriores) {
            grupo.anteriores = grupo.anteriores.filter(function (a2) {
              return a2.dia !== pas.dia;
            });
          }

          // recálculo de erro: apaga a linha da tentativa falhada
          if (pas.reproc) {
            await apagarLinhaControle(q, res, cl, pas.dia);
            delete pas.reproc;
          }

          // descarte barato: cena quase toda encoberta não merece nem sonda
          if (pas.nuvem != null && pas.nuvem >= CFG.nuvemCenaDescartar) {
            await gravarControle(q, res, cl, pas, null, "nublada", 0, 0, 0,
              usuario, null, "cena com " + Math.round(pas.nuvem) + "% de nuvem",
              null, totalCelulas);
            feitas++;
            continue;
          }

          // a nuvem que decide é a que está sobre a CÉLULA, não a da cena
          var sonda = await Nuvem.sondar(cl, pas.dia, CFG.divisorSonda);
          var puGasto = puSonda;
          Pu.somar(puSonda);

          if (sonda.pct > CFG.nuvemRecorteMax) {
            await gravarControle(q, res, cl, pas, null, "nublada", 0, 0, puGasto,
              usuario, null, "nuvem no recorte: " + sonda.pct + "%", sonda, totalCelulas);
            feitas++;
            continue;
          }

          // o dia é VIÁVEL e vai entrar na cadeia. Se está sendo inserido no
          // meio de cadeia já aceita (erro reprocessado, cena publicada com
          // atraso pelo Copernicus), quem passou por cima dele precisa ser
          // reaberto — e volta para a fila DESTA sessão, em ordem. Rodar só
          // depois da sonda preserva a curadoria quando o dia se revela
          // nublado: nada é reaberto à toa.
          var reabertos = await reabrirPuladas(q, res, cl, pas.dia);
          if (reabertos.length) {
            var catalogo = {};
            (cl.dias || []).forEach(function (dd) { catalogo[dd.dia] = dd; });
            var cauda = grupo.dias.slice(k + 1);
            reabertos.forEach(function (d0) {
              var jaTem = cauda.some(function (x) { return x.dia === d0; });
              if (!jaTem) {
                cauda.push(catalogo[d0] || { dia: d0, nuvem: null, id: null });
                total++;
              }
            });
            cauda.sort(function (a, b) { return a.dia < b.dia ? -1 : 1; });
            grupo.dias = grupo.dias.slice(0, k + 1).concat(cauda);
            if (grupo.anteriores) {
              grupo.anteriores = grupo.anteriores.filter(function (a2) {
                return reabertos.indexOf(a2.dia) < 0;
              });
            }
          }

          // visita nova: a cadeia recomeça, então busca a base no controle
          if (!base) base = await recuperarBase(q, res, cl, pas.dia);

          var atual = await nbrDaCelula(cl, pas.dia);
          atual.dia = pas.dia; atual.id = pas.id;
          puGasto += puIndice;
          Pu.somar(puIndice);
          aplicarNuvem(atual, sonda);

          if (!base) {
            // primeira viável da série: vira a base, sem produzir área
            await gravarControle(q, res, cl, pas, null, "base", 0, 0, puGasto,
              usuario, null, "primeira passagem viável — base de cálculo",
              sonda, totalCelulas);
            base = atual;
            feitas++;
            continue;
          }

          // a cadeia em memória pode estar ATRÁS do banco: se existe linha
          // aceita entre a base em memória e esta passagem (dependente de um
          // dia pulado que não foi reaberto, ou outra sessão avançou a
          // célula), a base verdadeira é a do controle — re-ancora
          var aFrente = await rest(CFG.tabelaControle + "/query", {
            where: "quad_id = '" + q.id + "' AND celula = " + cl.n +
                   " AND res_m = " + Number(res) +
                   " AND data_pass > timestamp '" + base.dia + " 12:00:00'" +
                   " AND data_pass < timestamp '" + pas.dia + " 00:00:00'" +
                   " AND status_proc IN ('base','calculada','sem_area')",
            outFields: "objectid", resultRecordCount: "1",
            returnGeometry: "false"
          });
          if ((aFrente.features || []).length) {
            var reancorada = await recuperarBase(q, res, cl, pas.dia);
            if (reancorada) base = reancorada;
          }

          var vao = Math.round(
            (new Date(pas.dia + "T00:00:00Z") - new Date(base.dia + "T00:00:00Z")) / 864e5);

          var d = Raster.calcularDNBR(base.nbr, atual.nbr);
          var mm = Raster.montarMascara(d.dnbr, null, { limiar: CFG.limiar });
          var vet = Vetor.vetorizar(mm.mascara, d.dnbr, atual.grade, {
            limiar: CFG.limiar, morfologia: 0,
            areaMinM2: CFG.areaMinM2, tolSimplPx: 0, maxPoligonos: 5000
          }, function () { });

          // memória da regeneração: uma consulta por célula, por sessão
          if (vet.feicoes.length && grupo.anteriores == null) {
            var desdeRegen = dia(new Date(
              epoch(grupo.dias[0].dia) - CFG.regeneracaoDias * 864e5
            ).toISOString());
            grupo.anteriores = await carregarAnteriores(q, res, cl, desdeRegen);
          }

          // uso do solo → biomassa (M = A×B×C): o tile da célula está na
          // mesma grade do dNBR, então o pixel casa 1:1 com os rótulos.
          // Sem tile (ou fora de 10 m), a passagem grava com biomassa
          // nula — nunca bloqueia o cálculo de área.
          var tileLulc = null, paramsBC = null;
          if (vet.feicoes.length && Number(res) === 10 &&
              typeof Biomassa !== "undefined") {
            try {
              paramsBC = await Biomassa.carregarParametros();
              tileLulc = await Biomassa.carregarTile(cl, CFG.anoLULC);
              if (!tileLulc) {
                console.warn("célula", cl.n, "sem tile LULC", CFG.anoLULC,
                  "— biomassa fica nula");
              }
            } catch (eB) {
              console.warn("LULC/biomassa indisponível:", eB);
              tileLulc = null;
            }
          }

          var adds = [];
          var novosGeoms = [];
          var detalhes = [];      // [{idx, classes}] — alinhado com adds
          var areaTotal = 0;
          var foraDescartados = 0;

          /* O piso em área NO CHÃO. A malha é Mercator: o pixel "de 10 m"
             mede 10·cos(lat) no terreno (~9,45 m nesta latitude, 89% da
             área). Comparar área GEODÉSICA contra um piso escrito em
             metros de Mercator derrubaria justamente os componentes do
             tamanho mínimo — o critério de detecção é em PIXELS (o
             minPixels do vetorizador), isto aqui é só a tradução dele. */
          var latMedia = (cl.bbox4326[1] + cl.bbox4326[3]) / 2;
          var fatorChao = Math.pow(Math.cos(latMedia * Math.PI / 180), 2);
          var pisoChaoHa = (CFG.areaMinM2 * fatorChao) / 10000;
          vet.feicoes.forEach(function (f) {
            var rings = paraRings(f, atual.grade, conv);
            if (!rings.length) return;
            var poli = new SDK.Polygon({ rings: rings, spatialReference: { wkid: 4326 } });
            var sp = SDK.ge.simplify(poli) || poli;
            var haCheio = Math.abs(SDK.ge.geodesicArea(sp, "square-meters")) / 10000;
            var recortado = recortarRegeneracao(sp, grupo.anteriores, pas.dia);
            if (!recortado) return;   // tudo já contado dentro da janela
            var ha = recortado === sp ? haCheio
              : Math.abs(SDK.ge.geodesicArea(recortado, "square-meters")) / 10000;
            if (ha < pisoChaoHa) return;
            // o dNBR médio é do COMPONENTE vetorizado inteiro; se o recorte
            // tirou área relevante, a média não descreve mais a geometria
            // gravada — melhor nulo que número errado
            var dnbrMed = f.dnbrMedio != null && ha >= haCheio * 0.99
              ? Math.round(f.dnbrMedio * 10000) / 10000 : null;

            // RECORTE MUNICIPAL: o que cai 100% fora dos 8 não é gravado
            // (as células são retângulos e a maior parte da área delas
            // não interessa); o que cruza a divisa vira uma linha POR
            // MUNICÍPIO, cada uma com a sua parte — assim a soma
            // municipal é a área que está DENTRO de cada município.
            var partes = partesMunicipais(recortado, ha);
            if (!partes.length) { foraDescartados++; return; }

            partes.forEach(function (pt) {
              if (pt.ha < pisoChaoHa) return;

              var classeUso = null, biomassaT = null;
              if (tileLulc && paramsBC && vet.rotulos && f.rotulo) {
                // a proporção por classe é a do componente; aplicada à
                // área da parte municipal
                var bc = Biomassa.porClasse(tileLulc, vet.rotulos, f.rotulo,
                                            pt.ha, paramsBC);
                classeUso = bc.dominante;
                biomassaT = bc.biomassa_t != null
                  ? Math.round(bc.biomassa_t * 1000) / 1000 : null;
                if (bc.classes.length) {
                  detalhes.push({ idx: adds.length, classes: bc.classes,
                                  pixels: f.pixels, municipio: pt.codigo });
                }
              }

              areaTotal += pt.ha;
              novosGeoms.push(pt.geom);
              adds.push({
                geometry: { rings: pt.geom.rings,
                            spatialReference: { wkid: 4326 } },
                attributes: {
                  quad_id: q.id, celula: cl.n, res_m: Number(res),
                  data_pass: epoch(pas.dia), data_ref: epoch(base.dia),
                  area_ha: Math.round(pt.ha * 10000) / 10000,
                  n_pixels: f.pixels,
                  municipio: pt.codigo, mun_nome: pt.nome,
                  mun_fracao: pt.fracao != null
                    ? Math.round(pt.fracao * 10000) / 10000 : null,
                  dnbr_med: dnbrMed,
                  status: "Queimada",
                  competencia: pas.dia.slice(0, 7),
                  classe_uso: classeUso,
                  biomassa_t: biomassaT,
                  cena_id: pas.id, cena_ref_id: base.id || null,
                  metodo: "dNBR (B08/B12) " + res + " m · base " + base.dia +
                          " · regen " + CFG.regeneracaoDias + "d" +
                          (tileLulc ? " · LULC " + CFG.anoLULC : ""),
                  processado_por: usuario
                }
              });
            });
          });

          // 2.000 feições por requisição é o teto prático do applyEdits;
          // uma célula em mês de fogo passa disso com folga
          var gidsAdicionados = [];
          for (var a = 0; a < adds.length; a += 500) {
            var jr = await rest(CFG.camadaPoligonos + "/applyEdits", {
              adds: JSON.stringify(adds.slice(a, a + 500))
            });
            var nFalhas = 0;
            (jr.addResults || []).forEach(function (ar) {
              if (ar.success) {
                oidsAdicionados.push(ar.objectId);
                gidsAdicionados.push(ar.globalId || null);
              } else nFalhas++;
            });
            // gravação parcial vira erro: o catch desfaz o que entrou
            if (nFalhas) {
              throw new Error("polígonos não gravados: " + nFalhas +
                " de " + adds.length);
            }
          }

          // detalhamento A×B×C por classe — filho dos polígonos que
          // acabaram de ser gravados (chave = globalid do polígono)
          if (detalhes.length && gidsAdicionados.length) {
            var addsClasse = [];
            detalhes.forEach(function (dt) {
              var gid = gidsAdicionados[dt.idx];
              if (!gid) return;
              dt.classes.forEach(function (cc) {
                addsClasse.push({ attributes: {
                  poligono_gid: gid,
                  competencia: pas.dia.slice(0, 7),
                  quad_id: q.id, celula: cl.n, res_m: Number(res),
                  data_pass: epoch(pas.dia),
                  classe_id: cc.classe,
                  area_ha: Math.round(cc.area_ha * 10000) / 10000,
                  n_pixels: dt.pixels,
                  municipio: dt.municipio,
                  biomassa_t: cc.biomassa_t != null
                    ? Math.round(cc.biomassa_t * 1000) / 1000 : null
                } });
              });
            });
            for (var a2 = 0; a2 < addsClasse.length; a2 += 500) {
              conferir(await rest(CFG.tabelaQueimadaClasse + "/applyEdits", {
                adds: JSON.stringify(addsClasse.slice(a2, a2 + 500))
              }));
            }
          }

          // vão longo continua sendo calculado — mas sai marcado, porque
          // é o caso em que a estiagem se disfarça de cicatriz; e truncamento
          // do vetorizador é subcontagem, nunca pode ficar em silêncio
          var motivos = [];
          if (vet.truncado) {
            motivos.push("vetorização truncada: " + vet.totalBruto +
              " componentes, gravados " + vet.feicoes.length);
          }
          if (vao > CFG.vaoMaximoDias) {
            motivos.push("vão de " + vao + " dias até a base (" + base.dia +
              ") — validar na estação");
          }
          var motivo = motivos.length ? motivos.join(" · ").slice(0, 240) : null;

          var oidCtrl = await gravarControle(q, res, cl, pas,
            { dia: base.dia }, adds.length ? "calculada" : "sem_area",
            areaTotal, adds.length, puGasto, usuario, base.id || null,
            motivo, sonda, totalCelulas);

          // os recém-gravados entram na memória da célula — a próxima
          // passagem da sessão também recorta contra eles
          if (grupo.anteriores != null && novosGeoms.length) {
            novosGeoms.forEach(function (g2) {
              grupo.anteriores.push({ dia: pas.dia, geom: g2 });
            });
          }

          if (adds.length && oidCtrl) {
            try {
              var fcBlob = await Copernicus.baixarRecorte({
                bbox: cl.bbox, epsg: cl.epsg,
                largura: cl.largura, altura: cl.altura,
                data: pas.dia, evalscript: Copernicus.EVAL_FALSA_COR,
                formato: "image/png"
              });
              Pu.somar(puFC);
              await anexar(oidCtrl, "falsacor_" + pas.dia + "_c" + cl.n + ".png", fcBlob);
            } catch (e) { console.warn("falsa cor não anexada:", e); }
          }
          if (oidCtrl && sonda.blob) {
            try {
              await anexar(oidCtrl, "scl_" + pas.dia + "_c" + cl.n + ".png", sonda.blob);
            } catch (e) { console.warn("sonda não anexada:", e); }
          }

          base = atual;   // a cadeia avança
          feitas++;
        } catch (e) {
          console.error(q.id, "célula", cl.n, pas.dia, e);
          // desfaz os polígonos desta tentativa: órfão sem linha de controle
          // volta como pendência "nova" e contaria o mesmo fogo duas vezes
          if (oidsAdicionados.length) {
            try { await excluirPoligonos(oidsAdicionados); }
            catch (e2) { console.warn("rollback de polígonos falhou:", e2); }
          }
          try {
            await gravarControle(q, res, cl, pas, null, "erro", 0, 0, 0, usuario,
              null, String(e && e.message || e).slice(0, 240), null, totalCelulas);
          } catch (e3) {
            // sem linha de controle o dia volta como pendência nova; a
            // higiene no início do try (apagarPoligonos) limpa qualquer
            // órfão que o rollback acima não tenha conseguido desfazer
            console.warn("linha de erro não gravada:", e3);
          }
          feitas++;
        }
      }
    }
    return { processadas: feitas, restantes: total - feitas };
  }

  /**
   * Recupera a base quando a cadeia recomeça noutra visita: a última
   * passagem ANTERIOR já aceita na mesma célula. Custa uma sonda e um
   * índice — uma vez por célula, por sessão.
   */
  async function recuperarBase(q, res, cl, diaAtual) {
    var j = await rest(CFG.tabelaControle + "/query", {
      where: "quad_id = '" + q.id + "' AND celula = " + cl.n +
             " AND res_m = " + Number(res) +
             " AND data_pass < timestamp '" + diaAtual + " 00:00:00'" +
             " AND status_proc IN ('base','calculada','sem_area')",
      outFields: "objectid,data_pass,cena_id",
      orderByFields: "data_pass DESC", resultRecordCount: "1",
      returnGeometry: "false"
    });
    var f = (j.features || [])[0];
    if (!f) return null;

    var d = dia(new Date(f.attributes.data_pass).toISOString());
    var sonda = await Nuvem.sondar(cl, d, CFG.divisorSonda);
    Pu.somar(Nuvem.pu(cl, CFG.divisorSonda));
    var idx = await nbrDaCelula(cl, d);
    Pu.somar(cl.largura * cl.altura * custoPorPx.indice);
    idx.dia = d;
    idx.id = f.attributes.cena_id;
    aplicarNuvem(idx, sonda);
    return idx;
  }

  /** Apaga do índice os pixels que a sonda classificou como imprestáveis. */
  function aplicarNuvem(idx, sonda) {
    if (!sonda || !idx || !idx.grade) return;
    var bom = Nuvem.ampliar(sonda, idx.grade.largura, idx.grade.altura);
    for (var i = 0; i < idx.nbr.length && i < bom.length; i++) {
      if (!bom[i]) idx.nbr[i] = NaN;
    }
  }

  async function gravarControle(q, res, cl, pas, ref, status, areaHa, nPoli, pu,
                                usuario, refId, motivo, sonda, totalCelulas) {
    var j = await rest(CFG.tabelaControle + "/applyEdits", {
      adds: JSON.stringify([{
        attributes: {
          quad_id: q.id, celula: cl.n, total_celulas: totalCelulas,
          res_m: Number(res),
          data_pass: epoch(pas.dia), data_ref: ref ? epoch(ref.dia) : null,
          competencia: pas.dia.slice(0, 7),
          cena_id: pas.id, cena_ref_id: refId || null,
          status_proc: status, nuvem_pct: pas.nuvem,
          area_ha: Math.round(areaHa * 100) / 100, n_poligonos: nPoli,
          pu_gasto: Math.round(pu * 10) / 10,
          bbox_3857: cl.bbox.map(function (v) { return v.toFixed(1); }).join(","),
          bbox_4326: cl.bbox4326.map(function (v) { return v.toFixed(5); }).join(","),
          motivo: motivo || null,
          nuvem_rec: sonda ? sonda.pct : null,
          nuvem_rec_det: sonda ? sonda.detalhe.slice(0, 120) : null,
          processado_por: usuario
        }
      }])
    });
    var r = (j.addResults || [])[0];
    // falha POR LINHA do applyEdits não vem como j.error — sem este throw a
    // passagem ficaria com polígonos gravados e sem linha de controle, e
    // voltaria à fila como pendência "nova", duplicando os polígonos
    if (!r || !r.success) {
      throw new Error("linha de controle não gravada" +
        (r && r.error ? ": " + (r.error.description || r.error.code) : ""));
    }
    return r.objectId;
  }

  async function anexar(oid, nome, blob) {
    var fd = new FormData();
    fd.append("attachment", new File([blob], nome, { type: "image/png" }));
    fd.append("f", "json");
    fd.append("token", Auth.token());
    var r = await fetch(CFG.tabelaControle + "/" + oid + "/addAttachment",
                        { method: "POST", body: fd });
    var j = await r.json();
    if (j.error) throw new Error(j.error.message);
  }

  /* ---------------- curadoria ---------------- */

  async function mudarStatus(oids, status) {
    var updates = oids.map(function (o) {
      return { attributes: { objectid: o, status: status } };
    });
    conferir(await rest(CFG.camadaPoligonos + "/applyEdits",
                        { updates: JSON.stringify(updates) }));
  }

  async function excluirPoligonos(oids) {
    // o detalhamento por classe é filho do polígono: apaga junto, senão a
    // consolidação por classe contaria área/biomassa de polígono excluído
    if (CFG.tabelaQueimadaClasse) {
      for (var i0 = 0; i0 < oids.length; i0 += 200) {
        var lote = oids.slice(i0, i0 + 200);
        var jg = await rest(CFG.camadaPoligonos + "/query", {
          where: "objectid IN (" + lote.join(",") + ")",
          outFields: "globalid", returnGeometry: "false"
        });
        var gids = (jg.features || []).map(function (f2) {
          return "'" + f2.attributes.globalid + "'";
        });
        if (gids.length) {
          await rest(CFG.tabelaQueimadaClasse + "/deleteFeatures", {
            where: "poligono_gid IN (" + gids.join(",") + ")"
          });
        }
      }
    }
    for (var i = 0; i < oids.length; i += 500) {
      conferir(await rest(CFG.camadaPoligonos + "/applyEdits",
                          { deletes: oids.slice(i, i + 500).join(",") }));
    }
  }

  /**
   * Recalcula area_ha/n_poligonos das linhas de controle de um dia a partir
   * dos polígonos que REALMENTE existem. A curadoria por exclusão apaga
   * polígonos da camada; sem esta sincronização o total oficial — que o
   * painel soma da tabela de controle — ficaria inflado para sempre.
   */
  async function sincronizarControle(quadId, diaPass, res) {
    var wh = ondeDoDia(quadId, diaPass, res);
    var polis = await consultarTudo(CFG.camadaPoligonos, wh, "celula,area_ha");
    var porCel = {};
    polis.forEach(function (p2) {
      var s = porCel[p2.celula] = porCel[p2.celula] || { area: 0, n: 0 };
      s.area += (p2.area_ha || 0);
      s.n += 1;
    });
    var ctrl = await consultarTudo(CFG.tabelaControle,
      wh + " AND status_proc IN ('calculada','sem_area')", "objectid,celula");
    if (!ctrl.length) return;
    var updates = ctrl.map(function (c) {
      var s = porCel[c.celula] || { area: 0, n: 0 };
      return { attributes: {
        objectid: c.objectid,
        area_ha: Math.round(s.area * 100) / 100, n_poligonos: s.n,
        status_proc: s.n ? "calculada" : "sem_area"
      } };
    });
    conferir(await rest(CFG.tabelaControle + "/applyEdits", {
      updates: JSON.stringify(updates)
    }));
  }

  function ondeDoDia(quadId, diaPass, res) {
    return "quad_id = '" + quadId + "' AND " + janelaDia(diaPass) +
           (res ? " AND res_m = " + Number(res) : "");
  }

  function diaSeguinte(d) {
    var t = new Date(d + "T00:00:00Z").getTime() + 864e5;
    return new Date(t).toISOString().slice(0, 10);
  }

  /** Apaga por where os polígonos de uma célula×dia (deleteFeatures) —
      e o detalhamento por classe, que é filho deles. */
  async function apagarPoligonos(quadId, res, celN, diaPass) {
    var wh = "quad_id = '" + quadId + "' AND celula = " + celN +
             " AND res_m = " + Number(res) + " AND " + janelaDia(diaPass);
    await rest(CFG.camadaPoligonos + "/deleteFeatures", { where: wh });
    if (CFG.tabelaQueimadaClasse) {
      await rest(CFG.tabelaQueimadaClasse + "/deleteFeatures", { where: wh });
    }
  }

  /* Passagens de células que "pularam" o dia D: cadeia com base anterior a
     ele (calculada/sem_area com data_ref < D) OU cadeia que recomeçou por
     cima do buraco (linha 'base' posterior a D — data_ref dela é nulo, por
     isso o OR). Sempre restrito a data_pass depois de D. */
  function wherePuladas(quadId, res, cels, diaPass) {
    return "quad_id = '" + quadId + "'" +
      " AND res_m = " + Number(res) +
      " AND celula IN (" + cels.join(",") + ")" +
      " AND data_pass >= timestamp '" + diaSeguinte(diaPass) + " 00:00:00'" +
      " AND ((data_ref < timestamp '" + diaPass + " 00:00:00'" +
      " AND status_proc IN ('calculada','sem_area'))" +
      " OR status_proc = 'base')";
  }

  /** Apaga a(s) linha(s) de controle de UMA célula×dia (rastro do erro). */
  async function apagarLinhaControle(q, res, cl, diaPass) {
    var wh = "quad_id = '" + q.id + "' AND celula = " + cl.n +
             " AND res_m = " + Number(res) + " AND " + janelaDia(diaPass);
    var ctrl = await consultarTudo(CFG.tabelaControle, wh, "objectid");
    if (ctrl.length) {
      conferir(await rest(CFG.tabelaControle + "/applyEdits", {
        deletes: ctrl.map(function (c) { return c.objectid; }).join(",")
      }));
    }
  }

  /**
   * Reabre as passagens da célula que passaram POR CIMA do dia (base
   * anterior a ele, ou "base" recriada depois dele — wherePuladas) e
   * devolve os dias reabertos, para o processar reinserir na fila da
   * sessão. Rodar em toda passagem viável cobre tanto o erro reprocessado
   * quanto a cena publicada com atraso; no fluxo normal a consulta volta
   * vazia e nada acontece.
   */
  async function reabrirPuladas(q, res, cl, diaPass) {
    var puladas = await consultarTudo(CFG.tabelaControle,
      wherePuladas(q.id, res, [cl.n], diaPass), "data_pass");
    var dias = {};
    puladas.forEach(function (f) {
      dias[dia(new Date(f.data_pass).toISOString())] = true;
    });
    var reabertos = Object.keys(dias).sort();
    for (var i = 0; i < reabertos.length; i++) {
      await apagarDia(q.id, reabertos[i], res, [cl.n]);
    }
    return reabertos;
  }

  /* Linhas de controle do quadrante que usaram o dia D como base. Só
     calculada/sem_area têm data_ref válido — o filtro impede a cascata de
     capturar (e apagar) uma passagem vetada como "ignorada". */
  function ondeBaseNoDia(quadId, diaPass, res) {
    return "quad_id = '" + quadId + "'" +
           (res ? " AND res_m = " + Number(res) : "") +
           " AND data_ref >= timestamp '" + diaPass + " 00:00:00'" +
           " AND data_ref < timestamp '" + diaSeguinte(diaPass) + " 00:00:00'" +
           " AND status_proc IN ('calculada','sem_area')";
  }

  /**
   * A cadeia célula a célula que depende (direta ou indiretamente) do dia
   * mexido: quem usou D como base, quem usou esses como base, e assim por
   * diante. Além do controle, consulta os POLÍGONOS pelo data_ref — pega
   * órfãos de tentativas cuja linha de controle falhou ou virou "erro".
   *
   * Devolve [{dia, celulas}] em ordem cronológica: só as células que de
   * fato dependem, para a cascata não apagar curadoria de célula alheia.
   */
  async function dependentesDe(quadId, diaPass, res) {
    var visto = {};                       // "dia|celula" -> true
    var saida = {};                       // dia -> {celula: true}
    var fila = [{ dia: diaPass, celulas: null }];   // null = dia inteiro

    while (fila.length) {
      var item = fila.shift();
      var emCelulas = item.celulas && item.celulas.length
        ? " AND celula IN (" + item.celulas.join(",") + ")" : "";
      var refJanela =
        " AND data_ref >= timestamp '" + item.dia + " 00:00:00'" +
        " AND data_ref < timestamp '" + diaSeguinte(item.dia) + " 00:00:00'";

      var rows = await consultarTudo(CFG.tabelaControle,
        ondeBaseNoDia(quadId, item.dia, res) + emCelulas, "celula,data_pass");
      rows = rows.concat(await consultarTudo(CFG.camadaPoligonos,
        "quad_id = '" + quadId + "'" +
        (res ? " AND res_m = " + Number(res) : "") +
        refJanela + emCelulas, "celula,data_pass"));

      var novos = {};                     // dia -> [celulas]
      rows.forEach(function (f) {
        var d = dia(new Date(f.data_pass).toISOString());
        var k = d + "|" + f.celula;
        if (visto[k]) return;
        visto[k] = true;
        (novos[d] = novos[d] || []).push(f.celula);
        (saida[d] = saida[d] || {})[f.celula] = true;
      });
      for (var d2 in novos) fila.push({ dia: d2, celulas: novos[d2] });
    }

    return Object.keys(saida).sort().map(function (d3) {
      return { dia: d3, celulas: Object.keys(saida[d3]).map(Number) };
    });
  }

  /**
   * Apaga polígonos e linhas de controle de um dia do quadrante —
   * opcionalmente restrito a uma lista de células (a cascata usa isso para
   * não levar junto célula que não dependia do dia mexido).
   */
  async function apagarDia(quadId, diaPass, res, celulas) {
    var wh = ondeDoDia(quadId, diaPass, res) +
      (celulas && celulas.length
        ? " AND celula IN (" + celulas.join(",") + ")" : "");
    // controle PRIMEIRO: se a rede cair entre os passos, o dia fica sem
    // linha e volta à fila — a higiene do processar (apagarPoligonos)
    // limpa o que sobrou. Na ordem inversa sobraria linha "calculada" com
    // área e zero polígonos, que nunca seria revisitada.
    var ctrl = await consultarTudo(CFG.tabelaControle, wh, "objectid");
    if (ctrl.length) {
      conferir(await rest(CFG.tabelaControle + "/applyEdits", {
        deletes: ctrl.map(function (c) { return c.objectid; }).join(",")
      }));
    }
    if (CFG.tabelaQueimadaClasse) {
      await rest(CFG.tabelaQueimadaClasse + "/deleteFeatures", { where: wh });
    }
    var polis = await consultarTudo(CFG.camadaPoligonos, wh, "objectid");
    if (polis.length) {
      await excluirPoligonos(polis.map(function (p2) { return p2.objectid; }));
    }
    return { poligonos: polis.length, linhas: ctrl.length };
  }

  /**
   * Ignora a passagem inteira: apaga os polígonos e marca o controle.
   * As passagens que usavam este dia como base são reabertas em cascata —
   * foram medidas contra uma cena agora declarada ruim e serão recalculadas
   * contra a última base aceita antes dela.
   */
  async function ignorarPassagem(quadId, diaPass, motivo, res) {
    var dep = await dependentesDe(quadId, diaPass, res);

    var wh = ondeDoDia(quadId, diaPass, res);
    // marca PRIMEIRO, apaga depois: se a rede cair no meio, sobra linha
    // "ignorada" com polígonos ainda visíveis — o operador re-ignora e
    // resolve. Na ordem inversa sobraria linha "calculada" sem polígonos.
    var ctrl = await consultarTudo(CFG.tabelaControle, wh, "objectid");
    if (ctrl.length) {
      conferir(await rest(CFG.tabelaControle + "/applyEdits", {
        updates: JSON.stringify(ctrl.map(function (c) {
          return { attributes: { objectid: c.objectid, status_proc: "ignorada",
                                 motivo: (motivo || "").slice(0, 240),
                                 area_ha: 0, n_poligonos: 0 } };
        }))
      }));
    }
    var polis = await consultarTudo(CFG.camadaPoligonos, wh, "objectid");
    if (polis.length) {
      await excluirPoligonos(polis.map(function (p2) { return p2.objectid; }));
    }

    for (var i = 0; i < dep.length; i++) {
      await apagarDia(quadId, dep[i].dia, res, dep[i].celulas);
    }
    return { cascata: dep };
  }

  /**
   * Reabre a passagem: apaga polígonos E linhas de controle do dia,
   * devolvendo-a à fila de pendências — e reabre em CASCATA as passagens
   * que a usavam como base (direta ou indiretamente), para nenhuma linha
   * ficar calculada contra um elo que não existe mais. Use dependentesDe()
   * antes para mostrar o custo ao usuário.
   */
  /**
   * As passagens que passaram por cima do dia D (base anterior a ele, ou
   * "base" recriada depois dele), nas células que tinham linha em D. É o
   * complemento de dependentesDe para reabrir um dia NÃO aceito (erro ou
   * nublada): quem pulou o buraco precisa recalcular caso o dia reaberto
   * vire viável. Consultar ANTES de apagar as linhas do dia.
   */
  async function puladasDe(quadId, diaPass, res) {
    var linhasDia = await consultarTudo(CFG.tabelaControle,
      ondeDoDia(quadId, diaPass, res), "celula");
    var celulasDia = {};
    linhasDia.forEach(function (f) { celulasDia[f.celula] = true; });
    var cels = Object.keys(celulasDia).map(Number);
    if (!cels.length) return [];

    var rows = await consultarTudo(CFG.tabelaControle,
      wherePuladas(quadId, res, cels, diaPass), "celula,data_pass");
    var saida = {};
    rows.forEach(function (f) {
      var d = dia(new Date(f.data_pass).toISOString());
      (saida[d] = saida[d] || {})[f.celula] = true;
    });
    return Object.keys(saida).sort().map(function (d3) {
      return { dia: d3, celulas: Object.keys(saida[d3]).map(Number) };
    });
  }

  async function reabrirPassagem(quadId, diaPass, res) {
    var dep = await dependentesDe(quadId, diaPass, res);
    var pul = await puladasDe(quadId, diaPass, res);
    var r = await apagarDia(quadId, diaPass, res, null);
    var extras = dep.concat(pul);
    for (var i = 0; i < extras.length; i++) {
      var ri = await apagarDia(quadId, extras[i].dia, res, extras[i].celulas);
      r.poligonos += ri.poligonos;
      r.linhas += ri.linhas;
    }
    r.cascata = extras;
    return r;
  }

  /** Atualiza atributos de uma linha do controle (ex.: nuvem medida). */
  async function atualizarControle(oid, attrs) {
    attrs = attrs || {};
    attrs.objectid = oid;
    conferir(await rest(CFG.tabelaControle + "/applyEdits", {
      updates: JSON.stringify([{ attributes: attrs }])
    }));
  }

  glob.Motor = {
    iniciar: iniciar,
    pendencias: pendencias,
    processar: processar,
    celulasDe: celulasDe,
    janelaDia: janelaDia,
    consultarTudo: consultarTudo,
    rest: rest,
    mudarStatus: mudarStatus,
    excluirPoligonos: excluirPoligonos,
    sincronizarControle: sincronizarControle,
    ignorarPassagem: ignorarPassagem,
    reabrirPassagem: reabrirPassagem,
    dependentesDe: dependentesDe,
    puladasDe: puladasDe,
    atualizarControle: atualizarControle,
    anexar: anexar,
    conferir: conferir,
    custoPorPx: custoPorPx
  };
})(window);
