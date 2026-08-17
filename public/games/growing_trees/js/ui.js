/* ============================================================
   ui.js — top-left HUD, settings panel, persistence
   ============================================================ */

/* ---- Top-left HUD ---- */
// A gesture playback card: the note's total time, its base/relative/current
// volume, and a progress bar that moves through the note.
function gestureNoteCardHtml(now, p) {
  const elapsed = Math.min(now - p.startedAt, p.totalMs || 0);
  const total = Math.round(p.totalMs || 0);
  const st = pathStateAtTime(p.pts, p.cumTime, elapsed);
  // Live notes share the audio's playhead (which also advances while the
  // finger is held); wait-mode notes use their playback timeline position.
  const prog = (p.ds && p.ds.gain) ? liveFadeProgress(p.ds) : elapsed;
  // A held live note's path time freezes but the note keeps playing, so show
  // real elapsed time while held; once released, stop at the full duration.
  const timeMs = p.released ? Math.min(prog, p.totalMs || 0) : prog;
  const pct = total > 0 ? (Math.min(elapsed, total) / total * 100).toFixed(1) : 100;
  // The readout shows base volume (a number, 100 = full scale, from the path's
  // Y per the upper/lower gain settings — a line at the top with upper gain 50
  // reads 50), relative volume (the % of base volume in use from the envelope),
  // and the resulting current volume level (base × relative, same 0-100 gain
  // scale).
  const tailEnd = p.tailEnd != null ? p.tailEnd : (p.pts ? p.pts.length : 0);
  const pathMs = tailEnd > 0 ? (p.cumTime[tailEnd - 1] || 0) : 0;
  const relVol = st.idx < tailEnd
    ? relValueBody(ENVELOPE, prog, !!p.looped)
    : relValueRelease(ENVELOPE, prog - pathMs, relValueBody(ENVELOPE, pathMs, !!p.looped));
  const baseVol = baseVolumeFromY(st.y);
  const baseNum = Math.round(baseVol * 100);
  const relPct = Math.round(relVol * 100);
  const curNum = Math.round(baseVol * relVol * 100);
  return `<div class="live"><div class="note-stats">${EMOJI_TIME}${Math.round(timeMs)}ms</div><div class="vol-stats">${EMOJI_VOL} base: ${baseNum} · relative: ${relPct}% · true: ${curNum}</div><div class="hud-bar"><div class="hud-fill" style="width:${pct}%"></div></div></div>`;
}

// Refresh the top-left display each frame: one card per active gesture
// playback, stacked. Cards leave when their note is done.
function refreshHud(now) {
  const blocks = [];
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
const STORAGE_KEY = 'growingTrees.settings.v9';
// Older versions saved under these keys. v8 stores the same envelope/pitchZones
// layout (only `volume` was added in v8, which loads with defaults when absent);
// v7 and v6 are further back. When the current key is missing, fall back through
// them so a storage-key bump never discards saved settings.
const LEGACY_STORAGE_KEYS = ['growingTrees.settings.v8', 'growingTrees.settings.v7', 'growingTrees.settings.v6'];

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ chime: CHIME_SETTINGS, gesture: GESTURE, envelope: ENVELOPE, pitchZones: PITCH_ZONES, volume: VOLUME, harmonics: HARMONICS }));
    return true;
  } catch (e) {
    noteStorageError();
    return false;
  }
}

// Persist the instant anything changes: the payload is tiny, so writing on every
// 'input' (even mid-slider-drag) is cheap, and there is never a debounce window
// in which an edit exists only in memory and could be lost on a fast reload.
let settingsSaveTimer = null;
function scheduleSettingsSave() {
  clearTimeout(settingsSaveTimer);
  saveSettings();
}
function flushSettingsSave() {
  clearTimeout(settingsSaveTimer);
  saveSettings();
}

