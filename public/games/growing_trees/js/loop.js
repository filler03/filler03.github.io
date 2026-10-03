/* ============================================================
   loop.js — loopable track clips for the playing field.

   A live loop station layered over the gesture instrument:
   - A shared transport clock (audio-clock based) with a tap-tempo
     BPM, a time signature (beats per bar) and an
     optional metronome click (off until explicitly toggled on).
   - Record: a 1-bar count-in, then N bars of freehand playing are
     captured. Each gesture becomes an event storing its absolute
     pitch, its start time and its full drawn volume shape (no
     quantization — the performance is kept as played).
   - The sound of every gesture is SNAPSHOTTED from the active flow
     instrument at capture time, so a clip is self-contained and
     keeps working even if the flow editor's note is later edited
     or deleted.
   - Playback: clips are armed/stopped quantized to the next bar
     and loop at their own length (in bars). Events are scheduled on
     the Web Audio clock with a short lookahead, so loops lock to
     the grid and stack with each other and with live playing.

   Loaded last, after flow.js and instrument.js. Reuses the shared
   audio schedulers (schedulePathAudio) by swapping each clip's
   snapshot into the globals for the synchronous scheduling call —
   the same trick previewFlowNote uses.
   ============================================================ */

const CLIP_SAVE_KEY = 'growingTrees.clips.v1';
const CLIP_POINT_MAX = 32;        // path points stored per recorded note (volume shape)
const CLIP_TICK_MS = 25;          // scheduler tick period
const CLIP_LOOKAHEAD_S = 0.2;     // how far ahead events are scheduled on the audio clock
const CLIP_BPM_MIN = 30, CLIP_BPM_MAX = 300;
const TAP_RESET_MS = 2000;        // a gap longer than this restarts tap tempo
const CLIP_HOLD_DELETE = 600;     // long-press a pad to delete it
const CLIP_BARS_OPTIONS = [1, 2, 4, 8];
const CLIP_COLORS = ['#4fc3f7', '#f06292', '#ffb74d', '#81c784', '#ba68c8', '#64b5f6', '#e57373', '#4db6ac'];

var loopClips = [];               // saved/loaded clips, each with its own events + sound snapshots
var loopRec = null;               // active recording session, or null
var loopTicker = null;            // setInterval handle for the scheduler
var loopTaps = [];                // performance.now() of the taps in the current tap-tempo run
var loopTapTimer = null;          // visual reset timeout for an in-progress tap run

var loopTransport = {
  bpm: 120,
  beatsPerBar: 4,
  metronome: false,
  barsToRecord: 4,
  autoLoopAfterRecord: true,
  running: false,                 // is the transport clock live?
  paused: false,                  // frozen while the flow editor is open
  pauseAudioAt: 0,
  originAudio: 0,                 // audioCtx.currentTime mapped to transport beat 0
  originPerf: 0,
  _metroLastBeat: null,           // last scheduled metronome beat (prevents double-fires)
};

/* ---- Transport clock ---- */

function loopBeatDur() { return 60 / loopTransport.bpm; }   // seconds per beat

function loopCurBeat() {
  if (!audioCtx || !loopTransport.running) return 0;
  return (audioCtx.currentTime - loopTransport.originAudio) / loopBeatDur();
}

function loopBeatToAudio(beat) {
  return loopTransport.originAudio + beat * loopBeatDur();
}

// The first downbeat strictly after the current position.
function loopNextBarBeat() {
  const bpb = loopTransport.beatsPerBar;
  const cur = loopCurBeat();
  return (Math.floor(cur / bpb) + 1) * bpb;
}

function loopEnsureTransport() {
  initAudio();
  resumeAudio();
  if (!audioCtx || !masterGain) return;
  if (!loopTransport.running) {
    loopTransport.running = true;
    loopTransport.paused = false;
    loopTransport.originAudio = audioCtx.currentTime + 0.08;
    loopTransport.originPerf = performance.now();
  }
  loopStartTicker();
}

