/* ============================================================
   gesture.js — freehand path gestures: recording, playback path
   drawing, and note scheduling.
   ============================================================ */

// A gesture "moved" when the finger travelled far enough from its start to be
// a drag rather than a tap.
function gestureMoved(g) {
  const n = g.pts.length;
  if (n === 0) return false;
  return Math.abs(g.pts[n - 1].x - g.startX) + Math.abs(g.pts[n - 1].y - g.startY) > TAP_THRESHOLD;
}

// ---- Freehand path gestures ----
// A gesture is one continuous freehand path recorded while the finger is
// down. Each point's horizontal travel adds time (left and right both count),
// so cumTime grows along the path: a vertical line is near-instant, a long
// horizontal one makes a long note. The path's absolute screen Y sets the
// volume. While the note plays a small circle travels along the path turning
// the played portion into a glowing green solid line.

function addPathPoint(ds, x, y) {
  const last = ds.pts[ds.pts.length - 1];
  const dx = x - last.x, dy = y - last.y;
  if (Math.abs(dx) + Math.abs(dy) < 3) return;        // throttle: ~3px of travel per point
  const wPct = Math.abs(dx) / Math.max(1, W) * 100;   // horizontal travel, % of width
  const dt = wPct * TIME_PER_W * GESTURE.timeMult;    // ms this step adds
  ds.pts.push({ x, y });
  ds.cumTime.push(ds.totalMs + dt);
  ds.totalMs += dt;
  ds.lastMoveAt = performance.now();
}

// Where the playback circle is along the path at elapsed time `t` (ms):
// interpolated { x, y, idx, frac }. Zero-duration segments (vertical steps)
// are passed over instantly.
function pathStateAtTime(pts, cum, t) {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0, idx: 0, frac: 0 };
  if (t <= 0) return { x: pts[0].x, y: pts[0].y, idx: 0, frac: 0 };
  const last = cum[n - 1];
  if (t >= last) return { x: pts[n - 1].x, y: pts[n - 1].y, idx: n - 1, frac: 1 };
  for (let i = 0; i < n - 1; i++) {
    if (t < cum[i + 1]) {
      const span = cum[i + 1] - cum[i];
      const f = span > 0.0001 ? Math.max(0, Math.min(1, (t - cum[i]) / span)) : 1;
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * f,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * f,
        idx: i, frac: f,
      };
    }
  }
  return { x: pts[n - 1].x, y: pts[n - 1].y, idx: n - 1, frac: 1 };
}

// While the tap-note attack is enabled for gestures, the volume is faded in
// over the first `attackMs` of the gesture's own timeline: each ms plays
// base volume × (t / attackMs), so a fluctuating base is scaled by the
// fade factor at every moment. After the window the factor is 1.
function attackFactor(tMs, atkMs) {
  return atkMs > 0 ? Math.min(1, tMs / atkMs) : 1;
}

// Decay mirrors the attack and is applied right after it: the attack fades the
// volume IN from 0 to the gesture's own volume over the first `atkMs`, then the
// decay fades it OUT from the 100% volume point (where the attack ends) down to
// the decay's end volume over `decMs`. `fadeProg` is how far the note's fade
// domain has progressed in ms. Without an attack the decay starts right away at
// the note's start (the 100% volume point is the very beginning).
function decayFactor(fadeProg, atkMs, decMs) {
  if (!(decMs > 0)) return 1;
  const start = atkMs > 0 ? atkMs : 0;
  const p = Math.min(1, Math.max(0, (fadeProg - start) / decMs));
  return 1 - (1 - decayEndVol()) * p;
}

// How far a live note's fade domain has progressed in ms — the attack occupies
// the first atkMs and the decay the decMs right after it. Like the attack's
// progress, it follows the gesture's note time while drawing and keeps moving
// with real time during a hold.
function liveFadeProgress(ds) {
  return Math.max(ds.totalMs || 0, performance.now() - (ds.startedAt || 0));
}

