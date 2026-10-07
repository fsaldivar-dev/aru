// Perceptual Regularizer (region level). Runs between the measured regions and the contour extraction:
//   "which clean regions were these pixels probably trying to be?"
// Stages: RAG merging -> gradient detection -> palette cleanup -> identical-neighbour merging.
// Everything is driven by `abstraction` (0 = keep the trace, 1 = icon-like) and validated against the pixels.
import { buildRAG, mergeNodes, meanLab, ownerOf, deltaE, regionsFromIds, labToRgb } from './rag.js';
import { hex } from './quantize.js';

const lerp = (a, b, t) => a + (b - a) * t;

export function regularizationParams(A) {
  return {
    mergeDE: lerp(5, 18, A),         // ΔE scale of acceptable recoloring for small regions
    sameColorDE: lerp(2.5, 7, A),    // adjacent regions this close are the same paint, whatever their size
    sizeLimit: lerp(40, 900, A),     // "small" (px), shrunk by importance
    paletteDE: lerp(4, 10, A),       // palette collapse radius (ΔE); near-duplicates are < 5
    gradStep: lerp(9, 16, A),        // max ΔE between neighbours of one gradient
    gradAllowance: lerp(1.05, 1.5, A), // gradient RMS may exceed the flat RMS by this factor
  };
}

