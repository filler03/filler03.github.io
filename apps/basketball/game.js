'use strict';

// Server-authoritative basketball match. One Match instance per room; it runs the
// physics for BOTH players. Clients only send shots and render what they receive.
// The simulation is ported verbatim from the old browser-side host code so the
// gameplay feel is unchanged — the only difference is *where* it runs.

var WORLD_W = 960, WORLD_H = 540;
var FLOOR_Y = WORLD_H - 90;
var BALL_R = 18, HOOP_W = 60, RIM_R = 5;
var GRAVITY = 0.55, AIR = 0.997, FRICTION = 0.98;
var STEP = 1 / 60;                 // fixed physics timestep
var MAX_SHOT_SPEED = 60;           // clamp against bad/malicious input
// How often the server streams the ball position while it's moving, in ms.
// Lower = smoother on the client (more updates), at a tiny bandwidth cost.
// ~16ms ≈ 60/sec (one per physics tick); 33ms ≈ 30/sec. Tune to taste.
var BALL_SEND_MS = 16;
var COLORS = { 1: '#ff6b6b', 2: '#4a9eff' };
var DEFAULTS = { speed: 1.1, shotClock: 10, halfLength: 60, bounce: 0.7 };

// ---- "Frenzy" mode: simultaneous, multi-ball free-for-all --------------------
// Both players play at once. There is a shared pool of balls (an even count,
// 2..10) spread evenly across the floor. Either player can grab any resting,
// un-held ball, aim it, and shoot -- while a ball is being aimed it is anchored
// and immovable (the other player can't grab it and balls that hit it just bounce
// off). Balls collide with one another at rest and in the air, so you can knock a
// rival's shot off course. There are no turns, no shot clock, and no halftime; the
// match clock counts down but every `pointsPer` combined points add `bonusSecs`.
var FRENZY_DEFAULTS = { speed: 1.1, halfLength: 60, bounce: 0.7, balls: 6, pointsPer: 5, bonusSecs: 10, scoreMode: 'own' };
var GRAB_R = 70;          // how close a tap must be (world units) to grab a ball
var MAX_HOLD_MS = 8000;   // safety: auto-release a ball held longer than this
var BALL_REST = 0.9;      // restitution for ball-to-ball collisions
var BALLS_SEND_MS = 33;   // multi-ball stream cadence (~30/sec)

var hoopLeft = { x: 15, y: WORLD_H * 0.4, side: 'left' };
var hoopRight = { x: WORLD_W - 15, y: WORLD_H * 0.4, side: 'right' };

function now() { return Date.now(); }
function clampSpeed(vx, vy) {
  var s = Math.hypot(vx, vy);
  if (s > MAX_SHOT_SPEED) { vx = vx * MAX_SHOT_SPEED / s; vy = vy * MAX_SHOT_SPEED / s; }
  return [vx, vy];
}
function num(v, lo, hi, dflt) { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; }
function sanitizeOptions(o) {
  o = o || {};
  if (o.mode === 'frenzy') {
    var n = Math.round(num(o.balls, 2, 10, FRENZY_DEFAULTS.balls));
    if (n % 2 !== 0) n += (n < 10 ? 1 : -1);   // must be even
    return {
      mode: 'frenzy',
      speed: num(o.speed, 0.6, 1.8, FRENZY_DEFAULTS.speed),
      halfLength: Math.round(num(o.halfLength, 30, 180, FRENZY_DEFAULTS.halfLength)),
      bounce: num(o.bounce, 0.4, 0.85, FRENZY_DEFAULTS.bounce),
      balls: n,
      pointsPer: Math.round(num(o.pointsPer, 2, 20, FRENZY_DEFAULTS.pointsPer)),
      bonusSecs: Math.round(num(o.bonusSecs, 5, 30, FRENZY_DEFAULTS.bonusSecs)),
      scoreMode: o.scoreMode === 'any' ? 'any' : 'own'
    };
  }
  return {
    mode: 'duel',
    speed: num(o.speed, 0.6, 1.8, DEFAULTS.speed),
    shotClock: Math.round(num(o.shotClock, 5, 24, DEFAULTS.shotClock)),
    halfLength: Math.round(num(o.halfLength, 30, 180, DEFAULTS.halfLength)),
    bounce: num(o.bounce, 0.4, 0.85, DEFAULTS.bounce)
  };
}

