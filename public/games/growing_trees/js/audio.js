/* ============================================================
   audio.js — synthesized sound: engine, note scheduling, gesture
   audio (live + wait modes), oscillator-stack voices.
   ============================================================ */

const midiFreq = m => 440 * Math.pow(2, (m - 69) / 12);

const WAVE_HARMONICS = 64;

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
  // Hard limiter: a second compressor with near-brickwall settings catches any
  // peaks that slip past the first (musical) compressor, preventing clipping
  // when many voices stack.
  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  comp.connect(limiter);
  limiter.connect(audioCtx.destination);
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
  const stack = buildLayerStack(audioCtx, gain);
  scheduleLayerMix(stack, t0, tEnd);
  startLayerStack(stack, t0, noteToFreq(s.note), tEnd);
  scheduleLayerPitch(stack, t0, tEnd, noteToFreq(s.note), null, null);
  setTimeout(() => {
    try { stack.oscs.forEach(o => o.disconnect()); stack.mixGains.forEach(g => g.disconnect()); gain.disconnect(); } catch (e) {}
  }, (tEnd - t0 + 0.5) * 1000);
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

// Build a PeriodicWave from harmonic amplitudes (0..1 each). The peak is
// normalized to 1.0 so every harmonic combination plays at equal loudness.
function buildHarmonicWave(ctx, amplitudes) {
  const real = new Float32Array(WAVE_HARMONICS + 1);
  const imag = new Float32Array(WAVE_HARMONICS + 1);
  for (let i = 0; i < Math.min(amplitudes.length, WAVE_HARMONICS); i++) {
    imag[i + 1] = amplitudes[i];
  }
  let peak = 0;
  const N = 2048;
  for (let k = 0; k < N; k++) {
    const th = (2 * Math.PI * k) / N;
    let v = 0;
    for (let n = 1; n <= WAVE_HARMONICS; n++) v += imag[n] * Math.sin(n * th);
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  if (peak > 1e-9) {
    const s = 1 / peak;
    for (let n = 0; n <= WAVE_HARMONICS; n++) imag[n] *= s;
  }
  return ctx.createPeriodicWave(real, imag);
}

/* ---- Oscillator stack ----
   A note is a mix of OSC_STACK.layers. Each layer gets its own oscillator and
   mix gain, chained osc → mixGain → the shared envelope gain (which carries the
   amplitude envelope, so all the envelope scheduling below is untouched). The
   mix gain carries only the layer's time-varying mix weight. */
// Built PeriodicWaves are cached by their harmonic content so a repeated layer
// (same preset or custom amplitudes) reuses the wave instead of rebuilding it
// for every note.
const layerWaveCache = new Map();
function layerWaveKey(layer) {
  if (layer.presetId) return 'p:' + layer.presetId;
  let key = 'c:';
  for (let i = 0; i < HARMONIC_COUNT; i++) {
    key += (i ? ',' : '') + Math.round((layer.amplitudes[i] || 0) * 1000);
  }
  return key;
}
function layerWave(ctx, layer) {
  const key = layerWaveKey(layer);
  let w = layerWaveCache.get(key);
  if (!w) {
    w = buildHarmonicWave(ctx, layerWaveCoeffs(layer));
    // Cap the cache: drawing a spectrum can churn out many waves in a session.
    // In-flight oscillators keep their own references, so evicting old entries
    // never silences a note that is already scheduled.
    if (layerWaveCache.size >= 256) layerWaveCache.clear();
    layerWaveCache.set(key, w);
  }
  return w;
}

// Build the oscillator layers for a note (osc → voiceGain → envGain). Each
// layer spawns one oscillator per voice (fundamental + duplicates); all of a
// layer's voices share its normalized mix gain, scaled by the voice's own
// normalized level. Parallel arrays describe each oscillator:
//   oscLayer[i]  — index of the owning layer
//   oscVoice[i]  — the voice spec (null = fundamental)
//   oscOffset[i] — static pitch offset in semitones (voice st + cents)
//   oscLvl[i]    — normalized gain multiplier for this voice
function buildLayerStack(ctx, envGain) {
  const oscs = [], mixGains = [], mixParams = [];
  const oscLayer = [], oscVoice = [], oscOffset = [], oscLvl = [];
  const g0 = layerGainsAt(0);
  for (let i = 0; i < OSC_STACK.layers.length; i++) {
    const layer = OSC_STACK.layers[i];
    if (layer && layer.muted) continue;   // muted layer: no oscillators at all
    const wave = layerWave(ctx, layer);
    const lvls = normalizedVoiceLevels(layer);
    const group = layerPlayableVoices(layer);   // fundamental + unmuted voices
    for (let j = 0; j < group.length; j++) {
      const v = group[j];
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = 440;
      const g = ctx.createGain();
      g.gain.value = g0[i] * lvls[j];
      osc.connect(g);
      g.connect(envGain);
      oscs.push(osc);
      mixGains.push(g);
      mixParams.push(g.gain);
      oscLayer.push(i);
      oscVoice.push(v);
      oscOffset.push(v ? voiceStOffset(v) : 0);
      oscLvl.push(lvls[j]);
    }
  }
  return { oscs, mixGains, mixParams, oscLayer, oscVoice, oscOffset, oscLvl };
}

// Start every oscillator at t0 (and stop at stopAt, when provided — live notes
// schedule their own stop at release). Each oscillator plays the note's pitch
// plus any static offset its voice carries.
function startLayerStack(stack, t0, freq, stopAt) {
  for (let i = 0; i < stack.oscs.length; i++) {
    stack.oscs[i].frequency.value = freqShifted(freq, stack.oscOffset[i]);
    stack.oscs[i].start(t0);
    if (stopAt != null) stack.oscs[i].stop(stopAt);
  }
}

// Duration of the release section (the design tail after the hold end).
function releaseMs() {
  return compsMs(ENVELOPE.components.slice(ENVELOPE.beginReleaseIndex));
}

// Design body length (hold end) — the canonical body used by the curve markers.
function designBodyMs() {
  return designTimeline().bodyMs;
}

// Schedule each layer's mix across the whole note (wait-mode and the fixed-length
// one-shot chimes): sample each layer's normalized mix curve over t0..tEnd and
// play it with a value curve (same pattern as the envelope body scheduling).
// The curve is sampled against the note's body/release split (when given) so the
// drawn features line up with the HOLD/CUT/REL markers; one-shots sample it
// uniformly.
function scheduleLayerMix(stack, t0, tEnd, actualBodyMs, relMs) {
  const dur = Math.max(0.004, tEnd - t0);
  const N = 64;
  const gains = [];
  const split = actualBodyMs != null && relMs != null && (actualBodyMs + relMs) > 0;
  const dBody = designBodyMs();
  for (let k = 0; k < N; k++) {
    const audioMs = (k / (N - 1)) * dur * 1000;
    const prog = split ? mixProgForTimes(audioMs, actualBodyMs, relMs, dBody) : k / (N - 1);
    gains.push(layerGainsAt(prog));
  }
  for (let i = 0; i < stack.mixParams.length; i++) {
    const p = stack.mixParams[i];
    const layerIdx = stack.oscLayer[i], lvl = stack.oscLvl[i];
    const curve = new Float32Array(N);
    for (let k = 0; k < N; k++) curve[k] = gains[k][layerIdx] * lvl;
    p.setValueAtTime(curve[0], t0);
    p.setValueCurveAtTime(curve, t0 + 0.002, dur - 0.002);
  }
}

// Chase the live mix params toward their current progress value. The body runs
// from note start to the release point (max of the drawn time and the early-cut
// marker), then the release section, mapped onto the same curve axis.
function updateLiveMixTargets(ds, at, tc) {
  const actualBodyMs = Math.max(ds.totalMs || 0, earlyCutMs());
  const relMs = releaseMs();
  const gains = layerGainsAt(mixProgForTimes(liveFadeProgress(ds), actualBodyMs, relMs, designBodyMs()));
  for (let i = 0; i < ds.mixParams.length; i++) {
    ds.mixParams[i].setTargetAtTime(gains[ds.oscLayer[i]] * ds.oscLvl[i], at, tc);
  }
}

// On release, each live layer's mix continues through the release section of its
// drawn curve (from the release-begin fraction up to the note-end value), so the
// morph completes through the tail exactly as it does in wait mode.
function rampLayerMixToEnd(ds, startT, ms) {
  const actualBodyMs = Math.max(ds.totalMs || 0, earlyCutMs());
  const relMs = releaseMs();
  const dBody = designBodyMs();
  const N = 32;
  for (let i = 0; i < (ds.mixParams || []).length; i++) {
    const p = ds.mixParams[i];
    const layerIdx = ds.oscLayer[i], lvl = ds.oscLvl[i];
    const curve = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const relElapsed = relMs > 0 ? ms * k / (N - 1) : ms;
      curve[k] = layerGainsAt(mixProgForTimes(actualBodyMs + relElapsed, actualBodyMs, relMs, dBody))[layerIdx] * lvl;
    }
    p.cancelScheduledValues(startT);
    p.setValueAtTime(Math.max(1e-4, p.value), startT);
    p.setValueCurveAtTime(curve, startT + 0.002, Math.max(0.004, ms / 1000) - 0.002);
  }
}

