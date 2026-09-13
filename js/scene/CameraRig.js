import { clamp, damp, easeInOutCubic, lerp } from '../utils/easing.js';

/**
 * Side-scrolling camera. World X is distance (left → right), Y is altitude (up).
 * Idle uses a zoomed establishing shot; after START this rig blends into follow.
 */
export class CameraRig {
  constructor(config) {
    this.config = config.scene;
    this.origin = 0;
    this.lift = 0;
    this.sway = 0;
    this.bob = 0;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.time = 0;
    this.wind = 0;
    this.intro = 1;
    this.poseHold = 1;
    this._playBlend = 0;
    this._playing = false;
    this._followOrigin = 0;
  }

  reset() {
    const introCfg = this.config.cameraIntro ?? {};
    this.origin = introCfg.origin ?? 0;
    this.lift = introCfg.lift ?? 0;
    this.sway = 0;
    this.bob = 0;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.time = 0;
    this.wind = 0;
    this.intro = 1;
    this.poseHold = 1;
    this._playBlend = 0;
    this._playing = false;
    this._followOrigin = introCfg.origin ?? 0;
  }

  introSettings(w, h) {
    const base = this.config.cameraIntro ?? {};
    const tall = h > w * 1.02;
    return tall ? { ...base, ...(base.tall ?? {}) } : { ...base };
  }

  impulse(amount) {
    this.shake = Math.max(this.shake, amount);
  }

  update(dt, sample, viewport = null) {
    const sec = dt > 2 ? dt / 1000 : dt;
    this.time += dt;
    const introCfg = this.config.cameraIntro ?? {};
    const idle = !sample || sample.phase === 'idle';

    if (idle) {
      this._playing = false;
      this._playBlend = 0;
      this.intro = damp(this.intro, 1, 1 / Math.max(0.25, introCfg.returnDuration ?? 0.85), sec);
      if (this.intro > 0.985) this.intro = 1;
      this.poseHold = damp(this.poseHold, 1, 4.4, sec);
      if (this.poseHold > 0.985) this.poseHold = 1;
    } else {
      if (!this._playing) {
        this._playing = true;
        this._playBlend = 0;
      }
      const duration = Math.max(0.18, introCfg.blendDuration ?? 0.35);
      this._playBlend = Math.min(1, this._playBlend + sec / duration);
      this.intro = 1 - easeInOutCubic(this._playBlend);
      const release = Math.max(0.06, introCfg.poseRelease ?? 0.12);
      this.poseHold = Math.max(0, this.poseHold - sec / release);
    }

    const speed = sample?.speed ?? 0;
    const distance = sample?.distance ?? 0;
    const playAnchor = this.config.planeX ?? this.config.followLookAhead ?? 0.28;
    const damping = this.config.followDamping ?? 5.4;
    const speedLead = this.config.followSpeedLead ?? 0.02;
    const playRange = this.config.viewRange;
    const introOrigin = introCfg.origin ?? 0;
    const playDesired = distance - playRange * playAnchor + speed * speedLead;

    if (idle) {
      this._followOrigin = damp(this._followOrigin, introOrigin, 3.2, sec);
      this.origin = lerp(this._followOrigin, introOrigin, this.intro);
    } else {
      this._followOrigin = damp(this._followOrigin, playDesired, damping, sec);
      const maxLag = playRange * (this.config.followMaxLag ?? 0.16);
      this._followOrigin = clamp(this._followOrigin, playDesired - maxLag, playDesired + maxLag);
      this.origin = this._followOrigin;
    }

    const altitude = sample?.altitude ?? 0;
    const keepAlt = this.config.followKeepAlt ?? 64;
    const playLift = Math.max(0, altitude - keepAlt);
    const introLift = introCfg.lift ?? 0;
    const liftTarget = idle ? lerp(playLift, introLift, this.intro) : playLift;
    this.lift = damp(this.lift, liftTarget, idle ? 1.7 : 12, sec);
    if (!idle) {
      const visLo = this.config.followMinVisAlt ?? 32;
      const visHi = this.config.followMaxVisAlt ?? 96;
      this.lift = clamp(this.lift, Math.max(0, altitude - visHi), Math.max(0, altitude - visLo));
    }

    this.wind = Math.sin(this.time * 0.00032) * 0.55 + Math.sin(this.time * 0.00011) * 0.35;
    const breeze = this.wind * (this.config.sway ?? 10) * 0.35 * lerp(1, introCfg.sway ?? 0.34, this.intro);
    this.shake *= Math.exp(-5.2 * sec);
    this.shakeX = Math.sin(this.time * 0.062) * this.shake * 8;
    this.shakeY = Math.cos(this.time * 0.08) * this.shake * 5;
    const rumble = sample?.phase && sample.phase !== 'idle' ? lerp(0.45, 0.18, this.intro) : 0.18;
    this.shakeX += Math.sin(this.time * 0.13) * rumble;
    this.shakeY += Math.cos(this.time * 0.11) * rumble * 0.6;
    this.sway =
      Math.sin(this.time * 0.00045) * this.config.sway * 0.35 * lerp(1, introCfg.sway ?? 0.34, this.intro) +
      breeze +
      this.shakeX;
    this.bob = Math.sin(this.time * 0.0007) * 2.2 * lerp(1, 0.4, this.intro) + this.shakeY;

    if (!idle && viewport?.w > 0 && viewport?.h > 0) {
      this._keepInView(sample, viewport.w, viewport.h);
    }
  }

