/* ============================================================
   creator.js — full-screen sound creator. Repurposes the main
   canvas to draw each oscillator layer's mix curve (how much of
   that waveform is heard over the life of the note). The garden
   state is untouched while away: mode flips to 'creator' and the
   main loop skips its own rendering.
   ============================================================ */

// One color per oscillator layer (index-stable so layers keep their colors).
const OSC_COLORS = ['#2e5d34', '#1e88e5', '#f57c00', '#8e24aa', '#00897b', '#d9534f', '#6d4c41', '#3949ab'];
const creatorBtn = document.getElementById('creatorBtn');

let creatorSubmode = 'note';  // 'note' (merged volume envelope + mix), 'harm', or 'pitch'
let creatorVolSel = true;     // true = master volume envelope selected; false = a layer's mix curve
let creatorPitchSel = 'master'; // Pitch tab selection: 'master' or a layer index
let creatorVoiceSel = 0;        // Voices tab: which duplicate voice of the selected layer is being edited
let creatorPtr = null;        // { mode:'point'|'marker'|'draw', layerIdx, ptIdx|key, x0, y0, moved }
let creatorLastTap = null;    // { t, x, y } for double-tap-to-delete
let creatorPreviewTimer = null;
// Freehand "Draw" mode: while on, any drag in the graph scribbles breakpoints
// along the finger's path instead of grabbing/moving individual dots. The
// points dropdown (4..32) sets how many evenly-spaced breakpoints a full-width
// sweep places across the graph; the mode itself is session-only, the count is
// persisted.
let creatorDrawMode = false;
// "Erase" mode: a draw-stroke mode that zeroes the swept region instead of
// following the finger's value. Existing points inside the swept corridor are
// absorbed and replaced by zero-value breakpoints, so dragging across a shape
// flattens it down to the zero line. Turning Erase on also turns Draw on;
// turning Draw off clears Erase. Session-only, like draw mode.
let creatorEraseMode = false;
// "Delete" mode: a single tap on a point (envelope boundary, mix/pitch
// breakpoint, or spectrum point) removes it — the Point mode's double-tap
// gesture, made one-tap. Session-only, like the other graph modes.
let creatorDeleteMode = false;
// "Line" mode: the segment editor's From/To workflow. Only in this mode does
// tapping two dots select a From→To range (the points between are removed and
// the segment editor opens to pick a line type); in every other mode a point
// tap is just a grab/drag. Session-only, like the other graph modes.
let creatorSegMode = false;
var creatorDrawPoints = 8;   // 4..HARMONIC_COUNT (clamped)
// Auto-preview: when on, edits/taps in the creator (and settings sliders) play
// the current design automatically. When off, only the ▶ Preview button (and
// the settings panel's Play test) make a sound. Persisted; default off.
var creatorAutoPreview = false;
// Voice slider snapping (Voices tab): when on, the Semitones slider snaps to
// whole semitones and the ± nudge buttons step by exactly 1 st. Cents keep
// providing fine sub-semitone tuning. Persisted; default off.
var creatorVoiceSnap = false;
// Hard cap on envelope components created by drawing (the other editors cap via
// their own insert helpers, raised to HARMONIC_COUNT for drawing).
const ENV_DRAW_MAX = 48;

/* ---- Open / close ---- */
function openSoundCreator(submode, layerIdx) {
  creatorActive = true;
  creatorSubmode = (submode === 'env' || submode === 'mix') ? 'note' : (submode || 'note');
  creatorVolSel = creatorSubmode === 'note';
  clearSegSelection();
  if (layerIdx != null && layerIdx >= 0 && layerIdx < OSC_STACK.layers.length) selectedLayerIdx = layerIdx;
  mode = 'creator';
  stopGestureNote();
  stopPreviewVoices();
  playbacks.length = 0;
  settingsPanel.classList.add('hidden');
  document.body.classList.add('creator');
  const ptsSel = document.getElementById('creatorPoints');
  if (ptsSel) ptsSel.value = drawPointCount();
}

function closeSoundCreator() {
  creatorActive = false;
  creatorPtr = null;
  mode = 'plant';
  playbacks.length = 0;
  clearTimeout(creatorPreviewTimer);
  clearSegSelection();
  stopGestureNote();
  stopPreviewVoices();
  document.body.classList.remove('creator');
  const ptsSel = document.getElementById('creatorPoints');
  if (ptsSel) ptsSel.style.display = 'none';
  flushSettingsSave();
}

creatorBtn.addEventListener('click', () => {
  if (creatorActive) { closeSoundCreator(); return; }
  initAudio();
  resumeAudio();
  openSoundCreator('note', selectedLayerIdx);
});

/* ---- Draw points dropdown ----
   A native <select> overlaid on the toolbar's points pill. Its options mirror
   the range of the graph's point models (4..HARMONIC_COUNT), so a full-width
   draw places exactly the chosen number of breakpoints on any tab. */
(function initDrawPointsSelect() {
  const sel = document.getElementById('creatorPoints');
  if (!sel) return;
  for (let i = 4; i <= HARMONIC_COUNT; i++) {
    const o = document.createElement('option');
    o.value = i; o.textContent = i + ' points';
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    creatorDrawPoints = Math.max(4, Math.min(HARMONIC_COUNT, +sel.value || 8));
    saveSettings();
    sel.blur();
  });
})();

/* ---- Plot geometry ---- */
function creatorPlot() {
  const top = 180, bottom = H - 38, left = 20, right = W - 14;
  return { top, bottom, left, right, pw: right - left, ph: bottom - top };
}
const tToX = (t, p) => p.left + clamp01(t) * p.pw;
const xToT = (x, p) => clamp01((x - p.left) / p.pw);
const vToY = (v, p) => p.bottom - clamp01(v) * p.ph;
const yToV = (y, p) => clamp01((p.bottom - y) / p.ph);

/* ---- Time markers (shared by the volume envelope & mix curves) ----
   HOLD / CUT / REL are draggable via grab tabs drawn above the plot. Tabs at
   nearby x positions are staggered onto a second row so overlapping markers
   (e.g. cut == hold end) stay separately grabbable. */
const MARKER_DEFS = [
  { key: 'hold', label: 'HOLD', color: '#00897b' },
  { key: 'cut', label: 'CUT', color: '#f57c00' },
  { key: 'rel', label: 'REL', color: '#d9534f' },
];
// The marker lane: a grabbable strip between the note-life row (ends at y 118)
// and the plot (starts at creatorPlot().top = 180). Bigger tabs than before,
// staggered onto two rows, so overlapping markers (e.g. cut == hold end) each
// keep a separate handle. The plot itself no longer intercepts grabs near a
// marker's line, so curve points sitting on the same x stay draggable.
const MARKER_LANE_TOP = 122, MARKER_LANE_BOTTOM = 176;
const MARKER_TAB_W = 58, MARKER_TAB_H = 22;
const MARKER_TAB_ROW = 128, MARKER_TAB_ROW2 = 154;
function markerList() {
  const tl = designTimeline();
  return MARKER_DEFS.map(m => ({
    key: m.key, label: m.label, color: m.color,
    t: m.key === 'hold' ? tl.tHoldStart : m.key === 'cut' ? tl.tCut : tl.tHoldEnd,
  }));
}
function markerTabs(p) {
  const tabs = [];
  for (const m of markerList()) {
    const cx = tToX(m.t, p);
    let y = MARKER_TAB_ROW;
    for (const t of tabs) if (Math.abs(t.cx - cx) < 50) y = MARKER_TAB_ROW2;
    tabs.push({ key: m.key, label: m.label, color: m.color, cx, x: cx - MARKER_TAB_W / 2, y, w: MARKER_TAB_W, h: MARKER_TAB_H });
  }
  return tabs;
}

// Dimmed per-marker variants for tabs that show the HOLD/CUT/REL markers but
// don't edit them (the Pitch tab): keep each marker's hue so it stays
// identifiable, but drop the saturation/brightness so they read as display-only.
function markerHue(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return h;
}
const markerDim = (hex, sat, light) => 'hsl(' + markerHue(hex).toFixed(1) + ',' + sat + '%,' + light + '%)';

// Waveform presets offered in the Harmonics tab. They reuse the shared
// HARMONIC_PRESETS via applyPresetToLayer, so a picked waveform is the exact
// same sound as choosing it in the settings panel.
const HARM_PRESETS = [
  { name: 'sine', label: 'Sine' },
  { name: 'triangle', label: 'Triangle' },
  { name: 'square', label: 'Square' },
  { name: 'sawtooth', label: 'Sawtooth' },
];
function harmPresetButtons(p) {
  const n = HARM_PRESETS.length;
  const gap = 8;
  const w = (p.pw - (n - 1) * gap) / n;
  const y = 102, h = 40;
  return HARM_PRESETS.map((pr, i) => ({
    name: pr.name, label: pr.label,
    x: p.left + i * (w + gap), y, w, h,
  }));
}
function previewPitchName() {
  const positions = pitchPositions();
  const idx = Math.max(0, Math.min(positions.length - 1, PREVIEW_PITCH || 0));
  return positions.length ? noteNameForPos(positions[idx]) : '—';
}
function previewPitchFreq() {
  const name = previewPitchName();
  if (name === '—') return 0;
  try { return noteToFreq(name); } catch (e) { return 0; }
}

// Average harmonic number of the mixed spectrum at a given mix progress
// (1 = fundamental, 2 = an octave up, etc.). This is the note's spectral center —
// what a listener perceives as "the pitch" as brightness changes over the note.
function mixedSpectralCentroid(prog) {
  const gains = layerGainsAt(prog);
  let num = 0, den = 0;
  for (let i = 0; i < OSC_STACK.layers.length; i++) {
    const w = gains[i] || 0;
    const amps = layerAmplitudes(OSC_STACK.layers[i]) || [];
    for (let h = 0; h < HARMONIC_COUNT; h++) {
      const a = Math.abs((amps[h] || 0) * w);
      num += (h + 1) * a;
      den += a;
    }
  }
  return den > 1e-9 ? num / den : 1;
}

// Name of the note at the spectral center (frequency × centroid harmonic).
function centroidPitchName(prog) {
  const base = previewPitchFreq();
  const f = base * mixedSpectralCentroid(prog);
  try { return midiToName(Math.round(12 * Math.log2(f / 440) + 69)); } catch (e) { return '—'; }
}

/* ---- Curve helpers ---- */
function insertCurvePoint(l, t, v) {
  t = clamp01(t); v = clamp01(v);
  const curve = l.curve;
  for (let i = 0; i < curve.length; i++) {
    if (Math.abs(curve[i].t - t) < 0.008) { curve[i].v = v; return i; }
  }
  if (curve.length >= HARMONIC_COUNT) return -1;
  curve.push({ t, v });
  curve.sort((a, b) => a.t - b.t);
  return curve.findIndex(pt => pt.t === t && pt.v === v);
}

function removeCurvePoint(l, idx) {
  const pt = l.curve[idx];
  if (!pt) return;
  if (pt.t === 0 || pt.t === 1) return;   // the far-left/right anchors are protected
  if (l.curve.length <= 2) {
    // Keep two points: collapse to a flat silent line the user can draw up.
    l.curve = [{ t: 0, v: 0 }, { t: 1, v: 0 }];
    return;
  }
  l.curve.splice(idx, 1);
}

function resetLayerCurve(l) {
  l.curve = [{ t: 0, v: 1 }, { t: 1, v: 1 }];
}

/* ---- Harmonics (spectrum) helpers ----
   The selected layer's waveform is drawn as a signed amplitude curve over the
   harmonic axis (x = 0..1 across harmonics 1..32, a = -1..1). Breakpoints live
   in layer.specPoints and are resampled into layer.amplitudes on every edit, so
   the audio engine, preset matching, and wave cache all stay consistent. */
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

function hitTestHarm(x, y, p) {
  const l = selectedLayer();
  initLayerSpecPoints(l);
  const pts = l.specPoints;
  for (let j = 0; j < pts.length; j++) {
    const px = tToX(pts[j].x, p), py = ampToY(pts[j].a, p);
    if (Math.hypot(x - px, y - py) < 18) return { type: 'harmpoint', idx: j };
  }
  return { type: 'empty' };
}

/* ---- Pitch envelope helpers ----
   The Pitch tab edits either the master envelope (all layers) or one layer's
   own. Both are breakpoint curves over the note's timeline with a signed
   semitone axis (± the envelope's range). A layer's own envelope may not exist
   yet — it's created lazily on first edit, and Reset clears it away again.
   The master overrides every layer while it exists (non-destructively). */
function selectedPitchEnvOrNull() {
  if (creatorPitchSel === 'master') {
    return (MASTER_PITCH_ENV && MASTER_PITCH_ENV.points && MASTER_PITCH_ENV.points.length >= 2)
      ? MASTER_PITCH_ENV : null;
  }
  const l = OSC_STACK.layers[creatorPitchSel];
  return (l && l.pitchEnv && l.pitchEnv.points && l.pitchEnv.points.length >= 2) ? l.pitchEnv : null;
}
function ensureSelectedPitchEnv() {
  const existing = selectedPitchEnvOrNull();
  if (existing) return existing;
  const env = defaultPitchEnv();
  if (creatorPitchSel === 'master') MASTER_PITCH_ENV = env;
  else OSC_STACK.layers[creatorPitchSel].pitchEnv = env;
  return env;
}
// Map semitones to/from screen Y using the signed-axis mapping scaled by range.
function stToY(st, range, p) { return ampToY(st / range, p); }
function yToSt(y, range, p) { return yToAmp(y, p) * range; }

