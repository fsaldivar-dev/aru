// Stage 1: load + normalize. An image is { width, height, data: Uint8ClampedArray RGBA }.
// Normalization: composite alpha over a background color and downscale (area average) to maxSide.

export function normalizeImage(img, { maxSide = 600, background = [255, 255, 255] } = {}) {
  const { width: w, height: h, data: src } = img;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy0 = Math.floor(y * h / H), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / H));
    for (let x = 0; x < W; x++) {
      const sx0 = Math.floor(x * w / W), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const i = (sy * w + sx) * 4, a = src[i + 3] / 255;
        r += src[i] * a + background[0] * (1 - a); g += src[i + 1] * a + background[1] * (1 - a); b += src[i + 2] * a + background[2] * (1 - a); n++;
      }
      const o = (y * W + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out, scale: k, sourceWidth: w, sourceHeight: h };
}

// Browser loader: any format the browser can decode (png, jpg, webp, svg)
export function loadImageBrowser(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.naturalWidth || im.width; c.height = im.naturalHeight || im.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(im, 0, 0, c.width, c.height);
      resolve({ width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data });
    };
    im.onerror = () => reject(new Error(`cannot load image ${src}`));
    im.src = src;
  });
}