class Match {
  constructor(options, name1, name2, send) {
    this.send = send;               // send(msgObject) -> broadcast to both players
    this.options = sanitizeOptions(options);
    this.mode = this.options.mode;  // 'duel' (turn-based) or 'frenzy' (simultaneous multi-ball)
    this.names = { 1: name1 || 'Player 1', 2: name2 || 'Player 2' };
    this.connected = { 1: true, 2: true };   // per-seat; a drop no longer pauses the match
    this.lastBallSent = 0;
    this.lastHeartbeat = 0;
    this._timers = [];
    this._destroyed = false;
    this.reset();
  }

  reset() {
    if (this.mode === 'frenzy') { this.resetFrenzy(); return; }
    this.phase = 'playing';
    this.players = { 1: { score: 0, shots: 0, made: 0, turnovers: 0 }, 2: { score: 0, shots: 0, made: 0, turnovers: 0 } };
    this.currentPlayer = 1; this.half = 1; this.sidesSwapped = false;
    this.shotClock = this.options.shotClock; this.gameTimer = this.options.halfLength;
    this.initialDrop = true; this.waitingForNextTurn = false; this.shotClockActive = false;
    this.scoredThisShot = false; this.wentThroughBelow = false; this.shotOriginX = WORLD_W / 2; this.lastBallY = 0;
    this.ball = { x: WORLD_W / 2, y: -BALL_R, vx: 0, vy: 0, rot: 0, angularVel: 0, grounded: false };
    this.acc = 0; this.lastClock = 0; this.lastGameClock = 0;
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
    if (this.mode === 'frenzy') return this.startFrenzy();
    this.reset(); this.dropBall();
    this.send({ t: 'start', o: this.options, p1: this.names[1], p2: this.names[2] });
    this.sendState(); this.sendBall(true);
  }
  rematch() {
    if (this.mode === 'frenzy') return this.startFrenzy();
    this.reset(); this.dropBall();
    this.send({ t: 'start', o: this.options, p1: this.names[1], p2: this.names[2] });
    this.sendState(); this.sendBall(true);
  }
  // A player's socket dropped: the match keeps running. If it's *their* turn, the
  // clocks hold (see updateClocks) so they aren't penalized and the opponent just
  // sees a normal "their turn" pause. The opponent is never notified.
  onDisconnect(role) { this.connected[role] = false; }
  // They came back within the grace window: mark them present and reset the clock
  // anchors so no time "jumps". The caller sends resyncPayload() to just this player.
  onReconnect(role) {
    this.connected[role] = true;
    this.lastClock = now(); this.lastGameClock = now(); this.acc = 0;
  }
  resyncPayload() {
    if (this.mode === 'frenzy') {
      return { t: 'resync', o: this.options, p1: this.names[1], p2: this.names[2], st: this.stateObj(), balls: this.ballsArray() };
    }
    var b = this.ball;
    return { t: 'resync', o: this.options, p1: this.names[1], p2: this.names[2], st: this.stateObj(), ball: { x: Math.round(b.x), y: Math.round(b.y), r: b.rot, g: b.grounded ? 1 : 0 } };
  }

  targetHoop(player) {
    if (this.sidesSwapped) return player === 1 ? 'left' : 'right';
    return player === 1 ? 'right' : 'left';
  }
  isThree(x, side) {
    var tpr = WORLD_W / 3;
    if (side === 'left') return x > (hoopLeft.x + HOOP_W / 2) + tpr;
    return x < (hoopRight.x - HOOP_W / 2) - tpr;
  }
  dropBall() {
    var b = this.ball;
    b.x = WORLD_W / 2; b.y = WORLD_H * 0.25; b.vx = 0; b.vy = 5 * this.options.speed;
    b.angularVel = 0; b.rot = 0; b.grounded = false;
  }

