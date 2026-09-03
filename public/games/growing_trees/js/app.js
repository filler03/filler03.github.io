/* ============================================================
   app.js — core setup, shared state, helpers, constants
   Loaded FIRST. Everything in here is shared across the other
   modules via globals (classic scripts, no build step).
   ============================================================ */

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');

var W, H, HORIZON;
const statHud = document.getElementById('statHud');

var playbacks = [];      // { pts, cumTime, totalMs, startedAt, released }
var gestureNotes = [];   // { osc, gain, cleanupTimer } running gesture-note audio
var previewPlayhead = null;   // { t0, bodyMs, relMs, totalMs, endAt } drives the sound-creator playhead

var mode = 'plant';      // 'plant' | 'nav' | 'creator' (full-screen sound editor) | 'flow' (full-screen sound flow editor)
var creatorActive = false;   // sound-creator mode is open (declared early: main.js reads it)
var flowActive = false;      // sound-flow editor mode is open (declared early: main.js reads it)
var navState = null;     // single-finger pan drag in nav mode
var dragStates = new Map();  // plant gestures, one per pointer (multi-finger)
var pinchState = null;   // { dist } two-finger pinch in nav mode
var pointers = new Map();

var cam = { x: 0, y: 0, zoom: 1 };   // filled in below after resize

let audioCtx = null;
let masterGain = null;

/* Stage coordinates map pointer positions to canvas space. The canvas is
   shrunk to the safe area (below), so stage coords subtract the safe-area
   offsets to stay aligned with the drawing layout. */
var SAFE = { top: 0, left: 0, right: 0, bottom: 0 };   // safe-area insets (px)
function stageX(e) { return e.clientX - SAFE.left; }
function stageY(e) { return e.clientY - SAFE.top; }

// Measure the safe-area insets (notch/island/home indicator) with a probe
// element pinned to the safe edges. env(safe-area-inset-*) resolves inside
// fixed-position inset values, so the probe's rect reveals exactly how far the
// visible area sits from each screen edge. Non-notched browsers resolve 0.
function safeArea() {
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;'
    + 'top:env(safe-area-inset-top,0px);left:env(safe-area-inset-left,0px);'
    + 'bottom:env(safe-area-inset-bottom,0px);right:env(safe-area-inset-right,0px);';
  document.body.appendChild(p);
  const r = p.getBoundingClientRect();
  p.remove();
  return {
    top: Math.max(0, Math.round(r.top)),
    left: Math.max(0, Math.round(r.left)),
    bottom: Math.max(0, Math.round(window.innerHeight - r.bottom)),
    right: Math.max(0, Math.round(window.innerWidth - r.right)),
  };
}

// iOS can fire resize with transient/degenerate sizes while a rotation or
// toolbar change is settling. A wrong value can STICK — the final, correct
// resize event sometimes never arrives — leaving the canvas shorter than the
// visible screen, which cuts off the bottom of the scene (e.g. the color
// bands vanish before the bottom edge). So every resize re-checks the
// viewport size a moment later, once things have settled, and re-applies it
// if it drifted.
let resizeVerifyTimer = null;
var VIEW_W = 0, VIEW_H = 0;   // full viewport size (including the safe area)
function scheduleSizeVerify() {
  clearTimeout(resizeVerifyTimer);
  resizeVerifyTimer = setTimeout(() => {
    const w = window.innerWidth, h = window.innerHeight;
    if (w !== VIEW_W || h !== VIEW_H) resize();
  }, 400);
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (!w || !h || !isFinite(w) || !isFinite(h)) return;
  VIEW_W = w; VIEW_H = h;
  SAFE = safeArea();
  // Keep the canvas clear of the notch/island and the home indicator: shrink
  // to the safe area and offset it, so the page background shows behind the
  // hardware instead of interactive UI.
  canvas.style.left = SAFE.left + 'px';
  canvas.style.top = SAFE.top + 'px';
  const w2 = Math.max(1, w - SAFE.left - SAFE.right);
  const h2 = Math.max(1, h - SAFE.top - SAFE.bottom);
  if (w2 === W && h2 === H) return;
  W = canvas.width  = w2;
  H = canvas.height = h2;
  HORIZON = H * 0.56;              // where ground meets sky (matches CSS)
  scheduleSizeVerify();
}
window.addEventListener('resize', resize);
// Rotation itself isn't always followed by a settle-time resize event, so
// schedule an explicit re-check when the orientation flips.
window.addEventListener('orientationchange', scheduleSizeVerify);
resize();

