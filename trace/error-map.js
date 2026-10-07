// Error Map: rasterize the traced result and compare it with the reference in CIE Lab (ΔE76) per pixel.
// Weighted Error Map = Error Map × Importance Map. Also aggregated per context zone (for the quality search).
import { rasterizeTrace } from './raster.js';
import { rgbToLab } from './quantize.js';

export function errorMaps(T, img, imp, { threshold = 10 } = {}) {
  const ids = rasterizeTrace(T), N = T.width * T.height;
  const regLab = new Map(T.regions.map((r) => [r.id, rgbToLab(...r.color)]));
  const W = T.width, regById = new Map(T.regions.map((r) => [r.id, r]));
  // gradient regions: color along the ramp
  const colorAt = (id, i) => {
    const r = regById.get(id), g = r?.gradient;
    if (!g) return regLab.get(id);
    const x = (i % W) + 0.5, y = Math.floor(i / W) + 0.5, dx = g.x2 - g.x1, dy = g.y2 - g.y1, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - g.x1) * dx + (y - g.y1) * dy) / L2));
    return g.lab0.map((v, k) => v + (g.lab1[k] - v) * t);
  };
  const err = new Float32Array(N), weighted = new Float32Array(N);
  let within = 0, wWithin = 0, wSum = 0, eSum = 0, weSum = 0, rgb30 = 0, agree = 0;
  const zones = new Map();
  for (let i = 0; i < N; i++) {
    const o = rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
    const v = ids[i] >= 0 ? colorAt(ids[i], i) : [100, 0, 0];
    const e = Math.hypot(o[0] - v[0], o[1] - v[1], o[2] - v[2]);
    const w = imp ? imp.map[i] : 1;
    err[i] = e; weighted[i] = e * w;
    if (e <= threshold) { within++; wWithin += w; }
    wSum += w; eSum += e; weSum += e * w;
    if (ids[i] === T.ids[i]) agree++;
    if (ids[i] >= 0) { const c = T.regionsById.get(ids[i]).color; if (Math.hypot(img.data[i * 4] - c[0], img.data[i * 4 + 1] - c[1], img.data[i * 4 + 2] - c[2]) <= 30) rgb30++; }
    // error diagnosis: colorLoss = pixel vs its own region color (quantization / merging),
    // geomLoss = what vectorization adds on top (pixel rendered with a neighbour's color)
    const own = colorAt(T.ids[i], i);
    const eReg = own ? Math.hypot(o[0] - own[0], o[1] - own[1], o[2] - own[2]) : e;
    if (imp) {
      const z = imp.owner[i]; let s = zones.get(z);
      if (!s) zones.set(z, (s = { owner: z, mass: 0, imp: 0, err: 0, n: 0, within: 0, colorLoss: 0, geomLoss: 0 }));
      s.mass += e * w; s.imp += w; s.err += e; s.n++; if (e <= threshold) s.within++;
      s.colorLoss += eReg * w; s.geomLoss += Math.max(0, e - eReg) * w;
    }
  }
  return {
    err, weighted, ids,
    metrics: {
      pixelFidelity: within / N, weightedFidelity: wWithin / wSum, meanColorError: eSum / N, weightedColorError: weSum / wSum,
      pixelsWithinRGB30: rgb30 / N, regionAgreement: agree / N,
    },
    zones: [...zones.values()].map((z) => ({ ...z, meanErr: z.err / z.n, fidelity: z.within / z.n })).sort((a, b) => b.mass - a.mass),
  };
}
