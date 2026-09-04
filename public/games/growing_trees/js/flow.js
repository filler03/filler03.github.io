/* ============================================================
   flow.js — full-screen sound flow editor. A black scene with a
   pannable grid of squares (each shows its x,y position) for
   arranging sound nodes into a playable graph, opened from the
   main screen's bottom-right button.

   Node types: Note (🎵, the entry point — aggregates a required
   Volume envelope + up to 3 Waves, each with an optional mix Env),
   Volume (📉, the ADSR envelope with HOLD/CUT/REL markers), Env
   (📈, a kind-agnostic neutral curve), Wave (🌊, harmonic
   spectrum), and Unison (🦄, one additional voice with optional
   vol/st/ct animation envelopes).

   Connections are consumer-owned slots assigned from the right
   drawer (tap a pill to arm it, tap a node on the grid to
   connect); wires render as colored beziers. A note's ▶ Play
   compiles the graph into the legacy audio globals and previews
   the sound.
   ============================================================ */

const flowBtn = document.getElementById('flowBtn');
const FLOW_BAR_H = 88;          // height of the bottom node-palette bar
const FLOW_CELL = 72;           // grid square size (px)
const FLOW_BACK_R = 22;         // back-button radius
const FLOW_TAP_MAX = 10;        // px of movement before a touch counts as a pan
const FLOW_PANEL_W = 180;       // right-side attribute panel width
const FLOW_CHIP_W = 78;         // bottom-bar node chip width
const FLOW_CHIP_H = 46;         // bottom-bar node chip height
const FLOW_CHIP_GAP = 8;        // gap between bottom-bar chips
const FLOW_BAR_EDGE = 16;       // left padding inside the bottom bar
const FLOW_DOUBLE_TAP_MS = 400; // window for a double-tap on a chip
const FLOW_HOLD_MOVE = 500;     // ms of a still hold before the node enters move mode (flash)
const FLOW_UNDO_W = 78;         // undo button width (bottom bar, left of the back button)
const FLOW_UNDO_H = 40;         // undo button height
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

var flowNodes = [];             // [{ id, gx, gy, type, noteLife }] placed sound nodes
var flowSelId = null;           // id of the selected node (attribute panel shown for it)
var flowAddMenu = null;         // { gx, gy } open add-node menu anchor, or null
var flowBarScrollX = 0;         // horizontal scroll offset of the bottom-bar chip strip
var flowLastChipTap = null;     // { id, t } last bottom-bar chip tap (double-tap detection)
var flowLastGridTap = null;     // { id, t } last grid-node tap (double-tap detection)
var flowPanAnim = null;         // { x0, y0, x1, y1, t0 } animated pan to a node's cell
var flowHold = null;            // { id, kind, t0, stage } active long-press hold, or null
var flowMoveId = null;          // id of the node in move mode (slowly flashing), or null
var flowConnArm = null;         // { nodeId, slot } armed connection slot awaiting a grid tap, or null
var flowHistory = [];           // undo stack: [{ nodes }] snapshots taken before each action

const FLOW_SAVE_KEY = 'growingTrees.flow.v1';

