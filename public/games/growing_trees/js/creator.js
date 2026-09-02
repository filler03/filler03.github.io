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
let creatorVoiceEnvSel = null;  // Voices tab: 'st' | 'ct' | 'vol' = which slider parameter's envelope curve is being edited
let creatorVoiceEnvMaster = false; // Voices tab: edit the Master fallback curve instead of the selected voice's own
let creatorPtr = null;        // { mode:'point'|'marker'|'draw', layerIdx, ptIdx|key, x0, y0, moved }
let creatorLastTap = null;    // { t, x, y } for double-tap-to-delete
let creatorSelMarker = null;  // selected marker key ('hold'|'cut'|'rel') awaiting a destination tap, or null
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
// Voice slider snapping (Voices tab): when on, the Semitones flat-line fader
// snaps to whole semitones. Cents keep providing fine sub-semitone tuning.
// Persisted; default off.
var creatorVoiceSnap = false;
// Hard cap on envelope components created by drawing (the other editors cap via
// their own insert helpers, raised to HARMONIC_COUNT for drawing).
const ENV_DRAW_MAX = 48;

/* ---- Open / close ---- */
function openSoundCreator(submode, layerIdx) {
  creatorActive = true;
  creatorSubmode = (submode === 'env' || submode === 'mix') ? 'note' : (submode || 'note');
  creatorVolSel = creatorSubmode === 'note';
  creatorVoiceEnvSel = creatorSubmode === 'voices' ? 'st' : null;
  creatorVoiceEnvMaster = false;
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
  creatorSelMarker = null;
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

/* ---- Plot geometry ----
   The plot is the graph itself: nothing but the curve, its grid, its axis
   labels, and its time markers render inside it. Every control — the mode
   toolbar, the Clear pill, the ±range pill, and the segment editor — lives in
   the dedicated widget band above the plot, so widgets never cover the graph.
   The band sits between the marker lane (ends at MARKER_LANE_BOTTOM) and the
   plot. */
const WIDGET_BAND_TOP = 180, WIDGET_BAND_BOTTOM = 214;   // pill strip between the marker lane and the plot
const WIDGET_PILL_Y = 184, WIDGET_PILL_H = 26;
function creatorPlot() {
  const top = 218, bottom = H - 38, left = 20, right = W - 14;
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
// Row where a selected marker's valid destinations are lit as dots, just below
// the two tab rows so they read as move targets without colliding with tabs.
const MARKER_DEST_ROW = 168;
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
  l.trim = 0;
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
   The Pitch tab edits either the master envelope (fallback for layers without
   their own) or one layer's own. Both are breakpoint curves over the note's
   timeline with a signed semitone axis (± the envelope's range). A layer's own
   envelope may not exist yet — it's created lazily on first edit, and Reset
   clears it away again. A layer plays its OWN envelope when it has one; the
   master only applies to layers without one. */
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

// Range pill: ±N stepper in the widget band's left corner (Pitch tab only).
function pitchRangePill(p) {
  const y = WIDGET_PILL_Y, w = 96, h = WIDGET_PILL_H;
  return { x: p.left + 4, y, w, h };
}

// Clear pill: removes the envelope being edited (a layer's own, or the master
// fallback) so that layer reverts to the master / base pitch. Present only in
// the Pitch tab and only when the selected envelope actually exists.
function pitchClearPill(p) {
  const rp = pitchRangePill(p);
  const w = 64, h = WIDGET_PILL_H;
  const x = rp.x + rp.w + 8, y = rp.y;
  return { x, y, w, h };
}

// Is the envelope currently being edited present (and therefore clearable)?
function selectedPitchEnvExists() {
  return !!selectedPitchEnvOrNull();
}

/* ---- Volume envelope helpers ----
   The master volume envelope (Vol) is the note's ADSR: it shapes every
   oscillator's loudness. Each oscillator also has its own mix curve — its
   level over the note. A layer "has its own" when that curve is customized;
   layers still on the default flat curve simply follow Vol. */
// A layer's curve is customized (differs from the default flat full-level), or
// its whole-line trim has been moved off zero.
function layerHasCustomCurve(l) {
  const c = l && l.curve;
  if (l && l.trim) return true;
  if (!c || !c.length) return false;
  if (c.length !== 2) return true;
  const a = c[0], b = c[1];
  if (a && a.seg && typeof a.seg === 'object') return true;
  if (Math.abs((a && a.t || 0) - 0) > 1e-9 || Math.abs((a && a.v != null ? a.v : 1) - 1) > 1e-9) return true;
  if (Math.abs((b && b.t != null ? b.t : 1) - 1) > 1e-9 || Math.abs((b && b.v != null ? b.v : 1) - 1) > 1e-9) return true;
  return false;
}

// Is the master volume envelope still its default ADSR (nothing to clear)?
function envelopeIsDefault(env) {
  const d = DEFAULT_ENVELOPE;
  if (!env || !env.components || env.components.length !== d.components.length) return false;
  if (envTrim(env) !== 0) return false;
  if (env.holdStartIndex !== d.holdStartIndex || env.holdEndIndex !== d.holdEndIndex ||
      env.beginReleaseIndex !== d.beginReleaseIndex || env.earlyCutIndex !== d.earlyCutIndex) return false;
  for (let i = 0; i < d.components.length; i++) {
    const c = env.components[i], dc = d.components[i];
    if (!c || c.duration !== dc.duration || c.startValue !== dc.startValue || c.endValue !== dc.endValue ||
        (c.name || '') !== (dc.name || '')) return false;
    const hasSeg = c.seg && typeof c.seg === 'object';
    const defHasSeg = dc.seg && typeof dc.seg === 'object';
    if (hasSeg !== defHasSeg) return false;
    if (hasSeg && defHasSeg) {
      const s1 = c.seg, s2 = dc.seg;
      if ((s1.type || '') !== (s2.type || '') || +s1.stairs !== +s2.stairs ||
          +s1.freq !== +s2.freq || +s1.depth !== +s2.depth) return false;
    }
  }
  return true;
}

// Clear pill (Volume tab, widget band): resets the selected envelope — the
// master ADSR, or the selected layer's mix curve — back to default.
function volClearPill(p) {
  const w = 64, h = WIDGET_PILL_H;
  return { x: p.left + 4, y: WIDGET_PILL_Y, w, h };
}

// Vertical trim slider (Volume tab, left of the graph): a small mixer fader that
// shifts the selected curve — the master ADSR, or the selected layer's mix curve
// — uniformly up/down without adding any breakpoints. Drag up to raise, down to
// lower; the middle of the track is no-trim.
function volTrimSlider(p) {
  const x = 2, w = 16;
  return { x, w, y0: p.top + 10, y1: p.bottom - 16 };
}
function volTrimValue() {
  return creatorVolSel ? envTrim(ENVELOPE) : layerTrim(OSC_STACK.layers[selectedLayerIdx]);
}
function volTrimFromY(sl, y) {
  const f = Math.max(0, Math.min(1, (y - sl.y0) / (sl.y1 - sl.y0)));
  return 1 - 2 * f;   // top of the track = +1, bottom = -1
}
function applyVolTrim(trim) {
  trim = Math.max(-1, Math.min(1, trim));
  if (creatorVolSel) ENVELOPE.trim = trim;
  else {
    const l = OSC_STACK.layers[selectedLayerIdx];
    if (l) l.trim = trim;
  }
  scheduleCreatorPreview();
}

/* ---- Voice slider trim (Voices tab, left of the graph) ----
   Each voice parameter's flat-line value — the semitone/cents offset or the
   volume — is set with a small vertical mixer fader beside the graph, exactly
   like the Volume tab's Trim. The curve (if any) bends on top of this line. */
function voiceTrimSlider(p) {
  const x = 2, w = 16;
  return { x, w, y0: p.top + 10, y1: p.bottom - 16 };
}
function voiceTrimValue() {
  const param = creatorVoiceEnvSel;
  if (!param) return 0;
  const v = selectedVoice();
  const d = VOICE_PARAM_DEFS.find(d => d.key === param);
  const def = v && d ? +v[d.key] || 0 : 0;
  const range = VOICE_PARAM_RANGES[param] || 1;
  const min = param === 'vol' ? 0 : -range;
  const max = param === 'vol' ? range : range;
  return Math.max(min, Math.min(max, def));
}
function voiceTrimFromY(sl, y) {
  const param = creatorVoiceEnvSel;
  const f = Math.max(0, Math.min(1, (y - sl.y0) / (sl.y1 - sl.y0)));
  const range = VOICE_PARAM_RANGES[param] || 1;
  if (param === 'vol') return range * (1 - f);          // top = max, bottom = 0
  return (1 - 2 * f) * range;                          // top = +range, bottom = -range
}
function applyVoiceTrim(trim) {
  const param = creatorVoiceEnvSel;
  const v = selectedVoice();
  if (!param || !v) return;
  const range = VOICE_PARAM_RANGES[param] || 1;
  const min = param === 'vol' ? 0 : -range;
  const max = param === 'vol' ? range : range;
  trim = Math.max(min, Math.min(max, trim));
  if (param === 'st' && creatorVoiceSnap) trim = Math.round(trim);
  if (param === 'vol') trim = Math.round(trim * 100) / 100;
  v[param] = trim;
  scheduleCreatorPreview();
}

// Is there something to clear for the volume envelope being edited?
function selectedVolClearable() {
  return creatorVolSel ? !envelopeIsDefault(ENVELOPE) : layerHasCustomCurve(OSC_STACK.layers[selectedLayerIdx]);
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

// Selection state: the selected segment's start/end point indexes (component
// boundaries for the volume envelope, breakpoint indexes for mix/pitch curves).
// Line mode picks one segment at a time by dragging across the graph: from is
// the segment's start point, to is its end point.
let segFromIdx = null, segToIdx = null;
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
  if (creatorSubmode === 'voices' && creatorVoiceEnvSel) {
    const env = selectedVoiceEnvOrNull();
    return { elems: env ? env.points : [], lastPoint: env ? env.points.length : 0 };
  }
  return null;
}

// Normalized selection range as { m, lo, hi } (point indexes), or null. Line
// mode always selects one segment: lo is its start point, hi its end point.
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

// Run `fn(el)` for every segment element inside the selected range. A single
// segment selection (from == i, to == i+1) covers the one element at i.
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
// The screen x of a segment's starting point (its start boundary / breakpoint),
// used by the drag-based segment picker in Line mode.
function segStartX(i, p) {
  if (creatorSubmode === 'note' && creatorVolSel) {
    const eb = envBoundaries();
    return tToX(eb.tOf(eb.b[i]), p);
  }
  if (creatorSubmode === 'pitch') {
    const env = selectedPitchEnvOrNull();
    const pt = env && env.points[i];
    return pt ? tToX(pt.t, p) : p.right;
  }
  if (creatorSubmode === 'voices' && creatorVoiceEnvSel) {
    const env = selectedVoiceEnvOrNull();
    const pt = env && env.points[i];
    return pt ? tToX(pt.t, p) : p.right;
  }
  const l = OSC_STACK.layers[selectedLayerIdx];
  const pt = l.curve[i];
  return pt ? tToX(pt.t, p) : p.right;
}

// The segment whose starting point is horizontally closest to screen x — the
// drag-based pick in Line mode. Only the horizontal position matters; the
// gesture's height never influences which segment is chosen.
function segIndexAtX(x, p) {
  const m = segModel();
  if (!m || m.lastPoint < 2) return -1;
  let best = -1, bd = Infinity;
  for (let i = 0; i < m.lastPoint - 1; i++) {
    const d = Math.abs(x - segStartX(i, p));
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Select a single segment (by its start-point index) and open the segment
// editor on it. Line mode's drag picker calls this as the gesture is drawn, so
// the selection — and the editor — track the finger across the graph.
function selectSegPoint(idx) {
  const m = segModel();
  if (!m || idx < 0 || idx >= m.lastPoint - 1) return;
  segFromIdx = idx;
  segToIdx = idx + 1;
  segPanelOpen = true;
}

function clearSegSelection() {
  segFromIdx = null; segToIdx = null; segPanelOpen = false;
}
function clampSegSelection() {
  const m = segModel();
  if (!m) { clearSegSelection(); return; }
  if (segFromIdx != null && segFromIdx >= m.lastPoint) segFromIdx = null;
  if (segToIdx != null && segToIdx >= m.lastPoint) segToIdx = null;
  if (segFromIdx == null && segToIdx == null) segPanelOpen = false;
}

// Screen-space layout of the floating segment-editor panel (the Line-mode
// "modal"). It lives in the bands above the plot — never on the graph itself —
// as a roomy block: a readout row, one row of type pills, and a full row of
// side-by-side parameter sliders. Returns row rects used by both the hit tester
// and the renderer.
const SEG_PANEL_W_MAX = 640;
const SEG_PANEL_TOP = 90;
function segPanelRects(p) {
  const w = Math.min(SEG_PANEL_W_MAX, Math.max(400, p.pw * 0.72));
  const x = p.left + 4;
  const y0 = SEG_PANEL_TOP;
  const rowH = 36, gap = 6;
  const y = n => y0 + n * (rowH + gap);
  const cur = segCurrent();
  const type = cur ? segOf(cur).type : 'line';
  const params = SEGMENT_TYPE_PARAMS[type] || [];
  const clear = { x: x + w - 34, y: y(0) + 4, w: 28, h: rowH - 8 };
  const pillW = (w - 20 - (SEGMENT_TYPE_ORDER.length - 1) * 3) / SEGMENT_TYPE_ORDER.length;
  const typePills = SEGMENT_TYPE_ORDER.map((t, i) => ({ t, x: x + 10 + i * (pillW + 3), y: y(1), w: pillW, h: rowH }));
  const paramGroups = segParamGroups(x, w, y(2) + rowH / 2, params);
  const height = y(2) + rowH + gap - y0;
  return { x, y0, w, clear, typePills, paramGroups, rowH, gap, height };
}

// One parameter group per row slot: the label, a −/+ pair around a slider, and
// the readout, all side by side. `params` is the array of key strings (e.g.
// ['freq', 'depth']) from SEGMENT_TYPE_PARAMS; each group carries its key so the
// draw/hit-test code can look up its SEG_PARAM_DEFS.
function segParamGroups(x, w, cy, params) {
  const n = params.length;
  if (!n) return [];
  const pad = 10, gap = 14;
  const avail = w - pad * 2 - gap * (n - 1);
  const gw = avail / n;
  const btnW = 24, labelW = 44, valW = 46;
  return params.map((pr, i) => {
    const gx = x + pad + i * (gw + gap);
    const bxMinus = gx + labelW + 2;
    const valRight = gx + gw - 2;
    const bxPlus = valRight - valW - btnW - 4;
    return { key: pr, cy, btnW, labelW, gx, gw, bxMinus, bxPlus, x1: bxMinus + btnW + 4, x2: bxPlus - 4 };
  });
}

// Hit-test the segment-editor panel. Taps outside the panel's rect fall through
// (so a dot can still re-select a range); taps inside the rect but off a
// control are swallowed ('bar'), keeping the panel modal.
function hitTestSegPanel(x, y, p) {
  if (!segPanelOpen || !creatorSegMode || creatorDrawMode || creatorDeleteMode) return null;
  const R = segPanelRects(p);
  if (x < R.x || x > R.x + R.w || y < R.y0 || y > R.y0 + R.height) return null;
  if (y >= R.clear.y && y <= R.clear.y + R.clear.h && x >= R.clear.x && x <= R.clear.x + R.clear.w) return { type: 'segclear' };
  if (y >= R.typePills[0].y && y <= R.typePills[0].y + R.typePills[0].h) {
    for (const pill of R.typePills) {
      if (x >= pill.x && x <= pill.x + pill.w) return { type: 'segtype', t: pill.t };
    }
    return { type: 'bar' };
  }
  // All groups share one row (the same cy), so every group must be checked:
  // a tap can hit a later group's controls even when it is inside an earlier
  // group's vertical band. Only swallow the tap once no group's control hits.
  for (const g of R.paramGroups) {
    if (y >= g.cy - g.btnW - 4 && y <= g.cy + g.btnW + 4) {
      if (x >= g.bxMinus && x <= g.bxMinus + g.btnW) return { type: 'segparam', key: g.key, dir: -1 };
      if (x >= g.bxPlus && x <= g.bxPlus + g.btnW) return { type: 'segparam', key: g.key, dir: 1 };
      if (x >= g.x1 - 6 && x <= g.x2 + 8) return { type: 'segslider', key: g.key };
    }
  }
  return { type: 'bar' };
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
  } else if (creatorSubmode === 'voices' && creatorVoiceEnvSel) {
    const env = selectedVoiceEnvOrNull();
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
  // Panel backdrop (solid so the busy bars behind never clutter the controls).
  ctx.fillStyle = '#f4faf0';
  ctx.strokeStyle = 'rgba(46,93,52,0.5)';
  ctx.lineWidth = 2;
  drawRoundRect(R.x, R.y0, R.w, R.height, 12);
  ctx.fill();
  ctx.stroke();
  // Row 0: the merged segment readout (left) + ✕ dismiss (right).
  ctx.fillStyle = '#2e5d34';
  ctx.font = '800 13px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Segment ' + (r ? r.lo : 0) + ' · drag the graph to re-select', R.x + 12, R.y0 + 23);
  // ✕ dismiss.
  const cx0 = R.clear.x + R.clear.w / 2, cy0 = R.clear.y + R.clear.h / 2;
  ctx.fillStyle = '#eef5ea';
  ctx.beginPath();
  ctx.arc(cx0, cy0, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(46,93,52,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#2e5d34';
  ctx.font = '800 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('✕', cx0, cy0 + 5);
  // Row 1: type pills.
  for (const pill of R.typePills) {
    const active = pill.t === type;
    drawRoundRect(pill.x, pill.y, pill.w, pill.h, 9);
    ctx.fillStyle = active ? '#2e5d34' : '#fff';
    ctx.fill();
    ctx.strokeStyle = active ? '#2e5d34' : 'rgba(46,93,52,0.4)';
    ctx.lineWidth = active ? 2 : 1.5;
    ctx.stroke();
    ctx.fillStyle = active ? '#fff' : '#2e5d34';
    ctx.font = '800 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(SEGMENT_TYPE_DEFS[pill.t].label, pill.x + pill.w / 2, pill.y + pill.h / 2 + 5);
  }
  // Row 2: parameter groups, or a hint when the type has none (Line).
  if (!R.paramGroups.length) {
    ctx.fillStyle = '#6b8e5a';
    ctx.font = '700 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Line = a straight ramp — tap a shape above for parameters', R.x + R.w / 2, R.y0 + R.height - 22);
    return;
  }
  for (const g of R.paramGroups) {
    const d = SEG_PARAM_DEFS[g.key];
    const val = segParamValue(g.key);
    ctx.fillStyle = '#6b8e5a';
    ctx.font = '800 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(d.label, g.gx + g.labelW - 2, g.cy + 5);
    ctx.font = '700 16px sans-serif';
    ctx.textAlign = 'center';
    for (const side of ['-', '+']) {
      const bx = side === '-' ? g.bxMinus : g.bxPlus;
      drawRoundRect(bx, g.cy - g.btnW / 2, g.btnW, g.btnW, 7);
      ctx.fillStyle = '#eef5ea';
      ctx.fill();
      ctx.strokeStyle = 'rgba(46,93,52,0.4)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#2e5d34';
      ctx.fillText(side === '-' ? '−' : '+', bx + g.btnW / 2, g.cy + 6);
    }
    // Track + fill + thumb.
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(46,93,52,0.22)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(g.x1, g.cy); ctx.lineTo(g.x2, g.cy);
    ctx.stroke();
    const tx = g.x1 + (g.x2 - g.x1) * ((val - d.min) / (d.max - d.min));
    ctx.strokeStyle = '#2e5d34';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(g.x1, g.cy); ctx.lineTo(tx, g.cy);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(tx, g.cy, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#2e5d34';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = '#2e5d34';
    ctx.font = '800 15px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(d.fmt(val), g.gx + g.gw - 2, g.cy + 5);
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

// Toolbar buttons in the widget band's right corner (always visible in every
// sub-mode except Voices, so the mode switch stays reachable without crowding
// the busy bars). Each editor mode — Point, Draw, Erase, Delete, Line — gets
// its own button, lined up side by side; tapping one selects that mode directly
// (no cycling). The points pill sits just right of them and is the visual under
// the native <select> dropdown.
const CREATOR_MODES = [
  { mode: 'point', label: 'Point' },
  { mode: 'draw',  label: 'Draw' },
  { mode: 'erase', label: 'Erase' },
  { mode: 'delete', label: 'Delete' },
  { mode: 'line',  label: 'Line' },
];
function drawToolbar(p) {
  const y = WIDGET_PILL_Y, h = WIDGET_PILL_H;
  const btnW = 48, gap = 6, densW = 56;
  const n = CREATOR_MODES.length;
  const totalW = n * btnW + (n - 1) * gap + 6 + densW;
  let x = p.right - 4 - totalW;
  const modes = CREATOR_MODES.map(c => {
    const r = { mode: c.mode, label: c.label, x, y, w: btnW, h };
    x += btnW + gap;
    return r;
  });
  return { modes, dens: { x, y, w: densW, h } };
}

// Line-mode hint pill (Volume tab, widget band left corner): nudges the player
// to drag across the graph to pick a segment. Width is the space available
// before the mode toolbar at the band's right edge; the draw code skips it when
// that space is too narrow to hold a readable label.
function lineHintPill(p) {
  const x = p.left + 4, y = WIDGET_PILL_Y, h = WIDGET_PILL_H;
  const tb = drawToolbar(p);
  const w = Math.min(200, tb.modes[0].x - x - 8);
  return { x, y, w, h };
}

// The fill color for a mode button: each mode keeps its own hue so the active
// state is obvious at a glance. Point uses the shared green.
function creatorModeColor(mode) {
  if (mode === 'erase') return '#d9534f';
  if (mode === 'delete') return '#c0392b';
  if (mode === 'line') return '#3949ab';
  if (mode === 'draw') return OSC_COLORS[selectedLayerIdx % OSC_COLORS.length];
  return '#2e5d34';   // point
}

// Is a given mode the one currently selected? Erase implies Draw (its stroke
// scribbles along the erase line), so the Draw button only lights up when Draw
// alone is active.
function creatorModeActive(mode) {
  if (mode === 'erase') return creatorEraseMode;
  if (mode === 'delete') return creatorDeleteMode;
  if (mode === 'line') return creatorSegMode;
  if (mode === 'draw') return creatorDrawMode && !creatorEraseMode;
  return !creatorDrawMode && !creatorEraseMode && !creatorDeleteMode && !creatorSegMode;   // point
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
   voice to edit, the chips above the graph pick which parameter (st/ct/vol)
   curve to edit, and the graph holds that curve with a vertical fader at the
   left that raises/lowers its flat line. */
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
/* ---- Voice slider envelopes (the st / ct / vol curve editor) ----
   The Voices tab's three sliders can each be replaced by a breakpoint curve
   over the note's timeline. Editing either the selected voice's own envelope
   or the Master fallback (which every voice without its own inherits) works
   exactly like the Pitch tab: tap/drag points, draw/erase/delete/line modes,
   and a Clear pill. The axis is fixed per parameter — st ±24, ct ±100, vol
   0..2 — so there is no ±range pill. */
function selectedVoiceEnvOrNull() {
  const param = creatorVoiceEnvSel;
  if (!param) return null;
  if (creatorVoiceEnvMaster) {
    const env = MASTER_VOICE_ENVS[param];
    return env && env.points && env.points.length >= 2 ? env : null;
  }
  const v = selectedVoice();
  const own = v && v.envs && v.envs[param];
  return own && own.points && own.points.length >= 2 ? own : null;
}
function selectedVoiceEnvExists() {
  return !!selectedVoiceEnvOrNull();
}
function ensureSelectedVoiceEnv() {
  const existing = selectedVoiceEnvOrNull();
  if (existing) return existing;
  const param = creatorVoiceEnvSel;
  if (!param) return null;
  const env = defaultVoiceEnv(param);
  if (creatorVoiceEnvMaster) MASTER_VOICE_ENVS[param] = env;
  else {
    const v = selectedVoice();
    if (!v) return null;
    if (!v.envs || typeof v.envs !== 'object') v.envs = { st: null, ct: null, vol: null };
    v.envs[param] = env;
  }
  return env;
}
// Value ↔ screen Y for the selected parameter: st/ct are bipolar (0 centered,
// top = +range), vol is unipolar 0..range (top = max).
function voiceEnvValueFromY(param, y, p) {
  const range = VOICE_PARAM_RANGES[param] || 1;
  if (param === 'vol') return clamp01((p.bottom - y) / p.ph) * range;
  return yToAmp(y, p) * range;
}
function voiceEnvYFromValue(param, v, p) {
  const range = VOICE_PARAM_RANGES[param] || 1;
  if (param === 'vol') return p.bottom - clamp01(v / range) * p.ph;
  return ampToY(v / range, p);
}
function insertVoiceEnvPoint(env, param, t, v) {
  const range = VOICE_PARAM_RANGES[param] || 1;
  const min = param === 'vol' ? 0 : -range;
  const max = param === 'vol' ? range : range;
  t = clamp01(t);
  v = Math.max(min, Math.min(max, v));
  const pts = env.points;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].t - t) < 0.01) { pts[i].v = v; return i; }
  }
  if (pts.length >= 64) return -1;
  pts.push({ t, v });
  pts.sort((a, b) => a.t - b.t);
  return pts.findIndex(pt => pt.t === t && pt.v === v);
}
function removeVoiceEnvPoint(env, idx) {
  const pts = env.points;
  const pt = pts[idx];
  if (!pt) return;
  if (pt.t === 0 || pt.t === 1) return;   // the far-left/right anchors are protected
  if (pts.length <= 2) {
    // Keep two points: collapse to a flat no-modulation line the user can draw up.
    const neutral = voiceEnvNeutral(creatorVoiceEnvSel);
    env.points = [{ t: 0, v: neutral }, { t: 1, v: neutral }];
    return;
  }
  pts.splice(idx, 1);
}
// Mode chips in the strip above the plot (Voices tab): pick which parameter's
// envelope curve to edit, plus the Master fallback toggle. They sit on the
// strip's top row; the Snap pill + interval chips use the bottom row.
function voiceEnvChips(p) {
  const y = MARKER_LANE_TOP + 2, h = 20;
  const labels = [['st', 'st'], ['ct', 'ct'], ['vol', 'vol'], ['master', 'Master']];
  const gap = 6, w = 56;
  const x0 = p.left + 4;
  return labels.map((l, i) => ({ key: l[0], label: l[1], x: x0 + i * (w + gap), y, w, h }));
}
// Clear pill (Voices tab, env mode): removes the envelope being edited — a
// voice's own reverts to inheriting the master; clearing the master removes the
// fallback entirely.
function voiceEnvClearPill(p) {
  const w = 64, h = WIDGET_PILL_H;
  return { x: p.left + 4, y: WIDGET_PILL_Y, w, h };
}
function clearSelectedVoiceEnv() {
  if (creatorVoiceEnvMaster) MASTER_VOICE_ENVS[creatorVoiceEnvSel] = null;
  else {
    const v = selectedVoice();
    if (v && v.envs) {
      v.envs[creatorVoiceEnvSel] = null;
      if (!v.envs.st && !v.envs.ct && !v.envs.vol) v.envs = null;
    }
  }
}
// Voice chips strip (replaces the note-life row in the Voices tab).
function voiceChipRects(p) {
  const rects = [];
  const vs = selectedVoicesLayer() ? layerVoices(selectedVoicesLayer()) : [];
  for (let i = 0; i < vs.length; i++) {
    rects.push({ x: p.left + i * 104, y: LIFE_ROW_CY - 14, w: 100, h: 34 });
  }
  if (vs.length < MAX_LAYER_VOICES) {
    rects.push({ x: p.left + vs.length * 104 + 6, y: LIFE_ROW_CY - 14, w: 50, h: 34 });
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
  const y = MARKER_LANE_BOTTOM - 26, w = 70, h = 26;
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

// Place/update breakpoints for the slot range `fromS`..`s` (the finger's sweep
// since the last event) at the pointer's value. Absorption and placement are
// confined to the swept corridor: existing points between those slots (plus a
// small dedupe epsilon so a coincident point is replaced) are removed, points
// outside are untouched. Returns the last placed index (spec & curve), or null.
function drawPlacePointAtSlot(s, y, p, fromS) {
  const loS = Math.min(s, fromS == null ? s : fromS), hiS = Math.max(s, fromS == null ? s : fromS);
  const loT = slotT(loS), hiT = slotT(hiS), eps = 0.008;
  if (creatorSubmode === 'voices' && creatorVoiceEnvSel) {
    const env = ensureSelectedVoiceEnv();
    if (!env) return -1;
    const param = creatorVoiceEnvSel;
    const neutral = voiceEnvNeutral(param);
    const base = voiceTrimValue();
    // Raw curve value whose effective value (base + curve − neutral) sits at
    // the pointer's Y, so drawn dots land where the finger points.
    const rawFromY = eff => voiceEnvValueFromY(param, eff, p) - (base - neutral);
    if (env.points.length > 2) {
      const kept = env.points.filter(pt => pt.t === 0 || pt.t === 1 || pt.t < loT - eps || pt.t > hiT + eps);
      if (kept.length >= 2) env.points = kept;
    }
    let idx = -1;
    for (let k = loS; k <= hiS; k++) {
      // Erase snaps the swept curve to the neutral line (no modulation); flat
      // neutral runs stay sparse instead of gaining dots.
      if (!creatorEraseMode || Math.abs(envValueAt(env, slotT(k)) - neutral) > 1e-9) idx = insertVoiceEnvPoint(env, param, slotT(k), creatorEraseMode ? neutral : rawFromY(y));
    }
    return idx;
  }
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
  if (creatorVolSel) { envDrawAt(slotT(s), yToV(y, p) - envTrim(ENVELOPE), p, loT, hiT, creatorEraseMode); return null; }
  const l = selectedLayer();
  if (l.curve.length > 2) {
    const kept = l.curve.filter(pt => pt.t === 0 || pt.t === 1 || pt.t < loT - eps || pt.t > hiT + eps);
    if (kept.length >= 2) l.curve = kept;
  }
  let idx = -1;
  for (let k = loS; k <= hiS; k++) {
    // Erase snaps the swept curve to the full-volume line (1) rather than the
    // finger's value; flat full-volume runs stay sparse instead of gaining dots.
    if (!creatorEraseMode || Math.abs(clamp01(curveValue(l, slotT(k)) + layerTrim(l)) - 1) > 1e-9) idx = insertCurvePoint(l, slotT(k), creatorEraseMode ? 1 : yToV(y, p) - layerTrim(l));
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
    const sx = tToX(t, p), sy = vToY(clamp01(curveValue(l, t) + layerTrim(l)), p);
    const d = Math.hypot(x - sx, y - sy);
    if (d < best) best = d;
  }
  return best;
}

// Distance from a point to the master envelope's drawn line (sampled).

/* ---- Marker placement (edit the existing envelope indexes) ----
   Markers move by select-then-place: tap a marker to select it, tap one of the
   lit valid destinations (component boundaries it is allowed to sit on) to move
   it. Each marker maps to an envelope index with a constrained range: HOLD
   (holdStartIndex) must stay at or before the hold end; CUT (earlyCutIndex) must
   stay inside the hold range; REL (holdEndIndex) may sit on any boundary. */
// The normalized times (0..1) a marker may legally be placed on, derived from
// the envelope's component boundaries and the index constraints above.
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

// The playhead's normalized note time (0..1 across the graph) while a preview
// note is playing, or -1 when nothing is sounding. Progress is measured against
// the Web Audio clock so the marker stays in sync with the preview audio.
function previewPlayheadT() {
  const ph = previewPlayhead;
  if (!ph || !audioCtx) return -1;
  const at = audioCtx.currentTime;
  if (at < ph.t0 || at >= ph.endAt) return -1;
  const elapsed = (at - ph.t0) * 1000;
  return mixProgForTimes(elapsed, ph.bodyMs, ph.relMs, ph.bodyMs);
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
  const trim = envTrim(ENVELOPE);
  const vOf = v => clamp01(v + trim);
  for (let i = 0; i <= eb.n; i++) {
    const px = tToX(eb.tOf(eb.b[i]), p), py = vToY(vOf(eb.vals[i]), p);
    if (Math.hypot(x - px, y - py) < 18) return { type: 'envbound', idx: i };
  }
  let best = -1, bd = 16;
  for (let c = 0; c < eb.n; c++) {
    const d = segDist(x, y,
      tToX(eb.tOf(eb.b[c]), p), vToY(vOf(eb.vals[c]), p),
      tToX(eb.tOf(eb.b[c + 1]), p), vToY(vOf(eb.vals[c + 1]), p));
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
  if (y >= 64 && y <= 90) {
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
      if (x >= cx && x <= cx + 24 && y >= 64 && y <= 90) return { type: 'layermute', layerIdx: i };
      if (x >= cx && x <= cx + 72) return { type: 'layer', layerIdx: i };
    }
    // Master swatch (pinned first in the Pitch tab).
    if (creatorSubmode === 'pitch' && x >= p.left && x <= p.left + 72) return { type: 'master' };
    // Vol swatch (pinned first in the Volume-envelope tab).
    if (creatorSubmode === 'note' && x >= p.left && x <= p.left + 72) return { type: 'vol' };
    // Preview pitch selector (◀ name ▶)
    if (x >= W - 196 && x <= W - 108) {
      const dir = x < W - 196 + 29 ? -1 : (x < W - 196 + 59 ? 0 : 1);
      return { type: 'pitch', dir };
    }
    if (x >= W - 104 && x <= W - 14) return { type: 'reset' };
    return { type: 'bar' };
  }
  // Segment-editor panel (the Line-mode modal, in the bands above the plot).
  // Taps inside its rect are handled (or swallowed); taps outside fall through
  // so a dot can still re-select a range.
  if (segPanelOpen && creatorSegMode) {
    const segHit = hitTestSegPanel(x, y, p);
    if (segHit) return segHit;
  }
  // Note-life row / voice-chips strip below the controls row.
  if (creatorSubmode === 'voices') {
    if (y >= LIFE_ROW_CY - 14 && y <= LIFE_ROW_CY + 20) {
      const l = selectedVoicesLayer();
      const nV = l ? layerVoices(l).length : 0;
      const rects = voiceChipRects(p);
      for (let i = 0; i < rects.length; i++) {
        const rc = rects[i];
        if (x >= rc.x && x <= rc.x + rc.w && y >= rc.y && y <= rc.y + rc.h) {
          if (i >= nV) return { type: 'voiceaddchip' };
          // ✕ badge on the selected chip deletes that voice.
          if (i === creatorVoiceSel && Math.hypot(x - (rc.x + rc.w - 15), y - LIFE_ROW_CY) < 13) return { type: 'voicedelchip', idx: i };
          // M badge (left) toggles that voice's mute.
          if (Math.hypot(x - (rc.x + 16), y - LIFE_ROW_CY) < 18) return { type: 'voicemute', idx: i };
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
      // When a marker is selected, its lit valid destinations are tappable.
      if (creatorSelMarker) {
        const destY = MARKER_DEST_ROW;
        if (Math.abs(y - destY) <= 12) {
          for (const t of markerValidTimes(creatorSelMarker)) {
            const dx = tToX(t, p);
            if (Math.abs(x - dx) <= 10) return { type: 'markerdest', key: creatorSelMarker, t };
          }
        }
      }
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
  // Mode chips (Voices tab, strip): pick which parameter's envelope curve to
  // edit, plus the Master fallback toggle.
  if (y > MARKER_LANE_TOP && y <= MARKER_LANE_BOTTOM && creatorSubmode === 'voices') {
    for (const c of voiceEnvChips(p)) {
      if (x >= c.x - 4 && x <= c.x + c.w + 4 && y >= c.y - 4 && y <= c.y + c.h + 4) return { type: 'voiceenvchip', key: c.key };
    }
  }
  // Snap-to-semitone toggle pill + interval preset chips (the same strip,
  // Voices tab only, bottom row). Tapping an interval jumps the selected
  // voice's Semitones flat line to that interval.
  if (y > MARKER_LANE_TOP && y <= MARKER_LANE_BOTTOM && creatorSubmode === 'voices') {
    const sp = voiceSnapPill(p);
    if (x >= sp.x - 6 && x <= sp.x + sp.w + 6 && y >= sp.y - 4 && y <= sp.y + sp.h + 4) return { type: 'voicesnap' };
    for (const b of voiceIntervalButtons(p)) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { type: 'voiceint', st: b.st };
    }
    return { type: 'bar' };
  }
  // Widget band (between the marker lane and the plot): the draw-mode toolbar
  // (right) and the Clear/±range pills (left). This strip never overlaps the
  // graph — it is reserved purely for controls.
  if (y >= WIDGET_BAND_TOP && y <= WIDGET_BAND_BOTTOM) {
    if (creatorSubmode !== 'voices') {
      const tb = drawToolbar(p);
      for (const m of tb.modes) {
        if (x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h) return { type: 'mode', mode: m.mode };
      }
    }
    // The ±range/clear pills and the Clear/Trim widgets sit in the band's left
    // corner; the mode toolbar owns the right edge.
    if (creatorSubmode === 'pitch') {
      const rp = pitchRangePill(p);
      if (x >= rp.x && x <= rp.x + rp.w && y >= rp.y && y <= rp.y + rp.h) {
        return { type: 'pitchrange', dir: x < rp.x + rp.w * 0.35 ? -1 : (x > rp.x + rp.w * 0.65 ? 1 : 0) };
      }
      const cp = pitchClearPill(p);
      if (selectedPitchEnvExists() && x >= cp.x && x <= cp.x + cp.w && y >= cp.y && y <= cp.y + cp.h) return { type: 'pitchclear' };
    }
    // Clear pill (Voices tab): reset the selected envelope.
    if (creatorSubmode === 'voices' && !creatorSegMode) {
      const cp = voiceEnvClearPill(p);
      if (selectedVoiceEnvExists() && x >= cp.x && x <= cp.x + cp.w && y >= cp.y && y <= cp.y + cp.h) return { type: 'voiceenvclear' };
    }
    // Clear pill (Volume tab): reset the selected envelope.
    if (creatorSubmode === 'note' && !creatorSegMode) {
      const cp = volClearPill(p);
      if (selectedVolClearable() && x >= cp.x && x <= cp.x + cp.w && y >= cp.y && y <= cp.y + cp.h) return { type: 'volclear' };
    }
    return { type: 'bar' };
  }
  // Vertical trim slider (Volume tab, left edge of the graph): the whole-line
  // mixer fader. Sits in the canvas margin beside the plot, so it never covers
  // the curve or its dots.
  if (creatorSubmode === 'note' && !creatorSegMode) {
    const sl = volTrimSlider(p);
    if (x >= sl.x - 4 && x <= sl.x + sl.w + 4 && y >= sl.y0 - 10 && y <= sl.y1 + 6) return { type: 'voltrim' };
  }
  // Vertical flat-line fader (Voices tab, left edge of the graph): raises or
  // lowers the selected parameter's straight line — the slider value the curve
  // rides on top of.
  if (creatorSubmode === 'voices' && selectedVoice()) {
    const sl = voiceTrimSlider(p);
    if (x >= sl.x - 4 && x <= sl.x + sl.w + 4 && y >= sl.y0 - 10 && y <= sl.y1 + 6) return { type: 'voicetrim' };
  }
  if (y >= p.top && y <= p.bottom) {
    // Voices tab: the envelope editor for the selected parameter's curve.
    if (creatorSubmode === 'voices') {
      // Line mode: the whole graph is a segment picker.
      if (creatorSegMode && segModel()) return { type: 'segselect' };
      if (creatorDrawMode) return { type: 'draw' };
      const env = selectedVoiceEnvOrNull();
      if (env) {
        const param = creatorVoiceEnvSel;
        const neutral = voiceEnvNeutral(param);
        const base = voiceTrimValue();
        for (let j = 0; j < env.points.length; j++) {
          const px = tToX(env.points[j].t, p), py = voiceEnvYFromValue(param, base + (env.points[j].v - neutral), p);
          if (Math.hypot(x - px, y - py) < 18) return { type: 'voiceenvpoint', idx: j };
        }
      }
      return { type: 'emptyvoiceenv' };
    }
    // Line mode: the whole graph is a segment picker — drag across it to select
    // the segment whose start point is horizontally closest to the finger.
    if (creatorSegMode && segModel()) return { type: 'segselect' };
    // Draw/Erase mode takes over the whole graph: any drag scribbles (or zeroes).
    if (creatorDrawMode) return { type: 'draw' };
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
    if (hit.type === 'point' || hit.type === 'envbound' || hit.type === 'pitchpoint' || hit.type === 'harmpoint' || hit.type === 'voiceenvpoint') {
      maybeAutoPreview();
      if (hit.type === 'envbound') envDeleteAt(Math.max(0, hit.idx - 1));
      else if (hit.type === 'pitchpoint') removePitchPoint(ensureSelectedPitchEnv(), hit.idx);
      else if (hit.type === 'harmpoint') removeSpecPoint(selectedLayer(), hit.idx);
      else if (hit.type === 'voiceenvpoint') removeVoiceEnvPoint(ensureSelectedVoiceEnv(), hit.idx);
      else removeCurvePoint(OSC_STACK.layers[hit.layerIdx], hit.ptIdx);
      clearSegSelection();
      previewAndSave();
      return;
    }
    if (hit.type === 'line' || hit.type === 'empty' || hit.type === 'envline' || hit.type === 'emptypitch' || hit.type === 'harm' || hit.type === 'emptyvoiceenv') return;
  }
  if (hit.type !== 'marker' && hit.type !== 'markerdest') creatorSelMarker = null;
  if (hit.type === 'back') { closeSoundCreator(); return; }
  if (hit.type === 'tab') {
    if (hit.enabled) {
      creatorSubmode = hit.submode;
      creatorSelMarker = null;
      creatorVolSel = creatorSubmode === 'note';
      creatorVoiceEnvSel = creatorSubmode === 'voices' ? 'st' : null;
      creatorVoiceEnvMaster = false;
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
    creatorVoiceEnvMaster = false;   // picking a voice edits its own envelope
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
  if (hit.type === 'voiceenvchip') {
    // Mode chips: pick a parameter's curve to edit, or toggle between the
    // selected voice's own curve and the Master fallback.
    if (hit.key === 'master') {
      if (!creatorVoiceEnvSel) creatorVoiceEnvSel = 'st';
      creatorVoiceEnvMaster = !creatorVoiceEnvMaster;
    } else {
      creatorVoiceEnvSel = hit.key;
    }
    creatorPtr = null;
    clearSegSelection();
    maybeAutoPreview();
    return;
  }
  if (hit.type === 'voiceint') {
    // Jump the selected voice's semitone flat line to the tapped interval.
    const v = selectedVoice();
    if (v) {
      v.st = Math.max(VOICE_PARAM_DEFS[0].min, Math.min(VOICE_PARAM_DEFS[0].max, hit.st));
      creatorPtr = null;
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
    // The Master swatch just picks the fallback envelope to edit; it is created
    // lazily on the first draw/tap (like a layer's own envelope).
    creatorPitchSel = 'master';
    creatorPtr = null;
    clearSegSelection();
    maybeAutoPreview();
    saveSettings();
    return;
  }
  if (hit.type === 'pitchclear') {
    // Removes the envelope being edited: a layer's own reverts to inheriting
    // the master; clearing the master removes the fallback entirely.
    if (creatorPitchSel === 'master') MASTER_PITCH_ENV = null;
    else OSC_STACK.layers[creatorPitchSel].pitchEnv = null;
    creatorPtr = null;
    clearSegSelection();
    previewAndSave();
    return;
  }
  if (hit.type === 'volclear') {
    // Resets the volume envelope being edited to default: the master ADSR, or
    // the selected layer's mix curve (it returns to following Vol).
    if (creatorVolSel) {
      ENVELOPE = clone(DEFAULT_ENVELOPE);
      clampEnvelopeIndexes();
    } else {
      resetLayerCurve(selectedLayer());
    }
    creatorPtr = null;
    clearSegSelection();
    previewAndSave();
    return;
  }
  if (hit.type === 'voltrim') {
    // Whole-line mixer: drag the fader to raise/lower the selected curve.
    applyVolTrim(volTrimFromY(volTrimSlider(p), y));
    creatorPtr = { mode: 'voltrim', x0: x, y0: y };
    return;
  }
  if (hit.type === 'voicetrim') {
    // Flat-line fader: drag to raise/lower the voice parameter's straight line.
    applyVoiceTrim(voiceTrimFromY(voiceTrimSlider(p), y));
    creatorPtr = { mode: 'voicetrim', x0: x, y0: y };
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
  if (hit.type === 'voiceenvpoint') {
    maybeAutoPreview();
    const env = ensureSelectedVoiceEnv();
    if (creatorLastTap && performance.now() - creatorLastTap.t < 400 && Math.hypot(x - creatorLastTap.x, y - creatorLastTap.y) < 26) {
      removeVoiceEnvPoint(env, hit.idx);
      creatorLastTap = null;
      clampSegSelection();
      previewAndSave();
      return;
    }
    creatorLastTap = { t: performance.now(), x, y };
    creatorPtr = { mode: 'voiceenvpoint', idx: hit.idx, x0: x, y0: y };
    return;
  }
  if (hit.type === 'emptyvoiceenv') {
    // Tapping anywhere on the graph adds a breakpoint there.
    const env = ensureSelectedVoiceEnv();
    if (env) {
      const param = creatorVoiceEnvSel;
      const base = voiceTrimValue();
      const raw = voiceEnvValueFromY(param, y, p) - (base - voiceEnvNeutral(param));
      const idx = insertVoiceEnvPoint(env, param, xToT(x, p), raw);
      if (idx >= 0) creatorPtr = { mode: 'voiceenvpoint', idx, x0: x, y0: y };
    }
    clearSegSelection();
    previewAndSave();
    return;
  }
  if (hit.type === 'voiceenvclear') {
    // Removes the envelope being edited: a voice's own reverts to inheriting
    // the master; clearing the master removes the fallback entirely.
    clearSelectedVoiceEnv();
    creatorPtr = null;
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
      // Reset the envelope being edited to a flat neutral line (no modulation).
      const env = ensureSelectedVoiceEnv();
      if (env) env.points = [{ t: 0, v: voiceEnvNeutral(creatorVoiceEnvSel) }, { t: 1, v: voiceEnvNeutral(creatorVoiceEnvSel) }];
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
  if (hit.type === 'mode') {
    // Each editor mode has its own button: select the tapped mode directly.
    clearSegSelection();            // From/To selection lives only in Line mode
    creatorDrawMode = hit.mode === 'draw' || hit.mode === 'erase';   // Erase implies Draw
    creatorEraseMode = hit.mode === 'erase';
    creatorDeleteMode = hit.mode === 'delete';
    creatorSegMode = hit.mode === 'line';
    creatorPtr = null;
    return;
  }
  if (hit.type === 'segclear') { clearSegSelection(); return; }
  if (hit.type === 'segtype') { setSegType(hit.t); return; }
  if (hit.type === 'segparam') {
    const R = segPanelRects(p);
    const pr = R.paramGroups.find(r => r.key === hit.key);
    if (pr) setSegParam(hit.key, segParamValue(hit.key) + hit.dir * SEG_PARAM_DEFS[hit.key].step);
    creatorPtr = { mode: 'segparam', key: hit.key, x0: x, y0: y };
    return;
  }
  if (hit.type === 'segslider') {
    const R = segPanelRects(p);
    const pr = R.paramGroups.find(r => r.key === hit.key);
    if (pr) applySegParam(hit.key, segParamFromX(pr, x));
    creatorPtr = { mode: 'segparam', key: hit.key, x0: x, y0: y };
    scheduleCreatorPreview();
    return;
  }
  if (hit.type === 'segselect') {
    // Line mode drag: pick the segment whose start point is closest to the
    // finger (horizontal only); the segment editor tracks the gesture live.
    const i = segIndexAtX(x, p);
    if (i >= 0) selectSegPoint(i);
    creatorPtr = { mode: 'segselect', x0: x, y0: y };
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
  if (hit.type === 'bar') { creatorPtr = null; creatorSelMarker = null; return; }
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
  if (hit.type === 'markerdest') {
    maybeAutoPreview();
    dragCreatorMarker(hit.key, hit.t);
    creatorSelMarker = null;
    previewAndSave();
    return;
  }
  if (hit.type === 'marker') {
    maybeAutoPreview();
    // Select-then-place: tap a marker to arm it (its valid destinations light
    // up); tapping the same marker again deselects it.
    creatorSelMarker = (creatorSelMarker === hit.key) ? null : hit.key;
    creatorPtr = null;
    return;
  }
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
  const p = creatorPlot();
  if (creatorPtr.mode === 'point') {
    const l = OSC_STACK.layers[creatorPtr.layerIdx];
    const pt = l && l.curve[creatorPtr.ptIdx];
    if (pt) {
      pt.t = clamp01(xToT(x, p));
      pt.v = clamp01(yToV(y, p) - layerTrim(l));
      l.curve.sort((a, b) => a.t - b.t);
      creatorPtr.ptIdx = l.curve.indexOf(pt);
      scheduleCreatorPreview();
    }
  } else if (creatorPtr.mode === 'envbound') {
    envDragBoundary(creatorPtr.idx, xToT(x, p), yToV(y, p) - envTrim(ENVELOPE));
    scheduleCreatorPreview();
  } else if (creatorPtr.mode === 'life') {
    applyLifeFromX(x);
    scheduleCreatorPreview();
  } else if (creatorPtr.mode === 'voltrim') {
    applyVolTrim(volTrimFromY(volTrimSlider(p), y));
  } else if (creatorPtr.mode === 'voicetrim') {
    applyVoiceTrim(voiceTrimFromY(voiceTrimSlider(p), y));
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
  } else if (creatorPtr.mode === 'voiceenvpoint') {
    const env = ensureSelectedVoiceEnv();
    if (env) {
      const param = creatorVoiceEnvSel;
      const pt = env.points[creatorPtr.idx];
      if (pt) {
        pt.t = clamp01(xToT(x, p));
        pt.v = voiceEnvValueFromY(param, y, p) - (voiceTrimValue() - voiceEnvNeutral(param));
        env.points.sort((a, b) => a.t - b.t);
        creatorPtr.idx = env.points.indexOf(pt);
        scheduleCreatorPreview();
      }
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
  } else if (creatorPtr.mode === 'segselect') {
    // Re-pick the segment under the gesture as it is drawn across the graph.
    const i = segIndexAtX(x, p);
    if (i >= 0) selectSegPoint(i);
  } else if (creatorPtr.mode === 'segparam') {
    const R = segPanelRects(p);
    const pr = R.paramGroups.find(r => r.key === creatorPtr.key);
    if (pr) {
      applySegParam(creatorPtr.key, segParamFromX(pr, x));
      scheduleCreatorPreview();
    }
  }
});

canvas.addEventListener('pointerup', e => {
  if (!creatorActive || !creatorPtr) return;
  // Selection already happened live during the gesture (Line mode) or the drag
  // was an edit (points, markers, sliders) — only persist here.
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

// Background pill behind an oscillator tab (the Vol/Master swatch or one of the
// Osc swatches). The selected tab is filled with a soft green and given a bold
// outline so the active oscillator is obvious at a glance.
function drawSwatchTab(x, selected) {
  drawRoundRect(x, 64, 72, 26, 9);
  ctx.fillStyle = selected ? '#dff0d3' : '#fff';
  ctx.fill();
  ctx.strokeStyle = selected ? '#2e5d34' : 'rgba(46,93,52,0.25)';
  ctx.lineWidth = selected ? 2 : 1;
  ctx.stroke();
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
    drawSwatchTab(p.left, creatorVolSel);
    ctx.fillStyle = '#1b4523';
    ctx.beginPath();
    ctx.arc(p.left + 7, 76, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = (creatorVolSel ? '800 ' : '700 ') + '11px sans-serif';
    ctx.fillStyle = creatorVolSel ? '#1b4523' : '#6b8e5a';
    ctx.textAlign = 'left';
    ctx.fillText('Vol', p.left + 18, 82);
    // Small 'all' pill: the Vol envelope shapes every oscillator.
    const vx = p.left + 42;
    drawRoundRect(vx, 71, 26, 13, 6);
    ctx.fillStyle = '#e6f2dd';
    ctx.fill();
    ctx.strokeStyle = '#3c7a45';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#2e5d34';
    ctx.font = '800 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('all', vx + 13, 80);
    ctx.textAlign = 'left';
  }
  if (creatorSubmode === 'pitch') {
    const masterSel = creatorPitchSel === 'master';
    const masterOn = !!(MASTER_PITCH_ENV && MASTER_PITCH_ENV.points && MASTER_PITCH_ENV.points.length >= 2);
    drawSwatchTab(p.left, masterSel);
    ctx.fillStyle = '#1b4523';
    ctx.beginPath();
    ctx.arc(p.left + 7, 76, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = ((masterSel || masterOn) ? '800 ' : '700 ') + '11px sans-serif';
    ctx.fillStyle = masterSel ? '#1b4523' : (masterOn ? '#3c7a45' : '#6b8e5a');
    ctx.textAlign = 'left';
    ctx.fillText('Master', p.left + 18, 82);
    if (masterOn) {
      // Small green dot: the fallback envelope exists and is driving layers
      // that have no envelope of their own.
      ctx.beginPath();
      ctx.arc(p.left + 68, 73, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#3c7a45';
      ctx.fill();
    }
  }
  for (let i = 0; i < OSC_STACK.layers.length; i++) {
    const cx = p.left + sw * 76 + i * 76;
    const sel = creatorSubmode === 'pitch' ? creatorPitchSel === i : (!creatorVolSel && i === selectedLayerIdx);
    const muted = !!(OSC_STACK.layers[i].muted);
    const color = OSC_COLORS[i % OSC_COLORS.length];
    drawSwatchTab(cx, sel);
    // Mute button (the swatch's icon): 🔊 when the layer is live, 🔇 when
    // muted. A white chip with a layer-colored border (red border when muted).
    drawRoundRect(cx + 1, 65, 22, 22, 7);
    ctx.fillStyle = muted ? '#fdecea' : '#fff';
    ctx.fill();
    ctx.strokeStyle = muted ? '#c0392b' : color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(muted ? '🔇' : '🔊', cx + 12, 77);
    ctx.textBaseline = 'alphabetic';
    ctx.font = (sel ? '800 ' : '700 ') + '11px sans-serif';
    ctx.fillStyle = muted ? '#9db89c' : (sel ? '#1b4523' : '#6b8e5a');
    ctx.textAlign = 'left';
    ctx.fillText('Osc ' + (i + 1), cx + 28, 82);
    // Status badge (bottom-right of the swatch, pitch tab only): which envelope
    // this oscillator actually plays. 'own' = its own pitch envelope, 'M' = it
    // inherits the master fallback because it has no envelope of its own.
    if (creatorSubmode === 'pitch') {
      const l = OSC_STACK.layers[i];
      let hasOwn, usesMaster;
      hasOwn = !!(l && l.pitchEnv && l.pitchEnv.points && l.pitchEnv.points.length >= 2);
      usesMaster = !hasOwn && !!(MASTER_PITCH_ENV && MASTER_PITCH_ENV.points && MASTER_PITCH_ENV.points.length >= 2);
      if (hasOwn || usesMaster) {
        const bx = cx + 45, by = 84, bw = 26, bh = 13;
        drawRoundRect(bx, by, bw, bh, 7);
        if (hasOwn) {
          ctx.fillStyle = color;
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = '800 8px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('own', bx + bw / 2, by + bh / 2 + 3);
        } else {
          ctx.fillStyle = '#e6f2dd';
          ctx.fill();
          ctx.strokeStyle = '#3c7a45';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = '#2e5d34';
          ctx.font = '800 8px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('M', bx + bw / 2, by + bh / 2 + 3);
        }
        ctx.textAlign = 'left';
      }
    }
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
  ctx.fillText(creatorVolSel ? '↺ Reset vol' : creatorSubmode === 'pitch' ? '↺ Reset pitch' : creatorSubmode === 'voices' ? '↺ Reset curve' : creatorSubmode === 'harm' ? '↺ Reset spec' : '↺ Reset curve', W - 59, 83);

  // Voice chips strip (Voices tab): pick which duplicate to edit, or add one.
  if (creatorSubmode === 'voices') {
    const l = selectedVoicesLayer();
    const nV = l ? layerVoices(l).length : 0;
    const rects = voiceChipRects(p);
    ctx.textAlign = 'center';
    const chipAlpha = creatorVoiceEnvMaster ? 0.55 : 1;
    for (let i = 0; i < nV; i++) {
      const rc = rects[i], selChip = i === creatorVoiceSel;
      const v = l.voices[i];
      const vMuted = !!(v && v.muted);
      ctx.globalAlpha = chipAlpha;
      drawRoundRect(rc.x, rc.y, rc.w, rc.h, 10);
      ctx.fillStyle = selChip ? (vMuted ? '#5c8a62' : '#2e5d34') : (vMuted ? '#e5eee1' : '#fff');
      ctx.fill();
      ctx.strokeStyle = selChip ? '#1b4523' : (vMuted ? 'rgba(107,142,90,0.55)' : 'rgba(46,93,52,0.4)');
      ctx.lineWidth = selChip ? 2 : 1;
      ctx.stroke();
      // Mute badge: the button at the left of each chip (tap it to mute/unmute).
      const mbx = rc.x + 16, mby = LIFE_ROW_CY;
      ctx.beginPath();
      ctx.arc(mbx, mby, 10, 0, Math.PI * 2);
      ctx.fillStyle = vMuted ? '#c0392b' : '#eef5ea';
      ctx.fill();
      ctx.strokeStyle = vMuted ? '#c0392b' : 'rgba(46,93,52,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = '14px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(vMuted ? '🔇' : '🔊', mbx, mby + 1);
      ctx.textBaseline = 'alphabetic';
      // Two-part label: voice number on the left, semitone offset on the right,
      // so the value never runs into the delete badge at the far end.
      const lblColor = selChip ? '#fff' : (vMuted ? '#9db89c' : '#2e5d34');
      ctx.fillStyle = lblColor;
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('V' + (i + 1), rc.x + 31, rc.y + rc.h / 2 + 4);
      ctx.textAlign = 'right';
      const stLbl = (Math.round((+v.st || 0) * 100) / 100) + ' st';
      ctx.fillText(stLbl, rc.x + rc.w - 20, rc.y + rc.h / 2 + 4);
      ctx.textAlign = 'center';
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
        ctx.arc(rc.x + rc.w - 15, LIFE_ROW_CY, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '800 10px sans-serif';
        ctx.fillText('✕', rc.x + rc.w - 15, LIFE_ROW_CY + 3);
      }
    }
    ctx.globalAlpha = 1;
    if (nV < MAX_LAYER_VOICES) {
      const rc = rects[nV];
      drawRoundRect(rc.x, rc.y, rc.w, rc.h, 10);
      ctx.fillStyle = '#eef5ea';
      ctx.fill();
      ctx.strokeStyle = 'rgba(46,93,52,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#2e5d34';
      ctx.font = '800 13px sans-serif';
      ctx.fillText('+', rc.x + rc.w / 2, rc.y + rc.h / 2 + 4);
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
      const armed = creatorSubmode === 'note' && creatorSelMarker === tab.key;
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
      ctx.fillStyle = armed ? '#fff7cc' : fillColor;
      ctx.fill();
      ctx.strokeStyle = armed ? '#8a6d00' : 'rgba(0,0,0,0)';
      ctx.lineWidth = armed ? 2 : 0;
      ctx.stroke();
      ctx.fillStyle = armed ? '#5a4600' : labelColor;
      ctx.font = '800 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(tab.label, tab.cx, tab.y + 15);
    }
    // When a marker is armed (note tab), light up its valid destinations as
    // move targets on the destination row.
    if (creatorSubmode === 'note' && creatorSelMarker) {
      const def = MARKER_DEFS.find(d => d.key === creatorSelMarker);
      const color = def ? def.color : '#2e5d34';
      for (const t of markerValidTimes(creatorSelMarker)) {
        const dx = tToX(t, p);
        ctx.beginPath();
        ctx.arc(dx, MARKER_DEST_ROW, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
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

  // ---- Mode chips (Voices tab only, above the plot): which parameter's
  // envelope to edit, plus the Master fallback toggle. A small dot marks a
  // parameter that has an envelope defined (own or Master) for the selected
  // voice. ----
  if (creatorSubmode === 'voices') {
    const v = selectedVoice();
    const hasAnyMaster = ['st', 'ct', 'vol'].some(k => MASTER_VOICE_ENVS[k] && MASTER_VOICE_ENVS[k].points && MASTER_VOICE_ENVS[k].points.length >= 2);
    for (const c of voiceEnvChips(p)) {
      const active = c.key === 'master' ? creatorVoiceEnvMaster : creatorVoiceEnvSel === c.key;
      const hasEnv = c.key === 'master' ? hasAnyMaster : (v ? !!activeVoiceEnv(v, c.key) : false);
      drawRoundRect(c.x, c.y, c.w, c.h, 8);
      ctx.fillStyle = active ? '#2e5d34' : '#fff';
      ctx.fill();
      ctx.strokeStyle = active ? '#2e5d34' : 'rgba(46,93,52,0.4)';
      ctx.lineWidth = active ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = active ? '#fff' : '#2e5d34';
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(c.label, c.x + c.w / 2, c.y + c.h / 2 + 3);
      if (hasEnv) {
        // Envelope-defined dot (top-right corner), contrasting on the active chip.
        ctx.fillStyle = active ? '#ffd86b' : '#e0862d';
        ctx.beginPath();
        ctx.arc(c.x + c.w - 7, c.y + 6, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---- Snap-to-semitone toggle pill (Voices tab, flat-line fader for Semitones) ----
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

  // ---- Interval preset chips (Voices tab, right of the Snap pill) ----
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
    ctx.fillText('+' + r + ' st', p.left + 2, p.top + 10);
    const y0 = ampToY(0, p);
    ctx.fillText('0', p.left + 2, y0 + 3);
    ctx.fillText('−' + r + ' st', p.left + 2, p.bottom - 4);
    ctx.textAlign = 'right';
    ctx.fillText('note life →', p.right, p.bottom - 6);
  } else if (creatorSubmode === 'voices') {
    const param = creatorVoiceEnvSel;
    const range = VOICE_PARAM_RANGES[param] || 1;
    const unit = param === 'st' ? ' st' : (param === 'ct' ? ' ¢' : '×');
    if (param === 'vol') {
      ctx.fillText('+' + range + '×', p.left + 2, p.top + 10);
      ctx.fillText('1', p.left + 2, voiceEnvYFromValue(param, 1, p) + 3);
      ctx.fillText('0', p.left + 2, p.bottom - 4);
    } else {
      ctx.fillText('+' + range + unit, p.left + 2, p.top + 10);
      ctx.fillText('0', p.left + 2, ampToY(0, p) + 3);
      ctx.fillText('−' + range + unit, p.left + 2, p.bottom - 4);
    }
    ctx.textAlign = 'right';
    ctx.fillText('note life →', p.right, p.bottom - 6);
    ctx.textAlign = 'left';
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
    // Layer mix curves (the selected layer solid, the others in their own color
    // but more transparent so the active one reads clearly).
    for (let i = 0; i < OSC_STACK.layers.length; i++) {
      const l = OSC_STACK.layers[i];
      const sel = !creatorVolSel && i === selectedLayerIdx;
      const muted = !!(l.muted);
      const trim = layerTrim(l);
      ctx.strokeStyle = OSC_COLORS[i % OSC_COLORS.length];
      ctx.globalAlpha = muted ? 0.22 : (sel ? 1 : 0.2);
      ctx.lineWidth = sel ? 3 : 2;
      const curve = l.curve || [];
      if (!curve.length) { ctx.globalAlpha = 1; continue; }
      // Extend the flat clamped regions out to the plot edges, then stroke each
      // segment with its own line type. The whole line is offset by the trim.
      const pts = [{ x: tToX(0, p), y: vToY(clamp01(curveValue(l, 0) + trim), p), v: clamp01(curveValue(l, 0) + trim), el: null }];
      for (let k = 0; k < curve.length; k++) pts.push({ x: tToX(curve[k].t, p), y: vToY(clamp01(curve[k].v + trim), p), v: clamp01(curve[k].v + trim), el: curve[k] });
      pts.push({ x: tToX(1, p), y: vToY(clamp01(curveValue(l, 1) + trim), p), v: clamp01(curveValue(l, 1) + trim), el: null });
      strokeSegPath(pts, 1, v => vToY(clamp01(v), p));
      ctx.globalAlpha = 1;
      if (sel) {
        ctx.globalAlpha = muted ? 0.5 : 1;
        for (const pt of curve) {
          ctx.fillStyle = OSC_COLORS[i % OSC_COLORS.length];
          ctx.beginPath();
          ctx.arc(tToX(pt.t, p), vToY(clamp01(pt.v + trim), p), 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
    // Master envelope outline (bold when Vol is selected, faint otherwise). The
    // whole ADSR line is offset by the envelope's trim.
    ctx.globalAlpha = creatorVolSel ? 1 : 0.2;
    ctx.strokeStyle = '#2e5d34';
    ctx.lineWidth = creatorVolSel ? 3 : 1.5;
    const envTrimT = envTrim(ENVELOPE);
    const envPts = [];
    for (let i = 0; i <= eb.n; i++) envPts.push({ x: tToX(eb.tOf(eb.b[i]), p), y: vToY(clamp01(eb.vals[i] + envTrimT), p), v: clamp01(eb.vals[i] + envTrimT), el: i < eb.n ? eb.env.components[i] : null });
    strokeSegPath(envPts, 1, v => vToY(clamp01(v), p));
    ctx.globalAlpha = 1;
    if (creatorVolSel) {
      for (let i = 0; i <= eb.n; i++) {
        ctx.fillStyle = '#2e5d34';
        ctx.beginPath();
        ctx.arc(tToX(eb.tOf(eb.b[i]), p), vToY(clamp01(eb.vals[i] + envTrimT), p), 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    // The volume Clear pill lives in the widget band above the plot (drawn
    // later, outside the graph), so it never covers the curve.
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
      const masterOn = !!(MASTER_PITCH_ENV && MASTER_PITCH_ENV.points && MASTER_PITCH_ENV.points.length >= 2);
      ctx.fillText(creatorPitchSel === 'master'
        ? 'Master has no pitch envelope yet · tap or draw to create one'
        : masterOn
        ? 'Osc ' + (creatorPitchSel + 1) + ' inherits the Master (no envelope of its own) · draw to give it its own'
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
    // The ±range and Clear pills live in the widget band above the plot (drawn
    // later, outside the graph), so they never cover the envelope.
  }

  // ---- Voice slider envelope (voices sub-mode, curve editor) ----
  if (creatorSubmode === 'voices') {
    const param = creatorVoiceEnvSel;
    const range = VOICE_PARAM_RANGES[param] || 1;
    const neutral = voiceEnvNeutral(param);
    const env = selectedVoiceEnvOrNull();
    const paramLabel = param === 'st' ? 'semitones' : (param === 'ct' ? 'cents' : 'volume');
    const base = voiceTrimValue();          // flat-line value (the fader)
    const yBase = voiceEnvYFromValue(param, base, p);
    // Neutral line: the flat-line position the fader raises and lowers.
    ctx.strokeStyle = 'rgba(46,93,52,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.left, yBase); ctx.lineTo(p.right, yBase);
    ctx.stroke();
    if (!env) {
      // No curve on this selection yet: dashed guide at the flat line until the
      // first edit.
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(46,93,52,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.left, yBase); ctx.lineTo(p.right, yBase);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#9db89c';
      ctx.font = '700 11px sans-serif';
      ctx.textAlign = 'center';
      const masterOn = !!(MASTER_VOICE_ENVS[param] && MASTER_VOICE_ENVS[param].points && MASTER_VOICE_ENVS[param].points.length >= 2);
      ctx.fillText(creatorVoiceEnvMaster
        ? 'The Master ' + paramLabel + ' curve has no curve yet · tap or draw to create one'
        : masterOn
        ? 'This voice inherits the Master ' + paramLabel + ' curve (no curve of its own) · draw to give it its own'
        : 'This voice has no ' + paramLabel + ' curve · tap or draw to bend it · the fader at left sets the flat line', W / 2, p.top + p.ph / 2 - 14);
    } else {
      const color = creatorVoiceEnvMaster ? '#2e5d34' : OSC_COLORS[selectedLayerIdx % OSC_COLORS.length];
      // Selected-range highlight behind the envelope.
      const hl = segRangeHighlight(p);
      if (hl) {
        ctx.fillStyle = 'rgba(46,93,52,0.09)';
        ctx.fillRect(hl.x0, p.top, hl.x1 - hl.x0, p.ph);
      }
      const pts = env.points;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      const yOf = v => voiceEnvYFromValue(param, base + (v - neutral), p);
      const path = [{ x: tToX(0, p), y: yOf(envValueAt(env, 0)), v: envValueAt(env, 0), el: null }];
      for (let j = 0; j < pts.length; j++) path.push({ x: tToX(pts[j].t, p), y: yOf(pts[j].v), v: pts[j].v, el: pts[j] });
      path.push({ x: tToX(1, p), y: yOf(envValueAt(env, 1)), v: envValueAt(env, 1), el: null });
      strokeSegPath(path, Math.max(1, range), yOf);
      for (const pt of pts) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(tToX(pt.t, p), yOf(pt.v), 6, 0, Math.PI * 2);
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

  // ---- Widget band (between the marker lane and the plot) ----
  // Editor-mode buttons + draw-points pill (right).
  if (creatorSubmode !== 'voices') {
    const tb = drawToolbar(p);
    ctx.textBaseline = 'middle';
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'center';
    // One button per editor mode, lined up side by side.
    for (const m of tb.modes) {
      const active = creatorModeActive(m.mode);
      const color = creatorModeColor(m.mode);
      drawRoundRect(m.x, m.y, m.w, m.h, 8);
      ctx.fillStyle = active ? color : '#fff';
      ctx.fill();
      ctx.strokeStyle = active ? color : 'rgba(46,93,52,0.4)';
      ctx.lineWidth = active ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = active ? '#fff' : '#2e5d34';
      ctx.fillText(m.label, m.x + m.w / 2, m.y + m.h / 2 + 1);
    }
    // The draw-points pill (a native <select> overlays it).
    drawRoundRect(tb.dens.x, tb.dens.y, tb.dens.w, tb.dens.h, 8);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(46,93,52,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#2e5d34';
    ctx.fillText(drawPointCount() + ' pts ▾', tb.dens.x + tb.dens.w / 2, tb.dens.y + tb.dens.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';

    // Position the native points <select> over the pill (creator-active only).
    const ptsSel = document.getElementById('creatorPoints');
    if (ptsSel) {
      ptsSel.style.left = (tb.dens.x + SAFE.left) + 'px';
      ptsSel.style.top = (tb.dens.y + SAFE.top) + 'px';
      ptsSel.style.width = tb.dens.w + 'px';
      ptsSel.style.height = tb.dens.h + 'px';
      ptsSel.style.display = creatorActive ? 'block' : 'none';
    }
  } else {
    // The toolbar (and its points <select>) is hidden in the Voices tab — make
    // sure the select isn't left floating over the graph after switching tabs.
    const ptsSel = document.getElementById('creatorPoints');
    if (ptsSel) ptsSel.style.display = 'none';
  }

  // Clear/±range pills (left of the widget band).
  {
    if (creatorSubmode === 'pitch') {
      const rp = pitchRangePill(p);
      const env = selectedPitchEnvOrNull();
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
      // Clear pill (beside the range pill): removes the envelope being edited —
      // a layer's own envelope, or the master fallback. Only shown while the
      // selected envelope actually exists.
      if (selectedPitchEnvExists()) {
        const cp = pitchClearPill(p);
        drawRoundRect(cp.x, cp.y, cp.w, cp.h, 8);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#c0392b';
        ctx.font = '700 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Clear', cp.x + cp.w / 2, cp.y + cp.h / 2 + 4);
      }
    }
    // Clear pill (Voices tab): removes the envelope being edited — a voice's own
    // reverts to inheriting the master; clearing the master removes the
    // fallback entirely.
    if (creatorSubmode === 'voices' && !creatorSegMode && selectedVoiceEnvExists()) {
      const cp = voiceEnvClearPill(p);
      drawRoundRect(cp.x, cp.y, cp.w, cp.h, 8);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#c0392b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#c0392b';
      ctx.font = '700 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Clear', cp.x + cp.w / 2, cp.y + cp.h / 2 + 4);
    }
    // Clear pill (Volume tab): resets the volume envelope being edited — the
    // master ADSR, or the selected layer's mix curve (back to following Vol).
    if (creatorSubmode === 'note' && !creatorSegMode && selectedVolClearable()) {
      const cp = volClearPill(p);
      drawRoundRect(cp.x, cp.y, cp.w, cp.h, 8);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#c0392b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#c0392b';
      ctx.font = '700 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Clear', cp.x + cp.w / 2, cp.y + cp.h / 2 + 4);
    }
    // Trim slider (Volume tab, left edge of the graph): the whole-line mixer
    // fader — drag up to raise the selected curve, down to lower it.
    if (creatorSubmode === 'note' && !creatorSegMode) {
      const sl = volTrimSlider(p);
      const cx = sl.x + sl.w / 2;
      const trim = volTrimValue();
      // Track.
      ctx.strokeStyle = 'rgba(46,93,52,0.5)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, sl.y0); ctx.lineTo(cx, sl.y1);
      ctx.stroke();
      // Center notch (0 = unchanged).
      ctx.strokeStyle = 'rgba(46,93,52,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sl.x, (sl.y0 + sl.y1) / 2); ctx.lineTo(sl.x + sl.w, (sl.y0 + sl.y1) / 2);
      ctx.stroke();
      // Thumb.
      const cy = sl.y1 - (trim + 1) / 2 * (sl.y1 - sl.y0);
      drawRoundRect(sl.x, cy - 7, sl.w, 14, 7);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = creatorVolSel ? '#2e5d34' : OSC_COLORS[selectedLayerIdx % OSC_COLORS.length];
      ctx.lineWidth = 2;
      ctx.stroke();
      // Tiny label.
      ctx.fillStyle = '#6b8e5a';
      ctx.font = '700 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Trim', cx, sl.y0 - 6);
    }
    // Flat-line fader (Voices tab, left edge of the graph): raises/lowers the
    // selected parameter's straight line — the static slider value the curve
    // rides on top of.
    if (creatorSubmode === 'voices' && selectedVoice()) {
      const sl = voiceTrimSlider(p);
      const cx = sl.x + sl.w / 2;
      const param = creatorVoiceEnvSel;
      const range = VOICE_PARAM_RANGES[param] || 1;
      const val = voiceTrimValue();
      ctx.strokeStyle = 'rgba(46,93,52,0.5)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, sl.y0); ctx.lineTo(cx, sl.y1);
      ctx.stroke();
      // Neutral notch (st/ct 0, vol 1).
      const notchVal = param === 'vol' ? 1 : 0;
      const ny = sl.y1 - (notchVal - (param === 'vol' ? 0 : -range)) / (param === 'vol' ? range : 2 * range) * (sl.y1 - sl.y0);
      ctx.strokeStyle = 'rgba(46,93,52,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sl.x, ny); ctx.lineTo(sl.x + sl.w, ny);
      ctx.stroke();
      // Thumb (top = max for vol, +range for st/ct).
      const tf = param === 'vol' ? 1 - val / range : (range - val) / (2 * range);
      const cy = sl.y0 + tf * (sl.y1 - sl.y0);
      drawRoundRect(sl.x, cy - 7, sl.w, 14, 7);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = creatorVoiceEnvMaster ? '#2e5d34' : OSC_COLORS[selectedLayerIdx % OSC_COLORS.length];
      ctx.lineWidth = 2;
      ctx.stroke();
      // Tiny label + readout.
      ctx.fillStyle = '#6b8e5a';
      ctx.font = '700 8px sans-serif';
      ctx.textAlign = 'center';
      const unit = param === 'st' ? ' st' : (param === 'ct' ? ' ¢' : '×');
      ctx.fillText(param === 'vol' ? 'Vol' : (param === 'st' ? 'St' : 'Ct'), cx, sl.y0 - 6);
      ctx.fillText((Math.round(val * 100) / 100) + unit, cx, sl.y1 + 10);
    }
    // Line-mode hint (Volume tab): a gentle reminder of the drag-to-select
    // gesture while no segment is picked yet. Skipped if the toolbar leaves no
    // room for it (very narrow screens).
    if (creatorSegMode && creatorSubmode === 'note' && !segPanelOpen) {
      const hp = lineHintPill(p);
      if (hp.w >= 90) {
        drawRoundRect(hp.x, hp.y, hp.w, hp.h, 8);
        ctx.fillStyle = '#2e5d34';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '700 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Line · drag the graph to select', hp.x + hp.w / 2, hp.y + hp.h / 2 + 4);
      }
    }
  }

  // ---- Segment editor panel (compact modal above the plot; Line mode only) ----
  if (segPanelOpen && creatorSegMode && segModel()) drawSegPanel(p);

  // ---- Preview playhead: animates across the graph while a note is previewed ----
  if (creatorSubmode === 'note' || creatorSubmode === 'pitch' || (creatorSubmode === 'voices' && creatorVoiceEnvSel)) {
    const phT = previewPlayheadT();
    if (phT >= 0) {
      const px = tToX(phT, p);
      ctx.strokeStyle = 'rgba(20,20,20,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, p.top);
      ctx.lineTo(px, p.bottom);
      ctx.stroke();
      // A small downward triangle at the top edge reads as a moving playhead
      // rather than a grid line.
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.moveTo(px, p.top + 8);
      ctx.lineTo(px - 5, p.top);
      ctx.lineTo(px + 5, p.top);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---- Hint ----
  ctx.fillStyle = '#6b8e5a';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  if (creatorSubmode === 'voices') {
    ctx.fillText('Editing the ' + (creatorVoiceEnvSel === 'st' ? 'semitones' : creatorVoiceEnvSel === 'ct' ? 'cents' : 'volume') + ' curve' + (creatorVoiceEnvMaster ? ' (Master — the fallback every voice without its own inherits)' : ' of the selected voice') + ' · the fader at the left raises/lowers the flat line (drag it, or tap an interval chip to jump Semitones) · tap or draw to bend the curve · drag a dot · double-tap a dot to delete · Clear (above the graph) removes the curve', W / 2, H - 8);
  } else if (creatorSegMode) {
    ctx.fillText('Line-type mode · drag across the graph to select a segment (the one whose start point is closest) and pick Line / Stairs / Spring / Pulse · Freq is the number of ups & downs across the segment · Depth is % of the full value scale · tap another mode button above the graph to exit', W / 2, H - 8);
  } else if (creatorDeleteMode) {
    ctx.fillText('Delete mode · tap a dot to remove it · tap Point above the graph to return (double-tap a dot also deletes in Point mode)', W / 2, H - 8);
  } else if (creatorDrawMode) {
    const voiceEnvTarget = () => {
      const param = creatorVoiceEnvSel === 'st' ? 'semitones' : creatorVoiceEnvSel === 'ct' ? 'cents' : 'volume';
      return 'the ' + param + ' curve' + (creatorVoiceEnvMaster ? ' (Master)' : ' of the selected voice');
    };
    ctx.fillText(creatorEraseMode
      ? 'Erasing the ' + (creatorSubmode === 'note' ? (creatorVolSel ? 'volume envelope' : 'selected oscillator mix') : creatorSubmode === 'pitch' ? (creatorPitchSel === 'master' ? 'master pitch envelope' : 'selected oscillator pitch envelope') : (creatorSubmode === 'voices') ? voiceEnvTarget() : 'selected oscillator spectrum') + ' · drag across a region to snap it to the erase line · tap Point above the graph to edit dots'
      : creatorSubmode === 'note'
      ? 'Drawing the ' + (creatorVolSel ? 'volume envelope (the note\u2019s attack/decay/release, applied to all oscillators)' : 'selected oscillator mix curve (this oscillator\u2019s own level over the note)') + ' · drag to scribble (' + drawPointCount() + ' pts) · tap Point above the graph to edit dots'
      : creatorSubmode === 'pitch'
        ? 'Drawing the ' + (creatorPitchSel === 'master' ? 'master pitch envelope (fallback for oscillators without their own)' : 'selected oscillator pitch envelope') + ' · drag to scribble (' + drawPointCount() + ' pts) · tap Point above the graph to edit dots'
        : creatorSubmode === 'voices'
          ? 'Drawing ' + voiceEnvTarget() + ' · drag to scribble (' + drawPointCount() + ' pts) · tap Point above the graph to edit dots'
          : 'Drawing the selected oscillator spectrum · drag to scribble (' + drawPointCount() + ' pts) · tap Point above the graph to edit dots', W / 2, H - 8);
  } else {
    ctx.fillText(creatorSubmode === 'note'
      ? 'Vol shapes every oscillator\u2019s attack/decay/release · a swatch\u2019s badge shows own (customized curve) vs vol (follows Vol) · Clear (above the graph) resets the selected curve · the Trim fader (left of the graph) raises/lowers the whole line · drag HOLD/CUT/REL markers and set note life on the right · drag dots · tap to add · double-tap a dot to delete · tap Line above the graph to shape a segment\u2019s line type'
: creatorSubmode === 'pitch'
          ? 'Each oscillator uses its own envelope when it has one, otherwise it inherits the Master (fallback) · swatches show which (own / M) · Clear (above the graph) removes the selected envelope · drag dots · tap to add · set ±range above · tap Line above the graph to shape a segment\u2019s line type'
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