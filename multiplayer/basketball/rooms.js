'use strict';

// Matchmaking + match lifecycle for the server-authoritative version.
//
// Clients send  { type: 'join', code, name, token? }  to enter a room. Once both
// seats are filled, seat 1 sends { t:'start', o } and the server creates a Match
// (game.js) that runs the physics and streams ball/state/events to BOTH players.
//
// Disconnects PAUSE the match and hold the seat for a grace window, so a player
// can close the tab and reopen (with their saved token) and drop back into the
// live game. When the grace expires the seat is freed and the match ends.

const crypto = require('crypto');
const { Match } = require('./game');

function randomToken() { return crypto.randomBytes(9).toString('base64url'); }
function normCode(code) { return String(code == null ? '' : code).trim().toUpperCase(); }
function normName(name) { return String(name == null ? '' : name).trim().slice(0, 20); }
function ctrl(conn, obj) { if (conn && conn.alive) conn.send(JSON.stringify(obj)); }

class Rooms {
  constructor(opts) {
    opts = opts || {};
    this.max = 2;
    this.graceMs = opts.graceMs == null ? 120000 : opts.graceMs; // 2 min: room to close & reopen
    this.log = opts.log || function () {};
    this.rooms = new Map();   // code -> room
    this.conns = new Set();   // live connections (heartbeat)
  }

  count() { return this.rooms.size; }

  // Active matches, for the server's physics tick.
  matches() {
    const out = [];
    for (const room of this.rooms.values()) if (room.match) out.push(room.match);
    return out;
  }

  attach(conn) {
    this.conns.add(conn);
    conn._alive = true;
    conn.on('pong', () => { conn._alive = true; });
    conn.on('message', (m) => { if (typeof m === 'string') this._handleMessage(conn, m); });
    conn.on('close', () => { this.conns.delete(conn); this._handleClose(conn); });
  }

  heartbeat() {
    for (const conn of this.conns) {
      if (conn._alive === false) { conn.close(); this.conns.delete(conn); continue; }
      conn._alive = false; conn.ping();
    }
  }

  _newRoom(code) { return { code, seats: [null, null], graceTimers: new Map(), match: null }; }
  _peerOf(room, idx) { for (let i = 0; i < room.seats.length; i++) if (i !== idx && room.seats[i]) return room.seats[i]; return null; }
  _opponentName(room, idx) { const p = this._peerOf(room, idx); return p ? p.name : null; }
  _clearGrace(room, idx) { const t = room.graceTimers.get(idx); if (t) { clearTimeout(t); room.graceTimers.delete(idx); } }
  _broadcast(room, raw) { for (const s of room.seats) if (s && s.conn) s.conn.send(raw); }
  _sender(room) { const self = this; return function (msg) { self._broadcast(room, JSON.stringify(msg)); }; }

  _handleMessage(conn, raw) {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg) return;
    if (msg.type === 'join') { this._join(conn, msg); return; }

    const code = conn.roomCode;
    const room = code ? this.rooms.get(code) : null;
    if (!room) return;
    const role = conn.role;

