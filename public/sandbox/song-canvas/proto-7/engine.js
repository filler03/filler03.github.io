(() => {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);

  const engine = (() => {
    let ctx = null;
    let analyser = null;
    let master = null;
    let bus = null;
    let shape = null;
    let chorusDry = null;
    let chorusWet = null;
    let echoDry = null;
    let echoWet = null;
    let echoNode = null;
    let revDry = null;
    let revWet = null;
    let noiseBuffer = null;
    let spec = null;
    let voice = null;
    let failed = false;

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
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
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
      if (failed) return null;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        failed = true;
        return null;
      }
      try {
        ctx = new Ctx();
      } catch (err) {
        failed = true;
        return null;
      }
      noiseBuffer = makeNoise();
      bus = ctx.createGain();
      bus.gain.value = 0.55;
      shape = ctx.createWaveShaper();
      shape.oversample = '4x';
      shape.curve = makeDriveCurve(0.06);
      bus.connect(shape);

      const chorusOut = ctx.createGain();
      chorusDry = ctx.createGain();
      chorusWet = ctx.createGain();
      const chorusDelay = ctx.createDelay(0.1);
      chorusDelay.delayTime.value = 0.018;
      const chorusLfo = ctx.createOscillator();
      const chorusLfoGain = ctx.createGain();
      chorusLfo.frequency.value = 0.35;
      chorusLfoGain.gain.value = 0.004;
      chorusLfo.connect(chorusLfoGain).connect(chorusDelay.delayTime);
      chorusLfo.start();
      shape.connect(chorusDry).connect(chorusOut);
      shape.connect(chorusDelay).connect(chorusWet).connect(chorusOut);

      const echoOut = ctx.createGain();
      echoDry = ctx.createGain();
      echoWet = ctx.createGain();
      echoNode = ctx.createDelay(1);
      echoNode.delayTime.value = 0.32;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.32;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 2600;
      chorusOut.connect(echoDry).connect(echoOut);
      chorusOut.connect(echoNode).connect(tone);
      tone.connect(feedback).connect(echoNode);
      tone.connect(echoWet).connect(echoOut);

      const revOut = ctx.createGain();
      revDry = ctx.createGain();
      revWet = ctx.createGain();
      const convolver = ctx.createConvolver();
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
      master.gain.value = 0.72;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.82;
      revOut.connect(comp).connect(master);
      master.connect(analyser).connect(ctx.destination);
      return ctx;
    }

    function ensure() {
      if (!ctx) init();
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    function applyFx(p) {
      if (!ctx) return;
      shape.curve = makeDriveCurve(p.fx.drive);
      chorusWet.gain.setTargetAtTime(p.fx.chorus * 0.72, ctx.currentTime, 0.02);
      chorusDry.gain.setTargetAtTime(1 - p.fx.chorus * 0.22, ctx.currentTime, 0.02);
      echoWet.gain.setTargetAtTime(p.fx.delay * 0.62, ctx.currentTime, 0.02);
      echoNode.delayTime.setTargetAtTime(p.fx.delayTime || 0.32, ctx.currentTime, 0.02);
      revWet.gain.setTargetAtTime(p.fx.reverb * 0.9, ctx.currentTime, 0.02);
      revDry.gain.setTargetAtTime(1 - p.fx.reverb * 0.16, ctx.currentTime, 0.02);
      master.gain.setTargetAtTime(clamp(p.master.level, 0.2, 1), ctx.currentTime, 0.04);
    }

    function routeLfo(v, p) {
      v.lfoGain.disconnect();
      v.lfoGain.gain.cancelScheduledValues(ctx.currentTime);
      v.lfoGain.gain.value = 0;
      v.trem.gain.cancelScheduledValues(ctx.currentTime);
      v.trem.gain.value = 1;
      if (!p.lfo.on) return;
      if (p.lfo.target === 'pitch') {
        v.lfoGain.gain.value = p.lfo.depth * 170;
        for (const o of v.oscs) v.lfoGain.connect(o.osc.detune);
      } else if (p.lfo.target === 'filter') {
        v.lfoGain.gain.value = p.lfo.depth * 2000;
        v.lfoGain.connect(v.filter.frequency);
      } else {
        v.lfoGain.gain.value = p.lfo.depth * 0.42;
        v.lfoGain.connect(v.trem.gain);
      }
    }

    function play(patch, midi) {
      ensure();
      if (!ctx) return false;
      if (voice) hardStop();
      spec = patch;
      applyFx(patch);
      const now = ctx.currentTime + 0.01;
      const filter = ctx.createBiquadFilter();
      const amp = ctx.createGain();
      const trem = ctx.createGain();
      const oscs = [];
      const baseCutoff = clamp(patch.filter.cutoff, 40, 16000);
      filter.type = patch.filter.type;
      filter.Q.value = patch.filter.q;
      filter.frequency.setValueAtTime(baseCutoff, now);
      const envAmount = Number(patch.filter.envAmount) || 0;
      if (envAmount !== 0) {
        const peak = clamp(baseCutoff * Math.pow(2, envAmount * 4), 40, 18000);
        filter.frequency.linearRampToValueAtTime(peak, now + Math.max(0.001, patch.filter.env.a));
        filter.frequency.linearRampToValueAtTime(
          clamp(baseCutoff + (peak - baseCutoff) * patch.filter.env.s, 40, 18000),
          now + Math.max(0.002, patch.filter.env.a + patch.filter.env.d)
        );
      }
      for (const key of ['osc1', 'osc2']) {
        const layer = patch[key];
        if (!layer || !layer.on) continue;
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
      if (patch.noise.on) {
        noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = noiseBuffer;
        noiseSrc.loop = true;
        noiseGain = ctx.createGain();
        noiseGain.gain.value = patch.noise.level;
        noiseSrc.connect(noiseGain).connect(filter);
        noiseSrc.start(now);
      }
      amp.gain.setValueAtTime(0.0001, now);
      amp.gain.linearRampToValueAtTime(0.82, now + Math.max(0.001, patch.amp.a));
      amp.gain.linearRampToValueAtTime(
        Math.max(0.0001, 0.82 * patch.amp.s),
        now + Math.max(0.002, patch.amp.a + patch.amp.d)
      );
      filter.connect(amp).connect(trem).connect(bus);
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.type = patch.lfo.wave;
      lfo.frequency.value = patch.lfo.rate;
      lfo.connect(lfoGain);
      lfo.start(now);
      voice = {
        midi, filter, amp, trem, oscs, noiseSrc, noiseGain, lfo, lfoGain,
        baseCutoff, released: false
      };
      routeLfo(voice, patch);
      return true;
    }

    function stopNodes(v) {
      for (const o of v.oscs) {
        try { o.osc.stop(); } catch (err) {}
        try { o.osc.disconnect(); o.gain.disconnect(); } catch (err) {}
      }
      try { if (v.noiseSrc) { v.noiseSrc.stop(); v.noiseSrc.disconnect(); } } catch (err) {}
      try { if (v.noiseGain) v.noiseGain.disconnect(); } catch (err) {}
      try { v.lfo.stop(); v.lfo.disconnect(); v.lfoGain.disconnect(); } catch (err) {}
      try { v.filter.disconnect(); v.amp.disconnect(); v.trem.disconnect(); } catch (err) {}
    }

    function hardStop() {
      if (!voice) return;
      const v = voice;
      voice = null;
      stopNodes(v);
    }

    function release() {
      if (!voice || voice.released || !ctx) return;
      const v = voice;
      const p = spec;
      v.released = true;
      const now = ctx.currentTime;
      const rel = Math.max(0.05, p.amp.r);
      v.amp.gain.cancelScheduledValues(now);
      v.amp.gain.setValueAtTime(Math.max(0.0001, v.amp.gain.value), now);
      v.amp.gain.exponentialRampToValueAtTime(0.0001, now + rel);
      try {
        v.filter.frequency.cancelScheduledValues(now);
        v.filter.frequency.setValueAtTime(Math.max(40, v.filter.frequency.value), now);
        v.filter.frequency.linearRampToValueAtTime(v.baseCutoff, now + Math.max(0.02, p.filter.env.r));
      } catch (err) {}
      setTimeout(() => {
        if (voice === v) {
          voice = null;
          stopNodes(v);
        }
      }, (rel + 0.14) * 1000);
    }

    function stop() {
      hardStop();
      if (!ctx) return;
      for (const param of [chorusWet, echoWet, revWet]) {
        try { param.gain.cancelScheduledValues(ctx.currentTime); } catch (err) {}
      }
    }

    function getAnalyser() { return analyser; }
    function isReady() { return !!ctx; }
    function isPlaying() { return !!voice && !voice.released; }

    return { play, release, stop, ensure, getAnalyser, isReady, isPlaying };
  })();

  window.TimbreEngine = engine;
})();
