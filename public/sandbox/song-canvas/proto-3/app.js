/* ============================================================
   Song Canvas — Prototype 3 (checkpoint workstation)
   Each checkpoint is a short clip assembled from parts:
   instruments, chords, figure, filters, tempo. Audition parts,
   preview clips, then send the checkpoints to opencode.
   ============================================================ */
(function () {
  'use strict';

  const E = window.SongEngine;
  const API = (window.SONGCANVAS_API || '').replace(/\/+$/, '');
  const HUES = [168, 205, 272, 324, 32, 112, 190, 250];
  const hueFor = i => HUES[i % HUES.length];
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const clone = o => JSON.parse(JSON.stringify(o));
  const $ = s => document.querySelector(s);

  const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
  const CHORD_PRESETS = {
    'Bittersweet': [[0, 1], [8, 0], [3, 0], [10, 0]],
    'Dark': [[0, 1], [8, 0], [5, 1], [7, 0]],
    'Rising': [[0, 1], [3, 0], [8, 0], [10, 0]],
    'Floating': [[0, 1], [7, 1], [8, 0], [10, 0]],
    'Open': [[0, 1], [10, 0], [8, 0], [10, 0]],
    'Longing': [[0, 1], [5, 1], [8, 0], [7, 0]],
    'Hopeful': [[0, 1], [3, 0], [8, 0], [5, 1]],
    'Suspended': [[0, 1], [7, 0], [8, 0], [5, 1]]
  };
  const CATS = [
    { label: 'Bed', ids: ['pad', 'keys', 'strings'] },
    { label: 'Figure', ids: ['pluck', 'bells'] },
    { label: 'Low end', ids: ['bass'] },
    { label: 'Rhythm', ids: ['drums', 'perc'] }
  ];
  const FILTERS = [
    { key: 'brightness', label: 'Tone', lo: 'dark', hi: 'bright' },
    { key: 'space', label: 'Space', lo: 'dry', hi: 'vast' },
    { key: 'delay', label: 'Echo', lo: 'none', hi: 'deep' },
    { key: 'tension', label: 'Edge', lo: 'soft', hi: 'sharp' }
  ];
  const INST_BY_ID = Object.fromEntries(E.INSTRUMENTS.map(i => [i.id, i]));

  const S = {
    cps: defaultCheckpoints(),
    active: 0,
    playing: false,
    clipUrl: null,
    rendering: false,
    aiBusy: false,
    ai: null,
    notes: '',
    draft: false
  };

  function defaultInstruments(on) {
    const o = {};
    for (const i of E.INSTRUMENTS) o[i.id] = false;
    for (const id of on) o[id] = true;
    return o;
  }

  function cp(over) {
    return Object.assign({
      name: 'Checkpoint',
      bars: 4,
      pace: 0.45,
      energy: 0.4,
      brightness: 0.5,
      tension: 0.3,
      density: 0.45,
      space: 0.4,
      delay: 0.15,
      swing: 0.1,
      human: 0.25,
      riff: 'pulse',
      progression: 'bittersweet',
      chords: [[0, 1], [8, 0], [3, 0], [10, 0]].map(([root, minor]) => ({ root, minor: !!minor })),
      instruments: defaultInstruments(['pad', 'pluck', 'bass'])
    }, over);
  }

  function defaultCheckpoints() {
    return [
      cp({
        name: 'Drift in', pace: 0.32, energy: 0.28, brightness: 0.32, tension: 0.2, density: 0.3, space: 0.62, delay: 0.3, swing: 0.08,
        riff: 'drift', chords: [[0, 1], [8, 0], [3, 0], [10, 0]].map(([root, minor]) => ({ root, minor: !!minor })),
        instruments: defaultInstruments(['pad', 'pluck', 'bass'])
      }),
      cp({
        name: 'Lift', pace: 0.55, energy: 0.6, brightness: 0.55, tension: 0.3, density: 0.62, space: 0.34, delay: 0.15, swing: 0.18,
        riff: 'weave', chords: [[0, 1], [3, 0], [8, 0], [10, 0]].map(([root, minor]) => ({ root, minor: !!minor })),
        instruments: defaultInstruments(['keys', 'pluck', 'bass', 'drums', 'perc'])
      }),
      cp({
        name: 'Bloom', pace: 0.68, energy: 0.8, brightness: 0.72, tension: 0.38, density: 0.78, space: 0.26, delay: 0.18, swing: 0.12,
        riff: 'run', chords: [[8, 0], [10, 0], [0, 1], [7, 1]].map(([root, minor]) => ({ root, minor: !!minor })),
        instruments: defaultInstruments(['keys', 'strings', 'pluck', 'bells', 'bass', 'drums', 'perc'])
      }),
      cp({
        name: 'Settle', pace: 0.32, energy: 0.32, brightness: 0.46, tension: 0.42, density: 0.32, space: 0.72, delay: 0.35, swing: 0.3,
        riff: 'call', chords: [[0, 1], [7, 1], [8, 0], [10, 0]].map(([root, minor]) => ({ root, minor: !!minor })),
        instruments: defaultInstruments(['pad', 'bells', 'bass'])
      })
    ];
  }

  /* ---------------- utils ---------------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function add(parent, node) { parent.appendChild(node); return node; }
  function chordLabel(c) { return NOTE_NAMES[c.root] + (c.minor ? 'm' : ''); }
  function chordsLabel(cp) { return (cp.chords || []).map(chordLabel).join(' '); }
  function chordChoices() {
    const out = [];
    for (let r = 0; r < 12; r++) {
      for (let m = 0; m < 2; m++) {
        out.push({ value: `${r}:${m}`, label: NOTE_NAMES[r] + (m ? 'm' : ''), root: r, minor: !!m });
      }
    }
    return out;
  }
  const CHORD_CHOICES = chordChoices();

  function toSection(cp, bars) {
    return E.section({
      name: cp.name,
      bars: bars || cp.bars,
      pace: cp.pace,
      energy: cp.energy,
      brightness: cp.brightness,
      tension: cp.tension,
      density: cp.density,
      space: cp.space,
      delay: cp.delay,
      swing: cp.swing,
      human: cp.human,
      riff: cp.riff,
      progression: cp.progression,
      chords: clone(cp.chords),
      flow: 'blend',
      instruments: clone(cp.instruments)
    });
  }
  function syncEngine() {
    E.song.sections = S.cps.map(c => toSection(c));
  }

  /* ---------------- transport ---------------- */
  function playAll() {
    if (E.isPlaying()) { E.pause(); S.playing = false; }
    else {
      E.pause();
      syncEngine();
      E.song.sections = S.cps.map(c => toSection(c));
      E.play();
      S.playing = true;
    }
    updateTransport();
  }
  function updateTransport() {
    const btn = $('#playAll');
    const on = E.isPlaying();
    btn.classList.toggle('playing', on);
    btn.textContent = on ? '❚❚' : '▶';
    $('#nowName').textContent = on ? (E.song.sections[(E.position() || {}).si || 0] || {}).name || '' : `${S.cps.length} checkpoints`;
    if (!on) $('#nowBar').textContent = 'build the vibe, clip by clip';
  }

  async function previewCheckpoint() {
    if (S.rendering) return;
    if (E.isPlaying()) { E.pause(); S.playing = false; updateTransport(); }
    S.rendering = true;
    $('#clipStatus').textContent = 'rendering the clip…';
    try {
      const res = await E.renderSong([toSection(S.cps[S.active], 4)]);
      const blob = E.wavBlob(res.buffer);
      if (S.clipUrl) URL.revokeObjectURL(S.clipUrl);
      S.clipUrl = URL.createObjectURL(blob);
      const audio = $('#clip');
      audio.hidden = false;
      audio.src = S.clipUrl;
      audio.play().catch(() => {});
      $('#clipStatus').textContent = `clip · ${res.duration.toFixed(1)}s · ${S.cps[S.active].name}`;
    } catch (e) {
      $('#clipStatus').textContent = 'clip failed: ' + e.message;
    }
    S.rendering = false;
  }

  /* ---------------- rail ---------------- */
  function renderRail() {
    const list = $('#cpList');
    list.innerHTML = '';
    S.cps.forEach((c, i) => {
      const b = el('button', 'cp' + (i === S.active ? ' on' : ''));
      b.type = 'button';
      b.dataset.i = String(i);
      b.style.setProperty('--dot', `hsl(${hueFor(i)} 72% 68%)`);
      const row = add(b, el('div', 'row1'));
      add(row, el('span', 'dot'));
      add(row, el('span', null, c.name));
      add(b, el('div', 'sub', `${chordsLabel(c)} · ${paceWord(c.pace)}`));
      const pips = add(b, el('div', 'pips'));
      for (const inst of E.INSTRUMENTS) {
        const p = add(pips, el('i'));
        if (c.instruments[inst.id]) p.classList.add('on');
      }
      add(b, el('div', 'barline'));
      b.addEventListener('click', () => {
        S.active = i;
        renderRail();
        renderEditor();
      });
      list.appendChild(b);
    });
  }
  function paceWord(v) { return v < 0.3 ? 'slow' : v < 0.48 ? 'steady' : v < 0.68 ? 'moving' : 'driving'; }
  function bpm(v) { return Math.round(62 + clamp01(v) * 56); }

  /* ---------------- editor ---------------- */
  function renderEditor() {
    const root = $('#editor');
    root.innerHTML = '';
    const c = S.cps[S.active];
    if (!c) return;
    const head = add(root, el('div', 'edhead'));
    const name = add(head, el('input'));
    name.value = c.name;
    name.setAttribute('aria-label', 'Checkpoint name');
    name.addEventListener('input', () => { c.name = name.value || 'Checkpoint'; renderRail(); });
    const tools = add(head, el('div', 'tools'));
    const dup = add(tools, el('button', 'ico', '⧉'));
    dup.type = 'button'; dup.title = 'Duplicate checkpoint';
    dup.addEventListener('click', () => {
      S.cps.splice(S.active + 1, 0, clone(S.cps[S.active]));
      S.cps[S.active + 1].name = 'Checkpoint ' + (S.cps.length);
      S.active++;
      renderAll();
    });
    const rm = add(tools, el('button', 'ico', '✕'));
    rm.type = 'button'; rm.title = 'Remove checkpoint';
    rm.disabled = S.cps.length <= 1;
    rm.addEventListener('click', () => {
      if (S.cps.length <= 1) return;
      S.cps.splice(S.active, 1);
      S.active = Math.min(S.active, S.cps.length - 1);
      renderAll();
    });

    // instruments
    const instBlock = add(root, el('div', 'block'));
    const instHead = add(instBlock, el('h2', null, 'Instruments'));
    add(instHead, el('span', 'cap', 'click hear to audition'));
    for (const cat of CATS) {
      const cw = add(instBlock, el('div', 'cat'));
      add(cw, el('div', 'catlabel', cat.label));
      const grid = add(cw, el('div', 'instgrid'));
      for (const id of cat.ids) {
        const inst = INST_BY_ID[id];
        const btn = el('div', 'inst' + (c.instruments[id] ? ' on' : ''));
        btn.dataset.id = id;
        btn.title = inst.hint || '';
        const sw = add(btn, el('span', 'sw', c.instruments[id] ? '✓' : ''));
        add(btn, el('span', 'nm', inst.label));
        const hear = add(btn, el('button', 'hear', '♪'));
        hear.type = 'button';
        hear.title = 'Hear this instrument';
        hear.addEventListener('click', (e) => {
          e.stopPropagation();
          E.audition(id);
        });
        btn.addEventListener('click', () => {
          c.instruments[id] = !c.instruments[id];
          btn.classList.toggle('on', c.instruments[id]);
          sw.textContent = c.instruments[id] ? '✓' : '';
          syncEngine();
          renderRail();
        });
        add(grid, btn);
      }
    }

    // chords
    const chordBlock = add(root, el('div', 'block'));
    const chordHead = add(chordBlock, el('h2', null, 'Chords'));
    add(chordHead, el('span', 'cap', 'one per bar · drag the vibe'));
    const row = add(chordBlock, el('div', 'chordrow'));
    const selects = [];
    c.chords.forEach((ch, i) => {
      const slot = add(row, el('div', 'chordslot'));
      add(slot, el('span', null, `Bar ${i + 1}`));
      const sel = add(slot, el('select'));
      for (const opt of CHORD_CHOICES) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        o.selected = opt.root === ch.root && opt.minor === !!ch.minor;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        const [r, m] = sel.value.split(':').map(Number);
        c.chords[i] = { root: r, minor: !!m };
        syncEngine();
        renderRail();
      });
      selects.push(sel);
    });
    const presets = add(chordBlock, el('div', 'chips presets'));
    Object.entries(CHORD_PRESETS).forEach(([label, chords]) => {
      const b = add(presets, el('button', 'chip', label));
      b.type = 'button';
      b.addEventListener('click', () => {
        c.chords = chords.map(([root, minor]) => ({ root, minor: !!minor }));
        selects.forEach((sel, i) => { sel.value = `${c.chords[i].root}:${c.chords[i].minor ? 1 : 0}`; });
        syncEngine();
        renderRail();
        previewCheckpoint();
      });
    });
    if (S.active > 0) {
      const same = add(presets, el('button', 'chip', 'Same as previous'));
      same.type = 'button';
      same.addEventListener('click', () => {
        c.chords = clone(S.cps[S.active - 1].chords);
        renderEditor();
        syncEngine();
        renderRail();
      });
    }

    // figures
    const figBlock = add(root, el('div', 'block'));
    add(figBlock, el('h2', null, 'Figure / melody'));
    const figGrid = add(figBlock, el('div', 'figgrid'));
    Object.entries(E.RIFFS).forEach(([id, riff]) => {
      const b = el('div', 'fig' + (c.riff === id ? ' on' : ''));
      const cv = add(b, el('canvas'));
      cv.width = 80; cv.height = 32;
      drawFigure(cv, riff);
      add(b, el('span', null, riff.label));
      const hear = add(b, el('button', 'hear', '♪'));
      hear.type = 'button';
      hear.title = 'Hear this figure in the checkpoint';
      hear.addEventListener('click', (e) => { e.stopPropagation(); c.riff = id; syncEngine(); previewCheckpoint(); });
      b.addEventListener('click', () => {
        c.riff = id;
        figGrid.querySelectorAll('.fig').forEach(f => f.classList.toggle('on', f === b));
        syncEngine();
        renderRail();
      });
      add(figGrid, b);
    });

    // filters
    const filtBlock = add(root, el('div', 'block'));
    add(filtBlock, el('h2', null, 'Feel & filters'));
    const filt = add(filtBlock, el('div', 'filters'));
    FILTERS.forEach((f) => {
      const box = add(filt, el('div', 'filter'));
      const lab = add(box, el('div', 'lab'));
      add(lab, el('span', null, f.label));
      const val = add(lab, el('b', null, f.lo + ' / ' + f.hi));
      const input = add(box, el('input'));
      input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.01';
      input.value = String(c[f.key] != null ? c[f.key] : 0.3);
      input.setAttribute('aria-label', f.label);
      input.addEventListener('input', () => {
        c[f.key] = parseFloat(input.value);
        syncEngine();
      });
      val.textContent = descriptor(f.key, c[f.key]);
    });

    // tempo + length
    const tempoBlock = add(root, el('div', 'block'));
    add(tempoBlock, el('h2', null, 'Tempo & length'));
    const inline = add(tempoBlock, el('div', 'inline'));
    const tempo = add(inline, el('input'));
    tempo.type = 'range'; tempo.min = '0'; tempo.max = '1'; tempo.step = '0.01';
    tempo.value = String(c.pace);
    tempo.style.maxWidth = '320px';
    tempo.setAttribute('aria-label', 'Tempo');
    const tempoVal = add(inline, el('div', 'tempoVal'));
    const setTempoLabel = () => { tempoVal.innerHTML = `${bpm(c.pace)}<span>bpm</span>`; };
    setTempoLabel();
    tempo.addEventListener('input', () => { c.pace = parseFloat(tempo.value); setTempoLabel(); syncEngine(); });
    const bars = add(tempoBlock, el('div', 'chips'));
    bars.style.marginTop = '8px';
    [2, 4, 8].forEach((n) => {
      const b = add(bars, el('button', 'chip' + (c.bars === n ? ' on' : ''), `${n} bars`));
      b.type = 'button';
      b.addEventListener('click', () => {
        c.bars = n;
        bars.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
        syncEngine();
      });
    });

    // composer
    const comp = add(root, el('div', 'block'));
    comp.id = 'composer';
    add(comp, el('h2', null, 'Send the checkpoints to the composer'));
    add(comp, el('p', 'note', 'opencode will join these clips into a finished piece, smooth the transitions, and post the render to #music-testing.'));
    const notes = add(comp, el('textarea'));
    notes.placeholder = 'e.g. make the last checkpoint feel like sunrise; keep the drums out until the lift';
    notes.value = S.notes;
    notes.addEventListener('input', () => { S.notes = notes.value; });
    const actions = add(comp, el('div', 'actions'));
    const gen = add(actions, el('button', 'primary', S.aiBusy ? 'Composing…' : 'Generate the final song'));
    gen.type = 'button';
    gen.disabled = S.aiBusy || !API;
    gen.addEventListener('click', generate);
    const copy = add(actions, el('button', 'chip', 'Copy brief'));
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const text = JSON.stringify(commission(), null, 2);
      try { await navigator.clipboard.writeText(text); $('#clipStatus').textContent = 'commission copied'; }
      catch (e) { $('#clipStatus').textContent = 'copy blocked'; }
    });
    if (S.ai || S.aiBusy) {
      const box = add(comp, el('div', 'renderbox'));
      const status = add(box, el('p', 'status'));
      status.id = 'aiStatus';
      status.textContent = S.aiBusy
        ? `opencode · ${(S.ai && S.ai.phase) || 'sending the commission'}`
        : S.ai && S.ai.status === 'error' ? `failed · ${S.ai.error || S.ai.phase}` : aiSummary();
      if (S.ai && S.ai.status === 'done' && S.ai.audioUrl) {
        const audio = add(box, el('audio'));
        audio.controls = true;
        audio.src = S.ai.audioUrl;
        const links = add(box, el('div', 'links'));
        const dl = add(links, el('a', null, 'Download MP3'));
        dl.href = S.ai.audioUrl; dl.download = 'song-canvas-ai.mp3';
        const disc = add(links, el('a', null, 'Open in #music-testing'));
        disc.href = S.ai.discordUrl; disc.target = '_blank'; disc.rel = 'noopener';
      }
    }

    // preview actions at the bottom
    const preview = add(root, el('div', 'block'));
    const pa = add(preview, el('div', 'inline'));
    const p1 = add(pa, el('button', 'primary', 'Preview this checkpoint'));
    p1.type = 'button';
    p1.addEventListener('click', previewCheckpoint);
    const p2 = add(pa, el('button', 'chip', E.isPlaying() ? '❚❚ Pause all' : '▶ Play all'));
    p2.type = 'button';
    p2.addEventListener('click', () => { playAll(); renderEditor(); });
    add(preview, el('p', 'note', 'Preview plays one 4-bar clip. Play all loops the checkpoints so you can hear the sequence — the AI smooths it afterwards.'));
  }

  function descriptor(key, v) {
    v = clamp01(v);
    if (key === 'brightness') return v < .33 ? 'dark' : v < .6 ? 'soft' : 'bright';
    if (key === 'space') return v < .33 ? 'dry' : v < .6 ? 'roomy' : 'wide';
    if (key === 'delay') return v < .2 ? 'none' : v < .5 ? 'slap' : 'deep';
    return v < .33 ? 'gentle' : v < .6 ? 'restless' : 'sharp';
  }

  function drawFigure(canvas, riff) {
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.lineWidth = 1.4;
    c.beginPath();
    riff.steps.forEach(([step, deg, len], i) => {
      const x = 3 + (step / 16) * (canvas.width - 6);
      const y = canvas.height - 5 - (deg / 6) * (canvas.height - 12);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      if (len > 1) c.lineTo(3 + ((step + len) / 16) * (canvas.width - 6), y);
    });
    c.stroke();
  }

  /* ---------------- AI composer ---------------- */
  function specSection(c) {
    return {
      name: c.name, bars: c.bars,
      pace: +c.pace.toFixed(2), energy: +c.energy.toFixed(2), brightness: +c.brightness.toFixed(2),
      tension: +c.tension.toFixed(2), density: +c.density.toFixed(2), space: +c.space.toFixed(2),
      delay: +c.delay.toFixed(2), swing: +c.swing.toFixed(2), human: +c.human.toFixed(2),
      progression: c.progression, riff: c.riff, flow: 'blend',
      chords: c.chords.map(x => ({ root: x.root, minor: !!x.minor })),
      instruments: Object.keys(c.instruments).filter(k => c.instruments[k])
    };
  }
  function commission() {
    const sections = S.cps.map(specSection);
    const arrangement = S.cps.map((c) => Object.assign(specSection(c), { bars: Math.max(4, c.bars) }));
    return {
      brief: S.notes,
      notes: S.notes,
      spec: { key: 'A minor', sections },
      arrangement,
      instructions: 'Join these checkpoints into a finished arrangement; smooth transitions; keep the chords and instruments.'
    };
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

  async function generate() {
    if (!API || S.aiBusy) return;
    S.aiBusy = true;
    S.ai = { status: 'queued', phase: 'sending the commission' };
    renderEditor();
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
      renderEditor();
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
          renderEditor();
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
          renderEditor();
          return;
        }
      }
    }
  }

  /* ---------------- playhead ---------------- */
  function tick() {
    if (E.isPlaying()) {
      const pos = E.position();
      if (pos) {
        const cards = document.querySelectorAll('#cpList .cp');
        cards.forEach((card, i) => {
          const line = card.querySelector('.barline');
          if (!line) return;
          const sec = S.cps[i] || {};
          const p = i < pos.si ? 1 : i > pos.si ? 0 : clamp01((pos.bi + pos.barProgress) / Math.max(1, sec.bars || 1));
          line.style.width = `${(p * 100).toFixed(1)}%`;
          card.style.borderColor = i === pos.si ? 'rgba(255,255,255,0.32)' : '';
        });
        const sec = S.cps[pos.si];
        if (sec) {
          $('#nowName').textContent = sec.name;
          $('#nowBar').textContent = `checkpoint ${pos.si + 1} / ${S.cps.length} · bar ${pos.bi + 1} / ${sec.bars}`;
        }
      }
    }
    requestAnimationFrame(tick);
  }

  /* ---------------- boot ---------------- */
  function renderAll() {
    renderRail();
    renderEditor();
    updateTransport();
  }

  $('#addCp').addEventListener('click', () => {
    const next = clone(S.cps[S.active] || cp({}));
    next.name = 'Checkpoint ' + (S.cps.length + 1);
    S.cps.splice(S.active + 1, 0, next);
    S.active++;
    renderAll();
    syncEngine();
  });
  $('#previewBtn').addEventListener('click', previewCheckpoint);
  $('#playAll').addEventListener('click', () => { playAll(); renderEditor(); });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); playAll(); renderEditor(); }
  });
  $('#clip').addEventListener('ended', () => { $('#clipStatus').textContent = 'clip finished'; });

  syncEngine();
  renderAll();
  tick();

  window.Checkpoints = {
    state: S,
    defaults: defaultCheckpoints,
    commission,
    preview: previewCheckpoint,
    engine: E
  };
  window.__SC3_READY__ = true;
})();
