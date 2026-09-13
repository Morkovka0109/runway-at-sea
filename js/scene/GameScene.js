/**
 * Home carrier, target carrier, and irregular ambient ships along the sea.
 * Only ships inside the current side-scroll window are bound into the pool.
 */
import { Body } from '../physics/Body.js';
import { Collider } from '../physics/Collider.js';

function createSlot() {
  const collider = new Collider({
    id: '',
    kind: 'ship',
    shape: 'aabb',
    halfW: 48,
    halfH: 16,
    sensor: true,
    enabled: false,
  });
  const zoneCollider = new Collider({
    id: '',
    kind: 'landing-zone',
    shape: 'aabb',
    halfW: 70,
    halfH: 20,
    sensor: true,
    enabled: false,
  });
  return {
    active: false,
    id: '',
    distance: 0,
    lateral: 0,
    yaw: 0,
    scale: 1,
    drift: 0,
    role: 'ambient',
    collider,
    zoneCollider,
    body: new Body({ collider, kinematic: true, sensor: true, kind: 'ship' }),
    zoneBody: new Body({
      collider: zoneCollider,
      kinematic: true,
      sensor: true,
      kind: 'landing-zone',
    }),
  };
}

function bindSlot(slot, spec, extras = {}) {
  slot.active = true;
  slot.id = spec.id;
  slot.distance = spec.distance;
  slot.lateral = spec.lateral;
  slot.yaw = spec.yaw;
  slot.scale = spec.scale;
  slot.drift = spec.drift ?? 0;
  slot.role = spec.role;
  const deckAlt = (extras.deckAltitude ?? 26) + (spec.drift ?? 0);
  slot.collider.id = spec.id;
  slot.collider.kind = spec.role === 'target' ? 'ship-target' : 'ship';
  slot.collider.enabled = true;
  slot.collider.sensor = true;
  slot.collider.setAabb(
    (extras.shipHalfW ?? 84) * (spec.scale ?? 1),
    extras.shipHalfH ?? 18,
  );
  slot.collider.setPosition(spec.distance, deckAlt);
  slot.body.id = spec.id;
  slot.body.setPose(spec.distance, deckAlt);

  const zone = extras.landingZone;
  if (spec.role === 'target' && zone) {
    slot.zoneCollider.id = 'landing-zone';
    slot.zoneCollider.kind = 'landing-zone';
    slot.zoneCollider.enabled = true;
    slot.zoneCollider.sensor = true;
    slot.zoneCollider.setAabb(Math.max(8, (zone.end - zone.start) / 2), 20);
    slot.zoneCollider.setPosition((zone.start + zone.end) / 2, deckAlt + 8);
    slot.zoneBody.id = 'landing-zone';
    slot.zoneBody.setPose(slot.zoneCollider.x, slot.zoneCollider.y);
  } else {
    slot.zoneCollider.enabled = false;
  }
}

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

function shipSpec(id, distance, role, extras = {}) {
  return {
    id,
    distance,
    lateral: 0,
    yaw: 0,
    scale: extras.scale ?? 1,
    drift: extras.drift ?? 0,
    role,
  };
}

function minShipGap(config) {
  const track = config.scene.track ?? {};
  const shipLen = config.scene.objectScale?.shipWorldLength ?? 176;
  return Math.max(track.minGap ?? 0, shipLen * 2.25 + 48);
}

function randomShipGap(rng, config) {
  const min = minShipGap(config);
  const max = Math.max(min + 80, config.scene.track?.maxGap ?? min + 460);
  return min + rng() * (max - min);
}

function canPlaceAmbient(distance, target, keepBefore, keepAfter, lastDistance, minGap) {
  const inKeepOut = distance > target - keepBefore && distance < target + keepAfter;
  if (inKeepOut || Math.abs(distance - target) < minGap) return false;
  if (Number.isFinite(lastDistance) && distance - lastDistance < minGap) return false;
  return true;
}

