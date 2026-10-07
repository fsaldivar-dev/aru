// Fidelity check: rasterize the traced regions back (scanline, even-odd per region, paint order like the
// compiler, pixel-center sampling) and compare against the reference and against the quantized region map.
import { bez } from './bezier.js';
import { reverseSegs } from './compiler.js';

export function loopPolygon(loop, fits) {
  const out = [];
  for (const ref of loop.refs) {
    const f = ref.reversed ? reverseSegs(fits[ref.chain]) : fits[ref.chain];
    let cur = f.start; if (!out.length) out.push(cur);
    for (const s of f.segs) {
      if (s.t === 'L') out.push(s.p);
      else { const b = [cur, s.c1, s.c2, s.p]; for (let i = 1; i <= 8; i++) out.push(bez(b, i / 8)); }
      cur = s.p;
    }
  }
  return out;
}

export function rasterizeTrace(T) {
  const { width: W, height: H } = T;
  const ids = new Int32Array(W * H).fill(-1);
  const order = [...T.regions].sort((a, b) => a.depth - b.depth || b.area - a.area);
  for (const r of order) {
    const poly = loopPolygon(r.outer, T.fits);
    let y0 = Infinity, y1 = -Infinity;
    for (const p of poly) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
      const cy = y + 0.5, xs = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((a[1] > cy) !== (b[1] > cy)) xs.push(a[0] + ((cy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x < Math.min(W, Math.ceil(xs[i + 1] - 0.5)); x++) ids[y * W + x] = r.id;
      }
    }
  }
  return ids;
}

export function fidelity(T, img) {
  const ids = rasterizeTrace(T), N = T.width * T.height;
  const color = new Map(T.regions.map((r) => [r.id, r.color]));
  let errVec = 0, errQuant = 0, within = 0, sameRegion = 0, holes = 0;
  for (let i = 0; i < N; i++) {
    const o = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
    const v = ids[i] >= 0 ? color.get(ids[i]) : [255, 0, 255];
    if (ids[i] < 0) holes++;
    const q = color.get(T.ids[i]);
    const dv = Math.hypot(o[0] - v[0], o[1] - v[1], o[2] - v[2]), dq = Math.hypot(o[0] - q[0], o[1] - q[1], o[2] - q[2]);
    errVec += dv; errQuant += dq;
    if (dv <= 30) within++;
    if (ids[i] === T.ids[i]) sameRegion++;
  }
  return {
    meanColorErrorVector: errVec / N, meanColorErrorRegions: errQuant / N,
    pixelsWithin30: within / N, regionAgreement: sameRegion / N, uncovered: holes / N,
  };
}
