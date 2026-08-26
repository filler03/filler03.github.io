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

let creatorSubmode = 'note';  // 'note' (merged volume envelope + mix) or 'harm'
let creatorVolSel = true;     // true = master volume envelope selected; false = a layer's mix curve
let creatorPtr = null;        // { mode:'point'|'marker'|'draw', layerIdx, ptIdx|key, x0, y0, moved }
let creatorLastTap = null;    // { t, x, y } for double-tap-to-delete
let creatorPreviewTimer = null;
// Freehand "Draw" mode: while on, any drag in the graph scribbles breakpoints
// along the finger's path instead of grabbing/moving individual dots. The
// points dropdown (4..32) sets how many evenly-spaced breakpoints a full-width
// sweep places across the graph; the mode itself is session-only, the count is
// persisted.
let creatorDrawMode = false;
var creatorDrawPoints = 8;   // 4..HARMONIC_COUNT (clamped)
// Auto-preview: when on, edits/taps in the creator (and settings sliders) play
// the current design automatically. When off, only the ▶ Preview button (and
// the settings panel's Play test) make a sound. Persisted; default off.
var creatorAutoPreview = false;
// Hard cap on envelope components created by drawing (the other editors cap via
// their own insert helpers, raised to HARMONIC_COUNT for drawing).
const ENV_DRAW_MAX = 48;

