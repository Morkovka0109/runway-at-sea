import { clamp, damp } from '../utils/easing.js';
import { clampImpulse, finite, sanitizeVelocity } from '../physics/Body.js';

/**
 * Guided aircraft body. Follows the predetermined flight/landing pose
 * with forces, drag and impulses. Does not decide SUCCESS / FAIL.
 */
export class AircraftPhysicsController {
  constructor(config, aircraft) {
    this.config = config;
    this.aircraft = aircraft;
    this.body = aircraft.body;
    this.prev = { x: 0, y: 0, radius: aircraft.collider.radius };
    this.mode = 'idle';
    this._speedRecover = 1;
    this._time = 0;
    this.reset();
  }

  get spec() {
    return this.config.physics ?? {};
  }

  reset(pose = null) {
    const start = pose ?? this.config.flight.path.startPosition;
    const x = finite(start.distance ?? start.x, 0);
    const y = finite(start.altitude ?? start.y, this.spec.minAltitude ?? 8);
    this.body.x = x;
    this.body.y = y;
    this.body.vx = 0;
    this.body.vy = 0;
    this.body.ax = 0;
    this.body.ay = 0;
    this.body.rotation = finite(start.pitch, 0);
    this.body.omega = 0;
    this._speedRecover = 1;
    this.mode = 'idle';
    this._time = 0;
    this._capturePrev();
    this.body.syncCollider();
    this.aircraft.collider.radius = this.spec.planeRadius ?? this.config.numberPickups?.planeRadius ?? 18;
    this.aircraft.setPose(this._poseFromBody({ phase: start.phase ?? 'idle', t: start.t ?? 0 }));
  }

  applyRocketHit(rocket) {
    const spec = this.spec;
    const rockets = this.config.rockets ?? {};
    const damage = rocket?.damage ?? {};
    const maxImpulse = spec.maxImpulse ?? 90;
    const vyHit = damage.altitude ?? rockets.rocketAltitudePenalty ?? spec.rocketVy ?? 14;
    const impulse = clampImpulse(0, -Math.abs(vyHit) * 3.2, maxImpulse);
    this.body.vy += impulse.y / this.body.mass;
    const spdCut = clamp(damage.speed ?? rockets.rocketSpeedPenalty ?? 0.22, 0, 0.6);
    this.body.vx *= clamp(1 - spdCut, spec.minSpeedMul ?? rockets.minSpeedMul ?? 0.55, 1);
    this._speedRecover = clamp(1 - spdCut, spec.minSpeedMul ?? 0.55, 1);
    this.body.omega = clamp(this.body.omega - 18, -(spec.maxAngular ?? 80), spec.maxAngular ?? 80);
    this._sanitize();
  }

  applyNumberHit() {
    const heading = this.body.rotation;
    const vx = this.body.vx;
    const nudge = this.spec.numberNudge ?? 4;
    const impulse = clampImpulse(0, nudge, this.spec.maxImpulse ?? 90);
    this.body.vy += impulse.y * 0.12;
    this.body.vx = vx;
    this.body.rotation = heading;
    this._sanitize();
  }

