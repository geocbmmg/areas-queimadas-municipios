/* =====================================================================
   consolida.js — fecha o mês do MONITOR DOS 8 MUNICÍPIOS.

   Agrega a camada de polígonos por recorte e grava na tabela
   "Consolidado mensal" (apaga e regrava a competência — idempotente:
   rodar de novo sempre reflete o estado atual da camada, inclusive
   depois de curadoria).

   Recortes deste fork:
     municipios  "8MUN"  — a soma das interseções municipais (o número
                           que interessa: só o que caiu DENTRO dos 8)
     municipio   <IBGE>  — um por município, por interseção geométrica
                           com o limite do IBGE (municipios.geojson);
                           incêndio na divisa é repartido pela divisa
     fora        "FORA"  — o que o motor calculou nas células mas caiu
                           fora dos 8 limites (as células são retângulos
                           maiores que os municípios — transparência)
     quadrante   A1..    — acompanhamento por responsável

   A resolução canônica é a do plano (CFG.resolucaoPadrao = 10 m neste
   fork). Somar séries de resoluções diferentes dobraria a área.
   ===================================================================== */
(function (glob) {
  "use strict";

  var RES_CANONICA = Number(CFG.resolucaoPadrao);

  /* PISO DE RELATÓRIO — o filtro que decide o que ENTRA na conta, sem
     tocar no que está gravado. Os polígonos são gravados no piso mais
     fino (CFG.areaMinM2); subir CFG.pisoRelatorioM2 e reconsolidar o mês
     produz a série num corte maior em segundos, sem reprocessar o GEE.
     Fica registrado no campo `metodo` de cada linha do consolidado. */
  function pisoM2() {
    var p = Number(CFG.pisoRelatorioM2 || CFG.areaMinM2 || 0);
    var g = Number(CFG.areaMinM2 || 0);
    return p > g ? p : g;   // nunca abaixo do que foi gravado
  }

  /* O filtro vai em PIXELS, não em área: é exato (inteiro, sem ponto
     flutuante nem variação de área geodésica com a latitude) e vale
     igual nas duas tabelas — na de classes o `area_ha` é a fatia da
     classe, não o tamanho do polígono, então filtrar por área ali
     derrubaria fragmentos por engano. */
  function pisoPx() {
    return Math.ceil(pisoM2() / (RES_CANONICA * RES_CANONICA));
  }

  function filtroPiso() {
    var px = pisoPx();
    return px > 1 ? " AND n_pixels >= " + px : "";
  }

  var municipiosCache = null;   // [{codigo, nome, geom (SDK.Polygon 4326)}]
  var SDK = null;               // {Polygon, ge} — entregues pelo painel

  function iniciar(mods) { SDK = mods; }

  async function carregarMunicipios() {
    if (municipiosCache) return municipiosCache;
    var gj = await (await fetch("dados/municipios.geojson")).json();
    municipiosCache = gj.features.map(function (f) {
      var g = f.geometry;
      var rings = g.type === "Polygon" ? g.coordinates
        : g.coordinates.reduce(function (a, p) { return a.concat(p); }, []);
      return {
        codigo: f.properties.codigo,
        nome: f.properties.nome,
        geom: new SDK.Polygon({ rings: rings, spatialReference: { wkid: 4326 } })
      };
    });
    return municipiosCache;
  }

  /**
   * Área e biomassa por município — direto do servidor, agrupando pelo
   * campo `municipio` que o motor grava em CADA polígono.
   *
   * A versão anterior baixava todos os polígonos do mês COM GEOMETRIA e
   * cruzava um a um no navegador: com ~8 milhões de polígonos na série
   * isso significaria centenas de milhares de feições num mês de pico —
   * o navegador não aguentaria e a conta de emissões nunca fecharia.
   * A atribuição agora é feita uma única vez, na gravação.
   */
  async function porMunicipio(competencia, aoProgresso) {
    aoProgresso && aoProgresso("agregando por município…");
    var wh = "competencia = '" + competencia + "'" +
             " AND res_m = " + RES_CANONICA + filtroPiso();
    var linhas = await estat(CFG.camadaPoligonos, wh, "municipio,mun_nome");

    var municipios = [], totalDentro = 0, totalBio = 0;
    var nDentro = 0, temBioAlgum = false, semMunicipio = 0;
    linhas.forEach(function (g) {
      // desde o recorte na gravação, todo polígono tem município; uma
      // linha sem ele só pode ser resíduo de geração anterior — fica de
      // fora da conta municipal e é denunciada no console
      if (!g.municipio) { semMunicipio += g.n || 0; return; }
      municipios.push({
        codigo: g.municipio, nome: g.mun_nome || g.municipio,
        area: g.soma_area || 0, n: g.n || 0,
        bio: g.soma_bio, temBio: g.soma_bio != null
      });
      totalDentro += g.soma_area || 0;
      nDentro += g.n || 0;
      if (g.soma_bio != null) { totalBio += g.soma_bio; temBioAlgum = true; }
    });
    municipios.sort(function (a, b) { return b.area - a.area; });
    if (semMunicipio) {
      console.warn("consolidação de " + competencia + ": " + semMunicipio +
        " polígono(s) sem município — resíduo de geração anterior, fora " +
        "da conta municipal");
    }
    return { municipios: municipios, totalDentro: totalDentro,
             nDentro: nDentro, semMunicipio: semMunicipio,
             totalBio: temBioAlgum ? totalBio : null };
  }

  /** Versão antiga (cruzamento no navegador) — mantida só como
   *  referência do método geométrico; não é chamada. */
  async function porMunicipioGeometrico(competencia, aoProgresso) {
    if (!SDK) throw new Error("Consolida sem SDK — chame Consolida.iniciar()");
    var municipios = await carregarMunicipios();
    var acum = {};
    municipios.forEach(function (m) {
      acum[m.codigo] = { codigo: m.codigo, nome: m.nome,
                         area: 0, n: 0, bio: 0, temBio: false };
    });
    var totalDentro = 0, totalBio = 0, temBioAlgum = false;
    var nDentro = 0;   // polígonos que tocam ALGUM dos 8 municípios

    var offset = 0, vistos = 0;
    while (true) {
      var j = await Motor.rest(CFG.camadaPoligonos + "/query", {
        where: "competencia = '" + competencia + "'" +
               " AND res_m = " + RES_CANONICA + filtroPiso(),
        outFields: "objectid,area_ha,biomassa_t", returnGeometry: "true",
        outSR: "4326", geometryPrecision: "6", orderByFields: "objectid",
        resultOffset: String(offset), resultRecordCount: "1000"
      });
      var fs = j.features || [];
      fs.forEach(function (f) {
        if (!f.geometry || !f.geometry.rings) return;
        var poli = new SDK.Polygon({ rings: f.geometry.rings,
                                     spatialReference: { wkid: 4326 } });
        var areaPoli = f.attributes.area_ha || 0;
        var bioPoli = f.attributes.biomassa_t;
        var e = poli.extent;
        var tocouAlgum = false;
        municipios.forEach(function (m) {
          var e2 = m.geom.extent;
          if (!e || !e2 || e2.xmin > e.xmax || e2.xmax < e.xmin ||
              e2.ymin > e.ymax || e2.ymax < e.ymin) return;
          var inter = null;
          try { inter = SDK.ge.intersect(poli, m.geom); } catch (err) { }
          if (!inter) return;
          var ha = Math.abs(SDK.ge.geodesicArea(inter, "square-meters")) / 10000;
          if (ha <= 0) return;
          var a = acum[m.codigo];
          a.area += ha;
          a.n += 1;
          tocouAlgum = true;
          totalDentro += ha;
          if (bioPoli != null && areaPoli > 0) {
            a.bio += bioPoli * (ha / areaPoli);
            a.temBio = true;
            totalBio += bioPoli * (ha / areaPoli);
            temBioAlgum = true;
          }
        });
        if (tocouAlgum) nDentro++;
      });
      vistos += fs.length;
      aoProgresso && aoProgresso("repartindo por município — " +
        vistos + " polígono(s)");
      if (!j.exceededTransferLimit || !fs.length) break;
      offset += fs.length;
    }
    return { municipios: municipios.map(function (m) { return acum[m.codigo]; }),
             totalDentro: totalDentro,
             nDentro: nDentro,
             totalBio: temBioAlgum ? totalBio : null };
  }

  async function estat(url, where, groupBy) {
    var stats = [
      { statisticType: "sum", onStatisticField: "area_ha",
        outStatisticFieldName: "soma_area" },
      { statisticType: "count", onStatisticField: "objectid",
        outStatisticFieldName: "n" },
      { statisticType: "sum", onStatisticField: "biomassa_t",
        outStatisticFieldName: "soma_bio" }
    ];
    var p = { where: where, outStatistics: JSON.stringify(stats),
              returnGeometry: "false" };
    if (groupBy) p.groupByFieldsForStatistics = groupBy;
    var j = await Motor.rest(url + "/query", p);
    return (j.features || []).map(function (f) { return f.attributes; });
  }

  /**
   * Completude REAL do mês: compara o CATÁLOGO do Copernicus com o
   * controle, quadrante a quadrante (Motor.pendencias — só consulta de
   * catálogo, custo zero de PU). Célula fechada = nenhum dia do mês
   * pendente (pendencias já reenfileira 'erro', então erro conta como
   * pendência). "Tem uma linha no mês" NÃO basta — o motor para no teto
   * de PU no meio da célula e as passagens seguintes ficam sem rastro.
   *
   * Exige Copernicus conectado; sem ele devolve null e o consolidado sai
   * gravado com completude não verificada (celulas_fechadas nulo).
   */
  async function completude(competencia, plano, aoProgresso) {
    var temCop = false;
    try { temCop = await Copernicus.tokenValido(); } catch (e) { }
    if (!temCop) return null;

    var fechadas = 0, total = 0;
    for (var i = 0; i < plano.quadrantes.length; i++) {
      var q = plano.quadrantes[i];
      aoProgresso && aoProgresso("catálogo — quadrante " + q.id +
        " (" + (i + 1) + "/" + plano.quadrantes.length + ")");
      var p = await Motor.pendencias(q, RES_CANONICA);
      var comPend = {};
      p.pendentes.forEach(function (pd) {
        if (pd.passagem.dia.slice(0, 7) === competencia) {
          comPend[pd.celula.n] = true;
        }
      });
      p.celulas.forEach(function (cl) {
        total++;
        if (!comPend[cl.n]) fechadas++;
      });
    }
    return { fechadas: fechadas, total: total };
  }

  /**
   * Consolida uma competência ("AAAA-MM"). `plano` é o quadrantes.json
   * carregado pelo painel — dá a lista de quadrantes (completude) e o
   * total de células do estado a 20 m.
   */
  async function fecharMes(competencia, plano, aoProgresso) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia || "")) {
      throw new Error("competência inválida — use AAAA-MM (mês 01–12)");
    }
    if (competencia > new Date().toISOString().slice(0, 7)) {
      throw new Error("competência no futuro: " + competencia);
    }
    // total de células NA RESOLUÇÃO CANÔNICA — a mesma da completude
    // (a 10 m cada célula-mãe do plano vira 4; somar a chave "20" com a
    // completude contada a 10 m mostraria "52/13")
    var totalCelulas = plano.quadrantes.reduce(function (a, q) {
      return a + q.res[String(RES_CANONICA)].celulas;
    }, 0);
    var whBase = "competencia = '" + competencia + "'" +
                 " AND res_m = " + RES_CANONICA + filtroPiso();

    var estado = await estat(CFG.camadaPoligonos, whBase, null);
    var quads = await estat(CFG.camadaPoligonos, whBase, "quad_id");
    var comp = await completude(competencia, plano, aoProgresso);
    var mun = await porMunicipio(competencia, aoProgresso);

    // por classe de uso do solo (tabela "Queimada por classe") + nomes
    aoProgresso && aoProgresso("agregando por classe e emissões…");
    var classes = await estat(CFG.tabelaQueimadaClasse, whBase, "classe_id");
    var nomesClasse = {};
    (await Motor.consultarTudo(CFG.tabelaParametros, "1=1",
      "classe_id,classe_nome")).forEach(function (p2) {
      if (p2.classe_id != null) nomesClasse[p2.classe_id] = p2.classe_nome;
    });

    // E_i = Σ_classe biomassa_classe × EF_i(classe) / 1000  → toneladas
    // (sobre TODAS as células; o rateio para os 8 municípios e para cada
    // município é proporcional à biomassa — aproximação documentada)
    var efs = await Motor.consultarTudo(CFG.tabelaFatoresEmissao, "1=1",
      "poluente,classe_id,ef_g_kg");
    // EF exato por classe; linha com classe_id NULO vale para todas as
    // classes que não têm linha própria (é o contrato do campo)
    var efExato = {}, efGeral = {}, poluentes = {};
    efs.forEach(function (e2) {
      if (e2.ef_g_kg == null) return;
      poluentes[e2.poluente] = true;
      if (e2.classe_id == null) efGeral[e2.poluente] = e2.ef_g_kg;
      else efExato[e2.poluente + "|" + e2.classe_id] = e2.ef_g_kg;
    });
    var emissCels = {};
    classes.forEach(function (g) {
      if (g.classe_id == null || g.soma_bio == null) return;
      for (var pol0 in poluentes) {
        var ef = efExato[pol0 + "|" + g.classe_id];
        if (ef == null) ef = efGeral[pol0];
        if (ef == null) continue;
        emissCels[pol0] = (emissCels[pol0] || 0) + g.soma_bio * ef / 1000;
      }
    });

    var agora = Date.now();
    var eu = Auth.usuario() || "desconhecido";
    function linha(tipo, id, nome, e) {
      return { attributes: {
        competencia: competencia, tipo_recorte: tipo,
        recorte_id: String(id), recorte_nome: nome,
        area_ha: Math.round((e.soma_area || 0) * 100) / 100,
        n_poligonos: e.n || 0,
        biomassa_t: e.soma_bio != null
          ? Math.round(e.soma_bio * 100) / 100 : null,
        celulas_fechadas: comp ? comp.fechadas : null,
        celulas_total: totalCelulas,
        piso_m2: pisoM2(),
        gerado_em: agora, gerado_por: eu
      } };
    }

    var e0 = (estado[0] && estado[0].n) ? estado[0]
      : { soma_area: 0, n: 0, soma_bio: null };

    var adds = [linha("municipios", "8MUN", "8 municípios (soma)", {
      soma_area: mun.totalDentro, n: mun.nDentro, soma_bio: mun.totalBio
    })];
    mun.municipios.forEach(function (a) {
      adds.push(linha("municipio", a.codigo, a.nome, {
        soma_area: a.area, n: a.n, soma_bio: a.temBio ? a.bio : null
      }));
    });
    // não há mais linha "FORA": o que cai 100% fora dos 8 municípios não
    // chega a ser gravado (o recorte municipal é feito na gravação), e o
    // que cruza a divisa já entra recortado no município certo.
    quads.forEach(function (g) {
      if (!g.quad_id) return;
      adds.push(linha("quadrante", g.quad_id, "Quadrante " + g.quad_id, g));
    });
    classes.forEach(function (g) {
      if (g.classe_id == null) return;
      adds.push(linha("classe", g.classe_id,
        nomesClasse[g.classe_id] || ("Classe " + g.classe_id), g));
    });

    // linhas de EMISSÃO (massa_t em toneladas): total das células rateado
    // para os 8 pela fração de biomassa que caiu dentro; por município,
    // pela biomassa municipal (rateio proporcional — ver DOCUMENTACAO.md)
    function linhaEmissao(tipo, id, nome, massaT) {
      return { attributes: {
        competencia: competencia, tipo_recorte: tipo,
        recorte_id: String(id), recorte_nome: nome,
        area_ha: null, n_poligonos: null, biomassa_t: null,
        massa_t: Math.round(massaT * 1000) / 1000,
        celulas_fechadas: comp ? comp.fechadas : null,
        celulas_total: totalCelulas,
        piso_m2: pisoM2(),
        gerado_em: agora, gerado_por: eu
      } };
    }
    var bioCels = e0.soma_bio || 0;
    var emiss8 = {};
    if (bioCels > 0 && mun.totalBio != null) {
      for (var pol in emissCels) {
        emiss8[pol] = emissCels[pol] * (mun.totalBio / bioCels);
        adds.push(linhaEmissao("emissao", pol,
          pol + " — 8 municípios", emiss8[pol]));
        mun.municipios.forEach(function (a) {
          if (!a.temBio || !mun.totalBio) return;
          adds.push(linhaEmissao("emissao_mun", pol + "|" + a.codigo,
            pol + " — " + a.nome,
            emiss8[pol] * (a.bio / mun.totalBio)));
        });
      }
    }

    // idempotência: apaga a competência e regrava. As linhas antigas são
    // lidas INTEIRAS antes — se a regravação falhar, elas são restauradas
    // (melhor esforço) em vez de deixar o mês oficial zerado.
    aoProgresso && aoProgresso("gravando o consolidado…");
    var CAMPOS = "competencia,tipo_recorte,recorte_id,recorte_nome,area_ha," +
      "n_poligonos,biomassa_t,massa_t,celulas_fechadas,celulas_total," +
      "gerado_em,gerado_por";
    var velhas = await Motor.consultarTudo(CFG.tabelaConsolidado,
      "competencia = '" + competencia + "'", "objectid," + CAMPOS);
    if (velhas.length) {
      Motor.conferir(await Motor.rest(CFG.tabelaConsolidado + "/applyEdits", {
        deletes: velhas.map(function (v) { return v.objectid; }).join(",")
      }));
    }
    try {
      Motor.conferir(await Motor.rest(CFG.tabelaConsolidado + "/applyEdits", {
        adds: JSON.stringify(adds)
      }));
    } catch (e2) {
      if (velhas.length) {
        try {
          var restaura = velhas.map(function (v) {
            var at = {};
            CAMPOS.split(",").forEach(function (c) { at[c] = v[c]; });
            return { attributes: at };
          });
          await Motor.rest(CFG.tabelaConsolidado + "/applyEdits", {
            adds: JSON.stringify(restaura)
          });
        } catch (e3) { console.warn("restauração do consolidado falhou:", e3); }
      }
      throw e2;
    }

    return {
      linhas: adds.length,
      area_ha: mun.totalDentro,
      n_poligonos: mun.nDentro,
      biomassa_t: mun.totalBio,
      emissoes: emiss8,                  // poluente -> t (dentro dos 8)
      fechadas: comp ? comp.fechadas : null,
      total: totalCelulas,
      verificada: !!comp
    };
  }

  async function lerMes(competencia) {
    return Motor.consultarTudo(CFG.tabelaConsolidado,
      "competencia = '" + competencia + "'",
      "tipo_recorte,recorte_id,recorte_nome,area_ha,n_poligonos,biomassa_t," +
      "massa_t,celulas_fechadas,celulas_total,gerado_em,gerado_por");
  }

  glob.Consolida = { iniciar: iniciar, fecharMes: fecharMes, lerMes: lerMes };
})(window);
