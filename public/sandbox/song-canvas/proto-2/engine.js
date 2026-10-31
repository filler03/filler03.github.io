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
    open:        { label: 'Open',        roots: [0, 10, 8, 7], minor: [true, false, false, false] },
    longing:     { label: 'Longing',     roots: [0, 5, 8, 7],  minor: [true, true, false, false] },
    hopeful:     { label: 'Hopeful',     roots: [0, 3, 8, 5],  minor: [true, false, false, true] },
    suspended:   { label: 'Suspended',   roots: [0, 7, 8, 5],  minor: [true, false, false, true] },
    driving:     { label: 'Driving',     roots: [0, 5, 10, 3], minor: [true, true, false, false] }
  };

  // Riff tiles: [16th step, chord-tone index, length in 16ths].
  // Chord-tone index is folded over the bar's chord, so every riff stays in key.
  const RIFFS = {
    lullaby: { label: 'Lullaby', steps: [[0, 0, 6], [8, 2, 6], [12, 1, 4]] },
    spark:   { label: 'Spark',   steps: [[0, 0, 2], [2, 2, 2], [4, 4, 2], [6, 2, 2], [8, 0, 2], [10, 2, 2], [12, 4, 2], [14, 6, 2]] },
    drive:   { label: 'Drive',   steps: [[0, 0, 1], [1, 2, 1], [2, 4, 1], [3, 2, 1], [4, 0, 1], [5, 2, 1], [6, 4, 1], [7, 5, 1], [8, 0, 1], [9, 2, 1], [10, 4, 1], [11, 2, 1], [12, 0, 1], [13, 2, 1], [14, 4, 1], [15, 5, 1]] },
    sparse:  { label: 'Sparse',  steps: [[0, 0, 8], [8, 4, 8]] },
    hook:    { label: 'Hook',    steps: [[0, 4, 2], [2, 2, 2], [4, 0, 2], [6, 2, 2], [8, 4, 2], [10, 4, 2], [12, 2, 2], [14, 1, 2]] },
    drift:   { label: 'Drift',   steps: [[0, 4, 4], [4, 2, 4], [8, 0, 4], [12, 1, 4]] },
    pulse:   { label: 'Pulse',   steps: [[0, 0, 2], [2, 4, 2], [4, 2, 2], [6, 4, 2], [8, 0, 2], [10, 4, 2], [12, 2, 2], [14, 4, 2]] },
    weave:   { label: 'Weave',   steps: [[0, 4, 3], [3, 2, 3], [6, 0, 2], [8, 4, 2], [10, 2, 2], [12, 0, 4]] },
    call:    { label: 'Call',    steps: [[0, 6, 4], [8, 4, 2], [10, 2, 2], [12, 0, 4]] },
    run:     { label: 'Run',     steps: [[0, 6, 1], [1, 5, 1], [2, 4, 1], [3, 3, 1], [4, 2, 1], [5, 1, 1], [6, 0, 2], [8, 4, 2], [10, 2, 2], [12, 0, 4]] }
  };

  const INSTRUMENTS = [
    { id: 'pad', label: 'Pad', hint: 'a bed of sound' },
    { id: 'keys', label: 'Keys', hint: 'electric piano stabs' },
    { id: 'strings', label: 'Strings', hint: 'slow bowed warmth' },
    { id: 'pluck', label: 'Pluck', hint: 'a repeating figure' },
    { id: 'bells', label: 'Bells', hint: 'high, ringing notes' },
    { id: 'bass', label: 'Bass', hint: 'the low end' },
    { id: 'drums', label: 'Drums', hint: 'the pulse' },
    { id: 'perc', label: 'Shaker', hint: 'offbeat texture' }
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
      swing: 0,
      human: 0.15,
      instruments: { pad: true, keys: false, strings: false, pluck: true, bells: false, bass: true, drums: true, perc: false }
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

  function buildGraph(target) {
    ctx = target;
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
    return target;
  }

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    return buildGraph(new AC());
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

  function keysVoice(freqs, t, dur, vel) {
    for (const hz of freqs) {
      const carrier = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      const g = ctx.createGain();
      carrier.type = 'sine';
      mod.type = 'sine';
      carrier.frequency.value = hz;
      mod.frequency.value = hz * 2;
      modGain.gain.setValueAtTime(hz * 0.9, t);
      modGain.gain.exponentialRampToValueAtTime(hz * 0.05, t + 0.35);
      mod.connect(modGain);
      modGain.connect(carrier.frequency);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08 * vel, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.25, dur));
      carrier.connect(g);
      connectMusic(g);
      carrier.start(t); mod.start(t);
      carrier.stop(t + dur + 0.1); mod.stop(t + dur + 0.1);
    }
  }

  function strings(freqs, t, dur, vel) {
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1600, t);
    f.frequency.linearRampToValueAtTime(2600, t + dur * 0.6);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05 * vel, t + 0.5);
    g.gain.setValueAtTime(0.05 * vel, t + dur * 0.78);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.35);
    for (const hz of freqs) {
      for (const cents of [-9, 0, 9]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz;
        o.detune.value = cents;
        o.connect(f);
        o.start(t); o.stop(t + dur + 0.4);
      }
    }
    f.connect(g);
    connectMusic(g);
  }

  function bell(freq, t, dur, vel) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.075 * vel, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [ratio, amp] of [[1, 1], [2.76, 0.5], [5.4, 0.22]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * ratio;
      const pg = ctx.createGain();
      pg.gain.value = amp;
      o.connect(pg); pg.connect(g);
      o.start(t); o.stop(t + dur + 0.05);
    }
    connectMusic(g);
  }

  function shaker(t, vel) {
    const n = playNoise(t, 0.09, 'highpass', 6200, 0.07 * vel);
    n.connect(drumsBus);
    wet(n, 0.2);
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
    return 900 * Math.pow(2, sec.brightness * 4.2);
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
    return scheduleBarFor(sec, info.bi, nextSec, t0);
  }

  function scheduleBarFor(sec, bi, nextSec, t0) {
    const bpm = tempoFor(sec);
    const barDur = (4 * 60) / bpm;
    const step = barDur / 16;
    const swing = clamp01(sec.swing || 0);
    const human = clamp01(sec.human || 0);
    const at = k => t0 + k * step + (k % 2 ? swing * step * 0.42 : 0);
    const jit = () => (Math.random() - 0.5) * step * 0.3 * human;
    const cutoff = cutoffFor(sec);
    const vel = 0.55 + sec.energy * 0.45;
    const inst = sec.instruments;

    musicFilter.frequency.setTargetAtTime(cutoff, t0, 0.15);
    revSend.gain.setTargetAtTime(0.03 + sec.space * 0.3, t0, 0.2);
    dlySend.gain.setTargetAtTime(sec.space * 0.24, t0, 0.2);
    S.lastCutoff = cutoff;

    const ch = chord(t0, sec, bi, barDur);
    const chordHz = ch.tones.map(i => midiHz(ch.root + i));
    const firstOfSection = bi === 0;
    const lastOfSection = bi === Math.max(1, sec.bars | 0) - 1;
    const drumsIn = inst.drums && !(sec.flow === 'drift' && firstOfSection);

    if (inst.pad) {
      pad(chordHz, t0, barDur * 0.94, 0.9 + sec.energy * 0.4, cutoff);
    }
    if (inst.strings) {
      strings(chordHz, t0, barDur * 0.95, 0.7 + sec.energy * 0.4);
    }
    if (inst.keys) {
      const stabs = chordHz.slice(0, 3);
      keysVoice(stabs, at(0) + jit(), barDur * 0.48, 0.75 + sec.energy * 0.35);
      if (sec.energy > 0.45) keysVoice(stabs, at(8) + jit(), barDur * 0.4, 0.62 + sec.energy * 0.3);
      if (sec.density > 0.65) keysVoice([chordHz[chordHz.length - 1]], at(14) + jit(), barDur * 0.2, 0.5);
    }

    if (inst.bass) {
      const rootHz = midiHz(ch.root - 12);
      bass(rootHz, t0, barDur * 0.62, vel);
      if (sec.energy > 0.42) bass(rootHz, at(8), barDur * 0.42, vel * 0.85);
      if (sec.energy > 0.66) bass(midiHz(ch.root - 5), at(14), barDur * 0.22, vel * 0.7);
    }

    if (inst.pluck) {
      const riff = RIFFS[sec.riff] || RIFFS.lullaby;
      const tones = ch.tones;
      for (const [s, deg, len] of riff.steps) {
        if (sec.flow === 'drift' && firstOfSection && (s % 8) !== 0) continue;
        const note = ch.root + 12 + tones[deg % tones.length];
        const dur = Math.max(0.08, len * step * 0.9);
        pluck(midiHz(note), at(s) + jit(), dur, vel * (0.8 + 0.2 * Math.random()));
      }
    }

    if (inst.bells) {
      const riff = RIFFS[sec.riff] || RIFFS.lullaby;
      const tones = ch.tones;
      for (let i = 0; i < riff.steps.length; i += 2) {
        const [s, deg, len] = riff.steps[i];
        const note = ch.root + 24 + tones[deg % tones.length];
        bell(midiHz(note), at(s) + jit(), Math.max(0.5, len * step * 1.7), 0.5 + sec.density * 0.4);
      }
    }

    if (inst.perc) {
      const every = sec.density > 0.7 ? 4 : 8;
      for (let k = 1; k < 16; k += 2) shaker(at(k) + jit(), 0.4 + sec.density * 0.5);
      if (every === 4) for (let k = 0; k < 16; k += 4) shaker(at(k) + jit(), 0.25);
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
        hat(at(k) + jit(), sec.energy * accent * 0.9 + 0.15, false);
      }
      if (sec.energy > 0.5) hat(at(14), 0.5, true);

      if (firstOfSection) crash(at(0), 0.5 + sec.energy * 0.5);

      if (lastOfSection && nextSec && nextSec.flow === 'lift') {
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

  function renderSong(items, opts) {
    opts = opts || {};
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC) return Promise.reject(new Error('Offline audio is not available in this browser.'));
    const sr = opts.sampleRate || 44100;
    const wasPlaying = S.playing;
    if (wasPlaying) {
      S.playing = false;
      if (S.timer) { clearInterval(S.timer); S.timer = null; }
    }
    const prev = { ctx, master, compressor, musicBus, musicFilter, drumsBus, revSend, dlySend, noiseBuf };

    let t = 0.1;
    const bars = [];
    for (let i = 0; i < items.length; i++) {
      const sec = items[i];
      const next = items[i + 1] || items[0];
      const n = Math.max(1, sec.bars | 0);
      for (let bi = 0; bi < n; bi++) {
        bars.push({ sec, bi, next, t });
        t += (4 * 60) / tempoFor(sec);
      }
    }
    const duration = t + 2.8;
    const off = new AC(2, Math.ceil(sr * duration), sr);
    buildGraph(off);
    for (const b of bars) scheduleBarFor(b.sec, b.bi, b.next, b.t);

    const restore = () => {
      ({ ctx, master, compressor, musicBus, musicFilter, drumsBus, revSend, dlySend, noiseBuf } = prev);
      if (wasPlaying) play();
    };
    return off.startRendering().then(buffer => {
      restore();
      return { buffer, duration };
    }, err => {
      restore();
      throw err;
    });
  }

  function wavBlob(buffer) {
    const channels = buffer.numberOfChannels;
    const len = buffer.length;
    const sr = buffer.sampleRate;
    const bytes = 44 + len * channels * 2;
    const ab = new ArrayBuffer(bytes);
    const v = new DataView(ab);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF'); v.setUint32(4, bytes - 8, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
    writeStr(36, 'data'); v.setUint32(40, len * channels * 2, true);
    const data = [];
    for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < channels; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
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
    renderSong,
    wavBlob,
    totalBars,
    tempoFor,
    cutoffFor,
    midiHz
  };
})();
