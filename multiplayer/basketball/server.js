'use strict';

// One process does two jobs:
//   1. serves the game (the static files in ./public)
//   2. relays WebSocket traffic between the two players in a room
//
// Because both live behind the same origin/port, there is no cross-origin
// or mixed-content problem: an https page gets a wss socket automatically.
//
// Deploy note: put this behind nginx with the WebSocket upgrade headers
// (see README.md). Run it under pm2 like the other bots.

const http = require('http');
const fs = require('fs');
const path = require('path');
const wslite = require('./ws-lite');
const Rooms = require('./rooms');

const PORT = process.env.PORT || 3100;
const PUBLIC_DIR = path.join(__dirname, 'public');

const rooms = new Rooms({
  max: 2,
  graceMs: 45000, // keep a seat warm this long after a drop, for reconnects
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
  // Strip query, decode, normalize, and confine to PUBLIC_DIR.
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
  // Accept the socket regardless of any proxy path prefix, as long as it ends in /ws.
  if (pathname !== '/ws' && !pathname.endsWith('/ws')) {
    socket.destroy();
    return;
  }
  wslite.handleUpgrade(req, socket, head, (conn) => rooms.attach(conn));
});

// Drop dead sockets (and trigger the reconnect grace window) roughly every 25s.
const heartbeat = setInterval(() => rooms.heartbeat(), 25000);
if (heartbeat.unref) heartbeat.unref();

server.listen(PORT, () => {
  console.log('Basketball multiplayer server listening on port ' + PORT);
  console.log('Serving ' + PUBLIC_DIR);
});
