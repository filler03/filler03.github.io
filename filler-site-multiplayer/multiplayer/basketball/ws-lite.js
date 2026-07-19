'use strict';

// ws-lite: a tiny, dependency-free WebSocket server.
//
// It handles exactly what a browser client needs for a JSON relay:
//   - the RFC 6455 upgrade handshake
//   - reading masked text frames (browsers always mask)
//   - reassembling fragmented frames and frames split across TCP reads
//   - ping/pong (for liveness) and close
//   - writing unmasked text / ping / pong / close frames
//
// It deliberately does NOT implement extensions (no permessage-deflate),
// since we never negotiate them, so clients send uncompressed frames.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 4 * 1024 * 1024; // hard cap to avoid abuse (4 MB)

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class Conn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.alive = true; // can we still send frames?
    this._emittedClose = false; // have we fired the 'close' event yet?
    this._buf = Buffer.alloc(0);
    this._fragOp = null;
    this._frags = [];

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onSocketClose());
    socket.on('error', () => { /* surfaced via 'close' */ });
  }

  _onSocketClose() {
    if (this._emittedClose) return;
    this._emittedClose = true;
    this.alive = false;
    this.emit('close');
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    try {
      this._parse();
    } catch (err) {
      // Malformed frame: close the connection cleanly.
      this.close(1002);
    }
  }

  _parse() {
    while (true) {
      const buf = this._buf;
      if (buf.length < 2) return;

      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const hi = buf.readUInt32BE(2);
        const lo = buf.readUInt32BE(6);
        len = hi * 0x100000000 + lo;
        offset = 10;
      }

      if (len > MAX_PAYLOAD) {
        this.close(1009); // message too big
        return;
      }

      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buf.length < offset + len) return; // wait for the rest of the payload

      let payload = buf.subarray(offset, offset + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload); // copy out of the shared buffer
      }

      this._buf = buf.subarray(offset + len);
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_CLOSE:
        this.close();
        return;
      case OP_PING:
        this._send(OP_PONG, payload);
        return;
      case OP_PONG:
        this.emit('pong');
        return;
      case OP_CONT:
        if (this._fragOp === null) return; // stray continuation, ignore
        this._frags.push(payload);
        if (fin) {
          const full = Buffer.concat(this._frags);
          const op = this._fragOp;
          this._frags = [];
          this._fragOp = null;
          this._deliver(op, full);
        }
        return;
      case OP_TEXT:
      case OP_BIN:
        if (!fin) {
          this._fragOp = opcode;
          this._frags = [payload];
          return;
        }
        this._deliver(opcode, payload);
        return;
      default:
        return; // unknown opcode, ignore
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP_TEXT) {
      this.emit('message', payload.toString('utf8'));
    } else {
      this.emit('message', payload); // binary (unused by this app)
    }
  }

  _send(opcode, data) {
    if (!this.alive) return;
    if (!Buffer.isBuffer(data)) data = Buffer.from(data || '');
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode; // FIN set, no mask (server frames are never masked)
    try {
      this.socket.write(Buffer.concat([header, data]));
    } catch (err) {
      this.alive = false;
    }
  }

  send(str) {
    this._send(OP_TEXT, Buffer.from(String(str), 'utf8'));
  }

  ping() {
    this._send(OP_PING, Buffer.alloc(0));
  }

  close(code) {
    if (this.alive) {
      let payload = Buffer.alloc(0);
      if (code) {
        payload = Buffer.allocUnsafe(2);
        payload.writeUInt16BE(code, 0);
      }
      this._send(OP_CLOSE, payload);
      this.alive = false;
      try { this.socket.end(); } catch (e) {}
    }
    // Guarantee the socket dies (and therefore 'close' fires) even if the peer
    // never replies to our close frame.
    setTimeout(() => { try { this.socket.destroy(); } catch (e) {} }, 1000).unref();
  }
}

// Completes the handshake on an HTTP `upgrade` event and hands back a Conn.
function handleUpgrade(req, socket, head, cb) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (!key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + acceptKey(key),
    '\r\n',
  ].join('\r\n');

  socket.write(responseHeaders);

  const conn = new Conn(socket);
  if (head && head.length) conn._onData(head); // any bytes read past the headers
  cb(conn);
}

module.exports = { handleUpgrade };
