'use strict';

// Server-authoritative soccer match. One Match instance per room; it runs the 3D
// ball physics for BOTH players. Clients only send kicks and render what they
// receive. The simulation is ported from the single-player browser game so the
// gameplay feel is unchanged -- the only difference is *where* it runs.
//
// The pitch plays down its long (x) axis with a goal at EACH end, facing inward.
// It is turn-based, exactly like the basketball version: the current player kicks
// the ball from midfield at their far goal, the server simulates it until it
// scores or comes to rest, then it's the other player's turn. Timed halves swap
// which goal each player attacks at the interval, and a per-turn kick clock keeps
// things moving.
//
//   World units are meters. Field: x in [-30, 30] (length), z in [-20, 20]
//   (width), y up. Left goal's mouth faces +x, right goal's faces -x.

// ---- fixed pitch geometry (must match the client scene) --------------------
var FIELD_HALF_W = 30;     // x half-extent (length)
var FIELD_HALF_D = 20;     // z half-extent (width)
var BALL_R = 0.22;

var GOAL_W = 7.32;         // FIFA goal width  (spans z here)
var GOAL_H = 2.44;         // FIFA goal height (y)
var GOAL_DEPTH = 2.0;      // how far the net box extends behind the line (x)
var GOAL_LINE = 27;        // |x| of the front posts (a little inside the walls)
var GOAL_POST_R = 0.06;
var BACK_POST_H = GOAL_H * 0.5;

// ---- physics constants (ported from the browser game) ----------------------
var GRAVITY = -9.81;
var FRICTION = 0.98;       // ground rolling friction (per substep)
var ANG_FRICTION = 0.995;  // spin decay
var WALL_BOUNCE = 0.6;
var GOAL_BOUNCE = 0.5;     // posts / crossbar
var NET_BOUNCE = 0.3;

var MAX_KICK_SPEED = 40;   // clamp against bad / malicious input (m/s)
var REST_SPEED = 0.35;     // below this (and on the ground) the ball is "at rest"
var MAX_FLIGHT_MS = 7000;  // safety: force-settle a ball still rolling after this

// How often the server streams the ball while it's moving, in ms.
// ~33ms = 30/sec; the client interpolates between updates so it looks smooth.
var BALL_SEND_MS = 33;

var COLORS = { 1: '#ff5b5b', 2: '#4a9eff' };
var DEFAULTS = { speed: 1.0, kickClock: 10, halfLength: 90, bounce: 0.7 };

// The two goals. `sign` is the direction from the goal line toward the net
// interior (and toward the wall behind it): -1 for the left goal, +1 for the
// right goal. `frontX` is the goal line; `backX` is the back net plane.
var GOALS = [
  { side: 'left', sign: -1, frontX: -GOAL_LINE, backX: -GOAL_LINE - GOAL_DEPTH },
  { side: 'right', sign: 1, frontX: GOAL_LINE, backX: GOAL_LINE + GOAL_DEPTH }
];

function now() { return Date.now(); }
function num(v, lo, hi, dflt) { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; }
function hyp3(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }
function r2(v) { return Math.round(v * 100) / 100; }

function clampKick(vx, vy, vz) {
  if (!isFinite(vx) || !isFinite(vy) || !isFinite(vz)) return null;
  var s = hyp3(vx, vy, vz);
  if (s > MAX_KICK_SPEED) { var k = MAX_KICK_SPEED / s; vx *= k; vy *= k; vz *= k; }
  if (vy < 0) vy = 0;                 // a kick can't drive the ball into the ground
  return [vx, vy, vz];
}

function sanitizeOptions(o) {
  o = o || {};
  return {
    speed: num(o.speed, 0.6, 1.8, DEFAULTS.speed),
    kickClock: Math.round(num(o.kickClock, 5, 20, DEFAULTS.kickClock)),
    halfLength: Math.round(num(o.halfLength, 30, 180, DEFAULTS.halfLength)),
    bounce: num(o.bounce, 0.4, 0.85, DEFAULTS.bounce)
  };
}

class Match {
  constructor(options, name1, name2, send) {
    this.send = send;                 // send(msgObject) -> broadcast to both players
    this.options = sanitizeOptions(options);
    this.names = { 1: name1 || 'Player 1', 2: name2 || 'Player 2' };
    this.connected = { 1: true, 2: true };
    this.lastBallSent = 0;
    this.lastHeartbeat = 0;
    this.lastTick = 0;
    this._timers = [];
    this._destroyed = false;
    this.reset();
  }