function loopStartTicker() {
  if (loopTicker) return;
  loopTicker = setInterval(loopTick, CLIP_TICK_MS);
}

function loopStopTicker() {
  if (loopTicker) { clearInterval(loopTicker); loopTicker = null; }
}

// Park the clock (and therefore every loop's phase) while the flow editor is
// open: freezing real time keeps clips in phase when you come back. When the
// transport isn't needed by anything (no metronome, recording, or clips), the
// ticker is stopped entirely.
function loopMaybeStopTicker() {
  const busy = loopTransport.metronome || loopRec
    || loopClips.some(c => c.state === 'playing' || c.state === 'armed' || c.state === 'stopping');
  if (!busy && !loopTransport.paused) {
    loopTransport.running = false;
    loopStopTicker();
  }
}

/* ---- Scheduler ---- */

function loopTick() {
  if (!audioCtx) return;
  // Freeze during flow-mode sound design (see loopMaybeStopTicker).
  const paused = !!flowActive;
  if (paused !== loopTransport.paused) {
    if (paused) {
      loopTransport.paused = true;
      loopTransport.pauseAudioAt = audioCtx.currentTime;
    } else if (loopTransport.running) {
      loopTransport.paused = false;
      loopTransport.originAudio += audioCtx.currentTime - loopTransport.pauseAudioAt;
      for (const c of loopClips) {
        if (c.state === 'playing') c._scheduledUntil = loopCurBeat();
      }
    }
  }
  if (paused) return;
  if (!loopTransport.running) return;

  const cur = loopCurBeat();
  const to = cur + CLIP_LOOKAHEAD_S / loopBeatDur();

  if (loopTransport.metronome) loopScheduleMetronome(cur, to);

  if (loopRec) {
    if (loopRec.phase === 'countin' && cur >= loopRec.startBeat) loopRec.phase = 'recording';
    if (cur >= loopRec.endBeat) loopFinalizeRecording();
  }

  for (const c of loopClips) loopScheduleClip(c, cur, to);

  loopRenderLive(cur);
  loopMaybeStopTicker();
}

function loopScheduleMetronome(cur, to) {
  let b = Math.max(0, Math.floor(cur));
  if (loopTransport._metroLastBeat != null && loopTransport._metroLastBeat >= b) {
    b = loopTransport._metroLastBeat + 1;
  }
  for (; b <= to + 1e-9; b++) {
    const at = loopBeatToAudio(b);
    if (at < audioCtx.currentTime - 0.005) { loopTransport._metroLastBeat = b; continue; }
    loopClick(at, b % loopTransport.beatsPerBar === 0);
    loopTransport._metroLastBeat = b;
  }
}

// Arm (start at the next bar) or stop a clip (stop at the next bar).
function loopToggleClip(id) {
  const c = loopClipById(id);
  if (!c) return;
  if (c.state === 'playing') {
    c.state = 'stopping';
    c._stopBeat = loopNextBarBeat();
  } else if (c.state === 'armed') {
    c.state = 'stopped';
    c._scheduledUntil = null;
  } else {
    loopEnsureTransport();
    const start = loopNextBarBeat();
    c.state = 'armed';
    c._startBeat = start;
    c._scheduledUntil = start;
    c._stopBeat = null;
  }
  loopRenderClipStates();
  loopMaybeStopTicker();
}

