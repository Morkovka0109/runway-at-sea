const DEFAULTS = {
  soundEnabled: true,
  playbackSpeed: 1,
  lastBet: null,
};

export class SettingsManager {
  constructor(config, storage = window.localStorage) {
    this.config = config;
    this.storage = storage;
    this.key = `${config.storageKey}:settings`;
    this.values = {
      ...DEFAULTS,
      playbackSpeed: config.defaultPlaybackSpeed,
      lastBet: config.betting.defaultAmount,
    };
    this.load();
  }

  load() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      this.values = { ...this.values, ...parsed };
    } catch {
      // Keep defaults if storage is unavailable or corrupt.
    }
  }

  save() {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.values));
    } catch {
      // Ignore quota / private-mode failures.
    }
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
    this.save();
  }

  get roundResetDelayMs() {
    return this.config.roundResetDelayMs;
  }

  get playbackSpeed() {
    return this.values.playbackSpeed;
  }

  setPlaybackSpeed(speed) {
    this.set('playbackSpeed', speed);
  }

  get soundEnabled() {
    return this.values.soundEnabled;
  }

  toggleSound() {
    this.set('soundEnabled', !this.values.soundEnabled);
    return this.values.soundEnabled;
  }
}
