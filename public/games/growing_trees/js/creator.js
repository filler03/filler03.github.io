/* ============================================================
   creator.js — shared sound-editing helpers for the flow editor.
   The legacy full-screen sound creator (its own editor UI, canvas
   render loop, pointer handling, and 'creator' mode) was removed:
   the playing field now picks its instruments from the flow graph
   (see instrument.js). What remains is the set of primitives the
   flow editor reuses to edit its nodes — the envelope boundary and
   draw helpers (envBoundaries, envDrawAt, envDragBoundary, …), the
   wave-spectrum helpers (initLayerSpecPoints, insertSpecPoint, …),
   segment-line rendering (strokeSegPath, segDrawSamples, …), the
   note preview-pitch helpers, and the shared constants
   (HARM_PRESETS, SEGMENT_TYPE_*, VOICE_PARAM_DEFS, VOICE_INTERVALS).
   ============================================================ */


// Shared state persisted by the settings panel. All three creator* fields are
// kept so existing saves still round-trip; only creatorDrawPoints is read here
// (by drawPointCount below) — auto-preview and voice-snap no longer have a UI
// to turn them on, so they stay permanently off.
var creatorDrawPoints = 8;   // 4..HARMONIC_COUNT (clamped)
var creatorAutoPreview = false;
var creatorVoiceSnap = false;
// Hard cap on envelope components created by drawing (the flow editors cap via
// their own insert helpers, raised to HARMONIC_COUNT for drawing).
const ENV_DRAW_MAX = 48;

const tToX = (t, p) => p.left + clamp01(t) * p.pw;
const xToT = (x, p) => clamp01((x - p.left) / p.pw);
const vToY = (v, p) => p.bottom - clamp01(v) * p.ph;
const yToV = (y, p) => clamp01((p.bottom - y) / p.ph);

const HARM_PRESETS = [
  { name: 'sine', label: 'Sine' },
  { name: 'triangle', label: 'Triangle' },
  { name: 'square', label: 'Square' },
  { name: 'sawtooth', label: 'Sawtooth' },
];
function previewPitchName() {
  const positions = pitchPositions();
  const idx = Math.max(0, Math.min(positions.length - 1, PREVIEW_PITCH || 0));
  return positions.length ? noteNameForPos(positions[idx]) : '—';
}
function ampToY(a, p) { return (p.top + p.bottom) / 2 - clampSign(a) * (p.ph / 2); }
function yToAmp(y, p) { return clampSign(((p.top + p.bottom) / 2 - y) / (p.ph / 2)); }

// Build the drawn spectrum from the current amplitudes (merging flat runs so a
// plain preset shows few dots). Amplitudes become the source of truth again
// whenever specPoints is null.
function initLayerSpecPoints(layer) {
  if (layer.specPoints && layer.specPoints.length) return;
  const amps = layer.amplitudes || [];
  const pts = [];
  let last = null;
  for (let i = 0; i < HARMONIC_COUNT; i++) {
    const x = HARMONIC_COUNT > 1 ? i / (HARMONIC_COUNT - 1) : 0;
    const a = clampSign(+amps[i] || 0);
    if (i === 0 || i === HARMONIC_COUNT - 1 || a !== last) {
      pts.push({ x, a });
      last = a;
    }
  }
  layer.specPoints = pts;
}

// Resample the drawn spectrum into the 32 amplitudes.
function syncLayerAmplitudes(layer) {
  if (!layer.specPoints || !layer.specPoints.length) return;
  for (let i = 0; i < HARMONIC_COUNT; i++) {
    layer.amplitudes[i] = specValueAt(layer.specPoints, HARMONIC_COUNT > 1 ? i / (HARMONIC_COUNT - 1) : 0);
  }
  layer.presetId = null;
}

function insertSpecPoint(l, x, a) {
  x = clamp01(x); a = clampSign(a);
  const pts = l.specPoints;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].x - x) < 0.01) { pts[i].a = a; return i; }
  }
  if (pts.length >= 64) return -1;
  pts.push({ x, a });
  pts.sort((p, q) => p.x - q.x);
  return pts.findIndex(pt => pt.x === x && pt.a === a);
}

function removeSpecPoint(l, idx) {
  const pts = l.specPoints;
  if (!pts || !pts.length) return;
  const pt = pts[idx];
  if (!pt) return;
  if (pt.x === 0 || pt.x === 1) return;   // the far-left/right anchors are protected
  if (pts.length <= 2) {
    l.specPoints = [{ x: 0, a: 0 }, { x: 1, a: 0 }];
    syncLayerAmplitudes(l);
    return;
  }
  pts.splice(idx, 1);
  syncLayerAmplitudes(l);
}