function loopScheduleClip(c, cur, to) {
  if (c.state === 'armed') {
    if (cur >= c._startBeat) {
      c.state = 'playing';
      c._scheduledUntil = c._startBeat;
      loopRenderClipStates();
    } else {
      return;
    }
  }
  if (c.state === 'stopping' && cur >= c._stopBeat) {
    loopStopClipNow(c);
    return;
  }
  if (c.state !== 'playing') return;

  const L = Math.max(1e-6, c.bars * loopTransport.beatsPerBar);
  let from = c._scheduledUntil != null ? c._scheduledUntil : c._startBeat;
  // Tolerate a little tick lateness so the downbeat isn't dropped, but never
  // replay a long backlog (e.g. after a pause) all at once.
  if (from < cur - 0.5) from = cur;
  const toBeat = to;
  if (toBeat <= from) return;

  for (const ev of c.events) {
    const base = c._startBeat + ev.startBeat;
    let k = Math.ceil((from - base) / L);
    if (k < 0) k = 0;
    for (;; k++) {
      const ab = base + k * L;
      if (ab > toBeat + 1e-9) break;
      if (ab < from - 1e-9) continue;
      loopPlayEvent(c, ev, loopBeatToAudio(ab));
    }
  }
  c._scheduledUntil = toBeat;
}

// Schedule one recorded note at an absolute audio time, using its clip's sound
// snapshot. The snapshot is swapped into the shared globals for the synchronous
// scheduling call and restored right after (no mutation happens on it).
function loopPlayEvent(c, ev, at) {
  const snap = c.sounds[ev.soundId];
  if (!snap) return;
  const ds = loopEventDs(ev, 60000 / loopTransport.bpm, c.id);
  const saved = flowGlobalsSwap(snap);
  try {
    schedulePathAudio(ds, ds.totalMs, null, at);
  } finally {
    flowGlobalsRestore(saved);
  }
}

// Rebuild a synthetic gesture for a recorded event: the stored normalized
// volume shape is mapped back through the CURRENT volume range (an exact
// inverse of baseVolumeFromY), so the drawn swells replay without depending on
// the screen size or the volume sliders used at record time.
function loopEventDs(ev, msPerBeat, group) {
  const pts = [], cum = [];
  const span = volumeTop() - VOLUME.bottom;
  for (let i = 0; i < ev.cumBeats.length; i++) {
    const g = VOLUME.bottom + span * clamp01(ev.vols[i] || 0);
    pts.push({ x: 0, y: yForBaseVolume(g) });
    cum.push(ev.cumBeats[i] * msPerBeat);
  }
  const totalMs = Math.max(MIN_GESTURE_MS, ev.endBeat * msPerBeat);
  return {
    startX: 0,
    startY: pts.length ? pts[0].y : H / 2,
    pts,
    cumTime: cum,
    totalMs,
    pitchOverride: ev.pitch,
    voiceGroup: group,
    lastMoveAt: 0,
    finished: false,
    playback: null,
  };
}

function loopStopClipNow(c) {
  c.state = 'stopped';
  c._scheduledUntil = null;
  // Fade this clip's still-ringing voices (scoped by voice group).
  for (const n of gestureNotes.slice()) {
    if (n.voiceGroup === c.id) quickFadeNote(n, 40);
  }
  loopRenderClipStates();
}

function loopStopAll() {
  if (loopRec) { loopRec = null; loopRenderRecordBtn(); }
  for (const c of loopClips) {
    if (c.state === 'playing' || c.state === 'armed' || c.state === 'stopping') loopStopClipNow(c);
  }
  loopRenderClipStates();
  loopMaybeStopTicker();
}

/* ---- Recording ---- */

// The record button toggles: press to start (count-in + N bars), press again
// to bail out early.
function loopStartRecording() {
  if (loopRec) { loopRec = null; loopRenderRecordBtn(); loopMaybeStopTicker(); return; }
  loopEnsureTransport();
  const bpb = loopTransport.beatsPerBar;
  const nextDown = loopNextBarBeat();
  const start = nextDown + bpb;             // one full bar of count-in
  const bars = loopTransport.barsToRecord;
  const remainingMs = (start - loopCurBeat()) * loopBeatDur() * 1000;
  loopRec = {
    phase: 'countin',
    startBeat: start,
    endBeat: start + bpb * bars,
    startPerf: performance.now() + remainingMs,
    bars,
    events: [],
    sounds: {},
  };
  loopRenderRecordBtn();
}

