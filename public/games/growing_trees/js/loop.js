/* ============================================================
   loop.js — loopable track clips for the playing field.

   A live loop station layered over the gesture instrument:
   - A shared transport clock (audio-clock based) with a tap-tempo
     BPM, a time signature (beats per bar) and an
     optional metronome click (off until explicitly toggled on).
   - Record a clip: a 1-bar count-in, then N bars of freehand playing are
     captured. Each gesture becomes an event storing its absolute
     pitch, its start time and its full drawn volume shape (no
     quantization — the performance is kept as played).
   - Song mode: Start Song wipes the clips, runs a 1-bar count-in (metronome
     if enabled, otherwise a big on-screen counter), then an open-ended song.
     Tempo controls are hidden while a song runs. Stop Song lets the playing
     loops finish their current cycle first. The optional Record Song toggle
     captures the whole performance — live gestures PLUS every loop occurrence
     — into one take saved to the separate Songs screen for replay.
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
const SONG_SAVE_KEY = 'growingTrees.songs.v1';
const CLIP_POINT_MAX = 32;        // path points stored per recorded note (volume shape)
const CLIP_TICK_MS = 25;          // scheduler tick period
const CLIP_LOOKAHEAD_S = 0.2;     // how far ahead events are scheduled on the audio clock
const CLIP_BPM_MIN = 30, CLIP_BPM_MAX = 300;
const TAP_RESET_MS = 2000;        // a gap longer than this restarts tap tempo
const CLIP_HOLD_DELETE = 600;     // long-press a pad to delete it
const TIMELINE_MEASURES = 32;     // measures the song timeline spans across the screen
const CLIP_COLORS = ['#4fc3f7', '#f06292', '#ffb74d', '#81c784', '#ba68c8', '#64b5f6', '#e57373', '#4db6ac'];

var loopClips = [];               // saved/loaded clips, each with its own events + sound snapshots
var loopSongs = [];               // saved whole-song takes (the Songs screen)
var loopSong = null;              // active song session, or null
var loopSongReplay = null;        // active song replay, or null
var songViewActive = false;       // the Songs screen is open (freezes the transport)
var loopTicker = null;            // setInterval handle for the scheduler
var loopTaps = [];                // performance.now() of the taps in the current tap-tempo run
var loopTapTimer = null;          // visual reset timeout for an in-progress tap run

var loopTransport = {
  bpm: 120,
  beatsPerBar: 4,
  barsPerPhrase: 4,               // a phrase = this many measures (bars)
  metronome: false,
  recordSong: false,              // capture the whole song as one take
  running: false,                 // is the transport clock live?
  paused: false,                  // frozen while the flow editor / songs screen is open
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
  const busy = loopTransport.metronome || loopSong
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
  const paused = !!flowActive || songViewActive;
  if (paused !== loopTransport.paused) {
    if (paused) {
      loopTransport.paused = true;
      loopTransport.pauseAudioAt = audioCtx.currentTime;
    } else if (loopTransport.running) {
      const pauseMs = (audioCtx.currentTime - loopTransport.pauseAudioAt) * 1000;
      loopTransport.paused = false;
      loopTransport.originAudio += audioCtx.currentTime - loopTransport.pauseAudioAt;
      // Keep the song take's perf-clock mapping aligned after a freeze.
      if (loopSong) loopSong.startPerf += pauseMs;
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

  if (loopSong) {
    if (loopSong.phase === 'countin' && cur >= loopSong.startBeat) loopSong.phase = 'playing';
    if (loopSong.phase === 'ending' && cur >= loopSong.endAtBeat) loopFinishSong();
  }

  for (const c of loopClips) loopScheduleClip(c, cur, to);
  if (loopSong) loopSchedulePlacements(cur, to);
  if (loopSong) loopProcessCutQueue(cur);

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
      if (loopSong && loopSong.rec && loopTransport.recordSong
        && loopSong.phase !== 'countin' && ab >= loopSong.startBeat - 1e-9) {
        loopSongCapturePlayed(c, ev, ab - loopSong.startBeat);
      }
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
  for (const c of loopClips) {
    if (c.state === 'playing' || c.state === 'armed' || c.state === 'stopping') loopStopClipNow(c);
  }
  loopRenderClipStates();
  loopMaybeStopTicker();
}

// Universal Stop: end the song if one is running, otherwise silence everything
// (loops plus any ringing live/preview notes).
function loopStop() {
  if (loopSong) { loopStopSong(); return; }
  loopStopAll();
  stopGestureNote();
}

/* ---- Live capture ---- */

