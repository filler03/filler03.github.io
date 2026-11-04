(() => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE = 'songcanvas.section.v1';
  const BPM = 96;
  const BARS = 8;
  const BEATS_PER_BAR = 4;
  const DURATION_SEC = (BARS * BEATS_PER_BAR * 60) / BPM;
  const MAX_LIKES = 30;

  const ATTRIBUTES = [
    { id: 'energy', label: 'Energy', color: '#7cf3d1', default: 0.5, variation: 0.12, effects: false, hint: 'overall level and presence' },
    { id: 'density', label: 'Density', color: '#8bd3ff', default: 0.5, variation: 0.14, effects: false, hint: 'how present the second layer is' },
    { id: 'brightness', label: 'Brightness', color: '#ffd479', default: 0.5, variation: 0.18, effects: true, hint: 'filter cutoff' },
    { id: 'space', label: 'Space', color: '#b39cff', default: 0.5, variation: 0.18, effects: true, hint: 'reverb and room' },
    { id: 'grit', label: 'Grit', color: '#ff9e7a', default: 0.5, variation: 0.15, effects: true, hint: 'drive and edge' },
    { id: 'motion', label: 'Motion', color: '#ff7ab0', default: 0.5, variation: 0.15, effects: true, hint: 'echo movement' }
  ];

  const DEFAULT_CURVES = {
    energy: [{ t: 0, v: 0.25 }, { t: 0.5, v: 0.5 }, { t: 1, v: 0.75 }],
    density: [{ t: 0, v: 0.3 }, { t: 1, v: 0.55 }],
    brightness: [{ t: 0, v: 0.3 }, { t: 0.5, v: 0.55 }, { t: 1, v: 0.7 }],
    space: [{ t: 0, v: 0.2 }, { t: 1, v: 0.45 }],
    grit: [{ t: 0, v: 0.05 }, { t: 1, v: 0.2 }],
    motion: [{ t: 0, v: 0.1 }, { t: 0.5, v: 0.3 }, { t: 1, v: 0.4 }]
  };

  const ATTR_BY_ID = Object.fromEntries(ATTRIBUTES.map(attribute => [attribute.id, attribute]));
  const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));
  const round = (value, places = 3) => Math.round(Number(value) * Math.pow(10, places)) / Math.pow(10, places);
  const clone = value => JSON.parse(JSON.stringify(value));
  const nowIso = () => new Date().toISOString();
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const randomSeed = () => Math.floor(Math.random() * 2147483647) + 1;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a += 0x6D2B79F5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function normalizePoint(point) {
    if (Array.isArray(point)) return { t: round(clamp(point[0], 0, 1)), v: round(clamp(point[1], 0, 1)) };
    return { t: round(clamp(point && point.t, 0, 1)), v: round(clamp(point && point.v, 0, 1)) };
  }

  function normalizePoints(points) {
    return (Array.isArray(points) ? points : [])
      .map(normalizePoint)
      .sort((a, b) => a.t - b.t);
  }

  async function loadLibrary() {
    const response = await fetch('../instruments/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Library manifest returned ${response.status}`);
    const manifest = await response.json();
    const sources = (Array.isArray(manifest.previews) ? manifest.previews : []).map(item => {
      const meta = (window.TasteLibraryMeta || {})[item.key] || {};
      return {
        id: `inst_${item.key}`,
        key: item.key,
        label: item.label,
        family: meta.family || 'other',
        family_label: meta.familyLabel || 'Other',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        roles: Array.isArray(meta.roles) ? meta.roles : [],
        blurb: meta.blurb || '',
        source: item.source || '',
        preview: item.preview || item.file || '',
        url: `../instruments/${item.preview || item.file || ''}`,
        discord_url: item.discordUrl || ''
      };
    });
    const byKey = {};
    for (const source of sources) byKey[source.key] = source;
    return { manifest, sources, byKey };
  }

  function defaultSourceKeys(sourcesByKey) {
    const preferred = ['pad', 'texture', 'keys', 'strings'];
    const keys = preferred.filter(key => sourcesByKey[key]);
    for (const key of Object.keys(sourcesByKey || {})) {
      if (keys.length >= 2) break;
      if (!keys.includes(key)) keys.push(key);
    }
    return keys.slice(0, 2);
  }

  function sourceFromKey(key, sourcesByKey) {
    const source = sourcesByKey[key];
    return source ? { key: source.key, label: source.label, family_label: source.family_label, url: source.url } : null;
  }

  function createSection(sourcesByKey) {
    const keys = defaultSourceKeys(sourcesByKey);
    const sources = keys.map(key => sourceFromKey(key, sourcesByKey)).filter(Boolean);
    return normalizeSection({
      id: 'sec_001',
      title: 'New section',
      bpm: BPM,
      bars: BARS,
      sources,
      attributes: Object.fromEntries(ATTRIBUTES.map(attribute => [attribute.id, {
        id: attribute.id,
        specified: false,
        locked: false,
        interpolation: 'linear',
        points: []
      }])),
      discovery: {
        focus: 'brightness',
        effects_locked: false,
        auto_next: true,
        cycle: 0,
        offset: 0,
        seed: randomSeed(),
        likes: []
      }
    }, sourcesByKey);
  }

  function isLocked(section, id) {
    const lane = section.attributes[id];
    const definition = ATTR_BY_ID[id];
    if (!lane || !definition) return true;
    return !!lane.locked || (!!section.discovery.effects_locked && definition.effects);
  }

  function chooseFocus(section) {
    const available = ATTRIBUTES.find(attribute => !isLocked(section, attribute.id));
    return available ? available.id : 'energy';
  }

  function normalizeLike(input) {
    if (!input || typeof input !== 'object' || !input.id || !ATTR_BY_ID[input.focus]) return null;
    const sources = Array.isArray(input.sources)
      ? input.sources.filter(source => source && (source.key || source.label)).map(source => ({ key: String(source.key || ''), label: String(source.label || source.key || '') }))
      : [];
    return {
      ...input,
      mode: 'guide',
      offset: round(clamp(input.offset ?? 0, -1, 1)),
      cycle: Math.max(0, Math.round(Number(input.cycle) || 0)),
      sources,
      effective: input.effective && typeof input.effective === 'object' ? input.effective : {}
    };
  }

  function normalizeSection(input, sourcesByKey) {
    const fallback = input && typeof input === 'object' ? input : {};
    const defaultKeys = defaultSourceKeys(sourcesByKey);
    const sourceList = Array.isArray(fallback.sources) ? fallback.sources : [];
    const sources = [];
    for (let index = 0; index < 2; index++) {
      const item = sourceList[index];
      const key = item && (item.key || item.source_key);
      const mapped = key && sourcesByKey && sourcesByKey[key];
      const fallback = defaultKeys[index] && sourcesByKey && sourcesByKey[defaultKeys[index]];
      const source = mapped || (item && item.url ? item : null) || fallback;
      if (source) sources.push({ key: source.key, label: source.label, family_label: source.family_label, url: source.url });
    }
    const attributes = {};
    for (const definition of ATTRIBUTES) {
      const lane = (fallback.attributes && fallback.attributes[definition.id]) || {};
      const points = normalizePoints(lane.points);
      const specified = !!lane.specified;
      attributes[definition.id] = {
        id: definition.id,
        specified,
        locked: !!lane.locked,
        interpolation: 'linear',
        points: specified && points.length < 2 ? clone(DEFAULT_CURVES[definition.id]) : points
      };
    }
    const rawDiscovery = fallback.discovery && typeof fallback.discovery === 'object' ? fallback.discovery : {};
    let focus = ATTR_BY_ID[rawDiscovery.focus] ? rawDiscovery.focus : 'brightness';
    const effectsLocked = !!rawDiscovery.effects_locked;
    const preliminary = { attributes, discovery: { effects_locked: effectsLocked } };
    if (isLocked(preliminary, focus)) focus = chooseFocus(preliminary);
    const likes = Array.isArray(rawDiscovery.likes)
      ? rawDiscovery.likes.map(normalizeLike).filter(Boolean).slice(-MAX_LIKES)
      : [];
    const section = {
      schema_version: SCHEMA_VERSION,
      mode: 'guide',
      id: String(fallback.id || 'sec_001').slice(0, 48),
      title: String(fallback.title || 'New section').slice(0, 80),
      bpm: BPM,
      bars: BARS,
      duration_sec: DURATION_SEC,
      sources,
      attributes,
      discovery: {
        focus,
        effects_locked: effectsLocked,
        auto_next: rawDiscovery.auto_next !== false,
        cycle: Math.max(0, Math.round(Number(rawDiscovery.cycle) || 0)),
        offset: round(clamp(rawDiscovery.offset ?? 0, -1, 1)),
        seed: Number.isInteger(rawDiscovery.seed) ? rawDiscovery.seed : randomSeed(),
        likes
      }
    };
    return section;
  }

  function saveSection(section, sourcesByKey = {}) {
    const normalized = normalizeSection(section, sourcesByKey);
    try {
      localStorage.setItem(STORAGE, JSON.stringify(normalized));
      return normalized;
    } catch (error) {
      throw new Error('Browser storage is full; this section was not saved.');
    }
  }

  function loadSection(sourcesByKey) {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (!raw) return createSection(sourcesByKey);
      return normalizeSection(JSON.parse(raw), sourcesByKey);
    } catch (error) {
      return createSection(sourcesByKey);
    }
  }

  function setSource(section, index, key, sourcesByKey) {
    const source = sourcesByKey[key];
    if (!source || (index !== 0 && index !== 1)) return false;
    section.sources[index] = { key: source.key, label: source.label, family_label: source.family_label, url: source.url };
    return true;
  }

  function toggleSpecified(section, id) {
    const lane = section.attributes[id];
    if (!lane) return false;
    lane.specified = !lane.specified;
    if (lane.specified && lane.points.length < 2) lane.points = clone(DEFAULT_CURVES[id]);
    return true;
  }

  function toggleLock(section, id) {
    const lane = section.attributes[id];
    const definition = ATTR_BY_ID[id];
    if (!lane || !definition) return false;
    lane.locked = !lane.locked;
    if (lane.locked && section.discovery.focus === id) {
      section.discovery.focus = chooseFocus(section);
      section.discovery.offset = 0;
    }
    return true;
  }

  function setEffectsLocked(section, locked) {
    section.discovery.effects_locked = !!locked;
    if (locked && ATTR_BY_ID[section.discovery.focus].effects) {
      section.discovery.focus = chooseFocus(section);
      section.discovery.offset = 0;
    }
    return true;
  }

  function setFocus(section, id) {
    const definition = ATTR_BY_ID[id];
    if (!definition) return false;
    const lane = section.attributes[id];
    if (!lane || isLocked(section, id)) return false;
    section.discovery.focus = id;
    section.discovery.offset = 0;
    return true;
  }

  function setAutoNext(section, auto) {
    section.discovery.auto_next = !!auto;
  }

  function nextVariation(section) {
    const definition = ATTR_BY_ID[section.discovery.focus] || ATTR_BY_ID.brightness;
    const lane = section.attributes[definition.id];
    if (!lane || isLocked(section, definition.id)) {
      section.discovery.focus = chooseFocus(section);
      section.discovery.offset = 0;
    } else {
      const rng = mulberry32((section.discovery.seed + section.discovery.cycle * 7919) >>> 0);
      section.discovery.offset = round((rng() * 2 - 1) * definition.variation);
    }
    section.discovery.cycle += 1;
    return section.discovery.offset;
  }

  function variationText(section) {
    const definition = ATTR_BY_ID[section.discovery.focus];
    if (!definition) return 'No focus';
    const lane = section.attributes[definition.id];
    if (!lane || isLocked(section, definition.id)) return `${definition.label} is locked`;
    const offset = section.discovery.offset;
    const direction = offset > 0.005 ? `+${Math.round(offset * 100)}%` : offset < -0.005 ? `${Math.round(offset * 100)}%` : 'centered';
    return `${definition.label} ${direction}`;
  }

  function evaluatePoints(points, t) {
    if (!points || !points.length) return 0.5;
    const x = clamp(t, 0, 1);
    if (x <= points[0].t) return points[0].v;
    for (let index = 0; index < points.length - 1; index++) {
      const a = points[index];
      const b = points[index + 1];
      if (x >= a.t && x <= b.t) {
        const span = Math.max(0.0001, b.t - a.t);
        return a.v + (b.v - a.v) * ((x - a.t) / span);
      }
    }
    return points[points.length - 1].v;
  }

  function curveValue(section, id, t) {
    const definition = ATTR_BY_ID[id];
    const lane = section.attributes[id];
    if (!definition || !lane) return 0.5;
    return lane.specified ? evaluatePoints(lane.points, t) : definition.default;
  }

  function effectiveValue(section, id, t) {
    const definition = ATTR_BY_ID[id];
    const lane = section.attributes[id];
    if (!definition || !lane) return 0.5;
    let value = curveValue(section, id, t);
    if (section.discovery.focus === id && !isLocked(section, id)) {
      value += section.discovery.offset;
    }
    return round(clamp(value, 0, 1));
  }

  function makeLayer(source, index, values) {
    const cutoff = clamp(300 * Math.pow(50, values.brightness), 300, 16000);
    return {
      schema_version: SCHEMA_VERSION,
      id: `layer_${index + 1}`,
      source_id: source.key ? `inst_${source.key}` : 'inst_unknown',
      source_key: source.key,
      source_label: source.label,
      source_url: source.url,
      level: round(index === 0 ? 0.35 + values.energy * 0.5 : 0.12 + values.density * 0.62),
      processors: [
        { type: 'filter', mode: 'lowpass', cutoff_hz: round(cutoff, 1), resonance: 0.7 },
        { type: 'drive', amount: round(values.grit * 0.55, 3) },
        { type: 'pan', value: index === 0 ? -0.12 : 0.12 },
        { type: 'delay', time_sec: round(0.22 + values.motion * 0.18, 3), feedback: 0.2, mix: round(values.motion * 0.5, 3) },
        { type: 'reverb', mix: round(values.space * 0.65, 3), seconds: 2.2 }
      ]
    };
  }

  function makeLayers(section, t) {
    const values = {};
    for (const definition of ATTRIBUTES) values[definition.id] = effectiveValue(section, definition.id, t);
    return section.sources.map((source, index) => makeLayer(source, index, values));
  }

  function makeCandidate(section, t) {
    return {
      schema_version: SCHEMA_VERSION,
      id: uid('cand'),
      label: section.title || 'Section preview',
      created_at: nowIso(),
      seed: section.discovery.seed,
      master: { level: 0.72 },
      layers: makeLayers(section, t)
    };
  }

  function addLike(section) {
    const effective = {};
    for (const definition of ATTRIBUTES) {
      effective[definition.id] = [0, 0.25, 0.5, 0.75, 1].map(t => effectiveValue(section, definition.id, t));
    }
    const like = {
      id: uid('like'),
      timestamp: nowIso(),
      mode: 'guide',
      focus: section.discovery.focus,
      offset: section.discovery.offset,
      cycle: section.discovery.cycle,
      sources: section.sources.map(source => ({ key: source.key, label: source.label })),
      attributes: Object.fromEntries(ATTRIBUTES.map(definition => {
        const lane = section.attributes[definition.id];
        return [definition.id, { specified: lane.specified, locked: lane.locked, points: clone(lane.points) }];
      })),
      effective
    };
    section.discovery.likes.push(like);
    section.discovery.likes = section.discovery.likes.slice(-MAX_LIKES);
    return like;
  }

  function applyLike(section, likeId, sourcesByKey = {}) {
    const like = (section.discovery.likes || []).find(item => item.id === likeId);
    if (!like) return null;
    (Array.isArray(like.sources) ? like.sources : []).slice(0, 2).forEach((item, index) => {
      const source = item && item.key && sourcesByKey[item.key];
      if (source) {
        section.sources[index] = { key: source.key, label: source.label, family_label: source.family_label, url: source.url };
      }
    });
    for (const definition of ATTRIBUTES) {
      const saved = like.attributes && like.attributes[definition.id];
      if (!saved) continue;
      const lane = section.attributes[definition.id];
      lane.specified = !!saved.specified;
      lane.locked = !!saved.locked;
      lane.points = Array.isArray(saved.points) ? normalizePoints(saved.points) : [];
      if (lane.specified && lane.points.length < 2) lane.points = clone(DEFAULT_CURVES[definition.id]);
    }
    section.discovery.focus = ATTR_BY_ID[like.focus] ? like.focus : chooseFocus(section);
    if (isLocked(section, section.discovery.focus)) section.discovery.focus = chooseFocus(section);
    section.discovery.offset = round(clamp(like.offset ?? 0, -1, 1));
    section.discovery.cycle = Math.max(0, Math.round(Number(like.cycle) || 0));
    return like;
  }

  function removeLike(section, likeId) {
    const before = section.discovery.likes.length;
    section.discovery.likes = section.discovery.likes.filter(item => item.id !== likeId);
    return section.discovery.likes.length !== before;
  }

  function makeBrief(section) {
    return {
      schema_version: SCHEMA_VERSION,
      mode: 'guide',
      exported_at: nowIso(),
      section: {
        id: section.id,
        title: section.title,
        bpm: section.bpm,
        bars: section.bars,
        duration_sec: section.duration_sec,
        sources: section.sources.map(source => ({ key: source.key, label: source.label }))
      },
      attributes: Object.fromEntries(ATTRIBUTES.map(definition => {
        const lane = section.attributes[definition.id];
        return [definition.id, {
          label: definition.label,
          specified: lane.specified,
          locked: lane.locked,
          interpolation: lane.interpolation,
          range: [0, 1],
          curve: lane.specified ? clone(lane.points) : null,
          ai_decides: !lane.specified
        }];
      })),
      discovery: {
        focus: section.discovery.focus,
        effects_locked: section.discovery.effects_locked,
        auto_next: section.discovery.auto_next,
        likes: clone(section.discovery.likes)
      },
      note: 'Guide only. The final song should use these curves, locks, and liked variations as intent evidence; it should re-realize the section, not replay this preview.'
    };
  }

  window.SectionModel = {
    SCHEMA_VERSION,
    STORAGE,
    ATTRIBUTES,
    ATTR_BY_ID,
    DEFAULT_CURVES,
    BPM,
    BARS,
    DURATION_SEC,
    loadLibrary,
    createSection,
    normalizeSection,
    loadSection,
    saveSection,
    setSource,
    toggleSpecified,
    toggleLock,
    setEffectsLocked,
    setFocus,
    setAutoNext,
    nextVariation,
    variationText,
    curveValue,
    effectiveValue,
    isLocked,
    makeLayers,
    makeCandidate,
    addLike,
    applyLike,
    removeLike,
    makeBrief,
    clamp
  };
})();
