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
var tapNotes = [];       // { osc, gain, vol, level, segEnd, noteStart, totalMs, ... }

var mode = 'plant';      // 'plant' | 'nav'
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
const TAP_ATTACK_MS = 60; // quick attack for a tap with no line
const TAP_THRESHOLD = 8;      // px of total movement before a drag counts
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
// top is loudest, bottom is quietest. The relative volume — the percentage of
// this base volume actually being output — comes from the attack/decay/release
// components and drives the gesture line's thickness.
const BASE_VOL_MIN = 0.01, BASE_VOL_MAX = 0.5;
function baseVolumeFromY(sy) {
  return mix(BASE_VOL_MIN, BASE_VOL_MAX, clamp01(1 - sy / H));
}
function yForBaseVolume(v) {
  return H * (1 - (v - BASE_VOL_MIN) / (BASE_VOL_MAX - BASE_VOL_MIN));
}

// Which envelope phase each tap-default slot drives, for the A/D/S/R card.
const SLOT_NAMES = ['attack', 'decay', 'hold', 'release'];

// Top-left HUD emoji markers.
const EMOJI_TIME = '⏳';   // hourglass marks time values
const EMOJI_VOL  = '🔊';   // speaker marks volume values

/* ---------- Defaults (persisted to localStorage) ---------- */
const DEFAULT_GESTURE = {
  waitForGesture: false,   // when on, sound plays only after the whole gesture is drawn
  timeMult: 1,             // × the base time rate (TIME_PER_W ms per % of width)
  allowTapNotes: true,     // when off, tapping the screen plays no note
  gestureAttack: false,    // when on, custom gestures fade their relative volume in over the tap-note attack time
  gestureDecay: false,     // when on, custom gestures fade their relative volume out over the tap-note decay time, right after the attack
  gestureRelease: false,   // when on, the tap-note release value is appended to custom gestures
};
var GESTURE = clone(DEFAULT_GESTURE);

// FIXED presets: each component's duration (`value`, ms) and the relative
// volume it drives the note toward (`vol`, as a % of the base volume).
const DEFAULT_FIXED = {
  attack:  { on: true,  value: 250,  vol: 100 },
  decay:   { on: true,  value: 250,  vol: 60 },
  hold:    { on: true,  value: 250,  vol: 60 },
  release: { on: true,  value: 1200, vol: 0 },
};
var FIXED = clone(DEFAULT_FIXED);

// Per-level chime settings: key/root note (pitch), wave type, and ADSR
// envelope. The pitch is derived from the gesture's position (bottom = key
// root, sky = two octaves higher, snapped to the scale), so the key here only
// sets the root. The drag gesture can override attack/hold for individual drops.
const DEFAULT_CHIME = {
  start:  { note: 'C4', wave: 'sine', blend: 0.5, blendTo: 'triangle', volume: 0.12, attack: 5,   decay: 100, sustain: 90, hold: 0,   release: 810 },
  finish: { note: 'C4', wave: 'sine', blend: 0, blendTo: null, attack: 5,   decay: 500, sustain: 10, hold: 0,   release: 300 },  // reserved for later
};
var CHIME_SETTINGS = clone(DEFAULT_CHIME);

// Pitch color zones: the range of scale degrees shown as faint color bands on
// screen (screen X = pitch). Octaves are relative to the key note's octave —
// 0 is the key octave (the "middle ground"), -1/-2 below, +1/+2 above. The
// default spans two octaves centered on the key octave.
const DEFAULT_PITCH_ZONES = {
  show: true,           // render the on-screen color bands
  labelMode: 'note',    // band labels: 'note' (note names) or 'degree' (degree numbers)
  lowDegree: 1, lowOctave: -1,   // lowest pitch (degree + octave)
  highDegree: 7, highOctave: 1,  // highest pitch
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
