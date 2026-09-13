import { clamp, damp, lerp } from '../utils/easing.js';
import { finite, sanitizeVelocity } from '../physics/Body.js';

/**
 * Single source of truth for the aircraft body.
 * Speed and altitude hold unless a digit or bomb changes the targets.
 * Position only advances forward from the previous state.
 */
export class AircraftPhysicsController {
  constructor(config, aircraft) {
    this.config = config;
    this.aircraft = aircraft;
    this.body = aircraft.body;
    this.prev = { x: 0, y: 0, radius: aircraft.collider.radius };
    this.mode = 'idle';
    this._time = 0;
    this.reset();
  }

  get spec() {
    return this.config.physics ?? {};
  }

  snapshot(guide = {}) {
    return this._poseFromBody(guide);
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
    this.mode = 'idle';
    this._time = 0;
    this._damage = 0;
    this._stability = 1;
    this._crashBlend = 0;
    this._targetVx = 0;
    this._targetY = y;
    this._holdVx = 0;
    this._holdVy = 0;
    this._airborne = false;
    this._launched = false;
    this._boostLeft = 0;
    this._flightState = 'hold';
    this._bombHits = 0;
    this._capturePrev();
    this.body.syncCollider();
    this.aircraft.collider.radius = this.spec.planeRadius ?? this.config.numberPickups?.planeRadius ?? 18;
    this.aircraft.setPose(this._poseFromBody({ phase: start.phase ?? 'idle', t: start.t ?? 0 }));
  }

  applyRocketHit(rocket) {
    const spec = this.spec;
    const rockets = this.config.rockets ?? {};
    const damage = rocket?.damage ?? {};
    const dH = Math.abs(damage.altitude ?? rockets.rocketAltitudePenalty ?? spec.rocketVy ?? 8);
    const dV = Math.abs(
      Number.isFinite(damage.deltaSpeed)
        ? damage.deltaSpeed
        : (rockets.rocketSpeedDelta ?? (damage.speed ?? rockets.rocketSpeedPenalty ?? 0.12) * 80),
    );
    const water = this.config.flight?.world?.waterLevel ?? 0;
    const deck = this.config.flight?.world?.deckAltitude ?? 26;
    const minY = this.mode === 'landing' ? deck : water + 1;
    const minVx = spec.minHoldSpeed ?? 18;
    this._bombHits += 1;
    this._targetVx = Math.max(minVx, Math.max(0, this.body.vx) - dV);
    this._targetY = Math.max(minY, this.body.y - dH);
    this.body.vx = this._targetVx;
    this.body.vy = Math.min(this.body.vy, -Math.min(26, dH * 0.85));
    this._holdVx = this.body.vx;
    this.body.omega = clamp(this.body.omega - 8, -(spec.maxAngular ?? 80), spec.maxAngular ?? 80);
    const amount = clamp(damage.damage ?? rockets.rocketDamage ?? 0.18, 0.06, 0.4);
    this._damage = clamp(this._damage + amount, 0, spec.maxDamage ?? 1.25);
    this._stability = clamp(1 - this._damage * 0.85, 0.12, 1);
    this._refreshFlightState();
    this._sanitize();
  }

  applyNumberHit(item) {
    const spec = this.spec;
    const heading = this.body.rotation;
    const n = clamp(Math.round(Number(item?.number) || 5), 1, 10);
    const scale = 0.55 + n * 0.045;
    const dH = Math.abs((spec.numberNudge ?? 10) * scale);
    const dV = Math.abs((spec.numberSpeedBoost ?? 14) * scale);
    const maxAlt = spec.maxAltitude ?? 360;
    const maxSpeed = spec.maxSpeed ?? 420;
    this._targetVx = Math.min(maxSpeed, Math.max(this._targetVx, this.body.vx) + dV);
    this._targetY = Math.min(maxAlt, Math.max(this._targetY, this.body.y) + dH);
    this.body.vx = Math.max(this.body.vx, this._targetVx);
    this.body.vy = Math.max(this.body.vy, Math.min(26, dH * 0.85));
    this._holdVx = this.body.vx;
    this.body.rotation = heading;
    this._damage = Math.max(0, this._damage - (spec.numberRepair ?? 0.04));
    this._stability = clamp(1 - this._damage * 0.85, 0.12, 1);
    this._sanitize();
  }

