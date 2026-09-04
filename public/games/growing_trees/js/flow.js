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
   tap the port again to cancel, its ✕ clears); wires render as colored beziers
   from a source to the consumer's port. Every node is an always-visible widget
   card that shows its values (mini envelope / curve / spectrum / faders / play
   + note-life) read-only, sized to fit exactly. Tapping a widget enters edit
   mode: it grows in place into its full editor (envelope / wave / curve /
   unison / note), and tapping outside it shrinks it back. The ▶ Play button on
   a note widget is always live. Long-press a node to move it (flash + tap to
   place); hold it longer and a 3-2-1 countdown deletes it (release to cancel).
   The ☰ top-left button opens a read-only node-list side bar (tap a row to pan
   to that node); all editing happens on the field.
   ============================================================ */

const flowBtn = document.getElementById('flowBtn');
const FLOW_CELL = 88;           // node size basis (px): the old grid cell, kept as the visual scale
const FLOW_SHOW_GRID = false;   // draw the old dotted grid + cell coordinates? (kept for a possible return)
const FLOW_NODE_SEP = 190;      // min centre-to-centre distance between nodes (float-away spacing; widgets are wider than cells)
const FLOW_SEP_MS = 250;        // duration of the float-away separation animation
const FLOW_BACK_R = 22;         // top-right round button radius (sidebar / undo / back)
const FLOW_TOP_BTN_GAP = 14;    // gap between the top-right buttons
const FLOW_TAP_MAX = 10;        // px of movement before a touch counts as a pan
const FLOW_PORT_R = 15;         // connection-port dot radius on a node's edge
const FLOW_HOLD_MOVE = 500;     // ms of a still hold before the node enters move mode (flash)
const FLOW_HOLD_DELETE = 1200;  // ms of a continued hold (past move mode) before the delete countdown starts
const FLOW_DELETE_MS = 3000;    // delete countdown duration: a 3-2-1 hold before the node is deleted
const FLOW_SIDE_W = 250;        // node-list side bar width (left edge)
const FLOW_SIDE_HDR = 44;       // side bar header height
const FLOW_SIDE_ROW_H = 44;     // side bar row height
const FLOW_HISTORY_MAX = 50;    // undo stack depth
const FLOW_WAVE_ACCENT = '#4fc3f7';      // wave-editor plot accent (cyan)
const FLOW_UNISON_ACCENT = '#d98cff';    // unison-editor accent (violet)
// Wire colors, keyed by connection-slot role.
const FLOW_WIRE_COLORS = {
  volumeEnv: '#4caf50',
  waves: FLOW_WAVE_ACCENT,
  mixEnvs: '#ffb74d',
  mixEnv: '#ffb74d',
  unison: '#ba68c8',
  volEnv: '#9ccc65',
  stEnv: '#64b5f6',
  ctEnv: '#f48fb1',
};

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
// The top-right control row: undo and back (rightmost), as two round buttons.
function flowTopButtonRects() {
  const d = FLOW_BACK_R * 2;
  const backX = W - 16 - d;
  const undoX = backX - d - FLOW_TOP_BTN_GAP;
  return {
    undo: { x: undoX, y: 16, d },
    back: { x: backX, y: 16, d },
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
// A note widget's ▶ play button and its note-life slider track, laid out for
// whatever rect it is drawn in (idle widget or enlarged note editor).
function flowNoteWidgetPlay(r) {
  return { x: r.x + 10, y: r.y + 30, w: r.w - 20, h: 26 };
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
function defaultEnvCurve() {
  return { points: [{ t: 0, v: 0 }, { t: 1, v: 0 }] };
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
  if (type === 'wave') return { mixEnv: null, unison: null };
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
    rows.push({ slot: { key: 'mixEnv' }, label: 'Mix env', y: 0 });
    rows.push({ slot: { key: 'unison' }, label: 'Unison', y: 0 });
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
  return true;
}
// Is a note playable (volume env + at least one wave connected)?
function flowNoteReady(note) {
  if (!note || note.type !== 'note') return false;
  const c = flowNodeConn(note);
  return !!c.volumeEnv && !!c.waves.some(Boolean);
}
// Clear every slot that references `id` (used when a node is deleted).
function flowDetachNode(id) {
  for (const n of flowNodes) {
    for (const r of flowSlotRows(n)) {
      const pills = r.pill2 ? [r.slot, r.pill2] : [r.slot];
      for (const slot of pills) {
        if (connSlotGet(n, slot) === id) connSlotSet(n, slot, null);
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
// v −1..1; falls back to the flat-neutral default when nothing valid is stored.
function envCurveFromSaved(e) {
  if (e && Array.isArray(e.points) && e.points.length >= 2) {
    const pts = e.points
      .filter(p => p && typeof p.t === 'number' && typeof p.v === 'number')
      .map(p => ({ t: clamp01(p.t), v: Math.max(-1, Math.min(1, p.v)) }));
    pts.sort((a, b) => a.t - b.t);
    if (pts.length >= 2) return { points: pts };
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
    out.unison = typeof c.unison === 'string' ? c.unison : null;
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
        if (w && seen[w]) c.waves[i] = null;
        if (w) seen[w] = true;
      }
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
  flowSideOpen = false;
  flowSideScrollY = 0;
  flowSepAnim = null;
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
   cancels; a filled dot's ✕ clears it. While armed, tapping a valid source node
   on the grid assigns it. Wires terminate at the consumer's port anchor. */
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
  if (slot.key === 'unison') return 'Uni';
  if (slot.key === 'volEnv') return 'Vol';
  if (slot.key === 'stEnv') return 'St';
  if (slot.key === 'ctEnv') return 'Ct';
  return '';
}
// Screen-space port dots for a node (on the widget card's edges).
function flowPorts(node) {
  const p = flowNodeScreen(node);
  const cx = p.x, cy = p.y;
  const r = flowWidgetRect(node, false);
  const w = r.w, h = r.h;
  const out = [];
  const add = (slot, px, py, edge, req) => {
    out.push({
      slot, cx: px, cy: py, edge, req: !!req,
      emoji: flowPortEmoji(slot),
      label: flowPortLabel(slot),
      color: flowWireColor(slotKey(slot)),
    });
  };
  if (node.type === 'note') {
    add({ key: 'volumeEnv' }, cx, cy - h / 2 - 6, 'top', true);
    for (let i = 0; i < 3; i++) {
      const y = cy + (i - 1) * 27;
      add({ key: 'waves', idx: i }, cx + w / 2 + 6, y, 'right', i === 0);
      add({ key: 'mixEnvs', idx: i }, cx - w / 2 - 6, y, 'left');
    }
  } else if (node.type === 'wave') {
    add({ key: 'mixEnv' }, cx, cy - h / 2 - 6, 'top');
    add({ key: 'unison' }, cx, cy + h / 2 + 6, 'bottom');
  } else if (node.type === 'unison') {
    add({ key: 'volEnv' }, cx - w / 2 - 6, cy - 27, 'left');
    add({ key: 'stEnv' }, cx - w / 2 - 6, cy, 'left');
    add({ key: 'ctEnv' }, cx - w / 2 - 6, cy + 27, 'left');
  }
  return out;
}
// The port dot for a particular slot (wire endpoint / armed-slot match).
function flowPortAnchor(node, slot) {
  const s = slotKey(slot);
  for (const pt of flowPorts(node)) if (slotKey(pt.slot) === s) return pt;
  return null;
}
// The ✕ clear badge on a filled port (sits just beyond the dot, outward).
function flowPortClearPos(pt) {
  const o = FLOW_PORT_R + 10;
  if (pt.edge === 'right') return { cx: pt.cx + o, cy: pt.cy };
  if (pt.edge === 'left') return { cx: pt.cx - o, cy: pt.cy };
  if (pt.edge === 'top') return { cx: pt.cx, cy: pt.cy - o };
  return { cx: pt.cx, cy: pt.cy + o };
}
// Screen-space port hit test. On a filled port the ✕ badge (radius 8) takes
// precedence and the dot itself is a narrower target, so the rim between them
// does nothing rather than accidentally clearing.
function hitFlowPort(x, y) {
  for (const n of flowNodes) {
    for (const pt of flowPorts(n)) {
      const dDot = Math.hypot(x - pt.cx, y - pt.cy);
      if (dDot > FLOW_PORT_R + 6) continue;
      const filled = !!connSlotGet(n, pt.slot);
      if (filled) {
        const c = flowPortClearPos(pt);
        if (Math.hypot(x - c.cx, y - c.cy) <= 8) return { node: n, pt, clear: true };
        if (dDot <= FLOW_PORT_R) return { node: n, pt };
      } else {
        return { node: n, pt };
      }
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
      ctx.fillText(pt.label, pt.cx, pt.edge === 'top' ? pt.cy - FLOW_PORT_R - 5 : pt.cy + FLOW_PORT_R + 6);
      // ✕ clear badge on filled ports.
      if (filled) {
        const c = flowPortClearPos(pt);
        ctx.beginPath();
        ctx.arc(c.cx, c.cy, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#c0392b';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = '800 9px sans-serif';
        ctx.fillText('✕', c.cx, c.cy + 1);
      }
      ctx.textBaseline = 'alphabetic';
    }
  }
}

/* ---- Wire rendering ----
   Consumer-owned slots are drawn as beziers from the source node's cell to the
   consumer's cell, colored by role. Drawn under the node circles. */
function flowWireColor(slotKeyStr) {
  return FLOW_WIRE_COLORS[slotKeyStr.split(':')[0]] || '#bdbdbd';
}
function drawFlowWires() {
  for (const n of flowNodes) {
    const rows = flowSlotRows(n);
    const sel = n.id === flowSelId;
    for (const r of rows) {
      const pills = r.pill2 ? [r.slot, r.pill2] : [r.slot];
      for (const slot of pills) {
        const tid = connSlotGet(n, slot);
        if (!tid) continue;
        const src = flowNodeById(tid);
        if (!src) continue;
        const a = flowNodeScreen(src);
        const b = flowNodeScreen(n);
        const ax = a.x, ay = a.y;
        // Wires terminate at the consumer's on-node port for this slot.
        const port = flowPortAnchor(n, slot);
        const bx = port ? port.cx : b.x;
        const by = port ? port.cy : b.y + FLOW_CELL / 2;
        const color = flowWireColor(slotKey(slot));
        ctx.globalAlpha = sel ? 1 : 0.5;
        ctx.strokeStyle = color;
        ctx.lineWidth = sel ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        const mx = bx + (ax - bx) * 0.5;
        ctx.bezierCurveTo(mx, ay, mx, by, bx, by);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
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
function drawFlowWidgetNote(n, r) {
  const ready = flowNoteReady(n);
  // Play button (always live — tapping it previews, never edits).
  const p = flowNoteWidgetPlay(r);
  drawRoundRect(p.x, p.y, p.w, p.h, 8);
  ctx.fillStyle = ready ? '#1b8a4a' : '#2b2b2b';
  ctx.fill();
  ctx.strokeStyle = ready ? '#1b8a4a' : 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = ready ? '#ffffff' : 'rgba(255,255,255,0.4)';
  ctx.font = '800 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ready ? '▶ Play sound' : '▶ Needs volume + wave', p.x + p.w / 2, p.y + p.h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
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
  drawMiniPlotFrame(pl);
  if (!pts) return;
  ctx.strokeStyle = '#8dd3ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tToX(0, pl), ampToY(specValueAtCurve(pts, 0), pl));
  for (let j = 0; j < pts.length; j++) ctx.lineTo(tToX(pts[j].t, pl), ampToY(pts[j].v, pl));
  ctx.lineTo(tToX(1, pl), ampToY(specValueAtCurve(pts, 1), pl));
  ctx.stroke();
  for (const pt of pts) {
    ctx.fillStyle = '#8dd3ff';
    ctx.beginPath();
    ctx.arc(tToX(pt.t, pl), ampToY(pt.v, pl), 3, 0, Math.PI * 2);
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
    drawFlowWidgetFader(d.label, val, d.min, d.max, d.fmt, y, r);
    y += 28;
  }
}
function drawFlowWidgetFader(label, val, min, max, fmt, y, r) {
  const trackX1 = r.x + 58, trackX2 = r.x + r.w - 54;
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
  ctx.lineCap = 'butt';
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '700 9px sans-serif';
  ctx.fillText(fmt(val), r.x + r.w - 8, y);
}

/* ---- Note editor ----
   A note's editing surface is just its widget grown in place: a big ▶ play
   button plus an editable Note-life slider (scales the connected volume env).
   Tapping outside the enlarged card closes it back down. */
var flowNoteEdit = null;    // id of the note node being edited, or null
function flowNoteEditorPlay(p) {
  return { x: p.x + 16, y: p.y + 46, w: p.w - 32, h: 36 };
}
function flowNoteEditorLife(p) {
  return { x: p.x + 108, x2: p.x + p.w - 20, y: p.y + 128 };
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
  // Big play button.
  const ready = flowNoteReady(n);
  const pb = flowNoteEditorPlay(p);
  drawRoundRect(pb.x, pb.y, pb.w, pb.h, 10);
  ctx.fillStyle = ready ? '#1b8a4a' : '#2b2b2b';
  ctx.fill();
  ctx.strokeStyle = ready ? '#1b8a4a' : 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = ready ? '#ffffff' : 'rgba(255,255,255,0.4)';
  ctx.font = '800 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ready ? '▶ Play sound' : '▶ Needs volume + wave', pb.x + pb.w / 2, pb.y + pb.h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
  // Note-life slider (editable here).
  const env = flowNoteLifeEnv(n);
  const ms = env ? flowNoteLifeMs(n) : 0;
  ctx.fillStyle = env ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)';
  ctx.font = '800 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Note life', p.x + 16, p.y + 128);
  ctx.textAlign = 'right';
  ctx.fillText(ms ? Math.round(ms) + ' ms' : '—', p.x + p.w - 16, p.y + 128);
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
  const pb = flowNoteEditorPlay(p);
  if (x >= pb.x && x <= pb.x + pb.w && y >= pb.y && y <= pb.y + pb.h) {
    const n = flowNodeById(flowNoteEdit);
    if (n) playFlowNote(n);
    return;
  }
  const s = flowNoteEditorLife(p);
  if (y >= s.y - 18 && y <= s.y + 18 && x >= s.x - 12 && x <= s.x2 + 12) {
    const n = flowNodeById(flowNoteEdit);
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
}
// Open the editor for a node (tap on its widget → edit mode, growing in place).
function openFlowNodeEditor(id) {
  const n = flowNodeById(id);
  if (!n) return;
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

  // ---- Top-right control row (undo / back) ----
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
var flowEnvPtr = null;     // { mode: 'bound'|'trim'|'segparam', ... } active overlay drag
var flowEnvMarker = null;  // armed HOLD/CUT/REL marker awaiting a destination tap
var flowEnvLastTap = null; // double-tap-to-delete on an envelope boundary
var flowEnvMode = 'point'; // 'point' | 'draw' | 'line' (segment line types) | 'delete'
var flowEnvSegFrom = null, flowEnvSegTo = null;   // selected segment (boundary indexes)

// The shared enlarged editor panel: the node's own widget, grown in place at
// its position (centered on the node, clamped to stay on screen), so the rest
// of the grid stays visible around it. Tapping outside it ends edit mode.
function flowEnvPanel() {
  const w = Math.min(600, W - 24);
  const h = Math.min(440, H - 24);
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
function flowEnvPlot(p) {
  const top = p.y + 140, bottom = p.y + p.h - 28, left = p.x + 32, right = p.x + p.w - 18;
  return { top, bottom, left, right, pw: right - left, ph: bottom - top };
}
function flowEnvCloseRect(p) {
  return { x: p.x + p.w - 48, y: p.y + 8, w: 38, h: 38 };
}
function flowEnvClearPill(p) {
  return { x: p.x + p.w - 70, y: p.y + 46, w: 54, h: 26 };
}
function flowEnvToolbar(p) {
  const modes = [['point', 'Point'], ['draw', 'Draw'], ['line', 'Line'], ['delete', 'Delete']];
  const w = 54, gap = 6, h = 26, y = p.y + 48, x0 = p.x + 16;
  return modes.map((m, i) => ({ mode: m[0], label: m[1], x: x0 + i * (w + gap), y, w, h }));
}
function flowEnvTrimSlider(p) {
  const pl = flowEnvPlot(p);
  return { x: p.x + 8, w: 14, y0: pl.top + 4, y1: pl.bottom - 4 };
}
function flowEnvMarkerTabs(p) {
  const pl = flowEnvPlot(p);
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
  flowEnvLastTap = null;
  flowEnvMode = 'point';
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
  flowEnvLastTap = null;
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
function flowEnvSegStartX(i, pl) {
  const eb = envBoundaries();
  return tToX(eb.tOf(eb.b[i]), pl);
}
function flowEnvSegIndexAtX(x, pl) {
  const m = flowEnvSegModel();
  if (m.lastPoint < 2) return -1;
  let best = -1, bd = Infinity;
  for (let i = 0; i < m.lastPoint - 1; i++) {
    const d = Math.abs(x - flowEnvSegStartX(i, pl));
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
// The Line-mode editor card (floats over the top of the plot).
function flowEnvSegParamGroups(x, w, cy) {
  const cur = flowEnvSegCurrent();
  const type = cur ? segOf(cur).type : 'line';
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
function flowEnvSegCard(p) {
  const pl = flowEnvPlot(p);
  const w = Math.min(560, Math.max(340, pl.pw * 0.78));
  const x = pl.left + 4, y0 = pl.top + 8;
  const pillW = (w - 20 - (SEGMENT_TYPE_ORDER.length - 1) * 4) / SEGMENT_TYPE_ORDER.length;
  const pills = SEGMENT_TYPE_ORDER.map((t, i) => ({ t, x: x + 10 + i * (pillW + 4), y: y0 + 26, w: pillW, h: 26 }));
  const params = flowEnvSegParamGroups(x, w, y0 + 26 + 26 + 6 + 15);
  return { x, y0, w, h: 26 + 26 + 6 + 30 + 10, rowH: 26, pills, params };
}
function flowEnvHitSegCard(x, y, p) {
  const R = flowEnvSegCard(p);
  if (x < R.x || x > R.x + R.w || y < R.y0 || y > R.y0 + R.h) return null;
  for (const pill of R.pills) {
    if (x >= pill.x && x <= pill.x + pill.w && y >= pill.y && y <= pill.y + pill.h) return { type: 'type', t: pill.t };
  }
  for (const g of R.params) {
    if (y >= g.cy - g.btnW - 4 && y <= g.cy + g.btnW + 4) {
      if (x >= g.bxMinus && x <= g.bxMinus + g.btnW) return { type: 'param', key: g.key, dir: -1 };
      if (x >= g.bxPlus && x <= g.bxPlus + g.btnW) return { type: 'param', key: g.key, dir: 1 };
      if (x >= g.x1 - 6 && x <= g.x2 + 8) return { type: 'slider', key: g.key };
    }
  }
  return { type: 'bar' };
}

function drawFlowEnvEditor() {
  const p = flowEnvPanel();
  const pl = flowEnvPlot(p);
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
  const cl = flowEnvCloseRect(p);
  ctx.beginPath();
  ctx.arc(cl.x + cl.w / 2, cl.y + cl.h / 2, 14, 0, Math.PI * 2);
  ctx.fillStyle = '#333333';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('✕', cl.x + cl.w / 2, cl.y + cl.h / 2 + 5);
  // Mode toolbar.
  for (const b of flowEnvToolbar(p)) {
    const active = flowEnvMode === b.mode;
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
  // Line-mode segment editor (floats over the plot when a segment is picked).
  if (flowEnvMode === 'line' && flowEnvSegRange()) drawFlowEnvSegCard(p);
  else if (flowEnvMode === 'line') {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '700 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Tap the graph to pick a segment, then choose a line type', pl.left + pl.pw / 2, pl.top + pl.ph / 2 - 10);
  }
  // Hint.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(flowEnvMode === 'line'
    ? 'Line · tap the graph to pick a segment, then choose Line / Stairs / Spring / Pulse'
    : flowEnvMode === 'draw'
    ? 'Draw · drag across the graph to scribble the curve (' + drawPointCount() + ' pts) · tap Point to edit dots'
    : flowEnvMode === 'delete'
    ? 'Delete · tap a dot to remove it'
    : 'Point · tap to add a point · drag a dot to move · double-tap a dot to delete · tap HOLD/CUT/REL then a dot to move it', p.x + p.w / 2, p.y + p.h - 8);
}

function drawFlowEnvSegCard(p) {
  const R = flowEnvSegCard(p);
  const cur = flowEnvSegCurrent();
  const type = cur ? segOf(cur).type : 'line';
  const r = flowEnvSegRange();
  drawRoundRect(R.x, R.y0, R.w, R.h, 10);
  ctx.fillStyle = 'rgba(28,28,32,0.97)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Segment ' + (r ? r.lo : 0) + ' · tap the graph to re-select', R.x + 12, R.y0 + 18);
  for (const pill of R.pills) {
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
  if (!R.params.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '700 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Line = a straight ramp — pick a shape above', R.x + R.w / 2, R.y0 + R.h - 12);
    return;
  }
  for (const g of R.params) {
    const d = SEG_PARAM_DEFS[g.key];
    const val = flowEnvSegParamValue(g.key);
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
  const pl = flowEnvPlot(p);
  // Close (✕) — or tap anywhere outside the panel to dismiss.
  if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) { closeFlowEnvelopeEditor(); return; }
  const cl = flowEnvCloseRect(p);
  if (x >= cl.x && x <= cl.x + cl.w && y >= cl.y && y <= cl.y + cl.h) { closeFlowEnvelopeEditor(); return; }
  // Mode toolbar.
  for (const b of flowEnvToolbar(p)) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      flowEnvMode = b.mode;
      flowEnvSegFrom = null;
      flowEnvSegTo = null;
      return;
    }
  }
  // Clear pill.
  const cp = flowEnvClearPill(p);
  if (x >= cp.x && x <= cp.x + cp.w && y >= cp.y && y <= cp.y + cp.h) {
    flowEnvMutate(() => {
      const env = clone(DEFAULT_ENVELOPE);
      const n = flowNodeById(flowEnvEdit);
      if (n) n.envelope = env;
      ENVELOPE = env;
      clampEnvelopeIndexes();
    });
    return;
  }
  // Line-mode segment editor card (type pills / parameter controls).
  if (flowEnvMode === 'line' && flowEnvSegRange()) {
    const hit = flowEnvHitSegCard(x, y, p);
    if (hit) {
      if (hit.type === 'type') flowEnvSetSegType(hit.t);
      else if (hit.type === 'param') flowEnvSetSegParam(hit.key, flowEnvSegParamValue(hit.key) + hit.dir * SEG_PARAM_DEFS[hit.key].step);
      else if (hit.type === 'slider') {
        const R = flowEnvSegCard(p);
        const g = R.params.find(r => r.key === hit.key);
        if (g) { flowEnvSetSegParam(hit.key, flowEnvSegParamFromX(g, x)); flowEnvPtr = { mode: 'segparam', key: hit.key }; }
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
    flowEnvPtr = { mode: 'trim', x0: x, y0: y };
    return;
  }
  // Plot behaviour depends on the mode.
  if (y >= pl.top && y <= pl.bottom) {
    if (flowEnvMode === 'draw') {
      const s0 = slotAtX(x, pl);
      flowEnvDrawAt(s0, y, pl, null);
      flowEnvPtr = { mode: 'draw', lastSlot: s0 };
      return;
    }
    if (flowEnvMode === 'delete') {
      const hit = hitTestEnv(x, y, pl);
      if (hit.type === 'envbound') flowEnvMutate(() => { envDeleteAt(Math.max(0, hit.idx - 1)); });
      return;
    }
    if (flowEnvMode === 'line') {
      const i = flowEnvSegIndexAtX(x, pl);
      if (i >= 0) { flowEnvSegFrom = i; flowEnvSegTo = i + 1; }
      return;
    }
    // Point mode: grab a boundary (double-tap deletes), or split to add a point.
    const hit = hitTestEnv(x, y, pl);
    const bidx = hit.type === 'envbound' ? hit.idx : flowEnvHitBoundary(x, y, pl);
    if (bidx >= 0) {
      if (flowEnvLastTap && flowEnvLastTap.idx === bidx && performance.now() - flowEnvLastTap.t < 400 && Math.hypot(x - flowEnvLastTap.x, y - flowEnvLastTap.y) < 26) {
        flowEnvMutate(() => { envDeleteAt(Math.max(0, bidx - 1)); });
        flowEnvLastTap = null;
        return;
      }
      flowEnvLastTap = { t: performance.now(), x, y, idx: bidx };
      flowEnvPtr = { mode: 'bound', idx: bidx, x0: x, y0: y };
      return;
    }
    if (hit.type === 'envline' || hit.type === 'empty') {
      // Only split when the tap is actually inside the plot — a tap past the
      // left/right border (where the end dots sit) is never a new point.
      if (x < pl.left - 4 || x > pl.right + 4) return;
      const eb = envBoundaries();
      flowEnvMutate(() => { envSplitAtTime(clamp01(xToT(x, pl)) * eb.total); });
    }
  }
}

function flowEnvHandleMove(x, y) {
  if (!flowEnvPtr) return;
  const p = flowEnvPanel();
  const pl = flowEnvPlot(p);
  if (flowEnvPtr.mode === 'bound') {
    flowEnvMutate(() => { envDragBoundary(flowEnvPtr.idx, xToT(x, pl), yToV(y, pl) - envTrim(ENVELOPE)); });
  } else if (flowEnvPtr.mode === 'draw') {
    const s = slotAtX(x, pl);
    flowEnvDrawAt(s, y, pl, flowEnvPtr.lastSlot);
    flowEnvPtr.lastSlot = s;
  } else if (flowEnvPtr.mode === 'trim') {
    flowEnvApplyTrimFromY(flowEnvTrimSlider(p), y);
  } else if (flowEnvPtr.mode === 'segparam') {
    const R = flowEnvSegCard(p);
    const g = R.params.find(r => r.key === flowEnvPtr.key);
    if (g) flowEnvSetSegParam(flowEnvPtr.key, flowEnvSegParamFromX(g, x));
  }
}

function flowEnvHandleUp() {
  flowEnvPtr = null;
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
function flowWaveCloseRect(p) { return flowEnvCloseRect(p); }
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
  const cl = flowWaveCloseRect(p);
  ctx.beginPath();
  ctx.arc(cl.x + cl.w / 2, cl.y + cl.h / 2, 14, 0, Math.PI * 2);
  ctx.fillStyle = '#333333';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('✕', cl.x + cl.w / 2, cl.y + cl.h / 2 + 5);
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
  const cl = flowWaveCloseRect(p);
  if (x >= cl.x && x <= cl.x + cl.w && y >= cl.y && y <= cl.y + cl.h) { closeFlowWaveEditor(); return; }
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
function flowUnisonCloseRect(p) { return flowEnvCloseRect(p); }
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
  const cl = flowUnisonCloseRect(p);
  ctx.beginPath();
  ctx.arc(cl.x + cl.w / 2, cl.y + cl.h / 2, 13, 0, Math.PI * 2);
  ctx.fillStyle = '#333333';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('✕', cl.x + cl.w / 2, cl.y + cl.h / 2 + 4);
  // Interval preset chips (semitones for the single voice).
  for (const ic of flowUnisonIntervals(p)) {
    const on = v && Math.round(+v.st || 0) === ic.st;
    drawRoundRect(ic.x, ic.y, ic.w, ic.h, 7);
    ctx.fillStyle = on ? FLOW_UNISON_ACCENT : '#222222';
    ctx.fill();
    ctx.strokeStyle = on ? FLOW_UNISON_ACCENT : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = on ? 1.5 : 1;
    ctx.stroke();
    ctx.fillStyle = on ? '#000000' : '#ffffff';
    ctx.font = '800 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ic.label, ic.x + ic.w / 2, ic.y + ic.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  // Parameter faders (st/ct/vol).
  for (const f of flowUnisonFaders(p)) {
    const active = !!v;
    const cur = v ? (+v[f.key] != null ? +v[f.key] : (f.key === 'vol' ? 1 : 0)) : (f.key === 'vol' ? 1 : 0);
    ctx.globalAlpha = active ? 1 : 0.35;
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
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(f.fmt(cur), f.valX, f.cy + 4);
    for (const side of ['btnMinus', 'btnPlus']) {
      const bx = f[side];
      drawRoundRect(bx.x, bx.y, bx.w, bx.h, 6);
      ctx.fillStyle = '#333333';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
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
  const cl = flowUnisonCloseRect(p);
  if (x >= cl.x && x <= cl.x + cl.w && y >= cl.y && y <= cl.y + cl.h) { closeFlowUnisonEditor(); return; }
  // Interval preset chips (semitone jumps for the single voice).
  const v = flowUnisonSelectedVoice();
  if (v) {
    for (const ic of flowUnisonIntervals(p)) {
      if (x >= ic.x && x <= ic.x + ic.w && y >= ic.y && y <= ic.y + ic.h) {
        flowUnisonMutate(() => { v.st = ic.st; });
        return;
      }
    }
  }
  // Faders: nudge buttons, then the track (drag).
  for (const f of flowUnisonFaders(p)) {
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
  if (f) flowUnisonSetParam(f, x);
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
var flowCurvePtr = null;      // { mode: 'point'|'draw', idx?, lastX? } active drag
var flowCurveLastTap = null;  // double-tap-to-delete on a curve dot
var flowCurveMode = 'point';  // 'point' | 'draw' | 'delete'

function flowCurvePanel() { return flowEnvPanel(); }
function flowCurvePlot(p) { return flowEnvPlot(p); }
function flowCurveCloseRect(p) { return flowEnvCloseRect(p); }
function flowCurveClearPill(p) { return flowEnvClearPill(p); }
function flowCurveToolbar(p) {
  const modes = [['point', 'Point'], ['draw', 'Draw'], ['delete', 'Delete']];
  const w = 54, gap = 6, h = 26, y = p.y + 48, x0 = p.x + 16;
  return modes.map((m, i) => ({ mode: m[0], label: m[1], x: x0 + i * (w + gap), y, w, h }));
}
function flowCurvePointsOf(node) {
  const n = flowNodeById(node);
  if (!n) return null;
  if (!n.env || !Array.isArray(n.env.points) || n.env.points.length < 2) n.env = defaultEnvCurve();
  return n.env.points;
}
function flowCurveInsert(points, t, v) {
  t = clamp01(t); v = Math.max(-1, Math.min(1, v));
  for (let i = 0; i < points.length; i++) {
    if (Math.abs(points[i].t - t) < 0.01) { points[i].v = v; return i; }
  }
  if (points.length >= 64) return -1;
  points.push({ t, v });
  points.sort((a, b) => a.t - b.t);
  return points.findIndex(pt => pt.t === t && pt.v === v);
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
function hitTestCurveDot(x, y, pl, points) {
  let best = -1, bd = Infinity;
  for (let j = 0; j < points.length; j++) {
    const d = Math.hypot(x - tToX(points[j].t, pl), y - ampToY(points[j].v, pl));
    if (d < bd) { bd = d; best = j; }
  }
  return bd <= 24 ? best : -1;
}
function openFlowCurveEditor(id) {
  const n = flowNodeById(id);
  if (!n || n.type !== 'env') return;
  if (!n.env || !Array.isArray(n.env.points) || n.env.points.length < 2) n.env = defaultEnvCurve();
  flowCurveEdit = id;
  flowCurveDirty = false;
  flowCurvePtr = null;
  flowCurveLastTap = null;
  flowCurveMode = 'point';
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
  flowCurveLastTap = null;
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
  const cl = flowCurveCloseRect(p);
  ctx.beginPath();
  ctx.arc(cl.x + cl.w / 2, cl.y + cl.h / 2, 14, 0, Math.PI * 2);
  ctx.fillStyle = '#333333';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('✕', cl.x + cl.w / 2, cl.y + cl.h / 2 + 5);
  // Mode toolbar.
  for (const b of flowCurveToolbar(p)) {
    const active = flowCurveMode === b.mode;
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
  // Curve + dots (extend the clamped ends to the plot edges).
  ctx.strokeStyle = '#8dd3ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(tToX(0, pl), ampToY(specValueAtCurve(points, 0), pl));
  for (let j = 0; j < points.length; j++) ctx.lineTo(tToX(points[j].t, pl), ampToY(points[j].v, pl));
  ctx.lineTo(tToX(1, pl), ampToY(specValueAtCurve(points, 1), pl));
  ctx.stroke();
  for (const pt of points) {
    ctx.fillStyle = '#8dd3ff';
    ctx.beginPath();
    ctx.arc(tToX(pt.t, pl), ampToY(pt.v, pl), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Hint.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '700 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(flowCurveMode === 'draw'
    ? 'Draw · drag across the plot to scribble the curve · tap Point to edit dots'
    : flowCurveMode === 'delete'
    ? 'Delete · tap a dot to remove it'
    : 'Point · tap to add a point · drag a dot to move · double-tap a dot to delete · above 0 adds, below ducks', p.x + p.w / 2, p.y + p.h - 8);
}
// Curve value at t (linear between breakpoints, ends clamp) — like specValueAt
// but with {t,v} points and a ±1 axis.
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
      return clampSign(a.v + (b.v - a.v) * f);
    }
  }
  return clampSign(hi.v);
}
function flowCurveHandleDown(x, y) {
  const p = flowCurvePanel();
  const pl = flowCurvePlot(p);
  if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) { closeFlowCurveEditor(); return; }
  const cl = flowCurveCloseRect(p);
  if (x >= cl.x && x <= cl.x + cl.w && y >= cl.y && y <= cl.y + cl.h) { closeFlowCurveEditor(); return; }
  for (const b of flowCurveToolbar(p)) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      flowCurveMode = b.mode;
      flowCurvePtr = null;
      return;
    }
  }
  const cp = flowCurveClearPill(p);
  if (x >= cp.x && x <= cp.x + cp.w && y >= cp.y && y <= cp.y + cp.h) {
    flowCurveMutate(() => {
      const pts = flowCurvePointsOf(flowCurveEdit);
      pts.length = 0;
      pts.push({ t: 0, v: 0 }, { t: 1, v: 0 });
    });
    return;
  }
  if (y < pl.top || y > pl.bottom) return;
  const pts = flowCurvePointsOf(flowCurveEdit);
  if (flowCurveMode === 'delete') {
    const idx = hitTestCurveDot(x, y, pl, pts);
    if (idx >= 0) flowCurveMutate(() => { flowCurveRemove(pts, idx); });
    return;
  }
  if (flowCurveMode === 'draw') {
    flowCurveMutate(() => { flowCurveInsert(pts, xToT(x, pl), yToAmp(y, pl)); });
    flowCurvePtr = { mode: 'draw', lastX: xToT(x, pl) };
    return;
  }
  // Point mode: grab a dot (double-tap deletes), or add a point and drag it.
  const idx = hitTestCurveDot(x, y, pl, pts);
  if (idx >= 0) {
    if (flowCurveLastTap && flowCurveLastTap.idx === idx && performance.now() - flowCurveLastTap.t < 400 && Math.hypot(x - flowCurveLastTap.x, y - flowCurveLastTap.y) < 26) {
      flowCurveMutate(() => { flowCurveRemove(pts, idx); });
      flowCurveLastTap = null;
      return;
    }
    flowCurveLastTap = { t: performance.now(), x, y, idx };
    flowCurvePtr = { mode: 'point', idx, x0: x, y0: y };
    return;
  }
  const ni = flowCurveMutate(() => {
    // Don't add a point from a tap outside the plot (the end dots sit right on
    // the border — a finger past it should do nothing, not add an edge point).
    if (x < pl.left - 4 || x > pl.right + 4) return -1;
    return flowCurveInsert(pts, xToT(x, pl), yToAmp(y, pl));
  });
  if (ni >= 0) flowCurvePtr = { mode: 'point', idx: ni, x0: x, y0: y };
}
function flowCurveHandleMove(x, y) {
  if (!flowCurvePtr) return;
  const p = flowCurvePanel();
  const pl = flowCurvePlot(p);
  if (flowCurvePtr.mode === 'point') {
    const pts = flowCurvePointsOf(flowCurveEdit);
    const pt = pts[flowCurvePtr.idx];
    if (pt) {
      flowCurveMutate(() => {
        pt.t = clamp01(xToT(x, pl));
        pt.v = clampSign(yToAmp(y, pl));
        pts.sort((a, b) => a.t - b.t);
        flowCurvePtr.idx = pts.indexOf(pt);
      });
    }
  } else if (flowCurvePtr.mode === 'draw') {
    const xf = xToT(x, pl);
    if (Math.abs(xf - flowCurvePtr.lastX) > 0.01) {
      flowCurveMutate(() => { flowCurveInsert(flowCurvePointsOf(flowCurveEdit), xf, yToAmp(y, pl)); });
      flowCurvePtr.lastX = xf;
    }
  }
}
function flowCurveHandleUp() {
  flowCurvePtr = null;
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
    // Mix envelope: an env curve v ∈ −1..1 maps to a mix weight 0..1 (0 = full).
    const mixId = note.conn.mixEnvs[i];
    const mix = mixId ? flowNodeById(mixId) : null;
    if (mix && mix.type === 'env' && mix.env && Array.isArray(mix.env.points) && mix.env.points.length >= 2) {
      layer.curve = mix.env.points.map(pt => ({ t: clamp01(pt.t), v: clamp01(1 + (+pt.v || 0)) }));
    } else {
      layer.curve = [{ t: 0, v: 1 }, { t: 1, v: 1 }];
    }
    // Unison: static voices + optional vol/st/ct animation envs (per-voice).
    const uniId = w.conn && w.conn.unison;
    const uni = uniId ? flowNodeById(uniId) : null;
    if (uni && uni.type === 'unison' && Array.isArray(uni.voices) && uni.voices.length) {
      layer.voices = voicesFromSavedFlow(uni.voices);
      const uEnvs = compileUnisonEnvs(uni);
      if (uEnvs) for (const v of layer.voices) v.envs = uEnvs;
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
    return {
      range,
      points: n.env.points.map(pt => ({
        t: clamp01(pt.t),
        v: Math.max(-range, Math.min(range, neutral + (+pt.v || 0) * scale)),
      })),
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

/* ---- Pointer handling (active only in flow mode) ---- */
canvas.addEventListener('pointerdown', e => {
  if (!flowActive) return;
  const x = stageX(e), y = stageY(e);
  // When an editor dismisses itself on this tap (outside panel or ✕), fall
  // through so the tap also acts on whatever is underneath (ports / nodes /
  // grid). If it handled the tap internally, it stays open and we stop here.
  if (flowNoteEdit) { flowNoteHandleDown(x, y); if (flowNoteEdit) return; }
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
  // On-node connection ports (arm / cancel / clear). Drawn on top of the modal
  // and the add menu, so they hit before those.
  const portHit = hitFlowPort(x, y);
  if (portHit) {
    const pn = portHit.node, pt = portHit.pt;
    flowAddMenu = null;
    flowPanAnim = null;
    if (portHit.clear) {
      flowPushHistory();
      connSlotSet(pn, pt.slot, null);
      saveFlow();
      return;
    }
    const k = slotKey(pt.slot);
    if (flowConnArm && flowConnArm.nodeId === pn.id && slotKey(flowConnArm.slot) === k) flowConnArm = null;
    else flowConnArm = { nodeId: pn.id, slot: pt.slot };
    return;
  }
  // Add-node menu option (create the node).
  const opt = hitAddMenu(x, y);
  if (opt) { addFlowNode(opt.type); return; }
  // Grid: start a pan (a small movement counts as a tap on release). Pressing
  // on a node arms a long-press move/delete hold; pressing empty space arms a
  // long-press add-menu hold.
  flowAddMenu = null;
  flowInertia = null;
  flowPanAnim = null;
  const wx = x + flowCam.x, wy = y + flowCam.y;
  const node = flowNodeAt(wx, wy);
  flowPtr = { kind: 'grid', x, y, startX: x, startY: y, lastT: e.timeStamp, vx: 0, vy: 0, moved: false };
  if (node) flowHold = { id: node.id, kind: 'move', t0: performance.now(), stage: 0 };
  else flowHold = { id: null, kind: 'add', x: wx, y: wy, t0: performance.now(), stage: 0 };
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
  if (flowNoteEdit) { flowNoteHandleUp(); return; }
  if (flowEnvEdit) { flowEnvHandleUp(); return; }
  if (flowWaveEdit) { flowWaveHandleUp(); return; }
  if (flowUnisonEdit) { flowUnisonHandleUp(); return; }
  if (flowCurveEdit) { flowCurveHandleUp(); return; }
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
    // A note widget's ▶ play button is always live: tapping it previews the
    // sound instead of entering edit mode.
    if (node.type === 'note') {
      const wr = flowWidgetRect(node, false);
      const pb = flowNoteWidgetPlay(wr);
      if (tapX >= pb.x && tapX <= pb.x + pb.w && tapY >= pb.y && tapY <= pb.y + pb.h) {
        playFlowNote(node);
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
  }
});

canvas.addEventListener('pointercancel', () => {
  flowEnvPtr = null;
  flowWavePtr = null;
  flowUnisonDrag = null;
  flowPtr = null;
  flowInertia = null;
  flowPanAnim = null;
  flowHold = null;
  flowSepAnim = null;
});

function flowLoop(now) {
  if (flowActive) {
    // Long-press hold: move mode on a node (stage 1), then a longer hold on the
    // same node becomes a delete countdown (stage 2); holding empty space opens
    // the add menu.
    if (flowHold) {
      const el = performance.now() - flowHold.t0;
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