/* ---- Pitch envelopes ----
   Each layer's oscillator frequency follows its active pitch envelope (the
   master when set, else its own), sampled across the same body/release timeline
   as the mix curves so drawn features line up with HOLD/CUT/REL. Layers
   without an envelope stay at their base pitch. */

// One-shot path (wait mode, chimes, previews): sample each layer's pitch
// envelope across t0..tEnd into a frequency value curve.
function scheduleLayerPitch(stack, t0, tEnd, baseFreq, bodyMs, relMs) {
  const dur = Math.max(0.004, tEnd - t0);
  const N = 64;
  const split = bodyMs != null && relMs != null && (bodyMs + relMs) > 0;
  const dBody = designBodyMs();
  for (let i = 0; i < stack.oscs.length; i++) {
    const env = activePitchEnv(stack.oscLayer[i]);
    if (!env) continue;
    const p = stack.oscs[i].frequency;
    p.cancelScheduledValues(t0);
    const off = stack.oscOffset[i];
    const curve = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const audioMs = (k / (N - 1)) * dur * 1000;
      const prog = split ? mixProgForTimes(audioMs, bodyMs, relMs, dBody) : k / (N - 1);
      curve[k] = freqShifted(baseFreq, pitchStAt(env, prog) + off);
    }
    p.setValueAtTime(curve[0], t0);
    p.setValueCurveAtTime(curve, t0 + 0.002, dur - 0.002);
  }
}

