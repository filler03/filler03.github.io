'use strict';

// Server-authoritative soccer match. One Match instance per room; it runs the 3D
// ball physics for BOTH players. Clients only send kicks and render what they
// receive.
//
// FREE PLAY (no turns): there is ONE shared ball, live at all times. Either
// player may kick it at any moment. It resets to the centre spot only when a
// goal is scored. A single running match clock ends the game.

var FIELD_HALF_W = 30;
var FIELD_HALF_D = 20;
var BALL_R = 0.22;

var GOAL_W = 7.32;
var GOAL_H = 2.44;
var GOAL_DEPTH = 2.0;
var GOAL_LINE = 27;
var GOAL_POST_R = 0.06;
var BACK_POST_H = GOAL_H * 0.5;

var GRAVITY = -9.81;
var FRICTION = 0.98;
var ANG_FRICTION = 0.995;
var WALL_BOUNCE = 0.6;
var GOAL_BOUNCE = 0.5;
var NET_BOUNCE = 0.3;

var MAX_KICK_SPEED = 40;

var KICK_COOLDOWN_MS = 120;
var GOAL_RESET_MS = 1500;

var BALL_SEND_MS = 33;

var COLORS = { 1: '#ff5b5b', 2: '#4a9eff' };
var DEFAULTS = { speed: 1.0, halfLength: 90, bounce: 0.7 };

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
  if (vy < 0) vy = 0;
  return [vx, vy, vz];
}

function sanitizeOptions(o) {
  o = o || {};
  return {
    speed: num(o.speed, 0.6, 1.8, DEFAULTS.speed),
    halfLength: Math.round(num(o.halfLength, 30, 180, DEFAULTS.halfLength)),
    bounce: num(o.bounce, 0.4, 0.85, DEFAULTS.bounce)
  };
}

class Match {
  constructor(options, name1, name2, send, onEnd) {
    this.send = send;
    this.onEnd = onEnd || null;
    this.options = sanitizeOptions(options);
    this.names = { 1: name1 || 'Player 1', 2: name2 || 'Player 2' };
    this.connected = { 1: true, 2: true };
    this.lastBallSent = 0;
    this.lastHeartbeat = 0;
    this._lastBallStr = '';
    this._timers = [];
    this._destroyed = false;
    this.reset();
  }

  reset() {
    this.phase = 'playing';
    this.players = { 1: { score: 0, kicks: 0 }, 2: { score: 0, kicks: 0 } };
    this.gameTimer = this.options.halfLength;
    this.started = false;
    this.goalPause = false;
    this.scoredThisGoal = false;
    this.lastKickAt = { 1: 0, 2: 0 };
    this.ball = { x: 0, y: BALL_R, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, avx: 0, avy: 0, avz: 0, grounded: true };
    this.lastGameClock = 0;
    this._lastBallStr = '';
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
    this.kickoff(true);
  }
  rematch() {
    this.reset();
    this.send({ t: 'start', o: this.options, p1: this.names[1], p2: this.names[2] });
    this.kickoff(true);
  }

  onDisconnect(role) { this.connected[role] = false; }
  onReconnect(role) {
    this.connected[role] = true;
    this.lastGameClock = now();
  }
  resyncPayload() {
    return { t: 'resync', o: this.options, p1: this.names[1], p2: this.names[2], st: this.stateObj(), ball: this.ballObj() };
  }

  isPaused() { return this.goalPause || !this.connected[1] || !this.connected[2]; }

  attackSignFor(player) { return (player === 1) ? 1 : -1; }
  ownerOf(goal) { return goal.sign === 1 ? 1 : 2; }

  centerBall() {
    var b = this.ball;
    b.x = 0; b.y = BALL_R; b.z = 0;
    b.vx = 0; b.vy = 0; b.vz = 0;
    b.avx = 0; b.avy = 0; b.avz = 0;
    b.grounded = true;
  }

  kickoff(initial) {
    this.centerBall();
    this.goalPause = false;
    this.scoredThisGoal = false;
    this.lastGameClock = now();
    if (initial) this.started = true;
    this.sendState();
    this.sendBall(true);
  }

