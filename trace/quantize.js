// Stage 2: color quantization to ~4-32 colors.
// k-means in CIE Lab (perceptual distances), initialized by median cut (deterministic: no random seeds),
// trained on a subsample, then every pixel is assigned. An optional 3x3 majority filter removes
// anti-aliasing slivers, which in flat illustrations otherwise become thousands of 1-px regions.

export function rgbToLab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

export function quantize(img, { colors = 12, iterations = 12, sampleStep = 3, smooth = 1 } = {}) {
  const { width: W, height: H, data } = img, N = W * H;
  const lab = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const [L, a, b] = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]); lab[i * 3] = L; lab[i * 3 + 1] = a; lab[i * 3 + 2] = b; }
  const samples = [];
  for (let i = 0; i < N; i += sampleStep) samples.push(i);
  let cent = clusterLab(lab, samples, colors, iterations);
  const nearest = (i) => nearestCentroid(lab, i, cent);

  // ---- assign every pixel ----
  let labels = new Uint16Array(N);
  for (let i = 0; i < N; i++) labels[i] = nearest(i);
  for (let p = 0; p < smooth; p++) labels = majority(labels, W, H);
  return finalizePalette(img, labels, cent.length, { lab });
}

// mean original RGB per label, drop empty labels and re-index
export function finalizePalette(img, labels, nLabels, extra = {}) {
  const { width: W, height: H, data } = img, N = W * H;

  // palette = mean original RGB of each cluster (after smoothing); drop empty clusters and re-index
  const acc = Array.from({ length: nLabels }, () => [0, 0, 0, 0]);
  for (let i = 0; i < N; i++) { const A = acc[labels[i]]; A[0] += data[i * 4]; A[1] += data[i * 4 + 1]; A[2] += data[i * 4 + 2]; A[3]++; }
  const remap = new Int32Array(acc.length).fill(-1), palette = [];
  acc.forEach((A, k) => { if (A[3]) { remap[k] = palette.length; palette.push([A[0] / A[3], A[1] / A[3], A[2] / A[3]].map(Math.round)); } });
  for (let i = 0; i < N; i++) labels[i] = remap[labels[i]];
  return { width: W, height: H, labels, palette, paletteHex: palette.map(hex), remap, ...extra };
}

// median-cut initialization + k-means, in Lab, over the given pixel indices (deterministic)
export function clusterLab(lab, samples, colors, iterations = 12) {
  let boxes = [samples];
  while (boxes.length < colors) {
    let best = -1, bestScore = -1, bestAxis = 0;
    boxes.forEach((box, bi) => {
      if (box.length < 2) return;
      for (let ax = 0; ax < 3; ax++) {
        let lo = Infinity, hi = -Infinity;
        for (const i of box) { const v = lab[i * 3 + ax]; if (v < lo) lo = v; if (v > hi) hi = v; }
        const score = (hi - lo) * (hi - lo) * box.length;
        if (score > bestScore) { bestScore = score; best = bi; bestAxis = ax; }
      }
    });
    if (best < 0 || bestScore === 0) break;
    const box = boxes[best].slice().sort((p, q) => lab[p * 3 + bestAxis] - lab[q * 3 + bestAxis]);
    const mid = box.length >> 1;
    boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }
  let cent = boxes.filter((b) => b.length).map((box) => { const c = [0, 0, 0]; for (const i of box) for (let a = 0; a < 3; a++) c[a] += lab[i * 3 + a]; return c.map((v) => v / box.length); });
  const assign = new Int32Array(samples.length).fill(-1);
  for (let it = 0; it < iterations; it++) {
    let changed = 0;
    const sum = cent.map(() => [0, 0, 0, 0]);
    samples.forEach((i, s) => { const k = nearestCentroid(lab, i, cent); if (k !== assign[s]) { assign[s] = k; changed++; } const S = sum[k]; S[0] += lab[i * 3]; S[1] += lab[i * 3 + 1]; S[2] += lab[i * 3 + 2]; S[3]++; });
    cent = sum.filter((S) => S[3] > 0).map((S) => [S[0] / S[3], S[1] / S[3], S[2] / S[3]]);
    if (!changed) break;
  }
  return cent;
}
export function nearestCentroid(lab, i, cent, allowed = null) {
  let bi = 0, bd = Infinity;
  for (let k = 0; k < cent.length; k++) {
    if (allowed && !allowed(k)) continue;
    const c = cent[k], d0 = lab[i * 3] - c[0], d1 = lab[i * 3 + 1] - c[1], d2 = lab[i * 3 + 2] - c[2], d = d0 * d0 + d1 * d1 + d2 * d2;
    if (d < bd) { bd = d; bi = k; }
  }
  return bi;
}
export function labImage(img) {
  const N = img.width * img.height, lab = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const [L, a, b] = rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]); lab[i * 3] = L; lab[i * 3 + 1] = a; lab[i * 3 + 2] = b; }
  return lab;
}

// 3x3 majority: a pixel whose label is rare in its neighbourhood takes the dominant neighbour label.
// `protect(i)` (optional) exempts pixels, e.g. inside visually important zones.
export function majority(labels, W, H, protect = null) {
  const out = new Uint16Array(labels);
  const count = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (protect && protect(y * W + x)) continue;
    count.clear();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const l = labels[yy * W + xx]; count.set(l, (count.get(l) || 0) + 1);
    }
    const own = count.get(labels[y * W + x]);
    if (own > 2) continue;
    let best = labels[y * W + x], bc = own;
    for (const [l, c] of count) if (c > bc) { bc = c; best = l; }
    if (bc >= 4) out[y * W + x] = best;
  }
  return out;
}

export const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
