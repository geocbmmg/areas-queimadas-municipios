/* =====================================================================
   geo.js — conversão de coordenadas do CRS do raster para WGS84.

   O Copernicus Browser entrega o recorte quase sempre em UTM/WGS84
   (EPSG:326xx no hemisfério norte, 327xx no sul), e às vezes em
   4326 ou 3857. Esses três casos são resolvidos aqui em JavaScript
   puro, sem depender do módulo de projeção do SDK: é exato, síncrono
   e rápido o bastante para reprojetar dezenas de milhares de vértices.

   Qualquer outro CRS cai no módulo esri/geometry/projection.
   ===================================================================== */
(function (glob) {
  "use strict";

  var A = 6378137.0;                 // semieixo maior WGS84
  var F = 1 / 298.257223563;         // achatamento
  var E2 = F * (2 - F);              // primeira excentricidade ao quadrado
  var K0 = 0.9996;                   // fator de escala UTM
  var R2D = 180 / Math.PI;
  var D2R = Math.PI / 180;

  /**
   * Interpreta o código EPSG e devolve um descritor do sistema.
   * @param {number} epsg
   */
  function descreverCRS(epsg) {
    if (!epsg) return { tipo: "desconhecido", epsg: epsg };
    if (epsg === 4326) return { tipo: "geografico", epsg: epsg, unidade: "graus" };
    if (epsg === 3857 || epsg === 900913 || epsg === 102100) {
      return { tipo: "webmercator", epsg: 3857, unidade: "m" };
    }
    if (epsg >= 32601 && epsg <= 32660) {
      return { tipo: "utm", epsg: epsg, zona: epsg - 32600, sul: false, unidade: "m" };
    }
    if (epsg >= 32701 && epsg <= 32760) {
      return { tipo: "utm", epsg: epsg, zona: epsg - 32700, sul: true, unidade: "m" };
    }
    return { tipo: "outro", epsg: epsg, unidade: "m" };
  }

  /**
   * UTM (WGS84) → longitude/latitude. Série de Snyder, precisão milimétrica.
   * @returns {[number,number]} [lon, lat] em graus
   */
  function utmParaLonLat(leste, norte, zona, sul) {
    var x = leste - 500000.0;
    var y = sul ? norte - 10000000.0 : norte;

    var e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    var M = y / K0;
    var mu = M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256));

    var e1_2 = e1 * e1, e1_3 = e1_2 * e1, e1_4 = e1_3 * e1;
    var phi1 = mu
      + (3 * e1 / 2 - 27 * e1_3 / 32) * Math.sin(2 * mu)
      + (21 * e1_2 / 16 - 55 * e1_4 / 32) * Math.sin(4 * mu)
      + (151 * e1_3 / 96) * Math.sin(6 * mu)
      + (1097 * e1_4 / 512) * Math.sin(8 * mu);

    var sinP = Math.sin(phi1), cosP = Math.cos(phi1), tanP = Math.tan(phi1);
    var ep2 = E2 / (1 - E2);
    var C1 = ep2 * cosP * cosP;
    var T1 = tanP * tanP;
    var raiz = Math.sqrt(1 - E2 * sinP * sinP);
    var N1 = A / raiz;
    var R1 = A * (1 - E2) / (raiz * raiz * raiz);
    var D = x / (N1 * K0);

    var D2 = D * D, D3 = D2 * D, D4 = D3 * D, D5 = D4 * D, D6 = D5 * D;

    var lat = phi1 - (N1 * tanP / R1) * (
      D2 / 2
      - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D6 / 720
    );

    var lon = (
      D
      - (1 + 2 * T1 + C1) * D3 / 6
      + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D5 / 120
    ) / cosP;

    var lon0 = (zona * 6 - 183) * D2R;
    return [(lon0 + lon) * R2D, lat * R2D];
  }

  /** Zona UTM e hemisfério de um ponto em graus. */
  function zonaUtm(lon, lat) {
    var zona = Math.floor((lon + 180) / 6) + 1;
    if (zona < 1) zona = 1;
    if (zona > 60) zona = 60;
    return { zona: zona, sul: lat < 0, epsg: (lat < 0 ? 32700 : 32600) + zona };
  }

  /**
   * Longitude/latitude → UTM (WGS84). Série de Snyder, o inverso de
   * utmParaLonLat. Usada para pedir o recorte ao Copernicus já em metros,
   * de modo que o pixel saia quadrado e a área não precise de correção.
   */
  function lonLatParaUtm(lon, lat, zona, sul) {
    var latR = lat * D2R;
    var lonR = lon * D2R;
    var lon0 = (zona * 6 - 183) * D2R;

    var sinL = Math.sin(latR), cosL = Math.cos(latR), tanL = Math.tan(latR);
    var N = A / Math.sqrt(1 - E2 * sinL * sinL);
    var T = tanL * tanL;
    var ep2 = E2 / (1 - E2);
    var C = ep2 * cosL * cosL;
    var Aa = cosL * (lonR - lon0);

    var M = A * (
      (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256) * latR
      - (3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 * E2 * E2 / 1024) * Math.sin(2 * latR)
      + (15 * E2 * E2 / 256 + 45 * E2 * E2 * E2 / 1024) * Math.sin(4 * latR)
      - (35 * E2 * E2 * E2 / 3072) * Math.sin(6 * latR)
    );

    var A2 = Aa * Aa, A3 = A2 * Aa, A4 = A3 * Aa, A5 = A4 * Aa, A6 = A5 * Aa;

    var leste = K0 * N * (
      Aa + (1 - T + C) * A3 / 6
      + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A5 / 120
    ) + 500000.0;

    var norte = K0 * (M + N * tanL * (
      A2 / 2 + (5 - T + 9 * C + 4 * C * C) * A4 / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A6 / 720
    ));
    if (sul) norte += 10000000.0;

    return [leste, norte];
  }

  /** Web Mercator → longitude/latitude. */
  function mercatorParaLonLat(x, y) {
    return [
      (x / A) * R2D,
      (2 * Math.atan(Math.exp(y / A)) - Math.PI / 2) * R2D
    ];
  }

  /** Longitude/latitude → Web Mercator, inversa exata da função acima. */
  function lonLatParaMercator(lon, lat) {
    var latR = lat * D2R;
    return [
      A * lon * D2R,
      A * Math.log(Math.tan(Math.PI / 4 + latR / 2))
    ];
  }

  /**
   * Devolve uma função (x, y) => [lon, lat] para o CRS informado.
   * Lança se o CRS não puder ser resolvido localmente — nesse caso o
   * chamador deve recorrer a `projetarComSDK`.
   */
  function conversorParaWGS84(epsg) {
    var crs = descreverCRS(epsg);
    switch (crs.tipo) {
      case "geografico":
        return function (x, y) { return [x, y]; };
      case "webmercator":
        return mercatorParaLonLat;
      case "utm":
        return function (x, y) { return utmParaLonLat(x, y, crs.zona, crs.sul); };
      default:
        return null;
    }
  }

  /** Nome legível do CRS, para exibir na interface e gravar no atributo. */
  function nomeCRS(epsg) {
    var crs = descreverCRS(epsg);
    if (crs.tipo === "utm") {
      return "EPSG:" + epsg + " (UTM " + crs.zona + (crs.sul ? "S" : "N") + ")";
    }
    if (crs.tipo === "geografico") return "EPSG:4326 (WGS84)";
    if (crs.tipo === "webmercator") return "EPSG:3857 (Web Mercator)";
    return epsg ? "EPSG:" + epsg : "CRS não identificado";
  }

  /**
   * Área geodésica de um anel em lon/lat, em m². Fórmula de Chamberlain
   * & Duquette sobre a esfera autálica — erro abaixo de 0,1 % nas
   * dimensões de uma cicatriz de incêndio.
   * Usada apenas como pré-filtro; a área final vem do geometryEngine.
   */
  function areaGeodesicaAprox(anel) {
    var R = 6371007.181;
    var soma = 0;
    for (var i = 0, n = anel.length; i < n; i++) {
      var p1 = anel[i], p2 = anel[(i + 1) % n];
      soma += (p2[0] - p1[0]) * D2R *
              (2 + Math.sin(p1[1] * D2R) + Math.sin(p2[1] * D2R));
    }
    return Math.abs(soma * R * R / 2);
  }

  /** Área planar (shoelace) de um anel, na unidade do próprio CRS. */
  function areaPlanar(anel) {
    var s = 0;
    for (var i = 0, n = anel.length; i < n; i++) {
      var p1 = anel[i], p2 = anel[(i + 1) % n];
      s += p1[0] * p2[1] - p2[0] * p1[1];
    }
    return s / 2;
  }

  glob.Geo = {
    descreverCRS: descreverCRS,
    conversorParaWGS84: conversorParaWGS84,
    utmParaLonLat: utmParaLonLat,
    lonLatParaUtm: lonLatParaUtm,
    zonaUtm: zonaUtm,
    mercatorParaLonLat: mercatorParaLonLat,
    lonLatParaMercator: lonLatParaMercator,
    nomeCRS: nomeCRS,
    areaGeodesicaAprox: areaGeodesicaAprox,
    areaPlanar: areaPlanar
  };
})(window);
