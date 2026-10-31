/* ============================================================
   Song Canvas — app.js
   Three lenses over one song spec: draw / map / cards.
   ============================================================ */
(function () {
  'use strict';

  const E = window.SongEngine;
  const song = E.song;
  const HUES = [168, 205, 272, 324, 32, 112];
  const $ = sel => document.querySelector(sel);

  const state = {
    mode: 'draw',
    selected: 0,
    strokes: song.sections.map(() => null),
    drag: null,
    hoverLane: -1,
    lastLive: 0
  };

  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const hueFor = i => HUES[i % HUES.length];
  const dotFor = i => `hsl(${hueFor(i)} 72% 68%)`;

  /* ---------------- canvas helpers ---------------- */
  function fitCanvas(canvas) {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: r.width, h: r.height };
  }

  function laneRects(w, h) {
    const left = 104, right = 26, top = 26, bottom = 44;
    const n = song.sections.length;
    const laneH = (h - top - bottom) / n;
    return song.sections.map((s, i) => ({
      i,
      x: left,
      y: top + i * laneH,
      w: w - left - right,
      h: laneH
    }));
  }

  /* ---------------- draw lens ---------------- */
  const drawCanvas = $('#draw');
  const drawWrap = $('#drawView');

  function metricsFromStroke(pts, laneW, laneH) {
    if (pts.length < 2) return null;
    let len = 0, wob = 0, sy = 0, speedSum = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = (b.x - a.x) * laneW;
      const dy = (b.y - a.y) * laneH;
      const seg = Math.hypot(dx, dy);
      len += seg;
      wob += Math.abs(dy);
      const dt = Math.max(0.001, (b.t - a.t) / 1000);
      speedSum += seg / dt;
    }
    for (const p of pts) sy += p.y;
    const dur = Math.max(0.06, (pts[pts.length - 1].t - pts[0].t) / 1000);
    const speed = len / dur;
    const pace = clamp01((speed - 25) / 900);
    const brightness = clamp01(1 - sy / pts.length);
    const coverage = clamp01(len / (laneW * 1.55));
    const tension = clamp01((wob / Math.max(1, len)) * 3.4);
    const density = clamp01(0.12 + coverage * 0.95);
    const energy = clamp01(0.1 + pace * 0.62 + density * 0.25);
    const space = clamp01(0.16 + (1 - energy) * 0.55 + (1 - density) * 0.2);
    return { pace, brightness, tension, density, energy, space };
  }

  function applyMetrics(si, m) {
    if (!m) return;
    const s = song.sections[si];
    s.pace = m.pace;
    s.brightness = m.brightness;
    s.tension = m.tension;
    s.density = m.density;
    s.energy = m.energy;
    s.space = m.space;
  }

  function strokeFor(si) { return state.strokes[si]; }

  function drawStroke(ctx, lane, stroke, color) {
    if (!stroke || stroke.length < 2) return;
    const pts = stroke.map(p => ({ x: lane.x + p.x * lane.w, y: lane.y + p.y * lane.h }));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
  }

  function renderDraw(time) {
    const { ctx, w, h } = fitCanvas(drawCanvas);
    ctx.clearRect(0, 0, w, h);
    const lanes = laneRects(w, h);

    for (const lane of lanes) {
      const i = lane.i;
      const s = song.sections[i];
      const color = dotFor(i);
      const selected = i === state.selected;
      const g = ctx.createLinearGradient(lane.x, 0, lane.x + lane.w, 0);
      g.addColorStop(0, `hsla(${hueFor(i)}, 60%, 50%, ${selected ? 0.1 : 0.05})`);
      g.addColorStop(1, `hsla(${hueFor(i)}, 60%, 50%, 0.0)`);
      ctx.fillStyle = g;
      ctx.fillRect(lane.x, lane.y + 3, lane.w, lane.h - 6);

      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.09)';
      ctx.lineWidth = 1;
      ctx.strokeRect(lane.x + 0.5, lane.y + 3.5, lane.w - 1, lane.h - 7);

      // brightness guide
      ctx.setLineDash([2, 8]);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(lane.x, lane.y + lane.h * 0.5);
      ctx.lineTo(lane.x + lane.w, lane.y + lane.h * 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(236,234,245,0.92)';
      ctx.font = '600 12.5px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.name, 16, lane.y + 18);
      ctx.fillStyle = 'rgba(141,139,163,0.9)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${Math.round(s.energy * 100)}% energy`, 16, lane.y + 34);
      ctx.fillText(`${Math.round(s.brightness * 100)}% bright`, 16, lane.y + 48);

      const st = strokeFor(i);
      if (st) drawStroke(ctx, lane, st, color);
      else if (i === state.hoverLane && !state.drag) {
        ctx.save();
        ctx.globalAlpha = 0.25;
        drawStroke(ctx, lane, [{ x: 0.1, y: 0.55 }, { x: 0.9, y: 0.55 }], color);
        ctx.restore();
      }
    }

    // playhead
    const pos = E.position();
    if (pos && pos.si != null) {
      const lane = lanes[pos.si];
      if (lane) {
        const x = lane.x + lane.w * Math.min(1, (pos.bi + pos.barProgress) / Math.max(1, song.sections[pos.si].bars));
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillRect(x, lane.y + 4, 1.5, lane.h - 8);
      }
    }

    drawCanvas._lanes = lanes;
    drawCanvas._size = { w, h };
  }

  (function bindDraw() {
    const toLocal = (e, lane) => {
      const r = drawCanvas.getBoundingClientRect();
      const x = (e.clientX - r.left - lane.x) / lane.w;
      const y = (e.clientY - r.top - lane.y) / lane.h;
      return { x: clamp01(x), y: clamp01(y), t: performance.now() };
    };
    const laneAt = (e) => {
      const r = drawCanvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const lanes = drawCanvas._lanes || [];
      for (const lane of lanes) {
        if (x >= lane.x && x <= lane.x + lane.w && y >= lane.y && y <= lane.y + lane.h) return lane;
      }
      return null;
    };

    drawCanvas.addEventListener('pointerdown', (e) => {
      const lane = laneAt(e);
      if (!lane) return;
      e.preventDefault();
      drawCanvas.setPointerCapture(e.pointerId);
      state.selected = lane.i;
      state.drag = { si: lane.i, pts: [toLocal(e, lane)] };
      state.strokes[lane.i] = state.drag.pts;
      E.ensureCtx();
      syncSelection();
    });

    drawCanvas.addEventListener('pointermove', (e) => {
      if (!state.drag) {
        const lane = laneAt(e);
        state.hoverLane = lane ? lane.i : -1;
        return;
      }
      e.preventDefault();
      const lane = laneAt(e);
      if (!lane || lane.i !== state.drag.si) return;
      state.drag.pts.push(toLocal(e, lane));
      const now = performance.now();
      if (now - state.lastLive > 110) {
        state.lastLive = now;
        const m = metricsFromStroke(state.drag.pts, lane.w, lane.h);
        if (m) { applyMetrics(state.drag.si, m); refreshSoft(); }
      }
    });

    const end = (e) => {
      if (!state.drag) return;
      const lane = (drawCanvas._lanes || [])[state.drag.si];
      const m = lane ? metricsFromStroke(state.drag.pts, lane.w, lane.h) : null;
      if (m) applyMetrics(state.drag.si, m);
      state.drag = null;
      if (e && e.pointerId != null) { try { drawCanvas.releasePointerCapture(e.pointerId); } catch (err) {} }
      refreshFull();
    };
    drawCanvas.addEventListener('pointerup', end);
    drawCanvas.addEventListener('pointercancel', end);
    drawCanvas.addEventListener('pointerleave', () => { state.hoverLane = -1; });
  })();

  /* ---------------- map lens ---------------- */
  const mapCanvas = $('#map');
  const mapWrap = $('#mapView');

  function mapGeom() {
    const { ctx, w, h } = fitCanvas(mapCanvas);
    const padL = 74, padR = 38, padT = 38, padB = 54;
    return { ctx, w, h, x0: padL, y0: padT, fw: w - padL - padR, fh: h - padT - padB };
  }
  function nodePos(g, s) {
    return { x: g.x0 + clamp01(s.energy) * g.fw, y: g.y0 + (1 - clamp01(s.brightness)) * g.fh };
  }

  function renderMap() {
    const g = mapGeom();
    const { ctx } = g;
    ctx.clearRect(0, 0, g.w, g.h);
    if (g.fw <= 0 || g.fh <= 0) return;

    const grd = ctx.createRadialGradient(g.x0 + g.fw * 0.5, g.y0 + g.fh * 0.45, 10, g.x0 + g.fw * 0.5, g.y0 + g.fh * 0.5, Math.max(g.fw, g.fh) * 0.75);
    grd.addColorStop(0, 'rgba(179,156,255,0.08)');
    grd.addColorStop(1, 'rgba(8,9,13,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(g.x0, g.y0, g.fw, g.fh);

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const x = g.x0 + (g.fw * i) / 4;
      const y = g.y0 + (g.fh * i) / 4;
      ctx.beginPath(); ctx.moveTo(x, g.y0); ctx.lineTo(x, g.y0 + g.fh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(g.x0, y); ctx.lineTo(g.x0 + g.fw, y); ctx.stroke();
    }

    ctx.fillStyle = 'rgba(141,139,163,0.85)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('calm', g.x0, g.y0 + g.fh + 24);
    ctx.fillText('intense', g.x0 + g.fw, g.y0 + g.fh + 24);
    ctx.save();
    ctx.translate(20, g.y0 + g.fh / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('dark  →  bright', 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';

    const pts = song.sections.map((s) => nodePos(g, s));
    if (pts.length > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.quadraticCurveTo(a.x, a.y, mx, my);
        ctx.quadraticCurveTo(b.x, b.y, b.x, b.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // direction arrows at segment midpoints
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(ang);
        ctx.fillStyle = 'rgba(255,255,255,0.34)';
        ctx.beginPath();
        ctx.moveTo(5, 0); ctx.lineTo(-4, 4); ctx.lineTo(-4, -4);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }

    const pos = E.position();
    song.sections.forEach((s, i) => {
      const p = pts[i];
      const color = dotFor(i);
      const selected = i === state.selected;
      const active = pos && pos.si === i;
      const r = active ? 21 : 17;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = selected || active ? 26 : 12;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.95;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = selected ? 1.6 : 1;
      ctx.stroke();

      ctx.fillStyle = 'rgba(8,9,13,0.82)';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y + 0.5);

      ctx.fillStyle = 'rgba(236,234,245,0.9)';
      ctx.font = '600 12px system-ui, sans-serif';
      const flip = p.x > g.x0 + g.fw - 130;
      ctx.textAlign = flip ? 'right' : 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.name, p.x + (flip ? -r - 9 : r + 9), p.y + 1);
    });
  }

  (function bindMap() {
    mapCanvas.addEventListener('pointerdown', (e) => {
      const g = mapGeom();
      const r = mapCanvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      let hit = -1, best = 30;
      song.sections.forEach((s, i) => {
        const p = nodePos(g, s);
        const d = Math.hypot(px - p.x, py - p.y);
        if (d < best) { best = d; hit = i; }
      });
      if (hit < 0) return;
      state.selected = hit;
      state.drag = { kind: 'map', si: hit };
      mapCanvas.setPointerCapture(e.pointerId);
      syncSelection();
      E.ensureCtx();
    });

    mapCanvas.addEventListener('pointermove', (e) => {
      if (!state.drag) return;
      const g = mapGeom();
      const r = mapCanvas.getBoundingClientRect();
      const x = clamp01((e.clientX - r.left - g.x0) / Math.max(1, g.fw));
      const y = clamp01((e.clientY - r.top - g.y0) / Math.max(1, g.fh));
      const s = song.sections[state.drag.si];
      s.energy = x;
      s.brightness = 1 - y;
      const now = performance.now();
      if (now - state.lastLive > 110) { state.lastLive = now; refreshSoft(); }
    });

    const up = () => { if (state.drag && state.drag.kind === 'map') { state.drag = null; refreshFull(); } };
    mapCanvas.addEventListener('pointerup', up);
    mapCanvas.addEventListener('pointercancel', up);
  })();

  /* ---------------- cards lens ---------------- */
  const cardsEl = $('#cards');

  const SLIDERS = [
    { key: 'brightness', left: 'dark', right: 'bright' },
    { key: 'energy', left: 'calm', right: 'driven' },
    { key: 'tension', left: 'soft', right: 'sharp' },
    { key: 'density', left: 'sparse', right: 'busy' },
    { key: 'space', left: 'dry', right: 'spacey' },
    { key: 'pace', left: 'slow', right: 'fast' }
  ];

  function rebuildCards() {
    cardsEl.innerHTML = '';
    song.sections.forEach((s, i) => {
      const card = document.createElement('article');
      card.className = 'card';
      card.style.setProperty('--dot', dotFor(i));

      const h = document.createElement('h3');
      h.style.setProperty('--dot', dotFor(i));
      h.innerHTML = `<span class="dot"></span>`;
      const name = document.createElement('input');
      name.className = 'name';
      name.value = s.name;
      name.setAttribute('aria-label', 'Moment name');
      name.addEventListener('input', () => { s.name = name.value || 'Moment'; refreshStrip(); });
      h.appendChild(name);

      const bars = document.createElement('div');
      bars.className = 'bars';
      const minus = document.createElement('button'); minus.textContent = '−';
      const count = document.createElement('span'); count.textContent = `${s.bars} bars`;
      const plus = document.createElement('button'); plus.textContent = '+';
      minus.addEventListener('click', () => { s.bars = Math.max(1, s.bars - 1); count.textContent = `${s.bars} bars`; refreshFull(); });
      plus.addEventListener('click', () => { s.bars = Math.min(8, s.bars + 1); count.textContent = `${s.bars} bars`; refreshFull(); });
      bars.append(minus, count, plus);
      h.appendChild(bars);

      const rm = document.createElement('button');
      rm.className = 'remove'; rm.textContent = '✕'; rm.title = 'Remove moment';
      rm.addEventListener('click', (e) => { e.stopPropagation(); removeSection(i); });

      card.append(h, rm);

      for (const sl of SLIDERS) {
        const wrap = document.createElement('label');
        wrap.className = 'slider';
        const lab = document.createElement('div');
        lab.className = 'lab';
        const l = document.createElement('span'); l.textContent = sl.left;
        const r = document.createElement('span'); r.textContent = sl.right;
        lab.append(l, r);
        const input = document.createElement('input');
        input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.01';
        input.value = String(s[sl.key]);
        input.setAttribute('aria-label', `${sl.left} to ${sl.right}`);
        input.addEventListener('input', () => {
          s[sl.key] = parseFloat(input.value);
          refreshSoft();
        });
        wrap.append(lab, input);
        card.appendChild(wrap);
      }

      const row = document.createElement('div');
      row.className = 'row';
      const prog = document.createElement('select');
      prog.setAttribute('aria-label', 'Harmony');
      for (const [id, p] of Object.entries(E.PROGRESSIONS)) {
        const opt = document.createElement('option');
        opt.value = id; opt.textContent = p.label; opt.selected = s.progression === id;
        prog.appendChild(opt);
      }
      prog.addEventListener('change', () => { s.progression = prog.value; refreshSoft(); });

      const flow = document.createElement('select');
      flow.setAttribute('aria-label', 'How it arrives');
      for (const f of E.FLOWS) {
        const opt = document.createElement('option');
        opt.value = f.id; opt.textContent = f.label; opt.selected = s.flow === f.id;
        flow.appendChild(opt);
      }
      flow.addEventListener('change', () => { s.flow = flow.value; refreshStrip(); });

      row.append(prog, flow);
      card.appendChild(row);

      const chips = document.createElement('div');
      chips.className = 'chips';
      for (const inst of E.INSTRUMENTS) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (s.instruments[inst.id] ? ' on' : '');
        chip.textContent = inst.label;
        chip.addEventListener('click', () => {
          s.instruments[inst.id] = !s.instruments[inst.id];
          chip.classList.toggle('on', s.instruments[inst.id]);
          refreshSoft();
        });
        chips.appendChild(chip);
      }
      card.appendChild(chips);

      card.addEventListener('pointerdown', () => {
        state.selected = i;
        syncSelection();
      });

      cardsEl.appendChild(card);
    });
    syncSelection();
  }

  /* ---------------- strip + tiles ---------------- */
  const stripEl = $('#strip');

  function rebuildStrip() {
    stripEl.innerHTML = '';
    song.sections.forEach((s, i) => {
      const el = document.createElement('button');
      el.className = 'moment' + (i === state.selected ? ' on' : '');
      el.style.setProperty('--dot', dotFor(i));
      el.dataset.i = String(i);

      const h = document.createElement('div');
      h.className = 'h';
      const dot = document.createElement('span'); dot.className = 'dot';
      const nm = document.createElement('span'); nm.textContent = `${i + 1}. ${s.name}`;
      h.append(dot, nm);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<span>${s.bars} bars</span><span>${(E.RIFFS[s.riff] || { label: 'Riff' }).label}</span>`;

      const pips = document.createElement('div');
      pips.className = 'pips';
      for (const inst of E.INSTRUMENTS) {
        const pip = document.createElement('i');
        if (s.instruments[inst.id]) pip.classList.add('on');
        pips.appendChild(pip);
      }

      const fill = document.createElement('div');
      fill.className = 'fill';

      el.append(h, meta, pips, fill);
      el.addEventListener('click', () => {
        state.selected = i;
        syncSelection();
        if (state.mode === 'cards') {
          const cards = cardsEl.querySelectorAll('.card');
          if (cards[i]) cards[i].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
      stripEl.appendChild(el);
    });
  }

  const tilesEl = $('#tiles');
  function rebuildTiles() {
    tilesEl.innerHTML = '';
    const svg = document.createElement('canvas');
    svg.width = 88; svg.height = 36;
    for (const [id, riff] of Object.entries(E.RIFFS)) {
      const btn = document.createElement('button');
      btn.className = 'tile' + (song.sections[state.selected] && song.sections[state.selected].riff === id ? ' on' : '');
      btn.dataset.riff = id;

      const c = document.createElement('canvas');
      c.width = 88; c.height = 36;
      const cc = c.getContext('2d');
      cc.strokeStyle = 'rgba(255,255,255,0.75)';
      cc.lineWidth = 1.4;
      cc.beginPath();
      riff.steps.forEach(([step, deg, len], k) => {
        const x = 3 + (step / 16) * 82;
        const y = 30 - (deg / 6) * 24;
        if (k === 0) cc.moveTo(x, y); else cc.lineTo(x, y);
        if (len > 1) {
          const x2 = 3 + ((step + len) / 16) * 82;
          cc.lineTo(x2, y);
        }
      });
      cc.stroke();

      const lab = document.createElement('span');
      lab.textContent = riff.label;
      btn.append(c, lab);
      btn.addEventListener('click', () => {
        song.sections[state.selected].riff = id;
        syncTiles();
        refreshStrip();
      });
      tilesEl.appendChild(btn);
    }
  }
  function syncTiles() {
    const cur = song.sections[state.selected] ? song.sections[state.selected].riff : null;
    tilesEl.querySelectorAll('.tile').forEach(t => t.classList.toggle('on', t.dataset.riff === cur));
  }

  function syncSelection() {
    stripEl.querySelectorAll('.moment').forEach((el) => {
      el.classList.toggle('on', Number(el.dataset.i) === state.selected);
    });
    syncTiles();
    if (state.mode === 'cards') {
      cardsEl.querySelectorAll('.card').forEach((card, i) => {
        card.style.outline = i === state.selected ? '1px solid rgba(255,255,255,0.22)' : 'none';
      });
    }
  }

  /* ---------------- refresh ---------------- */
  let softTimer = null;
  function refreshSoft() {
    if (softTimer) return;
    softTimer = setTimeout(() => {
      softTimer = null;
      rebuildStrip();
      if (state.mode === 'cards') syncCardValues();
    }, 90);
  }
  function refreshFull() {
    rebuildStrip();
    syncCardValues();
    syncTiles();
    syncSelection();
  }
  function syncCardValues() {
    const cards = cardsEl.querySelectorAll('.card');
    song.sections.forEach((s, i) => {
      const card = cards[i];
      if (!card) return;
      card.querySelectorAll('input[type="range"]').forEach((input, k) => {
        const key = SLIDERS[k].key;
        if (document.activeElement !== input) input.value = String(s[key]);
      });
      const count = card.querySelector('.bars span');
      if (count) count.textContent = `${s.bars} bars`;
      const sel = card.querySelectorAll('select');
      if (sel[0]) sel[0].value = s.progression;
      if (sel[1]) sel[1].value = s.flow;
      card.querySelectorAll('.chip').forEach((chip, k) => {
        chip.classList.toggle('on', !!s.instruments[E.INSTRUMENTS[k].id]);
      });
    });
  }

  /* ---------------- structure edits ---------------- */
  function addSection() {
    const last = song.sections[song.sections.length - 1] || E.section({});
    const next = E.section({
      name: `Moment ${song.sections.length + 1}`,
      bars: 2,
      pace: last.pace,
      energy: last.energy,
      brightness: last.brightness,
      tension: last.tension,
      density: last.density,
      space: last.space,
      progression: last.progression,
      riff: last.riff,
      flow: 'blend',
      instruments: JSON.parse(JSON.stringify(last.instruments))
    });
    song.sections.push(next);
    state.strokes.push(null);
    state.selected = song.sections.length - 1;
    rebuildCards();
    refreshFull();
  }
  function removeSection(i) {
    if (song.sections.length <= 1) return;
    song.sections.splice(i, 1);
    state.strokes.splice(i, 1);
    state.selected = Math.min(state.selected, song.sections.length - 1);
    if (E.isPlaying()) E.restart();
    rebuildCards();
    refreshFull();
  }

  /* ---------------- transport ---------------- */
  const playBtn = $('#play');
  function setPlaying(ui) {
    playBtn.classList.toggle('playing', ui);
    playBtn.textContent = ui ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', ui ? 'Pause' : 'Play');
  }
  playBtn.addEventListener('click', () => {
    if (E.isPlaying()) { E.pause(); setPlaying(false); }
    else { E.play(); setPlaying(true); }
  });
  $('#loopBtn').addEventListener('click', () => { E.restart(); if (!E.isPlaying()) { E.play(); setPlaying(true); } });
  $('#addSection').addEventListener('click', addSection);

  /* ---------------- mode switch ---------------- */
  const views = { draw: drawWrap, map: mapWrap, cards: $('#cardsView') };
  function setMode(mode) {
    state.mode = mode;
    for (const [k, el] of Object.entries(views)) el.classList.toggle('hidden', k !== mode);
    document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    if (mode === 'cards') rebuildCards();
  }
  $('#modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  /* ---------------- AI dialog ---------------- */
  const dialog = $('#aiDialog');
  const specView = $('#specView');
  const noteEl = $('#aiNote');
  const ENDPOINT = window.SONGCANVAS_ENDPOINT || '';

  function spec() {
    return {
      key: song.keyName,
      sections: song.sections.map(s => ({
        name: s.name,
        bars: s.bars,
        pace: round2(s.pace),
        energy: round2(s.energy),
        brightness: round2(s.brightness),
        tension: round2(s.tension),
        density: round2(s.density),
        space: round2(s.space),
        progression: s.progression,
        riff: s.riff,
        flow: s.flow,
        instruments: Object.keys(s.instruments).filter(k => s.instruments[k])
      }))
    };
  }
  const round2 = v => Math.round(v * 100) / 100;

  function setNote(t) { noteEl.textContent = t; }

  function openAi() {
    specView.textContent = JSON.stringify(spec(), null, 2);
    setNote(ENDPOINT ? `Backend: ${ENDPOINT}` : 'Backend not connected — local sketch only. Point window.SONGCANVAS_ENDPOINT at the opencode bridge to enable real generation.');
    if (!dialog.open) dialog.showModal();
  }
  $('#ai').addEventListener('click', openAi);

  function applySpec(obj) {
    if (!obj || !Array.isArray(obj.sections) || !obj.sections.length) throw new Error('No sections in spec');
    const next = obj.sections.slice(0, 6).map((s, i) => {
      const base = E.section({});
      const inst = s.instruments
        ? E.INSTRUMENTS.reduce((acc, it) => { acc[it.id] = s.instruments.includes(it.id); return acc; }, {})
        : base.instruments;
      return E.section({
        name: s.name || `Moment ${i + 1}`,
        bars: Math.max(1, Math.min(8, s.bars | 0 || 2)),
        pace: clamp01(numOr(s.pace, base.pace)),
        energy: clamp01(numOr(s.energy, base.energy)),
        brightness: clamp01(numOr(s.brightness, base.brightness)),
        tension: clamp01(numOr(s.tension, base.tension)),
        density: clamp01(numOr(s.density, base.density)),
        space: clamp01(numOr(s.space, base.space)),
        progression: E.PROGRESSIONS[s.progression] ? s.progression : 'bittersweet',
        riff: E.RIFFS[s.riff] ? s.riff : 'lullaby',
        flow: E.FLOWS.some(f => f.id === s.flow) ? s.flow : 'blend',
        instruments: inst
      });
    });
    song.sections.length = 0;
    song.sections.push(...next);
    state.strokes = song.sections.map(() => null);
    state.selected = 0;
    rebuildCards();
    refreshFull();
    if (E.isPlaying()) E.restart();
    specView.textContent = JSON.stringify(spec(), null, 2);
  }
  function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

  // local heuristic sketch — stands in for the AI until the bridge exists
  function sketchFromText(text) {
    const t = (text || '').toLowerCase();
    const has = (...ws) => ws.some(w => t.includes(w));
    const base = { energy: 0.42, brightness: 0.5, tension: 0.28, density: 0.45, space: 0.4, pace: 0.42 };

    if (has('dark', 'sad', 'moody', 'night', 'rain', 'melancholy', 'minor', 'mysterious', 'lonely')) {
      base.brightness -= 0.16; base.tension += 0.12; base.space += 0.06;
    }
    if (has('bright', 'happy', 'sun', 'joy', 'hopeful', 'warm', 'uplift', 'morning')) {
      base.brightness += 0.16; base.tension -= 0.06;
    }
    if (has('slow', 'calm', 'chill', 'ambient', 'gentle', 'sleep', 'float', 'dream', 'lazy')) {
      base.energy -= 0.15; base.density -= 0.13; base.pace -= 0.16; base.space += 0.1;
    }
    if (has('fast', 'driving', 'energetic', 'dance', 'party', 'aggressive', 'heavy', 'rock', 'punch', 'rush')) {
      base.energy += 0.22; base.density += 0.18; base.pace += 0.16;
    }
    if (has('wide', 'space', 'reverb', 'airy', 'open', 'vast')) base.space += 0.15;
    if (has('tight', 'dry', 'close', 'intimate')) base.space -= 0.15;
    if (has('jazz', 'lush', 'rich', 'chords', 'harmonic')) base.tension += 0.12;
    if (has('simple', 'sparse', 'minimal')) base.density -= 0.15;

    const clamp = clamp01;
    const bright = clamp(base.brightness);
    const tens = clamp(base.tension);
    const prog = bright > 0.6 ? 'rising' : tens > 0.5 ? 'dark' : 'bittersweet';
    const prog2 = bright > 0.6 ? 'open' : 'floating';
    const riffs = base.energy > 0.6 ? ['hook', 'drive'] : base.density < 0.35 ? ['drift', 'sparse'] : ['lullaby', 'spark'];
    const arc = [0.5, 0.72, 1.0, 0.55];
    const names = ['Open', 'Build', 'Peak', 'Settle'];
    const flows = ['blend', 'lift', 'lift', 'blend'];
    return {
      key: 'A minor',
      sections: arc.map((a, i) => ({
        name: names[i],
        bars: 2,
        pace: clamp(base.pace + (a - 0.7) * 0.18),
        energy: clamp(base.energy + (a - 0.7) * 0.3),
        brightness: clamp(bright + (a - 0.7) * 0.18),
        tension: clamp(tens + (i === 3 ? 0.1 : 0)),
        density: clamp(base.density + (a - 0.7) * 0.28),
        space: clamp(base.space + (i === 0 || i === 3 ? 0.1 : -0.04)),
        progression: i === 3 ? prog2 : prog,
        riff: riffs[i % riffs.length],
        flow: flows[i],
        instruments: i === 0 ? (base.energy < 0.35 ? ['pad', 'bass'] : ['pad', 'pluck', 'bass']) : ['pad', 'pluck', 'bass', 'drums']
      }))
    };
  }

  $('#sketch').addEventListener('click', async () => {
    const brief = $('#brief').value.trim();
    setNote('Sketching…');
    if (ENDPOINT) {
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brief, spec: spec() })
        });
        if (!res.ok) throw new Error(`backend ${res.status}`);
        const data = await res.json();
        applySpec(data.spec || data);
        setNote('Applied the backend arrangement.');
        return;
      } catch (err) {
        setNote(`Backend failed (${err.message}); falling back to a local sketch.`);
      }
    } else {
      setNote('Applied a local sketch. Connect the opencode bridge to have the AI compose it.');
    }
    try {
      applySpec(sketchFromText(brief));
    } catch (err) {
      setNote(`Could not sketch: ${err.message}`);
    }
  });

  $('#applyJson').addEventListener('click', () => {
    try {
      const raw = specView.textContent.trim();
      const obj = JSON.parse(raw);
      applySpec(obj.spec || obj);
      setNote('Applied the JSON spec.');
    } catch (err) {
      setNote(`Invalid JSON: ${err.message}`);
    }
  });

  $('#copyBrief').addEventListener('click', async () => {
    const brief = $('#brief').value.trim();
    const prompt = [
      'You are the composer inside "Song Canvas", a non-technical gesture music tool.',
      'Return ONLY JSON matching the schema below, no prose.',
      'Each section: name, bars (1-8), pace/energy/brightness/tension/density/space (0-1),',
      'progression (one of: ' + Object.keys(E.PROGRESSIONS).join(', ') + '),',
      'riff (one of: ' + Object.keys(E.RIFFS).join(', ') + '),',
      'flow (one of: ' + E.FLOWS.map(f => f.id).join(', ') + '),',
      'instruments (subset of: ' + E.INSTRUMENTS.map(i => i.id).join(', ') + ').',
      '',
      'Current song spec:',
      JSON.stringify(spec(), null, 2),
      '',
      'The user wants:',
      brief || '(no brief given)'
    ].join('\n');
    try {
      await navigator.clipboard.writeText(prompt);
      setNote('Brief copied — paste it into opencode.');
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = prompt;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setNote('Brief copied.'); }
      catch (e2) { setNote('Copy failed — select the JSON below manually.'); }
      ta.remove();
    }
  });

  /* ---------------- loop ---------------- */
  function updatePlayhead() {
    const pos = E.position();
    const nowName = $('#nowName');
    const nowBar = $('#nowBar');
    const moments = stripEl.querySelectorAll('.moment');
    if (pos) {
      const s = song.sections[pos.si];
      nowName.textContent = s.name;
      nowBar.textContent = `moment ${pos.si + 1} / ${song.sections.length} · bar ${pos.bi + 1} / ${s.bars}`;
      const p = clamp01((pos.bi + pos.barProgress) / Math.max(1, s.bars));
      moments.forEach((el, i) => {
        const fill = el.querySelector('.fill');
        if (!fill) return;
        fill.style.width = i === pos.si ? `${(p * 100).toFixed(1)}%` : i < pos.si ? '100%' : '0%';
      });
    } else if (!E.isPlaying()) {
      nowName.textContent = 'press play';
      nowBar.textContent = '';
      moments.forEach(el => { const f = el.querySelector('.fill'); if (f) f.style.width = '0%'; });
    }
  }

  function frame() {
    if (state.mode === 'draw') renderDraw(performance.now());
    else if (state.mode === 'map') renderMap();
    updatePlayhead();
    requestAnimationFrame(frame);
  }

  /* ---------------- boot ---------------- */
  window.addEventListener('resize', () => {
    if (state.mode === 'draw') renderDraw(performance.now());
    else if (state.mode === 'map') renderMap();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
    if (e.key === '1') setMode('draw');
    if (e.key === '2') setMode('map');
    if (e.key === '3') setMode('cards');
  });

  rebuildCards();
  rebuildStrip();
  rebuildTiles();
  setMode('draw');
  requestAnimationFrame(frame);

  window.SongCanvas = {
    state,
    song,
    engine: E,
    setMode,
    applySpec,
    sketchFromText,
    spec,
    refreshAll: refreshFull,
    play: () => { E.play(); setPlaying(true); },
    pause: () => { E.pause(); setPlaying(false); }
  };
  window.__SC_READY__ = true;
})();