  applyShot(player, vx, vy, i) {
    if (this.mode === 'frenzy') return this.applyShotFrenzy(player, i, vx, vy);
    if (this._destroyed || this.phase !== 'playing') return;
    if (this.currentPlayer !== player || !this.ball.grounded || this.waitingForNextTurn) return;
    var c = clampSpeed(vx, vy); vx = c[0]; vy = c[1];
    if (!isFinite(vx) || !isFinite(vy)) return;
    var b = this.ball;
    b.vx = vx; b.vy = vy; b.angularVel = vx * 0.05; b.grounded = false;
    this.shotClockActive = false; this.scoredThisShot = false; this.wentThroughBelow = false; this.shotOriginX = b.x;
    this.players[player].shots++;
    this.send({ t: 'evt', k: 'shot', x: Math.round(b.x), y: Math.round(b.y), c: COLORS[player] });
    this.sendState();
  }

  // Called by the server loop with elapsed milliseconds since the last tick.
  step(dtMs) {
    if (this.mode === 'frenzy') return this.stepFrenzy(dtMs);
    if (this._destroyed || this.phase !== 'playing') return;
    this.acc += Math.min(dtMs / 1000, 0.1);
    var guard = 0;
    while (this.acc >= STEP && guard < 8) { this.physics(); this.acc -= STEP; guard++; }
    if (this.acc > STEP) this.acc = 0;
    this.updateClocks();
    if (!this.ball.grounded) this.sendBall(false);
    var t = now();
    if (t - this.lastHeartbeat > 1000) { this.lastHeartbeat = t; this.sendState(); }
  }

  physics() {
    var b = this.ball, sp = this.options.speed, bnc = this.options.bounce;
    if (b.grounded) return;
    b.vy += GRAVITY * sp;
    b.vx *= Math.pow(AIR, sp); b.vy *= Math.pow(AIR, sp);
    var prevY = b.y;
    b.x += b.vx * sp; b.y += b.vy * sp;
    b.rot += b.angularVel * sp; b.angularVel *= 0.99;
    this.lastBallY = prevY;
    this.checkHoop(hoopLeft); this.checkHoop(hoopRight);
    if (b.y + BALL_R > FLOOR_Y) {
      b.y = FLOOR_Y - BALL_R; b.vy *= -bnc; b.vx *= FRICTION; b.angularVel = b.vx * 0.03;
      if (Math.abs(b.vy) < 1 && Math.abs(b.vx) < 0.5) { b.vx = 0; b.vy = 0; b.grounded = true; this.onBallGrounded(); }
      else { this.sendBall(true, true); }
    }
    if (b.x - BALL_R < 0) { b.x = BALL_R; b.vx *= -bnc; this.sendBall(true, true); }
    if (b.x + BALL_R > WORLD_W) { b.x = WORLD_W - BALL_R; b.vx *= -bnc; this.sendBall(true, true); }
  }

