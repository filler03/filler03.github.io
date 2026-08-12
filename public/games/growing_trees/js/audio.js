/* ============================================================
   audio.js — synthesized sound: engine, note scheduling, gesture
   audio (live + wait modes), tap-note ADSR, wave blending.
   ============================================================ */

const midiFreq = m => 440 * Math.pow(2, (m - 69) / 12);

// Wave morphing: periodic waves are built from Fourier coefficients, so a
// blend between two types is a per-harmonic linear interpolation of their
// coefficients. `blend` (0..1) mixes the chosen wave toward `blendTo` (or the
// NEXT shape in the cycle if blendTo is unset), e.g. 50% sine + 50% triangle.
const WAVE_ORDER = ['sine', 'triangle', 'square', 'sawtooth'];
const HARMONICS = 64;

function waveCoeffs(type) {
  const imag = new Float32Array(HARMONICS + 1);
  for (let n = 1; n <= HARMONICS; n++) {
    if (type === 'sine') {
      if (n === 1) imag[n] = 1;
    } else if (type === 'triangle') {
      if (n % 2 === 1) imag[n] = (8 / (Math.PI * Math.PI)) * (n % 4 === 1 ? 1 : -1) / (n * n);
    } else if (type === 'square') {
      if (n % 2 === 1) imag[n] = (4 / Math.PI) / n;
    } else if (type === 'sawtooth') {
      imag[n] = (2 / Math.PI) * (n % 2 === 1 ? 1 : -1) / n;
    }
  }
  return imag;
}

function buildBlendWave(ctx, typeA, typeB, t) {
  const a = waveCoeffs(typeA), b = waveCoeffs(typeB);
  const real = new Float32Array(HARMONICS + 1);
  const imag = new Float32Array(HARMONICS + 1);
  for (let n = 0; n <= HARMONICS; n++) imag[n] = (1 - t) * a[n] + t * b[n];
  return ctx.createPeriodicWave(real, imag);
}

function initAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.45;
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 16;
  comp.ratio.value = 8;
  comp.attack.value = 0.01;
  comp.release.value = 0.3;
  masterGain.connect(comp);
  comp.connect(audioCtx.destination);
}

function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') return audioCtx.resume();
}

// iOS-style audio unlock: some browsers only start a freshly-created
// AudioContext from a discrete tap/click and don't treat a drag's pointer events
// as audio user activations. Create and resume the context, play a silent
// sample, and retry the resume a tick later once the context creation has
// settled, so the first interaction can unlock audio.
function unlockAudio() {
  initAudio();
  if (!audioCtx) return;
  if (audioCtx.state === 'running') return;
  resumeAudio();
  if (audioCtx.state === 'suspended') {
    try {
      const buf = audioCtx.createBuffer(1, Math.max(1, Math.floor(audioCtx.sampleRate * 0.05)), audioCtx.sampleRate);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.start(0);
    } catch (e) {}
    setTimeout(() => { if (audioCtx && audioCtx.state === 'suspended') resumeAudio(); }, 0);
  }
}
document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
document.addEventListener('click', unlockAudio, { once: true, passive: true });

// Short, quiet confirmation chime for the sound-overlay tap. Scheduled a
// little in the future so a just-resumed AudioContext doesn't drop the events
// (events at exactly currentTime are what browsers drop on a fresh resume).
function playUnlockChime() {
  if (!audioCtx || !masterGain) return;
  const s = Object.assign({}, CHIME_SETTINGS.start, { volume: 0.01, decay: 100, sustain: 0, release: 200 });
  const peak = 0.01;
  const t0 = audioCtx.currentTime + 0.05;
  const atk = (s.attack || 5) / 1000;
  const dec = s.decay / 1000;
  const rel = s.release / 1000;
  const tPeak = t0 + atk;
  const tSus = tPeak + dec;
  const tEnd = tSus + rel;
  const gain = audioCtx.createGain();
  const g = gain.gain;
  g.setValueAtTime(0, t0);
  if (atk > 0) g.linearRampToValueAtTime(peak, tPeak);
  else g.setValueAtTime(peak, tPeak);
  g.linearRampToValueAtTime(0, tSus);
  g.setValueAtTime(0, tSus);
  g.linearRampToValueAtTime(0, tEnd);
  gain.connect(masterGain);
  const osc = audioCtx.createOscillator();
  setOscWave(osc, s);
  osc.frequency.value = noteToFreq(s.note);
  osc.connect(gain);
  osc.start(t0);
  osc.stop(tEnd + 0.05);
  setTimeout(() => { try { osc.disconnect(); gain.disconnect(); } catch (e) {} }, (tEnd - t0 + 0.5) * 1000);
}

