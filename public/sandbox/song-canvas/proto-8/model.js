(() => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE = {
    observations: 'songcanvas.taste.observations.v1',
    variants: 'songcanvas.taste.variants.v1',
    context: 'songcanvas.taste.context.v1',
    settings: 'songcanvas.taste.settings.v1'
  };
  const ACTIONS = ['prefer_a', 'prefer_b', 'like', 'dislike', 'neutral'];
  const PROCESSOR_TYPES = ['filter', 'drive', 'pan', 'delay', 'reverb'];
  const ROLES = ['intro', 'verse', 'buildup', 'chorus', 'breakdown', 'bridge', 'climax', 'outro'];
  const MOODS = ['reflective', 'hopeful', 'dreamy', 'dark', 'tense', 'energetic', 'calm', 'unstable'];
  const GENRES = ['ambient', 'electronic', 'rock', 'orchestral', 'jazz', 'folk', 'experimental', 'none'];

  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));
  const round = (value, places = 3) => Math.round(Number(value) * Math.pow(10, places)) / Math.pow(10, places);
  const nowIso = () => new Date().toISOString();
  const randomSeed = () => Math.floor(Math.random() * 2147483647) + 1;
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const unique = list => [...new Set(list)];

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

  function energyBand(value) {
    const n = clamp(value, 0, 1);
    return n < 0.34 ? 'low' : n < 0.67 ? 'mid' : 'high';
  }

  function densityBand(value) {
    const n = clamp(value, 0, 1);
    return n < 0.34 ? 'sparse' : n < 0.67 ? 'medium' : 'dense';
  }

  function normalizeContext(input) {
    const c = input && typeof input === 'object' ? input : {};
    return {
      song_id: String(c.song_id || c.songId || 'song_001').slice(0, 48),
      section_id: String(c.section_id || c.sectionId || 'sec_001').slice(0, 48),
      section_role: ROLES.includes(c.section_role || c.sectionRole) ? (c.section_role || c.sectionRole) : 'buildup',
      mood: MOODS.includes(c.mood) ? c.mood : 'reflective',
      mood_strength: round(clamp(c.mood_strength ?? c.moodStrength ?? 0.7, 0, 1)),
      genre: GENRES.includes(c.genre) ? c.genre : 'ambient',
      genre_strength: round(clamp(c.genre_strength ?? c.genreStrength ?? 0.5, 0, 1)),
      energy: round(clamp(c.energy ?? 0.4, 0, 1)),
      density: round(clamp(c.density ?? 0.4, 0, 1)),
      note: String(c.note || '').slice(0, 280)
    };
  }

  function defaultContext() {
    return normalizeContext({});
  }

  function defaultProcessors(index) {
    return [
      { type: 'filter', mode: 'lowpass', cutoff_hz: 9000, resonance: 0.7 },
      { type: 'drive', amount: 0.04 },
      { type: 'pan', value: index === 0 ? -0.12 : 0.12 },
      { type: 'delay', time_sec: 0.32, feedback: 0.2, mix: 0 },
      { type: 'reverb', mix: 0.12, seconds: 2.2 }
    ];
  }

  function normalizeProcessor(input) {
    const p = input && typeof input === 'object' ? input : {};
    const type = PROCESSOR_TYPES.includes(p.type) ? p.type : 'filter';
    if (type === 'filter') {
      return {
        type,
        mode: ['lowpass', 'highpass', 'bandpass'].includes(p.mode) ? p.mode : 'lowpass',
        cutoff_hz: round(clamp(p.cutoff_hz ?? p.cutoffHz ?? 9000, 40, 18000), 1),
        resonance: round(clamp(p.resonance ?? 0.7, 0.1, 12), 2)
      };
    }
    if (type === 'drive') {
      return { type, amount: round(clamp(p.amount ?? 0.04, 0, 0.7), 3) };
    }
    if (type === 'pan') {
      return { type, value: round(clamp(p.value ?? 0, -1, 1), 2) };
    }
    if (type === 'delay') {
      return {
        type,
        time_sec: round(clamp(p.time_sec ?? p.timeSec ?? 0.32, 0.05, 1.2), 3),
        feedback: round(clamp(p.feedback ?? 0.2, 0, 0.72), 3),
        mix: round(clamp(p.mix ?? 0, 0, 0.7), 3)
      };
    }
    return { type: 'reverb', mix: round(clamp(p.mix ?? 0.12, 0, 0.75), 3), seconds: round(clamp(p.seconds ?? 2.2, 0.4, 5), 2) };
  }

  function normalizeLayer(input, sourcesByKey, index = 0) {
    const layer = input && typeof input === 'object' ? input : {};
    const source = sourcesByKey && (
      sourcesByKey[layer.sourceKey] ||
      sourcesByKey[layer.source_key] ||
      Object.values(sourcesByKey).find(item => item.id === (layer.sourceId || layer.source_id))
    );
    const processors = Array.isArray(layer.processors) ? layer.processors : defaultProcessors(index);
    const byType = {};
    for (const processor of processors) {
      const normalized = normalizeProcessor(processor);
      if (!byType[normalized.type]) byType[normalized.type] = normalized;
    }
    for (const type of PROCESSOR_TYPES) {
      if (!byType[type]) byType[type] = normalizeProcessor({ type });
    }
    return {
      schema_version: SCHEMA_VERSION,
      id: String(layer.id || uid('layer')),
      source_id: source ? source.id : String(layer.source_id || layer.sourceId || 'inst_unknown'),
      source_key: source ? source.key : String(layer.source_key || layer.sourceKey || 'unknown'),
      source_label: source ? source.label : String(layer.source_label || layer.sourceLabel || 'Unknown source'),
      source_url: source ? source.url : String(layer.source_url || layer.url || ''),
      level: round(clamp(layer.level ?? 0.72, 0, 1), 3),
      processors: PROCESSOR_TYPES.map(type => byType[type])
    };
  }

  function getProcessor(layer, type) {
    return (layer.processors || []).find(processor => processor.type === type);
  }

  function setProcessor(layer, type, values) {
    const existing = getProcessor(layer, type);
    const next = normalizeProcessor({ ...(existing || { type }), ...(values || {}), type });
    layer.processors = (layer.processors || []).filter(processor => processor.type !== type);
    layer.processors.push(next);
    layer.processors.sort((a, b) => PROCESSOR_TYPES.indexOf(a.type) - PROCESSOR_TYPES.indexOf(b.type));
    return next;
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
        register: meta.register || 'mid',
        blurb: meta.blurb || '',
        source: item.source || '',
        preview: item.preview || item.file || '',
        url: `../instruments/${item.preview || item.file || ''}`,
        discord_url: item.discordUrl || '',
        message_id: item.messageId || '',
        kind: item.kind || 'instrument'
      };
    });
    const byKey = {};
    for (const source of sources) byKey[source.key] = source;
    return { manifest, sources, byKey };
  }

  function createLayer(source, index = 0) {
    return normalizeLayer({
      source_id: source.id,
      source_key: source.key,
      source_label: source.label,
      source_url: source.url,
      level: index === 0 ? 0.76 : 0.58,
      processors: defaultProcessors(index)
    }, { [source.key]: source }, index);
  }

  function captureCandidate(layers, label, sourcesByKey, extra = {}) {
    const normalized = (Array.isArray(layers) ? layers : [])
      .slice(0, 2)
      .map((layer, index) => normalizeLayer(layer, sourcesByKey, index));
    if (!normalized.length) throw new Error('A candidate needs at least one source layer.');
    return {
      schema_version: SCHEMA_VERSION,
      id: uid('cand'),
      label: String(label || 'Untitled candidate').slice(0, 80),
      created_at: nowIso(),
      seed: Number.isInteger(extra.seed) ? extra.seed : randomSeed(),
      derived_from: extra.derived_from || null,
      change: extra.change || null,
      master: { level: round(clamp(extra.master_level ?? 0.72, 0.1, 1), 3) },
      layers: normalized
    };
  }

  function describeCandidate(candidate) {
    if (!candidate || !Array.isArray(candidate.layers)) return 'No candidate';
    const names = candidate.layers.map(layer => layer.source_label || layer.source_key);
    const first = candidate.layers[0];
    const filter = first ? getProcessor(first, 'filter') : null;
    const drive = first ? getProcessor(first, 'drive') : null;
    const reverb = first ? getProcessor(first, 'reverb') : null;
    const parts = [names.join(' + ')];
    if (filter) parts.push(`${filter.mode} ${formatHz(filter.cutoff_hz)}`);
    if (drive && drive.amount > 0.02) parts.push(`drive ${Math.round(drive.amount * 100)}%`);
    if (reverb && reverb.mix > 0.02) parts.push(`space ${Math.round(reverb.mix * 100)}%`);
    return parts.join(' · ');
  }

  function formatHz(value) {
    const hz = Number(value) || 0;
    return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`;
  }

  function sourceForLayer(layer, sourcesByKey) {
    return sourcesByKey && (sourcesByKey[layer.sourceKey] || sourcesByKey[layer.source_key]) || null;
  }

  function mutateCandidate(candidate, focus, sources) {
    const next = clone(candidate);
    next.id = uid('cand');
    next.created_at = nowIso();
    next.seed = randomSeed();
    next.derived_from = candidate.id;
    const rng = mulberry32(next.seed);
    const allowed = ['filter', 'drive', 'space', 'source', 'random'];
    let chosen = allowed.includes(focus) ? focus : 'random';
    if (chosen === 'random') chosen = ['filter', 'drive', 'space', 'source'][Math.floor(rng() * 4)];
    const layer = next.layers[0];
    if (!layer) throw new Error('Candidate has no layer to vary.');
    if (chosen === 'source') {
      const current = layer.source_key;
      const sameFamily = sources.filter(source => source.key !== current && source.family === (sources.find(s => s.key === current) || {}).family);
      const pool = sameFamily.length ? sameFamily : sources.filter(source => source.key !== current);
      const picked = pool[Math.floor(rng() * pool.length)] || sources[0];
      if (picked) {
        layer.source_id = picked.id;
        layer.source_key = picked.key;
        layer.source_label = picked.label;
        layer.source_url = picked.url;
      }
      next.change = { focus: 'source', layer: 1, summary: `source → ${layer.source_label}` };
      next.label = `B · source → ${layer.source_label}`;
    } else if (chosen === 'filter') {
      const filter = getProcessor(layer, 'filter');
      const direction = rng() < 0.5 ? -1 : 1;
      const factor = 1 + direction * (0.18 + rng() * 0.32);
      setProcessor(layer, 'filter', {
        ...filter,
        cutoff_hz: clamp(filter.cutoff_hz * factor, 180, 16000),
        resonance: clamp(filter.resonance + (rng() - 0.5) * 0.5, 0.2, 6)
      });
      next.change = { focus: 'filter', layer: 1, summary: direction > 0 ? 'filter opens' : 'filter closes' };
      next.label = `B · ${next.change.summary}`;
    } else if (chosen === 'drive') {
      const drive = getProcessor(layer, 'drive');
      const direction = rng() < 0.5 ? -1 : 1;
      setProcessor(layer, 'drive', { ...drive, amount: clamp(drive.amount + direction * (0.08 + rng() * 0.16), 0, 0.55) });
      next.change = { focus: 'drive', layer: 1, summary: direction > 0 ? 'more drive' : 'cleaner' };
      next.label = `B · ${next.change.summary}`;
    } else {
      const reverb = getProcessor(layer, 'reverb');
      const delay = getProcessor(layer, 'delay');
      const direction = rng() < 0.5 ? -1 : 1;
      if (rng() < 0.65) {
        setProcessor(layer, 'reverb', { ...reverb, mix: clamp(reverb.mix + direction * (0.08 + rng() * 0.18), 0, 0.65) });
        next.change = { focus: 'space', layer: 1, summary: direction > 0 ? 'more room' : 'drier' };
      } else {
        setProcessor(layer, 'delay', { ...delay, mix: clamp(delay.mix + direction * (0.06 + rng() * 0.14), 0, 0.55) });
        next.change = { focus: 'space', layer: 1, summary: direction > 0 ? 'more echo' : 'less echo' };
      }
      next.label = `B · ${next.change.summary}`;
    }
    return next;
  }

  function normalizeCandidate(input, sourcesByKey) {
    const c = clone(input);
    c.schema_version = SCHEMA_VERSION;
    c.id = String(c.id || uid('cand'));
    c.label = String(c.label || 'Candidate').slice(0, 80);
    c.created_at = c.created_at || nowIso();
    c.seed = Number.isInteger(c.seed) ? c.seed : randomSeed();
    c.master = { level: round(clamp((c.master && c.master.level) ?? 0.72, 0.1, 1), 3) };
    c.layers = (Array.isArray(c.layers) ? c.layers : []).slice(0, 2).map((layer, index) => normalizeLayer(layer, sourcesByKey, index));
    return c;
  }

  function candidateSourceKeys(candidate) {
    return unique((candidate && candidate.layers || []).map(layer => layer.source_key || layer.sourceKey).filter(Boolean));
  }

  function makeObservation(input, sourcesByKey) {
    const action = ACTIONS.includes(input.action) ? input.action : 'neutral';
    if (!input.candidateA) throw new Error('An observation needs candidate A.');
    if ((action === 'prefer_a' || action === 'prefer_b') && !input.candidateB) throw new Error('A/B preference needs candidate B.');
    return {
      schema_version: SCHEMA_VERSION,
      id: uid('obs'),
      timestamp: nowIso(),
      action,
      strength: round(clamp(input.strength ?? 0.7, 0.1, 1), 2),
      candidateA: normalizeCandidate(input.candidateA, sourcesByKey),
      candidateB: input.candidateB ? normalizeCandidate(input.candidateB, sourcesByKey) : null,
      context: normalizeContext(input.context),
      reason_tags: Array.isArray(input.reason_tags) ? input.reason_tags.slice(0, 8).map(tag => String(tag).slice(0, 40)) : [],
      notes: input.notes ? String(input.notes).slice(0, 500) : null
    };
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn('Taste storage failed', error);
      return false;
    }
  }

  function readObservationStore() {
    const data = readJson(STORAGE.observations, []);
    return Array.isArray(data) ? data : [];
  }

  function readVariantStore() {
    const data = readJson(STORAGE.variants, []);
    return Array.isArray(data) ? data : [];
  }

  function validCandidate(candidate) {
    return !!candidate && Array.isArray(candidate.layers) && candidate.layers.length > 0
      && candidate.layers.length <= 2
      && candidate.layers.every(layer => layer && layer.source_key && layer.source_key !== 'unknown');
  }

  function sanitizeObservation(input) {
    if (!input || typeof input !== 'object' || !input.id || !ACTIONS.includes(input.action)) return null;
    if (!validCandidate(input.candidateA)) return null;
    const candidateA = normalizeCandidate(input.candidateA);
    if (!validCandidate(candidateA)) return null;
    let candidateB = null;
    if (input.candidateB) {
      if (!validCandidate(input.candidateB)) return null;
      candidateB = normalizeCandidate(input.candidateB);
      if (!validCandidate(candidateB)) return null;
    }
    if ((input.action === 'prefer_a' || input.action === 'prefer_b') && !candidateB) return null;
    return {
      ...input,
      schema_version: SCHEMA_VERSION,
      action: input.action,
      strength: round(clamp(input.strength ?? 0.7, 0.1, 1), 2),
      candidateA,
      candidateB,
      context: normalizeContext(input.context),
      reason_tags: Array.isArray(input.reason_tags) ? input.reason_tags.slice(0, 8).map(tag => String(tag).slice(0, 40)) : [],
      notes: input.notes ? String(input.notes).slice(0, 500) : null
    };
  }

  function sanitizeVariant(input) {
    if (!input || typeof input !== 'object' || !input.id || !validCandidate(input)) return null;
    const candidate = normalizeCandidate(input);
    if (!validCandidate(candidate)) return null;
    return { ...input, ...candidate, name: String(input.name || input.label || 'Variant').slice(0, 48), saved_at: input.saved_at || nowIso() };
  }

  function loadObservations() {
    return readObservationStore().map(sanitizeObservation).filter(Boolean);
  }

  function appendObservation(observation) {
    const list = readObservationStore();
    if (!list.some(item => item && item.id === observation.id)) list.push(observation);
    if (!writeJson(STORAGE.observations, list)) throw new Error('Browser storage is full; the observation was not saved.');
    return observation;
  }

  function loadVariants() {
    return readVariantStore().map(sanitizeVariant).filter(Boolean);
  }

  function saveVariant(variant) {
    const list = readVariantStore();
    const existing = list.find(item => item && item.id === variant.id);
    if (existing) Object.assign(existing, variant);
    else list.unshift(variant);
    if (!writeJson(STORAGE.variants, list.slice(0, 80))) throw new Error('Browser storage is full; the variant was not saved.');
    return variant;
  }

  function deleteVariant(id) {
    const list = readVariantStore().filter(item => item && item.id !== id);
    writeJson(STORAGE.variants, list);
    return list;
  }

  function loadContext() {
    return normalizeContext(readJson(STORAGE.context, defaultContext()));
  }

  function saveContext(context) {
    const normalized = normalizeContext(context);
    writeJson(STORAGE.context, normalized);
    return normalized;
  }

  function loadSettings() {
    const data = readJson(STORAGE.settings, null);
    return { loop: !!(data && data.loop) };
  }

  function saveSettings(settings) {
    writeJson(STORAGE.settings, { loop: !!settings.loop });
  }

  function targetLabel(target) {
    if (target.kind === 'family') {
      return (window.TasteLibraryFamilies || {})[target.key] || target.label || target.key;
    }
    return target.label || target.key;
  }

  function candidateDifferences(preferred, other, sourcesByKey) {
    const differences = [];
    const layers = Math.min((preferred.layers || []).length, (other.layers || []).length);
    for (let index = 0; index < layers; index++) {
      const preferredLayer = preferred.layers[index];
      const otherLayer = other.layers[index];
      if (preferredLayer.source_key !== otherLayer.source_key) continue;
      const source = sourcesByKey[preferredLayer.source_key] || {
        key: preferredLayer.source_key,
        label: preferredLayer.source_label,
        family: 'other',
        family_label: 'Other'
      };
      const preferredFilter = getProcessor(preferredLayer, 'filter');
      const otherFilter = getProcessor(otherLayer, 'filter');
      if (preferredFilter && otherFilter) {
        const ratio = preferredFilter.cutoff_hz / Math.max(1, otherFilter.cutoff_hz);
        if (ratio > 1.05) {
          differences.push({
            source,
            preferred: { key: 'filter:brighter', label: 'brighter filter' },
            opposite: { key: 'filter:darker', label: 'darker filter' }
          });
        } else if (ratio < 0.95) {
          differences.push({
            source,
            preferred: { key: 'filter:darker', label: 'darker filter' },
            opposite: { key: 'filter:brighter', label: 'brighter filter' }
          });
        }
      }
      const preferredDrive = getProcessor(preferredLayer, 'drive');
      const otherDrive = getProcessor(otherLayer, 'drive');
      if (preferredDrive && otherDrive && Math.abs(preferredDrive.amount - otherDrive.amount) > 0.03) {
        const more = preferredDrive.amount > otherDrive.amount;
        differences.push({
          source,
          preferred: more ? { key: 'drive:more', label: 'more drive' } : { key: 'drive:less', label: 'less drive' },
          opposite: more ? { key: 'drive:less', label: 'less drive' } : { key: 'drive:more', label: 'more drive' }
        });
      }
      const preferredReverb = getProcessor(preferredLayer, 'reverb');
      const otherReverb = getProcessor(otherLayer, 'reverb');
      if (preferredReverb && otherReverb && Math.abs(preferredReverb.mix - otherReverb.mix) > 0.03) {
        const more = preferredReverb.mix > otherReverb.mix;
        differences.push({
          source,
          preferred: more ? { key: 'space:more', label: 'more space' } : { key: 'space:drier', label: 'drier space' },
          opposite: more ? { key: 'space:drier', label: 'drier space' } : { key: 'space:more', label: 'more space' }
        });
      }
      const preferredDelay = getProcessor(preferredLayer, 'delay');
      const otherDelay = getProcessor(otherLayer, 'delay');
      if (preferredDelay && otherDelay && Math.abs(preferredDelay.mix - otherDelay.mix) > 0.03) {
        const more = preferredDelay.mix > otherDelay.mix;
        differences.push({
          source,
          preferred: more ? { key: 'echo:more', label: 'more echo' } : { key: 'echo:less', label: 'less echo' },
          opposite: more ? { key: 'echo:less', label: 'less echo' } : { key: 'echo:more', label: 'more echo' }
        });
      }
    }
    return differences;
  }

  function derivePreferences(observations, sourcesByKey) {
    const global = new Map();
    const contextual = new Map();

    function add(map, target, conditions, positive, weight, observation) {
      const key = `${target.kind}:${target.key}|${conditions ? JSON.stringify(conditions) : 'global'}`;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          target: { ...target, label: targetLabel(target) },
          conditions: conditions ? { ...conditions } : null,
          positive: 0,
          negative: 0,
          support: 0,
          examples: [],
          last_supported_at: null
        };
        map.set(key, entry);
      }
      if (positive) entry.positive += weight;
      else entry.negative += weight;
      if (!entry.examples.includes(observation.id)) {
        entry.support += 1;
        entry.examples.push(observation.id);
      }
      entry.last_supported_at = observation.timestamp;
    }

    for (const observation of observations) {
      const context = normalizeContext(observation.context);
      const events = [];
      if (observation.action === 'prefer_a' && observation.candidateB) {
        events.push([observation.candidateA, true], [observation.candidateB, false]);
      } else if (observation.action === 'prefer_b' && observation.candidateB) {
        events.push([observation.candidateB, true], [observation.candidateA, false]);
      } else if (observation.action === 'like') {
        events.push([observation.candidateA, true]);
      } else if (observation.action === 'dislike') {
        events.push([observation.candidateA, false]);
      } else {
        continue;
      }
      const weight = clamp(observation.strength ?? 0.7, 0.1, 1);
      const contextualConditions = {
        section_role: context.section_role,
        mood: context.mood,
        genre: context.genre,
        energy_band: energyBand(context.energy),
        density_band: densityBand(context.density)
      };
      for (const [candidate, positive] of events) {
        const keys = candidateSourceKeys(candidate);
        for (const key of keys) {
          const source = sourcesByKey[key] || { key, label: key, family: 'other', family_label: 'Other' };
          const targets = [
            { kind: 'source', key, label: source.label, family: source.family, family_label: source.family_label },
            { kind: 'family', key: source.family, label: source.family_label, family: source.family, family_label: source.family_label }
          ];
          for (const target of targets) {
            add(global, target, null, positive, weight, observation);
            add(contextual, target, contextualConditions, positive, weight, observation);
          }
        }
      }

      if (observation.action === 'prefer_a' || observation.action === 'prefer_b') {
        const preferred = observation.action === 'prefer_a' ? observation.candidateA : observation.candidateB;
        const other = observation.action === 'prefer_a' ? observation.candidateB : observation.candidateA;
        for (const difference of candidateDifferences(preferred, other, sourcesByKey)) {
          const source = difference.source;
          const preferredTarget = {
            kind: 'transformation',
            key: `${source.key}:${difference.preferred.key}`,
            label: `${source.label} · ${difference.preferred.label}`,
            family: source.family,
            family_label: source.family_label
          };
          const oppositeTarget = {
            kind: 'transformation',
            key: `${source.key}:${difference.opposite.key}`,
            label: `${source.label} · ${difference.opposite.label}`,
            family: source.family,
            family_label: source.family_label
          };
          add(global, preferredTarget, null, true, weight, observation);
          add(contextual, preferredTarget, contextualConditions, true, weight, observation);
          add(global, oppositeTarget, null, false, weight, observation);
          add(contextual, oppositeTarget, contextualConditions, false, weight, observation);
        }
      }
    }

    function rules(map, scope) {
      return [...map.values()]
        .map(entry => {
          const total = entry.positive + entry.negative;
          const raw = total ? (entry.positive - entry.negative) / total : 0;
          return {
            id: `pref_${scope}_${entry.target.kind}_${entry.target.key}_${entry.conditions ? Object.values(entry.conditions).join('-') : 'all'}`,
            scope,
            target: entry.target,
            conditions: entry.conditions,
            preference_score: round(0.5 + raw * 0.5, 3),
            confidence: round(entry.support / (entry.support + 2), 3),
            support: entry.support,
            positive: round(entry.positive, 3),
            negative: round(entry.negative, 3),
            source_observation_ids: entry.examples.slice(-8),
            last_supported_at: entry.last_supported_at
          };
        })
        .sort((a, b) => (b.confidence * (0.35 + Math.abs(b.preference_score - 0.5))) - (a.confidence * (0.35 + Math.abs(a.preference_score - 0.5))))
        .slice(0, scope === 'global' ? 12 : 16);
    }

    return {
      generated_at: nowIso(),
      observation_count: observations.length,
      global: rules(global, 'global'),
      contextual: rules(contextual, 'contextual')
    };
  }

  function mergeById(existing, incoming, predicate) {
    const map = new Map();
    for (const item of existing) map.set(item.id, item);
    for (const item of incoming) {
      if (!map.has(item.id) && predicate(item)) map.set(item.id, item);
    }
    return [...map.values()];
  }

  function exportProject(settings) {
    return {
      schema_version: SCHEMA_VERSION,
      exported_at: nowIso(),
      storage_keys: STORAGE,
      observations: readObservationStore(),
      variants: readVariantStore(),
      context: loadContext(),
      settings: { loop: !!(settings && settings.loop) }
    };
  }

  function importProject(project) {
    if (!project || typeof project !== 'object') throw new Error('Not a JSON project.');
    const incomingObservations = (Array.isArray(project.observations) ? project.observations : [])
      .map(sanitizeObservation)
      .filter(Boolean);
    const incomingVariants = (Array.isArray(project.variants) ? project.variants : [])
      .map(sanitizeVariant)
      .filter(Boolean);
    const observations = mergeById(readObservationStore(), incomingObservations, () => true);
    const variants = mergeById(readVariantStore(), incomingVariants, () => true);
    if (!writeJson(STORAGE.observations, observations)) throw new Error('Browser storage is full; observations were not imported.');
    if (!writeJson(STORAGE.variants, variants.slice(0, 80))) throw new Error('Browser storage is full; variants were not imported.');
    if (project.context) saveContext(project.context);
    if (project.settings) saveSettings({ loop: !!project.settings.loop });
    return {
      observations: observations.length,
      importedObservations: incomingObservations.length,
      variants: variants.length,
      importedVariants: incomingVariants.length,
      skippedObservations: (Array.isArray(project.observations) ? project.observations.length : 0) - incomingObservations.length,
      skippedVariants: (Array.isArray(project.variants) ? project.variants.length : 0) - incomingVariants.length
    };
  }

  window.TasteModel = {
    SCHEMA_VERSION,
    STORAGE,
    ACTIONS,
    ROLES,
    MOODS,
    GENRES,
    loadLibrary,
    normalizeContext,
    defaultContext,
    createLayer,
    captureCandidate,
    normalizeCandidate,
    describeCandidate,
    formatHz,
    getProcessor,
    setProcessor,
    mutateCandidate,
    makeObservation,
    loadObservations,
    appendObservation,
    loadVariants,
    saveVariant,
    deleteVariant,
    loadContext,
    saveContext,
    loadSettings,
    saveSettings,
    derivePreferences,
    exportProject,
    importProject,
    energyBand,
    densityBand
  };
})();
