// Style evidence: does the REFERENCE boundary actually support the style a reviewer asked for?
//   edges = straight  ->  longLineShare: share of boundary length explained by long segments (>= 8 px) of a 1 px
//                         Douglas–Peucker polyline (faceted shapes: high; organic curves and zigzags: low); lineResidual
//   edges = curved    ->  cubicsPer100: Schneider pieces per 100 px at 1 px tolerance (smooth curves need few, zigzag many);
//                         curvatureConsistency from inflections per 100 px at a 3-sample scale
//   shape = circle    ->  residual / coverage / inlier ratio from the conic consensus (shapeSupport)
// Measured on the densified pixel boundary (lightly smoothed), never on the current vector.
// Decision (in section-polish): Vision proposes + VisualIntent suggests + Pixels measure.
import { densify, douglasPeucker, segDist } from './simplify.js';
import { taubin } from './edges.js';
import { fitCubic } from './bezier.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], len = (v) => Math.hypot(v[0], v[1]);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const norm = (v) => { const l = len(v) || 1; return [v[0] / l, v[1] / l]; };

export function styleEvidence(chains) {
  let length = 0, longLen = 0, lineSq = 0, cubics = 0, inflections = 0, counted = 0;
  for (const ch of chains) {
    const D = densify(ch);
    const island = ch.closed && !ch.atJunction;
    const pts = island ? D.slice(0, -1) : D;
    const n = pts.length;
    if (n < 6) continue;
    const sm = taubin(pts, new Set(island ? [] : [0, n - 1]), 3, island);
    const P = island ? [...sm, sm[0]] : sm;
    let L = 0; for (let i = 1; i < P.length; i++) L += len(sub(P[i], P[i - 1]));
    length += L;
    // straight: long segments of a 1 px DP polyline
    const keep = douglasPeucker(P, 1.0);
    for (let k = 1; k < keep.length; k++) {
      const a = P[keep[k - 1]], b = P[keep[k]], sl = len(sub(b, a));
      if (sl >= 8) longLen += sl;
      for (let i = keep[k - 1] + 1; i < keep[k]; i++) lineSq += segDist(P[i], a, b) ** 2;
    }
    // curved: Schneider pieces at 1 px BETWEEN persistent corners (an almond eye has two sharp tips, not wiggles)
    const cornersAt = [0];
    const ang = (i, k) => { if (i - k < 0 || i + k >= P.length) return 0; const v1 = sub(P[i], P[i - k]), v2 = sub(P[i + k], P[i]); return Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1])) * 180 / Math.PI; };
    for (let i = 4; i + 4 < P.length; i++) { const a = ang(i, 4); if (a > 55 && ang(i, 8) > 40 && a >= ang(i - 1, 4) && a > ang(i + 1, 4)) cornersAt.push(i); }
    cornersAt.push(P.length - 1);
    for (let k = 0; k + 1 < cornersAt.length; k++) {
      const a = cornersAt[k], b = cornersAt[k + 1]; if (b - a < 2) continue;
      const out = [], off = Math.min(2, b - a);
      fitCubic(P, a, b, norm(sub(P[a + off], P[a])), norm(sub(P[b - off], P[b])), 1.0, out, 0);
      cubics += out.length; counted++;
    }
    // inflections at a 6-sample scale (pixel stairs are not inflections)
    let prev = 0;
    for (let i = 6; i + 6 < P.length; i += 3) {
      const v1 = sub(P[i], P[i - 6]), v2 = sub(P[i + 6], P[i]);
      const a = Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]);
      if (Math.abs(a) > 0.1) { const sg = Math.sign(a); if (prev && sg !== prev) inflections++; prev = sg; }
    }
  }
  if (!length) return null;
  // pieces BEYOND one per chain (a short junction-to-junction chain always needs one)
  const longShare = longLen / length, cubicsPer100 = (Math.max(0, cubics - counted) / length) * 100, inflPer100 = (inflections / length) * 100;
  if (typeof process !== 'undefined' && process.env?.ARU_DEBUG_STYLE) console.log('STYLE', chains.length, 'len', Math.round(length), 'extraCubicsPer100', cubicsPer100.toFixed(2), 'inflPer100', inflPer100.toFixed(2), 'longShare', longShare.toFixed(2));
  return {
    straight: { longLineShare: +longShare.toFixed(2), lineResidual: +Math.sqrt(lineSq / Math.max(1, length)).toFixed(2), support: +clamp01((longShare - 0.25) / 0.5).toFixed(2) },
    curved: { cubicsPer100: +cubicsPer100.toFixed(2), inflectionsPer100: +inflPer100.toFixed(2), curvatureConsistency: +(1 / (1 + inflPer100 / 3)).toFixed(2), support: +(clamp01(1 - (cubicsPer100 - 1) / 4) * (1 / (1 + inflPer100 / 6))).toFixed(2) },
    length: Math.round(length),
  };
}

export function shapeSupport(cand) {
  if (!cand) return { support: 0, reason: 'no analytic candidate fits the pixels' };
  const s = clamp01((cand.coverage - 100) / 120) * clamp01(cand.inlierRatio / 0.5) * clamp01(2 - cand.rms / cand.tol);
  return { kind: cand.shape.kind, residual: +cand.rms.toFixed(2), coverage: Math.round(cand.coverage), inlierRatio: +cand.inlierRatio.toFixed(2), support: +s.toFixed(2) };
}

// visualIntent agreement: +1 agrees, 0 says nothing, -1 contradicts
export function intentAgreement(d, vi = {}) {
  const smooth = vi.edge === 'smooth' || vi.edge === 'analytic' || vi.geometry === 'circular' || vi.geometry === 'organic-clean';
  const sharp = vi.edge === 'sharp' || vi.geometry === 'geometric' || vi.geometry === 'angular';
  let a = 0;
  if (d.edges === 'straight') a = sharp ? 1 : smooth ? -1 : 0;
  if (d.edges === 'curved') a = smooth ? 1 : sharp ? -1 : 0;
  if (d.shape !== 'none') a = vi.geometry === 'circular' || vi.edge === 'analytic' ? 1 : vi.geometry && vi.geometry !== 'organic-clean' ? -1 : a;
  return a;
}
export const CONFIDENCE = { low: 0.3, medium: 0.6, high: 0.9 };