/* ---------- Small shared helpers ---------- */
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const clone = o => JSON.parse(JSON.stringify(o));
// Append an alpha channel (0..1) to a #rrggbb color, for translucent fills.
function withAlpha(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/* ---------- Shared constants ---------- */
const TIME_PER_W = 50;    // ms of time per % of screen width at 1x time multiplier
const MIN_GESTURE_MS = 80;  // shortest note a gesture can produce (a vertical line ~ 0 ms)
const LINGER_MS = 800;      // how long a finished gesture's green path stays before fading
const RELEASE_TAIL_STEPS = 14;  // subdivisions of the appended release tail
const FADE_MS = 150;      // smooth fade-out to 0 when a sequence ends (no clip)
const PAN_SENS = 2;          // camera movement multiplier
const PINCH_SENS = 0.4;      // pinch zoom dampening (<1 = less sensitive)

// Pitch scale: 7-note diatonic major. Each degree's semitone offset (1-indexed
// via the mapping helpers) comes from SCALE_DEGREES[degree - 1].
const SCALE_DEGREES = [0, 2, 4, 5, 7, 9, 11];
// Color per scale degree, for the on-screen pitch zones: 1 red, 2 orange,
// 3 yellow, 4 green, 5 light blue, 6 dark blue, 7 pink.
const DEGREE_COLORS = ['#c62828', '#f57c00', '#f9a825', '#43a047', '#4fc3f7', '#1e88e5', '#f06292'];
const ZONE_FILL_ALPHA = 0.15;   // faintness of a degree's color band (0..1)
const OCTAVE_BOUND_ALPHA = 0.35;  // slightly stronger line where a new octave begins

// Base volume (gain) comes from where the gesture sits vertically on screen:
// top is loudest, bottom is quietest. The top 10% of the screen is the
// full-volume zone (the upper gain) and the bottom 10% the lowest-volume zone
// (the lower gain); the middle 80% sweeps linearly between the two. The
// relative volume — the percentage of this base volume actually being output —
// comes from the attack/decay/release components and drives the gesture line's
// thickness.
// Gain is a linear amplitude in 0..1 (1.0 = full scale, the loudest a voice can
// play). `bottom` is the gain at the bottom of the screen, `top` the gain at
// the top; both are set directly by the user's lower/upper gain sliders.
const DEFAULT_VOLUME = { bottom: 0.01, top: 0.5 };
var VOLUME = clone(DEFAULT_VOLUME);

function volumeTop() {
  return VOLUME.top;
}

function baseVolumeFromY(sy) {
  const t = clamp01(1 - sy / H);   // 1 at the top of the screen, 0 at the bottom
  return mix(VOLUME.bottom, volumeTop(), clamp01((t - 0.1) / 0.8));
}
function yForBaseVolume(v) {
  const span = volumeTop() - VOLUME.bottom;
  if (span === 0) return H / 2;
  const r = clamp01((v - VOLUME.bottom) / span);
  // The top/bottom 10% of the screen are flat full/low zones, so gains at the
  // top/bottom of the scale sit at the center of their zone.
  if (r >= 1) return H * 0.05;
  if (r <= 0) return H * 0.95;
  return H * (1 - (0.1 + r * 0.8));
}

// Top-left HUD emoji markers.
const EMOJI_TIME = '⏳';   // hourglass marks time values
const EMOJI_VOL  = '🔊';   // speaker marks volume values

/* ---------- Defaults (persisted to localStorage) ---------- */
const DEFAULT_GESTURE = {
  waitForGesture: false,   // when on, sound plays only after the whole gesture is drawn
  timeMult: 1,             // ÷ the base time rate (TIME_PER_W ms per % of width)
};
var GESTURE = clone(DEFAULT_GESTURE);

/* ---------- Sound envelope ----------
   A note's value (volume today) is defined by an envelope: an ordered list of
   components the user can name, add, delete, and reorder. Each component ramps
   the relative value (a % of the note's base value) from startValue to
   endValue over `duration` ms. Start values chain: every component starts where
   the previous one ended, so only the first component has an independent start.
   Markers on the list drive the note's lifecycle:
   - holdStartIndex..holdEndIndex: this range loops while the finger stays down
     (a single "sustain" component, or several).
   - beginReleaseIndex: always holdEndIndex + 1, so the release section begins
     immediately after the hold and no component is ever skipped.
   - earlyCutIndex: when the finger lifts early (the gesture is still playing),
     the body plays through this component, then jumps to the release section.
     The last body component (the default) means the whole body plays out.
   Playback always enters a component from the value that is currently playing —
   a chained start, a hold-loop wrap, or a jump to the release section — so every
   transition is a smooth continuation instead of a step to a design start. */
const DEFAULT_ENVELOPE = {
  components: [
    { id: 'comp-1', name: 'Attack',  duration: 10,   startValue: 0,   endValue: 100 },
    { id: 'comp-2', name: 'Decay',   duration: 500,  startValue: 100, endValue: 55 },
    { id: 'comp-3', name: 'Ring',    duration: 1500, startValue: 55,  endValue: 28 },
    { id: 'comp-4', name: 'Release', duration: 1200, startValue: 28,  endValue: 0 },
  ],
  beginReleaseIndex: 3,
  holdStartIndex: 1,
  holdEndIndex: 2,
  earlyCutIndex: 2,
  trim: 0,   // whole-envelope vertical offset (relative 0..1 units), like a mixer
};
var ENVELOPE = clone(DEFAULT_ENVELOPE);

// A master envelope's trim: a uniform offset added to its relative value (top of
// the graph = +1, bottom = -1). 0 = the envelope as designed. Clamped so a line
// can't be pushed past the plot's edges.
function envTrim(env) { return Math.max(-1, Math.min(1, +((env && env.trim) || 0))); }

// A layer's trim: the same whole-line vertical offset for a mix curve.
function layerTrim(layer) { return Math.max(-1, Math.min(1, +((layer && layer.trim) || 0))); }

// Chain start values: each component after the first starts where the previous
// one ended, so only the first component holds an independent start value.
function chainStartValues(env) {
  for (let i = 1; i < env.components.length; i++) {
    env.components[i].startValue = env.components[i - 1].endValue;
  }
}

/* ---- Segment line types ----
   Every envelope segment — an envelope component, a mix-curve span, or a
   pitch-envelope span — interpolates from its start value to its end value via
   one of four shapes:
   - 'line':   the straight ramp (the default; old data has no seg at all).
   - 'stairs': N equal-width steps; each holds its level, the last lands on end.
   - 'spring': a damped sine wobble around the ramp, settling on the end point.
   - 'pulse':  like spring but with hard corners (square-wave wobble).
   A segment stores { type, stairs, freq, depth } on its FROM element (the
   component / the segment's start point). stairs = step count (2..16);
   freq = the number of up-and-down wobble cycles across the segment (0.25..16);
   depth = wobble amplitude as a fraction of the curve's full value scale
   (0..1) — the depth is absolute (independent of the segment's rise), while
   the freq is a count of cycles within the segment itself. */
const DEFAULT_SEG = { type: 'line', stairs: 4, freq: 2, depth: 0.15 };

// The validated segment config for an element (one carrying a .seg, or a bare
// seg object). Anything missing falls back to the defaults, so old data reads
// as a straight line.
function segOf(x) {
  const s = (x && typeof x === 'object' && x.seg && typeof x.seg === 'object') ? x.seg : x;
  if (!s || typeof s !== 'object') return DEFAULT_SEG;
  const t = (s.type === 'stairs' || s.type === 'spring' || s.type === 'pulse') ? s.type : 'line';
  return {
    type: t,
    stairs: Math.max(2, Math.min(16, Math.round(+s.stairs || DEFAULT_SEG.stairs))),
    freq: Math.max(0.25, Math.min(16, +s.freq || DEFAULT_SEG.freq)),
    depth: Math.max(0, Math.min(1, +s.depth || DEFAULT_SEG.depth)),
  };
}

// The value at progress p (0..1) through a segment from `from` to `to` (in the
// curve's native units), with `scale` the curve's full value span (1 for the
// normalized volume/mix curves, the semitone range for pitch envelopes). freq
// is the count of wobble cycles across the segment (each cycle is one up and
// one down); depth is a fixed fraction of full scale, so the wobble amplitude
// does not depend on how far the segment rises or falls.
function segValueAt(x, from, to, p, scale) {
  const s = segOf(x);
  const q = clamp01(p);
  if (s.type === 'stairs') {
    const n = Math.max(2, s.stairs);
    return from + (to - from) * clamp01(Math.min(1, Math.floor(q * n) / (n - 1)));
  }
  const base = from + (to - from) * q;
  if (s.type === 'spring' || s.type === 'pulse') {
    const ph = Math.PI * 2 * s.freq * q;
    const w = Math.sin(ph);
    return base + s.depth * scale * (1 - q) * (s.type === 'pulse' ? Math.sign(w) : w);
  }
  return base;
}

/* ---- Envelope math (pure) ----
   Relative component value (0..1) from a 0..100 setting. */
function compValue(c, v) {
  return Math.max(0, Math.min(100, v == null ? 100 : v)) / 100;
}

// Relative value through an ordered component list at time t. Each component
// ramps from the value that was current when it was entered to its own end
// value, so a transition into a component — moving to the next one, wrapping a
// hold loop, or jumping to the release section — always starts from whatever
// the sound is currently playing, never a design start. `seed` is the value
// current at t = 0 (defaults to the first component's start value).
function relValueAtList(comps, t, seed) {
  if (!comps.length) return 1;
  let cur = seed == null ? compValue(comps[0], comps[0].startValue) : seed;
  let acc = 0;
  for (const c of comps) {
    const dur = Math.max(0, c.duration);
    const end = compValue(c, c.endValue);
    if (t < acc + dur) {
      const p = dur > 0 ? (t - acc) / dur : 1;
      return clamp01(segValueAt(c, cur, end, p, 1));
    }
    cur = end;
    acc += dur;
  }
  return cur;
}

function compsMs(comps) {
  return comps.reduce((s, c) => s + c.duration, 0);
}
function envelopeMs(env) {
  return compsMs(env.components);
}

// Start time of the hold loop window and the release section.
function holdStartTime(env) {
  return compsMs(env.components.slice(0, env.holdStartIndex));
}
function holdEndTime(env) {
  return compsMs(env.components.slice(0, env.holdEndIndex + 1));
}

// Relative value over the note's body (everything before the release). With
// `looped`, once the playhead passes the hold window it loops back into it; the
// loop restarts from whatever value was playing at the loop's end (not the
// hold's design start), so the wrap is a smooth continuation. Otherwise the
// value holds at the window's end for the rest of the body. With no pre-release
// section the body is silent.
function relValueBody(env, t, looped) {
  if (env.beginReleaseIndex <= 0) return 0;
  const trim = envTrim(env);
  const hs = holdStartTime(env), he = holdEndTime(env);
  let raw;
  if (looped && he > hs && t >= he) {
    const hold = env.components.slice(env.holdStartIndex, env.holdEndIndex + 1);
    const loopMs = he - hs;
    const seed0 = env.holdStartIndex > 0
      ? compValue(env.components[env.holdStartIndex - 1], env.components[env.holdStartIndex - 1].endValue)
      : compValue(env.components[0], env.components[0].startValue);
    const loopEnd = relValueAtList(hold, loopMs, seed0);
    raw = relValueAtList(hold, (t - hs) % loopMs, loopEnd);
  } else {
    raw = relValueAtList(env.components.slice(0, env.beginReleaseIndex), t);
  }
  return clamp01(raw + trim);
}

// Relative value through the release section (components at/after beginRelease),
// as time measured from the release start. The first card starts from whatever
// value is playing when the release begins — `seed`, the real-time value at the
// body's end (never a static chained start) — and the rest chain onto it. The
// seed already includes the envelope trim (it came from relValueBody), so it is
// untrimmed before sampling and the trim is re-added — the release tail shifts
// with the rest of the line instead of being trimmed twice.
function relValueRelease(env, t, seed) {
  const trim = envTrim(env);
  return clamp01(relValueAtList(env.components.slice(env.beginReleaseIndex), t, seed - trim) + trim);
}

// Sample an ordered component list into N relative values.
function sampleComps(comps, N, seed, env) {
  const total = compsMs(comps);
  const curve = new Float32Array(Math.max(2, N));
  for (let k = 0; k < curve.length; k++) {
    const t = total * k / (curve.length - 1);
    curve[k] = env ? relValueRelease(env, t, seed) : relValueAtList(comps, t, seed);
  }
  return { curve, totalMs: total };
}

// Per-level chime settings: key/root note (pitch), wave type, and ADSR
// envelope. The pitch is derived from the gesture's position (bottom = key
// root, sky = two octaves higher, snapped to the scale), so the key here only
// sets the root. The drag gesture can override attack/hold for individual drops.
const DEFAULT_CHIME = {
  start:  { note: 'C4', wave: 'sine', blend: 0.5, blendTo: 'triangle', volume: 0.12, attack: 5,   decay: 100, sustain: 90, hold: 0,   release: 810 },
  finish: { note: 'C4', wave: 'sine', blend: 0, blendTo: null, attack: 5,   decay: 500, sustain: 10, hold: 0,   release: 300 },  // reserved for later
};
var CHIME_SETTINGS = clone(DEFAULT_CHIME);

/* ---------- Oscillator stack ----------
   A note is a mix of one or more oscillators (layers). Each layer defines its
   own waveform (32 individual harmonic amplitudes, 0..1 each — harmonic 1 is
   the fundamental, harmonic N is N× the fundamental frequency), a level, and a
   drawn mix curve: breakpoints [{t, v}] (t = 0..1 note progress, v = 0..1 mix
   weight) sampled over the life of the note, so a bright layer can give way to
   a mellow ring in the tail. Layer gains are normalized at every sample, so the
   total loudness stays constant as layers are added. */
const HARMONIC_COUNT = 32;
const clampSign = v => Math.max(-1, Math.min(1, v));

/* ---------- Layer voices (coupled duplicates) ----------
   A layer can carry up to MAX_LAYER_VOICES duplicate voices that play its same
   waveform in parallel. Each voice only carries offsets: st (semitones),
   ct (cents), vol (relative gain multiplier). Voices are fully coupled to
   their layer: they share the mix curve, the pitch envelope, and every other
   layer property — only pitch/volume differ per voice, which is what produces
   chorus/unison thickening. */
const MAX_LAYER_VOICES = 5;
function defaultVoice(id) {
  return { id: id || 'voice-' + Date.now().toString(36), st: 0, ct: 7, vol: 1, muted: false, envs: null };
}
function defaultLayer(id) {
  const amplitudes = new Array(HARMONIC_COUNT).fill(0);
  amplitudes[0] = 1;
  return { id: id || 'osc-1', amplitudes, level: 1, trim: 0, curve: [{ t: 0, v: 1 }, { t: 1, v: 1 }], presetId: null, specPoints: null, pitchEnv: null, voices: null, muted: false };
}
// A soothing chime as the out-of-the-box sound: a soft bell body that carries
// the strike, plus a bright overtone layer that blooms into the tail. Layer
// gains are normalized per sample, so the mix curves genuinely morph the tone
// (warm attack → shimmering ring) rather than just scaling loudness.
function ampFromSpec(spec) {
  const a = new Array(HARMONIC_COUNT).fill(0);
  for (const [h, v] of spec) a[h - 1] = clampSign(v);
  return a;
}
function chimeLayer(id, spec, curve, level) {
  return { id, amplitudes: ampFromSpec(spec), level, trim: 0, curve, presetId: null, specPoints: null, pitchEnv: null, voices: null, muted: false };
}
const DEFAULT_OSC_STACK = {
  layers: [
    chimeLayer('osc-1',
      [[1, 1], [2, 0.22], [3, 0.08], [4, 0.14], [5, 0.05], [7, 0.02], [10, 0.01]],
      [{ t: 0, v: 1 }, { t: 1, v: 0.3 }], 1),
    chimeLayer('osc-2',
      [[2, 0.4], [4, 0.25], [5, 0.1], [6, 0.05], [8, 0.06], [10, 0.04]],
      [{ t: 0, v: 0 }, { t: 0.5, v: 0.15 }, { t: 1, v: 1 }], 0.8),
  ],
};
var OSC_STACK = clone(DEFAULT_OSC_STACK);

// A layer's raw mix weight at note progress `prog` (0..1): level × its curve.
// A muted layer contributes nothing, so the shared mix normalization excludes it
// and the other layers keep the loudness constant — muting "subtracts" the layer.
// The layer's trim shifts its whole curve up/down before the level applies.
function layerMixAt(layer, prog) {
  if (layer && layer.muted) return 0;
  return (layer.level || 0) * clamp01(curveValue(layer, prog) + layerTrim(layer));
}

// Interpolate a layer's drawn mix curve (linear between breakpoints, clamped).
function curveValue(layer, t) {
  const pts = layer.curve;
  if (!pts || !pts.length) return 1;
  if (pts.length === 1) return clamp01(pts[0].v);
  const lo = pts[0], hi = pts[pts.length - 1];
  if (t <= lo.t) return clamp01(lo.v);
  if (t >= hi.t) return clamp01(hi.v);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const f = span > 0 ? (t - a.t) / span : 0;
      return clamp01(segValueAt(a, a.v, b.v, f, 1));
    }
  }
  return clamp01(hi.v);
}