/* ---- Open / close ---- */
function openSoundCreator(submode, layerIdx) {
  creatorActive = true;
  creatorSubmode = (submode === 'env' || submode === 'mix') ? 'note' : (submode || 'note');
  creatorVolSel = creatorSubmode !== 'harm';
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
  const top = 180, bottom = H - 26, left = 20, right = W - 14;
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
  if (!l.curve.length || !l.curve[idx]) return;
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
  if (!pts.length || !pts[idx]) return;
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
  const val = compValue(cc, cc.startValue) + (compValue(cc, cc.endValue) - compValue(cc, cc.startValue)) * frac;
  comps[c].duration = ms - start;
  comps.splice(c + 1, 0, {
    id: newCompId(),
    name: 'Component',
    duration: end - ms,
    startValue: Math.round(clamp01(val) * 100),
    endValue: cc.endValue,
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
// horizontal moves the boundary time between its neighbors.
function envDragBoundary(i, t, v) {
  const env = ENVELOPE;
  const b = envBoundaries().b;
  const n = env.components.length;
  const value = Math.round(clamp01(v) * 100);
  if (i === 0) {
    env.components[0].startValue = value;
  } else {
    env.components[i - 1].endValue = value;
    chainStartValues(env);
  }
  if (i >= 1 && i <= n - 1) {
    const ms = clamp01(t) * envBoundaries().total;
    const lo = b[i - 1] + 1, hi = b[i + 1] - 1;
    const newMs = Math.max(lo, Math.min(hi, ms));
    env.components[i - 1].duration = newMs - b[i - 1];
    env.components[i].duration = b[i + 1] - newMs;
  }
  clampEnvelopeIndexes();
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
   Insert-dedupe merges revisits, so backtracking adds nothing. */
function drawPointCount() { return Math.max(4, Math.min(HARMONIC_COUNT, +creatorDrawPoints || 8)); }
function slotT(s) { const n = drawPointCount(); return n > 1 ? s / (n - 1) : 0; }
function slotAtX(x, p) {
  const n = drawPointCount();
  if (n <= 1) return 0;
  return Math.max(0, Math.min(n - 1, Math.round((x - p.left) / (p.pw / (n - 1)))));
}

// Toolbar pills floating in the top-right corner of the plot (always visible in
// both sub-modes, so Draw stays reachable without crowding the busy bars). The
// points pill is the visual under the native <select> dropdown.
function drawToolbar(p) {
  const y = p.top + 8, w = 58, h = 26;
  const drawX = p.right - 4 - w;
  const densX = drawX - 8 - w;
  return {
    draw:  { x: drawX, y, w, h },
    dens:  { x: densX, y, w, h },
  };
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

// Place/update breakpoints for the slot range `fromS`..`s` (the finger's sweep
// since the last event) at the pointer's value. Absorption and placement are
// confined to the swept corridor: existing points between those slots (plus a
// small dedupe epsilon so a coincident point is replaced) are removed, points
// outside are untouched. Returns the last placed index (spec & curve), or null.
function drawPlacePointAtSlot(s, y, p, fromS) {
  const loS = Math.min(s, fromS == null ? s : fromS), hiS = Math.max(s, fromS == null ? s : fromS);
  const loT = slotT(loS), hiT = slotT(hiS), eps = 0.008;
  if (creatorSubmode === 'harm') {
    const l = selectedLayer();
    initLayerSpecPoints(l);
    if (l.specPoints.length > 2) {
      const kept = l.specPoints.filter(pt => pt.x < loT - eps || pt.x > hiT + eps);
      if (kept.length >= 2) l.specPoints = kept;
    }
    let idx = -1;
    for (let k = loS; k <= hiS; k++) idx = insertSpecPoint(l, slotT(k), yToAmp(y, p));
    if (idx >= 0) syncLayerAmplitudes(l);
    return idx;
  }
  if (creatorVolSel) { envDrawAt(slotT(s), yToV(y, p), p, loT, hiT); return null; }
  const l = selectedLayer();
  if (l.curve.length > 2) {
    const kept = l.curve.filter(pt => pt.t < loT - eps || pt.t > hiT + eps);
    if (kept.length >= 2) l.curve = kept;
  }
  let idx = -1;
  for (let k = loS; k <= hiS; k++) idx = insertCurvePoint(l, slotT(k), yToV(y, p));
  return idx;
}

// Envelope draw: nudge the nearest boundary (within half the slot spacing) to
// the drawn time/value, otherwise split the envelope there (capped) and set the
// new boundary's value. Values chain forward via envDragBoundary, so the drawn
// path is preserved as a continuous piecewise-linear curve. While the envelope
// carries more components than the chosen point count, interior boundaries that
// fall inside the swept corridor [loT..hiT] are merged away first — so a
// low-density sweep thins the shape only where it actually passes.
function envDrawAt(t, v, p, loT, hiT) {
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
    { submode: 'note', label: 'Volume envelope', enabled: true },
    { submode: 'harm', label: 'Harmonics', enabled: true },
  ];
}

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
      const w = 112;
      tx -= w;
      if (x >= tx && x <= tx + w) return { type: 'tab', submode: tabs[i].submode, enabled: tabs[i].enabled };
    }
    return { type: 'bar' };
  }
  const p = creatorPlot();
  if (y >= 66 && y <= 90) {
    const sw = creatorSubmode === 'note' ? 1 : 0;   // note mode pins a Vol swatch first
    // Auto-preview toggle + manual preview button (right of the swatches).
    const tp = creatorTopPills();
    if (x >= tp.auto.x && x <= tp.auto.x + tp.auto.w && y >= tp.auto.y && y <= tp.auto.y + tp.auto.h) return { type: 'autopreview' };
    if (x >= tp.preview.x && x <= tp.preview.x + tp.preview.w && y >= tp.preview.y && y <= tp.preview.y + tp.preview.h) return { type: 'previewbtn' };
    // ✕ delete badge on the selected layer (layers only; hidden when it's the last one).
    if (!creatorVolSel && OSC_STACK.layers.length > 1) {
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
      if (x >= cx && x <= cx + 70) return { type: 'layer', layerIdx: i };
    }
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
  // Note-life row: dedicated strip below the controls row (non-harm sub-modes).
  if (creatorSubmode !== 'harm' && y >= LIFE_ROW_CY - 14 && y <= LIFE_ROW_CY + 14) {
    const L = lifeSlider(p);
    if (x >= L.x1 - 10 && x <= L.x2 + 10) return { type: 'life' };
    return { type: 'bar' };
  }
  // Marker grab tabs (the lane above the plot; Volume envelope only).
  if (y > MARKER_LANE_TOP && y <= MARKER_LANE_BOTTOM && creatorSubmode !== 'harm') {
    for (const tab of markerTabs(p)) {
      if (x >= tab.x - 8 && x <= tab.x + tab.w + 8 && y >= tab.y - 5 && y <= tab.y + tab.h + 5) return { type: 'marker', key: tab.key };
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
  if (y >= p.top && y <= p.bottom) {
    // Draw-mode toolbar (top-right of the plot, both sub-modes). The points
    // pill is covered by a native <select>, so only the Draw toggle is hit.
    const tb = drawToolbar(p);
    if (x >= tb.draw.x && x <= tb.draw.x + tb.draw.w && y >= tb.draw.y && y <= tb.draw.y + tb.draw.h) return { type: 'drawtoggle' };
    // Draw mode takes over the whole graph: any drag scribbles new points.
    if (creatorDrawMode) return { type: 'draw' };
    if (creatorSubmode === 'harm') return hitTestHarm(x, y, p);
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
  if (hit.type === 'back') { closeSoundCreator(); return; }
  if (hit.type === 'tab') {
    if (hit.enabled) {
      creatorSubmode = hit.submode;
      creatorVolSel = creatorSubmode !== 'harm';
      if (creatorSubmode === 'harm') initLayerSpecPoints(selectedLayer());
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
  if (hit.type === 'vol') {
    creatorVolSel = true;
    creatorPtr = null;
    maybeAutoPreview();
    return;
  }
  if (hit.type === 'layer') {
    selectedLayerIdx = hit.layerIdx;
    creatorVolSel = false;
    if (creatorSubmode === 'harm') initLayerSpecPoints(selectedLayer());
    creatorPtr = null;
    maybeAutoPreview();
    return;
  }
  if (hit.type === 'addlayer') {
    if (OSC_STACK.layers.length >= 8) return;
    OSC_STACK.layers.push(defaultLayer('osc-' + (OSC_STACK.layers.length + 1)));
    selectedLayerIdx = OSC_STACK.layers.length - 1;
    creatorVolSel = false;
    if (creatorSubmode === 'harm') initLayerSpecPoints(selectedLayer());
    previewAndSave();
    return;
  }
  if (hit.type === 'dellayer') {
    if (OSC_STACK.layers.length <= 1) return;
    OSC_STACK.layers.splice(selectedLayerIdx, 1);
    selectedLayerIdx = Math.max(0, Math.min(OSC_STACK.layers.length - 1, selectedLayerIdx));
    if (creatorSubmode === 'harm') initLayerSpecPoints(selectedLayer());
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
    } else if (creatorVolSel) {
      ENVELOPE = clone(DEFAULT_ENVELOPE);
      clampEnvelopeIndexes();
    } else {
      resetLayerCurve(selectedLayer());
    }
    previewAndSave();
    return;
  }
  if (hit.type === 'harmpreset') {
    applyPresetToLayer(selectedLayer(), hit.name);
    initLayerSpecPoints(selectedLayer());
    previewAndSave();
    return;
  }
  if (hit.type === 'drawtoggle') {
    creatorDrawMode = !creatorDrawMode;
    creatorPtr = null;
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
    previewAndSave();
    return;
  }
  if (hit.type === 'point') {
    maybeAutoPreview();
    if (creatorLastTap && performance.now() - creatorLastTap.t < 400 && Math.hypot(x - creatorLastTap.x, y - creatorLastTap.y) < 26) {
      removeCurvePoint(OSC_STACK.layers[hit.layerIdx], hit.ptIdx);
      creatorLastTap = null;
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
    previewAndSave();
    return;
  }
  const idx = insertCurvePoint(l, xToT(x, p), yToV(y, p));
  if (idx >= 0) creatorPtr = { mode: 'point', layerIdx: selectedLayerIdx, ptIdx: idx, x0: x, y0: y };
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
  }
  creatorPtr.x0 = x; creatorPtr.y0 = y;
});

canvas.addEventListener('pointerup', e => {
  if (!creatorActive || !creatorPtr) return;
  creatorPtr = null;
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
  ctx.fillText('Sound creator', W / 2, 36);
// Prominent readout of the exact preview pitch + frequency the test plays,
// plus the note's spectral center at the start and end of the note — so a
// rising "pitch" from the mix morphing is visibly explained.
  ctx.font = '700 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Test: ' + previewPitchName() + ' · ' + previewPitchFreq().toFixed(1) + ' Hz', 84, 38);
  ctx.fillText('spectral center: ' + centroidPitchName(0) + ' → ' + centroidPitchName(1), 84, 58);
  const tabs = creatorTabs();
  let tx = W - 14;
  for (let i = tabs.length - 1; i >= 0; i--) {
    const w = 112, x = tx - w;
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

  // ---- Legend (Vol + layer colors + add/remove + reset) ----
  const sw = creatorSubmode === 'note' ? 1 : 0;   // note mode pins a Vol swatch first
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
  for (let i = 0; i < OSC_STACK.layers.length; i++) {
    const cx = p.left + sw * 76 + i * 76;
    const sel = i === selectedLayerIdx;
    ctx.fillStyle = OSC_COLORS[i % OSC_COLORS.length];
    ctx.beginPath();
    ctx.arc(cx + 7, 78, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = (sel ? '800 ' : '700 ') + '11px sans-serif';
    ctx.fillStyle = sel ? '#1b4523' : '#6b8e5a';
    ctx.textAlign = 'left';
    ctx.fillText('Osc ' + (i + 1), cx + 18, 82);
    // ✕ delete badge on the selected layer (layers only, hidden when it's the last one).
    if (sel && !creatorVolSel && OSC_STACK.layers.length > 1) {
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
  ctx.fillText(creatorVolSel ? '↺ Reset vol' : creatorSubmode === 'harm' ? '↺ Reset spec' : '↺ Reset curve', W - 59, 83);

  // Note-lifetime slider (note mode only; dedicated row below the controls
  // row, above the HOLD/CUT/REL marker lane).
  if (creatorSubmode !== 'harm') {
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

  // ---- Marker grab tabs (Volume envelope tab only) ----
  if (creatorSubmode !== 'harm') {
    for (const tab of markerTabs(p)) {
      // Connector from the tab down to its dashed line so the pairing is obvious.
      ctx.strokeStyle = tab.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tab.cx, tab.y + tab.h);
      ctx.lineTo(tab.cx, p.top);
      ctx.stroke();
      ctx.globalAlpha = 1;
      drawRoundRect(tab.x, tab.y, tab.w, tab.h, 7);
      ctx.fillStyle = tab.color;
      ctx.fill();
      ctx.fillStyle = '#fff';
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
    ctx.textAlign = 'right';
    ctx.fillText('H1 → H32', p.right, p.bottom - 6);
  } else {
    ctx.fillText('0%', p.left + 2, p.bottom - 6);
    ctx.textAlign = 'right';
    ctx.fillText('note life →', p.right, p.bottom - 6);
    ctx.textAlign = 'left';
    ctx.fillText('loudness 100%', p.left + 2, p.top + 10);
  }

  // ---- Markers (time-based sub-modes only) ----
  if (creatorSubmode !== 'harm') {
    const markers = markerList();
    for (const m of markers) {
      const x = tToX(m.t, p);
      ctx.strokeStyle = m.color;
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
    // Release-region tint (from the hold end).
    const relX = tToX(eb.tOf(eb.b[ENVELOPE.holdEndIndex + 1]), p);
    ctx.fillStyle = 'rgba(217,83,79,0.07)';
    ctx.fillRect(relX, p.top, p.right - relX, p.ph);
    // Layer mix curves (the selected layer solid, the others dimmed).
    for (let i = 0; i < OSC_STACK.layers.length; i++) {
      const l = OSC_STACK.layers[i];
      const sel = !creatorVolSel && i === selectedLayerIdx;
      ctx.strokeStyle = OSC_COLORS[i % OSC_COLORS.length];
      ctx.globalAlpha = sel ? 1 : 0.5;
      ctx.lineWidth = sel ? 3 : 1.5;
      ctx.beginPath();
      const curve = l.curve || [];
      if (!curve.length) { ctx.globalAlpha = 1; continue; }
      // Extend the flat clamped regions out to the plot edges.
      ctx.moveTo(tToX(0, p), vToY(curveValue(l, 0), p));
      for (let k = 0; k < curve.length; k++) ctx.lineTo(tToX(curve[k].t, p), vToY(clamp01(curve[k].v), p));
      ctx.lineTo(tToX(1, p), vToY(curveValue(l, 1), p));
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (sel) {
        for (const pt of curve) {
          ctx.fillStyle = OSC_COLORS[i % OSC_COLORS.length];
          ctx.beginPath();
          ctx.arc(tToX(pt.t, p), vToY(clamp01(pt.v), p), 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
    // Master envelope outline (bold when Vol is selected, faint otherwise).
    ctx.globalAlpha = creatorVolSel ? 1 : 0.45;
    ctx.strokeStyle = '#2e5d34';
    ctx.lineWidth = creatorVolSel ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(tToX(eb.tOf(eb.b[0]), p), vToY(eb.vals[0], p));
    for (let i = 1; i <= eb.n; i++) ctx.lineTo(tToX(eb.tOf(eb.b[i]), p), vToY(eb.vals[i], p));
    ctx.stroke();
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
    ctx.fillStyle = '#9db89c';
    ctx.font = '700 9px sans-serif';
    ctx.textAlign = 'center';
    for (let i = 4; i < 32; i += 4) {
      const x = tToX(i / 31, p);
      ctx.strokeStyle = 'rgba(46,93,52,0.1)';
      ctx.beginPath();
      ctx.moveTo(x, p.top); ctx.lineTo(x, p.bottom);
      ctx.stroke();
      ctx.fillStyle = '#9db89c';
      ctx.fillText('H' + (i + 1), x, p.bottom + 9);
    }
    // Curve + dots (extend the clamped ends out to the plot edges)
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
  }

  // ---- Draw-mode toolbar (top-right of the plot, both sub-modes) ----
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
  drawRoundRect(tb.draw.x, tb.draw.y, tb.draw.w, tb.draw.h, 8);
  ctx.fillStyle = creatorDrawMode ? accent : '#fff';
  ctx.fill();
  ctx.strokeStyle = 'rgba(46,93,52,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = creatorDrawMode ? '#fff' : '#2e5d34';
  ctx.fillText(creatorDrawMode ? 'ON' : 'Draw', tb.draw.x + tb.draw.w / 2, tb.draw.y + tb.draw.h / 2 + 1);
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

  // ---- Hint ----
  ctx.fillStyle = '#6b8e5a';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  if (creatorDrawMode) {
    ctx.fillText(creatorSubmode === 'note'
      ? 'Drawing the ' + (creatorVolSel ? 'volume envelope' : 'selected oscillator mix') + ' · drag to scribble (' + drawPointCount() + ' pts) · tap Draw to edit dots'
      : 'Drawing the selected oscillator spectrum · drag to scribble (' + drawPointCount() + ' pts) · tap Draw to edit dots', W / 2, H - 8);
  } else {
    ctx.fillText(creatorSubmode === 'note'
      ? 'Pick Vol or an oscillator above · drag HOLD/CUT/REL markers and set note life on the right · drag dots · tap a curve to add a point or split · double-tap a dot to delete'
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