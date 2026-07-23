"use strict";
// ============================================================
//  Soccer MP - game-over / session-ended patch (drop-in)
//
//  Load AFTER the main inline <script> in soccer/public/index.html:
//
//      </script>
//      <script src="./gameover-patch.js"></script>
//    </body>
//
//  Fixes two issues without editing the existing inline code:
//    1) {type:'session-ended'} control message  ->  close orphaned
//       socket + wipe saved reconnect token, so re-entering the same
//       code cannot land in a phantom old room.
//    2) {t:'phase', ph:'gameover'} with p1/p2/winner/winnerName  ->
//       repaint the Full Time overlay from the server-authoritative
//       payload (name + score) rather than local G.players.
//    3) Rematch button always opens a NEW WebSocket (never reuses the
//       finished-room socket).
//
//  Assumes the main client exposes globals: net, send, connect,
//  clearSession, G (the soccer index.html does).
// ============================================================
(function () {
  function $(id) { return document.getElementById(id); }
  function getNet() { return (typeof net === 'object' && net) ? net : null; }
  function getClear() { return (typeof clearSession === 'function') ? clearSession : function () {}; }
  function getConnect() { return (typeof connect === 'function') ? connect : null; }
  function getSend() { return (typeof send === 'function') ? send : null; }
  function nukeSession() { try { localStorage.removeItem('smp_session'); } catch (e) {} }

  // 1. session-ended: room is closed server-side. Detach and lock.
  function onSessionEnded() {
    var n = getNet();
    if (n) {
      n.ended = true; n.token = ''; n.manualClose = true;
      try { if (n.ws) n.ws.close(); } catch (e) {}
      n.ws = null; n.connected = false;
    }
    getClear()(); nukeSession();
    try { if (typeof setPill === 'function') setPill(false); } catch (e) {}
  }

  // 2. Repaint the game-over overlay from the server payload.
  function paintGameOver(m) {
    var s1 = m.s1, s2 = m.s2;
    var winnerName = m.winnerName ||
      (m.winner === 1 ? (m.p1 || 'Player 1') : (m.winner === 2 ? (m.p2 || 'Player 2') : null));
    var w = $('winner');
    var COL = { 1: '#ff5b5b', 2: '#4a9eff' };
    if (w) {
      if (m.winner === 0 || m.winner == null) {
        w.style.color = 'var(--amber)';
        w.textContent = "It's a draw";
      } else {
        w.style.color = COL[m.winner] || '';
        w.textContent = '\ud83c\udfc6 ' + winnerName + ' wins';
      }
    }
    // Ensure a big "N - N" line exists above the per-player rows.
    var fs = $('finalScoreLine');
    if (!fs) {
      var over = $('gameover');
      if (over) {
        fs = document.createElement('div');
        fs.id = 'finalScoreLine';
        fs.style.cssText = 'font-family:"Bebas Neue",sans-serif;font-size:44px;letter-spacing:.05em;text-align:center;margin:8px 0 14px;color:#eafaef;line-height:1;';
        var card = over.querySelector('.card');
        if (card) card.insertBefore(fs, card.querySelector('#finalScores') || card.querySelector('#rematchBtn'));
      }
    }
    if (fs) {
      var hi = Math.max(s1, s2), lo = Math.min(s1, s2);
      if (m.winner === 1) { fs.style.color = COL[1]; fs.textContent = hi + ' \u2013 ' + lo; }
      else if (m.winner === 2) { fs.style.color = COL[2]; fs.textContent = hi + ' \u2013 ' + lo; }
      else { fs.style.color = '#eafaef'; fs.textContent = s1 + ' \u2013 ' + s2; }
    }
  }

  // Intercept ws.onmessage non-destructively.
  function install(ws) {
    if (!ws || ws.__goPatched) return;
    ws.__goPatched = true;
    var orig = ws.onmessage;
    ws.onmessage = function (ev) {
      var m = null; try { m = JSON.parse(ev.data); } catch (e) {}
      if (orig) { try { orig.call(this, ev); } catch (e) {} }
      if (!m) return;
      if (m.type === 'session-ended') { onSessionEnded(); return; }
      if (m.t === 'phase' && m.ph === 'gameover') {
        setTimeout(function () { paintGameOver(m); }, 0);
      }
    };
  }
  var pollWs = setInterval(function () {
    var n = getNet(); if (n && n.ws) install(n.ws);
  }, 200);
  setTimeout(function () { clearInterval(pollWs); }, 120000);

  // 3. Rewire Rematch: always open a NEW socket.
  function wireRematch() {
    var btn = $('rematchBtn'); if (!btn) return false;
    if (btn.__goPatched) return true;
    btn.__goPatched = true;
    btn.addEventListener('click', function (e) {
      e.stopImmediatePropagation();
      e.preventDefault();
      var n = getNet(); if (!n) return;
      var connectFn = getConnect(), sendFn = getSend();
      if (!connectFn || !sendFn) return;
      var code = n.code, name = n.name;
      try { if (n.ws) n.ws.close(); } catch (er) {}
      n.ws = null; n.connected = false;
      n.token = ''; n.ended = false; n.reconnecting = false;
      n.manualClose = false; n.connecting = true; n.retries = 0;
      getClear()(); nukeSession();
      try { if (typeof G !== 'undefined') G = null; } catch (er) {}
      var status = $('gameoverStatus'); if (status) status.textContent = 'Restarting\u2026';
      connectFn(function () {
        n.connecting = false;
        install(n.ws);
        sendFn({ type: 'join', code: code, name: name });
      });
    }, true);
    return true;
  }
  var pollBtn = setInterval(function () { if (wireRematch()) clearInterval(pollBtn); }, 200);
})();
