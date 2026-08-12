/* ============================================================
   ui.js — top-left HUD, settings panel, persistence
   ============================================================ */

/* ---- Top-left HUD ---- */
// Which envelope phase (0=A, 1=D, 2=S, 3=R) `elapsed` ms sits in, for a tap
// note whose per-slot durations live in n.slots[].
function tapPhase(n, elapsed) {
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    if (n.slots[i] == null) continue;
    acc += n.slots[i];
    if (elapsed < acc) return i;
  }
  return 3;
}

// A tap note card: the A D S R phases in a line, with a progress bar that
// moves through them as the note plays.
function tapNoteCardHtml(n, elapsed) {
  const pct = n.totalMs > 0 ? (Math.min(elapsed, n.totalMs) / n.totalMs * 100).toFixed(1) : 100;
  const phase = tapPhase(n, elapsed);
  const letters = ['A', 'D', 'S', 'R']
    .map((l, i) => `<span class="adsr-letter${phase === i ? ' active' : ''}">${l}</span>`)
    .join('');
  return `<div class="hud-fixed"><div class="adsr">${letters}</div><div class="hud-bar"><div class="hud-fill" style="width:${pct}%"></div></div></div>`;
}

function gestureNoteCardHtml(now, p) {
  const elapsed = Math.min(now - p.startedAt, p.totalMs || 0);
  const total = Math.round(p.totalMs || 0);
  const st = pathStateAtTime(p.pts, p.cumTime, elapsed);
  // Live notes share the audio's fade progress (which also advances while the
  // finger is held); wait-mode notes use their playback timeline position.
  const prog = (p.ds && p.ds.gain) ? liveFadeProgress(p.ds) : elapsed;
  // A held live note's path time freezes but the note keeps playing, so show
  // real elapsed time while held; once released, stop at the full duration.
  const timeMs = p.released ? Math.min(prog, p.totalMs || 0) : prog;
  const pct = total > 0 ? (Math.min(elapsed, total) / total * 100).toFixed(1) : 100;
  // The readout shows base volume (a number, 100 = highest, from the path's Y),
  // relative volume (the % of base volume in use from attack/decay/release),
  // and the resulting current volume level (base × relative).
  const tailEnd = p.tailEnd != null ? p.tailEnd : (p.pts ? p.pts.length : 0);
  const relVol = st.idx < tailEnd
    ? attackRelVol(prog, p.atkMs || 0) * decayRelVol(prog, p.atkMs || 0, p.decMs || 0)
    : releaseRelVol(prog - (p.cumTime[tailEnd - 1] || 0), p.relMs || 0);
  const baseVol = baseVolumeFromY(st.y);
  const baseNum = Math.round(baseVol / BASE_VOL_MAX * 100);
  const relPct = Math.round(relVol * 100);
  const curNum = Math.round(baseVol * relVol / BASE_VOL_MAX * 100);
  return `<div class="live"><div class="note-stats">${EMOJI_TIME}${Math.round(timeMs)}ms</div><div class="vol-stats">${EMOJI_VOL} base: ${baseNum} · relative: ${relPct}% · true: ${curNum}</div><div class="hud-bar"><div class="hud-fill" style="width:${pct}%"></div></div></div>`;
}

// Refresh the top-left display each frame: one card per running tap note plus
// one per active gesture playback, stacked. Cards leave when their note is
// done.
function refreshHud(now) {
  const blocks = [];
  for (let i = tapNotes.length - 1; i >= 0; i--) {
    const n = tapNotes[i];
    const elapsed = now - n.noteStart;
    if (elapsed >= n.totalMs) { tapNotes.splice(i, 1); continue; }
    blocks.push(tapNoteCardHtml(n, elapsed));
  }
  for (const p of playbacks) blocks.push(gestureNoteCardHtml(now, p));
  if (blocks.length) {
    statHud.innerHTML = blocks.join('');
    statHud.style.opacity = '1';
  } else {
    statHud.style.opacity = '0';
  }
}

// Hide the HUD (used by Clear).
function clearHud() {
  statHud.style.opacity = '0';
}