// The grid area: everything above the bottom bar.
function flowGridArea() {
  return { top: 0, bottom: H - FLOW_BAR_H, left: 0, right: W };
}
// Back button rect (bottom-right, inside the bar).
function flowBackRect() {
  const d = FLOW_BACK_R * 2;
  const x = W - 16 - d;
  const y = H - FLOW_BAR_H + (FLOW_BAR_H - d) / 2;
  return { x, y, d };
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
function flowNodeAt(gx, gy) {
  return flowNodes.find(n => n.gx === gx && n.gy === gy);
}
// The attribute-panel rect (docked on the right, above the bottom bar).
function flowPanelRect() {
  return { x: W - 16 - FLOW_PANEL_W, y: 16, w: FLOW_PANEL_W, h: H - FLOW_BAR_H - 32 };
}
function flowPanelCloseRect(panel) {
  return { x: panel.x + panel.w - 34, y: panel.y + 7, w: 26, h: 26 };
}
function flowPanelEnvBtnRect(panel) {
  const w = panel.w - 28;
  return { x: panel.x + 14, y: panel.y + 54, w, h: 40 };
}
// The add-menu option buttons, laid out around the anchored cell (clamped to
// stay inside the grid area). One per node type for now.
function flowAddMenuOptions() {
  const p = flowCellScreen(flowAddMenu.gx, flowAddMenu.gy);
  const keys = Object.keys(FLOW_NODE_TYPES);
  const gap = 12;
  const totalW = keys.length * 48 + (keys.length - 1) * gap;
  const cx0 = Math.max(48, Math.min(W - 48, p.x + FLOW_CELL / 2));
  const cy = Math.max(30, Math.min(H - FLOW_BAR_H - 30, p.y - 40));
  return keys.map((type, i) => {
    const x = cx0 - totalW / 2 + i * (48 + gap) + 24;
    return { type, cx: x, cy, r: 24, emoji: FLOW_NODE_TYPES[type].emoji, label: FLOW_NODE_TYPES[type].label };
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
// The connection slots a node exposes, in drawer order. Each row carries its
// pills (usually one; the note's wave rows carry a second pill for the mix env).
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

// Create a node of `type` in the cell that owns the open add menu, select it,
// and persist.
function addFlowNode(type) {
  if (!flowAddMenu || !FLOW_NODE_TYPES[type]) return;
  flowPushHistory();
  const id = 'node-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
  const n = { id, gx: flowAddMenu.gx, gy: flowAddMenu.gy, type, inBar: true };
  if (type === 'note') n.noteLife = 2500;
  else if (type === 'volumeEnv') n.envelope = clone(DEFAULT_ENVELOPE);
  else if (type === 'env') n.env = defaultEnvCurve();
  else if (type === 'wave') n.wave = defaultWaveSpec();
  else if (type === 'unison') n.voices = defaultUnisonVoices();
  n.conn = defaultConn(type);
  flowNodes.push(n);
  flowAddMenu = null;
  flowSelId = id;
  saveFlow();
}

/* ---- Undo ----
   Snapshot-based: every mutating action pushes the state BEFORE it onto the
   stack; Undo pops the most recent snapshot and restores it. Future node
   actions just need to call flowPushHistory() before they mutate flowNodes. */
function flowUndoRect() {
  const bx = W - 16 - FLOW_BACK_R;                     // back-button center
  const x = bx - FLOW_BACK_R - 10 - FLOW_UNDO_W;       // just left of the back button
  const y = H - FLOW_BAR_H + (FLOW_BAR_H - FLOW_UNDO_H) / 2;
  return { x, y, w: FLOW_UNDO_W, h: FLOW_UNDO_H };
}
// Where the bottom-bar chip strip ends (clear of the undo + back buttons).
function flowBarRightLimit() {
  return flowUndoRect().x - 8;
}
function flowPushHistory(base) {
  const state = base || clone(flowNodes);
  const top = flowHistory[flowHistory.length - 1];
  if (top && JSON.stringify(top.nodes) === JSON.stringify(state)) return;   // no-op snapshots
  flowHistory.push({ nodes: state });
  if (flowHistory.length > FLOW_HISTORY_MAX) flowHistory.shift();
}
function undoFlow() {
  const entry = flowHistory.pop();
  if (!entry) return;
  // An open overlay editor mutates node data on close (wave/unison write their
  // proxy back into the node), so close it first — the undo below then restores
  // the pre-edit snapshot the overlay pushed when it first changed something.
  if (flowEnvEdit) closeFlowEnvelopeEditor();
  if (flowWaveEdit) closeFlowWaveEditor();
  if (flowUnisonEdit) closeFlowUnisonEditor();
  if (flowCurveEdit) closeFlowCurveEditor();
  flowNodes = clone(entry.nodes);
  if (flowSelId && !flowNodeById(flowSelId)) flowSelId = null;
  if (flowMoveId && !flowNodeById(flowMoveId)) flowMoveId = null;
  flowAddMenu = null;
  saveFlow();
}

/* ---- Bottom-bar node tray ----
   Every placed node gets a chip in the bottom bar (emoji + its x,y position).
   The selected node's chip is highlighted, like its cell on the grid. The chip
   strip scrolls horizontally when it overflows. */
function flowBarChips() {
  const list = flowNodes.filter(n => n.inBar !== false);
  const n = list.length;
  const y = H - FLOW_BAR_H + (FLOW_BAR_H - FLOW_CHIP_H) / 2;
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({ node: list[i], x: FLOW_BAR_EDGE - flowBarScrollX + i * (FLOW_CHIP_W + FLOW_CHIP_GAP), y, w: FLOW_CHIP_W, h: FLOW_CHIP_H });
  }
  return arr;
}
function flowBarMaxScroll() {
  const n = flowNodes.filter(x => x.inBar !== false).length;
  if (!n) return 0;
  const stripW = FLOW_BAR_EDGE + n * (FLOW_CHIP_W + FLOW_CHIP_GAP) - FLOW_CHIP_GAP;
  return Math.max(0, stripW - (flowBarRightLimit() - FLOW_BAR_EDGE));
}
function hitBarChip(x, y) {
  if (y < H - FLOW_BAR_H || x >= flowBarRightLimit()) return null;
  const yc = H - FLOW_BAR_H + (FLOW_BAR_H - FLOW_CHIP_H) / 2;
  if (y < yc || y > yc + FLOW_CHIP_H) return null;
  for (const c of flowBarChips()) {
    if (x >= c.x && x <= c.x + c.w) return c;
  }
  return null;
}
// Center the camera on a node's cell with a short eased pan.
function panToNode(node) {
  flowInertia = null;
  flowPanAnim = {
    x0: flowCam.x, y0: flowCam.y,
    x1: node.gx * FLOW_CELL - W / 2 + FLOW_CELL / 2,
    y1: node.gy * FLOW_CELL - (H - FLOW_BAR_H) / 2 + FLOW_CELL / 2,
    t0: performance.now(),
  };
}
// A tap on a bottom-bar chip: single tap toggles selection (opens/closes the
// attribute drawer); a double-tap recenters the grid on that node instead.
function handleChipTap(node) {
  const now = performance.now();
  if (flowLastChipTap && flowLastChipTap.id === node.id && now - flowLastChipTap.t < FLOW_DOUBLE_TAP_MS) {
    flowLastChipTap = null;
    flowSelId = node.id;
    flowAddMenu = null;
    panToNode(node);
    saveFlow();
    return;
  }
  flowLastChipTap = { id: node.id, t: now };
  if (flowSelId === node.id) {
    flowSelId = null;   // deselect: closes the attribute drawer
  } else {
    flowSelId = node.id;
    flowAddMenu = null;
  }
  saveFlow();
}

/* ---- Long-press: move mode ----
   Holding a node (on the bar or on the grid) still for FLOW_HOLD_MOVE ms puts
   it into move mode — it flashes slowly. The next tap on an empty grid cell
   moves the node there. Deleting a node is only available in the right-side
   attribute drawer; removing a chip from the bar uses its ✕ badge. */
function deleteFlowNode(id) {
  flowPushHistory();
  flowDetachNode(id);          // clear every slot pointing at this node
  flowNodes = flowNodes.filter(n => n.id !== id);
  if (flowSelId === id) flowSelId = null;
  if (flowMoveId === id) flowMoveId = null;
  flowAddMenu = null;
  saveFlow();
}
function moveFlowNodeTo(id, gx, gy) {
  const n = flowNodeById(id);
  if (!n) return;
  flowPushHistory();
  n.gx = gx; n.gy = gy;
  flowMoveId = null;
  saveFlow();
}
// Slowly-pulsing alpha for the node currently in move mode.
function flowFlashAlpha() {
  const p = 0.5 + 0.5 * Math.sin(performance.now() / 300);
  return 0.35 + 0.65 * p;
}
// Remove a node's chip from the bottom bar (the node itself stays on the grid;
// double-tap it there to bring the chip back). Undoable.
function removeNodeFromBar(id) {
  const n = flowNodeById(id);
  if (!n || n.inBar === false) return;
  flowPushHistory();
  n.inBar = false;
  saveFlow();
}
// The ✕ badge underneath a bottom-bar chip (hit test).
function chipCloseRect(c) {
  return { cx: c.x + c.w - 12, cy: c.y + c.h + 6, r: 10 };
}
function hitChipClose(x, y) {
  for (const c of flowBarChips()) {
    const r = chipCloseRect(c);
    if (Math.hypot(x - r.cx, y - r.cy) <= r.r) return c.node;
  }
  return null;
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
      if (!n || typeof n.gx !== 'number' || typeof n.gy !== 'number' || typeof n.type !== 'string') continue;
      // The old envelope node type became the volume envelope.
      const type = n.type === 'envelope' ? 'volumeEnv' : n.type;
      const node = {
        id: typeof n.id === 'string' ? n.id : 'node-' + Math.random().toString(36).slice(2),
        gx: Math.round(n.gx), gy: Math.round(n.gy),
        type: FLOW_NODE_TYPES[type] ? type : 'note',
        noteLife: Math.max(FLOW_NOTE_LIFE_MIN, Math.min(FLOW_NOTE_LIFE_MAX, Math.round(+n.noteLife) || 2500)),
        inBar: n.inBar !== false,
      };
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
  if (flowEnvEdit) closeFlowEnvelopeEditor();
  if (flowWaveEdit) closeFlowWaveEditor();
  if (flowUnisonEdit) closeFlowUnisonEditor();
  if (flowCurveEdit) closeFlowCurveEditor();
  flowPtr = null;
  flowInertia = null;
  flowAddMenu = null;
  flowConnArm = null;
  flowPanAnim = null;
  flowLastChipTap = null;
  flowLastGridTap = null;
  flowHold = null;
  flowMoveId = null;
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

/* ---- Connection drawer (right-side panel slots) ----
   Each node type lays its connection slots out as compact rows with value
   pills. A row carries one pill (vol env / mix env / unison / env slots) or two
   (a note's wave row: the wave + its mix env). Tapping an empty or filled pill
   arms it; tapping it again cancels; the ✕ inside a filled pill clears it.
   While armed, tapping a valid node on the grid assigns it. */
function flowDrawerPlayRect(panel) {
  return { x: panel.x + 14, y: panel.y + 36, w: panel.w - 28, h: 26 };
}
// Connection-slot rows for a node, positioned inside its drawer.
function flowConnRows(node, panel) {
  const yTop = node.type === 'note' ? panel.y + 66 : node.type === 'wave' ? panel.y + 102 : panel.y + 98;
  const rowH = node.type === 'note' ? 24 : node.type === 'unison' ? 20 : 26;
  const out = [];
  flowSlotRows(node).forEach((r, i) => {
    const y = yTop + i * rowH, h = rowH;
    const labelW = r.label.length <= 4 ? 46 : (r.label.length <= 6 ? 56 : 62);
    const avail = panel.w - 28 - labelW - 6;
    const two = !!r.pill2;
    const pillW = two ? Math.floor((avail - 8) / 2) : avail;
    let px = panel.x + 14 + labelW + 6;
    const pills = [];
    const mk = (slot, req) => {
      const filled = !!connSlotGet(node, slot);
      return { slot, rect: { x: px, y: y, w: pillW, h }, filled, req: req && !filled };
    };
    pills.push(mk(r.slot, r.req));
    px += pillW + 8;
    if (two) pills.push(mk(r.pill2, false));
    out.push({ slot: r.slot, pill2: r.pill2, label: r.label, req: r.req, y, h, pills });
  });
  return out;
}
function flowConnPillHit(x, y, row, pillRect) {
  if (x < pillRect.x || x > pillRect.x + pillRect.w || y < pillRect.y || y > pillRect.y + pillRect.h) return false;
  return true;
}
// The Y just below a node's drawer content (where the Delete button sits).
function flowDrawerEndY(node, panel) {
  const rows = flowSlotRows(node).length;
  if (node.type === 'note') return panel.y + 66 + rows * 24;
  if (node.type === 'wave') return panel.y + 102 + rows * 26;
  if (node.type === 'unison') return panel.y + 98 + rows * 20;
  return panel.y + 94;   // volumeEnv / env: right below the edit button
}
function flowDrawerDeleteRect(node, panel) {
  return { x: panel.x + 14, y: flowDrawerEndY(node, panel) + 6, w: panel.w - 28, h: 26 };
}
// Hit-test the whole drawer (play button + slots + per-node extras). Returns
// { kind:'arm', slot } | { kind:'clear', slot } | { kind:'cancel' } | { kind:'play' } | null.
function flowHitDrawer(x, y, panel, node) {
  if (node.type === 'note') {
    const p = flowDrawerPlayRect(panel);
    if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return { kind: 'play' };
  }
  for (const row of flowConnRows(node, panel)) {
    for (const pill of row.pills) {
      if (!flowConnPillHit(x, y, row, pill.rect)) continue;
      const k = slotKey(pill.slot);
      const armed = flowConnArm && flowConnArm.nodeId === node.id && slotKey(flowConnArm.slot) === k;
      if (armed) return { kind: 'cancel' };
      if (pill.filled && x >= pill.rect.x + pill.rect.w - 18) return { kind: 'clear', slot: pill.slot };
      return { kind: 'arm', slot: pill.slot };
    }
  }
  if (node.type === 'unison') {
    const vc = flowUnisonMiniChips(panel);
    for (const c of vc) {
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) {
        if (c.edit) return { kind: 'uned' };
        return { kind: 'vsel', i: c.i };
      }
    }
    const ic = flowUnisonMiniIntervals(panel);
    if (flowUnisonSelectedOf(node)) {
      for (const b of ic) {
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { kind: 'interval', st: b.st };
      }
    }
  }
  return null;
}
// The draw part of the drawer (slots + note play + unison compact voices).
function drawFlowDrawer(node, panel) {
  // Connection slot rows.
  for (const row of flowConnRows(node, panel)) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '700 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(row.label, panel.x + 14, row.y + row.h / 2);
    for (const pill of row.pills) {
      drawFlowConnPill(node, panel, row, pill);
    }
  }
  // Note: play button on top.
  if (node.type === 'note') {
    const ready = flowNoteReady(node);
    const p = flowDrawerPlayRect(panel);
    drawRoundRect(p.x, p.y, p.w, p.h, 9);
    ctx.fillStyle = ready ? '#1b8a4a' : '#2b2b2b';
    ctx.fill();
    ctx.strokeStyle = ready ? '#1b8a4a' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = ready ? '#ffffff' : 'rgba(255,255,255,0.4)';
    ctx.font = '800 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ready ? '▶ Play sound' : '▶ Needs volume + wave', p.x + p.w / 2, p.y + p.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  // Unison: compact single-voice chip + interval chips + readout (above the slots).
  if (node.type === 'unison') drawFlowUnisonMini(node, panel);
}
function drawFlowConnPill(node, panel, row, pill) {
  const r = pill.rect;
  const k = slotKey(pill.slot);
  const armed = flowConnArm && flowConnArm.nodeId === node.id && slotKey(flowConnArm.slot) === k;
  drawRoundRect(r.x, r.y, r.w, r.h, 8);
  ctx.fillStyle = armed ? '#3a3f52' : 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.strokeStyle = armed ? FLOW_UNISON_ACCENT : (pill.req) ? '#e06060' : 'rgba(255,255,255,0.4)';
  ctx.lineWidth = armed || pill.req ? 1.5 : 1;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (pill.filled && !armed) {
    const src = flowNodeById(connSlotGet(node, pill.slot));
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#ffffff';
    if (src) ctx.fillText(FLOW_NODE_TYPES[src.type].emoji, r.x + r.w / 2 - 5, r.y + r.h / 2 + 1);
    // ✕ clear (right edge).
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '800 11px sans-serif';
    ctx.fillText('✕', r.x + r.w - 10, r.y + r.h / 2 + 1);
  } else if (armed) {
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 10px sans-serif';
    ctx.fillText('…', r.x + r.w / 2, r.y + r.h / 2 + 1);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '800 11px sans-serif';
    ctx.fillText('✕', r.x + r.w - 10, r.y + r.h / 2 + 1);
  } else {
    ctx.fillStyle = pill.req ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.45)';
    ctx.font = '800 13px sans-serif';
    ctx.fillText('＋', r.x + r.w / 2, r.y + r.h / 2 + 1);
  }
  ctx.textBaseline = 'alphabetic';
}

/* ---- Unison compact voices (right drawer) ----
   A unison node is exactly one additional voice: a single V1 chip + an ✎ that
   opens the full overlay, the legacy interval chips (they set the voice's
   semitones), and a one-line readout of the voice's st/ct/vol. */
function flowUnisonSelectedOf(node) {
  const vs = (node && Array.isArray(node.voices)) ? node.voices : [];
  return (flowUnisonSel >= 0 && vs[flowUnisonSel]) ? vs[flowUnisonSel] : null;
}
function flowUnisonMiniChips(panel) {
  const n = flowNodeById(flowSelId);
  const vs = (n && Array.isArray(n.voices)) ? n.voices : [];
  const gap = 6;
  const chipW = Math.max(30, Math.min(40, (panel.w - 28 - 40 - (vs.length + 1) * gap) / Math.max(1, vs.length)));
  const y = panel.y + 44, h = 22;
  const arr = [];
  for (let i = 0; i < vs.length; i++) arr.push({ i, x: panel.x + 14 + i * (chipW + gap), y, w: chipW, h });
  arr.push({ edit: true, x: panel.x + 14 + vs.length * (chipW + gap), y, w: 34, h });
  return arr;
}
function flowUnisonMiniIntervals(panel) {
  const gap = 4;
  const w = Math.max(26, Math.min(34, (panel.w - 28 - (VOICE_INTERVALS.length - 1) * gap) / VOICE_INTERVALS.length));
  const y = panel.y + 70, h = 18;
  return VOICE_INTERVALS.map((iv, i) => ({ st: iv.st, label: iv.label, x: panel.x + 14 + i * (w + gap), y, w, h }));
}
function drawFlowUnisonMini(node, panel) {
  const vs = (node && Array.isArray(node.voices)) ? node.voices : [];
  const v = flowUnisonSelectedOf(node);
  // Voice chip strip (select + edit).
  for (const c of flowUnisonMiniChips(panel)) {
    if (c.edit) {
      drawRoundRect(c.x, c.y, c.w, c.h, 6);
      ctx.fillStyle = '#2b2b2b';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✎', c.x + c.w / 2, c.y + c.h / 2 + 1);
      ctx.textBaseline = 'alphabetic';
      continue;
    }
    const sel = c.i === flowUnisonSel;
    const vv = vs[c.i];
    const muted = !!(vv && vv.muted);
    drawRoundRect(c.x, c.y, c.w, c.h, 6);
    ctx.fillStyle = sel ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.strokeStyle = sel ? FLOW_UNISON_ACCENT : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = sel ? 1.5 : 1;
    ctx.stroke();
    ctx.fillStyle = muted ? 'rgba(255,255,255,0.5)' : '#ffffff';
    ctx.font = '800 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('V' + (c.i + 1), c.x + c.w / 2, c.y + c.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  // Interval chips (only when a voice is selected).
  if (v) {
    for (const b of flowUnisonMiniIntervals(panel)) {
      const on = Math.round(+v.st || 0) === b.st;
      drawRoundRect(b.x, b.y, b.w, b.h, 5);
      ctx.fillStyle = on ? FLOW_UNISON_ACCENT : '#222222';
      ctx.fill();
      ctx.strokeStyle = on ? FLOW_UNISON_ACCENT : 'rgba(255,255,255,0.4)';
      ctx.lineWidth = on ? 1.5 : 1;
      ctx.stroke();
      ctx.fillStyle = on ? '#000000' : '#ffffff';
      ctx.font = '800 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
      ctx.textBaseline = 'alphabetic';
    }
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('No voices — ✎ to edit', panel.x + 14, panel.y + 66);
    ctx.textBaseline = 'alphabetic';
  }
  // Readout.
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '700 10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (v) {
    ctx.fillText('V' + (flowUnisonSel + 1) + ' · ' + (Math.round((+v.st || 0) * 100) / 100) + ' st · ' + Math.round(+v.ct || 0) + ' ¢ · ' + Math.round((+v.vol || 1) * 100) + '%', panel.x + 14, panel.y + 92);
  } else {
    ctx.fillText('Add voices in the ✎ editor', panel.x + 14, panel.y + 92);
  }
  ctx.textBaseline = 'alphabetic';
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
        const a = flowCellScreen(src.gx, src.gy);
        const b = flowCellScreen(n.gx, n.gy);
        const ax = a.x + FLOW_CELL / 2, ay = a.y + FLOW_CELL / 2;
        const bx = b.x + FLOW_CELL / 2, by = b.y + FLOW_CELL / 2;
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

/* ---- Rendering ---- */
function drawFlow(now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  const g = flowGridArea();

  // ---- Grid squares: white dotted lines, panned by flowCam ----
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
  ctx.font = '13px monospace';
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

  // ---- Wires (consumer slots → sources), drawn under the nodes ----
  drawFlowWires();

  // ---- Connecting mode: highlight valid targets ----
  if (flowConnArm) {
    const consumer = flowNodeById(flowConnArm.nodeId);
    if (consumer) {
      for (const n of flowNodes) {
        if (!flowConnCanAssign(consumer, flowConnArm.slot, n.id)) continue;
        const p = flowCellScreen(n.gx, n.gy);
        const cx = p.x + FLOW_CELL / 2, cy = p.y + FLOW_CELL / 2;
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 250);
        ctx.strokeStyle = '#5cdb7a';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, FLOW_CELL / 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  // ---- Sound nodes ----
  for (const n of flowNodes) {
    const p = flowCellScreen(n.gx, n.gy);
    const cx = p.x + FLOW_CELL / 2, cy = p.y + FLOW_CELL / 2;
    const sel = n.id === flowSelId;
    const move = n.id === flowMoveId;
    if (move) {
      ctx.globalAlpha = flowFlashAlpha();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(cx, cy, FLOW_CELL / 2 - 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.arc(cx, cy, FLOW_CELL / 2 - 6, 0, Math.PI * 2);
    ctx.fillStyle = sel ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)';
    ctx.fill();
    ctx.strokeStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = sel ? 2.5 : 1;
    ctx.stroke();
    ctx.font = '36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(FLOW_NODE_TYPES[n.type].emoji, cx, cy + 2);
    ctx.textBaseline = 'alphabetic';
    // Warning badge on a note whose required connections are missing.
    if (n.type === 'note' && !flowNoteReady(n)) {
      ctx.beginPath();
      ctx.arc(cx + FLOW_CELL / 2 - 12, cy - FLOW_CELL / 2 + 12, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#e06060';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 11px sans-serif';
      ctx.fillText('!', cx + FLOW_CELL / 2 - 12, cy - FLOW_CELL / 2 + 12 + 1);
    }
    ctx.globalAlpha = 1;
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
      ctx.font = '24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.emoji, o.cx, o.cy + 1);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '700 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(o.label, o.cx, o.cy + o.r + 15);
    }
  }

  // ---- Attribute panel (right side, for the selected node) ----
  const selNode = flowNodeById(flowSelId);
  if (selNode) {
    const panel = flowPanelRect();
    drawRoundRect(panel.x, panel.y, panel.w, panel.h, 12);
    ctx.fillStyle = 'rgba(12,12,12,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Header: node type + ✕ close.
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 15px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(FLOW_NODE_TYPES[selNode.type].label, panel.x + 14, panel.y + 28);
    const close = flowPanelCloseRect(panel);
    ctx.beginPath();
    ctx.arc(close.x + close.w / 2, close.y + close.h / 2, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#333333';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✕', close.x + close.w / 2, close.y + close.h / 2 + 4);
    // Drawer content depends on node type.
    if (selNode.type === 'note') {
      drawFlowDrawer(selNode, panel);
    } else {
      // Edit button for volumeEnv / env / wave (the unison drawer's ✎ chip
      // opens its overlay instead, to keep the drawer compact).
      if (selNode.type !== 'unison') {
        const eb = flowPanelEnvBtnRect(panel);
        drawRoundRect(eb.x, eb.y, eb.w, eb.h, 9);
        ctx.fillStyle = '#2b2b2b';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = '800 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(selNode.type === 'wave' ? '🌊 Edit waveform' : selNode.type === 'env' ? '📈 Edit curve' : '📉 Edit volume', eb.x + eb.w / 2, eb.y + eb.h / 2 + 1);
        ctx.textBaseline = 'alphabetic';
      }
      drawFlowDrawer(selNode, panel);
    }
    // Delete button: positioned right after the drawer content.
    const del = flowDrawerDeleteRect(selNode, panel);
    drawRoundRect(del.x, del.y, del.w, del.h, 9);
    ctx.fillStyle = '#c0392b';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🗑 Delete', del.x + del.w / 2, del.y + del.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }

  // ---- Connecting banner (a slot is armed, awaiting a grid tap) ----
  if (flowConnArm) {
    drawRoundRect(16, 16, 300, 34, 10);
    ctx.fillStyle = 'rgba(22,26,34,0.95)';
    ctx.fill();
    ctx.strokeStyle = FLOW_UNISON_ACCENT;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Connecting… tap a node to connect · tap the slot to cancel', 30, 34);
    ctx.textBaseline = 'alphabetic';
  }

  // ---- Bottom node tray ----
  ctx.fillStyle = '#141414';
  ctx.fillRect(g.left, g.bottom, g.right - g.left, H - g.bottom);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(g.left, g.bottom); ctx.lineTo(g.right, g.bottom);
  ctx.stroke();
  // Node chips (one per placed node: emoji + its x,y position), clipped to the
  // bar clear of the back button. The selected node's chip is highlighted,
  // matching its highlight on the grid.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, g.bottom, flowBarRightLimit(), H - g.bottom);
  ctx.clip();
  const chips = flowBarChips();
  if (flowBarScrollX > flowBarMaxScroll()) flowBarScrollX = flowBarMaxScroll();
  if (!chips.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '700 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(flowNodes.length
      ? 'All nodes hidden from the bar · double-tap one on the grid to bring it back'
      : 'No nodes yet · tap a cell on the grid to add one', 16, H - FLOW_BAR_H / 2);
    ctx.textBaseline = 'alphabetic';
  } else {
    for (const c of chips) {
      const sel = c.node.id === flowSelId;
      if (c.node.id === flowMoveId) ctx.globalAlpha = flowFlashAlpha();
      drawRoundRect(c.x, c.y, c.w, c.h, 10);
      ctx.fillStyle = sel ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.06)';
      ctx.fill();
      ctx.strokeStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.4)';
      ctx.lineWidth = sel ? 2 : 1;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '20px sans-serif';
      ctx.fillText(FLOW_NODE_TYPES[c.node.type].emoji, c.x + c.w / 2, c.y + 16);
      ctx.font = '700 11px monospace';
      ctx.fillStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.8)';
      ctx.fillText(c.node.gx + ',' + c.node.gy, c.x + c.w / 2, c.y + c.h - 11);
      ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = 1;
      // ✕ badge underneath: removes this chip from the bar (node stays on grid).
      const cl = chipCloseRect(c);
      ctx.beginPath();
      ctx.arc(cl.cx, cl.cy, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#c0392b';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✕', cl.cx, cl.cy + 1);
      ctx.textBaseline = 'alphabetic';
    }
  }
  ctx.restore();

  // ---- Back button (bottom-right, inside the bar) ----
  const b = flowBackRect();
  ctx.beginPath();
  ctx.arc(b.x + b.d / 2, b.y + b.d / 2, FLOW_BACK_R, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.fillStyle = '#000000';
  ctx.font = '800 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('‹', b.x + b.d / 2, b.y + b.d / 2 + 1);
  ctx.textBaseline = 'alphabetic';

  // ---- Undo button (left of the back button; disabled when nothing to undo) ----
  const u = flowUndoRect();
  const canUndo = flowHistory.length > 0;
  drawRoundRect(u.x, u.y, u.w, u.h, 10);
  ctx.fillStyle = canUndo ? '#2b2b2b' : '#1a1a1a';
  ctx.fill();
  ctx.strokeStyle = canUndo ? '#ffffff' : 'rgba(255,255,255,0.3)';
  ctx.lineWidth = canUndo ? 1.5 : 1;
  ctx.stroke();
  ctx.fillStyle = canUndo ? '#ffffff' : 'rgba(255,255,255,0.4)';
  ctx.font = '700 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('↺ Undo', u.x + u.w / 2, u.y + u.h / 2 + 1);
  ctx.textBaseline = 'alphabetic';

  // ---- Envelope editor overlay (on top of everything else) ----
  if (flowEnvEdit) drawFlowEnvEditor();
  else if (flowWaveEdit) drawFlowWaveEditor();
  else if (flowUnisonEdit) drawFlowUnisonEditor();
  else if (flowCurveEdit) drawFlowCurveEditor();
}

/* ---- Hit testing ---- */
function hitTestFlow(x, y) {
  const b = flowBackRect();
  if (Math.hypot(x - (b.x + b.d / 2), y - (b.y + b.d / 2)) <= FLOW_BACK_R + 6) return { type: 'back' };
  if (y < H - FLOW_BAR_H) return { type: 'grid' };
  return { type: 'empty' };
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

function flowEnvPanel() {
  return { x: 16, y: 16, w: W - 32, h: H - FLOW_BAR_H - 32 };
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
  ctx.fillStyle = 'rgba(14,14,16,0.92)';
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
var flowWavePtr = null;      // { mode: 'point'|'draw', idx?, lastX? } active drag
var flowWaveLastTap = null;  // double-tap-to-delete on a spectrum dot
var flowWaveMode = 'point';  // 'point' | 'draw' | 'delete'

function flowWavePanel() { return flowEnvPanel(); }
function flowWavePlot(p) { return flowEnvPlot(p); }
function flowWaveCloseRect(p) { return flowEnvCloseRect(p); }
function flowWaveClearPill(p) { return flowEnvClearPill(p); }
function flowWaveToolbar(p) {
  const modes = [['point', 'Point'], ['draw', 'Draw'], ['delete', 'Delete']];
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
function drawFlowWaveEditor() {
  const p = flowWavePanel();
  const pl = flowWavePlot(p);
  const l = selectedLayer();
  initLayerSpecPoints(l);
  const pts = l.specPoints;
  const y0 = ampToY(0, pl);
  // Partially transparent backdrop: the flow grid shows through.
  drawRoundRect(p.x, p.y, p.w, p.h, 14);
  ctx.fillStyle = 'rgba(14,14,16,0.92)';
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
  ctx.fillStyle = 'rgba(14,14,16,0.92)';
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
  ctx.fillStyle = 'rgba(14,14,16,0.92)';
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
  if (flowEnvEdit) { flowEnvHandleDown(x, y); return; }
  if (flowWaveEdit) { flowWaveHandleDown(x, y); return; }
  if (flowUnisonEdit) { flowUnisonHandleDown(x, y); return; }
  if (flowCurveEdit) { flowCurveHandleDown(x, y); return; }
  // Back button always wins.
  if (hitTestFlow(x, y).type === 'back') { closeSoundFlow(); return; }
  // Undo button (bottom bar).
  const u = flowUndoRect();
  if (x >= u.x && x <= u.x + u.w && y >= u.y && y <= u.y + u.h) { undoFlow(); return; }
  // Add-node menu option (create the node).
  const opt = hitAddMenu(x, y);
  if (opt) { addFlowNode(opt.type); return; }
  // Attribute panel (selected node): slider, close, or swallow.
  if (flowSelId && flowNodeById(flowSelId)) {
    const panel = flowPanelRect();
    if (x >= panel.x && x <= panel.x + panel.w && y >= panel.y && y <= panel.y + panel.h) {
      const close = flowPanelCloseRect(panel);
      if (x >= close.x && x <= close.x + close.w && y >= close.y && y <= close.y + close.h) {
        flowSelId = null;
        flowAddMenu = null;
        saveFlow();
        return;
      }
      const selN = flowNodeById(flowSelId);
      // Delete button (positioned after the drawer content).
      const del = flowDrawerDeleteRect(selN, panel);
      if (x >= del.x && x <= del.x + del.w && y >= del.y && y <= del.y + del.h) {
        deleteFlowNode(flowSelId);   // clears selection too, so the drawer closes
        return;
      }
      // Edit button for volumeEnv / env / wave (the unison drawer's ✎ chip
      // opens its overlay instead).
      if (selN && selN.type !== 'note' && selN.type !== 'unison') {
        const eb = flowPanelEnvBtnRect(panel);
        if (x >= eb.x && x <= eb.x + eb.w && y >= eb.y && y <= eb.y + eb.h) {
          if (selN.type === 'volumeEnv') openFlowEnvelopeEditor(flowSelId);
          else if (selN.type === 'env') openFlowCurveEditor(flowSelId);
          else openFlowWaveEditor(flowSelId);
          return;
        }
      }
      // Drawer interactions: connection slots, play, unison compact voices.
      if (selN) {
        const cH = flowHitDrawer(x, y, panel, selN);
        if (cH) {
          if (cH.kind === 'clear') {
            flowPushHistory();
            connSlotSet(selN, cH.slot, null);
            saveFlow();
          } else if (cH.kind === 'arm') {
            const k = slotKey(cH.slot);
            if (flowConnArm && flowConnArm.nodeId === selN.id && slotKey(flowConnArm.slot) === k) flowConnArm = null;
            else flowConnArm = { nodeId: selN.id, slot: cH.slot };
          } else if (cH.kind === 'cancel') {
            flowConnArm = null;
          } else if (cH.kind === 'play') {
            playFlowNote(selN);
          } else if (cH.kind === 'uned') {
            openFlowUnisonEditor(flowSelId);
          } else if (cH.kind === 'vsel') {
            flowUnisonSel = cH.i;
          } else if (cH.kind === 'interval') {
            const v = flowUnisonSelectedOf(selN);
            if (v) { flowPushHistory(); v.st = cH.st; saveFlow(); }
          }
          return;
        }
      }
      return;   // panel body: swallow, never pan from here
    }
  }
  // Bottom bar: a tap on a chip (toggle/double-tap), a long-press (move/delete),
  // or a drag scrolls the strip.
  if (y >= H - FLOW_BAR_H) {
    // ✕ badge underneath a chip: remove that node from the bar (undoable).
    const closeNode = hitChipClose(x, y);
    if (closeNode) {
      removeNodeFromBar(closeNode.id);
      return;
    }
    const chip = hitBarChip(x, y);
    flowAddMenu = null;
    flowPanAnim = null;
    flowPtr = { kind: 'bar', chip: chip ? chip.node : null, x, y, startX: x, startY: y, lastT: e.timeStamp, vx: 0, vy: 0, moved: false };
    if (chip) flowHold = { id: chip.node.id, kind: 'bar', t0: performance.now(), stage: 0 };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    return;
  }
  // Grid: start a pan (a small movement counts as a tap on release). Pressing
  // on a node also arms the long-press hold.
  flowAddMenu = null;
  flowInertia = null;
  flowPanAnim = null;
  const gx = Math.floor((x + flowCam.x) / FLOW_CELL);
  const gy = Math.floor((y + flowCam.y) / FLOW_CELL);
  const node = flowNodeAt(gx, gy);
  flowPtr = { kind: 'grid', x, y, startX: x, startY: y, lastT: e.timeStamp, vx: 0, vy: 0, moved: false };
  if (node) flowHold = { id: node.id, kind: 'grid', t0: performance.now(), stage: 0 };
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
});

canvas.addEventListener('pointermove', e => {
  if (!flowActive) return;
  const x = stageX(e), y = stageY(e);
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
  if (flowPtr.kind === 'bar') {
    if (flowPtr.moved) flowBarScrollX = Math.max(0, Math.min(flowBarMaxScroll(), flowBarScrollX - dx));
    flowPtr.x = x;
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
  if (flowEnvEdit) { flowEnvHandleUp(); return; }
  if (flowWaveEdit) { flowWaveHandleUp(); return; }
  if (flowUnisonEdit) { flowUnisonHandleUp(); return; }
  if (flowCurveEdit) { flowCurveHandleUp(); return; }
  // A held press that reached move mode: consume the release so it doesn't also
  // select/deselect or open the add menu (the node keeps flashing).
  if (flowHold) {
    const h = flowHold;
    flowHold = null;
    if (h.stage >= 1) { flowPtr = null; return; }
  }
  if (!flowPtr) return;
  const kind = flowPtr.kind;
  const wasMoved = flowPtr.moved;
  const chip = flowPtr.chip;
  const tapX = flowPtr.startX, tapY = flowPtr.startY;
  const vx = flowPtr.vx, vy = flowPtr.vy;
  flowPtr = null;
  if (kind === 'bar') {
    if (wasMoved || !chip) return;   // a scroll, or an empty-bar tap
    flowMoveId = null;               // tapping a chip cancels move mode
    handleChipTap(chip);
    return;
  }
  if (wasMoved) {
    if (Math.hypot(vx, vy) > FLOW_FLICK_MIN) flowInertia = { vx, vy };
    return;
  }
  // Tap: pick the cell under the finger.
  const gx = Math.floor((tapX + flowCam.x) / FLOW_CELL);
  const gy = Math.floor((tapY + flowCam.y) / FLOW_CELL);
  // Move mode: place the flashing node on this cell (empty cells only).
  if (flowMoveId) {
    const id = flowMoveId;
    const t = flowNodeAt(gx, gy);
    if (!t || t.id === id) moveFlowNodeTo(id, gx, gy);
    else flowMoveId = null;   // cell occupied by another node: cancel move mode
    return;
  }
  const node = flowNodeAt(gx, gy);
  if (node) {
    // Connection slot armed: tapping a node assigns it (kept armed on a wrong
    // type so the user can pick the right node instead).
    if (flowConnArm) {
      const consumer = flowNodeById(flowConnArm.nodeId);
      if (consumer && flowConnCanAssign(consumer, flowConnArm.slot, node.id)) {
        flowPushHistory();
        connSlotSet(consumer, flowConnArm.slot, node.id);
        saveFlow();
        flowConnArm = null;
      }
      return;
    }
    const now = performance.now();
    // Double-tap on a grid node: select it and add it to the bottom bar (useful
    // for nodes whose chip was hidden with the medium-long hold).
    if (flowLastGridTap && flowLastGridTap.id === node.id && now - flowLastGridTap.t < FLOW_DOUBLE_TAP_MS) {
      flowLastGridTap = null;
      flowSelId = node.id;
      flowAddMenu = null;
      if (node.inBar === false) {
        flowPushHistory();
        node.inBar = true;
        saveFlow();
      }
      return;
    }
    flowLastGridTap = { id: node.id, t: now };
    flowSelId = node.id;
    flowAddMenu = null;
    saveFlow();
  } else {
    if (flowConnArm) { flowConnArm = null; return; }   // cancelled on an empty cell
    flowAddMenu = { gx, gy };
    flowSelId = null;
    flowLastGridTap = null;
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
});

function flowLoop(now) {
  if (flowActive) {
    // Long-press hold: move mode at FLOW_HOLD_MOVE.
    if (flowHold) {
      const el = performance.now() - flowHold.t0;
      if (flowHold.stage === 0 && el >= FLOW_HOLD_MOVE) {
        flowHold.stage = 1;
        flowMoveId = flowHold.id;   // start flashing (move mode)
        flowSelId = flowHold.id;
        flowAddMenu = null;
      }
    }
    // Animated pan to a double-tapped node's cell (ease-out cubic).
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