function envBoundaries() {
  const env = ENVELOPE;
  const n = env.components.length;
  const b = [];
  for (let i = 0; i <= n; i++) b.push(compsMs(env.components.slice(0, i)));
  const total = designTimeline().total;
  const tOf = ms => (total > 0 ? ms / total : 0);
  const vals = [];
  for (let i = 0; i <= n; i++) {
    vals.push(i === 0
      ? compValue(env.components[0], env.components[0].startValue)
      : compValue(env.components[i - 1], env.components[i - 1].endValue));
  }
  return { env, n, b, tOf, vals, total };
}

// Envelope value at normalized time t (0..1), interpolated across the component
// that contains it.
function envValueAtT(t) {
  const eb = envBoundaries();
  const total = eb.total;
  const ms = clamp01(t) * total;
  for (let i = 0; i < eb.n; i++) {
    if (ms >= eb.b[i] && ms <= eb.b[i + 1]) {
      const span = eb.b[i + 1] - eb.b[i];
      const f = span > 0 ? (ms - eb.b[i]) / span : 0;
      return segValueAt(eb.env.components[i], eb.vals[i], eb.vals[i + 1], f, 1);
    }
  }
  return eb.vals[eb.n];
}

// Split component `c` at time `ms` (add a breakpoint = a new component).
function envSplitAt(c, ms) {
  const env = ENVELOPE;
  const comps = env.components;
  if (c < 0 || c >= comps.length) return;
  const b = envBoundaries().b;
  const start = b[c], end = b[c + 1];
  if (end - start < 2) return;   // too short to split
  ms = Math.max(start + 1, Math.min(end - 1, ms));
  const cc = comps[c];
  const frac = (ms - start) / (end - start);
  const val = segValueAt(cc, compValue(cc, cc.startValue), compValue(cc, cc.endValue), frac, 1);
  comps[c].duration = ms - start;
  const splitSeg = cc.seg && typeof cc.seg === 'object' ? clone(cc.seg) : null;
  comps.splice(c + 1, 0, {
    id: newCompId(),
    name: 'Component',
    duration: end - ms,
    startValue: Math.round(clamp01(val) * 100),
    endValue: cc.endValue,
    seg: splitSeg,
  });
  chainStartValues(ENVELOPE);
  clampEnvelopeIndexes();
}

// Split the envelope component that contains time `ms` at that time.
function envSplitAtTime(ms) {
  const eb = envBoundaries();
  for (let c = 0; c < eb.n; c++) {
    if (ms >= eb.b[c] && ms <= eb.b[c + 1]) { envSplitAt(c, ms); return; }
  }
}

function envDeleteAt(idx) {
  const comps = ENVELOPE.components;
  if (comps.length <= 1) return;
  comps.splice(idx, 1);
  chainStartValues(ENVELOPE);
  clampEnvelopeIndexes();
}

// Drag an envelope boundary: vertical sets the value (chaining the next start),
// horizontal moves the boundary time. The boundary may be dragged freely across
// the note's whole span — the boundary list is re-sorted afterwards, so a point
// can be dragged left or right even when it's densely packed against its
// neighbors (it would otherwise get stuck with no room to move). Values travel
// with the dragged boundary, exactly like the free-dragging curve points.
function envDragBoundary(i, t, v) {
  const env = ENVELOPE;
  const eb = envBoundaries();
  const n = env.components.length;
  const total = eb.total;
  // Collect each boundary's (time ms, relative value 0..1).
  const pts = [];
  for (let k = 0; k <= n; k++) pts.push({ t: eb.b[k], v: eb.vals[k] });
  const value = clamp01(v);
  // Vertical: this boundary's value (the first boundary is the envelope start).
  pts[i].v = value;
  // Horizontal: move this boundary to the dragged time (i >= 1, the first stays
  // pinned at the note start), then keep order by re-sorting.
  if (i >= 1 && i <= n - 1) {
    pts[i].t = clamp01(t) * total;
  }
  pts.sort((a, b) => a.t - b.t);
  // Rebuild each component's duration/end value from the sorted boundaries.
  for (let c = 0; c < n; c++) {
    env.components[c].duration = Math.max(1, Math.round(pts[c + 1].t - pts[c].t));
    env.components[c].endValue = Math.round(clamp01(pts[c + 1].v) * 100);
  }
  env.components[0].startValue = Math.round(clamp01(pts[0].v) * 100);
  chainStartValues(env);
  clampEnvelopeIndexes();
}

/* ---- Segment line types (editor) ----
   Every segment of the edited curve — an envelope component, a mix-curve span,
   or a pitch span — interpolates its two endpoints via one of four shapes:
   Line (the default), Stairs (N steps), Spring (a damped sine wobble), or
   Pulse (a hard square-wave wobble). A segment's config lives on its FROM
   element (the component or the segment's start breakpoint) as { type, stairs,
   freq, depth } — see DEFAULT_SEG / segOf in app.js. Selecting breakpoints
   builds a from→to range and the chosen shape/parameter applies to every
   segment in it (from == to edits a single segment). */
