import { roundTo } from '../utils/easing.js';

/**
 * Virtual chip ledger only. No payments, no real money, no cash-out.
 * Debit and credit are idempotent per round id.
 */
export class Wallet {
  constructor(config, storage = window.localStorage) {
    this.config = config;
    this.storage = storage;
    this.key = `${config.storageKey}:wallet`;
    this.currency = config.currencyCode;
    this.balance = config.startingBalance;
    this._debitRoundId = null;
    this._creditRoundId = null;
    this.load();
  }

  load() {
    try {
      const raw = this.storage.getItem(this.key);
      if (raw == null) return;
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) this.balance = roundTo(parsed, 2);
    } catch {
      this.balance = this.config.startingBalance;
    }
  }

  save() {
    try {
      this.storage.setItem(this.key, String(this.balance));
    } catch {
      // Prototype: ignore storage failures.
    }
  }

  getBalance() {
    return this.balance;
  }

  canAfford(amount) {
    return this.balance >= amount && amount > 0;
  }

  /**
   * Start of round: balance -= bet. Same roundId never debits twice.
   */
  placeBet(bet, roundId = null) {
    if (roundId != null && this._debitRoundId === roundId) {
      return { balance: this.balance, applied: false };
    }
    const amount = roundTo(bet, 2);
    if (!this.canAfford(amount)) {
      throw new Error('Insufficient virtual balance');
    }
    this.balance = roundTo(this.balance - amount, 2);
    this._debitRoundId = roundId;
    this.save();
    return { balance: this.balance, applied: true };
  }

  /**
   * SUCCESS: balance += winAmount. Same roundId never credits twice.
   */
  creditWin(winAmount, roundId = null) {
    if (roundId != null && this._creditRoundId === roundId) {
      return { balance: this.balance, applied: false };
    }
    const amount = roundTo(Math.max(0, winAmount), 2);
    if (amount <= 0) {
      this._creditRoundId = roundId;
      return { balance: this.balance, applied: false };
    }
    this.balance = roundTo(this.balance + amount, 2);
    this._creditRoundId = roundId;
    this.save();
    return { balance: this.balance, applied: true };
  }

  reset() {
    this.balance = this.config.startingBalance;
    this._debitRoundId = null;
    this._creditRoundId = null;
    this.save();
    return this.balance;
  }
}