// Sample the volume the path produces at N evenly-spaced times across its
// duration. The attack and decay fades are baked into each sample. For
// near-vertical paths (almost no time) the samples walk the path by index
// instead so the note still sweeps its Y range in a short blip.
function buildVolumeCurve(pts, cum, totalMs, N, atkMs, decMs) {
  const curve = new Float32Array(N);
  if (totalMs < MIN_GESTURE_MS) {
    for (let k = 0; k < N; k++) {
      const idx = Math.min(pts.length - 1, Math.round((k / (N - 1)) * (pts.length - 1)));
      const t = totalMs * k / (N - 1);
      curve[k] = volumeFromStartY(pts[idx].y) * attackFactor(t, atkMs) * decayFactor(t, atkMs, decMs);
    }
    return curve;
  }
  for (let k = 0; k < N; k++) {
    const t = (totalMs * k) / (N - 1);
    curve[k] = volumeFromStartY(pathStateAtTime(pts, cum, t).y) * attackFactor(t, atkMs) * decayFactor(t, atkMs, decMs);
  }
  return curve;
}

// WAIT MODE: the whole note is scheduled once the gesture is released. The
// volume profile is played with a single setValueCurveAtTime (128 samples,
// attack fade baked in) plus a fade-out tail. The visual shows immediately;
// the audio waits for the AudioContext to actually be running so the first
// gesture on a fresh load isn't dropped.
function schedulePathPlayback(ds) {
  initAudio();
  const totalMs = Math.max(MIN_GESTURE_MS, ds.totalMs || 0);
  const atkMs = gestureAttackMs();
  const decMs = gestureDecayMs();
  const relMs = gestureReleaseMs();
  const tail = buildGesturePlaybackPath(ds.pts, ds.cumTime, ds.totalMs || 0, atkMs, decMs, relMs);
  playbacks.push({
    pts: tail.pts, cumTime: tail.cum, atkMs, decMs, tailEnd: tail.tailEnd,
    totalMs: totalMs + relMs, relMs, startedAt: performance.now(), released: true,
  });
  ensureAudioRunning(() => schedulePathAudio(ds, totalMs, atkMs, decMs, relMs), Date.now() + 30000);
}

// LIVE MODE: the note begins as soon as the finger moves past the tap
// threshold. The audio clock is real time, so each newly-recorded path point
// is scheduled at the audio time its horizontal travel implies. If the circle
// catches the fingertip (the user is drawing slower than the playback clock),
// later points schedule in the past and are chased with setTargetAtTime, which
// makes the sound hold at the fingertip's volume and resume as the finger
// moves again.
function startLivePathNote(ds) {
  initAudio();
  ds.started = true;   // stop repeated pointermoves from double-starting the note
  // The visual shows immediately; only the audio waits for the AudioContext
  // to be running, since a freshly-created context is still suspended on the
  // very first load and events scheduled at currentTime 0 would be missed.
  ds.playback = { ds, pts: [], cumTime: [], atkMs: gestureAttackMs(), totalMs: 0, decMs: gestureDecayMs(), relMs: 0, startedAt: performance.now(), released: false };
  syncLivePlaybackPath(ds);
  playbacks.push(ds.playback);
  ensureLiveAudio(ds, Date.now() + 30000);
}

// Rebuild a live playback's path so it always matches the gesture so far.
// The release tail is added on finger-up.
function syncLivePlaybackPath(ds) {
  if (!ds.playback) return;
  const path = buildGesturePlaybackPath(ds.pts, ds.cumTime, ds.totalMs || 0, gestureAttackMs(), ds.decMs || 0, 0);
  ds.playback.pts = path.pts;
  ds.playback.cumTime = path.cum;
  ds.playback.tailEnd = path.tailEnd;
}


