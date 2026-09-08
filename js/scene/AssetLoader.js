function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${src}`));
    image.src = src;
  });
}

function chromaKeyAndTrim(image) {
  const source = document.createElement('canvas');
  source.width = image.width;
  source.height = image.height;
  const ctx = source.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const frame = ctx.getImageData(0, 0, source.width, source.height);
  const px = frame.data;

  let minX = source.width;
  let minY = source.height;
  let maxX = 0;
  let maxY = 0;

  for (let i = 0, p = 0; i < px.length; i += 4, p += 1) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const magenta = (r + b) / 2 - g;
    if (r > 120 && b > 120 && g < 140 && magenta > 40) {
      px[i + 3] = magenta > 90 ? 0 : Math.max(0, 255 - magenta * 2.4);
    }
    if (px[i + 3] > 12) {
      const x = p % source.width;
      const y = (p / source.width) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  ctx.putImageData(frame, 0, 0);

  if (maxX <= minX || maxY <= minY) return source;

  const pad = 2;
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.min(source.width - sx, maxX - minX + 1 + pad * 2);
  const sh = Math.min(source.height - sy, maxY - minY + 1 + pad * 2);
  const trimmed = document.createElement('canvas');
  trimmed.width = sw;
  trimmed.height = sh;
  trimmed.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return trimmed;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function recolorPlane(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = frame.data;

  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 12) continue;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const max = Math.max(r, g, b);
    if (max < 42) continue;

    const lum = (0.22 * r + 0.7 * g + 0.08 * b) / 255;
    const teal = g - r > 16 && b - r > 4 && g > 78;
    const greenLight = g - r > 32 && g - b > 18 && g > 78;

    let nr;
    let ng;
    let nb;
    const t = lum ** 0.88;
    if (teal || greenLight) {
      nr = lerp(148, 244, t);
      ng = lerp(92, 196, t);
      nb = lerp(22, 88, t);
      if (lum > 0.62) {
        nr = Math.min(255, nr + 8);
        ng = Math.min(210, ng + 4);
      }
    } else {
      nr = lerp(132, 255, t);
      ng = lerp(0, 22, t * t);
      nb = lerp(6, 28, t * 0.75);
      if (lum > 0.78) {
        const hi = (lum - 0.78) / 0.22;
        nr = 255;
        ng = lerp(18, 54, hi);
        nb = lerp(16, 42, hi);
      }
    }
    px[i] = nr;
    px[i + 1] = ng;
    px[i + 2] = nb;
  }

  ctx.putImageData(frame, 0, 0);
  return canvas;
}

export class AssetLoader {
  constructor(paths) {
    this.paths = paths;
    this.assets = null;
    this.error = null;
  }

  async load() {
    try {
      const [sky, carrier, plane] = await Promise.all([
        loadImage(this.paths.sky),
        loadImage(this.paths.carrier),
        loadImage(this.paths.plane),
      ]);
      this.assets = {
        sky,
        carrier: chromaKeyAndTrim(carrier),
        plane: recolorPlane(chromaKeyAndTrim(plane)),
      };
      return this.assets;
    } catch (error) {
      this.error = error;
      throw error;
    }
  }
}
