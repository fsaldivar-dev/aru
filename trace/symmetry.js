// Symmetry regularization: "shared structure + independent local variation".
// For every `symmetric` relation in the VisualContext, regions of part A are paired with regions of part B by
// mirrored position (relative to the axis between both parts), color and area. Paired colors are pulled toward
// their common mean by `strength` (0 = untouched, 1 = identical); unmatched regions keep their own look.
import { rgbToLab } from './quantize.js';
import { labToRgb, deltaE } from './rag.js';
import { hex } from './quantize.js';

export function harmonizeSymmetry(T, assign, ctx, strength) {
  const out = { pairs: 0, beforeDE: 0, afterDE: 0 };
  if (!strength) return out;
  for (const rel of ctx.relations || []) {
    if (rel.type !== 'symmetric' && rel.type !== 'paired') continue;
    const inPart = (p) => T.regions.filter((r) => { const a = assign.get(r.id); return a && (a.path === p || a.path.startsWith(p + '.')); });
    const A = inPart(rel.a), B = inPart(rel.b);
    if (!A.length || !B.length) continue;
    const box = (rs) => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const r of rs) { x0 = Math.min(x0, r.bounds[0]); x1 = Math.max(x1, r.bounds[2]); y0 = Math.min(y0, r.bounds[1]); y1 = Math.max(y1, r.bounds[3]); } return [x0, y0, x1, y1]; };
    const ba = box(A), bb = box(B), axis = ((ba[0] + ba[2]) / 2 + (bb[0] + bb[2]) / 2) / 2;
    const size = Math.max(ba[2] - ba[0], ba[3] - ba[1], 1);
    const cands = [];
    for (const ra of A) for (const rb of B) {
      const m = [2 * axis - ra.centroid[0], ra.centroid[1]];
      const cost = Math.hypot(m[0] - rb.centroid[0], m[1] - rb.centroid[1]) / size + deltaE(rgbToLab(...ra.color), rgbToLab(...rb.color)) / 50 + Math.abs(Math.log(ra.area / rb.area)) * 0.5;
      if (cost < 1) cands.push({ ra, rb, cost });
    }
    cands.sort((x, y) => x.cost - y.cost || x.ra.id - y.ra.id || x.rb.id - y.rb.id);
    const palette = [...new Map(T.regions.map((r) => [r.sourceColor, rgbToLab(...r.color)])).values()];
    const used = new Set();
    for (const { ra, rb } of cands) {
      if (used.has(ra.id) || used.has(rb.id)) continue;
      used.add(ra.id); used.add(rb.id);
      const la = rgbToLab(...ra.color), lb = rgbToLab(...rb.color), mean = la.map((v, i) => (v + lb[i]) / 2);
      out.beforeDE += deltaE(la, lb);
      for (const [r, l] of [[ra, la], [rb, lb]]) {
        let nl = l.map((v, i) => v + (mean[i] - v) * strength);
        // stay on the cleaned palette: snap to an existing fill if one is perceptually identical
        let best = null, bd = 5;
        for (const p of palette) { const d = deltaE(p, nl); if (d < bd) { bd = d; best = p; } }
        if (best && !r.gradient) nl = best;
        r.color = labToRgb(nl); r.sourceColor = hex(r.color);
        if (r.gradient) for (const k of ['lab0', 'lab1']) { r.gradient[k] = r.gradient[k].map((v, i) => v + (mean[i] - l[i]) * strength); }
        if (r.gradient) { r.gradient.c0 = labToRgb(r.gradient.lab0); r.gradient.c1 = labToRgb(r.gradient.lab1); }
      }
      out.afterDE += deltaE(rgbToLab(...ra.color), rgbToLab(...rb.color));
      out.pairs++;
    }
  }
  if (out.pairs) { out.beforeDE /= out.pairs; out.afterDE /= out.pairs; }
  return out;
}