  reset() {
    this.phase = 'playing';
    this.players = { 1: { score: 0, kicks: 0 }, 2: { score: 0, kicks: 0 } };
    this.currentPlayer = 1;
    this.half = 1;
    this.sidesSwapped = false;
    this.kickClock = this.options.kickClock;
    this.gameTimer = this.options.halfLength;
    this.started = false;             // first possession begun (game clock runs after this)
    this.waitingForNextTurn = false;
    this.kickInFlight = false;
    this.scoredThisKick = false;
    this.flightStart = 0;
    this.ball = { x: 0, y: BALL_R, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, avx: 0, avy: 0, avz: 0, grounded: true };
    this.lastClock = 0;
    this.lastGameClock = 0;
  }

  _timeout(fn, ms) {
    var self = this;
    var id = setTimeout(function () {
      var i = self._timers.indexOf(id); if (i >= 0) self._timers.splice(i, 1);
      if (!self._destroyed) fn();
    }, ms);
    this._timers.push(id);
    return id;
  }
  destroy() {
    this._destroyed = true;
    for (var i = 0; i < this._timers.length; i++) clearTimeout(this._timers[i]);
    this._timers = [];
  }

  start() {
    this.reset();
    this.send({ t: 'start', o: this.options, p1: this.names[1], p2: this.names[2] });
    this.beginPossession(1, true);
  }
  rematch() {
    this.reset();
    this.send({ t: 'start', o: this.options, p1: this.names[1], p2: this.names[2] });
    this.beginPossession(1, true);
  }

  // A player's socket dropped: the match keeps running. If it's *their* turn the
  // clocks hold (see updateClocks) so they aren't penalized; the opponent is
  // never notified.
  onDisconnect(role) { this.connected[role] = false; }
  onReconnect(role) {
    this.connected[role] = true;
    var t = now();
    this.lastClock = t; this.lastGameClock = t; this.lastTick = t;
  }
  resyncPayload() {
    return { t: 'resync', o: this.options, p1: this.names[1], p2: this.names[2], st: this.stateObj(), ball: this.ballObj() };
  }

  // half 1: player 1 attacks the RIGHT goal (+x), player 2 the LEFT (-x).
  // Sides swap at halftime.
  attackSignFor(player) {
    var base = (player === 1) ? 1 : -1;
    return this.sidesSwapped ? -base : base;
  }
  // Which player is attacking a given goal right now.
  ownerOf(goal) { return this.attackSignFor(1) === goal.sign ? 1 : 2; }

  centerBall() {
    var b = this.ball;
    b.x = 0; b.y = BALL_R; b.z = 0;
    b.vx = 0; b.vy = 0; b.vz = 0;
    b.avx = 0; b.avy = 0; b.avz = 0;
    b.grounded = true;
  }

  beginPossession(player, initial) {
    this.currentPlayer = player;
    this.centerBall();
    this.kickInFlight = false;
    this.scoredThisKick = false;
    this.waitingForNextTurn = false;
    this.kickClock = this.options.kickClock;
    var t = now();
    this.lastClock = t; this.lastGameClock = t; this.lastTick = t;
    if (initial) this.started = true;
    this.sendTurn();
    this.sendState();
    this.sendBall(true);
  }

  applyKick(player, vx, vy, vz) {
    if (this._destroyed || this.phase !== 'playing') return;
    if (this.currentPlayer !== player) return;
    if (!this.ball.grounded || this.kickInFlight || this.waitingForNextTurn) return;
    var c = clampKick(vx, vy, vz); if (!c) return;
    var b = this.ball;
    b.vx = c[0]; b.vy = c[1]; b.vz = c[2];
    b.grounded = false;
    // Spin from the kick direction (cosmetic, ported feel).
    b.avx = c[2] * 0.6; b.avz = -c[0] * 0.6; b.avy = 0;
    this.kickInFlight = true;
    this.scoredThisKick = false;
    this.flightStart = now();
    this.players[player].kicks++;
    this.send({ t: 'evt', k: 'kick', by: player, c: COLORS[player] });
    this.sendState();
    this.sendBall(true);
  }

  // Called by the server loop with elapsed milliseconds since the last tick.
  step(dtMs) {
    if (this._destroyed || this.phase !== 'playing') return;
    var t = now();
    // frame-based sim with a capped dt, exactly like the browser game's loop.
    var dt = Math.min(dtMs / 1000, 0.05);
    if (this.kickInFlight) {
      this.simulate(dt);
      this.sendBall(false);
      if (this.ballAtRest()) this.onKickSettled(false);
      else if (t - this.flightStart > MAX_FLIGHT_MS) { this.ball.grounded = true; this.onKickSettled(false); }
    }
    this.updateClocks();
    if (t - this.lastHeartbeat > 1000) { this.lastHeartbeat = t; this.sendState(); }
  }

