/* ============================================================
   Song Canvas — engine.js
   A small generative engine: sections describe a mood, the engine
   renders a continuous loop with a bar-level scheduler.
   No build step, no modules; exposes window.SongEngine.
   ============================================================ */
(function () {
  'use strict';

  const KEY_MIDI = 57; // A3

  const PROGRESSIONS = {
    bittersweet: { label: 'Bittersweet', roots: [0, 8, 3, 10], minor: [true, false, false, false] },
    dark:        { label: 'Dark',        roots: [0, 8, 5, 7],  minor: [true, true, true, false] },
    rising:      { label: 'Rising',      roots: [0, 3, 8, 10], minor: [true, false, false, false] },
    floating:    { label: 'Floating',    roots: [0, 7, 8, 3],  minor: [true, false, false, false] },
    open:        { label: 'Open',        roots: [0, 10, 8, 7], minor: [true, false, false, false] }
  };

  // Riff tiles: [16th step, chord-tone index, length in 16ths].
  // Chord-tone index is folded over the bar's chord, so every riff stays in key.
  const RIFFS = {
    lullaby: { label: 'Lullaby', steps: [[0, 0, 6], [8, 2, 6], [12, 1, 4]] },
    spark:   { label: 'Spark',   steps: [[0, 0, 2], [2, 2, 2], [4, 4, 2], [6, 2, 2], [8, 0, 2], [10, 2, 2], [12, 4, 2], [14, 6, 2]] },
    drive:   { label: 'Drive',   steps: [[0, 0, 1], [1, 2, 1], [2, 4, 1], [3, 2, 1], [4, 0, 1], [5, 2, 1], [6, 4, 1], [7, 5, 1], [8, 0, 1], [9, 2, 1], [10, 4, 1], [11, 2, 1], [12, 0, 1], [13, 2, 1], [14, 4, 1], [15, 5, 1]] },
    sparse:  { label: 'Sparse',  steps: [[0, 0, 8], [8, 4, 8]] },
    hook:    { label: 'Hook',    steps: [[0, 4, 2], [2, 2, 2], [4, 0, 2], [6, 2, 2], [8, 4, 2], [10, 4, 2], [12, 2, 2], [14, 1, 2]] },
    drift:   { label: 'Drift',   steps: [[0, 4, 4], [4, 2, 4], [8, 0, 4], [12, 1, 4]] }
  };

  const INSTRUMENTS = [
    { id: 'pad', label: 'Pad' },
    { id: 'pluck', label: 'Pluck' },
    { id: 'bass', label: 'Bass' },
    { id: 'drums', label: 'Drums' }
  ];

  const FLOWS = [
    { id: 'blend', label: 'Blend' },
    { id: 'lift', label: 'Lift' },
    { id: 'drift', label: 'Drift' }
  ];

  function section(over) {
    return Object.assign({
      name: 'Moment',
      bars: 2,
      pace: 0.45,
      energy: 0.35,
      brightness: 0.5,
      tension: 0.2,
      density: 0.4,
      space: 0.3,
      progression: 'bittersweet',
      riff: 'lullaby',
      flow: 'blend',
      instruments: { pad: true, pluck: true, bass: true, drums: true }
    }, over);
  }

  const song = {
    keyName: 'A minor',
    sections: [
      section({ name: 'Drift in', bars: 2, pace: 0.32, energy: 0.22, brightness: 0.34, tension: 0.14, density: 0.26, space: 0.42, progression: 'floating', riff: 'drift', instruments: { pad: true, pluck: true, bass: true, drums: false }, flow: 'blend' }),
      section({ name: 'Lift', bars: 2, pace: 0.5, energy: 0.52, brightness: 0.55, tension: 0.3, density: 0.52, space: 0.34, progression: 'bittersweet', riff: 'lullaby', flow: 'lift' }),
      section({ name: 'Bloom', bars: 2, pace: 0.62, energy: 0.74, brightness: 0.68, tension: 0.36, density: 0.7, space: 0.3, progression: 'rising', riff: 'hook', flow: 'lift' }),
      section({ name: 'Settle', bars: 2, pace: 0.4, energy: 0.34, brightness: 0.44, tension: 0.42, density: 0.34, space: 0.55, progression: 'open', riff: 'sparse', flow: 'blend' })
    ]
  };

  // ---------- audio ----------
  let ctx = null;
  let master, compressor, musicBus, musicFilter, drumsBus, revSend, dlySend, noiseBuf;
  let outBus = null;

  const S = {
    playing: false,
    nextBarTime: 0,
    barIndex: 0,
    timer: null,
    timeline: [],
    lastCutoff: 2200
  };

  function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function makeNoise(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function makeImpulse(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const n = Math.random() * 2 - 1;
        lp += 0.22 * (n - lp);
        d[i] = lp * Math.pow(1 - i / len, 2.6);
      }
    }
    return buf;
  }

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.8;
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 20;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.25;
    master.connect(compressor);
    compressor.connect(ctx.destination);

    musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.frequency.value = S.lastCutoff;
    musicFilter.Q.value = 0.4;
    musicFilter.connect(master);

    musicBus = ctx.createGain();
    musicBus.gain.value = 0.75;
    musicBus.connect(musicFilter);

    drumsBus = ctx.createGain();
    drumsBus.gain.value = 0.85;
    drumsBus.connect(master);

    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(2.4);
    const revRet = ctx.createGain();
    revRet.gain.value = 0.34;
    reverb.connect(revRet);
    revRet.connect(master);
    revSend = ctx.createGain();
    revSend.gain.value = 0.12;
    revSend.connect(reverb);

    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.29;
    const fb = ctx.createGain();
    fb.gain.value = 0.26;
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 2400;
    delay.connect(dlp);
    dlp.connect(fb);
    fb.connect(delay);
    const dlyRet = ctx.createGain();
    dlyRet.gain.value = 0.35;
    delay.connect(dlyRet);
    dlyRet.connect(master);
    dlySend = ctx.createGain();
    dlySend.gain.value = 0.08;
    dlySend.connect(delay);

    noiseBuf = makeNoise(1.2);
    return ctx;
  }

  function connectMusic(node) {
    node.connect(musicBus);
    wet(node, 0.75);
    node.connect(dlySend);
  }

  function wet(node, amount) {
    const g = ctx.createGain();
    g.gain.value = amount;
    node.connect(g);
    g.connect(revSend);
    return g;
  }

  function playNoise(t, dur, type, freq, gain) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g);
    src.start(t); src.stop(t + dur + 0.02);
    return g;
  }

  function kick(t, vel) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(155, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.13);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.85 * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g); g.connect(drumsBus);
    o.start(t); o.stop(t + 0.46);
  }

  function snare(t, vel) {
    const n = playNoise(t, 0.22, 'bandpass', 1900, 0.42 * vel);
    n.connect(drumsBus);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(196, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 * vel, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g); g.connect(drumsBus);
    o.start(t); o.stop(t + 0.14);
  }

  function hat(t, vel, open) {
    const n = playNoise(t, open ? 0.34 : 0.055, 'highpass', 7600, (open ? 0.14 : 0.1) * vel);
    n.connect(drumsBus);
    wet(n, 0.28);
  }

  function crash(t, vel) {
    const n = playNoise(t, 1.6, 'highpass', 4200, 0.18 * vel);
    n.connect(drumsBus);
    wet(n, 0.45);
  }

  function bass(freq, t, dur, vel) {
    const o = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'sawtooth'; o2.type = 'sine';
    o.frequency.value = freq;
    o2.frequency.value = freq / 2;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(260, t + dur);
    f.Q.value = 0.8;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * vel, t + 0.01);
    g.gain.setValueAtTime(0.22 * vel, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); o2.connect(f); f.connect(g);
    connectMusic(g);
    o.start(t); o2.start(t);
    o.stop(t + dur + 0.03); o2.stop(t + dur + 0.03);
  }

  function pluck(freq, t, dur, vel) {
    const o = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = 'triangle';
    o2.type = 'sawtooth';
    o.frequency.value = freq;
    o2.frequency.value = freq * 1.003;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(4200, t);
    f.frequency.exponentialRampToValueAtTime(900, t + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); o2.connect(f); f.connect(g);
    connectMusic(g);
    o.start(t); o2.start(t);
    o.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
  }

  function pad(freqs, t, dur, vel, cutoff) {
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(Math.min(6000, cutoff * 1.1), t);
    f.Q.value = 0.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05 * vel, t + 0.35);
    g.gain.setValueAtTime(0.05 * vel, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.25);
    for (const hz of freqs) {
      for (const cents of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz;
        o.detune.value = cents;
        o.connect(f);
        o.start(t); o.stop(t + dur + 0.3);
      }
    }
    f.connect(g);
    connectMusic(g);
  }

  function chord(t, sec, bi, barDur) {
    const prog = PROGRESSIONS[sec.progression] || PROGRESSIONS.bittersweet;
    const ci = bi % prog.roots.length;
    const root = KEY_MIDI + prog.roots[ci];
    const isMinor = prog.minor[ci];
    const third = isMinor ? 3 : 4;
    const tones = [0, third, 7];
    if (sec.tension > 0.45) tones.push(isMinor ? 10 : 11);
    if (sec.tension > 0.75) tones.push(14);
    return { root, tones, isMinor };
  }

  function cutoffFor(sec) {
    return 700 * Math.pow(2, sec.brightness * 3.4);
  }

  function barInfo(i) {
    let n = i;
    for (let s = 0; s < song.sections.length; s++) {
      const bars = Math.max(1, song.sections[s].bars | 0);
      if (n < bars) return { si: s, bi: n };
      n -= bars;
    }
    return { si: 0, bi: 0 };
  }

  function totalBars() {
    let n = 0;
    for (const s of song.sections) n += Math.max(1, s.bars | 0);
    return Math.max(1, n);
  }

  function tempoFor(sec) {
    return 62 + clamp01(sec.pace) * 56;
  }

  function scheduleBar(barIndex, t0) {
    const info = barInfo(barIndex);
    const sec = song.sections[info.si];
    if (!sec) return 3; // nothing to play yet
    const nextSec = song.sections[(info.si + 1) % song.sections.length];
    const bpm = tempoFor(sec);
    const barDur = (4 * 60) / bpm;
    const step = barDur / 16;
    const at = k => t0 + k * step;
    const cutoff = cutoffFor(sec);
    const vel = 0.55 + sec.energy * 0.45;

    musicFilter.frequency.setTargetAtTime(cutoff, t0, 0.15);
    revSend.gain.setTargetAtTime(0.03 + sec.space * 0.3, t0, 0.2);
    dlySend.gain.setTargetAtTime(sec.space * 0.24, t0, 0.2);
    S.lastCutoff = cutoff;

    const ch = chord(t0, sec, info.bi, barDur);
    const chordHz = ch.tones.map(i => midiHz(ch.root + i));
    const firstOfSection = info.bi === 0;
    const lastOfSection = info.bi === Math.max(1, sec.bars | 0) - 1;
    const drumsIn = sec.instruments.drums && !(sec.flow === 'drift' && firstOfSection);

    if (sec.instruments.pad) {
      pad(chordHz, t0, barDur * 0.94, 0.9 + sec.energy * 0.4, cutoff);
    }

    if (sec.instruments.bass) {
      const rootHz = midiHz(ch.root - 12);
      bass(rootHz, t0, barDur * 0.62, vel);
      if (sec.energy > 0.42) bass(rootHz, at(8), barDur * 0.42, vel * 0.85);
      if (sec.energy > 0.66) bass(midiHz(ch.root - 5), at(14), barDur * 0.22, vel * 0.7);
    }

    if (sec.instruments.pluck) {
      const riff = RIFFS[sec.riff] || RIFFS.lullaby;
      const tones = ch.tones;
      for (const [s, deg, len] of riff.steps) {
        if (sec.flow === 'drift' && firstOfSection && (s % 8) !== 0) continue;
        const note = ch.root + 12 + tones[deg % tones.length];
        const dur = Math.max(0.08, len * step * 0.9);
        pluck(midiHz(note), at(s), dur, vel * (0.8 + 0.2 * Math.random()));
      }
    }

    if (drumsIn) {
      const kicks = [0, 8];
      if (sec.energy > 0.55) kicks.push(11);
      if (sec.energy > 0.8) kicks.push(6);
      for (const k of kicks) kick(at(k), 0.8 * vel);

      snare(at(4), 0.72 * vel);
      snare(at(12), 0.7 * vel);
      if (sec.density > 0.68) snare(at(15), 0.22 * vel);

      const hatEvery = sec.density > 0.74 ? 1 : sec.density > 0.46 ? 2 : 4;
      for (let k = 0; k < 16; k += hatEvery) {
        const accent = k % 4 === 0 ? 1 : 0.62;
        hat(at(k), sec.energy * accent * 0.9 + 0.15, false);
      }
      if (sec.energy > 0.5) hat(at(14), 0.5, true);

      if (firstOfSection) crash(at(0), 0.5 + sec.energy * 0.5);

      if (lastOfSection && nextSec.flow === 'lift') {
        for (let k = 12; k < 16; k++) snare(at(k), (0.2 + (k - 12) * 0.14) * vel);
        const n = playNoise(t0 + barDur * 0.5, barDur * 0.5, 'highpass', 3000, 0.08);
        n.connect(drumsBus);
      }
    }

    return barDur;
  }

  function tick() {
    if (!S.playing || !ctx) return;
    while (S.nextBarTime < ctx.currentTime + 0.35) {
      const barIndex = S.barIndex;
      const info = barInfo(barIndex);
      const dur = scheduleBar(barIndex, S.nextBarTime);
      S.timeline.push({ barIndex, t0: S.nextBarTime, dur, si: info.si, bi: info.bi });
      if (S.timeline.length > 128) S.timeline.shift();
      S.nextBarTime += dur;
      S.barIndex = (barIndex + 1) % totalBars();
      if (S.barIndex === 0) {
        // drop history from the previous loop
        S.timeline = S.timeline.filter(e => e.t0 >= ctx.currentTime - 4);
      }
    }
  }

  function play() {
    ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (S.playing) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(0.8, t, 0.03);
    S.playing = true;
    S.barIndex = S.barIndex || 0;
    if (!S.nextBarTime || S.nextBarTime < ctx.currentTime) S.nextBarTime = ctx.currentTime + 0.08;
    S.timeline = [];
    tick();
    S.timer = setInterval(tick, 25);
  }

  function pause() {
    S.playing = false;
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    if (ctx) {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime(0.0001, t, 0.05);
    }
  }

  function restart() {
    const wasPlaying = S.playing;
    pause();
    S.barIndex = 0;
    S.nextBarTime = 0;
    S.timeline = [];
    setTimeout(() => { if (wasPlaying) play(); }, 120);
  }

  function position() {
    if (!ctx || !S.playing) return null;
    const now = ctx.currentTime;
    for (let i = S.timeline.length - 1; i >= 0; i--) {
      const e = S.timeline[i];
      if (now >= e.t0) {
        return {
          si: e.si,
          bi: e.bi,
          barProgress: Math.min(1, Math.max(0, (now - e.t0) / e.dur)),
          t0: e.t0,
          dur: e.dur
        };
      }
    }
    return null;
  }

  window.SongEngine = {
    song,
    PROGRESSIONS,
    RIFFS,
    INSTRUMENTS,
    FLOWS,
    section,
    ensureCtx,
    play,
    pause,
    restart,
    isPlaying: () => S.playing,
    position,
    context: () => ctx,
    tap: () => compressor,
    totalBars,
    tempoFor,
    cutoffFor,
    midiHz
  };
})();
