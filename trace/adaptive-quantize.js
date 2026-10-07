// Adaptive quantization: one GLOBAL palette (budget.colors) for the whole image, plus small LOCAL palette
// refinements inside important zones whose quantization error is high.
//
// Representation: palette entries carry a scope ('global' or a zone path). A local entry can only be used by
// pixels of its zone, and a pixel only switches to it when it is clearly better (ΔE gain > minGain) than the best
// global color — so real colors spanning a zone border keep the same global label (no seams at zone edges).
// Refinement units = zones with a local color budget; a pixel belongs to the unit of its deepest owner node,
// walking up the context tree until a node with local budget is found.
import { quantize, clusterLab, nearestCentroid, majority, finalizePalette, labImage } from './quantize.js';

export function adaptiveQuantize(img, plan, { minGain = 5, errThreshold = 5, minDistinct = 8, cache = null, cacheKey = '', thinMask = null } = {}) {
  const W = img.width, H = img.height, N = W * H, imp = plan.imp, ctx = plan.context;
  const colors = plan.budget.colors;
  const key = `q${colors}${cacheKey}`;
  const base = cache?.get(key) || quantize(img, { colors, smooth: 0 });
  cache?.set(key, base);
  const lab = base.lab || labImage(img);
  const labels = new Uint16Array(base.labels);
  const G = base.palette.length;
  const cent = meanLab(lab, labels, G);
  const scope = Array(G).fill('global');

  // refinement unit for each context node
  const zoneByPath = new Map(plan.zones.map((z) => [z.target, z]));
  const unitOf = new Map();
  for (const n of ctx.nodes) {
    let m = n;
    while (m && !((zoneByPath.get(m.path)?.localColors ?? 0) + (zoneByPath.get(m.path)?.extraColors ?? 0) > 0)) m = m.parentPath ? ctx.nodes.find((x) => x.path === m.parentPath) : null;
    unitOf.set(n.index, m ? zoneByPath.get(m.path) : null);
  }
  const unitPixels = new Map();
  for (let i = 0; i < N; i++) {
    const o = imp.owner[i]; if (o < 0) continue;
    const u = unitOf.get(o); if (!u) continue;
    if (!unitPixels.has(u)) unitPixels.set(u, []);
    unitPixels.get(u).push(i);
  }
  const stats = [];
  const de = (i, c) => Math.sqrt((lab[i * 3] - c[0]) ** 2 + (lab[i * 3 + 1] - c[1]) ** 2 + (lab[i * 3 + 2] - c[2]) ** 2);
  for (const [u, px] of unitPixels) {
    let wsum = 0, esum = 0;
    for (const i of px) { const w = imp.map[i]; wsum += w; esum += w * de(i, cent[labels[i]]); }
    const errBefore = esum / Math.max(1e-9, wsum);
    const k = Math.min(6, u.localColors + u.extraColors);
    const st = { target: u.target, pixels: px.length, errBefore, errAfter: errBefore, localColors: 0, switched: 0 };
    stats.push(st);
    if (errBefore < errThreshold || k <= 0 || px.length < 12) continue;
    const local = clusterLab(lab, px.length > 4000 ? px.filter((_, j) => j % Math.ceil(px.length / 4000) === 0) : px, k, 10);
    const first = cent.length, used = new Array(local.length).fill(0), pending = [];
    for (const i of px) {
      const g = de(i, cent[labels[i]]);
      let bl = -1, bd = Infinity;
      for (let j = 0; j < local.length; j++) { const d = de(i, local[j]); if (d < bd) { bd = d; bl = j; } }
      if (bd + minGain < g) { pending.push([i, bl]); used[bl]++; }
    }
    const keepIdx = new Map();
    const minUse = Math.max(6, Math.round(px.length * 0.02)); // a local color must describe a real part of the zone
    // ...and be a genuinely new color (ΔE >= minDistinct from every global color), not a compression/gradient shade
    const distinct = (c) => cent.slice(0, G).every((g) => Math.hypot(g[0] - c[0], g[1] - c[1], g[2] - c[2]) >= minDistinct);
    local.forEach((c, j) => { if (used[j] >= minUse && distinct(c)) { keepIdx.set(j, cent.length); cent.push(c); scope.push(u.target); } });
    for (const [i, j] of pending) if (keepIdx.has(j)) { labels[i] = keepIdx.get(j); st.switched++; }
    st.localColors = keepIdx.size;
    esum = 0; for (const i of px) esum += imp.map[i] * de(i, cent[labels[i]]);
    st.errAfter = esum / Math.max(1e-9, wsum);
    if (!keepIdx.size) cent.length = first;
  }
  // anti-aliasing cleanup everywhere except explicitly preserved details. (First version also skipped every
  // important pixel: that kept compression noise along eye edges and produced staircase outlines.)
  // thin features (whiskers, 1–3 px strokes) are also exempt: a 3x3 majority erases them by construction
  const cleaned = majority(labels, W, H, thinMask ? (i) => imp.preserve[i] === 1 || thinMask[i] === 1 : (i) => imp.preserve[i] === 1);
  const fin = finalizePalette(img, cleaned, cent.length, { lab });
  const finalScope = [];
  fin.remap.forEach((nw, old) => { if (nw >= 0) finalScope[nw] = scope[old]; });
  fin.paletteScope = finalScope;
  fin.labelLab = meanLab(lab, fin.labels, fin.palette.length);
  fin.globalColors = finalScope.filter((s) => s === 'global').length;
  fin.localColors = finalScope.length - fin.globalColors;
  fin.zoneStats = stats;
  return fin;
}

export function meanLab(lab, labels, n) {
  const acc = Array.from({ length: n }, () => [0, 0, 0, 0]);
  for (let i = 0; i < labels.length; i++) { const A = acc[labels[i]]; A[0] += lab[i * 3]; A[1] += lab[i * 3 + 1]; A[2] += lab[i * 3 + 2]; A[3]++; }
  return acc.map((A) => (A[3] ? [A[0] / A[3], A[1] / A[3], A[2] / A[3]] : [0, 0, 0]));
}