const SEGMENT_TYPE_ORDER = ['line', 'stairs', 'spring', 'pulse'];
const SEGMENT_TYPE_DEFS = { line: { label: 'Line' }, stairs: { label: 'Stairs' }, spring: { label: 'Spring' }, pulse: { label: 'Pulse' } };
const SEGMENT_TYPE_PARAMS = { line: [], stairs: ['stairs'], spring: ['freq', 'depth'], pulse: ['freq', 'depth'] };
const SEG_PARAM_DEFS = {
  stairs: { label: 'Steps', min: 2, max: 16, step: 1,   fmt: v => Math.round(v) + '' },
  freq:   { label: 'Freq',  min: 0.25, max: 16, step: 0.25, fmt: v => (Math.round(v * 100) / 100) + '×' },
  depth:  { label: 'Depth', min: 0, max: 1, step: 0.05,  fmt: v => Math.round(v * 100) + '%' },
};
// How finely a non-line segment is sampled when drawn on screen. The base
// count scales with the segment's shape so high freq wobbles and many steps
// render smooth instead of aliased: ~16 samples per wobble cycle, ~2 per
// stair step, all clamped between the base count and a per-frame cap.
const SEG_DRAW_SAMPLES = 24;
const SEG_SAMPLES_PER_CYCLE = 16;
const SEG_SAMPLES_PER_STEP = 2;
const SEG_DRAW_SAMPLES_MAX = 256;
function segDrawSamples(seg) {
  const n = seg.type === 'stairs'
    ? SEG_SAMPLES_PER_STEP * seg.stairs
    : Math.ceil(SEG_SAMPLES_PER_CYCLE * seg.freq);
  return Math.max(SEG_DRAW_SAMPLES, Math.min(SEG_DRAW_SAMPLES_MAX, n));
}

// Selection state: the selected segment's start/end point indexes (component
// boundaries for the volume envelope, breakpoint indexes for mix/pitch curves).
// Line mode picks one segment at a time by dragging across the graph: from is
// the segment's start point, to is its end point.
function strokeSegPath(pts, scale, yOf) {
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.el && segOf(a.el).type !== 'line') {
      const n = segDrawSamples(segOf(a.el));
      for (let k = 0; k <= n; k++) {
        const f = k / n;
        const x = a.x + (b.x - a.x) * f;
        const y = yOf(segValueAt(a.el, a.v, b.v, f, scale));
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
    } else {
      if (!started) { ctx.moveTo(a.x, a.y); started = true; }
      ctx.lineTo(b.x, b.y);
    }
  }
  ctx.stroke();
}

// The envelope's draw granularity: how many evenly-spaced breakpoints a
// full-width sweep places across the graph (persisted via creatorDrawPoints).
function drawPointCount() { return Math.max(4, Math.min(HARMONIC_COUNT, +creatorDrawPoints || 8)); }
const VOICE_PARAM_DEFS = [
  { key: 'st',  label: 'Semitones', min: -24, max: 24, step: 0.25, fmt: v => (Math.round(v * 100) / 100) + ' st' },
  { key: 'ct',  label: 'Cents',     min: -100, max: 100, step: 1,  fmt: v => Math.round(v) + ' ¢' },
  { key: 'vol', label: 'Volume',    min: 0,  max: 2,  step: 0.01, fmt: v => Math.round(v * 100) + '%' },
];
// Interval presets the flow editor's unison editor can snap voices to.
const VOICE_INTERVALS = [
  { st: -12, label: '−8' },   // lower octave
  { st: 3,  label: 'b3' },    // minor 3rd up
  { st: 4,  label: '3' },     // major 3rd up
  { st: 5,  label: '4' },     // perfect 4th up
  { st: 7,  label: '5' },     // perfect 5th up
  { st: 12, label: '8' },     // upper octave
];
function envDrawAt(t, v, p, loT, hiT, erase, points) {
  const comps = ENVELOPE.components;
  const lo = loT == null ? t : Math.min(loT, hiT);
  const hi = loT == null ? t : Math.max(loT, hiT);
  const cnt = Math.max(4, Math.min(HARMONIC_COUNT, Math.round(+points || drawPointCount())));
  while (comps.length > cnt - 1) {
    const eb0 = envBoundaries();
    let best = -1, bd = Infinity;
    for (let i = 1; i < eb0.n; i++) {
      if (eb0.b[i] < lo * eb0.total - 1 || eb0.b[i] > hi * eb0.total + 1) continue;
      const d = Math.abs(eb0.b[i] - clamp01(t) * eb0.total);
      if (d < bd) { bd = d; best = i; }
    }
    if (best <= 0 || comps.length <= 1) break;
    const c = best - 1;   // the component ending at that boundary
    if (c > 0) {
      comps[c - 1].duration += comps[c].duration;
      comps[c - 1].endValue = comps[c].endValue;
      comps.splice(c, 1);
    } else {
      comps.splice(0, 1);
    }
    chainStartValues(ENVELOPE);
    clampEnvelopeIndexes();
  }
  const eb = envBoundaries();
  const total = eb.total;
  const ms = clamp01(t) * total;
  const dedupeMs = total / (2 * (cnt - 1));
  let best = -1, bd = dedupeMs;
  for (let i = 0; i <= eb.n; i++) {
    const d = Math.abs(eb.b[i] - ms);
    if (d < bd) { bd = d; best = i; }
  }
  // Erase snaps the swept point to the full-volume line rather than the finger's value.
  if (erase) {
    v = 100;
    // Where the envelope is already flat at full volume and there's no nearby
    // boundary to grab, don't split — flat runs stay sparse instead of gaining
    // dots. A nearby boundary (best >= 0) is still dragged below, so a lone
    // point can be picked up and moved even though it's already at full volume.
    const ev = envValueAtT(clamp01(t));
    if (Math.abs(ev - 100) <= 1e-9 && best < 0) return;
  }
  if (best >= 0) { envDragBoundary(best, t, v); return; }
  if (eb.n >= ENV_DRAW_MAX) return;
  envSplitAtTime(ms);
  const eb2 = envBoundaries();
  best = -1; bd = Infinity;
  for (let i = 0; i <= eb2.n; i++) {
    const d = Math.abs(eb2.b[i] - ms);
    if (d < bd) { bd = d; best = i; }
  }
  if (best >= 0) envDragBoundary(best, t, v);
}

