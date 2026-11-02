(() => {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const NOTE_MIDI = 48;
  const HOLD_MS = 6200;
  const RELEASE_MS = 1300;
  const GAP_MS = 500;
  const STORAGE_INSTR = 'songcanvas.instruments.v1';
  const STORAGE_LIKES = 'songcanvas.timbre.likes.v1';
  const OPENING = ['filter', 'space', 'body', 'motion', 'character', 'filter', 'body', 'motion'];
  const AXIS_LABELS = [
    ['bright', 'Brightness'], ['body', 'Body'], ['motion', 'Motion'],
    ['space', 'Space'], ['grit', 'Grit']
  ];
  const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
  const WAVE_BRIGHT = { sine: 0.08, triangle: 0.3, sawtooth: 0.66, square: 0.82 };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clamp01 = v => clamp(v, 0, 1);
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const clone = obj => JSON.parse(JSON.stringify(obj));
  const midiName = m => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
  const fmtCut = hz => hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;

  function initTimbre() {
    return {
      name: 'Timbre',
      osc1: { on: true, wave: 'sawtooth', octave: 0, detune: 0, level: 0.6 },
      osc2: { on: false, wave: 'sine', octave: -1, detune: 7, level: 0.25 },
      noise: { on: false, level: 0.12 },
      filter: { type: 'lowpass', cutoff: 2200, q: 1.2, envAmount: 0, env: { a: 0.01, d: 0.45, s: 0.35, r: 0.5 } },
      lfo: { on: false, wave: 'sine', rate: 4.2, depth: 0.16, target: 'filter' },
      fx: { drive: 0.06, chorus: 0.1, delay: 0, delayTime: 0.32, reverb: 0.18 },
      amp: { a: 0.35, d: 0.25, s: 1, r: 1.2 },
      master: { level: 0.72 }
    };
  }

  function merge(base, extra) {
    return Object.assign({}, base, extra || {});
  }

  function touchFields(p) {
    const d = initTimbre();
    p.osc1 = merge(d.osc1, p.osc1);
    p.osc2 = merge(d.osc2, p.osc2);
    p.noise = merge(d.noise, p.noise);
    p.filter = merge(d.filter, p.filter);
    p.filter.env = merge(d.filter.env, p.filter.env);
    p.lfo = merge(d.lfo, p.lfo);
    p.fx = merge(d.fx, p.fx);
    p.amp = merge(d.amp, p.amp);
    p.master = merge(d.master, p.master);
    return p;
  }

  function normalizeTimbre(input) {
    const p = touchFields(clone(input));
    const d = initTimbre();
    p.name = typeof p.name === 'string' ? p.name : 'Timbre';
    p.osc1.wave = WAVES.includes(p.osc1.wave) ? p.osc1.wave : d.osc1.wave;
    p.osc2.wave = WAVES.includes(p.osc2.wave) ? p.osc2.wave : d.osc2.wave;
    p.osc1.octave = clamp(Math.round(p.osc1.octave), -2, 2);
    p.osc2.octave = clamp(Math.round(p.osc2.octave), -2, 2);
    p.osc1.detune = clamp(p.osc1.detune, -30, 30);
    p.osc2.detune = clamp(p.osc2.detune, -30, 30);
    p.osc1.level = clamp(p.osc1.level, 0, 0.85);
    p.osc2.level = clamp(p.osc2.level, 0, 0.85);
    p.osc1.on = !!p.osc1.on;
    p.osc2.on = !!p.osc2.on;
    p.noise.on = !!p.noise.on;
    p.noise.level = clamp(p.noise.level, 0, 0.26);
    p.filter.type = ['lowpass', 'bandpass', 'highpass'].includes(p.filter.type) ? p.filter.type : 'lowpass';
    p.filter.q = clamp(p.filter.q, 0.3, 7);
    if (p.filter.type === 'highpass') p.filter.cutoff = clamp(p.filter.cutoff, 250, 3600);
    else if (p.filter.type === 'bandpass') p.filter.cutoff = clamp(p.filter.cutoff, 300, 7200);
    else p.filter.cutoff = clamp(p.filter.cutoff, 300, 12000);
    p.filter.envAmount = 0;
    p.filter.env = { a: 0.01, d: 0.45, s: 0.35, r: 0.5 };
    if (!p.osc1.on && !p.osc2.on && !p.noise.on) p.osc1.on = true;
    const sum = (p.osc1.on ? p.osc1.level : 0) + (p.osc2.on ? p.osc2.level : 0) + (p.noise.on ? p.noise.level * 0.65 : 0);
    if (sum > 1.12) {
      const k = 1.12 / sum;
      p.osc1.level *= k;
      p.osc2.level *= k;
      p.noise.level *= k;
    } else if (sum < 0.34) {
      const k = 0.5 / Math.max(0.18, sum);
      p.osc1.level = clamp(p.osc1.level * k, 0, 0.85);
      p.osc2.level = clamp(p.osc2.level * k, 0, 0.85);
      p.noise.level = clamp(p.noise.level * k, 0, 0.26);
    }
    p.lfo.on = !!p.lfo.on;
    p.lfo.wave = ['sine', 'triangle', 'square'].includes(p.lfo.wave) ? p.lfo.wave : 'sine';
    p.lfo.target = ['pitch', 'filter', 'amp'].includes(p.lfo.target) ? p.lfo.target : 'filter';
    p.lfo.rate = clamp(p.lfo.rate, 0.1, 9);
    p.lfo.depth = clamp(p.lfo.depth, 0, p.lfo.target === 'pitch' ? 0.28 : p.lfo.target === 'amp' ? 0.32 : 0.62);
    p.fx.drive = clamp(p.fx.drive, 0, 0.45);
    p.fx.chorus = clamp(p.fx.chorus, 0, 0.6);
    p.fx.delay = clamp(p.fx.delay, 0, 0.35);
    p.fx.delayTime = clamp(p.fx.delayTime, 0.16, 0.48);
    p.fx.reverb = clamp(p.fx.reverb, 0.04, 0.6);
    const sum2 = (p.osc1.on ? p.osc1.level : 0) + (p.osc2.on ? p.osc2.level : 0) + (p.noise.on ? p.noise.level * 0.65 : 0);
    p.master.level = clamp(0.8 - (sum2 / 1.12) * 0.16 - p.fx.drive * 0.06, 0.54, 0.82);
    p.amp = { a: 0.35, d: 0.25, s: 1, r: 1.2 };
    return p;
  }

  function loadSavedInstruments() {
    try {
      const raw = localStorage.getItem(STORAGE_INSTR);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(x => x && x.spec && x.name).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    } catch (err) {
      return [];
    }
  }

  function loadLikes() {
    try {
      const raw = localStorage.getItem(STORAGE_LIKES);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(x => x && x.spec && x.name) : [];
    } catch (err) {
      return [];
    }
  }

  function persistLikes() {
    try {
      localStorage.setItem(STORAGE_LIKES, JSON.stringify(S.liked));
    } catch (err) {}
  }

  function axes(p) {
    const brightnessWave = Math.max(
      p.osc1.on ? WAVE_BRIGHT[p.osc1.wave] : 0,
      p.osc2.on ? WAVE_BRIGHT[p.osc2.wave] : 0,
      p.noise.on ? 0.44 : 0
    );
    const cutN = clamp01(Math.log(p.filter.cutoff / 300) / Math.log(12000 / 300));
    const bright = clamp01(0.52 * cutN + 0.25 * brightnessWave + 0.14 * p.fx.drive + 0.09 * (p.filter.q / 7));
    const levels = (p.osc1.on ? p.osc1.level : 0) + (p.osc2.on ? p.osc2.level : 0) + (p.noise.on ? p.noise.level * 0.4 : 0);
    const body = clamp01(0.15 + 0.58 * clamp01(levels / 1.05) + (p.osc2.on && p.osc2.octave < 0 ? 0.2 : 0) + (p.osc1.octave < 0 ? 0.12 : 0) - (p.filter.cutoff > 6500 ? 0.08 : 0));
    const motion = clamp01((p.lfo.on ? 0.25 + p.lfo.depth * 0.75 : 0) + p.fx.chorus * 0.5 + p.fx.delay * 0.5);
    const space = clamp01(p.fx.reverb * 1.25 + p.fx.delay * 0.45);
    const grit = clamp01(p.fx.drive * 1.5 + (p.filter.q / 7) * 0.3 + (p.noise.on ? p.noise.level * 0.9 : 0));
    return { bright, body, motion, space, grit };
  }

  function waveWord(w) {
    return w === 'sawtooth' ? 'saw' : w === 'triangle' ? 'tri' : w === 'square' ? 'square' : 'sine';
  }

  function describe(p) {
    const a = axes(p);
    const tone = a.bright < 0.3 ? 'Dark' : a.bright < 0.48 ? 'Warm' : a.bright < 0.67 ? 'Clear' : 'Glass';
    const body = a.body < 0.34 ? 'thin' : a.body < 0.56 ? 'round' : 'full';
    const motion = a.motion < 0.17 ? 'still' : a.motion < 0.42 ? 'breathing' : 'restless';
    const space = a.space < 0.2 ? 'dry' : a.space < 0.42 ? 'room' : 'hall';
    const grit = a.grit > 0.62 ? 'gritty ' : '';
    const sources = [];
    if (p.osc1.on) sources.push(waveWord(p.osc1.wave));
    if (p.osc2.on) sources.push(waveWord(p.osc2.wave));
    if (p.noise.on) sources.push('air');
    return `${tone} ${body} · ${grit}${motion} ${space} · ${sources.slice(0, 2).join('+') || 'voice'}`;
  }

  function diff(prev, next) {
    if (!prev) return ['starting timbre'];
    const out = [];
    const ratio = next.filter.cutoff / Math.max(1, prev.filter.cutoff);
    if (ratio > 1.06) out.push('brighter');
    else if (ratio < 0.94) out.push('darker');
    else if (ratio > 1.015) out.push('a touch brighter');
    else if (ratio < 0.985) out.push('a touch darker');
    if (next.fx.reverb > prev.fx.reverb + 0.035) out.push('more room');
    else if (next.fx.reverb < prev.fx.reverb - 0.035) out.push('drier');
    if (next.fx.drive > prev.fx.drive + 0.03) out.push('more grit');
    else if (next.fx.drive < prev.fx.drive - 0.03) out.push('cleaner');
    if (next.fx.chorus > prev.fx.chorus + 0.035 || (next.lfo.on && !prev.lfo.on)) out.push('more movement');
    else if (next.fx.chorus < prev.fx.chorus - 0.035 || (!next.lfo.on && prev.lfo.on)) out.push('still');
    if (next.osc1.wave !== prev.osc1.wave || next.osc2.wave !== prev.osc2.wave) out.push('new waveform');
    if (next.osc1.octave !== prev.osc1.octave || next.osc2.octave !== prev.osc2.octave) out.push('new octave');
    if (next.filter.type !== prev.filter.type) out.push('new filter');
    if (next.osc2.on !== prev.osc2.on || next.noise.on !== prev.noise.on) out.push(next.osc2.on || next.noise.on ? 'fuller' : 'lighter');
    if (!out.length) out.push('small shift');
    return [...new Set(out)].slice(0, 3);
  }

  function other(arr, current) {
    const options = arr.filter(x => x !== current);
    return options.length ? pick(options) : current;
  }

  function timbreSig(p) {
    return [
      p.osc1.on, p.osc2.on, p.noise.on,
      p.osc1.wave, p.osc2.wave, p.osc1.octave, p.osc2.octave,
      Math.round(p.osc1.level * 100), Math.round(p.osc2.level * 100), Math.round(p.noise.level * 100),
      Math.round(p.filter.cutoff), Math.round(p.filter.q * 10), p.filter.type,
      p.lfo.on, p.lfo.wave, p.lfo.target, Math.round(p.lfo.rate * 10), Math.round(p.lfo.depth * 100),
      Math.round(p.fx.drive * 100), Math.round(p.fx.chorus * 100), Math.round(p.fx.delay * 100), Math.round(p.fx.reverb * 100)
    ].join('|');
  }

  function forceShift(p) {
    if (p.filter.type === 'lowpass' && p.filter.cutoff < 11000) p.filter.cutoff *= rand(1.06, 1.15);
    else if (p.filter.type !== 'highpass' && p.filter.cutoff > 420) p.filter.cutoff *= rand(0.87, 0.94);
    else if (p.fx.reverb < 0.55) p.fx.reverb += 0.05;
    else p.fx.chorus = clamp(p.fx.chorus + 0.05, 0, 0.6);
    return normalizeTimbre(p);
  }

  function mutate(base, scale, focus) {
    const p = clone(base);
    const pool = ['filter', 'body', 'motion', 'space', 'character'];
    const weights = [0.33, 0.2, 0.22, 0.16, 0.09];
    const chosen = focus && pool.includes(focus) ? [focus] : [];
    const groups = chosen.length ? 1 + (Math.random() < 0.25 ? 1 : 0) : Math.random() < 0.12 ? 3 : Math.random() < 0.48 ? 2 : 1;
    while (chosen.length < groups) {
      let r = Math.random();
      let idx = 0;
      while (idx < weights.length - 1 && r > weights[idx]) { r -= weights[idx]; idx++; }
      const group = pool[idx];
      if (!chosen.includes(group)) chosen.push(group);
      if (chosen.length < groups && pool.every(g => chosen.includes(g))) break;
    }
    for (const group of chosen) {
      if (group === 'filter') {
        const f = p.filter;
        const dir = Math.random() < 0.5 ? -1 : 1;
        f.cutoff = clamp(f.cutoff * Math.exp(dir * (0.07 + Math.random() * 0.16) * scale), 300, 12000);
        f.q = clamp(f.q + rand(-0.55, 0.55) * scale, 0.3, 7);
        if (Math.random() < 0.06 * scale) f.type = other(['lowpass', 'bandpass', 'highpass'], f.type);
        if (f.type === 'highpass') f.cutoff = clamp(f.cutoff, 250, 3600);
        if (f.type === 'bandpass') f.cutoff = clamp(f.cutoff, 300, 7200);
      } else if (group === 'body') {
        if (focus === 'body' && !p.osc2.on && !p.noise.on) {
          if (Math.random() < 0.68) {
            p.osc2.on = true;
            p.osc2.level = clamp(0.16 + Math.random() * 0.2, 0, 0.6);
            p.osc2.octave = Math.random() < 0.5 ? -1 : 0;
          } else {
            p.noise.on = true;
            p.noise.level = clamp(0.07 + Math.random() * 0.07, 0, 0.24);
          }
        }
        const which = Math.random() < 0.5 ? p.osc1 : p.osc2;
        which.level = clamp(which.level + rand(-0.09, 0.09) * scale, 0, 0.85);
        which.detune = clamp(which.detune + rand(-6, 6) * scale, -30, 30);
        if (Math.random() < 0.12 * scale) {
          const others = [p.osc1, p.osc2, p.noise].filter(x => x !== which);
          if (!which.on || others.some(x => x.on)) which.on = !which.on;
        }
        if (Math.random() < 0.06 * scale) which.octave = clamp(which.octave + pick([-1, 1]), -2, 2);
        if (Math.random() < 0.06 * scale) which.wave = other(WAVES, which.wave);
        if (Math.random() < 0.3) p.noise.level = clamp(p.noise.level + rand(-0.04, 0.04) * scale, 0, 0.26);
        if (Math.random() < 0.07 * scale) p.noise.on = !p.noise.on;
      } else if (group === 'motion') {
        const l = p.lfo;
        if (focus === 'motion' && !l.on) {
          l.on = true;
          l.depth = clamp(0.13 + Math.random() * 0.09, 0, 0.62);
        }
        if (Math.random() < 0.09 * scale) l.on = !l.on;
        l.rate = clamp(l.rate * Math.exp(rand(-0.16, 0.16) * scale), 0.1, 9);
        l.depth = clamp(l.depth + rand(-0.06, 0.06) * scale, 0, 0.62);
        if (Math.random() < 0.1 * scale) l.target = other(['pitch', 'filter', 'amp'], l.target);
        if (Math.random() < 0.06 * scale) l.wave = other(['sine', 'triangle', 'square'], l.wave);
        p.fx.chorus = clamp(p.fx.chorus + rand(-0.07, 0.07) * scale, 0, 0.6);
        p.fx.delay = clamp(p.fx.delay + rand(-0.055, 0.055) * scale, 0, 0.35);
      } else if (group === 'space') {
        p.fx.reverb = clamp(p.fx.reverb + rand(-0.08, 0.08) * scale, 0.04, 0.6);
        p.fx.drive = clamp(p.fx.drive + rand(-0.055, 0.055) * scale, 0, 0.45);
      } else {
        if (focus === 'character') {
          if (Math.random() < 0.72) p.osc1.wave = other(WAVES, p.osc1.wave);
          else p.filter.type = other(['lowpass', 'bandpass', 'highpass'], p.filter.type);
        } else if (Math.random() < 0.45) p.filter.type = other(['lowpass', 'bandpass', 'highpass'], p.filter.type);
        else if (Math.random() < 0.5) p.osc1.wave = other(WAVES, p.osc1.wave);
        else if (Math.random() < 0.5) p.osc2.wave = other(WAVES, p.osc2.wave);
        else if (Math.random() < 0.5) p.osc1.octave = clamp(p.osc1.octave + pick([-1, 1]), -2, 2);
        else p.lfo.target = other(['pitch', 'filter', 'amp'], p.lfo.target);
      }
    }
    let next = normalizeTimbre(p);
    if (timbreSig(next) === timbreSig(base)) {
      next = forceShift(next);
      if (timbreSig(next) === timbreSig(base)) next = forceShift(next);
    }
    next.name = describe(next);
    return next;
  }

  const S = {
    seeds: [],
    seedKey: 'init',
    seedLabel: 'Init timbre',
    seedSpec: null,
    patch: null,
    prev: null,
    index: 0,
    trialKey: '',
    change: [],
    history: [],
    playing: false,
    state: 'idle',
    played: false,
    likeable: false,
    currentLiked: false,
    liked: loadLikes(),
    anchor: null,
    sinceLike: 99,
    noteStart: 0,
    gapStart: 0,
    holdTimer: null,
    gapTimer: null,
    skipTimer: null
  };

  function prepareSeed(raw, label) {
    const p = normalizeTimbre(raw || initTimbre());
    p.name = describe(p);
    return { label, spec: p };
  }

  function buildSeeds() {
    const saved = loadSavedInstruments();
    S.seeds = [{ key: 'init', label: 'Init timbre', spec: initTimbre(), savedAt: 0 }];
    for (const inst of saved) {
      S.seeds.push({ key: inst.id, label: inst.name, spec: inst.spec, savedAt: inst.savedAt || 0 });
    }
    const latest = saved.length ? S.seeds.find(s => s.key === saved[0].id) : null;
    return latest || S.seeds[0];
  }

  function renderSeedOptions(selectedKey) {
    const sel = $('#seedSel');
    sel.innerHTML = '';
    for (const seed of S.seeds) {
      const opt = document.createElement('option');
      opt.value = seed.key;
      opt.textContent = seed.label;
      sel.appendChild(opt);
    }
    sel.value = selectedKey;
  }

  function clearTimers() {
    clearTimeout(S.holdTimer);
    clearTimeout(S.gapTimer);
    clearTimeout(S.skipTimer);
    S.holdTimer = null;
    S.gapTimer = null;
    S.skipTimer = null;
  }

  function stopStream() {
    S.playing = false;
    clearTimers();
    try { window.TimbreEngine.stop(); } catch (err) {}
  }

  function setSeed(key, options = {}) {
    stopStream();
    const seed = S.seeds.find(s => s.key === key) || S.seeds[0];
    S.seedKey = seed.key;
    S.seedLabel = seed.label;
    S.seedSpec = prepareSeed(seed.spec, seed.label);
    S.patch = clone(S.seedSpec.spec);
    S.patch.name = describe(S.patch);
    S.prev = null;
    S.index = 0;
    S.trialKey = `seed-${seed.key}-${Date.now().toString(36)}`;
    S.change = ['starting timbre'];
    S.history = [axes(S.patch)];
    S.playing = false;
    S.state = 'idle';
    S.played = false;
    S.likeable = false;
    S.currentLiked = false;
    S.anchor = null;
    S.sinceLike = 99;
    S.noteStart = 0;
    S.gapStart = 0;
    clearTimers();
    if ($('#seedSel')) $('#seedSel').value = seed.key;
    renderCurrent();
    renderLikes();
    drawMap();
    updateProgress();
    updateControls();
    if (!options.silent) setStageState('press play', '');
  }

  function setStageState(label, cls) {
    const el = $('#stateLabel');
    el.textContent = label;
    el.classList.toggle('live', cls === 'live');
    el.classList.toggle('gap', cls === 'gap');
  }

  function renderAxes() {
    const wrap = $('#axes');
    wrap.innerHTML = '';
    const a = axes(S.patch);
    for (const [key, label] of AXIS_LABELS) {
      const el = document.createElement('div');
      el.className = 'axis';
      const top = document.createElement('div');
      top.className = 'axlabel';
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('b');
      value.textContent = Math.round(a[key] * 100);
      top.append(name, value);
      const track = document.createElement('div');
      track.className = 'track';
      const fill = document.createElement('div');
      fill.className = 'fill';
      fill.style.width = `${Math.round(a[key] * 100)}%`;
      track.appendChild(fill);
      el.append(top, track);
      wrap.appendChild(el);
    }
  }

  function renderCurrent() {
    if (!S.patch) return;
    $('#currentName').textContent = S.patch.name;
    $('#trialLabel').textContent = S.index === 0
      ? `seed · ${S.seedLabel}`
      : `trial ${String(S.index).padStart(2, '0')} · ${S.seedLabel}`;
    const row = $('#changeRow');
    row.innerHTML = '';
    for (const item of S.change) {
      const span = document.createElement('span');
      span.textContent = item;
      if (S.index === 0 && item === 'starting timbre') span.className = 'first';
      row.appendChild(span);
    }
    renderAxes();
    updateControls();
  }

  function updateControls() {
    const play = $('#play');
    play.textContent = S.playing ? '❚❚' : '▶';
    play.classList.toggle('playing', S.playing);
    play.setAttribute('aria-label', S.playing ? 'Pause timbre stream' : 'Play timbre stream');
    const like = $('#like');
    const canLike = S.played && !S.currentLiked;
    like.disabled = !canLike;
    like.textContent = S.currentLiked ? '♥ Liked' : '♥ I like this timbre';
    like.classList.toggle('liked', S.currentLiked);
    $('#skip').disabled = !S.playing;
    $('#likedCount').textContent = `${S.liked.length} liked`;
    $('#likedSideCount').textContent = String(S.liked.length);
  }

  function renderLikes() {
    const list = $('#likedList');
    list.innerHTML = '';
    if (!S.liked.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Press play. When a timbre lands, hit the heart.';
      list.appendChild(empty);
    } else {
      for (const item of S.liked) {
        const card = document.createElement('div');
        card.className = 'likedcard';
        const body = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'lcname';
        name.textContent = item.name;
        const meta = document.createElement('div');
        meta.className = 'lcmeta';
        meta.textContent = `${item.seed || 'seed'} · trial ${item.trial ?? '—'}`;
        body.append(name, meta);
        const del = document.createElement('button');
        del.className = 'ldel';
        del.type = 'button';
        del.textContent = '×';
        del.title = 'Remove this liked timbre';
        del.addEventListener('click', () => deleteLike(item.id));
        card.append(body, del);
        list.appendChild(card);
      }
    }
    $('#likedCount').textContent = `${S.liked.length} liked`;
    $('#likedSideCount').textContent = String(S.liked.length);
  }

  function deleteLike(id) {
    const item = S.liked.find(x => x.id === id);
    S.liked = S.liked.filter(x => x.id !== id);
    if (item && item.spec && S.patch && item.name === S.patch.name && item.trial === S.index) {
      S.currentLiked = false;
    }
    persistLikes();
    renderLikes();
    drawMap();
    updateControls();
  }

  function likeCurrent() {
    if (!S.played || !S.patch || S.currentLiked) return;
    const item = {
      id: `like-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      name: S.patch.name,
      spec: clone(S.patch),
      seed: S.seedLabel,
      trial: S.index,
      axes: axes(S.patch),
      likedAt: Date.now()
    };
    S.liked.unshift(item);
    S.currentLiked = true;
    S.anchor = clone(S.patch);
    S.sinceLike = 0;
    persistLikes();
    renderLikes();
    drawMap();
    updateControls();
    const btn = $('#like');
    btn.classList.remove('flash');
    void btn.offsetWidth;
    btn.classList.add('flash');
  }

  function playCurrent() {
    const ok = window.TimbreEngine.play(S.patch, NOTE_MIDI);
    if (!ok) {
      S.playing = false;
      updateControls();
      setStageState('audio unavailable', '');
      return;
    }
    S.noteStart = performance.now();
    S.state = 'holding';
    S.playing = true;
    setStageState('holding · one long note', 'live');
    updateControls();
    clearTimeout(S.holdTimer);
    clearTimeout(S.gapTimer);
    S.holdTimer = setTimeout(() => {
      if (!S.playing) return;
      try { window.TimbreEngine.release(); } catch (err) {}
      S.state = 'gap';
      S.gapStart = performance.now();
      setStageState('next timbre', 'gap');
      S.gapTimer = setTimeout(() => {
        if (!S.playing) return;
        advance();
      }, RELEASE_MS + GAP_MS);
    }, HOLD_MS);
  }

  function togglePlay() {
    if (S.playing) {
      S.playing = false;
      clearTimers();
      try { window.TimbreEngine.release(); } catch (err) {}
      S.state = 'paused';
      setStageState('paused', '');
      updateControls();
      updateProgress();
      return;
    }
    if (!S.patch) return;
    S.played = true;
    S.likeable = true;
    S.playing = true;
    playCurrent();
  }

  function advance() {
    if (!S.playing) return;
    const prev = S.patch;
    const useAnchor = S.anchor && S.sinceLike <= 2;
    const base = useAnchor ? S.anchor : prev;
    let scale = useAnchor ? 0.5 : S.sinceLike <= 4 ? 0.7 : 0.92;
    if (!useAnchor && S.sinceLike > 6 && S.index > 0 && S.index % 5 === 4) scale *= 1.32;
    const nextIndex = S.index + 1;
    const focus = nextIndex <= OPENING.length ? OPENING[nextIndex - 1] : undefined;
    const next = mutate(base, scale, focus);
    next.name = describe(next);
    S.prev = prev;
    S.patch = next;
    S.index += 1;
    S.trialKey = `trial-${S.index}-${Date.now().toString(36)}`;
    S.change = diff(prev, next);
    S.history.push(axes(next));
    if (S.history.length > 90) S.history.shift();
    S.sinceLike += 1;
    S.currentLiked = false;
    S.likeable = true;
    S.played = true;
    renderCurrent();
    drawMap();
    playCurrent();
  }

  function skip() {
    if (!S.playing) return;
    clearTimers();
    try { window.TimbreEngine.release(); } catch (err) {}
    S.state = 'gap';
    S.gapStart = performance.now();
    setStageState('skipping', 'gap');
    updateControls();
    S.skipTimer = setTimeout(() => {
      if (!S.playing) return;
      advance();
    }, 260);
  }

  function updateProgress() {
    const fill = $('#progressFill');
    const clock = $('#clock');
    if (!S.playing) {
      if (S.state === 'paused') {
        fill.style.width = '0%';
        clock.textContent = 'paused';
      } else {
        fill.style.width = '0%';
        clock.textContent = '—';
      }
      return;
    }
    if (S.state === 'holding') {
      const t = performance.now() - S.noteStart;
      fill.style.width = `${clamp(t / HOLD_MS, 0, 1) * 100}%`;
      clock.textContent = `holding ${(t / 1000).toFixed(1)} s`;
    } else if (S.state === 'gap') {
      const t = performance.now() - S.gapStart;
      fill.style.width = '100%';
      const left = Math.max(0, (RELEASE_MS + GAP_MS - t) / 1000);
      clock.textContent = `next in ${left.toFixed(1)} s`;
    } else if (S.state === 'paused') {
      fill.style.width = '0%';
      clock.textContent = 'paused';
    }
  }

  let scopeW = 0;
  let scopeH = 0;
  let scopeDpr = 1;
  function drawScope() {
    const canvas = $('#scope');
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    scopeW = w;
    scopeH = h;
    scopeDpr = dpr;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath();
      g.moveTo(0, (h / 4) * i);
      g.lineTo(w, (h / 4) * i);
      g.stroke();
    }
    const analyser = window.TimbreEngine.getAnalyser();
    if (analyser) {
      const data = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      g.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = (i / (data.length - 1)) * w;
        const v = (data[i] - 128) / 128;
        sum += v * v;
        const y = h / 2 + v * (h * 0.42);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#7cf3d1');
      grad.addColorStop(0.55, '#b39cff');
      grad.addColorStop(1, '#ffca8c');
      g.strokeStyle = grad;
      g.lineWidth = 1.5;
      g.shadowColor = 'rgba(124,243,209,0.45)';
      g.shadowBlur = 7;
      g.stroke();
      g.shadowBlur = 0;
      if (S.playing && Math.sqrt(sum / data.length) > 0.004) S.audioLive = true;
    } else {
      g.beginPath();
      g.moveTo(0, h / 2);
      g.lineTo(w, h / 2);
      g.strokeStyle = 'rgba(255,255,255,0.14)';
      g.stroke();
    }
  }

  function mapPoint(x, y, padX, padY, w, h) {
    return { x: padX + x * (w - padX * 2), y: padY + (1 - y) * (h - padY * 2) };
  }

  function drawMap() {
    const canvas = $('#map');
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      g.beginPath();
      g.moveTo(24, 18 + ((h - 36) / 4) * i);
      g.lineTo(w - 12, 18 + ((h - 36) / 4) * i);
      g.stroke();
      g.beginPath();
      g.moveTo(24 + ((w - 36) / 4) * i, 18);
      g.lineTo(24 + ((w - 36) / 4) * i, h - 18);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.3)';
    g.font = '8.5px ui-monospace, Menlo, monospace';
    g.fillText('dark', 25, h - 5);
    g.fillText('bright', w - 47, h - 5);
    g.fillText('airy', 4, 26);
    g.fillText('dry', 4, h - 20);

    const history = S.history.slice(-55);
    g.strokeStyle = 'rgba(124,243,209,0.32)';
    g.lineWidth = 1.3;
    g.beginPath();
    history.forEach((a, i) => {
      const pt = mapPoint(clamp01(a.bright), clamp01(a.space), 24, 18, w, h);
      if (i === 0) g.moveTo(pt.x, pt.y); else g.lineTo(pt.x, pt.y);
    });
    g.stroke();
    history.forEach((a, i) => {
      const pt = mapPoint(clamp01(a.bright), clamp01(a.space), 24, 18, w, h);
      g.beginPath();
      g.arc(pt.x, pt.y, i === history.length - 1 ? 3.4 : 1.8, 0, Math.PI * 2);
      g.fillStyle = i === history.length - 1 ? '#7cf3d1' : 'rgba(236,234,245,0.35)';
      g.fill();
    });
    if (S.seedSpec) {
      const p = axes(S.seedSpec.spec);
      const pt = mapPoint(clamp01(p.bright), clamp01(p.space), 24, 18, w, h);
      g.beginPath();
      g.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(179,156,255,0.7)';
      g.lineWidth = 1.2;
      g.stroke();
    }
    if (S.patch) {
      const a = axes(S.patch);
      const pt = mapPoint(clamp01(a.bright), clamp01(a.space), 24, 18, w, h);
      g.beginPath();
      g.arc(pt.x, pt.y, 5.5, 0, Math.PI * 2);
      g.fillStyle = '#7cf3d1';
      g.shadowColor = '#7cf3d1';
      g.shadowBlur = 12;
      g.fill();
      g.shadowBlur = 0;
    }
    for (const item of S.liked) {
      if (!item.axes) continue;
      const pt = mapPoint(clamp01(item.axes.bright), clamp01(item.axes.space), 24, 18, w, h);
      g.fillStyle = 'rgba(255,122,176,0.92)';
      g.font = '12px ui-sans-serif, system-ui';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('♥', pt.x, pt.y);
      g.textAlign = 'start';
      g.textBaseline = 'alphabetic';
    }
  }

  function tick() {
    drawScope();
    updateProgress();
    requestAnimationFrame(tick);
  }

  function wire() {
    $('#seedSel').addEventListener('change', e => {
      setSeed(e.target.value);
    });
    $('#play').addEventListener('click', togglePlay);
    $('#like').addEventListener('click', likeCurrent);
    $('#skip').addEventListener('click', skip);
    window.addEventListener('resize', () => drawMap());
  }

  function boot() {
    const defaultSeed = buildSeeds();
    renderSeedOptions(defaultSeed.key);
    setSeed(defaultSeed.key, { silent: true });
    renderLikes();
    wire();
    drawMap();
    updateProgress();
    updateControls();
    requestAnimationFrame(tick);
  }

  window.TimbreDrift = {
    state: S,
    mutate,
    describe,
    axes,
    normalizeTimbre,
    setSeed,
    likeCurrent,
    advance,
    skip
  };

  boot();
})();