// localStorage can be unavailable (private mode, blocked storage, sandboxed
// preview iframes). Persistence is best-effort: if it throws, say so on screen
// instead of silently letting settings revert on reload.
let storageWarned = false;
function noteStorageError() {
  if (storageWarned) return;
  storageWarned = true;
  console.warn('[Growing Trees] Settings could not be saved: localStorage is unavailable (private browsing, blocked storage, or a sandboxed preview frame). Changes will revert on reload.');
  const panel = document.getElementById('settingsPanel');
  const head = panel && panel.querySelector('.panel-head');
  if (!head || head.querySelector('#storageWarn')) return;
  const el = document.createElement('span');
  el.id = 'storageWarn';
  el.textContent = '⚠ not saving';
  el.style.cssText = 'margin-left:auto;font-size:10px;font-weight:700;color:#d9534f;background:#fdecea;border:1px solid #d9534f;border-radius:8px;padding:2px 7px;';
  head.appendChild(el);
}
// Close the tab mid-edit: flush anything pending so the last value sticks.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSettingsSave();
});
// Some browsers (especially mobile) never fire visibilitychange on reload or
// swipe-to-close, so also flush on pagehide.
window.addEventListener('pagehide', flushSettingsSave);

// Merge saved settings over the defaults (in case older saves lack keys).
function loadSavedSettings() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    let migrated = false;
    if (!raw) {
      for (const k of LEGACY_STORAGE_KEYS) {
        raw = localStorage.getItem(k);
        if (raw) { migrated = true; break; }
      }
    }
    if (!raw) return false;
    const d = JSON.parse(raw);
    const chime = clone(DEFAULT_CHIME);
    if (d.chime) for (const k of Object.keys(chime)) chime[k] = Object.assign({}, chime[k], d.chime[k]);
    CHIME_SETTINGS = chime;
    const g = clone(DEFAULT_GESTURE);
    if (d.gesture) {
      if (d.gesture.waitForGesture != null) g.waitForGesture = !!d.gesture.waitForGesture;
      if (d.gesture.timeMult != null) g.timeMult = Math.max(0.1, Math.min(4, d.gesture.timeMult));
    }
    GESTURE = g;
    const env = clone(DEFAULT_ENVELOPE);
    if (d.envelope && Array.isArray(d.envelope.components) && d.envelope.components.length) {
      env.components = d.envelope.components.map((c, i) => ({
        id: c.id || newCompId(),
        name: String(c.name || ('Component ' + (i + 1))).slice(0, 24),
        duration: Math.max(1, Math.min(5000, +c.duration || 250)),
        startValue: Math.max(0, Math.min(100, +c.startValue || 0)),
        endValue: Math.max(0, Math.min(100, +c.endValue || 100)),
      }));
      if (d.envelope.beginReleaseIndex != null) env.beginReleaseIndex = +d.envelope.beginReleaseIndex;
      if (d.envelope.holdStartIndex != null) env.holdStartIndex = +d.envelope.holdStartIndex;
      if (d.envelope.holdEndIndex != null) env.holdEndIndex = +d.envelope.holdEndIndex;
      if (d.envelope.earlyCutIndex != null) env.earlyCutIndex = +d.envelope.earlyCutIndex;
    } else if (d.fixed) {
      // v6 → v7 migration: map the old fixed ADSR phases onto the envelope.
      const fx = d.fixed;
      const dur = f => Math.max(1, Math.min(5000, (f && f.value) || 250));
      const vol = (f, fb) => Math.max(0, Math.min(100, (f && f.vol != null) ? f.vol : fb));
      env.components = [
        { id: 'comp-1', name: 'Attack',  duration: dur(fx.attack),  startValue: 0,   endValue: 100 },
        { id: 'comp-2', name: 'Decay',   duration: dur(fx.decay),   startValue: 100, endValue: vol(fx.decay, 60) },
        { id: 'comp-3', name: 'Sustain', duration: dur(fx.hold),    startValue: vol(fx.hold, 60), endValue: vol(fx.hold, 60) },
        { id: 'comp-4', name: 'Release', duration: dur(fx.release), startValue: 100, endValue: vol(fx.release, 0) },
      ];
      env.beginReleaseIndex = 3;
      env.holdStartIndex = 2;
      env.holdEndIndex = 2;
    }
    ENVELOPE = env;
    clampEnvelopeIndexes();
    const pz = clone(DEFAULT_PITCH_ZONES);
    if (d.pitchZones) {
      if (d.pitchZones.show != null) pz.show = !!d.pitchZones.show;
      if (d.pitchZones.labelMode === 'note' || d.pitchZones.labelMode === 'degree') pz.labelMode = d.pitchZones.labelMode;
      if (d.pitchZones.lowDegree != null) pz.lowDegree = Math.max(1, Math.min(7, +d.pitchZones.lowDegree));
      if (d.pitchZones.lowOctave != null) pz.lowOctave = Math.max(-2, Math.min(2, +d.pitchZones.lowOctave));
      if (d.pitchZones.highDegree != null) pz.highDegree = Math.max(1, Math.min(7, +d.pitchZones.highDegree));
      if (d.pitchZones.highOctave != null) pz.highOctave = Math.max(-2, Math.min(2, +d.pitchZones.highOctave));
    }
    PITCH_ZONES = pz;
    const vol = clone(DEFAULT_VOLUME);
    if (d.volume) {
      if (d.volume.bottom != null) vol.bottom = Math.max(0, Math.min(1, +d.volume.bottom || 0.01));
      // Older saves used `ratio` (how many × louder the top is) instead of a
      // direct top gain: map it so the stored sound is preserved.
      if (d.volume.top != null) vol.top = Math.max(0, Math.min(1, +d.volume.top || 0.5));
      else if (d.volume.ratio != null) vol.top = Math.max(0, Math.min(1, vol.bottom * (+d.volume.ratio || 50)));
    }
    VOLUME = vol;
    // v9+: harmonics
    const harm = clone(DEFAULT_HARMONICS);
    if (d.harmonics && Array.isArray(d.harmonics.amplitudes) && d.harmonics.amplitudes.length) {
      for (let i = 0; i < HARMONIC_COUNT; i++) {
        harm.amplitudes[i] = Math.max(-1, Math.min(1, +d.harmonics.amplitudes[i] || 0));
      }
    }
    HARMONICS = harm;
    if (migrated) {
      // A legacy save was just loaded: persist it under the current key now so
      // later edits land in the right place (and the legacy copy can age out).
      saveSettings();
    }
    return true;
  } catch (e) {
    noteStorageError();
    return false;
  }
}

