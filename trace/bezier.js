// Stage 6: Bézier fitting (Schneider, "An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems 1990).
// Per chain: the DP vertices whose turning angle exceeds `cornerAngle` are corners (kept sharp). Between two
// corners the DENSE points are fitted with cubic Béziers: chord-length parameters, least-squares control-point
// magnitudes along the end tangents, Newton–Raphson reparameterization, recursive split at the worst point.
// A run uses curves only if they need clearly fewer points than the DP polyline (3 per cubic vs 1 per line)
// and stay within `curveTolerance`; otherwise the DP lines are kept.
import { segDist } from './simplify.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], add = (a, b) => [a[0] + b[0], a[1] + b[1]], mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1], len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

export function fitChain(simp, { curveTolerance = 1.5, cornerAngle = 50, gain = 0.8 } = {}) {
  const { dense, keep } = simp;
  const corners = [keep[0]];
  for (let i = 1; i < keep.length - 1; i++) {
    const a = dense[keep[i - 1]], b = dense[keep[i]], c = dense[keep[i + 1]];
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(norm(sub(b, a)), norm(sub(c, b)))))) * 180 / Math.PI;
    if (turn > cornerAngle) corners.push(keep[i]);
  }
  corners.push(keep[keep.length - 1]);
  const segs = [];
  let beziers = 0, lines = 0;
  for (let k = 0; k + 1 < corners.length; k++) {
    const a = corners[k], b = corners[k + 1];
    const dpRun = keep.filter((i) => i > a && i <= b);
    let curves = null;
    if (b - a >= 4 && dpRun.length >= 2) {
      const off = Math.max(1, Math.min(4, Math.round((b - a) / 6)));
      const t1 = norm(sub(dense[a + off], dense[a])), t2 = norm(sub(dense[b - off], dense[b]));
      curves = [];
      fitCubic(dense, a, b, t1, t2, curveTolerance, curves, 0);
      if (3 * curves.length >= gain * dpRun.length) curves = null;
    }
    if (curves) { for (const c of curves) segs.push({ t: 'C', c1: c[1], c2: c[2], p: c[3] }); beziers += curves.length; }
    else for (const i of dpRun) { segs.push({ t: 'L', p: dense[i] }); lines++; }
  }
  return { start: dense[keep[0]], segs, beziers, lines, corners: corners.length };
}

export function fitCubic(d, first, last, t1, t2, err, out, depth) {
  const p0 = d[first], p3 = d[last];
  if (last - first === 1) { const dist = len(sub(p3, p0)) / 3; out.push([p0, add(p0, mul(t1, dist)), add(p3, mul(t2, dist)), p3]); return; }
  let u = chordLength(d, first, last);
  let bez = generate(d, first, last, u, t1, t2);
  let [maxErr, split] = maxError(d, first, last, bez, u);
  if (maxErr < err) { out.push(bez); return; }
  if (maxErr < err * 3) {
    for (let i = 0; i < 4; i++) {
      u = reparameterize(d, first, last, u, bez);
      bez = generate(d, first, last, u, t1, t2);
      [maxErr, split] = maxError(d, first, last, bez, u);
      if (maxErr < err) { out.push(bez); return; }
    }
  }
  if (depth > 14) { out.push(bez); return; }
  const tc = norm(sub(d[split - 1], d[split + 1]));
  fitCubic(d, first, split, t1, tc, err, out, depth + 1);
  fitCubic(d, split, last, mul(tc, -1), t2, err, out, depth + 1);
}
function chordLength(d, first, last) {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(d[i], d[i - 1])));
  const tot = u[u.length - 1] || 1;
  return u.map((v) => v / tot);
}
const B = [(t) => (1 - t) ** 3, (t) => 3 * t * (1 - t) ** 2, (t) => 3 * t * t * (1 - t), (t) => t ** 3];
export const bez = (b, t) => [0, 1].map((k) => B[0](t) * b[0][k] + B[1](t) * b[1][k] + B[2](t) * b[2][k] + B[3](t) * b[3][k]);
function generate(d, first, last, u, t1, t2) {
  const p0 = d[first], p3 = d[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const a1 = mul(t1, B[1](u[i])), a2 = mul(t2, B[2](u[i]));
    c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2);
    const tmp = sub(d[first + i], add(mul(p0, B[0](u[i]) + B[1](u[i])), mul(p3, B[2](u[i]) + B[3](u[i]))));
    x0 += dot(a1, tmp); x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let al = det ? (x0 * c11 - x1 * c01) / det : 0, ar = det ? (c00 * x1 - c01 * x0) / det : 0;
  const segLen = len(sub(p3, p0)), eps = 1e-6 * segLen;
  if (al < eps || ar < eps) al = ar = segLen / 3; // degenerate: fall back to a straight-ish cubic
  return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
}
function maxError(d, first, last, b, u) {
  let maxD = 0, split = Math.floor((first + last) / 2);
  for (let i = first + 1; i < last; i++) { const e = len(sub(bez(b, u[i - first]), d[i])); if (e >= maxD) { maxD = e; split = i; } }
  return [maxD, split];
}
function reparameterize(d, first, last, u, b) {
  const q1 = [0, 1, 2].map((i) => mul(sub(b[i + 1], b[i]), 3)), q2 = [0, 1].map((i) => mul(sub(q1[i + 1], q1[i]), 2));
  return u.map((t, k) => {
    const P = d[first + k], Q = bez(b, t);
    const Q1 = add(add(mul(q1[0], (1 - t) ** 2), mul(q1[1], 2 * t * (1 - t))), mul(q1[2], t * t));
    const Q2 = add(mul(q2[0], 1 - t), mul(q2[1], t));
    const num = dot(sub(Q, P), Q1), den = dot(Q1, Q1) + dot(sub(Q, P), Q2);
    const r = den ? t - num / den : t;
    return Math.max(0, Math.min(1, r));
  });
}

// distance from every dense point to the fitted output (curves flattened), for traceError
export function traceError(dense, fit) {
  const poly = [fit.start];
  let cur = fit.start;
  for (const s of fit.segs) {
    if (s.t === 'L') poly.push(s.p);
    else { const b = [cur, s.c1, s.c2, s.p]; for (let i = 1; i <= 12; i++) poly.push(bez(b, i / 12)); }
    cur = s.p;
  }
  // exhaustive nearest-segment search (a windowed search mis-measured closed loops that wrap around)
  let max = 0, sum = 0;
  for (const p of dense) {
    let best = Infinity;
    for (let k = 0; k < poly.length - 1; k++) { const dd = segDist(p, poly[k], poly[k + 1]); if (dd < best) best = dd; }
    max = Math.max(max, best); sum += best;
  }
  return { max, sum, n: dense.length };
}