  ballAtRest() {
    var b = this.ball;
    if (!b.grounded) return false;
    return Math.abs(b.vx) < REST_SPEED && Math.abs(b.vz) < REST_SPEED && Math.abs(b.vy) < REST_SPEED;
  }

  simulate(dt) {
    var b = this.ball;
    var bounce = this.options.bounce;
    var speed = hyp3(b.vx, b.vy, b.vz);
    var maxStep = BALL_R * 0.2;
    var subSteps = Math.max(1, Math.ceil(speed * dt / maxStep));
    var sub = dt / subSteps;

    for (var s = 0; s < subSteps; s++) {
      b.vy += GRAVITY * sub;
      var prevX = b.x;
      var nx = b.x + b.vx * sub;
      var ny = b.y + b.vy * sub;
      var nz = b.z + b.vz * sub;

      // ---- ground ----
      if (ny < BALL_R) {
        ny = BALL_R;
        if (b.vy < -0.1) { b.vy = -b.vy * bounce; b.avx += b.vz * 0.5; b.avz -= b.vx * 0.5; }
        else b.vy = 0;
        b.vx *= FRICTION; b.vz *= FRICTION;
        if (Math.abs(b.vx) < 0.02) b.vx = 0;
        if (Math.abs(b.vz) < 0.02) b.vz = 0;
      }

      // ---- field walls ----
      if (nx < -FIELD_HALF_W + BALL_R) { nx = -FIELD_HALF_W + BALL_R; b.vx = Math.abs(b.vx) * WALL_BOUNCE; }
      if (nx > FIELD_HALF_W - BALL_R) { nx = FIELD_HALF_W - BALL_R; b.vx = -Math.abs(b.vx) * WALL_BOUNCE; }
      if (nz < -FIELD_HALF_D + BALL_R) { nz = -FIELD_HALF_D + BALL_R; b.vz = Math.abs(b.vz) * WALL_BOUNCE; }
      if (nz > FIELD_HALF_D - BALL_R) { nz = FIELD_HALF_D - BALL_R; b.vz = -Math.abs(b.vz) * WALL_BOUNCE; }

      // ---- goals (structure) then goal-line detection ----
      var res = { x: nx, y: ny, z: nz };
      for (var g = 0; g < GOALS.length; g++) this.collideGoal(res, GOALS[g]);
      nx = res.x; ny = res.y; nz = res.z;

      if (!this.scoredThisKick) {
        for (var g2 = 0; g2 < GOALS.length; g2++) {
          if (this.crossedLine(prevX, nx, ny, nz, GOALS[g2])) { this.onGoal(GOALS[g2]); break; }
        }
      }

      b.x = nx; b.y = ny; b.z = nz;
    }

    // spin (once per frame, matching the browser game)
    var af = Math.pow(ANG_FRICTION, dt * 60);
    b.avx *= af; b.avy *= af; b.avz *= af;
    b.rx += b.avx * dt; b.ry += b.avy * dt; b.rz += b.avz * dt;
  }