// Called by gesture.js the moment a gesture finishes. Captures the gesture as
// a clip event while a recording is live. No-op otherwise.
function loopCaptureGesture(ds) {
  if (!loopRec || loopRec.phase !== 'recording' || !ds || !ds.pts || !ds.pts.length) return;
  const bpm = loopTransport.bpm;
  const beatMs = 60000 / bpm;
  const loopMs = loopRec.bars * loopTransport.beatsPerBar * beatMs;
  const began = ds.beganAt != null ? ds.beganAt : performance.now();
  const startMs = began - loopRec.startPerf;
  if (!isFinite(startMs) || startMs < 0 || startMs >= loopMs) return;
  const ev = loopBuildEvent(ds, startMs, loopMs, bpm);
  if (!ev) return;
  ev.soundId = loopRecSoundId();
  loopRec.events.push(ev);
}

function loopBuildEvent(ds, startMs, loopMs, bpm) {
  const n = ds.pts.length;
  if (!n) return null;
  const beatMs = 60000 / bpm;
  const totalMs = Math.max(0, ds.totalMs || 0);
  const bodyMs = Math.min(Math.max(totalMs, MIN_GESTURE_MS), Math.max(1, loopMs - startMs));
  const N = Math.max(2, Math.min(CLIP_POINT_MAX, n));
  const cumBeats = [], vols = [];
  if (totalMs < MIN_GESTURE_MS) {
    // Near-instant gesture (a tap): sweep the recorded points by index so the
    // drawn Y shape still comes through over the minimum body length.
    for (let k = 0; k < N; k++) {
      const idx = Math.round((k / (N - 1)) * (n - 1));
      cumBeats.push((bodyMs * k / (N - 1)) / beatMs);
      vols.push(loopVolNormFromY(ds.pts[idx].y));
    }
  } else {
    for (let k = 0; k < N; k++) {
      const t = bodyMs * k / (N - 1);
      const st = pathStateAtTime(ds.pts, ds.cumTime, t);
      cumBeats.push(t / beatMs);
      vols.push(loopVolNormFromY(st.y));
    }
  }
  return {
    soundId: null,
    pitch: ds.pitchOverride || ds.pitch || pitchFor(ds.startX, ds.startY),
    startBeat: startMs / beatMs,
    endBeat: bodyMs / beatMs,
    cumBeats,
    vols,
  };
}

// The drawn base volume normalized against the current volume range (0 = the
// bottom gain, 1 = the top gain), so the shape is portable.
function loopVolNormFromY(y) {
  const span = volumeTop() - VOLUME.bottom;
  if (span <= 1e-6) return 0;
  return clamp01((baseVolumeFromY(y) - VOLUME.bottom) / span);
}

// Snapshot the active instrument's sound (shared globals are kept equal to the
// compiled active note by instrument.js) under its note id, once per recording.
function loopRecSoundId() {
  const id = (typeof instActiveId !== 'undefined' && instActiveId) ? instActiveId : '__default';
  if (!loopRec.sounds[id]) {
    let name = 'Default', color = '#78909c';
    const node = (typeof flowNodeById === 'function') ? flowNodeById(id) : null;
    if (node) {
      name = (typeof flowNoteName === 'function' && flowNoteName(node)) || 'Note';
      color = (typeof flowNoteColor === 'function' && flowNoteColor(node)) || color;
    }
    loopRec.sounds[id] = {
      name,
      color,
      envelope: clone(ENVELOPE),
      layers: clone(OSC_STACK.layers),
      masterPitchEnv: clone(MASTER_PITCH_ENV),
      masterVoiceEnvs: clone(MASTER_VOICE_ENVS),
    };
  }
  return id;
}