  /**
   * Integrate from the previous body state toward the current targets.
   * `mode`: idle | flight | landing | crash.
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

    if (mode === 'idle') {
      this._holdIdle(guide, dt);
      return this._emit(guide);
    }
    if (dt <= 0) {
      return this._emit(guide);
    }

    if (this._targetVx <= 0 && this.body.vx > 0) this._targetVx = this.body.vx;
    if (mode === 'flight' && this._isLaunch(guide)) {
      this._launchOnce();
    }
    if (mode === 'landing' || (mode === 'flight' && this._nearLandingZone())) {
      this._armLandingTargets(guide);
    }
    if (mode === 'crash') this._armCrashTargets(guide);
    this._refreshFlightState();

    const stepLimit = 1 / 48;
    const steps = Math.max(1, Math.min(6, Math.ceil(dt / stepLimit)));
    const stepDt = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      this._steerTargets(stepDt, mode);
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

  hitsWater(ship) {
    const waterLevel = this.config.flight?.world?.waterLevel ?? 0;
    if (this.body.y <= waterLevel + 2.4) return true;
    const water = ship?.waterCollider;
    return !!(water && this.overlapsZone(water));
  }

  hitsShip(ship) {
    if (!ship) return false;
    const deck = ship.deck?.altitude ?? this.config.flight.world.deckAltitude ?? 26;
    if (this.body.y > deck + 8) return false;
    const zone = ship.zoneCollider;
    const hull = ship.collider;
    return this.overlapsZone(zone) || this.overlapsZone(hull);
  }

  _holdIdle(guide, dt) {
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
    this._targetVx = 0;
    this._targetY = this.body.y;
    this.body.syncCollider();
  }

  _isLaunch(guide) {
    if (this._airborne || this._launched) return false;
    const phase = guide?.phase;
    if (phase === 'TAKEOFF') return true;
    const speed = Math.hypot(this.body.vx, this.body.vy);
    return speed < (this.spec.holdSpeed ?? 180) * 0.28 && this._time < 0.9;
  }

  _launchOnce() {
    const spec = this.spec;
    const maxGuide = spec.maxSpeed ?? 420;
    const launchVx = clamp(spec.launchVx ?? spec.holdSpeed ?? 96, 48, maxGuide);
    const launchVy = clamp(spec.launchVy ?? 70, 24, 320);
    const launchPitch = spec.launchPitch ?? 0;
    this._launched = true;
    this._airborne = true;
    this._boostLeft = spec.launchBoost ?? 0.1;
    this.body.vx = Math.max(this.body.vx, launchVx);
    this.body.vy = Math.max(this.body.vy, launchVy);
    this.body.rotation = launchPitch;
    this.body.omega = 0;
    this._targetVx = this.body.vx;
    const worldStart = this.config.flight?.world?.startAltitude ?? this.body.y;
    this._targetY = spec.launchHoldAltitude ?? (worldStart + 70);
    this._holdVx = this.body.vx;
    this._holdVy = launchVy;
    this.body.ax = 0;
    this.body.ay = 0;
    this._flightState = 'hold';
  }

  _zoneStart() {
    const world = this.config.flight.world ?? {};
    const zone = this.config.roundResult?.landingZone;
    return zone?.start ?? world.shipDistance ?? 1280;
  }

  _nearLandingZone() {
    return this.body.x >= this._zoneStart() - 220;
  }

  _isOverDeck(guide = {}) {
    if (guide.overDeck === true) return true;
    const world = this.config.flight.world ?? {};
    const zone = this.config.roundResult?.landingZone;
    const start = zone?.start ?? world.shipDistance ?? 1280;
    const end = zone?.end ?? start + (world.deckLength ?? 170);
    return this.body.x >= start - 14 && this.body.x <= end + 70;
  }

  _armLandingTargets(guide) {
    const deck = this.config.flight.world?.deckAltitude ?? 26;
    const settled = guide?.landed || guide?.landingStage === 'STOP' || guide?.landingStage === 'SETTLE';
    const over = this._isOverDeck(guide);
    this._flightState = 'descent';
    if (settled && over) {
      this._targetY = deck;
      this._targetVx = 0;
      return;
    }
    this._targetY = over ? deck : deck + 16;
    const high = Math.max(0, this.body.y - deck);
    const floor = this.spec.minHoldSpeed ?? 18;
    if (over) {
      const brake = high > 24 ? 20 : 28;
      this._targetVx = Math.min(Math.max(this.body.vx, floor), brake);
    } else {
      this._targetVx = 100;
    }
  }

  _armCrashTargets(guide = {}) {
    const water = this.config.flight?.world?.waterLevel ?? 0;
    const world = this.config.flight.world ?? {};
    const zone = this.config.roundResult?.landingZone;
    const start = zone?.start ?? world.shipDistance ?? 1280;
    const reachedDeck = this.body.x >= start - 14;
    const stall = this._stallAmount();
    if (reachedDeck || this._isOverDeck(guide) || this._flightState === 'falling' || stall > 0.36) {
      this._targetY = water + 1;
      this._flightState = 'falling';
      return;
    }
    if (this._flightState === 'hold') this._flightState = 'descent';
  }

  _refreshFlightState() {
    const stall = this._stallAmount();
    this._crashBlend = stall;
    if (this.mode === 'idle') {
      this._flightState = 'hold';
      return;
    }
    if (this.mode === 'landing') {
      if (this._flightState === 'falling') this._flightState = 'descent';
      return;
    }
    if (this._flightState === 'hold' && stall > 0.28) {
      this._flightState = 'descent';
    } else if (this._flightState === 'descent' && stall > 0.62) {
      this._flightState = 'falling';
    }
  }

  _stallAmount() {
    const spec = this.spec;
    const rockets = this.config.rockets ?? {};
    const speed = Math.max(0, this.body.vx);
    const stallSpeed = spec.stallSpeed ?? 72;
    const stallAlt = spec.stallAltitude ?? 22;
    const water = this.config.flight?.world?.waterLevel ?? 0;
    const speedStall = speed < stallSpeed ? (stallSpeed - speed) / stallSpeed : 0;
    const altStall = this._targetY < stallAlt || this.body.y < stallAlt
      ? (stallAlt - Math.max(water, Math.min(this.body.y, this._targetY))) / stallAlt
      : 0;
    const critical = spec.criticalDamage ?? rockets.criticalDamage ?? 0.75;
    const dmgStall = this._damage >= critical ? clamp((this._damage - critical * 0.7) / 0.6, 0, 1) : 0;
    const bombStall = this._bombHits >= 4 ? clamp((this._bombHits - 3) / 5, 0, 1) : 0;
    return clamp(Math.max(speedStall, altStall, dmgStall, bombStall), 0, 1);
  }

  _steerTargets(dt, mode) {
    const spec = this.spec;
    const lock = spec.holdLock ?? 7.5;
    const holdVx = Math.max(0, Number.isFinite(this._targetVx) ? this._targetVx : this.body.vx);
    this.body.ax = (holdVx - this.body.vx) * lock;

    if (this._boostLeft > 0 && mode === 'flight') {
      this._boostLeft = Math.max(0, this._boostLeft - dt);
      this.body.ay = 0;
      this._targetY = Math.max(this._targetY, this.body.y);
      this.body.omega += (0 - this.body.rotation) * (spec.angularDamp ?? 10) * 3 * dt;
      this.body.rotation = clamp(this.body.rotation, -1, spec.holdPitchMax ?? 0);
      return;
    }

    const err = this._targetY - this.body.y;
    let desiredVy;
    if (this._flightState === 'falling') {
      desiredVy = Math.min(this.body.vy, -10) - (spec.crashGravity ?? 140) * dt;
    } else if (this._flightState === 'descent') {
      const landing = mode === 'landing' || (mode === 'flight' && this._nearLandingZone());
      const remaining = -err;
      const flare = landing && remaining < 20;
      const cap = landing ? (flare ? 26 : 110) : 28;
      const minSink = landing ? (flare ? 8 : 82) : 10;
      const sink = clamp(remaining * (landing ? 0.5 : 0.32), minSink, cap);
      desiredVy = err >= 0 ? clamp(err * 1.6, 0, 10) : -sink;
    } else {
      desiredVy = clamp(err * 3.2, -26, 28);
    }
    this.body.ay = (desiredVy - this.body.vy) * lock;

    const divePitch = spec.divePitch ?? this.config.flight?.landing?.fail?.divePitch ?? -38;
    const stall = this._crashBlend;
    let pitchTarget = 0;
    if (this._flightState === 'falling' || (mode === 'crash' && stall > 0.2)) {
      pitchTarget = lerp(0, divePitch, clamp(stall, 0, 1));
    } else if (mode === 'landing' || this._flightState === 'descent' || this._flightState === 'hold') {
      pitchTarget = 0;
    }
    this.body.omega += (pitchTarget - this.body.rotation) * (spec.angularDamp ?? 10) * 0.7 * dt;
    if (mode === 'crash' && this._flightState === 'falling') {
      this.body.omega -= 8 * dt;
    }
    if (mode === 'landing') {
      this.body.omega += (0 - this.body.rotation) * 16 * dt;
      this.body.rotation *= Math.exp(-10 * dt);
    }
  }

  _integrate(dt, mode = 'flight') {
    const spec = this.spec;
    this.body.vx += this.body.ax * dt;
    this.body.vy += this.body.ay * dt;
    this.body.vx = Math.max(0, this.body.vx);
    this.body.rotation += this.body.omega * dt;
    this.body.omega *= Math.exp(-(spec.angularDamp ?? 10) * 0.45 * dt);

    const nextX = this.body.x + this.body.vx * dt;
    const nextY = this.body.y + this.body.vy * dt;
    const slack = mode === 'crash' ? 1.45 : mode === 'landing' ? 1.8 : 1.35;
    const maxStep = (spec.maxSpeed ?? 420) * dt * slack;
    const dx = Math.max(0, nextX - this.body.x);
    const dy = nextY - this.body.y;
    const step = Math.hypot(dx, dy);
    if (step > maxStep && step > 0) {
      this.body.x += (dx / step) * maxStep;
      this.body.y += (dy / step) * maxStep;
    } else {
      this.body.x = this.body.x + dx;
      this.body.y = nextY;
    }
    this.body.x = Math.max(this.prev.x, this.body.x);
  }

  _constrain(guide = {}, _dt = 0, mode = this.mode) {
    const spec = this.spec;
    const world = this.config.flight.world;
    const minDist = spec.minDistance ?? 0;
    const maxDist = spec.maxDistance ?? 100000;
    const maxAlt = spec.maxAltitude ?? 360;
    const water = world.waterLevel ?? 0;
    this.body.x = clamp(Math.max(this.prev.x, this.body.x), minDist, maxDist);
    this.body.vx = Math.max(0, this.body.vx);
    if (mode === 'landing' && (guide.landed || guide.landingStage === 'STOP')) {
      const deckAlt = world.deckAltitude ?? 26;
      if (this._isOverDeck(guide) || guide.landed) {
        this.body.y = clamp(this.body.y, deckAlt, maxAlt);
        if (guide.landingStage === 'STOP' && (guide.landed || this._isOverDeck(guide))) {
          this.body.vx = 0;
          this.body.vy = 0;
          this.body.omega = 0;
          this.body.rotation = 0;
          this._targetVx = 0;
        }
      } else {
        this.body.y = clamp(this.body.y, deckAlt + 4, maxAlt);
      }
    } else if (mode === 'crash' || this._flightState === 'falling') {
      this.body.y = clamp(this.body.y, water - 12, maxAlt);
    } else {
      this.body.y = clamp(this.body.y, water + 0.4, maxAlt);
    }
    const maxAng = spec.maxAngular ?? 80;
    this.body.omega = clamp(this.body.omega, -maxAng, maxAng);
    const pitchMin = mode === 'crash' ? -52 : (mode === 'landing' ? -1 : -2);
    const pitchMax = mode === 'crash' ? 16 : (spec.holdPitchMax ?? 0);
    this.body.rotation = clamp(this.body.rotation, pitchMin, pitchMax);
  }

  _sanitize() {
    const spec = this.spec;
    const cleaned = sanitizeVelocity(this.body.vx, this.body.vy, spec.maxSpeed ?? 420);
    this.body.vx = Math.max(0, cleaned.vx);
    this.body.vy = cleaned.vy;
    this.body.x = finite(this.body.x);
    this.body.y = finite(this.body.y, spec.minAltitude ?? 8);
    this.body.ax = finite(this.body.ax);
    this.body.ay = finite(this.body.ay);
    this.body.rotation = finite(this.body.rotation);
    this.body.omega = finite(this.body.omega);
    this._targetVx = Math.max(0, finite(this._targetVx, this.body.vx));
    this._targetY = finite(this._targetY, this.body.y);
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
      flightState: this._flightState,
    };
  }
}
