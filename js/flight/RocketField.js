import { sweptCircleHit } from '../physics/Collider.js';
import { RocketObstacle } from './RocketObstacle.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function range(rng, min, max) {
  return min + rng() * (max - min);
}

/**
 * Spawns and collides rocket obstacles for one round.
 * Initial fill covers the flight path; ensureAhead streams more ahead of the plane.
 */
export class RocketField {
  constructor(config) {
    this.config = config;
    this.items = [];
    this.roundId = null;
    this._resetStream();
  }

  _resetStream() {
    this._rng = null;
    this._keys = [];
    this._next = 0;
    this._seq = 0;
    this._wave = 96;
  }

  clear() {
    this.items = [];
    this.roundId = null;
    this._resetStream();
  }

  spawn(roundId, flightPlan) {
    const spec = this.config.rockets ?? {};
    const minCount = spec.minCount ?? 20;
    const extra = spec.extraCount ?? 5;
    const seed = ((spec.seed ?? 113) + (Number(roundId) || 0) * 7919) >>> 0;
    const rng = mulberry32(seed);
    const keys = flightPlan?.keys ?? [];
    const last = keys[keys.length - 1];
    const pathEnd = Math.max((last?.distance ?? 1280) * 0.96, 720);
    const guaranteed = minCount + Math.floor(rng() * (extra + 1));

    this.roundId = roundId;
    this.items = [];
    this._rng = rng;
    this._keys = keys;
    this._seq = 0;
    this._next = (spec.startDistance ?? 100) + range(rng, 6, 40);
    this._wave = (this.config.flight?.world?.startAltitude ?? 26) + 70;
    const floor = spec.waveMin ?? 36;
    const ceil = spec.waveMax ?? 190;
    const step = spec.waveStep ?? 40;
    while (this._seq < guaranteed || this._next < pathEnd) {
      this._wave = Math.max(floor, Math.min(ceil, this._wave + range(rng, -step, step)));
      if (!this._placeOne(this._next, this._wave)) break;
      this._next += range(rng, spec.gapMin ?? 54, spec.gapMax ?? 140);
    }
  }

  ensureAhead(distance, altitude) {
    if (!this._rng) return;
    const spec = this.config.rockets ?? {};
    const spawnAhead = spec.spawnAhead ?? 480;
    const despawnBehind = spec.despawnBehind ?? 260;
    const maxLive = spec.maxLive ?? 48;
    const horizon = distance + spawnAhead;

    this.items = this.items.filter((item) => {
      if (item.gone) return false;
      if (item.hit) return item.homeDistance > distance - 90;
      return item.homeDistance > distance - despawnBehind;
    });

    const floor = spec.waveMin ?? 36;
    const ceil = spec.waveMax ?? 190;
    const step = spec.waveStep ?? 40;
    let guard = 0;
    while (this._next < horizon && this.items.length < maxLive && guard < 16) {
      const around = Number.isFinite(altitude) ? altitude : this._wave;
      this._wave = Math.max(floor, Math.min(ceil, around + range(this._rng, -step, step)));
      if (!this._placeOne(this._next, this._wave)) break;
      this._next += range(this._rng, spec.gapMin ?? 54, spec.gapMax ?? 140);
      guard += 1;
    }
  }

  _placeOne(distance, pathAltitude) {
    const spec = this.config.rockets ?? {};
    const rng = this._rng;
    const maxLive = spec.maxLive ?? 48;
    if (!rng || this.items.length >= maxLive) return false;

    const radius = spec.radius ?? 12;
    const bands = spec.altitudeBands ?? [-56, -28, 8, 36, 64];
    const minSep = spec.minSeparation ?? 70;
    const distJitter = spec.distanceJitter ?? 16;
    const altJitter = spec.altitudeJitter ?? 12;

    let x = distance + range(rng, -distJitter, distJitter);
    let altitude = pathAltitude + bands[Math.floor(rng() * bands.length)] + range(rng, -altJitter, altJitter);
    for (const prev of this.items) {
      const dx = x - prev.homeDistance;
      const dy = altitude - prev.homeAltitude;
      if (dx * dx + dy * dy < minSep * minSep) {
        x += minSep * range(rng, 0.7, 1.2);
        altitude += this._seq % 2 === 0 ? 10 : -10;
      }
    }

    const vary = range(rng, 0.86, 1.16);
    this._seq += 1;
    this.items.push(
      new RocketObstacle({
        id: `rk-${this.roundId}-${this._seq}`,
        distance: x,
        altitude: Math.max(12, altitude),
        angle: range(rng, spec.angleMin ?? -32, spec.angleMax ?? 36),
        radius,
        scale: range(rng, 0.82, 0.96),
        bob: range(rng, spec.bobMin ?? 3, spec.bobMax ?? 9),
        drift: range(rng, spec.driftMin ?? 2, spec.driftMax ?? 8),
        bobSpeed: range(rng, 0.7, 1.7),
        phase: range(rng, 0, Math.PI * 2),
          damage: {
            multiplier: (spec.rocketMultiplierPenalty ?? 0.18) * vary,
            altitude: (spec.rocketAltitudePenalty ?? 8) * vary,
            speed: spec.rocketSpeedPenalty ?? 0.12,
            deltaSpeed: (spec.rocketSpeedDelta ?? 18) * vary,
            damage: (spec.rocketDamage ?? 0.2) * vary,
            duration: spec.rocketEffectDuration ?? 0.9,
          },
      }),
    );
    return true;
  }

  update(dt) {
    for (const item of this.items) item.update(dt);
  }

  collectHits(planeCollider, previous = null) {
    const hits = [];
    if (!planeCollider) return hits;
    const from = previous ?? { x: planeCollider.x, y: planeCollider.y, radius: planeCollider.radius };
    const to = planeCollider;
    for (const item of this.items) {
      if (!item.active || item.hit || !item.collider.enabled) continue;
      const hit = previous
        ? sweptCircleHit(from, to, item.collider)
        : item.collider.overlaps(planeCollider);
      if (!hit) continue;
      if (!item.explode()) continue;
      hits.push(item);
    }
    return hits;
  }

  visible(origin, viewRange) {
    const near = origin - 90;
    const far = origin + viewRange + 160;
    return this.items.filter((item) => !item.gone && item.distance >= near && item.distance <= far);
  }
}
