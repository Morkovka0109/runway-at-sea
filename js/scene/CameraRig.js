import { clamp, damp, easeInOutCubic, lerp } from '../utils/easing.js';

/**
 * Camera controller. Follows the plane with damped look-ahead after takeoff.
 * Idle uses a cinematic establishing shot; after START this rig blends into follow.
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
    this._followOrigin = 0;
  }

  introSettings(w, h) {
    const base = this.config.cameraIntro ?? {};
    const tall = h > w * 1.02;
    return tall ? { ...base, ...(base.tall ?? {}) } : { ...base };
  }

  impulse(amount) {
    this.shake = Math.max(this.shake, amount);
  }

  update(dt, sample) {
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
      const duration = Math.max(0.35, introCfg.blendDuration ?? 1.55);
      this._playBlend = Math.min(1, this._playBlend + sec / duration);
      this.intro = 1 - easeInOutCubic(this._playBlend);
      this.poseHold = this.intro;
    }

    const speed = sample?.speed ?? 0;
    const distance = sample?.distance ?? 0;
    const lookAhead = this.config.followLookAhead ?? 0.25;
    const damping = this.config.followDamping ?? 3.4;
    const speedLead = this.config.followSpeedLead ?? 0.12;
    const maxOrigin = this.config.followMaxOrigin ?? this.config.maxCameraOrigin ?? 1850;
    const playRange = this.config.viewRange;
    const desired = idle
      ? 0
      : clamp(distance - playRange * lookAhead + speed * speedLead, 0, maxOrigin);
    this._followOrigin = damp(this._followOrigin, desired, damping, sec);
    const introOrigin = introCfg.origin ?? 0;
    this.origin = lerp(this._followOrigin, introOrigin, this.intro);
    const playLift = Math.min(36, (sample?.altitude ?? 0) * (this.config.followLift ?? 0.1));
    const introLift = introCfg.lift ?? 0;
    this.lift = damp(this.lift, lerp(playLift, introLift, this.intro), 1.7, sec);

    this.wind = Math.sin(this.time * 0.00032) * 0.55 + Math.sin(this.time * 0.00011) * 0.35;
    const breeze = this.wind * (this.config.sway ?? 10) * 0.35 * lerp(1, introCfg.sway ?? 0.34, this.intro);
    this.shake *= Math.exp(-5.2 * sec);
    this.shakeX = Math.sin(this.time * 0.062) * this.shake * 11;
    this.shakeY = Math.cos(this.time * 0.08) * this.shake * 7;
    const rumble = sample?.phase && sample.phase !== 'idle' ? lerp(0.7, 0.28, this.intro) : 0.28;
    this.shakeX += Math.sin(this.time * 0.13) * rumble;
    this.shakeY += Math.cos(this.time * 0.11) * rumble * 0.6;
    this.sway = Math.sin(this.time * 0.00045) * this.config.sway * 0.55 * lerp(1, introCfg.sway ?? 0.34, this.intro) + breeze + this.shakeX;
    this.bob = Math.sin(this.time * 0.0007) * 3.2 * lerp(1, 0.4, this.intro) + this.shakeY;
  }

  framing(w, h) {
    const introCfg = this.introSettings(w, h);
    const k = this.intro;
    return {
      viewRange: lerp(this.config.viewRange, introCfg.viewRange ?? this.config.viewRange, k),
      nearScale: lerp(this.config.nearScale, introCfg.nearScale ?? this.config.nearScale, k),
      farScale: lerp(this.config.farScale, introCfg.farScale ?? this.config.farScale, k),
      nearX: lerp(0.2, introCfg.nearX ?? 0.26, k),
      farX: lerp(0.84, introCfg.farX ?? 0.86, k),
      nearWater: lerp(0.84, introCfg.nearWater ?? 0.84, k),
      perspective: lerp(this.config.perspective, introCfg.perspective ?? this.config.perspective, k),
    };
  }

  project(distance, altitude, w, h, lateral = 0) {
    const frame = this.framing(w, h);
    const horizonY = h * this.config.horizonRatio;
    const u = clamp((distance - this.origin) / frame.viewRange, -0.08, 1.12);
    const p = 1 - (1 - clamp(u, 0, 1)) ** frame.perspective;
    const scale = lerp(frame.nearScale, frame.farScale, p);
    const spread = this.config.lateralFactor ?? 0.72;
    const x =
      lerp(w * frame.nearX, w * frame.farX, p) +
      this.sway +
      lateral * (w / Math.max(1, frame.viewRange)) * scale * spread;
    const yWater = lerp(h * frame.nearWater, horizonY + h * 0.018, p) + this.bob * 0.25;
    const y = yWater - (altitude + this.lift) * (h / 560) * (0.28 + scale * 0.7);
    return { x, y, scale, t: u, horizonY, yWater };
  }
}
