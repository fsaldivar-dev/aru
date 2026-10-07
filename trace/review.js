// Review crops for Section Polish: the reference and the current vector of one section, side by side.
// Pure JS (no canvas): the vector is scan-converted with supersampling, so curves look like the real render.
import { loopPolygon } from './raster.js';

export function renderCropRGB(T, [x0, y0, w, h], scale = 4, ss = 3) {
  const S = scale * ss, Wc = Math.round(w * S), Hc = Math.round(h * S);
  const ids = new Int32Array(Wc * Hc).fill(-1);
  const order = [...T.regions].sort((a, b) => a.depth - b.depth || b.area - a.area);
  for (const r of order) {
    const poly = loopPolygon(r.outer, T.fits).map((p) => [(p[0] - x0) * S, (p[1] - y0) * S]);
    let ya = Infinity, yb = -Infinity; for (const p of poly) { ya = Math.min(ya, p[1]); yb = Math.max(yb, p[1]); }
    if (yb < 0 || ya > Hc) continue;
    for (let y = Math.max(0, Math.floor(ya)); y < Math.min(Hc, Math.ceil(yb)); y++) {
      const cy = y + 0.5, xs = [];
      for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; if ((a[1] > cy) !== (b[1] > cy)) xs.push(a[0] + ((cy - a[1]) / (b[1] - a[1])) * (b[0] - a[0])); }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x < Math.min(Wc, Math.ceil(xs[i + 1] - 0.5)); x++) ids[y * Wc + x] = r.id;
    }
  }
  const byId = new Map(T.regions.map((r) => [r.id, r]));
  const colorOf = (id, sx, sy) => {
    const r = byId.get(id); if (!r) return [255, 255, 255];
    const g = r.gradient; if (!g) return r.color;
    const x = x0 + sx / S, y = y0 + sy / S, dx = g.x2 - g.x1, dy = g.y2 - g.y1, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - g.x1) * dx + (y - g.y1) * dy) / L2));
    return g.c0.map((v, k) => v + (g.c1[k] - v) * t);
  };
  const ow = Math.round(w * scale), oh = Math.round(h * scale), out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    let R = 0, G = 0, B = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) { const sx = x * ss + i, sy = y * ss + j; const c = colorOf(ids[sy * Wc + sx], sx + 0.5, sy + 0.5); R += c[0]; G += c[1]; B += c[2]; }
    const o = (y * ow + x) * 4, k = ss * ss; out[o] = R / k; out[o + 1] = G / k; out[o + 2] = B / k; out[o + 3] = 255;
  }
  return { width: ow, height: oh, data: out };
}

export function referenceCropRGB(img, [x0, y0, w, h], scale = 4) {
  const ow = Math.round(w * scale), oh = Math.round(h * scale), out = new Uint8ClampedArray(ow * oh * 4), W = img.width, H = img.height;
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const fx = Math.min(W - 1, Math.max(0, x0 + (x + 0.5) / scale - 0.5)), fy = Math.min(H - 1, Math.max(0, y0 + (y + 0.5) / scale - 0.5));
    const xa = Math.floor(fx), ya = Math.floor(fy), xb = Math.min(W - 1, xa + 1), yb = Math.min(H - 1, ya + 1), tx = fx - xa, ty = fy - ya;
    for (let c = 0; c < 3; c++) {
      const v = (1 - ty) * ((1 - tx) * img.data[(ya * W + xa) * 4 + c] + tx * img.data[(ya * W + xb) * 4 + c]) + ty * ((1 - tx) * img.data[(yb * W + xa) * 4 + c] + tx * img.data[(yb * W + xb) * 4 + c]);
      out[(y * ow + x) * 4 + c] = v;
    }
    out[(y * ow + x) * 4 + 3] = 255;
  }
  return { width: ow, height: oh, data: out };
}

export function sideBySide(a, b, gap = 8) {
  const w = a.width + gap + b.width, h = Math.max(a.height, b.height), out = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [im, ox] of [[a, 0], [b, a.width + gap]]) for (let y = 0; y < im.height; y++) out.set(im.data.subarray(y * im.width * 4, (y + 1) * im.width * 4), (y * w + ox) * 4);
  return { width: w, height: h, data: out };
}

// crop box around a section: its bounds + margin, at least `minSide` px, inside the image
export function sectionBox(sec, W, H, { margin = 0.15, minSide = 48 } = {}) {
  const [a, b, c, d] = sec.bounds;
  let w = c - a + 1, h = d - b + 1;
  const m = Math.max(4, Math.round(margin * Math.max(w, h)));
  let x0 = a - m, y0 = b - m; w += 2 * m; h += 2 * m;
  if (w < minSide) { x0 -= (minSide - w) / 2; w = minSide; }
  if (h < minSide) { y0 -= (minSide - h) / 2; h = minSide; }
  x0 = Math.max(0, Math.min(W - w, x0)); y0 = Math.max(0, Math.min(H - h, y0));
  return [Math.round(x0), Math.round(y0), Math.round(Math.min(w, W)), Math.round(Math.min(h, H))];
}

// ---- reviewer views (presentation only; the tracer's pixels are never touched) ----
// DETAIL box: section bounds + 15–30 % margin (more for small sections), square-ish, inside the image
export function detailBox(bounds, W, H) {
  const [a, b, c, d] = bounds, w = c - a, h = d - b, side = Math.max(w, h, 1);
  const margin = side < 40 ? 0.3 : side > 200 ? 0.15 : 0.3 - 0.15 * (side - 40) / 160;
  const s = Math.min(Math.max(W, H), Math.max(24, Math.round(side * (1 + 2 * margin))));
  const x0 = Math.max(0, Math.min(W - Math.min(W, s), Math.round((a + c) / 2 - s / 2))), y0 = Math.max(0, Math.min(H - Math.min(H, s), Math.round((b + d) / 2 - s / 2)));
  return [x0, y0, Math.min(W, s), Math.min(H, s)];
}
// detail scale: tiny parts (iris, pupil, highlight) are enlarged so their edges can be judged; capped for cost
export const detailScale = (box, { minSide = 320, maxSide = 448 } = {}) => Math.max(1, Math.min(maxSide / Math.max(box[2], box[3]), Math.max(1, minSide / Math.max(box[2], box[3]))));

// CONTEXT: the whole reference, downscaled, with the section box drawn
export function contextView(img, box, maxSide = 192) {
  const k = maxSide / Math.max(img.width, img.height), view = referenceCropRGB(img, [0, 0, img.width, img.height], k);
  const x0 = Math.floor(box[0] * k), y0 = Math.floor(box[1] * k), x1 = Math.min(view.width - 1, Math.ceil((box[0] + box[2]) * k)), y1 = Math.min(view.height - 1, Math.ceil((box[1] + box[3]) * k));
  const put = (x, y) => { if (x < 0 || y < 0 || x >= view.width || y >= view.height) return; const o = (y * view.width + x) * 4; view.data[o] = 255; view.data[o + 1] = 40; view.data[o + 2] = 40; };
  for (let t = 0; t < 2; t++) { for (let x = x0 - t; x <= x1 + t; x++) { put(x, y0 - t); put(x, y1 + t); } for (let y = y0 - t; y <= y1 + t; y++) { put(x0 - t, y); put(x1 + t, y); } }
  return view;
}