function loopFinalizeRecording() {
  const rec = loopRec;
  loopRec = null;
  loopRenderRecordBtn();
  const firstSound = rec.events.length ? rec.sounds[rec.events[0].soundId] : null;
  const clip = {
    id: 'clip-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
    name: 'Loop ' + (loopClips.length + 1),
    color: (firstSound && firstSound.color) || CLIP_COLORS[loopClips.length % CLIP_COLORS.length],
    bars: rec.bars,
    events: rec.events,
    sounds: rec.sounds,
    state: 'stopped',
    _startBeat: 0,
    _stopBeat: 0,
    _scheduledUntil: null,
  };
  loopClips.push(clip);
  loopSave();
  loopBuildPads();
  if (loopTransport.autoLoopAfterRecord && clip.events.length) {
    loopEnsureTransport();
    clip.state = 'armed';
    clip._startBeat = rec.endBeat;
    clip._scheduledUntil = rec.endBeat;
  }
  loopRenderClipStates();
}

/* ---- Metronome ---- */

function loopClick(when, accent) {
  if (!audioCtx || !masterGain) return;
  const t = Math.max(when, audioCtx.currentTime);
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = accent ? 1600 : 1050;
  const peak = accent ? 0.18 : 0.1;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.002);
  g.gain.linearRampToValueAtTime(0.0001, t + 0.05);
  osc.connect(g);
  g.connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.07);
  setTimeout(() => { try { osc.disconnect(); g.disconnect(); } catch (e) {} }, (t - audioCtx.currentTime + 0.25) * 1000);
}

/* ---- Persistence ---- */

function loopSave() {
  try {
    localStorage.setItem(CLIP_SAVE_KEY, JSON.stringify({
      clips: loopClips.map(c => ({
        id: c.id, name: c.name, color: c.color, bars: c.bars, events: c.events, sounds: c.sounds,
      })),
      transport: {
        bpm: loopTransport.bpm,
        beatsPerBar: loopTransport.beatsPerBar,
        metronome: loopTransport.metronome,
        barsToRecord: loopTransport.barsToRecord,
        autoLoopAfterRecord: loopTransport.autoLoopAfterRecord,
      },
    }));
  } catch (e) {}
}

function loopLoad() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(CLIP_SAVE_KEY) || 'null'); } catch (e) {}
  if (!d) return;
  const t = d.transport || {};
  if (t.bpm != null) loopTransport.bpm = Math.max(CLIP_BPM_MIN, Math.min(CLIP_BPM_MAX, Math.round(+t.bpm) || 120));
  if (t.beatsPerBar != null) loopTransport.beatsPerBar = Math.max(2, Math.min(12, Math.round(+t.beatsPerBar) || 4));
  loopTransport.metronome = !!t.metronome;
  if (CLIP_BARS_OPTIONS.indexOf(+t.barsToRecord) >= 0) loopTransport.barsToRecord = +t.barsToRecord;
  if (t.autoLoopAfterRecord != null) loopTransport.autoLoopAfterRecord = !!t.autoLoopAfterRecord;
  if (!Array.isArray(d.clips)) return;
  loopClips = d.clips.map((c, i) => {
    if (!c || !Array.isArray(c.events) || !c.sounds || typeof c.sounds !== 'object') return null;
    const bars = Math.max(1, Math.min(64, Math.round(+c.bars) || 1));
    const events = c.events.filter(ev => ev && Array.isArray(ev.cumBeats) && Array.isArray(ev.vols)
      && ev.cumBeats.length === ev.vols.length && c.sounds[ev.soundId]);
    return {
      id: c.id || ('clip-loaded-' + i),
      name: String(c.name || ('Loop ' + (i + 1))).slice(0, 40),
      color: c.color || CLIP_COLORS[i % CLIP_COLORS.length],
      bars,
      events,
      sounds: c.sounds,
      state: 'stopped',
      _startBeat: 0,
      _stopBeat: 0,
      _scheduledUntil: null,
    };
  }).filter(Boolean);
}

function loopClipById(id) {
  return loopClips.find(c => c.id === id) || null;
}

function loopDeleteClip(id) {
  const i = loopClips.findIndex(c => c.id === id);
  if (i < 0) return;
  const c = loopClips[i];
  if (!window.confirm('Delete "' + c.name + '"?\n\nThis removes the loop for good.')) return;
  loopStopClipNow(c);
  loopClips.splice(i, 1);
  loopSave();
  loopBuildPads();
  loopRenderClipStates();
}

