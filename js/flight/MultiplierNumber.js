import { Body } from '../physics/Body.js';
import { Collider } from '../physics/Collider.js';

/**
 * A collectible digit on the flight path. Collision is world-space;
 * visuals are handled by AnimationController.
 */
export class MultiplierNumber {
  constructor({
    id,
    number,
    distance,
    altitude,
    radius = 15,
    scale = 1,
    lateral = 0,
  }) {
    this.id = id;
    this.number = number;
    this.distance = distance;
    this.altitude = altitude;
    this.scale = scale;
    this.lateral = lateral;
    this.collected = false;
    this.hit = false;
    this.pop = 0;
    this.collider = new Collider({
      id,
      x: distance,
      y: altitude,
      radius,
      kind: 'multiplier-number',
      enabled: true,
      sensor: true,
      shape: 'circle',
    });
    this.body = new Body({
      id,
      collider: this.collider,
      kinematic: true,
      sensor: true,
      x: distance,
      y: altitude,
      kind: 'multiplier-number',
    });
  }

  collect() {
    if (this.collected || this.hit) return false;
    this.collected = true;
    this.hit = true;
    this.pop = 0.0001;
    this.collider.enabled = false;
    this.body.sensor = true;
    return true;
  }

  update(dt) {
    if (!this.hit) return;
    this.pop = Math.min(1.2, this.pop + dt / 0.28);
  }

  get gone() {
    return this.hit && this.pop >= 1;
  }
}