    // Seat 1 sends its chosen options (on entering the lobby and on any change).
    // We store them and try to start — the actual start fires from _maybeStart the
    // moment BOTH seats are filled, so it never depends on a fragile client echo.
    if (msg.t === 'setup' || msg.t === 'start') {
      if (role === 1) { if (msg.o) room.options = msg.o; this._maybeStart(room); }
      return;
    }
    if (msg.t === 'leave') { this._leave(conn); return; }
    if (!room.match) return;
    if (msg.t === 'shot') { room.match.applyShot(role, Number(msg.vx), Number(msg.vy)); return; }
    if (msg.t === 'rematch') { room.match.rematch(); return; }
  }

  // Start the match as soon as both seats are occupied and there isn't one yet.
  // Works no matter how the seats got filled (fresh joins, reconnects, either
  // order), so a stale reconnect can't leave a host stuck on "waiting".
  _maybeStart(room) {
    if (!room || room.match) return;
    if (!(room.seats[0] && room.seats[1])) return;
    room.match = new Match(room.options || {}, room.seats[0].name, room.seats[1].name, this._sender(room));
    room.match.start();
    this.log('match start', room.code);
  }

  _join(conn, msg) {
    const code = normCode(msg.code);
    if (!code) { ctrl(conn, { type: 'error', reason: 'Enter a room code to play.' }); return; }
    if (code.length > 12) { ctrl(conn, { type: 'error', reason: 'Room codes are 12 characters or fewer.' }); return; }

    let room = this.rooms.get(code);
    if (!room) { room = this._newRoom(code); this.rooms.set(code, room); }

    // Reconnect: a matching token reclaims its seat and resumes the match.
    if (msg.token) {
      const idx = room.seats.findIndex((s) => s && s.token === msg.token);
      if (idx >= 0) {
        const seat = room.seats[idx];
        this._clearGrace(room, idx);
        if (seat.conn && seat.conn !== conn) { try { seat.conn.close(); } catch (e) {} }
        seat.conn = conn;
        if (normName(msg.name)) seat.name = normName(msg.name);
        conn.roomCode = code; conn.role = idx + 1;
        ctrl(conn, {
          type: 'joined', role: idx + 1, roomCode: code, token: seat.token,
          opponent: this._opponentName(room, idx), reconnect: true, match: !!room.match
        });
        // The opponent was never told this player left, so there's nothing to
        // un-tell. Mark them present and resync *only* the returning player.
        if (room.match) {
          room.match.names[idx + 1] = seat.name;
          room.match.onReconnect(idx + 1);
          ctrl(conn, room.match.resyncPayload());
        } else {
          this._maybeStart(room);   // both seats present again, no match yet -> begin
        }
        this.log('reconnect', code, 'role', idx + 1);
        return;
      }
      // token no longer valid (seat expired) -> fall through to a fresh join
    }

    const empty = room.seats.findIndex((s) => s === null);
    if (empty < 0) { ctrl(conn, { type: 'room-full' }); return; }

    const token = randomToken();
    const seat = { conn, role: empty + 1, name: normName(msg.name) || ('Player ' + (empty + 1)), token };
    room.seats[empty] = seat;
    conn.roomCode = code; conn.role = empty + 1;
    ctrl(conn, { type: 'joined', role: empty + 1, roomCode: code, token, opponent: this._opponentName(room, empty), reconnect: false, match: !!room.match });
    const peer = this._peerOf(room, empty);
    if (peer) ctrl(peer.conn, { type: 'peer-joined', name: seat.name });
    this.log('join', code, 'role', empty + 1, seat.name);
    this._maybeStart(room);   // if that filled both seats, start now (host's echo not required)
  }

  _handleClose(conn) {
    const code = conn.roomCode; if (!code) return;
    const room = this.rooms.get(code); if (!room) return;
    const idx = (conn.role || 0) - 1; if (idx < 0) return;
    const seat = room.seats[idx]; if (!seat || seat.conn !== conn) return;

    seat.conn = null;
    // Keep the match running. If it becomes this player's turn while they're gone,
    // the clocks hold for them (game.js). The opponent is deliberately NOT notified
    // — from their side the game just continues.
    if (room.match) room.match.onDisconnect(idx + 1);
    this.log('disconnect', code, 'role', idx + 1, '(grace', this.graceMs + 'ms, silent)');

    const self = this;
    const timer = setTimeout(function () {
      room.graceTimers.delete(idx);
      room.seats[idx] = null;
      const p = self._peerOf(room, idx);
      if (p) ctrl(p.conn, { type: 'peer-left' });
      self._endMatch(room);
      self._maybeCloseRoom(room);
    }, this.graceMs);
    if (timer.unref) timer.unref();
    room.graceTimers.set(idx, timer);
  }

  _leave(conn) {
    const code = conn.roomCode; if (!code) return;
    const room = this.rooms.get(code); if (!room) return;
    const idx = (conn.role || 0) - 1; if (idx < 0) return;
    this._clearGrace(room, idx);
    room.seats[idx] = null;
    conn.roomCode = null; conn.role = 0;
    const peer = this._peerOf(room, idx);
    if (peer) ctrl(peer.conn, { type: 'peer-left' });
    this._endMatch(room);
    this._maybeCloseRoom(room);
    this.log('leave', code, 'role', idx + 1);
  }

  _endMatch(room) {
    // If anyone is gone for good, stop simulating.
    if (room.match && room.seats.some((s) => s === null)) {
      room.match.destroy(); room.match = null;
    }
  }
  _maybeCloseRoom(room) {
    if (room.seats.every((s) => s === null)) {
      if (room.match) { room.match.destroy(); room.match = null; }
      for (const t of room.graceTimers.values()) clearTimeout(t);
      room.graceTimers.clear();
      this.rooms.delete(room.code);
      this.log('room closed', room.code);
    }
  }
}

module.exports = Rooms;
