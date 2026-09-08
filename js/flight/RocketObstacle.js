import { Body } from '../physics/Body.js';
import { Collider } from '../physics/Collider.js';

/**
 * A rocket obstacle on the flight path. Collision is world-space;
 * visuals are handled by AnimationController.
 */
export class RocketObstacle {
  constructor({
    id,
    distance,
    altitude,
    angle = 0,
    radius = 16,
    scale = 1,
    bob = 0,
    drift = 0,
    bobSpeed = 1.2,
    phase = 0,
    damage,
  }) {
    this.id = id;
    this.homeDistance = distance;
    this.homeAltitude = altitude;
    this.distance = distance;
    this.altitude = altitude;
    this.angle = angle;
    this.scale = scale;
    this.bob = bob;
    this.drift = drift;
    this.bobSpeed = bobSpeed;
    this.phase = phase;
    this.time = 0;
    this.active = true;
    this.hit = false;
    this.pop = 0;
    this.damage = {
      multiplier: 0.18,
      altitude: 14,
      speed: 0.22,
      duration: 0.9,
      ...damage,
    };
    this.collider = new Collider({
      id,
      x: distance,
      y: altitude,
      radius,
      kind: 'rocket',
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
      kind: 'rocket',
    });
  }

  explode() {
    if (!this.active || this.hit) return false;
    this.active = false;
    this.hit = true;
    this.pop = 0.0001;
    this.collider.enabled = false;
    this.body.vx = 0;
    this.body.vy = 0;
    return true;
  }

  update(dt) {
    this.time += dt;
    if (this.hit) {
      this.pop = Math.min(1.2, this.pop + dt / 0.32);
      return;
    }
    const wave = this.time * this.bobSpeed + this.phase;
    this.distance = this.homeDistance + Math.sin(wave * 0.85) * this.drift;
    this.altitude = this.homeAltitude + Math.sin(wave) * this.bob;
    this.collider.setPosition(this.distance, this.altitude);
    this.body.x = this.distance;
    this.body.y = this.altitude;
    this.body.syncCollider();
  }

  get gone() {
    return this.hit && this.pop >= 1;
  }
}
