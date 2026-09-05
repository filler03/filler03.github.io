/* ============================================================
   flow.js — full-screen sound flow editor. A black, infinitely
   pannable canvas for arranging sound nodes (at free positions —
   no grid) into a playable graph, opened from the main screen's
   bottom-right button. Long-press an empty spot to open the add
   menu; a new node floats away from its neighbours so wires stay
   readable.

   Node types: Note (🎵, the entry point — aggregates a required
   Volume envelope + up to 3 Waves, each with an optional mix Env),
   Volume (📉, the ADSR envelope with HOLD/CUT/REL markers), Env
   (📈, a kind-agnostic neutral curve), Wave (🌊, harmonic
   spectrum), and Unison (🦄, one additional voice with optional
   vol/st/ct animation envelopes).

   Connections are consumer-owned slots shown as emoji-labeled ports on the
   node's own edges (tap a port to arm it, tap a node on the grid to connect,
   tap the port again to cancel); wires render as colored beziers from a source
   to the consumer's port, colored by the source node's type, and arc around
   any node card they would otherwise pass under (tap
   a wire to select it — long-press it to delete, and off-screen endpoints get
   edge jump buttons). Every node is an always-visible widget
   card that shows its values (mini envelope / curve / spectrum / faders / play
   + note-life) read-only, sized to fit exactly. Tapping a widget enters edit
   mode: it grows in place into its full editor (envelope / wave / curve /
   unison / note), and tapping outside it shrinks it back. A note widget offers
   four always-live ▶ play options: tap (body through the cut, then release),
   full length (whole note), live (press & hold — sustains the body, release
   plays the tail), and repeat (loops the tap / full options until stopped).
   Long-press a node to move it (flash + tap to
   place); hold it longer and a 3-2-1 countdown deletes it (release to cancel).
   The ☰ top-left button opens a read-only node-list side bar (tap a row to pan
   to that node); all editing happens on the field.
   ============================================================ */

const flowBtn = document.getElementById('flowBtn');
const FLOW_CELL = 88;           // node size basis (px): the old grid cell, kept as the visual scale
const FLOW_SHOW_GRID = false;   // draw the old dotted grid + cell coordinates? (kept for a possible return)
const FLOW_NODE_SEP = 190;      // min centre-to-centre distance between nodes (float-away spacing; widgets are wider than cells)
const FLOW_SEP_MS = 250;        // duration of the float-away separation animation
const FLOW_BACK_R = 22;         // round button radius (sidebar / undo / back)
const FLOW_TAP_MAX = 10;        // px of movement before a touch counts as a pan
const FLOW_PORT_R = 15;         // connection-port dot radius on a node's edge
const FLOW_MIX_PORT_DIST = 55;  // a note's mix port sits this far (px) along its wave's wire, close to the note
const FLOW_HOLD_MOVE = 500;     // ms of a still hold before the node enters move mode (flash)
const FLOW_HOLD_DELETE = 1200;  // ms of a continued hold (past move mode) before the delete countdown starts
const FLOW_DELETE_MS = 3000;    // delete countdown duration: a 3-2-1 hold before the node is deleted
const FLOW_SIDE_W = 250;        // node-list side bar width (left edge)
const FLOW_SIDE_HDR = 44;       // side bar header height
const FLOW_SIDE_ROW_H = 44;     // side bar row height
const FLOW_HISTORY_MAX = 50;    // undo stack depth
const FLOW_WAVE_ACCENT = '#4fc3f7';      // wave-editor plot accent (cyan)
const FLOW_UNISON_ACCENT = '#d98cff';    // unison-editor accent (violet)
const FLOW_ENV_DRAW_ZONE = 26;           // px strip inside a plot's left border: a swipe starting here is draw mode
const FLOW_ENV_HEADER_H = 24;            // extra header room above the graph editors' plot for the docked line-mode strip
const FLOW_ENV_DELETE_BUFFER = 24;       // px a dot must pass the plot edge before drag-to-delete arms (the delete pill appears)
// Wire colors: a connection line's color comes from the SOURCE ("from") node's
// type — each type has its own accent. A filled port inherits its source's
// color (so the port matches the wire); an empty port keeps a role-based hint
// (FLOW_ROLE_COLORS) for what could connect there.
const FLOW_SOURCE_COLORS = {
  wave: FLOW_WAVE_ACCENT,      // 🌊 → cyan
  volumeEnv: '#4caf50',        // 📉 → green
  env: '#ffb74d',              // 📈 → orange
  unison: '#ba68c8',           // 🦄 → violet
};
const FLOW_ROLE_COLORS = {
  volumeEnv: '#4caf50',
  waves: FLOW_WAVE_ACCENT,
  mixEnvs: '#ffb74d',
  mixEnv: '#ffb74d',
  unison: '#ba68c8',
  volEnv: '#9ccc65',
  stEnv: '#64b5f6',
  ctEnv: '#f48fb1',
};
// The color of a wire / filled port, from the source node's type.
function flowSourceColor(node) {
  return (node && FLOW_SOURCE_COLORS[node.type]) || '#bdbdbd';
}

// Node types: the add-menu option and the node's grid image share its emoji.
// `wave` defines the node's harmonic structure (a 32-harmonic spectrum, like a
// legacy layer); `unison` holds duplicate voices (st/ct/vol offsets) that tap
// the legacy sound creator's voices logic. `volumeEnv` is the note's required
// ADSR envelope (HOLD/CUT/REL markers); `env` is a kind-agnostic breakpoint
// curve whose consumers decide what it means (mix / st / ct / voice volume).
const FLOW_NODE_TYPES = {
  note: { label: 'Note', emoji: '🎵' },
  volumeEnv: { label: 'Volume', emoji: '📉' },
  env: { label: 'Env', emoji: '📈' },
  wave: { label: 'Wave', emoji: '🌊' },
  unison: { label: 'Unison', emoji: '🦄' },
};
const FLOW_NOTE_LIFE_MIN = 300;    // ms
const FLOW_NOTE_LIFE_MAX = 10000;  // ms

var flowCam = { x: 0, y: 0 };   // grid pan offset (px): world = screen + cam
var flowPtr = null;             // { x, y, startX, startY, lastT, vx, vy, moved } active pan drag, or null
var flowInertia = null;         // { vx, vy } px/ms momentum after a flick, or null
var flowLastT = 0;              // last RAF timestamp, for dt-based inertia decay
const FLOW_FLICK_MIN = 0.04;    // px/ms velocity needed to start inertia on release
const FLOW_FLICK_STOP = 0.001;  // px/ms at which inertia settles and stops

var flowNodes = [];             // [{ id, x, y, type, noteLife }] placed sound nodes (x,y = world px centre)
var flowSelId = null;           // id of the selected node (attribute panel shown for it)
var flowSelConn = null;         // { nodeId, slot } the selected connection wire (edge jump buttons shown), or null
var flowAddMenu = null;         // { x, y } open add-node menu anchor (world px), or null
var flowSideOpen = false;       // node-list side bar open?
var flowSideScrollY = 0;        // vertical scroll offset of the side-bar list
var flowPanAnim = null;         // { x0, y0, x1, y1, t0 } animated pan to a node's position
var flowHold = null;            // { id, kind, x, y, t0, stage } active long-press hold, or null
var flowMoveId = null;          // id of the node in move mode (slowly flashing), or null
var flowConnArm = null;         // { nodeId, slot } armed connection slot awaiting a grid tap, or null
var flowSepAnim = null;         // { id, x0, y0, x1, y1, cam0x, cam0y, t0 } a node drifting to clear spacing (camera follows), or null
var flowHistory = [];           // undo stack: [{ nodes, cam }] snapshots taken before each action

const FLOW_SAVE_KEY = 'growingTrees.flow.v1';

// The grid area: the full screen (no bottom bar).
function flowGridArea() {
  return { top: 0, bottom: H, left: 0, right: W };
}
// The control buttons: undo at top-right, and the back-to-playing-field button
// at bottom-right (kept away from the editors' corners so it can't be tapped
// when dismissing a window).
function flowTopButtonRects() {
  const d = FLOW_BACK_R * 2;
  return {
    undo: { x: W - 16 - d, y: 16, d },
    back: { x: W - 16 - d, y: H - 16 - d, d },
  };
}
function flowTopHit(x, y) {
  const r = flowTopButtonRects();
  for (const k of ['undo', 'back']) {
    const b = r[k];
    if (Math.hypot(x - (b.x + b.d / 2), y - (b.y + b.d / 2)) <= FLOW_BACK_R + 6) return k;
  }
  return null;
}
// The side bar's expand/collapse button (top-left; overlays the panel's header
// when the panel is open).
function flowSideBtnRect() {
  return { x: 16, y: 16, d: FLOW_BACK_R * 2 };
}
function flowSideBtnHit(x, y) {
  const b = flowSideBtnRect();
  return Math.hypot(x - (b.x + b.d / 2), y - (b.y + b.d / 2)) <= FLOW_BACK_R + 6;
}
// The integer grid-cell range that intersects the visible grid area.
function flowCellRange() {
  const g = flowGridArea();
  const gx0 = Math.floor(flowCam.x / FLOW_CELL), gx1 = Math.floor((flowCam.x + g.right) / FLOW_CELL);
  const gy0 = Math.floor(flowCam.y / FLOW_CELL), gy1 = Math.floor((flowCam.y + (g.bottom - g.top)) / FLOW_CELL);
  return { gx0, gx1, gy0, gy1 };
}
// Screen position of a cell's top-left corner.
function flowCellScreen(gx, gy) {
  return { x: gx * FLOW_CELL - flowCam.x, y: gy * FLOW_CELL - flowCam.y };
}