/* ---- UI ---- */

function loopEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function loopBuildUI() {
  const bar = document.getElementById('clipBar');
  if (!bar) return;
  bar.innerHTML = '';
  bar.classList.remove('collapsed');
  document.body.classList.remove('clip-collapsed');

  const handle = loopEl('button', 'clip-handle', '▾');
  handle.id = 'clipHandle';
  handle.type = 'button';
  handle.title = 'Show/hide the loop clips';
  handle.addEventListener('click', () => {
    const collapsed = bar.classList.toggle('collapsed');
    document.body.classList.toggle('clip-collapsed', collapsed);
    handle.textContent = collapsed ? '▸' : '▾';
  });
  bar.appendChild(handle);

  const body = loopEl('div');
  body.id = 'clipBody';
  bar.appendChild(body);

  const tr = loopEl('div');
  tr.id = 'clipTransport';
  body.appendChild(tr);

  const tap = loopEl('button', 'clip-btn', 'TAP');
  tap.id = 'tapTempo';
  tap.type = 'button';
  tap.title = 'Tap each beat to set the tempo';
  tap.addEventListener('pointerdown', e => { e.preventDefault(); loopTapTempo(); });
  tr.appendChild(tap);
  loopBindTapReset(tap);

  const bpmDown = loopEl('button', 'clip-btn', '−');
  bpmDown.type = 'button';
  bpmDown.addEventListener('click', () => loopSetBpm(loopTransport.bpm - 1));
  tr.appendChild(bpmDown);

  const bpmInput = document.createElement('input');
  bpmInput.id = 'bpmInput';
  bpmInput.type = 'number';
  bpmInput.min = String(CLIP_BPM_MIN);
  bpmInput.max = String(CLIP_BPM_MAX);
  bpmInput.step = '1';
  bpmInput.title = 'Tempo (beats per minute)';
  bpmInput.addEventListener('change', () => loopSetBpm(+bpmInput.value));
  tr.appendChild(bpmInput);
  tr.appendChild(loopEl('span', 'clip-label', 'BPM'));

  const bpmUp = loopEl('button', 'clip-btn', '+');
  bpmUp.type = 'button';
  bpmUp.addEventListener('click', () => loopSetBpm(loopTransport.bpm + 1));
  tr.appendChild(bpmUp);

  tr.appendChild(loopSelect('beatsPerBar', 'Beats', [[2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6'], [7, '7'], [8, '8'], [9, '9'], [10, '10'], [11, '11'], [12, '12']],
    v => { loopTransport.beatsPerBar = +v; loopSave(); loopMaybeStopTicker(); }));
  tr.appendChild(loopSelect('barsToRecord', 'Bars', CLIP_BARS_OPTIONS.map(b => [b, String(b)]),
    v => { loopTransport.barsToRecord = +v; loopSave(); }));

  const metro = loopEl('button', 'clip-btn', '🥁 Metro');
  metro.id = 'metroToggle';
  metro.type = 'button';
  metro.title = 'Metronome click (off by default)';
  metro.addEventListener('click', () => {
    loopTransport.metronome = !loopTransport.metronome;
    loopTransport._metroLastBeat = Math.floor(loopCurBeat());
    if (loopTransport.metronome) loopEnsureTransport();
    loopSyncControls();
    loopSave();
    loopMaybeStopTicker();
  });
  tr.appendChild(metro);

  const autoLoop = loopEl('button', 'clip-btn', '🔁 Auto-loop');
  autoLoop.id = 'autoLoopToggle';
  autoLoop.type = 'button';
  autoLoop.title = 'Loop new recordings automatically';
  autoLoop.addEventListener('click', () => {
    loopTransport.autoLoopAfterRecord = !loopTransport.autoLoopAfterRecord;
    loopSyncControls();
    loopSave();
  });
  tr.appendChild(autoLoop);

  const rec = loopEl('button', 'clip-btn rec-btn', '⏺ Record');
  rec.id = 'recordBtn';
  rec.type = 'button';
  rec.addEventListener('click', loopStartRecording);
  tr.appendChild(rec);

  const stop = loopEl('button', 'clip-btn', '⏹ Stop all');
  stop.id = 'stopAllBtn';
  stop.type = 'button';
  stop.addEventListener('click', loopStopAll);
  tr.appendChild(stop);

  const beat = loopEl('span', 'clip-beat', '1.1');
  beat.id = 'clipBeat';
  tr.appendChild(beat);

  const pads = loopEl('div');
  pads.id = 'clipPads';
  body.appendChild(pads);
}

// A labelled <select> whose change reports the raw value.
function loopSelect(id, label, options, onChange) {
  const wrap = loopEl('span', 'clip-field');
  wrap.appendChild(loopEl('span', 'clip-label', label));
  const sel = document.createElement('select');
  sel.id = id;
  for (const [val, text] of options) sel.add(new Option(text, String(val)));
  sel.addEventListener('change', () => onChange(sel.value));
  wrap.appendChild(sel);
  return wrap;
}

function loopSyncControls() {
  const bpm = document.getElementById('bpmInput');
  if (bpm) bpm.value = String(loopTransport.bpm);
  const bpb = document.getElementById('beatsPerBar');
  if (bpb) bpb.value = String(loopTransport.beatsPerBar);
  const bars = document.getElementById('barsToRecord');
  if (bars) bars.value = String(loopTransport.barsToRecord);
  const metro = document.getElementById('metroToggle');
  if (metro) metro.classList.toggle('on', loopTransport.metronome);
  const auto = document.getElementById('autoLoopToggle');
  if (auto) auto.classList.toggle('on', loopTransport.autoLoopAfterRecord);
  loopRenderRecordBtn();
}

function loopBuildPads() {
  const wrap = document.getElementById('clipPads');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!loopClips.length) {
    wrap.appendChild(loopEl('div', 'clip-empty', 'Tap ⏺ Record to capture a loop'));
    return;
  }
  for (const c of loopClips) {
    const pad = loopEl('div', 'clip-pad');
    pad.dataset.id = c.id;
    pad.style.background = c.color;
    pad.appendChild(loopEl('div', 'clip-name', c.name));
    pad.appendChild(loopEl('div', 'clip-sub', c.bars + (c.bars === 1 ? ' bar' : ' bars')));
    pad.appendChild(loopEl('div', 'clip-fill'));

    const del = loopEl('button', 'clip-del', '✕');
    del.type = 'button';
    del.title = 'Delete clip';
    del.addEventListener('click', e => { e.stopPropagation(); loopDeleteClip(c.id); });
    pad.appendChild(del);

    let holdTimer = null, held = false;
    pad.addEventListener('pointerdown', () => {
      held = false;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { held = true; loopDeleteClip(c.id); }, CLIP_HOLD_DELETE);
    });
    const cancel = () => { clearTimeout(holdTimer); };
    pad.addEventListener('pointerup', () => {
      clearTimeout(holdTimer);
      if (!held) loopToggleClip(c.id);
    });
    pad.addEventListener('pointerleave', cancel);
    pad.addEventListener('pointercancel', cancel);
    wrap.appendChild(pad);
  }
}