  _keepInView(sample, w, h) {
    const distance = sample?.distance ?? 0;
    const altitude = sample?.altitude ?? 0;
    const p = this.project(distance, altitude, w, h);
    const range = Math.max(1, this.framing(w, h).viewRange);
    const xMin = w * (this.config.followXMin ?? 0.14);
    const xMax = w * (this.config.followXMax ?? 0.52);
    const yMin = h * (this.config.followYMin ?? 0.18);
    const yMax = h * (this.config.followYMax ?? 0.58);
    if (p.x < xMin) this.origin -= ((xMin - p.x) / w) * range;
    if (p.x > xMax) this.origin += ((p.x - xMax) / w) * range;
    const meters = (h / 560) * (this.framing(w, h).altScale ?? 1);
    if (meters > 0.01) {
      if (p.y < yMin) this.lift += (yMin - p.y) / meters;
      if (p.y > yMax) this.lift -= (p.y - yMax) / meters;
      this.lift = Math.max(0, this.lift);
    }
  }

  framing(w, h) {
    const introCfg = this.introSettings(w, h);
    const k = this.intro;
    const playScale = this.config.nearScale;
    const introScale = introCfg.nearScale ?? playScale;
    const planeX = lerp(this.config.planeX ?? 0.28, introCfg.planeX ?? introCfg.nearX ?? 0.4, k);
    return {
      viewRange: lerp(this.config.viewRange, introCfg.viewRange ?? this.config.viewRange, k),
      nearScale: lerp(playScale, introScale, k),
      farScale: lerp(playScale, introScale, k),
      nearX: planeX,
      farX: planeX,
      nearWater: lerp(this.config.waterY ?? 0.7, introCfg.nearWater ?? 0.72, k),
      perspective: 1,
      planeX,
      altScale: lerp(this.config.altScale ?? 1.2, introCfg.altScale ?? this.config.altScale ?? 1.2, k),
    };
  }

  project(distance, altitude, w, h) {
    const frame = this.framing(w, h);
    const horizonY = h * this.config.horizonRatio;
    const range = Math.max(1, frame.viewRange);
    const u = (distance - this.origin) / range;
    const x = u * w + this.sway;
    const yWater = lerp(horizonY + h * 0.08, h * frame.nearWater, 0.55) + this.bob * 0.2;
    const meters = (h / 560) * frame.altScale;
    const y = yWater - (altitude - this.lift) * meters;
    const scale = frame.nearScale;
    return { x, y, scale, t: u, horizonY, yWater };
  }
}
