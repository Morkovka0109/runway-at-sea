import { catmullRom, clamp } from '../utils/easing.js';
import { sweptCircleHit } from '../physics/Collider.js';
import { MultiplierNumber } from './MultiplierNumber.js';

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

function shuffle(list, rng) {
  const items = list.slice();
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
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

/**
 * Spawns and collides collectible multiplier digits for one round.
 */
export class MultiplierNumberField {
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
    const spec = this.config.numberPickups ?? {};
    const minCount = spec.minCount ?? 20;
    const extra = spec.extraCount ?? 4;
    const numberMin = spec.numberMin ?? 1;
    const numberMax = spec.numberMax ?? 10;
    const radius = spec.numberRadius ?? 15;
    const seed = ((spec.seed ?? 91) + (Number(roundId) || 0) * 9973) >>> 0;
    const rng = mulberry32(seed);
    const count = minCount + Math.floor(rng() * (extra + 1));
    const keys = flightPlan?.keys ?? [];

    const values = [];
    for (let i = 0; i < count; i += 1) {
      values.push(numberMin + (i % (numberMax - numberMin + 1)));
    }
    const shuffled = shuffle(values, rng);

    const u0 = spec.uStart ?? 0.06;
    const u1 = spec.uEnd ?? 0.9;
    const slots = chaoticUs(count, u0, u1, rng);
    const altJitter = spec.altitudeJitter ?? 42;
    const distJitter = spec.distanceJitter ?? 64;
    const minSep = spec.minSeparation ?? 28;
    const bands = spec.altitudeBands ?? [-92, -58, -30, -8, 14, 40, 72, 108];
    const latMin = spec.lateralMin ?? 28;
    const latMax = spec.lateralMax ?? 148;
    const water = this.config.flight?.world?.waterLevel ?? 0;
    const maxAlt = this.config.physics?.maxAltitude ?? 360;

    this.roundId = roundId;
    this.items = [];
    for (let i = 0; i < count; i += 1) {
      const point = pathPoint(keys, slots[i]);
      const band = bands[Math.floor(rng() * bands.length)];
      let distance = point.distance + range(rng, -distJitter, distJitter);
      let altitude = point.altitude + band + range(rng, -altJitter, altJitter);
      const side = rng() < 0.5 ? -1 : 1;
      let lateral = side * range(rng, latMin, latMax);
      if (rng() < 0.18) lateral *= range(rng, 0.15, 0.45);

      for (let attempt = 0; attempt < 6; attempt += 1) {
        let bumped = false;
        for (const prev of this.items) {
          const dx = distance - prev.distance;
          const dy = altitude - prev.altitude;
          if (dx * dx + dy * dy < minSep * minSep) {
            distance += minSep * range(rng, 0.7, 1.35) * (rng() < 0.5 ? -1 : 1);
            altitude += minSep * range(rng, 0.35, 0.9) * (rng() < 0.5 ? -1 : 1);
            bumped = true;
          }
        }
        if (!bumped) break;
      }

      this.items.push(
        new MultiplierNumber({
          id: `mn-${roundId}-${i}`,
          number: shuffled[i],
          distance,
          altitude: clamp(altitude, water + 8, maxAlt),
          radius,
          scale: range(rng, 0.78, 1.22),
          lateral,
        }),
      );
    }
  }

  update(dt) {
    for (const item of this.items) item.update(dt);
  }

  /**
   * Returns newly collected numbers. Each item can fire only once.
   */
  collectHits(planeCollider, previous = null) {
    const hits = [];
    if (!planeCollider) return hits;
    const from = previous ?? { x: planeCollider.x, y: planeCollider.y, radius: planeCollider.radius };
    const to = planeCollider;

    for (const item of this.items) {
      if (item.collected || item.hit || !item.collider.enabled) continue;
      const hit = previous
        ? sweptCircleHit(from, to, item.collider)
        : item.collider.overlaps(planeCollider);
      if (!hit) continue;
      if (!item.collect()) continue;
      hits.push(item);
    }
    return hits;
  }

  visible(origin, viewRange) {
    const near = origin - 80;
    const far = origin + viewRange + 140;
    return this.items.filter((item) => !item.gone && item.distance >= near && item.distance <= far);
  }
}

function chaoticUs(count, u0, u1, rng) {
  const span = u1 - u0;
  const slots = [];
  for (let i = 0; i < count; i += 1) {
    if (slots.length && rng() < 0.2) {
      const cluster = slots[Math.floor(rng() * slots.length)];
      slots.push(clamp(cluster + range(rng, -span * 0.035, span * 0.035), u0, u1));
      continue;
    }
    slots.push(range(rng, u0, u1));
  }
  return slots;
}
