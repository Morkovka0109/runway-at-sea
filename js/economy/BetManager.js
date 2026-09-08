import { clamp } from '../utils/easing.js';

export class BetManager {
  constructor(config, settings) {
    this.config = config;
    this.settings = settings;
    const stored = settings.get('lastBet');
    this.amount = stored ?? config.betting.defaultAmount;
    this.locked = false;
  }

  getAmount() {
    return this.amount;
  }

  setAmount(value, maxAffordable = this.config.betting.max) {
    if (this.locked) return this.amount;
    const { min, max, step } = this.config.betting;
    const ceiling = Math.min(max, Math.max(min, maxAffordable));
    this.amount = clamp(Math.round(Number(value) / step) * step, min, ceiling);
    this.settings.set('lastBet', this.amount);
    return this.amount;
  }

  adjust(delta, maxAffordable) {
    return this.setAmount(this.amount + delta, maxAffordable);
  }

  lock() {
    this.locked = true;
  }

  unlock() {
    this.locked = false;
  }

  isLocked() {
    return this.locked;
  }
}