/* ---------- Pitch envelopes ----------
   A pitch envelope bends frequency over the note's life: breakpoints
   [{ t, st }] (t = note progress 0..1, st = semitone offset from the note's
   base pitch) interpolated linearly, 0 = no shift. `range` is the editor's
   vertical scale in semitones — the drawn curve spans ±range. The master
   envelope is a fallback: each layer uses its OWN envelope when it has one,
   otherwise it inherits the master; layers with neither stay at base pitch. */
const MAX_PITCH_ENV_RANGE = 24;
function defaultPitchEnv() {
  return { range: 1, points: [{ t: 0, st: 0 }, { t: 1, st: 0 }] };
}
var MASTER_PITCH_ENV = null;

// The value stored on an envelope breakpoint: pitch envelopes carry it as .st,
// voice-slider envelopes as .v. Returns 0 when absent.
function envPointVal(pt) {
  return pt && pt.v != null ? pt.v : (pt && pt.st != null ? pt.st : 0);
}

// Interpolate an envelope curve's value at note progress t (0..1), endpoints
// clamp. Works for pitch envelopes ({t, st}) and voice-slider envelopes
// ({t, v}) alike, applying each segment's line type.
function envValueAt(env, t) {
  const pts = env && env.points;
  if (!pts || !pts.length) return 0;
  if (pts.length === 1) return envPointVal(pts[0]);
  const lo = pts[0], hi = pts[pts.length - 1];
  if (t <= lo.t) return envPointVal(lo);
  if (t >= hi.t) return envPointVal(hi);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const f = span > 0 ? (t - a.t) / span : 0;
      return segValueAt(a, envPointVal(a), envPointVal(b), f, Math.max(1, env.range || 1));
    }
  }
  return envPointVal(hi);
}