/* ---- Live / wait button ---- */
const waitBtn = document.getElementById('waitBtn');
function syncWaitBtn() {
  waitBtn.textContent = GESTURE.waitForGesture ? '⏳ Wait for gesture' : '🎵 Live sound';
  waitBtn.classList.toggle('on', GESTURE.waitForGesture);
}
waitBtn.addEventListener('click', () => {
  GESTURE.waitForGesture = !GESTURE.waitForGesture;
  syncWaitBtn();
  saveSettings();
});

/* ---------- Persistence ---------- */
const STORAGE_KEY = 'growingTrees.settings.v6';

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ chime: CHIME_SETTINGS, gesture: GESTURE, fixed: FIXED }));
    return true;
  } catch (e) { return false; }
}

// Merge saved settings over the defaults (in case older saves lack keys).
function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    const chime = clone(DEFAULT_CHIME);
    if (d.chime) for (const k of Object.keys(chime)) chime[k] = Object.assign({}, chime[k], d.chime[k]);
    CHIME_SETTINGS = chime;
    const g = clone(DEFAULT_GESTURE);
    if (d.gesture) {
      if (d.gesture.waitForGesture != null) g.waitForGesture = !!d.gesture.waitForGesture;
      if (d.gesture.timeMult != null) g.timeMult = Math.max(0.1, Math.min(4, d.gesture.timeMult));
      if (d.gesture.allowTapNotes != null) g.allowTapNotes = !!d.gesture.allowTapNotes;
      if (d.gesture.gestureAttack != null) g.gestureAttack = !!d.gesture.gestureAttack;
      if (d.gesture.gestureDecay != null) g.gestureDecay = !!d.gesture.gestureDecay;
      if (d.gesture.gestureRelease != null) g.gestureRelease = !!d.gesture.gestureRelease;
    }
    GESTURE = g;
    const fx = clone(DEFAULT_FIXED);
    if (d.fixed) {
      for (const name of SLOT_NAMES) {
        if (d.fixed[name]) fx[name] = Object.assign({}, fx[name], d.fixed[name]);
      }
    }
    // Every component is a tap default now: no "skip via gesture line" mode.
    for (const name of SLOT_NAMES) fx[name].on = true;
    fx.attack.vol = 100;   // the attack always ramps to full gain
    FIXED = fx;
    return true;
  } catch (e) { return false; }
}

function resetToDefaults() {
  CHIME_SETTINGS = clone(DEFAULT_CHIME);
  GESTURE = clone(DEFAULT_GESTURE);
  FIXED = clone(DEFAULT_FIXED);
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  loadLevelUI(currentLevel);
  /* loadGestureUI(); syncMinMaxUI(); syncSensUI(); syncPauseUI(); */
  syncFixedUI();
  syncWaitBtn();
}

/* ---------- Chime settings panel ---------- */
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const noteSel = document.getElementById('note');
let currentLevel = 'start';

// Defaults for the six qualities, used whenever a quality isn't assigned to a
// vector or its vector isn't drawn in a gesture. volume's slider is ×100.
const SETTINGS_META = {
  volume:  { min: 0, max: 25, step: 1,   scale: 0.01, unit: '' },
  attack:  { min: 0, max: 200,   step: 5,   scale: 1, unit: 'ms' },
  decay:   { min: 0, max: 1000,  step: 10,  scale: 1, unit: 'ms' },
  sustain: { min: 0, max: 100,   step: 1,   scale: 1, unit: '%' },
  hold:    { min: 0, max: 10000, step: 100, scale: 1, unit: 'ms' },
  release: { min: 0, max: 2000,  step: 10,  scale: 1, unit: 'ms' },
};
const ENV_FIELDS = Object.keys(SETTINGS_META);

for (const n of NOTE_NAMES) noteSel.add(new Option(n, n));

function fmt(f, v) { return f === 'volume' ? v.toFixed(2) : v + SETTINGS_META[f].unit; }

function loadLevelUI(level) {
  const s = CHIME_SETTINGS[level];
  noteSel.value = s.note.slice(0, -1);
  /* COMMENTED OUT - wave/blend/ADSR defaults are gesture-driven now.
  waveSel.value = s.wave;
  document.getElementById('blend').value = Math.round((s.blend || 0) * 100);
  document.getElementById('blendVal').textContent = Math.round((s.blend || 0) * 100) + '%';
  const blendToSel = document.getElementById('blendTo');
  const b2 = s.blendTo || WAVE_ORDER[(WAVE_ORDER.indexOf(s.wave) + 1) % WAVE_ORDER.length];
  blendToSel.value = b2;
  for (const f of ENV_FIELDS) {
    const meta = SETTINGS_META[f];
    const el = document.getElementById(f);
    el.min = meta.min; el.max = meta.max; el.step = meta.step;
    el.value = s[f] / meta.scale;
    document.getElementById(f + 'Val').textContent = fmt(f, s[f]);
  }
  */
}