function resetToDefaults() {
  CHIME_SETTINGS = clone(DEFAULT_CHIME);
  GESTURE = clone(DEFAULT_GESTURE);
  ENVELOPE = clone(DEFAULT_ENVELOPE);
  PITCH_ZONES = clone(DEFAULT_PITCH_ZONES);
  VOLUME = clone(DEFAULT_VOLUME);
  HARMONICS = clone(DEFAULT_HARMONICS);
  // Clear legacy copies too, or the next load would migrate them straight back.
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  for (const k of LEGACY_STORAGE_KEYS) { try { localStorage.removeItem(k); } catch (e) {} }
  loadLevelUI(currentLevel);
  /* loadGestureUI(); syncMinMaxUI(); syncSensUI(); syncPauseUI(); */
  syncEnvelopeUI();
  syncPitchZonesUI();
  syncVolumeUI();
  syncHarmonicsUI();
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

// Preview the current envelope as a very short gesture (a tap) so the test
// button and key changes play the same path the fingers play.
function previewChime() {
  initAudio();
  resumeAudio();
  const x = W / 2, y = H * 0.55;
  const ds = { pts: [{ x, y }, { x, y }], cumTime: [0, 0], totalMs: 0, startX: x, startY: y };
  schedulePathPlayback(ds);
}

noteSel.addEventListener('change', () => {
  CHIME_SETTINGS[currentLevel].note = noteSel.value + NOTE_OCTAVE;
  previewChime();
});

/* ---- Pitch color zones ---- */
const DEGREE_COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'light blue', 'dark blue', 'pink'];
const zonesShowEl = document.getElementById('zonesShow');
const zonesLabelsEl = document.getElementById('zonesLabels');
const zonesLowOctEl = document.getElementById('zonesLowOct');
const zonesLowDegEl = document.getElementById('zonesLowDeg');
const zonesHighOctEl = document.getElementById('zonesHighOct');
const zonesHighDegEl = document.getElementById('zonesHighDeg');

for (let o = -2; o <= 2; o++) {
  const label = o === 0 ? '0 (key)' : String(o);
  zonesLowOctEl.add(new Option(label, o));
  zonesHighOctEl.add(new Option(label, o));
}
for (let d = 1; d <= 7; d++) {
  const label = d + ' · ' + DEGREE_COLOR_NAMES[d - 1];
  zonesLowDegEl.add(new Option(label, d));
  zonesHighDegEl.add(new Option(label, d));
}

