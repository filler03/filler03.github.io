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

// While the tap-note attack is enabled for gestures, the relative volume is
// faded in over the first `attackMs` of the gesture's own timeline: each ms
// plays base volume × (t / attackMs), so a fluctuating base volume is scaled by
// the relative volume at every moment. After the window the relative volume is 1.
function attackRelVol(tMs, atkMs) {
  return atkMs > 0 ? Math.min(1, tMs / atkMs) : 1;
}

// Decay mirrors the attack and is applied right after it: the attack fades the
// relative volume IN from 0 to 1 over the first `atkMs`, then the decay fades
// it OUT from 1 down to the decay's end relative volume over `decMs`.
// `fadeProg` is how far the note's fade domain has progressed in ms. Without an
// attack the decay starts right away at the note's start (1 is the beginning).
function decayRelVol(fadeProg, atkMs, decMs) {
  if (!(decMs > 0)) return 1;
  const start = atkMs > 0 ? atkMs : 0;
  const p = Math.min(1, Math.max(0, (fadeProg - start) / decMs));
  return 1 - (1 - decayEndRelVol()) * p;
}

// How far a live note's relative-volume fade domain has progressed in ms — the
// attack occupies the first atkMs and the decay the decMs right after it. Like
// the attack's progress, it follows the gesture's note time while drawing and
// keeps moving with real time during a hold.
function liveFadeProgress(ds) {
  return Math.max(ds.totalMs || 0, performance.now() - (ds.startedAt || 0));
}

