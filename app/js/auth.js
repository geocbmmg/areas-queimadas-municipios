/* =====================================================================
   auth.js — sessão do Portal ArcGIS Enterprise, destilada da Calculadora.

   Fluxo implícito por popup (o Portal só libera CORS para uma lista
   fechada de origens; a janela de authorize é navegação, não fetch).
   A página de login corta o window.opener (COOP), então o token volta
   por TRÊS canais: postMessage, BroadcastChannel e localStorage/storage
   event — o primeiro que chegar vence, consumo único.

   Sessão persistida em localStorage: F5 não pede senha de novo.
   ===================================================================== */
(function (glob) {
  "use strict";

  var CHAVE = "mg.portal.sessao";
  var CANAL = "monitor-portal-token";
  var sessao = null;

  function urlRetorno() {
    return location.origin + location.pathname.replace(/\/$/, "") ||
           location.origin;
  }

  function lerPersistida() {
    try {
      var s = JSON.parse(localStorage.getItem(CHAVE) || "null");
      if (s && s.token && s.expira > Date.now() + 60000) return s;
    } catch (e) { }
    return null;
  }

  function guardar(s) {
    sessao = s;
    try { localStorage.setItem(CHAVE, JSON.stringify(s)); } catch (e) { }
  }

  function limpar() {
    sessao = null;
    try { localStorage.removeItem(CHAVE); } catch (e) { }
  }

  /* --------- lado do callback: a própria página, aberta no popup ------ */
  (function tratarRetorno() {
    var h = location.hash;
    if (!(h && h.indexOf("access_token=") >= 0)) return;
    var p = new URLSearchParams(h.slice(1));
    var carga = {
      canal: CANAL,
      token: p.get("access_token"),
      expira: Date.now() + (parseInt(p.get("expires_in"), 10) || 3600) * 1000,
      usuario: p.get("username") || ""
    };
    try { if (window.opener) window.opener.postMessage(carga, location.origin); } catch (e) { }
    try { new BroadcastChannel(CANAL).postMessage(carga); } catch (e) { }
    try { localStorage.setItem(CANAL, JSON.stringify(carga)); } catch (e) { }
    document.body.innerHTML =
      "<p style='font:14px sans-serif;padding:30px'>Autenticado — pode fechar esta janela.</p>";
    setTimeout(function () { window.close(); }, 400);
    throw new Error("__callback_oauth__");   // impede o resto do app de subir no popup
  })();

  /* --------- lado do app ------------------------------------------- */

  function entrar() {
    return new Promise(function (resolver, rejeitar) {
      var url = CFG.portal + "/sharing/rest/oauth2/authorize" +
        "?client_id=" + encodeURIComponent(CFG.appId) +
        "&response_type=token" +
        "&expiration=20160" +
        "&redirect_uri=" + encodeURIComponent(urlRetorno());

      var pronto = false;
      function receber(c) {
        if (pronto || !c || c.canal !== CANAL || !c.token) return;
        pronto = true;
        guardar({ token: c.token, expira: c.expira, usuario: c.usuario });
        desligar();
        resolver(sessao);
      }

      var bc = null;
      function aoMensagem(ev) { if (ev.origin === location.origin) receber(ev.data); }
      function aoStorage(ev) {
        if (ev.key !== CANAL || !ev.newValue) return;
        try { receber(JSON.parse(ev.newValue)); } catch (e) { }
        try { localStorage.removeItem(CANAL); } catch (e) { }
      }
      function desligar() {
        window.removeEventListener("message", aoMensagem);
        window.removeEventListener("storage", aoStorage);
        if (bc) try { bc.close(); } catch (e) { }
        clearInterval(vigia);
      }

      window.addEventListener("message", aoMensagem);
      window.addEventListener("storage", aoStorage);
      try {
        bc = new BroadcastChannel(CANAL);
        bc.onmessage = function (ev) { receber(ev.data); };
      } catch (e) { }

      var jan = window.open(url, "portal_login", "width=480,height=640");
      if (!jan) { desligar(); rejeitar(new Error("popup bloqueado pelo navegador")); return; }

      var vigia = setInterval(function () {
        // resgate final: o popup pode ter gravado e fechado antes de o
        // storage event disparar
        try {
          var salvo = localStorage.getItem(CANAL);
          if (salvo) {
            localStorage.removeItem(CANAL);
            receber(JSON.parse(salvo));
            return;
          }
        } catch (e) { }
        if (jan.closed && !pronto) {
          desligar();
          rejeitar(new Error("janela fechada antes de concluir o login"));
        }
      }, 500);
    });
  }

  function sair() { limpar(); }

  sessao = lerPersistida();

  glob.Auth = {
    entrar: entrar,
    sair: sair,
    sessao: function () {
      if (sessao && sessao.expira <= Date.now() + 60000) limpar();
      return sessao;
    },
    token: function () { var s = glob.Auth.sessao(); return s ? s.token : null; },
    usuario: function () { var s = glob.Auth.sessao(); return s ? s.usuario : null; }
  };
})(window);
