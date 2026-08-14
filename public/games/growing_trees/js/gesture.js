/* ============================================================
   gesture.js — freehand path gestures: recording, playback path
   drawing, and note scheduling.
   ============================================================ */

// ---- Freehand path gestures ----
// A gesture is one continuous freehand path recorded while the finger is
// down. Each point's horizontal travel adds time (left and right both count),
// so cumTime grows along the path: a vertical line is near-instant, a long
// horizontal one makes a long note. The path's absolute screen Y sets the
// volume. While the note plays a small circle travels along the path turning
// the played portion into a glowing solid line colored by the scale degree it
// plays at each point (the vibrant version of the pitch-zone band color).
// Every touch is a gesture — a tap is just a very short one (near-zero
// horizontal travel), sharing the exact same start/play/release flow.

function addPathPoint(ds, x, y) {
  const last = ds.pts[ds.pts.length - 1];
  const dx = x - last.x, dy = y - last.y;
  if (Math.abs(dx) + Math.abs(dy) < 3) return;        // throttle: ~3px of travel per point
  const wPct = Math.abs(dx) / Math.max(1, W) * 100;   // horizontal travel, % of width
  const dt = wPct * TIME_PER_W / GESTURE.timeMult;    // ms this step adds
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

// How far a live note's playhead has progressed in ms — the envelope body's
// relative value follows this. It advances with the gesture's note time while
// drawing and with real time during a hold, so a held note keeps playing.
function liveFadeProgress(ds) {
  return Math.max(ds.totalMs || 0, performance.now() - (ds.startedAt || 0));
}

// Sample the gain the gesture produces at N evenly-spaced times across its
// body: the base volume at each point scaled by the envelope's pre-release
// shape (one pass — the value holds once the body domain is exhausted). The
// caller passes the body's total length (the note length, extended through the
// early-cut marker), so a tap's components all play before the release section.
// For near-vertical paths (almost no time) the samples walk the path by index
// instead so the note still sweeps its Y range in a short blip, and the
// envelope's relative value still advances over the MINIMUM note length rather
// than stalling at the attack start.
function buildVolumeCurve(pts, cum, totalMs, N) {
  const curve = new Float32Array(N);
  const noteMs = Math.max(MIN_GESTURE_MS, totalMs);
  if (totalMs < MIN_GESTURE_MS) {
    for (let k = 0; k < N; k++) {
      const idx = Math.min(pts.length - 1, Math.round((k / (N - 1)) * (pts.length - 1)));
      const t = noteMs * k / (N - 1);
      curve[k] = baseVolumeFromY(pts[idx].y) * relValueBody(ENVELOPE, t, false);
    }
    return curve;
  }
  for (let k = 0; k < N; k++) {
    const t = (totalMs * k) / (N - 1);
    curve[k] = baseVolumeFromY(pathStateAtTime(pts, cum, t).y) * relValueBody(ENVELOPE, t, false);
  }
  return curve;
}

// WAIT MODE: the whole note is scheduled once the gesture is released. The
// body's volume profile is played with a single setValueCurveAtTime (128
// samples, envelope shape baked in) plus the release section and a fade-out
// tail. The visual shows immediately; the audio waits for the AudioContext to
// actually be running so the first gesture on a fresh load isn't dropped.
function schedulePathPlayback(ds) {
  initAudio();
  const totalMs = Math.max(MIN_GESTURE_MS, ds.totalMs || 0);
  const relMs = compsMs(ENVELOPE.components.slice(ENVELOPE.beginReleaseIndex));
  const cutMs = earlyCutMs();
  const tail = buildGesturePlaybackPath(ds.pts, ds.cumTime, ds.totalMs || 0, relMs, cutMs);
  playbacks.push({
    pts: tail.pts, cumTime: tail.cum, tailEnd: tail.tailEnd,
    totalMs: Math.max(totalMs, cutMs) + relMs, relMs, startedAt: performance.now(), released: true, looped: false,
    color: degreeColorForX(ds.startX),
  });
  ensureAudioRunning(() => schedulePathAudio(ds, totalMs), Date.now() + 30000);
}

// LIVE MODE: the note begins the moment the finger touches down (a tap is just
// a gesture with no travel). The audio clock is real time, so each
// newly-recorded path point is scheduled at the audio time its horizontal
// travel implies. If the circle catches the fingertip (the user is drawing
// slower than the playback clock), later points schedule in the past and are
// chased with setTargetAtTime, which makes the sound hold at the fingertip's
// volume and resume as the finger moves again.
function startLivePathNote(ds) {
  initAudio();
  ds.started = true;   // stop repeated pointermoves from double-starting the note
  // The visual shows immediately; only the audio waits for the AudioContext
  // to be running, since a freshly-created context is still suspended on the
  // very first load and events scheduled at currentTime 0 would be missed.
  ds.playback = { ds, pts: [], cumTime: [], totalMs: 0, relMs: 0, startedAt: performance.now(), released: false, looped: true, color: degreeColorForX(ds.startX) };
  syncLivePlaybackPath(ds);
  playbacks.push(ds.playback);
  ensureLiveAudio(ds, Date.now() + 30000);
}

// Rebuild a live playback's path so it always matches the gesture so far.
// The release tail is added on finger-up.
function syncLivePlaybackPath(ds) {
  if (!ds.playback) return;
  const path = buildGesturePlaybackPath(ds.pts, ds.cumTime, ds.totalMs || 0, 0);
  ds.playback.pts = path.pts;
  ds.playback.cumTime = path.cum;
  ds.playback.tailEnd = path.tailEnd;
}


// End one plant gesture (one finger lifted). In live mode the note has been
// running since the finger touched down, so just wrap it up; in wait mode the
// whole note is scheduled now the path is complete. Other fingers' gestures
// keep going.
function finishPlantGesture(ds) {
  if (!ds) return;
  if (ds.started) {
    ds.finished = true;
    finishLivePathNote(ds);
    return;
  }
  if (GESTURE.waitForGesture) {
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

// The vibrant color of the scale degree played at screen X — the same color
// family as the faint pitch-zone bands, at full strength.
function degreeColorForX(sx) {
  const positions = pitchPositions();
  return DEGREE_COLORS[positions[pitchIndexForX(sx)].degree - 1];
}

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
  // Band labels at the bottom of each band, in black: either the note name
  // (letter only) or the scale degree, per PITCH_ZONES.labelMode. Skipped when
  // the band is too narrow for the label to fit without overlapping its
  // neighbor.
  ctx.fillStyle = '#000';
  ctx.font = '600 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let i = 0; i < n; i++) {
    const label = PITCH_ZONES.labelMode === 'degree'
      ? String(positions[i].degree)
      : noteNameForPos(positions[i]).replace(/\d+$/, '');
    if (ctx.measureText(label).width > bw - 4) continue;
    ctx.fillText(label, i * bw + bw / 2, H - 6);
  }
}

// The gesture path is always drawn at the finger's own Y. The line's thickness
// conveys the relative value at that point — the percentage of the path's base
// volume actually being output: the envelope's body shape scales the base
// volume, and the release section fades it on the tail. A relative value of 0
// draws the thinnest line, 1 the fullest.
const SOLID_MAX_W = 6, SOLID_MIN_W = 1;        // played solid line
const DOTTED_MAX_W = 3.2, DOTTED_MIN_W = 0.7;  // dotted lines (live path, unplayed tail)

// Relative value at the path point with index `i`. Points before tailEnd are
// the gesture's own body (the envelope's pre-release shape, looped while the
// finger is down); points from tailEnd on are the appended release tail.
function pointRelVol(cum, i, tailEnd, looped) {
  if (i < tailEnd) return relValueBody(ENVELOPE, cum[i], looped);
  const pathMs = tailEnd > 0 ? (cum[tailEnd - 1] || 0) : 0;
  // The release starts from the real-time value the body was playing when the
  // tail was entered — e.g. the value mid-hold-loop at the lift — never a
  // static chained start, so the drawn thickness matches the audio's level.
  const bodyEnd = relValueBody(ENVELOPE, pathMs, looped);
  return relValueRelease(ENVELOPE, (cum[i] || 0) - pathMs, bodyEnd);
}

// Same, for an interpolated playback state ({ idx, frac }).
function stateRelVol(cum, st, tailEnd, looped) {
  const t = cumAtState(cum, st);
  if (st.idx < tailEnd) return relValueBody(ENVELOPE, t, looped);
  const pathMs = tailEnd > 0 ? (cum[tailEnd - 1] || 0) : 0;
  const bodyEnd = relValueBody(ENVELOPE, pathMs, looped);
  return relValueRelease(ENVELOPE, t - pathMs, bodyEnd);
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

function drawDottedPath(pts, cum) {
  ctx.strokeStyle = 'rgba(46,93,52,0.55)';
  ctx.setLineDash([7, 9]);
  ctx.lineCap = 'round';
  // Each segment is stroked at the finger's own Y with a width that tracks the
  // envelope body's relative value at that point. lineDashOffset keeps the
  // dash pattern continuous across segments.
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const relVol = pointRelVol(cum, i, pts.length, true);
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
  ctx.arc(pts[0].x, pts[0].y, 2 + 2 * pointRelVol(cum, 0, pts.length, true), 0, Math.PI * 2);
  ctx.fill();
}

// Solid glowing line from the path's start up to the playback point `st`,
// colored by the scale degree of the color band the gesture began in — the
// vibrant version of that band's faint color, held for the whole gesture. The
// line's thickness conveys the relative volume at that point (the attack +
// decay fades on the own path, the release fade on the tail), so the component
// volumes still shape the width.
function drawGreenPath(pts, cum, st, tailEnd, looped, color) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const N = pts.length;
  if (tailEnd == null) tailEnd = N;

  ctx.shadowBlur = 14;
  ctx.strokeStyle = color;
  ctx.shadowColor = withAlpha(color, 0.9);
  // Each segment is stroked at the path's own Y with a width that tracks the
  // relative value at that point (the envelope body on the own path, the
  // release section on the tail).
  for (let i = 1; i <= st.idx && i < N; i++) {
    ctx.lineWidth = widthForRelVol(pointRelVol(cum, i, tailEnd, looped), SOLID_MIN_W, SOLID_MAX_W);
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  if (st.idx < N - 1) {
    ctx.lineWidth = widthForRelVol(stateRelVol(cum, st, tailEnd, looped), SOLID_MIN_W, SOLID_MAX_W);
    ctx.beginPath();
    ctx.moveTo(pts[st.idx].x, pts[st.idx].y);
    ctx.lineTo(st.x, st.y);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

// Dotted line for the portion ahead of the playback point, so the unplayed
// path stays visible until the note reaches it. It uses the gesture's own
// color, drawn very thin.
function drawDottedTail(pts, cum, st, tailEnd, color) {
  if (st.idx >= pts.length - 1) return;
  // Absolute distance along the polyline from pts[0] to each point, used to
  // anchor the dash phase to the path itself. Anchoring to the drawn range
  // instead would shift the dots every frame as the played range advances.
  const cumLen = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cumLen[i] = cumLen[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([7, 9]);
  ctx.lineCap = 'round';
  for (let i = Math.max(st.idx + 1, 1); i < pts.length; i++) {
    ctx.lineDashOffset = -cumLen[i - 1];
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

// Build the playback path a gesture's note follows: the gesture's own path,
// then an appended release tail. The body components don't add time — they
// scale the relative value in place over the path. When the gesture's body is
// shorter than the early-cut marker (`cutMs`), a horizontal continuation at the
// finger's end Y extends the body through the cut so the played line and its
// thickness animation run as long as the audio body. The release tail is a
// straight line in X=time space stretched over the release section's duration
// of horizontal travel, starting at the cut (or the path end if there is none);
// it stays at the finger's end Y and its thickness fades out instead of
// dropping in Y. Returns { pts, cum, tailEnd }.
function buildGesturePlaybackPath(pts, cum, pathMs, relMs, cutMs) {
  if (!pts.length) return { pts, cum, tailEnd: pts.length };
  const end = pts[pts.length - 1];
  let out = pts.slice();
  let outc = cum.slice();
  // Time-to-screen: horizontal travel, same scale as the release tail below
  // (px per ms of note time).
  const pxPerMs = (W / 100) * GESTURE.timeMult / TIME_PER_W;

  let tailEnd = out.length;
  let tailStartX = end.x;
  if (cutMs != null && cutMs > pathMs) {
    // The audio body plays on through the early-cut marker even though the
    // drawn path is already done: extend the line horizontally (X = time), at
    // the finger's end Y, exactly like the release tail, so the playhead keeps
    // moving and the thickness keeps animating (the envelope body's shape) for
    // the rest of the body.
    const contPx = (cutMs - pathMs) * pxPerMs;
    for (let i = 0; i <= RELEASE_TAIL_STEPS; i++) {
      const t = i / RELEASE_TAIL_STEPS;
      out.push({ x: end.x + contPx * t, y: end.y });
      outc.push(pathMs + (cutMs - pathMs) * t);
    }
    tailEnd = out.length;
    tailStartX = end.x + contPx;
  }
  if (relMs > 0) {
    const tailStartMs = cutMs != null ? Math.max(cutMs, pathMs) : pathMs;
    const px = relMs * pxPerMs;
    // The first tail point sits exactly at the finger's end position so the
    // solid played line flows straight into the tail with no gap.
    for (let i = 0; i <= RELEASE_TAIL_STEPS; i++) {
      const t = i / RELEASE_TAIL_STEPS;
      out.push({ x: tailStartX + px * t, y: end.y });
      outc.push(tailStartMs + relMs * t);
    }
  }
  return { pts: out, cum: outc, tailEnd };
}

function drawPlaybackCircle(x, y, alpha, relVol, color) {
  const v = Math.max(0, Math.min(1, relVol == null ? 1 : relVol));
  const r = 2 + 4 * v;
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(1.5, 3 * v);
  ctx.shadowColor = withAlpha(color, 0.9);
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}
