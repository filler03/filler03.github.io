/* ============================================================
   Song Canvas — Prototype 4 (taste radio)
   An endless randomized stream. Every phrase is a fresh draw
   from the same parts; liking a moment captures the last 5 s,
   teaches a persona, and pins the vibe for the final AI pass.
   ============================================================ */
(function () {
  'use strict';

  const E = window.SongEngine;
  const API = (window.SONGCANVAS_API || '').replace(/\/+$/, '');
  const $ = s => document.querySelector(s);
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const round2 = v => Math.round(v * 100) / 100;
  const clone = o => JSON.parse(JSON.stringify(o));

  const PARAMS = ['pace', 'energy', 'brightness', 'tension', 'density', 'space', 'delay', 'swing', 'shimmer'];
  const TEMPO_NAMES = ['very slow', 'slow', 'steady', 'moving', 'driving'];
  const PATTERN_NAMES = ['straight', 'offbeat', 'push', 'half-time', 'four-floor', 'breakbeat', 'shuffle', 'sparse'];
  const MODES = {
    minor: { label: 'A minor', tonicMinor: true, pool: [[0, 1, 5], [3, 0, 4], [5, 1, 3], [7, 1, 2], [8, 0, 4], [10, 0, 4], [7, 0, 1], [5, 0, 1]] },
    dorian: { label: 'A dorian', tonicMinor: true, pool: [[0, 1, 5], [3, 0, 3], [5, 0, 3], [7, 1, 3], [9, 0, 2], [10, 0, 3], [2, 1, 1]] },
    phrygian: { label: 'A phrygian', tonicMinor: true, pool: [[0, 1, 5], [1, 0, 4], [3, 0, 4], [5, 1, 3], [7, 1, 3], [8, 0, 3], [10, 0, 2]] },
    lydian: { label: 'A lydian', tonicMinor: false, pool: [[0, 0, 5], [2, 0, 3], [4, 1, 2], [6, 0, 2], [7, 0, 3], [9, 1, 2], [11, 0, 1]] },
    mixolydian: { label: 'A mixolydian', tonicMinor: false, pool: [[0, 0, 5], [2, 1, 3], [4, 1, 2], [5, 0, 3], [7, 1, 2], [9, 0, 3], [10, 0, 2]] },
    harmonic: { label: 'A harmonic minor', tonicMinor: true, pool: [[0, 1, 5], [2, 0, 2], [3, 0, 3], [5, 1, 3], [7, 0, 3], [8, 0, 4], [11, 0, 1]] }
  };
  const ARCHETYPES = [
    { id: 'drone', label: 'Drone', modes: ['minor', 'dorian', 'lydian'], instruments: ['pad', 'strings', 'bass', 'texture'], pattern: 0, riffs: ['drift', 'sigh', 'call'], register: 0, bars: 4,
      voice: { padWave: 'sawtooth', bassWave: 'sine', pluckWave: 'triangle', leadWave: 'sawtooth', keysRatio: 2 },
      bands: { pace: [0.08, 0.34], energy: [0.05, 0.26], brightness: [0.18, 0.5], tension: [0.1, 0.4], density: [0.05, 0.28], space: [0.7, 0.96], delay: [0.25, 0.55], swing: [0, 0.2], shimmer: [0.35, 0.75] } },
    { id: 'fourfloor', label: 'Four floor', modes: ['minor', 'dorian', 'mixolydian'], instruments: ['keys', 'pluck', 'bass', 'drums', 'perc'], pattern: 4, riffs: ['pulse', 'spark', 'hook'], register: 0, bars: 2,
      voice: { padWave: 'square', bassWave: 'sawtooth', pluckWave: 'square', leadWave: 'sawtooth', keysRatio: 2 },
      bands: { pace: [0.55, 0.88], energy: [0.68, 0.96], brightness: [0.5, 0.82], tension: [0.2, 0.5], density: [0.55, 0.85], space: [0.12, 0.35], delay: [0.04, 0.2], swing: [0, 0.12], shimmer: [0.04, 0.25] } },
    { id: 'broken', label: 'Broken beat', modes: ['phrygian', 'minor', 'harmonic'], instruments: ['keys', 'pluck', 'bass', 'drums', 'perc'], pattern: 5, riffs: ['weave', 'bounce', 'step'], register: 0, bars: 2,
      voice: { padWave: 'square', bassWave: 'square', pluckWave: 'sawtooth', leadWave: 'square', keysRatio: 3 },
      bands: { pace: [0.45, 0.78], energy: [0.5, 0.86], brightness: [0.32, 0.66], tension: [0.4, 0.78], density: [0.5, 0.88], space: [0.22, 0.5], delay: [0.1, 0.3], swing: [0.15, 0.42], shimmer: [0.08, 0.35] } },
    { id: 'bells', label: 'Bell melody', modes: ['lydian', 'dorian', 'minor'], instruments: ['bells', 'pad', 'bass'], pattern: 0, riffs: ['call', 'sigh', 'drift'], register: 12, bars: 4,
      voice: { padWave: 'triangle', bassWave: 'sine', pluckWave: 'triangle', leadWave: 'triangle', keysRatio: 3 },
      bands: { pace: [0.18, 0.5], energy: [0.15, 0.45], brightness: [0.62, 0.94], tension: [0.15, 0.45], density: [0.15, 0.38], space: [0.6, 0.92], delay: [0.3, 0.6], swing: [0, 0.25], shimmer: [0.4, 0.8] } },
    { id: 'stabs', label: 'Chord stabs', modes: ['minor', 'dorian', 'mixolydian'], instruments: ['keys', 'bass', 'drums'], pattern: 1, riffs: ['hook', 'pulse', 'weave'], register: 0, bars: 2,
      voice: { padWave: 'square', bassWave: 'sawtooth', pluckWave: 'square', leadWave: 'sawtooth', keysRatio: 2 },
      bands: { pace: [0.44, 0.72], energy: [0.55, 0.86], brightness: [0.38, 0.7], tension: [0.3, 0.62], density: [0.35, 0.6], space: [0.2, 0.45], delay: [0.08, 0.3], swing: [0.05, 0.32], shimmer: [0.08, 0.3] } },
    { id: 'bassline', label: 'Bassline', modes: ['phrygian', 'minor', 'dorian'], instruments: ['bass', 'drums', 'perc'], pattern: 3, riffs: ['weave', 'bounce', 'drive'], register: -12, bars: 2,
      voice: { padWave: 'square', bassWave: 'square', pluckWave: 'sawtooth', leadWave: 'sawtooth', keysRatio: 2 },
      bands: { pace: [0.38, 0.7], energy: [0.5, 0.86], brightness: [0.18, 0.5], tension: [0.35, 0.68], density: [0.4, 0.78], space: [0.18, 0.45], delay: [0.06, 0.25], swing: [0.1, 0.42], shimmer: [0.04, 0.25] } },
    { id: 'halftime', label: 'Half-time', modes: ['harmonic', 'minor', 'phrygian'], instruments: ['pad', 'keys', 'bass', 'drums'], pattern: 3, riffs: ['sigh', 'call', 'drift'], register: 0, bars: 4,
      voice: { padWave: 'sawtooth', bassWave: 'sine', pluckWave: 'triangle', leadWave: 'sawtooth', keysRatio: 3 },
      bands: { pace: [0.22, 0.5], energy: [0.28, 0.6], brightness: [0.28, 0.6], tension: [0.35, 0.7], density: [0.22, 0.5], space: [0.45, 0.78], delay: [0.2, 0.45], swing: [0.15, 0.45], shimmer: [0.2, 0.5] } },
    { id: 'breakdown', label: 'Breakdown', modes: ['minor', 'lydian', 'dorian'], instruments: ['pad', 'texture', 'bass'], pattern: 0, riffs: ['sparse', 'drift', 'sigh'], register: 0, bars: 4,
      voice: { padWave: 'triangle', bassWave: 'sine', pluckWave: 'triangle', leadWave: 'triangle', keysRatio: 2 },
      bands: { pace: [0.06, 0.3], energy: [0.02, 0.2], brightness: [0.18, 0.5], tension: [0.2, 0.5], density: [0.04, 0.22], space: [0.82, 0.98], delay: [0.3, 0.62], swing: [0, 0.2], shimmer: [0.4, 0.85] } },
    { id: 'arp', label: 'Arpeggio', modes: ['minor', 'dorian', 'mixolydian'], instruments: ['pluck', 'keys', 'bass', 'drums'], pattern: 2, riffs: ['run', 'drive', 'spark'], register: 12, bars: 2,
      voice: { padWave: 'sawtooth', bassWave: 'sawtooth', pluckWave: 'sawtooth', leadWave: 'sawtooth', keysRatio: 2 },
      bands: { pace: [0.5, 0.88], energy: [0.55, 0.92], brightness: [0.55, 0.92], tension: [0.2, 0.5], density: [0.55, 0.92], space: [0.18, 0.45], delay: [0.08, 0.3], swing: [0, 0.15], shimmer: [0.08, 0.3] } },
    { id: 'shuffle', label: 'Shuffle', modes: ['mixolydian', 'dorian', 'minor'], instruments: ['keys', 'pluck', 'bass', 'drums'], pattern: 6, riffs: ['bounce', 'hook', 'weave'], register: 0, bars: 2,
      voice: { padWave: 'triangle', bassWave: 'sawtooth', pluckWave: 'triangle', leadWave: 'sawtooth', keysRatio: 2 },
      bands: { pace: [0.36, 0.66], energy: [0.4, 0.72], brightness: [0.38, 0.7], tension: [0.2, 0.5], density: [0.38, 0.72], space: [0.22, 0.5], delay: [0.08, 0.3], swing: [0.45, 0.78], shimmer: [0.04, 0.25] } },
    { id: 'lead', label: 'Lead line', modes: ['minor', 'dorian', 'harmonic'], instruments: ['lead', 'keys', 'bass', 'drums'], pattern: 1, riffs: ['hook', 'call', 'run'], register: 12, bars: 2,
      voice: { padWave: 'sawtooth', bassWave: 'sawtooth', pluckWave: 'sawtooth', leadWave: 'square', keysRatio: 3 },
      bands: { pace: [0.45, 0.78], energy: [0.5, 0.82], brightness: [0.45, 0.78], tension: [0.28, 0.6], density: [0.35, 0.68], space: [0.3, 0.58], delay: [0.15, 0.4], swing: [0.05, 0.3], shimmer: [0.15, 0.45] } }
  ];
  const ARCHETYPE_BY_ID = Object.fromEntries(ARCHETYPES.map(a => [a.id, a]));
  const ARCH_FAMILY = {
    drone: 'air', bells: 'air', breakdown: 'air',
    fourfloor: 'groove', broken: 'groove', shuffle: 'groove', halftime: 'groove',
    arp: 'lead', lead: 'lead', stabs: 'lead', bassline: 'bass'
  };
  const ARCH_DRIVE = {
    drone: [0.02, 0.12], fourfloor: [0.08, 0.3], broken: [0.35, 0.7], bells: [0.02, 0.12],
    stabs: [0.1, 0.35], bassline: [0.2, 0.55], halftime: [0.04, 0.2], breakdown: [0.01, 0.08],
    arp: [0.15, 0.4], shuffle: [0.05, 0.2], lead: [0.2, 0.5]
  };
  const ARCH_DRUMTONE = {
    drone: [0.3, 0.6], fourfloor: [0.15, 0.35], broken: [0.6, 0.9], bells: [0.4, 0.7],
    stabs: [0.2, 0.5], bassline: [0.4, 0.7], halftime: [0.3, 0.6], breakdown: [0.2, 0.5],
    arp: [0.1, 0.4], shuffle: [0.4, 0.7], lead: [0.3, 0.6]
  };
  const BANKS = {
    pad: ['warm', 'glass', 'pulse'],
    keys: ['ep', 'bright', 'organ', 'bell'],
    pluck: ['nylon', 'steel', 'koto', 'muted'],
    bells: ['chime', 'glass', 'tubular'],
    bass: ['finger', 'pick', 'sub', 'growl'],
    lead: ['saw', 'square', 'vocal', 'whistle'],
    strings: ['warm', 'cello', 'choir'],
    texture: ['air', 'vinyl', 'rumble']
  };
  const ARCH_VOICES = {
    drone: { pad: 'glass', strings: 'warm', bass: 'sub', texture: 'air' },
    fourfloor: { keys: 'ep', pluck: 'steel', bass: 'pick' },
    broken: { keys: 'bright', pluck: 'koto', bass: 'growl', lead: 'square' },
    bells: { bells: 'glass', pad: 'glass', bass: 'sub' },
    stabs: { keys: 'organ', bass: 'pick' },
    bassline: { bass: 'growl', pluck: 'muted' },
    halftime: { pad: 'pulse', keys: 'ep', bass: 'sub' },
    breakdown: { pad: 'glass', texture: 'vinyl', bass: 'sub' },
    arp: { pluck: 'steel', keys: 'bright', bass: 'pick' },
    shuffle: { keys: 'organ', pluck: 'nylon', bass: 'finger' },
    lead: { lead: 'vocal', keys: 'ep', bass: 'finger' }
  };
  const ARCH_LAYERS = {
    drone: { sub: true }, fourfloor: { sub: true }, broken: {}, bells: { sparkle: true },
    stabs: { sub: true }, bassline: { sub: true }, halftime: { sub: true },
    breakdown: { sub: true }, arp: { sparkle: true }, shuffle: { sub: true }, lead: { double: true }
  };
  const ARCH_CHORUS = {
    drone: 0.8, fourfloor: 0.15, broken: 0.25, bells: 0.7, stabs: 0.2, bassline: 0.1,
    halftime: 0.5, breakdown: 0.9, arp: 0.3, shuffle: 0.2, lead: 0.45
  };
  const CHORD_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
  const BED = ['pad', 'keys', 'strings'];
  const FIGURE = ['pluck', 'bells'];
  const PERSONA_KEY = 'songcanvas.persona.v5';
  const CAPTURE_SEC = 5;
  const CHAOS_KEY = 'songcanvas.chaos.v1';
  const CHAOS_ASPECTS = [
    { id: 'chords', label: 'Chords' },
    { id: 'melody', label: 'Melody' },
    { id: 'instruments', label: 'Instruments' },
    { id: 'tempo', label: 'Tempo' },
    { id: 'beat', label: 'Beat' },
    { id: 'texture', label: 'Character' },
    { id: 'energy', label: 'Energy' },
    { id: 'tone', label: 'Tone' },
    { id: 'space', label: 'Space' },
    { id: 'echo', label: 'Echo' },
    { id: 'edge', label: 'Edge' },
    { id: 'shimmer', label: 'Timbre' },
    { id: 'drive', label: 'Drive' },
    { id: 'voice', label: 'Voice' }
  ];
  const CHAOS_DEFAULTS = {
    chords: 0.7, melody: 0.8, instruments: 0.75, tempo: 0.65, beat: 0.75, texture: 0.95,
    energy: 0.65, tone: 0.6, space: 0.6, echo: 0.6, edge: 0.6, shimmer: 0.6, drive: 0.65, voice: 0.85
  };
  function loadChaos() {
    try {
      const raw = JSON.parse(localStorage.getItem(CHAOS_KEY));
      if (raw) return Object.assign({}, CHAOS_DEFAULTS, raw);
    } catch (e) { /* ignore */ }
    return Object.assign({}, CHAOS_DEFAULTS);
  }
  function saveChaos() {
    try { localStorage.setItem(CHAOS_KEY, JSON.stringify(S.chaos)); } catch (e) { /* ignore */ }
  }
  function cval(id) { return clamp01(S.chaos[id] ?? CHAOS_DEFAULTS[id] ?? 0.5); }

  const S = {
    queue: [],
    phraseNo: 0,
    playing: false,
    lastIndex: 0,
    likes: [],
    aiBusy: false,
    ai: null,
    capture: null,
    analyser: null,
    chaos: loadChaos(),
    raf: 0
  };

  function blankPersona() {
    return {
      likes: 0,
      inst: {}, chords: {}, riffs: {}, patterns: {}, archetypes: {}, modes: {},
      sums: PARAMS.reduce((a, k) => (a[k] = 0, a), {})
    };
  }
  let persona = loadPersona();

  function loadPersona() {
    try {
      const raw = JSON.parse(localStorage.getItem(PERSONA_KEY));
      if (raw && raw.sums && raw.likes >= 0) return Object.assign(blankPersona(), raw);
    } catch (e) { /* ignore */ }
    return blankPersona();
  }
  function savePersona() {
    try { localStorage.setItem(PERSONA_KEY, JSON.stringify(persona)); } catch (e) { /* ignore */ }
  }

  /* ---------------- persisted likes ---------------- */
  let dbPromise = null;
  function openDb() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open('songcanvas', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('likes')) req.result.createObjectStore('likes', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return dbPromise;
  }
  async function dbPut(item) {
    const db = await openDb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('likes', 'readwrite');
        tx.objectStore('likes').put(item);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      } catch (e) { resolve(); }
    });
  }
  async function dbDelete(id) {
    const db = await openDb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('likes', 'readwrite');
        tx.objectStore('likes').delete(id);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      } catch (e) { resolve(); }
    });
  }
  async function dbAll() {
    const db = await openDb();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('likes', 'readonly');
        const req = tx.objectStore('likes').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  }
  async function restoreLikes() {
    const rows = await dbAll();
    if (!rows.length) return;
    S.likes = rows
      .filter(r => r && r.blob)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(r => Object.assign({}, r, { url: URL.createObjectURL(r.blob) }));
    renderLikes();
    renderTaste();
    $('#status').textContent = `${S.likes.length} captured moment${S.likes.length === 1 ? '' : 's'} restored.`;
  }

  /* ---------------- randomness ---------------- */
  function weighted(pool, weightOf) {
    const weights = pool.map(weightOf);
    const total = weights.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return pool[Math.floor(Math.random() * pool.length)];
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }
  function instWeight(id) { return 1 + (persona.inst[id] || 0) * 2.5; }
  function chordKey(c) { return c.root + ':' + (c.minor ? 1 : 0); }
  function chordName(c) { return CHORD_NAMES[c.root] + (c.minor ? 'm' : ''); }
  function mean(k) { return persona.likes ? persona.sums[k] / persona.likes : null; }
  function sample(k, fallback, spread = 0.45) {
    if (persona.likes >= 2 && Math.random() > 0.3) {
      return clamp01((mean(k) ?? fallback) + (Math.random() - 0.5) * spread);
    }
    return clamp01(fallback + (Math.random() - 0.5) * 0.7);
  }
  function bandDraw(band) {
    const [lo, hi] = band || [0, 1];
    return lo + Math.random() * (hi - lo);
  }
  function chooseArchetype(prev) {
    const c = cval('texture');
    const prevArch = prev && prev.archetype ? ARCHETYPE_BY_ID[prev.archetype] : null;
    if (prevArch && c <= 0.001) return prevArch;
    if (prevArch && Math.random() >= c) return prevArch;
    // Contrast, don't just mutate: the next phrase comes from a different family.
    const prevFam = prevArch ? ARCH_FAMILY[prevArch.id] : null;
    const pool = prevFam ? ARCHETYPES.filter(a => ARCH_FAMILY[a.id] !== prevFam) : ARCHETYPES;
    return weighted(pool, a => 1 + ((persona.archetypes && persona.archetypes[a.id]) || 0) * 1.2);
  }
  function chooseMode(arch) {
    return weighted(arch.modes, id => 1 + ((persona.modes && persona.modes[id]) || 0) * 1.5);
  }
  function randomChord(mode) {
    const md = MODES[mode] || MODES.minor;
    const c = weighted(md.pool, x => x[2] + (persona.chords[x[0] + ':' + (x[1] ? 1 : 0)] || 0) * 2);
    return { root: c[0], minor: !!c[1] };
  }
  function drawChords(mode) {
    const key = x => x.root + ':' + (x.minor ? 1 : 0);
    const out = [];
    for (let i = 0; i < 4; i++) {
      let c = randomChord(mode);
      let guard = 0;
      while (i > 0 && key(c) === key(out[i - 1]) && guard++ < 5) c = randomChord(mode);
      out.push(c);
    }
    if (new Set(out.map(key)).size < 2) out[1] = randomChord(mode);
    if (Math.random() < 0.6) out[3] = { root: 0, minor: (MODES[mode] || MODES.minor).tonicMinor };
    return out;
  }
  function generateChords(prev, mode) {
    const c = cval('chords');
    if (!prev) return drawChords(mode);
    if (c <= 0.001) return clone(prev.chords);
    if (Math.random() >= c) {
      if (c < 0.25 && Math.random() < c * 1.5) {
        const out = clone(prev.chords);
        out[Math.floor(Math.random() * out.length)] = randomChord(mode);
        return out;
      }
      return clone(prev.chords);
    }
    return drawChords(mode);
  }

  function archetypeInstruments(arch) {
    const o = {};
    for (const i of E.INSTRUMENTS) o[i.id] = false;
    for (const id of arch.instruments) if (o[id] !== undefined) o[id] = true;
    return o;
  }
  function generateInstruments(prev, arch) {
    const c = cval('instruments');
    const base = archetypeInstruments(arch);
    if (!prev) return base;
    if (c <= 0.001) return clone(prev.instruments);
    if (c >= 0.999) return base;
    const out = {};
    for (const i of E.INSTRUMENTS) {
      out[i.id] = Math.random() < c ? base[i.id] : prev.instruments[i.id];
    }
    if (!Object.values(out).some(Boolean)) out.pad = true;
    return out;
  }

  function drawRiff(arch) {
    return weighted(arch.riffs, id => 1 + (persona.riffs[id] || 0) * 2);
  }
  function generateRiff(prev, arch) {
    const c = cval('melody');
    if (!prev) return drawRiff(arch);
    if (c <= 0.001) return prev.riff;
    return Math.random() < c ? drawRiff(arch) : prev.riff;
  }

  function drawPattern(arch) {
    if (Math.random() < 0.75) return arch.pattern;
    const ids = [0, 1, 2, 3, 4, 5, 6, 7];
    return weighted(ids, id => (id === arch.pattern ? 2 : 1) + (persona.patterns[id] || 0) * 1.2);
  }
  function generatePattern(prev, arch) {
    const c = cval('beat');
    if (!prev) return drawPattern(arch);
    if (c <= 0.001) return prev.pattern;
    return Math.random() < c ? drawPattern(arch) : prev.pattern;
  }

  function blend(prevVal, drawn, c, force) {
    if (prevVal == null) return drawn;
    c = clamp01(c);
    if (c <= 0.001) return prevVal;
    if (force || Math.random() < c) return drawn;
    return prevVal + (drawn - prevVal) * 0.15;
  }

  function generatePhrase() {
    const prev = S.queue[S.queue.length - 1];
    const arch = chooseArchetype(prev);
    const archChanged = !prev || prev.archetype !== arch.id;
    const modeDraw = chooseMode(arch);
    const chords = generateChords(prev, modeDraw);
    const mode = prev && JSON.stringify(chords) === JSON.stringify(prev.chords) ? prev.mode : modeDraw;
    const cEnergy = cval('energy');
    const energyDraw = bandDraw(arch.bands.energy);
    const densityDraw = bandDraw(arch.bands.density);
    const bval = (pv, dv, c) => prev ? blend(pv, dv, c, archChanged) : dv;
    const energy = bval(prev && prev.energy, energyDraw, cEnergy);
    const density = bval(prev && prev.density, densityDraw, cEnergy);
    const pace = bval(prev && prev.pace, bandDraw(arch.bands.pace), cval('tempo'));
    const brightness = bval(prev && prev.brightness, bandDraw(arch.bands.brightness), cval('tone'));
    const tension = bval(prev && prev.tension, bandDraw(arch.bands.tension), cval('edge'));
    const space = bval(prev && prev.space, bandDraw(arch.bands.space), cval('space'));
    const delay = bval(prev && prev.delay, bandDraw(arch.bands.delay), cval('echo'));
    const swing = bval(prev && prev.swing, bandDraw(arch.bands.swing), cval('beat'));
    const shimmer = bval(prev && prev.shimmer, bandDraw(arch.bands.shimmer), cval('shimmer'));
    const driveDraw = bandDraw(ARCH_DRIVE[arch.id] || [0.1, 0.4]);
    const toneDraw = bandDraw(ARCH_DRUMTONE[arch.id] || [0.3, 0.7]);
    const drive = bval(prev && prev.drive, driveDraw, cval('drive'));
    const drumTone = bval(prev && prev.drumTone, toneDraw, cval('texture'));
    const vChaos = cval('voice');
    const archVoices = ARCH_VOICES[arch.id] || {};
    const banks = {};
    for (const inst of Object.keys(BANKS)) {
      const field = inst + 'Bank';
      const base = archVoices[inst] || BANKS[inst][0];
      const prevBank = prev && prev[field];
      let bank;
      if (!prev) bank = base;
      else if (vChaos <= 0.001) bank = prevBank || base;
      else if (Math.random() < vChaos) {
        bank = weighted(BANKS[inst], b => (b === base ? 1.4 : 1) + (b === prevBank ? 0.6 : 0));
      } else bank = prevBank || base;
      banks[inst] = bank;
    }
    const layers = ARCH_LAYERS[arch.id] || {};
    const chorus = ARCH_CHORUS[arch.id] == null ? 0.2 : ARCH_CHORUS[arch.id];
    const voice = arch.voice || {};

    return E.section({
      name: 'Phrase ' + (++S.phraseNo),
      bars: arch.bars || 2,
      pace: round2(pace),
      energy: round2(energy),
      brightness: round2(brightness),
      tension: round2(tension),
      density: round2(density),
      space: round2(space),
      delay: round2(delay),
      swing: round2(swing),
      shimmer: round2(shimmer),
      drive: round2(drive),
      drumTone: round2(drumTone),
      human: round2(0.1 + Math.random() * 0.4),
      pattern: generatePattern(prev, arch),
      riff: generateRiff(prev, arch),
      chords,
      archetype: arch.id,
      family: ARCH_FAMILY[arch.id] || '',
      mode,
      register: arch.register || 0,
      padWave: voice.padWave || 'sawtooth',
      bassWave: voice.bassWave || 'sawtooth',
      pluckWave: voice.pluckWave || 'triangle',
      leadWave: voice.leadWave || 'sawtooth',
      keysRatio: voice.keysRatio || 2,
      padBank: banks.pad, keysBank: banks.keys, pluckBank: banks.pluck, bellBank: banks.bells,
      bassBank: banks.bass, leadBank: banks.lead, stringsBank: banks.strings, textureBank: banks.texture,
      sub: !!layers.sub, sparkle: !!layers.sparkle, double: !!layers.double, chorus: round2(chorus),
      flow: Math.random() < 0.15 ? 'lift' : 'blend',
      instruments: generateInstruments(prev, arch)
    });
  }

  /* ---------------- queue / playback ---------------- */
  function currentIndex() {
    const pos = E.position();
    return pos ? pos.si : S.lastIndex;
  }
  function ensureAhead() {
    const cur = currentIndex();
    while (S.queue.length - cur < 4) {
      S.queue.push(generatePhrase());
    }
    E.song.sections = S.queue;
  }
  function startRadio() {
    if (!S.queue.length) for (let i = 0; i < 5; i++) S.queue.push(generatePhrase());
    ensureAhead();
    E.play();
    S.playing = true;
    startCapture();
    updatePlayButton();
    $('#like').disabled = false;
    $('#status').textContent = 'Listening. Every phrase is new; hit ♥ when something lands.';
  }
  function toggleRadio() {
    if (E.isPlaying()) {
      E.pause();
      S.playing = false;
      updatePlayButton();
    } else {
      startRadio();
    }
  }
  function updatePlayButton() {
    const on = E.isPlaying();
    const b = $('#play');
    b.classList.toggle('playing', on);
    b.textContent = on ? '❚❚' : '▶';
  }

  /* ---------------- capture ---------------- */
  function startCapture() {
    const ctx = E.context();
    const tap = E.tap();
    if (!ctx || !tap || S.capture) return;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 10.5);
    const ringL = new Float32Array(len);
    const ringR = new Float32Array(len);
    const sp = ctx.createScriptProcessor(4096, 2, 2);
    const cap = { ctx, sr, len, ringL, ringR, pos: 0 };
    sp.onaudioprocess = (e) => {
      const L = e.inputBuffer.getChannelData(0);
      const R = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : L;
      let p = cap.pos;
      for (let i = 0; i < L.length; i++) {
        ringL[p] = L[i];
        ringR[p] = R[i];
        p = (p + 1) % len;
      }
      cap.pos = p;
    };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    tap.connect(sp);
    sp.connect(sink);
    sink.connect(ctx.destination);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    tap.connect(analyser);
    analyser.connect(sink);

    S.capture = cap;
    S.analyser = analyser;
    window.__sc4 = { sp, sink, analyser };
  }

  function captureSeconds(n) {
    const cap = S.capture;
    if (!cap) return null;
    const count = Math.min(cap.len, Math.floor(n * cap.sr));
    const start = (cap.pos - count + cap.len) % cap.len;
    const L = new Float32Array(count);
    const R = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const p = (start + i) % cap.len;
      L[i] = cap.ringL[p];
      R[i] = cap.ringR[p];
    }
    return { L, R, sr: cap.sr };
  }
  function pcmToWav(pcm) {
    const ctx = E.context();
    const buf = ctx.createBuffer(2, pcm.L.length, pcm.sr);
    buf.copyToChannel(pcm.L, 0);
    buf.copyToChannel(pcm.R, 1);
    return E.wavBlob(buf);
  }
  function peaksOf(L, n) {
    const out = [];
    const block = Math.max(1, Math.floor(L.length / n));
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let j = i * block; j < Math.min(L.length, (i + 1) * block); j++) peak = Math.max(peak, Math.abs(L[j]));
      out.push(peak);
    }
    return out;
  }

  // Which phrases actually occupied the last `seconds`, weighted by overlap.
  function phraseWindows(seconds) {
    const pos = E.position();
    const ctx = E.context();
    if (!pos || !ctx || !S.queue[pos.si]) return [];
    const now = ctx.currentTime;
    const end = now;
    const start = now - seconds;
    const curSec = S.queue[pos.si];
    const curStart = pos.t0 - pos.bi * pos.dur;
    let endI = curStart + (curSec.bars || 2) * pos.dur;
    let startI = curStart;
    const out = [];
    for (let i = pos.si; i >= 0 && i > pos.si - 8; i--) {
      const s = S.queue[i];
      if (!s) break;
      if (i < pos.si) {
        const bar = (4 * 60) / (52 + clamp01(s.pace) * 88);
        const dur = Math.max(0.1, (s.bars || 2) * bar);
        endI = startI;
        startI = endI - dur;
      }
      const overlap = Math.max(0, Math.min(endI, end) - Math.max(startI, start));
      if (overlap > 0.05) out.push({ index: i, weight: overlap / seconds, phrase: s });
      if (startI <= start) break;
    }
    const total = out.reduce((a, x) => a + x.weight, 0) || 1;
    out.forEach(x => { x.weight /= total; });
    return out;
  }

  // Merge the window into one spec: numeric traits time-weighted, discrete
  // traits from what dominated (instruments need >35% of the window).
  function buildCapture(sources) {
    const total = sources.reduce((a, x) => a + x.weight, 0) || 1;
    const wavg = k => sources.reduce((a, x) => a + Number(x.phrase[k] || 0) * x.weight, 0) / total;
    const dom = sources.slice().sort((a, b) => b.weight - a.weight)[0].phrase;
    const instruments = {};
    for (const i of E.INSTRUMENTS) {
      const w = sources.reduce((a, x) => a + (x.phrase.instruments[i.id] ? x.weight : 0), 0) / total;
      instruments[i.id] = w >= 0.35;
    }
    if (!Object.values(instruments).some(Boolean)) instruments.pad = true;
    const spec = E.section({
      name: 'Liked window',
      bars: dom.bars || 2,
      pace: round2(wavg('pace')), energy: round2(wavg('energy')), brightness: round2(wavg('brightness')),
      tension: round2(wavg('tension')), density: round2(wavg('density')), space: round2(wavg('space')),
      delay: round2(wavg('delay')), swing: round2(wavg('swing')), shimmer: round2(wavg('shimmer')),
      human: round2(wavg('human')),
      pattern: dom.pattern, riff: dom.riff, chords: clone(dom.chords), flow: 'blend',
      archetype: dom.archetype, family: dom.family, mode: dom.mode, register: dom.register || 0,
      padWave: dom.padWave, bassWave: dom.bassWave, pluckWave: dom.pluckWave,
      leadWave: dom.leadWave, keysRatio: dom.keysRatio, drive: dom.drive, drumTone: dom.drumTone,
      padBank: dom.padBank, keysBank: dom.keysBank, pluckBank: dom.pluckBank, bellBank: dom.bellBank,
      bassBank: dom.bassBank, leadBank: dom.leadBank, stringsBank: dom.stringsBank, textureBank: dom.textureBank,
      sub: !!dom.sub, sparkle: !!dom.sparkle, double: !!dom.double, chorus: dom.chorus,
      instruments
    });
    return { spec, dom, sources };
  }

  function learnCapture(sources, spec) {
    persona.likes += 1;
    for (const k of PARAMS) persona.sums[k] += Number(spec[k] || 0);
    const total = sources.reduce((a, x) => a + x.weight, 0) || 1;
    for (const s of sources) {
      const w = s.weight / total;
      for (const [id, on] of Object.entries(s.phrase.instruments || {})) {
        if (on) persona.inst[id] = (persona.inst[id] || 0) + w;
      }
      for (const c of s.phrase.chords || []) {
        const k = chordKey(c);
        persona.chords[k] = (persona.chords[k] || 0) + w;
      }
      persona.riffs[s.phrase.riff] = (persona.riffs[s.phrase.riff] || 0) + w;
      persona.patterns[s.phrase.pattern] = (persona.patterns[s.phrase.pattern] || 0) + w;
      const archId = s.phrase.archetype || 'unknown';
      persona.archetypes[archId] = (persona.archetypes[archId] || 0) + w;
      const modeId = s.phrase.mode || 'minor';
      persona.modes[modeId] = (persona.modes[modeId] || 0) + w;
    }
    savePersona();
  }

  function likeCurrent() {
    if (!E.isPlaying()) return;
    const pcm = captureSeconds(CAPTURE_SEC);
    if (!pcm) return;
    const sources = phraseWindows(CAPTURE_SEC);
    if (!sources.length) return;
    const cap = buildCapture(sources);
    const blob = pcmToWav(pcm);
    const url = URL.createObjectURL(blob);
    const dom = cap.dom;
    const archLabel = (ARCHETYPE_BY_ID[dom.archetype] || {}).label || '';
    const label = `${CAPTURE_SEC}s · ${archLabel ? archLabel + ' · ' : ''}${dom.name} · ${dom.chords.map(chordName).join(' ')} · ${(E.RIFFS[dom.riff] || {}).label || dom.riff}`;
    const item = {
      id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      url,
      blob,
      seconds: CAPTURE_SEC,
      label,
      captureSpec: cap.spec,
      sources: sources.map(x => ({ name: x.phrase.name, weight: round2(x.weight) })),
      specs: sources.map(x => clone(x.phrase)),
      peaks: peaksOf(pcm.L, 60),
      pinned: false,
      createdAt: Date.now()
    };
    S.likes.unshift(item);
    learnCapture(sources, cap.spec);
    dbPut(item);
    while (S.likes.length > 20) {
      const old = S.likes.pop();
      try { URL.revokeObjectURL(old.url); } catch (e) { /* ignore */ }
      dbDelete(old.id);
    }
    renderLikes();
    renderTaste();
    const btn = $('#like');
    btn.classList.remove('flash');
    void btn.offsetWidth;
    btn.classList.add('flash');
    $('#status').textContent = `Captured ${CAPTURE_SEC} s · ${cap.sources.map(x => x.name).join(' + ')}`;
  }

  /* ---------------- rendering ---------------- */
  function phraseTags(sec) {
    const tags = [];
    tags.push({ text: (ARCHETYPE_BY_ID[sec.archetype] || {}).label || 'free' });
    tags.push({ text: (MODES[sec.mode] || {}).label || sec.mode || '' });
    for (const c of sec.chords) tags.push({ text: chordName(c), chord: true });
    for (const [id, on] of Object.entries(sec.instruments)) {
      if (on) tags.push({ text: (E.INSTRUMENTS.find(i => i.id === id) || {}).label || id });
    }
    tags.push({ text: E.RIFFS[sec.riff] ? E.RIFFS[sec.riff].label : sec.riff });
    tags.push({ text: PATTERN_NAMES[sec.pattern] || 'straight' });
    tags.push({ text: Math.round(E.tempoFor(sec)) + ' bpm' });
    return tags;
  }

  function renderNow() {
    const cur = currentIndex();
    const sec = S.queue[cur];
    if (!sec) return;
    $('#phraseName').textContent = sec.name;
    const tags = $('#phraseTags');
    tags.innerHTML = '';
    for (const t of phraseTags(sec)) {
      const s = document.createElement('span');
      s.textContent = t.text;
      if (t.chord) s.className = 'chord';
      tags.appendChild(s);
    }
    renderStream(cur);
  }

  function renderStream(cur) {
    const strip = $('#stream');
    strip.innerHTML = '';
    const from = Math.max(0, cur - 1);
    const to = Math.min(S.queue.length, cur + 5);
    for (let i = from; i < to; i++) {
      const sec = S.queue[i];
      const card = document.createElement('div');
      card.className = 'phr' + (i === cur ? ' on' : '');
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = sec.name;
      const ch = document.createElement('div');
      ch.className = 'ch';
      ch.textContent = ((ARCHETYPE_BY_ID[sec.archetype] || {}).label || '') + ' · ' + sec.chords.map(chordName).join(' ') + ' · ' + ((E.RIFFS[sec.riff] || {}).label || 'figure');
      const ins = document.createElement('div');
      ins.className = 'in';
      for (const [id, on] of Object.entries(sec.instruments)) {
        const d = document.createElement('i');
        if (on) d.style.background = 'rgba(124,243,209,0.7)';
        ins.appendChild(d);
      }
      const line = document.createElement('div');
      line.className = 'barline';
      card.append(nm, ch, ins, line);
      strip.appendChild(card);
    }
    $('#streamNote').textContent = E.isPlaying()
      ? `${S.queue.length} phrases · ${cur + 1} of ${S.queue.length} playing`
      : `${S.queue.length} phrases · ${cur + 1} of ${S.queue.length}`;
  }

  function renderLikes() {
    const box = $('#liked');
    box.innerHTML = '';
    if (!S.likes.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'Nothing captured yet — hit ♥ while it plays.';
      box.appendChild(e);
      return;
    }
    for (const item of S.likes) {
      const card = document.createElement('div');
      card.className = 'likecard' + (item.pinned ? ' pinned' : '');
      const cv = document.createElement('canvas');
      cv.width = 180; cv.height = 28;
      const c = cv.getContext('2d');
      c.fillStyle = 'rgba(124,243,209,0.55)';
      c.fillRect(0, 0, 180, 28);
      c.globalCompositeOperation = 'destination-out';
      item.peaks.forEach((p, i) => {
        const h = Math.max(1, p * 26);
        c.fillRect((i / item.peaks.length) * 180, 14 - h / 2, 2, h);
      });
      const lab = document.createElement('div');
      lab.className = 'lab';
      lab.textContent = item.label;
      lab.title = item.label + (item.sources ? ' · ' + item.sources.map(x => `${x.name} ${Math.round(x.weight * 100)}%`).join(' + ') : '');
      const row = document.createElement('div');
      row.className = 'row';
      const play = document.createElement('button');
      play.textContent = '▶ play';
      play.addEventListener('click', () => playLike(item));
      const pin = document.createElement('button');
      pin.textContent = item.pinned ? '● pinned' : '○ pin';
      pin.className = item.pinned ? 'on' : '';
      pin.title = 'Include this vibe in the final generation';
      pin.addEventListener('click', () => { item.pinned = !item.pinned; dbPut(item); renderLikes(); updateSendHint(); });
      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.addEventListener('click', () => {
        URL.revokeObjectURL(item.url);
        dbDelete(item.id);
        S.likes = S.likes.filter(x => x.id !== item.id);
        renderLikes();
        updateSendHint();
      });
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = item.createdAt ? new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : `${item.seconds}s`;
      time.title = `${item.seconds}s capture`;
      row.append(play, pin, rm, time);
      card.append(cv, lab, row);
      box.appendChild(card);
    }
    updateSendHint();
  }

  function playLike(item) {
    const audio = $('#clip');
    audio.hidden = false;
    audio.src = item.url;
    audio.currentTime = 0;
    audio.play().catch(() => {});
    $('#status').textContent = 'Playing a captured moment.';
  }

  function renderTaste() {
    const body = $('#tasteBody');
    body.innerHTML = '';
    const sum = $('#tasteSummary');
    $('#resetTaste').style.display = persona.likes ? '' : 'none';
    if (!persona.likes) {
      sum.textContent = 'Nothing learned yet. Like a few moments and the radio will lean your way.';
      return;
    }
    sum.textContent = `Learned from ${persona.likes} liked window${persona.likes === 1 ? '' : 's'}.`;
    const traits = [
      { k: 'pace', label: 'Tempo', fmt: v => Math.round(52 + clamp01(v) * 88) + ' bpm' },
      { k: 'energy', label: 'Energy', fmt: v => Math.round(clamp01(v) * 100) + '%' },
      { k: 'brightness', label: 'Light', fmt: v => Math.round(clamp01(v) * 100) + '%' },
      { k: 'density', label: 'Fullness', fmt: v => Math.round(clamp01(v) * 100) + '%' },
      { k: 'space', label: 'Space', fmt: v => Math.round(clamp01(v) * 100) + '%' },
      { k: 'swing', label: 'Swing', fmt: v => Math.round(clamp01(v) * 100) + '%' }
    ];
    const bars = document.createElement('div');
    bars.className = 'bars';
    for (const t of traits) {
      const v = mean(t.k) || 0;
      const row = document.createElement('div');
      row.className = 'trait';
      const l = document.createElement('span');
      l.textContent = t.label;
      const track = document.createElement('div');
      track.className = 'track';
      const fill = document.createElement('div');
      fill.className = 'fill';
      fill.style.width = `${clamp01(v) * 100}%`;
      track.appendChild(fill);
      const val = document.createElement('b');
      val.textContent = t.fmt(v);
      row.append(l, track, val);
      bars.appendChild(row);
    }
    body.appendChild(bars);

    const top = (map, labelOf, n = 4) => {
      const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
      const wrap = document.createElement('div');
      wrap.className = 'tastetags';
      for (const [k, v] of entries) {
        const s = document.createElement('span');
        s.innerHTML = '';
        s.append(document.createTextNode(labelOf(k) + ' '));
        const b = document.createElement('b');
        b.textContent = String(Math.round(v * 10) / 10);
        s.appendChild(b);
        wrap.appendChild(s);
      }
      return wrap;
    };
    const addSub = (title, node) => {
      const h = document.createElement('div');
      h.className = 'subhead';
      h.textContent = title;
      body.appendChild(h);
      body.appendChild(node);
    };
    if (Object.keys(persona.inst).length) {
      addSub('Instruments', top(persona.inst, id => (E.INSTRUMENTS.find(i => i.id === id) || {}).label || id));
    }
    if (Object.keys(persona.chords).length) {
      addSub('Chords', top(persona.chords, k => {
        const [r, m] = k.split(':').map(Number);
        return CHORD_NAMES[r] + (m ? 'm' : '');
      }));
    }
    if (Object.keys(persona.riffs).length) {
      addSub('Figures', top(persona.riffs, id => (E.RIFFS[id] || {}).label || id));
    }
    if (Object.keys(persona.archetypes).length) {
      addSub('Textures', top(persona.archetypes, id => (ARCHETYPE_BY_ID[id] || {}).label || id));
    }
    if (Object.keys(persona.modes).length) {
      addSub('Modes', top(persona.modes, id => (MODES[id] || {}).label || id));
    }
    const reset = $('#resetTaste');
    reset.style.display = '';
  }

  function updateSendHint() {
    const pinned = S.likes.filter(l => l.pinned).length;
    const gen = $('#generate');
    if (gen) gen.disabled = !S.likes.length;
    const cp = $('#copy');
    if (cp) cp.disabled = !S.likes.length;
    $('#sendHint').textContent = pinned
      ? `${pinned} pinned vibe${pinned === 1 ? '' : 's'} will lead the brief.`
      : S.likes.length ? 'No pins yet — the most recent likes will lead.' : 'Like a moment first; the brief needs a vibe.';
  }

  /* ---------------- composer ---------------- */
  function specOf(sec) {
    return {
      name: sec.name, bars: sec.bars,
      pace: round2(sec.pace), energy: round2(sec.energy), brightness: round2(sec.brightness),
      tension: round2(sec.tension), density: round2(sec.density), space: round2(sec.space),
      delay: round2(sec.delay), swing: round2(sec.swing), human: round2(sec.human),
      shimmer: round2(sec.shimmer), pattern: sec.pattern,
      archetype: sec.archetype || '', family: sec.family || '', mode: sec.mode || 'minor', register: sec.register || 0,
      padWave: sec.padWave || 'sawtooth', bassWave: sec.bassWave || 'sawtooth',
      pluckWave: sec.pluckWave || 'triangle', leadWave: sec.leadWave || 'sawtooth',
      keysRatio: sec.keysRatio || 2, drive: round2(sec.drive == null ? 0.1 : sec.drive), drumTone: round2(sec.drumTone == null ? 0.5 : sec.drumTone),
      padBank: sec.padBank || 'warm', keysBank: sec.keysBank || 'ep', pluckBank: sec.pluckBank || 'nylon',
      bellBank: sec.bellBank || 'chime', bassBank: sec.bassBank || 'finger', leadBank: sec.leadBank || 'saw',
      stringsBank: sec.stringsBank || 'warm', textureBank: sec.textureBank || 'air',
      sub: !!sec.sub, sparkle: !!sec.sparkle, double: !!sec.double,
      chorus: round2(sec.chorus == null ? 0.15 : sec.chorus),
      progression: sec.progression || 'bittersweet', riff: sec.riff, flow: 'blend',
      chords: (sec.chords || []).map(c => ({ root: c.root, minor: !!c.minor })),
      instruments: Object.keys(sec.instruments || {}).filter(k => sec.instruments[k])
    };
  }
  function personaSummary() {
    if (!persona.likes) return '';
    const topInst = Object.entries(persona.inst).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, n]) => `${(E.INSTRUMENTS.find(i => i.id === id) || {}).label || id} ${n}`).join(', ');
    const topChords = Object.entries(persona.chords).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => {
      const [r, m] = k.split(':').map(Number);
      return `${CHORD_NAMES[r] + (m ? 'm' : '')} ${n}`;
    }).join(', ');
    const topArch = Object.entries(persona.archetypes || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, n]) => `${(ARCHETYPE_BY_ID[id] || {}).label || id} ${n}`).join(', ');
    const bpm = Math.round(52 + clamp01(mean('pace') || 0) * 88);
    return `Learned taste (${persona.likes} liked windows): tempo ~${bpm} bpm, energy ${Math.round((mean('energy') || 0) * 100)}%, brightness ${Math.round((mean('brightness') || 0) * 100)}%, space ${Math.round((mean('space') || 0) * 100)}%; instruments: ${topInst}; chords: ${topChords}${topArch ? `; textures: ${topArch}` : ''}.`;
  }
  function commission() {
    const chosen = S.likes.filter(l => l.pinned);
    const pool = chosen.length ? chosen : S.likes.slice(0, 4);
    let sections = [];
    for (const item of pool) {
      if (item.captureSpec) {
        const sec = specOf(item.captureSpec);
        sec.name = 'Liked ' + (sections.length + 1);
        sections.push(sec);
      } else {
        sections = sections.concat(item.specs.map(specOf));
      }
    }
    sections = sections.slice(0, 12);
    const arrangement = sections.map(s => Object.assign({}, s, { bars: Math.max(4, s.bars) }));
    const notes = [S.notes, personaSummary()].filter(Boolean).join('\n\n');
    return {
      brief: notes || 'An original piece built from the captured vibes.',
      notes,
      spec: { key: 'A minor', sections },
      arrangement,
      instructions: 'Use the pinned/liked phrases as the emotional core; smooth transitions; vary the arrangement.'
    };
  }

  async function generate() {
    if (!API || S.aiBusy) return;
    if (!S.likes.length) { $('#status').textContent = 'Like a moment first.'; return; }
    S.aiBusy = true;
    S.ai = { status: 'queued', phase: 'sending the commission' };
    renderComposer();
    try {
      const res = await fetch(API + '/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(commission())
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      poll(data.jobId);
    } catch (e) {
      S.aiBusy = false;
      S.ai = { status: 'error', phase: 'failed', error: e.message };
      renderComposer();
    }
  }
  async function poll(id) {
    let fails = 0;
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const res = await fetch(API + '/job/' + id);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
        fails = 0;
        S.ai = j;
        if (j.status === 'done' || j.status === 'error') {
          S.aiBusy = false;
          renderComposer();
          const box = document.getElementById('composer');
          if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        const line = document.getElementById('aiStatus');
        if (line) line.textContent = `opencode · ${j.phase || j.status}`;
      } catch (e) {
        if (++fails >= 5) {
          S.aiBusy = false;
          S.ai = { status: 'error', phase: 'failed', error: 'lost contact: ' + e.message };
          renderComposer();
          return;
        }
      }
    }
  }
  function aiSummary() {
    const a = S.ai;
    if (!a) return '';
    if (a.status === 'done') {
      const m = Math.floor((a.duration || 0) / 60), s = Math.round((a.duration || 0) % 60);
      return `${a.source === 'ai' ? 'arranged by opencode' : 'local fallback'} · ${a.sections || '?'} sections · ${m}:${String(s).padStart(2, '0')} · ${a.model || 'default'}`;
    }
    return a.phase || a.status || '';
  }
  function renderComposer() {
    const box = $('#result');
    box.innerHTML = '';
    if (!S.ai && !S.aiBusy) return;
    const wrap = document.createElement('div');
    wrap.className = 'resultbox';
    const status = document.createElement('p');
    status.className = 'status';
    status.id = 'aiStatus';
    status.textContent = S.aiBusy
      ? `opencode · ${(S.ai && S.ai.phase) || 'sending the commission'}`
      : S.ai && S.ai.status === 'error' ? `failed · ${S.ai.error || S.ai.phase}` : aiSummary();
    wrap.appendChild(status);
    if (S.ai && S.ai.status === 'done' && S.ai.audioUrl) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = S.ai.audioUrl;
      wrap.appendChild(audio);
      const links = document.createElement('div');
      links.className = 'links';
      const dl = document.createElement('a');
      dl.href = S.ai.audioUrl; dl.download = 'song-canvas-ai.mp3'; dl.textContent = 'Download MP3';
      const disc = document.createElement('a');
      disc.href = S.ai.discordUrl; disc.target = '_blank'; disc.rel = 'noopener'; disc.textContent = 'Open in #music-testing';
      links.append(dl, disc);
      wrap.appendChild(links);
    }
    box.appendChild(wrap);
  }

  /* ---------------- analyser ---------------- */
  function drawViz() {
    const cv = $('#viz');
    const ctx = cv.getContext('2d');
    const w = cv.clientWidth || 600, h = cv.clientHeight || 54;
    if (cv.width !== w * 2) { cv.width = w * 2; cv.height = h * 2; }
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    if (S.analyser) {
      const data = new Uint8Array(S.analyser.frequencyBinCount);
      S.analyser.getByteFrequencyData(data);
      const bars = 64;
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const v = data[Math.floor((i / bars) * data.length * 0.7)] / 255;
        const bh = Math.max(2, v * v * h * 0.92);
        ctx.fillStyle = `rgba(124,243,209,${0.18 + v * 0.62})`;
        ctx.fillRect(i * bw + 1, h - bh - 1, Math.max(1, bw - 2), bh);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    }
    S.raf = requestAnimationFrame(drawViz);
  }

  /* ---------------- loop ---------------- */
  let lastIndex = -1;
  function tick() {
    const cur = currentIndex();
    if (cur !== lastIndex) {
      lastIndex = cur;
      S.lastIndex = cur;
      renderNow();
    }
    if (E.isPlaying() && S.queue.length - cur < 4) ensureAhead();
    const noteEl = $('#streamNote');
    if (noteEl) {
      const note = E.isPlaying()
        ? `${S.queue.length} phrases · ${cur + 1} of ${S.queue.length} playing`
        : `${S.queue.length} phrases · ${cur + 1} of ${S.queue.length}`;
      if (noteEl.textContent !== note) noteEl.textContent = note;
    }
    const cards = document.querySelectorAll('#stream .phr');
    cards.forEach((card, i) => {
      const idx = Math.max(0, cur - 1) + i;
      const sec = S.queue[idx];
      if (!sec) return;
      const pos = E.position();
      const line = card.querySelector('.barline');
      if (!line || !pos || pos.si !== idx) { if (line) line.style.width = '0%'; return; }
      line.style.width = `${clamp01((pos.bi + pos.barProgress) / Math.max(1, sec.bars)) * 100}%`;
    });
    const on = E.isPlaying();
    if (on !== S.playing) { S.playing = on; updatePlayButton(); $('#like').disabled = !on; }
    requestAnimationFrame(tick);
  }

  /* ---------------- control vs surprise ---------------- */
  let chaosTimer = 0;
  let chaosDirty = false;
  function scheduleChaosApply() {
    saveChaos();
    chaosDirty = true;
    clearTimeout(chaosTimer);
    chaosTimer = setTimeout(() => { chaosDirty = false; regenerateAhead(); }, 300);
  }
  function regenerateAhead() {
    if (!S.playing) {
      const count = Math.max(5, S.queue.length);
      S.queue = [];
      for (let i = 0; i < count; i++) S.queue.push(generatePhrase());
      E.song.sections = S.queue;
      S.lastIndex = 0;
      renderNow();
      return;
    }
    const cur = currentIndex();
    const keep = Math.min(S.queue.length, cur + 2);
    if (S.queue.length > keep) S.queue.length = keep;
    ensureAhead();
    renderStream(cur);
  }
  function buildChaosModal() {
    const body = $('#chaosBody');
    body.innerHTML = '';
    for (const a of CHAOS_ASPECTS) {
      const row = document.createElement('div');
      row.className = 'chaosRow';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = a.label;
      const input = document.createElement('input');
      input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.01';
      input.setAttribute('aria-label', a.label + ' randomness');
      const val = document.createElement('div');
      val.className = 'val';
      const paint = () => {
        const v = cval(a.id);
        input.value = String(v);
        val.textContent = v <= 0.001 ? 'locked' : Math.round(v * 100) + '%';
        val.classList.toggle('locked', v <= 0.001);
      };
      input.addEventListener('input', () => {
        S.chaos[a.id] = parseFloat(input.value);
        paint();
        scheduleChaosApply();
      });
      paint();
      row.append(name, input, val);
      body.appendChild(row);
    }
    const presets = $('#chaosPresets');
    presets.innerHTML = '';
    const applyPreset = (obj) => {
      S.chaos = obj;
      saveChaos();
      chaosDirty = false;
      buildChaosModal();
      regenerateAhead();
    };
    [['Lock all', () => Object.fromEntries(CHAOS_ASPECTS.map(a => [a.id, 0]))],
     ['Balanced', () => Object.assign({}, CHAOS_DEFAULTS)],
     ['Wild', () => Object.fromEntries(CHAOS_ASPECTS.map(a => [a.id, 1]))]].forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => applyPreset(fn()));
      presets.appendChild(b);
    });
  }
  $('#chaosBtn').addEventListener('click', () => {
    buildChaosModal();
    const dlg = $('#chaosDialog');
    if (dlg && !dlg.open) dlg.showModal();
  });
  $('#chaosClose').addEventListener('click', () => {
    const dlg = $('#chaosDialog');
    if (dlg && dlg.open) dlg.close();
  });
  $('#chaosDialog').addEventListener('close', () => {
    clearTimeout(chaosTimer);
    saveChaos();
    if (chaosDirty) { chaosDirty = false; regenerateAhead(); }
  });

  /* ---------------- boot ---------------- */
  for (let i = 0; i < 5; i++) S.queue.push(generatePhrase());
  E.song.sections = S.queue;

  $('#play').addEventListener('click', toggleRadio);
  $('#like').addEventListener('click', likeCurrent);
  $('#sendTop').addEventListener('click', () => {
    const c = document.getElementById('composer');
    if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#generate').addEventListener('click', generate);
  $('#notes').addEventListener('input', (e) => { S.notes = e.target.value; });
  $('#copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(commission(), null, 2)); $('#status').textContent = 'brief copied'; }
    catch (e) { $('#status').textContent = 'copy blocked'; }
  });
  $('#resetTaste').title = 'Forget the learned taste (keeps your captures)';
  $('#resetTaste').addEventListener('click', () => {
    persona = blankPersona();
    savePersona();
    renderTaste();
    $('#status').textContent = 'Taste reset. The next phrases are a fresh draw.';
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); toggleRadio(); }
    if (e.key.toLowerCase() === 'l') likeCurrent();
  });
  $('#clip').addEventListener('ended', () => { $('#status').textContent = 'Captured moment finished.'; });

  renderNow();
  renderLikes();
  renderTaste();
  updateSendHint();
  restoreLikes();
  drawViz();
  requestAnimationFrame(tick);
  updatePlayButton();

  window.TasteRadio = {
    state: S,
    persona: () => persona,
    commission,
    generate,
    like: likeCurrent,
    chaos: () => S.chaos,
    engine: E
  };
  window.__SC4_READY__ = true;
})();
