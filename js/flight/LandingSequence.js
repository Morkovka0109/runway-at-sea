import { clamp, damp } from '../utils/easing.js';
import { FlightPhase } from './FlightController.js';

export const LandingStage = {
  APPROACH: 'APPROACH',
  DECELERATE: 'DECELERATE',
  DESCEND: 'DESCEND',
  FLARE: 'FLARE',
  ALIGN: 'ALIGN',
  TOUCHDOWN: 'TOUCHDOWN',
  SETTLE: 'SETTLE',
  STOP: 'STOP',
  CRITICAL: 'CRITICAL',
  MISS: 'MISS',
  OVERSHOOT: 'OVERSHOOT',
  STALL: 'STALL',
  DIVE: 'DIVE',
  FALL: 'FALL',
  IMPACT: 'IMPACT',
};

/**
 * Separate landing / miss finale. FlightController only delivers the plane
 * to the approach handoff; this class owns touchdown, settle, and crash.
 */
export class LandingSequence {
  constructor(config, aircraft, ship) {
    this.config = config;
    this.aircraft = aircraft;
    this.ship = ship;
    this.reset();
  }

  reset() {
    this.active = false;
    this.complete = false;
    this.result = null;
    this.elapsed = 0;
    this.touchElapsed = 0;
    this.touched = false;
    this.falling = false;
    this.impacted = false;
    this.state = null;
    this.entry = null;
    this.plan = null;
    this._touchPulse = false;
    this._splashPulse = false;
    this.impactElapsed = 0;
    this.fx = this._idleFx();
  }

  /**
   * @param {object} handoff pose from FlightController
   * @param {{ result: 'SUCCESS' | 'FAIL', targetDistance: number }} roundResult
   * @param {object} [flightPlan]
   */
  begin(handoff, roundResult, flightPlan = null) {
    const spec = this.config.flight.landing;
    const world = this.config.flight.world;
    const deck = this.ship.deck;
    const zone = this.config.roundResult.landingZone;
    const result = roundResult.result;

    this.reset();
    this.active = true;
    this.result = result;
    this.plan = {
      result,
      deckAltitude: world.deckAltitude,
      waterLevel: world.waterLevel,
      zoneStart: zone.start,
      zoneEnd: zone.end,
      aimDistance: this.ship.landingAim.distance,
      targetDistance: roundResult.targetDistance,
      crashPoint: flightPlan?.crashPoint ?? roundResult.targetDistance,
      deckEnd: deck.end,
      spec,
    };

    const vx = Number.isFinite(handoff.vx) ? handoff.vx : Math.max(80, handoff.speed ?? spec.success.approachSpeed);
    const vy = Number.isFinite(handoff.vy) ? handoff.vy : -18;
    this.entry = {
      distance: handoff.distance,
      altitude: handoff.altitude,
      pitch: handoff.pitch ?? -6,
      vx,
      vy,
    };
    this.state = {
      distance: this.entry.distance,
      altitude: this.entry.altitude,
      pitch: this.entry.pitch,
      vx,
      vy,
    };
  }

  update(deltaTime) {
    if (!this.active || !this.state) return this._idlePose();
    const dt = clamp(deltaTime, 0, this.config.flight.path.maxDt * 4);
    this._syncFromAircraft();
    if (this.complete) return this._toPose(this._stage());

    this.elapsed += dt;
    this._touchPulse = false;
    this._splashPulse = false;
    this.fx.dust = damp(this.fx.dust, 0, 3.4, dt);
    this.fx.splash = damp(this.fx.splash, 0, 2.6, dt);
    this.fx.shake = damp(this.fx.shake, 0, 8, dt);

    if (this.result === 'SUCCESS') this._updateSuccess(dt);
    else this._updateFail(dt);

    if (this.result === 'SUCCESS' && this.elapsed > 10) this.complete = true;

    this.fx.zone = 0;
    return this._toPose(this._stage());
  }

  resolveSurfaces() {
    if (!this.active || this.complete || !this.state) return;
    this._syncFromAircraft();
    if (this.result === 'SUCCESS') {
      if (!this.touched && this._onShip()) {
        this.touched = true;
        this.touchElapsed = 0;
        this._pulseTouchdown();
      }
    } else if (!this.impacted && this._onWater()) {
      this.onAircraftWaterImpact();
    }
  }

  isComplete() {
    return this.complete;
  }

  _syncFromAircraft() {
    const body = this.aircraft?.body;
    if (!body || !this.state) return;
    this.state.distance = body.x;
    this.state.altitude = body.y;
    this.state.vx = Math.max(0, body.vx);
    this.state.vy = body.vy;
    this.state.pitch = body.rotation;
  }

  _planeProbe() {
    return {
      x: this.state.distance,
      y: this.state.altitude,
      radius: this.aircraft?.collider?.radius ?? 18,
      enabled: true,
      shape: 'circle',
    };
  }

  _overDeckX() {
    const start = this.plan?.zoneStart ?? this.ship?.deck?.start ?? 1280;
    const end = this.plan?.zoneEnd ?? this.ship?.deck?.end ?? start + 170;
    const x = this.state?.distance ?? 0;
    return x >= start - 14 && x <= end + 70;
  }

  _onShip() {
    if (!this._overDeckX()) return false;
    const deck = this.plan?.deckAltitude ?? 26;
    return this.state.altitude <= deck + 10;
  }