// End one plant gesture (one finger lifted). A tap (no real path) plays the
// default ADSR note; a drag finishes the freehand path — waiting for the
// gesture to complete in wait mode, or wrapping up the already-running live
// note. Other fingers' gestures keep going.
function finishPlantGesture(ds) {
  if (!ds) return;
  // A live note is already running for this finger — wrap it up no matter where
  // the finger ended. Otherwise a path that finishes back near its start (or a
  // slightly-jittery tap) would be read as a tap, and its already-started
  // oscillator would never be stopped, so the sound would keep playing forever.
  if (ds.started) {
    ds.finished = true;
    finishLivePathNote(ds);
    return;
  }
  if (!gestureMoved(ds)) {
    if (GESTURE.allowTapNotes) {
      // ---- Tap: default ADSR note (taps overlap and each keeps its own HUD) ----
      ds.attack = FIXED.attack.on ? FIXED.attack.value : TAP_ATTACK_MS;
      const note = startGestureNote(ds.startX, ds.startY, ds.attack,
                                    FIXED.attack.on ? FIXED.attack.vol : undefined);
      scheduleFixedRun(note, 1);
    } else {
      // Tap notes disabled: a tap behaves like a ~0-length gesture — a very
      // short note that follows the same gesture scheduling rules (volume from
      // the tap's Y, pitch from its X, min note length, playback visualization).
      schedulePathPlayback(ds);
    }
  } else if (GESTURE.waitForGesture) {
    // ---- Gesture: freehand path (wait mode) ----
    schedulePathPlayback(ds);
  }
}

// Abort one plant gesture (pointer cancelled): kill its live note and drop its
// on-screen playback, leaving every other finger's gesture alone.
function cancelDragState(ds) {
  if (ds.gain) {
    try {
      const now = audioCtx.currentTime;
      clearTimeout(ds.cleanupTimer);
      ds.gain.cancelScheduledValues(now);
      ds.gain.setValueAtTime(ds.gain.value, now);
      ds.gain.linearRampToValueAtTime(0, now + 0.03);
      ds.osc.stop(now + 0.05);
      setTimeout(() => { try { ds.osc.disconnect(); if (ds.gainNode) ds.gainNode.disconnect(); } catch (e) {} }, 200);
    } catch (e) {}
    unregisterNote(ds);
  }
  if (ds.playback) {
    const i = playbacks.indexOf(ds.playback);
    if (i >= 0) playbacks.splice(i, 1);
  }
}

/* ---- Path drawing (screen space) ---- */
const GESTURE_GREEN = '#3ecb5a';   // glowing green for the played portion
const GESTURE_AMBER = '#f5a623';   // amber while the attack fades the volume in

// Index of the first path point at or past the attack window's end (cum >=
// atkMs). Points before it are inside the attack fade. 0 when there is no
// attack; the whole path stays inside the window when it is shorter than it.
function attackEndIdx(cum, atkMs) {
  if (!(atkMs > 0)) return 0;
  for (let i = 0; i < cum.length; i++) if (cum[i] >= atkMs) return i;
  return cum.length - 1;
}

function drawDottedPath(pts) {
  ctx.strokeStyle = 'rgba(46,93,52,0.55)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([7, 9]);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(46,93,52,0.7)';
  ctx.beginPath();
  ctx.arc(pts[0].x, pts[0].y, 4, 0, Math.PI * 2);
  ctx.fill();
}