  checkHoop(hoop) {
    var b = this.ball;
    var rimLeftX = hoop.side === 'left' ? hoop.x : hoop.x - HOOP_W;
    var rimRightX = hoop.side === 'left' ? hoop.x + HOOP_W : hoop.x;
    var rims = [[rimLeftX, hoop.y], [rimRightX, hoop.y]];
    for (var i = 0; i < rims.length; i++) {
      var rx = rims[i][0], ry = rims[i][1];
      var dx = b.x - rx, dy = b.y - ry, d = Math.hypot(dx, dy), md = BALL_R + RIM_R;
      if (d < md && d > 0) {
        var nx = dx / d, ny = dy / d, ov = md - d;
        b.x += nx * ov; b.y += ny * ov;
        var dot = b.vx * nx + b.vy * ny;
        b.vx = (b.vx - 2 * dot * nx) * this.options.bounce;
        b.vy = (b.vy - 2 * dot * ny) * this.options.bounce;
        b.angularVel = b.vx * 0.03;
        this.send({ t: 'evt', k: 'rim', x: Math.round(rx), y: Math.round(ry) });
      }
    }
    if (!this.scoredThisShot) {
      var inX = b.x > rimLeftX && b.x < rimRightX;
      var crossedDown = this.lastBallY <= hoop.y && b.y > hoop.y;
      var crossedUp = this.lastBallY >= hoop.y && b.y < hoop.y;
      var correct = hoop.side === this.targetHoop(this.currentPlayer);
      if (inX && crossedUp && b.vy < 0 && correct) this.wentThroughBelow = true;
      if (inX && crossedDown && b.vy > 0 && correct) {
        var pts = this.wentThroughBelow ? 1 : (this.isThree(this.shotOriginX, hoop.side) ? 3 : 2);
        this.players[this.currentPlayer].score += pts;
        this.players[this.currentPlayer].made++;
        this.scoredThisShot = true;
        var cx = hoop.side === 'left' ? hoop.x + HOOP_W / 2 : hoop.x - HOOP_W / 2;
        var py = hoop.y + 60;
        this.send({ t: 'evt', k: 'score', x: Math.round(b.x), y: Math.round(b.y), px: Math.round(cx), py: Math.round(py), pts: pts, c: COLORS[this.currentPlayer] });
        this.sendState();
      }
    }
  }

  onBallGrounded() {
    var self = this;
    if (this.initialDrop) {
      this.initialDrop = false; this.shotClockActive = true;
      this.lastClock = now(); this.lastGameClock = now();
      this.sendState();
    } else if (!this.waitingForNextTurn) {
      this.waitingForNextTurn = true;
      this.sendBall(true); this.sendState();
      this._timeout(function () { self.switchTurn(); }, 800);
    }
  }
  switchTurn() {
    if (this.phase !== 'playing') return;
    this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
    this.scoredThisShot = false; this.waitingForNextTurn = false;
    this.shotClock = this.options.shotClock; this.lastClock = now(); this.shotClockActive = true;
    this.sendTurn(); this.sendState();
  }

  updateClocks() {
    var self = this, t = now();
    // If it's the disconnected player's turn, freeze the clocks and wait for them.
    // To the connected opponent this just looks like the other player taking their
    // time — no turnover, no half ending, no visible interruption.
    if (!this.connected[this.currentPlayer]) { this.lastClock = t; this.lastGameClock = t; return; }
    if (this.shotClockActive && this.ball.grounded && this.phase === 'playing') {
      var el = (t - this.lastClock) / 1000;
      if (el >= 1) {
        this.shotClock -= Math.floor(el); this.lastClock = t;
        if (this.shotClock <= 0) {
          this.shotClock = 0; this.shotClockActive = false;
          this.players[this.currentPlayer].turnovers++;
          this.send({ t: 'evt', k: 'turnover', p: this.currentPlayer });
          this.waitingForNextTurn = true; this.sendState();
          this._timeout(function () { self.switchTurn(); }, 1000);
        } else { this.sendState(); }
      }
    }
    if (this.phase === 'playing' && !this.initialDrop) {
      var el2 = (t - this.lastGameClock) / 1000;
      if (el2 >= 1) { this.gameTimer -= Math.floor(el2); this.lastGameClock = t; if (this.gameTimer < 0) this.gameTimer = 0; this.sendState(); }
      if (this.gameTimer <= 0 && this.ball.grounded && !this.waitingForNextTurn) {
        if (this.half === 1) this.halftime(); else this.gameOver();
      }
    }
  }

