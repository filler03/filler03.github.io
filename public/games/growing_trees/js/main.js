/* ============================================================
   main.js — boot sequence, pointer handlers, main render loop
   Loaded LAST, after all modules are defined.
   ============================================================ */

/* ---- Boot ---- */

// Mirror the bottom-right version badge into the rotate prompt, so the
// version shows while the device is held upright too.
document.getElementById('rotateVersion').textContent = document.getElementById('version').textContent;

// One-time "tap to enable sound" gate. Browsers refuse to start a freshly
// created AudioContext from a drag's pointer events; they only honor a discrete
// tap/click. This overlay guarantees that first qualifying tap happens before
// any gesture, so the very first note is audible.
const soundOverlay = document.getElementById('soundOverlay');
soundOverlay.addEventListener('pointerdown', unlockAudio);
function dismissSoundOverlay() {
  soundOverlay.classList.add('hidden');
  unlockAudio();
  // Create a REAL oscillator right now (not gated on the context reporting
  // running): some browsers only grant the audio unlock on actual sound output,
  // which is exactly what this chime provides.
  playUnlockChime();
}
soundOverlay.addEventListener('click', dismissSoundOverlay);

// Apply the saved settings to this session.
loadSavedSettings();
syncWaitBtn();
syncLineUI();
syncEnvelopeUI();
syncPitchZonesUI();

/* ---- Pointer handling ---- */

canvas.addEventListener('pointerdown', e => {
  unlockAudio();
  if (mode === 'creator') return;   // sound creator handles its own canvas input
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: stageX(e), y: stageY(e) });

  if (mode === 'plant') {
    // Each finger starts its own independent gesture (path + note). The note
    // begins the moment the finger touches down — a tap is just a very short
    // gesture (no horizontal travel), sharing the same flow. In wait mode the
    // sound holds until the finger lifts.
    const ds = {
      pointerId: e.pointerId,                 // lets a late audio init check if this drag is still alive
      startX: stageX(e), startY: stageY(e),   // where the gesture started (drives pitch)
      pts: [{ x: stageX(e), y: stageY(e) }],  // recorded freehand path
      cumTime: [0],                           // ms of note time at each point
      totalMs: 0,                             // running note length (horizontal travel)
      started: false, startedAt: 0, ctx0: 0,  // live note state
      gain: null, osc: null, gainLevel: 0, lastSched: 0, cleanupTimer: null,
      lastMoveAt: 0,                          // when the finger last added a path point
      playback: null,                         // this drag's playback entry (live mode)
    };
    dragStates.set(e.pointerId, ds);
    if (!GESTURE.waitForGesture) startLivePathNote(ds);
  } else {
    if (pointers.size === 1) {
      navState = { startX: stageX(e), startY: stageY(e), curX: stageX(e), curY: stageY(e) };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchState = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  }
});

canvas.addEventListener('pointermove', e => {
  if (mode === 'creator') return;
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = stageX(e) - p.x, dy = stageY(e) - p.y;
  p.x = stageX(e); p.y = stageY(e);

  if (mode === 'plant') {
    const ds = dragStates.get(e.pointerId);
    if (ds) {
      const x = stageX(e), y = stageY(e);
      const before = ds.pts.length;
      addPathPoint(ds, x, y);
      if (ds.pts.length > before) {
        if (!GESTURE.waitForGesture) {
          if (ds.started) scheduleLivePoint(ds);
          if (ds.playback) {
            ds.playback.totalMs = ds.totalMs;   // keep the HUD total live
            syncLivePlaybackPath(ds);
          }
        }
      }
    }
  } else if (pointers.size === 2 && pinchState) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    // Incremental delta from the LAST move (not the pinch start), so the
    // factor never compounds across events — keeps the zoom smooth.
    const factor = Math.pow(dist / pinchState.dist, PINCH_SENS);
    pinchState.dist = dist;
    zoomAt(mx, my, factor);
    clampCamY();
  } else if (pointers.size === 1 && navState) {
    navState.curX = stageX(e); navState.curY = stageY(e);
    cam.x -= dx * PAN_SENS;
    cam.y -= dy * PAN_SENS;
    clampCamY();
  }
});

canvas.addEventListener('pointerup', e => {
  unlockAudio();
  if (mode === 'creator') return;
  pointers.delete(e.pointerId);

  if (mode === 'plant') {
    const ds = dragStates.get(e.pointerId);
    dragStates.delete(e.pointerId);
    if (ds) finishPlantGesture(ds);
  } else {
    pinchState = null;
    if (pointers.size === 1) {
      const p = [...pointers.values()][0];
      navState = { startX: p.x, startY: p.y, curX: p.x, curY: p.y };
    } else if (pointers.size === 0) {
      navState = null;
    }
  }
});