// Chase each live layer's frequency toward its active pitch envelope's current
// value (same progress mapping as the mix targets).
function updateLivePitchTargets(ds, at, tc) {
  if (!ds.oscs || !ds.baseFreq) return;
  const actualBodyMs = Math.max(ds.totalMs || 0, earlyCutMs());
  const relMs = releaseMs();
  const prog = mixProgForTimes(liveFadeProgress(ds), actualBodyMs, relMs, designBodyMs());
  for (let i = 0; i < ds.oscs.length; i++) {
    const env = activePitchEnv(ds.oscLayer[i]);
    if (!env) continue;
    ds.oscs[i].frequency.setTargetAtTime(freqShifted(ds.baseFreq, pitchStAt(env, prog) + ds.oscOffset[i]), at, tc);
  }
}

// On release, each live layer's frequency continues through the release section
// of its pitch envelope (from the release-begin fraction to the note end), so
// the bend completes through the tail exactly as it does in wait mode.
function rampPitchToEnd(ds, startT, ms) {
  if (!ds.oscs) return;
  const actualBodyMs = Math.max(ds.totalMs || 0, earlyCutMs());
  const relMs = releaseMs();
  const dBody = designBodyMs();
  const N = 32;
  for (let i = 0; i < ds.oscs.length; i++) {
    const env = activePitchEnv(ds.oscLayer[i]);
    if (!env) continue;
    const p = ds.oscs[i].frequency;
    const off = ds.oscOffset[i];
    const curve = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const relElapsed = relMs > 0 ? ms * k / (N - 1) : ms;
      curve[k] = freqShifted(ds.baseFreq, pitchStAt(env, mixProgForTimes(actualBodyMs + relElapsed, actualBodyMs, relMs, dBody)) + off);
    }
    p.cancelScheduledValues(startT);
    p.setValueAtTime(p.value, startT);
    p.setValueCurveAtTime(curve, startT + 0.002, Math.max(0.004, ms / 1000) - 0.002);
  }
}

