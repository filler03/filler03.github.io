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

let creatorSubmode = 'mix';   // 'mix' active in phase 1; env/harmonic tabs disabled
let creatorPtr = null;        // { mode:'point'|'marker', layerIdx, ptIdx|key, x0, y0, moved }
let creatorLastTap = null;    // { t, x, y } for double-tap-to-delete
let creatorPreviewTimer = null;

/* ---- Open / close ---- */
function openSoundCreator(submode, layerIdx) {
  creatorActive = true;
  creatorSubmode = submode || 'mix';
  if (layerIdx != null && layerIdx >= 0 && layerIdx < OSC_STACK.layers.length) selectedLayerIdx = layerIdx;
  mode = 'creator';
  stopGestureNote();
  stopPreviewVoices();
  playbacks.length = 0;
  settingsPanel.classList.add('hidden');
  document.body.classList.add('creator');
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
  flushSettingsSave();
}

creatorBtn.addEventListener('click', () => {
  if (creatorActive) { closeSoundCreator(); return; }
  initAudio();
  resumeAudio();
  openSoundCreator('mix', selectedLayerIdx);
});

/* ---- Plot geometry ---- */
function creatorPlot() {
  const top = 124, bottom = H - 26, left = 20, right = W - 14;
  return { top, bottom, left, right, pw: right - left, ph: bottom - top };
}
const tToX = (t, p) => p.left + clamp01(t) * p.pw;
const xToT = (x, p) => clamp01((x - p.left) / p.pw);
const vToY = (v, p) => p.bottom - clamp01(v) * p.ph;
const yToV = (y, p) => clamp01((p.bottom - y) / p.ph);

/* ---- Time markers (shared by Mix & Envelope) ----
   HOLD / CUT / REL are draggable via grab tabs drawn above the plot. Tabs at
   nearby x positions are staggered onto a second row so overlapping markers
   (e.g. cut == hold end) stay separately grabbable. */