function previewChime() {
  initAudio();
  resumeAudio();
  chime(currentLevel);
}

noteSel.addEventListener('change', () => {
  CHIME_SETTINGS[currentLevel].note = noteSel.value + NOTE_OCTAVE;
  previewChime();
});
/* COMMENTED OUT - wave/blend/ADSR defaults are gesture-driven now.
waveSel.addEventListener('change', () => {
  CHIME_SETTINGS[currentLevel].wave = waveSel.value;
  // Keep the blend target sensible: if it's unset or now equals the base wave,
  // point it at the next shape in the cycle.
  const s = CHIME_SETTINGS[currentLevel];
  if (!s.blendTo || s.blendTo === waveSel.value) {
    s.blendTo = WAVE_ORDER[(WAVE_ORDER.indexOf(waveSel.value) + 1) % WAVE_ORDER.length];
  }
  document.getElementById('blendTo').value = s.blendTo;
  previewChime();
});
const blendEl = document.getElementById('blend');
blendEl.addEventListener('input', () => {
  CHIME_SETTINGS[currentLevel].blend = +blendEl.value / 100;
  document.getElementById('blendVal').textContent = blendEl.value + '%';
});
blendEl.addEventListener('change', () => previewChime());
const blendToSel = document.getElementById('blendTo');
blendToSel.addEventListener('change', () => {
  CHIME_SETTINGS[currentLevel].blendTo = blendToSel.value;
  previewChime();
});
*/
/* COMMENTED OUT - ADSR defaults are gesture-driven now.
for (const f of ENV_FIELDS) {
  const el = document.getElementById(f);
  el.addEventListener('input', () => {
    const raw = +el.value * SETTINGS_META[f].scale;
    const v = f === 'volume' ? Math.round(raw * 1000) / 1000 : Math.round(raw);
    CHIME_SETTINGS[currentLevel][f] = v;
    document.getElementById(f + 'Val').textContent = fmt(f, v);
  });
  el.addEventListener('change', () => previewChime());
}
*/

/* COMMENTED OUT - each vector now auto-maps to a sound quality.
   ---- Gesture mapping UI ----
const QUALITY_LABELS = { volume: 'Volume', attack: 'Attack', decay: 'Decay', sustain: 'Sustain', hold: 'Hold', release: 'Release' };
const vecSels = {};

// Vectors must be assigned in order: no vector N can have a quality if an
// earlier vector has none. Gaps (empty vectors) are only allowed at the tail.
function vectorActive(assign, v) {
  return assign['v' + v + 'x'] != null || assign['v' + v + 'y'] != null;
}
function orderedAssignmentsValid(assign) {
  let gap = false;
  for (let i = 1; i <= GESTURE.maxVectors; i++) {
    if (!vectorActive(assign, i)) gap = true;
    else if (gap) return false;
  }
  return true;
}
function flashSlot(slot) {
  const el = document.getElementById(slot);
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 600);
}

for (const slot of ASSIGN_SLOTS) {
  const el = document.getElementById(slot);
  el.add(new Option('(none)', ''));
  for (const q of QUALITIES) el.add(new Option(QUALITY_LABELS[q], q));
  el.addEventListener('change', () => {
    const next = el.value || null;
    const prev = GESTURE.assign[slot];
    if (next === prev) return;
    const pending = Object.assign({}, GESTURE.assign);
    pending[slot] = next;
    if (next) {
      // Keep each quality assigned to only one axis: swap with the slot that
      // currently owns `next` instead of creating a duplicate.
      const other = ASSIGN_SLOTS.find(s => s !== slot && pending[s] === next);
      if (other) pending[other] = prev;
    }
    if (!orderedAssignmentsValid(pending)) {
      loadGestureUI();
      flashSlot(slot);
      return;
    }
    GESTURE.assign = pending;
    loadGestureUI();
  });
  vecSels[slot] = el;
}
*/

