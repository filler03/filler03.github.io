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

function resize() {
  // iOS can fire resize with transient/degenerate sizes while overlays and
  // toolbars are settling — keep the last good size instead of corrupting the
  // canvas backing store (which would squish the scene's background).
  const w = window.innerWidth, h = window.innerHeight;
  if (!w || !h || !isFinite(w) || !isFinite(h)) return;
  if (w === W && h === H) return;
  W = canvas.width  = w;
  H = canvas.height = h;
  HORIZON = H * 0.56;              // where ground meets sky (matches CSS)
}
window.addEventListener('resize', resize);
resize();

/* ---------- Small shared helpers ---------- */
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const clone = o => JSON.parse(JSON.stringify(o));

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

// Volume (gain) comes from where the gesture starts vertically on screen: top
// is loudest, bottom is quietest.
const VOL_MIN = 0.01, VOL_MAX = 0.5;
function volumeFromStartY(sy) {
  return mix(VOL_MIN, VOL_MAX, clamp01(1 - sy / H));
}
function yForVolume(v) {
  return H * (1 - (v - VOL_MIN) / (VOL_MAX - VOL_MIN));
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
  gestureAttack: false,    // when on, custom gestures fade their volume in over the tap-note attack time
  gestureDecay: false,     // when on, custom gestures fade their volume out over the tap-note decay time, right after the attack
  gestureRelease: false,   // when on, the tap-note release value is appended to custom gestures
};
var GESTURE = clone(DEFAULT_GESTURE);

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
