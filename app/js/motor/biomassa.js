/* =====================================================================
   biomassa.js — o B×C da fórmula E = A × B × C × EF.

   Traduz cada polígono de cicatriz em biomassa consumida:

     1. o TILE de uso do solo da célula (PNG em tons de cinza anexado na
        tabela "LULC por celula"; valor do pixel = código MapBiomas, com
        o Mosaico de Usos já resolvido pelo desempate Esri 10 m) está na
        MESMA grade do dNBR — 2.500×2.500 px, mesmo bbox 3857 — então o
        índice do pixel casa um-a-um com os rótulos do vetorizador;
     2. a área do polígono é repartida por classe na proporção dos
        pixels (herda a área geodésica total, sem redistorcer);
     3. M_classe = A_classe × B_classe × C_classe, com B e C da tabela
        "Parametros de biomassa" (editável no Portal, com fontes).

   Se a célula não tem tile (ano sem mapa, tile não gerado), a passagem
   é gravada normalmente com biomassa nula — a consolidação distingue
   "sem biomassa calculada" de "biomassa zero".
   ===================================================================== */
(function (glob) {
  "use strict";

  var parametros = null;   // classe_id -> {b, c, nome}
  var tiles = {};          // "bbox|ano" -> {classes: Uint8, largura, altura} | null

  async function carregarParametros() {
    if (parametros) return parametros;
    var linhas = await Motor.consultarTudo(CFG.tabelaParametros, "1=1",
      "classe_id,classe_nome,b_t_ha,c_fracao");
    parametros = {};
    linhas.forEach(function (l) {
      if (l.classe_id == null) return;
      parametros[l.classe_id] = {
        b: l.b_t_ha || 0, c: l.c_fracao || 0, nome: l.classe_nome
      };
    });
    return parametros;
  }

  function chaveBbox(cl) {
    return cl.bbox.map(function (v) { return v.toFixed(1); }).join(",");
  }

  /**
   * O tile de uso do solo da célula para o ano dado — uma consulta + um
   * download por célula, por sessão (cache em memória). Devolve null se
   * a célula não tem tile.
   */
  async function carregarTile(cl, ano) {
    var k = chaveBbox(cl) + "|" + ano;
    if (k in tiles) return tiles[k];

    var j = await Motor.rest(CFG.tabelaLULC + "/query", {
      where: "bbox_3857 = '" + chaveBbox(cl) + "' AND ano = " + Number(ano) +
             " AND res_m = 10",
      outFields: "objectid", returnGeometry: "false",
      resultRecordCount: "1"
    });
    var f = (j.features || [])[0];
    if (!f) { tiles[k] = null; return null; }
    var oid = f.attributes.objectid;

    var ja = await Motor.rest(CFG.tabelaLULC + "/" + oid + "/attachments", {});
    var att = (ja.attachmentInfos || [])[0];
    if (!att) { tiles[k] = null; return null; }

    var resp = await fetch(CFG.tabelaLULC + "/" + oid + "/attachments/" +
      att.id + "?token=" + Auth.token());
    if (!resp.ok) throw new Error("tile LULC: HTTP " + resp.status);
    var blob = await resp.blob();
    var bmp = await createImageBitmap(blob, { colorSpaceConversion: "none" });
    var cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    var cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    var dados = cx.getImageData(0, 0, cv.width, cv.height).data;
    var classes = new Uint8ClampedArray(cv.width * cv.height);
    for (var i = 0; i < classes.length; i++) classes[i] = dados[i * 4];

    tiles[k] = { classes: classes, largura: cv.width, altura: cv.height };
    return tiles[k];
  }

  /**
   * Reparte a área de UMA feição por classe e calcula a biomassa.
   *
   * @param tile    {classes, largura, altura} — o tile da célula
   * @param rotulos Int32Array do vetorizador (mesma grade)
   * @param rotulo  o rótulo da feição
   * @param areaHa  área geodésica do polígono JÁ RECORTADO
   * @param params  tabela B×C carregada
   * @returns {classes: [{classe, pixels, area_ha, biomassa_t}],
   *           dominante, biomassa_t}
   *
   * Nota de método: a proporção de pixels vem do componente vetorizado
   * INTEIRO; quando a rede de regeneração recorta parte dele, a fração
   * por classe é aplicada à área que sobrou — aproximação documentada
   * (DOCUMENTACAO.md §6).
   */
  function porClasse(tile, rotulos, rotulo, areaHa, params) {
    var cont = {};
    var total = 0;
    var n = Math.min(rotulos.length, tile.classes.length);
    for (var i = 0; i < n; i++) {
      if (rotulos[i] !== rotulo) continue;
      var c = tile.classes[i];
      cont[c] = (cont[c] || 0) + 1;
      total++;
    }
    if (!total) return { classes: [], dominante: null, biomassa_t: null };

    var saida = [];
    var biomassa = 0;
    var calculou = false;   // distingue "0 t calculado" de "não calculável"
    var dominante = null, maxPx = 0;
    for (var k in cont) {
      var cid = Number(k);
      var areaC = areaHa * cont[k] / total;
      var p = params[cid];
      var bio = p ? areaC * p.b * p.c : null;
      if (bio != null) { biomassa += bio; calculou = true; }
      saida.push({ classe: cid, pixels: cont[k],
                   area_ha: areaC, biomassa_t: bio });
      if (cont[k] > maxPx) { maxPx = cont[k]; dominante = cid; }
    }
    return { classes: saida, dominante: dominante,
             biomassa_t: calculou ? biomassa : null };
  }

  glob.Biomassa = {
    carregarParametros: carregarParametros,
    carregarTile: carregarTile,
    porClasse: porClasse
  };
})(window);
