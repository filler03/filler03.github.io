'use strict';

// End-to-end test of the server-authoritative version: HTTP, matchmaking, the
// server-run simulation (start -> ball drops -> shoot), and disconnect/reconnect
// with resume + leave. Uses Node's built-in WebSocket client.
//
// Run: node test-server.js   (exits 0 on success, 1 on failure)

const { spawn } = require('child_process');
const http = require('http');

const PORT = 39217;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';

let passed = 0, failed = 0;
function ok(n) { passed++; console.log('  \u2713 ' + n); }
function bad(n, d) { failed++; console.log('  \u2717 ' + n + (d ? ' -- ' + d : '')); }
function assert(c, n, d) { c ? ok(n) : bad(n, d); }

function httpGet(path) {
  return new Promise((res, rej) => {
    http.get(BASE + path, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', rej);
  });
}

class Client {
  constructor() {
    this.ws = new WebSocket(WS);
    this.queue = []; this.waiters = [];
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { m = { raw: ev.data }; }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(m); }
      else this.queue.push(m);
    });
  }
  open() { return new Promise((res, rej) => { this.ws.addEventListener('open', () => res()); this.ws.addEventListener('error', () => rej(new Error('ws error'))); }); }
  send(o) { this.ws.send(JSON.stringify(o)); }
  waitFor(pred, ms = 2000) {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { const k = this.waiters.findIndex((w) => w.timer === timer); if (k >= 0) this.waiters.splice(k, 1); rej(new Error('timeout')); }, ms);
      this.waiters.push({ pred, resolve: res, timer });
    });
  }
  gotNothing(ms = 300) { return new Promise((res) => setTimeout(() => res(this.queue.length === 0), ms)); }
  close() { try { this.ws.close(); } catch (e) {} }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('HTTP:');
  const root = await httpGet('/');
  assert(root.status === 200 && /text\/html/.test(root.headers['content-type'] || ''), 'GET / serves html');
  const health = await httpGet('/health');
  let hj = {}; try { hj = JSON.parse(health.body); } catch (e) {}
  assert(health.status === 200 && hj.ok === true, 'GET /health ok');
  const man = await httpGet('/manifest.webmanifest');
  assert(man.status === 200, 'manifest served');

  console.log('Matchmaking:');
  const a = new Client(); await a.open();
  a.send({ type: 'join', code: 'test', name: 'Alice' });
  const aj = await a.waitFor((m) => m.type === 'joined');
  assert(aj.role === 1 && aj.roomCode === 'TEST', 'first joiner is role 1, code normalized');
  const aToken = aj.token;
  // Host publishes settings up front (as the real client does on entering the lobby).
  a.send({ t: 'setup', o: { speed: 1.2, shotClock: 10, halfLength: 60, bounce: 0.7 } });

  const b = new Client(); await b.open();
  b.send({ type: 'join', code: 'TEST', name: 'Bob' });
  const bj = await b.waitFor((m) => m.type === 'joined');
  assert(bj.role === 2 && bj.opponent === 'Alice', 'second joiner is role 2, sees opponent');
  const bToken = bj.token;
  const apj = await a.waitFor((m) => m.type === 'peer-joined');
  assert(apj.name === 'Bob', 'host told opponent joined');

  console.log('Auto-start (no explicit start needed):');
  // Neither client sends a "start" — the server begins the match on its own the
  // moment both seats are filled. This is what prevents a host stuck on "waiting".
  const aStart = await a.waitFor((m) => m.t === 'start', 3000);
  const bStart = await b.waitFor((m) => m.t === 'start', 3000);
  assert(aStart.p1 === 'Alice' && aStart.p2 === 'Bob', 'both receive start with names');
  assert(bStart.o && bStart.o.shotClock === 10, "host's options were used, not defaults");
  const ball1 = await b.waitFor((m) => m.t === 'ball', 3000);
  assert(typeof ball1.x === 'number' && typeof ball1.y === 'number', 'server streams ball position');

  // Ball drops and settles; then it's player 1's turn (grounded, not waiting).
  const grounded = await a.waitFor((m) => m.t === 'state' && m.gr === 1 && m.cp === 1 && m.wn === 0, 10000);
  assert(!!grounded, 'ball settles and it is P1 turn');

  // P1 shoots; server registers it (shot event + shots incremented).
  a.send({ t: 'shot', vx: 22, vy: -34 });
  const shotEvt = await a.waitFor((m) => m.t === 'evt' && m.k === 'shot', 2000);
  assert(!!shotEvt, 'server accepts the shot and broadcasts it');
  const afterShot = await a.waitFor((m) => m.t === 'state' && m.h1 >= 1, 2000);
  assert(afterShot.h1 >= 1, 'shot count incremented server-side');
  // Joiner cannot shoot on P1 turn (server ignores it) -> no shot count for P2.
  b.send({ t: 'shot', vx: 10, vy: -10 });
  await wait(200);
  const st2 = await a.waitFor((m) => m.t === 'state', 2000);
  assert(st2.h2 === 0, 'out-of-turn shot from joiner is ignored');

  console.log('Room full + bad code:');
  const c = new Client(); await c.open();
  c.send({ type: 'join', code: 'TEST', name: 'Carol' });
  const full = await c.waitFor((m) => m.type === 'room-full');
  assert(full.type === 'room-full', 'third player rejected'); c.close();
  const d = new Client(); await d.open();
  d.send({ type: 'join', code: '  ', name: 'Dan' });
  const err = await d.waitFor((m) => m.type === 'error');
  assert(/code/i.test(err.reason || ''), 'empty code errors'); d.close();

  console.log('Disconnect is silent for the opponent:');
  // Drain A's queue so we can prove nothing new of note arrives.
  a.queue.length = 0;
  b.close();
  // A must NOT be told the opponent dropped...
  let toldDropped = false;
  try { await a.waitFor((m) => m.type === 'peer-disconnected', 800); toldDropped = true; } catch (e) {}
  assert(!toldDropped, 'opponent is NOT notified of the drop');
  // ...and A's game keeps running (state heartbeats keep arriving).
  const stillLive = await a.waitFor((m) => m.t === 'state', 2000);
  assert(!!stillLive, 'match keeps streaming to the remaining player');

  console.log('Silent reconnect resyncs only the returning player:');
  const b2 = new Client(); await b2.open();
  a.queue.length = 0;
  b2.send({ type: 'join', code: 'TEST', name: 'Bob', token: bToken });
  const b2j = await b2.waitFor((m) => m.type === 'joined');
  assert(b2j.reconnect === true && b2j.role === 2 && b2j.match === true, 'reconnect reclaims seat, match still live');
  const resync = await b2.waitFor((m) => m.t === 'resync', 3000);
  assert(resync.st && typeof resync.st.s1 === 'number', 'returning player gets a full resync');
  let toldBack = false;
  try { await a.waitFor((m) => m.type === 'peer-reconnected', 800); toldBack = true; } catch (e) {}
  assert(!toldBack, 'opponent is NOT notified of the return either');

  console.log('Clocks hold while the CURRENT player is away:');
  // Fresh room so we control whose turn it is. After start it is always P1's turn.
  const x = new Client(); await x.open(); x.send({ type: 'join', code: 'HOLD', name: 'X' });
  await x.waitFor((m) => m.type === 'joined');
  x.send({ t: 'setup', o: { speed: 1, shotClock: 12, halfLength: 90, bounce: 0.7 } });
  const y = new Client(); await y.open(); y.send({ type: 'join', code: 'HOLD', name: 'Y' });
  const yj = await y.waitFor((m) => m.type === 'joined');
  await x.waitFor((m) => m.type === 'peer-joined');
  await y.waitFor((m) => m.t === 'start', 3000);   // auto-started when both seats filled
  await y.waitFor((m) => m.t === 'state' && m.gr === 1 && m.cp === 1 && m.wn === 0, 10000); // P1's turn, live
  // P1 (x) is the current player. Drop x; y (connected, not current) keeps watching.
  x.close();
  y.queue.length = 0;
  const s1 = await y.waitFor((m) => m.t === 'state', 2000);
  await wait(1700);
  const s2 = await y.waitFor((m) => m.t === 'state', 2000);
  assert(s2.sc === s1.sc, 'shot clock frozen while current player is away (' + s1.sc + '->' + s2.sc + ')');
  assert(s2.gt === s1.gt, 'game clock frozen while current player is away (' + s1.gt + '->' + s2.gt + ')');
  y.close();

  console.log('Frenzy mode (simultaneous, multi-ball):');
  const fa = new Client(); await fa.open();
  fa.send({ type: 'join', code: 'FRENZY', name: 'Fay' });
  await fa.waitFor((m) => m.type === 'joined');
  fa.send({ t: 'setup', o: { mode: 'frenzy', balls: 4, halfLength: 60, pointsPer: 4, bonusSecs: 10, scoreMode: 'own', speed: 1.1, bounce: 0.7 } });
  const fb = new Client(); await fb.open();
  fb.send({ type: 'join', code: 'FRENZY', name: 'Gus' });
  await fb.waitFor((m) => m.type === 'joined');
  await fa.waitFor((m) => m.type === 'peer-joined');
  const faStart = await fa.waitFor((m) => m.t === 'start', 3000);
  await fb.waitFor((m) => m.t === 'start', 3000);
  assert(faStart.o && faStart.o.mode === 'frenzy' && faStart.o.balls === 4, 'frenzy start carries mode + even ball count');
  const fballs = await fb.waitFor((m) => m.t === 'balls', 3000);
  assert(Array.isArray(fballs.b) && fballs.b.length === 4, 'server streams the 4-ball array');
  const startBalls = fballs.b.slice();

  // Grab a ball; the grabber should see it anchored (h===1).
  const target = startBalls[1];
  fa.queue.length = 0;
  fa.send({ t: 'grab', x: target.x, y: target.y });
  const heldFrame = await fa.waitFor((m) => m.t === 'balls' && m.b.some((x) => x.i === target.i && x.h === 1), 2000);
  assert(!!heldFrame, 'grab anchors the nearest ball for the grabber');

  // Opponent tries to grab the SAME (protected) ball — must fail. A heartbeat
  // balls frame (~1/s) reflects the truth: still held by 1, nobody holds it as 2.
  fb.queue.length = 0;
  fb.send({ t: 'grab', x: target.x, y: target.y });
  await wait(200);
  const chk = await fb.waitFor((m) => m.t === 'balls', 2000);
  const tb = chk.b.find((x) => x.i === target.i);
  assert(tb && tb.h === 1, 'protected ball stays with the original grabber');
  assert(!chk.b.some((x) => x.h === 2), 'opponent cannot grab a ball being aimed');

  // Shoot the held ball: shot event + shots incremented in frenzy state.
  fa.queue.length = 0;
  fa.send({ t: 'shot', i: target.i, vx: 30, vy: -35 });
  const fshot = await fa.waitFor((m) => m.t === 'evt' && m.k === 'shot' && m.i === target.i, 2000);
  assert(!!fshot, 'frenzy shot accepted for the aimed ball');
  const fstate = await fa.waitFor((m) => m.t === 'state' && m.md === 'frenzy' && m.h1 >= 1, 2000);
  assert(fstate.h1 >= 1, 'frenzy shot increments the shooter\u2019s shot count');
  fa.close(); fb.close();

  console.log('Leave ends the match:');
  a.send({ t: 'leave' });
  const left = await b2.waitFor((m) => m.type === 'peer-left', 3000);
  assert(!!left, 'remaining player told the other left');

  a.close(); b2.close();
  await wait(100);
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  return failed === 0;
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'inherit']
});
let ready = false;
child.stdout.on('data', (d) => {
  process.stdout.write('[server] ' + d);
  if (!ready && /listening on/i.test(d.toString())) {
    ready = true;
    run().then((s) => { child.kill(); process.exit(s ? 0 : 1); }).catch((e) => { console.error('TEST ERROR:', e); child.kill(); process.exit(1); });
  }
});
setTimeout(() => { if (!ready) { console.error('server did not start'); child.kill(); process.exit(1); } }, 5000);
