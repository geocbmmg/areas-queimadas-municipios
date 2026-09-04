/* =====================================================================
   pu.js — o velocímetro de cota do Copernicus, herdado da Calculadora.

   O CDSE não expõe o saldo por API; a estimativa vive neste navegador e
   zera no dia 1º. É por militar (cada um na própria estação/conta).
   ===================================================================== */
(function (glob) {
  "use strict";

  var CHAVE = "mg.pu.mensal";

  function mesAtual() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  function ler() {
    try {
      var r = JSON.parse(localStorage.getItem(CHAVE) || "null");
      if (r && r.mes === mesAtual()) return r;
    } catch (e) { }
    return { mes: mesAtual(), total: 0 };
  }

  function gravar(r) {
    try { localStorage.setItem(CHAVE, JSON.stringify(r)); } catch (e) { }
  }

  glob.Pu = {
    usado: function () { return ler().total; },
    somar: function (v) {
      if (!v || isNaN(v)) return;
      var r = ler();
      r.total = Math.round((r.total + v) * 10) / 10;
      gravar(r);
      if (glob.Pu.aoMudar) glob.Pu.aoMudar(r.total);
    },
    aoMudar: null
  };
})(window);
