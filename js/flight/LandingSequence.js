import { clamp, damp, easeInQuad, easeOutCubic, easeOutQuad, lerp, smoothstep } from '../utils/easing.js';
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
    this.aircraft.setPose(this._toPose(LandingStage.APPROACH));
  }

  update(deltaTime) {
    if (!this.active || !this.state) return this._idlePose();
    const dt = clamp(deltaTime, 0, this.config.flight.path.maxDt * 4);
    if (this.complete) return this._toPose(this._stage());

    this.elapsed += dt;
    this._touchPulse = false;
    this._splashPulse = false;
    this.fx.dust = damp(this.fx.dust, 0, 3.4, dt);
    this.fx.splash = damp(this.fx.splash, 0, 2.6, dt);
    this.fx.shake = damp(this.fx.shake, 0, 8, dt);

    if (this.result === 'SUCCESS') this._updateSuccess(dt);
    else this._updateFail(dt);

    if (this.elapsed > 6.5) this.complete = true;

    const stage = this._stage();
    this.fx.zone = this._zoneGlow(stage);
    const pose = this._toPose(stage);
    this.aircraft.setPose(pose);
    return pose;
  }

  isComplete() {
    return this.complete;
  }

  _updateSuccess(dt) {
    const { spec, deckAltitude, aimDistance, zoneEnd, deckEnd } = this.plan;
    const s = spec.success;
    const preTouch = s.approachDuration + s.decelerateDuration + s.descendDuration + s.flareDuration + s.alignDuration;

    if (!this.touched) {
      const u = clamp(this.elapsed / preTouch, 0, 1);
      const travel = easeOutCubic(u);
      const aim = clamp(aimDistance, this.entry.distance + 12, zoneEnd - 8);
      this.state.distance = lerp(this.entry.distance, aim, travel);
      this.state.vx = ((aim - this.entry.distance) * 3 * (1 - u) ** 2) / preTouch;

      const descendU = smoothstep(0, 0.62, u);
      const flareU = smoothstep(0.48, 0.86, u);
      const alignU = smoothstep(0.78, 1, u);
      const approachAlt = lerp(this.entry.altitude, deckAltitude + s.flareAltitude, descendU);
      const flared = lerp(approachAlt, deckAltitude + 3.2, flareU);
      this.state.altitude = lerp(flared, deckAltitude + 0.6, alignU);
      this.state.vy = (this.state.altitude - (this._prevAlt ?? this.state.altitude)) / Math.max(dt, 1e-4);

      const approachPitch = lerp(this.entry.pitch, s.approachPitch, smoothstep(0, 0.32, u));
      const flarePitch = lerp(approachPitch, s.flarePitch, flareU);
      this.state.pitch = lerp(flarePitch, s.alignPitch, alignU);

      const reachedDeck = this.state.altitude <= deckAltitude + 1.15 && u > 0.72;
      const timedOut = this.elapsed >= preTouch;
      if (reachedDeck || timedOut) {
        this.touched = true;
        this.touchElapsed = 0;
        this.state.altitude = deckAltitude;
        this.state.vy = s.bounce;
        this.state.vx = Math.max(s.touchdownSpeed, this.state.vx * 0.55);
        this.state.distance = clamp(this.state.distance, this.plan.zoneStart, zoneEnd);
        this._pulseTouchdown();
      }
      this._prevAlt = this.state.altitude;
      return;
    }

    this.touchElapsed += dt;
    const x = this.state.altitude - deckAltitude;
    this.state.vy += (-s.spring * x - s.damping * this.state.vy) * dt;
    this.state.altitude = Math.max(deckAltitude, this.state.altitude + this.state.vy * dt);
    this.state.vx = damp(this.state.vx, 0, s.brake, dt);
    this.state.pitch = damp(this.state.pitch, 0, 9, dt);
    this.state.distance = Math.min(deckEnd - 10, this.state.distance + this.state.vx * dt);

    const settled =
      this.state.vx < 3.5 &&
      Math.abs(this.state.altitude - deckAltitude) < 0.35 &&
      Math.abs(this.state.vy) < 2.5 &&
      this.touchElapsed > s.settleDuration * 0.45;

    if (settled || this.touchElapsed >= s.settleDuration + s.stopDuration) {
      this.state.vx = 0;
      this.state.vy = 0;
      this.state.altitude = deckAltitude;
      this.state.pitch = 0;
      this.complete = true;
    }
  }

  _updateFail(dt) {
    const { spec, deckAltitude, waterLevel, zoneStart, zoneEnd, crashPoint } = this.plan;
    const f = spec.fail;
    const criticalEnd = f.criticalDuration;
    const missEnd = criticalEnd + f.missDuration;
    const overshootEnd = missEnd + f.overshootDuration;
    const stallEnd = overshootEnd + f.stallDuration;

    if (!this.falling) {
      const t = this.elapsed;
      const missAlt = deckAltitude + f.missClearance;
      let targetDist;
      let targetAlt;
      let targetPitch;

      if (t < criticalEnd) {
        const u = t / criticalEnd;
        targetDist = lerp(this.entry.distance, lerp(zoneStart, zoneEnd, 0.55), easeOutQuad(u));
        targetAlt = lerp(this.entry.altitude, missAlt + 8, u * 0.35);
        targetPitch = lerp(this.entry.pitch, -5, u);
      } else if (t < missEnd) {
        const u = (t - criticalEnd) / f.missDuration;
        targetDist = lerp(lerp(zoneStart, zoneEnd, 0.55), zoneEnd + 18, u);
        targetAlt = lerp(missAlt + 8, missAlt, u);
        targetPitch = lerp(-5, -9, u);
      } else {
        const u = clamp((t - missEnd) / f.overshootDuration, 0, 1);
        targetDist = lerp(zoneEnd + 18, lerp(zoneEnd + 40, crashPoint, 0.55), easeOutQuad(u));
        targetAlt = lerp(missAlt, missAlt * 0.72, u);
        targetPitch = lerp(-9, f.divePitch * 0.35, u);
      }

      this.state.vx = (targetDist - this.state.distance) / Math.max(dt, 1e-3);
      this.state.vy = (targetAlt - this.state.altitude) / Math.max(dt, 1e-3);
      this.state.distance = targetDist;
      this.state.altitude = targetAlt;
      this.state.pitch = damp(this.state.pitch, targetPitch, 7, dt);

      if (this.elapsed >= overshootEnd) {
        this.falling = true;
        this.state.vx = Math.max(42, Math.min(this.state.vx, 160));
        this.state.vy = Math.min(this.state.vy, -22);
      }
      return;
    }

    const stallU = clamp((this.elapsed - overshootEnd) / Math.max(f.stallDuration, 0.01), 0, 1);
    this.state.vy -= f.gravity * dt * (0.55 + stallU * 0.7);
    this.state.vx = damp(this.state.vx, 28, 1.1, dt);
    this.state.distance += this.state.vx * dt;
    this.state.altitude += this.state.vy * dt;
    const diveU = clamp((this.elapsed - stallEnd) / Math.max(f.diveDuration, 0.01), 0, 1);
    const pitchTarget = lerp(f.divePitch * 0.45, f.divePitch, easeInQuad(clamp(diveU, 0, 1)));
    this.state.pitch = damp(this.state.pitch, pitchTarget, 6.5, dt);

    if (this.state.altitude <= waterLevel + 1.2) {
      this.state.altitude = waterLevel - 6;
      this.state.vx = damp(this.state.vx, 0, 8, dt);
      this.state.vy = 0;
      if (!this.impacted) {
        this.impacted = true;
        this._pulseSplash();
      }
      if (this.elapsed > stallEnd + f.fallDuration * 0.35) this.complete = true;
    }

    if (this.elapsed > overshootEnd + f.stallDuration + f.diveDuration + f.fallDuration + 0.4) {
      this.complete = true;
    }
  }

  _stage() {
    if (this.result === 'SUCCESS') {
      if (this.complete || (this.touched && this.state.vx < 4)) return LandingStage.STOP;
      if (this.touched && this.touchElapsed < 0.14) return LandingStage.TOUCHDOWN;
      if (this.touched) return LandingStage.SETTLE;
      const s = this.plan.spec.success;
      const t = this.elapsed;
      if (t < s.approachDuration) return LandingStage.APPROACH;
      if (t < s.approachDuration + s.decelerateDuration) return LandingStage.DECELERATE;
      if (t < s.approachDuration + s.decelerateDuration + s.descendDuration) return LandingStage.DESCEND;
      if (t < s.approachDuration + s.decelerateDuration + s.descendDuration + s.flareDuration) {
        return LandingStage.FLARE;
      }
      return LandingStage.ALIGN;
    }

    if (this.impacted || this.complete) return LandingStage.IMPACT;
    if (this.falling) {
      if (this.state.altitude < 36) return LandingStage.FALL;
      if (this.state.pitch < -18) return LandingStage.DIVE;
      return LandingStage.STALL;
    }
    const f = this.plan.spec.fail;
    if (this.elapsed < f.criticalDuration) return LandingStage.CRITICAL;
    if (this.elapsed < f.criticalDuration + f.missDuration) return LandingStage.MISS;
    return LandingStage.OVERSHOOT;
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

  _deckBlend(stage) {
    if (this.result !== 'SUCCESS') return 0;
    if (stage === LandingStage.STOP || stage === LandingStage.SETTLE) return 1;
    if (stage === LandingStage.TOUCHDOWN) return 0.75;
    if (stage === LandingStage.ALIGN) return 0.35;
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
      deckBlend: this._deckBlend(stage),
      effects: {
        zone: this.fx.zone,
        dust: this.fx.dust,
        splash: this.fx.splash,
        shake: this.fx.shake,
        smoke: this.result === 'FAIL' && (this.falling || this.impacted) ? 1 : 0,
        successGlow: this.result === 'SUCCESS' && this.touched ? Math.min(1, this.touchElapsed * 2) : 0,
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
