/* =====================================================================
   modal-passagem.js — a estação de trabalho de UMA passagem.

   O painel lateral respondia "quanto queimou"; aqui se responde "isso é
   mesmo queimada?". Para isso a estação junta, no mesmo mapa e na mesma
   data:

     · cor verdadeira da passagem      — é nuvem? é sombra? é fumaça?
     · cor verdadeira da referência    — já estava assim antes do fogo?
     · falsa cor (SWIR/NIR/verde)      — a cicatriz realçada
     · máscara de nuvem do SCL         — onde exatamente está a nuvem,
                                         medida NO RECORTE e não na cena

   Tudo o que é gerado vira anexo da linha de controle: paga-se uma vez,
   e a próxima abertura é de graça. Os produtos são pedidos no MESMO
   recorte da célula (EPSG:3857) do processamento e georreferenciados
   pelos quatro cantos convertidos para lon/lat — é o que faz a imagem
   cair exatamente em cima do polígono.
   ===================================================================== */
(function (glob) {
  "use strict";

  var SDK = null;      // módulos do Maps SDK, entregues pelo painel
  var ctx = {};        // {alerta, aviso, aoMudar}
  var S = null;        // estado da passagem aberta
  var V = {};          // mapa e camadas do modal
  var urls = [];       // object URLs a revogar no fechamento
  var pronto = false;

  /* Lado máximo da vista. O recorte cheio de uma fatia de 20 m tem ~2,4
     Mpx e custaria ~9 PU só para olhar; a 1200 px o pixel fica em ~40 m,
     de sobra para separar nuvem de cicatriz, por ~2,5 PU. */
  var MAX_PX = 1200;

  function $(id) { return document.getElementById(id); }
  function fmt(v, c) {
    return Number(v).toLocaleString("pt-BR",
      { minimumFractionDigits: c || 0, maximumFractionDigits: c || 0 });
  }
  function dia(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function dataBr(d) { return d ? d.split("-").reverse().join("/") : "—"; }
  /* formata um item {dia, celulas} da cascata de Motor.dependentesDe */
  function diaDep(d) {
    return dataBr(d.dia) + " (célula" + (d.celulas.length > 1 ? "s " : " ") +
           d.celulas.join(", ") + ")";
  }
  function esc(s) {
    var e = document.createElement("div");
    e.textContent = String(s == null ? "" : s);
    return e.innerHTML;
  }
  function avisar(t) { (ctx.aviso || alert)(t); }

  /* ---------------- catálogo de vistas ---------------- */

  var VISTAS = [
    {
      id: "verd", prefixo: "corverd_", bandas: 4,
      rotulo: "Cor verdadeira — passagem",
      dica: "Como o olho veria no dia. É aqui que se descobre se o “queimado” é nuvem, sombra ou fumaça.",
      eval: function () { return Copernicus.EVAL_COR_VERDADEIRA; },
      data: function (l) { return dia(l.data_pass); }
    },
    {
      id: "vref", prefixo: "corvref_", bandas: 4,
      rotulo: "Cor verdadeira — referência",
      dica: "A mesma área na data usada como “antes”. Se a mancha já estava lá, não é fogo desta passagem.",
      eval: function () { return Copernicus.EVAL_COR_VERDADEIRA; },
      data: function (l) { return l.data_ref ? dia(l.data_ref) : null; }
    },
    {
      id: "falsa", prefixo: "falsacor_", bandas: 3,
      rotulo: "Falsa cor — realce da queimada",
      dica: "NIR/vermelho/verde: vegetação viva em vermelho, cicatriz em marrom escuro. Gravada no processamento.",
      eval: function () { return Copernicus.EVAL_FALSA_COR; },
      data: function (l) { return dia(l.data_pass); }
    },
    {
      id: "nuvem", prefixo: "scl_", bandas: 1, scl: true,
      rotulo: "Máscara de nuvem (SCL)",
      dica: "Classificação do próprio Sentinel-2. Mede a nuvem DENTRO do recorte — o filtro automático usa a cena inteira, de 110×110 km.",
      eval: function () { return Copernicus.EVAL_SCL; },
      data: function (l) { return dia(l.data_pass); }
    }
  ];

  function vistaPorId(id) {
    return VISTAS.filter(function (v) { return v.id === id; })[0];
  }

  /* ---------------- custo ---------------- */

  function dimensoes(ft, v) {
    if (v.scl) return Nuvem.dimensoes(ft, CFG.divisorSonda);
    var lado = Math.max(ft.largura, ft.altura);
    var k = lado > MAX_PX ? MAX_PX / lado : 1;
    return { w: Math.max(32, Math.round(ft.largura * k)),
             h: Math.max(32, Math.round(ft.altura * k)) };
  }

  function puDaVista(v) {
    var total = 0;
    S.fatias.forEach(function (ft) {
      var d = dimensoes(ft, v);
      total += d.w * d.h / 262144 * (v.bandas / 3);
    });
    return Math.max(0.1, Math.round(total * 10) / 10);
  }

  /* ---------------- Portal: anexos ---------------- */

  function anexoDe(l, prefixo) {
    return (l.__anexos || []).filter(function (a) {
      return String(a.name).indexOf(prefixo) === 0;
    })[0];
  }

  async function lerAnexos(l) {
    var j = await Motor.rest(CFG.tabelaControle + "/" + l.objectid + "/attachments", {});
    l.__anexos = j.attachmentInfos || [];
  }

  async function blobDoAnexo(l, a) {
    var url = CFG.tabelaControle + "/" + l.objectid + "/attachments/" + a.id +
              "?token=" + encodeURIComponent(Auth.token());
    var r = await fetch(url);
    if (!r.ok) throw new Error("anexo HTTP " + r.status);
    return r.blob();
  }

  /* ---------------- georreferência ---------------- */

  /* Os quatro cantos do recorte UTM convertidos para lon/lat. O retângulo
     em metros vira um quadrilátero levemente torto em lon/lat, e é essa
     torção que o CornersGeoreference reproduz. Usar um bbox lat/lon
     "equivalente" erraria por até ~200 m no canto de uma fatia de 46 km. */
  function cantosDe(ft) {
    var c = Geo.conversorParaWGS84(ft.epsg);
    var b = ft.bbox;
    function pt(p) {
      return { x: p[0], y: p[1], spatialReference: { wkid: 4326 } };
    }
    return new SDK.Corners({
      topLeft: pt(c(b[0], b[3])), topRight: pt(c(b[2], b[3])),
      bottomLeft: pt(c(b[0], b[1])), bottomRight: pt(c(b[2], b[1]))
    });
  }

  /* MediaLayer não tem removeAll, e atribuir source depois de
     materializado é ignorado em silêncio — herança de cicatriz da
     Calculadora. Mexer em source.elements é o caminho que funciona. */
  function definirMidia(camada, elementos) {
    var s = camada.source;
    if (s && s.elements) {
      s.elements.removeAll();
      if (elementos && elementos.length) s.elements.addMany(elementos);
    } else {
      camada.source = elementos || [];
    }
  }

  /* ---------------- carregar / gerar uma vista ---------------- */

  /** Monta a vista a partir dos anexos já pagos. Não gasta PU. */
  async function carregarVista(v) {
    var elementos = [], achou = 0, medida = null;
    for (var i = 0; i < S.linhas.length; i++) {
      var l = S.linhas[i];
      var ft = S.porFatia[l.celula];
      if (!ft) continue;
      var a = anexoDe(l, v.prefixo);
      if (!a) continue;
      var blob = await blobDoAnexo(l, a);
      achou++;
      var imagem;
      if (v.scl) {
        var r = await Nuvem.ler(blob);
        imagem = Nuvem.pintar(r);
        medida = r;
        l.__nuvemRec = r;
      } else {
        var u = URL.createObjectURL(blob);
        urls.push(u);
        imagem = u;
      }
      elementos.push(new SDK.ImageElement({
        image: imagem, georeference: cantosDe(ft), opacity: 1
      }));
    }
    definirMidia(V.midia[v.id], elementos);
    V.midia[v.id].visible = elementos.length > 0;
    S.vistas[v.id] = { carregada: elementos.length > 0, fatias: achou, medida: medida };
    return achou;
  }

  /** Pede ao Copernicus, anexa no controle (cache) e mostra. */
  async function gerarVista(v) {
    if (!(await Copernicus.tokenValido())) await Copernicus.entrar();
    var feitas = 0;

    for (var i = 0; i < S.linhas.length; i++) {
      var l = S.linhas[i];
      var ft = S.porFatia[l.celula];
      if (!ft) continue;
      var data = v.data(l);
      if (!data) continue;
      if (anexoDe(l, v.prefixo)) { feitas++; continue; }

      var d = dimensoes(ft, v);
      var blob = await Copernicus.baixarRecorte({
        bbox: ft.bbox, epsg: ft.epsg, largura: d.w, altura: d.h,
        data: data, evalscript: v.eval(), formato: "image/png"
      });
      Pu.somar(d.w * d.h / 262144 * (v.bandas / 3));
      await Motor.anexar(l.objectid, v.prefixo + data + "_c" + l.celula + ".png", blob);
      await lerAnexos(l);
      feitas++;
    }
    if (!feitas) throw new Error("nada a gerar para esta vista");

    await carregarVista(v);

    // a nuvem medida vale mais que o palpite da cena: fica gravada
    if (v.scl) await gravarNuvem();
  }

  async function gravarNuvem() {
    for (var i = 0; i < S.linhas.length; i++) {
      var l = S.linhas[i];
      if (!l.__nuvemRec) continue;
      try {
        await Motor.atualizarControle(l.objectid, {
          nuvem_rec: l.__nuvemRec.pct,
          nuvem_rec_det: l.__nuvemRec.detalhe.slice(0, 120)
        });
        l.nuvem_rec = l.__nuvemRec.pct;
        l.nuvem_rec_det = l.__nuvemRec.detalhe;
      } catch (e) { console.warn("nuvem_rec:", e); }
    }
  }

  /* ---------------- polígonos ---------------- */

  /**
   * Carrega os polígonos da passagem para o mapa — os MAIORES primeiro e
   * com teto (CFG.maxPoligonosMapa). Uma passagem de quadrante a 10 m
   * pode ter mais de 100 mil feições: carregar todas trava o navegador
   * antes de desenhar qualquer coisa. O teto é só de DESENHO; o que está
   * gravado e o que a consolidação conta não mudam. S.total guarda
   * quantas existem de verdade, para a interface avisar.
   */
  async function carregarPoligonos() {
    var wh = "quad_id = '" + S.quad.id + "' AND " + Motor.janelaDia(S.dia) +
             " AND res_m = " + S.res;

    var jc = await Motor.rest(CFG.camadaPoligonos + "/query", {
      where: wh, returnCountOnly: "true"
    });
    S.total = jc.count || 0;

    var teto = Number(CFG.maxPoligonosMapa || 4000);
    var feicoes = [], offset = 0;
    while (feicoes.length < teto) {
      var j = await Motor.rest(CFG.camadaPoligonos + "/query", {
        where: wh, outFields: "objectid,quad_id,celula,area_ha,dnbr_med,status",
        returnGeometry: "true", outSR: "4326",
        orderByFields: "area_ha DESC,objectid",
        resultOffset: String(offset),
        resultRecordCount: String(Math.min(2000, teto - feicoes.length))
      });
      var fs = j.features || [];
      feicoes = feicoes.concat(fs);
      if (!j.exceededTransferLimit || !fs.length) break;
      offset += fs.length;
    }
    S.feicoes = feicoes;
    S.sel = [];
    desenharPoligonos();
    return feicoes.length;
  }

  function desenharPoligonos() {
    V.gPoli.removeAll();
    var ext = null, graficos = [];
    S.feicoes.forEach(function (f) {
      var g = new SDK.Polygon({ rings: f.geometry.rings,
                                spatialReference: { wkid: 4326 } });
      graficos.push(new SDK.Graphic({
        geometry: g, attributes: f.attributes,
        symbol: simbolo(f.attributes, S.sel.indexOf(f.attributes.objectid) >= 0)
      }));
      ext = ext ? ext.union(g.extent) : g.extent.clone();
    });
    V.gPoli.addMany(graficos);
    S.extPoli = ext;
  }

  function simbolo(at, sel) {
    var prescrita = at.status === "Queima prescrita";
    return {
      type: "simple-fill",
      color: prescrita ? [60, 120, 216, sel ? 0.75 : 0.35]
                       : [217, 60, 35, sel ? 0.8 : 0.4],
      outline: {
        color: sel ? [0, 220, 255, 1] : (prescrita ? [20, 60, 130, 1] : [255, 210, 40, 1]),
        width: sel ? 3 : 1.4
      }
    };
  }

  function repintar() {
    V.gPoli.graphics.forEach(function (g) {
      g.symbol = simbolo(g.attributes, S.sel.indexOf(g.attributes.objectid) >= 0);
    });
    pintarSelecao();
  }

  function pintarSelecao() {
    var n = S.sel.length;
    var ha = 0;
    V.gPoli.graphics.forEach(function (g) {
      if (S.sel.indexOf(g.attributes.objectid) >= 0) ha += g.attributes.area_ha || 0;
    });
    var desenhados = S.feicoes ? S.feicoes.length : 0;
    var corte = (S.total || 0) > desenhados
      ? '<br><span class="mp-aviso">mostrando os <b>' + fmt(desenhados) +
        "</b> maiores de <b>" + fmt(S.total) + "</b> polígonos da passagem" +
        " — os menores não são desenhados (o mapa travaria), mas <b>contam" +
        " normalmente</b> na consolidação. “Selecionar tudo” pega só os" +
        " desenhados.</span>"
      : "";
    $("mpSelecao").innerHTML = (n
      ? "<b>" + fmt(n) + "</b> selecionado(s) · " + fmt(ha, 1) + " ha"
      : "Nenhum polígono selecionado — clique nos do mapa.") + corte;
    ["mpPrescrita", "mpQueimada", "mpExcluir"].forEach(function (id) {
      $(id).disabled = !n;
    });
  }

  /* ---------------- mapa do modal ---------------- */

  function montarMapa() {
    if (V.view) return;
    V.midia = {};
    var camadas = [];
    ["vref", "verd", "falsa", "nuvem"].forEach(function (id) {
      V.midia[id] = new SDK.MediaLayer({ title: id, visible: false });
      camadas.push(V.midia[id]);
    });
    V.gFatias = new SDK.GraphicsLayer();
    V.lUC = new SDK.GeoJSONLayer({
      url: "dados/quadrantes.geojson", outFields: ["id"],
      definitionExpression: "id = '-'",
      renderer: { type: "simple", symbol: {
        type: "simple-fill", color: [0, 0, 0, 0],
        outline: { color: [70, 240, 140, 0.95], width: 2 } } }
    });
    V.gPoli = new SDK.GraphicsLayer();
    camadas.push(V.gFatias, V.lUC, V.gPoli);

    V.mapa = new SDK.Map({ basemap: "satellite", layers: camadas });
    V.view = new SDK.MapView({
      container: "mpMapa", map: V.mapa, center: [-44.5, -18.5], zoom: 6,
      popupEnabled: false, constraints: { snapToZoom: false }
    });

    V.view.on("click", function (ev) {
      V.view.hitTest(ev, { include: [V.gPoli] }).then(function (r) {
        if (!r.results.length) return;
        var at = r.results[0].graphic.attributes;
        var i = S.sel.indexOf(at.objectid);
        if (i >= 0) S.sel.splice(i, 1); else S.sel.push(at.objectid);
        repintar();
      });
    });
  }

  function desenharFatias() {
    V.gFatias.removeAll();
    S.fatias.forEach(function (ft) {
      var c = Geo.conversorParaWGS84(ft.epsg), b = ft.bbox;
      var anel = [c(b[0], b[1]), c(b[2], b[1]), c(b[2], b[3]), c(b[0], b[3]), c(b[0], b[1])];
      V.gFatias.add(new SDK.Graphic({
        geometry: new SDK.Polygon({ rings: [anel], spatialReference: { wkid: 4326 } }),
        symbol: { type: "simple-fill", color: [0, 0, 0, 0],
                  outline: { color: [255, 150, 20, 0.85], width: 1.2, style: "dash" } }
      }));
    });
  }

  function enquadrar() {
    var alvo = S.extPoli;
    if (!alvo && V.gFatias.graphics.length) {
      V.gFatias.graphics.forEach(function (g) {
        alvo = alvo ? alvo.union(g.geometry.extent) : g.geometry.extent.clone();
      });
    }
    if (alvo) V.view.goTo(alvo.expand(1.15)).catch(function () { });
  }

  /* ---------------- painel de dados ---------------- */

  function pintarDados() {
    var l0 = S.linhas[0] || {};
    var area = S.linhas.reduce(function (a, l) { return a + (l.area_ha || 0); }, 0);
    var nPoli = S.feicoes ? S.feicoes.length : 0;
    var pu = S.linhas.reduce(function (a, l) { return a + (l.pu_gasto || 0); }, 0);

    var vao = (l0.data_ref && l0.data_pass)
      ? Math.round((l0.data_pass - l0.data_ref) / 864e5) : null;

    var html = '<div class="mp-grade">' +
      '<div><b>' + fmt(area, 1) + ' ha</b><span>área queimada</span></div>' +
      '<div><b>' + fmt(nPoli) + '</b><span>polígonos</span></div>' +
      '<div><b>' + S.res + ' m</b><span>resolução</span></div>' +
      '<div><b>' + fmt(pu, 1) + '</b><span>PU já gastos</span></div>' +
      '</div>';

    // referência: o alerta que muda a leitura do número acima
    if (vao != null) {
      html += '<p class="mp-nota' + (vao > 20 ? ' mp-alerta' : '') + '">' +
        'Referência: <b>' + dataBr(dia(l0.data_ref)) + '</b> — ' + vao + ' dias antes' +
        (vao > 20 ? '. Nesse vão a vegetação seca sozinha: parte do dNBR pode ser ' +
                    'estiagem, não fogo. Confira na cor verdadeira da referência.' : '.') +
        '</p>';
    }

    html += '<table class="mp-tabela"><thead><tr><th>célula</th><th>estado</th>' +
            '<th>ha</th><th>nuvem cena</th><th>nuvem recorte</th></tr></thead><tbody>';
    S.linhas.forEach(function (l) {
      var rec = l.nuvem_rec != null
        ? '<b>' + fmt(l.nuvem_rec, 1) + '%</b>'
        : '<span class="mp-vazio">não medida</span>';
      html += '<tr><td>' + l.celula + '/' + (l.total_celulas || S.fatias.length) + '</td>' +
        '<td>' + esc(l.status_proc || "—") + '</td>' +
        '<td>' + fmt(l.area_ha || 0, 1) + '</td>' +
        '<td>' + (l.nuvem_pct != null ? fmt(l.nuvem_pct, 0) + "%" : "—") + '</td>' +
        '<td>' + rec + '</td></tr>';
      if (l.nuvem_rec_det) {
        html += '<tr class="mp-det"><td colspan="5">' + esc(l.nuvem_rec_det) + '</td></tr>';
      }
      if (l.motivo) {
        html += '<tr class="mp-det"><td colspan="5">motivo: ' + esc(l.motivo) + '</td></tr>';
      }
    });
    html += '</tbody></table>';

    var nuvemCena = l0.nuvem_pct;
    var nuvemRec = l0.nuvem_rec;
    if (nuvemCena != null && nuvemRec != null && nuvemCena - nuvemRec > 20) {
      html += '<p class="mp-nota mp-bom">A cena inteira estava com ' + fmt(nuvemCena, 0) +
        '% de nuvem, mas no recorte da UC são ' + fmt(nuvemRec, 1) +
        '%. O corte automático usa a cena — se esta passagem foi descartada, ' +
        'vale reabrir e recalcular.</p>';
    }

    html += '<p class="mp-nota mp-fraco">Cena: ' + esc(l0.cena_id || "—") +
      '<br>Referência: ' + esc(l0.cena_ref_id || "—") +
      '<br>Processado por ' + esc(l0.processado_por || "—") + '</p>';

    $("mpDados").innerHTML = html;
  }

  /* ---------------- painel de camadas ---------------- */

  function pintarVistas() {
    var html = "";
    VISTAS.forEach(function (v) {
      var est = S.vistas[v.id] || {};
      var temData = S.linhas.some(function (l) { return !!v.data(l); });
      var carregada = est.carregada;
      var estado, acao = "";
      if (!temData) {
        estado = '<span class="mp-vazio">sem data de referência</span>';
      } else if (carregada) {
        estado = '<span class="mp-ok">na tela</span>';
        if (est.fatias < S.linhas.length) {
          acao = '<button class="btn btn-mini" data-gerar="' + v.id + '">completar · ' +
                 fmt(puDaVista(v), 1) + ' PU</button>';
        }
      } else {
        estado = '<span class="mp-vazio">não gerada</span>';
        acao = '<button class="btn btn-mini" data-gerar="' + v.id + '">gerar · ' +
               fmt(puDaVista(v), 1) + ' PU</button>';
      }
      html += '<div class="mp-vista">' +
        '<label><input type="checkbox" data-vista="' + v.id + '"' +
        (carregada && V.midia[v.id].visible ? " checked" : "") +
        (carregada ? "" : " disabled") + '> ' + esc(v.rotulo) + '</label>' +
        '<div class="mp-vista-fim">' + estado + acao + '</div>' +
        '<p class="mp-dica">' + esc(v.dica) + '</p>' +
        '</div>';
    });

    html += '<div class="mp-vista mp-vista-simples">' +
      '<label><input type="checkbox" data-camada="poli"' +
      (V.gPoli.visible ? " checked" : "") + '> Polígonos da passagem</label></div>' +
      '<div class="mp-vista mp-vista-simples">' +
      '<label><input type="checkbox" data-camada="uc"' +
      (V.lUC.visible ? " checked" : "") + '> Contorno do quadrante</label></div>' +
      '<div class="mp-vista mp-vista-simples">' +
      '<label><input type="checkbox" data-camada="fatias"' +
      (V.gFatias.visible ? " checked" : "") + '> Grade de células</label></div>';

    $("mpVistas").innerHTML = html;

    $("mpVistas").querySelectorAll("[data-vista]").forEach(function (c) {
      c.addEventListener("change", function () {
        V.midia[c.dataset.vista].visible = c.checked;
      });
    });
    $("mpVistas").querySelectorAll("[data-camada]").forEach(function (c) {
      c.addEventListener("change", function () {
        var alvo = { poli: V.gPoli, uc: V.lUC, fatias: V.gFatias }[c.dataset.camada];
        if (alvo) alvo.visible = c.checked;
      });
    });
    $("mpVistas").querySelectorAll("[data-gerar]").forEach(function (b) {
      b.addEventListener("click", function () { pedirVista(b.dataset.gerar, b); });
    });
  }

  async function pedirVista(id, botao) {
    var v = vistaPorId(id);
    var pu = puDaVista(v);
    if (!confirm(v.rotulo + "\n\nIsto pede ao Copernicus e consome cerca de " +
                 fmt(pu, 1) + " PU. Depois de gerada fica anexada à passagem e " +
                 "abrir de novo não custa nada.\n\nGerar?")) return;
    var txt = botao.textContent;
    botao.disabled = true; botao.textContent = "gerando…";
    try {
      await gerarVista(v);
      V.midia[v.id].visible = true;
      pintarVistas();
      pintarDados();
      if (ctx.aoGastar) ctx.aoGastar();
    } catch (e) {
      console.error(e);
      botao.disabled = false; botao.textContent = txt;
      avisar(v.rotulo + ": " + (e.message || e));
    }
  }

  /* ---------------- curadoria ---------------- */

  async function acao(tipo) {
    try {
      if (tipo === "prescrita") await Motor.mudarStatus(S.sel, "Queima prescrita");
      if (tipo === "queimada") await Motor.mudarStatus(S.sel, "Queimada");
      if (tipo === "excluir") {
        if (!confirm("Excluir " + S.sel.length + " polígono(s)? Não tem desfazer.")) return;
        await Motor.excluirPoligonos(S.sel);
        // o total oficial vem da tabela de controle — recalcula a área e a
        // contagem a partir dos polígonos que sobraram, senão infla p/ sempre
        await Motor.sincronizarControle(S.quad.id, S.dia, S.res);
      }
      if (tipo === "ignorar") {
        var motivo = prompt("Motivo para ignorar a passagem de " + dataBr(S.dia) +
          " (ex.: nuvem não detectada, fumaça, erro de cena):");
        if (motivo === null) return;
        var depI = await Motor.dependentesDe(S.quad.id, S.dia, S.res);
        if (depI.length && !confirm(
            "A(s) passagem(ns) de " + depI.map(diaDep).join(", ") +
            " foi(ram) calculada(s) usando " + dataBr(S.dia) + " como base.\n\n" +
            "Ao ignorar, ela(s) será(ão) reaberta(s) em cascata e recalculada(s) " +
            "no próximo “Processar” (contra a última base aceita). A curadoria " +
            "manual feita nesses dias — reclassificações e exclusões de " +
            "polígonos — será perdida e terá de ser refeita.\n\nContinuar?")) return;
        var ri = await Motor.ignorarPassagem(S.quad.id, S.dia, motivo, S.res);
        if (ri.cascata.length) {
          (ctx.alerta || alert)("Passagem ignorada. Reabertas em cascata: " +
            ri.cascata.map(diaDep).join(", ") + ".");
        }
      }
      if (tipo === "reabrir") {
        var depR = (await Motor.dependentesDe(S.quad.id, S.dia, S.res))
          .concat(await Motor.puladasDe(S.quad.id, S.dia, S.res));
        var avisoDep = depR.length
          ? "\n\nATENÇÃO: " + depR.length + " passagem(ns) posterior(es) usa(m) " +
            "este dia como base (" + depR.map(diaDep).join(", ") + ") e será(ão) " +
            "reaberta(s) junto, em cascata. A curadoria manual desses dias " +
            "(reclassificações e exclusões) será perdida."
          : "";
        if (!confirm("Reabrir a passagem de " + dataBr(S.dia) + "?\n\n" +
            "Apaga os polígonos e o registro de controle deste dia; ela volta " +
            "para a fila de pendências e é recalculada no próximo “Processar”." +
            avisoDep)) return;
        var r = await Motor.reabrirPassagem(S.quad.id, S.dia, S.res);
        (ctx.alerta || alert)("Passagem reaberta: " + r.poligonos + " polígono(s) e " +
          r.linhas + " linha(s) de controle apagados" +
          (r.cascata.length ? " (inclui a cascata de " + r.cascata.length +
            " passagem(ns))." : "."));
        fechar();
        if (ctx.aoMudar) ctx.aoMudar();
        return;
      }
      await carregarPoligonos();
      await recarregarLinhas();
      pintarDados();
      pintarSelecao();
      if (ctx.aoMudar) ctx.aoMudar();
    } catch (e) {
      console.error(e);
      avisar("Falhou: " + (e.message || e));
    }
  }

  async function recarregarLinhas() {
    var linhas = await Motor.consultarTudo(CFG.tabelaControle,
      "quad_id = '" + S.quad.id + "' AND " + Motor.janelaDia(S.dia) +
      " AND res_m = " + S.res,
      "*");
    linhas.sort(function (a, b) { return (a.celula || 0) - (b.celula || 0); });
    linhas.forEach(function (n) {
      var v = S.linhas.filter(function (o) { return o.objectid === n.objectid; })[0];
      if (v) { n.__anexos = v.__anexos; n.__nuvemRec = v.__nuvemRec; }
    });
    S.linhas = linhas;
  }

  /* ---------------- abrir / fechar ---------------- */

  async function abrir(q, d, res) {
    if (!SDK) { avisar("O mapa ainda está carregando."); return; }
    if (!Auth.token()) { avisar("Entre no Portal para abrir a passagem."); return; }

    $("modalPassagem").classList.remove("oculto");
    document.body.classList.add("com-modal");
    montarMapa();

    S = { quad: q, dia: d, res: String(res), linhas: [], fatias: [], porFatia: {},
          vistas: {}, sel: [], feicoes: [] };

    $("mpTitulo").textContent = "Passagem de " + dataBr(d);
    $("mpSub").textContent = "Quadrante " + q.id + " · " + res + " m · " +
      q.n_celulas + " célula(s)";
    $("mpDados").innerHTML = '<p class="mp-dica">Carregando…</p>';
    $("mpVistas").innerHTML = "";
    $("mpSelecao").textContent = "Carregando…";

    try {
      await recarregarLinhas();
      S.fatias = Motor.celulasDe(q, S.res);
      S.fatias.forEach(function (ft) { S.porFatia[ft.n] = ft; });

      desenharFatias();
      V.lUC.definitionExpression = "id = '" + q.id + "'";

      await carregarPoligonos();
      enquadrar();
      pintarDados();
      pintarSelecao();

      // anexos: mostra de graça tudo o que já foi pago
      for (var i = 0; i < S.linhas.length; i++) await lerAnexos(S.linhas[i]);
      for (var k = 0; k < VISTAS.length; k++) {
        try { await carregarVista(VISTAS[k]); }
        catch (e) { console.warn("vista", VISTAS[k].id, e); }
      }
      // só a falsa cor entra ligada; o resto o operador acende
      ["verd", "vref", "nuvem"].forEach(function (id) { V.midia[id].visible = false; });
      pintarVistas();
      pintarDados();
    } catch (e) {
      console.error(e);
      $("mpDados").innerHTML = '<p class="mp-nota mp-alerta">Não consegui carregar: ' +
        esc(e.message || e) + "</p>";
    }
  }

  function fechar() {
    $("modalPassagem").classList.add("oculto");
    document.body.classList.remove("com-modal");
    if (V.midia) {
      Object.keys(V.midia).forEach(function (id) {
        definirMidia(V.midia[id], []);
        V.midia[id].visible = false;
      });
    }
    if (V.gPoli) V.gPoli.removeAll();
    if (V.gFatias) V.gFatias.removeAll();
    urls.forEach(function (u) { URL.revokeObjectURL(u); });
    urls = [];
    S = null;
  }

  /* ---------------- ligações ---------------- */

  function ligar() {
    if (pronto) return;
    pronto = true;
    $("mpFechar").addEventListener("click", fechar);
    $("modalPassagem").addEventListener("click", function (ev) {
      if (ev.target === $("modalPassagem")) fechar();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !$("modalPassagem").classList.contains("oculto")) fechar();
    });
    $("mpOpacidade").addEventListener("input", function () {
      var o = Number(this.value) / 100;
      Object.keys(V.midia || {}).forEach(function (id) { V.midia[id].opacity = o; });
    });
    $("mpEnquadrar").addEventListener("click", enquadrar);
    $("mpTudo").addEventListener("click", function () {
      S.sel = S.feicoes.map(function (f) { return f.attributes.objectid; });
      repintar();
    });
    $("mpInverter").addEventListener("click", function () {
      var antes = S.sel;
      S.sel = S.feicoes.map(function (f) { return f.attributes.objectid; })
        .filter(function (o) { return antes.indexOf(o) < 0; });
      repintar();
    });
    $("mpLimpar").addEventListener("click", function () { S.sel = []; repintar(); });
    $("mpPrescrita").addEventListener("click", function () { acao("prescrita"); });
    $("mpQueimada").addEventListener("click", function () { acao("queimada"); });
    $("mpExcluir").addEventListener("click", function () { acao("excluir"); });
    $("mpIgnorar").addEventListener("click", function () { acao("ignorar"); });
    $("mpReabrir").addEventListener("click", function () { acao("reabrir"); });
  }

  glob.ModalPassagem = {
    iniciar: function (mods, opc) { SDK = mods; ctx = opc || {}; ligar(); },
    abrir: abrir,
    fechar: fechar,
    aberto: function () { return !!S; }
  };
})(window);
