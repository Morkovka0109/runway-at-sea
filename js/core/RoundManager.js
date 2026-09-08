let nextId = 1;

export class RoundManager {
  constructor() {
    this.current = null;
  }

  create({ bet, generated, flightPlan, multiplier, roundNumber }) {
    const profile = multiplier ?? {
      result: generated.result,
      value: generated.result === 'SUCCESS' ? generated.multiplier : 0,
      peak: generated.multiplier,
    };
    this.current = {
      id: nextId++,
      roundNumber: roundNumber ?? nextId - 1,
      bet,
      result: generated.result,
      outcome: generated.result,
      multiplier: profile.value,
      peak: profile.peak,
      targetDistance: generated.targetDistance,
      maxAltitude: generated.maxAltitude,
      flightDuration: generated.flightDuration,
      generated,
      flightPlan,
      multiplierProfile: profile,
      startedAt: Date.now(),
      endedAt: null,
      betDebited: false,
      winCredited: false,
    };
    return this.current;
  }

  markBetDebited() {
    if (!this.current || this.current.betDebited) return false;
    this.current.betDebited = true;
    return true;
  }

  markWinCredited() {
    if (!this.current || this.current.winCredited) return false;
    if (this.current.result !== 'SUCCESS') return false;
    this.current.winCredited = true;
    return true;
  }

  markEnded() {
    if (this.current) this.current.endedAt = Date.now();
    return this.current;
  }

  getCurrent() {
    return this.current;
  }

  clear() {
    this.current = null;
  }

  summary() {
    const round = this.current;
    if (!round) return null;
    return {
      id: round.id,
      bet: round.bet,
      outcome: round.result,
      multiplier: round.multiplier,
      payout: round.result === 'SUCCESS' ? round.bet * round.multiplier : 0,
      endedAt: round.endedAt ?? Date.now(),
    };
  }
}
