/* =====================================================================
   raster.js — leitura dos GeoTIFF, alinhamento das quatro bandas numa
   grade comum e cálculo do dNBR.

   Tudo roda no navegador. Nenhum pixel sai da máquina do operador:
   o que vai para o Portal é só o polígono final.
   ===================================================================== */
(function (glob) {
  "use strict";

  /* ---------- 1. LEITURA ---------- */

  /**
   * Lê o cabeçalho de um GeoTIFF sem trazer os pixels.
   * @returns {Promise<Object>} descritor com extensão, tamanho e CRS
   */
  async function lerCabecalho(file) {
    var tiff = await GeoTIFF.fromBlob(file);
    var img = await tiff.getImage();
    var bbox = img.getBoundingBox();          // [minX, minY, maxX, maxY]
    var gk = img.geoKeys || {};
    var epsg = gk.ProjectedCSTypeGeoKey || gk.GeographicTypeGeoKey || null;

    var mt = img.fileDirectory.ModelTransformation;
    var rotacionado = !!(mt && (Math.abs(mt[1]) > 1e-9 || Math.abs(mt[4]) > 1e-9));

    return {
      arquivo: file,
      nome: file.name,
      tiff: tiff,
      imagem: img,
      largura: img.getWidth(),
      altura: img.getHeight(),
      bandas: img.getSamplesPerPixel(),
      bbox: bbox,
      epsg: epsg,
      semDado: img.getGDALNoData(),
      rotacionado: rotacionado,
      resX: (bbox[2] - bbox[0]) / img.getWidth(),
      resY: (bbox[3] - bbox[1]) / img.getHeight()
    };
  }

  /**
   * Lê os pixels de uma banda já decimados para um tamanho alvo.
   * @param {Object} cab descritor devolvido por lerCabecalho
   * @param {number} larg largura desejada de leitura
   * @param {number} alt altura desejada de leitura
   * @param {number} banda índice da banda (0 para imagens de banda única)
   */
  async function lerBanda(cab, larg, alt, banda) {
    larg = Math.max(1, Math.min(cab.largura, Math.round(larg)));
    alt = Math.max(1, Math.min(cab.altura, Math.round(alt)));
    var r = await cab.imagem.readRasters({
      width: larg,
      height: alt,
      samples: [banda || 0],
      interleave: false,
      // "nearest" de propósito: o bilinear daqui misturava o valor de
      // "sem dado" com vizinhos válidos ANTES da checagem de nodata,
      // inventando dNBR na borda diagonal da cena. A interpolação bilinear
      // de verdade acontece depois, em reamostrar(), já com o guard.
      resampleMethod: "nearest",
      fillValue: NaN
    });
    return { dados: r[0], largura: larg, altura: alt };
  }

  /** Lê as três bandas de uma imagem RGB (falsa cor) para exibição. */
  async function lerRGB(cab, larg, alt) {
    larg = Math.max(1, Math.min(cab.largura, Math.round(larg)));
    alt = Math.max(1, Math.min(cab.altura, Math.round(alt)));
    var amostras = cab.bandas >= 3 ? [0, 1, 2] : [0];
    var r = await cab.imagem.readRasters({
      width: larg, height: alt, samples: amostras,
      interleave: false, resampleMethod: "bilinear"
    });
    return { bandas: r, largura: larg, altura: alt, n: amostras.length };
  }

  /* ---------- 2. GRADE COMUM ---------- */

  /**
   * Define a grade de trabalho: interseção das extensões das quatro
   * bandas, na resolução da referência (B8 antes), respeitando o teto
   * de pixels escolhido pelo operador.
   *
   * @param {Object[]} cabs cabeçalhos das quatro bandas
   * @param {Object} ref cabeçalho usado como referência de resolução
   * @param {number} maxPixels 0 = sem limite
   */
  function definirGrade(cabs, ref, maxPixels) {
    var minX = -Infinity, minY = -Infinity, maxX = Infinity, maxY = Infinity;
    cabs.forEach(function (c) {
      minX = Math.max(minX, c.bbox[0]);
      minY = Math.max(minY, c.bbox[1]);
      maxX = Math.min(maxX, c.bbox[2]);
      maxY = Math.min(maxY, c.bbox[3]);
    });
    if (!(maxX > minX && maxY > minY)) {
      throw new Error(
        "As imagens não se sobrepõem. Confira se as quatro bandas são do mesmo recorte."
      );
    }

    var res = Math.min(Math.abs(ref.resX), Math.abs(ref.resY));
    var larg = Math.round((maxX - minX) / res);
    var alt = Math.round((maxY - minY) / res);

    var decimado = false;
    if (maxPixels > 0 && larg * alt > maxPixels) {
      var fator = Math.sqrt((larg * alt) / maxPixels);
      res = res * fator;
      larg = Math.max(1, Math.round((maxX - minX) / res));
      alt = Math.max(1, Math.round((maxY - minY) / res));
      decimado = true;
    }

    return {
      minX: minX, minY: minY,
      maxX: minX + larg * res, maxY: minY + alt * res,
      origemX: minX, origemY: minY + alt * res,   // canto superior esquerdo
      res: res, largura: larg, altura: alt,
      decimado: decimado,
      epsg: ref.epsg
    };
  }

  /* ---------- 3. REAMOSTRAGEM ---------- */

  /**
   * Reamostra por bilinear um bloco lido para a grade de trabalho.
   * Trata NaN e nodata: se algum dos quatro vizinhos for inválido, o
   * pixel de saída sai inválido — melhor um buraco honesto do que uma
   * borda inventada.
   */
  function reamostrar(bloco, bbox, grade, semDado) {
    var srcW = bloco.largura, srcH = bloco.altura, src = bloco.dados;
    var sMinX = bbox[0], sMaxY = bbox[3];
    var sResX = (bbox[2] - bbox[0]) / srcW;
    var sResY = (bbox[3] - bbox[1]) / srcH;

    var out = new Float32Array(grade.largura * grade.altura);
    var temNodata = semDado !== null && semDado !== undefined && !isNaN(semDado);

    for (var row = 0; row < grade.altura; row++) {
      var y = grade.origemY - (row + 0.5) * grade.res;
      var fy = (sMaxY - y) / sResY - 0.5;
      var r0 = Math.floor(fy);
      var ty = fy - r0;
      var r1 = r0 + 1;
      if (r0 < 0) { r0 = 0; }
      if (r1 < 0) { r1 = 0; }
      if (r0 > srcH - 1) { r0 = srcH - 1; }
      if (r1 > srcH - 1) { r1 = srcH - 1; }

      var base = row * grade.largura;
      for (var col = 0; col < grade.largura; col++) {
        var x = grade.origemX + (col + 0.5) * grade.res;
        var fx = (x - sMinX) / sResX - 0.5;
        var c0 = Math.floor(fx);
        var tx = fx - c0;
        var c1 = c0 + 1;
        if (c0 < 0) { c0 = 0; }
        if (c1 < 0) { c1 = 0; }
        if (c0 > srcW - 1) { c0 = srcW - 1; }
        if (c1 > srcW - 1) { c1 = srcW - 1; }

        var v00 = src[r0 * srcW + c0], v01 = src[r0 * srcW + c1];
        var v10 = src[r1 * srcW + c0], v11 = src[r1 * srcW + c1];

        if (temNodata) {
          if (v00 === semDado || v01 === semDado || v10 === semDado || v11 === semDado) {
            out[base + col] = NaN;
            continue;
          }
        }
        if (isNaN(v00) || isNaN(v01) || isNaN(v10) || isNaN(v11)) {
          out[base + col] = NaN;
          continue;
        }

        var a = v00 + (v01 - v00) * tx;
        var b = v10 + (v11 - v10) * tx;
        out[base + col] = a + (b - a) * ty;
      }
    }
    return out;
  }

  /**
   * Carrega uma banda já alinhada à grade de trabalho.
   * Lê o arquivo decimado próximo da resolução alvo para não estourar
   * a memória com cenas grandes.
   */
  async function bandaNaGrade(cab, grade, banda) {
    var escalaX = Math.abs(cab.resX) / grade.res;
    var escalaY = Math.abs(cab.resY) / grade.res;
    var larg = Math.min(cab.largura, Math.max(1, Math.ceil(cab.largura * escalaX)));
    var alt = Math.min(cab.altura, Math.max(1, Math.ceil(cab.altura * escalaY)));
    var bloco = await lerBanda(cab, larg, alt, banda || 0);
    return reamostrar(bloco, cab.bbox, grade, cab.semDado);
  }

  /* ---------- 4. dNBR ---------- */

  /**
   * NBR = (NIR − SWIR) / (NIR + SWIR).
   * A razão é invariante a escala, então tanto faz reflectância 0–1 ou
   * DN 0–10000. O offset, não: produtos L2A com baseline ≥ 04.00 trazem
   * −1000 embutido e precisam da correção.
   */
  function calcularNBR(nir, swir, offset) {
    var n = nir.length;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = nir[i] + offset;
      var b = swir[i] + offset;
      var s = a + b;
      out[i] = (s === 0 || isNaN(s)) ? NaN : (a - b) / s;
    }
    return out;
  }

  /**
   * Monta o dNBR e a máscara de queimada.
   *
   * @returns {{dnbr: Float32Array, nbrPos: Float32Array, mascara: Uint8Array,
   *            validos: number, queimados: number}}
   */
  function calcularDNBR(nbrPre, nbrPos) {
    var n = nbrPre.length;
    var dnbr = new Float32Array(n);
    var validos = 0;
    for (var i = 0; i < n; i++) {
      var a = nbrPre[i], b = nbrPos[i];
      if (isNaN(a) || isNaN(b)) { dnbr[i] = NaN; continue; }
      dnbr[i] = a - b;
      validos++;
    }
    return { dnbr: dnbr, validos: validos };
  }

  /**
   * Máscara binária de queimada a partir do dNBR.
   * @param {Object} opc {limiar, usarNbrPos, nbrPosMax}
   */
  function montarMascara(dnbr, nbrPos, opc) {
    var n = dnbr.length;
    var m = new Uint8Array(n);
    var limiar = opc.limiar;
    var checarNbr = !!opc.usarNbrPos;
    var tetoNbr = opc.nbrPosMax;
    var q = 0;
    for (var i = 0; i < n; i++) {
      var v = dnbr[i];
      if (isNaN(v) || v < limiar) continue;
      if (checarNbr) {
        var p = nbrPos[i];
        if (isNaN(p) || p >= tetoNbr) continue;
      }
      m[i] = 1;
      q++;
    }
    return { mascara: m, queimados: q };
  }

  /* ---------- 5. RENDERIZAÇÃO PARA TELA ---------- */

  /** Percentis de um array, ignorando NaN — usado no realce da falsa cor. */
  function percentis(arr, pBaixo, pAlto, amostra) {
    var passo = Math.max(1, Math.floor(arr.length / (amostra || 200000)));
    var v = [];
    for (var i = 0; i < arr.length; i += passo) {
      var x = arr[i];
      if (!isNaN(x)) v.push(x);
    }
    if (!v.length) return [0, 1];
    v.sort(function (a, b) { return a - b; });
    return [
      v[Math.floor(v.length * pBaixo)],
      v[Math.min(v.length - 1, Math.floor(v.length * pAlto))]
    ];
  }

  /**
   * Converte uma imagem RGB lida do GeoTIFF num canvas, com realce
   * linear por percentil 2–98 (o mesmo que o QGIS faz por padrão).
   */
  function rgbParaCanvas(rgb) {
    var w = rgb.largura, h = rgb.altura;
    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    var ctx = cv.getContext("2d");
    var img = ctx.createImageData(w, h);
    var d = img.data;

    var nb = rgb.n;

    // Imagem 8 bits já vem pronta para tela (é o caso de tudo que a
    // Process API devolve): copiar direto. O realce por percentil, banda a
    // banda, é só para reflectância crua de upload — aplicado numa imagem
    // já composta ele DESTRÓI as cores (o preto do queimado virava roxo).
    var direto = rgb.bandas[0] instanceof Uint8Array ||
                 rgb.bandas[0] instanceof Uint8ClampedArray;

    var cortes = [];
    if (!direto) {
      for (var b = 0; b < nb; b++) cortes.push(percentis(rgb.bandas[b], 0.02, 0.98));
    }

    for (var i = 0, px = 0; i < w * h; i++, px += 4) {
      for (var c = 0; c < 3; c++) {
        var bi = nb >= 3 ? c : 0;
        var v = rgb.bandas[bi][i];
        if (direto) {
          d[px + c] = v;
        } else {
          var lo = cortes[bi][0], hi = cortes[bi][1];
          var t = hi > lo ? (v - lo) / (hi - lo) : 0;
          d[px + c] = Math.max(0, Math.min(255, Math.round(t * 255)));
        }
      }
      d[px + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  /** Rampa de cor do dNBR, seguindo as classes de severidade. */
  function dnbrParaCanvas(dnbr, grade) {
    var w = grade.largura, h = grade.altura;
    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    var ctx = cv.getContext("2d");
    var img = ctx.createImageData(w, h);
    var d = img.data;

    for (var i = 0, px = 0; i < dnbr.length; i++, px += 4) {
      var v = dnbr[i];
      if (isNaN(v)) { d[px + 3] = 0; continue; }
      var s = glob.classificarSeveridade(v);
      d[px] = s.cor[0]; d[px + 1] = s.cor[1]; d[px + 2] = s.cor[2];
      // não queimado quase transparente, para o fundo aparecer
      d[px + 3] = (s.cod === 3) ? 25 : 235;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  glob.Raster = {
    lerCabecalho: lerCabecalho,
    lerBanda: lerBanda,
    lerRGB: lerRGB,
    definirGrade: definirGrade,
    bandaNaGrade: bandaNaGrade,
    reamostrar: reamostrar,
    calcularNBR: calcularNBR,
    calcularDNBR: calcularDNBR,
    montarMascara: montarMascara,
    rgbParaCanvas: rgbParaCanvas,
    dnbrParaCanvas: dnbrParaCanvas
  };
})(window);
