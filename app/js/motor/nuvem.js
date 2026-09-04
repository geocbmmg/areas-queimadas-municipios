/* =====================================================================
   nuvem.js — nuvem medida DENTRO do recorte, e não na cena.

   O filtro antigo olhava o eo:cloud_cover do catálogo: a nuvem de um
   tile inteiro do Sentinel-2, 110×110 km. Uma UC de 21×46 km cabe
   dezessete vezes ali dentro. Foi assim que 7 das 9 primeiras passagens
   da Serra do Cabral viraram "nublada" sem que ninguém olhasse a UC, e
   foi por isso que a única passagem calculada acabou comparada com uma
   referência de 35 dias antes — vão em que o cerrado seca sozinho e o
   dNBR se enche de mancha que não é fogo.

   A sonda aqui pede o SCL (a classificação que o próprio processamento
   L2A já produz) num quarto da resolução do índice. Custa ~1,6% do que
   custa o índice e serve para duas coisas ao mesmo tempo:

     1. decidir se a passagem é viável (nuvem no recorte, não na cena);
     2. apagar do dNBR os pixels de nuvem, cirrus e sombra — ampliados
        para a grade do índice por vizinho mais próximo.

   Classes do SCL: 0 sem dado · 1 saturado · 2 sombra de relevo ·
   3 sombra de nuvem · 4 vegetação · 5 solo · 6 água · 7 sem classe ·
   8 nuvem média · 9 nuvem alta · 10 cirrus · 11 neve.
   ===================================================================== */
(function (glob) {
  "use strict";

  var RUIM = { 3: 1, 8: 1, 9: 1, 10: 1, 11: 1 };   // o que invalida o pixel
  var NUVEM = { 8: 1, 9: 1, 10: 1 };               // o que conta como nuvem

  var COR = {
    3: [40, 90, 190, 130],     // sombra de nuvem
    8: [210, 130, 235, 120],   // nuvem média
    9: [235, 70, 220, 160],    // nuvem alta
    10: [255, 255, 255, 95],   // cirrus
    11: [120, 230, 255, 130]   // neve
  };

  /**
   * Lê um PNG de 1 banda com o SCL e devolve as classes e as contas.
   * O PNG de cinza chega ao canvas com r=g=b=valor da classe.
   */
  async function ler(blob) {
    var bmp = await createImageBitmap(blob);
    var cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    var cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    var px = cx.getImageData(0, 0, cv.width, cv.height).data;

    var n = cv.width * cv.height;
    var classes = new Uint8Array(n);
    var conta = new Uint32Array(12);
    var validos = 0;
    for (var i = 0; i < n; i++) {
      var c = px[i * 4];
      if (c > 11) c = 7;
      classes[i] = c;
      conta[c]++;
      if (c !== 0) validos++;
    }

    function pc(c) { return validos ? 100 * conta[c] / validos : 0; }
    var nuvem = 0;
    Object.keys(NUVEM).forEach(function (c) { nuvem += pc(Number(c)); });

    return {
      classes: classes, largura: cv.width, altura: cv.height,
      validos: validos, total: n,
      pct: Math.round(nuvem * 10) / 10,
      sombra: Math.round(pc(3) * 10) / 10,
      semDado: Math.round((validos ? 100 * conta[0] / n : 100) * 10) / 10,
      detalhe: "alta " + pc(9).toFixed(1) + " · média " + pc(8).toFixed(1) +
               " · cirrus " + pc(10).toFixed(1) + " · sombra " + pc(3).toFixed(1)
    };
  }

  /**
   * Amplia a máscara grossa para a grade do índice (vizinho mais
   * próximo) e devolve um Uint8Array: 1 = pixel utilizável.
   *
   * Vale lembrar o que isto não é: uma máscara de 80 m não recorta a
   * borda fina da nuvem. Ela tira o corpo da nuvem e a sombra grande,
   * que é o que produz mancha de hectares no dNBR. O fiapo de borda
   * continua sendo trabalho do operador na estação da passagem.
   */
  function ampliar(medida, largura, altura) {
    var bom = new Uint8Array(largura * altura);
    var kx = medida.largura / largura, ky = medida.altura / altura;
    for (var y = 0; y < altura; y++) {
      var sy = Math.min(medida.altura - 1, Math.floor(y * ky));
      for (var x = 0; x < largura; x++) {
        var sx = Math.min(medida.largura - 1, Math.floor(x * kx));
        var c = medida.classes[sy * medida.largura + sx];
        bom[y * largura + x] = (c === 0 || RUIM[c]) ? 0 : 1;
      }
    }
    return bom;
  }

  /** Canvas colorido da máscara, para sobrepor no mapa. */
  function pintar(medida) {
    var cv = document.createElement("canvas");
    cv.width = medida.largura; cv.height = medida.altura;
    var cx = cv.getContext("2d");
    var im = cx.createImageData(cv.width, cv.height);
    for (var i = 0; i < medida.classes.length; i++) {
      var cor = COR[medida.classes[i]];
      if (!cor) continue;
      im.data[i * 4] = cor[0];
      im.data[i * 4 + 1] = cor[1];
      im.data[i * 4 + 2] = cor[2];
      im.data[i * 4 + 3] = cor[3];
    }
    cx.putImageData(im, 0, 0);
    return cv;
  }

  /** Dimensões da sonda: o índice dividido por `divisor`, com piso. */
  function dimensoes(ft, divisor) {
    return {
      w: Math.max(48, Math.round(ft.largura / divisor)),
      h: Math.max(48, Math.round(ft.altura / divisor))
    };
  }

  /** Custo em PU de uma sonda (1 banda, uint8). */
  function pu(ft, divisor) {
    var d = dimensoes(ft, divisor);
    return d.w * d.h / 262144 / 3;
  }

  /** Sonda completa: pede o SCL ao Copernicus e mede. */
  async function sondar(ft, diaCena, divisor) {
    var d = dimensoes(ft, divisor);
    var blob = await Copernicus.baixarRecorte({
      bbox: ft.bbox, epsg: ft.epsg, largura: d.w, altura: d.h,
      data: diaCena, evalscript: Copernicus.EVAL_SCL, formato: "image/png"
    });
    var m = await ler(blob);
    m.blob = blob;
    return m;
  }

  glob.Nuvem = {
    ler: ler, ampliar: ampliar, pintar: pintar,
    sondar: sondar, dimensoes: dimensoes, pu: pu,
    RUIM: RUIM
  };
})(window);
