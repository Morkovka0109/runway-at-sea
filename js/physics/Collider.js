import { clamp } from '../utils/easing.js';

/**
 * Native collider in world space (distance, altitude).
 * Circles for plane / pickups / rockets; AABB for ships and the landing zone.
 * Swept tests prevent tunneling when the plane moves quickly.
 */
export class Collider {
  constructor({
    id,
    x = 0,
    y = 0,
    radius = 12,
    kind = 'generic',
    enabled = true,
    sensor = true,
    shape = 'circle',
    halfW = 12,
    halfH = 12,
  } = {}) {
    this.id = id ?? '';
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.kind = kind;
    this.enabled = enabled;
    this.sensor = sensor;
    this.shape = shape;
    this.halfW = halfW;
    this.halfH = halfH;
  }

  setPosition(x, y) {
    this.x = x;
    this.y = y;
  }

  setAabb(halfW, halfH) {
    this.shape = 'aabb';
    this.halfW = halfW;
    this.halfH = halfH;
  }

  overlaps(other) {
    if (!this.enabled || !other?.enabled) return false;
    return collidersOverlap(this, other);
  }

  hitsSwept(from, to = this) {
    if (!this.enabled) return false;
    return sweptHits(from, to, this);
  }
}

export function collidersOverlap(a, b) {
  if (a.shape === 'aabb' && b.shape !== 'aabb') return circleAabb(b, a);
  if (b.shape === 'aabb' && a.shape !== 'aabb') return circleAabb(a, b);
  if (a.shape === 'aabb' && b.shape === 'aabb') return aabbAabb(a, b);
  return circlesOverlap(a, b);
}

export function circlesOverlap(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = a.radius + b.radius;
  return dx * dx + dy * dy <= r * r;
}

export function circleAabb(circle, box) {
  const cx = clamp(circle.x, box.x - box.halfW, box.x + box.halfW);
  const cy = clamp(circle.y, box.y - box.halfH, box.y + box.halfH);
  const dx = circle.x - cx;
  const dy = circle.y - cy;
  return dx * dx + dy * dy <= circle.radius * circle.radius;
}

export function aabbAabb(a, b) {
  return (
    Math.abs(a.x - b.x) <= a.halfW + b.halfW &&
    Math.abs(a.y - b.y) <= a.halfH + b.halfH
  );
}

/**
 * True if a circle moving from `from` to `to` intersects `other`.
 */
export function sweptCircleHit(from, to, other) {
  if (!other?.enabled) return false;
  return sweptHits(from, to, other);
}

function sweptHits(from, to, other) {
  const moving = {
    x: to.x,
    y: to.y,
    radius: to.radius ?? from.radius ?? 12,
  };
  if (other.shape === 'aabb') {
    if (circleAabb(moving, other)) return true;
    if (circleAabb({ x: from.x, y: from.y, radius: moving.radius }, other)) return true;
    const samples = 3;
    for (let i = 1; i <= samples; i += 1) {
      const t = i / (samples + 1);
      const probe = {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        radius: moving.radius,
      };
      if (circleAabb(probe, other)) return true;
    }
    return false;
  }

  const r = moving.radius + (other.radius ?? 0);
  const r2 = r * r;
  if (dist2(to.x, to.y, other.x, other.y) <= r2) return true;
  if (dist2(from.x, from.y, other.x, other.y) <= r2) return true;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) return false;

  const t = clamp(((other.x - from.x) * dx + (other.y - from.y) * dy) / len2, 0, 1);
  const px = from.x + dx * t;
  const py = from.y + dy * t;
  return dist2(px, py, other.x, other.y) <= r2;
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
