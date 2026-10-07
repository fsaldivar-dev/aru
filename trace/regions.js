// Stage 3: connected regions (4-connectivity) of equal color label. Regions smaller than minRegionArea
// are merged into the neighbouring color they share the longest border with, repeated until stable.
import { hex } from './quantize.js';

export function components(labels, W, H) {
  const N = W * H, ids = new Int32Array(N).fill(-1), stack = new Int32Array(N), comps = [];
  for (let s = 0; s < N; s++) {
    if (ids[s] >= 0) continue;
    const id = comps.length, lab = labels[s], pixels = [];
    let top = 0; stack[top++] = s; ids[s] = id;
    while (top) {
      const p = stack[--top]; pixels.push(p);
      const x = p % W, y = (p - x) / W;
      if (x > 0 && ids[p - 1] < 0 && labels[p - 1] === lab) { ids[p - 1] = id; stack[top++] = p - 1; }
      if (x < W - 1 && ids[p + 1] < 0 && labels[p + 1] === lab) { ids[p + 1] = id; stack[top++] = p + 1; }
      if (y > 0 && ids[p - W] < 0 && labels[p - W] === lab) { ids[p - W] = id; stack[top++] = p - W; }
      if (y < H - 1 && ids[p + W] < 0 && labels[p + W] === lab) { ids[p + W] = id; stack[top++] = p + W; }
    }
    comps.push({ id, label: lab, pixels });
  }
  return { ids, comps };
}

// `decide(c, info)` (optional) replaces the plain area rule for candidate components (area < candidateArea).
// info = { border: Map(label -> shared edge count), perimeter, labels, ids, W, H }. Return true to merge.
export function findRegions(q, img, { minRegionArea = 20, maxPasses = 8, decide = null, candidateArea = null } = {}) {
  const { width: W, height: H } = q;
  const labels = new Uint16Array(q.labels);
  let merged = 0, cc;
  for (let pass = 0; pass < maxPasses; pass++) {
    cc = components(labels, W, H);
    const limit = candidateArea ?? minRegionArea;
    const small = cc.comps.filter((c) => c.pixels.length < limit).sort((a, b) => a.pixels.length - b.pixels.length);
    if (!small.length || cc.comps.length === small.length) break;
    let mergedThisPass = 0;
    for (const c of small) {
      const border = new Map();
      let perimeter = 0;
      for (const p of c.pixels) {
        const x = p % W;
        for (const q2 of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
          if (q2 < 0 || q2 >= W * H) { perimeter++; continue; }
          if (cc.ids[q2] === c.id) continue;
          perimeter++;
          const l = labels[q2]; border.set(l, (border.get(l) || 0) + 1);
        }
      }
      const merge = decide ? decide(c, { border, perimeter, labels, ids: cc.ids, W, H }) : c.pixels.length < minRegionArea;
      if (!merge) continue;
      let best = -1, bc = 0;
      for (const [l, n] of border) if (n > bc) { bc = n; best = l; }
      if (best >= 0 && best !== c.label) { for (const p of c.pixels) labels[p] = best; merged++; mergedThisPass++; }
    }
    if (!mergedThisPass) break;
  }
  cc = components(labels, W, H);
  // region statistics; the fill color is the mean of the region's INTERIOR source pixels (anti-aliased edges excluded)
  const regions = cc.comps.map((c) => {
    let x0 = W, y0 = H, x1 = 0, y1 = 0, sx = 0, sy = 0;
    const acc = [0, 0, 0, 0], all = [0, 0, 0, 0];
    for (const p of c.pixels) {
      const x = p % W, y = (p - x) / W;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; sx += x + 0.5; sy += y + 0.5;
      const interior = x > 0 && x < W - 1 && y > 0 && y < H - 1 && cc.ids[p - 1] === c.id && cc.ids[p + 1] === c.id && cc.ids[p - W] === c.id && cc.ids[p + W] === c.id;
      const T = interior ? acc : all;
      T[0] += img.data[p * 4]; T[1] += img.data[p * 4 + 1]; T[2] += img.data[p * 4 + 2]; T[3]++;
    }
    const src = acc[3] ? acc : (acc.forEach((_, i) => (acc[i] += all[i])), acc);
    const color = [src[0] / src[3], src[1] / src[3], src[2] / src[3]];
    return {
      id: c.id, label: c.label, area: c.pixels.length, bounds: [x0, y0, x1 + 1, y1 + 1], centroid: [sx / c.pixels.length, sy / c.pixels.length],
      firstPixel: c.pixels.reduce((m, p) => Math.min(m, p), Infinity), color, sourceColor: hex(color), paletteColor: q.paletteHex[c.label],
    };
  });
  return { width: W, height: H, ids: cc.ids, labels, regions, merged };
}