/* ---- Node helpers ---- */
function flowNodeById(id) {
  return flowNodes.find(n => n.id === id);
}
// Screen position of a node's centre.
function flowNodeScreen(n) {
  return { x: n.x - flowCam.x, y: n.y - flowCam.y };
}
// The node under the world point (x,y), or null. "Here a node exists" = inside
// its widget card's bounds (with a little slack), so long-presses near a node
// still count as on it.
function flowNodeAt(x, y) {
  const pad = 8;
  let best = null, bd = Infinity;
  for (const n of flowNodes) {
    const s = flowWidgetSize(n);
    if (x < n.x - s.w / 2 - pad || x > n.x + s.w / 2 + pad) continue;
    if (y < n.y - s.h / 2 - pad || y > n.y + s.h / 2 + pad) continue;
    const d = Math.hypot(x - n.x, y - n.y);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
// The idle widget size for a node: sized to exactly fit its read-only content
// (a single place to tune sizes — a future per-node scale factor can fold in
// here). volumeEnv / env / wave show a mini plot; unison shows mini faders; a
// note shows its play button and note-life slider.
function flowWidgetSize(node) {
  switch (node.type) {
    case 'note': return { w: 176, h: 96 };
    case 'unison': return { w: 176, h: 128 };
    default: return { w: 176, h: 116 };   // volumeEnv / env / wave mini plots
  }
}
// The node's widget rect in screen space. When the node is being edited, its
// widget IS the enlarged editor panel (grows in place at the node's position).
function flowWidgetRect(node, editing) {
  if (editing) return (node.type === 'note') ? flowNotePanel() : flowEnvPanel();
  const s = flowWidgetSize(node);
  const p = flowNodeScreen(node);
  return { x: p.x - s.w / 2, y: p.y - s.h / 2, w: s.w, h: s.h };
}
// The id of whichever node is currently being edited (its widget is enlarged),
// or null when nothing is being edited.
function flowActiveEditId() {
  return flowNoteEdit || flowEnvEdit || flowWaveEdit || flowUnisonEdit || flowCurveEdit || null;
}
// A note widget's four ▶ play buttons (tap / full / live / repeat) and its
// note-life slider track, laid out for whatever rect they are drawn in (idle
// widget or enlarged note editor). The widget squeezes them into a row; the
// editor stacks them full-width below the header.
function flowNoteWidgetButtons(r) {
  const gap = 4, n = 4;
  const w = (r.w - 20 - (n - 1) * gap) / n;
  const y = r.y + 30, h = 26;
  return {
    tap:    { x: r.x + 10, y, w, h },
    full:   { x: r.x + 10 + (w + gap), y, w, h },
    live:   { x: r.x + 10 + 2 * (w + gap), y, w, h },
    repeat: { x: r.x + 10 + 3 * (w + gap), y, w, h },
  };
}
function flowNoteWidgetLife(r) {
  return { x: r.x + 62, x2: r.x + r.w - 10, y: r.y + 74 };
}
// The add-menu option buttons, laid out around the anchored point (clamped to
// stay inside the grid area). One per node type for now.
function flowAddMenuOptions() {
  const p = { x: flowAddMenu.x - flowCam.x, y: flowAddMenu.y - flowCam.y };
  const keys = Object.keys(FLOW_NODE_TYPES);
  const gap = 14;
  const totalW = keys.length * 56 + (keys.length - 1) * gap;
  const cx0 = Math.max(flowSideOpen ? FLOW_SIDE_W + 40 : 56, Math.min(W - 56, p.x));
  const cy = Math.max(34, Math.min(H - 34, p.y - 44));
  return keys.map((type, i) => {
    const x = cx0 - totalW / 2 + i * (56 + gap) + 28;
    return { type, cx: x, cy, r: 28, emoji: FLOW_NODE_TYPES[type].emoji, label: FLOW_NODE_TYPES[type].label };
  });
}
function hitAddMenu(x, y) {
  if (!flowAddMenu) return null;
  for (const o of flowAddMenuOptions()) {
    if (Math.hypot(x - o.cx, y - o.cy) <= o.r + 6) return o;
  }
  return null;
}
// A wave node's default spectrum: a plain sine (fundamental only). Mirrors the
// shape of a legacy layer's spectrum fields so the shared helpers can edit it.
function defaultWaveSpec() {
  const amplitudes = new Array(HARMONIC_COUNT).fill(0);
  amplitudes[0] = 1;
  return { amplitudes, specPoints: null, presetId: null };
}
// A unison node is exactly one additional voice (like the legacy Voices tab's
// default voice). The near-twin chorus sound comes from stacking unison nodes
// on the same wave via the shared draw, or from the st/ct offsets + envs.
function defaultUnisonVoices() {
  return [defaultVoice('voice-uni-a')];
}
// A generic env node's default curve: flat at 0 — the neutral value that is a
// no-op for every consumer (mix = full, st/ct = no bend, voice vol = 1×).
// `trim` is a whole-curve vertical offset in the −1..1 graph units, like the
// volume envelope's trim slider (0 = the curve as designed).
function defaultEnvCurve() {
  return { points: [{ t: 0, v: 0 }, { t: 1, v: 0 }], trim: 0 };
}

/* ---- Connections ----
   Nodes connect with consumer-owned named slots: each node stores the ids of
   the source nodes feeding it (fan-out is free — any node can be referenced by
   many consumers). Slots are type-constrained, so the graph is a DAG by
   construction (no cycles). A note is the aggregator: it consumes a required
   volume envelope + 1..3 waves, each wave with an optional mix envelope; a wave
   may feed a unison; a unison may feed up to three envs (volume / st / ct). */
function defaultConn(type) {
  if (type === 'note') return { volumeEnv: null, waves: [null, null, null], mixEnvs: [null, null, null] };
  if (type === 'wave') return { mixEnv: null, unison: [] };
  if (type === 'unison') return { volEnv: null, stEnv: null, ctEnv: null };
  return null;
}
function flowNodeConn(n) {
  if (!n || !n.conn || typeof n.conn !== 'object') {
    if (n) n.conn = defaultConn(n.type);
  }
  return n ? n.conn : null;
}
// Read / write a named slot. A slot is { key, idx? }; idx addresses arrays.
function connSlotGet(node, slot) {
  const c = flowNodeConn(node);
  if (!c) return null;
  if (slot.idx != null) return (Array.isArray(c[slot.key]) ? c[slot.key] : [])[slot.idx] || null;
  return c[slot.key] || null;
}
function connSlotSet(node, slot, val) {
  const c = flowNodeConn(node);
  if (!c) return;
  if (slot.idx != null) {
    if (!Array.isArray(c[slot.key])) c[slot.key] = [null, null, null];
    c[slot.key][slot.idx] = val;
  } else {
    c[slot.key] = val;
  }
}
function slotKey(slot) {
  return slot.key + (slot.idx != null ? ':' + slot.idx : '');
}
// The connection slots a node exposes, in modal/port order. Each row carries
// its pills (usually one; the note's wave rows carry a second pill for the mix
// env) — the legacy structure kept for wiring/detach/prune and the ports.
function flowSlotRows(node) {
  const rows = [];
  if (node.type === 'note') {
    rows.push({ slot: { key: 'volumeEnv' }, label: 'Vol env', req: true, y: 0 });
    for (let i = 0; i < 3; i++) {
      rows.push({
        slot: { key: 'waves', idx: i },
        pill2: { key: 'mixEnvs', idx: i },
        label: 'Wave ' + (i + 1),
        req: i === 0,
        y: 0,
      });
    }
  } else if (node.type === 'wave') {
    // One row per connected unison plus a trailing empty "add" row — arming it
    // creates the next connection. Capped at MAX_LAYER_VOICES stacking voices.
    const c = flowNodeConn(node);
    const unis = Array.isArray(c.unison) ? c.unison : [];
    const n = Math.min(unis.length, MAX_LAYER_VOICES);
    for (let i = 0; i < n; i++) rows.push({ slot: { key: 'unison', idx: i }, label: 'Unison', y: 0 });
    if (n < MAX_LAYER_VOICES) rows.push({ slot: { key: 'unison', idx: n }, label: 'Unison', y: 0 });
  } else if (node.type === 'unison') {
    rows.push({ slot: { key: 'volEnv' }, label: 'Vol env', y: 0 });
    rows.push({ slot: { key: 'stEnv' }, label: 'St env', y: 0 });
    rows.push({ slot: { key: 'ctEnv' }, label: 'Ct env', y: 0 });
  }
  return rows;
}
// Whether a target node may fill a slot of a given consumer (type check + no
// self-connection + no duplicate wave in a note's wave slots).
function flowConnCanAssign(consumer, slot, targetId) {
  const target = flowNodeById(targetId);
  if (!target || !consumer || target.id === consumer.id) return false;
  const def = flowSlotRows(consumer).find(r =>
    (r.slot && slotKey(r.slot) === slotKey(slot)) || (r.pill2 && slotKey(r.pill2) === slotKey(slot)));
  if (!def) return false;
  if (def.accepts) {
    if (def.accepts.indexOf(target.type) < 0) return false;
  } else if (slot.key === 'mixEnvs' || slot.key === 'mixEnv') {
    if (target.type !== 'env') return false;
  } else if (slot.key === 'volumeEnv') {
    if (target.type !== 'volumeEnv') return false;
  } else if (slot.key === 'unison') {
    if (target.type !== 'unison') return false;
  } else if (slot.key === 'waves') {
    if (target.type !== 'wave') return false;
  } else {
    if (target.type !== 'env') return false;
  }
  // A wave may not fill two of the same note's wave slots.
  if (consumer.type === 'note' && slot.key === 'waves' && slot.idx != null) {
    for (let i = 0; i < 3; i++) {
      if (i !== slot.idx && connSlotGet(consumer, { key: 'waves', idx: i }) === targetId) return false;
    }
  }
  // A unison may not fill two of the same wave's unison slots (each stack adds
  // one voice — the count is capped at MAX_LAYER_VOICES).
  if (consumer.type === 'wave' && slot.key === 'unison' && slot.idx != null) {
    const unis = flowNodeConn(consumer).unison;
    if (Array.isArray(unis)) {
      for (let i = 0; i < unis.length; i++) {
        if (i !== slot.idx && unis[i] === targetId) return false;
      }
      if (slot.idx >= MAX_LAYER_VOICES) return false;
    }
  }
  return true;
}
// Is a note playable (volume env + at least one wave connected)?
function flowNoteReady(note) {
  if (!note || note.type !== 'note') return false;
  const c = flowNodeConn(note);
  return !!c.volumeEnv && !!c.waves.some(Boolean);
}
// Clear a slot and, for a note's wave slot, its paired mix-env slot (the mix
// port rides that wave's wire, so it must not outlive the wave connection).
function connSlotClearPair(node, slot) {
  connSlotSet(node, slot, null);
  if (node.type === 'note' && slot.key === 'waves' && slot.idx != null) {
    connSlotSet(node, { key: 'mixEnvs', idx: slot.idx }, null);
  }
}
// Clear every slot that references `id` (used when a node is deleted).
function flowDetachNode(id) {
  for (const n of flowNodes) {
    for (const r of flowSlotRows(n)) {
      const pills = r.pill2 ? [r.slot, r.pill2] : [r.slot];
      for (const slot of pills) {
        if (connSlotGet(n, slot) === id) connSlotClearPair(n, slot);
      }
    }
  }
}

// A temporary layer-shaped object carrying a wave node's spectrum, so the
// legacy Harmonics helpers (initLayerSpecPoints, syncLayerAmplitudes,
// insertSpecPoint, applyPresetToLayer, layerAmplitudes) can edit it directly.
function flowWaveLayer(node) {
  const w = (node && node.wave) || defaultWaveSpec();
  return {
    id: 'flow-wave', amplitudes: w.amplitudes, level: 1, trim: 0,
    curve: [{ t: 0, v: 1 }, { t: 1, v: 1 }], presetId: w.presetId,
    specPoints: w.specPoints, pitchEnv: null, voices: null, muted: false,
  };
}
// A temporary layer-shaped object carrying a unison node's voices, so the
// legacy voices helpers (layerVoices, defaultVoice, MAX_LAYER_VOICES) and the
// layer-shaped spectrum fields all work against it.
function flowUnisonLayer(node) {
  return {
    id: 'flow-unison', amplitudes: new Array(HARMONIC_COUNT).fill(0), level: 1, trim: 0,
    curve: [{ t: 0, v: 1 }, { t: 1, v: 1 }], presetId: null,
    specPoints: null, pitchEnv: null,
    voices: (node && Array.isArray(node.voices)) ? node.voices : [],
    muted: false,
  };
}

// Create a node of `type` at the open add-menu anchor, select it, and let it
// float away from any neighbours so the wires have room.
function addFlowNode(type) {
  if (!flowAddMenu || !FLOW_NODE_TYPES[type]) return;
  flowPushHistory();
  const id = 'node-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
  const n = { id, x: flowAddMenu.x, y: flowAddMenu.y, type };
  if (type === 'note') n.noteLife = 2500;
  else if (type === 'volumeEnv') n.envelope = clone(DEFAULT_ENVELOPE);
  else if (type === 'env') n.env = defaultEnvCurve();
  else if (type === 'wave') n.wave = defaultWaveSpec();
  else if (type === 'unison') n.voices = defaultUnisonVoices();
  n.conn = defaultConn(type);
  // The very first node (no nodes existed before this) becomes the world
  // origin: shift the camera by the node's position so the node is stored at
  // 0,0 but still appears exactly where it was placed. Any later first node
  // (after all nodes were deleted) re-anchors the origin the same way.
  if (!flowNodes.length) {
    flowCam.x -= n.x;
    flowCam.y -= n.y;
    n.x = 0; n.y = 0;
  }
  flowNodes.push(n);
  flowAddMenu = null;
  flowSelId = id;
  flowSelConn = null;
  saveFlow();
  flowSeparateNode(n);   // drift out of any neighbours (no-op when already clear)
}

/* ---- Undo ----
   Snapshot-based: every mutating action pushes the state BEFORE it onto the
   stack; Undo pops the most recent snapshot and restores it (nodes + camera,
   so an undo also returns the view to where the action happened). Future node
   actions just need to call flowPushHistory() before they mutate flowNodes. */
function flowPushHistory(base) {
  const state = base || clone(flowNodes);
  const top = flowHistory[flowHistory.length - 1];
  if (top && JSON.stringify(top.nodes) === JSON.stringify(state)) return;   // no-op snapshots
  flowHistory.push({ nodes: state, cam: { x: flowCam.x, y: flowCam.y } });
  if (flowHistory.length > FLOW_HISTORY_MAX) flowHistory.shift();
}
function undoFlow() {
  const entry = flowHistory.pop();
  if (!entry) return;
  // An open overlay editor mutates node data on close (wave/unison write their
  // proxy back into the node), so close it first — the undo below then restores
  // the pre-edit snapshot the overlay pushed when it first changed something.
  if (flowNoteEdit) closeFlowNoteEditor();
  if (flowEnvEdit) closeFlowEnvelopeEditor();
  if (flowWaveEdit) closeFlowWaveEditor();
  if (flowUnisonEdit) closeFlowUnisonEditor();
  if (flowCurveEdit) closeFlowCurveEditor();
  flowNodes = clone(entry.nodes);
  if (entry.cam) { flowCam = { x: entry.cam.x, y: entry.cam.y }; flowInertia = null; flowPanAnim = null; }
  if (flowSelId && !flowNodeById(flowSelId)) flowSelId = null;
  if (flowMoveId && !flowNodeById(flowMoveId)) flowMoveId = null;
  flowClearSelConn();
  flowAddMenu = null;
  flowSepAnim = null;
  saveFlow();
}

/* ---- Side bar (node list) ----
   A read-only list of every placed node (emoji + type + position in grid-cell
   units, i.e. world px ÷ FLOW_CELL), opened and closed by the ☰ top-right
   button or the header ✕. Tapping a row just pans the camera to that node —
   selection, editing, moving and deleting all stay on the field. The list
   scrolls vertically when it overflows. */
function flowSideRect() {
  return { x: 0, y: 0, w: FLOW_SIDE_W, h: H };
}
// The "Clear all" pill, right-aligned in the panel header: wipes every node and
// returns the camera to the origin.
function flowSideClearRect() {
  const s = flowSideRect();
  return { x: s.x + s.w - 96, y: 8, w: 86, h: 28 };
}
function flowSideRows() {
  const s = flowSideRect();
  const top = s.y + FLOW_SIDE_HDR;
  return flowNodes.map((node, i) => ({
    node, x: s.x, y: top - flowSideScrollY + i * FLOW_SIDE_ROW_H, w: s.w, h: FLOW_SIDE_ROW_H,
  }));
}
function flowSideMaxScroll() {
  const s = flowSideRect();
  return Math.max(0, flowNodes.length * FLOW_SIDE_ROW_H - (s.h - FLOW_SIDE_HDR));
}
// The node under (x,y), or null — only inside the panel's visible row area.
function flowSideRowAt(x, y) {
  if (!flowSideOpen) return null;
  const s = flowSideRect();
  if (x < s.x || x > s.x + s.w || y < s.y + FLOW_SIDE_HDR || y > s.y + s.h) return null;
  const max = flowSideMaxScroll();
  if (flowSideScrollY > max) flowSideScrollY = max;
  const idx = Math.floor((y - (s.y + FLOW_SIDE_HDR) + flowSideScrollY) / FLOW_SIDE_ROW_H);
  if (idx < 0 || idx >= flowNodes.length) return null;
  return flowNodes[idx];
}
function drawFlowSide() {
  const s = flowSideRect();
  drawRoundRect(s.x, s.y, s.w, s.h, 0);
  ctx.fillStyle = 'rgba(14,14,16,0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Header (the expand/collapse button overlays the top-left corner).
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 15px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Nodes', s.x + 68, s.y + 28);
  // Clear-all pill (right of the header).
  const cl = flowSideClearRect();
  drawRoundRect(cl.x, cl.y, cl.w, cl.h, 8);
  ctx.fillStyle = '#8e2f26';
  ctx.fill();
  ctx.strokeStyle = '#d0604f';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🗑 Clear all', cl.x + cl.w / 2, cl.y + cl.h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
  // Rows.
  const top = s.y + FLOW_SIDE_HDR;
  if (!flowNodes.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '700 12px sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('No nodes yet · long-press anywhere to add one', s.x + 14, top + 24);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(s.x, top, s.w, s.h - top);
  ctx.clip();
  const maxScroll = flowSideMaxScroll();
  if (flowSideScrollY > maxScroll) flowSideScrollY = maxScroll;
  for (const r of flowSideRows()) {
    const sel = r.node.id === flowSelId;
    drawRoundRect(r.x + 6, r.y + 4, r.w - 12, r.h - 8, 8);
    ctx.fillStyle = sel ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)';
    ctx.fill();
    if (sel) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.textBaseline = 'middle';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(FLOW_NODE_TYPES[r.node.type].emoji, r.x + 24, r.y + r.h / 2);
    ctx.font = '800 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.85)';
    ctx.fillText(FLOW_NODE_TYPES[r.node.type].label, r.x + 44, r.y + r.h / 2);
    // World position in grid-cell units (like the old grid's scale), 2 decimals.
    const ux = r.node.x / FLOW_CELL, uy = r.node.y / FLOW_CELL;
    ctx.font = '700 11px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(ux.toFixed(2) + ',' + uy.toFixed(2), r.x + r.w - 14, r.y + r.h / 2);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  // Scrollbar.
  const max = flowSideMaxScroll();
  if (max > 0) {
    const avail = s.h - top;
    const thumbH = Math.max(24, avail * avail / (flowNodes.length * FLOW_SIDE_ROW_H));
    const ty = top + (flowSideScrollY / max) * (avail - thumbH);
    drawRoundRect(s.x + s.w - 7, ty, 3, thumbH, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fill();
  }
}

// Center the camera on a node with a short eased pan.
function panToNode(node) {
  flowInertia = null;
  flowPanAnim = {
    x0: flowCam.x, y0: flowCam.y,
    x1: node.x - W / 2,
    y1: node.y - H / 2,
    t0: performance.now(),
  };
}

/* ---- Long-press: move mode / add menu ----
   Holding a node still for FLOW_HOLD_MOVE puts it into move mode — it flashes
   slowly; the next tap anywhere moves it there (auto-spacing from neighbours).
   Holding an empty spot for the same time opens the add menu anchored there.
   Deleting a node is available in its in-place property modal. */
function deleteFlowNode(id) {
  flowPushHistory();
  flowDetachNode(id);          // clear every slot pointing at this node
  flowNodes = flowNodes.filter(n => n.id !== id);
  if (flowNoteEdit === id) closeFlowNoteEditor();
  if (flowEnvEdit === id) closeFlowEnvelopeEditor();
  if (flowWaveEdit === id) closeFlowWaveEditor();
  if (flowUnisonEdit === id) closeFlowUnisonEditor();
  if (flowCurveEdit === id) closeFlowCurveEditor();
  if (flowSelId === id) flowSelId = null;
  flowClearSelConn();   // this node may be a selected wire's source/consumer
  if (flowMoveId === id) flowMoveId = null;
  if (flowConnArm && flowConnArm.nodeId === id) flowConnArm = null;
  flowAddMenu = null;
  if (flowSepAnim && flowSepAnim.id === id) flowSepAnim = null;
  saveFlow();
}
function moveFlowNodeTo(id, x, y) {
  const n = flowNodeById(id);
  if (!n) return;
  flowPushHistory();
  n.x = x; n.y = y;
  flowMoveId = null;
  saveFlow();
  flowSeparateNode(n);   // auto-space from any neighbours, just like a fresh add
}
// Clear every node and return the camera to the world origin (undoable).
function clearFlowAll() {
  flowPushHistory();
  if (flowNoteEdit) closeFlowNoteEditor();
  if (flowEnvEdit) closeFlowEnvelopeEditor();
  if (flowWaveEdit) closeFlowWaveEditor();
  if (flowUnisonEdit) closeFlowUnisonEditor();
  if (flowCurveEdit) closeFlowCurveEditor();
  flowNodes = [];
  flowSelId = null;
  flowSelConn = null;
  flowMoveId = null;
  flowConnArm = null;
  flowAddMenu = null;
  flowSepAnim = null;
  flowSideScrollY = 0;
  flowCam = { x: 0, y: 0 };
  flowInertia = null;
  flowPanAnim = null;
  saveFlow();
}
// Float a node away from every other node until no centre is closer than
// FLOW_NODE_SEP (only this node moves — existing nodes stay put). The target
// is found by iteratively pushing it out of each overlapping neighbour, then
// animated with an ease-out drift that the camera follows, so the node settles
// in the centre of the screen. No overlap → instant, no animation.
function flowSeparationTarget(node) {
  let px = node.x, py = node.y;
  for (let iter = 0; iter < 24; iter++) {
    let dx = 0, dy = 0;
    for (const n of flowNodes) {
      if (n.id === node.id) continue;
      const vx = px - n.x, vy = py - n.y;
      const d = Math.hypot(vx, vy);
      if (d >= FLOW_NODE_SEP || d === 0) continue;
      const push = (FLOW_NODE_SEP - d) / d;
      dx += vx * push; dy += vy * push;
    }
    if (Math.hypot(dx, dy) < 0.5) break;
    px += dx; py += dy;
  }
  return { x: px, y: py };
}
function flowSeparateNode(node) {
  const t = flowSeparationTarget(node);
  if (Math.hypot(t.x - node.x, t.y - node.y) < 0.5) return;   // already clear
  flowInertia = null;
  flowPanAnim = null;
  flowSepAnim = {
    id: node.id,
    x0: node.x, y0: node.y, x1: t.x, y1: t.y,
    cam0x: flowCam.x, cam0y: flowCam.y,   // pan along so the node ends centred
    t0: performance.now(),
  };
}
// Slowly-pulsing alpha for the node currently in move mode.
function flowFlashAlpha() {
  const p = 0.5 + 0.5 * Math.sin(performance.now() / 300);
  return 0.35 + 0.65 * p;
}

/* ---- Persistence ---- */
function saveFlow() {
  try { localStorage.setItem(FLOW_SAVE_KEY, JSON.stringify({ nodes: flowNodes })); } catch (err) {}
}
// A wave node's spectrum, loaded and clamped from storage: specPoints sorted by
// x with clamped x (0..1) / a (−1..1), amplitudes clamped; falls back to the
// default sine when nothing valid is stored.
function waveSpecFromSaved(w) {
  const out = defaultWaveSpec();
  if (!w || typeof w !== 'object') return out;
  if (Array.isArray(w.amplitudes) && w.amplitudes.length) {
    for (let i = 0; i < HARMONIC_COUNT; i++) out.amplitudes[i] = Math.max(-1, Math.min(1, +w.amplitudes[i] || 0));
  }
  if (Array.isArray(w.specPoints) && w.specPoints.length >= 2) {
    out.specPoints = w.specPoints
      .filter(p => p && typeof p.x === 'number' && typeof p.a === 'number')
      .map(p => ({ x: Math.max(0, Math.min(1, p.x)), a: Math.max(-1, Math.min(1, p.a)) }));
    out.specPoints.sort((a, b) => a.x - b.x);
  }
  out.presetId = (w.presetId && HARMONIC_PRESETS[w.presetId]) ? w.presetId : null;
  return out;
}
// A unison node's voices, loaded and clamped from storage: at most
// MAX_LAYER_VOICES, each with st/ct/vol clamped to the editor ranges (mirrors
// the legacy voicesFromSaved clamping without its envelope support).
function voicesFromSavedFlow(vs) {
  if (!Array.isArray(vs) || !vs.length) return [];
  // A unison node is one additional voice — keep only the first.
  return vs.slice(0, 1).map((v, k) => ({
    id: (v && v.id) || 'voice-' + k + '-' + Date.now().toString(36),
    st: Math.max(-24, Math.min(24, +((v && v.st) != null ? v.st : 0) || 0)),
    ct: Math.max(-100, Math.min(100, +((v && v.ct) != null ? v.ct : 0) || 0)),
    vol: Math.max(0, Math.min(2, +((v && v.vol) != null ? v.vol : 1) || 0)),
    muted: !!(v && v.muted),
  }));
}
// A generic env node's curve, loaded and clamped: points sorted by t, t 0..1,
// v −1..1, trim −1..1; falls back to the flat-neutral default when nothing
// valid is stored. A point's `.seg` (its span's line type) is preserved.
function envCurveFromSaved(e) {
  if (e && Array.isArray(e.points) && e.points.length >= 2) {
    const pts = e.points
      .filter(p => p && typeof p.t === 'number' && typeof p.v === 'number')
      .map(p => {
        const pt = { t: clamp01(p.t), v: Math.max(-1, Math.min(1, p.v)) };
        if (p.seg && typeof p.seg === 'object') pt.seg = clone(p.seg);
        return pt;
      });
    pts.sort((a, b) => a.t - b.t);
    if (pts.length >= 2) return { points: pts, trim: Math.max(-1, Math.min(1, +e.trim || 0)) };
  }
  return defaultEnvCurve();
}
// A node's connections, loaded from storage (dangling ids are cleaned later,
// once every node is in place).
function connFromSaved(type, c) {
  const out = defaultConn(type);
  if (!out || !c || typeof c !== 'object') return out;
  if (type === 'note') {
    out.volumeEnv = typeof c.volumeEnv === 'string' ? c.volumeEnv : null;
    for (let i = 0; i < 3; i++) {
      out.waves[i] = (Array.isArray(c.waves) && typeof c.waves[i] === 'string') ? c.waves[i] : null;
      out.mixEnvs[i] = (Array.isArray(c.mixEnvs) && typeof c.mixEnvs[i] === 'string') ? c.mixEnvs[i] : null;
    }
  } else if (type === 'wave') {
    out.mixEnv = typeof c.mixEnv === 'string' ? c.mixEnv : null;
    // unison is an array of stacked source ids; legacy saves hold a single string.
    if (typeof c.unison === 'string') out.unison = c.unison ? [c.unison] : [];
    else if (Array.isArray(c.unison)) out.unison = c.unison.filter(x => typeof x === 'string').slice(0, MAX_LAYER_VOICES);
    else out.unison = [];
  } else if (type === 'unison') {
    out.volEnv = typeof c.volEnv === 'string' ? c.volEnv : null;
    out.stEnv = typeof c.stEnv === 'string' ? c.stEnv : null;
    out.ctEnv = typeof c.ctEnv === 'string' ? c.ctEnv : null;
  }
  return out;
}
// Drop connection references to nodes that no longer exist, and dedupe a
// note's wave slots (a wave may fill only one).
function flowPruneConns() {
  const ids = new Set(flowNodes.map(n => n.id));
  for (const n of flowNodes) {
    const c = flowNodeConn(n);
    for (const r of flowSlotRows(n)) {
      const pills = r.pill2 ? [r.slot, r.pill2] : [r.slot];
      for (const slot of pills) {
        const v = connSlotGet(n, slot);
        if (v && !ids.has(v)) connSlotSet(n, slot, null);
      }
    }
    if (n.type === 'note') {
      const seen = {};
      for (let i = 0; i < 3; i++) {
        const w = c.waves[i];
        if (w && seen[w]) { c.waves[i] = null; }
        if (w) seen[w] = true;
        // A mix env rides its wave's wire — without the wave, it's orphaned.
        if (!c.waves[i]) c.mixEnvs[i] = null;
      }
    }
    if (n.type === 'wave' && Array.isArray(c.unison)) {
      const seen = {};
      for (let i = 0; i < c.unison.length; i++) {
        const id = c.unison[i];
        if (id && (!ids.has(id) || seen[id])) c.unison[i] = null;
        if (id) seen[id] = true;
      }
      // Trim trailing empties and cap the voice stack.
      while (c.unison.length && !c.unison[c.unison.length - 1]) c.unison.pop();
      if (c.unison.length > MAX_LAYER_VOICES) c.unison.length = MAX_LAYER_VOICES;
    }
  }
}
function loadFlow() {
  try {
    const raw = localStorage.getItem(FLOW_SAVE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    const arr = Array.isArray(d.nodes) ? d.nodes : [];
    flowNodes = [];
    for (const n of arr) {
      if (!n || typeof n.type !== 'string') continue;
      const hasPos = (typeof n.x === 'number' && typeof n.y === 'number') || (typeof n.gx === 'number' && typeof n.gy === 'number');
      if (!hasPos) continue;
      // The old envelope node type became the volume envelope.
      const type = n.type === 'envelope' ? 'volumeEnv' : n.type;
      const node = {
        id: typeof n.id === 'string' ? n.id : 'node-' + Math.random().toString(36).slice(2),
        type: FLOW_NODE_TYPES[type] ? type : 'note',
        noteLife: Math.max(FLOW_NOTE_LIFE_MIN, Math.min(FLOW_NOTE_LIFE_MAX, Math.round(+n.noteLife) || 2500)),
      };
      // Free placement: nodes save their world-px centre (x,y). Old grid saves
      // (gx,gy cells) migrate to the cell's centre.
      if (typeof n.x === 'number' && typeof n.y === 'number') {
        node.x = n.x; node.y = n.y;
      } else {
        node.x = Math.round(n.gx) * FLOW_CELL + FLOW_CELL / 2;
        node.y = Math.round(n.gy) * FLOW_CELL + FLOW_CELL / 2;
      }
      if (node.type === 'volumeEnv') {
        node.envelope = (n.envelope && Array.isArray(n.envelope.components) && n.envelope.components.length)
          ? n.envelope : clone(DEFAULT_ENVELOPE);
      }
      if (node.type === 'env') node.env = envCurveFromSaved(n.env);
      if (node.type === 'wave') node.wave = waveSpecFromSaved(n.wave);
      if (node.type === 'unison') node.voices = voicesFromSavedFlow(n.voices);
      node.conn = connFromSaved(node.type, n.conn);
      flowNodes.push(node);
    }
    flowPruneConns();
  } catch (err) {}
}
loadFlow();

/* ---- Open / close ---- */
function openSoundFlow() {
  flowActive = true;
  mode = 'flow';
  stopGestureNote();
  playbacks.length = 0;
  settingsPanel.classList.add('hidden');
  document.body.classList.add('flow');
}

function closeSoundFlow() {
  flowActive = false;
  mode = 'plant';
  if (flowNoteEdit) closeFlowNoteEditor();
  if (flowEnvEdit) closeFlowEnvelopeEditor();
  if (flowWaveEdit) closeFlowWaveEditor();
  if (flowUnisonEdit) closeFlowUnisonEditor();
  if (flowCurveEdit) closeFlowCurveEditor();
  flowPtr = null;
  flowInertia = null;
  flowAddMenu = null;
  flowConnArm = null;
  flowPanAnim = null;
  flowHold = null;
  flowMoveId = null;
  flowSelConn = null;
  flowSideOpen = false;
  flowSideScrollY = 0;
  flowSepAnim = null;
  flowStopRepeat();
  if (flowLive) flowLiveEnd();   // restores the shared sound globals too
  playbacks.length = 0;
  stopGestureNote();
  stopPreviewVoices();
  document.body.classList.remove('flow');
  saveFlow();
  flushSettingsSave();
}

flowBtn.addEventListener('click', () => {
  if (flowActive) { closeSoundFlow(); return; }
  initAudio();
  resumeAudio();
  openSoundFlow();
});

// The connected volume-envelope node feeding a note (its Note-life slider target).
function flowNoteLifeEnv(node) {
  const id = node && node.conn && node.conn.volumeEnv;
  const env = id ? flowNodeById(id) : null;
  return (env && env.type === 'volumeEnv' && env.envelope) ? env : null;
}
function flowNoteLifeMs(node) {
  const env = flowNoteLifeEnv(node);
  return env ? compsMs(env.envelope.components) : 0;
}
function flowNoteLifeFromX(s, x) {
  const f = clamp01((x - s.x) / (s.x2 - s.x));
  const ms = FLOW_NOTE_LIFE_MIN + f * (FLOW_NOTE_LIFE_MAX - FLOW_NOTE_LIFE_MIN);
  return Math.round(ms / 10) * 10;
}
function flowSetNoteLife(node, ms) {
  const env = flowNoteLifeEnv(node);
  if (!env) return;
  const saved = ENVELOPE;
  ENVELOPE = env.envelope;
  try { setNoteLifetime(ms); } finally { ENVELOPE = saved; }
}

/* ---- On-node connection ports ----
   Each consumer node's slots are drawn as small emoji-labeled dots around its
   cell ring. Tapping a dot arms that slot ("Connecting…"); tapping it again
   cancels. While armed, tapping a valid source node on the grid assigns it.
   Wires terminate at the consumer's port anchor. A wave node stacks multiple
   Unison connections (one port per stack, plus an empty port for the next);
   connections are cleared by selecting a wire and long-pressing it to delete. */
function flowPortEmoji(slot) {
  if (slot.key === 'volumeEnv') return '📉';
  if (slot.key === 'waves') return '🌊';
  if (slot.key === 'unison') return '🦄';
  return '📈';   // mixEnv(s), volEnv, stEnv, ctEnv
}
function flowPortLabel(slot) {
  if (slot.key === 'volumeEnv') return 'Vol';
  if (slot.key === 'waves') return 'W' + ((slot.idx != null ? slot.idx : 0) + 1);
  if (slot.key === 'mixEnvs' || slot.key === 'mixEnv') return (slot.key === 'mixEnvs' ? 'M' + ((slot.idx != null ? slot.idx : 0) + 1) : 'Mix');
  if (slot.key === 'unison') return slot.idx != null ? 'Uni' + (slot.idx + 1) : 'Uni';
  if (slot.key === 'volEnv') return 'Vol';
  if (slot.key === 'stEnv') return 'St';
  if (slot.key === 'ctEnv') return 'Ct';
  return '';
}
// A connection's wire path in screen space: the cubic bezier from the source
// node's centre to the consumer's port anchor. The curve deflects around any
// other node card it would otherwise pass under (see flowWirePath). Returns
// null when the slot is empty.
function flowConnPath(consumer, slot) {
  const tid = connSlotGet(consumer, slot);
  const src = tid ? flowNodeById(tid) : null;
  if (!src) return null;
  const a = flowNodeScreen(src);
  const b = flowNodeScreen(consumer);
  const port = flowPortAnchor(consumer, slot);
  const bx = port ? port.cx : b.x;
  const by = port ? port.cy : b.y + FLOW_CELL / 2;
  return flowWirePath({ x: a.x, y: a.y }, { x: bx, y: by }, consumer, src);
}
// Build a wire's bezier between endpoints `a` (source centre) and `b` (consumer
// port). Defaults to the horizontal S-curve (both control points share the
// midpoint x, at the endpoints' heights). When a node card sits on the curve,
// both control points are moved to arc the whole wire over (or under) the
// blocker — one smooth single-arc deflection that keeps the wire clear of the
// card (a dense layout may still clip, accepted tradeoff).
function flowWirePath(a, b, consumer, src) {
  const mx = b.x + (a.x - b.x) * 0.5;
  const p1 = { x: mx, y: a.y }, p2 = { x: mx, y: b.y };
  const blocker = flowWireBlocker(a, b, mx, consumer, src);
  if (blocker) {
    const M = 14;                       // clearance margin beyond the card
    const t = Math.max(0.18, Math.min(0.82, (blocker.cx - a.x) / (b.x - a.x || 1)));
    const u = 1 - t;
    // The default wire's height at the blocker's x: which side to arc to.
    const yAt = u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y;
    const target = blocker.cy < yAt ? blocker.top - M : blocker.bottom + M;
    // Solve y(t) = target for p1.y = p2.y = value (the cubic in y, kept simple
    // by making both control points share the value).
    const value = (target - u * u * u * a.y - t * t * t * b.y) / (3 * u * t * (u + t));
    const span = Math.abs(b.y - a.y) + 120;
    const v = Math.max(Math.min(a.y, b.y) - span, Math.min(Math.max(a.y, b.y) + span, value));
    p1.y = v; p2.y = v;
  }
  return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, mx, p1, p2 };
}
// The node card (other than the wire's own endpoints) whose inflated rect the
// default bezier passes through nearest its middle (t = 0.5), or null. Only the
// first hit per node counts (a wire may thread a card more than once).
function flowWireBlocker(a, b, mx, consumer, src) {
  const path = { a, b, mx };
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  let best = null, bestD = Infinity;
  for (const n of flowNodes) {
    if (n.id === consumer.id || n.id === src.id) continue;
    const r = flowWidgetRect(n, false);
    const rx = r.x - 10, ry = r.y - 10, rw = r.w + 20, rh = r.h + 20;
    if (rx > x1 || rx + rw < x0) continue;
    for (let i = 1; i < 24; i++) {
      const t = i / 24;
      const pt = flowBezierPoint(path, t);
      if (pt.x >= rx && pt.x <= rx + rw && pt.y >= ry && pt.y <= ry + rh) {
        const d = Math.abs(t - 0.5);
        if (d < bestD) { bestD = d; best = { cx: rx + rw / 2, cy: ry + rh / 2, top: ry, bottom: ry + rh }; }
        break;
      }
    }
  }
  return best;
}
// Point on a cubic bezier at parameter t (0 = source centre, 1 = consumer port).
// A path may carry deflected control points p1/p2 (see flowWirePath); when
// absent they default to the horizontal S-curve from the endpoints.
function flowBezierPoint(path, t) {
  const u = 1 - t;
  const p0 = path.a, p3 = path.b;
  const p1 = path.p1 || { x: path.mx, y: path.a.y }, p2 = path.p2 || { x: path.mx, y: path.b.y };
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}
// Unit tangent vector at parameter t.
function flowBezierTangent(path, t) {
  const u = 1 - t;
  const p0 = path.a, p3 = path.b;
  const p1 = path.p1 || { x: path.mx, y: path.a.y }, p2 = path.p2 || { x: path.mx, y: path.b.y };
  const x = 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
  const y = 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}
// Walk the bezier from the consumer port (t = 1) toward the source until the
// arc is at least `dist` px away; fall back to the midpoint on a short wire.
// Returns the point plus the unit normal (perpendicular to the tangent) for the
// port's label / ✕ badge to sit just off the wire.
function flowBezierAtDistFromB(path, dist) {
  const STEPS = 60;
  let prev = { x: path.b.x, y: path.b.y }, acc = 0;
  let last = { t: 1, x: path.b.x, y: path.b.y };
  for (let i = 1; i <= STEPS; i++) {
    const t = 1 - i / STEPS;
    const pt = flowBezierPoint(path, t);
    acc += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    prev = pt;
    last = { t, x: pt.x, y: pt.y };
    if (acc >= dist) break;
  }
  if (last.t <= 0) {
    const mid = flowBezierPoint(path, 0.5);
    last = { t: 0.5, x: mid.x, y: mid.y };
  }
  const tan = flowBezierTangent(path, last.t);
  return { x: last.x, y: last.y, nx: -tan.y, ny: tan.x };
}
// Screen-space port dots for a node (on the widget card's edges).
function flowPorts(node) {
  const p = flowNodeScreen(node);
  const cx = p.x, cy = p.y;
  const r = flowWidgetRect(node, false);
  const w = r.w, h = r.h;
  const out = [];
  const add = (slot, px, py, edge, req, nx, ny) => {
    const filled = !!connSlotGet(node, slot);
    const src = filled ? flowNodeById(connSlotGet(node, slot)) : null;
    out.push({
      slot, cx: px, cy: py, edge, req: !!req, nx: nx || 0, ny: ny || 0,
      emoji: flowPortEmoji(slot),
      label: flowPortLabel(slot),
      color: src ? flowSourceColor(src) : (FLOW_ROLE_COLORS[slot.key] || '#bdbdbd'),
    });
  };
  if (node.type === 'note') {
    add({ key: 'volumeEnv' }, cx, cy - h / 2 - 6, 'top', true);
    for (let i = 0; i < 3; i++) {
      const y = cy + (i - 1) * 27;
      const wx = cx + w / 2 + 6;
      add({ key: 'waves', idx: i }, wx, y, 'right', i === 0);
      // The per-wave mix port rides its wave's wire, close to the note — it only
      // exists while that wave is connected (no wave, no mix port).
      const waveId = connSlotGet(node, { key: 'waves', idx: i });
      const wsrc = waveId ? flowNodeById(waveId) : null;
      if (wsrc) {
        const wpath = flowWirePath({ x: flowNodeScreen(wsrc).x, y: flowNodeScreen(wsrc).y }, { x: wx, y }, node, wsrc);
        const pt = flowBezierAtDistFromB(wpath, FLOW_MIX_PORT_DIST);
        add({ key: 'mixEnvs', idx: i }, pt.x, pt.y, 'wire', false, pt.nx, pt.ny);
      }
    }
  } else if (node.type === 'wave') {
    // One bottom port per connected unison, plus a trailing empty port for the
    // next connection (capped at MAX_LAYER_VOICES stacked voices).
    const unis = flowNodeConn(node).unison;
    const unisArr = Array.isArray(unis) ? unis : [];
    const n = Math.min(unisArr.length, MAX_LAYER_VOICES);
    const total = n < MAX_LAYER_VOICES ? n + 1 : n;
    for (let i = 0; i < total; i++) {
      const px = cx + (i - (total - 1) / 2) * 27;
      add({ key: 'unison', idx: i }, px, cy + h / 2 + 6, 'bottom');
    }
  } else if (node.type === 'unison') {
    // One left-edge port per animation envelope, aligned beside the fader row
    // it drives (Semitones / Cents / Volume).
    add({ key: 'stEnv' }, cx - w / 2 - 6, r.y + 30, 'left');
    add({ key: 'ctEnv' }, cx - w / 2 - 6, r.y + 58, 'left');
    add({ key: 'volEnv' }, cx - w / 2 - 6, r.y + 86, 'left');
  }
  return out;
}
// The port dot for a particular slot (wire endpoint / armed-slot match).
function flowPortAnchor(node, slot) {
  const s = slotKey(slot);
  for (const pt of flowPorts(node)) if (slotKey(pt.slot) === s) return pt;
  return null;
}
// Screen-space port hit test. Tapping a port — filled or empty — arms it for a
// connection (or cancels an armed slot); a filled port's ✕ clear is gone, so
// wires are cleared by selecting + long-pressing them instead.
function hitFlowPort(x, y) {
  for (const n of flowNodes) {
    for (const pt of flowPorts(n)) {
      if (Math.hypot(x - pt.cx, y - pt.cy) <= FLOW_PORT_R + 6) return { node: n, pt };
    }
  }
  return null;
}
function drawFlowPorts() {
  for (const n of flowNodes) {
    if (n.id === flowActiveEditId()) continue;   // the enlarged editor covers its own ports
    for (const pt of flowPorts(n)) {
      const filled = !!connSlotGet(n, pt.slot);
      const src = filled ? flowNodeById(connSlotGet(n, pt.slot)) : null;
      const k = slotKey(pt.slot);
      const armed = flowConnArm && flowConnArm.nodeId === n.id && slotKey(flowConnArm.slot) === k;
      // Dot.
      ctx.beginPath();
      ctx.arc(pt.cx, pt.cy, FLOW_PORT_R, 0, Math.PI * 2);
      ctx.fillStyle = armed ? '#3a3f52' : (filled ? pt.color : 'rgba(255,255,255,0.08)');
      ctx.fill();
      ctx.strokeStyle = armed ? FLOW_UNISON_ACCENT : (filled ? pt.color : (pt.req ? '#e06060' : 'rgba(255,255,255,0.45)'));
      ctx.lineWidth = armed ? 2.5 : (filled || pt.req ? 2 : 1.5);
      ctx.stroke();
      // Inner glyph: a filled port shows the connected node's emoji.
      ctx.fillStyle = filled ? '#ffffff' : 'rgba(255,255,255,0.6)';
      ctx.font = (filled ? '15px' : '13px') + ' sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(filled ? (src ? FLOW_NODE_TYPES[src.type].emoji : pt.emoji) : pt.emoji, pt.cx, pt.cy + 1);
      // Label on the outward side of the dot.
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '800 9px sans-serif';
      if (pt.edge === 'wire') {
        ctx.fillText(pt.label, pt.cx + pt.nx * (FLOW_PORT_R + 5), pt.cy + pt.ny * (FLOW_PORT_R + 5));
      } else {
        ctx.fillText(pt.label, pt.cx, pt.edge === 'top' ? pt.cy - FLOW_PORT_R - 5 : pt.cy + FLOW_PORT_R + 6);
      }
      ctx.textBaseline = 'alphabetic';
    }
  }
}

/* ---- Wire rendering ----
   Consumer-owned slots are drawn as beziers from the source node's cell to the
   consumer's cell, colored by the SOURCE node's type (the "from" node owns the
   color). Drawn under the node circles. A selected wire (flowSelConn) is drawn
   thick and glowing; wires of the selected consumer node are also brightened. */
function drawFlowWires() {
  for (const n of flowNodes) {
    const rows = flowSlotRows(n);
    const nodeSel = n.id === flowSelId;
    for (const r of rows) {
      const pills = r.pill2 ? [r.slot, r.pill2] : [r.slot];
      for (const slot of pills) {
        const path = flowConnPath(n, slot);
        if (!path) continue;
        const tid = connSlotGet(n, slot);
        const src = tid ? flowNodeById(tid) : null;
        if (!src) continue;
        const wireSel = flowSelConn && flowSelConn.nodeId === n.id && slotKey(flowSelConn.slot) === slotKey(slot);
        ctx.globalAlpha = (wireSel || nodeSel) ? 1 : 0.5;
        ctx.strokeStyle = flowSourceColor(src);
        ctx.lineWidth = wireSel ? 6 : (nodeSel ? 5 : 4);
        ctx.shadowBlur = wireSel ? 12 : 0;
        ctx.shadowColor = withAlpha(flowSourceColor(src), 0.8);
        const p1 = path.p1 || { x: path.mx, y: path.a.y }, p2 = path.p2 || { x: path.mx, y: path.b.y };
        ctx.beginPath();
        ctx.moveTo(path.a.x, path.a.y);
        ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, path.b.x, path.b.y);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }
    }
  }
}

/* ---- Connection selection / deletion ----
   Every live wire is selectable: tap one to select it (its endpoints get edge
   jump buttons when off-screen), long-press it to delete it (same 3-2-1
   hold-to-delete as a node). */
// Every live connection as { nodeId, slot }: the consumer node and its slot.
function flowConnEntries() {
  const out = [];
  for (const n of flowNodes) {
    for (const r of flowSlotRows(n)) {
      const pills = r.pill2 ? [r.slot, r.pill2] : [r.slot];
      for (const slot of pills) {
        if (connSlotGet(n, slot)) out.push({ nodeId: n.id, slot });
      }
    }
  }
  return out;
}
// The wire under the screen point (x,y), or null. Samples each wire's bezier
// and keeps the nearest one within a finger-friendly distance.
function hitFlowConn(x, y) {
  let best = null, bd = 18;
  for (const c of flowConnEntries()) {
    const n = flowNodeById(c.nodeId);
    if (!n) continue;
    const path = flowConnPath(n, c.slot);
    if (!path) continue;
    for (let i = 1; i <= 20; i++) {
      const t = i / 20;
      const pt = flowBezierPoint(path, t);
      const d = Math.hypot(x - pt.x, y - pt.y);
      if (d < bd) { bd = d; best = { nodeId: c.nodeId, slot: c.slot, x: pt.x, y: pt.y, t }; }
    }
  }
  return best;
}
// The connection under the press (as a pointerdown target), preferring a node
// when the press is on top of a node widget (wires draw under the nodes).
function flowConnAtPress(x, y) {
  const wx = x + flowCam.x, wy = y + flowCam.y;
  if (flowNodeAt(wx, wy)) return null;
  return hitFlowConn(x, y);
}
// Select / clear a wire. Node selection and wire selection are exclusive.
function selectFlowConn(c) {
  flowSelConn = c ? { nodeId: c.nodeId, slot: c.slot } : null;
  if (c) flowSelId = null;
}
// Delete a connection (undoable), like clearing the slot's ✕ badge.
function deleteFlowConn(nodeId, slot) {
  const n = flowNodeById(nodeId);
  if (!n || !connSlotGet(n, slot)) return;
  flowPushHistory();
  connSlotClearPair(n, slot);
  saveFlow();
  if (flowSelConn && flowSelConn.nodeId === nodeId && slotKey(flowSelConn.slot) === slotKey(slot)) flowSelConn = null;
}

function flowClearSelConn() {
  if (!flowSelConn) return;
  const n = flowNodeById(flowSelConn.nodeId);
  if (!n || !connSlotGet(n, flowSelConn.slot)) flowSelConn = null;
}

/* ---- Edge jump buttons (selected wire's off-screen endpoints) ----
   While a wire is selected, each endpoint whose node is off-screen shows a
   floating arrow button on the edge of the screen, pointing toward that node;
   tapping it pans the camera to the node. */
function flowJumpButtons() {
  const out = [];
  if (!flowSelConn) return out;
  const cons = flowNodeById(flowSelConn.nodeId);
  const srcId = cons ? connSlotGet(cons, flowSelConn.slot) : null;
  const src = srcId ? flowNodeById(srcId) : null;
  for (const node of [src, cons]) {
    if (!node) continue;
    const p = flowNodeScreen(node);
    const onX = p.x >= 0 && p.x <= W;
    const onY = p.y >= 0 && p.y <= H;
    if (onX && onY) continue;   // on-screen — no button
    const cx = W / 2, cy = H / 2;
    let dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    // Scale the direction so the point sits just inside the viewport edge.
    const tx = dx !== 0 ? ((W / 2 - 34) / Math.abs(dx)) : Infinity;
    const ty = dy !== 0 ? ((H / 2 - 34) / Math.abs(dy)) : Infinity;
    const s = Math.min(tx, ty);
    const bx = Math.max(40, Math.min(W - 40, cx + dx * s));
    const by = Math.max(40, Math.min(H - 40, cy + dy * s));
    out.push({ node, x: bx, y: by, angle: Math.atan2(dy, dx) });
  }
  return out;
}
function hitFlowJumpBtn(x, y) {
  for (const b of flowJumpButtons()) {
    if (Math.hypot(x - b.x, y - b.y) <= 26 + 6) return b;
  }
  return null;
}
function drawFlowJumpButtons() {
  for (const b of flowJumpButtons()) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30,32,40,0.92)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('➤', 0, 2);
    ctx.restore();
    // Node emoji just below the arrow.
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(FLOW_NODE_TYPES[b.node.type].emoji, b.x, b.y + 34);
  }
}
// A held-press flash / 3-2-1 delete countdown while long-pressing a connection.
function drawFlowConnHold() {
  if (!flowHold || flowHold.kind !== 'conn') return;
  const n = flowNodeById(flowHold.conn.nodeId);
  const path = n ? flowConnPath(n, flowHold.conn.slot) : null;
  if (path) {
    const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(performance.now() / 120));
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 8;
    const p1 = path.p1 || { x: path.mx, y: path.a.y }, p2 = path.p2 || { x: path.mx, y: path.b.y };
    ctx.beginPath();
    ctx.moveTo(path.a.x, path.a.y);
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, path.b.x, path.b.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (flowHold.stage === 2) {
    const remain = FLOW_DELETE_MS - (performance.now() - flowHold.del0);
    const num = Math.max(1, Math.ceil(remain / 1000));
    const px = flowHold.x, py = flowHold.y;
    ctx.beginPath();
    ctx.arc(px, py, 34, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(130,20,20,0.88)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), px, py - 4);
    ctx.font = '700 10px sans-serif';
    ctx.fillText('hold to delete', px, py + 16);
    ctx.textBaseline = 'alphabetic';
  }
}