  halftime() {
    var self = this;
    this.phase = 'halftime'; this.shotClockActive = false;
    this.sendPhase('halftime');
    this._timeout(function () { self.secondHalf(); }, 4500);
  }
  secondHalf() {
    this.half = 2; this.phase = 'playing'; this.sidesSwapped = true;
    this.gameTimer = this.options.halfLength; this.currentPlayer = 2;
    this.initialDrop = true; this.waitingForNextTurn = false; this.shotClockActive = false;
    this.dropBall();
    this.sendPhase('second'); this.sendState(); this.sendBall(true);
  }
  gameOver() {
    this.phase = 'gameover'; this.shotClockActive = false;
    this.sendPhase('gameover');
  }

  // ======================================================================
  //  FRENZY MODE — simultaneous, shared pool of balls, ball-to-ball physics
  // ======================================================================
  resetFrenzy() {
    this.phase = 'playing';
    this.players = { 1: { score: 0, shots: 0, made: 0, turnovers: 0 }, 2: { score: 0, shots: 0, made: 0, turnovers: 0 } };
    this.gameTimer = this.options.halfLength;
    this.started = false;
    this.held = { 1: -1, 2: -1 };     // index of the ball each player is aiming (-1 = none)
    this.heldSince = { 1: 0, 2: 0 };
    this.bonusCount = 0;              // how many pointsPer thresholds have paid out
    this.acc = 0; this.lastGameClock = 0;
    this._lastBallsStr = '';
    this.initBalls();
  }
  initBalls() {
    this.balls = [];
    var n = this.options.balls;
    for (var i = 0; i < n; i++) {
      var x = WORLD_W * (i + 0.5) / n;   // evenly spread across the floor, symmetric about centre
      this.balls.push({ i: i, x: x, y: FLOOR_Y - BALL_R, vx: 0, vy: 0, rot: 0, av: 0, grounded: true, shooter: 0, target: null, scored: false, _below: false, _prevY: 0, _originX: x });
    }
  }
  startFrenzy() {
    this.reset();                      // -> resetFrenzy (mode dispatch)
    this.started = true; this.lastGameClock = now();
    this.send({ t: 'start', o: this.options, p1: this.names[1], p2: this.names[2] });
    this.sendState(); this.sendBalls(true);
  }

  heldByOf(i) { return this.held[1] === i ? 1 : (this.held[2] === i ? 2 : 0); }
  // Fixed sides in frenzy (no halftime/swap): player 1 shoots the RIGHT hoop, 2 the LEFT.
  targetHoopFrenzy(player) { return player === 1 ? 'right' : 'left'; }
  // A ball can be grabbed only if it's free (nobody's aiming it) and at rest.
  grabbable(b) { return this.heldByOf(b.i) === 0 && b.grounded; }

  // Claim the nearest resting, un-held ball to (x,y) and anchor it for aiming.
  grab(player, x, y) {
    if (this.mode !== 'frenzy' || this._destroyed || this.phase !== 'playing') return;
    if (!this.connected[player] || this.held[player] >= 0) return;
    if (!isFinite(x) || !isFinite(y)) return;
    var best = -1, bestD = GRAB_R;
    for (var k = 0; k < this.balls.length; k++) {
      var b = this.balls[k];
      if (!this.grabbable(b)) continue;
      var d = Math.hypot(b.x - x, b.y - y);
      if (d < bestD) { bestD = d; best = b.i; }
    }
    if (best < 0) return;
    this.held[player] = best; this.heldSince[player] = now();
    var hb = this.balls[best];
    hb.vx = 0; hb.vy = 0; hb.av = 0; hb.grounded = false;   // anchored: frozen & immovable, not "resting"
    hb.shooter = 0; hb.target = null; hb.scored = false; hb._below = false;
    this.send({ t: 'evt', k: 'grab', by: player, i: best });
    this.sendBalls(true);
  }

  // Let a held ball go without shooting (a tap / cancelled aim).
  release(player, i) {
    if (this.mode !== 'frenzy') return;
    var held = this.held[player];
    if (held < 0) return;
    if (i != null && Number(i) !== held) return;   // only release the ball you actually hold
    this.held[player] = -1;
    var b = this.balls[held];
    if (b) { b.vx = 0; b.vy = 0; b.av = 0; b.grounded = (b.y >= FLOOR_Y - BALL_R - 1); }
    this.send({ t: 'evt', k: 'release', by: player, i: held });
    this.sendBalls(true);
  }

