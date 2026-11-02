/* ============================================================
   Song Canvas — Prototype 5 (discovery lab)
   One continuous loop. Isolate aspects, roll only those, add or
   drop instruments, and like moments to build a contextual taste
   profile for the later LLM song builder.
   ============================================================ */
(function () {
  'use strict';

  const E = window.SongEngine;
  const $ = s => document.querySelector(s);
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const round2 = v => Math.round(v * 100) / 100;
  const clone = o => JSON.parse(JSON.stringify(o));

  const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
  const NOTE_NAMES_FLAT = ['A', 'Bb', 'B', 'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab'];
  const FLAT_MAJOR = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb']);
  const FLAT_MINOR = new Set(['D', 'G', 'C', 'F', 'Bb', 'Eb', 'Ab']);
  const PATTERN_NAMES = ['straight', 'offbeat', 'push', 'half-time', 'four-floor', 'breakbeat', 'shuffle', 'sparse'];
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
  const BANK_FIELD = {
    pad: 'padBank', keys: 'keysBank', pluck: 'pluckBank', bells: 'bellBank',
    bass: 'bassBank', lead: 'leadBank', strings: 'stringsBank', texture: 'textureBank'
  };
  const INST_LABEL = Object.fromEntries(E.INSTRUMENTS.map(i => [i.id, i.label]));
  const KEY_OFFSETS = { C: 3, 'C#': 4, Db: 4, D: 5, 'D#': 6, Eb: 6, E: 7, F: 8, 'F#': 9, Gb: 9, G: 10, 'G#': 11, Ab: 11, A: 0, 'A#': 1, Bb: 1, B: 2 };
  const KEY_LIST = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const MAJOR_Q = { 0: '', 2: 'm', 4: 'm', 5: '', 7: '', 9: 'm', 11: 'dim' };
  const MINOR_Q = { 0: 'm', 2: 'dim', 3: '', 5: 'm', 7: 'm', 8: '', 10: '' };
  const NASHVILLE_PRESETS = {
    minor: ['1m b6 b3 b7', '1m b7 b6 b7', '1m 4m 5m 1m', '1m b3 b7 4m', '1m b6 4m 5m', '1m b3 b6 b7', '1m 4m 5maj 1m', '1m b7 b3 b6'],
    major: ['1 5 6m 4', '1 6m 4 5', '1 4 5 6m', '1 b7 4 1', '1 4 6m 5', '1 5 4 5', '1 3m 4 5']
  };
  const ASPECTS = [
    { id: 'chords', label: 'Chords', desc: 'progression' },
    { id: 'melody', label: 'Melody', desc: 'figure' },
    { id: 'tempo', label: 'Tempo', desc: 'pace' },
    { id: 'beat', label: 'Beat', desc: 'pattern + swing' },
    { id: 'effects', label: 'Effects', desc: 'chorus / drive / space' },
    { id: 'instrument', label: 'Instrument', desc: 'selected slot' }
  ];
  const TASTE_KEY = 'songcanvas.discovery.taste.v2';
  const CAPTURE_SEC = 5;

  function usesFlats(key, mode) { return (mode === 'minor' ? FLAT_MINOR : FLAT_MAJOR).has(key); }
  function chordLabel(c, key, mode) {
    const names = usesFlats(key || S.key, mode || S.mode) ? NOTE_NAMES_FLAT : NOTE_NAMES;
    return names[c.root] + (c.dim ? 'dim' : c.aug ? 'aug' : c.minor ? 'm' : '');
  }
  function chordsLabel(list, key, mode) { return (list || []).map(c => chordLabel(c, key, mode)).join(' '); }
  const bpm = sec => Math.round(E.tempoFor(sec));

  function tokenToChord(token, key, mode) {
    const m = String(token).match(/^([#b]?)([1-7])(m|dim|aug|maj)?$/i);
    if (!m) return null;
    const acc = m[1] === '#' ? 1 : m[1] === 'b' ? -1 : 0;
    const deg = +m[2];
    const interval = ((MAJOR[deg - 1] + acc) % 12 + 12) % 12;
    const root = (((KEY_OFFSETS[key] || 0) + interval) % 12 + 12) % 12;
    const qual = (m[3] || '').toLowerCase();
    const dia = ((mode === 'minor' ? MINOR_Q : MAJOR_Q)[interval]) || '';
    const q = qual === 'maj' ? '' : (qual || dia);
    return { root, minor: q === 'm', dim: q === 'dim', aug: q === 'aug' };
  }
  function parseProgression(tokens, key, mode) {
    const out = [];
    for (const t of tokens) {
      const c = tokenToChord(t, key, mode);
      if (!c) return null;
      out.push(c);
    }
    return out.length ? out : null;
  }
  function applyProgression(tokens) {
    const chords = parseProgression(tokens, S.key, S.mode);
    if (!chords) return false;
    S.prog = tokens.slice();
    S.sec.chords = chords;
    S.sec.nashville = tokens.slice();
    S.sec.key = S.key;
    S.sec.mode = S.mode;
    return true;
  }

  /* ---------------- taste ---------------- */
  function blankTaste() {
    return {
      likes: 0,
      instruments: {},
      context: {
        chords: {}, riffs: {}, patterns: {},
        tempo: { sum: 0, n: 0 },
        chorus: { sum: 0, n: 0 }, drive: { sum: 0, n: 0 }, space: { sum: 0, n: 0 },
        echo: { sum: 0, n: 0 }, edge: { sum: 0, n: 0 }
      }
    };
  }
  function loadTaste() {
    try {
      const raw = JSON.parse(localStorage.getItem(TASTE_KEY));
      if (raw && raw.context) return Object.assign(blankTaste(), raw);
    } catch (e) { /* ignore */ }
    return blankTaste();
  }
  let taste = loadTaste();
  function saveTaste() { try { localStorage.setItem(TASTE_KEY, JSON.stringify(taste)); } catch (e) { /* ignore */ } }

  function instTaste(id) {
    if (!taste.instruments[id]) {
      taste.instruments[id] = { banks: {}, levelSum: 0, levelN: 0, regs: {}, layers: {}, toneSum: 0, toneN: 0 };
    }
    return taste.instruments[id];
  }
  function topKey(map) {
    if (!map) return null;
    let best = null, n = -1;
    for (const [k, v] of Object.entries(map)) if (v > n) { n = v; best = k; }
    return best;
  }

  /* ---------------- state ---------------- */
  const S = {
    sec: null,
    selected: 'pad',
    key: 'A',
    mode: 'minor',
    prog: ['1m', 'b6', 'b3', 'b7'],
    evolve: 4,
    lastEvolveT: -1,
    aspects: { chords: true, melody: true, tempo: true, beat: true, effects: true, instrument: false },
    likes: [],
    capture: null,
    analyser: null,
    clipUrl: null,
    raf: 0
  };

  function baseSection() {
    const inst = {};
    for (const i of E.INSTRUMENTS) inst[i.id] = false;
    inst.pad = inst.keys = inst.bass = inst.drums = true;
    return E.section({
      name: 'Discovery',
      bars: 4,
      pace: 0.5, energy: 0.52, brightness: 0.56, tension: 0.3, density: 0.5,
      space: 0.4, delay: 0.15, swing: 0.12, human: 0.25,
      drive: 0.2, drumTone: 0.5, chorus: 0.3, crash: false,
      pattern: 1, patternB: 5, riff: 'hook', riffB: 'bounce', fill: true, mode: S.mode, progression: 'minor',
      key: S.key, nashville: S.prog.slice(), chords: [],
      padBank: 'warm', keysBank: 'ep', pluckBank: 'nylon', bellBank: 'chime',
      bassBank: 'finger', leadBank: 'saw', stringsBank: 'warm', textureBank: 'air',
      sub: false, sparkle: false, double: false,
      levels: { pad: 1, keys: 1, pluck: 1, bells: 1, bass: 1, lead: 1, strings: 1, drums: 1, perc: 1, texture: 1 },
      regs: { pad: 0, keys: 0, pluck: 0, bells: 0, bass: 0, lead: 0, strings: 0 },
      instruments: inst
    });
  }

  /* ---------------- roll ---------------- */
  function rollInstrument(id) {
    const sec = S.sec;
    if (!id) return;
    const field = BANK_FIELD[id];
    if (field) {
      const list = BANKS[id];
      sec[field] = list[Math.floor(Math.random() * list.length)];
    }
    sec.levels = sec.levels || {};
    sec.regs = sec.regs || {};
    sec.levels[id] = round2(0.6 + Math.random() * 0.5);
    sec.regs[id] = ['drums', 'perc'].includes(id) ? 0 : [-12, 0, 12][Math.floor(Math.random() * 3)];
    if (id === 'bass') sec.sub = Math.random() < 0.5;
    if (id === 'pluck') sec.sparkle = Math.random() < 0.5;
    if (id === 'lead') sec.double = Math.random() < 0.5;
    if (id === 'drums') sec.drumTone = round2(0.15 + Math.random() * 0.7);
  }
  function roll() {
    const sec = S.sec;
    if (S.aspects.chords) {
      const list = NASHVILLE_PRESETS[S.mode] || NASHVILLE_PRESETS.minor;
      applyProgression(list[Math.floor(Math.random() * list.length)].split(' '));
    }
    if (S.aspects.melody) {
      const ids = Object.keys(E.RIFFS);
      const a = ids[Math.floor(Math.random() * ids.length)];
      let b = ids[Math.floor(Math.random() * ids.length)];
      if (b === a) b = ids[(ids.indexOf(a) + 3) % ids.length];
      sec.riff = a; sec.riffB = b;
    }
    if (S.aspects.tempo) sec.pace = round2(0.35 + Math.random() * 0.35);
    if (S.aspects.beat) {
      const p1 = Math.floor(Math.random() * 8);
      let p2 = Math.floor(Math.random() * 8);
      if (p2 === p1) p2 = (p1 + 3) % 8;
      sec.pattern = p1; sec.patternB = p2;
      sec.swing = round2(Math.random() * 0.4);
    }
    if (S.aspects.effects) {
      sec.chorus = round2(0.1 + Math.random() * 0.7);
      sec.drive = round2(0.05 + Math.random() * 0.4);
      sec.space = round2(0.2 + Math.random() * 0.5);
      sec.delay = round2(0.1 + Math.random() * 0.4);
      sec.tension = round2(0.1 + Math.random() * 0.5);
    }
    if (S.aspects.instrument) rollInstrument(S.selected);
    render();
  }

  /* ---------------- instruments ---------------- */
  function toggleSlot(id, selectOnly) {
    S.selected = id;
    if (!selectOnly) {
      const sec = S.sec;
      const on = !sec.instruments[id];
      sec.instruments[id] = on;
      if (on) {
        const t = taste.instruments[id];
        const field = BANK_FIELD[id];
        if (field && t) {
          const bank = topKey(t.banks);
          if (bank) sec[field] = bank;
        }
        if (t) {
          if (t.levelN) sec.levels[id] = round2(t.levelSum / t.levelN);
          const reg = topKey(t.regs);
          if (reg != null && !['drums', 'perc'].includes(id)) sec.regs[id] = Number(reg);
          if (id === 'drums' && t.toneN) sec.drumTone = round2(t.toneSum / t.toneN);
        }
      }
    }
    render();
  }

  function activeInstruments() {
    return E.INSTRUMENTS.filter(i => S.sec.instruments[i.id]).map(i => i.id);
  }

  /* ---------------- capture / learn ---------------- */
  let dbPromise = null;
  function openDb() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open('songcanvas-discovery', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('likes')) req.result.createObjectStore('likes', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return dbPromise;
  }
  async function dbPut(item) {
    const db = await openDb(); if (!db) return;
    return new Promise(resolve => {
      try { const tx = db.transaction('likes', 'readwrite'); tx.objectStore('likes').put(item); tx.oncomplete = resolve; tx.onerror = resolve; } catch (e) { resolve(); }
    });
  }
  async function dbDelete(id) {
    const db = await openDb(); if (!db) return;
    return new Promise(resolve => {
      try { const tx = db.transaction('likes', 'readwrite'); tx.objectStore('likes').delete(id); tx.oncomplete = resolve; tx.onerror = resolve; } catch (e) { resolve(); }
    });
  }
  async function dbAll() {
    const db = await openDb(); if (!db) return [];
    return new Promise(resolve => {
      try { const tx = db.transaction('likes', 'readonly'); const req = tx.objectStore('likes').getAll(); req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]); } catch (e) { resolve([]); }
    });
  }

  function startCapture() {
    const ctx = E.context(); const tap = E.tap();
    if (!ctx || !tap || S.capture) return;
    const sr = ctx.sampleRate, len = Math.floor(sr * 8.5);
    const ringL = new Float32Array(len), ringR = new Float32Array(len);
    const sp = ctx.createScriptProcessor(4096, 2, 2);
    const cap = { ctx, sr, len, ringL, ringR, pos: 0 };
    sp.onaudioprocess = (e) => {
      const L = e.inputBuffer.getChannelData(0);
      const R = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : L;
      let p = cap.pos;
      for (let i = 0; i < L.length; i++) { ringL[p] = L[i]; ringR[p] = R[i]; p = (p + 1) % len; }
      cap.pos = p;
    };
    const sink = ctx.createGain(); sink.gain.value = 0;
    tap.connect(sp); sp.connect(sink); sink.connect(ctx.destination);
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
    tap.connect(analyser); analyser.connect(sink);
    S.capture = cap; S.analyser = analyser;
    window.__sc5 = { sp, sink, analyser };
  }
  function capturePcm(seconds) {
    const cap = S.capture; if (!cap) return null;
    const count = Math.min(cap.len, Math.floor(seconds * cap.sr));
    const start = (cap.pos - count + cap.len) % cap.len;
    const L = new Float32Array(count), R = new Float32Array(count);
    for (let i = 0; i < count; i++) { const p = (start + i) % cap.len; L[i] = cap.ringL[p]; R[i] = cap.ringR[p]; }
    return { L, R, sr: cap.sr };
  }
  function pcmToWav(pcm) {
    const ctx = E.context();
    const buf = ctx.createBuffer(2, pcm.L.length, pcm.sr);
    buf.copyToChannel(pcm.L, 0); buf.copyToChannel(pcm.R, 1);
    return E.wavBlob(buf);
  }
  function peaksOf(L, n) {
    const out = []; const block = Math.max(1, Math.floor(L.length / n));
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let j = i * block; j < Math.min(L.length, (i + 1) * block); j++) peak = Math.max(peak, Math.abs(L[j]));
      out.push(peak);
    }
    return out;
  }

  function learn(sec) {
    taste.likes++;
    const active = activeInstruments();
    for (const id of active) {
      const t = instTaste(id);
      const field = BANK_FIELD[id];
      const bank = field ? sec[field] : null;
      if (bank) t.banks[bank] = (t.banks[bank] || 0) + 1;
      const level = sec.levels && sec.levels[id] != null ? sec.levels[id] : 1;
      t.levelSum += level; t.levelN++;
      if (!['drums', 'perc'].includes(id)) {
        const reg = String((sec.regs && sec.regs[id]) || 0);
        t.regs[reg] = (t.regs[reg] || 0) + 1;
      }
      if (id === 'bass') t.layers.sub = (t.layers.sub || 0) + (sec.sub ? 1 : 0);
      if (id === 'pluck') t.layers.sparkle = (t.layers.sparkle || 0) + (sec.sparkle ? 1 : 0);
      if (id === 'lead') t.layers.double = (t.layers.double || 0) + (sec.double ? 1 : 0);
      if (id === 'drums') { t.toneSum += Number(sec.drumTone || 0.5); t.toneN++; }
    }
    const c = taste.context;
    const ck = `${sec.key || S.key} ${sec.mode || S.mode} · ${(sec.nashville || S.prog).join(' ')}`;
    c.chords[ck] = (c.chords[ck] || 0) + 1;
    c.riffs[sec.riff] = (c.riffs[sec.riff] || 0) + 1;
    if (sec.riffB && sec.riffB !== sec.riff) c.riffs[sec.riffB] = (c.riffs[sec.riffB] || 0) + 1;
    c.patterns[sec.pattern] = (c.patterns[sec.pattern] || 0) + 1;
    if (sec.patternB != null && sec.patternB !== sec.pattern) c.patterns[sec.patternB] = (c.patterns[sec.patternB] || 0) + 1;
    for (const k of ['chorus', 'drive', 'space', 'echo', 'edge']) {
      c[k].sum += Number(sec[k] || 0); c[k].n++;
    }
    c.tempo.sum += Number(sec.pace || 0); c.tempo.n++;
    saveTaste();
  }

  function likeCurrent() {
    if (!E.isPlaying()) return;
    const pcm = capturePcm(CAPTURE_SEC); if (!pcm) return;
    const sec = clone(S.sec);
    const blob = pcmToWav(pcm);
    const url = URL.createObjectURL(blob);
    const label = `${CAPTURE_SEC}s · ${S.key} ${S.mode} · ${S.prog.join(' ')} · ${bpm(sec)} bpm`.trim();
    const item = {
      id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      url, blob, seconds: CAPTURE_SEC, label, context: sec,
      aspects: clone(S.aspects), selected: S.selected,
      peaks: peaksOf(pcm.L, 60), createdAt: Date.now()
    };
    S.likes.unshift(item);
    learn(S.sec);
    dbPut(item);
    while (S.likes.length > 20) {
      const old = S.likes.pop();
      try { URL.revokeObjectURL(old.url); } catch (e) { /* ignore */ }
      dbDelete(old.id);
    }
    renderLikes(); renderTaste(); renderNow();
    const btn = $('#like');
    btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash');
    $('#status').textContent = `Captured ${CAPTURE_SEC} s · ${label}`;
  }

  /* ---------------- rendering ---------------- */
  function render() {
    if (!S.sec) return;
    renderRail();
    renderNow();
    renderHarmony();
    renderAspects();
    renderSelected();
    renderLikes();
    renderTaste();
    $('#activeCount').textContent = `${activeInstruments().length} on`;
    $('#like').disabled = !E.isPlaying();
  }

  function renderRail() {
    const list = $('#instList');
    list.innerHTML = '';
    for (const inst of E.INSTRUMENTS) {
      const id = inst.id;
      const on = !!S.sec.instruments[id];
      const el = document.createElement('div');
      el.className = 'slot' + (on ? ' on' : '') + (id === S.selected ? ' sel' : '');
      const sw = document.createElement('button');
      sw.className = 'sw';
      sw.textContent = on ? '✓' : '';
      sw.title = on ? 'Drop' : 'Add';
      sw.addEventListener('click', (e) => { e.stopPropagation(); toggleSlot(id); });
      const nm = document.createElement('div');
      nm.className = 'nm';
      const b = document.createElement('b'); b.textContent = INST_LABEL[id] || id;
      const s = document.createElement('span');
      s.textContent = on ? 'playing' : 'off';
      nm.append(b, s);
      const bank = document.createElement('div');
      bank.className = 'bank';
      const field = BANK_FIELD[id];
      bank.textContent = id === 'drums' ? `tone ${(S.sec.drumTone || 0.5).toFixed(1)}` : field ? S.sec[field] : '';
      el.append(sw, nm, bank);
      el.addEventListener('click', () => { S.selected = id; render(); });
      list.appendChild(el);
    }
  }

  function renderNow() {
    const sec = S.sec;
    $('#nowTempo').textContent = `${bpm(sec)} bpm`;
    $('#nowChord').textContent = `${S.key} ${S.mode} · ${S.prog.join(' ')}`;
    const tags = $('#nowTags');
    tags.innerHTML = '';
    for (const c of sec.chords) {
      const s = document.createElement('span'); s.className = 'chord'; s.textContent = chordLabel(c, S.key, S.mode); tags.appendChild(s);
    }
    const riffNames = [...new Set([sec.riff, sec.riffB].filter(Boolean))].map(id => (E.RIFFS[id] || {}).label || id);
    const riff = document.createElement('span'); riff.textContent = `riff · ${riffNames.join(' / ')}`;
    riff.title = 'Two riffs alternate every bar'; tags.appendChild(riff);
    const patNames = [...new Set([sec.pattern, sec.patternB].filter(v => v != null))].map(id => PATTERN_NAMES[id] || 'straight');
    const pat = document.createElement('span'); pat.textContent = `beat · ${patNames.join(' / ')}`;
    pat.title = 'Two drum patterns alternate every bar'; tags.appendChild(pat);
    for (const id of activeInstruments()) {
      const s = document.createElement('span'); s.textContent = INST_LABEL[id]; tags.appendChild(s);
    }
    const sel = document.createElement('span'); sel.className = 'on';
    sel.textContent = `selected · ${INST_LABEL[S.selected]}`;
    tags.appendChild(sel);
  }

  function renderHarmony() {
    const sel = $('#keySel');
    if (!sel) return;
    if (!sel.options.length) {
      for (const k of KEY_LIST) {
        for (const mode of ['major', 'minor']) {
          const o = document.createElement('option');
          o.value = `${k}|${mode}`;
          o.textContent = `${k} ${mode}`;
          sel.appendChild(o);
        }
      }
    }
    sel.value = `${S.key}|${S.mode}`;
    const input = $('#progInput');
    if (input && document.activeElement !== input) input.value = S.prog.join(' ');
    const chords = $('#progChords');
    chords.innerHTML = '';
    for (const c of S.sec.chords) {
      const sp = document.createElement('span');
      sp.textContent = chordLabel(c, S.key, S.mode);
      chords.appendChild(sp);
    }
    const presets = $('#progPresets');
    presets.innerHTML = '';
    for (const p of (NASHVILLE_PRESETS[S.mode] || [])) {
      const b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.textContent = p;
      b.addEventListener('click', () => {
        if (applyProgression(p.split(' '))) {
          if (input) input.value = p;
          render();
        }
      });
      presets.appendChild(b);
    }
  }

  function renderAspects() {
    const box = $('#aspects');
    box.innerHTML = '';
    for (const a of ASPECTS) {
      const btn = document.createElement('button');
      const on = a.id === 'instrument' ? S.aspects.instrument : S.aspects[a.id];
      btn.className = 'aspect' + (on ? ' on' : '');
      const b = document.createElement('b');
      b.textContent = a.id === 'instrument' ? `Instrument · ${INST_LABEL[S.selected]}` : a.label;
      const s = document.createElement('span');
      s.textContent = on ? 'randomising' : 'frozen';
      btn.append(b, s);
      btn.addEventListener('click', () => {
        if (a.id === 'instrument') S.aspects.instrument = !S.aspects.instrument;
        else S.aspects[a.id] = !S.aspects[a.id];
        renderAspects();
      });
      box.appendChild(btn);
    }
    syncPresets();
  }

  function renderSelected() {
    const id = S.selected;
    const sec = S.sec;
    const field = BANK_FIELD[id];
    const meta = [];
    if (field) meta.push(`${INST_LABEL[id]} · ${sec[field]}`);
    else meta.push(INST_LABEL[id]);
    if (id === 'drums') meta.push(`tone ${(sec.drumTone || 0.5).toFixed(2)}`);
    $('#selMeta').textContent = meta.join(' · ');
    const grid = $('#selGrid');
    grid.innerHTML = '';
    const vars = [];
    if (field) vars.push(['Bank', sec[field]]);
    vars.push(['Level', (sec.levels && sec.levels[id] != null ? sec.levels[id] : 1).toFixed(2)]);
    if (!['drums', 'perc'].includes(id)) vars.push(['Octave', `${(sec.regs && sec.regs[id]) || 0}`]);
    if (id === 'bass') vars.push(['Sub', sec.sub ? 'on' : 'off']);
    if (id === 'pluck') vars.push(['Sparkle', sec.sparkle ? 'on' : 'off']);
    if (id === 'lead') vars.push(['Double', sec.double ? 'on' : 'off']);
    if (id === 'drums') vars.push(['Tone', (sec.drumTone || 0.5).toFixed(2)]);
    for (const [k, v] of vars) {
      const d = document.createElement('div');
      d.className = 'var';
      const s = document.createElement('span'); s.textContent = k;
      const b = document.createElement('b'); b.textContent = v;
      d.append(s, b); grid.appendChild(d);
    }
    const on = !!sec.instruments[id];
    $('#toggleInst').textContent = on ? 'Drop' : 'Add';
    $('#toggleInst').disabled = false;
  }

  function renderLikes() {
    const box = $('#liked');
    box.innerHTML = '';
    if (!S.likes.length) {
      const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Nothing captured yet — hit ♥ while it plays.'; box.appendChild(e);
      return;
    }
    for (const item of S.likes) {
      const card = document.createElement('div'); card.className = 'likecard';
      const cv = document.createElement('canvas'); cv.width = 180; cv.height = 24;
      const c = cv.getContext('2d');
      c.fillStyle = 'rgba(124,243,209,0.55)'; c.fillRect(0, 0, 180, 24);
      c.globalCompositeOperation = 'destination-out';
      item.peaks.forEach((p, i) => { const h = Math.max(1, p * 22); c.fillRect((i / item.peaks.length) * 180, 12 - h / 2, 2, h); });
      const lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = item.label;
      lab.title = item.label + ' · ' + (item.context ? chordsLabel(item.context.chords, item.context.key || S.key, item.context.mode || S.mode) + ' · ' + bpm(item.context) + ' bpm' : '');
      const row = document.createElement('div'); row.className = 'row';
      const play = document.createElement('button'); play.textContent = '▶'; play.title = 'Play';
      play.addEventListener('click', () => playLike(item));
      const rm = document.createElement('button'); rm.textContent = '✕'; rm.title = 'Remove';
      rm.addEventListener('click', () => { URL.revokeObjectURL(item.url); dbDelete(item.id); S.likes = S.likes.filter(x => x.id !== item.id); renderLikes(); });
      const time = document.createElement('span'); time.className = 'time';
      time.textContent = item.createdAt ? new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
      row.append(play, rm, time);
      card.append(cv, lab, row);
      box.appendChild(card);
    }
  }
  function playLike(item) {
    const a = $('#clip'); a.hidden = false; a.src = item.url; a.currentTime = 0; a.play().catch(() => {});
    $('#status').textContent = 'Playing a captured moment.';
  }

  function renderTaste() {
    const body = $('#tasteBody');
    body.innerHTML = '';
    $('#resetTaste').style.display = taste.likes ? '' : 'none';
    if (!taste.likes) {
      $('#tasteSummary').textContent = 'Nothing learned yet. Roll, listen, like.';
      return;
    }
    $('#tasteSummary').textContent = `Learned from ${taste.likes} liked moment${taste.likes === 1 ? '' : 's'}.`;
    $('#tastePersona').textContent = personaLine();
    const c = taste.context;

    const traits = [
      { label: 'Tempo', v: c.tempo.n ? c.tempo.sum / c.tempo.n : 0, fmt: v => Math.round(52 + clamp01(v) * 88) + ' bpm' },
      { label: 'Chorus', v: c.chorus.n ? c.chorus.sum / c.chorus.n : 0, fmt: v => Math.round(v * 100) + '%' },
      { label: 'Drive', v: c.drive.n ? c.drive.sum / c.drive.n : 0, fmt: v => Math.round(v * 100) + '%' },
      { label: 'Space', v: c.space.n ? c.space.sum / c.space.n : 0, fmt: v => Math.round(v * 100) + '%' }
    ];
    for (const t of traits) {
      const row = document.createElement('div'); row.className = 'trait';
      const l = document.createElement('span'); l.textContent = t.label;
      const track = document.createElement('div'); track.className = 'track';
      const fill = document.createElement('div'); fill.className = 'fill';
      fill.style.width = `${clamp01(t.v) * 100}%`;
      track.appendChild(fill);
      const b = document.createElement('b'); b.textContent = t.fmt(t.v);
      row.append(l, track, b); body.appendChild(row);
    }

    const sub = (title) => { const h = document.createElement('div'); h.className = 'subhead'; h.textContent = title; body.appendChild(h); };
    const tags = (map, labelOf) => {
      const w = document.createElement('div'); w.className = 'tastetags';
      for (const [k, v] of Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 4)) {
        const s = document.createElement('span'); s.textContent = labelOf(k) + ' ';
        const b = document.createElement('b'); b.textContent = String(Math.round(v * 10) / 10);
        s.appendChild(b); w.appendChild(s);
      }
      body.appendChild(w);
    };
    if (Object.keys(c.chords).length) {
      sub('Progressions');
      tags(c.chords, k => k);
    }
    if (Object.keys(c.riffs).length) { sub('Melodies'); tags(c.riffs, k => (E.RIFFS[k] || {}).label || k); }
    if (Object.keys(c.patterns).length) { sub('Beats'); tags(c.patterns, k => PATTERN_NAMES[k] || k); }

    if (Object.keys(taste.instruments).length) {
      sub('Instruments');
      const w = document.createElement('div'); w.className = 'tastetags';
      for (const [id, t] of Object.entries(taste.instruments)) {
        const bank = id === 'drums' ? `tone ${(t.toneN ? t.toneSum / t.toneN : 0.5).toFixed(2)}` : (topKey(t.banks) || '—');
        const s = document.createElement('span');
        s.textContent = `${INST_LABEL[id] || id} · ${bank} `;
        const b = document.createElement('b'); b.textContent = String(t.levelN);
        s.appendChild(b); w.appendChild(s);
      }
      body.appendChild(w);
    }
    const sel = taste.instruments[S.selected];
    if (sel) {
      sub(`${INST_LABEL[S.selected]} taste`);
      const w = document.createElement('div'); w.className = 'tastetags';
      for (const [k, v] of Object.entries(sel.banks).sort((a, b) => b[1] - a[1])) {
        const s = document.createElement('span'); s.textContent = k + ' ';
        const b = document.createElement('b'); b.textContent = String(v); s.appendChild(b); w.appendChild(s);
      }
      if (sel.levelN) {
        const s = document.createElement('span'); s.textContent = 'level ';
        const b = document.createElement('b'); b.textContent = (sel.levelSum / sel.levelN).toFixed(2); s.appendChild(b); w.appendChild(s);
      }
      for (const [k, v] of Object.entries(sel.regs)) {
        const s = document.createElement('span'); s.textContent = 'oct ' + k + ' ';
        const b = document.createElement('b'); b.textContent = String(v); s.appendChild(b); w.appendChild(s);
      }
      body.appendChild(w);
    }
  }

  function personaLine() {
    if (!taste.likes) return '';
    const banks = [];
    for (const [id, t] of Object.entries(taste.instruments)) {
      if (id === 'drums') {
        if (t.toneN) banks.push(`drums tone ${(t.toneSum / t.toneN).toFixed(2)}`);
        continue;
      }
      const b = topKey(t.banks);
      if (b) banks.push(`${INST_LABEL[id] || id} ${b}`);
    }
    const c = taste.context;
    const prog = topKey(c.chords);
    const riff = topKey(c.riffs);
    const pat = topKey(c.patterns);
    const tempo = c.tempo.n ? Math.round(52 + clamp01(c.tempo.sum / c.tempo.n) * 88) : null;
    return [
      banks.slice(0, 6).join(', '),
      prog || null,
      riff ? (E.RIFFS[riff] || {}).label : null,
      pat ? PATTERN_NAMES[pat] : null,
      tempo ? tempo + ' bpm' : null
    ].filter(Boolean).join(' · ');
  }

  function briefData() {
    return {
      persona: personaLine(),
      taste: {
        likes: taste.likes,
        instruments: taste.instruments,
        context: taste.context
      },
      likedWindows: S.likes.slice(0, 8).map(l => ({
        label: l.label,
        at: l.createdAt ? new Date(l.createdAt).toISOString() : null,
        isolated: l.aspects || null,
        context: {
          key: l.context.key || S.key, mode: l.context.mode || S.mode,
          nashville: (l.context.nashville || S.prog).slice(),
          chords: (l.context.chords || []).map(c => chordLabel(c, l.context.key || S.key, l.context.mode || S.mode)),
          tempo: bpm(l.context),
          pattern: PATTERN_NAMES[l.context.pattern] || '',
          patternB: PATTERN_NAMES[l.context.patternB] || '',
          riff: (E.RIFFS[l.context.riff] || {}).label || '',
          riffB: (E.RIFFS[l.context.riffB] || {}).label || '',
          instruments: Object.keys(l.context.instruments || {}).filter(k => l.context.instruments[k]),
          banks: Object.fromEntries(Object.entries(BANK_FIELD).map(([id, f]) => [id, l.context[f]])),
          levels: l.context.levels || {},
          regs: l.context.regs || {},
          effects: {
            chorus: l.context.chorus, drive: l.context.drive, space: l.context.space,
            delay: l.context.delay, tension: l.context.tension
          }
        }
      }))
    };
  }

  function buildBrief() {
    const data = briefData();
    const sum = $('#briefSummary');
    sum.innerHTML = '';
    const line = (label, value) => {
      const p = document.createElement('p'); p.className = 'briefline';
      const b = document.createElement('b'); b.textContent = label + ' ';
      p.append(b, document.createTextNode(value));
      sum.appendChild(p);
    };
    line('Persona:', data.persona || '(no likes yet)');
    line('Liked windows:', `${data.likedWindows.length}`);
    const topBanks = [];
    for (const [id, t] of Object.entries(taste.instruments)) {
      if (id === 'drums') { if (t.toneN) topBanks.push(`Drums tone ${(t.toneSum / t.toneN).toFixed(2)}`); continue; }
      const b = topKey(t.banks); if (b) topBanks.push(`${INST_LABEL[id] || id} ${b}`);
    }
    line('Instruments:', topBanks.join(', ') || '—');
    line('Progressions:', Object.keys(taste.context.chords).slice(0, 4).join(' / ') || '—');
    const wins = $('#briefWindows');
    wins.innerHTML = '';
    if (!data.likedWindows.length) {
      const p = document.createElement('p'); p.className = 'briefline'; p.textContent = 'No liked windows yet.'; wins.appendChild(p);
    } else {
      for (const w of data.likedWindows) {
        const p = document.createElement('p'); p.className = 'briefline';
        p.textContent = `• ${w.label} — ${w.context.chords.join(' ')} · ${w.context.tempo} bpm · ${w.context.instruments.join(', ')}`;
        wins.appendChild(p);
      }
    }
    $('#briefJson').textContent = JSON.stringify(data, null, 2);
    $('#briefNote').textContent = 'Copy this into opencode to produce a plan. Song create (plan → builder) is the next iteration.';
  }
  function openBrief() {
    buildBrief();
    const dlg = $('#briefDialog');
    if (dlg && !dlg.open) dlg.showModal();
  }

  const PRESETS = [
    { label: 'Instrument only', set: { chords: false, melody: false, tempo: false, beat: false, effects: false, instrument: true } },
    { label: 'Chords only', set: { chords: true, melody: false, tempo: false, beat: false, effects: false, instrument: false } },
    { label: 'Everything', set: { chords: true, melody: true, tempo: true, beat: true, effects: true, instrument: true } },
    { label: 'Freeze all', set: { chords: false, melody: false, tempo: false, beat: false, effects: false, instrument: false } }
  ];
  function renderPresets() {
    const box = $('#presets'); if (!box) return;
    box.innerHTML = '';
    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.textContent = p.label;
      b.dataset.preset = p.label;
      b.addEventListener('click', () => {
        Object.assign(S.aspects, p.set);
        renderAspects();
        $('#status').textContent = `${p.label} · roll to explore.`;
      });
      box.appendChild(b);
    }
    syncPresets();
  }
  function syncPresets() {
    document.querySelectorAll('#presets .chip').forEach(b => {
      const p = PRESETS.find(x => x.label === b.dataset.preset);
      if (!p) return;
      const match = Object.keys(p.set).every(k => !!S.aspects[k] === !!p.set[k]);
      b.classList.toggle('on', match);
    });
    const names = ASPECTS.filter(a => a.id !== 'instrument' ? S.aspects[a.id] : S.aspects.instrument)
      .map(a => a.id === 'instrument' ? `Instrument · ${INST_LABEL[S.selected]}` : a.label);
    $('#isoNote').textContent = names.length
      ? `A roll changes: ${names.join(', ')}. Everything else stays.`
      : 'Everything is frozen — a roll will not change anything.';
  }

  /* ---------------- playback / capture ---------------- */
  function ensurePlaying() {
    if (!E.isPlaying()) {
      E.song.sections = [S.sec];
      E.play();
      startCapture();
      $('#like').disabled = false;
    }
    updatePlay();
  }
  function updatePlay() {
    const on = E.isPlaying();
    const b = $('#play');
    b.classList.toggle('playing', on);
    b.textContent = on ? '❚❚' : '▶';
    $('#like').disabled = !on;
  }
  function togglePlay() {
    if (E.isPlaying()) { E.pause(); updatePlay(); }
    else ensurePlaying();
  }

  function drawViz() {
    const cv = $('#viz'); if (!cv) { S.raf = requestAnimationFrame(drawViz); return; }
    const ctx = cv.getContext('2d');
    const w = cv.clientWidth || 600, h = cv.clientHeight || 46;
    if (cv.width !== w * 2) { cv.width = w * 2; cv.height = h * 2; }
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (S.analyser) {
      const data = new Uint8Array(S.analyser.frequencyBinCount);
      S.analyser.getByteFrequencyData(data);
      const bars = 64, bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const v = data[Math.floor((i / bars) * data.length * 0.7)] / 255;
        const bh = Math.max(2, v * v * h * 0.92);
        ctx.fillStyle = `rgba(124,243,209,${0.18 + v * 0.62})`;
        ctx.fillRect(i * bw + 1, h - bh - 1, Math.max(1, bw - 2), bh);
      }
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    }
    S.raf = requestAnimationFrame(drawViz);
  }

  function tick() {
    const pos = E.position();
    if (S.evolve > 0 && pos && pos.bi % S.evolve === 0 && pos.t0 !== S.lastEvolveT) {
      S.lastEvolveT = pos.t0;
      roll();
    }
    requestAnimationFrame(tick);
  }

  /* ---------------- boot ---------------- */
  S.sec = baseSection();
  applyProgression(S.prog);
  E.song.sections = [S.sec];

  $('#keySel').addEventListener('change', () => {
    const [k, m] = $('#keySel').value.split('|');
    S.key = k; S.mode = m;
    if (!applyProgression(S.prog)) applyProgression(NASHVILLE_PRESETS[S.mode][0].split(' '));
    render();
  });
  $('#progInput').addEventListener('input', () => {
    const input = $('#progInput');
    const tokens = input.value.trim().split(/[,\s]+/).filter(Boolean);
    if (!tokens.length) { input.classList.add('invalid'); return; }
    if (applyProgression(tokens)) {
      input.classList.remove('invalid');
      renderHarmony();
      renderNow();
    } else {
      input.classList.add('invalid');
    }
  });
  $('#play').addEventListener('click', togglePlay);
  $('#like').addEventListener('click', likeCurrent);
  $('#roll').addEventListener('click', () => roll());
  $('#rollInst').addEventListener('click', () => { rollInstrument(S.selected); render(); });
  $('#toggleInst').addEventListener('click', () => toggleSlot(S.selected));
  $('#auto').addEventListener('click', () => {
    S.evolve = S.evolve === 4 ? 2 : S.evolve === 2 ? 0 : 4;
    S.lastEvolveT = -1;
    const label = S.evolve === 0 ? 'off' : S.evolve === 2 ? 'every 2 bars' : 'every loop';
    $('#auto').classList.toggle('on', S.evolve > 0);
    $('#auto').textContent = `Evolve: ${label}`;
  });
  $('#resetTaste').addEventListener('click', () => {
    taste = blankTaste(); saveTaste();
    $('#tastePersona').textContent = '';
    renderTaste();
    $('#status').textContent = 'Taste reset. Captured moments remain.';
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.key.toLowerCase() === 'l') likeCurrent();
    if (e.key.toLowerCase() === 'r') roll();
  });
  $('#clip').addEventListener('ended', () => { $('#status').textContent = 'Captured moment finished.'; });
  $('#briefBtn').addEventListener('click', openBrief);
  $('#tasteBrief').addEventListener('click', openBrief);
  $('#briefClose').addEventListener('click', () => $('#briefDialog').close());
  $('#briefDone').addEventListener('click', () => $('#briefDialog').close());
  $('#downloadBrief').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(briefData(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'song-canvas-taste-brief.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('#copyBrief').addEventListener('click', async () => {
    const text = 'You are the creative director for Song Canvas. Use this taste profile and liked windows to propose a song plan (sections, instruments/banks, chords, tempo, transitions), then a builder will render it.\n\n' + JSON.stringify(briefData(), null, 2);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) {}
      ta.remove();
    }
    $('#briefNote').textContent = ok ? 'Brief copied — paste it into opencode.' : 'Copy blocked; select the JSON manually.';
  });

  async function restoreLikes() {
    const rows = await dbAll();
    if (!rows.length) return;
    S.likes = rows.filter(r => r && r.blob).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(r => Object.assign({}, r, { url: URL.createObjectURL(r.blob) }));
    renderLikes();
    $('#status').textContent = `${S.likes.length} captured moment${S.likes.length === 1 ? '' : 's'} restored.`;
  }

  renderPresets();
  render();
  drawViz();
  requestAnimationFrame(tick);
  updatePlay();
  restoreLikes();

  window.Discovery = {
    state: S,
    taste: () => taste,
    roll,
    rollInstrument,
    toggleSlot,
    like: likeCurrent,
    brief: briefData,
    engine: E
  };
  window.__SC5_READY__ = true;
})();