function buildLayout(config, rng, cursor) {
  const world = config.flight.world;
  const track = config.scene.track ?? {};
  const target = world.shipDistance ?? 1280;
  const keepBefore = track.keepOutBeforeTarget ?? 200;
  const keepAfter = track.keepOutAfterTarget ?? 220;
  const length = track.length ?? 2100;
  const driftAmp = track.drift ?? 6;
  const minGap = minShipGap(config);

  const ships = [shipSpec('home', 0, 'home', { scale: 1, drift: 0 })];
  cursor.distance = 0;
  cursor.n = 0;
  let last = 0;

  while (cursor.distance < length) {
    cursor.distance += randomShipGap(rng, config);
    if (cursor.distance >= length) break;
    if (!canPlaceAmbient(cursor.distance, target, keepBefore, keepAfter, last, minGap)) continue;
    last = cursor.distance;
    cursor.n += 1;
    ships.push(
      shipSpec(`sea-${cursor.n}`, cursor.distance, 'ambient', {
        scale: 0.9 + rng() * 0.14,
        drift: (rng() - 0.5) * 2 * driftAmp,
      }),
    );
  }

  ships.push(
    shipSpec('target', target, 'target', {
      scale: 1,
      drift: (rng() - 0.5) * 3,
    }),
  );
  ships.sort((a, b) => a.distance - b.distance);
  return ships;
}

export class GameScene {
  constructor(config) {
    this.config = config;
    const track = config.scene.track ?? {};
    this._rng = mulberry32(track.seed ?? 47);
    this._cursor = { distance: 0, n: 0 };
    this.layout = buildLayout(config, this._rng, this._cursor);
    const poolSize = track.poolSize ?? 14;
    this.pool = Array.from({ length: poolSize }, () => createSlot());
    this._home = this.layout.find((ship) => ship.role === 'home');
    this._target = this.layout.find((ship) => ship.role === 'target');
  }

  /**
   * Append ambient carriers ahead of the camera so the sea never shows a hard end.
   */
  ensureAhead(origin, viewRange) {
    const track = this.config.scene.track ?? {};
    const world = this.config.flight.world;
    const target = world.shipDistance ?? 1280;
    const keepBefore = track.keepOutBeforeTarget ?? 200;
    const keepAfter = track.keepOutAfterTarget ?? 220;
    const driftAmp = track.drift ?? 6;
    const minGap = minShipGap(this.config);
    const lastPlaced = this.layout.reduce((max, ship) => Math.max(max, ship.distance), 0);
    this._cursor.distance = Math.max(this._cursor.distance, lastPlaced);
    const far = origin + viewRange + (track.spawnAhead ?? 520);
    let guard = 0;
    while (this._cursor.distance < far && guard < 10) {
      this._cursor.distance += randomShipGap(this._rng, this.config);
      guard += 1;
      const last = this.layout[this.layout.length - 1]?.distance ?? 0;
      if (!canPlaceAmbient(this._cursor.distance, target, keepBefore, keepAfter, last, minGap)) continue;
      this._cursor.n += 1;
      this.layout.push(
        shipSpec(`sea-${this._cursor.n}`, this._cursor.distance, 'ambient', {
          scale: 0.9 + this._rng() * 0.14,
          drift: (this._rng() - 0.5) * 2 * driftAmp,
        }),
      );
    }
  }

  get home() {
    return this._home;
  }

  get target() {
    return this._target;
  }

  get ships() {
    return this.pool.filter((slot) => slot.active);
  }

  syncVisible(origin, viewRange, bounds = {}) {
    const near = bounds.near ?? origin - 40;
    const far = bounds.far ?? origin + viewRange + 40;
    const force = new Set(bounds.forceIds ?? []);
    const maxVisible = bounds.maxVisible ?? this.config.scene.track?.maxVisible ?? 4;
    const inWindow = this.layout.filter(
      (spec) => force.has(spec.id) || (spec.distance >= near && spec.distance <= far),
    );
    inWindow.sort((a, b) => {
      const forced = (spec) => (force.has(spec.id) ? 0 : 1);
      return forced(a) - forced(b) || a.distance - b.distance;
    });
    const needed = inWindow.slice(0, Math.max(1, maxVisible));
    const keep = new Set(needed.map((spec) => spec.id));

    for (const slot of this.pool) {
      if (slot.active && !keep.has(slot.id)) {
        slot.active = false;
        slot.collider.enabled = false;
        slot.zoneCollider.enabled = false;
      }
    }

    const extras = {
      landingZone: this.config.roundResult?.landingZone,
      deckAltitude: this.config.flight.world?.deckAltitude ?? 26,
      shipHalfW: this.config.scene.objectScale?.shipHalfW ?? 84,
      shipHalfH: this.config.scene.objectScale?.shipHalfH ?? 18,
    };
    for (const spec of needed) {
      const bound = this.pool.find((slot) => slot.active && slot.id === spec.id);
      if (bound) {
        bindSlot(bound, spec, extras);
        continue;
      }
      const free = this.pool.find((slot) => !slot.active);
      if (free) bindSlot(free, spec, extras);
    }
  }

  shipsBackToFront() {
    return this.pool.filter((slot) => slot.active).sort((a, b) => b.distance - a.distance);
  }
}