function insertPitchPoint(env, t, st) {
  t = clamp01(t);
  const r = Math.max(1, env.range || 1);
  st = Math.max(-r, Math.min(r, st));
  const pts = env.points;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].t - t) < 0.01) { pts[i].st = st; return i; }
  }
  if (pts.length >= 64) return -1;
  pts.push({ t, st });
  pts.sort((a, b) => a.t - b.t);
  return pts.findIndex(pt => pt.t === t && pt.st === st);
}

function removePitchPoint(env, idx) {
  const pts = env.points;
  const pt = pts[idx];
  if (!pt) return;
  if (pt.t === 0 || pt.t === 1) return;   // the far-left/right anchors are protected
  if (pts.length <= 2) {
    // Keep two points: collapse to a flat no-shift line the user can draw up.
    env.points = [{ t: 0, st: 0 }, { t: 1, st: 0 }];
    return;
  }
  pts.splice(idx, 1);
}

// Range pill: ±N stepper floating in the plot's top-left (Pitch tab only).
function pitchRangePill(p) {
  const y = p.top + 8, w = 96, h = 26;
  return { x: p.left + 4, y, w, h };
}

/* ---- Envelope (component model) helpers ----
   The envelope is the existing ENVELOPE.components list (piecewise-linear).
   Boundary i sits at the start of component i (b[i] ms); its value is comp i-1's
   end value (or comp 0's start value at i = 0). Editing here edits the same data
   as the settings-panel card editor. */
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

// Selection state: from/to point indexes (component boundaries for the volume
// envelope, breakpoint indexes for mix/pitch curves) and which end the next
// point tap sets. The first tap picks From, the second To; only then does the
// segment editor open (on the merged single segment).
let segFromIdx = null, segToIdx = null, segActiveEnd = 'from';
let segPanelOpen = false;

// The curve being edited as a segment model: `elems` are the segment-owning
// elements (index = segment start), `lastPoint` is the count of selectable
// point positions (0..lastPoint-1). The envelope has one more position than
// components so its final boundary can close a range.
function segModel() {
  if (creatorSubmode === 'note') {
    if (creatorVolSel) return { elems: ENVELOPE.components, lastPoint: ENVELOPE.components.length + 1 };
    const l = OSC_STACK.layers[selectedLayerIdx];
    return { elems: l.curve, lastPoint: l.curve.length };
  }
  if (creatorSubmode === 'pitch') {
    const env = selectedPitchEnvOrNull();
    return { elems: env ? env.points : [], lastPoint: env ? env.points.length : 0 };
  }
  return null;
}

// Normalized selection range as { m, lo, hi } (point indexes), or null. A
// selection with only one end set (From or To) counts as a single point
// (lo == hi), which edits the one segment starting there.
function segRange() {
  const m = segModel();
  if (!m) return null;
  if (segFromIdx == null && segToIdx == null) return null;
  const a = segFromIdx == null ? segToIdx : segFromIdx;
  const b = segToIdx == null ? segFromIdx : segToIdx;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.max(a, b);
  if (lo >= m.lastPoint || hi >= m.lastPoint) return null;
  return { m, lo, hi };
}

// The element whose segment config represents the current selection (the first
// segment in the range), or null.
function segCurrent() {
  const r = segRange();
  return r ? (r.m.elems[r.lo] || null) : null;
}

// Run `fn(el)` for every segment element inside the selected range. A
// single-point selection (from == to) covers the one segment starting there.
function forEachSegInRange(fn) {
  const r = segRange();
  if (!r) return;
  const end = r.hi + (r.hi <= r.lo ? 0 : -1);   // last covered segment index
  for (let i = r.lo; i <= end; i++) {
    const el = r.m.elems[i];
    if (el) fn(el);
  }
}

function segParamValue(key) {
  const el = segCurrent();
  if (!el) return SEG_PARAM_DEFS[key].min;
  const s = segOf(el);
  return Math.max(SEG_PARAM_DEFS[key].min, Math.min(SEG_PARAM_DEFS[key].max, +s[key] || SEG_PARAM_DEFS[key].min));
}
function segParamFromX(pr, x) {
  const d = SEG_PARAM_DEFS[pr.key];
  let v = d.min + clamp01((x - pr.x1) / (pr.x2 - pr.x1)) * (d.max - d.min);
  v = Math.round(v / d.step) * d.step;
  return Math.max(d.min, Math.min(d.max, v));
}

function applySegParam(key, v) {
  const d = SEG_PARAM_DEFS[key];
  if (!d) return;
  v = Math.max(d.min, Math.min(d.max, +v || d.min));
  forEachSegInRange(el => {
    if (!el.seg || typeof el.seg !== 'object') el.seg = clone(DEFAULT_SEG);
    el.seg[key] = v;
  });
}
function setSegParam(key, v) { applySegParam(key, v); previewAndSave(); }
function setSegType(t) {
  if (SEGMENT_TYPE_ORDER.indexOf(t) < 0) return;
  forEachSegInRange(el => {
    if (!el.seg || typeof el.seg !== 'object') el.seg = clone(DEFAULT_SEG);
    el.seg.type = t;
  });
  previewAndSave();
}
// A tap on a point: the first tap picks the From end (the editor does not open
// yet); the second tap picks the To end — at which point every breakpoint
// strictly between the two is removed, collapsing the region into a single
// segment, and the segment editor opens on that merged segment.
function selectSegPoint(idx) {
  const m = segModel();
  if (!m || idx < 0 || idx >= m.lastPoint) return;
  // A complete selection is active: any point tap starts a fresh selection.
  if (segPanelOpen && segFromIdx != null && segToIdx != null) {
    segFromIdx = idx;
    segToIdx = null;
    segActiveEnd = 'to';
    segPanelOpen = false;
    return;
  }
  if (segActiveEnd === 'to' && segFromIdx != null) {
    segToIdx = idx;
    segActiveEnd = 'from';
    segDeleteBetween();
    segPanelOpen = true;
    maybeAutoPreview();
    saveSettings();
    return;
  }
  // First tap: set From and wait for To.
  segFromIdx = idx;
  segToIdx = null;
  segActiveEnd = 'to';
  saveSettings();
}

// Remove every breakpoint strictly between the selected From and To ends, so
// the region collapses to a single segment spanning the two endpoints (the
// from element's segment config is kept). Afterward the selection is the one
// merged segment — from point lo to its new neighbor lo+1.
function segDeleteBetween() {
  const m = segModel();
  if (!m || segFromIdx == null || segToIdx == null) return;
  const lo = Math.max(0, Math.min(segFromIdx, segToIdx));
  const hi = Math.max(segFromIdx, segToIdx);
  if (hi - lo < 2) {           // same or adjacent: nothing strictly between
    segFromIdx = lo;
    segToIdx = hi;
    return;
  }
  if (creatorSubmode === 'note' && creatorVolSel) {
    // Volume envelope: boundaries lo..hi, components lo..hi-1. Merge them into
    // one component (the from component) spanning boundary lo to boundary hi.
    const comps = ENVELOPE.components;
    const merged = comps[lo];
    let dur = 0;
    for (let c = lo; c < hi; c++) dur += comps[c].duration;
    merged.duration = Math.max(1, Math.round(dur));
    merged.endValue = comps[hi - 1].endValue;
    comps.splice(lo + 1, hi - lo - 1);
    chainStartValues(ENVELOPE);
    clampEnvelopeIndexes();
  } else if (creatorSubmode === 'pitch') {
    const env = selectedPitchEnvOrNull();
    if (!env) return;
    env.points.splice(lo + 1, hi - lo - 1);
  } else {
    const l = OSC_STACK.layers[selectedLayerIdx];
    l.curve.splice(lo + 1, hi - lo - 1);
  }
  segFromIdx = lo;
  segToIdx = lo + 1;
}
function clearSegSelection() {
  segFromIdx = null; segToIdx = null; segActiveEnd = 'from'; segPanelOpen = false;
}
function clampSegSelection() {
  const m = segModel();
  if (!m) { clearSegSelection(); return; }
  if (segFromIdx != null && segFromIdx >= m.lastPoint) segFromIdx = null;
  if (segToIdx != null && segToIdx >= m.lastPoint) segToIdx = null;
  if (segFromIdx == null && segToIdx == null) segPanelOpen = false;
}

// Screen-space layout of the floating segment-editor panel (top-left of the
// plot; below the ±range pill on the Pitch tab). Returns row rects used by
// both the hit tester and the renderer.
const SEG_PANEL_W_MAX = 330;
function segPanelRects(p) {
  const w = Math.min(SEG_PANEL_W_MAX, Math.max(200, p.pw - 8));
  const x = p.left + 4;
  const y0 = creatorSubmode === 'pitch' ? p.top + 44 : p.top + 10;
  const rowH = 24, gap = 6;
  const y = n => y0 + n * (rowH + gap);
  const cur = segCurrent();
  const type = cur ? segOf(cur).type : 'line';
  const params = SEGMENT_TYPE_PARAMS[type] || [];
  const clear = { x: x + w - 22, y: y(0), w: 22, h: rowH };
  const pillW = (w - 10) / SEGMENT_TYPE_ORDER.length;
  const typePills = SEGMENT_TYPE_ORDER.map((t, i) => ({ t, x: x + i * (pillW + 2), y: y(1), w: pillW, h: rowH + 2 }));
  const paramRows = params.map((key, i) => ({ key, cy: y(2) + 14 + i * (rowH + gap), btnW: 20, x1: x + 78, x2: x + w - 60 }));
  const height = y(2) + params.length * (rowH + gap) + rowH;
  return { x, y0, w, clear, typePills, paramRows, rowH, gap, height };
}

// Hit-test the segment-editor panel (null when closed / outside Line mode).
function hitTestSegPanel(x, y, p) {
  if (!segPanelOpen || !creatorSegMode || creatorDrawMode || creatorDeleteMode) return null;
  const R = segPanelRects(p);
  if (y >= R.clear.y && y <= R.clear.y + R.clear.h && x >= R.clear.x && x <= R.clear.x + R.clear.w) return { type: 'segclear' };
  if (y >= R.typePills[0].y && y <= R.typePills[0].y + R.typePills[0].h) {
    for (const pill of R.typePills) {
      if (x >= pill.x && x <= pill.x + pill.w) return { type: 'segtype', t: pill.t };
    }
    return null;
  }
  for (const pr of R.paramRows) {
    if (y >= pr.cy - 14 && y <= pr.cy + 14) {
      if (x >= pr.x1 - pr.btnW - 8 && x <= pr.x1 - 8) return { type: 'segparam', key: pr.key, dir: -1 };
      if (x >= pr.x2 + 8 && x <= pr.x2 + 8 + pr.btnW) return { type: 'segparam', key: pr.key, dir: 1 };
      if (x >= pr.x1 - 8 && x <= pr.x2 + 8) return { type: 'segslider', key: pr.key };
      return null;
    }
  }
  return null;
}

// Stroke a curve through `pts` ([{x, y, v, el}]) using each segment's line
// type: straight lines for 'line' segments, a sampled shape otherwise. `scale`
// is the curve's full value span (1 for volume/mix, the range for pitch) and
// `yOf` maps a value back to a screen y — so wobbles draw at their true
// absolute amplitude, even on flat segments where the two endpoints share a y.
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

// Screen x-span of the selected range on the currently edited curve, for a
// highlight band behind the drawn shape. A single-segment selection (from ==
// to) spans that one segment, from its start point to the next.
function segRangeHighlight(p) {
  const r = segRange();
  if (!r) return null;
  const end = r.hi + (r.hi <= r.lo ? 1 : 0);
  let x0, x1;
  if (creatorSubmode === 'note' && creatorVolSel) {
    const eb = envBoundaries();
    if (r.lo > eb.n || end > eb.n) return null;
    x0 = tToX(eb.tOf(eb.b[r.lo]), p);
    x1 = tToX(eb.tOf(eb.b[end]), p);
  } else if (creatorSubmode === 'pitch') {
    const env = selectedPitchEnvOrNull();
    if (!env || !env.points[r.lo] || !env.points[end]) return null;
    x0 = tToX(env.points[r.lo].t, p);
    x1 = tToX(env.points[end].t, p);
  } else {
    const l = OSC_STACK.layers[selectedLayerIdx];
    if (!l.curve[r.lo] || !l.curve[end]) return null;
    x0 = tToX(l.curve[r.lo].t, p);
    x1 = tToX(l.curve[end].t, p);
  }
  return { x0, x1 };
}

