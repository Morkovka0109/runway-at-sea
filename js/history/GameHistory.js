/**
 * Virtual-round log. Stores chip results only — never payment data.
 */
export class GameHistory {
  constructor(config, storage = window.localStorage) {
    this.config = config;
    this.storage = storage;
    this.key = `${config.storageKey}:history-v2`;
    this.entries = [];
    this.nextRoundNumber = 1;
    this.load();
  }

  load() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed;
        this.nextRoundNumber = this._maxRound(parsed) + 1;
        return;
      }
      if (parsed && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries;
        this.nextRoundNumber = parsed.nextRoundNumber ?? this._maxRound(parsed.entries) + 1;
      }
    } catch {
      this.entries = [];
      this.nextRoundNumber = 1;
    }
  }

  save() {
    try {
      this.storage.setItem(
        this.key,
        JSON.stringify({
          nextRoundNumber: this.nextRoundNumber,
          entries: this.entries,
        }),
      );
    } catch {
      // Ignore storage failures.
    }
  }

  nextNumber() {
    return this.nextRoundNumber;
  }

  push(entry) {
    const roundNumber = entry.roundNumber ?? this.nextRoundNumber;
    const record = { ...entry, roundNumber };
    this.entries.unshift(record);
    this.entries = this.entries.slice(0, this.config.historyLimit);
    this.nextRoundNumber = Math.max(this.nextRoundNumber, roundNumber) + 1;
    this.save();
    return this.entries;
  }

  list() {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
    this.nextRoundNumber = 1;
    this.save();
  }

  _maxRound(entries) {
    return entries.reduce((max, item) => Math.max(max, Number(item.roundNumber) || 0), 0);
  }
}