canvas.addEventListener('pointercancel', e => {
  if (mode === 'creator') return;
  pointers.delete(e.pointerId);
  pinchState = null;
  if (mode === 'plant') {
    const ds = dragStates.get(e.pointerId);
    dragStates.delete(e.pointerId);
    if (ds) cancelDragState(ds);
  } else if (pointers.size === 1) {
    const p = [...pointers.values()][0];
    navState = { startX: p.x, startY: p.y, curX: p.x, curY: p.y };
  } else if (pointers.size === 0) {
    navState = null;
  }
});

// If the pointer goes missing (window loses focus, browser steals the
// gesture, etc.), drop all ghost pointers so a stuck plant gesture or a
// phantom "down" finger can't freeze the game.
window.addEventListener('blur', () => {
  pointers.clear();
  pinchState = null;
  dragStates.clear();
  navState = null;
  stopGestureNote();
});

/* ---------- Main loop ---------- */
let lastT = performance.now();
function loop(now) {
  lastT = now;
  if (mode === 'creator') { requestAnimationFrame(loop); return; }   // sound creator draws its own frame
  try {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x, -cam.y);

  // Plain white background in WORLD coordinates so it scales and pans
  // together with the gestures (the CSS background is a fixed layer).
  const vx0 = cam.x / cam.zoom, vy0 = cam.y / cam.zoom;
  const vw = W / cam.zoom, vh = H / cam.zoom;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(vx0, vy0, vw, vh);

  // ---- Plant gesture rendering (screen space) ----
  // While drawing, the path is a dotted line. Once a note plays back, the
  // circle's current position splits the path: the played portion ahead is a
  // glowing green solid line, the unplayed portion behind stays dotted. Every
  // gesture that is still playing (or lingering) keeps its path on screen.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (mode === 'plant') {
    drawPitchZones();   // faint degree-color bands, one per scale degree
    drawVolumeScale();  // right-edge lower/middle/upper volume markers
    // Held live-sound gestures keep their attack fade advancing in real time;
    // without this the fade stalls the moment the finger stops drawing.
    for (const ds of dragStates.values()) {
      if (ds.gain && !ds.finished) tickLiveHold(ds);
    }
    for (const ds of dragStates.values()) {
      const currentPlay = playbacks.find(p => p.ds === ds);
      if (!currentPlay && ds.pts.length > 1) drawDottedPath(ds.pts, ds.cumTime);
      if (!currentPlay && ds.pts.length === 1) drawPlaybackCircle(ds.pts[0].x, ds.pts[0].y, 1, 1, degreeColorForX(ds.startX));
    }
  }
  for (let i = playbacks.length - 1; i >= 0; i--) {
    const p = playbacks[i];
    const elapsed = now - p.startedAt;
    const totalMs = p.totalMs || 0;
    const done = p.released && elapsed >= totalMs;
    let alpha = 1;
    if (done) {
      const after = elapsed - totalMs;
      if (after >= LINGER_MS) { playbacks.splice(i, 1); continue; }
      alpha = 1 - after / LINGER_MS;
    }
    const pts = p.pts, cum = p.cumTime;
    const st = pathStateAtTime(pts, cum, done ? (cum[cum.length - 1] || 0) : elapsed);
    const tailEnd = p.tailEnd != null ? p.tailEnd : pts.length;
    const cRelVol = pts.length === 1 && !p.released
      ? 1   // a stationary press has no path time: the envelope value stays at the attack start, so draw the circle at full size
      : stateRelVol(cum, st, tailEnd, !!p.looped);
    ctx.globalAlpha = alpha;
    drawGreenPath(pts, cum, st, tailEnd, !!p.looped, p.color);
    drawDottedTail(pts, cum, st, tailEnd, p.color);
    drawPlaybackCircle(st.x, st.y, alpha, cRelVol, p.color);
    ctx.globalAlpha = 1;
  }

  refreshHud(now);
  } catch (err) {
    // Never let a single bad frame brick the game: clear transient gesture
    // state so the next frame recovers, and keep the loop alive.
    console.error(err);
    dragStates.clear(); navState = null; pinchState = null;
    pointers.clear();
    stopGestureNote();
  }

  requestAnimationFrame(loop);
}
loop();