// Draw the floating segment-editor panel: the merged-segment readout + ✕, the
// four type pills, and the active type's parameter sliders.
function drawSegPanel(p) {
  const R = segPanelRects(p);
  const cur = segCurrent();
  const type = cur ? segOf(cur).type : 'line';
  const r = segRange();
  // Panel backdrop (semi-transparent so the curve underneath stays visible).
  ctx.fillStyle = 'rgba(244,250,240,0.82)';
  ctx.strokeStyle = 'rgba(46,93,52,0.5)';
  ctx.lineWidth = 1.5;
  drawRoundRect(R.x, R.y0, R.w, R.height, 10);
  ctx.fill();
  ctx.stroke();
  // Row 0: the merged segment readout (left) + ✕ dismiss (right).
  ctx.fillStyle = '#2e5d34';
  ctx.font = '800 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Segment ' + (r ? r.lo : 0), R.x + 6, R.y0 + R.rowH / 2 + 4);
  ctx.fillStyle = '#6b8e5a';
  ctx.font = '700 9px sans-serif';
  ctx.fillText('tap a dot to re-select', R.x + 6, R.y0 + R.rowH - 2);
  // ✕ dismiss.
  ctx.fillStyle = '#eef5ea';
  ctx.beginPath();
  ctx.arc(R.clear.x + R.clear.w / 2, R.clear.y + R.clear.h / 2, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(46,93,52,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#2e5d34';
  ctx.font = '800 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('✕', R.clear.x + R.clear.w / 2, R.clear.y + R.clear.h / 2 + 4);
  // Row 1: type pills.
  for (const pill of R.typePills) {
    const active = pill.t === type;
    drawRoundRect(pill.x, pill.y, pill.w, pill.h, 8);
    ctx.fillStyle = active ? '#2e5d34' : '#fff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(46,93,52,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = active ? '#fff' : '#2e5d34';
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(SEGMENT_TYPE_DEFS[pill.t].label, pill.x + pill.w / 2, pill.y + pill.h / 2 + 3);
  }
  // Param rows.
  for (const pr of R.paramRows) {
    const d = SEG_PARAM_DEFS[pr.key];
    const val = segParamValue(pr.key);
    // Label before the − button; readout after the + button.
    ctx.fillStyle = '#6b8e5a';
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(d.label, pr.x1 - pr.btnW - 12, pr.cy + 3);
    ctx.font = '700 13px sans-serif';
    ctx.textAlign = 'center';
    for (const side of ['-', '+']) {
      const bx = side === '-' ? pr.x1 - pr.btnW - 8 : pr.x2 + 8;
      drawRoundRect(bx, pr.cy - pr.btnW / 2, pr.btnW, pr.btnW, 6);
      ctx.fillStyle = '#eef5ea';
      ctx.fill();
      ctx.strokeStyle = 'rgba(46,93,52,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#2e5d34';
      ctx.fillText(side === '-' ? '−' : '+', bx + pr.btnW / 2, pr.cy + 5);
    }
    // Track + fill + thumb.
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(46,93,52,0.22)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(pr.x1, pr.cy); ctx.lineTo(pr.x2, pr.cy);
    ctx.stroke();
    const tx = pr.x1 + (pr.x2 - pr.x1) * ((val - d.min) / (d.max - d.min));
    ctx.strokeStyle = '#2e5d34';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(pr.x1, pr.cy); ctx.lineTo(tx, pr.cy);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(tx, pr.cy, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#2e5d34';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#2e5d34';
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(d.fmt(val), pr.x2 + 8 + pr.btnW + 4, pr.cy + 3);
  }
}

/* ---- Freehand drawing ----
   Draw mode scribbles breakpoints along the finger's path. The points dropdown
   (4..32) divides the graph into that many evenly-spaced slots (x = i/(N-1));
   the slot grid is computed across the whole graph, but a stroke only touches
   the slots it actually sweeps through — points outside the swept corridor are
   never modified, so starting mid-graph leaves everything else alone. Each
   visited slot gets a breakpoint at the finger's value, and pre-existing
   points inside the swept corridor are absorbed, so sweeping at a lower
   density than the existing shape thins it down as you pass through.
   Insert-dedupe merges revisits, so backtracking adds nothing. In Erase mode
   the drawn value is the erase line instead of the finger's: swept points are
   absorbed and erase-line breakpoints replace them, flattening the corridor to
   that line. */
function drawPointCount() { return Math.max(4, Math.min(HARMONIC_COUNT, +creatorDrawPoints || 8)); }
function slotT(s) { const n = drawPointCount(); return n > 1 ? s / (n - 1) : 0; }
function slotAtX(x, p) {
  const n = drawPointCount();
  if (n <= 1) return 0;
  return Math.max(0, Math.min(n - 1, Math.round((x - p.left) / (p.pw / (n - 1)))));
}

// Toolbar pills floating in the top-right corner of the plot (always visible in
// both sub-modes, so the mode switch stays reachable without crowding the busy
// bars). One mode button cycles Point -> Draw -> Erase -> Delete -> Line; the
// points pill is the
// visual under the native <select> dropdown.
function drawToolbar(p) {
  const y = p.top + 8, w = 58, h = 26;
  const modeX = p.right - 4 - w;
  const densX = modeX - 8 - w;
  return {
    mode: { x: modeX, y, w, h },
    dens: { x: densX, y, w, h },
  };
}

// Current editor mode name for the mode pill: Point (grab/edit dots), Draw
// (scribble with the finger's value), Erase (scribble along the erase line),
// Delete (tap a dot to remove it), or Line (pick two dots to shape a segment).
function creatorModeName() {
  if (creatorSegMode) return 'Line';
  if (creatorDeleteMode) return 'Delete';
  if (creatorEraseMode) return 'Erase';
  if (creatorDrawMode) return 'Draw';
  return 'Point';
}

// Auto-preview toggle + manual preview button, anchored just left of the pitch
// selector in the swatch row (y 68..90).
function creatorTopPills() {
  const y = 68, h = 22;
  const previewX = W - 196 - 8 - 72;
  const autoX = previewX - 6 - 58;
  return {
    auto:    { x: autoX,    y, w: 58, h },
    preview: { x: previewX, y, w: 72, h },
  };
}

/* ---- Voices tab (coupled duplicates of the selected oscillator) ----
   Each layer can carry duplicate voices that play its same waveform in
   parallel with per-voice pitch/volume offsets — chorus/unison thickening
   without extra tabs or swatches. The Voices tab has two levels of sub-tabs:
   the layer swatch row picks the oscillator, a chip row below picks which
   voice to edit, and the graph area holds one draggable slider per parameter
   (semitones, cents, volume) plus ± nudge buttons for fine steps. */
// The layer whose voices are being edited (always a concrete layer here).
function selectedVoicesLayer() {
  return OSC_STACK.layers[selectedLayerIdx] || null;
}
function clampVoiceSel() {
  const l = selectedVoicesLayer();
  const n = l ? layerVoices(l).length : 0;
  creatorVoiceSel = Math.max(0, Math.min(n - 1, creatorVoiceSel));
  return l && n ? l.voices[creatorVoiceSel] : null;
}
function selectedVoice() {
  return clampVoiceSel();
}
function addVoiceToSelected() {
  const l = selectedVoicesLayer();
  if (!l || layerVoices(l).length >= MAX_LAYER_VOICES) return null;
  if (!Array.isArray(l.voices)) l.voices = [];
  const v = defaultVoice();
  l.voices.push(v);
  creatorVoiceSel = l.voices.length - 1;
  return v;
}
// Voice chips strip (replaces the note-life row in the Voices tab).
function voiceChipRects(p) {
  const rects = [];
  const vs = selectedVoicesLayer() ? layerVoices(selectedVoicesLayer()) : [];
  for (let i = 0; i < vs.length; i++) {
    rects.push({ x: p.left + i * 88, y: LIFE_ROW_CY - 13, w: 84, h: 26 });
  }
  if (vs.length < MAX_LAYER_VOICES) {
    rects.push({ x: p.left + vs.length * 88 + 6, y: LIFE_ROW_CY - 13, w: 40, h: 26 });
  }
  return rects;
}
// Parameter sliders in the plot area. Bipolar tracks center on no-shift.
const VOICE_PARAM_DEFS = [
  { key: 'st',  label: 'Semitones', min: -24, max: 24, step: 0.25, fmt: v => (Math.round(v * 100) / 100) + ' st' },
  { key: 'ct',  label: 'Cents',     min: -100, max: 100, step: 1,  fmt: v => Math.round(v) + ' ¢' },
  { key: 'vol', label: 'Volume',    min: 0,  max: 2,  step: 0.01, fmt: v => Math.round(v * 100) + '%' },
];
// One-tap interval presets for the Semitones row, shown as chips in the strip
// above the plot (Voices tab). Tapping one sets the selected voice's semitone
// offset to that interval from the fundamental.
const VOICE_INTERVALS = [
  { st: -12, label: '−8' },   // lower octave
  { st: 3,  label: 'b3' },    // minor 3rd up
  { st: 4,  label: '3' },     // major 3rd up
  { st: 5,  label: '4' },     // perfect 4th up
  { st: 7,  label: '5' },     // perfect 5th up
  { st: 12, label: '8' },     // upper octave
];
// Snap-to-semitone toggle pill, floating in the strip above the plot (Voices
// tab only) — the band where the note-life slider / marker tabs live in the
// other tabs, and which is free in Voices mode. Keeps the sliders in the plot
// at their usual height.
function voiceSnapPill(p) {
  const y = MARKER_LANE_TOP + 22, w = 70, h = 26;
  return { x: p.left + 4, y, w, h };
}
// Interval preset chips, filling the strip to the right of the Snap pill. Chips
// share the pill's row and height, distributing the available width so they
// never overflow the screen (each settles between 34 and 46px wide).
function voiceIntervalButtons(p) {
  const sp = voiceSnapPill(p);
  const gap = 6;
  const avail = Math.max(0, p.right - (sp.x + sp.w + 10));
  const n = VOICE_INTERVALS.length;
  const w = Math.min(46, Math.max(34, (avail - gap * (n - 1)) / n));
  const x0 = sp.x + sp.w + 10;
  return VOICE_INTERVALS.map((it, i) => ({ ...it, x: x0 + i * (w + gap), y: sp.y, w, h: sp.h }));
}

function voiceSliderRows(p) {
  // One row per parameter, everything aligned on the track's line: the label
  // right-aligned just before the − button, the readout after the + button,
  // and the track between them. Keeping the label and readout on the line
  // (instead of a row above) shrinks each row's vertical footprint to the
  // buttons (±13px), so rows stay comfortably apart even on short landscape
  // plots instead of smushing together. Spacing grows up to 56px on roomy
  // screens but never drops below 30px, and the last row always clears the
  // bottom axis label.
  const n = VOICE_PARAM_DEFS.length;
  const topInset = 18;        // first row's buttons clear the plot top
  const bottomReserve = 24;   // last row clears the bottom axis label
  const span = Math.max(0, p.ph - topInset - bottomReserve);
  const spacing = n > 1 ? Math.min(56, Math.max(30, span / (n - 1))) : 0;
  return VOICE_PARAM_DEFS.map((d, i) => {
    const cy = p.top + topInset + i * spacing;
    return {
      def: d,
      cy,
      btnW: 26,
      x1: p.left + 130,   // inline label + − button
      x2: p.right - 96,   // + button + inline readout
    };
  });
}
function voiceParamFromX(row, x) {
  const f = Math.max(0, Math.min(1, (x - row.x1) / (row.x2 - row.x1)));
  let v = row.def.min + f * (row.def.max - row.def.min);
  if (row.def.key === 'ct') v = Math.round(v);
  else if (row.def.key === 'st' && creatorVoiceSnap) v = Math.round(v);
  else v = Math.round(v * 100) / 100;
  return Math.max(row.def.min, Math.min(row.def.max, v));
}

// Place/update breakpoints for the slot range `fromS`..`s` (the finger's sweep
// since the last event) at the pointer's value. Absorption and placement are
// confined to the swept corridor: existing points between those slots (plus a
// small dedupe epsilon so a coincident point is replaced) are removed, points
// outside are untouched. Returns the last placed index (spec & curve), or null.
function drawPlacePointAtSlot(s, y, p, fromS) {
  const loS = Math.min(s, fromS == null ? s : fromS), hiS = Math.max(s, fromS == null ? s : fromS);
  const loT = slotT(loS), hiT = slotT(hiS), eps = 0.008;
  if (creatorSubmode === 'pitch') {
    const env = ensureSelectedPitchEnv();
    const r = Math.max(1, env.range || 1);
    if (env.points.length > 2) {
      const kept = env.points.filter(pt => pt.t === 0 || pt.t === 1 || pt.t < loT - eps || pt.t > hiT + eps);
      if (kept.length >= 2) env.points = kept;
    }
    if (creatorEraseMode) {
      // Erase on the pitch axis: only place a zero point where the line isn't
      // already at zero — flat runs stay sparse instead of gaining dots.
      let idx = -1;
      for (let k = loS; k <= hiS; k++) {
        if (Math.abs(pitchStAt(env, slotT(k))) > 1e-9) idx = insertPitchPoint(env, slotT(k), 0);
      }
      return idx;
    }
    let idx = -1;
    for (let k = loS; k <= hiS; k++) idx = insertPitchPoint(env, slotT(k), yToSt(y, r, p));
    return idx;
  }
  if (creatorSubmode === 'harm') {
    const l = selectedLayer();
    initLayerSpecPoints(l);
    if (l.specPoints.length > 2) {
      const kept = l.specPoints.filter(pt => pt.x === 0 || pt.x === 1 || pt.x < loT - eps || pt.x > hiT + eps);
      if (kept.length >= 2) l.specPoints = kept;
    }
    let idx = -1;
    for (let k = loS; k <= hiS; k++) {
      if (!creatorEraseMode || Math.abs(specValueAt(l.specPoints, slotT(k))) > 1e-9) idx = insertSpecPoint(l, slotT(k), creatorEraseMode ? 0 : yToAmp(y, p));
    }
    if (idx >= 0) syncLayerAmplitudes(l);
    return idx;
  }
  if (creatorVolSel) { envDrawAt(slotT(s), yToV(y, p), p, loT, hiT, creatorEraseMode); return null; }
  const l = selectedLayer();
  if (l.curve.length > 2) {
    const kept = l.curve.filter(pt => pt.t === 0 || pt.t === 1 || pt.t < loT - eps || pt.t > hiT + eps);
    if (kept.length >= 2) l.curve = kept;
  }
  let idx = -1;
  for (let k = loS; k <= hiS; k++) {
    // Erase snaps the swept curve to the full-volume line (1) rather than the
    // finger's value; flat full-volume runs stay sparse instead of gaining dots.
    if (!creatorEraseMode || Math.abs(curveValue(l, slotT(k)) - 1) > 1e-9) idx = insertCurvePoint(l, slotT(k), creatorEraseMode ? 1 : yToV(y, p));
  }
  return idx;
}

// Envelope draw: nudge the nearest boundary (within half the slot spacing) to
// the drawn time/value, otherwise split the envelope there (capped) and set the
// new boundary's value. Values chain forward via envDragBoundary, so the drawn
// path is preserved as a continuous piecewise-linear curve. While the envelope
// carries more components than the chosen point count, interior boundaries that
// fall inside the swept corridor [loT..hiT] are merged away first — so a
// low-density sweep thins the shape only where it actually passes.
function envDrawAt(t, v, p, loT, hiT, erase) {
  const comps = ENVELOPE.components;
  const lo = loT == null ? t : Math.min(loT, hiT);
  const hi = loT == null ? t : Math.max(loT, hiT);
  while (comps.length > drawPointCount() - 1) {
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
  const dedupeMs = total / (2 * (drawPointCount() - 1));
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
   hold end plus the release tail). The Volume-envelope tab offers a single
   "Note life"
   slider that scales all component durations proportionally, so the envelope
   keeps its shape while the whole note is stretched or compressed. */
function noteLifetimeMs() {
  return compsMs(ENVELOPE.components);
}
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
// The note-life row: a dedicated full-width strip between the controls row
// (ends at y 90) and the marker lane, so the slider never competes with the
// swatches or the Auto/Preview/pitch/reset widgets for horizontal space.
const LIFE_ROW_CY = 105;
function lifeSlider(p) {
  return { x1: p.left, x2: p.right, cy: LIFE_ROW_CY, minSec: 0.3, maxSec: 10 };
}
function applyLifeFromX(x) {
  const L = lifeSlider(creatorPlot());
  // Map over the same inset track the thumb is drawn on (label + readout
  // insets in drawCreator), otherwise grabbing the thumb makes it jump.
  const tx1 = L.x1 + 60, tx2 = L.x2 - 44;
  const f = clamp01((x - tx1) / (tx2 - tx1));
  setNoteLifetime((L.minSec + f * (L.maxSec - L.minSec)) * 1000);
}

// Distance from a point to a layer's drawn curve (sampled).
function distToCurve(layerIdx, x, y, p) {
  const l = OSC_STACK.layers[layerIdx];
  let best = Infinity;
  for (let k = 0; k <= 160; k++) {
    const t = k / 160;
    const sx = tToX(t, p), sy = vToY(curveValue(l, t), p);
    const d = Math.hypot(x - sx, y - sy);
    if (d < best) best = d;
  }
  return best;
}

// Distance from a point to the master envelope's drawn line (sampled).

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

/* ---- Preview (debounced so drawing doesn't spam the engine) ---- */
function scheduleCreatorPreview() {
  clearTimeout(creatorPreviewTimer);
  creatorPreviewTimer = setTimeout(() => {
    // Only play when auto-preview is on; the ▶ Preview button always plays.
    if (!creatorAutoPreview) return;
    // A clean single preview note: retire every earlier voice first, so repeated
    // edits never ring into each other (stacked voices read as a rising, denser
    // tone even though every preview is the same pitch).
    stopGestureNote();
    previewChime();
  }, 150);
}

/* ---- Hit testing ---- */
function creatorTabs() {
  return [
    { submode: 'note', label: 'Volume', enabled: true },
    { submode: 'pitch', label: 'Pitch', enabled: true },
    { submode: 'harm', label: 'Harm', enabled: true },
    { submode: 'voices', label: 'Voices', enabled: true },
  ];
}
const CREATOR_TAB_W = 96;

// Distance from a point to a line segment.
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let f = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  f = Math.max(0, Math.min(1, f));
  return Math.hypot(px - (x1 + dx * f), py - (y1 + dy * f));
}

function hitTestEnv(x, y, p) {
  const eb = envBoundaries();
  for (let i = 0; i <= eb.n; i++) {
    const px = tToX(eb.tOf(eb.b[i]), p), py = vToY(eb.vals[i], p);
    if (Math.hypot(x - px, y - py) < 18) return { type: 'envbound', idx: i };
  }
  let best = -1, bd = 16;
  for (let c = 0; c < eb.n; c++) {
    const d = segDist(x, y,
      tToX(eb.tOf(eb.b[c]), p), vToY(eb.vals[c], p),
      tToX(eb.tOf(eb.b[c + 1]), p), vToY(eb.vals[c + 1], p));
    if (d < bd) { bd = d; best = c; }
  }
  if (best >= 0) return { type: 'envline', c: best };
  return { type: 'empty' };
}

function hitTestCreator(x, y) {
  if (y < 64) {
    if (x < 74) return { type: 'back' };
    const tabs = creatorTabs();
    let tx = W - 14;
    for (let i = tabs.length - 1; i >= 0; i--) {
      const w = CREATOR_TAB_W;
      tx -= w;
      if (x >= tx && x <= tx + w) return { type: 'tab', submode: tabs[i].submode, enabled: tabs[i].enabled };
    }
    return { type: 'bar' };
  }
  const p = creatorPlot();
  if (y >= 66 && y <= 90) {
    const sw = (creatorSubmode === 'note' || creatorSubmode === 'pitch') ? 1 : 0;   // note pins Vol first; pitch pins Master
    // Auto-preview toggle + manual preview button (right of the swatches).
    const tp = creatorTopPills();
    if (x >= tp.auto.x && x <= tp.auto.x + tp.auto.w && y >= tp.auto.y && y <= tp.auto.y + tp.auto.h) return { type: 'autopreview' };
    if (x >= tp.preview.x && x <= tp.preview.x + tp.preview.w && y >= tp.preview.y && y <= tp.preview.y + tp.preview.h) return { type: 'previewbtn' };
    // ✕ delete badge on the selected layer (layers only; hidden when it's the last one).
    const layerSelected = creatorSubmode === 'pitch' ? creatorPitchSel !== 'master' : !creatorVolSel;
    if (layerSelected && OSC_STACK.layers.length > 1) {
      const scx = p.left + sw * 76 + selectedLayerIdx * 76 + 62, scy = 72;
      if (Math.hypot(x - scx, y - scy) < 15) return { type: 'dellayer' };
    }
    // ➕ add-layer button after the last swatch.
    if (OSC_STACK.layers.length < 8) {
      const ax = p.left + sw * 76 + OSC_STACK.layers.length * 76 + 7, ay = 78;
      if (Math.hypot(x - ax, y - ay) < 18) return { type: 'addlayer' };
    }
    for (let i = 0; i < OSC_STACK.layers.length; i++) {
      const cx = p.left + sw * 76 + i * 76;
      // The 🔊/🔇 button (the swatch's icon) toggles the layer's mute.
      if (x >= cx && x <= cx + 22 && y >= 67 && y <= 89) return { type: 'layermute', layerIdx: i };
      if (x >= cx && x <= cx + 70) return { type: 'layer', layerIdx: i };
    }
    // Master swatch (pinned first in the Pitch tab), with its ✕ clear badge.
    if (creatorSubmode === 'pitch' && MASTER_PITCH_ENV && Math.hypot(x - (p.left + 62), y - 72) < 15) return { type: 'delmaster' };
    if (creatorSubmode === 'pitch' && x >= p.left && x <= p.left + 70) return { type: 'master' };
    // Vol swatch (pinned first in the Volume-envelope tab).
    if (creatorSubmode === 'note' && x >= p.left && x <= p.left + 70) return { type: 'vol' };
    // Preview pitch selector (◀ name ▶)
    if (x >= W - 196 && x <= W - 108) {
      const dir = x < W - 196 + 29 ? -1 : (x < W - 196 + 59 ? 0 : 1);
      return { type: 'pitch', dir };
    }
    if (x >= W - 104 && x <= W - 14) return { type: 'reset' };
    return { type: 'bar' };
  }
  // Note-life row / voice-chips strip below the controls row.
  if (creatorSubmode === 'voices') {
    if (y >= LIFE_ROW_CY - 16 && y <= LIFE_ROW_CY + 16) {
      const l = selectedVoicesLayer();
      const nV = l ? layerVoices(l).length : 0;
      const rects = voiceChipRects(p);
      for (let i = 0; i < rects.length; i++) {
        const rc = rects[i];
        if (x >= rc.x && x <= rc.x + rc.w && y >= rc.y && y <= rc.y + rc.h) {
          if (i >= nV) return { type: 'voiceaddchip' };
          // ✕ badge on the selected chip deletes that voice.
          if (i === creatorVoiceSel && Math.hypot(x - (rc.x + rc.w - 12), y - LIFE_ROW_CY) < 12) return { type: 'voicedelchip', idx: i };
          // M badge (left) toggles that voice's mute.
          if (Math.hypot(x - (rc.x + 12), y - LIFE_ROW_CY) < 16) return { type: 'voicemute', idx: i };
          return { type: 'voicechip', idx: i };
        }
      }
      return { type: 'bar' };
    }
    // else: fall through so taps below the strip reach the slider area.
  }
  if ((creatorSubmode === 'note' || creatorSubmode === 'pitch') && y >= LIFE_ROW_CY - 14 && y <= LIFE_ROW_CY + 14) {
    const L = lifeSlider(p);
    if (x >= L.x1 - 10 && x <= L.x2 + 10) return { type: 'life' };
    return { type: 'bar' };
  }
  // Marker grab tabs (the lane above the plot; Volume envelope only). In the
  // Pitch tab the markers are display-only, so the lane isn't grabbable there.
  if (y > MARKER_LANE_TOP && y <= MARKER_LANE_BOTTOM && (creatorSubmode === 'note' || creatorSubmode === 'pitch')) {
    if (creatorSubmode === 'note') {
      for (const tab of markerTabs(p)) {
        if (x >= tab.x - 8 && x <= tab.x + tab.w + 8 && y >= tab.y - 5 && y <= tab.y + tab.h + 5) return { type: 'marker', key: tab.key };
      }
    }
    return { type: 'bar' };
  }
  // Waveform preset buttons (the same strip, Harmonics tab only).
  if (y > MARKER_LANE_TOP && y <= MARKER_LANE_BOTTOM && creatorSubmode === 'harm') {
    for (const b of harmPresetButtons(p)) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { type: 'harmpreset', name: b.name };
    }
    return { type: 'bar' };
  }
  // Snap-to-semitone toggle pill + interval preset chips (the same strip,
  // Voices tab only).
  if (y > MARKER_LANE_TOP && y <= MARKER_LANE_BOTTOM && creatorSubmode === 'voices') {
    const sp = voiceSnapPill(p);
    if (x >= sp.x - 6 && x <= sp.x + sp.w + 6 && y >= sp.y - 4 && y <= sp.y + sp.h + 4) return { type: 'voicesnap' };
    for (const b of voiceIntervalButtons(p)) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { type: 'voiceint', st: b.st };
    }
    return { type: 'bar' };
  }
  if (y >= p.top && y <= p.bottom) {
    // Draw-mode toolbar (top-right of the plot; not in the Voices tab).
    if (creatorSubmode !== 'voices') {
      const tb = drawToolbar(p);
      if (x >= tb.mode.x && x <= tb.mode.x + tb.mode.w && y >= tb.mode.y && y <= tb.mode.y + tb.mode.h) return { type: 'modetoggle' };
    }
    // ±range stepper pill (Pitch tab, plot top-left).
    if (creatorSubmode === 'pitch') {
      const rp = pitchRangePill(p);
      if (x >= rp.x && x <= rp.x + rp.w && y >= rp.y && y <= rp.y + rp.h) {
        return { type: 'pitchrange', dir: x < rp.x + rp.w * 0.35 ? -1 : (x > rp.x + rp.w * 0.65 ? 1 : 0) };
      }
    }
    // Voices tab: one slider per parameter with −/+ nudge buttons at both ends.
    if (creatorSubmode === 'voices') {
      const rows = voiceSliderRows(p);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (y >= r.cy - 16 && y <= r.cy + 16) {
          if (x >= r.x1 - r.btnW - 8 && x <= r.x1 - 8) return { type: 'vparam', keyIdx: i, dir: -1 };
          if (x >= r.x2 + 8 && x <= r.x2 + 8 + r.btnW) return { type: 'vparam', keyIdx: i, dir: 1 };
          if (x >= r.x1 - 8 && x <= r.x2 + 8) return { type: 'voiceslider', keyIdx: i };
          return { type: 'bar' };
        }
      }
      return { type: 'bar' };
    }
    // Draw/Erase mode takes over the whole graph: any drag scribbles (or zeroes).
    if (creatorDrawMode) return { type: 'draw' };
    // Segment-editor panel (floating top-left; Line mode only).
    const segHit = hitTestSegPanel(x, y, p);
    if (segHit) return segHit;
    if (creatorSubmode === 'harm') return hitTestHarm(x, y, p);
    // Pitch tab: the selected envelope's dots are grabbable; tapping anywhere
    // else adds a point there.
    if (creatorSubmode === 'pitch') {
      const env = selectedPitchEnvOrNull();
      if (env) {
        const r = Math.max(1, env.range || 1);
        for (let j = 0; j < env.points.length; j++) {
          const px = tToX(env.points[j].t, p), py = stToY(env.points[j].st, r, p);
          if (Math.hypot(x - px, y - py) < 18) return { type: 'pitchpoint', idx: j };
        }
      }
      return { type: 'emptypitch' };
    }
    // Volume-envelope tab: the selected curve (the master envelope when Vol is
    // selected, else one layer's mix curve) is editable. Switching between them
    // is done only from the swatch row above, never by tapping a curve.
    if (creatorVolSel) {
      // The envelope is selected: dots drag, tapping anywhere else splits it
      // (adds a boundary point at the tapped time). Mix curves don't steal the
      // tap here — switching layers is done from the swatch row above.
      return hitTestEnv(x, y, p);   // 'envbound' | 'envline' | 'empty'
    }
    // A layer's mix curve is selected: only its own breakpoints are grabbable
    // and tapping its own line adds a point there. Other layers' curves and the
    // envelope don't steal the tap — switching is done from the swatch row above
    // — so they fall through to 'empty' (adds a point to the selected curve).
    const selCurve = OSC_STACK.layers[selectedLayerIdx].curve;
    for (let j = 0; j < selCurve.length; j++) {
      const px = tToX(selCurve[j].t, p), py = vToY(clamp01(selCurve[j].v), p);
      if (Math.hypot(x - px, y - py) < 18) return { type: 'point', layerIdx: selectedLayerIdx, ptIdx: j };
    }
    if (distToCurve(selectedLayerIdx, x, y, p) < 22) return { type: 'line', layerIdx: selectedLayerIdx };
    return { type: 'empty' };
  }
  return { type: 'bar' };
}

