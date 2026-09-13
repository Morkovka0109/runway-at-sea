import { clamp, damp, inverseLerp, lerp, roundTo } from '../utils/easing.js';

/**
 * Round multiplier. Not a Crash tick-up: the coefficient is computed
 * from this round's result parameters, then revealed along flight phases.
 * Collectible digits raise the live display inside that already-computed peak.
 * Returns data only — no DOM.
 */
export class MultiplierSystem {
  constructor(config) {
    this.config = config;
    this.profile = null;
    this.windows = null;
    this.current = config.multiplier.start;
    this.display = config.multiplier.start;
    this.rocketPenalty = 0;
    this._hitBonus = 0;
    this._hitIds = new Set();
    this._rocketHitIds = new Set();
    this._pulse = 0;
  }

  /**
   * @param {{ result: 'SUCCESS' | 'FAIL', targetDistance: number, maxAltitude: number, flightDuration: number }} roundResult
   * @returns {{ result: string, value: number, peak: number, score: number }}
   */
  calculateMultiplier(roundResult) {
    const spec = this.config.multiplier;
    const isSuccess = roundResult.result === 'SUCCESS';
    const band = isSuccess ? spec.success : spec.fail;
    const score = this._score(roundResult, isSuccess);
    const peak = lerp(band.min, band.max, score);
    const value = isSuccess ? peak : spec.fail.settled;

    return {
      result: roundResult.result,
      value: roundTo(value, spec.decimals),
      peak: roundTo(peak, spec.decimals),
      score: roundTo(score, 3),
    };
  }

  bind(roundResult, flightPlan = null) {
    this.profile = this.calculateMultiplier(roundResult);
    this.windows = flightPlan?.windows ?? null;
    this.current = this.config.multiplier.start;
    this.display = this.config.multiplier.start;
    this.rocketPenalty = 0;
    this._hitBonus = 0;
    this._hitIds = new Set();
    this._rocketHitIds = new Set();
    this._pulse = 0;
    return this.profile;
  }

  /**
   * Apply a collected path digit to the live coefficient.
   * Each digit adds a bonus on top of the current display, capped by this
   * round's peak so the predetermined payout formula is not replaced.
   */
  onMultiplierNumberHit(number, meta = {}) {
    const spec = this.config.multiplier;
    const pick = this.config.numberPickups ?? {};
    const min = pick.numberMin ?? 1;
    const max = pick.numberMax ?? 10;
    const n = clamp(Math.round(Number(number)), min, max);
    const id = meta.id;
    if (id != null) {
      if (this._hitIds.has(id)) return null;
      this._hitIds.add(id);
    }
    if (!this.profile) return null;

    const start = spec.start;
    const peak = this.profile.peak;
    const unit = pick.multiplierBonus ?? 0.06;
    const bump = roundTo(n * unit, spec.decimals);
    const floor = Math.max(this.current, this.display, start);
    const next = roundTo(Math.min(peak, floor + bump), spec.decimals);
    const delta = roundTo(Math.max(0, next - floor), spec.decimals);
    this._hitBonus = roundTo(this._hitBonus + delta, spec.decimals);
    this.current = next;
    this._pulse = 1;
    return {
      number: n,
      current: this.current,
      mapped: next,
      delta,
      peak,
    };
  }

  /**
   * Rocket strike. Lowers the live coefficient by the configured penalty.
   * Does not change the predetermined peak / payout.
   */
  onRocketHit(rocket) {
    const spec = this.config.multiplier;
    const rockets = this.config.rockets ?? {};
    const id = rocket?.id;
    if (id != null) {
      if (this._rocketHitIds.has(id)) return null;
      this._rocketHitIds.add(id);
    }
    if (!this.profile) return null;
    const penalty = rocket?.damage?.multiplier ?? rockets.rocketMultiplierPenalty ?? 0.18;
    this.rocketPenalty = roundTo(this.rocketPenalty + penalty, spec.decimals);
    this._pulse = 1;
    const live = roundTo(Math.max(rockets.minMultiplier ?? spec.start, this.current - this.rocketPenalty), spec.decimals);
    return {
      id,
      penalty: roundTo(penalty, spec.decimals),
      current: live,
      rocketPenalty: this.rocketPenalty,
      peak: this.profile.peak,
    };
  }