  applyKick(player, vx, vy, vz) {
    if (this._destroyed || this.phase !== 'playing') return;
    if (this.isPaused()) return;
    var t = now();
    if (t - (this.lastKickAt[player] || 0) < KICK_COOLDOWN_MS) return;
    var c = clampKick(vx, vy, vz); if (!c) return;
    this.lastKickAt[player] = t;
    var b = this.ball;
    b.vx = c[0]; b.vy = c[1]; b.vz = c[2];
    b.grounded = false;
    b.avx = c[2] * 0.6; b.avz = -c[0] * 0.6; b.avy = 0;
    this.players[player].kicks++;
    this.send({ t: 'evt', k: 'kick', by: player, c: COLORS[player] });
    this.sendState();
    this.sendBall(true);
  }

  step(dtMs) {
    if (this._destroyed || this.phase !== 'playing') return;
    var t = now();
    var dt = Math.min(dtMs / 1000, 0.05);
    if (!this.isPaused()) {
      this.simulate(dt);
      this.sendBall(false);
    }
    this.updateClocks();
    if (t - this.lastHeartbeat > 1000) { this.lastHeartbeat = t; this.sendState(); }
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

      if (ny < BALL_R) {
        ny = BALL_R;
        if (b.vy < -0.1) { b.vy = -b.vy * bounce; b.avx += b.vz * 0.5; b.avz -= b.vx * 0.5; }
        else b.vy = 0;
        b.vx *= FRICTION; b.vz *= FRICTION;
        if (Math.abs(b.vx) < 0.02) b.vx = 0;
        if (Math.abs(b.vz) < 0.02) b.vz = 0;
      }

      if (nx < -FIELD_HALF_W + BALL_R) { nx = -FIELD_HALF_W + BALL_R; b.vx = Math.abs(b.vx) * WALL_BOUNCE; }
      if (nx > FIELD_HALF_W - BALL_R) { nx = FIELD_HALF_W - BALL_R; b.vx = -Math.abs(b.vx) * WALL_BOUNCE; }
      if (nz < -FIELD_HALF_D + BALL_R) { nz = -FIELD_HALF_D + BALL_R; b.vz = Math.abs(b.vz) * WALL_BOUNCE; }
      if (nz > FIELD_HALF_D - BALL_R) { nz = FIELD_HALF_D - BALL_R; b.vz = -Math.abs(b.vz) * WALL_BOUNCE; }

      var res = { x: nx, y: ny, z: nz };
      for (var g = 0; g < GOALS.length; g++) this.collideGoal(res, GOALS[g]);
      nx = res.x; ny = res.y; nz = res.z;

      if (!this.scoredThisGoal) {
        for (var g2 = 0; g2 < GOALS.length; g2++) {
          if (this.crossedLine(prevX, nx, ny, nz, GOALS[g2])) { this.onGoal(GOALS[g2]); break; }
        }
      }

      b.x = nx; b.y = ny; b.z = nz;
    }

    var af = Math.pow(ANG_FRICTION, dt * 60);
    b.avx *= af; b.avy *= af; b.avz *= af;
    b.rx += b.avx * dt; b.ry += b.avy * dt; b.rz += b.avz * dt;

