'use strict';

// End-to-end test of the soccer multiplayer server: HTTP health, the WebSocket
// join/lobby handshake, FREE-PLAY kicks (either player, any time), a goal that
// credits the right player and resets the ball to centre, reconnect-by-token,
// and room-full rejection. Uses Node's built-in global WebSocket client
// (Node >= 21), so there is nothing to install.
//
//   node test-server.js
//
// Exits 0 on success, 1 on the first failed assertion.

const http = require('http');

const PORT = process.env.TEST_PORT || 3399;
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';

// Boot the server in-process.
require('./server.js');

const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';

let passed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { console.error('  ✗ ' + label); throw new Error('assertion failed: ' + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

// A tiny wrapper around the built-in WebSocket client with a message queue.
function client(name) {
  const ws = new WebSocket(WS);
  const msgs = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    m.__name = name;
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(m)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(m); return; }
    }
    msgs.push(m);
  });
  const api = {
    ws,
    open: () => new Promise((res, rej) => {
      if (ws.readyState === 1) return res();
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', () => rej(new Error(name + ' ws error')), { once: true });
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    // resolve with the first (queued or future) message matching pred
    waitFor: (pred, ms = 4000) => new Promise((resolve, reject) => {
      for (let i = 0; i < msgs.length; i++) { if (pred(msgs[i])) { const m = msgs.splice(i, 1)[0]; return resolve(m); } }
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer); if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(name + ' timed out waiting for a message'));
      }, ms);
      waiters.push({ pred, resolve, timer });
    }),
    seen: (pred) => msgs.some(pred)
  };
  return api;
}

// Regression (the "same code re-enters the finished game" bug): once a match ends,
// the room must close so reusing the code opens a fresh game the other player can join.
function roomCloseRegression() {
  console.log('Room close on game over (regression)');
  const Rooms = require('./rooms');
  const mk = () => ({ alive: true, roomCode: null, role: 0, sent: [], send(s) { this.sent.push(s); } });
  const R = new Rooms({ graceMs: 50, log: () => {} });
  const a = mk(), b = mk();
  R._join(a, { type: 'join', code: 'RC', name: 'A' });
  R._join(b, { type: 'join', code: 'RC', name: 'B' });
  R._handleMessage(a, JSON.stringify({ t: 'ready' }));
  R._handleMessage(b, JSON.stringify({ t: 'ready' }));
  const room = R.rooms.get('RC');
  ok(!!(room && room.match), 'match starts once both ready up');
  R._finishRoom(room);   // simulate the match reaching game over
  ok(!R.rooms.has('RC'), 'room is closed at game over');
  ok(a.roomCode === null && b.roomCode === null, 'both sockets are detached from the closed room');
  const c = mk(), d = mk();
  R._join(c, { type: 'join', code: 'RC', name: 'A2' });
  R._join(d, { type: 'join', code: 'RC', name: 'B2' });
  const room2 = R.rooms.get('RC');
  ok(!!(room2 && room2 !== room), 'reusing the code creates a brand-new room');
  const full = d.sent.map((x) => JSON.parse(x)).some((m) => m.type === 'room-full');
  ok(!full && !!(room2.seats[0] && room2.seats[1]), 'the other player can join the fresh room (no room-full)');
}