/* ---- Pointer handling (active only in creator mode) ---- */
canvas.addEventListener('pointerdown', e => {
  if (!creatorActive) return;
  unlockAudio();
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  const x = stageX(e), y = stageY(e);
  const p = creatorPlot();
  const hit = hitTestCreator(x, y);
  // Delete mode: a single tap on a point removes it; taps that would otherwise
  // add or split points are ignored so the mode is strictly destructive.
  if (creatorDeleteMode) {
    if (hit.type === 'point' || hit.type === 'envbound' || hit.type === 'pitchpoint' || hit.type === 'harmpoint') {
      maybeAutoPreview();
      if (hit.type === 'envbound') envDeleteAt(Math.max(0, hit.idx - 1));
      else if (hit.type === 'pitchpoint') removePitchPoint(ensureSelectedPitchEnv(), hit.idx);
      else if (hit.type === 'harmpoint') removeSpecPoint(selectedLayer(), hit.idx);
      else removeCurvePoint(OSC_STACK.layers[hit.layerIdx], hit.ptIdx);
      clearSegSelection();
      previewAndSave();
      return;
    }
    if (hit.type === 'line' || hit.type === 'empty' || hit.type === 'envline' || hit.type === 'emptypitch' || hit.type === 'harm') return;
  }
  if (hit.type === 'back') { closeSoundCreator(); return; }
  if (hit.type === 'tab') {
    if (hit.enabled) {
      creatorSubmode = hit.submode;
      creatorVolSel = creatorSubmode === 'note';
      clearSegSelection();
      if (creatorSubmode === 'harm') initLayerSpecPoints(selectedLayer());
      if (creatorSubmode === 'voices') clampVoiceSel();
    }
    return;
  }
  if (hit.type === 'autopreview') {
    creatorAutoPreview = !creatorAutoPreview;
    saveSettings();
    return;
  }
  if (hit.type === 'previewbtn') {
    previewChime();
    return;
  }
  if (hit.type === 'voicechip') {
    creatorVoiceSel = hit.idx;
    creatorPtr = null;
    maybeAutoPreview();
    return;
  }
  if (hit.type === 'voiceaddchip') {
    if (addVoiceToSelected()) {
      creatorPtr = null;
      previewAndSave();
    }
    return;
  }
  if (hit.type === 'voicedelchip') {
    const l = selectedVoicesLayer();
    if (l && l.voices && l.voices[hit.idx] != null) {
      l.voices.splice(hit.idx, 1);
      if (!l.voices.length) l.voices = null;   // back to a plain single osc
      clampVoiceSel();
      creatorPtr = null;
      previewAndSave();
    }
    return;
  }
  if (hit.type === 'voicemute') {
    const l = selectedVoicesLayer();
    if (l && l.voices && l.voices[hit.idx] != null) {
      l.voices[hit.idx].muted = !l.voices[hit.idx].muted;
      creatorPtr = null;
      previewAndSave();
    }
    return;
  }
  if (hit.type === 'layermute') {
    const l = OSC_STACK.layers[hit.layerIdx];
    if (l) {
      l.muted = !l.muted;
      creatorPtr = null;
      previewAndSave();
    }
    return;
  }
  if (hit.type === 'voicesnap') {
    creatorVoiceSnap = !creatorVoiceSnap;
    saveSettings();
    return;
  }
  if (hit.type === 'voiceint') {
    // Jump the selected voice's semitone offset to the tapped interval.
    const v = selectedVoice();
    if (v) {
      v.st = Math.max(VOICE_PARAM_DEFS[0].min, Math.min(VOICE_PARAM_DEFS[0].max, hit.st));
      creatorPtr = null;
      previewAndSave();
    }
    return;
  }
  if (hit.type === 'vparam') {
    // −/+ nudge buttons: fine steps on the selected voice's parameter. When
    // snapping is on, the Semitones row moves by whole semitones instead.
    const v = selectedVoice();
    const d = VOICE_PARAM_DEFS[hit.keyIdx];
    if (v && d) {
      if (d.key === 'st' && creatorVoiceSnap) {
        v.st = Math.max(d.min, Math.min(d.max, Math.round(+v.st || 0) + hit.dir));
      } else {
        const cur = +v[d.key] || 0;
        v[d.key] = Math.max(d.min, Math.min(d.max, Math.round(cur / d.step) * d.step + hit.dir * d.step));
      }
      if (d.key === 'vol') v.vol = Math.round((v.vol || 0) * 100) / 100;
      previewAndSave();
    }
    return;
  }
  if (hit.type === 'voiceslider') {
    // Grab a slider: continuous fine control while dragging.
    const v = selectedVoice();
    const row = voiceSliderRows(creatorPlot())[hit.keyIdx];
    if (v && row) {
      v[row.def.key] = voiceParamFromX(row, x);
      creatorPtr = { mode: 'voiceparam', keyIdx: hit.keyIdx, x0: x, y0: y };
      previewAndSave();
    }
    return;
  }
  if (hit.type === 'vol') {
    creatorVolSel = true;
    creatorPtr = null;
    clearSegSelection();
    maybeAutoPreview();
    return;
  }
  if (hit.type === 'master') {
    // Selecting the Master swatch materializes the master envelope: while it
    // exists it drives every layer (flat = no bend anywhere).
    creatorPitchSel = 'master';
    if (!MASTER_PITCH_ENV) MASTER_PITCH_ENV = defaultPitchEnv();
    creatorPtr = null;
    clearSegSelection();
    maybeAutoPreview();
    saveSettings();
    return;
  }
  if (hit.type === 'delmaster') {
    // Non-destructive override off: per-layer envelopes take over again.
    MASTER_PITCH_ENV = null;
    creatorPtr = null;
    clearSegSelection();
    previewAndSave();
    return;
  }
  if (hit.type === 'layer') {
    selectedLayerIdx = hit.layerIdx;
    creatorVolSel = false;
    if (creatorSubmode === 'pitch') creatorPitchSel = hit.layerIdx;
    clearSegSelection();
    if (creatorSubmode === 'harm') initLayerSpecPoints(selectedLayer());
    if (creatorSubmode === 'voices') clampVoiceSel();
    creatorPtr = null;
    maybeAutoPreview();
    return;
  }
  if (hit.type === 'pitchrange') {
    if (hit.dir !== 0) {
      const env = ensureSelectedPitchEnv();
      env.range = Math.max(1, Math.min(MAX_PITCH_ENV_RANGE, Math.round(env.range || 1) + hit.dir));
      previewAndSave();
    }
    return;
  }
  if (hit.type === 'pitchpoint') {
    maybeAutoPreview();
    const env = ensureSelectedPitchEnv();
    if (creatorLastTap && performance.now() - creatorLastTap.t < 400 && Math.hypot(x - creatorLastTap.x, y - creatorLastTap.y) < 26) {
      removePitchPoint(env, hit.idx);
      creatorLastTap = null;
      clampSegSelection();
      previewAndSave();
      return;
    }
    creatorLastTap = { t: performance.now(), x, y };
    creatorPtr = { mode: 'pitchpoint', idx: hit.idx, x0: x, y0: y };
    return;
  }
  if (hit.type === 'emptypitch') {
    // Tapping anywhere on the graph adds a breakpoint there.
    const env = ensureSelectedPitchEnv();
    const r = Math.max(1, env.range || 1);
    const idx = insertPitchPoint(env, xToT(x, p), yToSt(y, r, p));
    if (idx >= 0) creatorPtr = { mode: 'pitchpoint', idx, x0: x, y0: y };
    clearSegSelection();
    previewAndSave();
    return;
  }
  if (hit.type === 'addlayer') {
    if (OSC_STACK.layers.length >= 8) return;
    OSC_STACK.layers.push(defaultLayer('osc-' + (OSC_STACK.layers.length + 1)));
    selectedLayerIdx = OSC_STACK.layers.length - 1;
    creatorVolSel = false;
    clearSegSelection();
    if (creatorSubmode === 'harm') initLayerSpecPoints(selectedLayer());
    previewAndSave();
    return;
  }
  if (hit.type === 'dellayer') {
    if (OSC_STACK.layers.length <= 1) return;
    OSC_STACK.layers.splice(selectedLayerIdx, 1);
    selectedLayerIdx = Math.max(0, Math.min(OSC_STACK.layers.length - 1, selectedLayerIdx));
    clearSegSelection();
    if (creatorSubmode === 'harm') initLayerSpecPoints(selectedLayer());
    if (creatorSubmode === 'voices') clampVoiceSel();
    previewAndSave();
    return;
  }
  if (hit.type === 'life') {
    applyLifeFromX(x);
    scheduleCreatorPreview();
    creatorPtr = { mode: 'life', x0: x, y0: y };
    return;
  }
  if (hit.type === 'reset') {
    if (creatorSubmode === 'harm') {
      const l = selectedLayer();
      l.specPoints = null;
      l.presetId = null;
      for (let i = 0; i < HARMONIC_COUNT; i++) l.amplitudes[i] = i === 0 ? 1 : 0;
      initLayerSpecPoints(l);
    } else if (creatorSubmode === 'pitch') {
      const env = ensureSelectedPitchEnv();
      env.points = [{ t: 0, st: 0 }, { t: 1, st: 0 }];   // flat: no bend (range kept)
    } else if (creatorSubmode === 'voices') {
      const l = selectedVoicesLayer();
      if (l) {
        l.voices = null;      // clear all duplicates → back to a plain single osc
        creatorVoiceSel = 0;
      }
    } else if (creatorVolSel) {
      ENVELOPE = clone(DEFAULT_ENVELOPE);
      clampEnvelopeIndexes();
    } else {
      resetLayerCurve(selectedLayer());
    }
    clearSegSelection();
    previewAndSave();
    return;
  }
  if (hit.type === 'harmpreset') {
    applyPresetToLayer(selectedLayer(), hit.name);
    initLayerSpecPoints(selectedLayer());
    previewAndSave();
    return;
  }
  if (hit.type === 'modetoggle') {
    // Single mode button cycles Point -> Draw -> Erase -> Delete -> Line -> Point.
    clearSegSelection();            // From/To selection lives only in Line mode
    if (creatorEraseMode) {          // Erase -> Delete
      creatorDrawMode = false;
      creatorEraseMode = false;
      creatorDeleteMode = true;
      creatorSegMode = false;
    } else if (creatorDrawMode) {    // Draw -> Erase (Erase implies Draw)
      creatorEraseMode = true;
    } else if (creatorDeleteMode) {  // Delete -> Line
      creatorDeleteMode = false;
      creatorDrawMode = false;
      creatorEraseMode = false;
      creatorSegMode = true;
    } else if (creatorSegMode) {     // Line -> Point
      creatorSegMode = false;
      creatorDrawMode = false;
      creatorEraseMode = false;
      creatorDeleteMode = false;
    } else {                         // Point -> Draw
      creatorDrawMode = true;
      creatorEraseMode = false;
      creatorDeleteMode = false;
      creatorSegMode = false;
    }
    creatorPtr = null;
    return;
  }
  if (hit.type === 'segclear') { clearSegSelection(); return; }
  if (hit.type === 'segtype') { setSegType(hit.t); return; }
  if (hit.type === 'segparam') {
    const R = segPanelRects(p);
    const pr = R.paramRows.find(r => r.key === hit.key);
    if (pr) setSegParam(hit.key, segParamValue(hit.key) + hit.dir * SEG_PARAM_DEFS[hit.key].step);
    creatorPtr = { mode: 'segparam', key: hit.key, x0: x, y0: y };
    return;
  }
  if (hit.type === 'segslider') {
    const R = segPanelRects(p);
    const pr = R.paramRows.find(r => r.key === hit.key);
    if (pr) applySegParam(hit.key, segParamFromX(pr, x));
    creatorPtr = { mode: 'segparam', key: hit.key, x0: x, y0: y };
    scheduleCreatorPreview();
    return;
  }
  if (hit.type === 'draw') {
    // Start a scribble on the current selection. The slot grid spans the whole
    // graph, but a stroke only touches the slots it sweeps through — points
    // elsewhere are never modified. Use the Reset button to clear the shape.
    const p = creatorPlot();
    const s0 = slotAtX(x, p);
    drawPlacePointAtSlot(s0, y, p);
    creatorPtr = { mode: 'draw', layerIdx: selectedLayerIdx, x0: x, y0: y, lastSlot: s0 };
    previewAndSave();
    return;
  }
  if (hit.type === 'bar') { creatorPtr = null; return; }
  if (hit.type === 'pitch') {
    if (hit.dir !== 0) {
      const positions = pitchPositions();
      const n = positions.length || 1;
      const cur = Math.max(0, Math.min(n - 1, PREVIEW_PITCH || 0));
      PREVIEW_PITCH = (cur + hit.dir + n) % n;
      previewAndSave();
    }
    return;
  }
  if (hit.type === 'marker') { maybeAutoPreview(); creatorPtr = { mode: 'marker', key: hit.key, x0: x, y0: y }; return; }
  if (hit.type === 'harmpoint') {
    maybeAutoPreview();
    const l = selectedLayer();
    if (creatorLastTap && performance.now() - creatorLastTap.t < 400 && Math.hypot(x - creatorLastTap.x, y - creatorLastTap.y) < 26) {
      removeSpecPoint(l, hit.idx);
      creatorLastTap = null;
      previewAndSave();
      return;
    }
    creatorLastTap = { t: performance.now(), x, y };
    creatorPtr = { mode: 'harmpoint', layerIdx: selectedLayerIdx, idx: hit.idx, x0: x, y0: y };
    return;
  }
  if (hit.type === 'envbound') {
    maybeAutoPreview();
    if (creatorLastTap && performance.now() - creatorLastTap.t < 400 && Math.hypot(x - creatorLastTap.x, y - creatorLastTap.y) < 26) {
      envDeleteAt(Math.max(0, hit.idx - 1));   // the component ending at this boundary
      creatorLastTap = null;
      clampSegSelection();
      previewAndSave();
      return;
    }
    creatorLastTap = { t: performance.now(), x, y };
    creatorPtr = { mode: 'envbound', idx: hit.idx, x0: x, y0: y };
    return;
  }
  if (hit.type === 'envline') {
    const eb = envBoundaries();
    envSplitAtTime(clamp01(xToT(x, p)) * eb.total);
    clearSegSelection();
    previewAndSave();
    return;
  }
  if (hit.type === 'point') {
    maybeAutoPreview();
    if (creatorLastTap && performance.now() - creatorLastTap.t < 400 && Math.hypot(x - creatorLastTap.x, y - creatorLastTap.y) < 26) {
      removeCurvePoint(OSC_STACK.layers[hit.layerIdx], hit.ptIdx);
      creatorLastTap = null;
      clampSegSelection();
      previewAndSave();
      return;
    }
    creatorLastTap = { t: performance.now(), x, y };
    creatorVolSel = false;
    creatorPtr = { mode: 'point', layerIdx: hit.layerIdx, ptIdx: hit.ptIdx, x0: x, y0: y };
    return;
  }
  if (hit.type === 'line') {
    // Tapping the selected layer's own line adds a point there.
    const idx = insertCurvePoint(OSC_STACK.layers[hit.layerIdx], xToT(x, p), yToV(y, p));
    if (idx >= 0) creatorPtr = { mode: 'point', layerIdx: hit.layerIdx, ptIdx: idx, x0: x, y0: y };
    clearSegSelection();
    previewAndSave();
    return;
  }
  // Empty: add to the selected curve — split the envelope (Vol) or add a mix
  // breakpoint (a layer).
  const l = selectedLayer();
  if (creatorSubmode === 'harm') {
    const hidx = insertSpecPoint(l, xToT(x, p), yToAmp(y, p));
    if (hidx >= 0) {
      syncLayerAmplitudes(l);
      creatorPtr = { mode: 'harmpoint', layerIdx: selectedLayerIdx, idx: hidx, x0: x, y0: y };
    }
    previewAndSave();
    return;
  }
  if (creatorVolSel) {
    const eb = envBoundaries();
    envSplitAtTime(clamp01(xToT(x, p)) * eb.total);
    clearSegSelection();
    previewAndSave();
    return;
  }
  const idx = insertCurvePoint(l, xToT(x, p), yToV(y, p));
  if (idx >= 0) creatorPtr = { mode: 'point', layerIdx: selectedLayerIdx, ptIdx: idx, x0: x, y0: y };
  clearSegSelection();
  previewAndSave();
});

