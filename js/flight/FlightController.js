import { catmullRom, clamp, damp, lerp } from '../utils/easing.js';

export const FlightPhase = {
  TAKEOFF: 'TAKEOFF',
  CLIMB: 'CLIMB',
  CRUISE: 'CRUISE',
  DESCENT: 'DESCENT',
  LANDING: 'LANDING',
  CRASH: 'CRASH',
};

/**
 * Parametric flight. The mathematical result is already known;
 * this class only turns SUCCESS / FAIL into a smooth trajectory.
 * Integration uses deltaTime, never per-frame x += speed.
 */
export class FlightController {
  constructor(config, aircraft, ship, rng = Math.random) {
    this.config = config;
    this.aircraft = aircraft;
    this.ship = ship;
    this.rng = rng;
    this.path = null;
    this.elapsed = 0;
    this.smoothed = null;
    this.complete = false;
    this._impact = this._idleImpact();
  }

  /**
   * Builds a visual path for an already-decided round result.
   * Does not roll SUCCESS / FAIL and never reads aircraft position.
   * @param {{ result: 'SUCCESS' | 'FAIL', targetDistance: number, maxAltitude: number, flightDuration: number }} roundResult
   */
  generateFlightPath(roundResult) {
    const spec = this.config.flight.path;
    const world = this.config.flight.world;
    const rng = this.rng;
    const result = roundResult.result;
    const startPosition = {
      distance: spec.startPosition.distance,
      altitude: spec.startPosition.altitude,
    };
    const landingDistance = this.ship.landingAim.distance;
    const targetDistance = roundResult.targetDistance;
    const takeoffDuration = this._range(spec.takeoffDuration, rng);
    const climbDuration = this._range(spec.climbDuration, rng);
    const cruiseDuration = this._range(spec.cruiseDuration, rng);
    const descentDuration = this._range(spec.descentDuration, rng);
    const requestedTotal = roundResult.flightDuration;
    const rawSum = takeoffDuration + climbDuration + cruiseDuration + descentDuration;
    const scale = requestedTotal / rawSum;

    const durations = {
      takeoffDuration: takeoffDuration * scale,
      climbDuration: climbDuration * scale,
      cruiseDuration: cruiseDuration * scale,
      descentDuration: descentDuration * scale,
      finaleDuration: 0,
    };
    const flightDuration =
      durations.takeoffDuration +
      durations.climbDuration +
      durations.cruiseDuration +
      durations.descentDuration;

    const horizontalSpeed = this._range(spec.horizontalSpeed, rng);
    const verticalSpeed = this._range(spec.verticalSpeed, rng);
    const landingAngle = this._range(spec.landingAngle, rng);

    const path = {
      result,
      startPosition,
      landingDistance,
      targetDistance,
      maxAltitude: roundResult.maxAltitude,
      flightDuration,
      climbDuration: durations.climbDuration,
      cruiseDuration: durations.cruiseDuration,
      descentDuration: durations.descentDuration,
      takeoffDuration: durations.takeoffDuration,
      landingDuration: 0,
      crashDuration: 0,
      horizontalSpeed,
      verticalSpeed,
      landingAngle,
      crashPoint: result === 'FAIL' ? targetDistance : landingDistance,
      deckAltitude: world.deckAltitude,
      waterLevel: world.waterLevel,
      durationMs: flightDuration * 1000,
      windows: this._phaseWindows(durations, flightDuration),
      keys: [],
    };

    path.keys = result === 'SUCCESS' ? this._successKeys(path) : this._failKeys(path);
    return path;
  }

  load(path) {
    this.path = path;
    this.elapsed = 0;
    this.complete = false;
    this._impact = this._idleImpact();
    const start = this._evaluate(0);
    this.smoothed = {
      distance: start.distance,
      altitude: start.altitude,
      pitch: 0,
      speed: 0,
    };
    this.aircraft.reset();
    this.aircraft.setPose(this._toPose(start, 0, FlightPhase.TAKEOFF));
  }

  applyRocketHit(rocket) {
    const spec = this.config.rockets ?? {};
    const damage = rocket?.damage ?? {};
    const alt = damage.altitude ?? spec.rocketAltitudePenalty ?? 14;
    const spd = damage.speed ?? spec.rocketSpeedPenalty ?? 0.22;
    this._impact.altDrop = clamp(this._impact.altDrop - alt, -(spec.maxAltitudeDrop ?? 40), 0);
    this._impact.speedMul = clamp(this._impact.speedMul * (1 - spd), spec.minSpeedMul ?? 0.55, 1);
    this._impact.pitchNudge = clamp(this._impact.pitchNudge - 4.5, -11, 0);
  }

  _idleImpact() {
    return { altDrop: 0, speedMul: 1, pitchNudge: 0 };
  }