  /**
   * Integrate the body toward a guidance pose. `mode`: idle | flight | landing | crash.
   */
  follow(guide, deltaTime, mode = 'flight') {
    const spec = this.spec;
    const path = this.config.flight.path;
    const dt = clamp(finite(deltaTime, 0), 0, (path.maxDt ?? 0.05) * 4);
    this.mode = mode;
    this._time += dt;
    this._capturePrev();

    if (!guide) {
      this._sanitize();
      return this._poseFromBody({ phase: 'idle', t: 0 });
    }

    if (dt <= 0 || mode === 'idle') {
      this._hold(guide, dt);
      return this._emit(guide);
    }

    this._recover(dt);
    const stepLimit = 1 / 48;
    const steps = Math.max(1, Math.min(6, Math.ceil(dt / stepLimit)));
    const stepDt = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      this._steer(guide, stepDt, mode);
      this._integrate(stepDt, mode);
    }
    this._constrain(guide, dt, mode);
    this._sanitize();
    this.body.syncCollider();
    return this._emit(guide);
  }

  overlapsZone(zoneCollider, previous = null) {
    if (!zoneCollider) return false;
    const from = previous ?? this.prev;
    return zoneCollider.hitsSwept(from, this.body.collider);
  }

  _hold(guide, dt) {
    const x = finite(guide.distance ?? guide.x, this.body.x);
    const y = finite(guide.altitude ?? guide.y, this.body.y);
    if (dt <= 0) {
      this.body.x = x;
      this.body.y = y;
      this.body.vx = 0;
      this.body.vy = 0;
      this.body.rotation = finite(guide.pitch, 0);
    } else {
      this.body.x = damp(this.body.x, x, 14, dt);
      this.body.y = damp(this.body.y, y, 14, dt);
      this.body.vx = damp(this.body.vx, 0, 12, dt);
      this.body.vy = damp(this.body.vy, 0, 12, dt);
      this.body.rotation = damp(this.body.rotation, finite(guide.pitch, 0), 12, dt);
    }
    this.body.syncCollider();
  }

  _steer(guide, dt, mode) {
    const spec = this.spec;
    const targetX = finite(guide.distance ?? guide.x, this.body.x);
    const targetY = finite(guide.altitude ?? guide.y, this.body.y);
    const err = Math.hypot(targetX - this.body.x, targetY - this.body.y);
    let steer =
      mode === 'landing' ? spec.landingSteer ?? 16 : mode === 'crash' ? spec.crashSteer ?? 3.2 : spec.steer ?? 9;
    if (mode === 'crash' && err > 70) steer = spec.crashCatchup ?? 11;
    const gravity =
      mode === 'crash' ? spec.crashGravity ?? 220 : mode === 'landing' ? spec.landingGravity ?? 8 : spec.gravity ?? 38;
    const lift = spec.lift ?? 2.4;
    const maxGuide = spec.maxSpeed ?? 420;
    const guideVx = clamp(Number.isFinite(guide.vx) ? guide.vx : 0, -maxGuide, maxGuide);
    const guideVy = clamp(Number.isFinite(guide.vy) ? guide.vy : 0, -maxGuide, maxGuide);
    const desiredVx = ((targetX - this.body.x) * steer + guideVx) * this._speedRecover;
    const desiredVy = (targetY - this.body.y) * steer + guideVy;
    this.body.ax = (desiredVx - this.body.vx) * lift;
    this.body.ay = (desiredVy - this.body.vy) * lift - gravity;

    if (mode === 'crash') {
      this.body.ay -= gravity * 0.35;
      this.body.omega += Math.sin(this._time * 9.5) * 28 * dt;
    }

    if (mode === 'landing') {
      const deck = this.config.flight.world?.deckAltitude ?? 26;
      if (this.body.y < deck + 42) {
        this.body.ay -= this.body.vy * (spec.landingVyDamp ?? 14);
        this.body.omega += (0 - this.body.rotation) * 16 * dt;
      }
      if (guide.landed || guide.landingStage === 'STOP' || guide.landingStage === 'SETTLE') {
        this.body.ax -= this.body.vx * (spec.landingBrake ?? 10);
        this.body.ay -= this.body.vy * (spec.landingBrake ?? 10);
        this.body.omega += (0 - this.body.rotation) * 22 * dt;
      }
    }

    const pitchTarget = finite(guide.pitch, this.body.rotation);
    this.body.omega += (pitchTarget - this.body.rotation) * (spec.angularDamp ?? 10) * dt;
  }

  _integrate(dt, mode = 'flight') {
    const spec = this.spec;
    const drag = spec.drag ?? 1.8;
    this.body.vx += this.body.ax * dt;
    this.body.vy += this.body.ay * dt;
    const dampV = Math.exp(-drag * dt);
    this.body.vx *= dampV;
    this.body.vy *= dampV;
    this.body.rotation += this.body.omega * dt;
    this.body.omega *= Math.exp(-(spec.angularDamp ?? 10) * 0.45 * dt);

    const nextX = this.body.x + this.body.vx * dt;
    const nextY = this.body.y + this.body.vy * dt;
    const slack = mode === 'crash' ? 2.6 : mode === 'landing' ? 1.8 : 1.35;
    const maxStep = (spec.maxSpeed ?? 420) * dt * slack;
    const dx = nextX - this.body.x;
    const dy = nextY - this.body.y;
    const step = Math.hypot(dx, dy);
    if (step > maxStep && step > 0) {
      this.body.x += (dx / step) * maxStep;
      this.body.y += (dy / step) * maxStep;
    } else {
      this.body.x = nextX;
      this.body.y = nextY;
    }
  }

  _recover(dt) {
    const duration = Math.max(0.2, this.config.rockets?.rocketEffectDuration ?? this.spec.rocketEffectDuration ?? 0.9);
    this._speedRecover = damp(this._speedRecover, 1, 2.2 / duration, dt);
  }

  _constrain(guide = {}, _dt = 0, mode = this.mode) {
    const spec = this.spec;
    const world = this.config.flight.world;
    const track = this.config.scene?.track ?? {};
    const minAlt = spec.minAltitude ?? 8;
    const maxAlt = spec.maxAltitude ?? 360;
    const minDist = spec.minDistance ?? 0;
    const maxDist = spec.maxDistance ?? (track.length ?? 2100) + 280;
    const water = world.waterLevel ?? 0;
    const floor = mode === 'crash' ? water - 12 : Math.max(water, minAlt);
    this.body.y = clamp(this.body.y, floor, maxAlt);
    this.body.x = clamp(this.body.x, minDist, maxDist);
    if (mode === 'landing' && (guide.landed || guide.landingStage === 'STOP')) {
      this.body.y = Math.max(world.deckAltitude ?? 26, this.body.y);
      this.body.vx = Math.max(0, this.body.vx);
      if (guide.landingStage === 'STOP') {
        this.body.vx = 0;
        this.body.vy = 0;
        this.body.omega = 0;
        this.body.rotation = 0;
      }
    } else if (mode !== 'crash') {
      this.body.vx = Math.max(0, this.body.vx);
    }
    const maxAng = spec.maxAngular ?? 80;
    this.body.omega = clamp(this.body.omega, -maxAng, maxAng);
    const pitchMin = mode === 'crash' ? -52 : -48;
    this.body.rotation = clamp(this.body.rotation, pitchMin, 22);
  }

  _sanitize() {
    const spec = this.spec;
    const cleaned = sanitizeVelocity(this.body.vx, this.body.vy, spec.maxSpeed ?? 420);
    this.body.vx = cleaned.vx;
    this.body.vy = cleaned.vy;
    this.body.x = finite(this.body.x);
    this.body.y = finite(this.body.y, spec.minAltitude ?? 8);
    this.body.ax = finite(this.body.ax);
    this.body.ay = finite(this.body.ay);
    this.body.rotation = finite(this.body.rotation);
    this.body.omega = finite(this.body.omega);
    if (cleaned.speed < 0) {
      this.body.vx = 0;
      this.body.vy = 0;
    }
  }

  _capturePrev() {
    this.prev = {
      x: this.body.x,
      y: this.body.y,
      radius: this.aircraft.collider.radius,
    };
  }

  _emit(guide) {
    const pose = this._poseFromBody(guide);
    this.aircraft.setPose(pose);
    return pose;
  }

  _poseFromBody(guide = {}) {
    const speed = Math.max(0, Math.hypot(this.body.vx, this.body.vy));
    return {
      ...guide,
      distance: this.body.x,
      altitude: this.body.y,
      speed,
      pitch: this.body.rotation,
      vx: this.body.vx,
      vy: this.body.vy,
      x: this.body.x,
      y: this.body.y,
      fromPhysics: true,
    };
  }
}
