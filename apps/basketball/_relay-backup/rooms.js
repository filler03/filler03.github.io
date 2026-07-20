'use strict';

// Rooms: a generic, game-agnostic matchmaking + relay layer.
//
// Clients send  { type: 'join', code, name, token? }  to enter a room.
// Everything else a client sends is relayed verbatim to the other member(s)
// of its room -- the server never inspects gameplay messages. That is what
// makes this reusable for any two-player game: swap out the client, keep this.
//
// Message vocabulary the server SENDS (all carry a `type` field):
//   joined            you are in     { role, roomCode, token, opponent, reconnect }
//   peer-joined       opponent came  { name }
//   peer-disconnected opponent dropped (may return within the grace window)
//   peer-reconnected  opponent came back { name }
//   peer-left         opponent gone for good (grace expired)
//   room-full         the code already has the max players
//   error             bad request    { reason }
//
// Gameplay messages between peers use a `t` field instead, so the two never
// collide.

const crypto = require('crypto');

function randomToken() {
  return crypto.randomBytes(9).toString('base64url');
}

function normCode(code) {
  return String(code == null ? '' : code).trim().toUpperCase();
}

function normName(name) {
  return String(name == null ? '' : name).trim().slice(0, 20);
}

function ctrl(conn, obj) {
  if (conn && conn.alive) conn.send(JSON.stringify(obj));
}

class Rooms {
  constructor(opts) {
    opts = opts || {};
    this.max = opts.max || 2;
    this.graceMs = opts.graceMs == null ? 45000 : opts.graceMs;
    this.log = opts.log || (() => {});
    this.rooms = new Map(); // code -> room
    this.conns = new Set(); // all live connections (for heartbeat)
  }

  count() {
    return this.rooms.size;
  }

  attach(conn) {
    this.conns.add(conn);
    conn._alive = true;
    conn.on('pong', () => { conn._alive = true; });
    conn.on('message', (m) => {
      if (typeof m === 'string') this._handleMessage(conn, m);
    });
    conn.on('close', () => {
      this.conns.delete(conn);
      this._handleClose(conn);
    });
  }

  // Called on a timer by the server to drop dead connections.
  heartbeat() {
    for (const conn of this.conns) {
      if (conn._alive === false) {
        conn.close();
        this.conns.delete(conn);
        continue;
      }
      conn._alive = false;
      conn.ping();
    }
  }

  _newRoom(code) {
    return {
      code,
      seats: new Array(this.max).fill(null), // seat[i] = member for role i+1
      graceTimers: new Map(), // seatIndex -> timeout
    };
  }

  _peerOf(room, idx) {
    for (let i = 0; i < room.seats.length; i++) {
      if (i !== idx && room.seats[i]) return room.seats[i];
    }
    return null;
  }

  _opponentName(room, idx) {
    const peer = this._peerOf(room, idx);
    return peer ? peer.name : null;
  }

  _clearGrace(room, idx) {
    const t = room.graceTimers.get(idx);
    if (t) {
      clearTimeout(t);
      room.graceTimers.delete(idx);
    }
  }

  _handleMessage(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return; // ignore non-JSON
    }
    if (msg && msg.type === 'join') {
      this._join(conn, msg);
      return;
    }
    this._relay(conn, raw);
  }

  _join(conn, msg) {
    const code = normCode(msg.code);
    if (!code) {
      ctrl(conn, { type: 'error', reason: 'Enter a room code to play.' });
      return;
    }
    if (code.length > 12) {
      ctrl(conn, { type: 'error', reason: 'Room codes are 12 characters or fewer.' });
      return;
    }

    let room = this.rooms.get(code);
    if (!room) {
      room = this._newRoom(code);
      this.rooms.set(code, room);
    }

    // Reconnect: a matching token reclaims its old seat.
    if (msg.token) {
      const idx = room.seats.findIndex((s) => s && s.token === msg.token);
      if (idx >= 0) {
        const seat = room.seats[idx];
        this._clearGrace(room, idx);
        if (seat.conn && seat.conn !== conn) {
          try { seat.conn.close(); } catch (e) {}
        }
        seat.conn = conn;
        if (normName(msg.name)) seat.name = normName(msg.name);
        conn.roomCode = code;
        conn.role = idx + 1;
        ctrl(conn, {
          type: 'joined',
          role: idx + 1,
          roomCode: code,
          token: seat.token,
          opponent: this._opponentName(room, idx),
          reconnect: true,
        });
        const peer = this._peerOf(room, idx);
        if (peer) ctrl(peer.conn, { type: 'peer-reconnected', name: seat.name });
        this.log('reconnect', code, 'role', idx + 1);
        return;
      }
      // Token didn't match (room recycled). Fall through to a fresh join.
    }

    // Fresh join: take the first empty seat.
    const idx = room.seats.findIndex((s) => s === null);
    if (idx < 0) {
      ctrl(conn, { type: 'room-full' });
      return;
    }

    const token = randomToken();
    const seat = {
      conn,
      role: idx + 1,
      name: normName(msg.name) || 'Player ' + (idx + 1),
      token,
    };
    room.seats[idx] = seat;
    conn.roomCode = code;
    conn.role = idx + 1;

    ctrl(conn, {
      type: 'joined',
      role: idx + 1,
      roomCode: code,
      token,
      opponent: this._opponentName(room, idx),
      reconnect: false,
    });

    const peer = this._peerOf(room, idx);
    if (peer) ctrl(peer.conn, { type: 'peer-joined', name: seat.name });

    this.log('join', code, 'role', idx + 1, 'name', seat.name);
  }

  _relay(conn, raw) {
    const code = conn.roomCode;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    for (const seat of room.seats) {
      if (seat && seat.conn && seat.conn !== conn) seat.conn.send(raw);
    }
  }

  _handleClose(conn) {
    const code = conn.roomCode;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    const idx = (conn.role || 0) - 1;
    if (idx < 0) return;
    const seat = room.seats[idx];
    if (!seat || seat.conn !== conn) return; // stale close (already replaced)

    seat.conn = null; // reserve the seat during the grace window

    const peer = this._peerOf(room, idx);
    if (peer) ctrl(peer.conn, { type: 'peer-disconnected' });

    this.log('disconnect', code, 'role', idx + 1, '(grace', this.graceMs + 'ms)');

    const timer = setTimeout(() => {
      room.graceTimers.delete(idx);
      room.seats[idx] = null;
      const p = this._peerOf(room, idx);
      if (p) ctrl(p.conn, { type: 'peer-left' });
      if (room.seats.every((s) => s === null)) {
        this.rooms.delete(code);
        this.log('room closed', code);
      }
    }, this.graceMs);
    if (timer.unref) timer.unref();
    room.graceTimers.set(idx, timer);
  }
}

module.exports = Rooms;