function loopRenderClipStates() {
  const wrap = document.getElementById('clipPads');
  if (wrap) {
    for (const pad of wrap.querySelectorAll('.clip-pad')) {
      const c = loopClipById(pad.dataset.id);
      if (!c) continue;
      pad.classList.toggle('playing', c.state === 'playing');
      pad.classList.toggle('armed', c.state === 'armed');
      pad.classList.toggle('stopping', c.state === 'stopping');
    }
  }
}

function loopRenderRecordBtn() {
  const btn = document.getElementById('recordBtn');
  if (!btn) return;
  btn.classList.toggle('rec', !!loopRec);
  if (!loopRec) btn.textContent = '⏺ Record';
}

// Per-tick live UI: pad playhead fill, record countdown, bar.beat readout.
function loopRenderLive(cur) {
  const wrap = document.getElementById('clipPads');
  if (wrap) {
    for (const pad of wrap.querySelectorAll('.clip-pad')) {
      const c = loopClipById(pad.dataset.id);
      const fill = pad.querySelector('.clip-fill');
      if (!c || !fill) continue;
      if (c.state === 'playing') {
        const L = Math.max(1e-6, c.bars * loopTransport.beatsPerBar);
        const ph = (((cur - c._startBeat) % L) + L) % L / L;
        fill.style.width = (ph * 100).toFixed(1) + '%';
      } else {
        fill.style.width = '0%';
      }
    }
  }
  const rec = document.getElementById('recordBtn');
  if (rec && loopRec) {
    if (loopRec.phase === 'countin') rec.textContent = '⏳ ' + Math.max(0, Math.ceil(loopRec.startBeat - cur));
    else rec.textContent = '⏺ ' + Math.max(0, Math.ceil(loopRec.endBeat - cur));
  }
  const beat = document.getElementById('clipBeat');
  if (beat) {
    const bpb = loopTransport.beatsPerBar;
    const n = Math.max(0, Math.floor(cur));
    beat.textContent = (Math.floor(n / bpb) + 1) + '.' + ((n % bpb) + 1);
  }
}