export function regularizeRegions(reg, img, lab, plan, { abstraction = 0.5, thinMask = null } = {}) {
  const detailOf = (owner) => plan.context.nodes[owner]?.visualIntent?.detail;
  const detailScale = (owner) => ({ low: 1.5, medium: 1, high: 0.8 }[detailOf(owner)] ?? 1);
  const t0 = Date.now();
  const P = regularizationParams(abstraction);
  const { width: W, height: H } = reg, imp = plan.imp;
  const nodes = buildRAG(reg.ids, W, H, lab, imp);
  // thin features never disappear into a neighbour (they may absorb fragments)
  if (thinMask) { const cnt = new Map(); for (let i = 0; i < reg.ids.length; i++) if (thinMask[i]) cnt.set(reg.ids[i], (cnt.get(reg.ids[i]) || 0) + 1); for (const [id, k] of cnt) { const n = nodes.get(id); if (n && k >= 0.5 * n.area && k >= 6) n.thin = true; } }
  const parent = new Map();
  const find = (x) => { while (parent.has(x)) x = parent.get(x); return x; };
  const stats = { ragNodes: nodes.size, merged: 0, passes: 0 };

  // ---- 1. perceptual merging on the RAG ----
  for (let pass = 0; pass < 12; pass++) {
    const cands = [];
    for (const a of nodes.values()) {
      if (a.thin) continue;
      const la = meanLab(a), imp_ = 0.5 * (a.impSum / a.area) + 0.5 * a.impMax, oa = ownerOf(a);
      let best = null, bc = Infinity;
      // anti-aliasing fragment: its color lies BETWEEN its two main neighbours (dE(a,n1)+dE(a,n2) ≈ dE(n1,n2))
      const top = [...a.neighbors].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 2).map(([id]) => nodes.get(id));
      let aaFragment = false;
      if (top.length === 2) {
        const l1 = meanLab(top[0]), l2 = meanLab(top[1]), d12 = deltaE(l1, l2);
        aaFragment = d12 > 8 && deltaE(la, l1) + deltaE(la, l2) <= 1.25 * d12 && a.area < P.sizeLimit;
      }
      for (const [bid, len] of a.neighbors) {
        const b = nodes.get(bid);
        if (b.area < a.area) continue; // the smaller region is the one that disappears
        const dE = deltaE(la, meanLab(b));
        const shared = len / Math.max(1, a.perimeter);
        const small = a.area < P.sizeLimit * (1 - 0.8 * imp_);
        if (!small && !aaFragment && dE > P.sameColorDE) continue;
        // semantic boundaries matter for real regions, much less for few-pixel fragments
        const semantic = oa !== ownerOf(b) ? 0.6 * Math.min(1, a.area / 30) : 0;
        // a compact, contrasting detail fully inside another color (highlight, pupil) is kept; preserve makes it stronger
        const detail = shared > 0.8 && dE > 15 ? (a.preserve ? 3 : 1.2) : (a.preserve ? 0.3 : 0);
        const cost = (dE * (1 + imp_)) / (P.mergeDE * detailScale(oa)) + 0.5 * (1 - shared) + semantic + detail - (aaFragment ? 0.6 : 0);
        if (cost < bc) { bc = cost; best = b; }
      }
      if (best && bc < 1) cands.push({ a, b: best, cost: bc });
    }
    if (!cands.length) break;
    cands.sort((x, y) => x.cost - y.cost || x.a.id - y.a.id);
    const touched = new Set();
    let merged = 0;
    for (const { a, b } of cands) {
      if (touched.has(a.id) || touched.has(b.id) || !nodes.has(a.id) || !nodes.has(b.id)) continue;
      mergeNodes(nodes, a, b); parent.set(a.id, b.id); touched.add(a.id); touched.add(b.id); merged++;
    }
    stats.merged += merged; stats.passes++;
    if (!merged) break;
  }

  // ---- 2. gradient detection: banded regions that are one continuous linear ramp become one gradient region ----
  if (!(typeof process !== 'undefined' && process.env?.ARU_NO_GRAD)) detectGradients(nodes, reg, find, lab, W, P, parent, stats);

  // ---- 3. palette cleanup: cluster region colors (area-weighted), tighter where importance is high ----
  const order = [...nodes.values()].filter((n) => !n.grad).sort((x, y) => y.area - x.area || x.id - y.id);
  let clusters = [];
  const clusterOf = new Map();
  for (const n of order) {
    const l = meanLab(n), imp_ = n.impSum / n.area, tau = P.paletteDE * (1 - 0.5 * imp_);
    let best = -1, bd = Infinity;
    clusters.forEach((c, k) => { const d = deltaE(l, c.lab); if (d < bd) { bd = d; best = k; } });
    if (best >= 0 && bd < tau) { const c = clusters[best]; const w = c.w + n.area; c.lab = c.lab.map((v, i) => (v * c.w + l[i] * n.area) / w); c.w = w; clusterOf.set(n.id, best); }
    else { clusterOf.set(n.id, clusters.length); clusters.push({ lab: l, w: n.area }); }
  }
  // cluster centres drift: fold centres that ended up closer than the near-duplicate threshold
  const alias = clusters.map((_, k) => k);
  const root = (k) => { while (alias[k] !== k) k = alias[k]; return k; };
  for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
    const ri = root(i), rj = root(j); if (ri === rj) continue;
    if (deltaE(clusters[ri].lab, clusters[rj].lab) < Math.min(5, P.paletteDE)) {
      const w = clusters[ri].w + clusters[rj].w;
      clusters[ri].lab = clusters[ri].lab.map((v, k) => (v * clusters[ri].w + clusters[rj].lab[k] * clusters[rj].w) / w); clusters[ri].w = w; alias[rj] = ri;
    }
  }
  const paletteLab = (id) => (clusterOf.has(id) ? clusters[root(clusterOf.get(id))].lab : meanLab(nodes.get(id)));
  stats.paletteColors = new Set([...nodes.keys()].filter((id) => clusterOf.has(id)).map((id) => root(clusterOf.get(id)))).size;
  // ---- 4. neighbours painted with the same color become one region (unless they belong to different parts) ----
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of [...nodes.values()].sort((x, y) => x.area - y.area || x.id - y.id)) {
      if (!nodes.has(a.id) || a.grad) continue;
      const ca = root(clusterOf.get(a.id));
      for (const [bid] of [...a.neighbors].sort((x, y) => y[1] - x[1] || x[0] - y[0])) {
        const b = nodes.get(bid); if (!b || b.grad || root(clusterOf.get(bid)) !== ca) continue;
        if (ownerOf(a) !== ownerOf(b) && a.area > 30 && b.area > 30) continue;
        const [small, big] = a.area <= b.area ? [a, b] : [b, a];
        if (small.thin) continue;
        mergeNodes(nodes, small, big); parent.set(small.id, big.id); stats.merged++; changed = true;
        break;
      }
    }
  }

  // ---- 5. semantic coherence: a part should be a few clean regions, not dozens of fragments ----
  // budget per context part from its `detail` hint and the abstraction; merges stay INSIDE the part,
  // cheapest pair first (small ΔE, small area); compact contrasting preserved details are protected.
  const byOwner = new Map();
  for (const n of nodes.values()) { const o = ownerOf(n); if (o < 0) continue; if (!byOwner.has(o)) byOwner.set(o, new Set()); byOwner.get(o).add(n.id); }
  stats.coherenceMerged = 0;
  for (const [o, set] of [...byOwner].sort((x, y) => x[0] - y[0])) {
    let partArea = 0; for (const id of set) partArea += nodes.get(id).area;
    const fragLimit = Math.min(0.15 * partArea, 2 * P.sizeLimit);        // what counts as a fragment of THIS part
    const base = { low: 3, medium: 5, high: 8 }[detailOf(o)] ?? 5;
    const budget = Math.max(1, Math.round(base * (1.25 - abstraction) * Math.sqrt(partArea / 3000)));
    const fragments = () => [...set].filter((id) => nodes.get(id).area < fragLimit).length;
    while (fragments() > budget) {
      let best = null, bc = Infinity;
      for (const id of set) {
        const a = nodes.get(id);
        if (a.area >= fragLimit) continue;
        for (const [bid] of a.neighbors) {
          if (!set.has(bid) || bid === id) continue;
          const b = nodes.get(bid);
          const [sm, lg] = a.area <= b.area ? [a, b] : [b, a];
          if (sm.thin || sm.grad || lg.grad && sm.area > 200) continue;
          const dE = deltaE(meanLab(sm), meanLab(lg));
          if (dE > 2 * P.mergeDE && sm.area > 12) continue; // never erase a genuinely different color
          const protectedDetail = sm.preserve && dE > 25 && (sm.neighbors.get(lg.id) || 0) / Math.max(1, sm.perimeter) > 0.6;
          if (protectedDetail) continue;
          const cost = dE * Math.sqrt(sm.area);
          if (cost < bc || (cost === bc && sm.id < best?.[0].id)) { bc = cost; best = [sm, lg]; }
        }
      }
      if (!best) break;
      const [sm, lg] = best;
      mergeNodes(nodes, sm, lg); parent.set(sm.id, lg.id); set.delete(sm.id); stats.merged++; stats.coherenceMerged++;
    }
  }

  // ---- relabel ----
  const ids = new Int32Array(reg.ids.length);
  for (let i = 0; i < ids.length; i++) ids[i] = find(reg.ids[i]);
  const labelOfOld = new Map(reg.regions.map((r) => [r.id, r.label]));
  const regions = regionsFromIds(ids, W, H, img, (id) => labelOfOld.get(id) ?? 0, [], hex);
  // fills come from the cleaned palette, not from each region's own mean; gradient regions get their ramp
  for (const r of regions) {
    const node = nodes.get(r.id);
    if (node?.grad) {
      const g = gradientGeometry(node.grad, ids, r.id, W, H);
      r.gradient = g; r.color = labToRgb(g.midLab); r.sourceColor = hex(r.color);
      continue;
    }
    const c = labToRgb(paletteLab(r.id)); r.color = c; r.sourceColor = hex(c);
  }
  stats.gradients = regions.filter((r) => r.gradient).length;
  const labels = new Uint16Array(reg.labels.length);
  const labelById = new Map(regions.map((r) => [r.id, r.label]));
  for (let i = 0; i < ids.length; i++) labels[i] = labelById.get(ids[i]);
  stats.regionsAfter = regions.length;
  stats.ms = Date.now() - t0;
  return { reg: { width: W, height: H, ids, labels, regions, merged: reg.merged + stats.merged }, stats, nodes };
}

