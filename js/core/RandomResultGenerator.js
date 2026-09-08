import { clamp, roundTo } from '../utils/easing.js';

/**
 * Mathematical round resolver. Independent of UI, aircraft pose, and physics.
 * The visual flight only illustrates a result that already exists.
 */
export class RandomResultGenerator {
  constructor(config, rng = Math.random) {
    this.config = config;
    this.rng = rng;
  }

  /**
   * @returns {{
   *   result: 'SUCCESS' | 'FAIL',
   *   targetDistance: number,
   *   maxAltitude: number,
   *   flightDuration: number,
   *   multiplier: number
   * }}
   */
  generateRoundResult() {
    const result = this._pickResult();
    const spread = this.config.roundResult[result === 'SUCCESS' ? 'success' : 'fail'];
    const zone = this.config.roundResult.landingZone;

    let targetDistance = this._range(spread.targetDistance);
    if (result === 'SUCCESS') {
      targetDistance = clamp(targetDistance, zone.start, zone.end);
    } else {
      targetDistance = Math.max(targetDistance, zone.end + (spread.minOvershoot ?? 20));
    }

    return {
      result,
      targetDistance: roundTo(targetDistance, 1),
      maxAltitude: roundTo(this._range(spread.maxAltitude), 1),
      flightDuration: roundTo(this._range(spread.flightDuration), 2),
      multiplier: roundTo(this._range(spread.multiplier), this.config.multiplier.decimals),
    };
  }

  _pickResult() {
    const success = Math.max(0, this.config.successProbability);
    const fail = Math.max(0, this.config.failProbability);
    const total = success + fail || 1;
    return this.rng() < success / total ? 'SUCCESS' : 'FAIL';
  }

  _range({ min, max }) {
    return min + this.rng() * (max - min);
  }
}