/* ---- Note lifetime ----
   The note's lifetime is the sum of every envelope component (body through the
   hold end plus the release tail). setNoteLifetime scales all component
   durations proportionally so the envelope keeps its shape while the whole
   note is stretched or compressed. */
function setNoteLifetime(ms) {
  const comps = ENVELOPE.components;
  const cur = compsMs(comps);
  if (!comps.length || cur <= 0) return;
  ms = Math.max(300, Math.min(10000, ms));
  const k = ms / cur;
  for (const c of comps) c.duration = Math.max(1, Math.round(c.duration * k));
  // Snap the final total to the target by adjusting the last component.
  const diff = ms - compsMs(comps);
  if (comps.length) comps[comps.length - 1].duration = Math.max(1, comps[comps.length - 1].duration + diff);
  clampEnvelopeIndexes();
}

function markerValidTimes(key) {
  const env = ENVELOPE;
  const n = env.components.length;
  const total = designTimeline().total;
  const bounds = [];
  for (let i = 0; i <= n; i++) bounds.push(compsMs(env.components.slice(0, i)));
  const tOf = ms => (total > 0 ? ms / total : 0);
  const times = [];
  if (key === 'hold') {
    // holdStartIndex: any component start boundary at or before the hold end.
    for (let i = 0; i <= Math.min(n - 1, env.holdEndIndex); i++) times.push(tOf(bounds[i]));
  } else if (key === 'cut') {
    // earlyCutIndex: any component end boundary at or before the hold end.
    for (let i = 0; i <= env.holdEndIndex; i++) times.push(tOf(bounds[i + 1]));
  } else { // 'rel'
    // holdEndIndex: any component end boundary across the whole envelope.
    for (let i = 0; i < n; i++) times.push(tOf(bounds[i + 1]));
  }
  // De-dupe (boundaries may coincide when a component is zero-length) and sort.
  const seen = [];
  for (const t of times) if (seen.indexOf(t) < 0) seen.push(t);
  return seen.sort((a, b) => a - b);
}

/* ---- Marker dragging (edit the existing envelope indexes) ---- */
// Map a normalized time to the nearest component boundary and apply it to the
// requested envelope marker. All clamp through clampEnvelopeIndexes() so the
// hold/cut/release relationship stays the same as the card editor enforces.
function dragCreatorMarker(key, t) {
  const env = ENVELOPE;
  const n = env.components.length;
  const total = designTimeline().total;
  const ms = clamp01(t) * total;
  const starts = [], ends = [];
  for (let i = 0; i < n; i++) {
    starts.push(compsMs(env.components.slice(0, i)));
    ends.push(compsMs(env.components.slice(0, i + 1)));
  }
  const nearest = arr => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const d = Math.abs(arr[i] - ms);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  if (key === 'hold') env.holdStartIndex = nearest(starts);
  else if (key === 'cut') env.earlyCutIndex = nearest(ends);
  else if (key === 'rel') env.holdEndIndex = nearest(ends);
  clampEnvelopeIndexes();
}

function drawRoundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}