// ---------- gradients ----------
// Per-node additive moments make the least-squares fit of ANY union of regions O(1):
//   color_c(x, y) = b0 + bx·x + by·y   (Lab, coordinates normalized by W)
function momentsOf(nodes, reg, find, lab, W) {
  const M = new Map();
  for (const n of nodes.values()) M.set(n.id, new Float64Array(18));
  for (let i = 0; i < reg.ids.length; i++) {
    const m = M.get(find(reg.ids[i])); if (!m) continue;
    const x = (i % W) / W, y = Math.floor(i / W) / W;
    m[0]++; m[1] += x; m[2] += y; m[3] += x * x; m[4] += x * y; m[5] += y * y;
    for (let c = 0; c < 3; c++) { const v = lab[i * 3 + c]; m[6 + c * 4] += v; m[7 + c * 4] += v * x; m[8 + c * 4] += v * y; m[9 + c * 4] += v * v; }
  }
  return M;
}
const addM = (a, b) => { const o = new Float64Array(18); for (let i = 0; i < 18; i++) o[i] = a[i] + b[i]; return o; };
function fitM(m) {
  const S = [m[0], m[1], m[2], m[1], m[3], m[4], m[2], m[4], m[5]];
  const det3 = (q) => q[0] * (q[4] * q[8] - q[5] * q[7]) - q[1] * (q[3] * q[8] - q[5] * q[6]) + q[2] * (q[3] * q[7] - q[4] * q[6]);
  const S2 = S.slice(); S2[4] += 1e-9; S2[8] += 1e-9;
  const D = det3(S2);
  let sse = 0; const beta = [];
  for (let c = 0; c < 3; c++) {
    const rhs = [m[6 + c * 4], m[7 + c * 4], m[8 + c * 4]];
    const b = [0, 1, 2].map((k) => { const q = S2.slice(); for (let r = 0; r < 3; r++) q[r * 3 + k] = rhs[r]; return Math.abs(D) > 1e-12 ? det3(q) / D : (k === 0 ? rhs[0] / m[0] : 0); });
    beta.push(b);
    sse += m[9 + c * 4] - (b[0] * rhs[0] + b[1] * rhs[1] + b[2] * rhs[2]);
  }
  return { beta, rms: Math.sqrt(Math.max(0, sse) / m[0]) };
}
const flatSSE = (m) => { let s = 0; for (let c = 0; c < 3; c++) s += m[9 + c * 4] - m[6 + c * 4] ** 2 / m[0]; return s; };

