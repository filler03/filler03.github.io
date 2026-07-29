const SFX = (() => {
  let ctx = null;
  const SCALE = [261.63, 293.66, 329.63, 392.00, 440.00];

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
      scheduleNote(SCALE[index % SCALE.length], 0.4, 0.15, 0.05);
    },
    playComplete() {
      ensure();
      if (!ctx) return;
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, i) => {
        scheduleNote(freq, 0.5, 0.12, i * 0.15 + 0.05);
      });
    }
  };
})();