/* COMMENTED OUT - sensitivity settings are removed; values are hardcoded.
function sensLabel(q, raw) {
  return (raw / SENS_UI[q].div) + GESTURE.unit[q] + '/100px';
}

for (const q of QUALITIES) {
  const el = document.getElementById('sens-' + q);
  const meta = SENS_UI[q];
  el.min = meta.min; el.max = meta.max; el.step = meta.step;
  el.addEventListener('input', () => {
    GESTURE.sens[q] = +el.value;
    document.getElementById('sens-' + q + 'Val').textContent = sensLabel(q, GESTURE.sens[q]);
  });
}
function syncSensUI() {
  for (const q of QUALITIES) {
    const el = document.getElementById('sens-' + q);
    el.value = GESTURE.sens[q];
    document.getElementById('sens-' + q + 'Val').textContent = sensLabel(q, GESTURE.sens[q]);
  }
}
syncSensUI();
*/

/* ---- Gesture value mapping is pure screen proportions (see lineTimeForSlot) ---- */

/* ---- Time multiplier (ms per % of horizontal travel) ---- */
const timeMultEl = document.getElementById('timeMult');
// The note length a full-screen-width horizontal gesture delivers, shown live.
function syncLineMax() {
  document.getElementById('lineMaxTime').textContent = Math.round(100 * TIME_PER_W * GESTURE.timeMult);
}
function syncLineUI() {
  timeMultEl.value = GESTURE.timeMult;
  document.getElementById('timeMultVal').textContent = GESTURE.timeMult.toFixed(1) + 'x';
  syncLineMax();
}
timeMultEl.addEventListener('input', () => {
  GESTURE.timeMult = +timeMultEl.value;
  document.getElementById('timeMultVal').textContent = GESTURE.timeMult.toFixed(1) + 'x';
  syncLineMax();
});

/* ---- Tap note defaults ---- */
for (const name of SLOT_NAMES) {
  const tEl = document.getElementById('fx-' + name + 'T');
  const volEl = name === 'attack' ? null : document.getElementById('fx-' + name + 'Vol');
  tEl.addEventListener('input', () => {
    FIXED[name].value = +tEl.value;
    document.getElementById('fx-' + name + 'TVal').textContent = tEl.value + 'ms';
  });
  if (volEl) volEl.addEventListener('input', () => {
    FIXED[name].vol = +volEl.value;
    document.getElementById('fx-' + name + 'VolVal').textContent = volEl.value + '%';
  });
}
const attackGestureEl = document.getElementById('fx-attackGesture');
attackGestureEl.addEventListener('change', () => {
  GESTURE.gestureAttack = attackGestureEl.checked;
  saveSettings();
});
const releaseGestureEl = document.getElementById('fx-releaseGesture');
releaseGestureEl.addEventListener('change', () => {
  GESTURE.gestureRelease = releaseGestureEl.checked;
  saveSettings();
});
const decayGestureEl = document.getElementById('fx-decayGesture');
decayGestureEl.addEventListener('change', () => {
  GESTURE.gestureDecay = decayGestureEl.checked;
  saveSettings();
});
const allowTapNotesEl = document.getElementById('allowTapNotes');
allowTapNotesEl.addEventListener('change', () => {
  GESTURE.allowTapNotes = allowTapNotesEl.checked;
  saveSettings();
});
function syncFixedUI() {
  for (const name of SLOT_NAMES) {
    FIXED[name].on = true;   // every component is always a tap default
    const tEl = document.getElementById('fx-' + name + 'T');
    tEl.value = FIXED[name].value = Math.max(1, Math.min(5000, FIXED[name].value));
    document.getElementById('fx-' + name + 'TVal').textContent = FIXED[name].value + 'ms';
    if (name !== 'attack') {
      const volEl = document.getElementById('fx-' + name + 'Vol');
      volEl.value = FIXED[name].vol;
      document.getElementById('fx-' + name + 'VolVal').textContent = FIXED[name].vol + '%';
    }
  }
  attackGestureEl.checked = !!GESTURE.gestureAttack;
  decayGestureEl.checked = !!GESTURE.gestureDecay;
  releaseGestureEl.checked = !!GESTURE.gestureRelease;
  allowTapNotesEl.checked = !!GESTURE.allowTapNotes;
}