canvas.addEventListener('pointermove', e => {
  if (!creatorActive || !creatorPtr) return;
  const x = stageX(e), y = stageY(e);
  if (Math.hypot(x - creatorPtr.x0, y - creatorPtr.y0) > 4) creatorPtr.moved = true;
  const p = creatorPlot();
  if (creatorPtr.mode === 'point') {
    const l = OSC_STACK.layers[creatorPtr.layerIdx];
    const pt = l && l.curve[creatorPtr.ptIdx];
    if (pt) {
      pt.t = clamp01(xToT(x, p));
      pt.v = clamp01(yToV(y, p));
      l.curve.sort((a, b) => a.t - b.t);
      creatorPtr.ptIdx = l.curve.indexOf(pt);
      scheduleCreatorPreview();
    }
  } else if (creatorPtr.mode === 'marker') {
    dragCreatorMarker(creatorPtr.key, xToT(x, p));
    scheduleCreatorPreview();
  } else if (creatorPtr.mode === 'envbound') {
    envDragBoundary(creatorPtr.idx, xToT(x, p), yToV(y, p));
    scheduleCreatorPreview();
  } else if (creatorPtr.mode === 'life') {
    applyLifeFromX(x);
    scheduleCreatorPreview();
  } else if (creatorPtr.mode === 'voiceparam') {
    const v = selectedVoice();
    const row = voiceSliderRows(p)[creatorPtr.keyIdx];
    if (v && row) {
      v[row.def.key] = voiceParamFromX(row, x);
      if (row.def.key === 'vol') v.vol = Math.round((v.vol || 0) * 100) / 100;
      scheduleCreatorPreview();
    }
  } else if (creatorPtr.mode === 'pitchpoint') {
    const env = ensureSelectedPitchEnv();
    const r = Math.max(1, env.range || 1);
    const pt = env.points[creatorPtr.idx];
    if (pt) {
      pt.t = clamp01(xToT(x, p));
      pt.st = Math.max(-r, Math.min(r, yToSt(y, r, p)));
      env.points.sort((a, b) => a.t - b.t);
      creatorPtr.idx = env.points.indexOf(pt);
      scheduleCreatorPreview();
    }
  } else if (creatorPtr.mode === 'harmpoint') {
    const l = OSC_STACK.layers[creatorPtr.layerIdx];
    const pt = l && l.specPoints[creatorPtr.idx];
    if (pt) {
      pt.x = clamp01(xToT(x, p));
      pt.a = yToAmp(y, p);
      l.specPoints.sort((a, b) => a.x - b.x);
      creatorPtr.idx = l.specPoints.indexOf(pt);
      syncLayerAmplitudes(l);
      scheduleCreatorPreview();
    }
  } else if (creatorPtr.mode === 'draw') {
    const ns = slotAtX(x, p);
    drawPlacePointAtSlot(ns, y, p, creatorPtr.lastSlot);
    creatorPtr.lastSlot = ns;
    scheduleCreatorPreview();
  } else if (creatorPtr.mode === 'segparam') {
    const R = segPanelRects(p);
    const pr = R.paramRows.find(r => r.key === creatorPtr.key);
    if (pr) {
      applySegParam(creatorPtr.key, segParamFromX(pr, x));
      scheduleCreatorPreview();
    }
  }
  creatorPtr.x0 = x; creatorPtr.y0 = y;
});