function updateZonesRange() {
  document.getElementById('zonesLowOctVal').textContent = zonesLowOctEl.value;
  document.getElementById('zonesHighOctVal').textContent = zonesHighOctEl.value;
}

function syncPitchZonesUI() {
  zonesShowEl.checked = !!PITCH_ZONES.show;
  zonesLabelsEl.value = PITCH_ZONES.labelMode;
  zonesLowOctEl.value = PITCH_ZONES.lowOctave;
  zonesLowDegEl.value = PITCH_ZONES.lowDegree;
  zonesHighOctEl.value = PITCH_ZONES.highOctave;
  zonesHighDegEl.value = PITCH_ZONES.highDegree;
  updateZonesRange();
}

zonesShowEl.addEventListener('change', () => {
  PITCH_ZONES.show = zonesShowEl.checked;
  saveSettings();
});
zonesLabelsEl.addEventListener('change', () => {
  PITCH_ZONES.labelMode = zonesLabelsEl.value;
  saveSettings();
});
for (const el of [zonesLowOctEl, zonesLowDegEl, zonesHighOctEl, zonesHighDegEl]) {
  el.addEventListener('change', () => {
    PITCH_ZONES.lowOctave = +zonesLowOctEl.value;
    PITCH_ZONES.lowDegree = +zonesLowDegEl.value;
    PITCH_ZONES.highOctave = +zonesHighOctEl.value;
    PITCH_ZONES.highDegree = +zonesHighDegEl.value;
    updateZonesRange();
    saveSettings();
  });
}
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

/* ---- Harmonic editor ---- */
const harmonicSlidersEl = document.getElementById('harmonicSliders');
const harmonicPresetsEl = document.getElementById('harmonicPresets');
let activePreset = 'sine';

function renderHarmonicSliders() {
  let html = '';
  for (let i = 0; i < HARMONIC_COUNT; i++) {
    const amp = HARMONICS.amplitudes[i];
    const pct = Math.round(Math.abs(amp) * 100);
    const sign = amp < 0 ? '-' : '';
    html += '<div class="harm-row"><span class="harm-label">H' + (i + 1) + '</span>'
      + '<input type="range" class="harm-slider" data-idx="' + i + '" min="-100" max="100" step="1" value="' + Math.round(amp * 100) + '">'
      + '<span class="harm-val">' + sign + pct + '%</span></div>';
  }
  harmonicSlidersEl.innerHTML = html;
}

function syncHarmonicsUI() {
  renderHarmonicSliders();
  activePreset = matchPreset();
  for (const btn of harmonicPresetsEl.querySelectorAll('.harm-preset')) {
    btn.classList.toggle('active', btn.dataset.preset === activePreset);
  }
}

function matchPreset() {
  for (const name of Object.keys(HARMONIC_PRESETS)) {
    const preset = HARMONIC_PRESETS[name];
    let match = true;
    for (let i = 0; i < HARMONIC_COUNT; i++) {
      if (Math.abs(HARMONICS.amplitudes[i] - preset[i]) > 0.005) { match = false; break; }
    }
    if (match) return name;
  }
  return null;
}

harmonicSlidersEl.addEventListener('input', e => {
  if (!e.target.classList.contains('harm-slider')) return;
  const i = +e.target.dataset.idx;
  HARMONICS.amplitudes[i] = Math.max(-1, Math.min(1, +e.target.value / 100));
  const vEl = e.target.closest('.harm-row').querySelector('.harm-val');
  if (vEl) {
    const v = HARMONICS.amplitudes[i];
    const pct = Math.round(Math.abs(v) * 100);
    vEl.textContent = (v < 0 ? '-' : '') + pct + '%';
  }
  activePreset = matchPreset();
  for (const btn of harmonicPresetsEl.querySelectorAll('.harm-preset')) {
    btn.classList.toggle('active', btn.dataset.preset === activePreset);
  }
  previewChime();
});

harmonicSlidersEl.addEventListener('change', () => {
  saveSettings();
});

