'use strict';

// End-to-end test of the server: HTTP static serving, health, and the full
// WebSocket room protocol (join, roles, relay isolation, room-full, reconnect,
// large-payload framing). Uses Node's built-in WebSocket client.
//
// Run: node test-server.js   (exits 0 on success, 1 on failure)

const { spawn } = require('child_process');
const http = require('http');

const PORT = 39217;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';

let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log('  \u2713 ' + name); }
function bad(name, detail) { failed++; console.log('  \u2717 ' + name + (detail ? ' -- ' + detail : '')); }
function assert(cond, name, detail) { cond ? ok(name) : bad(name, detail); }

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

// Thin wrapper: collect messages, allow waiting for a matching one.
class Client {
  constructor() {
    this.ws = new WebSocket(WS);
    this.queue = [];
    this.waiters = [];
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { msg = { raw: ev.data }; }
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('ws error')));
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  waitFor(pred, ms = 2000) {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('timeout waiting for message'));
      }, ms);
      this.waiters.push({ pred, resolve, timer });
    });
  }
  gotNothing(ms = 300) {
    return new Promise((resolve) => setTimeout(() => resolve(this.queue.length === 0), ms));
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // --- HTTP ---
  console.log('HTTP:');
  const root = await httpGet('/');
  assert(root.status === 200, 'GET / returns 200', 'got ' + root.status);
  assert(/text\/html/.test(root.headers['content-type'] || ''), 'GET / is html');

  const health = await httpGet('/health');
  let healthJson = {};
  try { healthJson = JSON.parse(health.body); } catch (e) {}
  assert(health.status === 200 && healthJson.ok === true, 'GET /health ok');

  const prefixed = await httpGet('/multiplayer/basketball/');
  assert(prefixed.status === 200, 'proxy-prefixed path falls back to game', 'got ' + prefixed.status);

  const traversal = await httpGet('/../server.js');
  assert(!/PORT/.test(traversal.body), 'path traversal is blocked');

  // --- WebSocket: join + roles ---
  console.log('WebSocket join + roles:');
  const a = new Client();
  await a.open();
  a.send({ type: 'join', code: 'test', name: 'Alice' });
  const aJoined = await a.waitFor((m) => m.type === 'joined');
  assert(aJoined.role === 1, 'first joiner is role 1', 'role ' + aJoined.role);
  assert(aJoined.roomCode === 'TEST', 'code is normalized to upper-case', aJoined.roomCode);
  assert(!!aJoined.token, 'first joiner gets a token');
  assert(aJoined.opponent == null, 'first joiner has no opponent yet');
  const aToken = aJoined.token;

  const b = new Client();
  await b.open();
  b.send({ type: 'join', code: 'TEST', name: 'Bob' });
  const bJoined = await b.waitFor((m) => m.type === 'joined');
  assert(bJoined.role === 2, 'second joiner is role 2', 'role ' + bJoined.role);
  assert(bJoined.opponent === 'Alice', 'second joiner sees opponent name', bJoined.opponent);
  const bToken = bJoined.token;

  const aPeer = await a.waitFor((m) => m.type === 'peer-joined');
  assert(aPeer.name === 'Bob', 'host is told the opponent joined', aPeer.name);

  // --- Relay isolation ---
  console.log('Relay:');
  a.send({ t: 'ball', x: 123, y: 45 });
  const relayed = await b.waitFor((m) => m.t === 'ball');
  assert(relayed.x === 123 && relayed.y === 45, 'game message relays to the peer');
  const aQuiet = await a.gotNothing();
  assert(aQuiet, 'sender does not receive its own relayed message');

  b.send({ t: 'shot', vx: -10, vy: -20 });
  const backRelay = await a.waitFor((m) => m.t === 'shot');
  assert(backRelay.vx === -10, 'relay works in both directions');

  // Large payload to exercise 16-bit frame length + masking.
  const big = 'x'.repeat(5000);
  a.send({ t: 'state', blob: big });
  const bigRelay = await b.waitFor((m) => m.t === 'state');
  assert(bigRelay.blob && bigRelay.blob.length === 5000, 'large (5 KB) frame relays intact');

  // --- Room full ---
  console.log('Room full:');
  const c = new Client();
  await c.open();
  c.send({ type: 'join', code: 'TEST', name: 'Carol' });
  const full = await c.waitFor((m) => m.type === 'room-full');
  assert(full.type === 'room-full', 'third player into a full room is rejected');
  c.close();

  // --- Bad code ---
  const d = new Client();
  await d.open();
  d.send({ type: 'join', code: '   ', name: 'Dan' });
  const err = await d.waitFor((m) => m.type === 'error');
  assert(/code/i.test(err.reason || ''), 'empty code returns a helpful error');
  d.close();

  // --- Disconnect + reconnect within grace ---
  console.log('Reconnect:');
  b.close();
  const aDrop = await a.waitFor((m) => m.type === 'peer-disconnected', 3000);
  assert(aDrop.type === 'peer-disconnected', 'host learns the opponent dropped');

  const b2 = new Client();
  await b2.open();
  b2.send({ type: 'join', code: 'TEST', name: 'Bob', token: bToken });
  const b2Joined = await b2.waitFor((m) => m.type === 'joined');
  assert(b2Joined.role === 2 && b2Joined.reconnect === true, 'reconnect reclaims the same seat');
  const aBack = await a.waitFor((m) => m.type === 'peer-reconnected', 3000);
  assert(aBack.name === 'Bob', 'host learns the opponent reconnected');

  a.close();
  b2.close();

  await wait(100);
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  return failed === 0;
}

// Boot the server, wait for readiness, run, then tear down.
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: ['ignore', 'pipe', 'inherit'],
});

let ready = false;
child.stdout.on('data', (d) => {
  process.stdout.write('[server] ' + d);
  if (!ready && /listening on/i.test(d.toString())) {
    ready = true;
    run()
      .then((success) => {
        child.kill();
        process.exit(success ? 0 : 1);
      })
      .catch((err) => {
        console.error('TEST ERROR:', err);
        child.kill();
        process.exit(1);
      });
  }
});

setTimeout(() => {
  if (!ready) {
    console.error('server did not start in time');
    child.kill();
    process.exit(1);
  }
}, 5000);