/* COMMENTED OUT - new lines are started by a direction change only.
const pauseEl = document.getElementById('pause');
pauseEl.addEventListener('input', () => {
  GESTURE.pause = +pauseEl.value;
  document.getElementById('pauseVal').textContent = GESTURE.pause + 'ms';
});
function syncPauseUI() {
  pauseEl.value = GESTURE.pause;
  document.getElementById('pauseVal').textContent = GESTURE.pause + 'ms';
}
syncPauseUI();
*/

/* COMMENTED OUT - gesture values are clamped to sensible built-in ranges.
   ---- Min / Max per quality ----
function mmLabel(q, v) { return q === 'volume' ? v.toFixed(2) : v + GESTURE.unit[q]; }

for (const q of QUALITIES) {
  const b = QUALITY_BOUNDS[q];
  const minEl = document.getElementById('min-' + q);
  const maxEl = document.getElementById('max-' + q);
  const minValEl = document.getElementById('min-' + q + 'Val');
  const maxValEl = document.getElementById('max-' + q + 'Val');
  minEl.min = b.min; minEl.max = b.max; minEl.step = b.step;
  maxEl.min = b.min; maxEl.max = b.max; maxEl.step = b.step;
  minEl.addEventListener('input', () => {
    let v = Math.min(+minEl.value * b.scale, GESTURE.max[q]);   // min can't exceed max
    GESTURE.min[q] = q === 'volume' ? Math.round(v * 1000) / 1000 : Math.round(v);
    minEl.value = GESTURE.min[q] / b.scale;
    minValEl.textContent = mmLabel(q, GESTURE.min[q]);
  });
  maxEl.addEventListener('input', () => {
    let v = Math.max(+maxEl.value * b.scale, GESTURE.min[q]);   // max can't drop below min
    GESTURE.max[q] = q === 'volume' ? Math.round(v * 1000) / 1000 : Math.round(v);
    maxEl.value = GESTURE.max[q] / b.scale;
    maxValEl.textContent = mmLabel(q, GESTURE.max[q]);
  });
}
function syncMinMaxUI() {
  for (const q of QUALITIES) {
    const b = QUALITY_BOUNDS[q];
    const minEl = document.getElementById('min-' + q);
    const maxEl = document.getElementById('max-' + q);
    minEl.value = GESTURE.min[q] / b.scale;
    maxEl.value = GESTURE.max[q] / b.scale;
    document.getElementById('min-' + q + 'Val').textContent = mmLabel(q, GESTURE.min[q]);
    document.getElementById('max-' + q + 'Val').textContent = mmLabel(q, GESTURE.max[q]);
  }
}
syncMinMaxUI();

/* COMMENTED OUT - the gesture now determines the mapping automatically.
function loadGestureUI() {
  for (const slot of ASSIGN_SLOTS) vecSels[slot].value = GESTURE.assign[slot] || '';
}
loadGestureUI();
*/

function closeSettingsPanel() {
  settingsPanel.classList.add('hidden');
  saveSettings();
  // Re-sync the canvas to the real window size: iOS can leave it sized to a
  // stale value after the full-screen panel is dismissed, which squishes the
  // scene's background. Resetting canvas.width also forces a clean repaint.
  resize();
  clampCamY();
}
settingsBtn.addEventListener('click', () => {
  initAudio();
  resumeAudio();
  if (settingsPanel.classList.contains('hidden')) {
    settingsPanel.classList.remove('hidden');
    loadLevelUI(currentLevel);
    /* loadGestureUI(); */
    syncLineUI();
    syncFixedUI();
  } else {
    closeSettingsPanel();
  }
});
document.getElementById('closeSettings').addEventListener('click', closeSettingsPanel);
document.getElementById('testSound').addEventListener('click', previewChime);

document.getElementById('resetDefaults').addEventListener('click', () => {
  resetToDefaults();
  const b = document.getElementById('resetDefaults');
  b.textContent = '✓ Defaults restored';
  setTimeout(() => { b.textContent = '↺ Reset defaults'; }, 1200);
});

document.getElementById('clear').addEventListener('click', () => {
  stopGestureNote();
  clearHud();
});
