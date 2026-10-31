/* ============================================================
   Song Canvas — Prototype 2 (guided session)
   One question at a time. Gesture pads where words fall short.
   ============================================================ */
(function () {
  'use strict';

  const E = window.SongEngine;
  const stage = document.getElementById('stage');
  const progressFill = document.getElementById('progressFill');
  const stepName = document.getElementById('stepName');
  const backBtn = document.getElementById('back');
  const playBtn = document.getElementById('play');
  const HUES = [168, 205, 272, 324, 32, 112];
  const hueFor = i => HUES[i % HUES.length];

  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const round2 = v => Math.round(v * 100) / 100;

  const S = {
    step: 'mood',
    cur: 0,
    history: [],
    pendingRole: null
  };

  const STEP_LABEL = {
    mood: 'feeling', pace: 'pace', harmony: 'colour', instruments: 'players',
    shape: 'shape', next: 'next', place: 'place', review: 'review', done: 'done'
  };
  const PROGRESS = {
    mood: 0.07, pace: 0.22, harmony: 0.37, instruments: 0.5,
    shape: 0.63, next: 0.77, place: 0.84, review: 0.94, done: 1
  };

  /* ---------------- moods ---------------- */
  const MOODS = [
    {
      id: 'rain', label: 'Rainy night', desc: 'slow, blue, close',
      h: 205, h2: 240,
      base: { energy: 0.3, brightness: 0.28, tension: 0.44, density: 0.3, space: 0.56, pace: 0.34 },
      progression: 'dark', riff: 'drift', instruments: { pad: true, pluck: true, bass: true, drums: false }
    },
    {
      id: 'sun', label: 'Sunlit', desc: 'warm, open, easy',
      h: 42, h2: 18,
      base: { energy: 0.5, brightness: 0.72, tension: 0.2, density: 0.5, space: 0.36, pace: 0.5 },
      progression: 'rising', riff: 'spark', instruments: { pad: true, pluck: true, bass: true, drums: true }
    },
    {
      id: 'neon', label: 'Neon city', desc: 'tense, moving, bright edges',
      h: 292, h2: 320,
      base: { energy: 0.72, brightness: 0.6, tension: 0.56, density: 0.7, space: 0.24, pace: 0.7 },
      progression: 'rising', riff: 'drive', instruments: { pad: true, pluck: true, bass: true, drums: true }
    },
    {
      id: 'space', label: 'Deep space', desc: 'weightless, wide',
      h: 250, h2: 280,
      base: { energy: 0.2, brightness: 0.4, tension: 0.3, density: 0.22, space: 0.85, pace: 0.2 },
      progression: 'floating', riff: 'sparse', instruments: { pad: true, pluck: false, bass: true, drums: false }
    },
    {
      id: 'campfire', label: 'Campfire', desc: 'simple, intimate, warm',
      h: 24, h2: 8,
      base: { energy: 0.42, brightness: 0.55, tension: 0.15, density: 0.38, space: 0.24, pace: 0.44 },
      progression: 'open', riff: 'lullaby', instruments: { pad: true, pluck: true, bass: true, drums: false }
    },
    {
      id: 'storm', label: 'Storm', desc: 'heavy, fast, sharp',
      h: 190, h2: 210,
      base: { energy: 0.88, brightness: 0.46, tension: 0.62, density: 0.84, space: 0.3, pace: 0.84 },
      progression: 'dark', riff: 'drive', instruments: { pad: true, pluck: true, bass: true, drums: true }
    }
  ];

  const PROG_DESC = {
    bittersweet: 'warm, a little unresolved',
    dark: 'heavy, cinematic',
    rising: 'hopeful, lifting',
    floating: 'weightless, open',
    open: 'wide and simple'
  };

  const PACE_WORDS = [
    { v: 0.22, label: 'Slow' },
    { v: 0.42, label: 'Steady' },
    { v: 0.6, label: 'Moving' },
    { v: 0.8, label: 'Driving' }
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
  function paceWord(v) {
    return v < 0.3 ? 'slower' : v < 0.48 ? 'steady' : v < 0.68 ? 'moving' : 'driving';
  }
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

  /* ---------------- navigation ---------------- */
  function snapshot() {
    return JSON.stringify({ step: S.step, cur: S.cur, sections: E.song.sections, pendingRole: S.pendingRole });
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
    E.song.sections = o.sections;
    render();
  }

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
    else renderDone();
  }

  function renderMood() {
    const s = screen();
    heading(s, '1 · feeling', 'What does it feel like?', 'Pick a starting point. You can change everything later.');

    const grid = add(s, el('div', 'moodgrid'));
    MOODS.forEach((m) => {
      const b = el('button', 'mood');
      b.type = 'button';
      b.style.setProperty('--h', m.h);
      b.style.setProperty('--h2', m.h2);
      add(b, el('span', 'orb'));
      add(b, el('b', null, m.label));
      add(b, el('span', null, m.desc));
      b.addEventListener('click', () => startFromMood(m));
      add(grid, b);
    });

    const acts = add(s, el('div', 'actions'));
    const lucky = add(acts, el('button', 'textbtn', 'Choose for me'));
    lucky.type = 'button';
    lucky.addEventListener('click', () => startFromMood(MOODS[Math.floor(Math.random() * MOODS.length)]));
  }

  function startFromMood(m) {
    const sec = E.section({
      name: 'Open',
      bars: 2,
      pace: m.base.pace,
      energy: m.base.energy,
      brightness: m.base.brightness,
      tension: m.base.tension,
      density: m.base.density,
      space: m.base.space,
      progression: m.progression,
      riff: m.riff,
      flow: 'blend',
      instruments: Object.assign({ pad: true, pluck: true, bass: true, drums: true }, m.instruments)
    });
    E.song.sections = [sec];
    S.cur = 0;
    S.history = [];
    ensurePlaying();
    go('pace');
  }

  function renderPace() {
    const s = screen();
    const sec = current();
    heading(s, '2 · pace', 'How fast does it move?', 'Drag the pulse, or pick a word. You can change pace for any moment later.');

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

    function markNearestChip(row, v) {
      let best = null, bestD = 1e9;
      row.querySelectorAll('.chip').forEach((c) => {
        const d = Math.abs(parseFloat(c.dataset.v) - v);
        if (d < bestD) { bestD = d; best = c; }
      });
      row.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === best));
    }

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

  function renderHarmony() {
    const s = screen();
    const sec = current();
    heading(s, '3 · colour', 'What colour should it have?', 'These are flavours, not chords you need to know. Tap one and it changes as it plays.');

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

    const acts = add(s, el('div', 'actions'));
    const lucky = add(acts, el('button', 'textbtn', 'Surprise me'));
    lucky.type = 'button';
    lucky.addEventListener('click', () => {
      const ids = Object.keys(E.PROGRESSIONS);
      sec.progression = ids[Math.floor(Math.random() * ids.length)];
      ensurePlaying();
      go('instruments');
    });
  }

  function renderInstruments() {
    const s = screen();
    const sec = current();
    heading(s, '4 · players', 'Who plays in this moment?', 'Tap to invite or remove. The loop is already listening.');

    const row = add(s, el('div', 'chips large'));
    const DESC = { pad: 'a bed of sound', pluck: 'a repeating figure', bass: 'the low end', drums: 'the pulse' };
    E.INSTRUMENTS.forEach((inst) => {
      const c = el('button', 'chip' + (sec.instruments[inst.id] ? ' on' : ''), inst.label);
      c.type = 'button';
      c.title = DESC[inst.id] || '';
      c.addEventListener('click', () => {
        sec.instruments[inst.id] = !sec.instruments[inst.id];
        c.classList.toggle('on', sec.instruments[inst.id]);
        ensurePlaying();
      });
      add(row, c);
    });
    add(s, el('p', 'small', 'A moment with just a pad and a bass is a perfectly good moment.'));

    const acts = add(s, el('div', 'actions'));
    const next = add(acts, el('button', 'primary', 'Shape this moment →'));
    next.type = 'button';
    next.addEventListener('click', () => go('shape'));
  }

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

    add(s, el('p', 'small caption', 'Pace'));
    const paceRow = add(s, el('div', 'chips'));
    PACE_WORDS.forEach((p) => {
      const c = el('button', 'chip', p.label);
      c.type = 'button';
      c.dataset.v = String(p.v);
      c.addEventListener('click', () => {
        sec.pace = p.v;
        paceRow.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
      });
      add(paceRow, c);
    });
    let bestChip = null, bestD = 1e9;
    paceRow.querySelectorAll('.chip').forEach((c) => {
      const d = Math.abs(parseFloat(c.dataset.v) - sec.pace);
      if (d < bestD) { bestD = d; bestChip = c; }
    });
    if (bestChip) bestChip.classList.add('on');
    paceRow.style.marginTop = '6px';

    add(s, el('p', 'small caption', 'Length'));
    const barsRow = add(s, el('div', 'chips'));
    barsRow.style.marginTop = '6px';
    const minus = add(barsRow, el('button', 'chip', '−'));
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Fewer bars');
    const barsLabel = add(barsRow, el('span', 'small', `${sec.bars} bars`));
    barsLabel.style.alignSelf = 'center';
    const plus = add(barsRow, el('button', 'chip', '+'));
    plus.type = 'button';
    plus.setAttribute('aria-label', 'More bars');
    minus.addEventListener('click', () => { sec.bars = Math.max(1, sec.bars - 1); barsLabel.textContent = `${sec.bars} bars`; });
    plus.addEventListener('click', () => { sec.bars = Math.min(8, sec.bars + 1); barsLabel.textContent = `${sec.bars} bars`; });

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
        // snapshot BEFORE the section exists, so Back from the editor returns here
        S.history.push(snapshot());
        createSection(S.pendingRole, o.id);
        S.step = 'shape';
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
    const s = JSON.parse(JSON.stringify(base));
    s.name = uniqueName(role === 'Keep' ? 'Continue' : role);
    s.bars = 2;
    s.flow = role === 'Lift' ? 'lift' : role === 'Break' ? 'drift' : 'blend';

    if (role === 'Lift') {
      s.energy += 0.16; s.brightness += 0.12; s.density += 0.14; s.tension += 0.06;
      s.instruments.drums = true;
    } else if (role === 'Break') {
      s.energy -= 0.18; s.density -= 0.2; s.brightness -= 0.1; s.space += 0.15;
      s.instruments.drums = false;
    } else {
      s.energy += 0.04; s.density += 0.04;
    }

    for (const k of ['energy', 'brightness', 'tension', 'density', 'space']) s[k] = round2(clamp01(s[k]));

    let idx;
    if (place === 'before') idx = S.cur;
    else if (place === 'end') idx = E.song.sections.length;
    else idx = S.cur + 1;
    E.song.sections.splice(idx, 0, s);
    S.cur = idx;
  }

  function renderReview() {
    const s = screen();
    heading(s, '8 · review', 'Your song so far.', 'Play it, then fix anything that does not feel right.');

    const tl = add(s, el('div', 'timeline'));
    E.song.sections.forEach((sec, i) => {
      const row = el('div', 'tlrow');
      row.style.setProperty('--dot', `hsl(${hueFor(i)} 72% 68%)`);
      const dot = add(row, el('span', 'dot'));
      const grow = add(row, el('div', 'grow'));
      add(grow, el('div', 'nm', `${i + 1}. ${sec.name}`));
      add(grow, el('div', 'meta', `${sec.bars} bars · ${(E.RIFFS[sec.riff] || {}).label || ''} · ${paceWord(sec.pace)}`));
      const bars = add(row, el('div', 'bars'));
      for (let k = 0; k < 6; k++) {
        const seg = add(bars, el('i'));
        seg.style.setProperty('--o', String(Math.max(0.12, clamp01(sec.energy + (k - 3) * 0.08))));
      }
      const acts = add(row, el('div', 'acts'));
      const edit = add(acts, el('button', null, 'edit'));
      edit.type = 'button';
      edit.addEventListener('click', () => { S.cur = i; go('shape'); });
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
    const finish = add(acts, el('button', 'textbtn', 'Finish song →'));
    finish.type = 'button';
    finish.addEventListener('click', () => go('done'));
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
        progression: sec.progression,
        riff: sec.riff,
        flow: sec.flow,
        instruments: Object.keys(sec.instruments).filter(k => sec.instruments[k])
      }))
    };
  }

  function renderDone() {
    const s = screen();
    heading(s, '9 · done', "That's your song.", 'A guided sketch you can keep, play, or take back into the other lenses.');

    const big = add(s, el('div', 'bigplay'));
    const b = add(big, el('button', null, E.isPlaying() ? '❚❚' : '▶'));
    b.type = 'button';
    b.setAttribute('aria-label', 'Play song');
    const now = add(big, el('div', 'now', E.isPlaying() ? 'playing the loop' : 'paused'));
    b.addEventListener('click', () => {
      if (E.isPlaying()) { E.pause(); b.textContent = '▶'; now.textContent = 'paused'; }
      else { E.play(); b.textContent = '❚❚'; now.textContent = 'playing the loop'; }
      syncPlayButton();
    });

    const sum = add(s, el('div', 'summary'));
    E.song.sections.forEach((sec, i) => {
      add(sum, el('span', null, `${i + 1}. ${sec.name} · ${sec.bars} bars`));
    });

    const acts = add(s, el('div', 'actions'));
    const dl = add(acts, el('button', 'primary', 'Download the brief'));
    dl.type = 'button';
    dl.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(spec(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'song-canvas-brief.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    const again = add(acts, el('button', 'textbtn', 'Start over'));
    again.type = 'button';
    again.addEventListener('click', () => {
      E.pause();
      E.song.sections = [];
      S.history = [];
      S.cur = 0;
      S.step = 'mood';
      syncPlayButton();
      render();
    });
    const other = add(acts, el('a', 'textbtn', 'Try the draw/map lenses →'));
    other.href = '../proto-1/';
    other.style.textDecoration = 'none';
    other.style.alignSelf = 'center';
  }

  /* ---------------- chrome ---------------- */
  backBtn.addEventListener('click', back);
  playBtn.addEventListener('click', () => {
    if (!E.song.sections.length) return;
    if (E.isPlaying()) E.pause();
    else { ensurePlaying(); }
    syncPlayButton();
    if (S.step === 'review' || S.step === 'done') render();
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
    spec,
    go,
    back,
    render,
    engine: E,
    moods: MOODS
  };
  window.__SC2_READY__ = true;
})();
