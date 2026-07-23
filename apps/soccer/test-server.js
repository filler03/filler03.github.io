'use strict';

// End-to-end test of the soccer multiplayer server: HTTP health, the WebSocket
// join/lobby handshake, an authoritative kick that scores a goal, turn ownership,
// reconnect-by-token, and room-full rejection. Uses Node's built-in global
// WebSocket client (Node >= 21), so there is nothing to install.
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

async function main() {
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
  A.send({ t: 'setup', o: { speed: 1.0, kickClock: 12, halfLength: 120, bounce: 0.7 } });

  const B = client('B'); await B.open();
  B.send({ type: 'join', code: 'GOAL1', name: 'Bob' });
  const bJoined = await B.waitFor((m) => m.type === 'joined');
  ok(bJoined.role === 2, 'second client is seat 2');

  // both should receive the authoritative start + a turn + a ball
  const aStart = await A.waitFor((m) => m.t === 'start');
  ok(aStart.p1 === 'Ann' && aStart.p2 === 'Bob', 'start carries both names');
  await B.waitFor((m) => m.t === 'start');
  const turn = await A.waitFor((m) => m.t === 'turn');
  ok(turn.cp === 1, 'player 1 kicks off');
  await A.waitFor((m) => m.t === 'ball');

  console.log('Authoritative turn ownership');
  // B is NOT allowed to kick (not their turn): server must ignore it.
  B.send({ t: 'kick', vx: 24, vy: 6, vz: 0 });
  await sleep(400);
  ok(!B.seen((m) => m.t === 'evt' && m.k === 'goal'), 'off-turn kick produces no goal');
  const st0 = await A.waitFor((m) => m.t === 'state');
  ok(st0.s1 === 0 && st0.s2 === 0, 'score still 0-0 after off-turn kick');

  console.log('A scores a goal');
  // A (seat 1) attacks the RIGHT goal at +x. Kick straight down the pitch.
  A.send({ t: 'kick', vx: 24, vy: 6, vz: 0 });
  const kickEvt = await A.waitFor((m) => m.t === 'evt' && m.k === 'kick');
  ok(kickEvt.by === 1, 'kick event attributed to player 1');
  // ball should travel toward +x
  let sawForward = false;
  for (let i = 0; i < 12; i++) { const b = await A.waitFor((m) => m.t === 'ball'); if (b.x > 3) { sawForward = true; break; } }
  ok(sawForward, 'ball travels toward the target goal (+x)');
  const goal = await A.waitFor((m) => m.t === 'evt' && m.k === 'goal', 5000);
  ok(goal.by === 1 && goal.side === 'right', 'goal credited to player 1 in the right goal');
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