// Interpolate a pitch envelope's semitones at note progress t (ends clamp).
function pitchStAt(env, t) {
  return envValueAt(env, t);
}

// The pitch envelope actually driving a layer: its own when present, otherwise
// the master as a fallback (layers with neither stay at their base pitch).
function activePitchEnv(layerIdx) {
  const l = OSC_STACK.layers[layerIdx];
  if (l && l.pitchEnv && l.pitchEnv.points && l.pitchEnv.points.length >= 2) return l.pitchEnv;
  if (MASTER_PITCH_ENV && MASTER_PITCH_ENV.points && MASTER_PITCH_ENV.points.length >= 2) return MASTER_PITCH_ENV;
  return null;
}

// A base frequency shifted by `st` semitones.
function freqShifted(baseFreq, st) {
  return Math.max(20, baseFreq * Math.pow(2, st / 12));
}

/* ---------- Voice slider envelopes ----------
   Each duplicate voice's sliders — semitones, cents, volume — can be bent by a
   breakpoint curve over the note's timeline on top of its static flat-line
   value: the value heard = flat line + curve (relative to neutral), so a curve
   never disables the slider, it just modulates it. The master fallback per
   parameter applies to every voice that has no envelope of its own; the
   fundamental (the layer's own oscillator) never carries an envelope.
   Ranges mirror the Voices-tab flat-line faders: st ±24 st, ct ±100 ¢,
   vol 0..2. */