// Called by gesture.js the moment a gesture finishes. Feeds the song's
// continuous capture buffer and, when Record Song is on, the whole-song take.
// No-op outside a song.
function loopCaptureGesture(ds) {
  if (!ds || !ds.pts || !ds.pts.length) return;
  const bpm = loopTransport.bpm;
  const beatMs = 60000 / bpm;

  // Song: live gestures are captured continuously (for clip cuts) and, when
  // Record Song is on, also folded into the whole-song take.
  if (loopSong && loopSong.phase !== 'countin') {
    const began = ds.beganAt != null ? ds.beganAt : performance.now();
    const startMs = began - loopSong.startPerf;
    const endLimit = loopSong.endAtBeat != null
      ? (loopSong.endAtBeat - loopSong.startBeat) * beatMs : Infinity;
    if (isFinite(startMs) && startMs >= 0 && startMs < endLimit) {
      const ev = loopBuildEvent(ds, startMs, endLimit, bpm);
      if (ev) {
        loopAddBlip(startMs / beatMs, (startMs + (ds.totalMs || MIN_GESTURE_MS)) / beatMs,
          ev.pitch, loopActiveColor());
        if (loopSong.capture) {
          const cev = {
            soundId: loopSoundId(loopSong.capture), pitch: ev.pitch,
            startBeat: ev.startBeat, endBeat: ev.endBeat,
            cumBeats: ev.cumBeats.slice(), vols: ev.vols.slice(),
          };
          loopSong.capture.events.push(cev);
          // Bound memory: the timeline only reaches ~32 measures, so events far
          // behind the playhead can never be selected for a cut again.
          const keepFrom = ev.startBeat - 48 * loopTransport.beatsPerBar;
          if (keepFrom > 0) {
            loopSong.capture.events = loopSong.capture.events.filter(e => e.startBeat >= keepFrom);
          }
        }
        if (loopSong.rec && loopTransport.recordSong) {
          ev.soundId = loopSoundId(loopSong.rec);
          loopSong.rec.events.push(ev);
        }
      }
    }
  }
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
function loopSoundId(rec) {
  const id = (typeof instActiveId !== 'undefined' && instActiveId) ? instActiveId : '__default';
  if (!rec.sounds[id]) {
    let name = 'Default', color = '#78909c';
    const node = (typeof flowNodeById === 'function') ? flowNodeById(id) : null;
    if (node) {
      name = (typeof flowNoteName === 'function' && flowNoteName(node)) || 'Note';
      color = (typeof flowNoteColor === 'function' && flowNoteColor(node)) || color;
    }
    rec.sounds[id] = {
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

// Merge one loop occurrence the song take heard into the take's event list.
// The clip's sound snapshot is copied under a clip-scoped key so two clips that
// used the same instrument id stay distinct in the take.
function loopSongCapturePlayed(c, ev, beat) {
  const rec = loopSong.rec;
  const key = c.id + ':' + ev.soundId;
  if (!rec.sounds[key]) {
    const snap = c.sounds[ev.soundId];
    if (!snap) return;
    rec.sounds[key] = snap;
  }
  rec.events.push({
    soundId: key,
    pitch: ev.pitch,
    startBeat: beat,
    endBeat: ev.endBeat,
    cumBeats: ev.cumBeats,
    vols: ev.vols,
  });
}

/* ---- Song mode ----
   Start Song wipes the clips and runs a one-bar count-in, then an open-ended
   song. Tempo controls hide while it runs. Stop Song lets every playing loop
   finish its current cycle before ending. With Record Song on, the whole
   performance (live gestures + loop playback) is captured as one take saved to
   the Songs screen. */

function loopSongActive() { return !!loopSong; }

function loopStartSong() {
  if (loopSong) return;
  if (loopClips.length
    && !window.confirm('Start a new song?\n\nThis clears the current clips and saved clips.')) {
    return;
  }
  for (const c of loopClips) loopStopClipNow(c);
  loopClips = [];
  loopSave();
  loopBuildPads();

  loopEnsureTransport();
  const bpb = loopTransport.beatsPerBar;
  const nextDown = loopNextBarBeat();
  const start = nextDown + bpb;                 // one full bar of count-in
  const remainingMs = (start - loopCurBeat()) * loopBeatDur() * 1000;
  loopSong = {
    phase: 'countin',
    countStartBeat: nextDown,
    startBeat: start,
    endAtBeat: null,
    startPerf: performance.now() + remainingMs,
    rec: loopTransport.recordSong ? { events: [], sounds: {} } : null,
    capture: { events: [], sounds: {} },   // continuous live buffer for clip cuts
    sel: null,                    // measure selection { a, b } (0-based bars, inclusive)
    cuts: [],                     // queued cut segments { start, end } in song beats
    _drag: null,                  // in-progress timeline drag { x0, y0, bar, moved }
    placements: [],               // inserted clip instances { id, clipId, startBeat, _scheduledUntil }
    live: [],                     // recent live-note blips for the timeline
    _view: null,                  // last drawn { viewStart, pxPerBeat } for hit tests
  };
  loopUpdateTempoLock();
  loopRenderSongControls();
  loopBuildPads();
  loopRenderCountIn(loopCurBeat());
}

function loopStopSong() {
  if (!loopSong || loopSong.phase === 'ending') return;
  // Stopping during the count-in ends the (empty) song right away.
  if (loopSong.phase === 'countin') { loopFinishSong(); return; }
  const bpb = loopTransport.beatsPerBar;
  let end = loopNextBarBeat();                  // at least finish the current bar
  // Every playing clip plays out its current cycle first.
  for (const c of loopClips) {
    if (c.state === 'playing') {
      const L = Math.max(1e-6, c.bars * bpb);
      const cycleEnd = c._startBeat + (Math.floor((loopCurBeat() - c._startBeat) / L) + 1) * L;
      if (cycleEnd > end) end = cycleEnd;
      c.state = 'stopping';
      c._stopBeat = cycleEnd;
    } else if (c.state === 'armed') {
      c.state = 'stopped';
      c._scheduledUntil = null;
    }
  }
  loopSong.endAtBeat = end;
  loopSong.phase = 'ending';
  loopRenderClipStates();
  loopRenderSongControls();
}

function loopFinishSong() {
  const song = loopSong;
  loopSong = null;
  if (song.rec && song.rec.events.length) {
    let maxEnd = 0;
    for (const ev of song.rec.events) maxEnd = Math.max(maxEnd, ev.startBeat + ev.endBeat);
    const bars = Math.max(1, Math.ceil(maxEnd / loopTransport.beatsPerBar));
    const firstSound = song.rec.sounds[song.rec.events[0].soundId];
    loopSongs.push({
      id: 'song-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
      name: 'Song ' + (loopSongs.length + 1),
      createdAt: Date.now(),
      bpm: loopTransport.bpm,
      beatsPerBar: loopTransport.beatsPerBar,
      bars,
      events: song.rec.events,
      sounds: song.rec.sounds,
      color: (firstSound && firstSound.color) || CLIP_COLORS[loopSongs.length % CLIP_COLORS.length],
    });
    loopSaveSongs();
  }
  loopStopAll();
  loopBuildPads();
  loopUpdateTempoLock();
  loopRenderSongControls();
  loopRenderCountIn(0);
}

// Show/hide the tempo controls (TAP, BPM, Beats) while a song runs or the songs
// screen is open.
function loopUpdateTempoLock() {
  const tr = document.getElementById('clipTransport');
  if (tr) tr.classList.toggle('song-on', loopSongActive() || songViewActive);
  if (loopSongActive() && loopTaps.length) loopTapReset();
}

function loopRenderSongControls() {
  document.body.classList.toggle('song-run', !!loopSong);
  loopRenderRecordSongBtn();
  loopRenderCutControls();
  const b = document.getElementById('startSongBtn');
  if (!b) return;
  // Start Song is a pure start; a running song is ended with the Stop button.
  b.disabled = !!loopSong;
  b.textContent = '▶ Start Song';
  b.title = loopSong
    ? 'A song is running — press ⏹ Stop to end it'
    : 'Start a new song (counts in one bar, clears clips)';
}

// Big centered beat counter during the count-in (metronome handles the audio
// side, if it is on — this is visual either way).
function loopRenderCountIn(cur) {
  const el = document.getElementById('countIn');
  if (!el) return;
  if (loopSong && loopSong.phase === 'countin') {
    const remain = Math.max(1, Math.ceil(loopSong.startBeat - cur));
    el.textContent = String(remain);
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}

/* ---- Song library ---- */

function loopSaveSongs() {
  try {
    localStorage.setItem(SONG_SAVE_KEY, JSON.stringify(loopSongs.map(s => ({
      id: s.id, name: s.name, createdAt: s.createdAt, bpm: s.bpm,
      beatsPerBar: s.beatsPerBar, bars: s.bars, events: s.events,
      sounds: s.sounds, color: s.color,
    }))));
  } catch (e) {}
}

function loopLoadSongs() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(SONG_SAVE_KEY) || 'null'); } catch (e) {}
  if (!Array.isArray(d)) return;
  loopSongs = d.map((s, i) => {
    if (!s || !Array.isArray(s.events) || !s.sounds || typeof s.sounds !== 'object') return null;
    const events = s.events.filter(ev => ev && Array.isArray(ev.cumBeats) && Array.isArray(ev.vols)
      && ev.cumBeats.length === ev.vols.length && s.sounds[ev.soundId]);
    return {
      id: s.id || ('song-loaded-' + i),
      name: String(s.name || ('Song ' + (i + 1))).slice(0, 60),
      createdAt: +s.createdAt || Date.now(),
      bpm: Math.max(CLIP_BPM_MIN, Math.min(CLIP_BPM_MAX, Math.round(+s.bpm) || 120)),
      beatsPerBar: Math.max(2, Math.min(12, Math.round(+s.beatsPerBar) || 4)),
      bars: Math.max(1, Math.min(1024, Math.round(+s.bars) || 1)),
      events,
      sounds: s.sounds,
      color: s.color || CLIP_COLORS[i % CLIP_COLORS.length],
    };
  }).filter(Boolean);
}

function loopOpenSongs() {
  songViewActive = true;
  document.body.classList.add('songs');
  loopUpdateTempoLock();
  loopBuildSongList();
  loopMaybeStopTicker();
}

function loopCloseSongs() {
  loopStopReplay();
  songViewActive = false;
  document.body.classList.remove('songs');
  loopUpdateTempoLock();
  loopMaybeStopTicker();
}

function loopBuildSongList() {
  const wrap = document.getElementById('songList');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!loopSongs.length) {
    wrap.appendChild(loopEl('div', 'song-empty',
      'No songs yet — hit ▶ Start Song with 🎵 Record Song on to capture one.'));
    return;
  }
  for (const s of loopSongs) {
    const row = loopEl('div', 'song-row');
    row.style.borderLeftColor = s.color;
    const info = loopEl('div', 'song-info');
    info.appendChild(loopEl('div', 'song-name', s.name));
    const dur = s.bars + (s.bars === 1 ? ' bar' : ' bars');
    info.appendChild(loopEl('div', 'song-meta',
      s.bpm + ' BPM · ' + s.beatsPerBar + ' beats/bar · ' + dur));
    row.appendChild(info);

    const playing = loopSongReplay && loopSongReplay.songId === s.id;
    const play = loopEl('button', 'song-play' + (playing ? ' on' : ''), playing ? '⏹' : '▶');
    play.type = 'button';
    play.title = playing ? 'Stop' : 'Replay';
    play.addEventListener('click', () => {
      if (loopSongReplay && loopSongReplay.songId === s.id) loopStopReplay();
      else loopReplaySong(s);
    });
    row.appendChild(play);

    const del = loopEl('button', 'song-del', '🗑');
    del.type = 'button';
    del.title = 'Delete song';
    del.addEventListener('click', () => {
      if (!window.confirm('Delete "' + s.name + '"?\n\nThis cannot be undone.')) return;
      loopStopReplay();
      const i = loopSongs.findIndex(x => x.id === s.id);
      if (i >= 0) loopSongs.splice(i, 1);
      loopSaveSongs();
      loopBuildSongList();
    });
    row.appendChild(del);
    wrap.appendChild(row);
  }
}

// Replay a saved song once, straight to the audio clock (independent of the
// transport), so the songs screen can audition takes while everything is frozen.
function loopReplaySong(song) {
  loopStopReplay();
  initAudio();
  resumeAudio();
  if (!audioCtx || !masterGain) return;
  const beatDur = 60 / song.bpm;
  const t0 = audioCtx.currentTime + 0.15;
  const group = 'song-replay-' + Date.now().toString(36);
  let maxEnd = 0;
  for (const ev of song.events) {
    const snap = song.sounds[ev.soundId];
    if (!snap) continue;
    const ds = loopEventDs(ev, beatDur * 1000, group);
    const saved = flowGlobalsSwap(snap);
    try { schedulePathAudio(ds, ds.totalMs, null, t0 + ev.startBeat * beatDur); }
    finally { flowGlobalsRestore(saved); }
    maxEnd = Math.max(maxEnd, (ev.startBeat + ev.endBeat) * beatDur);
  }
  loopSongReplay = { group, songId: song.id };
  loopBuildSongList();
  const ms = (t0 + maxEnd - audioCtx.currentTime + 0.4) * 1000;
  setTimeout(() => {
    if (loopSongReplay && loopSongReplay.group === group) {
      loopSongReplay = null;
      loopBuildSongList();
    }
  }, ms);
}

function loopStopReplay() {
  if (!loopSongReplay) return;
  const g = loopSongReplay.group;
  for (const n of gestureNotes.slice()) {
    if (n.voiceGroup === g) quickFadeNote(n, 40);
  }
  loopSongReplay = null;
  loopBuildSongList();
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
        barsPerPhrase: loopTransport.barsPerPhrase,
        metronome: loopTransport.metronome,
        recordSong: loopTransport.recordSong,
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
  if (t.barsPerPhrase != null) loopTransport.barsPerPhrase = Math.max(1, Math.min(16, Math.round(+t.barsPerPhrase) || 4));
  loopTransport.metronome = !!t.metronome;
  if (t.recordSong != null) loopTransport.recordSong = !!t.recordSong;
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
  if (loopSong) loopSong.placements = loopSong.placements.filter(p => p.clipId !== id);
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

  // Tempo controls are grouped so a running song can hide them as one unit.
  const tempo = loopEl('span', 'tempo-group');
  tr.appendChild(tempo);

  const tap = loopEl('button', 'clip-btn', 'TAP');
  tap.id = 'tapTempo';
  tap.type = 'button';
  tap.title = 'Tap each beat to set the tempo';
  tap.addEventListener('pointerdown', e => { e.preventDefault(); loopTapTempo(); });
  tempo.appendChild(tap);
  loopBindTapReset(tap);

  const bpmDown = loopEl('button', 'clip-btn', '−');
  bpmDown.type = 'button';
  bpmDown.addEventListener('click', () => loopSetBpm(loopTransport.bpm - 1));
  tempo.appendChild(bpmDown);

  const bpmInput = document.createElement('input');
  bpmInput.id = 'bpmInput';
  bpmInput.type = 'number';
  bpmInput.min = String(CLIP_BPM_MIN);
  bpmInput.max = String(CLIP_BPM_MAX);
  bpmInput.step = '1';
  bpmInput.title = 'Tempo (beats per minute)';
  bpmInput.addEventListener('change', () => loopSetBpm(+bpmInput.value));
  tempo.appendChild(bpmInput);
  tempo.appendChild(loopEl('span', 'clip-label', 'BPM'));

  const bpmUp = loopEl('button', 'clip-btn', '+');
  bpmUp.type = 'button';
  bpmUp.addEventListener('click', () => loopSetBpm(loopTransport.bpm + 1));
  tempo.appendChild(bpmUp);

  tempo.appendChild(loopSelect('beatsPerBar', 'Beats per measure', [[2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6'], [7, '7'], [8, '8'], [9, '9'], [10, '10'], [11, '11'], [12, '12']],
    v => { loopTransport.beatsPerBar = +v; loopSave(); loopMaybeStopTicker(); }));

  // Phrase length is part of the locked grid, so it lives in the tempo group
  // (hidden while a song runs).
  tempo.appendChild(loopSelect('barsPerPhrase', 'Phrase', [[2, '2'], [3, '3'], [4, '4'], [6, '6'], [8, '8']],
    v => { loopTransport.barsPerPhrase = +v; loopSave(); loopDrawTimeline(); }));

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

  // Song clip cut: select measures on the timeline, then cut them into a clip.
  const cutGroup = loopEl('span');
  cutGroup.id = 'cutGroup';
  const cutBtn = loopEl('button', 'clip-btn', '✂ Cut Clip');
  cutBtn.id = 'cutClipBtn';
  cutBtn.type = 'button';
  cutBtn.title = 'Cut the selected measures into a clip';
  cutBtn.disabled = true;
  cutBtn.addEventListener('click', loopCutSelection);
  cutGroup.appendChild(cutBtn);
  tr.appendChild(cutGroup);

  const recSong = loopEl('button', 'clip-btn', '🎵 Record Song');
  recSong.id = 'recordSongToggle';
  recSong.type = 'button';
  recSong.title = 'Capture the whole performance as one take';
  recSong.addEventListener('click', () => {
    if (loopSong) return;   // locked once the song is running (icon-only then)
    loopTransport.recordSong = !loopTransport.recordSong;
    loopSyncControls();
    loopSave();
  });
  tr.appendChild(recSong);

  const startSong = loopEl('button', 'clip-btn', '▶ Start Song');
  startSong.id = 'startSongBtn';
  startSong.type = 'button';
  startSong.title = 'Start a new song (counts in one bar, clears clips)';
  startSong.addEventListener('click', loopStartSong);
  tr.appendChild(startSong);

  const stop = loopEl('button', 'clip-btn', '⏹ Stop');
  stop.id = 'stopBtn';
  stop.type = 'button';
  stop.title = 'Stop everything — ends the song, or silences any playing sounds';
  stop.addEventListener('click', loopStop);
  tr.appendChild(stop);

  const songs = loopEl('button', 'clip-btn', '🎵 Songs');
  songs.id = 'songsBtn';
  songs.type = 'button';
  songs.title = 'Past songs — replay';
  songs.addEventListener('click', loopOpenSongs);
  tr.appendChild(songs);

  const songClose = document.getElementById('songClose');
  if (songClose) songClose.addEventListener('click', loopCloseSongs);

  const beat = loopEl('span', 'clip-beat', '1.1');
  beat.id = 'clipBeat';
  tr.appendChild(beat);

  const arrange = loopEl('div');
  arrange.id = 'arrangePanel';
  const arrangeCanvas = document.createElement('canvas');
  arrangeCanvas.id = 'arrangeCanvas';
  arrangeCanvas.addEventListener('pointerdown', loopTimelineDown);
  arrangeCanvas.addEventListener('pointermove', loopTimelineMove);
  arrangeCanvas.addEventListener('pointerup', loopTimelineUp);
  arrangeCanvas.addEventListener('pointercancel', loopTimelineCancel);
  arrange.appendChild(arrangeCanvas);
  const arrangeTracks = loopEl('div');
  arrangeTracks.id = 'arrangeTracks';
  arrange.appendChild(arrangeTracks);
  body.appendChild(arrange);

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
  const phrase = document.getElementById('barsPerPhrase');
  if (phrase) phrase.value = String(loopTransport.barsPerPhrase);
  const metro = document.getElementById('metroToggle');
  if (metro) metro.classList.toggle('on', loopTransport.metronome);
  loopRenderSongControls();
  loopUpdateTempoLock();
}

// The Record Song toggle is locked (and shown as a plain recording icon) once a
// song is running, so it can't be flipped mid-take.
function loopRenderRecordSongBtn() {
  const b = document.getElementById('recordSongToggle');
  if (!b) return;
  if (loopSong) {
    b.disabled = true;
    b.classList.remove('on');
    b.classList.toggle('rec-icon', !!loopTransport.recordSong);
    b.textContent = '⏺';
    b.title = loopTransport.recordSong ? 'Recording the song' : 'Song recording is off';
  } else {
    b.disabled = false;
    b.classList.remove('rec-icon');
    b.classList.toggle('on', loopTransport.recordSong);
    b.textContent = '🎵 Record Song';
    b.title = 'Capture the whole performance as one take';
  }
}

function loopBuildPads() {
  if (loopSong) { loopBuildArrangement(); return; }
  const wrap = document.getElementById('clipPads');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!loopClips.length) {
    wrap.appendChild(loopEl('div', 'clip-empty', 'No clips — start a song and use Cut to make some'));
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

/* ---- Arrangement (song timeline + tracks) ----
   During a song the clip pads give way to a timeline canvas with three bands —
   a measure/phrase ruler, a live band (live gestures only) and a placement band
   below it — over a list of recorded track clips. Pressing Insert on a track
   drops a one-shot placement at the nearest upcoming measure; it shows as a block
   in the placement band and plays once (no forever-loop). A plain tap on a
   placement block removes it. */

function loopActiveColor() {
  if (typeof instActiveId !== 'undefined' && instActiveId && typeof flowNodeById === 'function') {
    const n = flowNodeById(instActiveId);
    if (n && typeof flowNoteColor === 'function') return flowNoteColor(n) || '#4fc3f7';
  }
  return '#4fc3f7';
}

function loopAddBlip(startBeat, endBeat, pitch, color) {
  if (!loopSong) return;
  loopSong.live.push({ startBeat, endBeat: Math.max(endBeat, startBeat + 0.06), pitch, color });
  if (loopSong.live.length > 600) loopSong.live.splice(0, loopSong.live.length - 600);
}

// Insert a clip instance at the measure nearest the playhead. The same clip
// can't be stacked on itself (no overlapping placements of one clip).
function loopInsertClip(clipId) {
  if (!loopSong || loopSong.phase === 'countin') return;
  const c = loopClipById(clipId);
  if (!c || !c.events.length) return;
  const m = loopTransport.beatsPerBar;
  const rel = loopCurBeat() - loopSong.startBeat;
  // Nearest measure, never behind the playhead (so the downbeat always sounds).
  let startBeat = Math.max(0, Math.round(rel / m) * m);
  if (startBeat < rel - 1e-6) startBeat += m;
  const len = Math.max(1e-6, c.bars * m);
  const overlaps = loopSong.placements.some(pl =>
    pl.clipId === clipId && startBeat < pl.startBeat + len && pl.startBeat < startBeat + len);
  if (overlaps) return;
  loopSong.placements.push({
    id: 'pl-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
    clipId, startBeat, _scheduledUntil: startBeat,
  });
  loopDrawTimeline();
}

function loopDeletePlacement(id) {
  if (!loopSong) return;
  const i = loopSong.placements.findIndex(p => p.id === id);
  if (i >= 0) loopSong.placements.splice(i, 1);
  loopDrawTimeline();
}

/* ---- Clip cuts ----
   During a song recording is continuous: live gestures stream into
   loopSong.capture. Tap or drag across the timeline to select a consecutive
   range of measures (future ones included); ✂ Cut Clip queues the segment and
   the captured notes become a new track clip once the playhead reaches its end.
   Several cuts can be queued; tapping a queued region cancels it. */

// Vertical bands of the timeline canvas (px).
const TIMELINE_RULER_H = 14;   // ruler strip along the top
const TIMELINE_LIVE_TOP = 14, TIMELINE_LIVE_BOT = 34;    // live gestures
const TIMELINE_PLACE_TOP = 36, TIMELINE_PLACE_BOT = 56;  // inserted clips

// Which measure (0-based, song-relative) sits under a canvas x.
function loopMeasureAtX(x) {
  const v = loopSong && loopSong._view;
  if (!v) return 0;
  const rel = v.viewStart + x / v.pxPerBeat;
  return Math.max(0, Math.floor(rel / loopTransport.beatsPerBar));
}

function loopTimelineDown(e) {
  if (!loopSong || !loopSong._view) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const bar = loopMeasureAtX(x);
  loopSong._drag = { x0: x, y0: e.clientY - rect.top, bar, moved: false };
  loopSong.sel = { a: bar, b: bar };
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
  loopDrawTimeline();
}

function loopTimelineMove(e) {
  const d = loopSong && loopSong._drag;
  if (!d) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (!d.moved && Math.abs(x - d.x0) < 4 && Math.abs(e.clientY - rect.top - d.y0) < 4) return;
  d.moved = true;
  const bar = loopMeasureAtX(x);
  loopSong.sel = { a: Math.min(d.bar, bar), b: Math.max(d.bar, bar) };
  loopDrawTimeline();
}

function loopTimelineUp(e) {
  const d = loopSong && loopSong._drag;
  if (!d) return;
  loopSong._drag = null;
  if (!d.moved) {
    // A plain tap: on a placement block it removes it, on a queued cut it cancels
    // it, otherwise keeps the single-measure selection made on pointerdown.
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y >= TIMELINE_PLACE_TOP && loopTapPlacement(x)) loopSong.sel = null;
    else if (y < TIMELINE_PLACE_TOP && loopTapQueuedCut(x)) loopSong.sel = null;
  }
  loopRenderCutControls();
  loopDrawTimeline();
}

// A cancelled pointer (browser took over) drops the drag without acting on it.
function loopTimelineCancel() {
  if (loopSong) loopSong._drag = null;
}

function loopTapQueuedCut(x) {
  const v = loopSong._view;
  for (let i = loopSong.cuts.length - 1; i >= 0; i--) {
    const x0 = (loopSong.cuts[i].start - v.viewStart) * v.pxPerBeat;
    const x1 = (loopSong.cuts[i].end - v.viewStart) * v.pxPerBeat;
    if (x >= x0 - 3 && x <= x1 + 3) {
      loopSong.cuts.splice(i, 1);
      loopRenderCutControls();
      return true;
    }
  }
  return false;
}

function loopTapPlacement(x) {
  const v = loopSong._view;
  for (let i = loopSong.placements.length - 1; i >= 0; i--) {
    const pl = loopSong.placements[i];
    const c = loopClipById(pl.clipId);
    if (!c) continue;
    const len = Math.max(1e-6, c.bars * loopTransport.beatsPerBar);
    const x0 = (pl.startBeat - v.viewStart) * v.pxPerBeat;
    const x1 = (pl.startBeat + len - v.viewStart) * v.pxPerBeat;
    if (x >= x0 - 3 && x <= x1 + 3) { loopDeletePlacement(pl.id); return true; }
  }
  return false;
}

// Queue the selected measures. The cut fires once the playhead reaches the end
// of the segment, so future measures can be queued and you can select the next
// range before time arrives. Duplicate segments are ignored.
function loopCutSelection() {
  if (!loopSong || loopSong.phase === 'countin' || !loopSong.sel) return;
  const m = loopTransport.beatsPerBar;
  const start = loopSong.sel.a * m, end = (loopSong.sel.b + 1) * m;
  if (!loopSong.cuts.some(q => q.start === start && q.end === end)) {
    loopSong.cuts.push({ start, end });
  }
  loopSong.sel = null;
  loopRenderCutControls();
  loopDrawTimeline();
}

// Fire any queued cuts whose segment has finished playing.
function loopProcessCutQueue(cur) {
  if (!loopSong || !loopSong.cuts.length) return;
  const rel = cur - loopSong.startBeat;
  let fired = false;
  for (let i = loopSong.cuts.length - 1; i >= 0; i--) {
    if (rel >= loopSong.cuts[i].end - 1e-6) {
      loopCutClip(loopSong.cuts[i]);
      loopSong.cuts.splice(i, 1);
      fired = true;
    }
  }
  if (fired) { loopRenderCutControls(); loopDrawTimeline(); }
}

// Emit the notes captured across a segment as a new track clip.
function loopCutClip(seg) {
  const bpb = loopTransport.beatsPerBar;
  const picked = loopSong.capture.events.filter(ev =>
    ev.startBeat >= seg.start - 1e-6 && ev.startBeat < seg.end - 1e-6);
  if (!picked.length) return;
  const bars = Math.max(1, Math.round((seg.end - seg.start) / bpb));
  const events = picked.map(ev => ({
    soundId: ev.soundId, pitch: ev.pitch,
    startBeat: ev.startBeat - seg.start, endBeat: ev.endBeat,
    cumBeats: ev.cumBeats, vols: ev.vols,
  }));
  const firstSound = loopSong.capture.sounds[events[0].soundId];
  loopClips.push({
    id: 'clip-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
    name: (bars === 1 ? 'Measure ' : 'Clip ') + (loopClips.length + 1),
    color: (firstSound && firstSound.color) || CLIP_COLORS[loopClips.length % CLIP_COLORS.length],
    bars,
    events,
    sounds: loopSong.capture.sounds,
    state: 'stopped', _startBeat: 0, _stopBeat: 0, _scheduledUntil: null,
  });
  loopSave();
  loopBuildPads();
}

function loopRenderCutControls() {
  const b = document.getElementById('cutClipBtn');
  if (!b) return;
  const can = !!loopSong && loopSong.phase !== 'countin' && !!loopSong.sel;
  b.disabled = !can;
  b.classList.toggle('on', can);
}

// Schedule every inserted instance's events once, in the lookahead window.
function loopSchedulePlacements(cur, to) {
  if (!loopSong || !loopSong.placements.length || loopSong.phase === 'countin') return;
  const bpb = loopTransport.beatsPerBar;
  const songCur = cur - loopSong.startBeat;
  const songTo = to - loopSong.startBeat;
  for (const pl of loopSong.placements) {
    const c = loopClipById(pl.clipId);
    if (!c) continue;
    const len = Math.max(1e-6, c.bars * bpb);
    let from = pl._scheduledUntil != null ? pl._scheduledUntil : pl.startBeat;
    if (from < songCur) from = songCur;   // don't dump a backlog after a pause
    for (const ev of c.events) {
      const base = pl.startBeat + ev.startBeat;
      if (base < from - 1e-9 || base > songTo + 1e-9) continue;
      if (base >= pl.startBeat + len - 1e-9) continue;
      loopPlayEvent(c, ev, loopBeatToAudio(loopSong.startBeat + base));
      loopAddBlip(base, base + ev.endBeat, ev.pitch,
        (c.sounds[ev.soundId] && c.sounds[ev.soundId].color) || c.color);
      if (loopSong.rec && loopTransport.recordSong) loopSongCapturePlayed(c, ev, base);
    }
    pl._scheduledUntil = songTo;
  }
}

function loopBuildArrangement() {
  const wrap = document.getElementById('arrangeTracks');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!loopClips.length) {
    wrap.appendChild(loopEl('div', 'track-empty', 'Select measures and hit ✂ Cut Clip to make a track'));
    requestAnimationFrame(loopDrawTimeline);
    return;
  }
  for (const c of loopClips) {
    const row = loopEl('div', 'clip-track');
    row.appendChild(loopEl('span', 'track-name', c.name));

    const plot = loopEl('span', 'track-plot');
    const cv = document.createElement('canvas');
    cv.className = 'track-canvas';
    cv.dataset.clip = c.id;
    plot.appendChild(cv);
    row.appendChild(plot);

    const chips = loopEl('span', 'track-chips');
    const seen = {};
    for (const ev of c.events) {
      const s = c.sounds[ev.soundId];
      const col = (s && s.color) || c.color;
      if (seen[col]) continue;
      seen[col] = 1;
      const chip = loopEl('span', 'track-chip');
      chip.style.background = col;
      chips.appendChild(chip);
    }
    row.appendChild(chips);

    const ins = loopEl('button', 'track-btn ins', '⤓ Insert');
    ins.type = 'button';
    ins.title = 'Insert at the nearest measure';
    ins.addEventListener('click', () => loopInsertClip(c.id));
    row.appendChild(ins);

    const del = loopEl('button', 'track-btn del', '✕');
    del.type = 'button';
    del.title = 'Delete track';
    del.addEventListener('click', () => loopDeleteClip(c.id));
    row.appendChild(del);

    wrap.appendChild(row);
    loopDrawTrackCanvas(cv, c);
  }
  // Redraw once laid out, so the canvases take their real flex width.
  requestAnimationFrame(() => {
    for (const cv of wrap.querySelectorAll('.track-canvas')) {
      const c = loopClipById(cv.dataset.clip);
      if (c) loopDrawTrackCanvas(cv, c);
    }
    loopDrawTimeline();
  });
}

// A track's whole clip drawn small: x = time within the clip, y = pitch, colour
// = instrument.
function loopDrawTrackCanvas(canvas, c) {
  const cssW = canvas.clientWidth || 120, cssH = 18;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const len = Math.max(1e-6, c.bars * loopTransport.beatsPerBar);
  const midis = c.events.map(ev => (typeof noteToMidi === 'function' ? noteToMidi(ev.pitch) : 60));
  let lo = 127, hi = 0;
  for (const m of midis) if (isFinite(m)) { lo = Math.min(lo, m); hi = Math.max(hi, m); }
  if (hi <= lo) { lo = 48; hi = 72; } else { const pad = (hi - lo) * 0.15; lo -= pad; hi += pad; }
  for (let i = 0; i < c.events.length; i++) {
    const ev = c.events[i];
    const col = (c.sounds[ev.soundId] && c.sounds[ev.soundId].color) || c.color;
    const x0 = (ev.startBeat / len) * cssW;
    const x1 = Math.min(cssW, ((ev.startBeat + Math.max(ev.endBeat, 0.04)) / len) * cssW);
    const f = (midis[i] - lo) / Math.max(1e-6, hi - lo);
    const y = cssH - 2 - f * (cssH - 4);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = col;
    ctx.fillRect(x0, y - 1, Math.max(2, x1 - x0), 2);
  }
  ctx.globalAlpha = 1;
}

function loopDrawTimeline() {
  const canvas = document.getElementById('arrangeCanvas');
  if (!canvas) return;
  const cssW = canvas.clientWidth || 300, cssH = 58;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!loopSong) return;

  const bpb = loopTransport.beatsPerBar;
  const barsPerPhrase = Math.max(1, loopTransport.barsPerPhrase);
  // A fixed, slow scroll: ~32 measures span the whole screen width.
  const windowBeats = TIMELINE_MEASURES * bpb;
  const pxPerBeat = cssW / windowBeats;
  const pxPerBar = pxPerBeat * bpb;
  const curRel = loopCurBeat() - loopSong.startBeat;
  const viewStart = curRel - 0.30 * windowBeats;
  loopSong._view = { viewStart, pxPerBeat };
  const X = b => (b - viewStart) * pxPerBeat;

  const rH = TIMELINE_RULER_H;
  const liveTop = TIMELINE_LIVE_TOP, liveBot = TIMELINE_LIVE_BOT;
  const placeTop = TIMELINE_PLACE_TOP, placeBot = TIMELINE_PLACE_BOT;
  const pitchY = (pitch) => {
    let midi = (typeof noteToMidi === 'function') ? noteToMidi(pitch) : 60;
    if (!isFinite(midi)) midi = 60;
    const f = clamp01((midi - 36) / (84 - 36));
    return liveBot - 1 - f * (liveBot - liveTop - 2);
  };

  // Band backgrounds.
  ctx.fillStyle = '#eef8e3';
  ctx.fillRect(0, 0, cssW, rH);
  ctx.fillStyle = '#fbfdf8';
  ctx.fillRect(0, liveTop, cssW, liveBot - liveTop);
  ctx.fillStyle = '#f1f7ea';
  ctx.fillRect(0, placeTop, cssW, placeBot - placeTop);
  ctx.textBaseline = 'middle';

  // Selection highlight (ruler + live band).
  if (loopSong.sel) {
    const sx0 = X(loopSong.sel.a * bpb);
    const sx1 = X((loopSong.sel.b + 1) * bpb);
    ctx.fillStyle = 'rgba(179,70,44,0.16)';
    ctx.fillRect(sx0, 0, sx1 - sx0, liveBot);
    ctx.strokeStyle = '#b3462c';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx0 + 0.5, 0.5, Math.max(0, sx1 - sx0 - 1), liveBot - 1);
  }
  // Queued cuts (dashed).
  ctx.save();
  ctx.setLineDash([4, 3]);
  for (const cut of loopSong.cuts) {
    const qx0 = X(cut.start), qx1 = X(cut.end);
    ctx.fillStyle = 'rgba(179,70,44,0.10)';
    ctx.fillRect(qx0, 0, qx1 - qx0, liveBot);
    ctx.strokeStyle = '#b3462c';
    ctx.lineWidth = 1;
    ctx.strokeRect(qx0 + 0.5, 0.5, Math.max(0, qx1 - qx0 - 1), liveBot - 1);
    if (qx1 - qx0 > 14) {
      ctx.fillStyle = '#b3462c';
      ctx.font = '700 8px sans-serif';
      ctx.fillText('✂', qx0 + 3, rH - 3);
    }
  }
  ctx.restore();

  // Ruler ticks + labels.
  const firstBar = Math.floor(viewStart / bpb) - 1;
  const lastBar = Math.ceil((viewStart + windowBeats) / bpb) + 1;
  const labelEvery = pxPerBar >= 22 ? 1 : (pxPerBar >= 13 ? 2 : 4);
  for (let bar = firstBar; bar <= lastBar; bar++) {
    if (bar < 0) continue;
    const x = X(bar * bpb);
    const phrase = (bar % barsPerPhrase) === 0;
    ctx.strokeStyle = phrase ? 'rgba(46,93,52,0.55)' : 'rgba(46,93,52,0.14)';
    ctx.lineWidth = phrase ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x, phrase ? 0 : 9);
    ctx.lineTo(x, placeBot);
    ctx.stroke();
    if (phrase || bar % labelEvery === 0) {
      ctx.fillStyle = phrase ? '#2e5d34' : 'rgba(46,93,52,0.5)';
      ctx.font = phrase ? '800 9px sans-serif' : '600 8px sans-serif';
      ctx.fillText(phrase ? ('P' + (Math.floor(bar / barsPerPhrase) + 1)) : String(bar + 1),
        x + 2, phrase ? 6 : 12);
    }
  }

  // Live gestures only, in the live band.
  const keep = [];
  for (const bl of loopSong.live) {
    const x0 = X(bl.startBeat), x1 = X(bl.endBeat);
    if (x1 < -20) continue;
    if (x0 > cssW + 20) { keep.push(bl); continue; }
    const y = pitchY(bl.pitch);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = bl.color || '#4fc3f7';
    ctx.fillRect(x0, y - 1.1, Math.max(2, x1 - x0), 2.2);
    keep.push(bl);
  }
  if (keep.length !== loopSong.live.length) loopSong.live = keep;
  ctx.globalAlpha = 1;

  // Inserted clips, in the placement band below the live timeline.
  for (const pl of loopSong.placements) {
    const c = loopClipById(pl.clipId);
    if (!c) continue;
    const len = Math.max(1e-6, c.bars * bpb);
    const x0 = X(pl.startBeat), x1 = X(pl.startBeat + len);
    if (x1 < -20 || x0 > cssW + 20) continue;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = c.color;
    ctx.fillRect(x0, placeTop + 1, Math.max(2, x1 - x0), placeBot - placeTop - 2);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, placeTop + 1.5, Math.max(1, x1 - x0 - 1), placeBot - placeTop - 3);
  }

  // Playhead across everything.
  const px = X(curRel);
  ctx.strokeStyle = '#b3462c';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, placeBot);
  ctx.stroke();
  ctx.fillStyle = '#b3462c';
  ctx.beginPath();
  ctx.moveTo(px - 3.5, 0);
  ctx.lineTo(px + 3.5, 0);
  ctx.lineTo(px, 5);
  ctx.closePath();
  ctx.fill();

  if (loopSong.phase === 'countin') {
    const remain = Math.max(1, Math.ceil(loopSong.startBeat - loopCurBeat()));
    ctx.fillStyle = 'rgba(46,93,52,0.78)';
    ctx.font = '800 11px sans-serif';
    ctx.fillText('count-in ' + remain, 6, liveBot - 7);
  }
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
  const beat = document.getElementById('clipBeat');
  if (beat) {
    const bpb = loopTransport.beatsPerBar;
    // While a song is live the readout counts from its count-in / downbeat.
    const base = loopSong
      ? (loopSong.phase === 'countin' ? loopSong.countStartBeat : loopSong.startBeat) : 0;
    const n = Math.max(0, Math.floor(cur - base));
    beat.textContent = (Math.floor(n / bpb) + 1) + '.' + ((n % bpb) + 1);
  }
  loopRenderCountIn(cur);
  if (loopSong) { loopRenderCutControls(); loopDrawTimeline(); }
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
  loopLoadSongs();
  loopBuildPads();
  loopSyncControls();
  loopRenderClipStates();
})();