  _recoverImpact(dt) {
    const spec = this.config.rockets ?? {};
    const duration = Math.max(0.2, spec.rocketEffectDuration ?? 0.9);
    const recover = 2.2 / duration;
    this._impact.speedMul = damp(this._impact.speedMul, 1, recover, dt);
    this._impact.altDrop = damp(this._impact.altDrop, 0, recover * 1.15, dt);
    this._impact.pitchNudge = damp(this._impact.pitchNudge, 0, recover * 1.4, dt);
  }

  /**
   * Advance the parametric curve by deltaTime seconds.
   * Callers must pass real time (optionally scaled), not a frame increment of 1.
   */
  update(deltaTime) {
    if (!this.path) return this._idlePose();
    const spec = this.config.flight.path;
    const dt = clamp(deltaTime, 0, spec.maxDt * 4);
    this._recoverImpact(dt);
    if (this.complete) return this._poseWithImpact(this.smoothed, 1, this._phaseAt(1));

    const step = dt * this._impact.speedMul;
    this.elapsed = Math.min(this.path.flightDuration, this.elapsed + step);
    const u = this.elapsed / this.path.flightDuration;
    const look = Math.min(0.02, 1 - u);
    const now = this._evaluate(u);
    const ahead = this._evaluate(Math.min(1, u + Math.max(look, 1e-4)));
    const dDist = ahead.distance - now.distance;
    const dAlt = ahead.altitude - now.altitude;
    const phase = this._phaseAt(u);
    const targetPitch = clamp(
      (Math.atan2(dAlt, Math.max(0.05, dDist)) * 180) / Math.PI,
      -42,
      18,
    );

    const lambda = spec.smoothing;
    const pitchLambda = spec.pitchSmoothing;
    if (dt === 0) {
      this.smoothed.distance = now.distance;
      this.smoothed.altitude = now.altitude;
      this.smoothed.pitch = targetPitch;
    } else {
      this.smoothed.distance = damp(this.smoothed.distance, now.distance, lambda, dt);
      this.smoothed.altitude = damp(this.smoothed.altitude, now.altitude, lambda, dt);
      this.smoothed.pitch = damp(this.smoothed.pitch, targetPitch, pitchLambda, dt);
    }
    this.smoothed.speed = Math.hypot(dDist, dAlt) / Math.max(look * this.path.flightDuration, 0.016);

    if (u >= 1) this.complete = true;

    return this._poseWithImpact(this.smoothed, u, phase);
  }

  isComplete() {
    return this.complete;
  }

  /**
   * Pose + velocity at the end of descent, for LandingSequence.
   */
  handoff() {
    if (!this.path || !this.smoothed) return this._idlePose();
    const span = Math.max(1e-3, this.path.flightDuration * 0.02);
    const now = this._evaluate(Math.max(0, 0.98));
    const ahead = this._evaluate(1);
    const vx = (ahead.distance - now.distance) / span;
    const vy = (ahead.altitude - now.altitude) / span;
    const altitude = Math.max(
      this.path.waterLevel ?? 0,
      this.smoothed.altitude + this._impact.altDrop,
    );
    return {
      t: 1,
      distance: this.smoothed.distance,
      altitude,
      pitch: this.smoothed.pitch + this._impact.pitchNudge,
      speed: Math.hypot(vx, vy) * this._impact.speedMul,
      vx: vx * this._impact.speedMul,
      vy,
      x: this.smoothed.distance,
      y: altitude,
      phase: FlightPhase.DESCENT,
      result: this.path.result,
    };
  }

  sample(t) {
    if (!this.path) return this._idlePose();
    this.elapsed = clamp(t, 0, 1) * this.path.flightDuration;
    this.complete = false;
    return this.update(0);
  }

  _phaseWindows(durations, total) {
    const takeoff = durations.takeoffDuration / total;
    const climb = durations.climbDuration / total;
    const cruise = durations.cruiseDuration / total;
    const descent = durations.descentDuration / total;
    return {
      takeoffEnd: takeoff,
      climbEnd: takeoff + climb,
      cruiseEnd: takeoff + climb + cruise,
      descentEnd: takeoff + climb + cruise + descent,
      finale: FlightPhase.DESCENT,
    };
  }

  _phaseAt(u) {
    const w = this.path.windows;
    if (u < w.takeoffEnd) return FlightPhase.TAKEOFF;
    if (u < w.climbEnd) return FlightPhase.CLIMB;
    if (u < w.cruiseEnd) return FlightPhase.CRUISE;
    if (u < w.descentEnd) return FlightPhase.DESCENT;
    return w.finale;
  }