canvas.addEventListener('pointerup', e => {
  if (!creatorActive || !creatorPtr) return;
  const wasTap = !creatorPtr.moved;
  const mode = creatorPtr.mode;
  // A point drag that never moved is a selection tap: choose the From/To end.
  const idx = (mode === 'point') ? creatorPtr.ptIdx : (creatorPtr.idx != null ? creatorPtr.idx : null);
  creatorPtr = null;
  if (wasTap && idx != null && creatorSegMode && (mode === 'point' || mode === 'envbound' || mode === 'pitchpoint')) {
    selectSegPoint(idx);
  }
  saveSettings();
});

canvas.addEventListener('pointercancel', () => {
  if (!creatorActive) return;
  creatorPtr = null;
  saveSettings();
});

function previewAndSave() {
  scheduleCreatorPreview();
  saveSettings();
}

/* ---- Rendering ---- */
function drawRoundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCreator(now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f4faf0';
  ctx.fillRect(0, 0, W, H);
  const p = creatorPlot();

  // ---- Top bar ----
  ctx.fillStyle = '#2e5d34';
  ctx.fillRect(0, 0, W, 64);
  drawRoundRect(14, 12, 60, 40, 12);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.fillStyle = '#2e5d34';
  ctx.font = '700 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('‹', 44, 39);
  ctx.font = '700 16px sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  // Clamp the title left of the tabs so it never slides underneath them on
  // narrow screens.
  const tabs = creatorTabs();
  const tabLeft = W - 14 - tabs.length * CREATOR_TAB_W;
  ctx.fillText('Sound creator', Math.min(W / 2, tabLeft - 72), 36);
// Prominent readout of the exact preview pitch + frequency the test plays,
// plus the note's spectral center at the start and end of the note — so a
// rising "pitch" from the mix morphing is visibly explained.
  ctx.font = '700 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Test: ' + previewPitchName() + ' · ' + previewPitchFreq().toFixed(1) + ' Hz', 84, 38);
  ctx.fillText('spectral center: ' + centroidPitchName(0) + ' → ' + centroidPitchName(1), 84, 58);
  let tx = W - 14;
  for (let i = tabs.length - 1; i >= 0; i--) {
    const w = CREATOR_TAB_W, x = tx - w;
    tx = x;
    const active = tabs[i].submode === creatorSubmode;
    ctx.globalAlpha = tabs[i].enabled ? 1 : 0.45;
    drawRoundRect(x, 12, w, 40, 12);
    ctx.fillStyle = active ? '#fff' : 'rgba(255,255,255,0.18)';
    ctx.fill();
    ctx.fillStyle = active ? '#2e5d34' : '#fff';
    ctx.font = '700 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(tabs[i].label, x + w / 2, 38);
    ctx.globalAlpha = 1;
  }

  // ---- Legend (Vol/Master + layer colors + add/remove + reset) ----
  const sw = (creatorSubmode === 'note' || creatorSubmode === 'pitch') ? 1 : 0;   // note pins Vol first; pitch pins Master
  if (creatorSubmode === 'note') {
    ctx.fillStyle = '#1b4523';
    ctx.beginPath();
    ctx.arc(p.left + 7, 78, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = (creatorVolSel ? '800 ' : '700 ') + '11px sans-serif';
    ctx.fillStyle = creatorVolSel ? '#1b4523' : '#6b8e5a';
    ctx.textAlign = 'left';
    ctx.fillText('Vol', p.left + 18, 82);
  }
  if (creatorSubmode === 'pitch') {
    const masterSel = creatorPitchSel === 'master';
    ctx.fillStyle = '#1b4523';
    ctx.beginPath();
    ctx.arc(p.left + 7, 78, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = (masterSel ? '800 ' : '700 ') + '11px sans-serif';
    ctx.fillStyle = masterSel ? '#1b4523' : '#6b8e5a';
    ctx.textAlign = 'left';
    ctx.fillText('Master', p.left + 18, 82);
    if (MASTER_PITCH_ENV) {
      // ✕ clear-master badge: turns the override off so per-layer envelopes
      // take over again (they are kept, not erased).
      const bx = p.left + 62, by = 72;
      ctx.beginPath();
      ctx.arc(bx, by, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#c0392b';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '800 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('✕', bx, by + 4);
    }
  }
  for (let i = 0; i < OSC_STACK.layers.length; i++) {
    const cx = p.left + sw * 76 + i * 76;
    const sel = creatorSubmode === 'pitch' ? creatorPitchSel === i : i === selectedLayerIdx;
    const muted = !!(OSC_STACK.layers[i].muted);
    const color = OSC_COLORS[i % OSC_COLORS.length];
    // Mute button (the swatch's icon): 🔊 when the layer is live, 🔇 when
    // muted. A white chip with a layer-colored border (red border when muted).
    drawRoundRect(cx + 1, 68, 20, 20, 6);
    ctx.fillStyle = muted ? '#fdecea' : '#fff';
    ctx.fill();
    ctx.strokeStyle = muted ? '#c0392b' : color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(muted ? '🔇' : '🔊', cx + 11, 78);
    ctx.textBaseline = 'alphabetic';
    ctx.font = (sel ? '800 ' : '700 ') + '11px sans-serif';
    ctx.fillStyle = muted ? '#9db89c' : (sel ? '#1b4523' : '#6b8e5a');
    ctx.textAlign = 'left';
    ctx.fillText('Osc ' + (i + 1), cx + 27, 82);
    // ✕ delete badge on the selected layer (layers only, hidden when it's the last one).
    if (sel && (creatorSubmode === 'pitch' || !creatorVolSel) && OSC_STACK.layers.length > 1) {
      const bx = cx + 62, by = 72;
      ctx.beginPath();
      ctx.arc(bx, by, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#c0392b';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '800 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('✕', bx, by + 4);
    }
  }
  // ➕ add-layer button after the last swatch.
  if (OSC_STACK.layers.length < 8) {
    const ax = p.left + sw * 76 + OSC_STACK.layers.length * 76 + 7, ay = 78;
    ctx.beginPath();
    ctx.arc(ax, ay, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#9db89c';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '800 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('+', ax, ay + 4);
    ctx.font = '700 11px sans-serif';
    ctx.fillStyle = '#6b8e5a';
    ctx.textAlign = 'left';
    ctx.fillText('Add', ax + 14, 82);
  }
  // Auto-preview toggle + manual preview button (left of the pitch selector).
  const tp = creatorTopPills();
  drawRoundRect(tp.auto.x, tp.auto.y, tp.auto.w, tp.auto.h, 8);
  ctx.fillStyle = creatorAutoPreview ? '#2e5d34' : '#fff';
  ctx.fill();
  ctx.strokeStyle = 'rgba(46,93,52,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = creatorAutoPreview ? '#fff' : '#6b8e5a';
  ctx.font = '700 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(creatorAutoPreview ? 'Auto on' : 'Auto off', tp.auto.x + tp.auto.w / 2, tp.auto.y + tp.auto.h / 2 + 3);
  drawRoundRect(tp.preview.x, tp.preview.y, tp.preview.w, tp.preview.h, 8);
  ctx.fillStyle = '#2e5d34';
  ctx.fill();
  ctx.strokeStyle = 'rgba(46,93,52,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '700 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('▶ Preview', tp.preview.x + tp.preview.w / 2, tp.preview.y + tp.preview.h / 2 + 3);
  // Preview pitch selector (◀ name ▶)
  const pcx = W - 196;
  drawRoundRect(pcx, 68, 88, 22, 8);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.fillStyle = '#2e5d34';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('◀', pcx + 13, 83);
  ctx.fillText(previewPitchName(), pcx + 44, 83);
  ctx.fillText('▶', pcx + 75, 83);
  drawRoundRect(W - 104, 68, 90, 22, 8);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.fillStyle = '#2e5d34';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(creatorVolSel ? '↺ Reset vol' : creatorSubmode === 'pitch' ? '↺ Reset pitch' : creatorSubmode === 'voices' ? '↺ Clear all' : creatorSubmode === 'harm' ? '↺ Reset spec' : '↺ Reset curve', W - 59, 83);

  // Voice chips strip (Voices tab): pick which duplicate to edit, or add one.
  if (creatorSubmode === 'voices') {
    const l = selectedVoicesLayer();
    const nV = l ? layerVoices(l).length : 0;
    const rects = voiceChipRects(p);
    ctx.textAlign = 'center';
    for (let i = 0; i < nV; i++) {
      const rc = rects[i], selChip = i === creatorVoiceSel;
      const v = l.voices[i];
      const vMuted = !!(v && v.muted);
      drawRoundRect(rc.x, rc.y, rc.w, rc.h, 8);
      ctx.fillStyle = selChip ? (vMuted ? '#5c8a62' : '#2e5d34') : (vMuted ? '#e5eee1' : '#fff');
      ctx.fill();
      ctx.strokeStyle = vMuted ? 'rgba(107,142,90,0.55)' : 'rgba(46,93,52,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Mute badge: the button at the left of each chip (tap it to mute/unmute).
      const mbx = rc.x + 12, mby = LIFE_ROW_CY;
      ctx.beginPath();
      ctx.arc(mbx, mby, 8.5, 0, Math.PI * 2);
      ctx.fillStyle = vMuted ? '#c0392b' : '#eef5ea';
      ctx.fill();
      ctx.strokeStyle = vMuted ? '#c0392b' : 'rgba(46,93,52,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = '12px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(vMuted ? '🔇' : '🔊', mbx, mby + 1);
      ctx.textBaseline = 'alphabetic';
      const lbl = 'V' + (i + 1) + ' · ' + (Math.round((+v.st || 0) * 100) / 100) + ' st';
      ctx.fillStyle = selChip ? '#fff' : (vMuted ? '#9db89c' : '#2e5d34');
      ctx.font = '700 10px sans-serif';
      ctx.fillText(lbl, rc.x + rc.w / 2 + 8 - (selChip ? 6 : 0), rc.y + 17);
      if (vMuted && !selChip) {
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(rc.x + 4, rc.y + 4); ctx.lineTo(rc.x + rc.w - 4, rc.y + rc.h - 4);
        ctx.stroke();
      }
      if (selChip) {
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.arc(rc.x + rc.w - 12, LIFE_ROW_CY, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '800 9px sans-serif';
        ctx.fillText('✕', rc.x + rc.w - 12, LIFE_ROW_CY + 3);
      }
    }
    if (nV < MAX_LAYER_VOICES) {
      const rc = rects[nV];
      drawRoundRect(rc.x, rc.y, rc.w, rc.h, 8);
      ctx.fillStyle = '#eef5ea';
      ctx.fill();
      ctx.strokeStyle = 'rgba(46,93,52,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#2e5d34';
      ctx.font = '800 11px sans-serif';
      ctx.fillText('+', rc.x + rc.w / 2, rc.y + 17);
    }
  }

  // Note-lifetime slider (note + pitch tabs; dedicated row below the controls
  // row, above the HOLD/CUT/REL marker lane).
  if (creatorSubmode === 'note' || creatorSubmode === 'pitch') {
    const L = lifeSlider(p);
    const totalS = noteLifetimeMs() / 1000;
    const f = clamp01((totalS - L.minSec) / (L.maxSec - L.minSec));
    const tx1 = L.x1 + 60, tx2 = L.x2 - 44;
    ctx.font = '700 10px sans-serif';
    ctx.fillStyle = '#6b8e5a';
    ctx.textAlign = 'left';
    ctx.fillText('Note life', L.x1 + 2, L.cy + 4);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(46,93,52,0.22)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(tx1, L.cy); ctx.lineTo(tx2, L.cy);
    ctx.stroke();
    ctx.strokeStyle = '#2e5d34';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(tx1, L.cy); ctx.lineTo(tx1 + f * (tx2 - tx1), L.cy);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(tx1 + f * (tx2 - tx1), L.cy, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#2e5d34';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#2e5d34';
    ctx.font = '700 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(totalS.toFixed(1) + 's', L.x2, L.cy + 4);
  }

  // ---- Marker grab tabs (Volume envelope / Pitch tabs only) ----
  if (creatorSubmode === 'note' || creatorSubmode === 'pitch') {
    const dimmed = creatorSubmode === 'pitch';
    for (const tab of markerTabs(p)) {
      const lineColor = dimmed ? markerDim(tab.color, 25, 52) : tab.color;
      const fillColor = dimmed ? markerDim(tab.color, 30, 82) : tab.color;
      const labelColor = dimmed ? markerDim(tab.color, 32, 28) : '#fff';
      // Connector from the tab down to its dashed line so the pairing is obvious.
      ctx.strokeStyle = lineColor;
      ctx.globalAlpha = dimmed ? 0.7 : 0.55;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tab.cx, tab.y + tab.h);
      ctx.lineTo(tab.cx, p.top);
      ctx.stroke();
      ctx.globalAlpha = 1;
      drawRoundRect(tab.x, tab.y, tab.w, tab.h, 7);
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.fillStyle = labelColor;
      ctx.font = '800 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(tab.label, tab.cx, tab.y + 15);
    }
  }

  // ---- Waveform presets (Harmonics tab only) ----
  if (creatorSubmode === 'harm') {
    const current = matchPreset(selectedLayer().amplitudes);
    const accent = OSC_COLORS[selectedLayerIdx % OSC_COLORS.length];
    for (const b of harmPresetButtons(p)) {
      const active = b.name === current;
      drawRoundRect(b.x, b.y, b.w, b.h, 8);
      ctx.fillStyle = active ? accent : '#fff';
      ctx.fill();
      ctx.fillStyle = active ? '#fff' : '#2e5d34';
      ctx.font = '700 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 4);
    }
  }

  // ---- Snap-to-semitone toggle pill (Voices tab only, above the plot) ----
  if (creatorSubmode === 'voices') {
    const sp = voiceSnapPill(p);
    drawRoundRect(sp.x, sp.y, sp.w, sp.h, 8);
    ctx.fillStyle = creatorVoiceSnap ? '#2e5d34' : '#fff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(46,93,52,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = creatorVoiceSnap ? '#fff' : '#2e5d34';
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(creatorVoiceSnap ? 'Snap on' : 'Snap', sp.x + sp.w / 2, sp.y + sp.h / 2 + 3);
  }

  // ---- Interval preset chips (Voices tab only, right of the Snap pill) ----
  if (creatorSubmode === 'voices') {
    const v = selectedVoice();
    const active = v ? Math.round(+v.st || 0) : NaN;
    for (const b of voiceIntervalButtons(p)) {
      const on = active === b.st;
      drawRoundRect(b.x, b.y, b.w, b.h, 8);
      ctx.fillStyle = on ? '#2e5d34' : '#fff';
      ctx.fill();
      ctx.strokeStyle = on ? '#2e5d34' : 'rgba(46,93,52,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = v ? 1 : 0.4;
      ctx.fillStyle = on ? '#fff' : '#2e5d34';
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 3);
      ctx.globalAlpha = 1;
    }
  }

  // ---- Grid ----
  ctx.strokeStyle = 'rgba(46,93,52,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= 10; k++) {
    const x = tToX(k / 10, p);
    ctx.moveTo(x, p.top); ctx.lineTo(x, p.bottom);
    const y = vToY(k / 10, p);
    ctx.moveTo(p.left, y); ctx.lineTo(p.right, y);
  }
  ctx.stroke();
  ctx.strokeStyle = '#2e5d34';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(p.left, p.top, p.pw, p.ph);

  // Axis labels
  ctx.fillStyle = '#6b8e5a';
  ctx.font = '700 10px sans-serif';
  ctx.textAlign = 'left';
  if (creatorSubmode === 'harm') {
    ctx.fillText('+100%', p.left + 2, p.top + 10);
    const y0 = ampToY(0, p);
    ctx.fillText('0', p.left + 2, y0 + 3);
    ctx.fillText('−100%', p.left + 2, p.bottom - 4);
  } else if (creatorSubmode === 'pitch') {
    const env = selectedPitchEnvOrNull();
    const r = env ? Math.max(1, env.range || 1) : 1;
    ctx.fillText('+' + r + ' st', p.left + 2, p.top + 46);
    const y0 = ampToY(0, p);
    ctx.fillText('0', p.left + 2, y0 + 3);
    ctx.fillText('−' + r + ' st', p.left + 2, p.bottom - 4);
    ctx.textAlign = 'right';
    ctx.fillText('note life →', p.right, p.bottom - 6);
  } else if (creatorSubmode === 'voices') {
    // No axis labels; the sliders carry their own labels/readouts below.
  } else {
    ctx.fillText('0%', p.left + 2, p.bottom - 6);
    ctx.textAlign = 'right';
    ctx.fillText('note life →', p.right, p.bottom - 6);
    ctx.textAlign = 'left';
    ctx.fillText('loudness 100%', p.left + 2, p.top + 10);
  }

  // ---- Markers (time-based sub-modes only) ----
  if (creatorSubmode === 'note' || creatorSubmode === 'pitch') {
    const dimmed = creatorSubmode === 'pitch';
    const markers = markerList();
    for (const m of markers) {
      const x = tToX(m.t, p);
      ctx.strokeStyle = dimmed ? markerDim(m.color, 25, 52) : m.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, p.top); ctx.lineTo(x, p.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---- Volume envelope + layer curves (note sub-mode) ----
  if (creatorSubmode === 'note') {
    const eb = envBoundaries();
    // Selected-range highlight behind the curve being edited.
    const hl = segRangeHighlight(p);
    if (hl) {
      ctx.fillStyle = 'rgba(46,93,52,0.09)';
      ctx.fillRect(hl.x0, p.top, hl.x1 - hl.x0, p.ph);
    }
    // Release-region tint (from the hold end).
    const relX = tToX(eb.tOf(eb.b[ENVELOPE.holdEndIndex + 1]), p);
    ctx.fillStyle = 'rgba(217,83,79,0.07)';
    ctx.fillRect(relX, p.top, p.right - relX, p.ph);
    // Layer mix curves (the selected layer solid, the others dimmed).
    for (let i = 0; i < OSC_STACK.layers.length; i++) {
      const l = OSC_STACK.layers[i];
      const sel = !creatorVolSel && i === selectedLayerIdx;
      const muted = !!(l.muted);
      ctx.strokeStyle = OSC_COLORS[i % OSC_COLORS.length];
      ctx.globalAlpha = muted ? 0.22 : (sel ? 1 : 0.5);
      ctx.lineWidth = sel ? 3 : 1.5;
      const curve = l.curve || [];
      if (!curve.length) { ctx.globalAlpha = 1; continue; }
      // Extend the flat clamped regions out to the plot edges, then stroke each
      // segment with its own line type.
      const pts = [{ x: tToX(0, p), y: vToY(curveValue(l, 0), p), v: curveValue(l, 0), el: null }];
      for (let k = 0; k < curve.length; k++) pts.push({ x: tToX(curve[k].t, p), y: vToY(clamp01(curve[k].v), p), v: clamp01(curve[k].v), el: curve[k] });
      pts.push({ x: tToX(1, p), y: vToY(curveValue(l, 1), p), v: curveValue(l, 1), el: null });
      strokeSegPath(pts, 1, v => vToY(clamp01(v), p));
      ctx.globalAlpha = 1;
      if (sel) {
        ctx.globalAlpha = muted ? 0.5 : 1;
        for (const pt of curve) {
          ctx.fillStyle = OSC_COLORS[i % OSC_COLORS.length];
          ctx.beginPath();
          ctx.arc(tToX(pt.t, p), vToY(clamp01(pt.v), p), 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
    // Master envelope outline (bold when Vol is selected, faint otherwise).
    ctx.globalAlpha = creatorVolSel ? 1 : 0.45;
    ctx.strokeStyle = '#2e5d34';
    ctx.lineWidth = creatorVolSel ? 3 : 1.5;
    const envPts = [];
    for (let i = 0; i <= eb.n; i++) envPts.push({ x: tToX(eb.tOf(eb.b[i]), p), y: vToY(eb.vals[i], p), v: eb.vals[i], el: i < eb.n ? eb.env.components[i] : null });
    strokeSegPath(envPts, 1, v => vToY(clamp01(v), p));
    ctx.globalAlpha = 1;
    if (creatorVolSel) {
      for (let i = 0; i <= eb.n; i++) {
        ctx.fillStyle = '#2e5d34';
        ctx.beginPath();
        ctx.arc(tToX(eb.tOf(eb.b[i]), p), vToY(eb.vals[i], p), 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  // ---- Pitch envelope (pitch sub-mode) ----
  if (creatorSubmode === 'pitch') {
    // Zero line = no pitch shift.
    const y0 = ampToY(0, p);
    ctx.strokeStyle = 'rgba(46,93,52,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.left, y0); ctx.lineTo(p.right, y0);
    ctx.stroke();
    const env = selectedPitchEnvOrNull();
    if (!env) {
      // No envelope on this selection yet: dashed guide until the first edit.
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(46,93,52,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.left, y0); ctx.lineTo(p.right, y0);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#9db89c';
      ctx.font = '700 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(creatorPitchSel === 'master'
        ? 'Master has no pitch envelope · tap or draw to create one'
        : 'Osc ' + (creatorPitchSel + 1) + ' has no pitch envelope · tap or draw to create one', W / 2, p.top + p.ph / 2 - 14);
    } else {
      const r = Math.max(1, env.range || 1);
      const isMaster = creatorPitchSel === 'master';
      const color = isMaster ? '#2e5d34' : OSC_COLORS[creatorPitchSel % OSC_COLORS.length];
      // Selected-range highlight behind the envelope.
      const hl = segRangeHighlight(p);
      if (hl) {
        ctx.fillStyle = 'rgba(46,93,52,0.09)';
        ctx.fillRect(hl.x0, p.top, hl.x1 - hl.x0, p.ph);
      }
      const pts = env.points;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      const path = [{ x: tToX(0, p), y: stToY(pitchStAt(env, 0), r, p), v: pitchStAt(env, 0), el: null }];
      for (let j = 0; j < pts.length; j++) path.push({ x: tToX(pts[j].t, p), y: stToY(pts[j].st, r, p), v: pts[j].st, el: pts[j] });
      path.push({ x: tToX(1, p), y: stToY(pitchStAt(env, 1), r, p), v: pitchStAt(env, 1), el: null });
      strokeSegPath(path, r, v => stToY(v, r, p));
      for (const pt of pts) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(tToX(pt.t, p), stToY(pt.st, r, p), 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    // ±range stepper pill (plot top-left).
    const rp = pitchRangePill(p);
    const rr = env ? Math.max(1, env.range || 1) : 1;
    drawRoundRect(rp.x, rp.y, rp.w, rp.h, 8);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(46,93,52,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#2e5d34';
    ctx.font = '700 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('−  ±' + rr + ' st  +', rp.x + rp.w / 2, rp.y + rp.h / 2 + 4);
  }

  // ---- Voices sliders (voices sub-mode) ----
  if (creatorSubmode === 'voices') {
    const v = selectedVoice();
    const rows = voiceSliderRows(p);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], d = r.def;
      // Label before the − button, current value after the + button — both on
      // the track's line, so a row's footprint is just its buttons.
      ctx.fillStyle = '#6b8e5a';
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(d.label, r.x1 - r.btnW - 12, r.cy + 3);
      ctx.fillText(v ? d.fmt(+v[d.key] || 0) : '—', p.right - 6, r.cy + 3);
      // −/+ nudge buttons.
      ctx.font = '700 13px sans-serif';
      ctx.textAlign = 'center';
      for (const side of ['-', '+']) {
        const bx = side === '-' ? r.x1 - r.btnW - 8 : r.x2 + 8;
        drawRoundRect(bx, r.cy - r.btnW / 2, r.btnW, r.btnW, 6);
        ctx.fillStyle = '#eef5ea';
        ctx.fill();
        ctx.strokeStyle = 'rgba(46,93,52,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#2e5d34';
        ctx.fillText(side === '-' ? '−' : '+', bx + r.btnW / 2, r.cy + 5);
      }
      // Track.
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(46,93,52,0.22)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(r.x1, r.cy); ctx.lineTo(r.x2, r.cy);
      ctx.stroke();
      // Bipolar center marker for semitones/cents; volume starts at zero.
      const midX = r.x1 + (r.x2 - r.x1) * ((0 - d.min) / (d.max - d.min));
      ctx.strokeStyle = 'rgba(46,93,52,0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(midX, r.cy - 9); ctx.lineTo(midX, r.cy + 9);
      ctx.stroke();
      // Snap grid: tick marks at each whole semitone along the track (visible
      // only while snapping is on, so the snap positions are obvious).
      if (d.key === 'st' && creatorVoiceSnap) {
        ctx.strokeStyle = 'rgba(46,93,52,0.30)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let s = Math.ceil(d.min); s <= Math.floor(d.max); s++) {
          const gx = r.x1 + (r.x2 - r.x1) * ((s - d.min) / (d.max - d.min));
          ctx.moveTo(gx, r.cy - 6); ctx.lineTo(gx, r.cy + 6);
        }
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
      // Fill + thumb for the current value.
      const cur = v ? Math.max(d.min, Math.min(d.max, +v[d.key] || 0)) : d.min;
      const tx = r.x1 + (r.x2 - r.x1) * ((cur - d.min) / (d.max - d.min));
      ctx.strokeStyle = '#2e5d34';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(r.x1, r.cy); ctx.lineTo(tx, r.cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, r.cy, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#2e5d34';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // ---- Spectrum (harm sub-mode) ----
  if (creatorSubmode === 'harm') {
    const l = selectedLayer();
    initLayerSpecPoints(l);
    const pts = l.specPoints;
    const color = OSC_COLORS[selectedLayerIdx % OSC_COLORS.length];
    // Zero line + harmonic guides
    const y0 = ampToY(0, p);
    ctx.strokeStyle = 'rgba(46,93,52,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.left, y0); ctx.lineTo(p.right, y0);
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = '700 8px sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i < HARMONIC_COUNT; i++) {
      const x = tToX(i / (HARMONIC_COUNT - 1), p);
      if (i >= 4 && i % 4 === 0) {
        ctx.strokeStyle = 'rgba(46,93,52,0.1)';
        ctx.beginPath();
        ctx.moveTo(x, p.top); ctx.lineTo(x, p.bottom);
        ctx.stroke();
      }
      ctx.fillStyle = '#000';
      ctx.fillText(String(i + 1), x, p.bottom + 10);
    }
    // Curve + dots (extend the clamped ends out to the plot edges); a muted
    // layer draws dimmed with a label so it reads as silent.
    ctx.globalAlpha = l.muted ? 0.3 : 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(tToX(0, p), ampToY(specValueAt(pts, 0), p));
    for (let j = 0; j < pts.length; j++) ctx.lineTo(tToX(pts[j].x, p), ampToY(pts[j].a, p));
    ctx.lineTo(tToX(1, p), ampToY(specValueAt(pts, 1), p));
    ctx.stroke();
    for (const pt of pts) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(tToX(pt.x, p), ampToY(pt.a, p), 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (l.muted) {
      ctx.fillStyle = '#c0392b';
      ctx.font = '700 12px sans-serif';
      ctx.fillText('MUTED', p.left + p.pw / 2, p.top + 24);
    }
  }

  // ---- Draw-mode toolbar (top-right of the plot; not in the Voices tab) ----
  if (creatorSubmode !== 'voices') {
    const tb = drawToolbar(p);
    const accent = OSC_COLORS[selectedLayerIdx % OSC_COLORS.length];
    ctx.textBaseline = 'middle';
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'center';
    drawRoundRect(tb.dens.x, tb.dens.y, tb.dens.w, tb.dens.h, 8);
    ctx.fillStyle = creatorDrawMode ? 'rgba(255,255,255,0.92)' : '#fff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(46,93,52,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#2e5d34';
    ctx.fillText(drawPointCount() + ' pts ▾', tb.dens.x + tb.dens.w / 2, tb.dens.y + tb.dens.h / 2 + 1);
    drawRoundRect(tb.mode.x, tb.mode.y, tb.mode.w, tb.mode.h, 8);
    ctx.fillStyle = creatorSegMode ? '#3949ab' : creatorDeleteMode ? '#c0392b' : creatorEraseMode ? '#d9534f' : creatorDrawMode ? accent : '#fff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(46,93,52,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = (creatorDrawMode || creatorEraseMode || creatorDeleteMode || creatorSegMode) ? '#fff' : '#2e5d34';
    ctx.fillText(creatorModeName(), tb.mode.x + tb.mode.w / 2, tb.mode.y + tb.mode.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';

    // Position the native points <select> over the pill (creator-active only).
    const ptsSel = document.getElementById('creatorPoints');
    if (ptsSel) {
      ptsSel.style.left = tb.dens.x + 'px';
      ptsSel.style.top = tb.dens.y + 'px';
      ptsSel.style.width = tb.dens.w + 'px';
      ptsSel.style.height = tb.dens.h + 'px';
      ptsSel.style.display = creatorActive ? 'block' : 'none';
    }
  }

  // ---- Segment editor: waiting for the To point (Line mode only) ----
  if (creatorSegMode && segFromIdx != null && segToIdx == null && !segPanelOpen && segModel()) {
    const wx = p.left + 4, wy = creatorSubmode === 'pitch' ? p.top + 44 : p.top + 10;
    const txt = 'From ' + segFromIdx + ' set — tap the To point';
    ctx.fillStyle = 'rgba(46,93,52,0.92)';
    drawRoundRect(wx, wy, Math.min(250, p.pw - 8), 24, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(txt, wx + Math.min(250, p.pw - 8) / 2, wy + 16);
  }

  // ---- Segment editor panel (floating top-left; Line mode only) ----
  if (segPanelOpen && creatorSegMode && segModel()) drawSegPanel(p);

  // ---- Hint ----
  ctx.fillStyle = '#6b8e5a';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  if (creatorSubmode === 'voices') {
    ctx.fillText('Pick an oscillator above and a voice chip to edit · drag the sliders or nudge with −/+ · tap an interval chip (−8 b3 3 4 5 8) to jump Semitones · Snap makes Semitones land on whole tones · tap a chip\u2019s 🔊 to mute it · ✕ deletes it · Reset clears them all', W / 2, H - 8);
  } else if (creatorSegMode) {
    ctx.fillText('Line-type mode · tap a dot for From, tap another for To (the points between are removed) and pick Line / Stairs / Spring / Pulse · Freq is the number of ups & downs across the segment · Depth is % of the full value scale · tap Mode to exit', W / 2, H - 8);
  } else if (creatorDeleteMode) {
    ctx.fillText('Delete mode · tap a dot to remove it · tap Mode to cycle back to Point (double-tap a dot also deletes in Point mode)', W / 2, H - 8);
  } else if (creatorDrawMode) {
    ctx.fillText(creatorEraseMode
      ? 'Erasing the ' + (creatorSubmode === 'note' ? (creatorVolSel ? 'volume envelope' : 'selected oscillator mix') : creatorSubmode === 'pitch' ? (creatorPitchSel === 'master' ? 'master pitch envelope' : 'selected oscillator pitch envelope') : 'selected oscillator spectrum') + ' · drag across a region to snap it to the erase line · tap Mode to edit dots'
      : creatorSubmode === 'note'
      ? 'Drawing the ' + (creatorVolSel ? 'volume envelope' : 'selected oscillator mix') + ' · drag to scribble (' + drawPointCount() + ' pts) · tap Mode to edit dots'
      : creatorSubmode === 'pitch'
        ? 'Drawing the ' + (creatorPitchSel === 'master' ? 'master pitch envelope (all oscillators)' : 'selected oscillator pitch envelope') + ' · drag to scribble (' + drawPointCount() + ' pts) · tap Mode to edit dots'
        : 'Drawing the selected oscillator spectrum · drag to scribble (' + drawPointCount() + ' pts) · tap Mode to edit dots', W / 2, H - 8);
  } else {
    ctx.fillText(creatorSubmode === 'note'
      ? 'Pick Vol or an oscillator above · tap a swatch\u2019s 🔊 to mute it · drag HOLD/CUT/REL markers and set note life on the right · drag dots · tap a curve to add a point or split · double-tap a dot to delete · tap Mode to shape a segment\u2019s line type'
: creatorSubmode === 'pitch'
          ? 'Master bends every oscillator while it exists (✕ clears it, revealing per-layer envelopes) · drag dots · tap to add · set ±range top-left · tap Mode to shape a segment\u2019s line type'
          : 'Draw the spectrum of the selected oscillator · tap to add · drag to move · double-tap a dot to delete', W / 2, H - 8);
  }
}

function creatorLoop(now) {
  if (creatorActive) {
    try { drawCreator(now); } catch (err) { console.error(err); }
  }
  requestAnimationFrame(creatorLoop);
}
requestAnimationFrame(creatorLoop);