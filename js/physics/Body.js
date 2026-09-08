import { clamp } from '../utils/easing.js';
import { Collider } from './Collider.js';

/**
 * Native 2D body in world space (distance, altitude).
 * Kinematic bodies are sensors; the aircraft uses a dynamic body.
 */
export class Body {
  constructor({
    id = '',
    collider = null,
    x = 0,
    y = 0,
    vx = 0,
    vy = 0,
    ax = 0,
    ay = 0,
    mass = 1,
    drag = 0,
    kinematic = true,
    sensor = true,
    radius = 12,
    kind = 'body',
  } = {}) {
    this.id = id;
    this.kinematic = kinematic;
    this.sensor = sensor;
    this.mass = Math.max(0.1, mass);
    this.drag = drag;
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.ax = ax;
    this.ay = ay;
    this.rotation = 0;
    this.omega = 0;
    this.collider =
      collider ??
      new Collider({
        id,
        x,
        y,
        radius,
        kind,
        sensor,
        enabled: true,
      });
    this.syncCollider();
  }

  syncCollider() {
    this.collider.setPosition(this.x, this.y);
    this.collider.sensor = this.sensor;
  }

  setPose(x, y, rotation = this.rotation) {
    this.x = x;
    this.y = y;
    this.rotation = rotation;
    this.syncCollider();
  }
}

export function finite(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

export function sanitizeVelocity(vx, vy, maxSpeed) {
  let x = finite(vx);
  let y = finite(vy);
  if (x === Infinity || x === -Infinity) x = 0;
  if (y === Infinity || y === -Infinity) y = 0;
  const speed = Math.hypot(x, y);
  if (!Number.isFinite(speed) || speed === Infinity) return { vx: 0, vy: 0, speed: 0 };
  if (speed > maxSpeed && speed > 0) {
    const s = maxSpeed / speed;
    x *= s;
    y *= s;
  }
  return { vx: x, vy: y, speed: Math.hypot(x, y) };
}

export function clampImpulse(ix, iy, maxImpulse) {
  const mag = Math.hypot(finite(ix), finite(iy));
  if (!Number.isFinite(mag) || mag === 0) return { x: 0, y: 0 };
  if (mag <= maxImpulse) return { x: ix, y: iy };
  const s = maxImpulse / mag;
  return { x: ix * s, y: iy * s };
}