const VOICE_PARAM_RANGES = { st: 24, ct: 100, vol: 2 };
var MASTER_VOICE_ENVS = { st: null, ct: null, vol: null };
// Flat-line values for the Master graphs, independent of each voice's own
// static slider values. A voice inheriting the master uses this as its base
// (plus the master curve), so the Master fader only affects the Master graph.
var MASTER_VOICE_FLATS = { st: 0, ct: 0, vol: 1 };

// A fresh flat voice envelope: no modulation (the neutral value holds).
function defaultVoiceEnv(param) {
  const neutral = param === 'vol' ? 1 : 0;
  return { range: VOICE_PARAM_RANGES[param] || 1, points: [{ t: 0, v: neutral }, { t: 1, v: neutral }] };
}

// The neutral (no-modulation) value of a voice envelope parameter.
function voiceEnvNeutral(param) {
  return param === 'vol' ? 1 : 0;
}

// The envelope actually driving a voice's slider parameter: its own when it has
// one, otherwise the master as a fallback. The fundamental (null) never has an
// envelope. Mirrors activePitchEnv.
function activeVoiceEnv(v, param) {
  if (!v) return null;
  const own = v.envs && v.envs[param];
  if (own && own.points && own.points.length >= 2) return own;
  const master = MASTER_VOICE_ENVS[param];
  if (master && master.points && master.points.length >= 2) return master;
  return null;
}

