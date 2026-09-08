import { catmullRom, clamp } from '../utils/easing.js';
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

function pathPoint(keys, u) {
  const t = clamp(u, 0, 1);
  if (!keys?.length) return { distance: 0, altitude: 0 };
  if (t <= keys[0].u) return { distance: keys[0].distance, altitude: keys[0].altitude };
  const last = keys[keys.length - 1];
  if (t >= last.u) return { distance: last.distance, altitude: last.altitude };

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

function irregularUs(count, u0, u1, rng) {
  const span = u1 - u0;
  const slots = [];
  let u = u0 + rng() * (span * 0.04);
  const avg = span / Math.max(1, count);
  for (let i = 0; i < count; i += 1) {
    slots.push(clamp(u + range(rng, -avg * 0.38, avg * 0.38), u0, u1));
    u += range(rng, avg * 0.62, avg * 1.4);
  }
  slots.sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i += 1) {
    if (slots[i] - slots[i - 1] < avg * 0.34) {
      slots[i] = Math.min(u1, slots[i - 1] + avg * 0.38);
    }
  }
  return slots;
}

/**
 * Spawns and collides rocket obstacles for one round.
 */
export class RocketField {
  constructor(config) {
    this.config = config;
    this.items = [];
    this.roundId = null;
  }

  clear() {
    this.items = [];
    this.roundId = null;
  }

  spawn(roundId, flightPlan) {
    const spec = this.config.rockets ?? {};
    const minCount = spec.minCount ?? 20;
    const extra = spec.extraCount ?? 5;
    const radius = spec.radius ?? 16;
    const seed = ((spec.seed ?? 113) + (Number(roundId) || 0) * 7919) >>> 0;
    const rng = mulberry32(seed);
    const count = minCount + Math.floor(rng() * (extra + 1));
    const keys = flightPlan?.keys ?? [];
    const bands = spec.altitudeBands ?? [-56, -28, 8, 36, 64];
    const minSep = spec.minSeparation ?? 56;
    const distJitter = spec.distanceJitter ?? 16;
    const altJitter = spec.altitudeJitter ?? 12;

    const slots = irregularUs(count, spec.uStart ?? 0.11, spec.uEnd ?? 0.84, rng);
    this.roundId = roundId;
    this.items = [];

    for (let i = 0; i < count; i += 1) {
      const point = pathPoint(keys, slots[i]);
      let distance = point.distance + range(rng, -distJitter, distJitter);
      let altitude = point.altitude + bands[i % bands.length] + range(rng, -altJitter, altJitter);
      for (const prev of this.items) {
        const dx = distance - prev.homeDistance;
        const dy = altitude - prev.homeAltitude;
        if (dx * dx + dy * dy < minSep * minSep) {
          distance += minSep;
          altitude += (i % 2 === 0 ? 10 : -10);
        }
      }

      const vary = range(rng, 0.86, 1.16);
      this.items.push(
        new RocketObstacle({
          id: `rk-${roundId}-${i}`,
          distance,
          altitude: Math.max(12, altitude),
          angle: range(rng, spec.angleMin ?? -32, spec.angleMax ?? 36),
          radius,
          scale: range(rng, 0.84, 1.16),
          bob: range(rng, spec.bobMin ?? 3, spec.bobMax ?? 9),
          drift: range(rng, spec.driftMin ?? 2, spec.driftMax ?? 8),
          bobSpeed: range(rng, 0.7, 1.7),
          phase: range(rng, 0, Math.PI * 2),
          damage: {
            multiplier: (spec.rocketMultiplierPenalty ?? 0.18) * vary,
            altitude: (spec.rocketAltitudePenalty ?? 14) * vary,
            speed: spec.rocketSpeedPenalty ?? 0.22,
            duration: spec.rocketEffectDuration ?? 0.9,
          },
        }),
      );
    }
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
