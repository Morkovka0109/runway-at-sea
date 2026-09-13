/**
 * Procedural Web Audio. Visual round outcome is already known; this only scores it.
 */
export class AudioManager {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.engine = null;
    this._landed = false;
    this._crashed = false;
  }

  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  playEngine() {
    this.unlock();
    this._landed = false;
    this._crashed = false;
    if (!this.ctx || !this.settings.soundEnabled) return;
    this.stopEngine(true);

    const ctx = this.ctx;
    const noise = this._noiseSource(2);
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.012;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    filter.Q.value = 0.7;

    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    const mix = ctx.createGain();
    oscA.type = 'sawtooth';
    oscB.type = 'triangle';
    oscA.frequency.value = 78;
    oscB.frequency.value = 156;
    mix.gain.value = 0.0001;

    noise.connect(noiseGain).connect(filter);
    oscA.connect(mix);
    oscB.connect(mix);
    mix.connect(filter);
    filter.connect(ctx.destination);

    const now = ctx.currentTime;
    mix.gain.exponentialRampToValueAtTime(0.028, now + 0.35);
    noise.start();
    oscA.start();
    oscB.start();
    this.engine = { noise, oscA, oscB, mix, filter, noiseGain };
  }

  setEngineFromSpeed(speed) {
    if (!this.engine) return;
    if (!this.settings.soundEnabled) {
      this.stopEngine();
      return;
    }
    const v = Math.max(0, speed);
    this.engine.oscA.frequency.setTargetAtTime(68 + v * 0.38, this.ctx.currentTime, 0.08);
    this.engine.oscB.frequency.setTargetAtTime(132 + v * 0.22, this.ctx.currentTime, 0.08);
    this.engine.filter.frequency.setTargetAtTime(380 + v * 6.5, this.ctx.currentTime, 0.1);
  }

  stopEngine(immediate = false) {
    if (!this.engine) return;
    const { noise, oscA, oscB, mix } = this.engine;
    const stop = () => {
      try {
        noise.stop();
        oscA.stop();
        oscB.stop();
      } catch {
        // Already stopped.
      }
    };
    if (immediate || !this.ctx) {
      stop();
      this.engine = null;
      return;
    }
    const now = this.ctx.currentTime;
    mix.gain.cancelScheduledValues(now);
    mix.gain.setValueAtTime(Math.max(0.0001, mix.gain.value), now);
    mix.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    setTimeout(() => {
      stop();
    }, 300);
    this.engine = null;
  }

  playLanding() {
    if (this._landed) return;
    this._landed = true;
    this._noiseBurst(0.16, 0.045, 900);
    this._tone(92, 0.22, 0, 'sine', 0.1);
    this._tone(48, 0.18, 0.02, 'sine', 0.07);
  }

  playCrash() {
    if (this._crashed) return;
    this._crashed = true;
    this._noiseBurst(0.55, 0.1, 520);
    this._noiseBurst(0.28, 0.06, 1400);
    this._sweep(160, 42, 0.42, 'triangle', 0.11);
    this._tone(56, 0.28, 0, 'sine', 0.1);
    this._tone(38, 0.34, 0.04, 'sine', 0.08);
  }

  playSuccess() {
    this._tone(523, 0.12, 0, 'sine', 0.07);
    this._tone(659, 0.14, 0.09, 'sine', 0.07);
    this._tone(784, 0.22, 0.18, 'triangle', 0.08);
  }

  playFail() {
    this._sweep(210, 90, 0.28, 'square', 0.06);
    this._tone(70, 0.2, 0.08, 'sine', 0.07);
  }

  _noiseSource(seconds) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    return src;
  }

  _noiseBurst(duration, gainValue, cutoff) {
    this.unlock();
    if (!this.ctx || !this.settings.soundEnabled) return;
    const ctx = this.ctx;
    const src = this._noiseSource(duration + 0.05);
    src.loop = false;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(ctx.destination);
    const start = ctx.currentTime;
    gain.gain.linearRampToValueAtTime(gainValue, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    src.start(start);
    src.stop(start + duration + 0.02);
  }

  _tone(frequency, duration, delay = 0, type = 'sine', level = 0.08) {
    this.unlock();
    if (!this.ctx || !this.settings.soundEnabled) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.value = 0;
    osc.connect(gain).connect(this.ctx.destination);
    const start = this.ctx.currentTime + delay;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  _sweep(from, to, duration, type, level) {
    this.unlock();
    if (!this.ctx || !this.settings.soundEnabled) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), this.ctx.currentTime + duration);
    gain.gain.value = 0;
    osc.connect(gain).connect(this.ctx.destination);
    const start = this.ctx.currentTime;
    gain.gain.linearRampToValueAtTime(level, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }
}
