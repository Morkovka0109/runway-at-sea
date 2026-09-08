import { Body } from '../physics/Body.js';
import { Collider } from '../physics/Collider.js';

export class Aircraft {
  constructor() {
    this.collider = new Collider({
      id: 'aircraft',
      kind: 'aircraft',
      radius: 18,
      enabled: true,
      sensor: false,
      shape: 'circle',
    });
    this.body = new Body({
      id: 'aircraft',
      collider: this.collider,
      kinematic: false,
      sensor: false,
      mass: 1,
      kind: 'aircraft',
    });
    this.reset();
  }

  reset() {
    this.distance = 0;
    this.altitude = 0;
    this.speed = 0;
    this.pitch = 0;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.phase = 'idle';
    this.body.vx = 0;
    this.body.vy = 0;
    this.body.ax = 0;
    this.body.ay = 0;
    this.body.omega = 0;
    this.body.setPose(0, 0, 0);
    this.collider.enabled = true;
  }

  setPose(pose) {
    this.distance = pose.distance;
    this.altitude = pose.altitude;
    this.speed = pose.speed;
    this.pitch = pose.pitch;
    this.x = pose.x;
    this.y = pose.y;
    this.vx = pose.vx ?? this.vx ?? 0;
    this.vy = pose.vy ?? this.vy ?? 0;
    this.phase = pose.phase;
    this.collider.setPosition(this.distance, this.altitude);
    if (pose.fromPhysics) {
      this.body.x = this.distance;
      this.body.y = this.altitude;
      this.body.rotation = this.pitch ?? 0;
      if (Number.isFinite(pose.vx)) this.body.vx = pose.vx;
      if (Number.isFinite(pose.vy)) this.body.vy = pose.vy;
      this.body.syncCollider();
    }
  }
}