/* ---------- Note / pitch helpers ---------- */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_OFFSETS = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const NOTE_OCTAVE = 4;

function noteToFreq(name) {
  return midiFreq(noteToMidi(name));
}

function noteToMidi(name) {
  const m = name.match(/^([A-G]#?)(\d)$/);
  return (+m[2] + 1) * 12 + NOTE_OFFSETS[m[1]];
}

function midiToName(m) {
  return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
}

// Pitch comes from the horizontal position (screen X), not the gesture:
// far left plays the low end of the scale, far right the high end, snapped to
// the chosen pentatonic scale. Different horizontal positions layer into a
// melody/chord.
function pitchFor(sx, sy) {
  const p = clamp01(sx / W);                      // 0 far left .. 1 far right
  const SCALE = [0, 2, 4, 7, 9];                  // major pentatonic semitone offsets
  const degree = Math.round(p * SCALE.length * 2);  // 0..10 across 2 octaves
  const octaveOffset = Math.floor(degree / SCALE.length);
  const semitone = SCALE[Math.min(SCALE.length - 1, degree % SCALE.length)] + 12 * octaveOffset;
  return midiToName(noteToMidi(CHIME_SETTINGS.start.note) + semitone - 12);   // an octave lower
}

function setOscWave(osc, s) {
  if (s.blend > 0) {
    const idx = WAVE_ORDER.indexOf(s.wave);
    const next = WAVE_ORDER.includes(s.blendTo) ? s.blendTo : WAVE_ORDER[(idx + 1) % WAVE_ORDER.length];
    osc.setPeriodicWave(buildBlendWave(audioCtx, s.wave, next, Math.min(1, s.blend)));
  } else {
    osc.type = s.wave;
  }
}

function chime(level, overrides) {
  initAudio();
  resumeAudio();
  if (!audioCtx || !masterGain) return;
  const s = Object.assign({}, CHIME_SETTINGS[level], overrides || {});
  const t0 = audioCtx.currentTime;
  const peak = s.volume != null ? s.volume : 0.12;

  const atk = s.attack / 1000;
  const dec = s.decay / 1000;
  const sus = s.sustain / 100;
  const hold = s.hold / 1000;
  const rel = s.release / 1000;

  const tPeak = t0 + atk;
  const tSus = tPeak + dec;
  const tRel = tSus + hold;
  const tEnd = tRel + rel;

  const gain = audioCtx.createGain();
  const g = gain.gain;
  g.setValueAtTime(0, t0);
  if (atk > 0) g.linearRampToValueAtTime(peak, tPeak);
  else g.setValueAtTime(peak, tPeak);
  g.linearRampToValueAtTime(peak * sus, tSus);
  g.setValueAtTime(peak * sus, tRel);
  g.linearRampToValueAtTime(0, tEnd);
  gain.connect(masterGain);

  const osc = audioCtx.createOscillator();
  setOscWave(osc, s);
  osc.frequency.value = noteToFreq(s.note);
  osc.connect(gain);
  osc.start(t0);
  osc.stop(tEnd + 0.05);

  setTimeout(() => {
    try { osc.disconnect(); gain.disconnect(); } catch (e) {}
  }, (tEnd - t0 + 0.5) * 1000);
}

/* ---- Gesture-attack / decay / release helpers ---- */
function gestureAttackMs() {
  // ms over which a custom gesture's volume fades in when "Add to gestures" is on
  return GESTURE.gestureAttack ? (FIXED.attack.value || 0) : 0;
}

function gestureDecayMs() {
  // ms over which a custom gesture's volume fades out, right after the attack,
  // when "Add to gestures" is on
  return GESTURE.gestureDecay ? (FIXED.decay.value || 0) : 0;
}

function decayEndVol() {
  // fraction of the full volume the decay fades down to (FIXED.decay.vol, 0..1)
  return Math.max(0, Math.min(1, (FIXED.decay.vol || 0) / 100));
}

function gestureReleaseMs() {
  // ms of release appended to a custom gesture's note when "Add to gestures" is on
  return GESTURE.gestureRelease ? (FIXED.release.value || 0) : 0;
}

/* ---- Tap notes: a default ADSR note per tap. Taps overlap — each tap gets
   its own oscillator + gain node, so several can ring at once. Uses the FIXED
   presets for attack/decay/hold/release and the touch's screen Y for volume. */
function startGestureNote(sx, sy, atkMs, volPct) {
  initAudio();
  resumeAudio();
  if (!audioCtx || !masterGain) return;
  const s = CHIME_SETTINGS.start;
  const vol = volumeFromStartY(sy);
  const atk = Math.max(0.005, (atkMs || TAP_ATTACK_MS) / 1000);
  const peak = vol * (volPct != null ? Math.max(0, Math.min(100, volPct)) / 100 : 1);
  const t0 = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  const g = gain.gain;
  // The note begins with the attack ramping from silence up to its peak level.
  g.setValueAtTime(0, t0);
  g.linearRampToValueAtTime(peak, t0 + atk);
  gain.connect(masterGain);

  const osc = audioCtx.createOscillator();
  setOscWave(osc, s);
  osc.frequency.value = noteToFreq(pitchFor(sx, sy));
  osc.connect(gain);
  osc.start(t0);

  const atkDurMs = Math.round(atk * 1000);
  const note = {
    osc, gain, vol, level: peak, segEnd: t0 + atk,
    scheduledSlots: [true, false, false, false],
    slots: [atkDurMs, null, null, null],   // per-phase durations, for the A/D/S/R card
    cleanupTimer: null,
    releaseScheduled: false,
    noteStart: performance.now(),
    totalMs: atkDurMs,
  };
  tapNotes.push(note);
  return note;
}

// Fixed segments: a generic ramp to a target level, a hold, and a fade-out,
// all chained onto the running note.
function scheduleRampTo(note, target, durMs) {
  if (!note) return;
  const now = audioCtx.currentTime;
  const g = note.gain.gain;
  const startTime = Math.max(now, note.segEnd || now);
  const startLevel = note.level;
  const end = startTime + Math.max(0.005, durMs / 1000);
  g.setValueAtTime(startLevel, startTime);
  g.linearRampToValueAtTime(target, end);
  note.level = target;
  note.segEnd = end;
}

// Schedule the fixed tap-default slots (decay, hold, release) onto a note.
function scheduleFixedRun(note, fromSlot) {
  if (!note) return;
  for (let slot = fromSlot; slot < 4; slot++) {
    if (note.scheduledSlots[slot]) continue;
    if (!FIXED[SLOT_NAMES[slot]].on) return;
    scheduleFixedSlot(note, slot);
    note.scheduledSlots[slot] = true;
  }
}

function scheduleFixedSlot(note, slot) {
  const name = SLOT_NAMES[slot];
  const f = FIXED[name];
  const vol = note.vol * (f.vol / 100);   // target level, as % of gain
  note.slots[slot] = f.value;             // per-phase duration, for the A/D/S/R card
  note.totalMs += f.value;                // card stays up for the whole envelope
  if (name === 'decay') {
    scheduleRampTo(note, vol, f.value);
  } else if (name === 'hold') {
    scheduleRampTo(note, vol, f.value);
  } else if (name === 'release') {
    scheduleRampTo(note, vol, f.value);
    fadeOutAndStop(note, note.segEnd);
  }
}

// Always end on a smooth fade to 0 so the note never clips when the sequence
// finishes.
function fadeOutAndStop(note, fromTime) {
  if (!note) return;
  const g = note.gain.gain;
  const end = fromTime + FADE_MS / 1000;
  g.linearRampToValueAtTime(0, end);
  scheduleStop(note, end);
}

function scheduleStop(note, end) {
  if (!note) return;
  note.releaseScheduled = true;
  const { osc, gain } = note;
  try { osc.stop(end + 0.05); } catch (e) {}
  clearTimeout(note.cleanupTimer);
  note.cleanupTimer = setTimeout(() => {
    try { osc.disconnect(); gain.disconnect(); } catch (e) {}
  }, (end - audioCtx.currentTime + 0.5) * 1000);
}

// Tap finished (finger lift): the release slot normally schedules its own
// stop; if it never did, fade from the current level.
function endGestureNote(note) {
  if (!note) return;
  if (!note.releaseScheduled) {
    const now = audioCtx.currentTime;
    const segEnd = note.segEnd && note.segEnd > now ? note.segEnd : now;
    note.gain.setValueAtTime(note.level, segEnd);
    fadeOutAndStop(note, segEnd);
  }
}

// Cancel everything (used on blur / cancel / mode switch / clear): quickly
// fade every running note out and drop all playback animations.
function stopGestureNote() {
  for (const n of gestureNotes) {
    try {
      const now = audioCtx.currentTime;
      clearTimeout(n.cleanupTimer);
      // Live notes store the AudioParam in .gain (with the node in .gainNode);
      // wait-mode notes store the GainNode in .gain. Resolve the AudioParam.
      const param = n.gain && n.gain.gain ? n.gain.gain : n.gain;
      const node = n.gainNode || n.gain;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(0, now + 0.03);
      n.osc.stop(now + 0.05);
      setTimeout(() => { try { n.osc.disconnect(); if (node && node.disconnect) node.disconnect(); } catch (e) {} }, 200);
    } catch (e) {}
  }
  for (const note of tapNotes) {
    try {
      const now = audioCtx.currentTime;
      clearTimeout(note.cleanupTimer);
      note.gain.cancelScheduledValues(now);
      note.gain.setValueAtTime(note.gain.gain.value, now);
      note.gain.linearRampToValueAtTime(0, now + 0.03);
      note.osc.stop(now + 0.05);
      setTimeout(() => { try { note.osc.disconnect(); note.gain.disconnect(); } catch (e) {} }, 200);
    } catch (e) {}
  }
  gestureNotes = [];
  tapNotes = [];
  playbacks = [];
}

/* ---- Gesture note audio ----
   WAIT MODE (schedulePathAudio): the whole note is played with a single
   setValueCurveAtTime over 128 volume samples (attack fade baked in) plus a
   fade-out tail.
   LIVE MODE (initLivePathAudio + scheduleLivePoint + tickLiveHold +
   finishLivePathNote): the note begins as soon as the finger moves past the
   tap threshold; each newly-recorded point is scheduled at the audio time its
   horizontal travel implies, with setTargetAtTime catch-up when the circle
   catches the fingertip. */

function schedulePathAudio(ds, totalMs, atkMs, decMs, relMs) {
  if (!audioCtx || !masterGain) return;
  const curve = buildVolumeCurve(ds.pts, ds.cumTime, ds.totalMs, 128, atkMs, decMs);
  const s = CHIME_SETTINGS.start;
  const t0 = audioCtx.currentTime;
  const pathDur = totalMs / 1000;

  const gain = audioCtx.createGain();
  const g = gain.gain;
  const curveStart = t0 + 0.002;   // tiny offset: no automation overlap with the setValue below
  g.setValueAtTime(curve[0], t0);
  g.setValueCurveAtTime(curve, curveStart, pathDur);
  const curveEnd = curveStart + pathDur;
  g.setValueAtTime(curve[curve.length - 1], curveEnd);
  if (relMs > 0) {
    g.linearRampToValueAtTime(curve[curve.length - 1] * (FIXED.release.vol / 100), curveEnd + relMs / 1000);
  }
  g.linearRampToValueAtTime(0, curveEnd + relMs / 1000 + FADE_MS / 1000);
  gain.connect(masterGain);

  const osc = audioCtx.createOscillator();
  setOscWave(osc, s);
  osc.frequency.value = noteToFreq(pitchFor(ds.startX, ds.startY));
  osc.connect(gain);
  osc.start(t0);
  const tEnd = curveEnd + relMs / 1000 + FADE_MS / 1000;
  osc.stop(tEnd + 0.05);
  const note = { osc, gain, cleanupTimer: null };
  gestureNotes.push(note);
  setTimeout(() => { try { osc.disconnect(); gain.disconnect(); } catch (e) {} unregisterNote(note); }, (tEnd - t0 + 0.5) * 1000);
}

// Run `fn` once the AudioContext is actually running. On the very first load the
// context is created suspended and some browsers defer resume() until a later
// gesture, so poll until it is running (or the wait times out).
function ensureAudioRunning(fn, deadline) {
  if (!audioCtx || !masterGain) return;
  if (audioCtx.state === 'running') { fn(); return; }
  if (deadline && Date.now() > deadline) return;
  resumeAudio();
  requestAnimationFrame(() => ensureAudioRunning(fn, deadline));
}

// Start a live gesture's note audio as soon as the AudioContext is actually
// running.
function ensureLiveAudio(ds, deadline) {
  if (!audioCtx || !masterGain || ds.gain) return;
  if (audioCtx.state === 'running') { initLivePathAudio(ds); return; }
  if (deadline && Date.now() > deadline) return;
  resumeAudio();
  requestAnimationFrame(() => {
    if (!ds.gain && (dragStates.has(ds.pointerId) || ds.finished)) ensureLiveAudio(ds, deadline);
  });
}

function initLivePathAudio(ds) {
  const s = CHIME_SETTINGS.start;
  const ctx0 = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  const g = gain.gain;
  const vol0 = volumeFromStartY(ds.pts[0].y);
  const atkMs = gestureAttackMs();
  // With an attack window the note starts silent and each scheduled point
  // ramps to its base volume scaled by the fade factor for that moment.
  g.setValueAtTime(atkMs > 0 ? 0 : vol0, ctx0);
  gain.connect(masterGain);
  const osc = audioCtx.createOscillator();
  setOscWave(osc, s);
  osc.frequency.value = noteToFreq(pitchFor(ds.startX, ds.startY));
  osc.connect(gain);
  osc.start(ctx0);
  ds.startedAt = performance.now();
  ds.ctx0 = ctx0;
  ds.gain = g;          // the AudioParam (gain.gain) — scheduling/ramps go through this
  ds.gainNode = gain;   // the GainNode itself — used for cleanup/disconnect
  ds.osc = osc;
  ds.gainLevel = atkMs > 0 ? 0 : vol0;
  ds.atkMs = atkMs;
  ds.decMs = gestureDecayMs();
  ds.lastSched = ctx0;
  ds.cleanupTimer = null;
  gestureNotes.push(ds);
  // The gesture finished before the context finished resuming (a very quick
  // first flick): wrap the note up right away so it plays and never leaks.
  if (ds.finished) finishLivePathNote(ds);
}

function scheduleLivePoint(ds) {
  if (!ds.gain) return;
  const pt = ds.pts[ds.pts.length - 1];
  // The envelope is applied in place: the base volume is scaled by the attack
  // fade over the first atkMs and by the decay fade over the decMs right after
  // it. Each point is scaled by the fade progress at the moment it is drawn;
  // the progress never steps backward when a held gesture resumes drawing.
  const prog = liveFadeProgress(ds);
  const target = volumeFromStartY(pt.y)
    * attackFactor(prog, ds.atkMs || 0)
    * decayFactor(prog, ds.atkMs || 0, ds.decMs || 0);
  const targetT = ds.ctx0 + ds.totalMs / 1000;   // audio-clock time this point plays
  const now = audioCtx.currentTime;
  if (targetT > now + 0.005) {
    const startT = Math.max(now, ds.lastSched);
    ds.gain.setValueAtTime(ds.gainLevel, startT);
    ds.gain.linearRampToValueAtTime(target, targetT);
    ds.lastSched = targetT;
  } else {
    ds.gain.setTargetAtTime(target, now, 0.06);   // catch-up: chase the fingertip
  }
  ds.gainLevel = target;
}

// A held finger adds no new path points, so no volume automation is scheduled
// and the attack fade would stall mid-fade. Each frame, while a live note is
// inside its attack window and the finger isn't drawing, schedule the gain
// toward the fingertip's level along the real-time fade curve so the volume
// keeps rising during a hold. The decay fade works the same way right after
// the attack: once the fade progress passes atkMs, the held note fades down
// toward the decay's end volume.
function tickLiveHold(ds) {
  if (!ds.gain || ds.finished) return;
  const atkMs = ds.atkMs || 0, decMs = ds.decMs || 0;
  if (!(atkMs > 0) && !(decMs > 0)) return;
  if (performance.now() - (ds.lastMoveAt || 0) < 50) return;   // finger is still drawing
  const at = audioCtx.currentTime;
  if (at < ds.lastSched - 0.005) return;                       // scheduled automation is still ahead
  const prog = liveFadeProgress(ds);
  const decEnd = (atkMs > 0 ? atkMs : 0) + decMs;
  if (prog >= atkMs && prog >= decEnd) return;                 // both fades complete
  const base = volumeFromStartY(ds.pts[ds.pts.length - 1].y);
  const horizon = 0.04;                                        // seconds of fade scheduled per frame
  const progF = prog + horizon * 1000;
  const target = base * attackFactor(progF, atkMs) * decayFactor(progF, atkMs, decMs);
  ds.gain.cancelScheduledValues(at);
  ds.gain.setValueAtTime(Math.max(1e-4, ds.gain.value), at);
  ds.gain.linearRampToValueAtTime(target, at + horizon);
  ds.lastSched = at + horizon;
  ds.gainLevel = target;
}

function finishLivePathNote(ds) {
  if (!ds.gain || !ds.playback) return;
  const totalMs = Math.max(MIN_GESTURE_MS, ds.totalMs || 0);
  const relMs = gestureReleaseMs();
  const path = buildGesturePlaybackPath(ds.pts, ds.cumTime, ds.totalMs || 0, ds.atkMs || gestureAttackMs(), ds.decMs || gestureDecayMs(), relMs);
  ds.playback.released = true;
  ds.playback.totalMs = totalMs + relMs;
  ds.playback.relMs = relMs;
  ds.playback.pts = path.pts;
  ds.playback.cumTime = path.cum;
  ds.playback.tailEnd = path.tailEnd;
  const now = audioCtx.currentTime;
  const endT = ds.ctx0 + ds.totalMs / 1000;   // when the path's playback finishes
  if (performance.now() - ds.startedAt >= ds.totalMs) {
    if (relMs > 0) {
      const held = ds.gain.value;
      ds.gain.cancelScheduledValues(now);
      ds.gain.setValueAtTime(held, now);
      ds.gain.linearRampToValueAtTime(held * (FIXED.release.vol / 100), now + relMs / 1000);
      ds.gain.linearRampToValueAtTime(0, now + relMs / 1000 + FADE_MS / 1000);
      try { ds.osc.stop(now + relMs / 1000 + FADE_MS / 1000 + 0.05); } catch (e) {}
      scheduleLiveCleanup(ds, now + relMs / 1000 + FADE_MS / 1000);
    } else {
      // The circle already caught the fingertip: fade out from the held level.
      ds.gain.setTargetAtTime(0, now, 0.03);
      try { ds.osc.stop(now + 0.4); } catch (e) {}
      scheduleLiveCleanup(ds, now + 0.6);
    }
  } else {
    // Playback is still behind the fingertip: finish the path, then fade.
    const startT = Math.max(now, endT, ds.ctx0);
    const stopT = startT + relMs / 1000 + FADE_MS / 1000;
    ds.gain.setValueAtTime(ds.gainLevel, startT);
    if (relMs > 0) ds.gain.linearRampToValueAtTime(ds.gainLevel * (FIXED.release.vol / 100), startT + relMs / 1000);
    ds.gain.linearRampToValueAtTime(0, stopT);
    try { ds.osc.stop(stopT + 0.05); } catch (e) {}
    scheduleLiveCleanup(ds, stopT + 0.5);
  }
}

function scheduleLiveCleanup(ds, t) {
  clearTimeout(ds.cleanupTimer);
  ds.cleanupTimer = setTimeout(() => {
    try { ds.osc.disconnect(); if (ds.gainNode) ds.gainNode.disconnect(); } catch (e) {}
    unregisterNote(ds);
  }, (t - audioCtx.currentTime + 0.5) * 1000);
}

// Forget a finished gesture note so it isn't cancelled later.
function unregisterNote(n) {
  const i = gestureNotes.indexOf(n);
  if (i >= 0) gestureNotes.splice(i, 1);
}