const MARKER_DEFS = [
  { key: 'hold', label: 'HOLD', color: '#00897b' },
  { key: 'cut', label: 'CUT', color: '#f57c00' },
  { key: 'rel', label: 'REL', color: '#d9534f' },
];
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
    let y = 90;
    for (const t of tabs) if (Math.abs(t.cx - cx) < 48) y = 108;
    tabs.push({ key: m.key, label: m.label, color: m.color, cx, x: cx - 23, y, w: 46, h: 16 });
  }
  return tabs;
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
  if (curve.length >= 16) return -1;
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
    { submode: 'mix', label: 'Mix', enabled: true },
    { submode: 'env', label: 'Envelope', enabled: true },
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
      const w = 74;
      tx -= w;
      if (x >= tx && x <= tx + w) return { type: 'tab', submode: tabs[i].submode, enabled: tabs[i].enabled };
    }
    return { type: 'bar' };
  }
  const p = creatorPlot();
  if (y >= 66 && y <= 90) {
    if (creatorSubmode !== 'env') {
      for (let i = 0; i < OSC_STACK.layers.length; i++) {
        const cx = p.left + i * 76;
        if (x >= cx && x <= cx + 70) return { type: 'layer', layerIdx: i };
      }
    }
    // Stable-test toggle (freeze the mix so the pitch can't climb)
    if (x >= W - 292 && x <= W - 200) return { type: 'stable' };
    // Preview pitch selector (◀ name ▶)
    if (x >= W - 196 && x <= W - 108) {
      const dir = x < W - 196 + 29 ? -1 : (x < W - 196 + 59 ? 0 : 1);
      return { type: 'pitch', dir };
    }
    if (x >= W - 104 && x <= W - 14) return { type: 'reset' };
    return { type: 'bar' };
  }
  // Marker grab tabs (above the plot; Mix & Envelope only).
  if (y > 90 && y <= 124 && creatorSubmode !== 'harm') {
    for (const tab of markerTabs(p)) {
      if (x >= tab.x && x <= tab.x + tab.w && y >= tab.y && y <= tab.y + tab.h) return { type: 'marker', key: tab.key };
    }
    return { type: 'bar' };
  }
  if (y >= p.top && y <= p.bottom) {
    if (creatorSubmode === 'harm') return hitTestHarm(x, y, p);
    const tl = designTimeline();
    const markers = [
      { t: tl.tHoldStart, key: 'hold' },
      { t: tl.tCut, key: 'cut' },
      { t: tl.tHoldEnd, key: 'rel' },
    ];
    for (const m of markers) {
      if (Math.abs(x - tToX(m.t, p)) < 16) return { type: 'marker', key: m.key };
    }
    if (creatorSubmode === 'env') return hitTestEnv(x, y, p);
    // Breakpoints: the selected layer first, then the others.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < OSC_STACK.layers.length; i++) {
        if ((pass === 0) !== (i === selectedLayerIdx)) continue;
        const curve = OSC_STACK.layers[i].curve;
        for (let j = 0; j < curve.length; j++) {
          const px = tToX(curve[j].t, p), py = vToY(clamp01(curve[j].v), p);
          if (Math.hypot(x - px, y - py) < 18) return { type: 'point', layerIdx: i, ptIdx: j };
        }
      }
    }
    let best = null, bd = 22;
    for (let i = 0; i < OSC_STACK.layers.length; i++) {
      const d = distToCurve(i, x, y, p);
      if (d < bd) { bd = d; best = i; }
    }
    if (best != null) return { type: 'line', layerIdx: best };
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
      if (creatorSubmode === 'harm') initLayerSpecPoints(selectedLayer());
    }
    return;
  }
  if (hit.type === 'layer') {
    selectedLayerIdx = hit.layerIdx;
    if (creatorSubmode === 'harm') initLayerSpecPoints(selectedLayer());
    creatorPtr = null;
    previewChime();
    return;
  }
  if (hit.type === 'reset') {
    if (creatorSubmode === 'env') {
      ENVELOPE = clone(DEFAULT_ENVELOPE);
      clampEnvelopeIndexes();
      renderEnvelopeEditor();
    } else if (creatorSubmode === 'harm') {
      const l = selectedLayer();
      l.specPoints = null;
      l.presetId = null;
      for (let i = 0; i < HARMONIC_COUNT; i++) l.amplitudes[i] = i === 0 ? 1 : 0;
      initLayerSpecPoints(l);
    } else {
      resetLayerCurve(selectedLayer());
    }
    previewAndSave();
    return;
  }
  if (hit.type === 'bar') { creatorPtr = null; return; }
  if (hit.type === 'stable') {
    PREVIEW_STABLE_MIX = !PREVIEW_STABLE_MIX;
    previewAndSave();
    return;
  }
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
  if (hit.type === 'marker') { previewChime(); creatorPtr = { mode: 'marker', key: hit.key, x0: x, y0: y }; return; }
  if (hit.type === 'harmpoint') {
    previewChime();
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
    previewChime();
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
    const ms = clamp01(xToT(x, p)) * eb.total;
    envSplitAt(hit.c, ms);
    previewAndSave();
    return;
  }
  if (hit.type === 'point') {
    previewChime();
    if (creatorLastTap && performance.now() - creatorLastTap.t < 400 && Math.hypot(x - creatorLastTap.x, y - creatorLastTap.y) < 26) {
      removeCurvePoint(OSC_STACK.layers[hit.layerIdx], hit.ptIdx);
      creatorLastTap = null;
      previewAndSave();
      return;
    }
    creatorLastTap = { t: performance.now(), x, y };
    if (hit.layerIdx !== selectedLayerIdx) selectedLayerIdx = hit.layerIdx;
    creatorPtr = { mode: 'point', layerIdx: hit.layerIdx, ptIdx: hit.ptIdx, x0: x, y0: y };
    return;
  }
  if (hit.type === 'line') { selectedLayerIdx = hit.layerIdx; creatorPtr = null; previewChime(); return; }
  // Empty: add a breakpoint to the selected layer and grab it.
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
  }
  creatorPtr.x0 = x; creatorPtr.y0 = y;
});

