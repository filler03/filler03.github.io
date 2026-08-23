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

var mode = 'plant';      // 'plant' | 'nav' | 'creator' (full-screen sound editor)
var navState = null;     // single-finger pan drag in nav mode
var dragStates = new Map();  // plant gestures, one per pointer (multi-finger)
var pinchState = null;   // { dist } two-finger pinch in nav mode
var pointers = new Map();

var cam = { x: 0, y: 0, zoom: 1 };   // filled in below after resize

let audioCtx = null;
let masterGain = null;

/* Stage coordinates match the viewport directly; landscape orientation is
   enforced by the rotate prompt, so no swapping or rotation is needed. */
function stageX(e) { return e.clientX; }
function stageY(e) { return e.clientY; }

// iOS can fire resize with transient/degenerate sizes while a rotation or
// toolbar change is settling. A wrong value can STICK — the final, correct
// resize event sometimes never arrives — leaving the canvas shorter than the
// visible screen, which cuts off the bottom of the scene (e.g. the color
// bands vanish before the bottom edge). So every resize re-checks the
// viewport size a moment later, once things have settled, and re-applies it
// if it drifted.
let resizeVerifyTimer = null;
function scheduleSizeVerify() {
  clearTimeout(resizeVerifyTimer);
  resizeVerifyTimer = setTimeout(() => {
    const w = window.innerWidth, h = window.innerHeight;
    if (w !== W || h !== H) resize();
  }, 400);
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (!w || !h || !isFinite(w) || !isFinite(h)) return;
  if (w === W && h === H) return;
  W = canvas.width  = w;
  H = canvas.height = h;
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
    { id: 'comp-1', name: 'Attack',  duration: 250,  startValue: 0,   endValue: 100 },
    { id: 'comp-2', name: 'Decay',   duration: 250,  startValue: 100, endValue: 60 },
    { id: 'comp-3', name: 'Sustain', duration: 250,  startValue: 60,  endValue: 60 },
    { id: 'comp-4', name: 'Release', duration: 1200, startValue: 60,  endValue: 0 },
  ],
  beginReleaseIndex: 3,
  holdStartIndex: 2,
  holdEndIndex: 2,
  earlyCutIndex: 2,
};
var ENVELOPE = clone(DEFAULT_ENVELOPE);

// Chain start values: each component after the first starts where the previous
// one ended, so only the first component holds an independent start value.
function chainStartValues(env) {
  for (let i = 1; i < env.components.length; i++) {
    env.components[i].startValue = env.components[i - 1].endValue;
  }
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
      return cur + (end - cur) * p;
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
  const hs = holdStartTime(env), he = holdEndTime(env);
  if (looped && he > hs && t >= he) {
    const hold = env.components.slice(env.holdStartIndex, env.holdEndIndex + 1);
    const loopMs = he - hs;
    const seed0 = env.holdStartIndex > 0
      ? compValue(env.components[env.holdStartIndex - 1], env.components[env.holdStartIndex - 1].endValue)
      : compValue(env.components[0], env.components[0].startValue);
    const loopEnd = relValueAtList(hold, loopMs, seed0);
    return relValueAtList(hold, (t - hs) % loopMs, loopEnd);
  }
  return relValueAtList(env.components.slice(0, env.beginReleaseIndex), t);
}

// Relative value through the release section (components at/after beginRelease),
// as time measured from the release start. The first card starts from whatever
// value is playing when the release begins — `seed`, the real-time value at the
// body's end (never a static chained start) — and the rest chain onto it.
function relValueRelease(env, t, seed) {
  return relValueAtList(env.components.slice(env.beginReleaseIndex), t, seed);
}

// Sample an ordered component list into N relative values.
function sampleComps(comps, N, seed) {
  const total = compsMs(comps);
  const curve = new Float32Array(Math.max(2, N));
  for (let k = 0; k < curve.length; k++) {
    const t = total * k / (curve.length - 1);
    curve[k] = relValueAtList(comps, t, seed);
  }
  return { curve, totalMs: total };
}

// Sample the looping body shape over a real-time window (used while holding).
function sampleRelBody(env, from, to, N) {
  const curve = new Float32Array(Math.max(2, N));
  for (let k = 0; k < curve.length; k++) {
    const t = from + (to - from) * k / (curve.length - 1);
    curve[k] = relValueBody(env, t, true);
  }
  return curve;
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
function defaultLayer(id) {
  const amplitudes = new Array(HARMONIC_COUNT).fill(0);
  amplitudes[0] = 1;
  return { id: id || 'osc-1', amplitudes, level: 1, curve: [{ t: 0, v: 1 }, { t: 1, v: 1 }], presetId: null, specPoints: null };
}
const DEFAULT_OSC_STACK = { layers: [defaultLayer()] };
var OSC_STACK = clone(DEFAULT_OSC_STACK);

// A layer's raw mix weight at note progress `prog` (0..1): level × its curve.
function layerMixAt(layer, prog) {
  return (layer.level || 0) * curveValue(layer, prog);
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
      return clamp01(a.v + (b.v - a.v) * f);
    }
  }
  return clamp01(hi.v);
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
