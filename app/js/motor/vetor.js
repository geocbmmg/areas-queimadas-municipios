/* =====================================================================
   vetor.js — da máscara binária ao polígono.

   Sequência:
     1. limpeza morfológica  (abertura tira pontinhos, fechamento tapa furos)
     2. rotulagem de componentes conexos (4-vizinhança)
     3. filtro de área mínima
     4. traçado dos anéis pelas arestas dos pixels
     5. simplificação Douglas–Peucker opcional

   O traçado percorre a fronteira mantendo o interior sempre à direita.
   Nessa convenção, num referencial de linhas crescendo para baixo, o
   anel externo fecha com área positiva e os buracos com área negativa —
   é assim que se separa ilha de furo sem teste de contenção.
   ===================================================================== */
(function (glob) {
  "use strict";

  /* ---------- 1. MORFOLOGIA ---------- */
  /* Elemento estruturante 3×3 quadrado, aplicado de forma separável
     (horizontal e depois vertical) para não pagar 9 leituras por pixel.
     A borda da imagem é replicada, senão a máscara encolheria de
     mentira em cicatrizes que encostam no limite do recorte. */

  function erodir1D(src, dst, w, h, horizontal) {
    var i, x, y, idx;
    if (horizontal) {
      for (y = 0; y < h; y++) {
        var base = y * w;
        for (x = 0; x < w; x++) {
          var e = x > 0 ? x - 1 : 0;
          var d = x < w - 1 ? x + 1 : w - 1;
          dst[base + x] = (src[base + e] && src[base + x] && src[base + d]) ? 1 : 0;
        }
      }
    } else {
      for (y = 0; y < h; y++) {
        var cima = (y > 0 ? y - 1 : 0) * w;
        var meio = y * w;
        var baixo = (y < h - 1 ? y + 1 : h - 1) * w;
        for (x = 0; x < w; x++) {
          dst[meio + x] = (src[cima + x] && src[meio + x] && src[baixo + x]) ? 1 : 0;
        }
      }
    }
  }

  function dilatar1D(src, dst, w, h, horizontal) {
    var x, y;
    if (horizontal) {
      for (y = 0; y < h; y++) {
        var base = y * w;
        for (x = 0; x < w; x++) {
          var e = x > 0 ? x - 1 : 0;
          var d = x < w - 1 ? x + 1 : w - 1;
          dst[base + x] = (src[base + e] || src[base + x] || src[base + d]) ? 1 : 0;
        }
      }
    } else {
      for (y = 0; y < h; y++) {
        var cima = (y > 0 ? y - 1 : 0) * w;
        var meio = y * w;
        var baixo = (y < h - 1 ? y + 1 : h - 1) * w;
        for (x = 0; x < w; x++) {
          dst[meio + x] = (src[cima + x] || src[meio + x] || src[baixo + x]) ? 1 : 0;
        }
      }
    }
  }

  function erodir(m, w, h, tmp) {
    erodir1D(m, tmp, w, h, true);
    erodir1D(tmp, m, w, h, false);
  }
  function dilatar(m, w, h, tmp) {
    dilatar1D(m, tmp, w, h, true);
    dilatar1D(tmp, m, w, h, false);
  }

  /**
   * Abertura e fechamento com raio n, in place.
   *
   * As passadas homogêneas vêm empilhadas (n erosões, depois n dilatações)
   * de propósito: alternar erodir/dilatar n vezes seria repetir a MESMA
   * abertura — abertura e fechamento são idempotentes — e o controle de
   * intensidade não faria nada acima de 1, como de fato não fazia.
   * Empilhando, o elemento estruturante efetivo cresce com n: com pixel de
   * 10 m, n=1/2/3 remove feições de até ~20/40/60 m.
   */
  function limpar(mascara, w, h, n) {
    if (!n) return mascara;
    var tmp = new Uint8Array(w * h);
    var i;
    for (i = 0; i < n; i++) erodir(mascara, w, h, tmp);
    for (i = 0; i < n; i++) dilatar(mascara, w, h, tmp);
    for (i = 0; i < n; i++) dilatar(mascara, w, h, tmp);
    for (i = 0; i < n; i++) erodir(mascara, w, h, tmp);
    return mascara;
  }

  /* ---------- 2. COMPONENTES CONEXOS ---------- */

  /**
   * Rotulagem por preenchimento iterativo, 4-vizinhança.
   * @returns {{rotulos: Int32Array, total: number, tamanhos: Int32Array,
   *            caixas: Int32Array}} caixas = [minX,minY,maxX,maxY] por rótulo
   */
  function rotular(mascara, w, h) {
    var rot = new Int32Array(w * h);
    var pilha = new Int32Array(Math.max(1024, w * h >> 2));
    var topo = 0;
    var tamanhos = [0];
    var caixas = [0, 0, 0, 0];
    var atual = 0;

    for (var p0 = 0; p0 < mascara.length; p0++) {
      if (!mascara[p0] || rot[p0]) continue;
      atual++;
      var cont = 0;
      var bx0 = w, by0 = h, bx1 = -1, by1 = -1;

      rot[p0] = atual;
      if (topo >= pilha.length) pilha = crescer(pilha);
      pilha[topo++] = p0;

      while (topo > 0) {
        var p = pilha[--topo];
        var x = p % w, y = (p - x) / w;
        cont++;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;

        // 4 vizinhos
        if (x > 0)     { var e = p - 1; if (mascara[e] && !rot[e]) { rot[e] = atual; if (topo >= pilha.length) pilha = crescer(pilha); pilha[topo++] = e; } }
        if (x < w - 1) { var d = p + 1; if (mascara[d] && !rot[d]) { rot[d] = atual; if (topo >= pilha.length) pilha = crescer(pilha); pilha[topo++] = d; } }
        if (y > 0)     { var c = p - w; if (mascara[c] && !rot[c]) { rot[c] = atual; if (topo >= pilha.length) pilha = crescer(pilha); pilha[topo++] = c; } }
        if (y < h - 1) { var b = p + w; if (mascara[b] && !rot[b]) { rot[b] = atual; if (topo >= pilha.length) pilha = crescer(pilha); pilha[topo++] = b; } }
      }
      tamanhos.push(cont);
      caixas.push(bx0, by0, bx1, by1);
    }

    return {
      rotulos: rot,
      total: atual,
      tamanhos: Int32Array.from(tamanhos),
      caixas: Int32Array.from(caixas)
    };
  }

  function crescer(a) {
    var b = new Int32Array(a.length * 2);
    b.set(a);
    return b;
  }

  /* ---------- 3. TRAÇADO DOS ANÉIS ---------- */

  /**
   * Percorre a fronteira de um componente e devolve seus anéis fechados
   * em coordenadas de canto de pixel (x = coluna, y = linha).
   *
   * @param {Int32Array} rot mapa de rótulos
   * @param {number} alvo rótulo do componente
   * @param {number[]} caixa [minX,minY,maxX,maxY]
   */
  function tracarAneis(rot, w, h, alvo, caixa) {
    var x0 = caixa[0], y0 = caixa[1], x1 = caixa[2], y1 = caixa[3];

    // arestas dirigidas: interior sempre à direita do sentido de percurso
    var deX = [], deY = [], paraX = [], paraY = [];
    var indice = new Map();   // chave do vértice -> lista de índices de aresta
    var W1 = w + 1;

    function addAresta(ax, ay, bx, by) {
      var i = deX.length;
      deX.push(ax); deY.push(ay); paraX.push(bx); paraY.push(by);
      var k = ay * W1 + ax;
      var lista = indice.get(k);
      if (lista) lista.push(i); else indice.set(k, [i]);
    }

    for (var y = y0; y <= y1; y++) {
      var base = y * w;
      for (var x = x0; x <= x1; x++) {
        if (rot[base + x] !== alvo) continue;
        // cima
        if (y === 0 || rot[base - w + x] !== alvo) addAresta(x, y, x + 1, y);
        // direita
        if (x === w - 1 || rot[base + x + 1] !== alvo) addAresta(x + 1, y, x + 1, y + 1);
        // baixo
        if (y === h - 1 || rot[base + w + x] !== alvo) addAresta(x + 1, y + 1, x, y + 1);
        // esquerda
        if (x === 0 || rot[base + x - 1] !== alvo) addAresta(x, y + 1, x, y);
      }
    }

    var usada = new Uint8Array(deX.length);
    var aneis = [];

    for (var s = 0; s < deX.length; s++) {
      if (usada[s]) continue;

      var anel = [];
      var atual = s;
      var vxIni = deX[s], vyIni = deY[s];
      anel.push([vxIni, vyIni]);

      while (true) {
        usada[atual] = 1;
        var bx = paraX[atual], by = paraY[atual];
        if (bx === vxIni && by === vyIni) break;
        anel.push([bx, by]);

        var dx = bx - deX[atual], dy = by - deY[atual];
        var cands = indice.get(by * W1 + bx);
        var prox = -1;

        if (cands) {
          // preferência: vira à direita, segue reto, vira à esquerda, volta
          var ordem = [
            [-dy, dx],
            [dx, dy],
            [dy, -dx],
            [-dx, -dy]
          ];
          for (var o = 0; o < 4 && prox < 0; o++) {
            for (var ci = 0; ci < cands.length; ci++) {
              var e = cands[ci];
              if (usada[e]) continue;
              if (paraX[e] - deX[e] === ordem[o][0] && paraY[e] - deY[e] === ordem[o][1]) {
                prox = e;
                break;
              }
            }
          }
        }
        if (prox < 0) break;   // fronteira aberta: não deveria ocorrer
        atual = prox;
      }

      if (anel.length >= 4) aneis.push(anel);
    }

    return aneis;
  }

  /** Área com sinal (shoelace) num referencial de linhas para baixo. */
  function areaAssinada(anel) {
    var s = 0;
    for (var i = 0, n = anel.length; i < n; i++) {
      var a = anel[i], b = anel[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
  }

  /* ---------- 4. SIMPLIFICAÇÃO ---------- */

  function distPontoReta2(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var L = dx * dx + dy * dy;
    if (L === 0) {
      var ex = p[0] - a[0], ey = p[1] - a[1];
      return ex * ex + ey * ey;
    }
    var t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var qx = a[0] + t * dx, qy = a[1] + t * dy;
    var fx = p[0] - qx, fy = p[1] - qy;
    return fx * fx + fy * fy;
  }

  /** Douglas–Peucker iterativo sobre uma polilinha aberta. */
  function dpPolilinha(pts, tol2) {
    var n = pts.length;
    if (n < 3) return pts.slice();
    var manter = new Uint8Array(n);
    manter[0] = manter[n - 1] = 1;
    var pilha = [[0, n - 1]];

    while (pilha.length) {
      var seg = pilha.pop();
      var ini = seg[0], fim = seg[1];
      var pior = -1, dPior = tol2;
      for (var i = ini + 1; i < fim; i++) {
        var d = distPontoReta2(pts[i], pts[ini], pts[fim]);
        if (d > dPior) { dPior = d; pior = i; }
      }
      if (pior > 0) {
        manter[pior] = 1;
        pilha.push([ini, pior], [pior, fim]);
      }
    }
    var out = [];
    for (var j = 0; j < n; j++) if (manter[j]) out.push(pts[j]);
    return out;
  }

  /**
   * Simplifica um anel fechado. Quebra em duas polilinhas nos dois
   * pontos mais afastados para não deixar o resultado depender de onde
   * o traçado começou.
   */
  function simplificarAnel(anel, tol) {
    if (tol <= 0 || anel.length < 8) return anel;
    var tol2 = tol * tol;
    var n = anel.length;

    var iLonge = 0, dMax = -1;
    for (var i = 1; i < n; i++) {
      var dx = anel[i][0] - anel[0][0], dy = anel[i][1] - anel[0][1];
      var d = dx * dx + dy * dy;
      if (d > dMax) { dMax = d; iLonge = i; }
    }

    var a = dpPolilinha(anel.slice(0, iLonge + 1), tol2);
    var b = dpPolilinha(anel.slice(iLonge).concat([anel[0]]), tol2);
    var res = a.concat(b.slice(1, b.length - 1));
    if (res.length < 4) return anel;

    // Chaikin por cima do Douglas–Peucker: corta os cantos que sobraram
    // do traçado pixel a pixel e o contorno sai com cara de cicatriz, não
    // de escada. Uma iteração muda a área menos de 0,5 %.
    return chaikin(res);
  }

  /** Uma iteração de corte de cantos de Chaikin, sobre anel fechado. */
  function chaikin(anel) {
    var n = anel.length;
    if (n < 4) return anel;
    var out = [];
    for (var i = 0; i < n; i++) {
      var p = anel[i], q = anel[(i + 1) % n];
      out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
      out.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
    }
    return out;
  }

  /* ---------- 5. ORQUESTRAÇÃO ---------- */

  /**
   * Vetoriza a máscara.
   *
   * @param {Uint8Array} mascara
   * @param {Float32Array} dnbr
   * @param {Object} grade
   * @param {Object} opc {morfologia, areaMinM2, tolSimplPx, maxPoligonos}
   * @param {Function} [aoProgredir] recebe (fracao, texto)
   * @returns {{feicoes: Object[], truncado: boolean, totalBruto: number}}
   */
  function vetorizar(mascara, dnbr, grade, opc, aoProgredir) {
    var w = grade.largura, h = grade.altura;
    var prog = aoProgredir || function () {};

    prog(0.05, "Limpando a máscara…");
    limpar(mascara, w, h, opc.morfologia | 0);

    prog(0.25, "Identificando manchas…");
    var comp = rotular(mascara, w, h);

    // pré-filtro por contagem de pixels — a área exata sai depois,
    // geodésica, mas isso já elimina o grosso do ruído barato
    var areaPixel = grade.res * grade.res;
    var minPixels = Math.max(1, Math.ceil((opc.areaMinM2 || 0) / areaPixel));

    var candidatos = [];
    for (var L = 1; L <= comp.total; L++) {
      if (comp.tamanhos[L] >= minPixels) candidatos.push(L);
    }
    var totalBruto = comp.total;

    // estatísticas de dNBR por componente, numa passada só. Só pixels
    // acima do limiar entram: o fechamento morfológico preenche furos com
    // pixels abaixo do corte, e sem este filtro as estatísticas daqui
    // divergiam das do recálculo pós-borracha (que sempre filtrou).
    var limiarStats = (opc.limiar != null && !isNaN(opc.limiar)) ? opc.limiar : -Infinity;
    var soma = new Float64Array(comp.total + 1);
    var vmin = new Float64Array(comp.total + 1).fill(Infinity);
    var vmax = new Float64Array(comp.total + 1).fill(-Infinity);
    var cont = new Int32Array(comp.total + 1);
    for (var i = 0; i < comp.rotulos.length; i++) {
      var L2 = comp.rotulos[i];
      if (!L2) continue;
      var v = dnbr[i];
      if (isNaN(v) || v < limiarStats) continue;
      soma[L2] += v; cont[L2]++;
      if (v < vmin[L2]) vmin[L2] = v;
      if (v > vmax[L2]) vmax[L2] = v;
    }

    prog(0.45, "Desenhando contornos…");
    var maxPol = opc.maxPoligonos || 20000;
    var truncado = candidatos.length > maxPol;
    if (truncado) {
      candidatos.sort(function (a, b) { return comp.tamanhos[b] - comp.tamanhos[a]; });
      candidatos = candidatos.slice(0, maxPol);
    }

    var tol = opc.tolSimplPx || 0;
    var feicoes = [];

    for (var k = 0; k < candidatos.length; k++) {
      var lab = candidatos[k];
      var caixa = [
        comp.caixas[lab * 4], comp.caixas[lab * 4 + 1],
        comp.caixas[lab * 4 + 2], comp.caixas[lab * 4 + 3]
      ];
      var aneis = tracarAneis(comp.rotulos, w, h, lab, caixa);
      if (!aneis.length) continue;

      var externos = [], buracos = [];
      for (var r = 0; r < aneis.length; r++) {
        var an = tol > 0 ? simplificarAnel(aneis[r], tol) : aneis[r];
        if (an.length < 4) continue;
        (areaAssinada(aneis[r]) > 0 ? externos : buracos).push(an);
      }
      if (!externos.length) continue;

      // um componente 4-conexo tem um único anel externo; se a
      // simplificação partiu algo, fica com o maior
      if (externos.length > 1) {
        externos.sort(function (a, b) {
          return Math.abs(areaAssinada(b)) - Math.abs(areaAssinada(a));
        });
        externos = [externos[0]];
      }

      feicoes.push({
        externo: externos[0],
        buracos: buracos,
        pixels: comp.tamanhos[lab],
        rotulo: lab,
        dnbrMedio: cont[lab] ? soma[lab] / cont[lab] : NaN,
        dnbrMin: cont[lab] ? vmin[lab] : NaN,
        dnbrMax: cont[lab] ? vmax[lab] : NaN
      });

      if ((k & 255) === 0) {
        prog(0.45 + 0.5 * (k / candidatos.length), "Desenhando contornos… " + k + "/" + candidatos.length);
      }
    }

    prog(1, "Pronto.");
    // rotulos: o mapa pixel→componente, na mesma grade do dNBR — é o que
    // permite cruzar cada feição com o tile de uso do solo (biomassa.js)
    return { feicoes: feicoes, truncado: truncado, totalBruto: totalBruto,
             rotulos: comp.rotulos };
  }

  glob.Vetor = {
    limpar: limpar,
    rotular: rotular,
    tracarAneis: tracarAneis,
    areaAssinada: areaAssinada,
    simplificarAnel: simplificarAnel,
    vetorizar: vetorizar
  };
})(window);