// Which envelope actually drives a voice's parameter — 'own', 'master', or
// null — so the matching flat-line base can be used with it.
function voiceEnvSource(v, param) {
  if (!v) return null;
  const own = v.envs && v.envs[param];
  if (own && own.points && own.points.length >= 2) return 'own';
  const master = MASTER_VOICE_ENVS[param];
  if (master && master.points && master.points.length >= 2) return 'master';
  return null;
}

// A voice's flat-line base value for a parameter: its own static slider, unless
// the active envelope is the Master — then the Master's flat-line is used.
function voiceFlatAt(v, param) {
  if (voiceEnvSource(v, param) === 'master') return +MASTER_VOICE_FLATS[param] || 0;
  return +(v && v[param]) || 0;
}

// Time-varying total pitch offset of a voice in semitones at note progress t:
// the flat-line base (own static, or Master's when inheriting) with the active
// st/ct envelope (own or master) bending on top of it, so the value =
// base + curve. Voices with no active envelope just sit at their flat line; the
// fundamental (null) stays at zero.
function voiceStOffsetAt(v, t) {
  if (!v) return 0;
  const stEnv = activeVoiceEnv(v, 'st');
  const ctEnv = activeVoiceEnv(v, 'ct');
  const st = voiceFlatAt(v, 'st') + (stEnv ? envValueAt(stEnv, t) : 0);
  const ct = voiceFlatAt(v, 'ct') + (ctEnv ? envValueAt(ctEnv, t) : 0);
  return st + ct / 100;
}

// Does a voice carry any time-varying pitch (an active st or ct envelope)?
// Used by the audio schedulers to keep scheduling a voice's frequency curve
// even when its layer has no pitch envelope of its own.
function voiceHasPitchBend(v) {
  return !!activeVoiceEnv(v, 'st') || !!activeVoiceEnv(v, 'ct');
}

// A voice's volume at note progress t: the flat-line base (own static, or
// Master's when inheriting) with the active vol envelope bending on top of it
// (relative to its neutral of 1.0), so the value = base + curve, clamped to the
// editor range. The fundamental (null) is always 1.
function voiceVolAt(v, t) {
  if (!v) return 1;
  const src = voiceEnvSource(v, 'vol');
  const env = src ? activeVoiceEnv(v, 'vol') : null;
  let base = +v.vol || 1;
  if (src === 'master') base = MASTER_VOICE_FLATS.vol != null ? +MASTER_VOICE_FLATS.vol : 1;
  const mod = env ? envValueAt(env, t) - 1 : 0;
  return Math.max(0, Math.min(2, base + mod));
}

/* ---- Layer voices (coupled duplicates) ---- */
// A layer's voices: the validated list, or [] when none.
function layerVoices(layer) {
  return (layer && Array.isArray(layer.voices)) ? layer.voices : [];
}
// The oscillator group a layer plays: the fundamental (null) plus every
// unmuted duplicate voice. Muted voices are dropped entirely, so the parallel
// arrays in the audio engine and the level normalization below stay aligned.
function layerPlayableVoices(layer) {
  const out = [null];
  for (const v of layerVoices(layer)) if (!v || !v.muted) out.push(v);
  return out;
}
// The time-varying version of the per-voice levels: each voice's level comes
// from its active vol envelope (own or master) at note progress t when one
// exists, else its static slider. Normalized per sample so the loudness
// invariant holds as the envelopes move.
function normalizedVoiceLevelsAt(layer, t) {
  const group = layerPlayableVoices(layer);
  const raw = group.map(v => voiceVolAt(v, t));
  const sum = raw.reduce((s, v) => s + v, 0);
  if (sum <= 0.001) return raw.map(() => 0);
  return raw.map(v => v / sum);
}

