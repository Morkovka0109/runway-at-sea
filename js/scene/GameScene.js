/**
 * Home carrier at takeoff and target carrier at landing.
 * At most one ship is bound into the visible pool.
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
  slot.collider.setAabb(52 * (spec.scale ?? 1), 18);
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

function buildLayout(config) {
  const world = config.flight.world;
  return [
    {
      id: 'home',
      distance: 0,
      lateral: 0,
      yaw: 0,
      scale: 1,
      drift: 0,
      role: 'home',
    },
    {
      id: 'target',
      distance: world.shipDistance,
      lateral: 0,
      yaw: 0,
      scale: 1,
      drift: 0,
      role: 'target',
    },
  ];
}

export class GameScene {
  constructor(config) {
    this.config = config;
    this.layout = buildLayout(config);
    const poolSize = config.scene.track?.poolSize ?? 10;
    this.pool = Array.from({ length: poolSize }, () => createSlot());
    this._home = this.layout.find((ship) => ship.role === 'home');
    this._target = this.layout.find((ship) => ship.role === 'target');
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
    const maxVisible = bounds.maxVisible ?? this.config.scene.track?.maxVisible ?? 1;
    const inWindow = this.layout.filter(
      (spec) => force.has(spec.id) || (spec.distance >= near && spec.distance <= far),
    );
    inWindow.sort((a, b) => {
      const forced = (spec) => (force.has(spec.id) ? 0 : 1);
      const dist = (spec) => Math.abs(spec.distance - origin);
      return forced(a) - forced(b) || dist(a) - dist(b);
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
