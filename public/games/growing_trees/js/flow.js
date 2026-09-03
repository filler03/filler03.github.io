/* ============================================================
   flow.js — full-screen sound flow editor. A new scene (white
   background + grid of squares made of black dotted lines) for
   arranging sound nodes, opened from the main screen's
   bottom-right button. Each square shows its x,y position in its
   bottom-right corner, and dragging a finger on any square pans
   the grid infinitely in any direction. The bottom node-palette
   bar (where node visuals land in the next phase) stays docked,
   with a back button in its bottom-right corner. The garden state
   is untouched while away: mode flips to 'flow' and the main loop
   skips its own rendering.
   ============================================================ */

const flowBtn = document.getElementById('flowBtn');
const FLOW_BAR_H = 88;          // height of the bottom node-palette bar
const FLOW_CELL = 72;           // grid square size (px)
const FLOW_BACK_R = 22;         // back-button radius

var flowCam = { x: 0, y: 0 };   // grid pan offset (px): world = screen + cam
var flowPtr = null;             // { x, y, lastT, vx, vy } active pan drag, or null
var flowInertia = null;         // { vx, vy } px/ms momentum after a flick, or null
var flowLastT = 0;              // last RAF timestamp, for dt-based inertia decay
const FLOW_FLICK_MIN = 0.04;    // px/ms velocity needed to start inertia on release
const FLOW_FLICK_STOP = 0.001;  // px/ms at which inertia settles and stops

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
  playbacks.length = 0;
  stopGestureNote();
  stopPreviewVoices();
  document.body.classList.remove('flow');
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

  // ---- Bottom node-palette bar ----
  ctx.fillStyle = '#141414';
  ctx.fillRect(g.left, g.bottom, g.right - g.left, H - g.bottom);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(g.left, g.bottom); ctx.lineTo(g.right, g.bottom);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Node palette', 16, H - FLOW_BAR_H / 2 + 4);
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = '700 11px sans-serif';
  ctx.fillText('Node visuals land here next · drag one onto the grid', 16, H - FLOW_BAR_H / 2 + 22);

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
  const hit = hitTestFlow(x, y);
  if (hit.type === 'back') { closeSoundFlow(); return; }
  if (hit.type === 'grid') {
    flowInertia = null;
    flowPtr = { x, y, lastT: e.timeStamp, vx: 0, vy: 0 };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  }
});

canvas.addEventListener('pointermove', e => {
  if (!flowActive || !flowPtr) return;
  const x = stageX(e), y = stageY(e);
  const dx = x - flowPtr.x, dy = y - flowPtr.y;
  const dt = Math.max(1, e.timeStamp - flowPtr.lastT);
  // Smoothed finger velocity (px/ms), so a quick flick builds momentum.
  flowPtr.vx = flowPtr.vx * 0.6 + (dx / dt) * 0.4;
  flowPtr.vy = flowPtr.vy * 0.6 + (dy / dt) * 0.4;
  flowCam.x -= dx;
  flowCam.y -= dy;
  flowPtr.x = x; flowPtr.y = y; flowPtr.lastT = e.timeStamp;
});

canvas.addEventListener('pointerup', () => {
  if (!flowPtr) return;
  const vx = flowPtr.vx, vy = flowPtr.vy;
  flowPtr = null;
  if (Math.hypot(vx, vy) > FLOW_FLICK_MIN) flowInertia = { vx, vy };
});
canvas.addEventListener('pointercancel', () => {
  flowPtr = null;
  flowInertia = null;
});

function flowLoop(now) {
  if (flowActive) {
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