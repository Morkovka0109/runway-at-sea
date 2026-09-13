import { clamp, inverseLerp, lerp } from '../utils/easing.js';
import { AssetLoader } from '../scene/AssetLoader.js?v=red2';
import { CameraRig } from '../scene/CameraRig.js?v=deck-up';
import { GameScene } from '../scene/GameScene.js?v=pickup-sea';
import { ParticleField } from '../scene/ParticleField.js';

/**
 * Renders the main field. Does not decide round outcomes.
 */
export class AnimationController {
  constructor(canvas, aircraft, ship, config) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.aircraft = aircraft;
    this.ship = ship;
    this.config = config;
    this.scene = new GameScene(config);
    this.camera = new CameraRig(config);
    this.loader = new AssetLoader(config.scene.assets);
    this.assets = null;
    this.sample = null;
    this._homeRect = null;
    this._shipRects = {};
    this.particles = new ParticleField(420);
    this._wrecked = false;
    this.numberField = null;
    this.rocketField = null;
    this.clouds = this._makeClouds();
    this.glints = this._makeGlints();
    this.time = 0;
    this.dpr = 1;
    this._plane = null;
    this._coefPops = [];
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
    this.ready = this.loader.load().then((assets) => {
      this.assets = assets;
      this.resize();
      return assets;
    });
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
  }

  reset() {
    this.camera.reset();
    this.particles.clear();
    this.numberField = null;
    this.rocketField = null;
    this._plane = null;
    this._coefPops = [];
    this._wrecked = false;
  }

  prepareRound(numberField, rocketField) {
    this.particles.clear();
    this.numberField = numberField ?? null;
    this.rocketField = rocketField ?? null;
    this._coefPops = [];
    this._wrecked = false;
  }

  returnToIdle(sample) {
    this.particles.clear();
    this.numberField = null;
    this.rocketField = null;
    this._plane = null;
    this._coefPops = [];
    this._wrecked = false;
    this.sample = sample;
  }

  onNumberHit(item, applied = null) {
    if (!item) return;
    this.camera.impulse(0.2);
    const delta = applied?.delta;
    if (Number.isFinite(delta) && delta > 0) {
      this._coefPops.push({
        distance: item.distance,
        altitude: item.altitude + 12,
        text: `+${delta.toFixed(2)}`,
        ttl: 0.85,
        life: 0.85,
      });
    }
    for (let i = 0; i < 10; i += 1) {
      this.particles.spawn({
        kind: 'spark',
        distance: item.distance + (Math.random() - 0.5) * 10,
        altitude: item.altitude + (Math.random() - 0.5) * 8,
        vx: (Math.random() - 0.5) * 70,
        vy: 12 + Math.random() * 36,
        ay: -24,
        ttl: 0.42,
        size: 2 + Math.random() * 3,
        wind: 0.08,
      });
    }
    this.particles.spawn({
      kind: 'flash',
      distance: item.distance,
      altitude: item.altitude,
      vx: 0,
      vy: 8,
      ttl: 0.32,
      size: 18,
    });
  }

  onRocketHit(rocket) {
    if (!rocket) return;
    this.camera.impulse(0.22);
    for (let i = 0; i < 7; i += 1) {
      this.particles.spawn({
        kind: 'spark',
        distance: rocket.distance + (Math.random() - 0.5) * 12,
        altitude: rocket.altitude + (Math.random() - 0.5) * 10,
        vx: (Math.random() - 0.5) * 80,
        vy: 16 + Math.random() * 28,
        ay: -30,
        ttl: 0.4,
        size: 2 + Math.random() * 2.5,
        wind: 0.12,
      });
    }
    for (let i = 0; i < 4; i += 1) {
      this.particles.spawn({
        kind: 'smoke',
        distance: rocket.distance + (Math.random() - 0.5) * 8,
        altitude: rocket.altitude + Math.random() * 6,
        vx: -8 + Math.random() * 16,
        vy: 8 + Math.random() * 12,
        ay: 6,
        ttl: 0.7,
        size: 6 + Math.random() * 6,
        wind: 0.55,
        drag: 0.96,
      });
    }
    this.particles.spawn({
      kind: 'flash',
      distance: rocket.distance,
      altitude: rocket.altitude,
      vx: 0,
      vy: 6,
      ttl: 0.28,
      size: 16,
    });
  }

  show(sample) {
    this.sample = sample;
    if (sample?.effects?.touchdownPulse) {
      this._spawnLandingBurst(sample);
      this.camera.impulse(0.72);
    }
    if (sample?.effects?.splashPulse) {
      this._wrecked = true;
      this._spawnSplash(sample);
      this._spawnWaterBurst(sample);
      this._spawnSmoke(sample, 22);
      this.camera.impulse(1.15);
    }
  }

  render(dt) {
    this.time += dt;
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    this.camera.update(dt, this.sample, { w, h });
    this._streamWorld();
    const sec = dt / 1000;
    const wind = this.camera.wind * 22;
    this._updateClouds(sec, wind);
    this._emitAmbient(sec);
    this.particles.update(sec, wind);
    this._updateCoefPops(sec);
    ctx.clearRect(0, 0, w, h);
    this._drawBackdrop(w, h);
    this._drawClouds(w, h);
    this._drawHorizon(w, h);
    this._drawWater(w, h);
    this._drawFleet(w, h);
    this._drawNumbers(w, h);
    this._drawCoefPops(w, h);
    this._drawRockets(w, h);
    this._plane = this._planeLayout(w, h);
    this._drawShadows(w, h);
    this._drawReflection(w, h);
    this._drawParticles(w, h, ['trail', 'smoke', 'fire']);
    this._drawAircraft(w, h);
    this._drawParticles(w, h, ['dust', 'spark', 'splash', 'flash', 'foam', 'wreck', 'spray']);
  }

  _horizonY(h) {
    return h * this.config.scene.horizonRatio;
  }

  _ppm(w, h) {
    const range = Math.max(1, this.config.scene.viewRange ?? 240);
    return w / range;
  }

  _streamWorld() {
    const origin = this.camera.origin ?? 0;
    const viewRange = this.config.scene.viewRange ?? 240;
    const distance = this.sample?.distance ?? 0;
    const altitude = this.sample?.altitude ?? 80;
    this.scene.ensureAhead(origin, viewRange);
    this.numberField?.ensureAhead?.(distance, altitude);
    this.rocketField?.ensureAhead?.(distance, altitude);
  }

  _worldPx(world, w, h) {
    return world * this._ppm(w, h);
  }

  _objectScale() {
    return this.config.scene.objectScale ?? {};
  }

  _makeClouds() {
    const clouds = [];
    for (let i = 0; i < 9; i += 1) {
      clouds.push({
        x: Math.random(),
        y: 0.06 + Math.random() * 0.28,
        w: 0.12 + Math.random() * 0.18,
        h: 0.03 + Math.random() * 0.04,
        speed: 0.006 + Math.random() * 0.01,
        alpha: 0.22 + Math.random() * 0.18,
        layer: i % 3,
      });
    }
    return clouds;
  }

  _makeGlints() {
    const glints = [];
    for (let i = 0; i < 16; i += 1) {
      glints.push({
        x: Math.random(),
        y: Math.random(),
        phase: Math.random() * Math.PI * 2,
        size: 1 + Math.random() * 2,
      });
    }
    return glints;
  }

  _updateClouds(sec, wind) {
    for (const cloud of this.clouds) {
      cloud.x += (cloud.speed + wind * 0.00035) * sec * 18;
      if (cloud.x > 1.25) cloud.x = -0.25;
      if (cloud.x < -0.25) cloud.x = 1.25;
    }
  }

  _emitAmbient(sec) {
    const sample = this.sample;
    if (!sample || sample.phase === 'idle') return;
    if (sample.speed > 24 && Math.random() < 0.65) {
      this.particles.spawn({
        kind: 'trail',
        distance: sample.distance - 8,
        altitude: sample.altitude + 2,
        vx: -18,
        vy: 2,
        ttl: 0.55,
        size: 5,
        wind: 0.4,
      });
    }
    const crashing = sample.phase === 'CRASH' || sample.effects?.smoke;
    if (crashing && Math.random() < 0.55) {
      this._spawnSmoke(sample, 1);
    }
    if (crashing && !this._wrecked && sample.altitude < 34 && sample.altitude > 2 && Math.random() < 0.7) {
      this.particles.spawn({
        kind: 'spray',
        distance: sample.distance + (Math.random() - 0.5) * 16,
        altitude: 1 + Math.random() * 4,
        vx: (Math.random() - 0.5) * 36,
        vy: 14 + Math.random() * 28,
        ay: -70,
        ttl: 0.35 + Math.random() * 0.2,
        size: 3 + Math.random() * 4,
      });
    }
    if (this._wrecked && Math.random() < 0.8) {
      this.particles.spawn({
        kind: 'fire',
        distance: sample.distance + (Math.random() - 0.5) * 14,
        altitude: 2 + Math.random() * 8,
        vx: (Math.random() - 0.5) * 18,
        vy: 10 + Math.random() * 18,
        ay: 6,
        ttl: 0.45 + Math.random() * 0.3,
        size: 5 + Math.random() * 7,
        wind: 0.35,
      });
      this.particles.spawn({
        kind: 'foam',
        distance: sample.distance + (Math.random() - 0.5) * 22,
        altitude: 1,
        vx: (Math.random() - 0.5) * 16,
        vy: 2,
        ay: -8,
        ttl: 0.7,
        size: 8 + Math.random() * 8,
        drag: 0.94,
      });
    }
  }

  _drawBackdrop(w, h) {
    const ctx = this.ctx;
    const sky = this.assets?.sky;
    if (!sky) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#16324a');
      g.addColorStop(0.4, '#c56a32');
      g.addColorStop(this.config.scene.horizonRatio, '#f0b060');
      g.addColorStop(1, '#08141c');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    const imgHorizon = this.config.scene.imageHorizon;
    const targetHorizon = this.config.scene.horizonRatio;
    const parallax = -this.camera.origin * 0.08 * this.dpr + this.camera.wind * 4;
    const scale = Math.max(w / sky.width, (h / sky.height) * 1.08);
    const iw = sky.width * scale;
    const ih = sky.height * scale;
    const ox = (w - iw) / 2 + parallax;
    const oy = targetHorizon * h - imgHorizon * ih;
    ctx.drawImage(sky, ox, oy, iw, ih);

    if (oy > 0) {
      ctx.fillStyle = '#102033';
      ctx.fillRect(0, 0, w, oy + 2);
    }
    if (oy + ih < h) {
      ctx.fillStyle = '#071018';
      ctx.fillRect(0, oy + ih - 2, w, h - oy - ih + 2);
    }
  }

  _drawClouds(w, h) {
    const ctx = this.ctx;
    const horizon = this._horizonY(h);
    for (const cloud of this.clouds) {
      const scroll = (this.camera.origin / 1400) * (0.18 + cloud.layer * 0.1);
      const x = ((((cloud.x - scroll) % 1) + 1) % 1) * w;
      const y = cloud.y * horizon;
      ctx.save();
      ctx.globalAlpha = cloud.alpha;
      ctx.fillStyle = '#f4e4c8';
      ctx.beginPath();
      ctx.ellipse(x, y, cloud.w * w, cloud.h * h, 0, 0, Math.PI * 2);
      ctx.ellipse(x + cloud.w * w * 0.35, y + 4, cloud.w * w * 0.55, cloud.h * h * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  _drawHorizon(w, h) {
    const y = this._horizonY(h);
    const ctx = this.ctx;
    const glow = ctx.createLinearGradient(0, y - 18 * this.dpr, 0, y + 18 * this.dpr);
    glow.addColorStop(0, 'rgba(255, 176, 96, 0)');
    glow.addColorStop(0.5, 'rgba(255, 196, 120, 0.55)');
    glow.addColorStop(1, 'rgba(255, 176, 96, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, y - 18 * this.dpr, w, 36 * this.dpr);
    ctx.strokeStyle = 'rgba(255, 220, 170, 0.55)';
    ctx.lineWidth = Math.max(1, 1.2 * this.dpr);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  _drawWater(w, h) {
    const ctx = this.ctx;
    const y = this._horizonY(h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, w, h - y);
    ctx.clip();
    ctx.strokeStyle = 'rgba(210, 236, 255, 0.16)';
    ctx.lineWidth = this.dpr;
    const wind = this.camera.wind;
    for (let i = 0; i < 9; i += 1) {
      const gy = y + (h - y) * (0.08 + i * 0.1);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const wave =
          Math.sin(x * 0.007 + this.time * 0.0016 + i + wind) * (3 + i) * this.dpr +
          Math.sin(x * 0.02 + this.time * 0.0022 + i * 0.4) * 1.6 * this.dpr;
        ctx.lineTo(x, gy + wave);
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(180, 230, 255, 0.09)';
    for (const glint of this.glints) {
      const pulse = 0.35 + 0.65 * Math.abs(Math.sin(this.time * 0.002 + glint.phase));
      const gx = ((glint.x + this.time * 0.00003 * (1 + wind)) % 1) * w;
      const gy = y + glint.y * (h - y) * 0.85;
      ctx.globalAlpha = 0.12 * pulse;
      ctx.beginPath();
      ctx.ellipse(gx, gy, glint.size * 3 * this.dpr, glint.size * this.dpr, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawFleet(w, h) {
    this._shipRects = {};
    this._homeRect = null;
    const frame = this.camera.framing(w, h);
    const intro = this.camera.intro ?? 0;
    const origin = this.camera.origin;
    const distance = this.sample?.distance ?? 0;
    const nearHome = distance < 160;
    const nearTarget = distance > (this.config.flight.world.shipDistance ?? 1280) - 220;
    const near = origin - 24;
    const far = origin + frame.viewRange + 36;
    const forceIds = [];
    if (intro > 0.35 && nearHome) forceIds.push('home');
    if ((this.sample?.deckBlend ?? 0) > 0.01 || nearTarget) forceIds.push('target');
    this.scene.syncVisible(origin, frame.viewRange, {
      near,
      far,
      forceIds,
      maxVisible: this.config.scene.track?.maxVisible ?? 5,
    });
    for (const ship of this.scene.shipsBackToFront()) {
      this._drawShip(ship, w, h);
    }
  }

  _drawNumbers(w, h) {
    const field = this.numberField;
    if (!field) return;
    if ((this.camera.intro ?? 0) > 0.52) return;
    const frame = this.camera.framing(w, h);
    const visible = field
      .visible(this.camera.origin, frame.viewRange)
      .sort((a, b) => b.distance - a.distance);
    for (const item of visible) this._drawNumber(item, w, h);
  }

  _updateCoefPops(sec) {
    this._coefPops = (this._coefPops ?? []).filter((pop) => {
      pop.ttl -= sec;
      pop.altitude += 26 * sec;
      return pop.ttl > 0;
    });
  }

  _drawCoefPops(w, h) {
    const pops = this._coefPops;
    if (!pops?.length) return;
    const ctx = this.ctx;
    for (const pop of pops) {
      const proj = this.camera.project(pop.distance, pop.altitude, w, h);
      const fade = clamp(pop.ttl / (pop.life || 0.85), 0, 1);
      const size = 13 * this.dpr * (0.85 + (1 - fade) * 0.35);
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.max(10, size)}px Sora, Arial, sans-serif`;
      ctx.shadowColor = 'rgba(255, 210, 96, 0.9)';
      ctx.shadowBlur = size * 0.45;
      ctx.strokeStyle = 'rgba(28, 16, 6, 0.82)';
      ctx.lineWidth = Math.max(2, size * 0.12);
      ctx.strokeText(pop.text, proj.x, proj.y);
      ctx.fillStyle = '#ffe27a';
      ctx.fillText(pop.text, proj.x, proj.y);
      ctx.restore();
    }
  }

  _drawNumber(item, w, h) {
    const proj = this.camera.project(item.distance, item.altitude, w, h, item.lateral ?? 0);
    const pop = item.pop ?? 0;
    const hitting = item.hit || item.collected;
    const fade = hitting ? clamp(1 - pop, 0, 1) : 1;
    if (fade <= 0.02) return;
    const scaleCfg = this._objectScale();
    const sprite = this.assets?.plane;
    const planeLen = scaleCfg.planeWorldLength ?? 48;
    const aspect = sprite ? sprite.height / sprite.width : 0.42;
    const planeHeight = planeLen * aspect;
    const frac = clamp(item.scale ?? 0.6, 0.5, 0.7);
    const swell = hitting ? 1 + Math.min(0.12, pop * 0.2) : 1;
    const size = this._worldPx(planeHeight * frac, w, h) * swell;
    const ctx = this.ctx;
    const n = item.number;
    const hot = n >= 8;
    const mid = n >= 4;
    const fill = hot ? '#ffe27a' : mid ? '#f3c56a' : '#fff4d6';
    const glow = hot ? 'rgba(255, 210, 96, 0.95)' : 'rgba(232, 196, 120, 0.8)';
    ctx.save();
    ctx.globalAlpha = (0.88 + 0.12 * (1 - Math.min(1, Math.max(0, proj.t)))) * fade;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.max(8, size)}px Sora, Arial, sans-serif`;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.shadowColor = glow;
    ctx.shadowBlur = size * 0.55;
    ctx.strokeStyle = 'rgba(28, 16, 6, 0.82)';
    ctx.lineWidth = Math.max(2.4, size * 0.12);
    ctx.strokeText(String(n), proj.x, proj.y);
    ctx.shadowBlur = size * 0.28;
    ctx.fillStyle = fill;
    ctx.fillText(String(n), proj.x, proj.y);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillText(String(n), proj.x, proj.y - size * 0.06);
    ctx.restore();
  }

  _drawRockets(w, h) {
    const field = this.rocketField;
    if (!field) return;
    if ((this.camera.intro ?? 0) > 0.52) return;
    const frame = this.camera.framing(w, h);
    const visible = field
      .visible(this.camera.origin, frame.viewRange)
      .sort((a, b) => b.distance - a.distance);
    for (const rocket of visible) this._drawRocket(rocket, w, h);
  }

  _drawRocket(rocket, w, h) {
    const proj = this.camera.project(rocket.distance, rocket.altitude, w, h);
    const pop = rocket.pop ?? 0;
    const fade = rocket.hit ? clamp(1 - pop, 0, 1) : 1;
    if (fade <= 0.02) return;
    const swell = rocket.hit ? 1 + Math.min(0.18, pop * 0.35) : 1;
    const planeLen = this._objectScale().planeWorldLength ?? 48;
    const rocketLen = Math.min(this._objectScale().rocketWorldLength ?? 26, planeLen * 0.58);
    const len = this._worldPx(rocketLen * clamp(rocket.scale ?? 0.9, 0.72, 0.96), w, h) * swell;
    const ctx = this.ctx;
    const flicker = 0.55 + 0.45 * Math.abs(Math.sin((this.time * 0.014 + rocket.phase) * 0.1));
    ctx.save();
    ctx.translate(proj.x, proj.y);
    ctx.rotate(((rocket.angle ?? 0) * Math.PI) / 180);
    ctx.globalAlpha = (0.88 + 0.12 * (1 - Math.min(1, Math.max(0, proj.t)))) * fade;

    if (!rocket.hit) {
      ctx.save();
      ctx.globalAlpha *= 0.55 + 0.45 * flicker;
      const exhaust = ctx.createLinearGradient(-len * 1.15, 0, -len * 0.42, 0);
      exhaust.addColorStop(0, 'rgba(80, 170, 255, 0)');
      exhaust.addColorStop(0.35, 'rgba(80, 190, 255, 0.28)');
      exhaust.addColorStop(0.7, 'rgba(255, 210, 120, 0.7)');
      exhaust.addColorStop(1, 'rgba(255, 255, 240, 0.95)');
      ctx.fillStyle = exhaust;
      ctx.beginPath();
      ctx.moveTo(-len * 0.42, 0);
      ctx.quadraticCurveTo(-len * 0.78, len * 0.1 * flicker, -len * 1.18, 0);
      ctx.quadraticCurveTo(-len * 0.78, -len * 0.1 * flicker, -len * 0.42, 0);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = '#1b2734';
    ctx.beginPath();
    ctx.moveTo(-len * 0.42, len * 0.16);
    ctx.lineTo(-len * 0.58, len * 0.3);
    ctx.lineTo(-len * 0.28, len * 0.08);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-len * 0.42, -len * 0.16);
    ctx.lineTo(-len * 0.58, -len * 0.3);
    ctx.lineTo(-len * 0.28, -len * 0.08);
    ctx.closePath();
    ctx.fill();

    const hull = ctx.createLinearGradient(0, -len * 0.14, 0, len * 0.14);
    hull.addColorStop(0, '#d7e4f2');
    hull.addColorStop(0.35, '#8ea4bb');
    hull.addColorStop(0.7, '#3d4d5f');
    hull.addColorStop(1, '#1a242f');
    ctx.fillStyle = rocket.hit ? `rgba(255, 176, 96, ${fade})` : hull;
    ctx.beginPath();
    ctx.moveTo(len * 0.58, 0);
    ctx.quadraticCurveTo(len * 0.22, -len * 0.13, -len * 0.38, -len * 0.11);
    ctx.lineTo(-len * 0.46, 0);
    ctx.lineTo(-len * 0.38, len * 0.11);
    ctx.quadraticCurveTo(len * 0.22, len * 0.13, len * 0.58, 0);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.beginPath();
    ctx.ellipse(len * 0.08, -len * 0.035, len * 0.22, len * 0.028, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#67e0ff';
    ctx.shadowColor = 'rgba(80, 210, 255, 0.9)';
    ctx.shadowBlur = len * 0.18;
    ctx.beginPath();
    ctx.ellipse(len * 0.18, 0, len * 0.07, len * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#0f1720';
    ctx.fillRect(-len * 0.5, -len * 0.045, len * 0.08, len * 0.09);

    if (rocket.hit && pop < 0.5) {
      ctx.globalAlpha = (1 - pop / 0.5) * 0.75;
      ctx.strokeStyle = 'rgba(180, 230, 255, 0.95)';
      ctx.lineWidth = Math.max(2, len * 0.08);
      ctx.beginPath();
      ctx.arc(0, 0, len * (0.7 + pop * 1.6), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _shipSize(proj, ship, w, h) {
    const introCfg = this.camera.introSettings(w, h);
    const introBoost = ship.id === 'home' ? lerp(1, introCfg.homeScale ?? 1.12, this.camera.intro ?? 0) : 1;
    const shipLen = this._objectScale().shipWorldLength ?? this.config.flight.world.deckLength ?? 176;
    const width = this._worldPx(shipLen * (ship.scale ?? 1), w, h) * introBoost;
    const sprite = this.assets?.carrier;
    const height = sprite ? width * (sprite.height / sprite.width) : width * 0.28;
    return { width, height };
  }

  _drawShip(ship, w, h) {
    const proj = this.camera.project(
      ship.distance,
      this.config.flight.world.deckAltitude + (ship.drift ?? 0),
      w,
      h,
      ship.lateral ?? 0,
    );
    const { width, height } = this._shipSize(proj, ship, w, h);
    const sprite = this.assets?.carrier;
    const yaw = 0;
    const ox = -width * 0.48;
    const oy = -height * 0.36;
    const x = proj.x + ox;
    const y = proj.y + oy;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = '#02080e';
    ctx.beginPath();
    ctx.ellipse(proj.x, proj.yWater + 12 * this.dpr, width * 0.48, height * 0.1, yaw, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.88 + 0.12 * (1 - Math.min(1, proj.t));
    ctx.translate(proj.x, proj.y);
    ctx.rotate(yaw);
    if (sprite) {
      ctx.drawImage(sprite, ox, oy, width, height);
    } else {
      this._drawFallbackShip({ x: 0, y: 0 }, width);
    }
    ctx.restore();
    const rect = { x, y, width, height, proj };
    this._shipRects[ship.id] = rect;
    if (ship.id === 'home') this._homeRect = rect;
  }

  _drawShipAccent(width, height, ox, oy) {
    const ctx = this.ctx;
    const deckY = oy + height * 0.3;
    const deckX0 = ox + width * 0.16;
    const deckX1 = ox + width * 0.82;
    ctx.save();
    ctx.fillStyle = 'rgba(6, 10, 16, 0.28)';
    ctx.fillRect(ox + width * 0.08, oy + height * 0.58, width * 0.82, height * 0.28);
    ctx.strokeStyle = 'rgba(244, 222, 172, 0.78)';
    ctx.shadowColor = 'rgba(232, 196, 120, 0.45)';
    ctx.shadowBlur = 10 * this.dpr;
    ctx.lineWidth = Math.max(1.6, width * 0.012);
    ctx.beginPath();
    ctx.moveTo(deckX0, deckY);
    ctx.lineTo(deckX1, deckY);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = Math.max(1, width * 0.006);
    ctx.strokeRect(deckX0, deckY - height * 0.045, deckX1 - deckX0, height * 0.09);
    ctx.restore();
  }

  _drawLandingLights(width, height, ox, oy) {
    const ctx = this.ctx;
    const deckY = oy + height * 0.3;
    const left = ox + width * 0.18;
    const right = ox + width * 0.8;
    const top = deckY - height * 0.05;
    const bot = deckY + height * 0.05;
    const r = Math.max(1.6, width * 0.012);
    const spots = [
      [left, top],
      [right, top],
      [left, bot],
      [right, bot],
      [(left + right) / 2, top],
      [(left + right) / 2, bot],
    ];
    ctx.save();
    for (const [x, y] of spots) {
      ctx.fillStyle = 'rgba(255, 236, 196, 0.55)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawFallbackShip(proj, width) {
    const ctx = this.ctx;
    const height = width * 0.28;
    const px = proj.x ?? 0;
    const py = proj.y ?? 0;
    ctx.fillStyle = '#2b3942';
    ctx.beginPath();
    ctx.moveTo(px - width * 0.5, py);
    ctx.lineTo(px + width * 0.48, py);
    ctx.lineTo(px + width * 0.4, py + height);
    ctx.lineTo(px - width * 0.35, py + height);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d9c39a';
    ctx.fillRect(px + width * 0.18, py - height * 0.7, width * 0.12, height * 0.7);
  }

  _planeLayout(w, h) {
    if (!this.sample) return null;
    const idle = this.sample.phase === 'idle';
    const home = this._homeRect;
    const target = this._shipRects.target;
    const hold = this.camera.poseHold ?? 0;
    const intro = this.camera.intro ?? 0;
    let pitch = idle ? 0 : (this.sample.pitch ?? 0);

    const proj = this.camera.project(this.sample.distance, this.sample.altitude, w, h);
    let x = proj.x;
    let y = proj.y;
    let yWater = proj.yWater;
    const planeLen = this._objectScale().planeWorldLength ?? 48;
    let width = this._worldPx(planeLen, w, h);

    if (home && hold > 0.001 && (idle || (this.sample?.speed ?? 0) < 16)) {
      const introCfg = this.camera.introSettings(w, h);
      const deckX = home.x + home.width * (introCfg.deckX ?? 0.38);
      const deckY = home.y + home.height * (introCfg.deckY ?? 0.5);
      const deckW = home.width * (introCfg.planeOnDeck ?? 0.28);
      x = lerp(x, deckX, hold);
      y = lerp(y, deckY, hold);
      width = lerp(width, deckW, hold);
      yWater = lerp(yWater, home.proj.yWater, hold);
    }

    const blend = this.sample.deckBlend ?? 0;
    if (target && blend > 0) {
      const deck = this.config.flight.world;
      const along = inverseLerp(deck.shipDistance, deck.shipDistance + deck.deckLength, this.sample.distance);
      const land = blend * (1 - intro);
      const deckX = target.x + target.width * lerp(0.28, 0.7, clamp(along, 0, 1));
      const deckY = target.y + target.height * 0.32;
      x = lerp(x, deckX, land);
      y = lerp(y, deckY, land);
      yWater = lerp(yWater, target.proj.yWater, land);
    }

    const sprite = this.assets?.plane;
    const height = sprite ? width * (sprite.height / sprite.width) : width * 0.28;
    return { x, y, width, height, pitch, yWater, idle };
  }

  _drawShadows(w, h) {
    const plane = this._plane;
    if (!plane || this._wrecked) return;
    const ctx = this.ctx;
    const alt = this.sample?.altitude ?? 0;
    const spread = 1 + Math.min(2.2, alt / 90);
    ctx.save();
    ctx.globalAlpha = clamp(0.28 - alt * 0.0012, 0.08, 0.28);
    ctx.fillStyle = '#031018';
    ctx.beginPath();
    ctx.ellipse(plane.x + 6, plane.yWater + 8 * this.dpr, plane.width * 0.34 * spread, 7 * this.dpr * spread, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawReflection(w, h) {
    const plane = this._plane;
    if (!plane || plane.idle || this._wrecked) return;
    const alt = this.sample?.altitude ?? 0;
    if (alt > 120) return;
    const ctx = this.ctx;
    const horizon = this._horizonY(h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, horizon, w, h - horizon);
    ctx.clip();
    ctx.globalAlpha = clamp(0.22 - alt * 0.0014, 0.05, 0.22);
    ctx.translate(plane.x, plane.yWater + (plane.yWater - plane.y) * 0.35);
    ctx.scale(1, -0.42);
    ctx.rotate((-plane.pitch * Math.PI) / 180);
    this._paintPlane(plane.width, plane.height);
    ctx.restore();
  }

  _drawAircraft() {
    const plane = this._plane;
    if (!plane || this._wrecked) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(plane.x, plane.y);
    ctx.rotate((-plane.pitch * Math.PI) / 180);
    this._paintPlane(plane.width, plane.height);
    ctx.restore();
  }

  _paintPlane(width, height) {
    const ctx = this.ctx;
    const sprite = this.assets?.plane;
    if (sprite) {
      ctx.drawImage(sprite, -width * 0.5, -height * 0.78, width, height);
      return;
    }
    ctx.fillStyle = '#e31b1b';
    ctx.beginPath();
    ctx.moveTo(-width * 0.4, 0);
    ctx.lineTo(width * 0.45, -width * 0.05);
    ctx.lineTo(width * 0.4, width * 0.08);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e8c37a';
    ctx.fillRect(-width * 0.28, -width * 0.02, width * 0.58, width * 0.035);
  }

  _drawLandingZone() {
    const glow = this.sample?.effects?.zone ?? 0;
    const success = this.sample?.effects?.successGlow ?? 0;
    const target = this._shipRects.target;
    if (!target || glow + success <= 0.02) return;
    const ctx = this.ctx;
    const cx = target.x + target.width * 0.52;
    const cy = target.y + target.height * 0.4;
    ctx.save();
    ctx.globalAlpha = 0.22 * glow + 0.35 * success;
    ctx.fillStyle = success > 0.1 ? 'rgba(93, 255, 177, 0.9)' : 'rgba(215, 181, 106, 0.9)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, target.width * 0.22, target.height * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _spawnLandingBurst(sample) {
    for (let i = 0; i < 10; i += 1) {
      this.particles.spawn({
        kind: 'dust',
        distance: sample.distance + (Math.random() - 0.35) * 18,
        altitude: Math.max(0, sample.altitude - 2),
        vx: 10 + Math.random() * 30,
        vy: 4 + Math.random() * 10,
        ttl: 0.7,
        size: 4 + Math.random() * 6,
      });
    }
    for (let i = 0; i < 12; i += 1) {
      this.particles.spawn({
        kind: 'spark',
        distance: sample.distance + (Math.random() - 0.5) * 14,
        altitude: sample.altitude + Math.random() * 6,
        vx: (Math.random() - 0.2) * 40,
        vy: 8 + Math.random() * 22,
        ay: -28,
        ttl: 0.55,
        size: 2 + Math.random() * 2,
        wind: 0.1,
      });
    }
  }

  _spawnSplash(sample) {
    const d = sample.distance;
    const a = Math.max(1, sample.altitude);
    for (let i = 0; i < 22; i += 1) {
      this.particles.spawn({
        kind: 'splash',
        distance: d + (Math.random() - 0.5) * 28,
        altitude: a + Math.random() * 8,
        vx: (Math.random() - 0.5) * 90,
        vy: 36 + Math.random() * 70,
        ay: -96,
        ttl: 0.85 + Math.random() * 0.45,
        size: 6 + Math.random() * 11,
      });
    }
    for (let i = 0; i < 28; i += 1) {
      this.particles.spawn({
        kind: 'spray',
        distance: d + (Math.random() - 0.5) * 36,
        altitude: a + Math.random() * 5,
        vx: (Math.random() - 0.5) * 140,
        vy: 18 + Math.random() * 54,
        ay: -86,
        ttl: 0.55 + Math.random() * 0.4,
        size: 2 + Math.random() * 4,
      });
    }
    for (let i = 0; i < 14; i += 1) {
      const ang = (i / 14) * Math.PI * 2;
      this.particles.spawn({
        kind: 'foam',
        distance: d + Math.cos(ang) * 8,
        altitude: 1 + Math.random() * 3,
        vx: Math.cos(ang) * (22 + Math.random() * 28),
        vy: 5 + Math.random() * 10,
        ay: -16,
        ttl: 1.15 + Math.random() * 0.45,
        size: 9 + Math.random() * 8,
        drag: 0.93,
      });
    }
  }

  _spawnWaterBurst(sample) {
    const d = sample.distance;
    this.particles.spawn({
      kind: 'flash',
      distance: d,
      altitude: 6,
      vx: 0,
      vy: 10,
      ttl: 0.42,
      size: 34,
    });
    this.particles.spawn({
      kind: 'flash',
      distance: d,
      altitude: 10,
      vx: 0,
      vy: 4,
      ttl: 0.28,
      size: 22,
    });
    for (let i = 0; i < 16; i += 1) {
      this.particles.spawn({
        kind: 'fire',
        distance: d + (Math.random() - 0.5) * 16,
        altitude: 3 + Math.random() * 10,
        vx: (Math.random() - 0.5) * 50,
        vy: 18 + Math.random() * 36,
        ay: -24,
        ttl: 0.7 + Math.random() * 0.4,
        size: 6 + Math.random() * 9,
        wind: 0.2,
      });
    }
    for (let i = 0; i < 14; i += 1) {
      this.particles.spawn({
        kind: 'wreck',
        distance: d + (Math.random() - 0.5) * 10,
        altitude: 4 + Math.random() * 8,
        vx: (Math.random() - 0.5) * 70,
        vy: 16 + Math.random() * 42,
        ay: -70,
        ttl: 1.4 + Math.random() * 0.6,
        size: 4 + Math.random() * 7,
        spin: (Math.random() - 0.5) * 8,
        drag: 0.97,
      });
    }
    for (let i = 0; i < 10; i += 1) {
      this.particles.spawn({
        kind: 'spark',
        distance: d + (Math.random() - 0.5) * 12,
        altitude: 5 + Math.random() * 8,
        vx: (Math.random() - 0.5) * 80,
        vy: 20 + Math.random() * 40,
        ay: -36,
        ttl: 0.55,
        size: 2 + Math.random() * 2.4,
        wind: 0.08,
      });
    }
  }

  _spawnSmoke(sample, count) {
    for (let i = 0; i < count; i += 1) {
      this.particles.spawn({
        kind: 'smoke',
        distance: sample.distance + (Math.random() - 0.5) * 10,
        altitude: Math.max(2, sample.altitude),
        vx: -6 + Math.random() * 14,
        vy: 10 + Math.random() * 16,
        ay: 8,
        ttl: 1.1,
        size: 7 + Math.random() * 10,
        wind: 0.8,
        drag: 0.96,
      });
    }
  }

  _drawParticles(w, h, kinds) {
    const ctx = this.ctx;
    const allow = new Set(kinds);
    for (const p of this.particles.items) {
      if (!allow.has(p.kind)) continue;
      const proj = this.camera.project(p.distance, Math.max(0, p.altitude), w, h);
      const alpha = Math.max(0, p.life);
      if (p.kind === 'trail') {
        ctx.fillStyle = `rgba(230, 244, 255, ${0.18 * alpha})`;
        ctx.beginPath();
        ctx.ellipse(proj.x, proj.y, p.size * proj.scale * this.dpr, p.size * 0.35 * this.dpr, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'smoke') {
        ctx.fillStyle = `rgba(70, 78, 86, ${0.28 * alpha})`;
        ctx.beginPath();
        ctx.ellipse(proj.x, proj.y, p.size * this.dpr, p.size * 0.7 * this.dpr, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'spark') {
        ctx.fillStyle = `rgba(255, 214, 140, ${0.7 * alpha})`;
        ctx.beginPath();
        ctx.arc(proj.x, proj.y, p.size * this.dpr, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'flash') {
        ctx.fillStyle = `rgba(255, 210, 120, ${0.55 * alpha})`;
        ctx.beginPath();
        ctx.arc(proj.x, proj.y, p.size * proj.scale * this.dpr * (1.35 - alpha * 0.35), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255, 250, 230, ${0.35 * alpha})`;
        ctx.beginPath();
        ctx.arc(proj.x, proj.y, p.size * proj.scale * this.dpr * 0.45, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'fire') {
        ctx.fillStyle = `rgba(255, ${90 + Math.round(90 * alpha)}, 32, ${0.62 * alpha})`;
        ctx.beginPath();
        ctx.ellipse(proj.x, proj.y, p.size * 0.7 * this.dpr, p.size * this.dpr, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'wreck') {
        ctx.save();
        ctx.translate(proj.x, proj.y);
        ctx.rotate((p.spin ?? 2) * (1 - alpha));
        ctx.fillStyle = `rgba(210, 28, 24, ${0.88 * alpha})`;
        ctx.fillRect(-p.size * this.dpr, -p.size * 0.32 * this.dpr, p.size * 2.1 * this.dpr, p.size * 0.64 * this.dpr);
        ctx.fillStyle = `rgba(80, 16, 14, ${0.45 * alpha})`;
        ctx.fillRect(-p.size * 0.4 * this.dpr, -p.size * 0.18 * this.dpr, p.size * this.dpr, p.size * 0.22 * this.dpr);
        ctx.restore();
      } else if (p.kind === 'splash' || p.kind === 'spray') {
        ctx.fillStyle = `rgba(198, 236, 255, ${0.58 * alpha})`;
        ctx.beginPath();
        ctx.ellipse(proj.x, proj.y, p.size * this.dpr, p.size * (p.kind === 'spray' ? 1.15 : 0.7) * this.dpr, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'foam') {
        ctx.fillStyle = `rgba(230, 246, 255, ${0.35 * alpha})`;
        ctx.beginPath();
        ctx.ellipse(proj.x, proj.yWater ?? proj.y, p.size * this.dpr * 1.4, p.size * 0.35 * this.dpr, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(214, 196, 160, ${0.28 * alpha})`;
        ctx.beginPath();
        ctx.ellipse(proj.x, proj.y, p.size * proj.scale * this.dpr, p.size * 0.45 * this.dpr, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