// Sample the gain the gesture produces at N evenly-spaced times across its
// duration: the base volume at each point scaled by the attack and decay
// relative volumes. For near-vertical paths (almost no time) the samples walk
// the path by index instead so the note still sweeps its Y range in a short
// blip.
function buildVolumeCurve(pts, cum, totalMs, N, atkMs, decMs) {
  const curve = new Float32Array(N);
  if (totalMs < MIN_GESTURE_MS) {
    for (let k = 0; k < N; k++) {
      const idx = Math.min(pts.length - 1, Math.round((k / (N - 1)) * (pts.length - 1)));
      const t = totalMs * k / (N - 1);
      curve[k] = baseVolumeFromY(pts[idx].y) * attackRelVol(t, atkMs) * decayRelVol(t, atkMs, decMs);
    }
    return curve;
  }
  for (let k = 0; k < N; k++) {
    const t = (totalMs * k) / (N - 1);
    curve[k] = baseVolumeFromY(pathStateAtTime(pts, cum, t).y) * attackRelVol(t, atkMs) * decayRelVol(t, atkMs, decMs);
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

// Faint, screen-space color zones showing which scale degree each horizontal
// position plays (screen X = pitch). Drawn behind the gestures. Each equal-
// width band matches pitchFor exactly: touching a band plays that degree.
function drawPitchZones() {
  if (!PITCH_ZONES.show) return;
  const positions = pitchPositions();
  const n = positions.length;
  const bw = W / n;
  for (let i = 0; i < n; i++) {
    const color = DEGREE_COLORS[positions[i].degree - 1];
    ctx.fillStyle = withAlpha(color, ZONE_FILL_ALPHA);
    ctx.fillRect(i * bw, 0, Math.max(1, bw), H);
  }
  // A slightly stronger line where a new octave begins, so octave 0 (the key
  // octave) stays readable across the repeating degree colors.
  for (let i = 1; i < n; i++) {
    if (positions[i].degree === 1) {
      ctx.fillStyle = 'rgba(46,93,52,' + OCTAVE_BOUND_ALPHA + ')';
      ctx.fillRect(i * bw, 0, 1, H);
    }
  }
}

// The gesture path is always drawn at the finger's own Y. The line's thickness
// conveys the relative volume at that point — the percentage of the path's base
// volume actually being output: the attack and decay fades scale the base
// volume, and the release tail fades it down to the release's end relative
// volume. A relative volume of 0 draws the thinnest line, 1 the fullest.
const SOLID_MAX_W = 6, SOLID_MIN_W = 1;        // played solid line (amber + green)
const DOTTED_MAX_W = 3.2, DOTTED_MIN_W = 0.7;  // dotted lines (live path, unplayed tail)

function ownPathRelVol(tMs, atkMs, decMs) {
  return attackRelVol(tMs, atkMs) * decayRelVol(tMs, atkMs, decMs);
}

// The release fade's relative volume: 1 right at the tail's start, falling to
// FIXED.release.vol/100 over `relMs`.
function releaseRelVol(progMs, relMs) {
  if (!(relMs > 0)) return 1;
  const p = Math.min(1, Math.max(0, progMs / relMs));
  return 1 - (1 - (FIXED.release.vol || 0) / 100) * p;
}

// Relative volume at the path point with index `i`. Points before tailEnd are
// the gesture's own path (attack + decay fades); points from tailEnd on are the
// appended release tail.
function pointRelVol(cum, i, tailEnd, atkMs, decMs, relMs) {
  if (i < tailEnd) return ownPathRelVol(cum[i], atkMs, decMs);
  const pathMs = tailEnd > 0 ? (cum[tailEnd - 1] || 0) : 0;
  return releaseRelVol((cum[i] || 0) - pathMs, relMs);
}

// Same, for an interpolated playback state ({ idx, frac }).
function stateRelVol(cum, st, tailEnd, atkMs, decMs, relMs) {
  const t = cumAtState(cum, st);
  if (st.idx < tailEnd) return ownPathRelVol(t, atkMs, decMs);
  const pathMs = tailEnd > 0 ? (cum[tailEnd - 1] || 0) : 0;
  return releaseRelVol(t - pathMs, relMs);
}

// Line width for a given relative volume (0 = thinnest, 1 = fullest).
function widthForRelVol(relVol, minW, maxW) {
  return minW + (maxW - minW) * Math.max(0, Math.min(1, relVol));
}

// The note-time (ms) at the playback state `st` ({ idx, frac }): interpolated
// between the neighboring cum entries so the circle lines up with the thickness
// the line was drawn with.
function cumAtState(cum, st) {
  const i = Math.max(0, Math.min(st.idx, cum.length - 1));
  const j = Math.min(i + 1, cum.length - 1);
  return mix(cum[i] || 0, cum[j] || 0, st.frac);
}

// Index of the first path point at or past the relative-volume window's end
// (cum >= ms, where ms is the attack + decay duration). Points before it are
// inside the attack/decay fade, where the relative volume is below 1. 0 when
// there is no attack/decay; the whole path stays inside the window when it is
// shorter than it.
function relVolWindowEndIdx(cum, ms) {
  if (!(ms > 0)) return 0;
  for (let i = 0; i < cum.length; i++) if (cum[i] >= ms) return i;
  return cum.length - 1;
}

function drawDottedPath(pts, cum, atkMs, decMs) {
  ctx.strokeStyle = 'rgba(46,93,52,0.55)';
  ctx.setLineDash([7, 9]);
  ctx.lineCap = 'round';
  // Each segment is stroked at the finger's own Y with a width that tracks the
  // attack/decay relative volume at that point. lineDashOffset keeps the
  // dash pattern continuous across segments.
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const relVol = pointRelVol(cum, i, pts.length, atkMs, decMs, 0);
    ctx.lineWidth = widthForRelVol(relVol, DOTTED_MIN_W, DOTTED_MAX_W);
    ctx.lineDashOffset = -len;
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.fillStyle = 'rgba(46,93,52,0.7)';
  ctx.beginPath();
  ctx.arc(pts[0].x, pts[0].y, 2 + 2 * pointRelVol(cum, 0, pts.length, atkMs, decMs, 0), 0, Math.PI * 2);
  ctx.fill();
}

// Solid glowing line from the path's start up to the playback point `st`.
// The part inside the attack + decay window and the appended release tail (from
// relVolWindowEnd / tailEnd on) are amber; the gesture's own played path
// between them is green.
function drawGreenPath(pts, cum, st, relVolWindowEnd, tailEnd, atkMs, decMs, relMs) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const N = pts.length;
  if (tailEnd == null) tailEnd = N;
  const hasRelVolWindow = relVolWindowEnd > 0 && relVolWindowEnd < N;
  // Green starts after the attack + decay window (or at the path start with no
  // attack/decay) and ends where the release tail begins.
  const greenFrom = hasRelVolWindow ? Math.min(relVolWindowEnd, tailEnd) : 0;

  const seg = (from, to, amber) => {
    if (from > to) return;
    ctx.strokeStyle = amber ? GESTURE_AMBER : GESTURE_GREEN;
    ctx.shadowColor = amber ? 'rgba(245,166,35,0.9)' : 'rgba(62,203,90,0.9)';
    ctx.shadowBlur = 14;
    // Each segment is stroked at the path's own Y with a width that tracks the
    // relative volume at that point (attack + decay on the own path, the
    // release fade on the tail).
    for (let i = Math.max(1, from + 1); i <= to && i < N; i++) {
      ctx.lineWidth = widthForRelVol(pointRelVol(cum, i, tailEnd, atkMs, decMs, relMs), SOLID_MIN_W, SOLID_MAX_W);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    if (to === st.idx && st.idx < N - 1) {
      ctx.lineWidth = widthForRelVol(stateRelVol(cum, st, tailEnd, atkMs, decMs, relMs), SOLID_MIN_W, SOLID_MAX_W);
      ctx.beginPath();
      ctx.moveTo(pts[st.idx].x, pts[st.idx].y);
      ctx.lineTo(st.x, st.y);
      ctx.stroke();
    }
  };

  const playedTo = st.idx;
  if (playedTo < greenFrom) {
    // Playback still inside the attack/decay window: all amber.
    seg(0, playedTo, true);
  } else {
    seg(0, greenFrom - 1, true);                                  // attack + decay window
    seg(greenFrom, Math.min(playedTo, tailEnd - 1), false);       // own played path
    seg(tailEnd, playedTo, true);                                 // release tail
  }
  ctx.shadowBlur = 0;
}

// Dotted line for the portion ahead of the playback point. The unplayed path
// inside the attack + decay window and the appended release tail (from
// relVolWindowEnd / tailEnd on) are faint amber; the rest of the gesture's own
// unplayed path keeps the normal dotted color.
function drawDottedTail(pts, cum, st, relVolWindowEnd, tailEnd, atkMs, decMs, relMs) {
  if (st.idx >= pts.length - 1) return;
  // Absolute distance along the polyline from pts[0] to each point, used to
  // anchor the dash phase to the path itself. Anchoring to the drawn range
  // instead would shift the dots every frame as the played range advances.
  const cumLen = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cumLen[i] = cumLen[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const seg = (from, to, color, dash) => {
    if (from > to) return;
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.lineCap = 'round';
    for (let i = from; i <= to; i++) {
      ctx.lineWidth = widthForRelVol(pointRelVol(cum, i, tailEnd, atkMs, decMs, relMs), DOTTED_MIN_W, DOTTED_MAX_W);
      ctx.lineDashOffset = -cumLen[i - 1];
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  };
  const amberTo = Math.min(relVolWindowEnd, tailEnd) - 1;
  if (relVolWindowEnd > 0 && st.idx < amberTo) seg(st.idx + 1, amberTo, 'rgba(245,166,35,0.5)', [4, 10]);
  if (st.idx < tailEnd - 1) seg(Math.max(st.idx + 1, relVolWindowEnd), tailEnd - 1, 'rgba(46,93,52,0.55)', [7, 9]);
  if (st.idx < pts.length - 1) seg(Math.max(st.idx + 1, tailEnd), pts.length - 1, 'rgba(245,166,35,0.5)', [4, 10]);
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

// Build the playback path a gesture's note follows: the gesture's own path,
// then an appended release tail. The attack and decay no longer add a tail —
// they fade the relative volume in place over the path's first `attackMs` and
// the `decayMs` right after it, so they add no time. The release tail is a
// straight line in X=time space stretched over its duration of horizontal
// travel; it stays at the finger's end Y and its thickness fades out instead of
// dropping in Y. Returns { pts, cum, tailEnd }.
function buildGesturePlaybackPath(pts, cum, pathMs, atkMs, decMs, relMs) {
  if (!pts.length) return { pts, cum, tailEnd: pts.length };
  const end = pts[pts.length - 1];
  let out = pts.slice();
  let outc = cum.slice();

  let tailEnd = out.length;
  if (relMs > 0) {
    const px = relMs / (TIME_PER_W * GESTURE.timeMult) * W / 100;
    // The first tail point sits exactly at the finger's end position so the
    // solid played line flows straight into the tail with no gap.
    for (let i = 0; i <= RELEASE_TAIL_STEPS; i++) {
      const t = i / RELEASE_TAIL_STEPS;
      out.push({ x: end.x + px * t, y: end.y });
      outc.push(pathMs + relMs * t);
    }
  }
  return { pts: out, cum: outc, tailEnd };
}

function drawPlaybackCircle(x, y, alpha, relVol) {
  const v = Math.max(0, Math.min(1, relVol == null ? 1 : relVol));
  const r = 2 + 4 * v;
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = GESTURE_GREEN;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(1.5, 3 * v);
  ctx.shadowColor = 'rgba(62,203,90,0.9)';
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}