  // Resolve the ball against one goal's posts, crossbar, back frame and nets.
  // Geometry is world-space and oriented along x (mirror of the browser's
  // z-oriented goal), parameterized by the goal's sign.
  collideGoal(p, goal) {
    var b = this.ball;
    var fx = goal.frontX, bx = goal.backX, sgn = goal.sign;
    var zL = -GOAL_W / 2, zR = GOAL_W / 2;

    // vertical cylinder (a post): collide in the x/z plane
    var self = this;
    function post(cx, cz, r, minY, maxY) {
      if (p.y < minY - BALL_R || p.y > maxY + BALL_R) return;
      var dx = p.x - cx, dz = p.z - cz, d = Math.sqrt(dx * dx + dz * dz), md = BALL_R + r;
      if (d < md && d > 0.001) {
        var nxn = dx / d, nzn = dz / d;
        p.x = cx + nxn * md; p.z = cz + nzn * md;
        var dot = b.vx * nxn + b.vz * nzn;
        if (dot < 0) { b.vx -= 2 * dot * nxn; b.vz -= 2 * dot * nzn; b.vx *= GOAL_BOUNCE; b.vz *= GOAL_BOUNCE; }
        self.send({ t: 'evt', k: 'post' });
      }
    }
    // horizontal cylinder along z (crossbar / back bar): collide in the x/y plane
    function barZ(barX, barY, r, minZ, maxZ) {
      if (p.z < minZ - BALL_R || p.z > maxZ + BALL_R) return;
      var dx = p.x - barX, dy = p.y - barY, d = Math.sqrt(dx * dx + dy * dy), md = BALL_R + r;
      if (d < md && d > 0.001) {
        var nxn = dx / d, nyn = dy / d;
        p.x = barX + nxn * md; p.y = barY + nyn * md;
        var dot = b.vx * nxn + b.vy * nyn;
        if (dot < 0) { b.vx -= 2 * dot * nxn; b.vy -= 2 * dot * nyn; b.vx *= GOAL_BOUNCE; b.vy *= GOAL_BOUNCE; }
        self.send({ t: 'evt', k: 'post' });
      }
    }

    // front posts + crossbar
    post(fx, zL, GOAL_POST_R, 0, GOAL_H);
    post(fx, zR, GOAL_POST_R, 0, GOAL_H);
    barZ(fx, GOAL_H, GOAL_POST_R, zL, zR);
    // back posts + back bar
    post(bx, zL, GOAL_POST_R * 0.7, 0, BACK_POST_H);
    post(bx, zR, GOAL_POST_R * 0.7, 0, BACK_POST_H);
    barZ(bx, BACK_POST_H, GOAL_POST_R * 0.7, zL, zR);

    // ---- nets (solid planes) ----
    var inZ = p.z > zL + GOAL_POST_R && p.z < zR - GOAL_POST_R;
    var inBox = (sgn > 0) ? (p.x > fx && p.x < bx) : (p.x < fx && p.x > bx);

    // back net: vertical plane at x = bx
    if (inZ && p.y > 0 && p.y < BACK_POST_H && Math.abs(p.x - bx) < BALL_R) {
      if (sgn > 0) { p.x = bx - BALL_R; if (b.vx > 0) b.vx = -b.vx * NET_BOUNCE; }
      else { p.x = bx + BALL_R; if (b.vx < 0) b.vx = -b.vx * NET_BOUNCE; }
      b.vy *= 0.8; b.vz *= 0.8;
    }
    // side nets: vertical planes at z = +/- GOAL_W/2, only inside the goal box
    if (inBox && p.y > 0 && p.y < GOAL_H) {
      var zLn = zL + GOAL_POST_R, zRn = zR - GOAL_POST_R;
      if (Math.abs(p.z - zLn) < BALL_R) {
        if (p.z > zLn) { p.z = zLn + BALL_R; if (b.vz < 0) b.vz = -b.vz * NET_BOUNCE; }
        else { p.z = zLn - BALL_R; if (b.vz > 0) b.vz = -b.vz * NET_BOUNCE; }
      }
      if (Math.abs(p.z - zRn) < BALL_R) {
        if (p.z < zRn) { p.z = zRn - BALL_R; if (b.vz > 0) b.vz = -b.vz * NET_BOUNCE; }
        else { p.z = zRn + BALL_R; if (b.vz < 0) b.vz = -b.vz * NET_BOUNCE; }
      }
    }
    // top net: sloped plane from crossbar (y=GOAL_H at x=fx) to back bar (y=BACK_POST_H at x=bx)
    if (inZ && inBox) {
      var t = Math.abs(p.x - fx) / GOAL_DEPTH;
      var hAt = GOAL_H - (GOAL_H - BACK_POST_H) * t;
      if (Math.abs(p.y - hAt) < BALL_R) {
        if (p.y < hAt) { p.y = hAt - BALL_R; if (b.vy > 0) b.vy = -b.vy * NET_BOUNCE; }
        else { p.y = hAt + BALL_R; if (b.vy < 0) b.vy = -b.vy * NET_BOUNCE; }
      }
    }
  }

  // Did the ball fully cross this goal's line, between the posts and under the
  // bar, moving inward? (A goal is scored the instant the ball crosses the line.)
  crossedLine(prevX, x, y, z, goal) {
    var b = this.ball, fx = goal.frontX, sgn = goal.sign;
    var crossed = (sgn > 0) ? (prevX <= fx && x > fx) : (prevX >= fx && x < fx);
    if (!crossed) return false;
    if (!((sgn > 0) ? b.vx > 0 : b.vx < 0)) return false;
    var inZ = z > -GOAL_W / 2 + BALL_R * 0.5 && z < GOAL_W / 2 - BALL_R * 0.5;
    var inY = y > BALL_R * 0.5 && y < GOAL_H - BALL_R * 0.5;
    return inZ && inY;
  }

