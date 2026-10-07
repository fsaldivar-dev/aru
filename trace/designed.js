// designedScore: "does this look deliberately built?" — cleanliness that is CONDITIONED on preservation.
//
//   polish_s       = weighted mean of: edge cleanliness, curvature consistency, analytic simplicity,
//                    (low) fragmentation, semantic coherence (regions per color role), palette coherence
//   preservation_s = exp(-4 · lostGood / max(good_baseline, 80))       lostGood = baseline-mask pixels (ΔE <= 10) that no longer
//                                                                       match; measured on the BASELINE mask of the section,
//                                                                       so shrinking/reassigning a section cannot game it
//   semantic_s     = min(1, area_after / area_baseline)                 (sections that were only raster fragments are exempt)
//   designed_s     = polish_s × preservation_s × semantic_s
//   designedScore  = importance·√area weighted mean of designed_s × exp(-8 · relative loss of importance-weighted matches)
// Deleting half the illustration raises cleanliness but collapses preservation, so designedScore drops.
import { rasterizeTrace } from './raster.js';
import { rgbToLab } from './quantize.js';
import { bez } from './bezier.js';
import { colorName } from './semanticize.js';
import { shapeDistance } from './conics.js';

const de = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], len = (v) => Math.hypot(v[0], v[1]);

// pixel masks of every section in a (baseline) trace
export function sectionMasks(T, assign) {
  const by = new Map();
  for (let i = 0; i < T.ids.length; i++) { const p = assign.get(T.ids[i])?.path ?? 'background'; let a = by.get(p); if (!a) by.set(p, (a = [])); a.push(i); }
  return by;
}

// per-section measurements of a trace, fidelity measured on `masks` (baseline masks) with the rendered result
export function measureSections(T, assign, lab, masks, imp = null, { ids = null, only = null, shapes = null } = {}) {
  const W = T.width;
  const rid = ids || rasterizeTrace(T);
  const byId = new Map(T.regions.map((r) => [r.id, r]));
  const labOf = new Map(T.regions.map((r) => [r.id, rgbToLab(...r.color)]));
  const colorAt = (id, i) => {
    const r = byId.get(id); if (!r) return [100, 0, 0];
    const g = r.gradient; if (!g) return labOf.get(id);
    const x = (i % W) + 0.5, y = Math.floor(i / W) + 0.5, dx = g.x2 - g.x1, dy = g.y2 - g.y1, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - g.x1) * dx + (y - g.y1) * dy) / L2));
    return g.lab0.map((v, k) => v + (g.lab1[k] - v) * t);
  };
  const out = new Map();
  const ensure = (p) => { if (!out.has(p)) out.set(p, { section: p, regions: [], chains: new Set(), area: 0 }); return out.get(p); };
  for (const r of T.regions) { const pr = assign.get(r.id)?.path ?? 'background'; if (only && !only.has(pr)) continue; const s = ensure(pr); s.regions.push(r); s.area += r.area; for (const loop of [r.outer, ...r.holeLoops]) for (const ref of loop.refs) s.chains.add(ref.chain); }
  for (const p of masks.keys()) if (!only || only.has(p)) ensure(p);
  let wGood = 0, wSum = 0;
  for (const [p, s] of out) {
    // fidelity on the baseline mask
    const mask = masks.get(p) || [];
    let g = 0, gw = 0, ww = 0;
    for (const i of mask) { const c = colorAt(rid[i], i), ok = de([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]], c) <= 10, w = imp ? imp.map[i] : 1; if (ok) { g++; gw += w; } ww += w; }
    s.fidelity = mask.length ? g / mask.length : 1; s.baseArea = mask.length; s.good = g;
    wGood += gw; wSum += ww;
    // regions: tiny, roles, near-duplicate paints, dominant colors
    const tinyArea = Math.max(12, 0.02 * s.area);
    s.tiny = s.regions.filter((r) => r.area < tinyArea).length;
    const paints = s.regions.map((r) => ({ lab: rgbToLab(...r.color), area: r.area, rgb: r.color }));
    const roles = [];
    for (const q of [...paints].sort((a, b) => b.area - a.area)) { const k = roles.find((x) => de(x.lab, q.lab) < 12); if (k) k.area += q.area; else roles.push({ lab: q.lab, area: q.area, rgb: q.rgb }); }
    s.roles = roles.length;
    let near = 0; for (let i = 0; i < paints.length; i++) if (paints.some((q, j) => j !== i && de(q.lab, paints[i].lab) < 5 && de(q.lab, paints[i].lab) > 0.5)) near++;
    s.nearDuplicates = near; s.colors = paints.length;
    s.dominantColors = roles.slice(0, 3).map((x) => ({ name: colorName(x.rgb), hex: '#' + x.rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''), share: +(x.area / Math.max(1, s.area)).toFixed(2) }));
    // edges
    const fits = [...s.chains].map((c) => T.fits[c]);
    let pts = 0, segsN = 0, curves = 0, lines = 0, turn = 0, length = 0, flat = 0, joints = 0, infl = 0, curvLen = 0;
    for (const f of fits) {
      let cur = f.start, prevDir = null, prevKind = null, prevSign = 0;
      for (const sg of f.segs) {
        pts += sg.t === 'L' ? 1 : 3; segsN += sg.t === 'C' ? 1.5 : 1;
        if (sg.t === 'L') lines++; else curves++;
        const poly = sg.t === 'L' ? [cur, sg.p] : Array.from({ length: 9 }, (_, i) => bez([cur, sg.c1, sg.c2, sg.p], i / 8));
        for (let i = 1; i < poly.length; i++) {
          const d = sub(poly[i], poly[i - 1]), l = len(d); if (!l) continue;
          length += l; if (sg.t === 'C') curvLen += l;
          if (prevDir) {
            const cr = prevDir[0] * d[1] - prevDir[1] * d[0], a = Math.atan2(cr, prevDir[0] * d[0] + prevDir[1] * d[1]);
            turn += Math.abs(a);
            if (sg.t === 'C' && i > 1 && Math.abs(a) > 0.05) { const sgn = Math.sign(a); if (prevSign && sgn !== prevSign) infl++; prevSign = sgn; }
            if (i === 1 && prevKind === 'L' && sg.t === 'L') { joints++; if (Math.abs(a) * 180 / Math.PI < 12) flat++; }
          }
          prevDir = d;
        }
        prevKind = sg.t; cur = sg.p;
      }
    }
    Object.assign(s, { points: pts, segments: segsN, curveRatio: curves / Math.max(1, curves + lines), roughness: length ? (turn / length) * 10 : 0, flatVertices: flat, flatRatio: flat / Math.max(1, joints), inflectionsPer100: curvLen ? (infl / curvLen) * 100 : 0, boundaryLength: length, regionCount: s.regions.length });
    // analytic coherence: share of the section's OUTLINE (output geometry) lying on its validated shape
    const sh = shapes?.get(p);
    if (sh) {
      const mine = new Set(s.regions.map((r) => r.id));
      let on = 0, all = 0;
      for (const ci of s.chains) {
        const c = T.chains[ci];
        if (mine.has(c.left) && mine.has(c.right)) continue; // inner edges are not the outline
        const f = T.fits[ci]; let cur = f.start;
        for (const sg of f.segs) { const poly = sg.t === 'L' ? [cur, sg.p] : Array.from({ length: 9 }, (_, i) => bez([cur, sg.c1, sg.c2, sg.p], i / 8)); for (const q of poly.slice(1)) { all++; if ([].concat(sh).some((x) => shapeDistance(x.shape, q).d <= Math.max(0.6, 0.5 * x.tol))) on++; } cur = sg.p; }
      }
      s.analyticFit = all ? on / all : 0;
    }
    delete s.regions; s.chains = s.chains.size;
  }
  return { sections: out, weightedFidelity: wSum ? wGood / wSum : 1, weightedGood: wGood };
}