  _onWater() {
    const water = this.plan?.waterLevel ?? 0;
    if (this.state.altitude <= water + 2.4) return true;
    return !!this.ship?.waterCollider?.overlaps(this._planeProbe());
  }

  _updateSuccess(dt) {
    const { spec, deckAltitude } = this.plan;
    const s = spec.success;
    if (!this.touched) {
      if (this._onShip()) {
        this.touched = true;
        this.touchElapsed = 0;
        this._pulseTouchdown();
      }
      return;
    }

    this.touchElapsed += dt;
    const settled =
      this.state.vx < 3.5 &&
      Math.abs(this.state.altitude - deckAltitude) < 2.2 &&
      this.touchElapsed > s.settleDuration * 0.35;
    if (settled || this.touchElapsed >= s.settleDuration + s.stopDuration) {
      this.complete = true;
    }
  }

  /**
   * One-shot water contact during FAIL. Visual/physics only — does not roll the result.
   */
  onAircraftWaterImpact() {
    if (this.result !== 'FAIL' || this.impacted || !this.active) return false;
    this.impacted = true;
    this.impactElapsed = 0;
    this.falling = true;
    this._pulseSplash();
    return true;
  }

  _updateFail(dt) {
    const f = this.plan.spec.fail;
    const pastDeck = this.state.distance >= (this.plan.zoneStart ?? 1280) - 14;
    if (pastDeck || this._overDeckX() || this.state.altitude < 40 || this.state.vx < (this.config.physics?.stallSpeed ?? 72)) {
      this.falling = true;
    }
    if (this.impacted) {
      this.impactElapsed += dt;
      if (this.impactElapsed >= (f.waterHold ?? 0.55)) this.complete = true;
      return;
    }
    if (this._onWater() || (this.falling && this.state.altitude <= 8)) this.onAircraftWaterImpact();
  }

  _stage() {
    if (this.result === 'SUCCESS') {
      if (this.complete || (this.touched && this.state.vx < 4)) return LandingStage.STOP;
      if (this.touched && this.touchElapsed < 0.16) return LandingStage.TOUCHDOWN;
      if (this.touched) return LandingStage.SETTLE;
      const s = this.plan.spec.success;
      const above = this.state.altitude - this.plan.deckAltitude;
      const flare = s.flareAltitude ?? 18;
      if (above > flare + 22) return this.state.vx > (s.approachSpeed ?? 92) * 0.9 ? LandingStage.APPROACH : LandingStage.DESCEND;
      if (above > flare + 6) return LandingStage.DESCEND;
      if (above > 3.4) return LandingStage.FLARE;
      return LandingStage.ALIGN;
    }

    if (this.impacted || this.complete) return LandingStage.IMPACT;
    if (this.falling) {
      if (this.state.altitude < 36) return LandingStage.FALL;
      if (this.state.pitch < -18) return LandingStage.DIVE;
      return LandingStage.STALL;
    }
    return LandingStage.CRITICAL;
  }

  _zoneGlow(stage) {
    if (this.result !== 'SUCCESS') {
      if (stage === LandingStage.CRITICAL || stage === LandingStage.MISS) return 0.22;
      return 0;
    }
    if (stage === LandingStage.STOP) return 0.18;
    if (stage === LandingStage.TOUCHDOWN || stage === LandingStage.SETTLE) return 0.7;
    if (stage === LandingStage.ALIGN || stage === LandingStage.FLARE) return 0.55;
    return 0.28;
  }

  _pulseTouchdown() {
    this._touchPulse = true;
    this.fx.dust = 1;
    this.fx.shake = 0.55;
  }

  _pulseSplash() {
    this._splashPulse = true;
    this.fx.splash = 1;
    this.fx.shake = 0.7;
  }

  _deckBlend() {
    return 0;
  }

  _toPose(stage) {
    const speed = Math.hypot(this.state.vx, this.state.vy);
    const phase = this.result === 'SUCCESS' ? FlightPhase.LANDING : FlightPhase.CRASH;
    return {
      t: 1,
      distance: this.state.distance,
      altitude: this.state.altitude,
      speed,
      pitch: this.state.pitch,
      vx: this.state.vx,
      vy: this.state.vy,
      x: this.state.distance,
      y: this.state.altitude,
      phase,
      landingStage: stage,
      landed: this.touched && this.result === 'SUCCESS',
      overDeck: this._overDeckX(),
      deckBlend: this._deckBlend(stage),
      effects: {
        zone: 0,
        dust: this.fx.dust,
        splash: this.fx.splash,
        shake: this.fx.shake,
        smoke: this.result === 'FAIL' && (this.falling || this.impacted || this.elapsed > 0.35) ? 1 : 0,
        successGlow: 0,
        touchdownPulse: this._touchPulse,
        splashPulse: this._splashPulse,
      },
    };
  }

  _idleFx() {
    return { zone: 0, dust: 0, splash: 0, shake: 0 };
  }

  _idlePose() {
    const start = this.config.flight.path.startPosition;
    return {
      t: 0,
      distance: start.distance,
      altitude: start.altitude,
      speed: 0,
      pitch: 0,
      x: start.distance,
      y: start.altitude,
      phase: 'idle',
      landingStage: null,
      effects: this._idleFx(),
    };
  }
}
