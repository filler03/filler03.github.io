(() => {
  'use strict';

  const M = window.SectionModel;
  const E = window.TasteEngine;
  const $ = selector => document.querySelector(selector);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const clamp = M.clamp;
  const pct = value => `${Math.round(Number(value) * 100)}%`;
  const shortTime = seconds => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds)) % 60).padStart(2, '0')}`;
  const shortDate = iso => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const SNAP_KEY = 'songcanvas.section.snapbars';

  const els = {
    status: $('#status'),
    sourceCount: $('#sourceCount'),
    transportStatus: $('#transportStatus'),
    sourceA: $('#sourceA'),
    sourceB: $('#sourceB'),
    playBtn: $('#playBtn'),
    stopBtn: $('#stopBtn'),
    playState: $('#playState'),
    lanes: $('#lanes'),
    axis: $('#axis'),
    snapBars: $('#snapBars'),
    undoPoint: $('#undoPoint'),
    resetBtn: $('#resetBtn'),
    focusChips: $('#focusChips'),
    effectsLock: $('#effectsLock'),
    autoNext: $('#autoNext'),
    nextBtn: $('#nextBtn'),
    likeBtn: $('#likeBtn'),
    likeStatus: $('#likeStatus'),
    variationLabel: $('#variationLabel'),
    variationClock: $('#variationClock'),
    progressFill: $('#progressFill'),
    briefStats: $('#briefStats'),
    briefList: $('#briefList'),
    exportBtn: $('#exportBtn'),
    likeCount: $('#likeCount'),
    likesList: $('#likesList')
  };

  const state = {
    sources: [],
    byKey: {},
    section: null,
    playing: false,
    loading: false,
    playToken: 0,
    raf: 0,
    lastLoopCycle: 0,
    loopDur: 0,
    undoPoint: null,
    playhead: 0,
    dragging: null,
    lastPointTap: null,
    dragMoved: false,
    pendingLaneRender: false,
    laneRefs: {},
    ready: false
  };

  function setStatus(message, error) {
    if (!els.status) return;
    els.status.textContent = message;
    els.status.classList.toggle('error', !!error);
  }

  function setTransport(message, error = false) {
    if (!els.transportStatus) return;
    els.transportStatus.textContent = message;
    els.transportStatus.classList.toggle('error', !!error);
  }

  function definition(id) {
    return M.ATTR_BY_ID[id];
  }

  function persist() {
    try {
      state.section = M.saveSection(state.section, state.byKey);
      return true;
    } catch (error) {
      setStatus(error.message || 'Could not save this section.', true);
      return false;
    }
  }

  function snappedT(t) {
    if (els.snapBars && els.snapBars.checked) return clamp(Math.round(t * M.BARS) / M.BARS, 0, 1);
    return Math.round(clamp(t, 0, 1) * 1000) / 1000;
  }

  function renderSourceOptions() {
    for (const select of [els.sourceA, els.sourceB]) {
      if (!select) continue;
      const current = select.value;
      select.textContent = '';
      const families = new Map();
      for (const source of state.sources) {
        const family = source.family_label || 'Other';
        if (!families.has(family)) families.set(family, []);
        families.get(family).push(source);
      }
      for (const [family, sources] of families) {
        const group = document.createElement('optgroup');
        group.label = family;
        for (const source of sources) {
          const option = document.createElement('option');
          option.value = source.key;
          option.textContent = source.label;
          group.appendChild(option);
        }
        select.appendChild(group);
      }
      if (current && state.byKey[current]) select.value = current;
    }
    if (els.sourceA && state.section.sources[0]) els.sourceA.value = state.section.sources[0].key;
    if (els.sourceB && state.section.sources[1]) els.sourceB.value = state.section.sources[1].key;
    if (els.sourceCount) els.sourceCount.textContent = `${state.sources.length} sources`;
  }

  function pathFromPoints(points, offset = 0) {
    if (!points || !points.length) return '';
    const parts = [];
    for (const point of points) {
      const x = clamp(point.t, 0, 1) * 1000;
      const y = (1 - clamp(point.v + offset, 0, 1)) * 70;
      parts.push(`${parts.length ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`);
    }
    return parts.join(' ');
  }

  function linePath(value, dashed = false) {
    const y = (1 - clamp(value, 0, 1)) * 70;
    return `M0,${y.toFixed(2)} L1000,${y.toFixed(2)}`;
  }

  function makeSvg() {
    return document.createElementNS(SVG_NS, 'svg');
  }

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  function makeControl(label, text, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = label;
    button.textContent = text;
    button.addEventListener('click', handler);
    return button;
  }

  function renderLanesSafe() {
    if (state.dragging) {
      state.pendingLaneRender = true;
      return;
    }
    renderLanes();
  }

  function renderLanes() {
    if (!els.lanes) return;
    els.lanes.textContent = '';
    state.laneRefs = {};
    for (const attr of M.ATTRIBUTES) {
      const laneData = state.section.attributes[attr.id];
      const locked = M.isLocked(state.section, attr.id);
      const lane = document.createElement('section');
      lane.className = 'lane'
        + (laneData.specified ? ' specified' : ' auto')
        + (locked ? ' locked' : '')
        + (state.section.discovery.focus === attr.id ? ' focus' : '');
      lane.style.setProperty('--attr-color', attr.color);
      lane.dataset.attribute = attr.id;

      const head = document.createElement('div');
      head.className = 'lane-head';
      const dot = document.createElement('i');
      dot.className = 'lane-dot';
      const name = document.createElement('span');
      name.className = 'lane-name';
      name.textContent = attr.label;
      const status = document.createElement('span');
      status.className = 'lane-status';
      status.textContent = laneData.specified ? 'curve' : 'AI decides';
      if (locked) status.textContent += laneData.locked ? ' · locked' : ' · locked by effects';

      const spec = makeControl('lane-spec' + (laneData.specified ? ' on' : ''), laneData.specified ? 'Use auto' : 'Draw curve', () => {
        M.toggleSpecified(state.section, attr.id);
        persist();
        renderLanes();
        renderFocus();
        renderGuide();
        setStatus(`${attr.label}: ${state.section.attributes[attr.id].specified ? 'curve specified' : 'left for the AI'}.`);
      });
      spec.setAttribute('aria-label', `${attr.label}: ${laneData.specified ? 'use AI decision' : 'draw a curve'}`);

      const groupLocked = state.section.discovery.effects_locked && attr.effects;
      const lock = makeControl('lane-lock', locked ? 'Locked' : 'Lock', () => {
        const previousFocus = state.section.discovery.focus;
        M.toggleLock(state.section, attr.id);
        persist();
        renderLanes();
        renderFocus();
        renderDiscovery();
        renderGuide();
        const focus = state.section.discovery.focus;
        if (focus !== previousFocus) {
          setStatus(`${attr.label} locked. Discovery moved to ${definition(focus).label}.`);
        }
      });
      lock.disabled = groupLocked;
      lock.setAttribute('aria-label', groupLocked ? `${attr.label}: locked by the effects group` : `${attr.label}: ${laneData.locked ? 'unlock' : 'lock'} discovery`);

      head.append(dot, name, status, spec, lock);
      lane.appendChild(head);

      const svg = makeSvg();
      svg.setAttribute('viewBox', '0 0 1000 70');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${attr.label} curve. ${laneData.specified ? 'Specified curve.' : 'Automatic, decided by the AI.'} ${laneData.locked ? 'Locked.' : ''}`);

      for (const ratio of [0.25, 0.5, 0.75]) {
        const y = (1 - ratio) * 70;
        svg.appendChild(svgElement('line', { class: 'lane-grid-line', x1: 0, y1: y, x2: 1000, y2: y }));
      }

      const autoLine = svgElement('path', { class: 'lane-auto-line', d: linePath(attr.default), fill: 'none' });
      const variationLine = svgElement('path', { class: 'lane-variation', d: '', fill: 'none' });
      const curve = svgElement('path', { class: 'lane-curve', d: '', fill: 'none' });
      const points = svgElement('g', { class: 'lane-points' });
      const playhead = svgElement('line', { class: 'lane-playhead', x1: 0, y1: 0, x2: 0, y2: 70 });
      svg.append(autoLine, variationLine, curve, points, playhead);
      lane.appendChild(svg);

      const drawHint = document.createElement('div');
      drawHint.className = 'lane-draw-hint';
      drawHint.textContent = 'Click to draw a curve';
      lane.appendChild(drawHint);

      const tip = document.createElement('div');
      tip.className = 'lane-tip';
      lane.appendChild(tip);

      els.lanes.appendChild(lane);

      state.laneRefs[attr.id] = { lane, svg, autoLine, variationLine, curve, points, playhead, drawHint, tip };
      bindLanePointer(svg, attr.id);
      drawLane(attr.id);
    }
    drawAxis();
    updatePlayheads(state.playhead);
  }

  function drawLane(id) {
    const ref = state.laneRefs[id];
    const laneData = state.section.attributes[id];
    const attr = definition(id);
    if (!ref || !laneData || !attr) return;
    const isFocus = state.section.discovery.focus === id;
    const verifiable = !M.isLocked(state.section, id);
    const offset = isFocus && verifiable ? state.section.discovery.offset : 0;

    ref.autoLine.style.display = laneData.specified ? 'none' : '';
    ref.autoLine.setAttribute('d', linePath(attr.default));
    if (ref.drawHint) ref.drawHint.style.display = laneData.specified ? 'none' : '';
    ref.curve.style.display = laneData.specified ? '' : 'none';
    ref.curve.setAttribute('d', laneData.specified ? pathFromPoints(laneData.points) : '');
    ref.variationLine.style.display = isFocus ? '' : 'none';
    if (isFocus) {
      if (laneData.specified) {
        ref.variationLine.setAttribute('d', pathFromPoints(laneData.points, offset));
      } else {
        ref.variationLine.setAttribute('d', pathFromPoints([{ t: 0, v: attr.default }, { t: 1, v: attr.default }], offset));
      }
    } else {
      ref.variationLine.setAttribute('d', '');
    }

    ref.points.textContent = '';
    if (laneData.specified) {
      for (let index = 0; index < laneData.points.length; index++) {
        const point = laneData.points[index];
        const circle = svgElement('circle', {
          class: 'lane-point',
          cx: (clamp(point.t, 0, 1) * 1000).toFixed(2),
          cy: ((1 - clamp(point.v, 0, 1)) * 70).toFixed(2),
          r: 4.2,
          'data-index': index
        });
        ref.points.appendChild(circle);
      }
    }
    updatePlayhead(id, state.playhead);
  }

  function drawAxis() {
    if (!els.axis) return;
    els.axis.textContent = '';
    for (const bar of [0, 2, 4, 6, 8]) {
      const span = document.createElement('span');
      span.textContent = bar === 8 ? '8 bars' : `bar ${bar + 1}`;
      els.axis.appendChild(span);
    }
  }

  function updatePlayhead(id, t) {
    const ref = state.laneRefs[id];
    if (!ref) return;
    const x = (clamp(t, 0, 1) * 1000).toFixed(2);
    ref.playhead.setAttribute('x1', x);
    ref.playhead.setAttribute('x2', x);
  }

  function updatePlayheads(t) {
    for (const attr of M.ATTRIBUTES) updatePlayhead(attr.id, t);
  }

  function pointFromEvent(svg, event) {
    const rect = svg.getBoundingClientRect();
    const t = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const v = clamp(1 - (event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    return { t, v };
  }

  function findPoint(svg, laneData, target) {
    const rect = svg.getBoundingClientRect();
    let best = -1;
    let distance = 15;
    for (let index = 0; index < laneData.points.length; index++) {
      const point = laneData.points[index];
      const dx = (point.t - target.t) * rect.width;
      const dy = (point.v - target.v) * rect.height;
      const current = Math.hypot(dx, dy);
      if (current < distance) {
        distance = current;
        best = index;
      }
    }
    return best;
  }

  function savePoint(id) {
    const laneData = state.section.attributes[id];
    laneData.points.sort((a, b) => a.t - b.t);
    persist();
    drawLane(id);
    renderGuide();
    if (state.pendingLaneRender && !state.dragging) {
      state.pendingLaneRender = false;
      renderLanes();
    }
  }

  function showTip(id, event, point) {
    const ref = state.laneRefs[id];
    if (!ref || !ref.tip) return;
    const rect = ref.lane.getBoundingClientRect();
    const bar = Math.min(M.BARS, Math.floor(clamp(point.t, 0, 1) * M.BARS) + 1);
    ref.tip.textContent = `bar ${bar} · ${pct(point.v)}`;
    ref.tip.style.left = `${event.clientX - rect.left}px`;
    ref.tip.style.top = `${event.clientY - rect.top}px`;
    ref.tip.style.display = 'block';
  }

  function hideTip(id) {
    const ref = state.laneRefs[id];
    if (ref && ref.tip) ref.tip.style.display = 'none';
  }

  function bindLanePointer(svg, id) {
    svg.addEventListener('pointerdown', event => {
      let laneData = state.section.attributes[id];
      event.preventDefault();
      if (!laneData.specified) {
        M.toggleSpecified(state.section, id);
        persist();
        laneData = state.section.attributes[id];
        const ref = state.laneRefs[id];
        if (ref) {
          ref.lane.classList.remove('auto');
          ref.lane.classList.add('specified');
        }
        state.pendingLaneRender = true;
        setStatus(`${definition(id).label}: curve mode on. Drag to shape it.`);
      }
      const target = pointFromEvent(svg, event);
      target.t = snappedT(target.t);
      let index = findPoint(svg, laneData, target);
      const now = Date.now();
      if (index >= 0 && state.lastPointTap && state.lastPointTap.id === id && state.lastPointTap.index === index
        && now - state.lastPointTap.time < 360 && laneData.points.length > 2) {
        const removed = laneData.points.splice(index, 1)[0];
        state.undoPoint = { id, point: { ...removed } };
        if (els.undoPoint) els.undoPoint.hidden = false;
        state.lastPointTap = null;
        state.dragging = null;
        persist();
        drawLane(id);
        renderGuide();
        setStatus(`${definition(id).label}: removed point.`);
        return;
      }
      if (index < 0) {
        const point = { t: target.t, v: Math.round(target.v * 1000) / 1000 };
        laneData.points.push(point);
        laneData.points.sort((a, b) => a.t - b.t);
        index = laneData.points.indexOf(point);
        state.lastPointTap = null;
        persist();
      } else {
        state.lastPointTap = { id, index, time: now };
      }
      state.dragMoved = false;
      state.dragging = { id, index, pointerId: event.pointerId };
      try { svg.setPointerCapture(event.pointerId); } catch (error) {}
      drawLane(id);
      const current = laneData.points[index];
      if (current) showTip(id, event, current);
    });

    svg.addEventListener('pointermove', event => {
      if (!state.dragging || state.dragging.id !== id) return;
      event.preventDefault();
      const laneData = state.section.attributes[id];
      const point = laneData.points[state.dragging.index];
      if (!point) return;
      const target = pointFromEvent(svg, event);
      point.t = snappedT(target.t);
      point.v = Math.round(target.v * 1000) / 1000;
      state.dragMoved = true;
      drawLane(id);
      showTip(id, event, point);
    });

    const end = event => {
      if (!state.dragging || state.dragging.id !== id) return;
      const pointerId = state.dragging.pointerId;
      state.dragging = null;
      if (state.dragMoved) state.lastPointTap = null;
      hideTip(id);
      try { svg.releasePointerCapture(pointerId); } catch (error) {}
      savePoint(id);
      event.preventDefault();
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', () => { if (!state.dragging) hideTip(id); });

  }

  function renderFocus() {
    if (!els.focusChips) return;
    els.focusChips.textContent = '';
    const groups = [
      ['Levels', M.ATTRIBUTES.filter(attr => !attr.effects)],
      ['Effects', M.ATTRIBUTES.filter(attr => attr.effects)]
    ];
    for (const [label, attrs] of groups) {
      const group = document.createElement('div');
      group.className = 'focusgroup';
      const tag = document.createElement('span');
      tag.className = 'focusgroup-label';
      tag.textContent = label;
      group.appendChild(tag);
      for (const attr of attrs) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'focuschip' + (state.section.discovery.focus === attr.id ? ' on' : '');
        button.textContent = attr.label;
        button.style.setProperty('--attr-color', attr.color);
        button.setAttribute('aria-pressed', state.section.discovery.focus === attr.id ? 'true' : 'false');
        const disabled = M.isLocked(state.section, attr.id);
        button.disabled = disabled;
        button.title = disabled ? `${attr.label} is excluded from discovery` : `Explore ${attr.label.toLowerCase()} while the loop plays`;
        button.addEventListener('click', () => {
          if (!M.setFocus(state.section, attr.id)) return;
          persist();
          renderLanes();
          renderFocus();
          renderDiscovery();
          renderGuide();
          setStatus(`Discovery focus: ${attr.label}.`);
        });
        group.appendChild(button);
      }
      els.focusChips.appendChild(group);
    }
  }

  function renderDiscovery() {
    if (!state.section) return;
    const discovery = state.section.discovery;
    if (els.effectsLock) {
      els.effectsLock.classList.toggle('on', discovery.effects_locked);
      els.effectsLock.textContent = discovery.effects_locked ? 'Effects locked' : 'Lock effects';
      els.effectsLock.setAttribute('aria-pressed', discovery.effects_locked ? 'true' : 'false');
    }
    if (els.autoNext) els.autoNext.checked = !!discovery.auto_next;
    if (els.variationLabel) els.variationLabel.textContent = M.variationText(state.section);
    if (els.variationClock) {
      els.variationClock.textContent = state.playing ? 'looping' : 'ready';
    }
    if (els.likeStatus) {
      const count = discovery.likes.length;
      els.likeStatus.textContent = count ? `${count} liked loop${count === 1 ? '' : 's'} saved.` : 'No likes yet.';
    }
    if (els.playState) {
      els.playState.textContent = state.loading ? 'loading audio…' : state.playing ? 'section loop playing' : 'press start to listen';
    }
    els.playBtn.disabled = state.loading;
    els.playBtn.textContent = state.playing ? 'Restart loop' : 'Start loop';
    els.stopBtn.disabled = !state.playing && !state.loading;
    els.nextBtn.disabled = false;
    els.autoNext.disabled = false;
  }

  function renderGuide() {
    if (!state.section || !els.briefStats) return;
    const attrs = M.ATTRIBUTES;
    const specified = attrs.filter(attr => state.section.attributes[attr.id].specified).length;
    const locked = attrs.filter(attr => M.isLocked(state.section, attr.id)).length;
    const likes = state.section.discovery.likes.length;
    els.briefStats.textContent = '';
    for (const [label, value] of [['Curves', specified], ['AI decides', attrs.length - specified], ['Locked', locked], ['Likes', likes]]) {
      const box = document.createElement('div');
      box.className = 'stat';
      const b = document.createElement('b');
      b.textContent = String(value);
      const span = document.createElement('span');
      span.textContent = label;
      box.append(b, span);
      els.briefStats.appendChild(box);
    }
    els.briefList.textContent = '';
    for (const attr of attrs) {
      const lane = state.section.attributes[attr.id];
      const row = document.createElement('div');
      row.className = 'briefrow';
      const dot = document.createElement('i');
      dot.style.background = attr.color;
      const name = document.createElement('strong');
      name.textContent = attr.label;
      const tag = document.createElement('span');
      const effectiveLocked = M.isLocked(state.section, attr.id);
      tag.className = 'tag ' + (effectiveLocked ? 'locked' : lane.specified ? '' : 'auto');
      tag.textContent = effectiveLocked ? 'locked' : lane.specified ? 'curve' : 'AI decides';
      row.append(dot, name, tag);
      els.briefList.appendChild(row);
    }
    if (els.likeCount) els.likeCount.textContent = String(likes);
    if (els.likeStatus) {
      els.likeStatus.textContent = likes ? `${likes} liked loop${likes === 1 ? '' : 's'} saved.` : 'No likes yet.';
    }
    renderLikes();
  }

  function renderLikes() {
    if (!els.likesList) return;
    els.likesList.textContent = '';
    const likes = state.section.discovery.likes;
    if (!likes.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Liked loops will collect here with their curve snapshot.';
      els.likesList.appendChild(empty);
      return;
    }
    for (const like of likes.slice(-6).reverse()) {
      const row = document.createElement('div');
      row.className = 'like';
      const main = document.createElement('div');
      main.className = 'like-main';
      const title = document.createElement('b');
      const focus = M.ATTR_BY_ID[like.focus];
      const delta = Math.round((Number(like.offset) || 0) * 100);
      title.textContent = `${focus ? focus.label : like.focus} ${delta === 0 ? 'centered' : `${delta > 0 ? '+' : ''}${delta}%`}`;
      const detail = document.createElement('span');
      const sourceNames = (Array.isArray(like.sources) ? like.sources : []).map(source => source.label).filter(Boolean).join(' + ');
      detail.textContent = `${shortDate(like.timestamp)} · variation ${like.cycle || 0} · ${sourceNames}`;
      main.append(title, detail);
      const actions = document.createElement('span');
      actions.className = 'like-actions';
      const recall = makeControl('like-btn', 'Recall', () => recallLike(like.id));
      recall.setAttribute('aria-label', `Recall variation ${like.cycle || 0}`);
      const remove = makeControl('like-btn danger', 'Remove', () => deleteLike(like.id));
      remove.setAttribute('aria-label', `Remove variation ${like.cycle || 0}`);
      actions.append(recall, remove);
      row.append(main, actions);
      els.likesList.appendChild(row);
    }
  }

  function renderAll() {
    renderSourceOptions();
    renderLanes();
    renderFocus();
    renderDiscovery();
    renderGuide();
  }

  async function startLoop() {
    if (!state.section || !state.section.sources.length) {
      setStatus('Choose two sources before starting the loop.', true);
      return;
    }
    if (state.playing || state.loading) stopLoop();
    const token = ++state.playToken;
    state.loading = true;
    renderDiscovery();
    setTransport('Loading section…');
    if (els.playBtn) els.playBtn.disabled = true;
    try {
      const candidate = M.makeCandidate(state.section, 0);
      const result = await E.play(candidate, { loop: true, loopEnd: M.DURATION_SEC });
      if (token !== state.playToken) return;
      state.loopDur = result && result.loopEnd ? result.loopEnd : M.DURATION_SEC;
      state.loading = false;
      state.playing = true;
      state.lastLoopCycle = 0;
      state.playhead = 0;
      setTransport('Looping section · 8 bars');
      renderDiscovery();
      updatePlayheads(0);
      state.raf = requestAnimationFrame(tick);
    } catch (error) {
      if (token !== state.playToken) return;
      state.loading = false;
      state.playing = false;
      setTransport(error && error.message ? error.message : 'Could not start the loop.', true);
      renderDiscovery();
    }
  }

  function stopLoop() {
    state.playToken++;
    state.loading = false;
    state.playing = false;
    state.lastLoopCycle = 0;
    state.playhead = 0;
    cancelAnimationFrame(state.raf);
    E.stop();
    updatePlayheads(0);
    if (els.progressFill) els.progressFill.style.width = '0%';
    setTransport('loop stopped');
    renderDiscovery();
  }

  function tick() {
    if (!state.playing) return;
    const audio = E.getState();
    if (!audio.playing) {
      state.playing = false;
      setTransport('loop finished');
      renderDiscovery();
      return;
    }
    const loopDur = audio.loopEnd || state.loopDur || M.DURATION_SEC;
    const elapsed = Math.max(0, audio.elapsed);
    const position = (elapsed % loopDur) / loopDur;
    state.playhead = position;
    updatePlayheads(position);
    const layers = M.makeLayers(state.section, position);
    for (let index = 0; index < layers.length; index++) E.updateLayer(index, layers[index]);
    const loopCycle = Math.floor(elapsed / loopDur);
    if (loopCycle !== state.lastLoopCycle) {
      state.lastLoopCycle = loopCycle;
      if (state.section.discovery.auto_next) {
        M.nextVariation(state.section);
        persist();
        renderLanesSafe();
        renderFocus();
        renderDiscovery();
        renderGuide();
      }
    }
    if (els.progressFill) els.progressFill.style.width = `${Math.round(position * 100)}%`;
    if (els.variationClock) {
      const remaining = loopDur - (elapsed % loopDur);
      els.variationClock.textContent = state.section.discovery.auto_next ? `next in ${remaining.toFixed(1)}s` : `${shortTime(elapsed % loopDur)} · loop`;
    }
    state.raf = requestAnimationFrame(tick);
  }

  function likeLoop() {
    if (!state.section) return;
    const like = M.addLike(state.section);
    persist();
    renderGuide();
    renderLikes();
    renderDiscovery();
    setStatus(`Kept variation ${like.cycle}: ${M.variationText(state.section)}. Recall it from the liked list any time.`);
  }

  function recallLike(likeId) {
    if (state.playing || state.loading) stopLoop();
    const like = M.applyLike(state.section, likeId, state.byKey);
    if (!like) return;
    persist();
    renderAll();
    setStatus(`Recalled liked variation ${like.cycle}. Start the loop to listen.`);
  }

  function deleteLike(likeId) {
    if (!M.removeLike(state.section, likeId)) return;
    persist();
    renderGuide();
    setStatus('Removed the liked loop.');
  }

  function undoPointRemoval() {
    if (!state.undoPoint) return;
    const lane = state.section.attributes[state.undoPoint.id];
    if (lane) {
      lane.points.push({ ...state.undoPoint.point });
      lane.points.sort((a, b) => a.t - b.t);
      persist();
      drawLane(state.undoPoint.id);
      renderGuide();
      setStatus(`${definition(state.undoPoint.id).label}: point restored.`);
    }
    state.undoPoint = null;
    if (els.undoPoint) els.undoPoint.hidden = true;
  }

  function resetSection() {
    if (!window.confirm('Reset this section? Curves, locks, likes, and source choices will be cleared.')) return;
    if (state.playing || state.loading) stopLoop();
    try { localStorage.removeItem(M.STORAGE); } catch (error) {}
    state.section = M.createSection(state.byKey);
    state.undoPoint = null;
    if (els.undoPoint) els.undoPoint.hidden = true;
    persist();
    renderAll();
    setStatus('Section reset. Draw a curve or start listening.');
  }

  function nextVariation() {
    M.nextVariation(state.section);
    persist();
    renderLanes();
    renderDiscovery();
    renderGuide();
    setStatus(`New variation: ${M.variationText(state.section)}.`);
  }

  function toggleEffectsLock() {
    const previousFocus = state.section.discovery.focus;
    M.setEffectsLocked(state.section, !state.section.discovery.effects_locked);
    persist();
    renderLanes();
    renderFocus();
    renderDiscovery();
    renderGuide();
    const focus = state.section.discovery.focus;
    if (state.section.discovery.effects_locked) {
      setStatus(focus !== previousFocus
        ? `Effects locked. Discovery moved to ${definition(focus).label}.`
        : 'Effects locked for discovery.');
    } else {
      setStatus('Effects unlocked for discovery.');
    }
  }

  function setSource(index, key) {
    if (state.playing || state.loading) stopLoop();
    if (!M.setSource(state.section, index, key, state.byKey)) return;
    persist();
    renderSourceOptions();
    renderGuide();
    setStatus(`Layer ${index + 1} source changed. Start the loop to listen.`);
  }

  function exportGuide() {
    const brief = M.makeBrief(state.section);
    const blob = new Blob([JSON.stringify(brief, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `section-guide-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Exported the guide JSON. The final song will re-realise it.');
  }

  function addPoint(id, t, v) {
    const lane = state.section.attributes[id];
    if (!lane) return false;
    if (!lane.specified) {
      lane.specified = true;
      if (lane.points.length < 2) lane.points = M.DEFAULT_CURVES[id].map(point => ({ ...point }));
    }
    lane.points.push({ t: clamp(t, 0, 1), v: clamp(v, 0, 1) });
    lane.points.sort((a, b) => a.t - b.t);
    persist();
    renderLanes();
    renderGuide();
    return true;
  }

  function wireEvents() {
    els.playBtn.addEventListener('click', startLoop);
    els.stopBtn.addEventListener('click', stopLoop);
    els.sourceA.addEventListener('change', () => setSource(0, els.sourceA.value));
    els.sourceB.addEventListener('change', () => setSource(1, els.sourceB.value));
    els.effectsLock.addEventListener('click', toggleEffectsLock);
    els.autoNext.addEventListener('change', () => {
      M.setAutoNext(state.section, els.autoNext.checked);
      persist();
      renderDiscovery();
    });
    els.nextBtn.addEventListener('click', nextVariation);
    els.likeBtn.addEventListener('click', likeLoop);
    els.exportBtn.addEventListener('click', exportGuide);
    if (els.snapBars) {
      els.snapBars.addEventListener('change', () => {
        try { localStorage.setItem(SNAP_KEY, els.snapBars.checked ? '1' : '0'); } catch (error) {}
        setStatus(els.snapBars.checked ? 'Curve points snap to bar boundaries.' : 'Curve points are free-form.');
      });
    }
    if (els.undoPoint) els.undoPoint.addEventListener('click', undoPointRemoval);
    if (els.resetBtn) els.resetBtn.addEventListener('click', resetSection);
    window.addEventListener('beforeunload', () => E.stop());
  }

  function exposeApi() {
    window.SectionLab = {
      ready: false,
      getState: () => ({
        ready: state.ready,
        sources: state.sources.length,
        section: JSON.parse(JSON.stringify(state.section)),
        playing: E.getState(),
        playhead: state.playhead,
        lanes: document.querySelectorAll('.lane').length
      }),
      start: startLoop,
      stop: stopLoop,
      setFocus: id => {
        if (!M.setFocus(state.section, id)) return false;
        persist();
        renderLanes();
        renderFocus();
        renderDiscovery();
        renderGuide();
        return true;
      },
      toggleLock: id => {
        if (!M.toggleLock(state.section, id)) return false;
        persist();
        renderLanes();
        renderFocus();
        renderDiscovery();
        renderGuide();
        return true;
      },
      setEffectsLocked: locked => {
        M.setEffectsLocked(state.section, locked);
        persist();
        renderLanes();
        renderFocus();
        renderDiscovery();
        renderGuide();
        return true;
      },
      toggleSpecified: id => {
        if (!M.toggleSpecified(state.section, id)) return false;
        persist();
        renderLanes();
        renderFocus();
        renderGuide();
        return true;
      },
      addPoint,
      next: nextVariation,
      like: likeLoop,
      setAutoNext: auto => {
        M.setAutoNext(state.section, auto);
        persist();
        renderDiscovery();
      },
      setSource: (index, key) => {
        setSource(index, key);
        return true;
      },
      exportBrief: () => M.makeBrief(state.section)
    };
  }

  async function boot() {
    wireEvents();
    exposeApi();
    try {
      const library = await M.loadLibrary();
      state.sources = library.sources;
      state.byKey = library.byKey;
      state.section = M.loadSection(state.byKey);
      if (els.snapBars) {
        try { els.snapBars.checked = localStorage.getItem(SNAP_KEY) === '1'; } catch (error) {}
      }
      renderAll();
      state.ready = true;
      window.SectionLab.ready = true;
      setStatus(`Loaded ${state.sources.length} sources. Draw a curve or start listening.`);
      setTransport('loop stopped');
    } catch (error) {
      setStatus(`Could not load the section: ${error.message}`, true);
      setTransport('audio unavailable', true);
    }
  }

  boot();
})();
