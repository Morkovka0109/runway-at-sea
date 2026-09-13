import { clamp } from '../utils/easing.js';
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

/**
 * Spawns and collides collectible multiplier digits for one round.
 * Initial fill covers the flight path; ensureAhead streams more as the plane flies.
 */
export class MultiplierNumberField {
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
    this._bag = [];
    this._wave = 96;
  }

  clear() {
    this.items = [];
    this.roundId = null;
    this._resetStream();
  }

  spawn(roundId, flightPlan) {
    const spec = this.config.numberPickups ?? {};
    const minCount = spec.minCount ?? 20;
    const extra = spec.extraCount ?? 4;
    const seed = ((spec.seed ?? 91) + (Number(roundId) || 0) * 9973) >>> 0;
    const rng = mulberry32(seed);
    const keys = flightPlan?.keys ?? [];
    const last = keys[keys.length - 1];
    const pathEnd = Math.max((last?.distance ?? 1280) * 0.98, 720);
    const guaranteed = minCount + Math.floor(rng() * (extra + 1));

    this.roundId = roundId;
    this.items = [];
    this._rng = rng;
    this._keys = keys;
    this._seq = 0;
    this._bag = [];
    this._next = (spec.startDistance ?? 56) + range(rng, 4, 36);
    this._wave = (this.config.flight?.world?.startAltitude ?? 26) + 70;
    const floor = spec.waveMin ?? 36;
    const ceil = spec.waveMax ?? 190;
    const step = spec.waveStep ?? 34;
    while (this._seq < guaranteed || this._next < pathEnd) {
      this._wave = clamp(this._wave + range(rng, -step, step), floor, ceil);
      if (!this._placeOne(this._next, this._wave)) break;
      this._next += range(rng, spec.gapMin ?? 28, spec.gapMax ?? 86);
    }
  }

  /**
   * Keep digits in front of the aircraft for as long as the round continues.
   */
  ensureAhead(distance, altitude) {
    if (!this._rng) return;
    const spec = this.config.numberPickups ?? {};
    const spawnAhead = spec.spawnAhead ?? 460;
    const despawnBehind = spec.despawnBehind ?? 240;
    const maxLive = spec.maxLive ?? 72;
    const horizon = distance + spawnAhead;

    this.items = this.items.filter((item) => {
      if (item.gone) return false;
      if (item.hit) return item.distance > distance - 90;
      return item.distance > distance - despawnBehind;
    });

    const floor = spec.waveMin ?? 36;
    const ceil = spec.waveMax ?? 190;
    const step = spec.waveStep ?? 34;
    let guard = 0;
    while (this._next < horizon && this.items.length < maxLive && guard < 24) {
      const around = Number.isFinite(altitude) ? altitude : this._wave;
      this._wave = clamp(around + range(this._rng, -step, step), floor, ceil);
      if (!this._placeOne(this._next, this._wave)) break;
      this._next += range(this._rng, spec.gapMin ?? 28, spec.gapMax ?? 86);
      guard += 1;
    }
  }

  _nextNumber() {
    const spec = this.config.numberPickups ?? {};
    const numberMin = spec.numberMin ?? 1;
    const numberMax = spec.numberMax ?? 10;
    if (!this._bag.length) {
      const bag = [];
      for (let n = numberMin; n <= numberMax; n += 1) bag.push(n);
      this._bag = shuffle(bag, this._rng);
    }
    return this._bag.pop();
  }

  _placeOne(distance, pathAltitude) {
    const spec = this.config.numberPickups ?? {};
    const rng = this._rng;
    const maxLive = spec.maxLive ?? 72;
    if (!rng || this.items.length >= maxLive) return false;

    const radius = spec.numberRadius ?? 8;
    const altJitter = spec.altitudeJitter ?? 42;
    const distJitter = spec.distanceJitter ?? 28;
    const minSep = spec.minSeparation ?? 36;
    const bands = spec.altitudeBands ?? [-92, -58, -30, -8, 14, 40, 72, 108];
    const latMin = spec.lateralMin ?? 28;
    const latMax = spec.lateralMax ?? 148;
    const water = this.config.flight?.world?.waterLevel ?? 0;
    const maxAlt = this.config.physics?.maxAltitude ?? 360;

    let x = distance + range(rng, -distJitter * 0.35, distJitter * 0.35);
    const band = bands[Math.floor(rng() * bands.length)];
    let altitude = pathAltitude + band + range(rng, -altJitter, altJitter);
    const side = rng() < 0.5 ? -1 : 1;
    let lateral = side * range(rng, latMin, latMax);
    if (rng() < 0.18) lateral *= range(rng, 0.15, 0.45);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      let bumped = false;
      for (const prev of this.items) {
        const dx = x - prev.distance;
        const dy = altitude - prev.altitude;
        if (dx * dx + dy * dy < minSep * minSep) {
          x += minSep * range(rng, 0.55, 1.15) * (rng() < 0.5 ? -1 : 1);
          altitude += minSep * range(rng, 0.3, 0.8) * (rng() < 0.5 ? -1 : 1);
          bumped = true;
        }
      }
      if (!bumped) break;
    }

    this._seq += 1;
    this.items.push(
      new MultiplierNumber({
        id: `mn-${this.roundId}-${this._seq}`,
        number: this._nextNumber(),
        distance: x,
        altitude: clamp(altitude, water + 8, maxAlt),
        radius,
        scale: range(rng, 0.52, 0.7),
        lateral,
      }),
    );
    return true;
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