// Value of a drawn spectrum curve at x (0..1 across the 32 harmonics): signed
// amplitude (-1..1), linear between breakpoints.
function specValueAt(pts, x) {
  if (!pts || !pts.length) return 0;
  x = clamp01(x);
  const lo = pts[0], hi = pts[pts.length - 1];
  if (x <= lo.x) return clampSign(lo.a);
  if (x >= hi.x) return clampSign(hi.a);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x >= a.x && x <= b.x) {
      const span = b.x - a.x;
      const f = span > 0 ? (x - a.x) / span : 0;
      return clampSign(a.a + (b.a - a.a) * f);
    }
  }
  return clampSign(hi.a);
}

// A layer's 32 harmonic amplitudes: sampled from its drawn spectrum curve
// (specPoints: [{x, a}], x 0..1, a signed) when present, else its amplitudes.
function layerAmplitudes(layer) {
  if (layer.specPoints && layer.specPoints.length) {
    const out = new Array(HARMONIC_COUNT).fill(0);
    for (let i = 0; i < HARMONIC_COUNT; i++) {
      out[i] = specValueAt(layer.specPoints, HARMONIC_COUNT > 1 ? i / (HARMONIC_COUNT - 1) : 0);
    }
    return out;
  }
  return layer.amplitudes;
}

// Normalized per-layer gains at note progress `prog`: each layer's raw weight
// ÷ the sum across layers (ε-guarded), so layering stays at consistent loudness.
function layerGainsAt(prog) {
  const raw = OSC_STACK.layers.map(l => Math.max(0, layerMixAt(l, prog)));
  const sum = raw.reduce((s, v) => s + v, 0);
  return raw.map(v => sum > 1e-6 ? v / sum : 0);
}

// Normalized timeline for the note's design length: body through the hold end
// plus the release tail. Marker positions (t in 0..1) are shared by every
// time-based curve and shown by the sound-creator editor.
function designTimeline() {
  const holdEndMs = compsMs(ENVELOPE.components.slice(0, ENVELOPE.holdEndIndex + 1));
  const relMs = compsMs(ENVELOPE.components.slice(ENVELOPE.beginReleaseIndex));
  const total = holdEndMs + relMs;
  const tOf = ms => (total > 0 ? ms / total : 0);
  return {
    bodyMs: holdEndMs, relMs, total,
    tHoldStart: tOf(compsMs(ENVELOPE.components.slice(0, ENVELOPE.holdStartIndex))),
    tCut: tOf(earlyCutMs()),
    tHoldEnd: tOf(holdEndMs),
  };
}

// Map an elapsed-ms position in a note to the drawn mix curve's normalized axis
// (0..1). The body occupies [0, bodyFrac] and the release [bodyFrac, 1], where
// bodyFrac comes from the DESIGN body (hold end) so curve features line up with
// the HOLD/CUT/REL markers no matter how long the actual gesture body is.
function mixProgForTimes(elapsedMs, actualBodyMs, relMs, designBodyMs) {
  const dBody = designBodyMs != null ? designBodyMs : actualBodyMs;
  const bodyFrac = (dBody + relMs) > 0 ? dBody / (dBody + relMs) : 1;
  if (elapsedMs < actualBodyMs) {
    return (actualBodyMs > 0 ? (elapsedMs / actualBodyMs) : 0) * bodyFrac;
  }
  const relElapsed = elapsedMs - actualBodyMs;
  return Math.min(1, bodyFrac + (relMs > 0 ? (relElapsed / relMs) : 0) * (1 - bodyFrac));
}

// Fourier coefficients (length HARMONIC_COUNT) for a layer's waveform: the
// drawn spectrum curve when one exists, else the layer's amplitudes array.
function layerWaveCoeffs(layer) {
  const amps = layerAmplitudes(layer);
  if (!amps) return new Array(HARMONIC_COUNT).fill(0);
  const a = new Array(HARMONIC_COUNT).fill(0);
  for (let i = 0; i < HARMONIC_COUNT; i++) {
    a[i] = Math.max(-1, Math.min(1, +amps[i] || 0));
  }
  return a;
}

