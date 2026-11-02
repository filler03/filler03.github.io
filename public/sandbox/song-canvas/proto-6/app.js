(() => {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
  const STORAGE_KEY = 'songcanvas.instruments.v1';
  const KEY_LABELS = ['A', 'W', 'S', 'E', 'D', 'F', 'T', 'G', 'Y', 'H', 'U', 'J', 'K'];
  const KEYMAP = {
    KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6,
    KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12
  };
  const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
  const BLACK_AFTER = [0, 1, 3, 4, 5, 7, 8, 10, 11, 12];

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const midiName = m => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
  const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);
  const clone = value => JSON.parse(JSON.stringify(value));
  const fmtTime = t => t < 1 ? `${Math.max(1, Math.round(t * 1000))} ms` : `${t.toFixed(2)} s`;
  const fmtPct = v => `${Math.round(v * 100)}%`;
  const fmtSignedPct = v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
  const fmtHz = hz => hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
  const fmtRate = hz => `${hz.toFixed(hz < 1 ? 2 : 1)} Hz`;
  const waveLabel = w => w.charAt(0).toUpperCase() + w.slice(1);

  function initSpec() {
    return {
      name: 'Untitled instrument',
      osc1: { on: true, wave: 'sawtooth', octave: 0, detune: 0, level: 0.6 },
      osc2: { on: false, wave: 'sine', octave: -1, detune: 7, level: 0.25 },
      noise: { on: false, level: 0.12 },
      amp: { a: 0.012, d: 0.32, s: 0.72, r: 0.5 },
      filter: {
        type: 'lowpass', cutoff: 2200, q: 1.2, envAmount: 0.25,
        env: { a: 0.01, d: 0.45, s: 0.35, r: 0.5 }
      },
      lfo: { on: false, wave: 'sine', rate: 4.2, depth: 0.16, target: 'filter' },
      fx: { drive: 0.06, chorus: 0.1, delay: 0, delayTime: 0.32, reverb: 0.18 },
      master: { level: 0.72 }
    };
  }

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(x => x && x.id && x.spec) : [];
    } catch (err) {
      return [];
    }
  }

  function persistSaved() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(S.saved));
      return true;
    } catch (err) {
      return false;
    }
  }

  const S = {
    spec: initSpec(),
    saved: loadSaved(),
    currentId: null,
    dirty: true,
    latch: false,
    baseMidi: 48,
    active: new Set(),
    sustained: new Set(),
    pointers: new Map(),
    heldKeys: new Set(),
    saveTimer: null
  };

  const A = (() => {
    let ctx = null;
    let analyser = null;
    let master = null;
    let bus = null;
    let shape = null;
    let chorusDry = null;
    let chorusWet = null;
    let chorusDelay = null;
    let echoDry = null;
    let echoWet = null;
    let echoNode = null;
    let echoFeedback = null;
    let revDry = null;
    let revWet = null;
    let convolver = null;
    let noiseBuffer = null;
    let spec = null;
    let initFailed = false;
    const voices = new Map();

    function makeNoise() {
      const len = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    }

    function makeImpulse(seconds, decay) {
      const len = Math.floor(ctx.sampleRate * seconds);
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          const fade = Math.pow(1 - i / len, decay);
          data[i] = (Math.random() * 2 - 1) * fade;
        }
      }
      return buf;
    }

    function makeDriveCurve(amount) {
      const n = 1024;
      const curve = new Float32Array(n);
      const k = 1 + amount * 14;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = amount === 0 ? x : Math.tanh(x * k) / Math.tanh(k);
      }
      return curve;
    }

    function init() {
      if (initFailed) return null;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        initFailed = true;
        $('#audioState').textContent = 'audio unavailable in this browser';
        return null;
      }
      try {
        ctx = new Ctx();
      } catch (err) {
        initFailed = true;
        $('#audioState').textContent = 'audio unavailable in this browser';
        return null;
      }
      spec = S.spec;
      noiseBuffer = makeNoise();

      bus = ctx.createGain();
      bus.gain.value = 0.55;

      shape = ctx.createWaveShaper();
      shape.oversample = '4x';
      shape.curve = makeDriveCurve(spec.fx.drive);
      bus.connect(shape);

      const chorusOut = ctx.createGain();
      chorusDry = ctx.createGain();
      chorusDry.gain.value = 1;
      chorusWet = ctx.createGain();
      chorusWet.gain.value = 0;
      chorusDelay = ctx.createDelay(0.1);
      chorusDelay.delayTime.value = 0.018;
      const chorusLfo = ctx.createOscillator();
      const chorusLfoGain = ctx.createGain();
      chorusLfo.type = 'sine';
      chorusLfo.frequency.value = 0.35;
      chorusLfoGain.gain.value = 0.004;
      chorusLfo.connect(chorusLfoGain).connect(chorusDelay.delayTime);
      chorusLfo.start();
      shape.connect(chorusDry).connect(chorusOut);
      shape.connect(chorusDelay).connect(chorusWet).connect(chorusOut);

      const echoOut = ctx.createGain();
      echoDry = ctx.createGain();
      echoDry.gain.value = 1;
      echoWet = ctx.createGain();
      echoWet.gain.value = 0;
      echoNode = ctx.createDelay(1);
      echoNode.delayTime.value = spec.fx.delayTime;
      echoFeedback = ctx.createGain();
      echoFeedback.gain.value = 0.32;
      const echoTone = ctx.createBiquadFilter();
      echoTone.type = 'lowpass';
      echoTone.frequency.value = 2600;
      chorusOut.connect(echoDry).connect(echoOut);
      chorusOut.connect(echoNode);
      echoNode.connect(echoTone);
      echoTone.connect(echoFeedback).connect(echoNode);
      echoTone.connect(echoWet).connect(echoOut);

      const revOut = ctx.createGain();
      revDry = ctx.createGain();
      revDry.gain.value = 1;
      revWet = ctx.createGain();
      revWet.gain.value = 0;
      convolver = ctx.createConvolver();
      convolver.buffer = makeImpulse(2.1, 2.7);
      echoOut.connect(revDry).connect(revOut);
      echoOut.connect(convolver).connect(revWet).connect(revOut);

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 18;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      master = ctx.createGain();
      master.gain.value = spec.master.level;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.82;
      revOut.connect(comp).connect(master);
      master.connect(analyser).connect(ctx.destination);
      applyFx();
      return ctx;
    }

    function ensure() {
      if (!ctx) init();
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    function applyFx() {
      if (!ctx || !spec) return;
      shape.curve = makeDriveCurve(spec.fx.drive);
      chorusWet.gain.setTargetAtTime(spec.fx.chorus * 0.72, ctx.currentTime, 0.02);
      chorusDry.gain.setTargetAtTime(1 - spec.fx.chorus * 0.22, ctx.currentTime, 0.02);
      echoWet.gain.setTargetAtTime(spec.fx.delay * 0.62, ctx.currentTime, 0.02);
      echoNode.delayTime.setTargetAtTime(spec.fx.delayTime, ctx.currentTime, 0.02);
      revWet.gain.setTargetAtTime(spec.fx.reverb * 0.9, ctx.currentTime, 0.02);
      revDry.gain.setTargetAtTime(1 - spec.fx.reverb * 0.16, ctx.currentTime, 0.02);
      master.gain.setTargetAtTime(spec.master.level, ctx.currentTime, 0.02);
    }

    function routeLfo(v) {
      v.lfoGain.disconnect();
      v.lfoGain.gain.cancelScheduledValues(ctx.currentTime);
      v.lfoGain.gain.value = 0;
      v.trem.gain.cancelScheduledValues(ctx.currentTime);
      v.trem.gain.value = 1;
      if (!spec.lfo.on) return;
      const depth = spec.lfo.depth;
      if (spec.lfo.target === 'pitch') {
        v.lfoGain.gain.value = depth * 170;
        for (const o of v.oscs) v.lfoGain.connect(o.osc.detune);
      } else if (spec.lfo.target === 'filter') {
        v.lfoGain.gain.value = depth * 2000;
        v.lfoGain.connect(v.filter.frequency);
      } else {
        v.lfoGain.gain.value = depth * 0.45;
        v.lfoGain.connect(v.trem.gain);
      }
    }

    function noteOn(midi, velocity = 0.82) {
      ensure();
      if (!ctx) return;
      spec = S.spec;
      if (voices.has(midi)) hardStop(midi);
      let activeVoices = [...voices.values()].filter(v => !v.released);
      if (activeVoices.length >= 8) hardStop(activeVoices[0].midi);
      const now = ctx.currentTime + 0.005;
      const filter = ctx.createBiquadFilter();
      const amp = ctx.createGain();
      const trem = ctx.createGain();
      const oscs = [];
      const baseCutoff = clamp(spec.filter.cutoff, 40, 16000);
      filter.type = spec.filter.type;
      filter.Q.value = spec.filter.q;
      filter.frequency.setValueAtTime(baseCutoff, now);
      const peak = clamp(baseCutoff * Math.pow(2, spec.filter.envAmount * 4), 40, 18000);
      if (spec.filter.envAmount !== 0) {
        filter.frequency.linearRampToValueAtTime(peak, now + Math.max(0.001, spec.filter.env.a));
        filter.frequency.linearRampToValueAtTime(
          clamp(baseCutoff + (peak - baseCutoff) * spec.filter.env.s, 40, 18000),
          now + Math.max(0.002, spec.filter.env.a + spec.filter.env.d)
        );
      }
      for (const key of ['osc1', 'osc2']) {
        const layer = spec[key];
        if (!layer.on) continue;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = layer.wave;
        osc.frequency.value = midiHz(midi + layer.octave * 12);
        osc.detune.value = layer.detune;
        gain.gain.value = layer.level;
        osc.connect(gain).connect(filter);
        osc.start(now);
        oscs.push({ key, osc, gain });
      }
      let noiseSrc = null;
      let noiseGain = null;
      if (spec.noise.on) {
        noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = noiseBuffer;
        noiseSrc.loop = true;
        noiseGain = ctx.createGain();
        noiseGain.gain.value = spec.noise.level;
        noiseSrc.connect(noiseGain).connect(filter);
        noiseSrc.start(now);
      }
      amp.gain.setValueAtTime(0.0001, now);
      amp.gain.linearRampToValueAtTime(Math.max(0.0001, velocity), now + Math.max(0.001, spec.amp.a));
      amp.gain.linearRampToValueAtTime(
        Math.max(0.0001, velocity * spec.amp.s),
        now + Math.max(0.002, spec.amp.a + spec.amp.d)
      );
      filter.connect(amp).connect(trem).connect(bus);
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.type = spec.lfo.wave;
      lfo.frequency.value = spec.lfo.rate;
      lfo.connect(lfoGain);
      lfo.start(now);
      const voice = {
        midi, filter, amp, trem, oscs, noiseSrc, noiseGain, lfo, lfoGain,
        baseCutoff, released: false, startedAt: now
      };
      voices.set(midi, voice);
      routeLfo(voice);
    }

    function noteOff(midi) {
      const v = voices.get(midi);
      if (!v || v.released || !ctx) return;
      spec = S.spec;
      v.released = true;
      const now = ctx.currentTime;
      const release = Math.max(0.02, spec.amp.r);
      v.amp.gain.cancelScheduledValues(now);
      v.amp.gain.setValueAtTime(Math.max(0.0001, v.amp.gain.value), now);
      v.amp.gain.exponentialRampToValueAtTime(0.0001, now + release);
      try {
        v.filter.frequency.cancelScheduledValues(now);
        v.filter.frequency.setValueAtTime(Math.max(40, v.filter.frequency.value), now);
        v.filter.frequency.linearRampToValueAtTime(v.baseCutoff, now + Math.max(0.02, spec.filter.env.r));
      } catch (err) { }
      setTimeout(() => {
        if (voices.get(midi) === v) {
          stopNodes(v);
          voices.delete(midi);
        }
      }, (release + 0.12) * 1000);
    }

    function stopNodes(v) {
      for (const o of v.oscs) {
        try { o.osc.stop(); } catch (err) { }
        try { o.osc.disconnect(); o.gain.disconnect(); } catch (err) { }
      }
      try { if (v.noiseSrc) { v.noiseSrc.stop(); v.noiseSrc.disconnect(); } } catch (err) { }
      try { v.noiseGain && v.noiseGain.disconnect(); } catch (err) { }
      try { v.lfo.stop(); v.lfo.disconnect(); v.lfoGain.disconnect(); } catch (err) { }
      try { v.filter.disconnect(); v.amp.disconnect(); v.trem.disconnect(); } catch (err) { }
    }

    function hardStop(midi) {
      const v = voices.get(midi);
      if (!v) return;
      voices.delete(midi);
      stopNodes(v);
    }

    function allOff() {
      for (const midi of [...voices.keys()]) hardStop(midi);
    }

    function applyVoice(v) {
      if (!ctx) return;
      const now = ctx.currentTime;
      v.filter.type = spec.filter.type;
      v.filter.Q.setTargetAtTime(spec.filter.q, now, 0.02);
      v.baseCutoff = clamp(spec.filter.cutoff, 40, 16000);
      try {
        v.filter.frequency.cancelScheduledValues(now);
        v.filter.frequency.setTargetAtTime(v.baseCutoff, now, 0.02);
      } catch (err) { }
      for (const o of v.oscs) {
        const layer = spec[o.key];
        if (!layer) continue;
        o.osc.type = layer.wave;
        o.osc.frequency.setTargetAtTime(midiHz(v.midi + layer.octave * 12), now, 0.02);
        o.osc.detune.setTargetAtTime(layer.detune, now, 0.02);
        o.gain.gain.setTargetAtTime(layer.level, now, 0.02);
      }
      if (v.noiseGain) v.noiseGain.gain.setTargetAtTime(spec.noise.level, now, 0.02);
      v.lfo.type = spec.lfo.wave;
      v.lfo.frequency.setTargetAtTime(spec.lfo.rate, now, 0.02);
      routeLfo(v);
    }

    function setSpec(next) {
      spec = next;
      if (!ctx) return;
      applyFx();
      for (const v of voices.values()) if (!v.released) applyVoice(v);
    }

    function getAnalyser() { return analyser; }
    function isReady() { return !!ctx; }
    function activeCount() { return [...voices.values()].filter(v => !v.released).length; }

    return { noteOn, noteOff, allOff, setSpec, getAnalyser, isReady, activeCount, ensure };
  })();

  const BINDINGS = [];

  function bindRange(id, get, set, fmt, toSlider, fromSlider) {
    const el = document.getElementById(id);
    const out = document.getElementById(id + 'Val');
    const apply = () => {
      const pos = Number(el.value);
      set(fromSlider ? fromSlider(pos) : pos);
      out.textContent = fmt(get());
      changed();
    };
    el.addEventListener('input', apply);
    BINDINGS.push(() => {
      const v = get();
      el.value = toSlider ? toSlider(v) : v;
      out.textContent = fmt(v);
    });
    return el;
  }

  function bindCheck(id, get, set) {
    const el = document.getElementById(id);
    el.addEventListener('change', () => { set(el.checked); changed(); });
    BINDINGS.push(() => { el.checked = !!get(); });
    return el;
  }

  function bindSelect(id, get, set) {
    const el = document.getElementById(id);
    el.addEventListener('change', () => { set(el.value); changed(); });
    BINDINGS.push(() => { el.value = get(); });
    return el;
  }

  function bindWaves(id, get, set, metaId) {
    const wrap = document.getElementById(id);
    const buttons = [...wrap.querySelectorAll('button')];
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        set(btn.dataset.wave);
        changed();
        syncWave(id, get, metaId);
      });
    });
    BINDINGS.push(() => syncWave(id, get, metaId));
  }

  function syncWave(id, get, metaId) {
    const w = get();
    document.getElementById(id).querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.wave === w);
    });
    document.getElementById(metaId).textContent = waveLabel(w);
  }

  function changed() {
    S.spec.name = $('#name').value.trim() || 'Untitled instrument';
    S.dirty = true;
    updateSaveState();
    drawEnv();
    renderSpec();
    A.setSpec(S.spec);
  }

  function updateSaveState() {
    const el = $('#saveState');
    el.textContent = S.dirty ? 'unsaved' : 'saved';
    el.classList.toggle('dirty', S.dirty);
    el.classList.toggle('saved', !S.dirty);
  }

  function renderSpec() {
    $('#specPreview').textContent = JSON.stringify(S.spec, null, 2);
  }

  function allNotesOff() {
    A.allOff();
    S.active.clear();
    S.sustained.clear();
    S.pointers.clear();
    S.heldKeys.clear();
    syncKeys();
    updateNoteReadout();
    updateAudioState();
  }

  function killNote(midi) {
    A.noteOff(midi);
    S.active.delete(midi);
    S.sustained.delete(midi);
    syncKeys();
    updateNoteReadout();
  }

  function pressNote(midi) {
    if (S.active.has(midi)) {
      if (S.latch) killNote(midi);
      return;
    }
    if (S.active.size >= 8) {
      const oldest = S.active.values().next().value;
      killNote(oldest);
    }
    A.noteOn(midi);
    S.active.add(midi);
    S.sustained.delete(midi);
    syncKeys();
    updateNoteReadout();
    updateAudioState();
  }

  function releaseNote(midi) {
    if (!S.active.has(midi)) return;
    if (S.latch) {
      S.sustained.add(midi);
      return;
    }
    A.noteOff(midi);
    S.active.delete(midi);
    syncKeys();
    updateNoteReadout();
  }

  function noteReadout() {
    const notes = [...S.active].sort((a, b) => a - b);
    return notes.length ? notes.map(midiName).join(' + ') : '—';
  }

  function updateNoteReadout() {
    $('#noteReadout').textContent = noteReadout();
  }

  function updateAudioState() {
    const state = $('#audioState');
    const wrap = state.parentElement;
    const live = S.active.size > 0;
    wrap.classList.toggle('live', live);
    if (!A.isReady()) state.textContent = 'audio idle · play a key';
    else if (S.active.size) state.textContent = `${S.active.size} note${S.active.size === 1 ? '' : 's'} sounding`;
    else state.textContent = 'audio live · ready';
  }

  function syncKeys() {
    document.querySelectorAll('.wkey, .bkey').forEach(key => {
      key.classList.toggle('on', S.active.has(Number(key.dataset.midi)));
    });
  }

  function buildKeyboard() {
    const wrap = $('#keys');
    wrap.innerHTML = '';
    const frag = document.createDocumentFragment();
    const width = 100 / WHITE_OFFSETS.length;
    for (let i = 0; i < WHITE_OFFSETS.length; i++) {
      const offset = WHITE_OFFSETS[i];
      const midi = S.baseMidi + offset;
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'wkey';
      key.dataset.midi = midi;
      key.setAttribute('aria-label', midiName(midi));
      const keyLabel = KEY_LABELS[offset];
      if (keyLabel) {
        const k = document.createElement('span');
        k.className = 'klabel';
        k.textContent = keyLabel;
        key.appendChild(k);
      }
      const note = document.createElement('span');
      note.className = 'notename';
      note.textContent = midiName(midi);
      key.appendChild(note);
      bindKeyPointer(key, midi);
      frag.appendChild(key);
    }
    for (const after of BLACK_AFTER) {
      const offset = WHITE_OFFSETS[after] + 1;
      const midi = S.baseMidi + offset;
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'bkey';
      key.dataset.midi = midi;
      key.setAttribute('aria-label', midiName(midi));
      key.style.width = `${width * 0.62}%`;
      key.style.left = `${(after + 1) * width}%`;
      const keyLabel = KEY_LABELS[offset];
      if (keyLabel) {
        const k = document.createElement('span');
        k.className = 'klabel';
        k.textContent = keyLabel;
        key.appendChild(k);
      }
      bindKeyPointer(key, midi);
      frag.appendChild(key);
    }
    wrap.appendChild(frag);
    $('#octLabel').textContent = `${midiName(S.baseMidi)}–${midiName(S.baseMidi + 24)}`;
    $('#octDown').disabled = S.baseMidi <= 36;
    $('#octUp').disabled = S.baseMidi >= 60;
    syncKeys();
  }

  function bindKeyPointer(key, midi) {
    key.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { key.setPointerCapture(e.pointerId); } catch (err) { }
      S.pointers.set(e.pointerId, midi);
      pressNote(midi);
    });
    const release = e => {
      const note = S.pointers.get(e.pointerId);
      if (note == null) return;
      S.pointers.delete(e.pointerId);
      releaseNote(note);
    };
    key.addEventListener('pointerup', release);
    key.addEventListener('pointercancel', release);
    key.addEventListener('lostpointercapture', release);
  }

  function syncAll() {
    $('#name').value = S.spec.name;
    BINDINGS.forEach(fn => fn());
    drawEnv();
    renderSpec();
    updateSaveState();
    renderSaved();
    updateNoteReadout();
    updateAudioState();
  }

  function drawEnv() {
    const canvas = $('#env');
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const pad = 12;
    const pw = w - pad * 2;
    const ph = h - pad * 2;
    const s = S.spec.amp;
    const plateau = 0.34;
    const total = Math.max(0.12, s.a + s.d + plateau + s.r);
    const x = t => pad + (t / total) * pw;
    const y = v => pad + ph - v * ph;
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      g.beginPath();
      g.moveTo(pad, pad + (ph / 4) * i);
      g.lineTo(pad + pw, pad + (ph / 4) * i);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(x(0), y(0));
    g.lineTo(x(s.a), y(1));
    g.lineTo(x(s.a + s.d), y(s.s));
    g.lineTo(x(s.a + s.d + plateau), y(s.s));
    g.lineTo(x(total), y(0));
    g.lineTo(x(0), y(0));
    const grad = g.createLinearGradient(0, pad, 0, pad + ph);
    grad.addColorStop(0, 'rgba(124,243,209,0.33)');
    grad.addColorStop(1, 'rgba(124,243,209,0.02)');
    g.fillStyle = grad;
    g.fill();
    g.beginPath();
    g.moveTo(x(0), y(0));
    g.lineTo(x(s.a), y(1));
    g.lineTo(x(s.a + s.d), y(s.s));
    g.lineTo(x(s.a + s.d + plateau), y(s.s));
    g.lineTo(x(total), y(0));
    g.strokeStyle = '#7cf3d1';
    g.lineWidth = 1.7;
    g.stroke();
    g.fillStyle = 'rgba(236,234,245,0.55)';
    g.font = '9px ui-monospace, Menlo, monospace';
    g.fillText('A', x(s.a) - 3, pad + ph - 5);
    g.fillText('D', x(s.a + s.d) - 3, pad + ph - 5);
    g.fillText('S', x(s.a + s.d + plateau / 2) - 3, y(s.s) - 5);
    g.fillText('R', x(total) - 4, pad + ph - 5);
  }

  let scopeSize = { w: 0, h: 0 };
  function drawScope() {
    const canvas = $('#scope');
    if (canvas) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w && h && (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr))) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        scopeSize = { w, h };
      }
      if (w && h) {
        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        g.strokeStyle = 'rgba(255,255,255,0.055)';
        g.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          g.beginPath();
          g.moveTo(0, (h / 4) * i);
          g.lineTo(w, (h / 4) * i);
          g.stroke();
        }
        const analyser = A.getAnalyser();
        if (analyser && A.isReady()) {
          const data = new Uint8Array(analyser.fftSize);
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          g.beginPath();
          for (let i = 0; i < data.length; i++) {
            const x = (i / (data.length - 1)) * w;
            const v = (data[i] - 128) / 128;
            sum += v * v;
            const y = h / 2 + v * (h * 0.42);
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          const grad = g.createLinearGradient(0, 0, w, 0);
          grad.addColorStop(0, '#7cf3d1');
          grad.addColorStop(0.55, '#b39cff');
          grad.addColorStop(1, '#ffca8c');
          g.strokeStyle = grad;
          g.lineWidth = 1.6;
          g.shadowColor = 'rgba(124,243,209,0.5)';
          g.shadowBlur = 8;
          g.stroke();
          g.shadowBlur = 0;
          const rms = Math.sqrt(sum / data.length);
          if (S.active.size && rms > 0.004) {
            $('#audioState').textContent = `${S.active.size} note${S.active.size === 1 ? '' : 's'} sounding`;
          }
        } else {
          g.beginPath();
          g.moveTo(0, h / 2);
          g.lineTo(w, h / 2);
          g.strokeStyle = 'rgba(255,255,255,0.14)';
          g.lineWidth = 1;
          g.stroke();
        }
      }
    }
    requestAnimationFrame(drawScope);
  }

  function updateSavedCount() {
    $('#savedCount').textContent = String(S.saved.length);
    $('#savedNote').textContent = S.saved.length
      ? 'Saved locally in this browser. Click one to load it.'
      : 'Saved locally in this browser. Nothing leaves the page.';
  }

  function renderSaved() {
    const list = $('#savedList');
    list.innerHTML = '';
    if (!S.saved.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No instruments saved yet. Shape a sound and save it.';
      list.appendChild(empty);
      updateSavedCount();
      return;
    }
    for (const inst of S.saved) {
      const card = document.createElement('div');
      card.className = 'savedcard' + (inst.id === S.currentId ? ' current' : '');
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Load ${inst.name}`);
      const body = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'scname';
      name.textContent = inst.name;
      const meta = document.createElement('div');
      meta.className = 'scmeta';
      meta.textContent = `${waveLabel(inst.spec.osc1.wave)}${inst.spec.osc2.on ? ' + ' + waveLabel(inst.spec.osc2.wave) : ''} · ${inst.spec.filter.type}`;
      body.append(name, meta);
      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.textContent = 'Delete';
      del.title = 'Delete this saved instrument';
      del.addEventListener('click', e => {
        e.stopPropagation();
        deleteInstrument(inst.id);
      });
      card.append(body, del);
      card.addEventListener('click', () => loadInstrument(inst.id));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          loadInstrument(inst.id);
        }
      });
      list.appendChild(card);
    }
    updateSavedCount();
  }

  function loadInstrument(id) {
    const inst = S.saved.find(x => x.id === id);
    if (!inst) return;
    S.spec = clone(inst.spec);
    S.currentId = inst.id;
    S.dirty = false;
    allNotesOff();
    syncAll();
    A.setSpec(S.spec);
  }

  function saveInstrument() {
    const name = ($('#name').value.trim() || 'Untitled instrument').slice(0, 48);
    $('#name').value = name;
    S.spec.name = name;
    const now = Date.now();
    if (S.currentId) {
      const existing = S.saved.find(x => x.id === S.currentId);
      if (existing) {
        existing.name = name;
        existing.spec = clone(S.spec);
        existing.savedAt = now;
      } else {
        S.currentId = null;
      }
    }
    if (!S.currentId) {
      S.currentId = 'i' + now.toString(36) + Math.random().toString(36).slice(2, 5);
      S.saved.unshift({ id: S.currentId, name, spec: clone(S.spec), savedAt: now });
    }
    S.saved.sort((a, b) => b.savedAt - a.savedAt);
    persistSaved();
    S.dirty = false;
    updateSaveState();
    renderSaved();
    renderSpec();
  }

  function deleteInstrument(id) {
    S.saved = S.saved.filter(x => x.id !== id);
    if (S.currentId === id) {
      S.currentId = null;
      S.dirty = true;
      updateSaveState();
    }
    persistSaved();
    renderSaved();
  }

  function newInstrument() {
    S.spec = initSpec();
    S.currentId = null;
    S.dirty = true;
    allNotesOff();
    syncAll();
    A.setSpec(S.spec);
  }

  function toggleLatch() {
    S.latch = !S.latch;
    $('#latch').classList.toggle('on', S.latch);
    if (!S.latch) {
      for (const midi of [...S.active]) {
        A.noteOff(midi);
        S.active.delete(midi);
      }
      S.sustained.clear();
      syncKeys();
      updateNoteReadout();
      updateAudioState();
    }
  }

  async function copySpec() {
    const text = JSON.stringify(S.spec, null, 2);
    const note = $('#copyNote');
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = 'Copied. The next piece can read this instrument spec.';
    } catch (err) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        note.textContent = 'Copied. The next piece can read this instrument spec.';
      } catch (err2) {
        note.textContent = 'Copy blocked by the browser. Select the spec above and copy it manually.';
      }
    }
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => {
      note.textContent = 'The next step will read this spec, sequence it, and arrange the song.';
    }, 6000);
  }

  function wire() {
    bindCheck('osc1on', () => S.spec.osc1.on, v => { S.spec.osc1.on = v; });
    bindCheck('osc2on', () => S.spec.osc2.on, v => { S.spec.osc2.on = v; });
    bindCheck('noiseOn', () => S.spec.noise.on, v => { S.spec.noise.on = v; });
    bindCheck('lfoOn', () => S.spec.lfo.on, v => { S.spec.lfo.on = v; });

    bindWaves('osc1waves', () => S.spec.osc1.wave, w => { S.spec.osc1.wave = w; }, 'osc1meta');
    bindWaves('osc2waves', () => S.spec.osc2.wave, w => { S.spec.osc2.wave = w; }, 'osc2meta');

    bindSelect('osc1oct', () => String(S.spec.osc1.octave), v => { S.spec.osc1.octave = Number(v); });
    bindSelect('osc2oct', () => String(S.spec.osc2.octave), v => { S.spec.osc2.octave = Number(v); });
    bindSelect('filterType', () => S.spec.filter.type, v => { S.spec.filter.type = v; });
    bindSelect('lfoWave', () => S.spec.lfo.wave, v => { S.spec.lfo.wave = v; });
    bindSelect('lfoTarget', () => S.spec.lfo.target, v => { S.spec.lfo.target = v; });

    bindRange('osc1detune', () => S.spec.osc1.detune, v => { S.spec.osc1.detune = Math.round(v); }, v => `${v > 0 ? '+' : ''}${Math.round(v)} ct`);
    bindRange('osc1level', () => S.spec.osc1.level, v => { S.spec.osc1.level = v; }, fmtPct);
    bindRange('osc2detune', () => S.spec.osc2.detune, v => { S.spec.osc2.detune = Math.round(v); }, v => `${v > 0 ? '+' : ''}${Math.round(v)} ct`);
    bindRange('osc2level', () => S.spec.osc2.level, v => { S.spec.osc2.level = v; }, fmtPct);
    bindRange('noiseLevel', () => S.spec.noise.level, v => { S.spec.noise.level = v; }, fmtPct);

    bindRange('ampA', () => S.spec.amp.a, v => { S.spec.amp.a = v; }, fmtTime);
    bindRange('ampD', () => S.spec.amp.d, v => { S.spec.amp.d = v; }, fmtTime);
    bindRange('ampS', () => S.spec.amp.s, v => { S.spec.amp.s = v; }, fmtPct);
    bindRange('ampR', () => S.spec.amp.r, v => { S.spec.amp.r = v; }, fmtTime);

    const cutoffToSlider = hz => Math.log(clamp(hz, 60, 16000) / 60) / Math.log(16000 / 60) * 100;
    const sliderToCutoff = pos => 60 * Math.pow(16000 / 60, pos / 100);
    bindRange('cutoff', () => S.spec.filter.cutoff, v => { S.spec.filter.cutoff = v; }, fmtHz, cutoffToSlider, sliderToCutoff);
    bindRange('resonance', () => S.spec.filter.q, v => { S.spec.filter.q = v; }, v => v.toFixed(1));
    bindRange('filterEnv', () => S.spec.filter.envAmount, v => { S.spec.filter.envAmount = v; }, fmtSignedPct);

    bindRange('fA', () => S.spec.filter.env.a, v => { S.spec.filter.env.a = v; }, fmtTime);
    bindRange('fD', () => S.spec.filter.env.d, v => { S.spec.filter.env.d = v; }, fmtTime);
    bindRange('fS', () => S.spec.filter.env.s, v => { S.spec.filter.env.s = v; }, fmtPct);
    bindRange('fR', () => S.spec.filter.env.r, v => { S.spec.filter.env.r = v; }, fmtTime);

    const rateToSlider = hz => Math.log(clamp(hz, 0.05, 12) / 0.05) / Math.log(12 / 0.05) * 100;
    const sliderToRate = pos => 0.05 * Math.pow(12 / 0.05, pos / 100);
    bindRange('lfoRate', () => S.spec.lfo.rate, v => { S.spec.lfo.rate = v; }, fmtRate, rateToSlider, sliderToRate);
    bindRange('lfoDepth', () => S.spec.lfo.depth, v => { S.spec.lfo.depth = v; }, fmtPct);

    bindRange('drive', () => S.spec.fx.drive, v => { S.spec.fx.drive = v; }, fmtPct);
    bindRange('chorus', () => S.spec.fx.chorus, v => { S.spec.fx.chorus = v; }, fmtPct);
    bindRange('delay', () => S.spec.fx.delay, v => { S.spec.fx.delay = v; }, fmtPct);
    bindRange('reverb', () => S.spec.fx.reverb, v => { S.spec.fx.reverb = v; }, fmtPct);
    bindRange('master', () => S.spec.master.level, v => { S.spec.master.level = v; }, fmtPct);

    $('#name').addEventListener('input', () => {
      S.spec.name = $('#name').value.trim() || 'Untitled instrument';
      S.dirty = true;
      updateSaveState();
      renderSpec();
    });
    $('#name').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveInstrument();
      }
    });

    $('#newBtn').addEventListener('click', newInstrument);
    $('#saveBtn').addEventListener('click', saveInstrument);
    $('#copySpec').addEventListener('click', copySpec);
    $('#latch').addEventListener('click', toggleLatch);
    $('#allOff').addEventListener('click', allNotesOff);
    $('#octDown').addEventListener('click', () => {
      if (S.baseMidi <= 36) return;
      allNotesOff();
      S.baseMidi -= 12;
      buildKeyboard();
    });
    $('#octUp').addEventListener('click', () => {
      if (S.baseMidi >= 60) return;
      allNotesOff();
      S.baseMidi += 12;
      buildKeyboard();
    });

    window.addEventListener('keydown', e => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target && e.target.closest && e.target.closest('input, select, textarea')) return;
      const offset = KEYMAP[e.code];
      if (offset == null) return;
      e.preventDefault();
      if (S.heldKeys.has(e.code)) return;
      S.heldKeys.add(e.code);
      pressNote(S.baseMidi + offset);
    });
    window.addEventListener('keyup', e => {
      const offset = KEYMAP[e.code];
      if (offset == null) return;
      if (!S.heldKeys.has(e.code)) return;
      S.heldKeys.delete(e.code);
      releaseNote(S.baseMidi + offset);
    });
    window.addEventListener('blur', () => {
      S.heldKeys.clear();
      allNotesOff();
    });
    window.addEventListener('resize', () => {
      drawEnv();
    });
  }

  wire();
  buildKeyboard();
  syncAll();
  drawEnv();
  requestAnimationFrame(drawScope);
  updateAudioState();
})();