/* ---- Always-visible node widgets ----
   Every node is a card that always shows its values read-only: a mini plot for
   volumeEnv / env / wave, mini faders for unison, and a ▶ play button + note-life
   slider for a note. The card is sized to fit exactly (flowWidgetSize) and hit-
   tested as a rect. Tapping a card enters edit mode — the node grows in place
   into its editor (drawn further down), so the card itself is skipped while the
   node is being edited. A longer hold turns the card into a 3-2-1 delete
   countdown (release to cancel). */
function flowMiniPlot(r) {
  return { left: r.x + 8, right: r.x + r.w - 8, top: r.y + 28, bottom: r.y + r.h - 6, pw: r.w - 16, ph: r.h - 34 };
}
function drawMiniPlotFrame(pl) {
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pl.left, pl.top, pl.pw, pl.ph);
  const y0 = pl.top + pl.ph / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.moveTo(pl.left, y0); ctx.lineTo(pl.right, y0);
  ctx.stroke();
}
function drawFlowWidget(n) {
  const r = flowWidgetRect(n, false);
  const sel = n.id === flowSelId;
  const move = n.id === flowMoveId;
  drawRoundRect(r.x, r.y, r.w, r.h, 12);
  ctx.fillStyle = 'rgba(20,20,24,0.92)';
  ctx.fill();
  ctx.strokeStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.4)';
  ctx.lineWidth = sel ? 2.5 : 1.2;
  ctx.stroke();
  if (move) {
    ctx.globalAlpha = flowFlashAlpha();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 6]);
    drawRoundRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6, 14);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  // Header: type emoji + label.
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 13px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(FLOW_NODE_TYPES[n.type].emoji + '  ' + FLOW_NODE_TYPES[n.type].label, r.x + 10, r.y + 20);
  // Per-type read-only content.
  if (n.type === 'note') drawFlowWidgetNote(n, r);
  else if (n.type === 'volumeEnv') drawFlowWidgetEnv(n, r);
  else if (n.type === 'env') drawFlowWidgetCurve(n, r);
  else if (n.type === 'wave') drawFlowWidgetWave(n, r);
  else if (n.type === 'unison') drawFlowWidgetUnison(n, r);
  // Warning badge on a note whose required connections are missing.
  if (n.type === 'note' && !flowNoteReady(n)) {
    ctx.beginPath();
    ctx.arc(r.x + r.w - 14, r.y + 14, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#e06060';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', r.x + r.w - 14, r.y + 14 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  // Delete countdown overlay while a longer hold is deleting this node.
  if (flowHold && flowHold.id === n.id && flowHold.stage === 2) {
    const remain = FLOW_DELETE_MS - (performance.now() - flowHold.del0);
    const num = Math.max(1, Math.ceil(remain / 1000));
    drawRoundRect(r.x, r.y, r.w, r.h, 12);
    ctx.fillStyle = 'rgba(130,20,20,0.88)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), r.x + r.w / 2, r.y + r.h / 2 - 8);
    ctx.font = '700 11px sans-serif';
    ctx.fillText('hold to delete · release to cancel', r.x + r.w / 2, r.y + r.h / 2 + 22);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.globalAlpha = 1;
}
// Draw one of a note's three play buttons (tap / full / live). `ready` dims a
// button whose note has no volume + wave yet; `active` highlights the live
// button while it is being held.
// Draw one of a note's four play buttons (tap / full / live / repeat).
// `ready` dims a button whose note has no volume + wave yet; `active` highlights
// a button that is engaged (a held live note, or the repeat toggle on); `stop`
// turns the button red with a stop label (the looping button while a repeat runs).
function drawFlowNotePlayButton(b, label, ready, active, font, stop) {
  drawRoundRect(b.x, b.y, b.w, b.h, 8);
  if (stop) ctx.fillStyle = '#8a2b2b';
  else if (active) ctx.fillStyle = '#0e5a34';
  else ctx.fillStyle = ready ? '#1b8a4a' : '#2b2b2b';
  ctx.fill();
  ctx.strokeStyle = (stop || active) ? '#ffffff' : (ready ? '#1b8a4a' : 'rgba(255,255,255,0.3)');
  ctx.lineWidth = (stop || active) ? 2 : 1.5;
  ctx.stroke();
  ctx.fillStyle = ready ? '#ffffff' : 'rgba(255,255,255,0.4)';
  ctx.font = font || '800 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
}
function drawFlowWidgetNote(n, r) {
  const ready = flowNoteReady(n);
  // Four play buttons (always live — tapping them plays, never edits).
  const btns = flowNoteWidgetButtons(r);
  const looping = flowLoopingMode();
  const liveOn = !!(flowLive && flowLive.nodeId === n.id);
  drawFlowNotePlayButton(btns.tap, looping === 'tap' ? '■' : 'Tap', ready, looping === 'tap', '800 9px sans-serif');
  drawFlowNotePlayButton(btns.full, looping === 'full' ? '■' : 'Full', ready, looping === 'full', '800 9px sans-serif');
  drawFlowNotePlayButton(btns.live, 'Live', ready, liveOn, '800 9px sans-serif');
  drawFlowNotePlayButton(btns.repeat, '⟳', ready, flowRepeat, '800 11px sans-serif');
  // Note-life readout: the slider is shown but read-only until edit mode.
  const env = flowNoteLifeEnv(n);
  const ms = env ? flowNoteLifeMs(n) : 0;
  ctx.fillStyle = env ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)';
  ctx.font = '800 10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Note life', r.x + 12, r.y + 74);
  ctx.textAlign = 'right';
  ctx.fillText(ms ? Math.round(ms) + ' ms' : '—', r.x + r.w - 10, r.y + 74);
  ctx.textBaseline = 'alphabetic';
  const s = flowNoteWidgetLife(r);
  ctx.globalAlpha = env ? 1 : 0.4;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y); ctx.lineTo(s.x2, s.y);
  ctx.stroke();
  if (env) {
    const frac = clamp01((ms - FLOW_NOTE_LIFE_MIN) / (FLOW_NOTE_LIFE_MAX - FLOW_NOTE_LIFE_MIN));
    const tx = s.x + frac * (s.x2 - s.x);
    ctx.strokeStyle = FLOW_WAVE_ACCENT;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y); ctx.lineTo(tx, s.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx, s.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.globalAlpha = 1;
}
function drawFlowWidgetEnv(n, r) {
  const pl = flowMiniPlot(r);
  const saved = ENVELOPE;
  ENVELOPE = n.envelope;
  try {
    const eb = envBoundaries();
    const trim = envTrim(ENVELOPE);
    const vOf = v => clamp01(v + trim);
    drawMiniPlotFrame(pl);
    const pts = [];
    for (let i = 0; i <= eb.n; i++) pts.push({ x: tToX(eb.tOf(eb.b[i]), pl), y: vToY(vOf(eb.vals[i]), pl), v: vOf(eb.vals[i]), el: i < eb.n ? eb.env.components[i] : null });
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    strokeSegPath(pts, 1, v => vToY(clamp01(v), pl));
    ctx.lineCap = 'butt';
    for (let i = 0; i <= eb.n; i++) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(tToX(eb.tOf(eb.b[i]), pl), vToY(vOf(eb.vals[i]), pl), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // HOLD / CUT / REL marker ticks.
    const tl = designTimeline();
    const marks = [['hold', tl.tHoldStart, '#7ecfff'], ['cut', tl.tCut, '#ffb37a'], ['rel', tl.tHoldEnd, '#ff9aa0']];
    for (const m of marks) {
      const mx = tToX(m[1], pl);
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = m[2];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mx, pl.top); ctx.lineTo(mx, pl.bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  } finally {
    ENVELOPE = saved;
  }
}
function drawFlowWidgetCurve(n, r) {
  const pl = flowMiniPlot(r);
  const pts = (n.env && Array.isArray(n.env.points) && n.env.points.length >= 2) ? n.env.points : null;
  const trim = (n.env && +n.env.trim) || 0;
  drawMiniPlotFrame(pl);
  if (!pts) return;
  ctx.strokeStyle = '#8dd3ff';
  ctx.lineWidth = 2;
  strokeSegPath(flowCurveScreenPoints(pts, trim, pl), 1, v => ampToY(clampSign(v), pl));
  for (const pt of pts) {
    ctx.fillStyle = '#8dd3ff';
    ctx.beginPath();
    ctx.arc(tToX(pt.t, pl), ampToY(clampSign(pt.v + trim), pl), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
function drawFlowWidgetWave(n, r) {
  const pl = flowMiniPlot(r);
  const l = flowWaveLayer(n);
  initLayerSpecPoints(l);
  const pts = l.specPoints || [];
  drawMiniPlotFrame(pl);
  ctx.strokeStyle = FLOW_WAVE_ACCENT;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tToX(0, pl), ampToY(specValueAt(pts, 0), pl));
  for (let j = 0; j < pts.length; j++) ctx.lineTo(tToX(pts[j].x, pl), ampToY(pts[j].a, pl));
  ctx.lineTo(tToX(1, pl), ampToY(specValueAt(pts, 1), pl));
  ctx.stroke();
  for (const pt of pts) {
    ctx.fillStyle = FLOW_WAVE_ACCENT;
    ctx.beginPath();
    ctx.arc(tToX(pt.x, pl), ampToY(pt.a, pl), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
// A unison param (st / ct / vol) is locked when its animation envelope is
// connected to the node — the envelope drives that value, so its slider is
// disabled until the connection is removed.
function flowUnisonParamLocked(node, key) {
  return !!(node && connSlotGet(node, { key: key + 'Env' }));
}
function drawFlowWidgetUnison(n, r) {
  const vs = (Array.isArray(n.voices) && n.voices.length) ? n.voices : null;
  if (!vs) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('No voices yet', r.x + 10, r.y + r.h / 2 + 6);
    ctx.textBaseline = 'alphabetic';
    return;
  }
  const v = vs[Math.min(flowUnisonSel, vs.length - 1)];
  let y = r.y + 30;
  for (const d of VOICE_PARAM_DEFS) {
    const val = +((v && v[d.key] != null) ? v[d.key] : (d.key === 'vol' ? 1 : 0));
    const locked = flowUnisonParamLocked(n, d.key);
    drawFlowWidgetFader(d.label, val, d.min, d.max, d.fmt, y, r, locked);
    y += 28;
  }
}
function drawFlowWidgetFader(label, val, min, max, fmt, y, r, locked) {
  const trackX1 = r.x + 58, trackX2 = r.x + r.w - 54;
  ctx.globalAlpha = locked ? 0.4 : 1;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '800 9px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, r.x + 10, y);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(trackX1, y); ctx.lineTo(trackX2, y);
  ctx.stroke();
  if (locked) {
    // An envelope drives this parameter — the slider is inert (a flat hollow
    // track, ENV in place of the value).
  } else {
    const f = clamp01((val - min) / (max - min));
    const kx = trackX1 + f * (trackX2 - trackX1);
    ctx.strokeStyle = FLOW_UNISON_ACCENT;
    ctx.beginPath();
    ctx.moveTo(trackX1, y); ctx.lineTo(kx, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(kx, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  ctx.lineCap = 'butt';
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '700 9px sans-serif';
  ctx.fillText(locked ? 'ENV' : fmt(val), r.x + r.w - 8, y);
  ctx.globalAlpha = 1;
}

/* ---- Note editor ----
   A note's editing surface is just its widget grown in place: four ▶ play
   buttons (tap / full length / live / repeat) plus an editable Note-life slider
   (scales the connected volume env). Tapping outside the enlarged card closes
   it back down. */
var flowNoteEdit = null;    // id of the note node being edited, or null
function flowNoteEditorButtons(p) {
  const w = p.w - 32, h = 30, x = p.x + 16;
  return {
    tap:    { x, y: p.y + 44, w, h },
    full:   { x, y: p.y + 78, w, h },
    live:   { x, y: p.y + 112, w, h },
    repeat: { x, y: p.y + 146, w, h },
  };
}
function flowNoteEditorLife(p) {
  return { x: p.x + 108, x2: p.x + p.w - 20, y: p.y + 190 };
}
function openFlowNoteEditor(id) {
  const n = flowNodeById(id);
  if (!n || n.type !== 'note') return;
  flowNoteEdit = id;
  flowAddMenu = null;
  flowMoveId = null;
  flowConnArm = null;
  flowSelId = id;
}
function closeFlowNoteEditor() {
  if (!flowNoteEdit) return;
  flowNoteEdit = null;
  saveFlow();
}
function drawFlowNoteEditor() {
  const p = flowNotePanel();
  const n = flowNodeById(flowNoteEdit);
  if (!n) return;
  drawRoundRect(p.x, p.y, p.w, p.h, 14);
  ctx.fillStyle = 'rgba(14,14,16,0.74)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 16px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('🎵  Note', p.x + 16, p.y + 30);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '700 11px sans-serif';
  ctx.fillText('Aggregates volume + up to 3 waves', p.x + 96, p.y + 30);
  // Four play buttons: tap, full length, live (hold), repeat (tap/full loop).
  const ready = flowNoteReady(n);
  const btns = flowNoteEditorButtons(p);
  const looping = flowLoopingMode();
  const liveOn = !!(flowLive && flowLive.nodeId === n.id);
  drawFlowNotePlayButton(btns.tap, looping === 'tap' ? '■ Stop' : '▶ Play (tap)', ready, looping === 'tap', '800 13px sans-serif', looping === 'tap');
  drawFlowNotePlayButton(btns.full, looping === 'full' ? '■ Stop' : '▶ Play (full length)', ready, looping === 'full', '800 13px sans-serif', looping === 'full');
  drawFlowNotePlayButton(btns.live, '▶ Play (live — press & hold)', ready, liveOn, '800 13px sans-serif');
  drawFlowNotePlayButton(btns.repeat, flowRepeat ? '⟳ Repeat: ON' : '⟳ Repeat: OFF', ready, flowRepeat, '800 13px sans-serif');
  // Note-life slider (editable here).
  const env = flowNoteLifeEnv(n);
  const ms = env ? flowNoteLifeMs(n) : 0;
  ctx.fillStyle = env ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)';
  ctx.font = '800 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Note life', p.x + 16, p.y + 190);
  ctx.textAlign = 'right';
  ctx.fillText(ms ? Math.round(ms) + ' ms' : '—', p.x + p.w - 16, p.y + 190);
  ctx.textBaseline = 'alphabetic';
  const s = flowNoteEditorLife(p);
  ctx.globalAlpha = env ? 1 : 0.4;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y); ctx.lineTo(s.x2, s.y);
  ctx.stroke();
  if (env) {
    const frac = clamp01((ms - FLOW_NOTE_LIFE_MIN) / (FLOW_NOTE_LIFE_MAX - FLOW_NOTE_LIFE_MIN));
    const tx = s.x + frac * (s.x2 - s.x);
    ctx.strokeStyle = FLOW_WAVE_ACCENT;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y); ctx.lineTo(tx, s.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx, s.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Tap outside this card to close', p.x + p.w / 2, p.y + p.h - 16);
  ctx.textBaseline = 'alphabetic';
}
function flowNoteHandleDown(x, y) {
  const p = flowNotePanel();
  if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) { closeFlowNoteEditor(); return; }
  const n = flowNodeById(flowNoteEdit);
  const btns = flowNoteEditorButtons(p);
  const hitBtn = btns.tap.x <= x && x <= btns.tap.x + btns.tap.w && y >= btns.tap.y && y <= btns.tap.y + btns.tap.h
    ? 'tap' : (btns.full.x <= x && x <= btns.full.x + btns.full.w && y >= btns.full.y && y <= btns.full.y + btns.full.h
      ? 'full' : (btns.live.x <= x && x <= btns.live.x + btns.live.w && y >= btns.live.y && y <= btns.live.y + btns.live.h
        ? 'live' : (btns.repeat.x <= x && x <= btns.repeat.x + btns.repeat.w && y >= btns.repeat.y && y <= btns.repeat.y + btns.repeat.h
          ? 'repeat' : null)));
  if (hitBtn && n) {
    if (hitBtn === 'tap') flowPlayMode('tap', n);
    else if (hitBtn === 'full') flowPlayMode('full', n);
    else if (hitBtn === 'repeat') flowRepeatToggle();
    else if (flowLiveStart(n)) return;   // live starts on press, ends on release
    return;
  }
  const s = flowNoteEditorLife(p);
  if (y >= s.y - 18 && y <= s.y + 18 && x >= s.x - 12 && x <= s.x2 + 12) {
    if (n) {
      flowPushHistory();
      flowSetNoteLife(n, flowNoteLifeFromX(s, x));
      flowPtr = { kind: 'noteLife', nodeId: n.id };
    }
  }
}
function flowNoteHandleMove(x, y) {
  if (!flowPtr || flowPtr.kind !== 'noteLife') return;
  const n = flowNodeById(flowPtr.nodeId);
  if (n) flowSetNoteLife(n, flowNoteLifeFromX(flowNoteEditorLife(flowNotePanel()), x));
}
function flowNoteHandleUp() {
  if (flowPtr && flowPtr.kind === 'noteLife') saveFlow();
  flowPtr = null;
  if (flowLive) flowLiveEnd();
}
// Open the editor for a node (tap on its widget → edit mode, growing in place).
// The camera pans to center the node while the editor is open, so the enlarged
// window settles in the middle of the screen.
function openFlowNodeEditor(id) {
  const n = flowNodeById(id);
  if (!n) return;
  flowSelConn = null;
  panToNode(n);
  if (n.type === 'note') openFlowNoteEditor(id);
  else if (n.type === 'volumeEnv') openFlowEnvelopeEditor(id);
  else if (n.type === 'env') openFlowCurveEditor(id);
  else if (n.type === 'wave') openFlowWaveEditor(id);
  else if (n.type === 'unison') openFlowUnisonEditor(id);
}

/* ---- Rendering ---- */
function drawFlow(now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  const g = flowGridArea();

  // ---- Grid squares: white dotted lines, panned by flowCam (hidden; kept for
  // a possible return — flip FLOW_SHOW_GRID) ----
  if (FLOW_SHOW_GRID) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    const { gx0, gx1, gy0, gy1 } = flowCellRange();
    for (let gx = gx0; gx <= gx1; gx++) {
      const sx = Math.round(gx * FLOW_CELL - flowCam.x);
      ctx.moveTo(sx, g.top); ctx.lineTo(sx, g.bottom);
    }
    for (let gy = gy0; gy <= gy1; gy++) {
      const sy = Math.round(gy * FLOW_CELL - flowCam.y);
      ctx.moveTo(g.left, sy); ctx.lineTo(g.right, sy);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // ---- Cell coordinate labels (bottom-right of each square) ----
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '15px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const p = flowCellScreen(gx, gy);
        const lx = Math.min(g.right - 3, p.x + FLOW_CELL - 3);
        const ly = Math.min(g.bottom - 2, p.y + FLOW_CELL - 2);
        ctx.fillText(gx + ',' + gy, lx, ly);
      }
    }
  }

  // ---- Wires (consumer slots → sources), drawn under the nodes ----
  drawFlowWires();

  // ---- Connecting mode: highlight valid targets ----
  if (flowConnArm) {
    const consumer = flowNodeById(flowConnArm.nodeId);
    if (consumer) {
      for (const n of flowNodes) {
        if (!flowConnCanAssign(consumer, flowConnArm.slot, n.id)) continue;
        const r = flowWidgetRect(n, false);
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 250);
        ctx.strokeStyle = '#5cdb7a';
        ctx.lineWidth = 3;
        drawRoundRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6, 14);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  // ---- Sound nodes: always-visible widget cards (the editing node's enlarged
  // editor draws in its place, further down). ----
  for (const n of flowNodes) {
    if (n.id === flowActiveEditId()) continue;
    drawFlowWidget(n);
  }

  // ---- Add-node menu (around the anchored cell) ----
  if (flowAddMenu) {
    const opts = flowAddMenuOptions();
    for (const o of opts) {
      ctx.beginPath();
      ctx.arc(o.cx, o.cy, o.r, 0, Math.PI * 2);
      ctx.fillStyle = '#1b1b1b';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = '28px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.emoji, o.cx, o.cy + 1);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '700 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(o.label, o.cx, o.cy + o.r + 15);
    }
  }

  // ---- On-node connection ports (drawn on top of the widgets) ----
  drawFlowPorts();

  // ---- Selected wire: edge jump buttons to its off-screen endpoints ----
  drawFlowJumpButtons();

  // ---- Long-press on a wire: flash / 3-2-1 delete countdown ----
  drawFlowConnHold();

  // ---- Node-list side bar (on top of the grid, before the banner/buttons) ----
  if (flowSideOpen) drawFlowSide();

  // ---- Connecting banner (a slot is armed, awaiting a grid tap) ----
  if (flowConnArm) {
    const bx = flowSideOpen ? FLOW_SIDE_W + 16 : 70;   // clear of the side bar / toggle button
    const bw = Math.max(200, Math.min(332, W - 176 - bx));   // clear of the top-right buttons
    drawRoundRect(bx, 16, bw, 34, 10);
    ctx.fillStyle = 'rgba(22,26,34,0.95)';
    ctx.fill();
    ctx.strokeStyle = FLOW_UNISON_ACCENT;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Connecting… tap a node to connect · tap the port to cancel', bx + 14, 34);
    ctx.textBaseline = 'alphabetic';
  }

  // ---- Top-left side-bar expand/collapse button (overlays the panel header) ----
  const sb = flowSideBtnRect();
  ctx.beginPath();
  ctx.arc(sb.x + sb.d / 2, sb.y + sb.d / 2, FLOW_BACK_R, 0, Math.PI * 2);
  ctx.fillStyle = '#2b2b2b';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(flowSideOpen ? '✕' : '☰', sb.x + sb.d / 2, sb.y + sb.d / 2 + 1);
  ctx.textBaseline = 'alphabetic';

  // ---- Control buttons: undo (top-right) and back-to-playing-field (bottom-right) ----
  const tbs = flowTopButtonRects();
  const tbIcons = [['undo', '↺'], ['back', '‹']];
  for (const [k, glyph] of tbIcons) {
    const b = tbs[k];
    const can = k !== 'undo' || flowHistory.length > 0;
    ctx.beginPath();
    ctx.arc(b.x + b.d / 2, b.y + b.d / 2, FLOW_BACK_R, 0, Math.PI * 2);
    ctx.fillStyle = can ? '#2b2b2b' : '#1a1a1a';
    ctx.fill();
    ctx.strokeStyle = can ? '#ffffff' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = can ? '#ffffff' : 'rgba(255,255,255,0.4)';
    ctx.font = '800 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, b.x + b.d / 2, b.y + b.d / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }

  // ---- Editor overlay: the node's enlarged in-place editor (on top) ----
  if (flowNoteEdit) drawFlowNoteEditor();
  else if (flowEnvEdit) drawFlowEnvEditor();
  else if (flowWaveEdit) drawFlowWaveEditor();
  else if (flowUnisonEdit) drawFlowUnisonEditor();
  else if (flowCurveEdit) drawFlowCurveEditor();
}

/* ---- Envelope editor overlay ----
   Editing an envelope node reuses the legacy sound creator's envelope logic
   (envBoundaries, envSplitAtTime, envDragBoundary, envDeleteAt, markerValidTimes,
   dragCreatorMarker, hitTestEnv, segment line types, ...) by temporarily pointing
   the shared global ENVELOPE at the node's own envelope object. The overlay
   panel is drawn with this screen's dark theme and is partially transparent so
   the flow grid stays visible behind it. */
var flowEnvEdit = null;    // id of the envelope node being edited, or null
var flowEnvSaved = null;   // the global ENVELOPE saved before the swap (restored on close)
var flowEnvDirty = false;  // any edit happened this session (coalesces into one undo entry)
var flowEnvPtr = null;     // { kind: 'bound'|'draw'|'drawzone'|'segarm'|'trim'|'segparam', ... } active overlay drag
var flowEnvMarker = null;  // armed HOLD/CUT/REL marker awaiting a destination tap
var flowEnvSegFrom = null, flowEnvSegTo = null;   // selected segment (boundary indexes)

// The shared enlarged editor panel: the node's own widget, grown in place at
// its position (centered on the node, clamped to stay on screen), so the rest
// of the grid stays visible around it. Tapping outside it ends edit mode. The
// size is a fixed px target (not a screen percentage) so on large screens like
// an iPad it stays a modest window; it only clamps down to fit a small screen.
function flowEnvPanel() {
  const w = Math.min(520, W - 24);
  const h = Math.min(360, H - 24);
  const id = flowActiveEditId();
  const n = id ? flowNodeById(id) : null;
  if (!n) return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  const p = flowNodeScreen(n);
  const x = Math.max(12, Math.min(W - 12 - w, p.x - w / 2));
  const y = Math.max(12, Math.min(H - 12 - h, p.y - h / 2));
  return { x, y, w, h };
}
// The note editor's enlarged panel: a more compact card than the graph editors.
function flowNotePanel() {
  const w = Math.min(420, W - 24);
  const h = Math.min(240, H - 24);
  const n = flowNoteEdit ? flowNodeById(flowNoteEdit) : null;
  if (!n) return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  const p = flowNodeScreen(n);
  const x = Math.max(12, Math.min(W - 12 - w, p.x - w / 2));
  const y = Math.max(12, Math.min(H - 12 - h, p.y - h / 2));
  return { x, y, w, h };
}
// The graph editors' plot area. `header` adds the docked line-mode strip's
// height above the plot (used by the envelope and env-curve editors, which
// park the segment type pills there); the wave editor keeps the plain layout.
function flowEnvPlot(p, header) {
  const top = p.y + 140 + (header ? FLOW_ENV_HEADER_H : 0), bottom = p.y + p.h - 28, left = p.x + 32, right = p.x + p.w - 18;
  return { top, bottom, left, right, pw: right - left, ph: bottom - top };
}
function flowEnvClearPill(p) {
  return { x: p.x + p.w - 70, y: p.y + 8, w: 54, h: 26 };
}
function flowEnvTrimSlider(p) {
  const pl = flowEnvPlot(p, true);
  return { x: p.x + 8, w: 14, y0: pl.top + 4, y1: pl.bottom - 4 };
}
function flowEnvMarkerTabs(p) {
  const pl = flowEnvPlot(p, true);
  const defs = [
    { key: 'hold', label: 'HOLD', color: '#7ecfff' },
    { key: 'cut', label: 'CUT', color: '#ffb37a' },
    { key: 'rel', label: 'REL', color: '#ff9aa0' },
  ];
  const tl = designTimeline();
  const tOf = m => m.key === 'hold' ? tl.tHoldStart : m.key === 'cut' ? tl.tCut : tl.tHoldEnd;
  const w = 54, h = 18;
  const y1 = pl.top - 52, y2 = pl.top - 34;
  const tabs = [];
  for (const m of defs) {
    const cx = tToX(tOf(m), pl);
    let y = y1;
    for (const t of tabs) if (Math.abs(t.cx - cx) < 50) y = y2;
    tabs.push({ key: m.key, label: m.label, color: m.color, cx, x: cx - w / 2, y, w, h });
  }
  return tabs;
}
// Reuse the legacy envelope editor, but against the node's own envelope.
function openFlowEnvelopeEditor(id) {
  const n = flowNodeById(id);
  if (!n || n.type !== 'volumeEnv') return;
  if (!n.envelope || !Array.isArray(n.envelope.components) || !n.envelope.components.length) n.envelope = clone(DEFAULT_ENVELOPE);
  flowEnvSaved = ENVELOPE;          // remember the instrument's envelope
  ENVELOPE = n.envelope;            // legacy helpers now edit the node's envelope
  flowEnvEdit = id;
  flowEnvDirty = false;
  flowEnvPtr = null;
  flowEnvMarker = null;
  flowEnvSegFrom = null;
  flowEnvSegTo = null;
  flowAddMenu = null;
  flowMoveId = null;
  flowConnArm = null;
  flowSelId = id;
}
function closeFlowEnvelopeEditor() {
  if (!flowEnvEdit) return;
  ENVELOPE = flowEnvSaved;          // restore the instrument's envelope
  flowEnvSaved = null;
  flowEnvEdit = null;
  flowEnvDirty = false;
  flowEnvPtr = null;
  flowEnvMarker = null;
  flowEnvSegFrom = null;
  flowEnvSegTo = null;
  saveFlow();
}
// Wrap an edit: the first mutation of a session records one undo entry.
function flowEnvMutate(fn) {
  if (!flowEnvDirty) { flowPushHistory(); flowEnvDirty = true; }
  fn();
}
function flowEnvApplyTrimFromY(sl, y) {
  const f = Math.max(0, Math.min(1, (y - sl.y0) / (sl.y1 - sl.y0)));
  flowEnvMutate(() => { ENVELOPE.trim = Math.max(-1, Math.min(1, 1 - 2 * f)); });
}
// Draw mode: scribble breakpoints along the finger's path, reusing the legacy
// envDrawAt (slot grid from drawPointCount/slotT/slotAtX).
function flowEnvDrawAt(slotX, y, pl, fromS) {
  const loS = Math.min(slotX, fromS == null ? slotX : fromS);
  const hiS = Math.max(slotX, fromS == null ? slotX : fromS);
  flowEnvMutate(() => { envDrawAt(slotT(slotX), yToV(y, pl) - envTrim(ENVELOPE), pl, slotT(loS), slotT(hiS), false); });
}

/* ---- Segment line types (Line mode) ----
   Reuses the legacy segment machinery (DEFAULT_SEG, segOf, SEGMENT_TYPE_ORDER,
   SEGMENT_TYPE_DEFS, SEGMENT_TYPE_PARAMS, SEG_PARAM_DEFS) against the
   envelope's own components, with self-contained selection state. */
function flowEnvSegModel() {
  return { elems: ENVELOPE.components, lastPoint: ENVELOPE.components.length + 1 };
}
function flowEnvSegRange() {
  const m = flowEnvSegModel();
  if (flowEnvSegFrom == null && flowEnvSegTo == null) return null;
  const a = flowEnvSegFrom == null ? flowEnvSegTo : flowEnvSegFrom;
  const b = flowEnvSegTo == null ? flowEnvSegFrom : flowEnvSegTo;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.max(a, b);
  if (lo >= m.lastPoint || hi >= m.lastPoint) return null;
  return { m, lo, hi };
}
function flowEnvSegCurrent() {
  const r = flowEnvSegRange();
  return r ? r.m.elems[r.lo] : null;
}
function flowEnvForEachSeg(fn) {
  const r = flowEnvSegRange();
  if (!r) return;
  const end = r.hi + (r.hi <= r.lo ? 0 : -1);
  for (let i = r.lo; i <= end; i++) { const el = r.m.elems[i]; if (el) fn(el); }
}
function flowEnvSegParamValue(key) {
  const el = flowEnvSegCurrent();
  if (!el) return SEG_PARAM_DEFS[key].min;
  const s = segOf(el);
  return Math.max(SEG_PARAM_DEFS[key].min, Math.min(SEG_PARAM_DEFS[key].max, +s[key] || SEG_PARAM_DEFS[key].min));
}
function flowEnvSegParamFromX(g, x) {
  const d = SEG_PARAM_DEFS[g.key];
  let v = d.min + clamp01((x - g.x1) / (g.x2 - g.x1)) * (d.max - d.min);
  v = Math.round(v / d.step) * d.step;
  return Math.max(d.min, Math.min(d.max, v));
}
function flowEnvSetSegType(t) {
  if (SEGMENT_TYPE_ORDER.indexOf(t) < 0) return;
  flowEnvMutate(() => {
    flowEnvForEachSeg(el => {
      if (!el.seg || typeof el.seg !== 'object') el.seg = clone(DEFAULT_SEG);
      el.seg.type = t;
    });
  });
}
function flowEnvSetSegParam(key, v) {
  const d = SEG_PARAM_DEFS[key];
  if (!d) return;
  v = Math.max(d.min, Math.min(d.max, +v || d.min));
  flowEnvMutate(() => {
    flowEnvForEachSeg(el => {
      if (!el.seg || typeof el.seg !== 'object') el.seg = clone(DEFAULT_SEG);
      el.seg[key] = v;
    });
  });
}
// The line-mode strip (docked at the top of the editor window, above the plot):
// type pills on the first row, the active type's parameter controls on the
// second — shown only while a segment is selected.
function flowSegTypeOf(cur) {
  return cur ? segOf(cur).type : 'line';
}
// Parameter control groups for a segment type (`type` = line/stairs/spring/
// pulse): one group per param, each = label + −/+ buttons + a slider, laid out
// across the given width at the row's center y.
function flowSegParamGroups(x, w, cy, type) {
  const params = SEGMENT_TYPE_PARAMS[type] || [];
  const n = params.length;
  if (!n) return [];
  const pad = 10, gap = 14;
  const avail = w - pad * 2 - gap * (n - 1);
  const gw = avail / n;
  const btnW = 24, labelW = 46, valW = 50;
  return params.map((pr, i) => {
    const gx = x + pad + i * (gw + gap);
    const bxMinus = gx + labelW + 2;
    const valRight = gx + gw - 2;
    const bxPlus = valRight - valW - btnW - 4;
    return { key: pr, cy, btnW, labelW, gx, gw, bxMinus, bxPlus, x1: bxMinus + btnW + 4, x2: bxPlus - 4 };
  });
}
// The docked line-mode strip: type pills on the first row, the active type's
// parameter controls on the second. Parked at the top of the editor window
// (above the plot) instead of floating over it as a card.
function flowSegStripLayout(p, type) {
  const x = p.x + 16, w = p.w - 32;
  const y0 = p.y + 50;
  const labelW = 80;
  const pillW = (w - labelW - (SEGMENT_TYPE_ORDER.length - 1) * 6) / SEGMENT_TYPE_ORDER.length;
  const px0 = x + labelW;
  const pills = SEGMENT_TYPE_ORDER.map((t, i) => ({ t, x: px0 + i * (pillW + 6), y: y0, w: pillW, h: 26 }));
  const params = flowSegParamGroups(x, w, y0 + 32 + 13, type);
  return { x, y0, w, labelW, pills, params, h: 26 + 6 + 26 };
}
function flowSegHitStrip(x, y, p, type) {
  const S = flowSegStripLayout(p, type);
  if (y < S.y0 - 4 || y >= S.y0 + S.h) return null;
  for (const pill of S.pills) {
    if (x >= pill.x && x <= pill.x + pill.w && y >= pill.y && y <= pill.y + pill.h) return { type: 'type', t: pill.t };
  }
  for (const g of S.params) {
    if (y >= g.cy - g.btnW / 2 - 2 && y <= g.cy + g.btnW / 2 + 2) {
      if (x >= g.bxMinus && x <= g.bxMinus + g.btnW) return { type: 'param', key: g.key, dir: -1 };
      if (x >= g.bxPlus && x <= g.bxPlus + g.btnW) return { type: 'param', key: g.key, dir: 1 };
      if (x >= g.x1 - 6 && x <= g.x2 + 8) return { type: 'slider', key: g.key };
    }
  }
  return { type: 'bar' };
}
// Draw the docked line-mode strip. `sel` supplies the editor's segment
// accessors (current/range/paramValue) — the envelope and env-curve editors
// share the drawing via their own wrappers.
function drawFlowSegStrip(p, sel) {
  const cur = sel.current();
  const type = flowSegTypeOf(cur);
  const S = flowSegStripLayout(p, type);
  const r = sel.range();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Segment ' + (r ? r.lo : 0), S.x + 2, S.y0 + 17);
  for (const pill of S.pills) {
    const active = pill.t === type;
    drawRoundRect(pill.x, pill.y, pill.w, pill.h, 7);
    ctx.fillStyle = active ? '#ffffff' : '#222222';
    ctx.fill();
    ctx.strokeStyle = active ? '#ffffff' : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = active ? 1.5 : 1;
    ctx.stroke();
    ctx.fillStyle = active ? '#000000' : '#ffffff';
    ctx.font = '800 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(SEGMENT_TYPE_DEFS[pill.t].label, pill.x + pill.w / 2, pill.y + pill.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  if (!S.params.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '700 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Line = a straight ramp — pick a shape above', S.x + S.w / 2, S.y0 + S.h - 8);
    return;
  }
  for (const g of S.params) {
    const d = SEG_PARAM_DEFS[g.key];
    const val = sel.paramValue(g.key);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '800 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(d.label, g.gx + g.labelW - 2, g.cy + 5);
    for (const side of ['-', '+']) {
      const bx = side === '-' ? g.bxMinus : g.bxPlus;
      drawRoundRect(bx, g.cy - g.btnW / 2, g.btnW, g.btnW, 6);
      ctx.fillStyle = '#333333';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(side === '-' ? '−' : '+', bx + g.btnW / 2, g.cy + 1);
      ctx.textBaseline = 'alphabetic';
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(g.x1, g.cy); ctx.lineTo(g.x2, g.cy);
    ctx.stroke();
    const tx = g.x1 + (g.x2 - g.x1) * ((val - d.min) / (d.max - d.min));
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(g.x1, g.cy); ctx.lineTo(tx, g.cy);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(tx, g.cy, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(d.fmt(val), g.gx + g.gw - 2, g.cy + 5);
  }
}
// Distance from (px,py) to the segment (x1,y1)-(x2,y2).
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
// The index of the envelope segment (span i→i+1) whose drawn curve is nearest
// (x,y), or -1. Samples the seg-aware path so stairs/spring/pulse wobbles are
// hittable, not just the straight chords.
function flowEnvSegHit(x, y, pl) {
  const eb = envBoundaries();
  if (eb.n < 1) return -1;
  const trim = envTrim(ENVELOPE);
  const vOf = v => clamp01(v + trim);
  let best = -1, bd = 18;
  for (let i = 0; i < eb.n; i++) {
    const el = eb.env.components[i];
    const ax = tToX(eb.tOf(eb.b[i]), pl), ay = vToY(vOf(eb.vals[i]), pl);
    const bx = tToX(eb.tOf(eb.b[i + 1]), pl), by = vToY(vOf(eb.vals[i + 1]), pl);
    const s = segOf(el);
    const n = s.type === 'line' ? 2 : segDrawSamples(s);
    for (let k = 0; k < n; k++) {
      const f = k / n, f2 = (k + 1) / n;
      const p1x = ax + (bx - ax) * f, p1y = vToY(segValueAt(el, vOf(eb.vals[i]), vOf(eb.vals[i + 1]), f, 1), pl);
      const p2x = ax + (bx - ax) * f2, p2y = vToY(segValueAt(el, vOf(eb.vals[i]), vOf(eb.vals[i + 1]), f2, 1), pl);
      const d = distToSeg(x, y, p1x, p1y, p2x, p2y);
      if (d < bd) { bd = d; best = i; }
    }
  }
  return best;
}

function drawFlowEnvEditor() {
  const p = flowEnvPanel();
  const pl = flowEnvPlot(p, true);
  // Partially transparent backdrop: the flow grid shows through.
  drawRoundRect(p.x, p.y, p.w, p.h, 14);
  ctx.fillStyle = 'rgba(14,14,16,0.74)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Header.
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 16px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Envelope', p.x + 16, p.y + 30);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '700 11px sans-serif';
  ctx.fillText('Shapes this node’s volume over its note', p.x + 86, p.y + 30);
  // Dock the line-mode strip at the top while a segment is selected.
  if (flowEnvSegRange()) drawFlowSegStrip(p, { current: flowEnvSegCurrent, range: flowEnvSegRange, paramValue: flowEnvSegParamValue });
  // Clear pill.
  const cp = flowEnvClearPill(p);
  drawRoundRect(cp.x, cp.y, cp.w, cp.h, 8);
  ctx.fillStyle = '#2b2b2b';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Clear', cp.x + cp.w / 2, cp.y + cp.h / 2 + 4);
  // Selected-segment highlight band on the graph.
  if (flowEnvSegRange()) {
    const eb0 = envBoundaries();
    const sr = flowEnvSegRange();
    const x0 = tToX(eb0.tOf(eb0.b[sr.lo]), pl);
    const x1 = tToX(eb0.tOf(eb0.b[sr.hi]), pl);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x0, pl.top, Math.max(1, x1 - x0), pl.ph);
  }
  // Marker lane: grab tabs, dashed lines, and armed destinations.
  for (const tab of flowEnvMarkerTabs(p)) {
    ctx.strokeStyle = tab.color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tab.cx, tab.y + tab.h);
    ctx.lineTo(tab.cx, pl.top);
    ctx.stroke();
    ctx.globalAlpha = 1;
    const armed = flowEnvMarker === tab.key;
    drawRoundRect(tab.x, tab.y, tab.w, tab.h, 7);
    ctx.fillStyle = armed ? '#fff7cc' : tab.color;
    ctx.fill();
    ctx.strokeStyle = armed ? '#8a6d00' : 'rgba(0,0,0,0)';
    ctx.lineWidth = armed ? 2 : 0;
    ctx.stroke();
    ctx.fillStyle = armed ? '#5a4600' : '#0a0a0a';
    ctx.font = '800 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(tab.label, tab.cx, tab.y + 13);
  }
  if (flowEnvMarker) {
    const def = { hold: '#7ecfff', cut: '#ffb37a', rel: '#ff9aa0' }[flowEnvMarker];
    for (const t of markerValidTimes(flowEnvMarker)) {
      const dx = tToX(t, pl);
      ctx.beginPath();
      ctx.arc(dx, pl.top - 14, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = def;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  // Plot grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= 10; k++) {
    const gx = tToX(k / 10, pl);
    ctx.moveTo(gx, pl.top); ctx.lineTo(gx, pl.bottom);
    const gy = vToY(k / 10, pl);
    ctx.moveTo(pl.left, gy); ctx.lineTo(pl.right, gy);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(pl.left, pl.top, pl.pw, pl.ph);
  // Axis labels.
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '700 10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('100%', pl.left + 2, pl.top + 10);
  ctx.fillText('0%', pl.left + 2, pl.bottom - 4);
  // Envelope curve + boundary dots (offset by the trim).
  const eb = envBoundaries();
  const trim = envTrim(ENVELOPE);
  const vOf = v => clamp01(v + trim);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  const pts = [];
  for (let i = 0; i <= eb.n; i++) pts.push({ x: tToX(eb.tOf(eb.b[i]), pl), y: vToY(vOf(eb.vals[i]), pl), v: vOf(eb.vals[i]), el: i < eb.n ? eb.env.components[i] : null });
  strokeSegPath(pts, 1, v => vToY(clamp01(v), pl));
  for (let i = 0; i <= eb.n; i++) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(tToX(eb.tOf(eb.b[i]), pl), vToY(vOf(eb.vals[i]), pl), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Trim slider.
  const sl = flowEnvTrimSlider(p);
  const scx = sl.x + sl.w / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(scx, sl.y0); ctx.lineTo(scx, sl.y1);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(sl.x, (sl.y0 + sl.y1) / 2); ctx.lineTo(sl.x + sl.w, (sl.y0 + sl.y1) / 2);
  ctx.stroke();
  const tc = sl.y1 - (trim + 1) / 2 * (sl.y1 - sl.y0);
  drawRoundRect(sl.x, tc - 7, sl.w, 14, 7);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '700 8px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Trim', scx, sl.y0 - 6);
  // Drag feedback: while dragging a boundary the dot rides the finger; once it
  // leaves the plot a trashcan pill appears (release there deletes the point).
  const ptr = flowEnvPtr;
  if (ptr && ptr.kind === 'bound' && ptr.moved) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ptr.px, ptr.py, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (ptr.out && ENVELOPE.components.length > 1) {
      const bw = 46, bh = 30;
      const bx = Math.max(pl.left, Math.min(pl.right - bw, ptr.px - bw / 2));
      const by = Math.max(pl.top, Math.min(pl.bottom - bh, ptr.py - bh - 10));
      drawRoundRect(bx, by, bw, bh, 8);
      ctx.fillStyle = 'rgba(220,60,60,0.92)';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🗑', bx + bw / 2, by + bh / 2 + 1);
      ctx.textBaseline = 'alphabetic';
    }
  }
  // Hint.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Tap + drag adds a point · drag a dot off the graph to delete (🗑) · left-edge swipe draws · tap a line to shape it', p.x + p.w / 2, p.y + p.h - 8);
}

// A fatter grab for boundary dots than hitTestEnv's 18px: fingers are imprecise,
// and the end dot sits exactly on the plot's right edge, so a tap that lands a
// little past the border (or just off the dot) should still grab it rather than
// spawning a new point.
function flowEnvHitBoundary(x, y, pl) {
  const eb = envBoundaries();
  const trim = envTrim(ENVELOPE);
  const vOf = v => clamp01(v + trim);
  let best = -1, bd = 24;
  for (let i = 0; i <= eb.n; i++) {
    const d = Math.hypot(x - tToX(eb.tOf(eb.b[i]), pl), y - vToY(vOf(eb.vals[i]), pl));
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function flowEnvHandleDown(x, y) {
  const p = flowEnvPanel();
  const pl = flowEnvPlot(p, true);
  // Tap anywhere outside the panel to dismiss (no ✕ button).
  if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) { closeFlowEnvelopeEditor(); return; }
  // Clear pill: reset to a single straight line — a lone component holding the
  // full volume across the whole note (the flat "no shaping" envelope).
  const cp = flowEnvClearPill(p);
  if (x >= cp.x && x <= cp.x + cp.w && y >= cp.y && y <= cp.y + cp.h) {
    flowEnvMutate(() => {
      const env = {
        components: [{ id: newCompId(), name: 'Volume', duration: 2500, startValue: 100, endValue: 100 }],
        beginReleaseIndex: 1, holdStartIndex: 0, holdEndIndex: 0, earlyCutIndex: -1, trim: 0,
      };
      const n = flowNodeById(flowEnvEdit);
      if (n) n.envelope = env;
      ENVELOPE = env;
      clampEnvelopeIndexes();
    });
    flowEnvSegFrom = null;
    flowEnvSegTo = null;
    return;
  }
  // Line-mode strip (docked at the top): type pills / parameter controls.
  if (flowEnvSegRange()) {
    const type = flowSegTypeOf(flowEnvSegCurrent());
    const hit = flowSegHitStrip(x, y, p, type);
    if (hit) {
      if (hit.type === 'type') flowEnvSetSegType(hit.t);
      else if (hit.type === 'param') flowEnvSetSegParam(hit.key, flowEnvSegParamValue(hit.key) + hit.dir * SEG_PARAM_DEFS[hit.key].step);
      else if (hit.type === 'slider') {
        const S = flowSegStripLayout(p, type);
        const g = S.params.find(r => r.key === hit.key);
        if (g) { flowEnvSetSegParam(hit.key, flowEnvSegParamFromX(g, x)); flowEnvPtr = { kind: 'segparam', key: hit.key }; }
      }
      return;
    }
  }
  // Marker grab tabs (arm / disarm) — UI only, no data change, no undo entry.
  for (const tab of flowEnvMarkerTabs(p)) {
    if (x >= tab.x - 6 && x <= tab.x + tab.w + 6 && y >= tab.y - 4 && y <= tab.y + tab.h + 4) {
      flowEnvMarker = (flowEnvMarker === tab.key) ? null : tab.key;
      flowEnvPtr = null;
      return;
    }
  }
  // Armed marker: a destination dot moves it.
  if (flowEnvMarker && Math.abs(y - (pl.top - 14)) <= 12) {
    for (const t of markerValidTimes(flowEnvMarker)) {
      const dx = tToX(t, pl);
      if (Math.abs(x - dx) <= 10) {
        flowEnvMutate(() => { dragCreatorMarker(flowEnvMarker, t); flowEnvMarker = null; });
        return;
      }
    }
  }
  // Trim slider.
  const sl = flowEnvTrimSlider(p);
  if (x >= sl.x - 4 && x <= sl.x + sl.w + 4 && y >= sl.y0 - 8 && y <= sl.y1 + 6) {
    flowEnvApplyTrimFromY(sl, y);
    flowEnvPtr = { kind: 'trim' };
    return;
  }
  // Plot: the gesture decides the mode (no toolbar).
  if (y < pl.top || y > pl.bottom) return;
  // 1. A dot grabs a boundary to move it.
  const bidx = flowEnvHitBoundary(x, y, pl);
  if (bidx >= 0) {
    flowEnvSegFrom = null; flowEnvSegTo = null;
    flowEnvPtr = { kind: 'bound', idx: bidx, px: x, py: y, moved: false, out: false };
    return;
  }
  // 2. A swipe starting in the left-edge strip is draw mode.
  if (x <= pl.left + FLOW_ENV_DRAW_ZONE) {
    flowEnvPtr = { kind: 'drawzone', px: x, py: y, moved: false };
    return;
  }
  // 3. Tapping a segment line selects it (opens the docked strip).
  const segIdx = flowEnvSegHit(x, y, pl);
  if (segIdx >= 0) {
    flowEnvPtr = { kind: 'segarm', idx: segIdx, px: x, py: y, moved: false };
    return;
  }
  // 4. Empty space: add a point at the tap and start dragging it. The new
  // point is placed exactly under the finger (like the wave editor), so the
  // dot grabs cleanly and its Y follows the drag from the very first move.
  if (x < pl.left - 4 || x > pl.right + 4) return;
  const eb = envBoundaries();
  const tT = clamp01(xToT(x, pl));
  let addIdx = -1;
  flowEnvMutate(() => {
    envSplitAtTime(tT * eb.total);
    // Locate the freshly-split boundary by time (it lands exactly at the tap's
    // X), then drop it at the finger's Y.
    const eb2 = envBoundaries();
    let best = -1, bd = Infinity;
    for (let i = 1; i <= eb2.n; i++) {
      const d = Math.abs(eb2.tOf(eb2.b[i]) - tT);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) envDragBoundary(best, tT, yToV(y, pl) - envTrim(ENVELOPE));
    addIdx = best;
  });
  flowEnvSegFrom = null; flowEnvSegTo = null;
  if (addIdx >= 0) flowEnvPtr = { kind: 'bound', idx: addIdx, px: x, py: y, moved: false, out: false };
}

function flowEnvHandleMove(x, y) {
  if (!flowEnvPtr) return;
  const p = flowEnvPanel();
  const pl = flowEnvPlot(p, true);
  const k = flowEnvPtr.kind;
  if (k === 'bound') {
    flowEnvPtr.px = x; flowEnvPtr.py = y;
    flowEnvPtr.moved = true;
    flowEnvPtr.out = (x < pl.left - FLOW_ENV_DELETE_BUFFER || x > pl.right + FLOW_ENV_DELETE_BUFFER || y < pl.top - FLOW_ENV_DELETE_BUFFER || y > pl.bottom + FLOW_ENV_DELETE_BUFFER);
    flowEnvMutate(() => { envDragBoundary(flowEnvPtr.idx, xToT(x, pl), yToV(y, pl) - envTrim(ENVELOPE)); });
    // Re-sorting can move the dragged boundary's index; re-locate it (at its
    // clamped position) so a release off the graph deletes the right point.
    const dv = clamp01(yToV(y, pl) - envTrim(ENVELOPE));
    const cpx = tToX(clamp01(xToT(x, pl)), pl);
    const cpy = vToY(clamp01(dv + envTrim(ENVELOPE)), pl);
    const hit = flowEnvHitBoundary(cpx, cpy, pl);
    if (hit >= 0) flowEnvPtr.idx = hit;
  } else if (k === 'draw') {
    const s = slotAtX(x, pl);
    flowEnvDrawAt(s, y, pl, flowEnvPtr.lastSlot);
    flowEnvPtr.lastSlot = s;
  } else if (k === 'drawzone') {
    if (!flowEnvPtr.moved && x - flowEnvPtr.px > FLOW_TAP_MAX) {
      flowEnvPtr.moved = true;
      flowEnvPtr.kind = 'draw';
      const s0 = slotAtX(flowEnvPtr.px, pl);
      flowEnvDrawAt(s0, flowEnvPtr.py, pl, null);
      flowEnvPtr.lastSlot = s0;
    }
    if (flowEnvPtr.kind === 'draw') {
      const s = slotAtX(x, pl);
      flowEnvDrawAt(s, y, pl, flowEnvPtr.lastSlot);
      flowEnvPtr.lastSlot = s;
    }
  } else if (k === 'segarm') {
    if (!flowEnvPtr.moved && Math.hypot(x - flowEnvPtr.px, y - flowEnvPtr.py) > FLOW_TAP_MAX) {
      // Dragging a line = add a point at the down spot and drag it.
      flowEnvPtr.moved = true;
      flowEnvPtr.kind = 'bound';
      flowEnvPtr.out = false;
      flowEnvPtr.px = x; flowEnvPtr.py = y;
      const eb = envBoundaries();
      flowEnvMutate(() => { envSplitAtTime(clamp01(xToT(flowEnvPtr.px, pl)) * eb.total); });
      const ni = flowEnvHitBoundary(flowEnvPtr.px, flowEnvPtr.py, pl);
      if (ni >= 0) flowEnvPtr.idx = ni;
    }
  } else if (k === 'trim') {
    flowEnvApplyTrimFromY(flowEnvTrimSlider(p), y);
  } else if (k === 'segparam') {
    const type = flowSegTypeOf(flowEnvSegCurrent());
    const S = flowSegStripLayout(p, type);
    const g = S.params.find(r => r.key === flowEnvPtr.key);
    if (g) flowEnvSetSegParam(flowEnvPtr.key, flowEnvSegParamFromX(g, x));
  }
}

function flowEnvHandleUp(x, y) {
  const p = flowEnvPanel();
  const pl = flowEnvPlot(p, true);
  if (flowEnvPtr) {
    const k = flowEnvPtr.kind;
    if (k === 'bound') {
      flowEnvPtr.px = x; flowEnvPtr.py = y;
      const out = (x < pl.left - FLOW_ENV_DELETE_BUFFER || x > pl.right + FLOW_ENV_DELETE_BUFFER || y < pl.top - FLOW_ENV_DELETE_BUFFER || y > pl.bottom + FLOW_ENV_DELETE_BUFFER);
      if (flowEnvPtr.moved && out) {
        flowEnvMutate(() => { envDeleteAt(Math.max(0, flowEnvPtr.idx - 1)); });
      }
    } else if (k === 'segarm' && !flowEnvPtr.moved) {
      // A tap on a line: select the segment — the docked strip opens.
      flowEnvSegFrom = flowEnvPtr.idx;
      flowEnvSegTo = flowEnvPtr.idx + 1;
    } else if (k === 'drawzone' && !flowEnvPtr.moved) {
      // A plain tap in the left-edge strip behaves like any other tap.
      const segIdx = flowEnvSegHit(x, y, pl);
      if (segIdx >= 0) { flowEnvSegFrom = segIdx; flowEnvSegTo = segIdx + 1; }
      else if (x >= pl.left - 4 && x <= pl.right + 4) {
        const eb = envBoundaries();
        const tT = clamp01(xToT(x, pl));
        flowEnvMutate(() => {
          envSplitAtTime(tT * eb.total);
          const eb2 = envBoundaries();
          let best = -1, bd = Infinity;
          for (let i = 1; i <= eb2.n; i++) {
            const d = Math.abs(eb2.tOf(eb2.b[i]) - tT);
            if (d < bd) { bd = d; best = i; }
          }
          if (best >= 0) envDragBoundary(best, tT, yToV(y, pl) - envTrim(ENVELOPE));
        });
      }
    }
    flowEnvPtr = null;
  }
  saveFlow();
}

/* ---- Wave (harmonic spectrum) editor overlay ----
   Editing a wave node reuses the legacy sound creator's Harmonics logic
   (initLayerSpecPoints, syncLayerAmplitudes, insertSpecPoint, removeSpecPoint,
   specValueAt, ampToY/yToAmp, applyPresetToLayer, matchPreset) by temporarily
   swapping a layer-shaped proxy for the node's spectrum into OSC_STACK at
   selectedLayerIdx 0 — the same trick the envelope overlay uses with the shared
   ENVELOPE global. The overlay is drawn with this screen's dark theme and is
   partially transparent so the flow grid stays visible behind it. */
var flowWaveEdit = null;     // id of the wave node being edited, or null
var flowWaveSaved = null;    // { stack, layerIdx } of the instrument, saved before the swap
var flowWaveDirty = false;   // any edit happened this session (coalesces into one undo entry)
var flowWavePtr = null;      // { mode: 'point'|'draw'|'erase', idx?, lastX? } active drag
var flowWaveLastTap = null;  // double-tap-to-delete on a spectrum dot
var flowWaveMode = 'point';  // 'point' | 'draw' | 'erase' | 'delete'

function flowWavePanel() { return flowEnvPanel(); }
function flowWavePlot(p) { return flowEnvPlot(p); }
function flowWaveClearPill(p) { return flowEnvClearPill(p); }
function flowWaveToolbar(p) {
  const modes = [['point', 'Point'], ['draw', 'Draw'], ['erase', 'Erase'], ['delete', 'Delete']];
  const w = 54, gap = 6, h = 26, y = p.y + 48, x0 = p.x + 16;
  return modes.map((m, i) => ({ mode: m[0], label: m[1], x: x0 + i * (w + gap), y, w, h }));
}
// Waveform presets (row 2, right under the toolbar): reuse the legacy presets.
function flowWavePresetButtons(p) {
  const names = HARM_PRESETS;
  const gap = 8;
  const w = (p.w - 32 - (names.length - 1) * gap) / names.length;
  const y = p.y + 80, h = 26;
  return names.map((pr, i) => ({ name: pr.name, label: pr.label, x: p.x + 16 + i * (w + gap), y, w, h }));
}
function hitTestWaveDot(x, y, pl) {
  const pts = selectedLayer().specPoints;
  if (!pts) return -1;
  let best = -1, bd = Infinity;
  for (let j = 0; j < pts.length; j++) {
    const d = Math.hypot(x - tToX(pts[j].x, pl), y - ampToY(pts[j].a, pl));
    if (d < bd) { bd = d; best = j; }
  }
  return bd <= 18 ? best : -1;
}
function openFlowWaveEditor(id) {
  const n = flowNodeById(id);
  if (!n || n.type !== 'wave') return;
  if (!n.wave || !Array.isArray(n.wave.amplitudes)) n.wave = defaultWaveSpec();
  const temp = flowWaveLayer(n);
  flowWaveSaved = { stack: OSC_STACK, layerIdx: selectedLayerIdx };
  OSC_STACK = { layers: [temp] };
  selectedLayerIdx = 0;
  initLayerSpecPoints(temp);   // derive the dots from the amplitudes (or keep drawn)
  flowWaveEdit = id;
  flowWaveDirty = false;
  flowWavePtr = null;
  flowWaveLastTap = null;
  flowWaveMode = 'point';
  flowAddMenu = null;
  flowMoveId = null;
  flowConnArm = null;
  flowSelId = id;
}
function closeFlowWaveEditor() {
  if (!flowWaveEdit) return;
  const n = flowNodeById(flowWaveEdit);
  const l = selectedLayer();   // the temp proxy layer
  if (n) n.wave = { amplitudes: l.amplitudes, specPoints: l.specPoints, presetId: l.presetId };
  OSC_STACK = flowWaveSaved.stack;
  selectedLayerIdx = flowWaveSaved.layerIdx;
  flowWaveSaved = null;
  flowWaveEdit = null;
  flowWaveDirty = false;
  flowWavePtr = null;
  flowWaveLastTap = null;
  saveFlow();
}
// Wrap an edit: the first mutation of a session records one undo entry (and
// returns the mutation's result, so point insertion can start a drag on the new dot).
function flowWaveMutate(fn) {
  if (!flowWaveDirty) { flowPushHistory(); flowWaveDirty = true; }
  return fn();
}
// Erase mode: flatten the spectrum to 0 across the swept corridor. Breakpoints
// inside the swept span are absorbed (anchors at x 0/1 kept), then zero points
// are placed at the span edges and the finger so the region between them
// interpolates to silence; a single tap zeroes just that harmonic.
function flowWaveEraseAt(l, t, fromT) {
  let pts = l.specPoints;
  if (!pts || !pts.length) { initLayerSpecPoints(l); pts = l.specPoints; }
  const lo = fromT == null ? t : Math.min(t, fromT);
  const hi = fromT == null ? t : Math.max(t, fromT);
  for (let i = pts.length - 1; i >= 0; i--) {
    const x = pts[i].x;
    if (x === 0 || x === 1) continue;
    if (x >= lo && x <= hi) pts.splice(i, 1);
  }
  const zeroAt = x => {
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(pts[i].x - x) < 0.01) { pts[i].a = 0; return; }
    }
    if (pts.length < 64) pts.push({ x, a: 0 });
  };
  zeroAt(lo);
  zeroAt(hi);
  pts.sort((a, b) => a.x - b.x);
  syncLayerAmplitudes(l);
}
function drawFlowWaveEditor() {
  const p = flowWavePanel();
  const pl = flowWavePlot(p);
  const l = selectedLayer();
  initLayerSpecPoints(l);
  const pts = l.specPoints;
  const y0 = ampToY(0, pl);
  // Partially transparent backdrop: the flow grid shows through.
  drawRoundRect(p.x, p.y, p.w, p.h, 14);
  ctx.fillStyle = 'rgba(14,14,16,0.74)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Header.
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 16px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Wave', p.x + 16, p.y + 30);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '700 11px sans-serif';
  ctx.fillText('Harmonic structure · overtones 1–32', p.x + 86, p.y + 30);
  // Mode toolbar.
  for (const b of flowWaveToolbar(p)) {
    const active = flowWaveMode === b.mode;
    drawRoundRect(b.x, b.y, b.w, b.h, 8);
    ctx.fillStyle = active ? '#ffffff' : '#222222';
    ctx.fill();
    ctx.strokeStyle = active ? '#ffffff' : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = active ? 1.5 : 1;
    ctx.stroke();
    ctx.fillStyle = active ? '#000000' : '#ffffff';
    ctx.font = '800 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  // Clear pill (row 1, right).
  const cp = flowWaveClearPill(p);
  drawRoundRect(cp.x, cp.y, cp.w, cp.h, 8);
  ctx.fillStyle = '#2b2b2b';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Clear', cp.x + cp.w / 2, cp.y + cp.h / 2 + 4);
  // Waveform preset buttons (row 2).
  for (const b of flowWavePresetButtons(p)) {
    const active = matchPreset(l.amplitudes) === b.name;
    drawRoundRect(b.x, b.y, b.w, b.h, 8);
    ctx.fillStyle = active ? FLOW_WAVE_ACCENT : '#222222';
    ctx.fill();
    ctx.strokeStyle = active ? FLOW_WAVE_ACCENT : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = active ? 1.5 : 1;
    ctx.stroke();
    ctx.fillStyle = active ? '#000000' : '#ffffff';
    ctx.font = '800 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  // Plot grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= 10; k++) {
    const gx = tToX(k / 10, pl);
    ctx.moveTo(gx, pl.top); ctx.lineTo(gx, pl.bottom);
    const gy = vToY(k / 10, pl);
    ctx.moveTo(pl.left, gy); ctx.lineTo(pl.right, gy);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(pl.left, pl.top, pl.pw, pl.ph);
  // Harmonic labels (1..32) + guide lines every 4th harmonic.
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '700 8px sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < HARMONIC_COUNT; i++) {
    const x = tToX(i / (HARMONIC_COUNT - 1), pl);
    if (i >= 4 && i % 4 === 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(x, pl.top); ctx.lineTo(x, pl.bottom);
      ctx.stroke();
    }
    ctx.fillText(String(i + 1), x, pl.bottom + 12);
  }
  // Zero line + axis labels.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pl.left, y0); ctx.lineTo(pl.right, y0);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '700 10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('+100%', pl.left + 2, pl.top + 10);
  ctx.fillText('0', pl.left + 2, y0 + 3);
  ctx.fillText('−100%', pl.left + 2, pl.bottom - 4);
  // Spectrum curve + dots (extend the clamped ends to the plot edges).
  ctx.strokeStyle = FLOW_WAVE_ACCENT;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(tToX(0, pl), ampToY(specValueAt(pts, 0), pl));
  for (let j = 0; j < pts.length; j++) ctx.lineTo(tToX(pts[j].x, pl), ampToY(pts[j].a, pl));
  ctx.lineTo(tToX(1, pl), ampToY(specValueAt(pts, 1), pl));
  ctx.stroke();
  for (const pt of pts) {
    ctx.fillStyle = FLOW_WAVE_ACCENT;
    ctx.beginPath();
    ctx.arc(tToX(pt.x, pl), ampToY(pt.a, pl), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Hint.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(flowWaveMode === 'draw'
    ? 'Draw · drag across the plot to scribble the spectrum · tap Point to edit dots'
    : flowWaveMode === 'erase'
    ? 'Erase · drag across the plot to zero out those harmonics · tap Point to edit dots'
    : flowWaveMode === 'delete'
    ? 'Delete · tap a dot to remove it'
    : 'Point · tap to add a harmonic · drag a dot to move · double-tap a dot to delete · presets above replace the curve', p.x + p.w / 2, p.y + p.h - 8);
}
function flowWaveHandleDown(x, y) {
  const p = flowWavePanel();
  const pl = flowWavePlot(p);
  if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) { closeFlowWaveEditor(); return; }
  // Mode toolbar.
  for (const b of flowWaveToolbar(p)) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      flowWaveMode = b.mode;
      flowWavePtr = null;
      return;
    }
  }
  // Clear pill: reset to a plain sine.
  const cp = flowWaveClearPill(p);
  if (x >= cp.x && x <= cp.x + cp.w && y >= cp.y && y <= cp.y + cp.h) {
    flowWaveMutate(() => { const l = selectedLayer(); applyPresetToLayer(l, 'sine'); initLayerSpecPoints(l); });
    return;
  }
  // Waveform preset buttons.
  for (const b of flowWavePresetButtons(p)) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      flowWaveMutate(() => { const l = selectedLayer(); applyPresetToLayer(l, b.name); initLayerSpecPoints(l); });
      return;
    }
  }
  // Plot behaviour depends on the mode.
  if (y >= pl.top && y <= pl.bottom) {
    if (flowWaveMode === 'delete') {
      const idx = hitTestWaveDot(x, y, pl);
      if (idx >= 0) flowWaveMutate(() => { removeSpecPoint(selectedLayer(), idx); });
      return;
    }
    if (flowWaveMode === 'draw') {
      flowWaveMutate(() => { insertSpecPoint(selectedLayer(), xToT(x, pl), yToAmp(y, pl)); });
      flowWavePtr = { mode: 'draw', lastX: xToT(x, pl) };
      return;
    }
    if (flowWaveMode === 'erase') {
      const xf = xToT(x, pl);
      flowWaveMutate(() => { flowWaveEraseAt(selectedLayer(), xf, null); });
      flowWavePtr = { mode: 'erase', lastX: xf };
      return;
    }
    // Point mode: grab a dot (double-tap deletes), or add a point and drag it.
    const idx = hitTestWaveDot(x, y, pl);
    if (idx >= 0) {
      if (flowWaveLastTap && flowWaveLastTap.idx === idx && performance.now() - flowWaveLastTap.t < 400 && Math.hypot(x - flowWaveLastTap.x, y - flowWaveLastTap.y) < 26) {
        flowWaveMutate(() => { removeSpecPoint(selectedLayer(), idx); });
        flowWaveLastTap = null;
        return;
      }
      flowWaveLastTap = { t: performance.now(), x, y, idx };
      flowWavePtr = { mode: 'point', idx, x0: x, y0: y };
      return;
    }
    const ni = flowWaveMutate(() => insertSpecPoint(selectedLayer(), xToT(x, pl), yToAmp(y, pl)));
    if (ni >= 0) flowWavePtr = { mode: 'point', idx: ni, x0: x, y0: y };
  }
}
function flowWaveHandleMove(x, y) {
  if (!flowWavePtr) return;
  const p = flowWavePanel();
  const pl = flowWavePlot(p);
  if (flowWavePtr.mode === 'point') {
    const l = selectedLayer();
    const pts = l.specPoints;
    const pt = pts[flowWavePtr.idx];
    if (pt) {
      flowWaveMutate(() => {
        pt.x = clamp01(xToT(x, pl));
        pt.a = clampSign(yToAmp(y, pl));
        pts.sort((a, b) => a.x - b.x);
        flowWavePtr.idx = pts.indexOf(pt);
        syncLayerAmplitudes(l);
      });
    }
  } else if (flowWavePtr.mode === 'draw') {
    const xf = xToT(x, pl);
    if (Math.abs(xf - flowWavePtr.lastX) > 0.01) {
      flowWaveMutate(() => { insertSpecPoint(selectedLayer(), xf, yToAmp(y, pl)); });
      flowWavePtr.lastX = xf;
    }
  } else if (flowWavePtr.mode === 'erase') {
    const xf = xToT(x, pl);
    if (Math.abs(xf - flowWavePtr.lastX) > 0.01) {
      flowWaveMutate(() => { flowWaveEraseAt(selectedLayer(), xf, flowWavePtr.lastX); });
      flowWavePtr.lastX = xf;
    }
  }
}
function flowWaveHandleUp() {
  flowWavePtr = null;
  saveFlow();
}

/* ---- Unison (voices) editor overlay ----
   Editing a unison node taps the legacy sound creator's voices logic — the
   duplicate-voice model (defaultVoice, MAX_LAYER_VOICES, layerVoices,
   normalizedVoiceLevelsAt) — by temporarily swapping a layer-shaped proxy that
   carries the node's voices into OSC_STACK at selectedLayerIdx 0. The overlay
   edits the static st/ct/vol offsets (no envelope curves): a chip row picks/
   adds/deletes/mutes voices, interval chips set semitones, and three faders
   drag the selected voice's offsets. */
var flowUnisonEdit = null;    // id of the unison node being edited, or null
var flowUnisonSaved = null;   // { stack, layerIdx } of the instrument, saved before the swap
var flowUnisonDirty = false;  // any edit happened this session (coalesces into one undo entry)
var flowUnisonSel = 0;        // index of the selected voice
var flowUnisonDrag = null;    // { key } active fader drag, or null

function flowUnisonPanel() { return flowEnvPanel(); }
function flowUnisonSelectedVoice() {
  const vs = layerVoices(selectedLayer());
  return (flowUnisonSel >= 0 && vs[flowUnisonSel]) ? vs[flowUnisonSel] : null;
}
// Semitone interval preset chips (row under the header) — reuse the legacy
// VOICE_INTERVALS list to jump the selected voice's st offset.
function flowUnisonIntervals(p) {
  const gap = 6;
  const w = Math.max(34, Math.min(52, (p.w - 32 - (VOICE_INTERVALS.length - 1) * gap) / VOICE_INTERVALS.length));
  const y = p.y + 84, h = 22;
  return VOICE_INTERVALS.map((iv, i) => ({ st: iv.st, label: iv.label, x: p.x + 16 + i * (w + gap), y, w, h }));
}
// Three parameter faders (st/ct/vol): a track to drag + −/+ nudge buttons, per
// the legacy VOICE_PARAM_DEFS ranges and step sizes.
function flowUnisonFaders(p) {
  const top = p.y + 112, h = 38;
  return VOICE_PARAM_DEFS.map((d, i) => {
    const cy = top + i * h;
    return {
      key: d.key, label: d.label, fmt: d.fmt, min: d.min, max: d.max, step: d.step,
      labelX: p.x + 16, cy,
      trackX1: p.x + 84, trackX2: p.x + p.w - 118,
      btnMinus: { x: p.x + p.w - 108, y: cy - 11, w: 22, h: 22 },
      btnPlus: { x: p.x + p.w - 80, y: cy - 11, w: 22, h: 22 },
      valX: p.x + p.w - 18,
    };
  });
}
function openFlowUnisonEditor(id) {
  const n = flowNodeById(id);
  if (!n || n.type !== 'unison') return;
  if (!Array.isArray(n.voices)) n.voices = defaultUnisonVoices();
  n.voices = voicesFromSavedFlow(n.voices);   // clamp/clean stored voices
  const temp = flowUnisonLayer(n);
  flowUnisonSaved = { stack: OSC_STACK, layerIdx: selectedLayerIdx };
  OSC_STACK = { layers: [temp] };
  selectedLayerIdx = 0;
  flowUnisonEdit = id;
  flowUnisonDirty = false;
  flowUnisonSel = Math.max(0, Math.min(n.voices.length - 1, 0));
  flowUnisonDrag = null;
  flowAddMenu = null;
  flowMoveId = null;
  flowConnArm = null;
  flowSelId = id;
}
function closeFlowUnisonEditor() {
  if (!flowUnisonEdit) return;
  const n = flowNodeById(flowUnisonEdit);
  const l = selectedLayer();   // the temp proxy layer
  if (n) n.voices = voicesFromSavedFlow(l.voices || []);
  OSC_STACK = flowUnisonSaved.stack;
  selectedLayerIdx = flowUnisonSaved.layerIdx;
  flowUnisonSaved = null;
  flowUnisonEdit = null;
  flowUnisonDirty = false;
  flowUnisonDrag = null;
  saveFlow();
}
function flowUnisonMutate(fn) {
  if (!flowUnisonDirty) { flowPushHistory(); flowUnisonDirty = true; }
  fn();
}
function flowUnisonSetParam(f, x) {
  const v = flowUnisonSelectedVoice();
  if (!v) return;
  let val = f.min + clamp01((x - f.trackX1) / (f.trackX2 - f.trackX1)) * (f.max - f.min);
  val = Math.round(val / f.step) * f.step;
  val = Math.max(f.min, Math.min(f.max, val));
  flowUnisonMutate(() => { v[f.key] = val; });
}
function flowUnisonNudge(key, dir) {
  const v = flowUnisonSelectedVoice();
  const d = VOICE_PARAM_DEFS.find(x => x.key === key);
  if (!v || !d) return;
  const cur = +(v[key] != null ? v[key] : (key === 'vol' ? 1 : 0));
  const val = Math.max(d.min, Math.min(d.max, cur + dir * d.step));
  flowUnisonMutate(() => { v[key] = val; });
}
function drawFlowUnisonEditor() {
  const p = flowUnisonPanel();
  const v = flowUnisonSelectedVoice();
  // Partially transparent backdrop: the flow grid shows through.
  drawRoundRect(p.x, p.y, p.w, p.h, 14);
  ctx.fillStyle = 'rgba(14,14,16,0.74)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Header.
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 16px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Unison', p.x + 16, p.y + 30);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '700 11px sans-serif';
  ctx.fillText('One extra voice playing the same wave', p.x + 86, p.y + 30);
  // Interval preset chips (semitones for the single voice) — disabled while a
  // semitone envelope drives the voice.
  const stLocked = flowUnisonParamLocked(flowNodeById(flowUnisonEdit), 'st');
  for (const ic of flowUnisonIntervals(p)) {
    const on = v && Math.round(+v.st || 0) === ic.st;
    drawRoundRect(ic.x, ic.y, ic.w, ic.h, 7);
    ctx.fillStyle = on ? FLOW_UNISON_ACCENT : '#222222';
    ctx.fill();
    ctx.strokeStyle = on ? FLOW_UNISON_ACCENT : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = on ? 1.5 : 1;
    ctx.stroke();
    ctx.globalAlpha = stLocked ? 0.4 : 1;
    ctx.fillStyle = on ? '#000000' : '#ffffff';
    ctx.font = '800 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ic.label, ic.x + ic.w / 2, ic.y + ic.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
  }
  // Parameter faders (st/ct/vol) — a fader is locked (inert, greyed) while its
  // animation envelope is connected.
  for (const f of flowUnisonFaders(p)) {
    const active = !!v;
    const locked = active && flowUnisonParamLocked(flowNodeById(flowUnisonEdit), f.key);
    const cur = v ? (+v[f.key] != null ? +v[f.key] : (f.key === 'vol' ? 1 : 0)) : (f.key === 'vol' ? 1 : 0);
    ctx.globalAlpha = active ? (locked ? 0.4 : 1) : 0.35;
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(f.label, f.labelX, f.cy + 4);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(f.trackX1, f.cy); ctx.lineTo(f.trackX2, f.cy);
    ctx.stroke();
    if (!locked) {
      const frac = clamp01((cur - f.min) / (f.max - f.min));
      const tx = f.trackX1 + frac * (f.trackX2 - f.trackX1);
      ctx.strokeStyle = FLOW_UNISON_ACCENT;
      ctx.beginPath();
      ctx.moveTo(f.trackX1, f.cy); ctx.lineTo(tx, f.cy);
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.arc(tx, f.cy, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(locked ? 'ENV' : f.fmt(cur), f.valX, f.cy + 4);
    for (const side of ['btnMinus', 'btnPlus']) {
      const bx = f[side];
      drawRoundRect(bx.x, bx.y, bx.w, bx.h, 6);
      ctx.fillStyle = locked ? '#1f1f1f' : '#333333';
      ctx.fill();
      ctx.strokeStyle = locked ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(side === 'btnMinus' ? '−' : '+', bx.x + bx.w / 2, bx.y + bx.h / 2 + 1);
      ctx.textBaseline = 'alphabetic';
    }
    ctx.globalAlpha = 1;
  }
  // Hint.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('The extra voice detunes by its st/ct offsets — vol/st/ct envs can animate them over the note', p.x + p.w / 2, p.y + p.h - 8);
}
function flowUnisonHandleDown(x, y) {
  const p = flowUnisonPanel();
  if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) { closeFlowUnisonEditor(); return; }
  // Interval preset chips (semitone jumps for the single voice) — inert while a
  // semitone envelope drives the voice.
  const v = flowUnisonSelectedVoice();
  if (v && !flowUnisonParamLocked(flowNodeById(flowUnisonEdit), 'st')) {
    for (const ic of flowUnisonIntervals(p)) {
      if (x >= ic.x && x <= ic.x + ic.w && y >= ic.y && y <= ic.y + ic.h) {
        flowUnisonMutate(() => { v.st = ic.st; });
        return;
      }
    }
  }
  // Faders: nudge buttons, then the track (drag). A fader whose animation
  // envelope is connected is locked — the envelope drives that value.
  for (const f of flowUnisonFaders(p)) {
    if (flowUnisonParamLocked(flowNodeById(flowUnisonEdit), f.key)) continue;
    if (x >= f.btnMinus.x && x <= f.btnMinus.x + f.btnMinus.w && y >= f.btnMinus.y && y <= f.btnMinus.y + f.btnMinus.h) { flowUnisonNudge(f.key, -1); return; }
    if (x >= f.btnPlus.x && x <= f.btnPlus.x + f.btnPlus.w && y >= f.btnPlus.y && y <= f.btnPlus.y + f.btnPlus.h) { flowUnisonNudge(f.key, 1); return; }
    if (v && Math.abs(y - f.cy) <= 16 && x >= f.trackX1 - 6 && x <= f.trackX2 + 8) {
      flowUnisonSetParam(f, x);
      flowUnisonDrag = { key: f.key };
      return;
    }
  }
}
function flowUnisonHandleMove(x, y) {
  if (!flowUnisonDrag) return;
  const p = flowUnisonPanel();
  const f = flowUnisonFaders(p).find(f => f.key === flowUnisonDrag.key);
  if (f && !flowUnisonParamLocked(flowNodeById(flowUnisonEdit), f.key)) flowUnisonSetParam(f, x);
}
function flowUnisonHandleUp() {
  flowUnisonDrag = null;
  saveFlow();
}

/* ---- Env (generic curve) editor overlay ----
   An env node is a kind-agnostic breakpoint curve: t = note progress 0..1,
   v = signed modulation −1..1 with 0 as the neutral line. It has no role of
   its own — whichever consumer connects to it decides what the curve means
   (mix = 1+v clamped to full, voice vol = 1+v, st = v·24, ct = v·100). The
   editor edits the node's own points directly (no shared global to swap). */
var flowCurveEdit = null;     // id of the env node being edited, or null
var flowCurveDirty = false;   // any edit happened this session (coalesces undo)
var flowCurvePtr = null;      // { kind: 'point'|'draw'|'drawzone'|'segarm'|'trim'|'segparam', ... } active drag
var flowCurveSegFrom = null, flowCurveSegTo = null;   // selected segment (point indexes)

function flowCurvePanel() { return flowEnvPanel(); }
function flowCurvePlot(p) { return flowEnvPlot(p, true); }
function flowCurveClearPill(p) { return flowEnvClearPill(p); }
function flowCurvePointsOf(node) {
  const n = flowNodeById(node);
  if (!n) return null;
  if (!n.env || !Array.isArray(n.env.points) || n.env.points.length < 2) n.env = defaultEnvCurve();
  return n.env.points;
}
// The env node's curve object itself (ensured a default, with a trim).
function flowCurveEnvOf(node) {
  const n = flowNodeById(node);
  if (!n) return null;
  if (!n.env || !Array.isArray(n.env.points) || n.env.points.length < 2) n.env = defaultEnvCurve();
  if (n.env.trim == null) n.env.trim = 0;
  return n.env;
}
// The left-edge vertical slider that raises/lowers the curve's trim — the same
// geometry as the volume envelope's trim slider (they share the plot layout).
function flowCurveTrimSlider(p) { return flowEnvTrimSlider(p); }
function flowCurveTrimApply(y) {
  const sl = flowCurveTrimSlider(flowCurvePanel());
  const f = Math.max(0, Math.min(1, (y - sl.y0) / (sl.y1 - sl.y0)));
  flowCurveMutate(() => { flowCurveEnvOf(flowCurveEdit).trim = Math.max(-1, Math.min(1, 1 - 2 * f)); });
}
function flowCurveInsert(points, t, v) {
  t = clamp01(t); v = Math.max(-1, Math.min(1, v));
  for (let i = 0; i < points.length; i++) {
    if (Math.abs(points[i].t - t) < 0.01) { points[i].v = v; return i; }
  }
  if (points.length >= 64) return -1;
  // A point inserted inside a span carries the span's segment config, so a
  // stairs/spring/pulse shape keeps its wobble across the split.
  let seg = null;
  for (let i = 0; i < points.length - 1; i++) {
    if (t > points[i].t && t < points[i + 1].t) {
      const s = points[i].seg;
      if (s && typeof s === 'object') seg = clone(s);
      break;
    }
  }
  const pt = { t, v };
  if (seg) pt.seg = seg;
  points.push(pt);
  points.sort((a, b) => a.t - b.t);
  return points.findIndex(p => p === pt);
}
function flowCurveRemove(points, idx) {
  const pt = points[idx];
  if (!pt) return;
  if (pt.t === 0 || pt.t === 1) return;   // the far-left/right anchors are protected
  if (points.length <= 2) {
    points.length = 0;
    points.push({ t: 0, v: 0 }, { t: 1, v: 0 });
    return;
  }
  points.splice(idx, 1);
}
function hitTestCurveDot(x, y, pl, points, trim) {
  let best = -1, bd = Infinity;
  for (let j = 0; j < points.length; j++) {
    const d = Math.hypot(x - tToX(points[j].t, pl), y - ampToY(clampSign(points[j].v + (trim || 0)), pl));
    if (d < bd) { bd = d; best = j; }
  }
  return bd <= 24 ? best : -1;
}
/* ---- Env-curve segment line types ----
   Each point owns the span from itself to the next ({t,v} + optional .seg), so
   the envelope's Line / Stairs / Spring / Pulse shapes apply to an env curve
   the same way they do to a mix/pitch curve. Selection state is self-contained
   (flowCurveSegFrom/To), mirroring the envelope editor's. */
function flowCurveSegModel() {
  const pts = flowCurvePointsOf(flowCurveEdit) || [];
  return { elems: pts, lastPoint: pts.length };
}
function flowCurveSegRange() {
  const m = flowCurveSegModel();
  if (flowCurveSegFrom == null && flowCurveSegTo == null) return null;
  const a = flowCurveSegFrom == null ? flowCurveSegTo : flowCurveSegFrom;
  const b = flowCurveSegTo == null ? flowCurveSegFrom : flowCurveSegTo;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.max(a, b);
  if (lo >= m.lastPoint || hi >= m.lastPoint) return null;
  return { m, lo, hi };
}
function flowCurveSegCurrent() {
  const r = flowCurveSegRange();
  return r ? r.m.elems[r.lo] : null;
}
function flowCurveForEachSeg(fn) {
  const r = flowCurveSegRange();
  if (!r) return;
  const end = r.hi + (r.hi <= r.lo ? 0 : -1);
  for (let i = r.lo; i <= end; i++) { const el = r.m.elems[i]; if (el) fn(el); }
}
function flowCurveSegParamValue(key) {
  const el = flowCurveSegCurrent();
  if (!el) return SEG_PARAM_DEFS[key].min;
  const s = segOf(el);
  return Math.max(SEG_PARAM_DEFS[key].min, Math.min(SEG_PARAM_DEFS[key].max, +s[key] || SEG_PARAM_DEFS[key].min));
}
function flowCurveSegParamFromX(g, x) {
  const d = SEG_PARAM_DEFS[g.key];
  let v = d.min + clamp01((x - g.x1) / (g.x2 - g.x1)) * (d.max - d.min);
  v = Math.round(v / d.step) * d.step;
  return Math.max(d.min, Math.min(d.max, v));
}
function flowCurveSetSegType(t) {
  if (SEGMENT_TYPE_ORDER.indexOf(t) < 0) return;
  flowCurveMutate(() => {
    flowCurveForEachSeg(el => {
      if (!el.seg || typeof el.seg !== 'object') el.seg = clone(DEFAULT_SEG);
      el.seg.type = t;
    });
  });
}
function flowCurveSetSegParam(key, v) {
  const d = SEG_PARAM_DEFS[key];
  if (!d) return;
  v = Math.max(d.min, Math.min(d.max, +v || d.min));
  flowCurveMutate(() => {
    flowCurveForEachSeg(el => {
      if (!el.seg || typeof el.seg !== 'object') el.seg = clone(DEFAULT_SEG);
      el.seg[key] = v;
    });
  });
}
// The index of the env-curve segment (span i→i+1) whose drawn curve is nearest
// (x,y), or -1.
function flowCurveSegHit(x, y, pl, points, trim) {
  if (!points || points.length < 2) return -1;
  let best = -1, bd = 18;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const ax = tToX(a.t, pl), ay = ampToY(clampSign(a.v + trim), pl);
    const bx = tToX(b.t, pl), by = ampToY(clampSign(b.v + trim), pl);
    const s = segOf(a);
    const n = s.type === 'line' ? 2 : segDrawSamples(s);
    for (let k = 0; k < n; k++) {
      const f = k / n, f2 = (k + 1) / n;
      const p1x = ax + (bx - ax) * f, p1y = ampToY(clampSign(segValueAt(a, a.v + trim, b.v + trim, f, 1)), pl);
      const p2x = ax + (bx - ax) * f2, p2y = ampToY(clampSign(segValueAt(a, a.v + trim, b.v + trim, f2, 1)), pl);
      const d = distToSeg(x, y, p1x, p1y, p2x, p2y);
      if (d < bd) { bd = d; best = i; }
    }
  }
  return best;
}
// Screen-space sample points for a seg-aware env-curve path (ends clamped to
// the plot edges), ready for strokeSegPath.
function flowCurveScreenPoints(points, trim, pl) {
  const out = [];
  const vAt = t => clampSign(specValueAtCurve(points, t) + trim);
  if (points[0].t > 0) out.push({ x: tToX(0, pl), y: ampToY(vAt(0), pl), v: vAt(0), el: null });
  for (let i = 0; i < points.length; i++) {
    out.push({ x: tToX(points[i].t, pl), y: ampToY(clampSign(points[i].v + trim), pl), v: clampSign(points[i].v + trim), el: i < points.length - 1 ? points[i] : null });
  }
  const last = points[points.length - 1];
  if (last.t < 1) out.push({ x: tToX(1, pl), y: ampToY(vAt(1), pl), v: vAt(1), el: null });
  return out;
}
function openFlowCurveEditor(id) {
  const n = flowNodeById(id);
  if (!n || n.type !== 'env') return;
  if (!n.env || !Array.isArray(n.env.points) || n.env.points.length < 2) n.env = defaultEnvCurve();
  flowCurveEdit = id;
  flowCurveDirty = false;
  flowCurvePtr = null;
  flowCurveSegFrom = null;
  flowCurveSegTo = null;
  flowAddMenu = null;
  flowMoveId = null;
  flowConnArm = null;
  flowSelId = id;
}
function closeFlowCurveEditor() {
  if (!flowCurveEdit) return;
  flowCurveEdit = null;
  flowCurveDirty = false;
  flowCurvePtr = null;
  flowCurveSegFrom = null;
  flowCurveSegTo = null;
  saveFlow();
}
function flowCurveMutate(fn) {
  if (!flowCurveDirty) { flowPushHistory(); flowCurveDirty = true; }
  return fn();
}
function drawFlowCurveEditor() {
  const p = flowCurvePanel();
  const pl = flowCurvePlot(p);
  const points = flowCurvePointsOf(flowCurveEdit) || [];
  const trim = flowCurveEnvOf(flowCurveEdit).trim || 0;
  const y0 = ampToY(0, pl);
  // Partially transparent backdrop: the flow grid shows through.
  drawRoundRect(p.x, p.y, p.w, p.h, 14);
  ctx.fillStyle = 'rgba(14,14,16,0.74)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Header.
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 16px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Env', p.x + 16, p.y + 30);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '700 11px sans-serif';
  ctx.fillText('Neutral curve · 0 = no change · consumers decide the meaning', p.x + 86, p.y + 30);
  // Dock the line-mode strip at the top while a segment is selected.
  if (flowCurveSegRange()) drawFlowSegStrip(p, { current: flowCurveSegCurrent, range: flowCurveSegRange, paramValue: flowCurveSegParamValue });
  // Clear pill (row 1, right): reset to the flat neutral line.
  const cp = flowCurveClearPill(p);
  drawRoundRect(cp.x, cp.y, cp.w, cp.h, 8);
  ctx.fillStyle = '#2b2b2b';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Clear', cp.x + cp.w / 2, cp.y + cp.h / 2 + 4);
  // Plot grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= 10; k++) {
    const gx = tToX(k / 10, pl);
    ctx.moveTo(gx, pl.top); ctx.lineTo(gx, pl.bottom);
    const gy = vToY(k / 10, pl);
    ctx.moveTo(pl.left, gy); ctx.lineTo(pl.right, gy);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(pl.left, pl.top, pl.pw, pl.ph);
  // Selected-segment highlight band on the graph.
  if (flowCurveSegRange()) {
    const sr = flowCurveSegRange();
    const a = points[sr.lo], b = points[sr.hi] || points[points.length - 1];
    const x0 = tToX(a.t, pl), x1 = tToX(b.t, pl);
    ctx.fillStyle = 'rgba(141,211,255,0.14)';
    ctx.fillRect(x0, pl.top, Math.max(1, x1 - x0), pl.ph);
  }
  // Neutral (0) line highlighted.
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(pl.left, y0); ctx.lineTo(pl.right, y0);
  ctx.stroke();
  ctx.setLineDash([]);
  // Axis labels.
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '700 10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('+100%', pl.left + 2, pl.top + 10);
  ctx.fillText('0', pl.left + 2, y0 + 3);
  ctx.fillText('−100%', pl.left + 2, pl.bottom - 4);
  // Curve + dots: each span renders its own line type (Line/Stairs/Spring/
  // Pulse); the trim offsets the whole curve vertically like the envelope's.
  ctx.strokeStyle = '#8dd3ff';
  ctx.lineWidth = 3;
  strokeSegPath(flowCurveScreenPoints(points, trim, pl), 1, v => ampToY(clampSign(v), pl));
  for (const pt of points) {
    ctx.fillStyle = '#8dd3ff';
    ctx.beginPath();
    ctx.arc(tToX(pt.t, pl), ampToY(clampSign(pt.v + trim), pl), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Trim slider: raises/lowers the whole curve.
  const sl = flowCurveTrimSlider(p);
  const scx = sl.x + sl.w / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(scx, sl.y0); ctx.lineTo(scx, sl.y1);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(sl.x, (sl.y0 + sl.y1) / 2); ctx.lineTo(sl.x + sl.w, (sl.y0 + sl.y1) / 2);
  ctx.stroke();
  const tc = sl.y1 - (trim + 1) / 2 * (sl.y1 - sl.y0);
  drawRoundRect(sl.x, tc - 7, sl.w, 14, 7);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '700 8px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Trim', scx, sl.y0 - 6);
  // Drag feedback: the dot rides the finger; once it leaves the plot a
  // trashcan pill appears (release there deletes the point, unless it's a
  // protected anchor).
  const ptr = flowCurvePtr;
  if (ptr && ptr.kind === 'point' && ptr.moved) {
    ctx.fillStyle = '#8dd3ff';
    ctx.beginPath();
    ctx.arc(ptr.px, ptr.py, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    const protectedAnchor = (() => {
      const pt = points[ptr.idx];
      return !!(pt && (pt.t === 0 || pt.t === 1));
    })();
    if (ptr.out && !protectedAnchor) {
      const bw = 46, bh = 30;
      const bx = Math.max(pl.left, Math.min(pl.right - bw, ptr.px - bw / 2));
      const by = Math.max(pl.top, Math.min(pl.bottom - bh, ptr.py - bh - 10));
      drawRoundRect(bx, by, bw, bh, 8);
      ctx.fillStyle = 'rgba(220,60,60,0.92)';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🗑', bx + bw / 2, by + bh / 2 + 1);
      ctx.textBaseline = 'alphabetic';
    }
  }
  // Hint.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Tap + drag adds a point · drag a dot off the graph to delete (🗑) · left-edge swipe draws · tap a line to shape it', p.x + p.w / 2, p.y + p.h - 8);
}
// Curve value at t (each span applies its segment line type, ends clamp) — like
// specValueAt but with {t,v} points and a ±1 axis.
function specValueAtCurve(points, t) {
  if (!points || !points.length) return 0;
  t = clamp01(t);
  const lo = points[0], hi = points[points.length - 1];
  if (t <= lo.t) return clampSign(lo.v);
  if (t >= hi.t) return clampSign(hi.v);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const f = span > 0 ? (t - a.t) / span : 0;
      return clampSign(segValueAt(a, a.v, b.v, f, 1));
    }
  }
  return clampSign(hi.v);
}
function flowCurveHandleDown(x, y) {
  const p = flowCurvePanel();
  const pl = flowCurvePlot(p);
  if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) { closeFlowCurveEditor(); return; }
  // Line-mode strip (docked at the top): type pills / parameter controls.
  if (flowCurveSegRange()) {
    const type = flowSegTypeOf(flowCurveSegCurrent());
    const hit = flowSegHitStrip(x, y, p, type);
    if (hit) {
      if (hit.type === 'type') flowCurveSetSegType(hit.t);
      else if (hit.type === 'param') flowCurveSetSegParam(hit.key, flowCurveSegParamValue(hit.key) + hit.dir * SEG_PARAM_DEFS[hit.key].step);
      else if (hit.type === 'slider') {
        const S = flowSegStripLayout(p, type);
        const g = S.params.find(r => r.key === hit.key);
        if (g) { flowCurveSetSegParam(hit.key, flowCurveSegParamFromX(g, x)); flowCurvePtr = { kind: 'segparam', key: hit.key }; }
      }
      return;
    }
  }
  const cp = flowCurveClearPill(p);
  if (x >= cp.x && x <= cp.x + cp.w && y >= cp.y && y <= cp.y + cp.h) {
    flowCurveMutate(() => {
      const pts = flowCurvePointsOf(flowCurveEdit);
      pts.length = 0;
      pts.push({ t: 0, v: 0 }, { t: 1, v: 0 });
      flowCurveEnvOf(flowCurveEdit).trim = 0;
    });
    flowCurveSegFrom = null;
    flowCurveSegTo = null;
    return;
  }
  // Trim slider.
  const sl = flowCurveTrimSlider(p);
  if (x >= sl.x - 4 && x <= sl.x + sl.w + 4 && y >= sl.y0 - 8 && y <= sl.y1 + 6) {
    flowCurveTrimApply(y);
    flowCurvePtr = { kind: 'trim' };
    return;
  }
  // Plot: the gesture decides the mode (no toolbar).
  if (y < pl.top || y > pl.bottom) return;
  const pts = flowCurvePointsOf(flowCurveEdit);
  const trim = flowCurveEnvOf(flowCurveEdit).trim || 0;
  // 1. A dot grabs a point to move it.
  const idx = hitTestCurveDot(x, y, pl, pts, trim);
  if (idx >= 0) {
    flowCurveSegFrom = null; flowCurveSegTo = null;
    flowCurvePtr = { kind: 'point', idx, px: x, py: y, moved: false, out: false };
    return;
  }
  // 2. A swipe starting in the left-edge strip is draw mode.
  if (x <= pl.left + FLOW_ENV_DRAW_ZONE) {
    flowCurvePtr = { kind: 'drawzone', px: x, py: y, moved: false };
    return;
  }
  // 3. Tapping a segment line selects it (opens the docked strip).
  const segIdx = flowCurveSegHit(x, y, pl, pts, trim);
  if (segIdx >= 0) {
    flowCurvePtr = { kind: 'segarm', idx: segIdx, px: x, py: y, moved: false };
    return;
  }
  // 4. Empty space: add a point at the tap and start dragging it.
  if (x < pl.left - 4 || x > pl.right + 4) return;
  const ni = flowCurveMutate(() => flowCurveInsert(pts, xToT(x, pl), yToAmp(y, pl) - trim));
  flowCurveSegFrom = null; flowCurveSegTo = null;
  if (ni >= 0) flowCurvePtr = { kind: 'point', idx: ni, px: x, py: y, moved: false, out: false };
}
function flowCurveHandleMove(x, y) {
  if (!flowCurvePtr) return;
  const p = flowCurvePanel();
  const pl = flowCurvePlot(p);
  const trim = flowCurveEnvOf(flowCurveEdit).trim || 0;
  const k = flowCurvePtr.kind;
  if (k === 'trim') {
    flowCurveTrimApply(y);
  } else if (k === 'point') {
    const pts = flowCurvePointsOf(flowCurveEdit);
    const pt = pts[flowCurvePtr.idx];
    flowCurvePtr.px = x; flowCurvePtr.py = y;
    flowCurvePtr.moved = true;
    flowCurvePtr.out = (x < pl.left || x > pl.right || y < pl.top || y > pl.bottom);
    if (pt) {
      flowCurveMutate(() => {
        pt.t = clamp01(xToT(x, pl));
        pt.v = clampSign(yToAmp(y, pl) - trim);
        pts.sort((a, b) => a.t - b.t);
        flowCurvePtr.idx = pts.indexOf(pt);
      });
    }
  } else if (k === 'drawzone') {
    if (!flowCurvePtr.moved && x - flowCurvePtr.px > FLOW_TAP_MAX) {
      flowCurvePtr.moved = true;
      flowCurvePtr.kind = 'draw';
      flowCurvePtr.lastX = xToT(flowCurvePtr.px, pl);
    }
    if (flowCurvePtr.kind === 'draw') {
      const xf = xToT(x, pl);
      if (Math.abs(xf - flowCurvePtr.lastX) > 0.01) {
        flowCurveMutate(() => { flowCurveInsert(flowCurvePointsOf(flowCurveEdit), xf, yToAmp(y, pl) - trim); });
        flowCurvePtr.lastX = xf;
      }
    }
  } else if (k === 'segarm') {
    if (!flowCurvePtr.moved && Math.hypot(x - flowCurvePtr.px, y - flowCurvePtr.py) > FLOW_TAP_MAX) {
      // Dragging a line = add a point at the down spot and drag it.
      flowCurvePtr.moved = true;
      flowCurvePtr.kind = 'point';
      flowCurvePtr.out = false;
      flowCurvePtr.px = x; flowCurvePtr.py = y;
      const pts = flowCurvePointsOf(flowCurveEdit);
      const ni = flowCurveMutate(() => flowCurveInsert(pts, xToT(flowCurvePtr.px, pl), yToAmp(flowCurvePtr.py, pl) - trim));
      if (ni >= 0) flowCurvePtr.idx = ni;
    }
  } else if (k === 'draw') {
    const xf = xToT(x, pl);
    if (Math.abs(xf - flowCurvePtr.lastX) > 0.01) {
      flowCurveMutate(() => { flowCurveInsert(flowCurvePointsOf(flowCurveEdit), xf, yToAmp(y, pl) - trim); });
      flowCurvePtr.lastX = xf;
    }
  } else if (k === 'segparam') {
    const type = flowSegTypeOf(flowCurveSegCurrent());
    const S = flowSegStripLayout(p, type);
    const g = S.params.find(r => r.key === flowCurvePtr.key);
    if (g) flowCurveSetSegParam(flowCurvePtr.key, flowCurveSegParamFromX(g, x));
  }
}
function flowCurveHandleUp(x, y) {
  const p = flowCurvePanel();
  const pl = flowCurvePlot(p);
  if (flowCurvePtr) {
    const k = flowCurvePtr.kind;
    if (k === 'point') {
      flowCurvePtr.px = x; flowCurvePtr.py = y;
      const out = (x < pl.left || x > pl.right || y < pl.top || y > pl.bottom);
      if (flowCurvePtr.moved && out) {
        const pts = flowCurvePointsOf(flowCurveEdit);
        const pt = pts[flowCurvePtr.idx];
        if (pt && pt.t !== 0 && pt.t !== 1) flowCurveMutate(() => { flowCurveRemove(pts, flowCurvePtr.idx); });
      }
    } else if (k === 'segarm' && !flowCurvePtr.moved) {
      // A tap on a line: select the segment — the docked strip opens.
      flowCurveSegFrom = flowCurvePtr.idx;
      flowCurveSegTo = flowCurvePtr.idx + 1;
    } else if (k === 'drawzone' && !flowCurvePtr.moved) {
      // A plain tap in the left-edge strip behaves like any other tap.
      const pts = flowCurvePointsOf(flowCurveEdit);
      const trim = flowCurveEnvOf(flowCurveEdit).trim || 0;
      const segIdx = flowCurveSegHit(x, y, pl, pts, trim);
      if (segIdx >= 0) { flowCurveSegFrom = segIdx; flowCurveSegTo = segIdx + 1; }
      else if (x >= pl.left - 4 && x <= pl.right + 4) {
        flowCurveMutate(() => { flowCurveInsert(pts, xToT(x, pl), yToAmp(y, pl) - trim); });
      }
    }
    flowCurvePtr = null;
  }
  saveFlow();
}

/* ---- Playback compile ----
   A note is the entry point of a sound: it aggregates its volume envelope, up
   to three waves, and each wave's optional mix envelope, unison, and the
   unison's optional vol/st/ct animation envelopes. compileFlowNote() builds the
   legacy globals (ENVELOPE, OSC_STACK, per-voice envs) from the connected
   graph; playFlowNote() swaps them in, previews the note, and restores. */
function compileFlowNote(note) {
  if (!note || note.type !== 'note' || !flowNoteReady(note)) return null;
  const envNode = flowNodeById(note.conn.volumeEnv);
  if (!envNode || !envNode.envelope) return null;
  const layers = [];
  for (let i = 0; i < 3; i++) {
    const wId = note.conn.waves[i];
    const w = wId ? flowNodeById(wId) : null;
    if (!w || w.type !== 'wave') continue;
    const spec = (w.wave && w.wave.amplitudes) ? w.wave : defaultWaveSpec();
    const layer = {
      id: 'flow-' + w.id,
      amplitudes: spec.amplitudes.slice(0, HARMONIC_COUNT),
      level: 1, trim: 0, muted: false,
      presetId: spec.presetId, specPoints: spec.specPoints,
      pitchEnv: null, voices: null,
    };
    // Mix envelope: an env curve v ∈ −1..1 maps to a mix weight 0..1 (0 = full);
    // the node's trim shifts the whole curve before that mapping, and each
    // span's line type (Line/Stairs/Spring/Pulse) rides along to the engine.
    const mixId = note.conn.mixEnvs[i];
    const mix = mixId ? flowNodeById(mixId) : null;
    if (mix && mix.type === 'env' && mix.env && Array.isArray(mix.env.points) && mix.env.points.length >= 2) {
      const mTrim = +mix.env.trim || 0;
      layer.curve = mix.env.points.map(pt => {
        const c = { t: clamp01(pt.t), v: clamp01(1 + (+pt.v || 0) + mTrim) };
        if (pt.seg && typeof pt.seg === 'object') c.seg = clone(pt.seg);
        return c;
      });
    } else {
      layer.curve = [{ t: 0, v: 1 }, { t: 1, v: 1 }];
    }
    // Unison: stack every connected unison's voices (each adds one duplicate
    // voice with its optional vol/st/ct animation envs), capped at the engine's
    // MAX_LAYER_VOICES.
    const unis = (w.conn && Array.isArray(w.conn.unison) ? w.conn.unison : [])
      .map(id => (id ? flowNodeById(id) : null))
      .filter(u => u && u.type === 'unison');
    if (unis.length) {
      const voices = [];
      for (const uni of unis) {
        if (!Array.isArray(uni.voices) || !uni.voices.length) continue;
        const vs = voicesFromSavedFlow(uni.voices);
        const uEnvs = compileUnisonEnvs(uni);
        if (uEnvs) for (const v of vs) v.envs = uEnvs;
        voices.push.apply(voices, vs);
      }
      if (voices.length) layer.voices = voices.slice(0, MAX_LAYER_VOICES);
    }
    layers.push(layer);
  }
  if (!layers.length) return null;
  return { envelope: clone(envNode.envelope), layers, masterPitchEnv: null, masterVoiceEnvs: { st: null, ct: null, vol: null } };
}
// The unison's connected vol/st/ct env nodes, compiled to legacy voice-envelope
// shapes ({ range, points }) with the neutral convention of each parameter.
function compileUnisonEnvs(uni) {
  const c = uni.conn || {};
  const out = { st: null, ct: null, vol: null };
  const mk = (id, range, scale, neutral) => {
    const n = id ? flowNodeById(id) : null;
    if (!n || n.type !== 'env' || !n.env || !Array.isArray(n.env.points) || n.env.points.length < 2) return null;
    const trim = +n.env.trim || 0;
    return {
      range,
      points: n.env.points.map(pt => {
        const c = {
          t: clamp01(pt.t),
          v: Math.max(-range, Math.min(range, neutral + ((+pt.v || 0) + trim) * scale)),
        };
        if (pt.seg && typeof pt.seg === 'object') c.seg = clone(pt.seg);
        return c;
      }),
    };
  };
  out.st = mk(c.stEnv, 24, 24, 0);
  out.ct = mk(c.ctEnv, 100, 100, 0);
  out.vol = mk(c.volEnv, 2, 1, 1);
  return (out.st || out.ct || out.vol) ? out : null;
}
function playFlowNote(note) {
  const compiled = compileFlowNote(note);
  if (!compiled) return false;
  initAudio();
  resumeAudio();
  if (!audioCtx || !masterGain) return false;
  const saved = { ENVELOPE, OSC_STACK, MASTER_PITCH_ENV, MASTER_VOICE_ENVS };
  ENVELOPE = compiled.envelope;
  OSC_STACK = { layers: compiled.layers };
  MASTER_PITCH_ENV = compiled.masterPitchEnv;
  MASTER_VOICE_ENVS = compiled.masterVoiceEnvs;
  try { previewNote(previewPitchName()); }
  finally {
    ENVELOPE = saved.ENVELOPE;
    OSC_STACK = saved.OSC_STACK;
    MASTER_PITCH_ENV = saved.MASTER_PITCH_ENV;
    MASTER_VOICE_ENVS = saved.MASTER_VOICE_ENVS;
  }
  return true;
}

/* ---- Note play modes (tap / full length / live) ----
   Beyond the one-shot full-length preview (playFlowNote above), a flow note can
   also be played like a tap or held live. Both reuse the shared live-note
   scheduler (initLivePathAudio / tickLiveHold / finishLivePathNote in audio.js)
   driven by a minimal synthetic "gesture": a single point at the preview pitch
   and preview base volume. Because they run the real live scheduler, every
   connected envelope applies — volume, wave mix, and unison vol/st/ct/pitch.
   The synthetic playback path is never drawn (gesture rendering only runs in
   the main area), so no stray circles appear in flow mode. */
var flowLive = null;    // { ds, nodeId } while a flow note's live button is held
function flowSyntheticDs(savedGlobals) {
  // Same base volume as the full preview (previewNote clamps its base to 0.35),
  // so the tap / live buttons sit at exactly the same level as the full button.
  const y = yForBaseVolume(Math.max(0.35, baseVolumeFromY(H * 0.55)));
  return {
    startX: 0, startY: y,
    pts: [{ x: 0, y }],
    cumTime: [0],
    totalMs: 0,
    pitchOverride: previewPitchName(),
    lastMoveAt: 0,
    finished: false,
    playback: { pts: [], cumTime: [], totalMs: 0, relMs: 0, startedAt: performance.now(), released: false, looped: true },
    savedGlobals,
  };
}
// Swap the shared sound globals in for the compiled flow note. They stay
// swapped for a live note's whole life (tickLiveHold / finishLivePathNote read
// them while scheduling), so the restore must wait until it wraps up.
function flowGlobalsSwap(compiled) {
  const saved = { ENVELOPE, OSC_STACK, MASTER_PITCH_ENV, MASTER_VOICE_ENVS };
  ENVELOPE = compiled.envelope;
  OSC_STACK = { layers: compiled.layers };
  MASTER_PITCH_ENV = compiled.masterPitchEnv;
  MASTER_VOICE_ENVS = compiled.masterVoiceEnvs;
  return saved;
}
function flowGlobalsRestore(saved) {
  if (!saved) return;
  ENVELOPE = saved.ENVELOPE;
  OSC_STACK = saved.OSC_STACK;
  MASTER_PITCH_ENV = saved.MASTER_PITCH_ENV;
  MASTER_VOICE_ENVS = saved.MASTER_VOICE_ENVS;
}
// Play a note "live": press-and-hold. Starts the note on press and sustains the
// envelope body (tickLiveHold in flowLoop) until release, then the release tail.
function flowLiveStart(note) {
  const compiled = compileFlowNote(note);
  if (!compiled) return false;
  flowStopRepeat();   // live is press-and-hold — never layered over a repeat
  initAudio();
  resumeAudio();
  if (!audioCtx || !masterGain) return false;
  stopPreviewVoices();
  if (flowLive) flowLiveEnd();
  const saved = flowGlobalsSwap(compiled);
  const ds = flowSyntheticDs(saved);
  try {
    initLivePathAudio(ds);
  } catch (err) {
    flowGlobalsRestore(saved);
    return false;
  }
  flowLive = { ds, nodeId: note.id };
  return true;
}
// End a held flow note: mark it finished, schedule its release tail, then
// restore the shared sound globals (the tail was baked in by finishLivePathNote).
function flowLiveEnd() {
  const lv = flowLive;
  flowLive = null;
  if (!lv || !lv.ds) return;
  const ds = lv.ds;
  try {
    if (ds.gain && !ds.finished) {
      ds.finished = true;
      finishLivePathNote(ds);
    } else if (ds.gain) {
      quickFadeNote(ds, 200);
    }
  } catch (err) {
    try { quickFadeNote(ds, 200); } catch (e) {}
  } finally {
    flowGlobalsRestore(ds.savedGlobals);
  }
}
// Play a note like a tap in the main area: the body plays through the early-cut
// marker, then the release section. Uses the same self-contained scheduler as
// the full button (previewNote) with a shorter body, so the tap starts exactly
// like the full preview — same onset, level, and every connected envelope.
function tapFlowNote(note) {
  const compiled = compileFlowNote(note);
  if (!compiled) return false;
  initAudio();
  resumeAudio();
  if (!audioCtx || !masterGain) return false;
  stopPreviewVoices();
  if (flowLive) flowLiveEnd();
  const saved = flowGlobalsSwap(compiled);
  try {
    previewNote(previewPitchName(), Math.max(1, earlyCutMs()));
  } finally {
    flowGlobalsRestore(saved);
  }
  return true;
}

/* ---- Note repeat (tap / full length) ----
   A repeat toggle makes the tap and full-length options play over and over.
   While a repeat is running, the looping button becomes a stop button (tap it
   again to stop); live stays press-and-hold and always stops any active repeat.
   The loop is timed by the note's own duration (body through the cut + release
   for tap, full body + release for full length), recomputed when it starts, so
   repeats land at the note's natural rhythm. */
var flowRepeat = false;         // the repeat toggle (applies to tap / full)
var flowRepeatTimer = null;     // interval handle while a repeat is active
var flowRepeatMode = null;      // 'tap' | 'full' | null — what is currently looping
var flowRepeatNodeId = null;    // note whose sound is looping
function flowLoopingMode() {
  return flowRepeatTimer ? flowRepeatMode : null;
}
function flowRepeatToggle() {
  flowRepeat = !flowRepeat;
  if (!flowRepeat) flowStopRepeat();
}
function flowStopRepeat() {
  if (flowRepeatTimer) { clearInterval(flowRepeatTimer); flowRepeatTimer = null; }
  flowRepeatMode = null;
  flowRepeatNodeId = null;
}
function flowRepeatIntervalMs(mode, compiled) {
  const env = compiled.envelope;
  if (!env || !env.components || !env.components.length) return 1200;
  const maxIdx = Math.max(0, env.beginReleaseIndex - 1);
  const idx = Math.max(-1, Math.min(maxIdx, env.earlyCutIndex == null ? maxIdx : env.earlyCutIndex));
  const cutMs = compsMs(env.components.slice(0, idx + 1));
  const relMs = compsMs(env.components.slice(env.beginReleaseIndex));
  const bodyMs = compsMs(env.components.slice(0, env.holdEndIndex + 1));
  const dur = mode === 'tap'
    ? Math.max(MIN_GESTURE_MS, cutMs) + relMs
    : bodyMs + relMs;
  return Math.max(300, dur) + FADE_MS + 40;   // full duration + a small gap
}
function flowStartRepeat(mode, note) {
  flowStopRepeat();
  const compiled = compileFlowNote(note);
  if (!compiled) return false;
  flowRepeatMode = mode;
  flowRepeatNodeId = note.id;
  if (mode === 'tap') tapFlowNote(note); else playFlowNote(note);
  const dur = flowRepeatIntervalMs(mode, compiled);
  flowRepeatTimer = setInterval(() => {
    const n = flowNodeById(flowRepeatNodeId);
    // Stop silently if the note vanished or is no longer playable.
    if (!n || !flowNoteReady(n) || !compileFlowNote(n)) { flowStopRepeat(); return; }
    if (flowRepeatMode === 'tap') tapFlowNote(n); else playFlowNote(n);
  }, dur);
  return true;
}
// The shared tap/full entry point: repeats when the toggle is on, otherwise
// plays once. Tapping the button of an already-looping mode stops it.
function flowPlayMode(mode, note) {
  if (flowRepeat) {
    if (flowRepeatMode === mode && flowRepeatNodeId === note.id) { flowStopRepeat(); return; }
    flowStartRepeat(mode, note);
  } else if (mode === 'tap') {
    tapFlowNote(note);
  } else {
    playFlowNote(note);
  }
}

/* ---- Pointer handling (active only in flow mode) ---- */
canvas.addEventListener('pointerdown', e => {
  if (!flowActive) return;
  const x = stageX(e), y = stageY(e);
  // When an editor dismisses itself on this tap (outside panel or ✕), fall
  // through so the tap also acts on whatever is underneath (ports / nodes /
  // grid). If it handled the tap internally, it stays open and we stop here.
  if (flowNoteEdit) { flowNoteHandleDown(x, y); if (flowLive) { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} } if (flowNoteEdit) return; }
  if (flowEnvEdit) { flowEnvHandleDown(x, y); if (flowEnvEdit) return; }
  if (flowWaveEdit) { flowWaveHandleDown(x, y); if (flowWaveEdit) return; }
  if (flowUnisonEdit) { flowUnisonHandleDown(x, y); if (flowUnisonEdit) return; }
  if (flowCurveEdit) { flowCurveHandleDown(x, y); if (flowCurveEdit) return; }
  // Top-left side-bar expand/collapse button, then the top-right undo/back.
  if (flowSideBtnHit(x, y)) {
    flowSideOpen = !flowSideOpen;
    if (!flowSideOpen) flowSideScrollY = 0;
    flowAddMenu = null;
    flowPanAnim = null;
    return;
  }
  const top = flowTopHit(x, y);
  if (top === 'undo') { undoFlow(); return; }
  if (top === 'back') { closeSoundFlow(); return; }
  // Node-list side bar: rows jump (pan) the camera; the panel stays open.
  if (flowSideOpen && x >= 0 && x <= FLOW_SIDE_W) {
    const s = flowSideRect();
    if (y >= s.y && y <= s.y + s.h) {
      if (y < s.y + FLOW_SIDE_HDR) {
        const cl = flowSideClearRect();
        if (x >= cl.x && x <= cl.x + cl.w && y >= cl.y && y <= cl.y + cl.h) { clearFlowAll(); }
        return;   // header: swallow (or the clear-all pill)
      }
      flowPtr = { kind: 'side', x, y, startX: x, startY: y, lastT: e.timeStamp, vx: 0, vy: 0, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }
  }
  // Edge jump buttons on a selected wire: tap one to pan to its off-screen node.
  const jumpBtn = hitFlowJumpBtn(x, y);
  if (jumpBtn) {
    flowAddMenu = null;
    flowPanAnim = null;
    flowInertia = null;
    panToNode(jumpBtn.node);
    return;
  }
  // On-node connection ports (arm / cancel). Drawn on top of the modal
  // and the add menu, so they hit before those.
  const portHit = hitFlowPort(x, y);
  if (portHit) {
    const pn = portHit.node, pt = portHit.pt;
    flowAddMenu = null;
    flowPanAnim = null;
    flowSelConn = null;   // arming a port supersedes wire selection
    const k = slotKey(pt.slot);
    if (flowConnArm && flowConnArm.nodeId === pn.id && slotKey(flowConnArm.slot) === k) flowConnArm = null;
    else flowConnArm = { nodeId: pn.id, slot: pt.slot };
    return;
  }
  // Add-node menu option (create the node).
  const opt = hitAddMenu(x, y);
  if (opt) { addFlowNode(opt.type); return; }
  // A note widget's ▶ live button is a press-and-hold: start it on press so the
  // note sustains until the finger lifts (the tap / full buttons act on the
  // tap in pointerup below).
  const wxp = x + flowCam.x, wyp = y + flowCam.y;
  const wn = flowNodeAt(wxp, wyp);
  if (wn && wn.type === 'note') {
    const wr = flowWidgetRect(wn, false);
    const btns = flowNoteWidgetButtons(wr);
    if (x >= btns.live.x && x <= btns.live.x + btns.live.w && y >= btns.live.y && y <= btns.live.y + btns.live.h) {
      flowSelId = wn.id;
      flowAddMenu = null;
      flowConnArm = null;
      if (flowLiveStart(wn)) {
        flowPtr = null;
        flowHold = null;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      }
      return;
    }
  }
  // Grid: start a pan (a small movement counts as a tap on release). Pressing
  // on a node arms a long-press move/delete hold; pressing a wire selects it
  // and arms a long-press delete hold; empty space arms the add-menu hold.
  flowAddMenu = null;
  flowInertia = null;
  flowPanAnim = null;
  const wx = x + flowCam.x, wy = y + flowCam.y;
  const node = flowNodeAt(wx, wy);
  const conn = node ? null : flowConnAtPress(x, y);
  flowPtr = { kind: 'grid', x, y, startX: x, startY: y, lastT: e.timeStamp, vx: 0, vy: 0, moved: false };
  if (node) {
    flowSelConn = null;
    flowHold = { id: node.id, kind: 'move', t0: performance.now(), stage: 0 };
  } else if (conn) {
    selectFlowConn(conn);
    flowHold = { id: null, kind: 'conn', conn: { nodeId: conn.nodeId, slot: conn.slot }, x, y, t0: performance.now(), stage: 0 };
  } else {
    flowHold = { id: null, kind: 'add', x: wx, y: wy, t0: performance.now(), stage: 0 };
  }
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
});

canvas.addEventListener('pointermove', e => {
  if (!flowActive) return;
  const x = stageX(e), y = stageY(e);
  if (flowNoteEdit) { flowNoteHandleMove(x, y); return; }
  if (flowEnvEdit) { flowEnvHandleMove(x, y); return; }
  if (flowWaveEdit) { flowWaveHandleMove(x, y); return; }
  if (flowUnisonEdit) { flowUnisonHandleMove(x, y); return; }
  if (flowCurveEdit) { flowCurveHandleMove(x, y); return; }
  if (flowLive) return;   // a held live button is a sustain, not a pan
  if (!flowPtr) return;
  if (!flowPtr.moved && Math.hypot(x - flowPtr.startX, y - flowPtr.startY) > FLOW_TAP_MAX) {
    flowPtr.moved = true;
    // Moving the finger means it's a drag/scroll, not a long-press: drop the hold.
    if (flowHold) { flowHold = null; flowMoveId = null; }
  }
  const dx = x - flowPtr.x, dy = y - flowPtr.y;
  if (flowPtr.kind === 'side') {
    if (flowPtr.moved) flowSideScrollY = Math.max(0, Math.min(flowSideMaxScroll(), flowSideScrollY - dy));
    flowPtr.x = x; flowPtr.y = y;
    return;
  }
  const dt = Math.max(1, e.timeStamp - flowPtr.lastT);
  // Smoothed finger velocity (px/ms), so a quick flick builds momentum.
  flowPtr.vx = flowPtr.vx * 0.6 + (dx / dt) * 0.4;
  flowPtr.vy = flowPtr.vy * 0.6 + (dy / dt) * 0.4;
  flowCam.x -= dx;
  flowCam.y -= dy;
  flowPtr.x = x; flowPtr.y = y; flowPtr.lastT = e.timeStamp;
});

canvas.addEventListener('pointerup', e => {
  if (!flowActive) return;
  const x = stageX(e), y = stageY(e);
  if (flowNoteEdit) { flowNoteHandleUp(); return; }
  if (flowEnvEdit) { flowEnvHandleUp(x, y); return; }
  if (flowWaveEdit) { flowWaveHandleUp(); return; }
  if (flowUnisonEdit) { flowUnisonHandleUp(); return; }
  if (flowCurveEdit) { flowCurveHandleUp(x, y); return; }
  // A held live button releases on finger-up: schedule the note's release tail.
  if (flowLive) { flowLiveEnd(); return; }
  // A held press that reached its long-press action (move mode / add menu):
  // consume the release so it doesn't also select/deselect or act as a tap.
  if (flowHold) {
    const h = flowHold;
    flowHold = null;
    if (h.stage >= 1) { flowPtr = null; return; }
  }
  if (!flowPtr) return;
  const kind = flowPtr.kind;
  const wasMoved = flowPtr.moved;
  const tapX = flowPtr.startX, tapY = flowPtr.startY;
  const vx = flowPtr.vx, vy = flowPtr.vy;
  flowPtr = null;
  if (kind === 'side') {
    if (wasMoved) return;   // a scroll of the node list
    const jump = flowSideRowAt(tapX, tapY);
    if (jump) panToNode(jump);   // jump only — the list stays open
    return;
  }
  if (wasMoved) {
    if (Math.hypot(vx, vy) > FLOW_FLICK_MIN) flowInertia = { vx, vy };
    return;
  }
  // Tap: the world point under the finger.
  const tapWX = tapX + flowCam.x, tapWY = tapY + flowCam.y;
  const node = flowNodeAt(tapWX, tapWY);
  // Connection slot armed: tapping a node assigns it (kept armed on a wrong
  // type so the user can pick the right node instead). This beats move-mode
  // placement — a deliberate connection action shouldn't get hijacked.
  if (flowConnArm && node) {
    const consumer = flowNodeById(flowConnArm.nodeId);
    if (consumer && flowConnCanAssign(consumer, flowConnArm.slot, node.id)) {
      flowPushHistory();
      connSlotSet(consumer, flowConnArm.slot, node.id);
      saveFlow();
      flowConnArm = null;
    }
    return;
  }
  // Move mode: place the flashing node at this point, auto-spacing it from any
  // neighbours (a tap too close to another node still moves it, then it floats
  // out to clear spacing).
  if (flowMoveId) {
    moveFlowNodeTo(flowMoveId, tapWX, tapWY);
    return;
  }
  if (node) {
    // A note widget's four ▶ play buttons are always live: tapping the tap /
    // full / repeat buttons acts on the tap instead of entering edit mode (the
    // live button is handled on pointerdown as a press-and-hold).
    if (node.type === 'note') {
      const wr = flowWidgetRect(node, false);
      const btns = flowNoteWidgetButtons(wr);
      if (tapX >= btns.tap.x && tapX <= btns.tap.x + btns.tap.w && tapY >= btns.tap.y && tapY <= btns.tap.y + btns.tap.h) {
        flowPlayMode('tap', node);
        flowSelId = node.id;
        return;
      }
      if (tapX >= btns.full.x && tapX <= btns.full.x + btns.full.w && tapY >= btns.full.y && tapY <= btns.full.y + btns.full.h) {
        flowPlayMode('full', node);
        flowSelId = node.id;
        return;
      }
      if (tapX >= btns.repeat.x && tapX <= btns.repeat.x + btns.repeat.w && tapY >= btns.repeat.y && tapY <= btns.repeat.y + btns.repeat.h) {
        flowRepeatToggle();
        flowSelId = node.id;
        return;
      }
    }
    // Tap a widget = enter edit mode: it grows in place (tap outside shrinks it).
    openFlowNodeEditor(node.id);
  } else {
    if (flowConnArm) { flowConnArm = null; return; }   // cancelled on an empty spot
    flowAddMenu = null;   // a plain tap never opens the add menu — long-press does
    flowSelId = null;
    if (!hitFlowConn(tapX, tapY)) flowSelConn = null;   // an empty tap clears wire selection
  }
});

canvas.addEventListener('pointercancel', () => {
  if (flowLive) flowLiveEnd();
  flowEnvPtr = null;
  flowWavePtr = null;
  flowUnisonDrag = null;
  flowCurvePtr = null;
  flowPtr = null;
  flowInertia = null;
  flowPanAnim = null;
  flowHold = null;
  flowSepAnim = null;
});

function flowLoop(now) {
  if (flowActive) {
    // A held live note sustains its envelope body while the finger stays down.
    if (flowLive) tickLiveHold(flowLive.ds);
    // Long-press hold: move mode on a node (stage 1), then a longer hold on the
    // same node becomes a delete countdown (stage 2); holding empty space opens
    // the add menu; holding a wire flashes it, then a 3-2-1 countdown deletes
    // the connection (release cancels).
    if (flowHold) {
      const el = performance.now() - flowHold.t0;
      if (flowHold.kind === 'conn') {
        if (flowHold.stage === 0 && el >= FLOW_HOLD_MOVE) flowHold.stage = 1;
        else if (flowHold.stage === 1 && el >= FLOW_HOLD_DELETE) {
          flowHold.stage = 2;
          flowHold.del0 = performance.now();
        }
        if (flowHold.stage === 2 && performance.now() - flowHold.del0 >= FLOW_DELETE_MS) {
          const c = flowHold.conn;
          flowHold = null;
          deleteFlowConn(c.nodeId, c.slot);
        }
      } else {
        if (flowHold.stage === 0 && el >= FLOW_HOLD_MOVE) {
          flowHold.stage = 1;
          if (flowHold.kind === 'add') {
            flowAddMenu = { x: flowHold.x, y: flowHold.y };   // add menu at the held spot
            flowSelId = null;
            flowConnArm = null;
            flowMoveId = null;
          } else {
            flowMoveId = flowHold.id;   // start flashing (move mode)
            flowSelId = flowHold.id;
            flowAddMenu = null;
          }
        }
        // Keep holding past move mode → switch to the 3-2-1 delete countdown.
        if (flowHold.kind !== 'add' && flowHold.stage === 1 && el >= FLOW_HOLD_DELETE) {
          flowHold.stage = 2;
          flowHold.del0 = performance.now();
          flowMoveId = null;   // cancel move placement
        }
        if (flowHold.stage === 2 && performance.now() - flowHold.del0 >= FLOW_DELETE_MS) {
          const id = flowHold.id;
          flowHold = null;
          deleteFlowNode(id);
        }
      }
    }
    // Float-away separation: a newly added / moved node drifts to clear space,
    // and the camera pans with it so the node settles in the centre of the screen.
    if (flowSepAnim) {
      const n = flowNodeById(flowSepAnim.id);
      if (n) {
        const f = clamp01((performance.now() - flowSepAnim.t0) / FLOW_SEP_MS);
        const e = 1 - Math.pow(1 - f, 3);
        n.x = mix(flowSepAnim.x0, flowSepAnim.x1, e);
        n.y = mix(flowSepAnim.y0, flowSepAnim.y1, e);
        flowCam.x = mix(flowSepAnim.cam0x, flowSepAnim.x1 - W / 2, e);
        flowCam.y = mix(flowSepAnim.cam0y, flowSepAnim.y1 - H / 2, e);
        if (f >= 1) { flowSepAnim = null; saveFlow(); }
      } else {
        flowSepAnim = null;
      }
    }
    // Animated pan to a node (sidebar jump) — ease-out cubic.
    if (flowPanAnim) {
      const f = clamp01((performance.now() - flowPanAnim.t0) / 350);
      const e = 1 - Math.pow(1 - f, 3);
      flowCam.x = mix(flowPanAnim.x0, flowPanAnim.x1, e);
      flowCam.y = mix(flowPanAnim.y0, flowPanAnim.y1, e);
      if (f >= 1) flowPanAnim = null;
    }
    if (flowInertia) {
      const dt = Math.max(0, now - flowLastT);
      // Finger velocity is signed the same way the drag moved the camera:
      // positive vx meant the grid content followed the finger to the right, so
      // momentum keeps it gliding in that same direction (cam moves opposite).
      flowCam.x -= flowInertia.vx * dt;
      flowCam.y -= flowInertia.vy * dt;
      const decay = Math.pow(0.94, dt / 16.67);   // ~6% speed loss per frame at 60fps
      flowInertia.vx *= decay;
      flowInertia.vy *= decay;
      if (Math.hypot(flowInertia.vx, flowInertia.vy) < FLOW_FLICK_STOP) flowInertia = null;
    }
    try { drawFlow(now); } catch (err) { console.error(err); }
  }
  flowLastT = now;
  requestAnimationFrame(flowLoop);
}
requestAnimationFrame(flowLoop);