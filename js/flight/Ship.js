import { Body } from '../physics/Body.js';
import { Collider } from '../physics/Collider.js';

export class Ship {
  constructor(world, landingZone = null) {
    this.world = world;
    const deck = this.deck;
    const zone = landingZone ?? {
      start: world.shipDistance + 8,
      end: world.shipDistance + world.deckLength,
    };
    this.landingZone = zone;
    this.collider = new Collider({
      id: 'target-ship',
      kind: 'ship',
      shape: 'aabb',
      x: deck.start + deck.length * 0.5,
      y: deck.altitude,
      halfW: deck.length * 0.52,
      halfH: 22,
      sensor: true,
      enabled: true,
    });
    this.zoneCollider = new Collider({
      id: 'landing-zone',
      kind: 'landing-zone',
      shape: 'aabb',
      x: (zone.start + zone.end) / 2,
      y: deck.altitude + 8,
      halfW: Math.max(8, (zone.end - zone.start) / 2),
      halfH: 20,
      sensor: true,
      enabled: true,
    });
    this.body = new Body({
      id: 'target-ship',
      collider: this.collider,
      kinematic: true,
      sensor: true,
      x: this.collider.x,
      y: this.collider.y,
    });
    this.zoneBody = new Body({
      id: 'landing-zone',
      collider: this.zoneCollider,
      kinematic: true,
      sensor: true,
      x: this.zoneCollider.x,
      y: this.zoneCollider.y,
    });
  }

  get deck() {
    return {
      start: this.world.shipDistance,
      end: this.world.shipDistance + this.world.deckLength,
      altitude: this.world.deckAltitude,
      length: this.world.deckLength,
    };
  }

  get landingAim() {
    const deck = this.deck;
    return {
      distance: deck.start + deck.length * 0.28,
      altitude: deck.altitude,
    };
  }
}
