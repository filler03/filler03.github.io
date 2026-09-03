/* ============================================================
   flow.js — full-screen sound flow editor. A new scene (black
   background + grid of squares made of white dotted lines) for
   arranging sound nodes, opened from the main screen's
   bottom-right button. Each square shows its x,y position in its
   bottom-right corner, and dragging a finger on any square pans
   the grid infinitely in any direction (with inertia on release).

   Placing nodes: tapping an empty cell shows the node types that
   can be added around it; tapping one creates that node in the
   cell. So far there is one node type — a Note (🎵). Selecting a
   node (a tap on it) opens the attribute panel on the right side
   of the screen, which shows the node's properties (note life for
   now). The bottom node-palette bar (where node visuals land in a
   later phase) stays docked, with a back button in its bottom-right
   corner. The garden state is untouched while away: mode flips to
   'flow' and the main loop skips its own rendering.
   ============================================================ */

const flowBtn = document.getElementById('flowBtn');
const FLOW_BAR_H = 88;          // height of the bottom node-palette bar
const FLOW_CELL = 72;           // grid square size (px)
const FLOW_BACK_R = 22;         // back-button radius
const FLOW_TAP_MAX = 10;        // px of movement before a touch counts as a pan
const FLOW_PANEL_W = 150;       // right-side attribute panel width
const FLOW_CHIP_W = 78;         // bottom-bar node chip width
const FLOW_CHIP_H = 46;         // bottom-bar node chip height
const FLOW_CHIP_GAP = 8;        // gap between bottom-bar chips
const FLOW_BAR_EDGE = 16;       // left padding inside the bottom bar
const FLOW_DOUBLE_TAP_MS = 400; // window for a double-tap on a chip
const FLOW_HOLD_MOVE = 500;     // ms of a still hold before the node enters move mode (flash)
const FLOW_UNDO_W = 78;         // undo button width (bottom bar, left of the back button)
const FLOW_UNDO_H = 40;         // undo button height
const FLOW_HISTORY_MAX = 50;    // undo stack depth

