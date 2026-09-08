/**
 * Lightweight world-space particles. Visual only.
 */
export class ParticleField {
  constructor(limit = 140) {
    this.limit = limit;
    this.items = [];
  }

  clear() {
    this.items = [];
  }

  spawn(spec) {
    if (this.items.length >= this.limit) this.items.shift();
    this.items.push({
      distance: 0,
      altitude: 0,
      vx: 0,
      vy: 0,
      ay: 0,
      life: 1,
      ttl: 1,
      size: 4,
      wind: 0.2,
      drag: 0.98,
      kind: 'dust',
      ...spec,
    });
  }

  update(sec, wind = 0) {
    const next = [];
    for (const p of this.items) {
      p.life -= sec / Math.max(0.05, p.ttl);
      if (p.life <= 0) continue;
      p.distance += (p.vx + wind * p.wind) * sec;
      p.altitude += p.vy * sec;
      p.vy += p.ay * sec;
      p.vx *= p.drag;
      p.vy *= p.drag;
      next.push(p);
    }
    this.items = next;
  }
}
