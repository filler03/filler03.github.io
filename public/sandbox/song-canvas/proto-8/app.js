(() => {
  'use strict';

  const M = window.TasteModel;
  const E = window.TasteEngine;
  const $ = selector => document.querySelector(selector);
  const clone = value => JSON.parse(JSON.stringify(value));
  const pct = value => `${Math.round(Number(value) * 100)}%`;
  const clock = seconds => {
    const whole = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  };
  const shortDate = iso => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const els = {
    status: $('#status'),
    sourceCount: $('#sourceCount'),
    transportStatus: $('#transportStatus'),
    playDeck: $('#playDeck'),
    stopBtn: $('#stopBtn'),
    loopToggle: $('#loopToggle'),
    layers: $('#layers'),
    addLayer: $('#addLayer'),
    deckHint: $('#deckHint'),
    focusSel: $('#focusSel'),
    slotA: $('#slotA'),
    slotB: $('#slotB'),
    captureA: $('#captureA'),
    captureB: $('#captureB'),
    suggestB: $('#suggestB'),
    playA: $('#playA'),
    playB: $('#playB'),
    preferA: $('#preferA'),
    preferB: $('#preferB'),
    likeDeck: $('#likeDeck'),
    dislikeDeck: $('#dislikeDeck'),
    neutralDeck: $('#neutralDeck'),
    feedbackStatus: $('#feedbackStatus'),
    strength: $('#strength'),
    strengthVal: $('#strengthVal'),
    notes: $('#notes'),
    searchInput: $('#searchInput'),
    familyFilters: $('#familyFilters'),
    libraryGrid: $('#libraryGrid'),
    libraryStatus: $('#libraryStatus'),
    roleSel: $('#roleSel'),
    moodSel: $('#moodSel'),
    genreSel: $('#genreSel'),
    moodStrength: $('#moodStrength'),
    genreStrength: $('#genreStrength'),
    genreStrengthVal: $('#genreStrengthVal'),
    moodStrengthVal: $('#moodStrengthVal'),
    energy: $('#energy'),
    energyVal: $('#energyVal'),
    density: $('#density'),
    densityVal: $('#densityVal'),
    contextSummary: $('#contextSummary'),
    obsCount: $('#obsCount'),
    preferences: $('#preferences'),
    observations: $('#observations'),
    prefNote: $('#prefNote'),
    variantName: $('#variantName'),
    saveVariant: $('#saveVariant'),
    variantList: $('#variantList'),
    exportBtn: $('#exportBtn'),
    importBtn: $('#importBtn'),
    importFile: $('#importFile')
  };

  const state = {
    ready: false,
    sources: [],
    sourceMap: {},
    layers: [],
    activeLayer: 0,
    candidateA: null,
    candidateB: null,
    context: M.defaultContext(),
    observations: [],
    variants: [],
    derived: { global: [], contextual: [], observation_count: 0 },
    loop: false,
    filterFamily: 'all',
    search: '',
    loading: false,
    playToken: 0,
    playingKind: null,
    transportError: false
  };

  function setStatus(message, error) {
    if (!els.status) return;
    els.status.textContent = message;
    els.status.classList.toggle('error', !!error);
  }

  function setTransport(message, error = false) {
    state.transportError = !!error;
    if (els.transportStatus) els.transportStatus.textContent = message;
  }

  function updateTransport() {
    const audio = E.getState();
    if (audio.playing) {
      setTransport(`${audio.label} · ${clock(audio.elapsed)}${audio.loop ? ' · loop' : ''}`);
    } else if (!state.loading) {
      state.playingKind = null;
      if (!state.transportError) setTransport('audio idle');
    }
  }

  function stopPlayback(message) {
    state.playToken++;
    state.loading = false;
    state.playingKind = null;
    E.stop();
    if (message) setTransport(message);
  }

  function stopForDeckChange() {
    if (state.playingKind || state.loading || E.getState().playing) {
      stopPlayback('stopped · deck changed');
    }
  }

  function setFeedback(message) {
    if (els.feedbackStatus) els.feedbackStatus.textContent = message;
  }

  function updateCounts() {
    if (els.sourceCount) els.sourceCount.textContent = `${state.sources.length} source${state.sources.length === 1 ? '' : 's'}`;
    if (els.obsCount) {
      const count = state.observations.length;
      els.obsCount.textContent = `${count} observation${count === 1 ? '' : 's'}`;
    }
  }

  function hzToSlider(hz) {
    const min = 80;
    const max = 16000;
    const value = Math.min(max, Math.max(min, Number(hz) || min));
    return Math.round((Math.log(value / min) / Math.log(max / min)) * 1000);
  }

  function sliderToHz(value) {
    const min = 80;
    const max = 16000;
    return Math.round(min * Math.pow(max / min, Math.min(1000, Math.max(0, Number(value) || 0)) / 1000));
  }

  function sourceMeta(layer) {
    return state.sourceMap[layer.source_key] || {
      family_label: 'Other',
      tags: [],
      roles: []
    };
  }

  function renderContextOptions() {
    els.roleSel.textContent = '';
    for (const role of M.ROLES) {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = role.charAt(0).toUpperCase() + role.slice(1);
      els.roleSel.appendChild(option);
    }
    els.moodSel.textContent = '';
    for (const mood of M.MOODS) {
      const option = document.createElement('option');
      option.value = mood;
      option.textContent = mood.charAt(0).toUpperCase() + mood.slice(1);
      els.moodSel.appendChild(option);
    }
    els.genreSel.textContent = '';
    for (const genre of M.GENRES) {
      const option = document.createElement('option');
      option.value = genre;
      option.textContent = genre.charAt(0).toUpperCase() + genre.slice(1);
      els.genreSel.appendChild(option);
    }
  }

  function syncContextControls() {
    const context = state.context;
    els.roleSel.value = context.section_role;
    els.moodSel.value = context.mood;
    els.genreSel.value = context.genre;
    els.moodStrength.value = context.mood_strength;
    els.genreStrength.value = context.genre_strength;
    els.energy.value = context.energy;
    els.density.value = context.density;
    els.moodStrengthVal.textContent = pct(context.mood_strength);
    els.genreStrengthVal.textContent = pct(context.genre_strength);
    els.energyVal.textContent = pct(context.energy);
    els.densityVal.textContent = pct(context.density);
    els.contextSummary.textContent = `${context.section_role} · ${context.mood} · ${context.genre} · energy ${pct(context.energy)} · density ${pct(context.density)}`;
  }

  function readContextControls(save = true) {
    const context = M.normalizeContext({
      ...state.context,
      section_role: els.roleSel.value,
      mood: els.moodSel.value,
      genre: els.genreSel.value,
      mood_strength: Number(els.moodStrength.value),
      genre_strength: Number(els.genreStrength.value),
      energy: Number(els.energy.value),
      density: Number(els.density.value)
    });
    state.context = save ? M.saveContext(context) : context;
    els.moodStrengthVal.textContent = pct(state.context.mood_strength);
    els.genreStrengthVal.textContent = pct(state.context.genre_strength);
    els.energyVal.textContent = pct(state.context.energy);
    els.densityVal.textContent = pct(state.context.density);
    els.contextSummary.textContent = `${state.context.section_role} · ${state.context.mood} · ${state.context.genre} · energy ${pct(state.context.energy)} · density ${pct(state.context.density)}`;
    return state.context;
  }

  function addRange(container, index, field, label, min, max, step, value, display) {
    const wrap = document.createElement('label');
    wrap.className = 'control';
    const top = document.createElement('span');
    top.className = 'control-top';
    const title = document.createElement('span');
    title.textContent = label;
    const output = document.createElement('output');
    output.textContent = display(value);
    top.append(title, output);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.dataset.layer = String(index);
    input.dataset.field = field;
    input.setAttribute('aria-label', `Layer ${index + 1} ${label}`);
    wrap.append(top, input);
    container.appendChild(wrap);
  }

  function addSelect(container, index, field, label, options, value) {
    const wrap = document.createElement('label');
    wrap.className = 'control';
    const title = document.createElement('span');
    title.textContent = label;
    const select = document.createElement('select');
    select.dataset.layer = String(index);
    select.dataset.field = field;
    for (const optionValue of options) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionValue.charAt(0).toUpperCase() + optionValue.slice(1);
      select.appendChild(option);
    }
    select.value = value;
    wrap.append(title, select);
    container.appendChild(wrap);
  }

  function renderLayers() {
    if (!els.layers) return;
    els.layers.textContent = '';
    state.layers.forEach((layer, index) => {
      const meta = sourceMeta(layer);
      const filter = M.getProcessor(layer, 'filter') || { mode: 'lowpass', cutoff_hz: 9000, resonance: 0.7 };
      const drive = M.getProcessor(layer, 'drive') || { amount: 0 };
      const delay = M.getProcessor(layer, 'delay') || { time_sec: 0.32, feedback: 0.2, mix: 0 };
      const reverb = M.getProcessor(layer, 'reverb') || { mix: 0.12 };
      const pan = M.getProcessor(layer, 'pan') || { value: 0 };

      const card = document.createElement('article');
      card.className = 'layer-card' + (index === state.activeLayer ? ' active' : '');
      card.dataset.layer = String(index);
      card.tabIndex = 0;
      card.setAttribute('aria-label', `Layer ${index + 1}: ${layer.source_label}. Press Enter to target this layer.`);

      const head = document.createElement('div');
      head.className = 'layer-head';
      const layerIndex = document.createElement('span');
      layerIndex.className = 'layer-index';
      layerIndex.textContent = `Layer ${index + 1}`;
      const source = document.createElement('div');
      source.className = 'layer-source';
      const strong = document.createElement('strong');
      strong.textContent = layer.source_label || 'Choose a source';
      const detail = document.createElement('span');
      const tags = meta.tags && meta.tags.length ? ` · ${meta.tags.slice(0, 2).join(' · ')}` : '';
      detail.textContent = `${meta.family_label || 'Other'}${tags}`;
      source.append(strong, detail);
      head.append(layerIndex, source);
      if (state.layers.length > 1) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-layer';
        remove.textContent = 'Remove';
        remove.addEventListener('click', event => {
          event.stopPropagation();
          stopForDeckChange();
          state.layers.splice(index, 1);
          state.activeLayer = Math.min(state.activeLayer, state.layers.length - 1);
          renderLayers();
          renderLibrary();
          setFeedback(`Layer removed. ${state.layers.length} layer${state.layers.length === 1 ? '' : 's'} active.`);
        });
        head.appendChild(remove);
      }
      card.appendChild(head);

      const controls = document.createElement('div');
      controls.className = 'controls';
      addRange(controls, index, 'level', 'Level', 0, 1, 0.01, layer.level, value => pct(value));
      addSelect(controls, index, 'filter_mode', 'Filter', ['lowpass', 'highpass', 'bandpass'], filter.mode);
      addRange(controls, index, 'filter_cutoff', 'Cutoff', 0, 1000, 1, hzToSlider(filter.cutoff_hz), value => M.formatHz(sliderToHz(value)));
      addRange(controls, index, 'filter_resonance', 'Resonance', 0.1, 6, 0.1, filter.resonance, value => Number(value).toFixed(1));
      addRange(controls, index, 'drive_amount', 'Drive', 0, 0.55, 0.01, drive.amount, value => pct(value));
      addRange(controls, index, 'delay_mix', 'Echo mix', 0, 0.6, 0.01, delay.mix, value => pct(value));
      addRange(controls, index, 'delay_time', 'Echo time', 0.08, 1, 0.01, delay.time_sec, value => `${Number(value).toFixed(2)} s`);
      addRange(controls, index, 'delay_feedback', 'Echo feedback', 0, 0.7, 0.01, delay.feedback, value => pct(value));
      addRange(controls, index, 'reverb_mix', 'Space', 0, 0.65, 0.01, reverb.mix, value => pct(value));
      addRange(controls, index, 'pan', 'Pan', -1, 1, 0.01, pan.value, value => {
        const number = Number(value);
        return number === 0 ? 'center' : number < 0 ? `L ${Math.round(-number * 100)}` : `R ${Math.round(number * 100)}`;
      });
      card.appendChild(controls);

      function selectLayer() {
        if (state.activeLayer === index) return;
        state.activeLayer = index;
        renderLayers();
        renderLibrary();
        setFeedback(`Layer ${index + 1} is the target for source cards.`);
      }
      card.addEventListener('click', event => {
        if (event.target.closest('input, select, button, label, option, output')) return;
        selectLayer();
      });
      card.addEventListener('keydown', event => {
        if (event.target !== card) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectLayer();
        }
      });
      els.layers.appendChild(card);
    });

    if (els.addLayer) {
      els.addLayer.disabled = state.layers.length >= 2;
      els.addLayer.textContent = state.layers.length >= 2 ? 'Second layer active' : '+ Add a second layer';
    }
    if (els.deckHint) {
      els.deckHint.textContent = `Layer ${state.activeLayer + 1} is the library target. Click a source card to load it.`;
    }
    updateFeedbackButtons();
  }

  function applyLayerField(index, field, rawValue) {
    const layer = state.layers[index];
    if (!layer) return;
    const value = Number(rawValue);
    if (field === 'level') {
      layer.level = Math.min(1, Math.max(0, value));
    } else if (field === 'filter_mode') {
      M.setProcessor(layer, 'filter', { ...M.getProcessor(layer, 'filter'), mode: rawValue });
    } else if (field === 'filter_cutoff') {
      M.setProcessor(layer, 'filter', { ...M.getProcessor(layer, 'filter'), cutoff_hz: sliderToHz(value) });
    } else if (field === 'filter_resonance') {
      M.setProcessor(layer, 'filter', { ...M.getProcessor(layer, 'filter'), resonance: value });
    } else if (field === 'drive_amount') {
      M.setProcessor(layer, 'drive', { ...M.getProcessor(layer, 'drive'), amount: value });
    } else if (field === 'delay_mix') {
      M.setProcessor(layer, 'delay', { ...M.getProcessor(layer, 'delay'), mix: value });
    } else if (field === 'delay_time') {
      M.setProcessor(layer, 'delay', { ...M.getProcessor(layer, 'delay'), time_sec: value });
    } else if (field === 'delay_feedback') {
      M.setProcessor(layer, 'delay', { ...M.getProcessor(layer, 'delay'), feedback: value });
    } else if (field === 'reverb_mix') {
      M.setProcessor(layer, 'reverb', { ...M.getProcessor(layer, 'reverb'), mix: value });
    } else if (field === 'pan') {
      M.setProcessor(layer, 'pan', { ...M.getProcessor(layer, 'pan'), value });
    }
  }

  function onLayerInput(event) {
    const input = event.target.closest('input[data-field], select[data-field]');
    if (!input) return;
    const index = Number(input.dataset.layer);
    if (!Number.isInteger(index) || !state.layers[index]) return;
    applyLayerField(index, input.dataset.field, input.value);
    state.activeLayer = index;
    const control = input.closest('.control');
    const output = control ? control.querySelector('output') : null;
    if (output) {
      const filter = M.getProcessor(state.layers[index], 'filter');
      const drive = M.getProcessor(state.layers[index], 'drive');
      const delay = M.getProcessor(state.layers[index], 'delay');
      const reverb = M.getProcessor(state.layers[index], 'reverb');
      const pan = M.getProcessor(state.layers[index], 'pan');
      switch (input.dataset.field) {
        case 'level': output.textContent = pct(state.layers[index].level); break;
        case 'filter_cutoff': output.textContent = M.formatHz(filter.cutoff_hz); break;
        case 'filter_resonance': output.textContent = Number(filter.resonance).toFixed(1); break;
        case 'drive_amount': output.textContent = pct(drive.amount); break;
        case 'delay_mix': output.textContent = pct(delay.mix); break;
        case 'delay_time': output.textContent = `${Number(delay.time_sec).toFixed(2)} s`; break;
        case 'delay_feedback': output.textContent = pct(delay.feedback); break;
        case 'reverb_mix': output.textContent = pct(reverb.mix); break;
        case 'pan': output.textContent = pan.value === 0 ? 'center' : pan.value < 0 ? `L ${Math.round(-pan.value * 100)}` : `R ${Math.round(pan.value * 100)}`; break;
      }
    }
    if (state.playingKind === 'deck' && E.getState().playing) {
      E.updateLayer(index, state.layers[index]);
    } else if (state.playingKind) {
      stopPlayback('stopped · deck changed');
    }
    document.querySelectorAll('.layer-card').forEach(card => {
      card.classList.toggle('active', Number(card.dataset.layer) === state.activeLayer);
    });
    const activeSource = state.layers[state.activeLayer] ? state.layers[state.activeLayer].source_key : null;
    document.querySelectorAll('.source-card').forEach(card => {
      const uses = card.querySelector('.source-use');
      if (uses) uses.textContent = card.dataset.key === activeSource ? `In layer ${state.activeLayer + 1}` : `Use layer ${state.activeLayer + 1}`;
      card.classList.toggle('active-source', card.dataset.key === activeSource);
    });
  }

  function assignSource(source, requestedIndex) {
    if (!source) return;
    stopForDeckChange();
    const index = Number.isInteger(requestedIndex) ? requestedIndex : state.activeLayer;
    if (!state.layers[index]) {
      state.layers[index] = M.createLayer(source, index);
    } else {
      const layer = state.layers[index];
      layer.source_id = source.id;
      layer.source_key = source.key;
      layer.source_label = source.label;
      layer.source_url = source.url;
    }
    state.activeLayer = index;
    renderLayers();
    renderLibrary();
    setFeedback(`${source.label} loaded into layer ${index + 1}.`);
  }

  function renderFamilyFilters() {
    if (!els.familyFilters) return;
    const counts = new Map();
    for (const source of state.sources) {
      counts.set(source.family, (counts.get(source.family) || 0) + 1);
    }
    const entries = [...counts.entries()].sort((a, b) => {
      const labelA = (state.sources.find(source => source.family === a[0]) || {}).family_label || a[0];
      const labelB = (state.sources.find(source => source.family === b[0]) || {}).family_label || b[0];
      return labelA.localeCompare(labelB);
    });
    els.familyFilters.textContent = '';
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip' + (state.filterFamily === 'all' ? ' on' : '');
    all.textContent = `All ${state.sources.length}`;
    all.addEventListener('click', () => {
      state.filterFamily = 'all';
      renderLibrary();
    });
    els.familyFilters.appendChild(all);
    for (const [family, count] of entries) {
      const source = state.sources.find(item => item.family === family);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip' + (state.filterFamily === family ? ' on' : '');
      button.textContent = `${source ? source.family_label : family} ${count}`;
      button.addEventListener('click', () => {
        state.filterFamily = family;
        renderLibrary();
      });
      els.familyFilters.appendChild(button);
    }
  }

  function matchesFilter(source) {
    if (state.filterFamily !== 'all' && source.family !== state.filterFamily) return false;
    const query = state.search.trim().toLowerCase();
    if (!query) return true;
    return [source.label, source.key, source.family_label, source.source, ...(source.tags || [])]
      .join(' ')
      .toLowerCase()
      .includes(query);
  }

  function renderLibrary() {
    if (!els.libraryGrid) return;
    renderFamilyFilters();
    els.libraryGrid.textContent = '';
    const activeLayer = state.layers[state.activeLayer];
    const items = state.sources.filter(matchesFilter);
    const activeKey = activeLayer ? activeLayer.source_key : null;
    const usedKeys = new Set(state.layers.map(layer => layer.source_key));
    for (const source of items) {
      const card = document.createElement('article');
      card.className = 'source-card'
        + (usedKeys.has(source.key) ? ' in-use' : '')
        + (source.key === activeKey ? ' active-source' : '');
      card.dataset.key = source.key;
      const strong = document.createElement('strong');
      strong.textContent = source.label;
      const family = document.createElement('span');
      family.className = 'source-family';
      family.textContent = source.family_label;
      const blurb = document.createElement('span');
      blurb.className = 'source-blurb';
      blurb.textContent = source.blurb || source.source;
      const tags = document.createElement('span');
      tags.className = 'source-tags';
      for (const tag of (source.tags || []).slice(0, 3)) {
        const label = document.createElement('span');
        label.className = 'source-tag';
        label.textContent = tag;
        tags.appendChild(label);
      }
      const actions = document.createElement('span');
      actions.className = 'source-actions';
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'preview-btn';
      preview.textContent = 'Audition';
      preview.addEventListener('click', event => {
        event.stopPropagation();
        auditionSource(source);
      });
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'source-use';
      use.textContent = source.key === activeKey ? `In layer ${state.activeLayer + 1}` : `Use layer ${state.activeLayer + 1}`;
      use.addEventListener('click', event => {
        event.stopPropagation();
        assignSource(source, state.activeLayer);
      });
      actions.append(preview, use);
      card.append(strong, family, blurb, tags, actions);
      card.addEventListener('click', () => assignSource(source, state.activeLayer));
      els.libraryGrid.appendChild(card);
    }
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No sources match this search.';
      els.libraryGrid.appendChild(empty);
    }
    if (els.libraryStatus) {
      els.libraryStatus.textContent = `${items.length} of ${state.sources.length} sources · target layer ${state.activeLayer + 1}${state.search ? ` · “${state.search}”` : ''}`;
    }
  }

  function auditionSource(source) {
    const candidate = M.captureCandidate([M.createLayer(source, 0)], `Preview · ${source.label}`, state.sourceMap);
    playCandidate(candidate, `Preview · ${source.label}`, 'preview');
    setFeedback(`Auditioning ${source.label}.`);
  }

  async function playCandidate(candidate, label, kind = 'deck') {
    const token = ++state.playToken;
    state.loading = true;
    state.playingKind = kind;
    setTransport(`Loading ${label}…`);
    try {
      await E.play(candidate, { loop: state.loop });
      if (token !== state.playToken) return;
      state.loading = false;
      setTransport(`Playing ${label} · ${state.loop ? 'loop' : clock(0)}`);
    } catch (error) {
      if (token !== state.playToken) return;
      state.loading = false;
      state.playingKind = null;
      setTransport(error && error.message ? error.message : 'Could not play audio.', true);
    }
  }

  function renderSlot(container, candidate, letter) {
    if (!container) return;
    container.textContent = '';
    const letterNode = document.createElement('span');
    letterNode.className = 'slotletter';
    letterNode.textContent = letter;
    container.appendChild(letterNode);
    if (!candidate) {
      const empty = document.createElement('p');
      empty.className = 'slotempty';
      empty.textContent = 'Not captured yet.';
      container.appendChild(empty);
      return;
    }
    const name = document.createElement('div');
    name.className = 'slotname';
    name.textContent = M.describeCandidate(candidate);
    const meta = document.createElement('div');
    meta.className = 'slotmeta';
    meta.textContent = [candidate.change ? candidate.change.summary : candidate.label, shortDate(candidate.created_at)]
      .filter(Boolean)
      .join(' · ');
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'mini slotuse';
    use.textContent = 'Use this deck';
    use.addEventListener('click', () => {
      stopForDeckChange();
      const loaded = M.captureCandidate(candidate.layers, candidate.label, state.sourceMap);
      state.layers = loaded.layers;
      state.activeLayer = 0;
      renderLayers();
      renderLibrary();
      setFeedback(`Loaded ${letter} into the deck.`);
    });
    container.append(name, meta, use);
  }

  function renderAB() {
    renderSlot(els.slotA, state.candidateA, 'A');
    renderSlot(els.slotB, state.candidateB, 'B');
    els.playA.disabled = !state.candidateA;
    els.playB.disabled = !state.candidateB;
    updateFeedbackButtons();
  }

  function updateFeedbackButtons() {
    const both = !!(state.candidateA && state.candidateB);
    if (els.preferA) els.preferA.disabled = !both;
    if (els.preferB) els.preferB.disabled = !both;
    if (els.likeDeck) els.likeDeck.disabled = !state.layers.length;
    if (els.dislikeDeck) els.dislikeDeck.disabled = !state.layers.length;
    if (els.neutralDeck) els.neutralDeck.disabled = !state.layers.length;
  }

  function captureDeck(label) {
    try {
      return M.captureCandidate(state.layers, label, state.sourceMap);
    } catch (error) {
      setFeedback(error.message || 'Could not capture the deck.');
      return null;
    }
  }

  function captureA() {
    const candidate = captureDeck('A');
    if (!candidate) return null;
    state.candidateA = candidate;
    renderAB();
    setFeedback('Captured A. Change the deck, then capture B or suggest one.');
    return candidate;
  }

  function captureB() {
    const candidate = captureDeck('B');
    if (!candidate) return null;
    state.candidateB = candidate;
    renderAB();
    setFeedback('Captured B.');
    return candidate;
  }

  function suggestB() {
    if (!state.candidateA) {
      state.candidateA = captureDeck('A');
      if (!state.candidateA) return null;
      setFeedback('Captured the deck as A. Generating a controlled B…');
    }
    try {
      state.candidateB = M.mutateCandidate(state.candidateA, els.focusSel.value, state.sources);
      renderAB();
      setFeedback(`B suggestion: ${state.candidateB.change.summary}. Audition both to compare.`);
      return state.candidateB;
    } catch (error) {
      setFeedback(error.message || 'Could not suggest a B candidate.');
      return null;
    }
  }

  function useSlotCandidate(candidate, letter) {
    if (!candidate) return;
    state.layers = M.captureCandidate(candidate.layers, candidate.label, state.sourceMap).layers;
    state.activeLayer = 0;
    renderLayers();
    renderLibrary();
    setFeedback(`Loaded ${letter} into the deck.`);
  }

  function recordFeedback(action) {
    let candidateA;
    let candidateB = null;
    if (action === 'prefer_a' || action === 'prefer_b') {
      if (!state.candidateA || !state.candidateB) {
        setFeedback('Capture both A and B before choosing between them.');
        return null;
      }
      candidateA = state.candidateA;
      candidateB = state.candidateB;
    } else {
      candidateA = captureDeck('Deck');
      if (!candidateA) return null;
    }
    try {
      const context = readContextControls(true);
      const observation = M.makeObservation({
        action,
        strength: Number(els.strength.value),
        candidateA,
        candidateB,
        context,
        notes: els.notes.value
      }, state.sourceMap);
      M.appendObservation(observation);
      state.observations = M.loadObservations();
      state.derived = M.derivePreferences(state.observations, state.sourceMap);
      els.notes.value = '';
      renderEvidence();
      setFeedback(`Saved ${actionLabel(action)} observation with its context.`);
      return observation;
    } catch (error) {
      setFeedback(error.message || 'Could not save that observation.');
      return null;
    }
  }

  function actionLabel(action) {
    return {
      prefer_a: 'prefer A',
      prefer_b: 'prefer B',
      like: 'like',
      dislike: 'dislike',
      neutral: 'neutral'
    }[action] || action;
  }

  function renderEvidence() {
    if (!els.preferences || !els.observations) return;
    updateCounts();
    els.preferences.textContent = '';
    els.observations.textContent = '';
    const rules = [...state.derived.global.slice(0, 6), ...state.derived.contextual.slice(0, 6)];
    if (!rules.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No preference rules yet. Capture a reaction and the evidence will appear here.';
      els.preferences.appendChild(empty);
    } else {
      for (const rule of rules) {
        const article = document.createElement('article');
        article.className = 'rule';
        const head = document.createElement('div');
        head.className = 'rulehead';
        const name = document.createElement('strong');
        name.textContent = rule.target.label || rule.target.key;
        const scope = document.createElement('span');
        scope.textContent = rule.scope === 'global' ? 'global' : 'context';
        head.append(name, scope);
        const context = document.createElement('div');
        context.className = 'rulecontext';
        context.textContent = rule.conditions
          ? [rule.conditions.section_role, rule.conditions.mood, rule.conditions.genre, rule.conditions.energy_band ? `${rule.conditions.energy_band} energy` : '', rule.conditions.density_band ? `${rule.conditions.density_band} density` : '']
            .filter(Boolean)
            .join(' · ')
          : 'across all recorded contexts';
        const bar = document.createElement('div');
        bar.className = 'rulebar';
        const fill = document.createElement('i');
        fill.style.width = `${Math.round(rule.preference_score * 100)}%`;
        bar.appendChild(fill);
        const meter = document.createElement('div');
        meter.className = 'rulemeter';
        const fit = document.createElement('span');
        fit.textContent = `fit ${pct(rule.preference_score)}`;
        const confidence = document.createElement('span');
        confidence.textContent = `confidence ${pct(rule.confidence)} · support ${rule.support}`;
        meter.append(fit, confidence);
        const detail = document.createElement('p');
        detail.textContent = `positive ${rule.positive.toFixed(1)} · negative ${rule.negative.toFixed(1)} · ${rule.source_observation_ids.length} recent example${rule.source_observation_ids.length === 1 ? '' : 's'}`;
        article.append(head, context, bar, meter, detail);
        els.preferences.appendChild(article);
      }
    }

    const recent = state.observations.slice(-6).reverse();
    if (!recent.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No observations yet.';
      els.observations.appendChild(empty);
    } else {
      for (const observation of recent) {
        const row = document.createElement('div');
        row.className = 'obs';
        const line = document.createElement('span');
        line.className = 'obsaction';
        line.textContent = actionLabel(observation.action);
        const detail = document.createElement('span');
        detail.textContent = ` · ${M.describeCandidate(observation.candidateA)}`;
        const ctx = document.createElement('span');
        ctx.className = 'obsctx';
        ctx.textContent = `${observation.context.section_role} · ${observation.context.mood} · energy ${pct(observation.context.energy)} · density ${pct(observation.context.density)} · ${shortDate(observation.timestamp)}`;
        row.append(line, detail, ctx);
        els.observations.appendChild(row);
      }
    }
    els.prefNote.textContent = state.observations.length
      ? 'Summary rules are derived from the observations above. Raw observations are not rewritten.'
      : 'Raw observations will stay the source of truth; summaries are only a cache.';
  }

  function saveCurrentVariant() {
    try {
      const name = els.variantName.value.trim() || `Variant ${state.variants.length + 1}`;
      const candidate = M.captureCandidate(state.layers, name, state.sourceMap);
      const variant = {
        ...candidate,
        name,
        saved_at: new Date().toISOString()
      };
      M.saveVariant(variant);
      state.variants = M.loadVariants();
      els.variantName.value = '';
      renderVariants();
      setFeedback(`Saved “${name}”.`);
    } catch (error) {
      setFeedback(error.message || 'Could not save this variant.');
    }
  }

  function renderVariants() {
    if (!els.variantList) return;
    els.variantList.textContent = '';
    if (!state.variants.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No saved variants yet.';
      els.variantList.appendChild(empty);
      return;
    }
    for (const variant of state.variants) {
      const row = document.createElement('div');
      row.className = 'variant';
      const name = document.createElement('strong');
      name.textContent = variant.name || variant.label || 'Variant';
      const meta = document.createElement('span');
      meta.textContent = M.describeCandidate(variant);
      const load = document.createElement('button');
      load.type = 'button';
      load.textContent = 'Load';
      load.addEventListener('click', () => {
        stopForDeckChange();
        const candidate = M.captureCandidate(variant.layers, variant.name || variant.label || 'Variant', state.sourceMap);
        state.layers = candidate.layers;
        state.activeLayer = 0;
        renderLayers();
        renderLibrary();
        setFeedback(`Loaded “${name.textContent}” into the deck.`);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => {
        if (!window.confirm(`Delete the variant “${name.textContent}”?`)) return;
        M.deleteVariant(variant.id);
        state.variants = M.loadVariants();
        renderVariants();
        setFeedback('Variant deleted.');
      });
      row.append(name, meta, load, remove);
      els.variantList.appendChild(row);
    }
  }

  function exportProject() {
    const project = M.exportProject({ loop: state.loop });
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `taste-studio-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedback('Exported observations, variants, context, and settings.');
  }

  function importProjectFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        stopForDeckChange();
        const result = M.importProject(JSON.parse(String(reader.result || '')));
        state.observations = M.loadObservations();
        state.variants = M.loadVariants();
        state.context = M.loadContext();
        state.loop = M.loadSettings().loop;
        els.loopToggle.checked = state.loop;
        state.derived = M.derivePreferences(state.observations, state.sourceMap);
        syncContextControls();
        renderAll();
        setFeedback(`Imported ${result.importedObservations} observations and ${result.importedVariants} variants.`);
      } catch (error) {
        setFeedback(error.message || 'Could not import that JSON file.');
      }
    };
    reader.onerror = () => setFeedback('Could not read that file.');
    reader.readAsText(file);
  }

  function addLayer() {
    if (state.layers.length >= 2) return;
    stopForDeckChange();
    const used = new Set(state.layers.map(layer => layer.source_key));
    const source = state.sources.find(item => item.key === 'texture' && !used.has(item.key))
      || state.sources.find(item => !used.has(item.key))
      || state.sources[0];
    if (!source) return;
    state.layers.push(M.createLayer(source, 1));
    state.activeLayer = 1;
    renderLayers();
    renderLibrary();
    setFeedback(`${source.label} added as layer 2.`);
  }

  function renderAll() {
    renderLayers();
    renderLibrary();
    renderAB();
    renderEvidence();
    renderVariants();
    syncContextControls();
    updateCounts();
  }

  function wireEvents() {
    els.playDeck.addEventListener('click', () => {
      const candidate = captureDeck('Deck');
      if (candidate) playCandidate(candidate, 'Deck', 'deck');
    });
    els.stopBtn.addEventListener('click', () => stopPlayback('audio idle'));
    els.loopToggle.addEventListener('change', () => {
      state.loop = !!els.loopToggle.checked;
      M.saveSettings({ loop: state.loop });
      setTransport(state.loop ? 'Loop armed for the next play' : 'audio idle');
    });
    els.addLayer.addEventListener('click', addLayer);
    els.layers.addEventListener('input', onLayerInput);
    els.layers.addEventListener('change', onLayerInput);
    els.captureA.addEventListener('click', captureA);
    els.captureB.addEventListener('click', captureB);
    els.suggestB.addEventListener('click', suggestB);
    els.playA.addEventListener('click', () => {
      if (state.candidateA) playCandidate(state.candidateA, 'A', 'a');
    });
    els.playB.addEventListener('click', () => {
      if (state.candidateB) playCandidate(state.candidateB, 'B', 'b');
    });
    els.preferA.addEventListener('click', () => recordFeedback('prefer_a'));
    els.preferB.addEventListener('click', () => recordFeedback('prefer_b'));
    els.likeDeck.addEventListener('click', () => recordFeedback('like'));
    els.dislikeDeck.addEventListener('click', () => recordFeedback('dislike'));
    els.neutralDeck.addEventListener('click', () => recordFeedback('neutral'));
    els.strength.addEventListener('input', () => {
      els.strengthVal.textContent = pct(els.strength.value);
    });
    els.roleSel.addEventListener('change', () => readContextControls(true));
    els.moodSel.addEventListener('change', () => readContextControls(true));
    els.genreSel.addEventListener('change', () => readContextControls(true));
    for (const input of [els.moodStrength, els.genreStrength, els.energy, els.density]) {
      input.addEventListener('input', () => readContextControls(true));
    }
    els.searchInput.addEventListener('input', () => {
      state.search = els.searchInput.value;
      renderLibrary();
    });
    els.saveVariant.addEventListener('click', saveCurrentVariant);
    els.exportBtn.addEventListener('click', exportProject);
    els.importBtn.addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', () => {
      const file = els.importFile.files && els.importFile.files[0];
      els.importFile.value = '';
      importProjectFile(file);
    });
  }

  function exposeTestApi() {
    window.TasteLab = {
      ready: false,
      getState: () => ({
        ready: state.ready,
        sources: state.sources.length,
        layers: clone(state.layers),
        activeLayer: state.activeLayer,
        candidateA: clone(state.candidateA),
        candidateB: clone(state.candidateB),
        context: clone(state.context),
        observations: state.observations.length,
        variants: state.variants.length,
        derived: clone(state.derived),
        playing: E.getState()
      }),
      selectSource: (key, layerIndex = 0) => {
        const source = state.sources.find(item => item.key === key);
        if (!source) throw new Error(`Unknown source: ${key}`);
        if (layerIndex !== 0 && layerIndex !== 1) throw new Error('v0.1 supports layers 0 and 1 only.');
        if (!state.layers[layerIndex]) state.layers[layerIndex] = M.createLayer(source, layerIndex);
        assignSource(source, layerIndex);
        return clone(state.layers[layerIndex]);
      },
      setLayer: (index, field, value) => {
        applyLayerField(index, field, value);
        if (state.playingKind === 'deck' && E.getState().playing) E.updateLayer(index, state.layers[index]);
        renderLayers();
        renderLibrary();
        return clone(state.layers[index]);
      },
      captureA,
      captureB,
      suggestB,
      record: action => recordFeedback(action),
      play: slot => playCandidate(slot === 'b' ? state.candidateB : slot === 'a' ? state.candidateA : captureDeck('Deck'), slot === 'b' ? 'B' : slot === 'a' ? 'A' : 'Deck', slot === 'b' ? 'b' : slot === 'a' ? 'a' : 'deck'),
      stop: () => stopPlayback('audio idle'),
      exportProject: () => M.exportProject({ loop: state.loop }),
      derive: () => M.derivePreferences(state.observations, state.sourceMap)
    };
  }

  async function boot() {
    wireEvents();
    renderContextOptions();
    exposeTestApi();
    try {
      const library = await M.loadLibrary();
      state.sources = library.sources;
      state.sourceMap = library.byKey;
      state.observations = M.loadObservations();
      state.variants = M.loadVariants();
      state.context = M.loadContext();
      state.loop = M.loadSettings().loop;
      els.loopToggle.checked = state.loop;
      els.strengthVal.textContent = pct(els.strength.value);
      const first = library.byKey.pad || library.byKey.keys || state.sources[0];
      if (first) state.layers = [M.createLayer(first, 0)];
      state.derived = M.derivePreferences(state.observations, state.sourceMap);
      syncContextControls();
      renderAll();
      state.ready = true;
      window.TasteLab.ready = true;
      setStatus(`Loaded ${state.sources.length} sources. Build a deck, compare, and keep the context.`);
      window.setInterval(updateTransport, 250);
    } catch (error) {
      setStatus(`Could not load the instrument library: ${error.message}`, true);
      setTransport('audio unavailable', true);
      state.ready = false;
    }
  }

  boot();
})();