  applyShotFrenzy(player, i, vx, vy) {
    if (this._destroyed || this.phase !== 'playing') return;
    i = Number(i);
    if (this.held[player] !== i) return;      // you can only shoot the ball you're aiming
    var c = clampSpeed(vx, vy); vx = c[0]; vy = c[1];
    if (!isFinite(vx) || !isFinite(vy)) return;
    var b = this.balls[i]; if (!b) return;
    this.held[player] = -1;
    b.vx = vx; b.vy = vy; b.av = vx * 0.05; b.grounded = false;
    b.shooter = player;
    b.target = this.options.scoreMode === 'any' ? 'any' : this.targetHoopFrenzy(player);
    b.scored = false; b._below = false; b._originX = b.x;
    this.players[player].shots++;
    this.send({ t: 'evt', k: 'shot', i: i, x: Math.round(b.x), y: Math.round(b.y), c: COLORS[player] });
    this.sendBalls(true);
  }

  stepFrenzy(dtMs) {
    if (this._destroyed || this.phase !== 'playing') return;
    var t = now();
    // Safety: a ball can't be locked forever. Auto-release anything held too long.
    for (var pl = 1; pl <= 2; pl++) {
      if (this.held[pl] >= 0 && t - this.heldSince[pl] > MAX_HOLD_MS) this.release(pl, this.held[pl]);
    }
    this.acc += Math.min(dtMs / 1000, 0.1);
    var guard = 0;
    while (this.acc >= STEP && guard < 8) { this.physicsFrenzy(); this.acc -= STEP; guard++; }
    if (this.acc > STEP) this.acc = 0;
    this.updateClocksFrenzy();
    this.sendBalls(false);
    if (t - this.lastHeartbeat > 1000) { this.lastHeartbeat = t; this.sendState(); this.sendBalls(true); }
  }

  physicsFrenzy() {
    var sp = this.options.speed, bnc = this.options.bounce, balls = this.balls;
    for (var k = 0; k < balls.length; k++) {
      var b = balls[k];
      if (this.heldByOf(b.i)) continue;    // anchored while being aimed
      if (b.grounded) continue;            // resting (still collides, handled below)
      b.vy += GRAVITY * sp;
      b.vx *= Math.pow(AIR, sp); b.vy *= Math.pow(AIR, sp);
      b._prevY = b.y;
      b.x += b.vx * sp; b.y += b.vy * sp;
      b.rot += b.av * sp; b.av *= 0.99;
      this.checkHoopFrenzy(b, hoopLeft); this.checkHoopFrenzy(b, hoopRight);
      if (b.y + BALL_R > FLOOR_Y) {
        b.y = FLOOR_Y - BALL_R; b.vy *= -bnc; b.vx *= FRICTION; b.av = b.vx * 0.03;
        if (Math.abs(b.vy) < 1 && Math.abs(b.vx) < 0.5) {
          b.vx = 0; b.vy = 0; b.grounded = true;
          b.shooter = 0; b.target = null; b.scored = false; b._below = false;   // shot is over
        }
      }
      if (b.x - BALL_R < 0) { b.x = BALL_R; b.vx *= -bnc; }
      if (b.x + BALL_R > WORLD_W) { b.x = WORLD_W - BALL_R; b.vx *= -bnc; }
    }
    this.ballBallCollisions();
    // Keep resting balls glued to the floor after any collision nudged them.
    for (var j = 0; j < balls.length; j++) { if (balls[j].grounded) balls[j].y = FLOOR_Y - BALL_R; }
  }

  wakeBall(b) { if (b.grounded && (Math.abs(b.vx) > 0.5 || Math.abs(b.vy) > 0.5)) b.grounded = false; }