harmonicPresetsEl.addEventListener('click', e => {
  const btn = e.target.closest('.harm-preset');
  if (!btn) return;
  const name = btn.dataset.preset;
  const preset = HARMONIC_PRESETS[name];
  if (!preset) return;
  for (let i = 0; i < HARMONIC_COUNT; i++) HARMONICS.amplitudes[i] = preset[i];
  activePreset = name;
  for (const b of harmonicPresetsEl.querySelectorAll('.harm-preset')) {
    b.classList.toggle('active', b === btn);
  }
  renderHarmonicSliders();
  previewChime();
  saveSettings();
});

/* ---- Playhead speed (ms per % of horizontal travel) ---- */
const timeMultEl = document.getElementById('timeMult');
function syncLineUI() {
  timeMultEl.value = GESTURE.timeMult;
  document.getElementById('timeMultVal').textContent = GESTURE.timeMult.toFixed(1) + 'x';
}
timeMultEl.addEventListener('input', () => {
  GESTURE.timeMult = +timeMultEl.value;
  document.getElementById('timeMultVal').textContent = GESTURE.timeMult.toFixed(1) + 'x';
});

/* ---- Volume over Y (bottom & top gain) ---- */
const volBottomEl = document.getElementById('volBottom');
const volTopEl = document.getElementById('volTop');
function syncVolumeUI() {
  volBottomEl.value = Math.round(VOLUME.bottom * 100);
  volTopEl.value = Math.round(VOLUME.top * 100);
  document.getElementById('volBottomVal').textContent = volBottomEl.value;
  document.getElementById('volTopVal').textContent = volTopEl.value;
}
volBottomEl.addEventListener('input', () => {
  VOLUME.bottom = Math.max(0, Math.min(1, +volBottomEl.value / 100));
  document.getElementById('volBottomVal').textContent = volBottomEl.value;
  scheduleSettingsSave();
});
volTopEl.addEventListener('input', () => {
  VOLUME.top = Math.max(0, Math.min(1, +volTopEl.value / 100));
  document.getElementById('volTopVal').textContent = volTopEl.value;
  scheduleSettingsSave();
});

/* ---- Envelope editor ---- */
const envAddBtn = document.getElementById('envAdd');
const envResetBtn = document.getElementById('envReset');
const envListEl = document.getElementById('envList');

let ENV_ID = 0;
function newCompId() { return 'c' + (++ENV_ID) + Math.random().toString(36).slice(2, 6); }

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Keep the envelope's markers sane after any add/delete/reorder: the release
// always starts right after the hold range ends (so no component is ever
// skipped) and the hold range is non-empty and lies before the release. Start
// values chain into the next component, so only the first one keeps an
// independent start.
function clampEnvelopeIndexes() {
  const n = ENVELOPE.components.length;
  if (n <= 1) {
    // A lone component is the whole release: no hold, no body.
    ENVELOPE.holdStartIndex = 0;
    ENVELOPE.holdEndIndex = 0;
    ENVELOPE.beginReleaseIndex = 0;
    ENVELOPE.earlyCutIndex = 0;
    chainStartValues(ENVELOPE);
    return;
  }
  ENVELOPE.holdEndIndex = Math.max(0, Math.min(n - 2, ENVELOPE.holdEndIndex));
  ENVELOPE.holdStartIndex = Math.max(0, Math.min(ENVELOPE.holdEndIndex, ENVELOPE.holdStartIndex));
  ENVELOPE.beginReleaseIndex = ENVELOPE.holdEndIndex + 1;
  ENVELOPE.earlyCutIndex = Math.max(0, Math.min(ENVELOPE.beginReleaseIndex - 1, ENVELOPE.earlyCutIndex));
  chainStartValues(ENVELOPE);
}

// Markers on each card: begin release and the hold range.
function markerRadio(name, cls, checked, disabled, label, title) {
  return `<label class="env-m ${cls}${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}" title="${title}">
    <input type="radio" name="${name}" value="1"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>${label}</label>`;
}