// Preset waveforms: pre-computed Fourier coefficients for the first 32 harmonics.
// Each value is the amplitude (signed) for harmonic n (1-indexed: presets[0] = harmonic 1).
function pulsePreset(duty) {
  const a = new Array(HARMONIC_COUNT).fill(0);
  for (let i = 0; i < HARMONIC_COUNT; i++) {
    const n = i + 1;
    a[i] = (2 / Math.PI) * Math.sin(n * Math.PI * duty) / n;
  }
  return a;
}
const HARMONIC_PRESETS = {
  sine:     (function () { const a = new Array(HARMONIC_COUNT).fill(0); a[0] = 1; return a; })(),
  triangle: (function () { const a = new Array(HARMONIC_COUNT).fill(0); for (let i = 0; i < HARMONIC_COUNT; i++) { const n = i + 1; if (n % 2 === 1) a[i] = (8 / (Math.PI * Math.PI)) * (n % 4 === 1 ? 1 : -1) / (n * n); } return a; })(),
  square:   (function () { const a = new Array(HARMONIC_COUNT).fill(0); for (let i = 0; i < HARMONIC_COUNT; i++) { const n = i + 1; if (n % 2 === 1) a[i] = (4 / Math.PI) / n; } return a; })(),
  sawtooth: (function () { const a = new Array(HARMONIC_COUNT).fill(0); for (let i = 0; i < HARMONIC_COUNT; i++) { const n = i + 1; a[i] = (2 / Math.PI) * (n % 2 === 1 ? 1 : -1) / n; } return a; })(),
  reverseSaw: (function () { const a = new Array(HARMONIC_COUNT).fill(0); for (let i = 0; i < HARMONIC_COUNT; i++) { const n = i + 1; a[i] = (2 / Math.PI) * (n % 2 === 1 ? -1 : 1) / n; } return a; })(),
  pulse25:  pulsePreset(0.25),
  pulse10:  pulsePreset(0.10),
  // Spectral profiles: simple additive stacks (positive amplitudes; the audio
  // engine peak-normalizes the wave, so only relative levels matter).
  warm:    (function () { const a = new Array(HARMONIC_COUNT).fill(0); for (let i = 0; i < HARMONIC_COUNT; i++) a[i] = 1 / (i + 1); return a; })(),
  mellow:  (function () { const a = new Array(HARMONIC_COUNT).fill(0); for (let i = 0; i < HARMONIC_COUNT; i++) a[i] = Math.pow(0.5, i); return a; })(),
  bright:  (function () { const a = new Array(HARMONIC_COUNT).fill(0); for (let i = 0; i < HARMONIC_COUNT; i++) a[i] = 1 / Math.sqrt(i + 1); return a; })(),
  hollow:  (function () { const a = new Array(HARMONIC_COUNT).fill(0); a[0] = 1; for (let i = 1; i < HARMONIC_COUNT; i++) { const n = i + 1; if (n % 2 === 0) a[i] = 1 / (n / 2); } return a; })(),
  ethereal: (function () { const a = new Array(HARMONIC_COUNT).fill(0); for (let i = 0; i < HARMONIC_COUNT; i++) { const n = i + 1; if (n % 2 === 1) a[i] = 1 / n; } return a; })(),
};

// Preview pitch: index into pitchPositions() for the test note (the 🎛️ creator
// and the settings "Play test" button). 0 = the key root.
var PREVIEW_PITCH = 0;

// Pitch color zones: the range of scale degrees shown as faint color bands on
// screen (screen X = pitch). Octaves are relative to the key note's octave —
// 0 is the key octave (the "middle ground"), -1/-2 below, +1/+2 above. The
// default spans the key octave and the one above it.
const DEFAULT_PITCH_ZONES = {
  show: true,           // render the on-screen color bands
  labelMode: 'note',    // band labels: 'note' (note names) or 'degree' (degree numbers)
  lowDegree: 1, lowOctave: 0,   // lowest pitch (degree + octave)
  highDegree: 5, highOctave: 1,  // highest pitch
};
var PITCH_ZONES = clone(DEFAULT_PITCH_ZONES);

/* ---------- Camera (pan + zoom) ---------- */
const MIN_ZOOM = 0.3, MAX_ZOOM = 3.0;
// cam is a screen-space translation: screen = world * zoom - cam.
// The pan slider pans cam.x, the vertical slider pans cam.y, and a
// pinch inside the pan slider changes cam.zoom.
// Start zoomed all the way out and panned all the way down (foreground view).
cam = { x: 0, y: HORIZON * MIN_ZOOM, zoom: MIN_ZOOM };

function toWorld(sx, sy) {
  return {
    x: (sx + cam.x) / cam.zoom,
    y: (sy + cam.y) / cam.zoom,
  };
}

function zoomAt(sx, sy, factor) {
  const w = toWorld(sx, sy);
  const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
  cam.zoom = nz;
  cam.x = w.x * nz - sx;
  cam.y = w.y * nz - sy;
}

// The ground scrolls down to the same absolute bottom at any zoom: the
// deepest world point visible when fully zoomed out (WORLD_BOTTOM). The
// horizon may drift off the top of the screen while zoomed in so the ground
// can be panned right to the bottom; minY still keeps the horizon from going
// below the screen bottom when panning up.
const WORLD_BOTTOM = HORIZON + H / MIN_ZOOM;
function clampCamY() {
  const minY = HORIZON * cam.zoom - H;
  const maxY = WORLD_BOTTOM * cam.zoom - H;
  cam.y = Math.max(minY, Math.min(maxY, cam.y));
}
