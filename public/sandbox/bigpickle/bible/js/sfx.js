const SFX = (() => {
  let ctx = null;
  const SCALE = [
    261.63, 293.66, 329.63, 392.00, 440.00,
    523.25, 587.33, 659.25, 783.99, 880.00
  ];

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
  }

  function scheduleNote(freq, duration, volume, delay) {
    if (!ctx) return;
    try {
      const t = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.04);
      gain.gain.linearRampToValueAtTime(0, t + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.1);
    } catch (e) {}
  }

  return {
    ensure,
    playPlacement(index) {
      ensure();
      if (!ctx) return;
      const freq = SCALE[index % SCALE.length];
      const roll = Math.random();
      if (roll < 0.15) {
        scheduleNote(freq, 0.5, 0.09, 0.05);
        scheduleNote(freq * 1.5, 0.5, 0.06, 0.05);
        scheduleNote(freq * 2, 0.5, 0.04, 0.05);
      } else if (roll < 0.35) {
        scheduleNote(freq, 0.4, 0.12, 0.05);
        scheduleNote(freq * 1.5, 0.4, 0.08, 0.05);
      } else {
        scheduleNote(freq, 0.4, 0.15, 0.05);
      }
    },
    playComplete() {
      ensure();
      if (!ctx) return;
      const notes = [
        523.25, 659.25, 783.99, 1046.50,
        1174.66, 1318.51, 1567.98, 1760.00
      ];
      notes.forEach((freq, i) => {
        const vol = 0.12 - i * 0.008;
        scheduleNote(freq, 0.6 + i * 0.05, vol, i * 0.12 + 0.05);
      });
    }
  };
})();
