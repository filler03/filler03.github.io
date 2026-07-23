'use strict';

// One process does two jobs:
//   1. serves the game (the static files in ./public)
//   2. runs the authoritative match(es) and streams them to both players
//
// Because both live behind the same origin/port, there is no cross-origin or
// mixed-content problem: an https page gets a wss socket automatically.
//
// Deploy note: put this behind nginx with the WebSocket upgrade headers
// (see README.md). Run it under pm2 like the other bots.

const http = require('http');
const fs = require('fs');
const path = require('path');
const wslite = require('./ws-lite');
const Rooms = require('./rooms');

const PORT = process.env.PORT || 3200;
// Bind to localhost by default: only the reverse proxy (nginx, same machine) can
// reach it. Set HOST=0.0.0.0 to expose it directly (e.g. running without a proxy).
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const rooms = new Rooms({
  graceMs: 120000, // hold the seat (and the running match) for 2 min across a reload
  log: (...args) => console.log('[rooms]', ...args),
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function safeJoin(base, requestPath) {
  let p = requestPath.split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch (e) { /* keep raw */ }
  const resolved = path.join(base, path.normalize(p));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];

  // Health check (works whether or not nginx strips the path prefix).
  if (pathname === '/health' || pathname.endsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.count(), uptime: Math.round(process.uptime()) }));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  const target = safeJoin(PUBLIC_DIR, pathname);

  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (!err && stat.isFile()) {
      sendFile(res, target);
      return;
    }
    // Anything that isn't a real file (including '/', directories, or a
    // reverse-proxy path prefix) falls back to the game itself.
    sendFile(res, indexPath);
  });
});

server.on('upgrade', (req, socket, head) => {
  const pathname = req.url.split('?')[0];
  if (pathname !== '/ws' && !pathname.endsWith('/ws')) {
    socket.destroy();
    return;
  }
  wslite.handleUpgrade(req, socket, head, (conn) => rooms.attach(conn));
});

// Drop dead sockets (and trigger the reconnect grace window) roughly every 25s.
const heartbeat = setInterval(() => rooms.heartbeat(), 25000);
if (heartbeat.unref) heartbeat.unref();

// Physics tick: step every active match ~60x/sec. Each match uses a capped,
// frame-based sim internally, so a little jitter in this interval is fine.
let lastTick = Date.now();
const tick = setInterval(() => {
  const t = Date.now();
  const dt = t - lastTick;
  lastTick = t;
  const list = rooms.matches();
  for (let i = 0; i < list.length; i++) list[i].step(dt);
}, 1000 / 60);
if (tick.unref) tick.unref();

server.listen(PORT, HOST, () => {
  console.log('Soccer multiplayer server listening on ' + HOST + ':' + PORT);
  console.log('Serving ' + PUBLIC_DIR);
});