  _successKeys(path) {
    const s = path.startPosition;
    const w = path.windows;
    const h = path.horizontalSpeed;
    const deck = path.deckAltitude;
    const cruiseAlt = path.maxAltitude;
    const slope = Math.abs(Math.tan((path.landingAngle * Math.PI) / 180));
    const descentDrop = slope * path.horizontalSpeed * path.descentDuration;
    const approachAlt = clamp(cruiseAlt - descentDrop, deck + 22, cruiseAlt - 10);
    const handoffDistance = path.landingDistance - 108;

    const dTakeoff = s.distance + h * path.takeoffDuration * 0.5;
    const dClimb = dTakeoff + h * path.climbDuration * 0.92;
    const dCruise = dClimb + h * path.cruiseDuration;
    const approachStart = lerp(dCruise, handoffDistance, 0.18);

    return this._scaleDistances(
      [
        { u: 0, distance: s.distance, altitude: s.altitude, phase: FlightPhase.TAKEOFF },
        { u: w.takeoffEnd, distance: dTakeoff, altitude: lerp(s.altitude, path.maxAltitude, 0.28), phase: FlightPhase.TAKEOFF },
        { u: w.climbEnd, distance: dClimb, altitude: path.maxAltitude, phase: FlightPhase.CLIMB },
        { u: w.cruiseEnd, distance: dCruise, altitude: cruiseAlt, phase: FlightPhase.CRUISE },
        { u: lerp(w.cruiseEnd, w.descentEnd, 0.55), distance: approachStart, altitude: lerp(cruiseAlt, approachAlt, 0.62), phase: FlightPhase.DESCENT },
        { u: 1, distance: handoffDistance, altitude: approachAlt, phase: FlightPhase.DESCENT },
      ],
      s.distance,
      handoffDistance,
    );
  }

  _failKeys(path) {
    const s = path.startPosition;
    const w = path.windows;
    const h = path.horizontalSpeed;
    const deck = path.deckAltitude;
    const cruiseAlt = path.maxAltitude * 1.02;
    const slope = Math.abs(Math.tan((path.landingAngle * Math.PI) / 180));
    const descentDrop = slope * path.horizontalSpeed * path.descentDuration * 0.85;
    const approachAlt = clamp(cruiseAlt - descentDrop, deck + 22, cruiseAlt - 12);
    const handoffDistance = path.landingDistance - 100;

    const dTakeoff = s.distance + h * path.takeoffDuration * 0.5;
    const dClimb = dTakeoff + h * path.climbDuration * 0.92;
    const dCruise = dClimb + h * path.cruiseDuration;
    const approachStart = lerp(dCruise, handoffDistance, 0.2);

    return this._scaleDistances(
      [
        { u: 0, distance: s.distance, altitude: s.altitude, phase: FlightPhase.TAKEOFF },
        { u: w.takeoffEnd, distance: dTakeoff, altitude: lerp(s.altitude, path.maxAltitude, 0.26), phase: FlightPhase.TAKEOFF },
        { u: w.climbEnd, distance: dClimb, altitude: path.maxAltitude, phase: FlightPhase.CLIMB },
        { u: w.cruiseEnd, distance: dCruise, altitude: cruiseAlt, phase: FlightPhase.CRUISE },
        { u: lerp(w.cruiseEnd, w.descentEnd, 0.5), distance: approachStart, altitude: lerp(cruiseAlt, approachAlt, 0.35), phase: FlightPhase.DESCENT },
        { u: 1, distance: handoffDistance, altitude: approachAlt, phase: FlightPhase.DESCENT },
      ],
      s.distance,
      handoffDistance,
    );
  }

  _scaleDistances(keys, start, end) {
    const first = keys[0].distance;
    const last = keys[keys.length - 1].distance;
    const span = last - first || 1;
    return keys.map((key) => ({
      ...key,
      distance: start + ((key.distance - first) / span) * (end - start),
    }));
  }

  _evaluate(u) {
    const keys = this.path.keys;
    const t = clamp(u, 0, 1);
    if (t <= keys[0].u) {
      return { distance: keys[0].distance, altitude: keys[0].altitude };
    }
    if (t >= keys[keys.length - 1].u) {
      const last = keys[keys.length - 1];
      return { distance: last.distance, altitude: last.altitude };
    }

    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].u < t) i += 1;
    const a = keys[i];
    const b = keys[i + 1];
    const p0 = keys[Math.max(0, i - 1)];
    const p3 = keys[Math.min(keys.length - 1, i + 2)];
    const local = (t - a.u) / (b.u - a.u || 1);

    return {
      distance: catmullRom(p0.distance, a.distance, b.distance, p3.distance, local),
      altitude: catmullRom(p0.altitude, a.altitude, b.altitude, p3.altitude, local),
    };
  }

  _poseWithImpact(point, t, phase) {
    const pose = this._toPose(point, t, phase);
    const water = this.path?.waterLevel ?? 0;
    pose.altitude = Math.max(water + 8, pose.altitude + this._impact.altDrop);
    pose.speed *= this._impact.speedMul;
    pose.pitch += this._impact.pitchNudge;
    pose.y = pose.altitude;
    return pose;
  }

  _toPose(point, t, phase) {
    return {
      t,
      distance: point.distance,
      altitude: point.altitude,
      speed: point.speed ?? this.smoothed?.speed ?? 0,
      pitch: point.pitch ?? 0,
      x: point.distance,
      y: point.altitude,
      phase,
    };
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
    };
  }

  _range({ min, max }, rng) {
    return min + rng() * (max - min);
  }
}