/* ---- Preview note ----
   A dedicated, self-contained scheduler for the test/preview sound. It plays
   the CURRENT sound design (oscillator stack + envelope + mix curves) at the
   EXACT requested pitch, with fresh nodes every time and no interaction with
   gesture scheduling, playback tracking, or retrigger state — so repeated
   previews can never accumulate voices or drift in pitch. */
// Every preview's nodes are tracked here so the next preview can retire them.
// Without this, rapid taps layer full-length notes of the same pitch; stacked
// harmonic-rich voices read as a rising, denser tone even though the badge
// (and each preview's fundamental) never changes.
const previewVoices = [];

// Retire every ringing preview voice: fade its envelope gain to zero, stop its
// oscillators, and disconnect — so a new preview always starts from silence.
function stopPreviewVoices() {
  for (const v of previewVoices.slice()) {
    try {
      const now = audioCtx.currentTime;
      clearTimeout(v.cleanupTimer);
      const g = v.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.03);
      for (const o of v.oscs) { try { o.stop(now + 0.06); } catch (e) {} }
      setTimeout(() => {
        try {
          v.oscs.forEach(o => o.disconnect());
          v.mixGains.forEach(x => x.disconnect());
          v.gain.disconnect();
        } catch (e) {}
      }, 200);
    } catch (e) {}
  }
  previewVoices.length = 0;
}

function previewNote(pitch) {
  initAudio();
  resumeAudio();
  if (!audioCtx || !masterGain) return;
  stopGestureNote();
  stopPreviewVoices();
  const freq = noteToFreq(pitch);
  const t0 = audioCtx.currentTime + 0.02;
  const bodyMs = earlyCutMs();
  const relMs = releaseMs();
  const base = Math.max(0.35, baseVolumeFromY(H * 0.55));

  // Amplitude envelope: the body (through the early-cut marker) then the release.
  const gain = audioCtx.createGain();
  const g = gain.gain;
  g.setValueAtTime(0, t0);
  const NB = 64;
  const body = new Float32Array(NB);
  for (let k = 0; k < NB; k++) body[k] = Math.max(0, base * relValueBody(ENVELOPE, bodyMs * k / (NB - 1), true));
  const bodyDur = Math.max(0.004, bodyMs / 1000);
  g.setValueCurveAtTime(body, t0 + 0.002, bodyDur - 0.002);
  let tRel = t0 + 0.002 + (bodyDur - 0.002);
  if (relMs > 0) {
    const relComps = ENVELOPE.components.slice(ENVELOPE.beginReleaseIndex);
    const seed = relValueBody(ENVELOPE, bodyMs, true);
    const tail = new Float32Array(32);
    for (let k = 0; k < tail.length; k++) tail[k] = Math.max(0, base * relValueAtList(relComps, relMs * k / (tail.length - 1), seed));
    g.setValueAtTime(tail[0], tRel);
    g.setValueCurveAtTime(tail, tRel + 0.002, relMs / 1000);
    tRel += 0.002 + relMs / 1000;
  }
  const tEnd = tRel + FADE_MS / 1000;
  g.linearRampToValueAtTime(0, tEnd);
  gain.connect(masterGain);

  const stack = buildLayerStack(audioCtx, gain);
  scheduleLayerMix(stack, t0, tEnd, bodyMs, relMs);
  startLayerStack(stack, t0, freq, tEnd);
  scheduleLayerPitch(stack, t0, tEnd, freq, bodyMs, relMs);

  const voice = { oscs: stack.oscs, mixGains: stack.mixGains, gain, cleanupTimer: null };
  previewVoices.push(voice);
  voice.cleanupTimer = setTimeout(() => {
    try {
      stack.oscs.forEach(o => o.disconnect());
      stack.mixGains.forEach(x => x.disconnect());
      gain.disconnect();
    } catch (e) {}
    const i = previewVoices.indexOf(voice);
    if (i >= 0) previewVoices.splice(i, 1);
  }, (tEnd - t0 + 0.5) * 1000);
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

  const stack = buildLayerStack(audioCtx, gain);
  scheduleLayerMix(stack, t0, tEnd);
  startLayerStack(stack, t0, noteToFreq(s.note), tEnd);
  scheduleLayerPitch(stack, t0, tEnd, noteToFreq(s.note), null, null);

  setTimeout(() => {
    try { stack.oscs.forEach(o => o.disconnect()); stack.mixGains.forEach(g => g.disconnect()); gain.disconnect(); } catch (e) {}
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
      const oscs = n.oscs || (n.osc ? [n.osc] : []);
      for (const o of oscs) { try { o.stop(now + 0.05); } catch (e) {} }
      setTimeout(() => {
        try {
          oscs.forEach(o => o.disconnect());
          (n.mixGains || []).forEach(g => g.disconnect());
          if (node && node.disconnect) node.disconnect();
        } catch (e) {}
      }, 200);
    } catch (e) {}
  }
  gestureNotes = [];
  playbacks = [];
}