function renderEnvelopeEditor() {
  clampEnvelopeIndexes();
  const n = ENVELOPE.components.length;
  const b = ENVELOPE.beginReleaseIndex;

  let rows = '';
  for (let i = 0; i < n; i++) {
    const c = ENVELOPE.components[i];
    const isRelease = i >= b;
    const inHold = i >= ENVELOPE.holdStartIndex && i <= ENVELOPE.holdEndIndex;
    const markers = [
      markerRadio('envRelease', 'env-m-release', b === i, n > 1 && i === 0, 'Release', 'Release starts here — the card before it becomes the last Hold'),
      markerRadio('envHoldFrom', 'env-m-holdfrom', ENVELOPE.holdStartIndex === i, i >= b, 'Hold from', 'Hold range starts here'),
      markerRadio('envHoldTo', 'env-m-holdto', ENVELOPE.holdEndIndex === i, i >= b, 'Hold to', 'Hold range ends here — release always starts on the next card'),
      markerRadio('envCut', 'env-m-cut', ENVELOPE.earlyCutIndex === i, i >= b, 'Cut', 'Early lift: the sound plays through this card, then jumps to Release')
    ].join('');
    const startCell = i === 0
      ? `<div class="env-sec"><span>Start</span><input type="range" data-f="startValue" min="0" max="100" step="1" value="${c.startValue}"><b data-v="startValue">${c.startValue}%</b></div>`
      : `<div class="env-sec env-start-ro" title="Starts where the previous component ends"><span>Start</span><b data-v="startValue">${c.startValue}%</b></div>`;
    rows += `<div class="fx-item env-row${isRelease ? ' release-row' : (inHold ? ' hold-row' : '')}" data-idx="${i}">
      <div class="env-row-head">
        <input type="text" class="env-name" value="${esc(c.name)}" maxlength="24" spellcheck="false" aria-label="Component name">
        <div class="env-markers">${markers}</div>
        <div class="env-btns">
          <button class="env-up" title="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="env-down" title="Move down" ${i === n - 1 ? 'disabled' : ''}>▼</button>
          <button class="env-del" title="Delete component" ${n <= 1 ? 'disabled' : ''}>✕</button>
        </div>
      </div>
      <div class="env-secs">
        <div class="env-sec"><span>Duration</span><input type="range" data-f="duration" min="1" max="5000" step="10" value="${c.duration}"><b data-v="duration">${c.duration}ms</b></div>
        ${startCell}
        <div class="env-sec"><span>End</span><input type="range" data-f="endValue" min="0" max="100" step="1" value="${c.endValue}"><b data-v="endValue">${c.endValue}%</b></div>
      </div>
    </div>`;
  }
  envListEl.innerHTML = rows;
}

// Values typed straight into a row update ENVELOPE live (no re-render).
envListEl.addEventListener('input', e => {
  const row = e.target.closest('.env-row');
  if (!row) return;
  const c = ENVELOPE.components[+row.dataset.idx];
  if (!c) return;
  if (e.target.classList.contains('env-name')) {
    c.name = e.target.value.slice(0, 24);
    scheduleSettingsSave();
    return;
  }
  const f = e.target.dataset.f;
  if (!f) return;
  c[f] = Math.max(f === 'duration' ? 1 : 0, Math.min(f === 'duration' ? 5000 : 100, +e.target.value));
  const vEl = row.querySelector('[data-v="' + f + '"]');
  if (vEl) vEl.textContent = c[f] + (f === 'duration' ? ' ms' : '%');
  if (f === 'endValue') {
    // An end feeds the next component's start: chain it and update that card's
    // read-only Start readout live.
    chainStartValues(ENVELOPE);
    const nextRow = row.nextElementSibling;
    const nextStart = nextRow && nextRow.querySelector('.env-start-ro b');
    if (nextStart) nextStart.textContent = c[f] + '%';
  }
  scheduleSettingsSave();
});