    b.grounded = b.y <= BALL_R + 0.02;
  }

  collideGoal(p, goal) {
    var b = this.ball;
    var fx = goal.frontX, bx = goal.backX, sgn = goal.sign;
    var zL = -GOAL_W / 2, zR = GOAL_W / 2;
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
    post(fx, zL, GOAL_POST_R, 0, GOAL_H);
    post(fx, zR, GOAL_POST_R, 0, GOAL_H);
    barZ(fx, GOAL_H, GOAL_POST_R, zL, zR);
    post(bx, zL, GOAL_POST_R * 0.7, 0, BACK_POST_H);
    post(bx, zR, GOAL_POST_R * 0.7, 0, BACK_POST_H);
    barZ(bx, BACK_POST_H, GOAL_POST_R * 0.7, zL, zR);
    var inZ = p.z > zL + GOAL_POST_R && p.z < zR - GOAL_POST_R;
    var inBox = (sgn > 0) ? (p.x > fx && p.x < bx) : (p.x < fx && p.x > bx);
    if (inZ && p.y > 0 && p.y < BACK_POST_H && Math.abs(p.x - bx) < BALL_R) {
      if (sgn > 0) { p.x = bx - BALL_R; if (b.vx > 0) b.vx = -b.vx * NET_BOUNCE; }
      else { p.x = bx + BALL_R; if (b.vx < 0) b.vx = -b.vx * NET_BOUNCE; }
      b.vy *= 0.8; b.vz *= 0.8;
    }
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
    if (inZ && inBox) {
      var t = Math.abs(p.x - fx) / GOAL_DEPTH;
      var hAt = GOAL_H - (GOAL_H - BACK_POST_H) * t;
      if (Math.abs(p.y - hAt) < BALL_R) {
        if (p.y < hAt) { p.y = hAt - BALL_R; if (b.vy > 0) b.vy = -b.vy * NET_BOUNCE; }
        else { p.y = hAt + BALL_R; if (b.vy < 0) b.vy = -b.vy * NET_BOUNCE; }
      }
    }
  }

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
    if (this.scoredThisGoal || this.goalPause) return;
    this.scoredThisGoal = true;
    var scorer = this.ownerOf(goal);
    this.players[scorer].score++;
    var b = this.ball;
    this.send({ t: 'evt', k: 'goal', by: scorer, side: goal.side, x: r2(b.x), y: r2(b.y), z: r2(b.z), c: COLORS[scorer] });
    this.goalPause = true;
    b.vx = 0; b.vy = 0; b.vz = 0; b.avx = 0; b.avy = 0; b.avz = 0;
    this.sendState();
    this.sendBall(true);
    var self = this;
    this._timeout(function () { self.afterGoal(); }, GOAL_RESET_MS);
  }

  afterGoal() {
    if (this.phase !== 'playing') return;
    this.kickoff(false);
  }

  updateClocks() {
    if (this.phase !== 'playing') return;
    var t = now();
    if (this.isPaused() || !this.started) { this.lastGameClock = t; return; }
    var el = (t - this.lastGameClock) / 1000;
    if (el >= 1) {
      this.gameTimer -= Math.floor(el); this.lastGameClock = t;
      if (this.gameTimer <= 0) { this.gameTimer = 0; this.sendState(); this.gameOver(); return; }
      this.sendState();
    }
  }

  gameOver() {
    this.phase = 'gameover';
    var s1 = this.players[1].score, s2 = this.players[2].score;
    // Server-authoritative final result on the game-over message so the ended
    // screen is always correct even if a state update was missed.
    // winner: 0 = draw, otherwise the seat number (1 or 2).
    var winner = (s1 === s2) ? 0 : (s1 > s2 ? 1 : 2);
    var winnerName = winner === 0 ? null : this.names[winner];
    this.send({
      t: 'phase', ph: 'gameover',
      gt: this.gameTimer,
      s1: s1, s2: s2,
      p1: this.names[1], p2: this.names[2],
      winner: winner, winnerName: winnerName
    });
    var self = this; setTimeout(function () { if (self.onEnd) self.onEnd(); }, 0);
  }

  ballObj() {
    var b = this.ball;
    return { x: r2(b.x), y: r2(b.y), z: r2(b.z), rx: r2(b.rx), ry: r2(b.ry), rz: r2(b.rz), g: b.grounded ? 1 : 0 };
  }
  sendBall(force) {
    var t = now();
    var o = this.ballObj();
    if (!force) {
      if (t - this.lastBallSent < BALL_SEND_MS) return;
      var sig = o.x + ',' + o.y + ',' + o.z + ',' + o.rx + ',' + o.ry + ',' + o.rz + ',' + o.g;
      if (sig === this._lastBallStr) { this.lastBallSent = t; return; }
      this._lastBallStr = sig;
    } else {
      this._lastBallStr = o.x + ',' + o.y + ',' + o.z + ',' + o.rx + ',' + o.ry + ',' + o.rz + ',' + o.g;
    }
    this.lastBallSent = t;
    this.send(Object.assign({ t: 'ball' }, o));
  }
  stateObj() {
    var p = this.players;
    return {
      s1: p[1].score, s2: p[2].score, k1: p[1].kicks, k2: p[2].kicks,
      gt: this.gameTimer, gp: this.goalPause ? 1 : 0,
      gr: this.ball.grounded ? 1 : 0, ph: this.phase
    };
  }
  sendState() { this.send(Object.assign({ t: 'state' }, this.stateObj())); }
  sendPhase(ph) { this.send({ t: 'phase', ph: ph, gt: this.gameTimer }); }
}

module.exports = { Match: Match, sanitizeOptions: sanitizeOptions };