// Fade one note out over `fadeMs` and stop it, then disconnect after the fade.
function quickFadeNote(n, fadeMs) {
  try {
    const now = audioCtx.currentTime;
    clearTimeout(n.cleanupTimer);
    // Live notes store the AudioParam in .gain (node in .gainNode); wait-mode
    // notes store the GainNode in .gain. Resolve the AudioParam.
    const param = n.gain && n.gain.gain ? n.gain.gain : n.gain;
    const node = n.gainNode || n.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(0, now + fadeMs / 1000);
    const oscs = n.oscs || (n.osc ? [n.osc] : []);
    for (const o of oscs) { try { o.stop(now + fadeMs / 1000 + 0.05); } catch (e) {} }
    setTimeout(() => {
      try {
        oscs.forEach(o => o.disconnect());
        (n.mixGains || []).forEach(g => g.disconnect());
        if (node && node.disconnect) node.disconnect();
      } catch (e) {}
    }, fadeMs + 200);
  } catch (e) {}
}

// A new note on the same pitch steals the voice already ringing there, so
// repeated taps on one band restrike instead of stacking voices (stacking is
// what made rapid tapping sound laggy — voices piled up through the
// compressor). The old voice fades in ~35 ms and its green playback path
// disappears; the new note starts its attack cycle fresh with its own path
// intact. Different pitches stay polyphonic.
function retriggerPitch(pitch, keep) {
  for (const n of gestureNotes.slice()) {
    if (n === keep || n.pitch !== pitch) continue;
    quickFadeNote(n, 35);
    // A live drag still drawing on this pitch is superseded: drop it so it
    // can't keep scheduling, and leave its pointer to come back up empty.
    if (n.pointerId != null && dragStates.has(n.pointerId)) {
      dragStates.delete(n.pointerId);
      n.gain = null;
      n.finished = true;
    }
    // Remove ONLY the stolen note's own playback path — never the new note's
    // (which is already in playbacks by the time the retrigger runs).
    const pb = n.playback;
    if (pb) {
      const i = playbacks.indexOf(pb);
      if (i >= 0) playbacks.splice(i, 1);
    }
    unregisterNote(n);
  }
}

