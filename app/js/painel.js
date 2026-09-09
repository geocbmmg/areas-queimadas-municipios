/* =====================================================================
   painel.js — Áreas Queimadas dos 9 Municípios.

   A interface é uma LISTA DE ÁREAS QUEIMADAS, não um plano de trabalho
   por quadrante: um operador só, querendo ver o que queimou, quanto, de
   que classe, quanta biomassa e quanta emissão — e validar cada polígono
   olhando o antes e o depois.

   O que sumiu de propósito: quadrantes, "assumir", carga por militar e
   as células que passam do limite municipal. O recorte é o município.
   ===================================================================== */
(function () {
  "use strict";

  var LOTE = 200;
  var M = {}, V = {};
  var municipios = [];          // [{codigo, nome}]
  var itens = [];               // polígonos carregados
  var sel = null;               // polígono selecionado
  var offset = 0, total = 0;
  var efs = null;               // fatores de emissão, por classe
  var nomesClasse = {};

  function $(id) { return document.getElementById(id); }
  function fmt(v, c) {
    return Number(v).toLocaleString("pt-BR",
      { minimumFractionDigits: c || 0, maximumFractionDigits: c || 0 });
  }
  function dia(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function dataBr(d) { return d ? d.split("-").reverse().join("/") : "—"; }
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = String(s == null ? "" : s);
    return d.innerHTML;
  }
  function alerta(t) {
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = t;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }
  function aviso(t) { console.log("[mg]", t); alerta(t); }

  /* ---------------- sessões ---------------- */

  function iniciaisDe(u) {
    var p = String(u || "").split(/[.\s_@-]+/).filter(Boolean);
    if (!p.length) return "?";
    return (p[0][0] + (p[1] ? p[1][0] : (p[0][1] || ""))).toUpperCase();
  }

  function pintarSessaoPortal() {
    var u = Auth.usuario();
    $("btnEntrar").classList.toggle("oculto", !!u);
    $("perfil").classList.toggle("oculto", !u);
    if (u) {
      $("perfilAvatar").textContent = iniciaisDe(u);
      $("perfilNome").textContent = u;
    }
  }

  function pintarSessaoCop() {
    var s = Copernicus.lerSessao && Copernicus.lerSessao();
    var cli = Copernicus.lerCliente && Copernicus.lerCliente();
    var el = $("copStatus");
    el.textContent = s
      ? "Copernicus: " + (s.usuario || (cli ? "cliente OAuth" : "conectado"))
      : (cli ? "Copernicus: credencial salva" : "Copernicus: não conectado");
    el.classList.toggle("pill-ok", !!s);
    el.title = "clique para configurar o acesso";
  }

  /* ---------------- acesso ao Copernicus ---------------- */

  function abrirModalCop() {
    var cli = Copernicus.lerCliente();
    var s = Copernicus.lerSessao();
    $("copEstado").innerHTML = s
      ? "<b>Conectado</b>" + (s.usuario ? " como " + esc(s.usuario) : "") +
        (s.expira ? " · sessão até " +
          new Date(s.expira).toLocaleTimeString("pt-BR") : "")
      : (cli ? "Credencial de cliente salva — ainda não conectada nesta sessão."
             : "Sem acesso configurado.");
    $("copId").value = cli ? (cli.id || "") : "";
    $("copSegredo").value = cli ? (cli.segredo || "") : "";
    $("copEsquecer").disabled = !cli;
    $("modalCop").classList.remove("oculto");
  }

  function fecharModalCop() { $("modalCop").classList.add("oculto"); }

  async function salvarCliente() {
    var id = $("copId").value.trim();
    var seg = $("copSegredo").value.trim();
    if (!id || !seg) { aviso("Preencha o client ID e o secret."); return; }
    var b = $("copSalvar");
    b.disabled = true;
    b.textContent = "testando…";
    try {
      // testa ANTES de guardar: credencial errada salva em silêncio vira
      // um "não conectado" sem explicação na próxima vez
      await Copernicus.entrarComCliente(id, seg);
      Copernicus.guardarCliente(id, seg);
      pintarSessaoCop();
      abrirModalCop();
      alerta("Credencial válida e salva — Copernicus conectado.");
    } catch (e) {
      console.error(e);
      aviso("A credencial não foi aceita: " + (e.message || e));
    } finally {
      b.disabled = false;
      b.textContent = "Salvar e conectar";
    }
  }

  function pintarPu() {
    $("puChip").textContent = fmt(Math.round(Pu.usado())) + " PU";
    $("puChip").classList.toggle("pill-alerta",
      Pu.usado() > CFG.tetoTrabalhoPU);
  }
  Pu.aoMudar = pintarPu;

  /* ---------------- metodologia (B, C, EF) ---------------- */

  var metBC = [], metEF = [];

  async function abrirMetodologia() {
    if (!Auth.token()) { aviso("Entre no Portal para editar a metodologia."); return; }
    $("modalMet").classList.remove("oculto");
    $("metAviso").textContent = "carregando…";
    metBC = await Motor.consultarTudo(CFG.tabelaParametros, "1=1",
      "objectid,classe_id,classe_nome,b_t_ha,c_fracao,fonte,obs");
    metEF = await Motor.consultarTudo(CFG.tabelaFatoresEmissao, "1=1",
      "objectid,poluente,classe_id,ef_g_kg,fonte,obs");
    metBC.sort(function (a, b) { return (a.classe_id || 0) - (b.classe_id || 0); });
    metEF.sort(function (a, b) {
      return a.poluente === b.poluente
        ? (a.classe_id || 0) - (b.classe_id || 0)
        : (a.poluente < b.poluente ? -1 : 1);
    });
    pintarBC();
    pintarEF();
    $("metAviso").textContent = "";
  }

  function pintarBC() {
    var h = "<tr><th>cód</th><th>classe</th><th>B (t/ha)</th>" +
            "<th>C (0–1)</th><th>B×C (t/ha)</th><th>fonte</th></tr>";
    h += metBC.map(function (p, i) {
      var bc = (p.b_t_ha != null && p.c_fracao != null)
        ? (p.b_t_ha * p.c_fracao) : null;
      return "<tr><td>" + esc(p.classe_id) + "</td><td>" +
        esc(p.classe_nome || "") + "</td>" +
        '<td><input type="number" step="0.1" min="0" data-i="' + i +
        '" data-c="b_t_ha" value="' + (p.b_t_ha != null ? p.b_t_ha : "") + '"></td>' +
        '<td><input type="number" step="0.01" min="0" max="1" data-i="' + i +
        '" data-c="c_fracao" value="' + (p.c_fracao != null ? p.c_fracao : "") + '"></td>' +
        '<td class="bc-prod" id="bcp_' + i + '">' +
        (bc != null ? fmt(bc, 2) : "—") + "</td>" +
        '<td class="met-fonte" title="' + esc(p.fonte || "") + '">' +
        esc((p.fonte || "").slice(0, 42)) + "</td></tr>";
    }).join("");
    $("tabBC").innerHTML = h;
  }

  function pintarEF() {
    var h = "<tr><th>poluente</th><th>classe</th><th>EF (g/kg)</th>" +
            "<th>fonte</th><th></th></tr>";
    h += metEF.map(function (e, i) {
      return "<tr><td><b>" + esc(e.poluente) + "</b></td><td>" +
        (e.classe_id == null ? "<i>todas</i>" : esc(e.classe_id)) + "</td>" +
        '<td><input type="number" step="0.1" min="0" data-i="' + i +
        '" data-c="ef_g_kg" value="' + (e.ef_g_kg != null ? e.ef_g_kg : "") + '"></td>' +
        '<td class="met-fonte" title="' + esc(e.fonte || "") + '">' +
        esc((e.fonte || "").slice(0, 38)) + "</td>" +
        '<td><button class="btn-x" data-del="' + i + '">×</button></td></tr>';
    }).join("");
    $("tabEF").innerHTML = h;
  }

  async function salvarMetodologia() {
    var b = $("metSalvar");
    b.disabled = true;
    $("metAviso").textContent = "salvando…";
    try {
      var upBC = metBC.filter(function (p) { return p.__mudou; })
        .map(function (p) {
          return { attributes: { objectid: p.objectid, b_t_ha: p.b_t_ha,
                                 c_fracao: p.c_fracao } };
        });
      var upEF = metEF.filter(function (e) { return e.__mudou && e.objectid; })
        .map(function (e) {
          return { attributes: { objectid: e.objectid, ef_g_kg: e.ef_g_kg } };
        });
      var novosEF = metEF.filter(function (e) { return !e.objectid; })
        .map(function (e) {
          return { attributes: { poluente: e.poluente, classe_id: e.classe_id,
                                 ef_g_kg: e.ef_g_kg, fonte: e.fonte,
                                 obs: "definido no painel" } };
        });
      var delEF = (metEF.__apagar || []).filter(Boolean);

      if (upBC.length) {
        Motor.conferir(await Motor.rest(CFG.tabelaParametros + "/applyEdits",
          { updates: JSON.stringify(upBC) }));
      }
      if (upEF.length || novosEF.length || delEF.length) {
        Motor.conferir(await Motor.rest(CFG.tabelaFatoresEmissao + "/applyEdits", {
          updates: JSON.stringify(upEF), adds: JSON.stringify(novosEF),
          deletes: delEF.join(",")
        }));
      }
      Consolida.recarregarMetodologia();
      $("metAviso").textContent = "";
      alerta("Metodologia salva — vale já no painel e na próxima consolidação.");
      if (sel) selecionar(sel);
      await abrirMetodologia();
    } catch (e) {
      console.error(e);
      $("metAviso").textContent = "";
      aviso("Não salvou: " + (e.message || e));
    } finally {
      b.disabled = false;
    }
  }

  /* ---------------- tabelas de apoio ---------------- */

  async function carregarApoio() {
    // a metodologia mora no Consolida: uma fonte só para o painel e para
    // o fechamento do mês, senão os dois divergiriam sem ninguém ver
    var m = await Consolida.carregarMetodologia();
    efs = m.ef;
    for (var k in m.param) nomesClasse[k] = m.param[k].nome;
  }

  /**
   * A conta aberta de um polígono, classe a classe:
   * área (bruto) → B × C → biomassa → EF → emissões.
   * Nada disso vem gravado; tudo sai dos parâmetros atuais.
   */
  async function contaDe(poli) {
    var linhas = await Motor.consultarTudo(CFG.tabelaQueimadaClasse,
      "poligono_gid = '" + poli.globalid + "'",
      "classe_id,area_ha,n_pixels_classe");
    if (!linhas.length) {
      // sem detalhamento: usa a classe dominante sobre a área toda
      linhas = [{ classe_id: poli.classe_uso, area_ha: poli.area_ha,
                  n_pixels_classe: poli.n_pixels }];
    }
    var par = Consolida.parametros() || {};
    var itens = [], bioTotal = 0, temBio = false, emiss = {};
    var areaQueimada = 0, areaDescartada = 0;
    linhas.forEach(function (l) {
      var p = par[l.classe_id] || {};
      var queima = Consolida.classeQueima(l.classe_id);
      var bio = Consolida.biomassaDe(l.area_ha || 0, l.classe_id);
      if (bio != null) { bioTotal += bio; temBio = true; }
      if (queima) areaQueimada += l.area_ha || 0;
      else areaDescartada += l.area_ha || 0;
      itens.push({ classe: l.classe_id, nome: nomesClasse[l.classe_id],
                   area: l.area_ha || 0, px: l.n_pixels_classe,
                   b: p.b, c: p.c, bio: bio, queima: queima });
      if (bio == null) return;
      for (var pol in Consolida.poluentes()) {
        var ef = Consolida.efDe(pol, l.classe_id);
        if (ef == null) continue;
        emiss[pol] = (emiss[pol] || 0) + bio * ef;   // t × g/kg = kg
      }
    });
    return { itens: itens, biomassa: temBio ? bioTotal : null, emiss: emiss,
             areaQueimada: areaQueimada, areaDescartada: areaDescartada };
  }

  /* ---------------- busca ---------------- */

  function whereAtual() {
    var w = ["res_m = " + Number(CFG.resolucaoPadrao)];
    var mun = $("fMunicipio").value;
    if (mun) w.push("municipio = '" + mun + "'");
    var de = $("fDe").value, ate = $("fAte").value;
    if (de) w.push("competencia >= '" + de + "'");
    if (ate) w.push("competencia <= '" + ate + "'");
    var piso = Number($("fPiso").value || 0);
    if (piso > 0) w.push("area_ha >= " + (piso / 10000));
    return w.join(" AND ");
  }

  async function buscar(novo) {
    if (!Auth.token()) { aviso("Entre no Portal primeiro."); return; }
    if (novo) { itens = []; offset = 0; $("listaAreas").innerHTML = ""; }
    $("btnBuscar").disabled = true;
    $("listaTopo").textContent = "Buscando…";
    try {
      await carregarApoio();
      var wh = whereAtual();
      if (novo) {
        var jc = await Motor.rest(CFG.camadaPoligonos + "/query",
          { where: wh, returnCountOnly: "true" });
        total = jc.count || 0;
        var js = await Motor.rest(CFG.camadaPoligonos + "/query", {
          where: wh, returnGeometry: "false",
          outStatistics: JSON.stringify([
            { statisticType: "sum", onStatisticField: "area_ha",
              outStatisticFieldName: "a" },
            { statisticType: "sum", onStatisticField: "biomassa_t",
              outStatisticFieldName: "b" }])
        });
        var st = (js.features || [])[0];
        st = st ? st.attributes : { a: 0, b: 0 };
        $("resumoBusca").innerHTML = "<b>" + fmt(total) + "</b> área(s) · <b>" +
          fmt(st.a || 0, 1) + " ha</b>" +
          (st.b ? " · " + fmt(st.b, 1) + " t de biomassa" : "");
      }

      var j = await Motor.rest(CFG.camadaPoligonos + "/query", {
        where: wh,
        outFields: "objectid,globalid,data_pass,data_ref,competencia,area_ha," +
                   "n_pixels,dnbr_med,classe_uso,biomassa_t,municipio," +
                   "mun_nome,status,metodo,quad_id,celula",
        returnGeometry: "true", outSR: "4326", geometryPrecision: "6",
        orderByFields: $("fOrdem").value + ",objectid",
        resultOffset: String(offset), resultRecordCount: String(LOTE)
      });
      var fs = j.features || [];
      fs.forEach(function (f) {
        var a = f.attributes;
        a.__rings = f.geometry ? f.geometry.rings : null;
        a.__diaPass = a.data_pass ? dia(a.data_pass) : null;
        a.__diaRef = a.data_ref ? dia(a.data_ref) : null;
        itens.push(a);
      });
      offset += fs.length;
      pintarLista();
      $("btnMais").classList.toggle("oculto", itens.length >= total);
    } catch (e) {
      console.error(e);
      aviso("Busca falhou: " + (e.message || e));
    } finally {
      $("btnBuscar").disabled = false;
    }
  }

  function pintarLista() {
    $("listaTopo").innerHTML = itens.length
      ? "mostrando <b>" + fmt(itens.length) + "</b> de " + fmt(total) +
        " · clique para ver no mapa e validar"
      : "Nenhuma área queimada com esses filtros.";
    $("listaAreas").innerHTML = itens.map(function (a, i) {
      return '<button class="area-item' + (sel === a ? " sel" : "") +
        '" data-i="' + i + '">' +
        '<span class="ai-area">' + fmt(a.area_ha, 2) + " ha</span>" +
        '<span class="ai-mun">' + esc(a.mun_nome || "fora dos 8") + "</span>" +
        '<span class="ai-data">' + dataBr(a.__diaPass) + "</span>" +
        '<span class="ai-classe">' +
        esc(nomesClasse[a.classe_uso] || ("classe " + (a.classe_uso == null ? "?" : a.classe_uso))) +
        "</span>" +
        (a.status === "Queima prescrita"
          ? '<span class="ai-tag">prescrita</span>' : "") +
        "</button>";
    }).join("");
    document.querySelectorAll("#listaAreas .area-item").forEach(function (b) {
      b.addEventListener("click", function () {
        selecionar(itens[Number(b.dataset.i)]);
      });
    });
  }

  /* ---------------- seleção e detalhe ---------------- */

  function selecionar(a) {
    sel = a;
    pintarLista();
    $("detArea").classList.remove("oculto");
    $("daTitulo").textContent = fmt(a.area_ha, 2) + " ha em " +
      (a.mun_nome || "fora dos limites");
    $("daSub").textContent = "detectada em " + dataBr(a.__diaPass) +
      " · medida contra " + dataBr(a.__diaRef) +
      " · " + (a.n_pixels || "?") + " px · dNBR " +
      (a.dnbr_med != null ? fmt(a.dnbr_med, 3) : "—");

    $("daGrid").innerHTML = '<div class="da-carregando">calculando…</div>';
    contaDe(a).then(function (r) {
      if (sel !== a) return;             // trocou de área no meio
      // a conta ABERTA: o que foi medido, o que foi aplicado, o que saiu
      var h = '<table class="tab-conta"><tr><th>classe</th><th>área ha</th>' +
              "<th>B×C t/ha</th><th>biomassa t</th></tr>";
      r.itens.sort(function (x, y) { return y.area - x.area; });
      r.itens.forEach(function (i) {
        var bc = (i.b != null && i.c != null) ? i.b * i.c : null;
        h += '<tr' + (i.queima ? "" : ' class="classe-nao-queima"') +
          "><td>" + esc(i.nome || ("classe " + i.classe)) +
          (i.queima ? "" : ' <span class="tag-nc" title="B×C = 0: não há ' +
            'combustível. Fica fora da área queimada.">não queima</span>') +
          "</td>" +
          "<td>" + fmt(i.area, 3) + "</td>" +
          "<td>" + (bc != null ? fmt(bc, 2) : "<i>sem parâmetro</i>") + "</td>" +
          "<td>" + (i.bio != null ? fmt(i.bio, 2) : "—") + "</td></tr>";
      });
      h += "</table>";
      if (r.areaDescartada > 0) {
        h += '<div class="conta-desconto">área queimada <b>' +
          fmt(r.areaQueimada, 3) + " ha</b> — descontados " +
          fmt(r.areaDescartada, 3) + " ha em classes sem combustível " +
          "(água, urbano, mineração, solo exposto), onde o dNBR costuma " +
          "confundir variação de nível e reflexo com cicatriz.</div>";
      }
      h += '<div class="conta-total">biomassa consumida: <b>' +
        (r.biomassa != null ? fmt(r.biomassa, 2) + " t" : "—") + "</b></div>";

      var pols = Object.keys(r.emiss).sort();
      if (pols.length) {
        h += '<div class="da-grid2">' + pols.map(function (p) {
          var kg = r.emiss[p];
          return "<div><span>" + esc(p) + "</span><b>" +
            (kg >= 1000 ? fmt(kg / 1000, 2) + " t" : fmt(kg, 1) + " kg") +
            "</b></div>";
        }).join("") + "</div>";
      }
      h += '<p class="mp-dica">Derivado dos parâmetros atuais — mude em ' +
        "<b>Metodologia</b> e o número muda aqui na hora.</p>";
      $("daGrid").innerHTML = h;
    }).catch(function (e) {
      $("daGrid").innerHTML = '<p class="det-dica">não calculou: ' +
        esc(e.message || e) + "</p>";
    });

    // troca de área: as vistas da anterior não valem mais
    vistasDoSel = {};
    $("daVistas").innerHTML = "";
    $("daSobrepor").classList.add("oculto");
    if (V.lMidia) definirMidia([]);
    $("btnVistas").disabled = false;
    $("btnVistas").textContent = "Ver imagens (≈" +
      fmt(VistasPoligono.pu() * 4, 1) + " PU)";

    desenhar(a);
  }

  function desenhar(a) {
    if (!V.gSel || !a.__rings) return;
    V.gSel.removeAll();
    var g = new M.Polygon({ rings: a.__rings,
                            spatialReference: { wkid: 4326 } });
    V.gSel.add(new M.Graphic({
      geometry: g,
      symbol: { type: "simple-fill", color: [255, 225, 0, 0.25],
                outline: { color: [255, 225, 0, 1], width: 2 } }
    }));
    V.view.goTo({ target: g.extent.expand(6) }).catch(function () { });
  }

  var vistasDoSel = {};     // qual -> {url, urlLimpa, bbox}

  async function verVistas() {
    if (!sel) return;
    var b = $("btnVistas");
    b.disabled = true;
    b.textContent = "gerando…";
    // matriz 2×2: cor verdadeira em cima, falsa cor embaixo; antes à
    // esquerda, depois à direita — a leitura vira uma comparação
    var quais = [
      ["verdAntes", "Cor verdadeira · antes", dataBr(sel.__diaRef)],
      ["verdDepois", "Cor verdadeira · depois", dataBr(sel.__diaPass)],
      ["falsaAntes", "Falsa cor · antes", dataBr(sel.__diaRef)],
      ["falsaDepois", "Falsa cor · depois", dataBr(sel.__diaPass)]
    ];
    $("daVistas").innerHTML = quais.map(function (q) {
      return '<figure class="vista"><div class="vista-img" id="v_' + q[0] +
        '">gerando…</div><figcaption>' + esc(q[1]) +
        '<br><span class="vista-data">' + esc(q[2]) +
        "</span></figcaption></figure>";
    }).join("");
    for (var i = 0; i < quais.length; i++) {
      var q = quais[i];
      try {
        var v = await VistasPoligono.gerar(sel, q[0]);
        vistasDoSel[q[0]] = v;
        var el = $("v_" + q[0]);
        if (el) {
          el.innerHTML = '<img src="' + v.url + '" alt="' + esc(q[1]) + '">';
          el.style.cursor = "pointer";
          el.title = "clique para ver sobre o mapa";
          el.onclick = (function (qual) {
            return function () { sobrepor(qual); };
          })(q[0]);
        }
      } catch (e) {
        var el2 = $("v_" + q[0]);
        if (el2) el2.textContent = "falhou: " + (e.message || e);
      }
    }
    b.disabled = false;
    b.textContent = "Imagens geradas";
    $("daSobrepor").classList.remove("oculto");
    // a falsa cor DEPOIS é onde a cicatriz salta primeiro
    sobrepor("falsaDepois");
  }

  /** Põe (ou tira) uma das vistas SOBRE o mapa, georreferenciada. */
  function sobrepor(qual) {
    if (!V.lMidia) return;
    document.querySelectorAll("#daToggle button").forEach(function (b) {
      b.classList.toggle("ativa", b.dataset.v === qual);
    });
    var v = qual ? vistasDoSel[qual] : null;
    if (!v) { definirMidia([]); return; }

    var b = v.bbox;
    var el = new M.ImageElement({
      image: v.urlLimpa,      // sem o contorno: ele já é camada vetorial
      georeference: new M.ExtentGeo({
        extent: new M.Extent({
          xmin: b[0], ymin: b[1], xmax: b[2], ymax: b[3],
          spatialReference: { wkid: 3857 }
        })
      }),
      opacity: Number($("daOpacidade").value) / 100
    });
    definirMidia([el]);
    if (sel) desenhar(sel);
  }

  /* MediaLayer não tem removeAll, e trocar `source` depois de
     materializado é ignorado em silêncio — mexer em source.elements é o
     caminho que funciona (cicatriz herdada da Calculadora). */
  function definirMidia(elementos) {
    var s = V.lMidia.source;
    if (s && s.elements) {
      s.elements.removeAll();
      if (elementos.length) s.elements.addMany(elementos);
    } else {
      V.lMidia.source = elementos;
    }
  }

  /* ---------------- curadoria ---------------- */

  async function curar(acao) {
    if (!sel) return;
    try {
      if (acao === "prescrita") {
        await Motor.mudarStatus([sel.objectid], "Queima prescrita");
        sel.status = "Queima prescrita";
        alerta("Marcada como queima prescrita.");
      } else {
        if (!confirm("Excluir esta área de " + fmt(sel.area_ha, 2) +
                     " ha?\n\nO polígono e o detalhamento por classe são " +
                     "apagados; a área sai da conta na próxima consolidação.")) {
          return;
        }
        // o detalhamento por classe é filho do polígono (chave = globalid)
        if (sel.globalid) {
          await Motor.rest(CFG.tabelaQueimadaClasse + "/deleteFeatures", {
            where: "poligono_gid = '" + sel.globalid + "'"
          }).catch(function (e) { console.warn("classes:", e); });
        }
        await Motor.excluirPoligonos([sel.objectid]);
        await Motor.sincronizarControle(sel.quad_id, sel.__diaPass,
                                        Number(CFG.resolucaoPadrao));
        itens = itens.filter(function (x) { return x !== sel; });
        total = Math.max(0, total - 1);
        sel = null;
        $("detArea").classList.add("oculto");
        if (V.gSel) V.gSel.removeAll();
        alerta("Área excluída.");
      }
      pintarLista();
    } catch (e) {
      console.error(e);
      aviso("Falhou: " + (e.message || e));
    }
  }

  /* ---------------- consolidado ---------------- */

  function mesAnterior() {
    var d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  }

  async function consolidarMes() {
    if (!Auth.token()) { aviso("Entre no Portal para consolidar."); return; }
    var m = $("mesConsolidado").value || mesAnterior();
    $("btnConsolidar").disabled = true;
    try {
      var r = await Consolida.fecharMes(m, V.plano, function (t) {
        $("mensalStatus").textContent = m + " · " + t;
      });
      $("mensalStatus").textContent = "";
      alerta("Mês " + m + " consolidado: " + fmt(r.area_ha, 1) + " ha em " +
        fmt(r.n_poligonos) + " polígono(s).");
      await verMes(m);
    } catch (e) {
      console.error(e);
      $("mensalStatus").textContent = "";
      aviso("Consolidação falhou: " + (e.message || e));
    } finally {
      $("btnConsolidar").disabled = false;
    }
  }

  async function verMes(m) {
    if (!Auth.token()) { aviso("Entre no Portal."); return; }
    m = m || $("mesConsolidado").value || mesAnterior();
    $("mesConsolidado").value = m;
    var linhas;
    try { linhas = await Consolida.lerMes(m); }
    catch (e) { aviso("Consolidado: " + (e.message || e)); return; }
    if (!linhas.length) {
      $("mensalLinhas").innerHTML = '<p class="det-dica">Nada consolidado ' +
        "para " + esc(m) + ' — clique em "Consolidar mês".</p>';
      return;
    }
    var soma = null, muns = [], emiss = [];
    linhas.forEach(function (l) {
      if (l.tipo_recorte === "municipios") soma = l;
      else if (l.tipo_recorte === "municipio") muns.push(l);
      else if (l.tipo_recorte === "emissao") emiss.push(l);
    });
    muns.sort(function (a, b) { return (b.area_ha || 0) - (a.area_ha || 0); });
    var html = "";
    if (soma) {
      html += '<div class="mensal-estado"><b>' + fmt(soma.area_ha, 1) +
        " ha</b> nos 9 Municípios" +
        (soma.biomassa_t != null
          ? " · " + fmt(soma.biomassa_t, 1) + " t de biomassa" : "") +
        "</div>";
    }
    html += muns.map(function (g) {
      return '<span class="mensal-quad">' + esc(g.recorte_nome) + " · " +
        fmt(g.area_ha, 1) + " ha</span>";
    }).join("");
    if (emiss.length) {
      html += '<div class="mensal-estado" style="margin-top:6px">Emissões: ' +
        emiss.map(function (e) {
          return "<b>" + esc(e.recorte_id) + "</b> " + fmt(e.massa_t, 2) + " t";
        }).join(" · ") + "</div>";
    }
    $("mensalLinhas").innerHTML = html;
  }

  /* ---------------- mapa ---------------- */

  function montarMapa() {
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = CFG.jsapi + "/esri/themes/light/main.css";
    document.head.appendChild(css);
    var s = document.createElement("script");
    s.src = CFG.jsapi + "/init.js";
    s.onload = function () {
      window.require([
        "esri/Map", "esri/views/MapView", "esri/layers/GeoJSONLayer",
        "esri/layers/GraphicsLayer", "esri/Graphic",
        "esri/geometry/Polygon", "esri/geometry/geometryEngine",
        "esri/layers/MediaLayer", "esri/layers/support/ImageElement",
        "esri/layers/support/ExtentAndRotationGeoreference",
        "esri/geometry/Extent"
      ], function (Map, MapView, GeoJSONLayer, GraphicsLayer, Graphic,
                   Polygon, ge, MediaLayer, ImageElement, ExtentGeo,
                   Extent) {
        M.Polygon = Polygon; M.Graphic = Graphic; M.ge = ge;
        M.ImageElement = ImageElement; M.ExtentGeo = ExtentGeo;
        M.Extent = Extent;
        Motor.iniciar({ Polygon: Polygon, ge: ge });
        Consolida.iniciar({ Polygon: Polygon, ge: ge });

        V.lMun = new GeoJSONLayer({
          url: "dados/municipios.geojson",
          renderer: { type: "simple", symbol: {
            type: "simple-fill", color: [255, 255, 255, 0.02],
            outline: { color: [80, 220, 255, 0.95], width: 1.6 } } },
          labelingInfo: [{
            labelExpressionInfo: { expression: "$feature.nome" },
            symbol: { type: "text", color: [220, 245, 255, 0.95],
                      haloColor: [0, 0, 0, .6], haloSize: 1,
                      font: { size: 11, weight: "bold" } } }],
          popupEnabled: false
        });
        V.lMidia = new MediaLayer({ source: [] });
        V.gSel = new GraphicsLayer();
        V.mapa = new Map({ basemap: "satellite",
                           layers: [V.lMidia, V.lMun, V.gSel] });
        V.view = new MapView({
          container: "mapa", map: V.mapa,
          center: [-43.6, -19.6], zoom: 8,
          popupEnabled: false, constraints: { snapToZoom: false }
        });
        $("legendaMapa").innerHTML =
          '<div class="li"><i style="background:rgba(80,220,255,.35)"></i> limite municipal (IBGE)</div>' +
          '<div class="li"><i style="background:rgba(255,225,0,.5)"></i> área selecionada</div>';
      });
    };
    document.head.appendChild(s);
  }

  /* ---------------- carga ---------------- */

  async function carregar() {
    V.plano = await (await fetch("dados/quadrantes.json")).json();
    municipios = (V.plano.premissas.municipios || []).slice()
      .sort(function (a, b) { return a.nome < b.nome ? -1 : 1; });
    $("fMunicipio").innerHTML = '<option value="">todos os 9</option>' +
      municipios.map(function (m) {
        return '<option value="' + m.codigo + '">' + esc(m.nome) + "</option>";
      }).join("");

    var p = V.plano.premissas;
    $("premissas").textContent =
      "Sentinel-2 a " + CFG.resolucaoPadrao + " m · dNBR ≥ " + CFG.limiar +
      " contra a passagem anterior viável da mesma célula · área mínima " +
      CFG.areaMinM2 + " m² (2 px) · nuvem decidida no recorte pelo SCL " +
      "(corte em " + CFG.nuvemRecorteMax + "%) · área que já queimou só " +
      "conta de novo após " + CFG.regeneracaoDias + " dias · biomassa por " +
      "classe do MapBiomas do ano do fogo, com desempate Sentinel-2 10 m · " +
      "emissões E = A×B×C×EF (fatores Andreae 2019 / Akagi 2011, " +
      "PROVISÓRIOS) · " + fmt(p.area_mg_km2) + " km² nos 9 Municípios";

    $("fDe").value = "2017-01";
    $("fAte").value = new Date().toISOString().slice(0, 7);
    $("mesConsolidado").value = mesAnterior();

    montarMapa();
    pintarSessaoPortal();
    pintarSessaoCop();
    pintarPu();
    if (Auth.token()) buscar(true);
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("btnBuscar").addEventListener("click", function () { buscar(true); });
    $("btnMais").addEventListener("click", function () { buscar(false); });
    $("btnVistas").addEventListener("click", verVistas);
    $("daToggle").addEventListener("click", function (ev) {
      var b = ev.target.closest("button");
      if (b) sobrepor(b.dataset.v);
    });
    $("daOpacidade").addEventListener("input", function () {
      if (!V.lMidia || !V.lMidia.source || !V.lMidia.source.elements) return;
      var o = Number(this.value) / 100;
      V.lMidia.source.elements.forEach(function (el) { el.opacity = o; });
    });
    $("btnPrescrita").addEventListener("click", function () { curar("prescrita"); });
    $("btnNaoQueimada").addEventListener("click", function () { curar("excluir"); });
    $("detFechar").addEventListener("click", function () {
      sel = null;
      $("detArea").classList.add("oculto");
      if (V.gSel) V.gSel.removeAll();
      pintarLista();
    });
    $("btnConsolidar").addEventListener("click", consolidarMes);
    $("btnVerMes").addEventListener("click", function () { verMes(); });

    $("btnEntrar").addEventListener("click", async function () {
      try {
        await Auth.entrar();
        pintarSessaoPortal();
        buscar(true);
      } catch (e) { aviso("Login falhou: " + (e.message || e)); }
    });
    $("perfilBotao").addEventListener("click", function (ev) {
      ev.stopPropagation();
      $("perfilMenu").classList.toggle("oculto");
    });
    $("btnSair").addEventListener("click", function () {
      Auth.sair();
      $("perfilMenu").classList.add("oculto");
      pintarSessaoPortal();
    });
    document.addEventListener("click", function (ev) {
      var m = $("perfilMenu");
      if (!m.classList.contains("oculto") && !$("perfil").contains(ev.target)) {
        m.classList.add("oculto");
      }
    });
    $("copStatus").addEventListener("click", abrirModalCop);
    $("copFechar").addEventListener("click", fecharModalCop);
    $("modalCop").addEventListener("click", function (ev) {
      if (ev.target === $("modalCop")) fecharModalCop();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") fecharModalCop();
    });
    $("copSalvar").addEventListener("click", salvarCliente);
    $("copUsarToken").addEventListener("click", async function () {
      var tk = $("copToken").value.trim();
      if (!tk) { aviso("Cole o token primeiro."); return; }
      var b = this;
      b.disabled = true; b.textContent = "validando…";
      try {
        var s = await Copernicus.entrarComToken(tk);
        pintarSessaoCop();
        abrirModalCop();
        alerta("Token aceito — válido até " +
          new Date(s.expira).toLocaleString("pt-BR"));
      } catch (e) {
        aviso("Token não aceito: " + (e.message || e));
      } finally {
        b.disabled = false; b.textContent = "Validar e usar token";
      }
    });

    // ---- metodologia ----
    $("btnMetodologia").addEventListener("click", abrirMetodologia);
    $("metFechar").addEventListener("click", function () {
      $("modalMet").classList.add("oculto");
    });
    $("modalMet").addEventListener("click", function (ev) {
      if (ev.target === $("modalMet")) $("modalMet").classList.add("oculto");
    });
    document.querySelectorAll(".met-abas button").forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll(".met-abas button").forEach(function (x) {
          x.classList.toggle("ativa", x === b);
        });
        $("metBC").classList.toggle("oculto", b.dataset.aba !== "bc");
        $("metEF").classList.toggle("oculto", b.dataset.aba !== "ef");
      });
    });
    $("tabBC").addEventListener("input", function (ev) {
      var el = ev.target;
      if (!el.dataset || el.dataset.i == null) return;
      var p = metBC[Number(el.dataset.i)];
      var v = el.value === "" ? null : Number(el.value);
      p[el.dataset.c] = v;
      p.__mudou = true;
      var prod = (p.b_t_ha != null && p.c_fracao != null)
        ? p.b_t_ha * p.c_fracao : null;
      var cel = $("bcp_" + el.dataset.i);
      if (cel) cel.textContent = prod != null ? fmt(prod, 2) : "—";
    });
    $("tabEF").addEventListener("input", function (ev) {
      var el = ev.target;
      if (!el.dataset || el.dataset.i == null) return;
      var e = metEF[Number(el.dataset.i)];
      e.ef_g_kg = el.value === "" ? null : Number(el.value);
      e.__mudou = true;
    });
    $("tabEF").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-del]");
      if (!b) return;
      var i = Number(b.dataset.del);
      var e = metEF[i];
      if (!confirm("Remover o fator " + e.poluente +
                   (e.classe_id == null ? " (todas as classes)"
                                        : " da classe " + e.classe_id) + "?")) return;
      metEF.__apagar = (metEF.__apagar || []).concat(
        e.objectid ? [e.objectid] : []);
      metEF.splice(i, 1);
      pintarEF();
    });
    $("efAdd").addEventListener("click", function () {
      var pol = $("efPol").value.trim().toUpperCase();
      var val = Number($("efValor").value);
      if (!pol || !(val >= 0)) { aviso("Informe poluente e valor."); return; }
      var cls = $("efClasse").value.trim();
      metEF.push({ poluente: pol, ef_g_kg: val,
                   classe_id: cls === "" ? null : Number(cls),
                   fonte: $("efFonte").value.trim() || "definido no painel" });
      $("efPol").value = ""; $("efValor").value = "";
      $("efClasse").value = ""; $("efFonte").value = "";
      pintarEF();
    });
    $("metSalvar").addEventListener("click", salvarMetodologia);
    $("copMostrar").addEventListener("change", function () {
      $("copSegredo").type = this.checked ? "text" : "password";
    });
    $("copEsquecer").addEventListener("click", function () {
      if (!confirm("Esquecer a credencial salva neste navegador?")) return;
      Copernicus.esquecerCliente();
      Copernicus.sair();
      $("copId").value = ""; $("copSegredo").value = "";
      pintarSessaoCop();
      abrirModalCop();
      alerta("Credencial removida.");
    });
    $("copLogin").addEventListener("click", async function () {
      try {
        await Copernicus.entrar();
        pintarSessaoCop();
        abrirModalCop();
        alerta("Copernicus conectado.");
      } catch (e) { aviso("Copernicus: " + (e.message || e)); }
    });

    carregar();
  });
})();