/* ---- Tempo controls ---- */

function loopSetBpm(v) {
  const bpm = Math.max(CLIP_BPM_MIN, Math.min(CLIP_BPM_MAX, Math.round(+v) || 120));
  loopTransport.bpm = bpm;
  const input = document.getElementById('bpmInput');
  if (input) input.value = String(bpm);
  loopSave();
}

// Abandon an in-progress tap run without touching the BPM (a gap, or a tap on
// some other control).
function loopTapReset() {
  loopTaps = [];
  if (loopTapTimer) { clearTimeout(loopTapTimer); loopTapTimer = null; }
  loopRenderTapBtn();
}

// While a run is live the button lights up and counts the taps so far.
function loopRenderTapBtn() {
  const tap = document.getElementById('tapTempo');
  if (!tap) return;
  const n = loopTaps.length;
  tap.textContent = n > 0 ? 'TAP ' + n : 'TAP';
  tap.classList.toggle('on', n > 0);
}

// Tapping any control other than the TAP button drops the current run.
var loopTapDocBound = false;
function loopBindTapReset(tap) {
  if (loopTapDocBound) return;
  loopTapDocBound = true;
  document.addEventListener('pointerdown', e => {
    if (loopTaps.length && e.target !== tap && !tap.contains(e.target)) loopTapReset();
  }, true);
}

// One tap per beat. The run completes after `beatsPerBar` taps, then the BPM is
// derived from the first-to-last span (beatsPerBar − 1 intervals) and the run
// resets. A run left idle for TAP_RESET_MS also resets, leaving the BPM alone.
function loopTapTempo() {
  const now = performance.now();
  if (loopTaps.length && now - loopTaps[loopTaps.length - 1] > TAP_RESET_MS) loopTaps = [];
  loopTaps.push(now);

  if (loopTaps.length >= loopTransport.beatsPerBar) {
    const span = loopTaps[loopTaps.length - 1] - loopTaps[0];
    const intervals = loopTaps.length - 1;
    if (intervals > 0 && span > 0) loopSetBpm(60000 / (span / intervals));
    loopTapReset();
    return;
  }

  loopRenderTapBtn();
  if (loopTapTimer) clearTimeout(loopTapTimer);
  loopTapTimer = setTimeout(loopTapReset, TAP_RESET_MS);
}

/* ---- Boot ---- */

(function loopBoot() {
  loopBuildUI();
  loopLoad();
  loopBuildPads();
  loopSyncControls();
  loopRenderClipStates();
})();
