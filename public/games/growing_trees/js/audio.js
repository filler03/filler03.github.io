/* ============================================================
   audio.js — synthesized sound: engine, note scheduling, gesture
   audio (live + wait modes), wave blending.
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

// Enumerate the scale positions between the configured low and high pitch
// bounds (inclusive), each { octave, degree } where octave is relative to the
// key note's octave. The bounds are swapped if reversed, so the range always
// reads low-to-high.
function pitchPositions() {
  let lo = { o: Math.max(-2, Math.min(2, PITCH_ZONES.lowOctave)), d: Math.max(1, Math.min(7, PITCH_ZONES.lowDegree)) };
  let hi = { o: Math.max(-2, Math.min(2, PITCH_ZONES.highOctave)), d: Math.max(1, Math.min(7, PITCH_ZONES.highDegree)) };
  if (lo.o > hi.o || (lo.o === hi.o && lo.d > hi.d)) { const t = lo; lo = hi; hi = t; }
  const out = [];
  for (let o = lo.o; o <= hi.o; o++) {
    const dStart = o === lo.o ? lo.d : 1;
    const dEnd = o === hi.o ? hi.d : 7;
    for (let d = dStart; d <= dEnd; d++) out.push({ octave: o, degree: d });
  }
  return out;
}

// Index into pitchPositions() for a screen X: which scale position plays there.
function pitchIndexForX(sx) {
  const positions = pitchPositions();
  const n = positions.length;
  return Math.max(0, Math.min(n - 1, Math.floor(clamp01(sx / W) * n)));
}

// The note name (e.g. "C4") of a scale position ({ octave, degree }), where
// octave is relative to the key note's octave.
function noteNameForPos(pos) {
  const semitone = 12 * pos.octave + SCALE_DEGREES[pos.degree - 1];
  return midiToName(noteToMidi(CHIME_SETTINGS.start.note) + semitone);
}

// Pitch comes from the horizontal position (screen X), not the gesture:
// far left plays the low end of the configured pitch range, far right the high
// end, snapped to the 7-degree diatonic scale. Different horizontal positions
// layer into a melody/chord.
function pitchFor(sx, sy) {
  return noteNameForPos(pitchPositions()[pitchIndexForX(sx)]);
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

/* ---- Gesture note audio ----
   Every touch is a gesture note. A tap is just a very short gesture (near-zero
   horizontal travel): in live mode the note starts the moment the finger
   touches down, in wait mode it is scheduled once the finger lifts.
   WAIT MODE (schedulePathAudio): the whole note is played with a single
   setValueCurveAtTime over 128 volume samples (attack fade baked in) plus a
   fade-out tail.
   LIVE MODE (initLivePathAudio + scheduleLivePoint + tickLiveHold +
   finishLivePathNote): the note begins on touch down; each newly-recorded
   point is scheduled at the audio time its horizontal travel implies, with
   setTargetAtTime catch-up when the circle catches the fingertip. */
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
  gestureNotes = [];
  playbacks = [];
}

/* ---- Gesture note audio ----
   WAIT MODE (schedulePathAudio): the whole note is played with a single
   setValueCurveAtTime over 128 volume samples (attack fade baked in) plus a
   fade-out tail.
   LIVE MODE (initLivePathAudio + scheduleLivePoint + tickLiveHold +
   finishLivePathNote): the note begins the moment the finger touches down; each
   newly-recorded point is scheduled at the audio time its horizontal travel
   implies, with setTargetAtTime catch-up when the circle catches the fingertip. */