  // Elastic-ish equal-mass collisions between every pair of balls. A ball being
  // aimed (held) is treated as immovable: others bounce off it but it doesn't move.
  ballBallCollisions() {
    var balls = this.balls, n = balls.length, D = BALL_R * 2, contact = false;
    for (var a = 0; a < n; a++) {
      for (var c = a + 1; c < n; c++) {
        var A = balls[a], B = balls[c];
        var dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
        if (d <= 0 || d >= D) continue;
        var nx = dx / d, ny = dy / d, overlap = D - d;
        var aHeld = this.heldByOf(A.i) !== 0, bHeld = this.heldByOf(B.i) !== 0;
        if (aHeld && bHeld) continue;
        if (aHeld) {
          B.x += nx * overlap; B.y += ny * overlap;
          var vnB = B.vx * nx + B.vy * ny;
          if (vnB < 0) { B.vx -= (1 + BALL_REST) * vnB * nx; B.vy -= (1 + BALL_REST) * vnB * ny; }
          this.wakeBall(B); contact = true;
        } else if (bHeld) {
          A.x -= nx * overlap; A.y -= ny * overlap;
          var vnA = A.vx * nx + A.vy * ny;
          if (vnA > 0) { A.vx -= (1 + BALL_REST) * vnA * nx; A.vy -= (1 + BALL_REST) * vnA * ny; }
          this.wakeBall(A); contact = true;
        } else {
          A.x -= nx * overlap / 2; A.y -= ny * overlap / 2;
          B.x += nx * overlap / 2; B.y += ny * overlap / 2;
          var rvx = B.vx - A.vx, rvy = B.vy - A.vy, vn = rvx * nx + rvy * ny;
          if (vn < 0) {
            var imp = -(1 + BALL_REST) * vn / 2;
            A.vx -= imp * nx; A.vy -= imp * ny;
            B.vx += imp * nx; B.vy += imp * ny;
          }
          this.wakeBall(A); this.wakeBall(B); contact = true;
        }
      }
    }
    if (contact) this.send({ t: 'evt', k: 'clack' });
  }

  checkHoopFrenzy(b, hoop) {
    var rimLeftX = hoop.side === 'left' ? hoop.x : hoop.x - HOOP_W;
    var rimRightX = hoop.side === 'left' ? hoop.x + HOOP_W : hoop.x;
    var rims = [[rimLeftX, hoop.y], [rimRightX, hoop.y]];
    for (var r = 0; r < rims.length; r++) {
      var rx = rims[r][0], ry = rims[r][1];
      var dx = b.x - rx, dy = b.y - ry, d = Math.hypot(dx, dy), md = BALL_R + RIM_R;
      if (d < md && d > 0) {
        var nx = dx / d, ny = dy / d, ov = md - d;
        b.x += nx * ov; b.y += ny * ov;
        var dot = b.vx * nx + b.vy * ny;
        b.vx = (b.vx - 2 * dot * nx) * this.options.bounce;
        b.vy = (b.vy - 2 * dot * ny) * this.options.bounce;
        b.av = b.vx * 0.03;
        this.send({ t: 'evt', k: 'rim', x: Math.round(rx), y: Math.round(ry) });
      }
    }
    if (!b.scored && b.shooter) {
      var inX = b.x > rimLeftX && b.x < rimRightX;
      var crossedDown = b._prevY <= hoop.y && b.y > hoop.y;
      var crossedUp = b._prevY >= hoop.y && b.y < hoop.y;
      var correct = (b.target === 'any') || (hoop.side === b.target);
      if (inX && crossedUp && b.vy < 0 && correct) b._below = true;
      if (inX && crossedDown && b.vy > 0 && correct) {
        var pts = b._below ? 1 : (this.isThree(b._originX, hoop.side) ? 3 : 2);
        var scorer = b.shooter;
        this.players[scorer].score += pts;
        this.players[scorer].made++;
        b.scored = true;
        var cx = hoop.side === 'left' ? hoop.x + HOOP_W / 2 : hoop.x - HOOP_W / 2;
        var py = hoop.y + 60;
        this.send({ t: 'evt', k: 'score', x: Math.round(b.x), y: Math.round(b.y), px: Math.round(cx), py: Math.round(py), pts: pts, c: COLORS[scorer], by: scorer });
        this.onScoreFrenzy();
      }
    }
  }

