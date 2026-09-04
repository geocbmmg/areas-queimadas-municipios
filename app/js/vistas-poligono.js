/* =====================================================================
   vistas-poligono.js — as imagens que respondem "queimou mesmo?".

   Para validar UM polígono não faz sentido pedir a célula inteira de
   25 km (~5,5 PU por vista). Aqui o recorte é uma janela pequena em
   volta do próprio polígono — 256 px, ~0,25 PU — e o CONTORNO do
   polígono é desenhado por cima da imagem. Assim a pergunta vira visual:

     ANTES (data da base)  ·  DEPOIS (data da passagem)  ·  FALSA COR

   Se a mancha só aparece no "depois", queimou. Se já estava no "antes",
   é estiagem, sombra ou solo exposto — e o polígono deve ser excluído.

   As imagens ficam em cache de memória por sessão (chave = oid + vista).
   ===================================================================== */
(function (glob) {
  "use strict";

  var LADO_PX = 320;        // lado da imagem gerada
  var FOLGA = 2.2;          // quantas vezes o polígono cabe na janela
  var MIN_M = 400;          // janela mínima (polígono minúsculo)
  var cache = {};           // "oid|vista" -> dataURL

  var R = 6378137.0;

  function paraMerc(lon, lat) {
    return [R * lon * Math.PI / 180,
            R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
  }

  /** Janela quadrada em 3857 em volta do polígono (rings em 4326). */
  function janelaDe(rings) {
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    rings.forEach(function (anel) {
      anel.forEach(function (p) {
        var m = paraMerc(p[0], p[1]);
        if (m[0] < minx) minx = m[0];
        if (m[0] > maxx) maxx = m[0];
        if (m[1] < miny) miny = m[1];
        if (m[1] > maxy) maxy = m[1];
      });
    });
    var cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    var lado = Math.max(maxx - minx, maxy - miny) * FOLGA;
    if (!(lado > 0) || lado < MIN_M) lado = MIN_M;
    return { bbox: [cx - lado / 2, cy - lado / 2, cx + lado / 2, cy + lado / 2],
             lado: lado };
  }

  /** Desenha o contorno do polígono sobre a imagem, na mesma janela. */
  function comContorno(imgURL, rings, jan) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var cv = document.createElement("canvas");
        cv.width = LADO_PX; cv.height = LADO_PX;
        var cx = cv.getContext("2d");
        cx.drawImage(img, 0, 0, LADO_PX, LADO_PX);

        var b = jan.bbox, esc = LADO_PX / (b[2] - b[0]);
        cx.lineWidth = 2;
        cx.strokeStyle = "rgba(255, 225, 0, 0.95)";
        cx.shadowColor = "rgba(0,0,0,.8)";
        cx.shadowBlur = 2;
        rings.forEach(function (anel) {
          cx.beginPath();
          anel.forEach(function (p, i) {
            var m = paraMerc(p[0], p[1]);
            var x = (m[0] - b[0]) * esc;
            var y = (b[3] - m[1]) * esc;
            if (i === 0) cx.moveTo(x, y); else cx.lineTo(x, y);
          });
          cx.closePath();
          cx.stroke();
        });
        resolve(cv.toDataURL("image/png"));
      };
      img.onerror = function () { resolve(imgURL); };
      img.src = imgURL;
    });
  }

  /**
   * Gera uma vista do polígono. `qual` = "antes" | "depois" | "falsa".
   * Devolve dataURL (com o contorno desenhado).
   */
  async function gerar(poli, qual) {
    var chave = poli.objectid + "|" + qual;
    if (cache[chave]) return cache[chave];

    var data = qual === "antes" ? poli.__diaRef : poli.__diaPass;
    if (!data) throw new Error("passagem sem data de base");
    if (!(await Copernicus.tokenValido())) await Copernicus.entrar();

    var jan = janelaDe(poli.__rings);
    var blob = await Copernicus.baixarRecorte({
      bbox: jan.bbox, epsg: 3857,
      largura: LADO_PX, altura: LADO_PX, data: data,
      evalscript: qual === "falsa" ? Copernicus.EVAL_FALSA_COR
                                   : Copernicus.EVAL_COR_VERDADEIRA,
      formato: "image/png"
    });
    Pu.somar(LADO_PX * LADO_PX / 262144);

    var url = await new Promise(function (res) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.readAsDataURL(blob);
    });
    var comLinha = await comContorno(url, poli.__rings, jan);
    cache[chave] = comLinha;
    return comLinha;
  }

  /** PU de uma vista — para avisar antes de gastar. */
  function pu() {
    return Math.round(LADO_PX * LADO_PX / 262144 * 100) / 100;
  }

  glob.VistasPoligono = { gerar: gerar, pu: pu, janelaDe: janelaDe };
})(window);
