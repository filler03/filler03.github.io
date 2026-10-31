/* ============================================================
   Song Canvas — Prototype 2.1 (guided session, expanded)
   More feels, players, attributes; per-section editing; final
   arrangement render + opencode commission.
   ============================================================ */
(function () {
  'use strict';

  const E = window.SongEngine;
  const stage = document.getElementById('stage');
  const progressFill = document.getElementById('progressFill');
  const stepName = document.getElementById('stepName');
  const backBtn = document.getElementById('back');
  const playBtn = document.getElementById('play');
  const HUES = [168, 205, 272, 324, 32, 112, 190, 250];
  const hueFor = i => HUES[i % HUES.length];

  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const round2 = v => Math.round(v * 100) / 100;
  const clone = o => JSON.parse(JSON.stringify(o));

  const S = {
    step: 'mood',
    cur: 0,
    history: [],
    pendingRole: null,
    feelNext: 'pace',
    selectedMood: null,
    notes: '',
    busy: false,
    renderUrl: null,
    renderDur: 0,
    status: '',
    ai: null,
    aiBusy: false
  };
  const API = (window.SONGCANVAS_API || '').replace(/\/+$/, '');

  const STEP_LABEL = {
    mood: 'feeling', pace: 'pace', harmony: 'colour', instruments: 'players',
    shape: 'shape', next: 'next', place: 'place', review: 'review',
    edit: 'edit', compose: 'compose'
  };
  const PROGRESS = {
    mood: 0.06, pace: 0.2, harmony: 0.34, instruments: 0.46,
    shape: 0.58, next: 0.7, place: 0.77, review: 0.88, edit: 0.9, compose: 1
  };

  /* ---------------- feels ---------------- */
  const DEFAULT_INST = { pad: false, keys: false, strings: false, pluck: false, bells: false, bass: false, drums: false, perc: false };
  const moods = [
    { id: 'rain', family: 'calm', label: 'Rainy night', desc: 'slow, blue, close', h: 205, h2: 240,
      base: { energy: 0.3, brightness: 0.28, tension: 0.44, density: 0.3, space: 0.56, pace: 0.34 },
      swing: 0.1, human: 0.3, progression: 'dark', riff: 'drift',
      instruments: { pad: true, pluck: true, bass: true } },
    { id: 'fog', family: 'calm', label: 'Morning fog', desc: 'soft, blurred, awake', h: 188, h2: 210,
      base: { energy: 0.24, brightness: 0.5, tension: 0.2, density: 0.26, space: 0.66, pace: 0.28 },
      swing: 0, human: 0.35, progression: 'floating', riff: 'sparse',
      instruments: { strings: true, keys: true, bass: true } },
    { id: 'space', family: 'calm', label: 'Deep space', desc: 'weightless, wide', h: 250, h2: 280,
      base: { energy: 0.2, brightness: 0.4, tension: 0.3, density: 0.22, space: 0.85, pace: 0.2 },
      swing: 0, human: 0.2, progression: 'suspended', riff: 'call',
      instruments: { pad: true, bells: true, bass: true } },
    { id: 'campfire', family: 'warm', label: 'Campfire', desc: 'simple, intimate, warm', h: 24, h2: 8,
      base: { energy: 0.42, brightness: 0.55, tension: 0.15, density: 0.38, space: 0.24, pace: 0.44 },
      swing: 0.25, human: 0.45, progression: 'open', riff: 'lullaby',
      instruments: { keys: true, pluck: true, bass: true } },
    { id: 'sun', family: 'warm', label: 'Sunlit', desc: 'warm, open, easy', h: 42, h2: 18,
      base: { energy: 0.5, brightness: 0.72, tension: 0.2, density: 0.5, space: 0.36, pace: 0.5 },
      swing: 0.12, human: 0.25, progression: 'rising', riff: 'spark',
      instruments: { pad: true, keys: true, pluck: true, bass: true, drums: true } },
    { id: 'highway', family: 'moving', label: 'Highway', desc: 'steady, rolling, open road', h: 210, h2: 232,
      base: { energy: 0.6, brightness: 0.58, tension: 0.25, density: 0.58, space: 0.32, pace: 0.58 },
      swing: 0.05, human: 0.2, progression: 'hopeful', riff: 'pulse',
      instruments: { pad: true, pluck: true, bass: true, drums: true, perc: true } },
    { id: 'neon', family: 'moving', label: 'Neon city', desc: 'tense, moving, bright edges', h: 292, h2: 320,
      base: { energy: 0.72, brightness: 0.6, tension: 0.56, density: 0.7, space: 0.24, pace: 0.7 },
      swing: 0, human: 0.15, progression: 'driving', riff: 'hook',
      instruments: { keys: true, pluck: true, bass: true, drums: true, perc: true } },
    { id: 'storm', family: 'dark', label: 'Storm', desc: 'heavy, fast, sharp', h: 190, h2: 210,
      base: { energy: 0.88, brightness: 0.46, tension: 0.62, density: 0.84, space: 0.3, pace: 0.84 },
      swing: 0, human: 0.1, progression: 'dark', riff: 'drive',
      instruments: { strings: true, bass: true, drums: true, perc: true } },
    { id: 'midnight', family: 'dark', label: 'Midnight', desc: 'sparse, cold, patient', h: 226, h2: 252,
      base: { energy: 0.26, brightness: 0.22, tension: 0.5, density: 0.24, space: 0.62, pace: 0.3 },
      swing: 0.18, human: 0.4, progression: 'longing', riff: 'call',
      instruments: { pad: true, bells: true, bass: true, drums: true } },
    { id: 'smoulder', family: 'dark', label: 'Smoulder', desc: 'slow burn, close, heavy', h: 12, h2: 348,
      base: { energy: 0.46, brightness: 0.36, tension: 0.52, density: 0.44, space: 0.34, pace: 0.36 },
      swing: 0.32, human: 0.4, progression: 'longing', riff: 'weave',
      instruments: { keys: true, strings: true, bass: true, drums: true } },
    { id: 'glass', family: 'fragile', label: 'Glass', desc: 'fragile, high, ringing', h: 168, h2: 190,
      base: { energy: 0.3, brightness: 0.66, tension: 0.34, density: 0.3, space: 0.58, pace: 0.34 },
      swing: 0, human: 0.5, progression: 'suspended', riff: 'call',
      instruments: { bells: true, pad: true, bass: true } },
    { id: 'carnival', family: 'fragile', label: 'Carnival', desc: 'playful, bright, busy', h: 320, h2: 40,
      base: { energy: 0.68, brightness: 0.8, tension: 0.34, density: 0.72, space: 0.22, pace: 0.68 },
      swing: 0.28, human: 0.3, progression: 'hopeful', riff: 'pulse',
      instruments: { keys: true, pluck: true, bass: true, drums: true, perc: true } }
  ];

  const PROG_DESC = {
    bittersweet: 'warm, a little unresolved',
    dark: 'heavy, cinematic',
    rising: 'hopeful, lifting',
    floating: 'weightless, open',
    open: 'wide and simple',
    longing: 'aching, reaching',
    hopeful: 'light at the edge',
    suspended: 'hanging in the air',
    driving: 'forward motion'
  };

  const PACE_WORDS = [
    { v: 0.22, label: 'Slow' },
    { v: 0.42, label: 'Steady' },
    { v: 0.6, label: 'Moving' },
    { v: 0.8, label: 'Driving' }
  ];
  const SWING_WORDS = [
    { v: 0, label: 'Straight' },
    { v: 0.25, label: 'Shuffle' },
    { v: 0.5, label: 'Swung' }
  ];
  const HUMAN_WORDS = [
    { v: 0, label: 'Tight' },
    { v: 0.2, label: 'Human' },
    { v: 0.45, label: 'Loose' }
  ];

  /* ---------------- helpers ---------------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function add(parent, node) { parent.appendChild(node); return node; }
  function screen() {
    stage.innerHTML = '';
    const s = el('section', 'screen');
    stage.appendChild(s);
    return s;
  }
  function heading(root, eyebrow, title, sub) {
    if (eyebrow) add(root, el('p', 'eyebrow', eyebrow));
    add(root, el('h1', null, title));
    if (sub) add(root, el('p', 'sub', sub));
  }
  function current() { return E.song.sections[S.cur]; }
  function paceWord(v) { return v < 0.3 ? 'slow' : v < 0.48 ? 'steady' : v < 0.68 ? 'moving' : 'driving'; }
  function bpmFor(v) { return Math.round(62 + clamp01(v) * 56); }

  function ensurePlaying() {
    if (!E.isPlaying()) {
      E.play();
      syncPlayButton();
    }
  }
  function syncPlayButton() {
    const on = E.isPlaying();
    playBtn.classList.toggle('playing', on);
    playBtn.textContent = on ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  }

  function markNearestChip(row, v) {
    let best = null, bestD = 1e9;
    row.querySelectorAll('.chip').forEach((c) => {
      const d = Math.abs(parseFloat(c.dataset.v) - v);
      if (d < bestD) { bestD = d; best = c; }
    });
    row.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === best));
  }

  /* ---------------- navigation ---------------- */
  function snapshot() {
    return JSON.stringify({ step: S.step, cur: S.cur, sections: E.song.sections, pendingRole: S.pendingRole, feelNext: S.feelNext, selectedMood: S.selectedMood });
  }
  function go(step) {
    S.history.push(snapshot());
    S.step = step;
    render();
  }
  function back() {
    const raw = S.history.pop();
    if (!raw) return;
    const o = JSON.parse(raw);
    S.step = o.step;
    S.cur = o.cur;
    S.pendingRole = o.pendingRole;
    S.feelNext = o.feelNext;
    S.selectedMood = o.selectedMood;
    E.song.sections = o.sections;
    render();
  }

  /* ---------------- mood application ---------------- */
  function applyMood(sec, m) {
    Object.assign(sec, clone(m.base));
    sec.swing = m.swing || 0;
    sec.human = m.human != null ? m.human : 0.15;
    sec.progression = m.progression;
    sec.riff = m.riff;
    sec.instruments = Object.assign(clone(DEFAULT_INST), m.instruments);
    S.selectedMood = m.id;
  }

  function moodById(id) { return moods.find(m => m.id === id) || moods[0]; }

  /* ---------------- screens ---------------- */
  function render() {
    playBtn.disabled = E.song.sections.length === 0;
    progressFill.style.width = `${(PROGRESS[S.step] || 0.05) * 100}%`;
    stepName.textContent = STEP_LABEL[S.step] || '';
    backBtn.disabled = S.history.length === 0;
    syncPlayButton();
    if (S.step === 'mood') renderMood();
    else if (S.step === 'pace') renderPace();
    else if (S.step === 'harmony') renderHarmony();
    else if (S.step === 'instruments') renderInstruments();
    else if (S.step === 'shape') renderShape();
    else if (S.step === 'next') renderNext();
    else if (S.step === 'place') renderPlace();
    else if (S.step === 'review') renderReview();
    else if (S.step === 'edit') renderEdit();
    else renderCompose();
  }

  /* --- feel screen (with vibe pad) --- */
  function renderMood() {
    const s = screen();
    const first = E.song.sections.length === 0;
    if (first) {
      const sec = E.section({ name: 'Open', bars: 2 });
      applyMood(sec, moods[0]);
      E.song.sections = [sec];
      S.cur = 0;
    }
    const sec = current();

    heading(s, first ? '1 · feeling' : 'feel', 'What does it feel like?', 'Tap a card, or drag through the field. Everything can change later.');

    // vibe field
    const field = add(s, el('div', 'feelmap'));
    const canvas = add(field, el('canvas', 'vibecanvas'));
    const cap = add(field, el('div', 'maplegend'));
    const capName = add(cap, el('span', 'mapname', ''));
    add(cap, el('span', 'maplegendtxt', 'calm → intense  ·  dark → bright'));

    const cctx = canvas.getContext('2d');
    let hover = null;
    function draw() {
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = r.width, h = r.height;
      const pad = 24;
      const fw = w - pad * 2, fh = h - pad * 2;
      cctx.clearRect(0, 0, w, h);
      const grd = cctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.7);
      grd.addColorStop(0, 'rgba(124,243,209,0.06)');
      grd.addColorStop(1, 'rgba(8,9,13,0)');
      cctx.fillStyle = grd;
      cctx.fillRect(0, 0, w, h);
      cctx.strokeStyle = 'rgba(255,255,255,0.06)';
      cctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const x = pad + (fw * i) / 4, y = pad + (fh * i) / 4;
        cctx.beginPath(); cctx.moveTo(x, pad); cctx.lineTo(x, pad + fh); cctx.stroke();
        cctx.beginPath(); cctx.moveTo(pad, y); cctx.lineTo(pad + fw, y); cctx.stroke();
      }
      for (const m of moods) {
        const x = pad + clamp01(m.base.energy) * fw;
        const y = pad + (1 - clamp01(m.base.brightness)) * fh;
        cctx.beginPath();
        cctx.arc(x, y, 4, 0, Math.PI * 2);
        cctx.fillStyle = `hsl(${m.h} 70% 66% / 0.65)`;
        cctx.fill();
      }
      const ox = pad + clamp01(sec.energy) * fw;
      const oy = pad + (1 - clamp01(sec.brightness)) * fh;
      const sel = hover || moods.find(m => m.id === S.selectedMood);
      if (sel) {
        const sx = pad + clamp01(sel.base.energy) * fw;
        const sy = pad + (1 - clamp01(sel.base.brightness)) * fh;
        cctx.beginPath();
        cctx.arc(sx, sy, 13, 0, Math.PI * 2);
        cctx.strokeStyle = 'rgba(255,255,255,0.5)';
        cctx.lineWidth = 1.5;
        cctx.stroke();
      }
      cctx.beginPath();
      cctx.arc(ox, oy, 9, 0, Math.PI * 2);
      cctx.fillStyle = '#eceaf5';
      cctx.shadowColor = 'rgba(255,255,255,0.5)';
      cctx.shadowBlur = 18;
      cctx.fill();
      cctx.shadowBlur = 0;
      capName.textContent = sel ? sel.label : 'somewhere between';
    }

    function nearestMood(px, py) {
      const r = canvas.getBoundingClientRect();
      const pad = 24;
      const fw = r.width - pad * 2, fh = r.height - pad * 2;
      const ex = clamp01((px - r.left - pad) / fw);
      const ey = 1 - clamp01((py - r.top - pad) / fh);
      let best = null, bestD = 1e9;
      for (const m of moods) {
        const dx = m.base.energy - ex;
        const dy = m.base.brightness - ey;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = m; }
      }
      return best;
    }

    let draggingField = false;
    function pick(e) {
      const m = nearestMood(e.clientX, e.clientY);
      if (m) {
        hover = m;
        applyMood(sec, m);
        if (E.isPlaying()) { /* applies on next bar */ }
        syncMoodCards();
        draw();
      }
    }
    canvas.addEventListener('pointerdown', (e) => {
      draggingField = true;
      canvas.setPointerCapture(e.pointerId);
      pick(e);
    });
    canvas.addEventListener('pointermove', (e) => { if (draggingField) pick(e); });
    canvas.addEventListener('pointerup', () => { draggingField = false; hover = null; });
    canvas.addEventListener('pointercancel', () => { draggingField = false; hover = null; });

    // mood cards
    const grid = add(s, el('div', 'moodgrid'));
    moods.forEach((m) => {
      const b = el('button', 'mood small' + (S.selectedMood === m.id ? ' on' : ''));
      b.type = 'button';
      b.dataset.id = m.id;
      b.style.setProperty('--h', m.h);
      b.style.setProperty('--h2', m.h2);
      add(b, el('span', 'orb'));
      const txt = add(b, el('span', 'txt'));
      add(txt, el('b', null, m.label));
      add(txt, el('span', null, m.desc));
      b.addEventListener('click', () => {
        applyMood(sec, m);
        ensurePlaying();
        syncMoodCards();
        draw();
      });
      add(grid, b);
    });
    function syncMoodCards() {
      grid.querySelectorAll('.mood').forEach((c) => c.classList.toggle('on', c.dataset.id === S.selectedMood));
    }

    const acts = add(s, el('div', 'actions'));
    const lucky = add(acts, el('button', 'textbtn', 'Choose for me'));
    lucky.type = 'button';
    lucky.addEventListener('click', () => {
      const m = moods[Math.floor(Math.random() * moods.length)];
      applyMood(sec, m);
      ensurePlaying();
      syncMoodCards();
      draw();
    });
    const next = add(acts, el('button', 'primary', first ? 'That feels right →' : 'Use this feel →'));
    next.type = 'button';
    next.addEventListener('click', () => {
      ensurePlaying();
      go(S.feelNext || 'pace');
    });
    if (!first) {
      const keep = add(acts, el('button', 'textbtn', 'Keep it as it was →'));
      keep.type = 'button';
      keep.addEventListener('click', () => go(S.feelNext || 'instruments'));
    }

    requestAnimationFrame(draw);
    window.addEventListener('resize', draw, { once: true });
  }

  /* --- pace --- */
  function renderPace() {
    const s = screen();
    const sec = current();
    heading(s, '2 · pace', 'How fast does it move?', 'Drag the pulse, or pick a word. Pace can differ for every moment.');

    const box = add(s, el('div', 'pacebox'));
    const rail = add(box, el('div', 'rail'));
    add(rail, el('div', 'glow'));
    const ticks = add(rail, el('div', 'ticks'));
    for (let i = 0; i < 9; i++) add(ticks, el('i'));
    const knob = add(rail, el('span', 'knob'));
    const labels = add(box, el('div', 'raillabels'));
    add(labels, el('span', null, 'slow'));
    add(labels, el('span', null, 'fast'));
    const bpmRow = add(box, el('div', 'bpm'));
    const bpmVal = add(bpmRow, el('b', null, String(bpmFor(sec.pace))));
    add(bpmRow, el('span', null, 'beats a minute'));
    const pulse = add(box, el('div', 'pulse'));
    const dots = [];
    for (let i = 0; i < 4; i++) dots.push(add(pulse, el('i')));

    const chipRow = add(s, el('div', 'chips large'));
    PACE_WORDS.forEach((p) => {
      const c = el('button', 'chip', p.label);
      c.type = 'button';
      c.dataset.v = String(p.v);
      c.addEventListener('click', () => { sec.pace = p.v; paint(); });
      add(chipRow, c);
    });

    function paint() {
      const v = clamp01(sec.pace);
      rail.querySelector('.glow').style.width = `${v * 100}%`;
      knob.style.left = `${v * 100}%`;
      bpmVal.textContent = String(bpmFor(v));
      const dur = 60 / bpmFor(v);
      dots.forEach((d, i) => {
        d.style.animationDuration = dur.toFixed(3) + 's';
        d.style.animationDelay = (-(i * dur) / 4).toFixed(3) + 's';
      });
      markNearestChip(chipRow, v);
    }

    let dragging = false;
    const setFromEvent = (e) => {
      const r = rail.getBoundingClientRect();
      sec.pace = clamp01((e.clientX - r.left) / Math.max(1, r.width));
      paint();
    };
    rail.addEventListener('pointerdown', (e) => { dragging = true; rail.setPointerCapture(e.pointerId); setFromEvent(e); });
    rail.addEventListener('pointermove', (e) => { if (dragging) setFromEvent(e); });
    rail.addEventListener('pointerup', () => { dragging = false; });
    rail.addEventListener('pointercancel', () => { dragging = false; });
    paint();

    const acts = add(s, el('div', 'actions'));
    const next = add(acts, el('button', 'primary', 'That feels right →'));
    next.type = 'button';
    next.addEventListener('click', () => go('harmony'));
  }

  /* --- harmony --- */
  function renderHarmony() {
    const s = screen();
    const sec = current();
    heading(s, '3 · colour', 'What colour should it have?', 'Flavours, not chords you need to know. Tap one and it changes as it plays.');

    const list = add(s, el('div', 'choices'));
    Object.entries(E.PROGRESSIONS).forEach(([id, p]) => {
      const b = el('button', 'choice');
      b.type = 'button';
      add(b, el('span', 'icon', '~'));
      const txt = add(b, el('span', 'txt'));
      add(txt, el('b', null, p.label));
      add(txt, el('span', null, PROG_DESC[id] || ''));
      add(b, el('span', 'arrow', '→'));
      b.addEventListener('click', () => {
        sec.progression = id;
        ensurePlaying();
        go('instruments');
      });
      add(list, b);
    });
  }

  /* --- instruments --- */
  function renderInstruments() {
    const s = screen();
    const sec = current();
    heading(s, '4 · players', 'Who plays in this moment?', 'Tap to invite or remove. The loop is already listening.');

    const row = add(s, el('div', 'chips large'));
    E.INSTRUMENTS.forEach((inst) => {
      const c = el('button', 'chip' + (sec.instruments[inst.id] ? ' on' : ''), inst.label);
      c.type = 'button';
      c.title = inst.hint || '';
      c.addEventListener('click', () => {
        sec.instruments[inst.id] = !sec.instruments[inst.id];
        c.classList.toggle('on', sec.instruments[inst.id]);
        ensurePlaying();
      });
      add(row, c);
    });
    add(s, el('p', 'small', 'Pad, Keys and Strings hold the chord; Pluck and Bells carry the figure; Bass, Drums and Shaker hold it down.'));

    const acts = add(s, el('div', 'actions'));
    const next = add(acts, el('button', 'primary', 'Shape this moment →'));
    next.type = 'button';
    next.addEventListener('click', () => go('shape'));
  }

  /* --- shape --- */
  function padDescriptor(kind, v) {
    if (kind === 'brightness') return v < 0.33 ? 'dark' : v < 0.55 ? 'soft' : v < 0.78 ? 'bright' : 'glowing';
    if (kind === 'density') return v < 0.33 ? 'sparse' : v < 0.55 ? 'moving' : v < 0.78 ? 'busy' : 'packed';
    if (kind === 'tension') return v < 0.33 ? 'gentle' : v < 0.55 ? 'restless' : v < 0.78 ? 'sharp' : 'edgy';
    return v < 0.33 ? 'dry' : v < 0.55 ? 'roomy' : v < 0.78 ? 'wide' : 'vast';
  }

  function makePad(kind, sec) {
    const wrap = el('div', 'pad');
    const lbl = add(wrap, el('div', 'lbl'));
    const names = {
      brightness: ['bright', 'dark'],
      density: ['busy', 'sparse'],
      tension: ['sharp', 'gentle'],
      space: ['wide', 'dry']
    };
    const cats = { brightness: 'Light', density: 'Fullness', tension: 'Edge', space: 'Room' };
    add(lbl, el('span', null, cats[kind]));
    const val = add(lbl, el('b', null, ''));
    const track = add(wrap, el('div', 'padtrack'));
    add(track, el('span', 'padedge top', names[kind][0]));
    add(track, el('span', 'padedge bot', names[kind][1]));
    const fill = add(track, el('div', 'padfill'));
    const orb = add(track, el('span', 'padorb'));
    function paint(v) {
      fill.style.height = `${v * 100}%`;
      orb.style.bottom = `${v * 100}%`;
      val.textContent = padDescriptor(kind, v);
    }
    paint(sec[kind]);
    let dragging = false;
    const setFromEvent = (e) => {
      const r = track.getBoundingClientRect();
      const v = clamp01(1 - (e.clientY - r.top) / Math.max(1, r.height));
      sec[kind] = v;
      paint(v);
      ensurePlaying();
    };
    track.addEventListener('pointerdown', (e) => { dragging = true; track.setPointerCapture(e.pointerId); setFromEvent(e); });
    track.addEventListener('pointermove', (e) => { if (dragging) setFromEvent(e); });
    track.addEventListener('pointerup', () => { dragging = false; });
    track.addEventListener('pointercancel', () => { dragging = false; });
    return { wrap, paint: () => paint(sec[kind]) };
  }

  function chipRow(parent, words, value, onChange, caption) {
    if (caption) add(parent, el('p', 'small caption', caption));
    const row = add(parent, el('div', 'chips'));
    words.forEach((p) => {
      const c = el('button', 'chip', p.label);
      c.type = 'button';
      c.dataset.v = String(p.v);
      c.addEventListener('click', () => {
        onChange(p.v);
        markNearestChip(row, p.v);
      });
      add(row, c);
    });
    markNearestChip(row, value);
    return row;
  }

  function barsStepper(sec) {
    const wrap = el('div', 'chips');
    const minus = add(wrap, el('button', 'chip', '−'));
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Fewer bars');
    const label = add(wrap, el('span', 'small', `${sec.bars} bars`));
    label.style.alignSelf = 'center';
    const plus = add(wrap, el('button', 'chip', '+'));
    plus.type = 'button';
    plus.setAttribute('aria-label', 'More bars');
    minus.addEventListener('click', () => { sec.bars = Math.max(1, sec.bars - 1); label.textContent = `${sec.bars} bars`; });
    plus.addEventListener('click', () => { sec.bars = Math.min(16, sec.bars + 1); label.textContent = `${sec.bars} bars`; });
    return wrap;
  }

  function renderShape() {
    const s = screen();
    const sec = current();
    heading(s, '5 · shape', 'Shape this moment.', "Drag each bar. It's playing — you'll hear it change on the next bar.");

    const grid = add(s, el('div', 'pads'));
    const pads = [];
    ['brightness', 'density', 'tension', 'space'].forEach((kind) => {
      const p = makePad(kind, sec);
      pads.push(p);
      add(grid, p.wrap);
    });

    const ctrls = add(s, el('div', 'shapecontrols'));
    const c1 = add(ctrls, el('div', 'ctrlbox'));
    chipRow(c1, PACE_WORDS, sec.pace, v => { sec.pace = v; }, 'Pace');
    const c2 = add(ctrls, el('div', 'ctrlbox'));
    chipRow(c2, SWING_WORDS, sec.swing, v => { sec.swing = v; }, 'Groove');
    const c3 = add(ctrls, el('div', 'ctrlbox'));
    chipRow(c3, HUMAN_WORDS, sec.human, v => { sec.human = v; }, 'Feel');
    const c4 = add(ctrls, el('div', 'ctrlbox'));
    add(c4, el('p', 'small caption', 'Length'));
    add(c4, barsStepper(sec));

    const acts = add(s, el('div', 'actions'));
    const lucky = add(acts, el('button', 'textbtn', 'Let it choose'));
    lucky.type = 'button';
    lucky.addEventListener('click', () => {
      sec.brightness = Math.random();
      sec.density = Math.random();
      sec.tension = Math.random() * 0.8;
      sec.space = Math.random() * 0.8;
      pads.forEach(p => p.paint());
    });
    const done = add(acts, el('button', 'primary', 'Done →'));
    done.type = 'button';
    done.addEventListener('click', () => go('next'));
  }

  /* --- next --- */
  function renderNext() {
    const s = screen();
    heading(s, '6 · next', 'What happens next?', 'Songs are built one moment at a time. Pick a direction, or stop here.');

    const list = add(s, el('div', 'choices'));
    const options = [
      { role: 'End', icon: '■', label: "That's the end", desc: 'Finish the song here.', end: true },
      { role: 'Keep', icon: '≈', label: 'Keep it going', desc: 'A new moment, close to this one.' },
      { role: 'Lift', icon: '↑', label: 'Lift it', desc: 'Brighter, fuller, more forward.' },
      { role: 'Break', icon: '↓', label: 'Break it down', desc: 'Strip back, open up, let it breathe.' }
    ];
    options.forEach((o) => {
      const b = el('button', 'choice');
      b.type = 'button';
      add(b, el('span', 'icon', o.icon));
      const txt = add(b, el('span', 'txt'));
      add(txt, el('b', null, o.label));
      add(txt, el('span', null, o.desc));
      add(b, el('span', 'arrow', '→'));
      b.addEventListener('click', () => {
        if (o.end) { go('review'); return; }
        S.pendingRole = o.role;
        go('place');
      });
      add(list, b);
    });
  }

  /* --- place --- */
  function renderPlace() {
    const s = screen();
    heading(s, '7 · place', 'Where should it go?', 'The order is still yours. Nothing is locked in.');

    const list = add(s, el('div', 'choices'));
    const opts = [
      { id: 'after', label: 'Right after this', desc: 'The natural next chapter.' },
      { id: 'before', label: 'Before this', desc: 'Drop it in earlier and shift the rest.' },
      { id: 'end', label: 'At the very end', desc: 'A new closer.' }
    ];
    opts.forEach((o) => {
      const b = el('button', 'choice');
      b.type = 'button';
      add(b, el('span', 'icon', '▸'));
      const txt = add(b, el('span', 'txt'));
      add(txt, el('b', null, o.label));
      add(txt, el('span', null, o.desc));
      add(b, el('span', 'arrow', '→'));
      b.addEventListener('click', () => {
        S.history.push(snapshot());
        createSection(S.pendingRole, o.id);
        S.feelNext = 'instruments';
        S.selectedMood = null;
        S.step = 'mood';
        render();
      });
      add(list, b);
    });
  }

  function uniqueName(base) {
    const names = E.song.sections.map(s => s.name);
    if (!names.includes(base)) return base;
    let i = 2;
    while (names.includes(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  function createSection(role, place) {
    const base = current() || E.song.sections[E.song.sections.length - 1];
    const s = clone(base);
    s.name = uniqueName(role === 'Keep' ? 'Continue' : role);
    s.bars = 2;
    s.flow = role === 'Lift' ? 'lift' : role === 'Break' ? 'drift' : 'blend';
    if (role === 'Lift') {
      s.energy = clamp01(s.energy + 0.16); s.brightness = clamp01(s.brightness + 0.12);
      s.density = clamp01(s.density + 0.14); s.tension = clamp01(s.tension + 0.06);
      s.instruments.drums = true;
    } else if (role === 'Break') {
      s.energy = clamp01(s.energy - 0.18); s.density = clamp01(s.density - 0.2);
      s.brightness = clamp01(s.brightness - 0.1); s.space = clamp01(s.space + 0.15);
      s.instruments.drums = false;
    } else {
      s.energy = clamp01(s.energy + 0.04); s.density = clamp01(s.density + 0.04);
    }
    let idx;
    if (place === 'before') idx = S.cur;
    else if (place === 'end') idx = E.song.sections.length;
    else idx = S.cur + 1;
    E.song.sections.splice(idx, 0, s);
    S.cur = idx;
  }

  /* --- review --- */
  function renderReview() {
    const s = screen();
    heading(s, '8 · review', 'Your song so far.', 'Play it, edit any moment, or build the final version.');

    const tl = add(s, el('div', 'timeline'));
    E.song.sections.forEach((sec, i) => {
      const row = el('div', 'tlrow' + (i === S.cur ? ' on' : ''));
      row.style.setProperty('--dot', `hsl(${hueFor(i)} 72% 68%)`);
      add(row, el('span', 'dot'));
      const grow = add(row, el('div', 'grow'));
      add(grow, el('div', 'nm', `${i + 1}. ${sec.name}`));
      add(grow, el('div', 'meta', `${sec.bars} bars · ${(E.RIFFS[sec.riff] || {}).label || ''} · ${paceWord(sec.pace)}`));
      const bars = add(row, el('div', 'bars'));
      for (let k = 0; k < 6; k++) {
        const seg = add(bars, el('i'));
        seg.style.setProperty('--o', String(Math.max(0.12, clamp01(sec.energy + (k - 3) * 0.08))));
      }
      const acts = add(row, el('div', 'acts'));
      const up = add(acts, el('button', null, '↑'));
      up.type = 'button';
      up.title = 'Move earlier';
      up.disabled = i === 0;
      up.addEventListener('click', () => moveSection(i, -1));
      const down = add(acts, el('button', null, '↓'));
      down.type = 'button';
      down.title = 'Move later';
      down.disabled = i === E.song.sections.length - 1;
      down.addEventListener('click', () => moveSection(i, 1));
      const edit = add(acts, el('button', null, 'edit'));
      edit.type = 'button';
      edit.addEventListener('click', () => { S.cur = i; go('edit'); });
      if (E.song.sections.length > 1) {
        const rm = add(acts, el('button', null, 'remove'));
        rm.type = 'button';
        rm.addEventListener('click', () => {
          E.song.sections.splice(i, 1);
          S.cur = Math.min(S.cur, E.song.sections.length - 1);
          render();
        });
      }
      tl.appendChild(row);
    });

    const addBtn = add(tl, el('button', 'addrow', '+ add another moment'));
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => {
      S.cur = E.song.sections.length - 1;
      go('next');
    });

    const acts = add(s, el('div', 'actions'));
    const play = add(acts, el('button', 'primary', E.isPlaying() ? '❚❚ Pause' : '▶ Play song'));
    play.type = 'button';
    play.addEventListener('click', () => {
      if (E.isPlaying()) { E.pause(); play.textContent = '▶ Play song'; }
      else { E.play(); play.textContent = '❚❚ Pause'; }
      syncPlayButton();
    });
    const finish = add(acts, el('button', 'textbtn', 'Build the final song →'));
    finish.type = 'button';
    finish.addEventListener('click', () => go('compose'));
    const arc = add(acts, el('button', 'textbtn', 'Draw the energy arc'));
    arc.type = 'button';
    arc.addEventListener('click', () => openArcDialog());
  }

  function moveSection(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= E.song.sections.length) return;
    const arr = E.song.sections;
    const [sec] = arr.splice(i, 1);
    arr.splice(j, 0, sec);
    S.cur = j;
    render();
  }

  /* --- section editor --- */
  function renderEdit() {
    const s = screen();
    const sec = current();
    heading(s, 'edit', `Edit “${sec.name}”.`, 'Everything about this moment in one place. It keeps playing.');

    add(s, el('p', 'small caption', 'Feel (resets colour and players)'));
    const feelRow = add(s, el('div', 'chips'));
    moods.forEach((m) => {
      const c = el('button', 'chip' + (S.selectedMood === m.id ? ' on' : ''), m.label);
      c.type = 'button';
      c.addEventListener('click', () => {
        applyMood(sec, m);
        render();
      });
      add(feelRow, c);
    });

    add(s, el('p', 'small caption', 'Colour'));
    const progRow = add(s, el('div', 'chips'));
    Object.entries(E.PROGRESSIONS).forEach(([id, p]) => {
      const c = el('button', 'chip' + (sec.progression === id ? ' on' : ''), p.label);
      c.type = 'button';
      c.addEventListener('click', () => {
        sec.progression = id;
        progRow.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
      });
      add(progRow, c);
    });

    add(s, el('p', 'small caption', 'Players'));
    const instRow = add(s, el('div', 'chips'));
    E.INSTRUMENTS.forEach((inst) => {
      const c = el('button', 'chip' + (sec.instruments[inst.id] ? ' on' : ''), inst.label);
      c.type = 'button';
      c.addEventListener('click', () => {
        sec.instruments[inst.id] = !sec.instruments[inst.id];
        c.classList.toggle('on', sec.instruments[inst.id]);
      });
      add(instRow, c);
    });

    const grid = add(s, el('div', 'pads'));
    ['brightness', 'density', 'tension', 'space'].forEach((kind) => {
      add(grid, makePad(kind, sec).wrap);
    });

    const ctrls = add(s, el('div', 'shapecontrols'));
    const c1 = add(ctrls, el('div', 'ctrlbox'));
    chipRow(c1, PACE_WORDS, sec.pace, v => { sec.pace = v; }, 'Pace');
    const c2 = add(ctrls, el('div', 'ctrlbox'));
    chipRow(c2, SWING_WORDS, sec.swing, v => { sec.swing = v; }, 'Groove');
    const c3 = add(ctrls, el('div', 'ctrlbox'));
    chipRow(c3, HUMAN_WORDS, sec.human, v => { sec.human = v; }, 'Feel');
    const c4 = add(ctrls, el('div', 'ctrlbox'));
    add(c4, el('p', 'small caption', 'Length'));
    add(c4, barsStepper(sec));

    const acts = add(s, el('div', 'actions'));
    const done = add(acts, el('button', 'primary', 'Back to the song →'));
    done.type = 'button';
    done.addEventListener('click', () => go('review'));
  }

  /* --- energy arc gesture (optional) --- */
  function openArcDialog() {
    const dlg = document.createElement('dialog');
    dlg.className = 'arcdialog';
    const inner = el('div', 'dialog-inner');
    const h = add(inner, el('h2', null, 'Draw the energy arc'));
    add(inner, el('p', 'small', 'One line across the whole song. Lift it for louder moments, drop it for quiet ones.'));
    const wrap = add(inner, el('div', 'arcwrap'));
    const canvas = add(wrap, el('canvas', 'arccanvas'));
    const acts = add(inner, el('div', 'actions'));
    const apply = add(acts, el('button', 'primary', 'Apply'));
    apply.type = 'button';
    const cancel = add(acts, el('button', 'textbtn', 'Cancel'));
    cancel.type = 'button';

    const dctx = canvas.getContext('2d');
    const n0 = E.song.sections.length;
    let points = [{ x: 0, y: 1 - E.song.sections[0].energy }]
      .concat(E.song.sections.map((s, i) => ({ x: (i + 0.5) / n0, y: 1 - s.energy })))
      .concat([{ x: 1, y: 1 - E.song.sections[n0 - 1].energy }]);
    let drag = false;
    function draw() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = r.width, h = r.height, pad = 18;
      dctx.clearRect(0, 0, w, h);
      dctx.strokeStyle = 'rgba(255,255,255,0.08)';
      for (let i = 0; i <= 4; i++) {
        const y = pad + (h - pad * 2) * i / 4;
        dctx.beginPath(); dctx.moveTo(pad, y); dctx.lineTo(w - pad, y); dctx.stroke();
      }
      E.song.sections.forEach((s, i) => {
        const x = pad + (w - pad * 2) * (i + 0.5) / E.song.sections.length;
        dctx.strokeStyle = 'rgba(255,255,255,0.05)';
        dctx.beginPath(); dctx.moveTo(x, pad); dctx.lineTo(x, h - pad); dctx.stroke();
        dctx.fillStyle = `hsl(${hueFor(i)} 72% 68% / .8)`;
        dctx.fillText(`${i + 1}`, x - 3, h - 4);
      });
      dctx.strokeStyle = 'rgba(124,243,209,0.9)';
      dctx.lineWidth = 2.5;
      dctx.beginPath();
      points.forEach((p, i) => {
        const x = pad + (w - pad * 2) * p.x;
        const y = pad + (h - pad * 2) * p.y;
        if (i === 0) dctx.moveTo(x, y); else dctx.lineTo(x, y);
      });
      dctx.stroke();
      points.forEach((p) => {
        const x = pad + (w - pad * 2) * p.x;
        const y = pad + (h - pad * 2) * p.y;
        dctx.beginPath(); dctx.arc(x, y, 5, 0, Math.PI * 2);
        dctx.fillStyle = '#eceaf5'; dctx.fill();
      });
    }
    function set(e) {
      const r = canvas.getBoundingClientRect();
      const x = clamp01((e.clientX - r.left - 18) / Math.max(1, r.width - 36));
      points = [{ x: 0, y: points[0].y }];
      const n = E.song.sections.length;
      for (let i = 0; i < n; i++) points.push({ x: (i + 0.5) / n, y: clamp01((e.clientY - r.top - 18) / Math.max(1, r.height - 36)) });
      points.push({ x: 1, y: points[points.length - 1].y });
      draw();
    }
    canvas.addEventListener('pointerdown', e => { drag = true; canvas.setPointerCapture(e.pointerId); set(e); });
    canvas.addEventListener('pointermove', e => { if (drag) set(e); });
    canvas.addEventListener('pointerup', () => { drag = false; });
    canvas.addEventListener('pointercancel', () => { drag = false; });

    apply.addEventListener('click', () => {
      E.song.sections.forEach((s, i) => { s.energy = clamp01(1 - points[i + 1].y); });
      S.history.push(snapshot());
      dlg.close();
      render();
    });
    cancel.addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => dlg.remove());

    dlg.appendChild(inner);
    document.body.appendChild(dlg);
    dlg.showModal();
    requestAnimationFrame(draw);
  }

  /* ---------------- final arrangement + render ---------------- */
  function finalArrangement() {
    const secs = E.song.sections;
    const items = [];
    const intro = clone(secs[0]);
    intro.name = 'Intro';
    intro.bars = 2;
    intro.instruments = Object.assign({}, intro.instruments, { drums: false, perc: false, pluck: false });
    intro.energy = clamp01(intro.energy - 0.18);
    intro.density = clamp01(intro.density - 0.1);
    intro.space = clamp01(intro.space + 0.12);
    intro.flow = 'blend';
    items.push(intro);

    secs.forEach((sec) => {
      const c = clone(sec);
      c.bars = Math.max(4, c.bars);
      items.push(c);
    });

    const total = items.reduce((a, x) => a + x.bars, 0);
    if (total < 12 && secs.length > 1) {
      const peak = clone(secs[1]);
      peak.name = 'Peak';
      peak.bars = 4;
      peak.energy = clamp01(peak.energy + 0.08);
      peak.density = clamp01(peak.density + 0.08);
      items.push(peak);
    }

    const outro = clone(secs[secs.length - 1]);
    outro.name = 'Outro';
    outro.bars = 3;
    outro.instruments = Object.assign({}, outro.instruments, { drums: false, perc: false, pluck: false });
    outro.energy = clamp01(outro.energy - 0.25);
    outro.density = clamp01(outro.density - 0.2);
    outro.space = clamp01(outro.space + 0.15);
    outro.swing = 0.1;
    outro.flow = 'blend';
    items.push(outro);
    return items;
  }

  function spec() {
    return {
      key: 'A minor',
      sections: E.song.sections.map(sec => ({
        name: sec.name,
        bars: sec.bars,
        pace: round2(sec.pace),
        energy: round2(sec.energy),
        brightness: round2(sec.brightness),
        tension: round2(sec.tension),
        density: round2(sec.density),
        space: round2(sec.space),
        swing: round2(sec.swing || 0),
        human: round2(sec.human || 0),
        progression: sec.progression,
        riff: sec.riff,
        flow: sec.flow,
        instruments: Object.keys(sec.instruments).filter(k => sec.instruments[k])
      }))
    };
  }

  function commission() {
    const arrangement = finalArrangement().map(sec => ({
      name: sec.name,
      bars: sec.bars,
      bpm: Math.round(E.tempoFor(sec)),
      energy: round2(sec.energy),
      brightness: round2(sec.brightness),
      tension: round2(sec.tension),
      density: round2(sec.density),
      space: round2(sec.space),
      swing: round2(sec.swing || 0),
      human: round2(sec.human || 0),
      progression: sec.progression,
      riff: sec.riff,
      instruments: Object.keys(sec.instruments).filter(k => sec.instruments[k])
    }));
    return {
      brief: S.notes,
      spec: spec(),
      arrangement,
      instructions: [
        'You are composing the final version of a song sketched in Song Canvas.',
        'Use the section order and feel below, but write it as a finished piece rather than a loop:',
        'add an intro and outro, transitions and fills between moments, and variation between repeats.',
        'Keep it in A minor, honour each section’s pace and mood, and return a render (audio) plus the final spec.',
        'User notes: ' + (S.notes || '(none)')
      ].join('\n')
    };
  }

  async function renderFinal() {
    if (S.busy) return;
    S.busy = true;
    S.status = 'Rendering the full arrangement…';
    renderCompose();
    try {
      const items = finalArrangement();
      const res = await E.renderSong(items);
      const blob = E.wavBlob(res.buffer);
      if (S.renderUrl) URL.revokeObjectURL(S.renderUrl);
      S.renderUrl = URL.createObjectURL(blob);
      S.renderDur = res.duration;
      S.status = 'Rendered. This is the local arrangement — the opencode version can go further.';
    } catch (err) {
      S.status = 'Render failed: ' + err.message;
    }
    S.busy = false;
    syncPlayButton();
    if (S.step === 'compose') renderCompose();
  }

  function renderCompose() {
    const s = screen();
    heading(s, 'final', 'Build the final song.', 'The loop you built is the sketch. This is where it becomes a finished piece.');

    const sum = add(s, el('div', 'summary'));
    E.song.sections.forEach((sec, i) => {
      add(sum, el('span', null, `${i + 1}. ${sec.name} · ${sec.bars} bars · ${paceWord(sec.pace)}`));
    });

    add(s, el('p', 'small caption', 'Anything else for the composer?'));
    const notes = add(s, el('textarea', 'notes'));
    notes.rows = 4;
    notes.placeholder = 'e.g. make the last section feel like sunrise, add a guitar line in the second half, keep the drums out until the lift';
    notes.value = S.notes;
    notes.addEventListener('input', () => { S.notes = notes.value; });

    const acts = add(s, el('div', 'actions'));
    const gen = add(acts, el('button', 'primary', S.aiBusy ? 'Generating…' : 'Generate the final song'));
    gen.type = 'button';
    gen.disabled = S.aiBusy;
    gen.addEventListener('click', generateWithAI);

    const render = add(acts, el('button', 'textbtn', S.busy ? 'Rendering draft…' : 'Render a draft here'));
    render.type = 'button';
    render.disabled = S.busy;
    render.addEventListener('click', renderFinal);

    const copy = add(acts, el('button', 'textbtn', 'Copy the commission'));
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const text = JSON.stringify(commission(), null, 2);
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { copied = document.execCommand('copy'); } catch (e2) {}
        ta.remove();
      }
      S.status = copied ? 'Commission copied — paste it into opencode.' : 'Copy blocked by the browser. Select the JSON below.';
      renderCompose();
    });

    if (S.status) add(s, el('p', 'status', S.status));

    if (S.ai || S.aiBusy) {
      const box = add(s, el('div', 'renderbox ai'));
      add(box, el('p', 'small caption', 'opencode · final render'));
      const line = add(box, el('p', 'status'));
      line.id = 'aiStatus';
      line.textContent = S.aiBusy
        ? `opencode · ${(S.ai && S.ai.phase) || 'sending the commission'}`
        : S.ai && S.ai.status === 'error' ? `failed · ${S.ai.error || S.ai.phase}` : aiSummary();
      if (S.ai && S.ai.status === 'done' && S.ai.audioUrl) {
        const audio = add(box, el('audio'));
        audio.controls = true;
        audio.src = S.ai.audioUrl;
        const links = add(box, el('div', 'actions'));
        const dl = add(links, el('a', 'download'));
        dl.href = S.ai.audioUrl;
        dl.download = 'song-canvas-ai.mp3';
        dl.textContent = 'Download MP3';
        const disc = add(links, el('a', 'download'));
        disc.href = S.ai.discordUrl;
        disc.target = '_blank';
        disc.rel = 'noopener';
        disc.textContent = 'Open in #music-testing';
        if (S.ai.source && S.ai.source !== 'ai') {
          add(box, el('p', 'small', 'The AI step failed, so this is the local arrangement. Ask again to retry the composer.'));
        }
      }
    }

    if (!API) {
      add(s, el('p', 'small', 'This copy has no composer endpoint configured, so only the draft render works.'));
    }

    if (S.renderUrl) {
      const box = add(s, el('div', 'renderbox'));
      add(box, el('p', 'small caption', `Your local arrangement · ${S.renderDur.toFixed(0)} seconds`));
      const audio = add(box, el('audio'));
      audio.controls = true;
      audio.src = S.renderUrl;
      const dl = add(box, el('a', 'download'));
      dl.href = S.renderUrl;
      dl.download = 'song-canvas-final.wav';
      dl.textContent = 'Download WAV';
    }

    add(s, el('p', 'small caption', 'The commission'));
    const pre = add(s, el('pre', 'spec'));
    pre.textContent = JSON.stringify(commission(), null, 2);

    const acts2 = add(s, el('div', 'actions'));
    const back = add(acts2, el('button', 'textbtn', '← Back to the session'));
    back.type = 'button';
    back.addEventListener('click', () => go('review'));
    const over = add(acts2, el('button', 'textbtn', 'Start over'));
    over.type = 'button';
    over.addEventListener('click', () => {
      E.pause();
      E.song.sections = [];
      S.history = [];
      S.cur = 0;
      S.step = 'mood';
      S.selectedMood = null;
      S.renderUrl = null;
      S.notes = '';
      S.status = '';
      S.ai = null;
      S.aiBusy = false;
      syncPlayButton();
      render();
    });
  }

  function aiSummary() {
    const a = S.ai;
    if (!a) return '';
    if (a.status === 'done') {
      const mins = Math.floor((a.duration || 0) / 60);
      const secs = Math.round((a.duration || 0) % 60);
      return `${a.source === 'ai' ? 'arranged by opencode' : 'local fallback'} · ${a.sections || '?'} sections · ${mins}:${String(secs).padStart(2, '0')} · ${a.model || 'default'}`;
    }
    return a.phase || a.status || '';
  }

  async function generateWithAI() {
    if (!API || S.aiBusy) return;
    S.aiBusy = true;
    S.ai = { status: 'queued', phase: 'sending the commission' };
    renderCompose();
    try {
      const res = await fetch(API + '/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(commission())
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      if (!data.jobId) throw new Error('No job id returned');
      pollJob(data.jobId);
    } catch (err) {
      S.aiBusy = false;
      S.ai = { status: 'error', phase: 'failed', error: err.message };
      renderCompose();
    }
  }

  async function pollJob(id) {
    let failures = 0;
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const res = await fetch(API + '/job/' + id);
        const j = await res.json();
        failures = 0;
        if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
        S.ai = j;
        if (j.status === 'done' || j.status === 'error') {
          S.aiBusy = false;
          renderCompose();
          return;
        }
        const line = document.getElementById('aiStatus');
        if (line) line.textContent = `opencode · ${j.phase || j.status}`;
      } catch (err) {
        if (++failures >= 5) {
          S.aiBusy = false;
          S.ai = { status: 'error', phase: 'failed', error: 'lost contact with the composer: ' + err.message };
          renderCompose();
          return;
        }
      }
    }
  }

  /* ---------------- chrome ---------------- */
  backBtn.addEventListener('click', back);
  playBtn.addEventListener('click', () => {
    if (!E.song.sections.length) return;
    if (E.isPlaying()) E.pause();
    else ensurePlaying();
    syncPlayButton();
    if (S.step === 'review' || S.step === 'compose') render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
    if (e.key === 'Escape') back();
  });

  E.song.sections = [];
  render();

  window.SongInterview = {
    state: S,
    moods,
    spec,
    commission,
    finalArrangement,
    renderFinal,
    go,
    back,
    render,
    engine: E
  };
  window.__SC2_READY__ = true;
})();