  // Every `pointsPer` COMBINED points, add `bonusSecs` to the clock.
  onScoreFrenzy() {
    var total = this.players[1].score + this.players[2].score;
    var reached = Math.floor(total / this.options.pointsPer);
    if (reached > this.bonusCount) {
      var add = (reached - this.bonusCount) * this.options.bonusSecs;
      this.gameTimer += add; this.bonusCount = reached;
      this.send({ t: 'evt', k: 'bonus', add: add, total: total });
    }
    this.sendState();
  }

  updateClocksFrenzy() {
    if (this.phase !== 'playing') return;
    var t = now();
    // Hold the clock before tip-off and whenever either player is away.
    if (!this.started || !this.connected[1] || !this.connected[2]) { this.lastGameClock = t; return; }
    var el = (t - this.lastGameClock) / 1000;
    if (el >= 1) {
      this.gameTimer -= Math.floor(el); this.lastGameClock = t;
      if (this.gameTimer <= 0) { this.gameTimer = 0; this.sendState(); this.gameOver(); return; }
      this.sendState();
    }
  }

  ballsArray() {
    var out = [];
    for (var k = 0; k < this.balls.length; k++) {
      var b = this.balls[k];
      out.push({ i: b.i, x: Math.round(b.x), y: Math.round(b.y), r: Math.round(b.rot * 100) / 100, h: this.heldByOf(b.i), g: b.grounded ? 1 : 0, s: b.shooter || 0 });
    }
    return out;
  }
  sendBalls(force) {
    var t = now();
    if (!force && t - this.lastBallSent < BALLS_SEND_MS) return;
    var arr = this.ballsArray();
    var sig = JSON.stringify(arr);
    if (!force && sig === this._lastBallsStr) { this.lastBallSent = t; return; }
    this._lastBallsStr = sig; this.lastBallSent = t;
    this.send({ t: 'balls', b: arr });
  }

  // ---- broadcast ----
  sendBall(force, contact) {
    var t = now();
    if (!force && t - this.lastBallSent < BALL_SEND_MS) return;
    this.lastBallSent = t;
    var b = this.ball;
    var m = { t: 'ball', x: Math.round(b.x), y: Math.round(b.y), r: Math.round(b.rot * 100) / 100, g: b.grounded ? 1 : 0 };
    if (contact) m.f = 1;
    this.send(m);
  }
  stateObj() {
    var p = this.players;
    if (this.mode === 'frenzy') {
      return {
        md: 'frenzy', s1: p[1].score, s2: p[2].score, h1: p[1].shots, h2: p[2].shots,
        m1: p[1].made, m2: p[2].made, gt: this.gameTimer, ph: this.phase, pp: this.options.pointsPer
      };
    }
    return {
      s1: p[1].score, s2: p[2].score, h1: p[1].shots, h2: p[2].shots,
      m1: p[1].made, m2: p[2].made, o1: p[1].turnovers, o2: p[2].turnovers,
      cp: this.currentPlayer, sc: this.shotClock, gt: this.gameTimer, hf: this.half,
      sw: this.sidesSwapped ? 1 : 0, gr: this.ball.grounded ? 1 : 0, wn: this.waitingForNextTurn ? 1 : 0, ph: this.phase
    };
  }
  sendState() { this.send(Object.assign({ t: 'state' }, this.stateObj())); }
  sendTurn() { this.send({ t: 'turn', cp: this.currentPlayer, sc: this.shotClock, gt: this.gameTimer }); }
  sendPhase(ph) { this.send({ t: 'phase', ph: ph, cp: this.currentPlayer, gt: this.gameTimer, hf: this.half, sw: this.sidesSwapped ? 1 : 0 }); }
}

module.exports = { Match: Match, sanitizeOptions: sanitizeOptions };