async function main() {
  roomCloseRegression();

  await sleep(250); // let the listener bind

  console.log('HTTP');
  const h = await httpGet('/health');
  ok(h.status === 200, 'GET /health -> 200');
  ok(JSON.parse(h.body).ok === true, '/health body ok:true');
  const idx = await httpGet('/');
  ok(idx.status === 200 && /Soccer/.test(idx.body), 'GET / serves the game');

  console.log('Lobby + match start');
  const A = client('A'); await A.open();
  A.send({ type: 'join', code: 'GOAL1', name: 'Ann' });
  const aJoined = await A.waitFor((m) => m.type === 'joined');
  ok(aJoined.role === 1, 'first client is seat 1 (host)');
  const token = aJoined.token;
  A.send({ t: 'setup', o: { speed: 1.0, halfLength: 120, bounce: 0.7 } });

  const B = client('B'); await B.open();
  B.send({ type: 'join', code: 'GOAL1', name: 'Bob' });
  const bJoined = await B.waitFor((m) => m.type === 'joined');
  ok(bJoined.role === 2, 'second client is seat 2');

  // Ready-up gate: the match must NOT start until BOTH players ready up.
  let early = false;
  try { await A.waitFor((m) => m.t === 'start', 500); early = true; } catch (e) {}
  ok(!early, 'match does not start until both players ready');
  A.send({ t: 'ready' });
  const lob = await A.waitFor((m) => m.type === 'lobby' && m.r1 === true, 2000);
  ok(lob.r1 === true && lob.r2 === false, 'lobby shows host ready, joiner not');
  let onlyOne = false;
  try { await A.waitFor((m) => m.t === 'start', 500); onlyOne = true; } catch (e) {}
  ok(!onlyOne, 'still no start with only one player ready');
  B.send({ t: 'ready' });

  // both should receive the authoritative start + the centred, live ball
  const aStart = await A.waitFor((m) => m.t === 'start');
  ok(aStart.p1 === 'Ann' && aStart.p2 === 'Bob', 'start carries both names');
  await B.waitFor((m) => m.t === 'start');
  const ball0 = await A.waitFor((m) => m.t === 'ball');
  ok(Math.abs(ball0.x) < 0.5 && Math.abs(ball0.z) < 0.5, 'match opens with the ball on the centre spot');

  console.log('Free play: either player may kick (no turns)');
  // Seat 2 (Bob) attacks the LEFT goal (-x). In free play he can kick whenever.
  B.send({ t: 'kick', vx: -26, vy: 6, vz: 0 });
  const bKick = await B.waitFor((m) => m.t === 'evt' && m.k === 'kick');
  ok(bKick.by === 2, 'player 2 may kick at any time (no turn gating)');
  let sawNeg = false;
  for (let i = 0; i < 14; i++) { const b = await B.waitFor((m) => m.t === 'ball'); if (b.x < -3) { sawNeg = true; break; } }
  ok(sawNeg, 'the ball travels the way player 2 kicked it (-x)');

  console.log('Player 2 scores in the left goal');
  const g2 = await B.waitFor((m) => m.t === 'evt' && m.k === 'goal', 6000);
  ok(g2.by === 2 && g2.side === 'left', 'goal credited to player 2 in the left goal');
  const sc2 = await B.waitFor((m) => m.t === 'state' && m.s2 >= 1);
  ok(sc2.s2 === 1, 'player 2 score is now 1');

  console.log('Ball resets to centre after a goal');
  // A's message queue still holds every ball frame from B's shot (centre -> net),
  // so first consume through the ball sitting in the left goal mouth (x < -20)...
  let sawInNet = false;
  for (let i = 0; i < 60; i++) { const b = await A.waitFor((m) => m.t === 'ball', 4000); if (b.x < -20) { sawInNet = true; break; } }
  ok(sawInNet, 'the scored ball is seen in the left goal mouth');
  // ...then the server holds briefly (client flashes "GOAL!") and the next ball
  // frames put it back on the centre spot.
  let recentred = false;
  for (let i = 0; i < 15; i++) { const b = await A.waitFor((m) => m.t === 'ball', 4000); if (Math.abs(b.x) < 0.5 && Math.abs(b.z) < 0.5) { recentred = true; break; } }
  ok(recentred, 'ball returns to the centre spot after the goal');

  console.log('Player 1 can also score (shared ball, both attack)');
  // Seat 1 (Ann) attacks the RIGHT goal (+x).
  A.send({ t: 'kick', vx: 26, vy: 6, vz: 0 });
  const g1 = await A.waitFor((m) => m.t === 'evt' && m.k === 'goal' && m.by === 1, 6000);
  ok(g1.side === 'right', 'goal credited to player 1 in the right goal');
  const scored = await A.waitFor((m) => m.t === 'state' && m.s1 >= 1);
  ok(scored.s1 === 1, 'player 1 score is now 1');

  console.log('Reconnect by token');
  A.close();
  await sleep(150);
  const A2 = client('A2'); await A2.open();
  A2.send({ type: 'join', code: 'GOAL1', name: 'Ann', token });
  const rj = await A2.waitFor((m) => m.type === 'joined');
  ok(rj.reconnect === true && rj.role === 1, 'reconnect reclaims seat 1');
  const resync = await A2.waitFor((m) => m.t === 'resync');
  ok(resync.st && resync.st.s1 === 1, 'resync restores the live score');

  console.log('Room full');
  const C = client('C'); await C.open();
  C.send({ type: 'join', code: 'GOAL1', name: 'Cara' });
  const full = await C.waitFor((m) => m.type === 'room-full' || m.type === 'joined');
  ok(full.type === 'room-full', 'third player is rejected as room-full');

  console.log('\nAll ' + passed + ' checks passed.');
  process.exit(0);
}

main().catch((e) => { console.error('\nTEST FAILED:', e && e.message); process.exit(1); });