  /**
   * Display value for the current pose. Follows phase waypoints of this round,
   * not an independent per-millisecond growth function. Collected digits can
   * raise the live value up to this round's peak; settlement is unchanged.
   */
  sample(pose = {}, dt = 0) {
    const spec = this.config.multiplier;
    if (!this.profile) {
      return {
        value: spec.start,
        peak: spec.start,
        settled: spec.start,
        result: null,
        phase: pose.phase ?? 'idle',
        pulse: 0,
      };
    }

    const phase = pose.phase ?? 'CRUISE';
    const t = clamp(pose.t ?? 0, 0, 1);
    const phaseValue = this._displayAt(t);
    const boosted = Math.max(phaseValue, this.current);
    const live = Math.max(spec.start, boosted - this.rocketPenalty);
    const settleFail = phase === 'CRASH' || (this.profile.result === 'FAIL' && t >= 1);
    const target = settleFail ? this.profile.value : live;
    const step = dt > 0 ? dt : 0;
    this.display = step > 0 ? damp(this.display, target, this._pulse > 0.2 ? 22 : 11, step) : target;
    this._pulse *= Math.exp(-10 * (step || 0.016));

    return {
      value: roundTo(this.display, spec.decimals),
      peak: this.profile.peak,
      settled: this.profile.value,
      result: this.profile.result,
      phase,
      pulse: this._pulse,
    };
  }

  payout(bet) {
    if (!this.profile || this.profile.result !== 'SUCCESS') return 0;
    return roundTo(bet * this.profile.value, 2);
  }

  _score(roundResult, isSuccess) {
    const spec = this.config.multiplier;
    const ranges = this.config.roundResult[isSuccess ? 'success' : 'fail'];
    const weights = isSuccess ? spec.success.weights : spec.fail.weights;
    const altitude = inverseLerp(ranges.maxAltitude.min, ranges.maxAltitude.max, roundResult.maxAltitude);
    const distance = inverseLerp(
      ranges.targetDistance.min,
      ranges.targetDistance.max,
      roundResult.targetDistance,
    );
    const duration = inverseLerp(
      ranges.flightDuration.min,
      ranges.flightDuration.max,
      roundResult.flightDuration,
    );
    return clamp(
      altitude * weights.altitude + distance * weights.distance + duration * weights.duration,
      0,
      1,
    );
  }

  _displayAt(t) {
    const keys = this._phaseKeys();
    if (t <= keys[0].t) return keys[0].value;
    const last = keys[keys.length - 1];
    if (t >= last.t) return last.value;

    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t < t) i += 1;
    const a = keys[i];
    const b = keys[i + 1];
    const local = (t - a.t) / (b.t - a.t || 1);
    return lerp(a.value, b.value, local);
  }

  _phaseKeys() {
    const spec = this.config.multiplier;
    const start = spec.start;
    const peak = this.profile.peak;
    const settled = this.profile.value;
    const phases = spec.phases;
    const w = this.windows;
    const fail = this.profile.result === 'FAIL';

    const keys = [
      { t: 0, value: start },
      { t: w?.takeoffEnd ?? phases.TAKEOFF.at, value: lerp(start, peak, phases.TAKEOFF.progress) },
      { t: w?.climbEnd ?? phases.CLIMB.at, value: lerp(start, peak, phases.CLIMB.progress) },
      { t: w?.cruiseEnd ?? phases.CRUISE.at, value: lerp(start, peak, phases.CRUISE.progress) },
      { t: w?.descentEnd ?? phases.DESCENT.at, value: lerp(start, peak, phases.DESCENT.progress) },
      { t: 1, value: fail ? settled : lerp(start, peak, phases.LANDING.progress) },
    ];
    return keys;
  }
}