canvas.addEventListener('pointerup', e => {
  if (!creatorActive || !creatorPtr) return;
  const wasEnv = creatorPtr.mode === 'marker' || creatorPtr.mode === 'envbound';
  creatorPtr = null;
  if (wasEnv) renderEnvelopeEditor();
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
  // Prominent readout of the exact preview pitch + frequency the test plays, plus
// the note's spectral center at the start and end of the note — so a rising
// "pitch" from the mix morphing is visibly explained.
  ctx.font = '700 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Test: ' + previewPitchName() + ' · ' + previewPitchFreq().toFixed(1) + ' Hz', 84, 38);
  const cs = PREVIEW_STABLE_MIX ? centroidPitchName(0.5) : centroidPitchName(0);
  const ce = PREVIEW_STABLE_MIX ? centroidPitchName(0.5) : centroidPitchName(1);
  ctx.fillText('spectral center: ' + cs + (PREVIEW_STABLE_MIX ? ' (stable)' : ' → ' + ce), 84, 58);
  const tabs = creatorTabs();
  let tx = W - 14;
  for (let i = tabs.length - 1; i >= 0; i--) {
    const w = 74, x = tx - w;
    tx = x;
    const active = tabs[i].submode === creatorSubmode;
    ctx.globalAlpha = tabs[i].enabled ? 1 : 0.45;
    drawRoundRect(x, 12, w, 40, 12);
    ctx.fillStyle = active ? '#fff' : 'rgba(255,255,255,0.18)';
    ctx.fill();
    ctx.fillStyle = active ? '#2e5d34' : '#fff';
    ctx.font = '700 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(tabs[i].label, x + w / 2, 38);
    ctx.globalAlpha = 1;
  }

  // ---- Legend (layer colors + reset) ----
  if (creatorSubmode === 'mix' || creatorSubmode === 'harm') {
    for (let i = 0; i < OSC_STACK.layers.length; i++) {
      const cx = p.left + i * 76;
      const sel = i === selectedLayerIdx;
      ctx.fillStyle = OSC_COLORS[i % OSC_COLORS.length];
      ctx.beginPath();
      ctx.arc(cx + 7, 78, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = (sel ? '800 ' : '700 ') + '11px sans-serif';
      ctx.fillStyle = sel ? '#1b4523' : '#6b8e5a';
      ctx.textAlign = 'left';
      ctx.fillText('Osc ' + (i + 1), cx + 18, 82);
    }
  } else {
    ctx.font = '800 11px sans-serif';
    ctx.fillStyle = '#1b4523';
    ctx.textAlign = 'left';
    ctx.fillText('Envelope — note value over time', p.left, 82);
  }
  // Stable-test toggle
  drawRoundRect(W - 292, 68, 92, 22, 8);
  ctx.fillStyle = PREVIEW_STABLE_MIX ? '#2e5d34' : '#fff';
  ctx.fill();
  ctx.fillStyle = PREVIEW_STABLE_MIX ? '#fff' : '#2e5d34';
  ctx.font = '700 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(PREVIEW_STABLE_MIX ? '◉ Stable test' : '◯ Morph test', W - 246, 83);
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
  ctx.fillText(creatorSubmode === 'env' ? '↺ Reset env' : creatorSubmode === 'harm' ? '↺ Reset spec' : '↺ Reset curve', W - 59, 83);

  // ---- Marker grab tabs (Mix & Envelope only) ----
  if (creatorSubmode !== 'harm') {
    for (const tab of markerTabs(p)) {
      drawRoundRect(tab.x, tab.y, tab.w, tab.h, 6);
      ctx.fillStyle = tab.color;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '800 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(tab.label, tab.cx, tab.y + 11);
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
    ctx.fillText(creatorSubmode === 'env' ? 'value 100%' : 'mix 100%', p.left + 2, p.top + 10);
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

  // ---- Envelope (env sub-mode) ----
  if (creatorSubmode === 'env') {
    const eb = envBoundaries();
    // Release-region tint (from the hold end).
    const relX = tToX(eb.tOf(eb.b[ENVELOPE.holdEndIndex + 1]), p);
    ctx.fillStyle = 'rgba(217,83,79,0.07)';
    ctx.fillRect(relX, p.top, p.right - relX, p.ph);
    ctx.strokeStyle = '#2e5d34';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(tToX(eb.tOf(eb.b[0]), p), vToY(eb.vals[0], p));
    for (let i = 1; i <= eb.n; i++) ctx.lineTo(tToX(eb.tOf(eb.b[i]), p), vToY(eb.vals[i], p));
    ctx.stroke();
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

  // ---- Layer curves (mix sub-mode) ----
  if (creatorSubmode === 'mix') {
    for (let i = 0; i < OSC_STACK.layers.length; i++) {
      const l = OSC_STACK.layers[i];
      const sel = i === selectedLayerIdx;
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

  // ---- Hint ----
  ctx.fillStyle = '#6b8e5a';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(creatorSubmode === 'env'
    ? 'Drag a dot to reshape · tap a line to split · double-tap a dot to delete · drag HOLD/CUT/REL markers'
    : creatorSubmode === 'harm'
      ? 'Draw the spectrum of the selected oscillator · tap to add · drag to move · double-tap a dot to delete'
      : 'Tap to add a point · drag to move · double-tap a dot to delete · tap a line to switch layers', W / 2, H - 8);
}

function creatorLoop(now) {
  if (creatorActive) {
    try { drawCreator(now); } catch (err) { console.error(err); }
  }
  requestAnimationFrame(creatorLoop);
}
requestAnimationFrame(creatorLoop);