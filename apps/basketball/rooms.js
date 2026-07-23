'use strict';

// Matchmaking + match lifecycle for the server-authoritative version.

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
    this.graceMs = opts.graceMs == null ? 120000 : opts.graceMs;
    this.log = opts.log || function () {};
    this.rooms = new Map();
    this.conns = new Set();
  }

  count() { return this.rooms.size; }

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
  _sendLobby(room) {
    const s0 = room.seats[0], s1 = room.seats[1];
    this._broadcast(room, JSON.stringify({
      type: 'lobby',
      p1: s0 ? s0.name : null, p2: s1 ? s1.name : null,
      r1: !!(s0 && s0.ready), r2: !!(s1 && s1.ready)
    }));
  }

  _handleMessage(conn, raw) {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg) return;
    if (msg.type === 'join') { this._join(conn, msg); return; }

    const code = conn.roomCode;
    const room = code ? this.rooms.get(code) : null;
    if (!room) return;
    const role = conn.role;

    if (msg.t === 'setup' || msg.t === 'start') {
      if (role === 1) { if (msg.o) room.options = msg.o; this._maybeStart(room); }
      return;
    }
    if (msg.t === 'ready') {
      const seat = room.seats[role - 1];
      if (seat) seat.ready = (msg.v === false) ? false : true;
      this._sendLobby(room);
      this._maybeStart(room);
      return;
    }
    if (msg.t === 'leave') { this._leave(conn); return; }
    if (!room.match) return;
    if (msg.t === 'shot') { room.match.applyShot(role, Number(msg.vx), Number(msg.vy), msg.i); return; }
    if (msg.t === 'grab') { room.match.grab(role, Number(msg.x), Number(msg.y)); return; }
    if (msg.t === 'release') { room.match.release(role, msg.i); return; }
    if (msg.t === 'rematch') { room.match.rematch(); return; }
  }

  _maybeStart(room) {
    if (!room || room.match) return;
    if (!(room.seats[0] && room.seats[1])) return;
    if (!(room.seats[0].ready && room.seats[1].ready)) return;
    const self = this;
    room.match = new Match(room.options || {}, room.seats[0].name, room.seats[1].name, this._sender(room), function () { self._finishRoom(room); });
    room.match.start();
    this.log('match start', room.code);
  }

  _join(conn, msg) {
    const code = normCode(msg.code);
    if (!code) { ctrl(conn, { type: 'error', reason: 'Enter a room code to play.' }); return; }
    if (code.length > 12) { ctrl(conn, { type: 'error', reason: 'Room codes are 12 characters or fewer.' }); return; }

    let room = this.rooms.get(code);
    if (room && room.finished) { this.rooms.delete(code); room = null; }
    if (!room) { room = this._newRoom(code); this.rooms.set(code, room); }

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
        if (room.match) {
          room.match.names[idx + 1] = seat.name;
          room.match.onReconnect(idx + 1);
          ctrl(conn, room.match.resyncPayload());
        } else {
          this._sendLobby(room);
          this._maybeStart(room);
        }
        this.log('reconnect', code, 'role', idx + 1);
        return;
      }
    }

    const empty = room.seats.findIndex((s) => s === null);
    if (empty < 0) { ctrl(conn, { type: 'room-full' }); return; }

    const token = randomToken();
    const seat = { conn, role: empty + 1, name: normName(msg.name) || ('Player ' + (empty + 1)), token, ready: false };
    room.seats[empty] = seat;
    conn.roomCode = code; conn.role = empty + 1;
    ctrl(conn, { type: 'joined', role: empty + 1, roomCode: code, token, opponent: this._opponentName(room, empty), reconnect: false, match: !!room.match });
    const peer = this._peerOf(room, empty);
    if (peer) ctrl(peer.conn, { type: 'peer-joined', name: seat.name });
    this._sendLobby(room);
    this.log('join', code, 'role', empty + 1, seat.name);
    this._maybeStart(room);
  }

  _handleClose(conn) {
    const code = conn.roomCode; if (!code) return;
    const room = this.rooms.get(code); if (!room) return;
    const idx = (conn.role || 0) - 1; if (idx < 0) return;
    const seat = room.seats[idx]; if (!seat || seat.conn !== conn) return;

    seat.conn = null;
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
    if (room.match && room.seats.some((s) => s === null)) {
      room.match.destroy(); room.match = null;
    }
  }
  // The match is over: close the room so the SAME code opens a brand-new game
  // next time. Sockets stay OPEN on the game-over screen so clients can keep
  // rendering the final state, but they are detached from the room AND each
  // client is explicitly told the session has ended so it can invalidate its
  // saved reconnect token and treat any new "join" as a fresh session.
  _finishRoom(room) {
    if (!room || room.finished) return;
    room.finished = true;
    for (const s of room.seats) {
      if (s && s.conn) {
        s.conn.roomCode = null;
        s.conn.role = 0;
        try { s.conn.send(JSON.stringify({ type: 'session-ended' })); } catch (e) {}
      }
    }
    if (room.match) { room.match.destroy(); room.match = null; }
    for (const t of room.graceTimers.values()) clearTimeout(t);
    room.graceTimers.clear();
    this.rooms.delete(room.code);
    this.log('room closed (game over)', room.code);
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