function schedulePathAudio(ds, totalMs) {
  if (!audioCtx || !masterGain) return;
  const s = CHIME_SETTINGS.start;
  const t0 = audioCtx.currentTime;
  const pathDur = totalMs / 1000;

  // Body: the base volume along the path × the envelope's pre-release shape
  // (one pass — once the body domain is exhausted the value holds at the hold
  // window's end), scheduled as a sampled curve.
  const body = buildVolumeCurve(ds.pts, ds.cumTime, ds.totalMs || 0, 128);
  const gain = audioCtx.createGain();
  const g = gain.gain;
  const curveStart = t0 + 0.002;   // tiny offset: no automation overlap with the setValue below
  g.setValueAtTime(body[0], t0);
  g.setValueCurveAtTime(body, curveStart, pathDur);
  const curveEnd = curveStart + pathDur;

  // Release tail: the release section, scaled to the path-end base volume.
  const relComps = ENVELOPE.components.slice(ENVELOPE.beginReleaseIndex);
  const relMs = compsMs(relComps);
  if (relMs > 0) {
    const endBase = baseVolumeFromY(ds.pts[ds.pts.length - 1].y);
    const tail = new Float32Array(64);
    for (let k = 0; k < tail.length; k++) {
      const t = relMs * k / (tail.length - 1);
      tail[k] = endBase * relValueRelease(ENVELOPE, t);
    }
    const relStart = curveEnd + 0.002;
    g.setValueAtTime(tail[0], curveEnd);
    g.setValueCurveAtTime(tail, relStart, relMs / 1000);
  }
  const tEnd = curveEnd + relMs / 1000 + FADE_MS / 1000;
  g.linearRampToValueAtTime(0, tEnd);
  gain.connect(masterGain);

  const osc = audioCtx.createOscillator();
  setOscWave(osc, s);
  osc.frequency.value = noteToFreq(pitchFor(ds.startX, ds.startY));
  osc.connect(gain);
  osc.start(t0);
  osc.stop(tEnd + 0.05);
  const note = { osc, gain, gainParam: g, cleanupTimer: null };
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
  const baseVol0 = baseVolumeFromY(ds.pts[0].y);
  g.setValueAtTime(baseVol0 * relValueBody(ENVELOPE, 0, true), ctx0);
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
  ds.gainLevel = baseVol0 * relValueBody(ENVELOPE, 0, true);
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
  // The relative value is the envelope's body shape at this moment (looped so
  // a held note cycles the hold range). The progress never steps backward when
  // a held gesture resumes drawing.
  const prog = liveFadeProgress(ds);
  const target = baseVolumeFromY(pt.y) * relValueBody(ENVELOPE, prog, true);
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
// and the envelope shape would stall. Each frame, while a live note is idle,
// schedule the body shape (looped through the hold range) ahead over a short
// horizon so the relative value keeps moving during a hold.
function tickLiveHold(ds) {
  if (!ds.gain || ds.finished) return;
  if (ENVELOPE.beginReleaseIndex <= 0) return;
  if (performance.now() - (ds.lastMoveAt || 0) < 50) return;   // finger is still drawing
  const at = audioCtx.currentTime;
  if (at < ds.lastSched - 0.005) return;                       // scheduled automation is still ahead
  const hs = holdStartTime(ENVELOPE), he = holdEndTime(ENVELOPE);
  const schedProg = (ds.lastSched - ds.ctx0) * 1000;
  if (schedProg >= he && !(he > hs)) return;                   // body done, no loop to cycle
  const baseVol = baseVolumeFromY(ds.pts[ds.pts.length - 1].y);
  const horizon = Math.max(0.06, Math.min(0.3, (he > hs ? he - hs : 200) / 1000));   // seconds of shape scheduled per frame
  const curve = sampleRelBody(ENVELOPE, schedProg, schedProg + horizon * 1000, 24);
  const scaled = curve.map(v => baseVol * v);
  ds.gain.cancelScheduledValues(at);
  ds.gain.setValueAtTime(Math.max(1e-4, scaled[0]), at);
  ds.gain.setValueCurveAtTime(scaled, at + 0.001, horizon);
  ds.lastSched = at + 0.001 + horizon;
  ds.gainLevel = scaled[scaled.length - 1];
}

// Where an early release jumps to the release section: the playback time (ms)
// through the body at the early-cut marker. Clamped so the cut never lands past
// the end of the body's last component (safe: it can't exceed holdEndTime).
function earlyCutMs() {
  const env = ENVELOPE;
  const maxIdx = Math.max(0, env.beginReleaseIndex - 1);
  const idx = Math.max(0, Math.min(maxIdx, env.earlyCutIndex == null ? maxIdx : env.earlyCutIndex));
  return compsMs(env.components.slice(0, idx + 1));
}

function finishLivePathNote(ds) {
  if (!ds.gain || !ds.playback) return;
  const totalMs = Math.max(MIN_GESTURE_MS, ds.totalMs || 0);
  const relComps = ENVELOPE.components.slice(ENVELOPE.beginReleaseIndex);
  const relMs = compsMs(relComps);
  const path = buildGesturePlaybackPath(ds.pts, ds.cumTime, ds.totalMs || 0, relMs);
  // Anchor the visual timeline at the release moment: keep the circle where it
  // is (its path-time playhead) but make the release tail run from now. Without
  // this a stationary press held past the note length would already be "done"
  // when the finger lifts, so its tail would never be drawn.
  const pb = ds.playback;
  const playheadMs = pb.pts && pb.pts.length
    ? cumAtState(pb.cumTime, pathStateAtTime(pb.pts, pb.cumTime, performance.now() - pb.startedAt))
    : 0;
  ds.playback.released = true;
  ds.playback.totalMs = totalMs + relMs;
  ds.playback.relMs = relMs;
  ds.playback.pts = path.pts;
  ds.playback.cumTime = path.cum;
  ds.playback.tailEnd = path.tailEnd;
  ds.playback.startedAt = performance.now() - playheadMs;
  const now = audioCtx.currentTime;
  if (performance.now() - ds.startedAt >= ds.totalMs) {
    // The circle already caught the fingertip: play the release section from
    // the held level, then fade.
    scheduleReleaseTail(ds, ds.gain.value, now);
  } else {
    // Playback is still behind the fingertip: let the body play through the
    // early-cut marker (or the whole body by default), then release from the
    // level at the cut.
    const bodyCutMs = Math.min(earlyCutMs(), ds.totalMs);
    const cutT = ds.ctx0 + bodyCutMs / 1000;
    const releaseT = Math.max(now, cutT, ds.ctx0);
    const st = pathStateAtTime(ds.pts, ds.cumTime, bodyCutMs);
    const level = baseVolumeFromY(st.y) * relValueBody(ENVELOPE, bodyCutMs, true);
    scheduleReleaseTail(ds, level, releaseT);
  }
}

// On finger-up, jump from the held body level into the release section, then
// fade out. The release section starts at `startLevel` (the value currently
// playing) and each release card ramps from whatever value it's entered at to
// its own end value, so the jump is a smooth continuation with no click. Any
// pending body/hold automation is cancelled at `startT`.
function scheduleReleaseTail(ds, startLevel, startT) {
  const g = ds.gain;
  const relComps = ENVELOPE.components.slice(ENVELOPE.beginReleaseIndex);
  const relMs = compsMs(relComps);
  const now = audioCtx.currentTime;
  g.cancelScheduledValues(Math.max(now, startT));
  g.setValueAtTime(Math.max(1e-4, startLevel), startT);
  if (relMs > 0) {
    const rel = sampleComps(relComps, 32, startLevel);
    g.setValueCurveAtTime(rel.curve, startT + 0.002, relMs / 1000);
    const stopT = startT + relMs / 1000 + FADE_MS / 1000;
    g.linearRampToValueAtTime(0, stopT);
    try { ds.osc.stop(stopT + 0.05); } catch (e) {}
    scheduleLiveCleanup(ds, stopT);
  } else {
    const stopT = startT + FADE_MS / 1000;
    g.linearRampToValueAtTime(0, stopT);
    try { ds.osc.stop(stopT + 0.05); } catch (e) {}
    scheduleLiveCleanup(ds, stopT);
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