// Node types: the add-menu option and the node's grid image share its emoji.
const FLOW_NODE_TYPES = {
  note: { label: 'Note', emoji: '🎵' },
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
var flowSliderDrag = false;     // note-life slider is being dragged
var flowBarScrollX = 0;         // horizontal scroll offset of the bottom-bar chip strip
var flowLastChipTap = null;     // { id, t } last bottom-bar chip tap (double-tap detection)
var flowLastGridTap = null;     // { id, t } last grid-node tap (double-tap detection)
var flowPanAnim = null;         // { x0, y0, x1, y1, t0 } animated pan to a node's cell
var flowHold = null;            // { id, kind, t0, stage } active long-press hold, or null
var flowMoveId = null;          // id of the node in move mode (slowly flashing), or null
var flowHistory = [];           // undo stack: [{ nodes }] snapshots taken before each action
var flowHistoryBase = null;     // snapshot taken at the start of a note-life drag (one undo entry per drag)

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
function flowPanelSliderRect(panel) {
  return { x1: panel.x + 16, x2: panel.x + panel.w - 16, cy: panel.y + 96 };
}
function flowPanelDeleteRect(panel) {
  const w = panel.w - 28;
  return { x: panel.x + 14, y: panel.y + panel.h - 46, w, h: 34 };
}
// The add-menu option buttons, laid out around the anchored cell (clamped to
// stay inside the grid area). One per node type for now.
function flowAddMenuOptions() {
  const p = flowCellScreen(flowAddMenu.gx, flowAddMenu.gy);
  const cx = Math.max(40, Math.min(W - 40, p.x + FLOW_CELL / 2));
  const cy = Math.max(30, Math.min(H - FLOW_BAR_H - 30, p.y - 40));
  return Object.keys(FLOW_NODE_TYPES).map(type => ({
    type, cx, cy, r: 24,
    emoji: FLOW_NODE_TYPES[type].emoji,
    label: FLOW_NODE_TYPES[type].label,
  }));
}
function hitAddMenu(x, y) {
  if (!flowAddMenu) return null;
  for (const o of flowAddMenuOptions()) {
    if (Math.hypot(x - o.cx, y - o.cy) <= o.r + 6) return o;
  }
  return null;
}
// Create a node of `type` in the cell that owns the open add menu, select it,
// and persist.
function addFlowNode(type) {
  if (!flowAddMenu || !FLOW_NODE_TYPES[type]) return;
  flowPushHistory();
  const id = 'node-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
  flowNodes.push({ id, gx: flowAddMenu.gx, gy: flowAddMenu.gy, type, noteLife: 2500, inBar: true });
  flowAddMenu = null;
  flowSelId = id;
  saveFlow();
}
function applyNoteLifeFromX(x) {
  const n = flowNodeById(flowSelId);
  if (!n) return;
  const s = flowPanelSliderRect(flowPanelRect());
  const f = clamp01((x - s.x1) / (s.x2 - s.x1));
  n.noteLife = Math.round(FLOW_NOTE_LIFE_MIN + f * (FLOW_NOTE_LIFE_MAX - FLOW_NOTE_LIFE_MIN));
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
function loadFlow() {
  try {
    const raw = localStorage.getItem(FLOW_SAVE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    const arr = Array.isArray(d.nodes) ? d.nodes : [];
    flowNodes = [];
    for (const n of arr) {
      if (!n || typeof n.gx !== 'number' || typeof n.gy !== 'number' || typeof n.type !== 'string') continue;
      flowNodes.push({
        id: typeof n.id === 'string' ? n.id : 'node-' + Math.random().toString(36).slice(2),
        gx: Math.round(n.gx), gy: Math.round(n.gy),
        type: FLOW_NODE_TYPES[n.type] ? n.type : 'note',
        noteLife: Math.max(FLOW_NOTE_LIFE_MIN, Math.min(FLOW_NOTE_LIFE_MAX, Math.round(+n.noteLife) || 2500)),
        inBar: n.inBar !== false,
      });
    }
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
  flowPtr = null;
  flowInertia = null;
  flowAddMenu = null;
  flowSliderDrag = false;
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
    // Note-life slider.
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '700 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Note life', panel.x + 14, panel.y + 66);
    const s = flowPanelSliderRect(panel);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.cy); ctx.lineTo(s.x2, s.cy);
    ctx.stroke();
    const f = clamp01((selNode.noteLife - FLOW_NOTE_LIFE_MIN) / (FLOW_NOTE_LIFE_MAX - FLOW_NOTE_LIFE_MIN));
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(s.x1, s.cy); ctx.lineTo(s.x1 + f * (s.x2 - s.x1), s.cy);
    ctx.stroke();
    ctx.lineCap = 'butt';
    const tx = s.x1 + f * (s.x2 - s.x1);
    ctx.beginPath();
    ctx.arc(tx, s.cy, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 13px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText((selNode.noteLife / 1000).toFixed(1) + 's', panel.x + panel.w - 14, panel.y + 138);
    // Delete button: deleting a node is only possible from this drawer.
    const del = flowPanelDeleteRect(panel);
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
}

/* ---- Hit testing ---- */
function hitTestFlow(x, y) {
  const b = flowBackRect();
  if (Math.hypot(x - (b.x + b.d / 2), y - (b.y + b.d / 2)) <= FLOW_BACK_R + 6) return { type: 'back' };
  if (y < H - FLOW_BAR_H) return { type: 'grid' };
  return { type: 'empty' };
}

/* ---- Pointer handling (active only in flow mode) ---- */
canvas.addEventListener('pointerdown', e => {
  if (!flowActive) return;
  const x = stageX(e), y = stageY(e);
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
      const del = flowPanelDeleteRect(panel);
      if (x >= del.x && x <= del.x + del.w && y >= del.y && y <= del.y + del.h) {
        deleteFlowNode(flowSelId);   // clears selection too, so the drawer closes
        return;
      }
      const s = flowPanelSliderRect(panel);
      if (Math.abs(y - s.cy) <= 14 && x >= s.x1 - 10 && x <= s.x2 + 10) {
        flowSliderDrag = true;
        flowHistoryBase = clone(flowNodes);   // the whole drag is one undo entry
        applyNoteLifeFromX(x);
        return;
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
  if (flowSliderDrag) { applyNoteLifeFromX(x); return; }
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
  if (flowSliderDrag) {
    flowSliderDrag = false;
    if (flowHistoryBase) { flowPushHistory(flowHistoryBase); flowHistoryBase = null; }
    saveFlow();
    return;
  }
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
    flowAddMenu = { gx, gy };
    flowSelId = null;
    flowLastGridTap = null;
  }
});

canvas.addEventListener('pointercancel', () => {
  if (flowHistoryBase) { flowPushHistory(flowHistoryBase); flowHistoryBase = null; }
  flowPtr = null;
  flowInertia = null;
  flowSliderDrag = false;
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