export function polishComponents(s) {
  const c = {
    edges: (1 / (1 + s.roughness / 0.5)) * (1 - 0.5 * s.flatRatio),
    curvature: 1 / (1 + s.inflectionsPer100 / 2),
    analytic: 1 / (1 + s.segments / Math.max(1, s.boundaryLength / 20)), // anchor nodes per 20 px (a cubic counts 1.5): a 4-cubic circle beats a 20-line polygon
    fragmentation: 1 - s.tiny / Math.max(1, s.regionCount),
    semantic: 1 / (1 + Math.max(0, s.regionCount - s.roles) / 2),
    palette: 1 - s.nearDuplicates / Math.max(1, s.colors),
  };
  const w = { edges: 0.25, curvature: 0.1, analytic: 0.2, fragmentation: 0.15, semantic: 0.2, palette: 0.1 };
  if (s.analyticFit !== undefined) { c.shape = s.analyticFit; w.shape = 0.25; } // only where the pixels support a shape
  let p = 0, ws = 0; for (const k of Object.keys(w)) { p += w[k] * c[k]; ws += w[k]; }
  p /= ws;
  return { components: c, polish: p };
}

// designed scores of `after` relative to `base` (both from measureSections on the SAME baseline masks)
export function designedScores(after, base, ctx) {
  const nodes = new Map(ctx.nodes.map((n) => [n.path, n]));
  const per = new Map();
  let num = 0, den = 0;
  for (const [p, b] of base.sections) {
    const a = after.sections.get(p) || { ...b, area: 0, regionCount: 0 };
    const { components, polish } = a.regionCount ? polishComponents(a) : { components: null, polish: 0 };
    // pixels of the baseline mask that matched before and do not now (absolute, so 3 px in a tiny highlight stay 3 px)
    const preservation = Math.exp(-4 * Math.max(0, b.good - (a.good ?? 0)) / Math.max(b.good, 80));
    const semantic = b.area < 20 ? 1 : Math.min(1, a.area / b.area);
    const designed = (a.regionCount ? polish : 0) * preservation * (b.area < 20 ? 1 : semantic) || (b.area < 20 ? 1 : 0);
    per.set(p, { section: p, polish, preservation, semantic, designed, components });
    const imp = p === 'background' ? ctx.background.importance : nodes.get(p)?.importance ?? 0.5;
    const w = Math.max(0.05, imp) * Math.sqrt(Math.max(1, b.area));
    num += w * designed; den += w;
  }
  const globalPreservation = Math.exp(-8 * Math.max(0, base.weightedGood - after.weightedGood) / Math.max(1, base.weightedGood));
  return { sections: per, designedScore: (den ? num / den : 0) * globalPreservation, globalPreservation, meanSection: den ? num / den : 0 };
}