/* ---- Gesture note audio ----
   WAIT MODE (schedulePathAudio): the whole note is played with a single
   setValueCurveAtTime over 128 volume samples (attack fade baked in) plus a
   fade-out tail.
   LIVE MODE (initLivePathAudio + scheduleLivePoint + tickLiveHold +
   finishLivePathNote): the note begins the moment the finger touches down; each
   newly-recorded point is scheduled at the audio time its horizontal travel
   implies, with setTargetAtTime catch-up when the circle catches the fingertip. */

function schedulePathAudio(ds, totalMs, pb) {
  if (!audioCtx || !masterGain) return;
  const t0 = audioCtx.currentTime;
  // Retrigger: a new note on this pitch steals the voice already ringing there,
  // so rapid taps on one band restrike instead of stacking voices.
  const pitch = ds.pitchOverride || pitchFor(ds.startX, ds.startY);
  retriggerPitch(pitch, null);
  // The body always plays through the early-cut marker: a tap or short note is
  // extended so every component up to the cut point plays before the release
  // section starts.
  const bodyDurMs = Math.max(totalMs, earlyCutMs());
  const pathDur = bodyDurMs / 1000;

  // Body: the base volume along the path × the envelope's pre-release shape
  // (one pass — once the body domain is exhausted the value holds at the hold
  // window's end), scheduled as a sampled curve.
  const body = buildVolumeCurve(ds.pts, ds.cumTime, bodyDurMs, 128);
  const gain = audioCtx.createGain();
  const g = gain.gain;
  const curveStart = t0 + 0.002;   // tiny offset: no automation overlap with the setValue below
  g.setValueAtTime(body[0], t0);
  g.setValueCurveAtTime(body, curveStart, pathDur);
  const curveEnd = curveStart + pathDur;

  // Release tail: the release section, scaled to the path-end base volume. It
  // continues from whatever the body ended at (a tap's body ends mid-attack),
  // not the release's design start, so the transition is a smooth continuation
  // with no jump. The seed is the body's end as a fraction of the end base.
  const relComps = ENVELOPE.components.slice(ENVELOPE.beginReleaseIndex);
  const relMs = compsMs(relComps);
  if (relMs > 0) {
    const endBase = baseVolumeFromY(ds.pts[ds.pts.length - 1].y);
    const bodyEnd = body[body.length - 1];
    const relSeed = endBase > 0.0001 ? Math.max(0, Math.min(1, bodyEnd / endBase)) : 0;
    const tail = new Float32Array(64);
    for (let k = 0; k < tail.length; k++) {
      const t = relMs * k / (tail.length - 1);
      tail[k] = endBase * relValueAtList(relComps, t, relSeed);
    }
    const relStart = curveEnd + 0.002;
    g.setValueAtTime(tail[0], curveEnd);
    g.setValueCurveAtTime(tail, relStart, relMs / 1000);
  }
  const tEnd = curveEnd + relMs / 1000 + FADE_MS / 1000;
  g.linearRampToValueAtTime(0, tEnd);
  gain.connect(masterGain);

  const stack = buildLayerStack(audioCtx, gain);
  scheduleLayerMix(stack, t0, tEnd, bodyDurMs, relMs);
  startLayerStack(stack, t0, noteToFreq(pitch), tEnd);
  scheduleLayerPitch(stack, t0, tEnd, noteToFreq(pitch), bodyDurMs, relMs);
  const note = { oscs: stack.oscs, mixGains: stack.mixGains, gain, gainParam: g, cleanupTimer: null, pitch, playback: pb };
  gestureNotes.push(note);
  setTimeout(() => {
    try { stack.oscs.forEach(o => o.disconnect()); stack.mixGains.forEach(x => x.disconnect()); gain.disconnect(); } catch (e) {}
    unregisterNote(note);
  }, (tEnd - t0 + 0.5) * 1000);
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
  const ctx0 = audioCtx.currentTime;
  // A new note on a pitch steals the voice already ringing there (retrigger),
  // so rapid taps on one band restrike instead of stacking voices.
  ds.pitch = pitchFor(ds.startX, ds.startY);
  retriggerPitch(ds.pitch, ds);
  const gain = audioCtx.createGain();
  const g = gain.gain;
  const baseVol0 = baseVolumeFromY(ds.pts[0].y);
  g.setValueAtTime(baseVol0 * relValueBody(ENVELOPE, 0, true), ctx0);
  gain.connect(masterGain);
  const stack = buildLayerStack(audioCtx, gain);
  const freq = noteToFreq(ds.pitch);
  ds.baseFreq = freq;   // pitch envelopes shift relative to this
  for (const osc of stack.oscs) { osc.frequency.value = freq; osc.start(ctx0); }
  ds.startedAt = performance.now();
  ds.ctx0 = ctx0;
  ds.gain = g;          // the AudioParam (gain.gain) — scheduling/ramps go through this
  ds.gainNode = gain;   // the GainNode itself — used for cleanup/disconnect
  ds.oscs = stack.oscs;
  ds.mixGains = stack.mixGains;
  ds.mixParams = stack.mixParams;
  ds.oscLayer = stack.oscLayer;
  ds.oscLvl = stack.oscLvl;
  ds.oscOffset = stack.oscOffset;
  ds.osc = stack.oscs[0];
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
  updateLiveMixTargets(ds, now, 0.06);
  updateLivePitchTargets(ds, now, 0.06);
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
  updateLiveMixTargets(ds, at, 0.06);
  updateLivePitchTargets(ds, at, 0.06);
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
  const cutMs = earlyCutMs();
  const relComps = ENVELOPE.components.slice(ENVELOPE.beginReleaseIndex);
  const relMs = compsMs(relComps);
  const path = buildGesturePlaybackPath(ds.pts, ds.cumTime, ds.totalMs || 0, relMs, cutMs);
  // Anchor the visual timeline at the release moment: keep the circle where it
  // is (its path-time playhead) but make the release tail run from now. Without
  // this a stationary press held past the note length would already be "done"
  // when the finger lifts, so its tail would never be drawn.
  const pb = ds.playback;
  const playheadMs = pb.pts && pb.pts.length
    ? cumAtState(pb.cumTime, pathStateAtTime(pb.pts, pb.cumTime, performance.now() - pb.startedAt))
    : 0;
  ds.playback.released = true;
  ds.playback.totalMs = Math.max(totalMs, cutMs) + relMs;
  ds.playback.relMs = relMs;
  ds.playback.pts = path.pts;
  ds.playback.cumTime = path.cum;
  ds.playback.tailEnd = path.tailEnd;
  ds.playback.startedAt = performance.now() - playheadMs;
  const now = audioCtx.currentTime;
  const elapsed = performance.now() - ds.startedAt;
  updateLiveMixTargets(ds, now, 0.05);
  updateLivePitchTargets(ds, now, 0.05);
  if (elapsed >= ds.totalMs) {
    // The circle already caught the fingertip (the drawn body finished). If the
    // envelope hasn't played through the early-cut marker yet — a quick tap or
    // a lift inside the body — extend the body through the cut point so the
    // components up to it all play before the release section.
    const prog = liveFadeProgress(ds);
    if (prog < cutMs) {
      const baseVol = baseVolumeFromY(ds.pts[ds.pts.length - 1].y);
      const N = 32;
      const curve = new Float32Array(N);
      curve[0] = Math.max(1e-4, ds.gain.value);
      for (let k = 1; k < N; k++) {
        const t = prog + (cutMs - prog) * k / (N - 1);
        curve[k] = baseVol * relValueBody(ENVELOPE, t, true);
      }
      ds.gain.cancelScheduledValues(now);
      ds.gain.setValueAtTime(Math.max(1e-4, ds.gain.value), now);
      ds.gain.setValueCurveAtTime(curve, now + 0.002, (cutMs - prog) / 1000);
      scheduleReleaseTail(ds, curve[curve.length - 1], now + 0.002 + (cutMs - prog) / 1000);
    } else {
      // The body already played through the cut: play the release section from
      // the held level, then fade.
      scheduleReleaseTail(ds, ds.gain.value, now);
    }
  } else {
    // Playback is still behind the fingertip: the cut-and-release must not fire
    // yet — there is still drawn line to play. It only fires once the line runs
    // out before the cut marker; then the remainder is added to the line and
    // the release section follows.
    if (ds.totalMs < cutMs) {
      // The line will run out before the cut: extend the body through the cut
      // point (the remainder), then release from the level at the cut.
      const baseVol = baseVolumeFromY(ds.pts[ds.pts.length - 1].y);
      const p0 = ds.totalMs;
      const t0 = Math.max(now, ds.ctx0 + p0 / 1000);
      const N = 32;
      const curve = new Float32Array(N);
      curve[0] = Math.max(1e-4, ds.gainLevel || ds.gain.value);
      for (let k = 1; k < N; k++) {
        const t = p0 + (cutMs - p0) * k / (N - 1);
        curve[k] = baseVol * relValueBody(ENVELOPE, t, true);
      }
      ds.gain.setValueCurveAtTime(curve, t0 + 0.002, (cutMs - p0) / 1000);
      scheduleReleaseTail(ds, curve[curve.length - 1], t0 + 0.002 + (cutMs - p0) / 1000);
    } else {
      // The line already reaches the cut: no cut needed — let the whole drawn
      // line play out to its end, then start the release section where the
      // body runs out so every drawn point gets used.
      const endT = Math.max(now, ds.ctx0 + ds.totalMs / 1000);
      scheduleReleaseTail(ds, ds.gainLevel, endT);
    }
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
  const oscs = ds.oscs || (ds.osc ? [ds.osc] : []);
  g.cancelScheduledValues(Math.max(now, startT));
  g.setValueAtTime(Math.max(1e-4, startLevel), startT);
  if (relMs > 0) {
    // The release section must stay relative to the gesture's Y (base volume),
    // exactly like the body. `startLevel` is an ABSOLUTE gain (base × envelope),
    // so convert it back to a relative seed before sampling, then scale the
    // sampled curve by the base volume — otherwise the release ramps toward the
    // component's raw relative end (0..1) and climbs to full scale regardless
    // of the screen position.
    const baseVol = ds.pts && ds.pts.length ? baseVolumeFromY(ds.pts[ds.pts.length - 1].y) : 0;
    const relSeed = baseVol > 0.0001 ? Math.max(0, Math.min(1, startLevel / baseVol)) : 0;
    const rel = sampleComps(relComps, 32, relSeed);
    const curve = rel.curve;
    if (baseVol > 0.0001) {
      for (let k = 0; k < curve.length; k++) curve[k] *= baseVol;
    }
    g.setValueCurveAtTime(curve, startT + 0.002, relMs / 1000);
    const stopT = startT + relMs / 1000 + FADE_MS / 1000;
    g.linearRampToValueAtTime(0, stopT);
    rampLayerMixToEnd(ds, startT, relMs);
    rampPitchToEnd(ds, startT, relMs);
    for (const o of oscs) { try { o.stop(stopT + 0.05); } catch (e) {} }
    scheduleLiveCleanup(ds, stopT);
  } else {
    const stopT = startT + FADE_MS / 1000;
    g.linearRampToValueAtTime(0, stopT);
    rampLayerMixToEnd(ds, startT, FADE_MS);
    rampPitchToEnd(ds, startT, FADE_MS);
    for (const o of oscs) { try { o.stop(stopT + 0.05); } catch (e) {} }
    scheduleLiveCleanup(ds, stopT);
  }
}

function scheduleLiveCleanup(ds, t) {
  clearTimeout(ds.cleanupTimer);
  ds.cleanupTimer = setTimeout(() => {
    try {
      (ds.oscs || []).forEach(o => o.disconnect());
      (ds.mixGains || []).forEach(g => g.disconnect());
      if (ds.gainNode) ds.gainNode.disconnect();
    } catch (e) {}
    unregisterNote(ds);
  }, (t - audioCtx.currentTime + 0.5) * 1000);
}

// Forget a finished gesture note so it isn't cancelled later.
function unregisterNote(n) {
  const i = gestureNotes.indexOf(n);
  if (i >= 0) gestureNotes.splice(i, 1);
}