function detectGradients(nodes, reg, find, lab, W, P, parent, stats) {
  const M = momentsOf(nodes, reg, find, lab, W);
  const minArea = 40;
  const used = new Set();
  let groups = 0, absorbed = 0, singles = 0;
  const seeds = [...nodes.values()].filter((n) => n.area >= minArea && !n.preserve && (2 * n.area) / Math.max(1, n.perimeter) >= 3.5).sort((a, b) => b.area - a.area || a.id - b.id);
  for (const seed of seeds) {
    if (used.has(seed.id) || !nodes.has(seed.id)) continue;
    const owner = ownerOf(seed);
    let members = [seed.id], m = M.get(seed.id), flat = flatSSE(m);
    const inGroup = new Set(members);
    let grew = true;
    while (grew) {
      grew = false;
      let best = null, bestRms = Infinity, bestM = null, bestFlat = 0;
      for (const id of members) for (const [nid, len] of nodes.get(id).neighbors) {
        if (inGroup.has(nid) || used.has(nid)) continue;
        const nb = nodes.get(nid);
        if (nb.area < minArea || nb.preserve || ownerOf(nb) !== owner) continue;
        if ((2 * nb.area) / Math.max(1, nb.perimeter) < 3.5) continue; // a thin line (stroke, whisker, icon) is not a gradient band
        const dE = deltaE(meanLab(nodes.get(id)), meanLab(nb));
        if (dE < 2 || dE > P.gradStep || len < Math.max(4, 0.15 * Math.min(nb.perimeter, nodes.get(id).perimeter))) continue;
        const um = addM(m, M.get(nid)), f = fitM(um), fl = flat + flatSSE(M.get(nid));
        const flatRms = Math.sqrt(fl / um[0]);
        // the ramp must explain the union almost as well as separate flat colors do
        if (f.rms <= Math.max(2.5, flatRms * P.gradAllowance) && f.rms < 9 && f.rms < bestRms) { best = nid; bestRms = f.rms; bestM = um; bestFlat = fl; }
      }
      if (best !== null) { members.push(best); inGroup.add(best); m = bestM; flat = bestFlat; grew = true; }
    }
    const f = fitM(m);
    const extent = gradientExtent(f.beta, nodes, members, W);
    if (members.length >= 2 && extent >= 6) {
      for (const id of members.slice(1)) { mergeNodes(nodes, nodes.get(id), seed); parent.set(id, seed.id); absorbed++; }
      seed.grad = f.beta; groups++;
      members.forEach((id) => used.add(id));
    } else if (members.length === 1 && seed.area >= 400) {
      // a single large region whose color clearly varies linearly keeps its shape but gets a ramp
      const flatRms = Math.sqrt(flatSSE(m) / m[0]);
      if (flatRms >= 4 && f.rms <= 0.7 * flatRms && extent >= 6) { seed.grad = f.beta; singles++; used.add(seed.id); }
    }
  }
  stats.gradientGroups = groups; stats.gradientAbsorbed = absorbed; stats.gradientSingles = singles; stats.merged += absorbed;
}
// approximate color change (ΔE) across a group's bounding box along the ramp direction
function gradientExtent(beta, nodes, members, W) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of members) { const n = nodes.get(id); x0 = Math.min(x0, n.x0); y0 = Math.min(y0, n.y0); x1 = Math.max(x1, n.x1); y1 = Math.max(y1, n.y1); }
  const dx = (x1 - x0) / W, dy = (y1 - y0) / W;
  return Math.sqrt(beta.reduce((s, b) => s + (b[1] * dx) ** 2 + (b[2] * dy) ** 2, 0));
}
// direction = dominant eigenvector of JᵀJ; endpoints = extreme projections of the region's pixels
function gradientGeometry(beta, ids, id, W, H) {
  let a = 0, b = 0, c = 0;
  for (const B of beta) { a += B[1] * B[1]; b += B[1] * B[2]; c += B[2] * B[2]; }
  const theta = 0.5 * Math.atan2(2 * b, a - c), d = [Math.cos(theta), Math.sin(theta)];
  let tmin = Infinity, tmax = -Infinity, sx = 0, sy = 0, n = 0;
  for (let i = 0; i < ids.length; i++) if (ids[i] === id) { const x = (i % W) + 0.5, y = Math.floor(i / W) + 0.5; const t = x * d[0] + y * d[1]; if (t < tmin) tmin = t; if (t > tmax) tmax = t; sx += x; sy += y; n++; }
  const cx = sx / n, cy = sy / n, tc = cx * d[0] + cy * d[1];
  const p0 = [cx + d[0] * (tmin - tc), cy + d[1] * (tmin - tc)], p1 = [cx + d[0] * (tmax - tc), cy + d[1] * (tmax - tc)];
  const at = (p) => beta.map((B) => B[0] + B[1] * (p[0] / W) + B[2] * (p[1] / W));
  const l0 = at(p0), l1 = at(p1);
  return { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], c0: labToRgb(l0), c1: labToRgb(l1), lab0: l0, lab1: l1, midLab: l0.map((v, k) => (v + l1[k]) / 2) };
}