// Solid glowing line from the path's start up to the playback point `st`.
// The part inside the attack + decay envelope window and the appended release
// tail (from envEnd / tailEnd on) are amber; the gesture's own played path
// between them is green.
function drawGreenPath(pts, st, envEnd, tailEnd) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  const N = pts.length;
  if (tailEnd == null) tailEnd = N;
  const hasEnv = envEnd > 0 && envEnd < N;
  // Green starts after the envelope window (or at the path start with no
  // attack/decay) and ends where the release tail begins.
  const greenFrom = hasEnv ? Math.min(envEnd, tailEnd) : 0;

  const seg = (from, to, amber) => {
    if (from > to) return;
    ctx.strokeStyle = amber ? GESTURE_AMBER : GESTURE_GREEN;
    ctx.shadowColor = amber ? 'rgba(245,166,35,0.9)' : 'rgba(62,203,90,0.9)';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(pts[Math.max(0, from)].x, pts[Math.max(0, from)].y);
    for (let i = Math.max(1, from + 1); i <= to && i < N; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (to === st.idx && st.idx < N - 1) ctx.lineTo(st.x, st.y);
    ctx.stroke();
  };

  const playedTo = st.idx;
  if (playedTo < greenFrom) {
    // Playback still inside the attack/decay envelope window: all amber.
    seg(0, playedTo, true);
  } else {
    seg(0, greenFrom - 1, true);                                  // attack + decay window
    seg(greenFrom, Math.min(playedTo, tailEnd - 1), false);       // own played path
    seg(tailEnd, playedTo, true);                                 // release tail
  }
  ctx.shadowBlur = 0;
}

// Dotted line for the portion ahead of the playback point. The unplayed path
// inside the attack + decay envelope window and the appended release tail (from
// envEnd / tailEnd on) are faint amber; the rest of the gesture's own unplayed
// path keeps the normal dotted color.
function drawDottedTail(pts, cum, st, envEnd, tailEnd) {
  if (st.idx >= pts.length - 1) return;
  const seg = (from, to, color, dash) => {
    if (from > to) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash(dash);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[from - 1].x, pts[from - 1].y);
    for (let i = from; i <= to; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  };
  const amberTo = Math.min(envEnd, tailEnd) - 1;
  if (envEnd > 0 && st.idx < amberTo) seg(st.idx + 1, amberTo, 'rgba(245,166,35,0.5)', [4, 10]);
  if (st.idx < tailEnd - 1) seg(Math.max(st.idx + 1, envEnd), tailEnd - 1, 'rgba(46,93,52,0.55)', [7, 9]);
  if (st.idx < pts.length - 1) seg(Math.max(st.idx + 1, tailEnd), pts.length - 1, 'rgba(245,166,35,0.5)', [4, 10]);
  ctx.setLineDash([]);
}

// Build the playback path a gesture's note follows: the gesture's own path,
// then an appended release tail. The attack and decay no longer add a tail —
// they fade the volume in place over the path's first `attackMs` and the
// `decayMs` right after it, so they add no time. The release tail is a straight
// line in X=time / Y=volume space stretched over its duration of horizontal
// travel, starting from the envelope level the note reaches at the gesture's
// end (decayed, if the decay is applied). Returns { pts, cum, tailEnd }.
function buildGesturePlaybackPath(pts, cum, pathMs, atkMs, decMs, relMs) {
  if (!pts.length) return { pts, cum, tailEnd: pts.length };
  const end = pts[pts.length - 1];
  let out = pts.slice();
  let outc = cum.slice();

  let tailEnd = out.length;
  if (relMs > 0) {
    const px = relMs / (TIME_PER_W * GESTURE.timeMult) * W / 100;
    const base = volumeFromStartY(end.y);
    const envAtEnd = attackFactor(pathMs, atkMs) * decayFactor(pathMs, atkMs, decMs);
    const startY = yForVolume(base * envAtEnd);
    const endY = yForVolume(base * envAtEnd * (FIXED.release.vol / 100));
    for (let i = 1; i <= RELEASE_TAIL_STEPS; i++) {
      const t = i / RELEASE_TAIL_STEPS;
      out.push({ x: end.x + px * t, y: startY + (endY - startY) * t });
      outc.push(pathMs + relMs * t);
    }
  }
  return { pts: out, cum: outc, tailEnd };
}

function drawPlaybackCircle(x, y, alpha) {
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = GESTURE_GREEN;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 3;
  ctx.shadowColor = 'rgba(62,203,90,0.9)';
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}