envListEl.addEventListener('change', e => {
  const row = e.target.closest('.env-row');
  if (!row) return;
  const idx = +row.dataset.idx;
  const c = ENVELOPE.components[idx];
  if (!c) return;

  if (e.target.classList.contains('env-name')) {
    c.name = e.target.value.slice(0, 24);
    saveSettings();
    return;
  }

  // Card markers: a radio sets the envelope's release/hold position.
  if (e.target.type === 'radio') {
    const mark = e.target.closest('.env-m');
    if (!mark || mark.classList.contains('disabled')) return;
    if (mark.classList.contains('env-m-release')) ENVELOPE.holdEndIndex = idx - 1;
    else if (mark.classList.contains('env-m-holdfrom')) {
      ENVELOPE.holdStartIndex = idx;
      if (ENVELOPE.holdEndIndex < idx) ENVELOPE.holdEndIndex = idx;
    } else if (mark.classList.contains('env-m-holdto')) {
      ENVELOPE.holdEndIndex = idx;
      if (ENVELOPE.holdStartIndex > idx) ENVELOPE.holdStartIndex = idx;
    } else if (mark.classList.contains('env-m-cut')) {
      ENVELOPE.earlyCutIndex = idx;
    }
    clampEnvelopeIndexes();
    renderEnvelopeEditor();
    saveSettings();
    return;
  }

  // Range sliders fire 'change' on thumb release (after live 'input' updates);
  // persist whatever was last edited.
  const f = e.target.dataset.f;
  if (f) {
    c[f] = Math.max(f === 'duration' ? 1 : 0, Math.min(f === 'duration' ? 5000 : 100, +e.target.value));
    const vEl = row.querySelector('[data-v="' + f + '"]');
    if (vEl) vEl.textContent = c[f] + (f === 'duration' ? 'ms' : '%');
    if (f === 'endValue') chainStartValues(ENVELOPE);
  }
  saveSettings();
});

// Structural edits: reorder, delete, add. All re-render and persist.
envListEl.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const row = btn.closest('.env-row');
  const idx = row ? +row.dataset.idx : -1;
  if (btn.classList.contains('env-up') || btn.classList.contains('env-down')) {
    const j = btn.classList.contains('env-up') ? idx - 1 : idx + 1;
    const arr = ENVELOPE.components;
    if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
  } else if (btn.classList.contains('env-del')) {
    ENVELOPE.components.splice(idx, 1);
  }
  clampEnvelopeIndexes();
  renderEnvelopeEditor();
  saveSettings();
});

envAddBtn.addEventListener('click', () => {
  ENVELOPE.components.push({ id: newCompId(), name: 'Component', duration: 250, startValue: 100, endValue: 100 });
  clampEnvelopeIndexes();
  renderEnvelopeEditor();
  saveSettings();
});
envResetBtn.addEventListener('click', () => {
  ENVELOPE = clone(DEFAULT_ENVELOPE);
  renderEnvelopeEditor();
  saveSettings();
});

function syncEnvelopeUI() {
  renderEnvelopeEditor();
}

/* ---- Settings window tabs ---- */
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanels = {
  'tab-sound': document.getElementById('tab-sound'),
  'tab-components': document.getElementById('tab-components')
};
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.toggle('active', b === btn));
    for (const id in tabPanels) {
      tabPanels[id].classList.toggle('hidden', id !== btn.dataset.tab);
    }
    const scroller = document.querySelector('.tab-scroll');
    if (scroller) scroller.scrollTop = 0;
  });
});

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
  flushSettingsSave();
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
    syncEnvelopeUI();
    syncPitchZonesUI();
    syncVolumeUI();
    syncHarmonicsUI();
  } else {
    closeSettingsPanel();
  }
});
document.getElementById('closeSettings').addEventListener('click', closeSettingsPanel);

// Belt-and-suspenders against the fixed panel panning sideways: some browsers
// still rubber-band/edge-pan it even with touch-action: pan-y (iOS Safari's
// fixed-element handling, Android edge pans). Swallow horizontal drags here so
// the screen can't slide; vertical drags keep scrolling and native range
// sliders keep their own drag handling (they're excluded below).
let panelDrag = null;
settingsPanel.addEventListener('touchstart', e => {
  if (e.target.closest('input[type=range]')) { panelDrag = null; return; }
  const t = e.touches[0];
  panelDrag = { x: t.clientX, y: t.clientY, horizontal: null };
}, { passive: true });
settingsPanel.addEventListener('touchmove', e => {
  if (!panelDrag) return;
  const t = e.touches[0];
  const dx = t.clientX - panelDrag.x;
  const dy = t.clientY - panelDrag.y;
  if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
  if (panelDrag.horizontal == null) panelDrag.horizontal = Math.abs(dx) > Math.abs(dy);
  if (panelDrag.horizontal || Math.abs(dx) > Math.abs(dy)) e.preventDefault();
}, { passive: false });
settingsPanel.addEventListener('touchend', () => { panelDrag = null; });
settingsPanel.addEventListener('touchcancel', () => { panelDrag = null; });
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