  onGoal(goal) {
    if (this.scoredThisKick) return;
    this.scoredThisKick = true;
    var scorer = this.ownerOf(goal);
    this.players[scorer].score++;
    var self = this;
    var b = this.ball;
    this.send({ t: 'evt', k: 'goal', by: scorer, side: goal.side, x: r2(b.x), y: r2(b.y), z: r2(b.z), c: COLORS[scorer] });
    this.sendState();
    // let the ball nestle in the net for a beat, then hand the turn over.
    this.waitingForNextTurn = true;
    this.kickInFlight = false;
    this._timeout(function () { self.nextTurn(); }, 1400);
  }

  // The kick came to rest without scoring.
  onKickSettled(scored) {
    if (scored || this.waitingForNextTurn) return;
    this.kickInFlight = false;
    this.waitingForNextTurn = true;
    var self = this;
    this.send({ t: 'evt', k: 'miss', by: this.currentPlayer });
    this.sendBall(true);
    this.sendState();
    this._timeout(function () { self.nextTurn(); }, 700);
  }

  nextTurn() {
    if (this.phase !== 'playing') return;
    var next = this.currentPlayer === 1 ? 2 : 1;
    this.beginPossession(next, false);
  }

  updateClocks() {
    var t = now();
    // If it's the disconnected player's turn, freeze the clocks and wait for them.
    if (!this.connected[this.currentPlayer]) { this.lastClock = t; this.lastGameClock = t; return; }

    // kick clock: only ticks while the ball is sitting at midfield awaiting a kick
    if (this.phase === 'playing' && this.ball.grounded && !this.kickInFlight && !this.waitingForNextTurn) {
      var el = (t - this.lastClock) / 1000;
      if (el >= 1) {
        this.kickClock -= Math.floor(el); this.lastClock = t;
        if (this.kickClock <= 0) {
          this.kickClock = 0;
          this.waitingForNextTurn = true;
          this.send({ t: 'evt', k: 'timeout', by: this.currentPlayer });
          this.sendState();
          var self = this;
          this._timeout(function () { self.nextTurn(); }, 900);
        } else {
          this.sendState();
        }
      }
    }

    // game clock: runs once the match is underway
    if (this.phase === 'playing' && this.started) {
      var el2 = (t - this.lastGameClock) / 1000;
      if (el2 >= 1) {
        this.gameTimer -= Math.floor(el2); this.lastGameClock = t;
        if (this.gameTimer < 0) this.gameTimer = 0;
        this.sendState();
      }
      if (this.gameTimer <= 0 && this.ball.grounded && !this.kickInFlight && !this.waitingForNextTurn) {
        if (this.half === 1) this.halftime(); else this.gameOver();
      }
    }
  }

  halftime() {
    this.phase = 'halftime';
    this.sendPhase('halftime');
    var self = this;
    this._timeout(function () { self.secondHalf(); }, 4500);
  }
  secondHalf() {
    this.half = 2;
    this.phase = 'playing';
    this.sidesSwapped = true;
    this.gameTimer = this.options.halfLength;
    this.sendPhase('second');
    // loser-of-first-half-ish convention: player 2 kicks off the second half.
    this.beginPossession(2, false);
  }
  gameOver() {
    this.phase = 'gameover';
    this.sendPhase('gameover');
  }

  // ---- broadcast ----
  ballObj() {
    var b = this.ball;
    return { x: r2(b.x), y: r2(b.y), z: r2(b.z), rx: r2(b.rx), ry: r2(b.ry), rz: r2(b.rz), g: b.grounded ? 1 : 0 };
  }
  sendBall(force) {
    var t = now();
    if (!force && t - this.lastBallSent < BALL_SEND_MS) return;
    this.lastBallSent = t;
    this.send(Object.assign({ t: 'ball' }, this.ballObj()));
  }
  stateObj() {
    var p = this.players;
    return {
      s1: p[1].score, s2: p[2].score, k1: p[1].kicks, k2: p[2].kicks,
      cp: this.currentPlayer, kc: this.kickClock, gt: this.gameTimer, hf: this.half,
      sw: this.sidesSwapped ? 1 : 0, gr: this.ball.grounded ? 1 : 0,
      wn: this.waitingForNextTurn ? 1 : 0, ki: this.kickInFlight ? 1 : 0, ph: this.phase
    };
  }
  sendState() { this.send(Object.assign({ t: 'state' }, this.stateObj())); }
  sendTurn() { this.send({ t: 'turn', cp: this.currentPlayer, kc: this.kickClock, gt: this.gameTimer, sw: this.sidesSwapped ? 1 : 0 }); }
  sendPhase(ph) { this.send({ t: 'phase', ph: ph, cp: this.currentPlayer, gt: this.gameTimer, hf: this.half, sw: this.sidesSwapped ? 1 : 0 }); }
}

module.exports = { Match: Match, sanitizeOptions: sanitizeOptions };
