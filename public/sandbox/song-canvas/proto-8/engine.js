(() => {
  'use strict';

  const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));

  const engine = (() => {
    let ctx = null;
    let master = null;
    let compressor = null;
    let analyser = null;
    let active = null;
    let recordDestination = null;
    let requestId = 0;
    const buffers = new Map();
    const impulses = new Map();
    const driveCurves = new Map();
    const MAX_BUFFERS = 8;

    function makeImpulse(seconds, decay) {
      const length = Math.floor(ctx.sampleRate * seconds);
      const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < length; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
      }
      return buffer;
    }

    function impulseFor(seconds) {
      const key = Math.round(clamp(seconds, 0.4, 5) * 10) / 10;
      if (!impulses.has(key)) impulses.set(key, makeImpulse(key, 2.4));
      return impulses.get(key);
    }

    function makeDriveCurve(amount) {
      const key = Math.round(clamp(amount, 0, 0.7) * 200);
      if (driveCurves.has(key)) return driveCurves.get(key);
      if (key === 0) {
        driveCurves.set(key, null);
        return null;
      }
      const n = 1024;
      const curve = new Float32Array(n);
      const k = 1 + (key / 200) * 22;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * k) / Math.tanh(k);
      }
      driveCurves.set(key, curve);
      return curve;
    }

    function ensure() {
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        return ctx;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('This browser does not support Web Audio.');
      ctx = new Ctx();
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.knee.value = 20;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.25;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      master = ctx.createGain();
      master.gain.value = 0.7;
      master.connect(compressor).connect(analyser).connect(ctx.destination);
      return ctx;
    }

    function processor(layer, type) {
      return (layer.processors || []).find(item => item.type === type) || null;
    }

    async function bufferFor(url) {
      if (!url) throw new Error('A layer is missing its source audio.');
      if (buffers.has(url)) return buffers.get(url);
      const promise = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
        const bytes = await response.arrayBuffer();
        return await ctx.decodeAudioData(bytes);
      })();
      buffers.set(url, promise);
      while (buffers.size > MAX_BUFFERS) {
        const oldest = buffers.keys().next().value;
        if (oldest === url) break;
        buffers.delete(oldest);
      }
      try {
        return await promise;
      } catch (error) {
        buffers.delete(url);
        throw error;
      }
    }

    function buildLayer(layer, buffer, startAt, playBus, convolver, state) {
      const filterData = processor(layer, 'filter') || {};
      const driveData = processor(layer, 'drive') || {};
      const panData = processor(layer, 'pan') || {};
      const delayData = processor(layer, 'delay') || {};
      const reverbData = processor(layer, 'reverb') || {};

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = state.loop;
      if (state.loop) {
        source.loopStart = 0;
        const requested = Number(state.loopEnd);
        source.loopEnd = Math.min(buffer.duration, Number.isFinite(requested) && requested > 0.1 ? requested : Math.max(0.1, buffer.duration - 0.03));
      }

      const level = ctx.createGain();
      level.gain.setValueAtTime(0.0001, startAt);
      level.gain.linearRampToValueAtTime(clamp(layer.level, 0, 1), startAt + 0.05);

      const filter = ctx.createBiquadFilter();
      filter.type = ['lowpass', 'highpass', 'bandpass'].includes(filterData.mode) ? filterData.mode : 'lowpass';
      filter.frequency.value = clamp(filterData.cutoff_hz, 40, 18000);
      filter.Q.value = clamp(filterData.resonance, 0.1, 12);

      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDriveCurve(clamp(driveData.amount, 0, 0.7));
      shaper.oversample = '2x';

      const panner = ctx.createStereoPanner
        ? ctx.createStereoPanner()
        : ctx.createGain();
      if (panner.pan) panner.pan.value = clamp(panData.value, -1, 1);

      const dry = ctx.createGain();
      dry.gain.value = 1;

      source.connect(level).connect(filter).connect(shaper).connect(panner).connect(dry).connect(playBus);

      const delay = ctx.createDelay(1.4);
      delay.delayTime.value = clamp(delayData.time_sec ?? 0.32, 0.05, 1.2);
      const feedback = ctx.createGain();
      feedback.gain.value = clamp(delayData.feedback ?? 0.2, 0, 0.72);
      const delayWet = ctx.createGain();
      delayWet.gain.value = clamp(delayData.mix ?? 0, 0, 0.7) * 0.78;
      panner.connect(delay).connect(delayWet).connect(playBus);
      delay.connect(feedback).connect(delay);

      const reverbSend = ctx.createGain();
      reverbSend.gain.value = clamp(reverbData.mix ?? 0.12, 0, 0.75) * 0.85;
      panner.connect(reverbSend).connect(convolver);

      source.start(startAt);
      state.sources.push(source);
      state.nodes.push(source, level, filter, shaper, panner, dry, delay, feedback, delayWet, reverbSend);
      state.layerNodes.push({ level, filter, shaper, panner, delay, feedback, delayWet, reverbSend });
      state.longest = Math.max(state.longest, buffer.duration);
    }

    function updateLayer(index, layer) {
      if (!active || !ctx || !active.layerNodes[index]) return false;
      const nodes = active.layerNodes[index];
      const now = ctx.currentTime;
      const filter = processor(layer, 'filter') || {};
      const drive = processor(layer, 'drive') || {};
      const pan = processor(layer, 'pan') || {};
      const delay = processor(layer, 'delay') || {};
      const reverb = processor(layer, 'reverb') || {};
      try {
        nodes.level.gain.setTargetAtTime(clamp(layer.level, 0, 1), now, 0.03);
        nodes.filter.type = ['lowpass', 'highpass', 'bandpass'].includes(filter.mode) ? filter.mode : 'lowpass';
        nodes.filter.frequency.setTargetAtTime(clamp(filter.cutoff_hz, 40, 18000), now, 0.03);
        nodes.filter.Q.setTargetAtTime(clamp(filter.resonance, 0.1, 12), now, 0.03);
        nodes.shaper.curve = makeDriveCurve(clamp(drive.amount, 0, 0.7));
        if (nodes.panner.pan) nodes.panner.pan.setTargetAtTime(clamp(pan.value, -1, 1), now, 0.03);
        nodes.delay.delayTime.setTargetAtTime(clamp(delay.time_sec ?? 0.32, 0.05, 1.2), now, 0.03);
        nodes.feedback.gain.setTargetAtTime(clamp(delay.feedback ?? 0.2, 0, 0.72), now, 0.03);
        nodes.delayWet.gain.setTargetAtTime(clamp(delay.mix ?? 0, 0, 0.7) * 0.78, now, 0.03);
        nodes.reverbSend.gain.setTargetAtTime(clamp(reverb.mix ?? 0.12, 0, 0.75) * 0.85, now, 0.03);
      } catch (error) {
        return false;
      }
      return true;
    }

    function disposeState(state) {
      for (const source of state.sources) {
        try { source.stop(); } catch (error) {}
      }
      for (const node of state.nodes) {
        try { node.disconnect(); } catch (error) {}
      }
      state.sources = [];
      state.nodes = [];
      state.layerNodes = [];
    }

    async function play(candidate, options = {}) {
      if (!candidate || !Array.isArray(candidate.layers) || !candidate.layers.length) {
        throw new Error('Choose at least one source before playing.');
      }
      const context = ensure();
      if (context.state === 'suspended') await context.resume();
      stop(true);
      const request = ++requestId;

      let loaded;
      try {
        loaded = await Promise.all(candidate.layers.map(async layer => ({
          layer,
          buffer: await bufferFor(layer.source_url || layer.url)
        })));
      } catch (error) {
        throw error;
      }
      if (request !== requestId) return { cancelled: true };

      const startAt = context.currentTime + 0.04;
      const loop = !!options.loop;
      const state = {
        candidateId: candidate.id,
        label: candidate.label || 'candidate',
        loop,
        sources: [],
        nodes: [],
        layerNodes: [],
        longest: 0,
        loopEnd: Number.isFinite(Number(options.loopEnd)) ? Number(options.loopEnd) : null,
        startAt,
        timer: null,
        playBus: null,
        convolver: null
      };

      const playBus = context.createGain();
      playBus.gain.setValueAtTime(0.0001, startAt);
      playBus.gain.linearRampToValueAtTime(1, startAt + 0.06);
      playBus.connect(master);
      state.playBus = playBus;
      state.nodes.push(playBus);

      const reverbSeconds = Math.max(...candidate.layers.map(layer => {
        const reverb = processor(layer, 'reverb');
        return reverb ? reverb.seconds : 2.2;
      }));
      const convolver = context.createConvolver();
      convolver.buffer = impulseFor(reverbSeconds);
      const reverbReturn = context.createGain();
      reverbReturn.gain.value = 0.82;
      convolver.connect(reverbReturn).connect(playBus);
      state.convolver = convolver;
      state.nodes.push(convolver, reverbReturn);

      try {
        for (const item of loaded) {
          buildLayer(item.layer, item.buffer, startAt, playBus, convolver, state);
        }
      } catch (error) {
        disposeState(state);
        throw error;
      }

      state.actualLoopEnd = null;
      if (loop) {
        const requested = Number(state.loopEnd);
        state.actualLoopEnd = Math.min(...loaded.map(item => Math.min(
          item.buffer.duration,
          Number.isFinite(requested) && requested > 0.1 ? requested : Math.max(0.1, item.buffer.duration - 0.03)
        )));
      }

      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.setTargetAtTime(clamp((candidate.master && candidate.master.level) ?? 0.72, 0.1, 1), context.currentTime, 0.03);
      active = state;

      if (!loop) {
        state.timer = setTimeout(() => {
          if (active === state) stop();
        }, Math.max(250, (state.longest + 0.15) * 1000));
      }
      return { duration: state.longest, loop, loopEnd: state.actualLoopEnd };
    }

    function stop(immediate = false) {
      requestId++;
      if (!active || !ctx) return;
      const state = active;
      active = null;
      clearTimeout(state.timer);
      const now = ctx.currentTime;
      try {
        state.playBus.gain.cancelScheduledValues(now);
        state.playBus.gain.setValueAtTime(Math.max(0.0001, state.playBus.gain.value), now);
        state.playBus.gain.linearRampToValueAtTime(0.0001, now + (immediate ? 0.02 : 0.09));
      } catch (error) {}
      const delay = immediate ? 35 : 140;
      setTimeout(() => disposeState(state), delay);
    }

    function getState() {
      if (!active || !ctx) {
        return { playing: false, label: '', candidateId: null, loop: false, elapsed: 0, duration: 0 };
      }
      return {
        playing: true,
        label: active.label,
        candidateId: active.candidateId,
        loop: active.loop,
        loopEnd: active.actualLoopEnd || null,
        elapsed: Math.max(0, ctx.currentTime - active.startAt),
        duration: active.longest
      };
    }

    function isSupported() {
      return !!(window.AudioContext || window.webkitAudioContext);
    }

    function getRecordingStream() {
      const context = ensure();
      if (!context) return null;
      if (!recordDestination) {
        recordDestination = context.createMediaStreamDestination();
        compressor.connect(recordDestination);
      }
      return recordDestination.stream;
    }

    return { play, stop, getState, updateLayer, isSupported, getRecordingStream, getAnalyser: () => analyser };
  })();

  window.TasteEngine = engine;
})();
