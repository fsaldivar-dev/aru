// Analytic shapes from PARTIAL, MULTI-CHAIN evidence: circles and ellipses.
// An iris cut by the eyelid is still an ellipse; a sun split in three by the wolf is still one circle.
//
//   samples (boundary points grouped by chain)
//   -> deterministic candidates (each chain, chain pairs, windows, all points, circumcircles at fixed strides)
//   -> circle (Kåsa) and ellipse (direct least squares, Halir & Flusser 1998) per candidate
//   -> inliers over ALL samples (true point-to-ellipse distance), refine on inliers
//   -> measures: inlier ratio, visible arc coverage, RMS residual
//   -> accept / reject; prefer the circle unless the ellipse is clearly better (Occam)
// No randomness: every candidate comes from fixed strides over the input order.

const hyp = Math.hypot;

export function fitCircle(pts) {
  const n = pts.length; if (n < 3) return null;
  let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) { const u = p[0] - mx, v = p[1] - my; suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
  const det = suu * svv - suv * suv; if (Math.abs(det) < 1e-9) return null;
  const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
  const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
  return { kind: 'circle', cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

// Direct least-squares ellipse (Fitzgibbon, numerically stable form of Halir & Flusser). Coordinates are centered
// and scaled first. Returns { kind:'ellipse', cx, cy, a, b, theta } or null.
export function fitEllipse(pts) {
  const n = pts.length; if (n < 6) return null;
  let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= n; my /= n;
  let s = 0; for (const p of pts) s += hyp(p[0] - mx, p[1] - my); s = s / n || 1;
  const S1 = [0, 0, 0, 0, 0, 0, 0, 0, 0], S2 = [0, 0, 0, 0, 0, 0, 0, 0, 0], S3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const x = (p[0] - mx) / s, y = (p[1] - my) / s, d1 = [x * x, x * y, y * y], d2 = [x, y, 1];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { S1[i * 3 + j] += d1[i] * d1[j]; S2[i * 3 + j] += d1[i] * d2[j]; S3[i * 3 + j] += d2[i] * d2[j]; }
  }
  const S3i = inv3(S3); if (!S3i) return null;
  // T = -S3^-1 S2^T ; M = S1 + S2 T
  const S2T = tr3(S2), Tm = mul3(S3i, S2T).map((v) => -v), M = add3(S1, mul3(S2, Tm));
  // premultiply by C1^-1: rows [M2/2, -M1, M0/2]
  const Mp = [M[6] / 2, M[7] / 2, M[8] / 2, -M[3], -M[4], -M[5], M[0] / 2, M[1] / 2, M[2] / 2];
  let best = null;
  for (const lam of eig3(Mp)) {
    const v = nullVec(Mp, lam); if (!v) continue;
    const cond = 4 * v[0] * v[2] - v[1] * v[1];
    if (cond > 0 && (!best || cond > best.cond)) best = { v, cond };
  }
  if (!best) return null;
  const a1 = best.v, a2 = [0, 1, 2].map((i) => Tm[i * 3] * a1[0] + Tm[i * 3 + 1] * a1[1] + Tm[i * 3 + 2] * a1[2]);
  const [A, B, C] = a1, [D, E, F] = a2;
  const den = B * B - 4 * A * C; if (den >= 0) return null;
  const x0 = (2 * C * D - B * E) / den, y0 = (2 * A * E - B * D) / den;
  const F0 = A * x0 * x0 + B * x0 * y0 + C * y0 * y0 + D * x0 + E * y0 + F;
  // eigen-decomposition of [[A, B/2], [B/2, C]]
  const tr = A + C, dt = A * C - B * B / 4, disc = Math.sqrt(Math.max(0, tr * tr / 4 - dt));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  if (-F0 / l1 <= 0 || -F0 / l2 <= 0) return null;
  let ax1 = Math.sqrt(-F0 / l1), ax2 = Math.sqrt(-F0 / l2);
  let theta = Math.abs(B) < 1e-12 ? (A <= C ? 0 : Math.PI / 2) : Math.atan2(l1 - A, B / 2);
  // axis along theta belongs to eigenvalue l1; make `a` the major axis
  let a = ax1, b = ax2;
  if (a < b) { [a, b] = [b, a]; theta += Math.PI / 2; }
  return { kind: 'ellipse', cx: mx + s * x0, cy: my + s * y0, a: s * a, b: s * b, theta: normAngle(theta) };
}
const normAngle = (t) => { t %= Math.PI; return t < 0 ? t + Math.PI : t; };

// distance from p to the shape, the closest point, and the angular parameter (for coverage)
export function shapeDistance(sh, p) {
  if (sh.kind === 'circle') {
    const dx = p[0] - sh.cx, dy = p[1] - sh.cy, l = hyp(dx, dy) || 1e-9;
    return { d: Math.abs(l - sh.r), q: [sh.cx + dx * sh.r / l, sh.cy + dy * sh.r / l], t: Math.atan2(dy, dx) };
  }
  const c = Math.cos(sh.theta), s = Math.sin(sh.theta), dx = p[0] - sh.cx, dy = p[1] - sh.cy;
  const u = dx * c + dy * s, v = -dx * s + dy * c, a = sh.a, b = sh.b;
  // Newton on f(t) = (a²-b²) sin t cos t - u a sin t + v b cos t
  let t = Math.atan2(a * v, b * u);
  for (let k = 0; k < 8; k++) {
    const st = Math.sin(t), ct = Math.cos(t);
    const f = (a * a - b * b) * st * ct - u * a * st + v * b * ct;
    const fp = (a * a - b * b) * (ct * ct - st * st) - u * a * ct - v * b * st;
    if (Math.abs(fp) < 1e-12) break;
    const nt = t - f / fp; if (Math.abs(nt - t) < 1e-9) { t = nt; break; } t = nt;
  }
  const qu = a * Math.cos(t), qv = b * Math.sin(t);
  return { d: hyp(u - qu, v - qv), q: [sh.cx + qu * c - qv * s, sh.cy + qu * s + qv * c], t };
}

// tolerance grows slowly with size (a big circle may wobble more in absolute pixels, same relative precision)
export const shapeTol = (sh, tol) => tol * Math.max(1, Math.sqrt((sh.kind === 'circle' ? sh.r : Math.sqrt(sh.a * sh.b)) / 40));

function circumcircle(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { kind: 'circle', cx, cy, r: hyp(a[0] - cx, a[1] - cy) };
}

// measure a candidate against a sample set
export function measureShape(sh, pts, tol) {
  const T = shapeTol(sh, tol);
  const inl = [], ts = [];
  let se = 0;
  for (const p of pts) { const m = shapeDistance(sh, p); if (m.d <= 1.5 * T) { inl.push(p); ts.push(m.t); se += m.d * m.d; } }
  ts.sort((x, y) => x - y);
  let gap = ts.length ? ts[0] + 2 * Math.PI - ts[ts.length - 1] : 2 * Math.PI;
  for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
  return { inliers: inl, inlierRatio: inl.length / Math.max(1, pts.length), coverage: (2 * Math.PI - gap) * 180 / Math.PI, rms: inl.length ? Math.sqrt(se / inl.length) : Infinity, tol: T };
}

// groups: arrays of boundary points (one per chain or per loop). Options: kinds, tol (px), maxSize (px), bbox [x0,y0,x1,y1]
export function consensusShape(groups, { kinds = ['circle', 'ellipse'], tol = 1, maxSize = Infinity, bbox = null, minCoverage = { circle: 120, ellipse: 160 }, prefer = null } = {}) {
  const all = groups.flat();
  const N = all.length;
  if (N < 16) return null;
  const step = Math.max(1, Math.floor(N / 600)), sample = all.filter((_, i) => i % step === 0);
  // deterministic candidate subsets
  const subsets = [all];
  const big = groups.filter((g) => g.length >= 8);
  for (const g of big) subsets.push(g);
  if (big.length <= 12) for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++) subsets.push(big[i].concat(big[j]));
  for (const g of big) if (g.length >= 24) { const w = Math.floor(g.length / 2); for (let o = 0; o + w <= g.length; o += Math.max(4, Math.floor(w / 2))) subsets.push(g.slice(o, o + w)); }
  const fits = [];
  for (const sub of subsets) for (const k of kinds) { const f = k === 'circle' ? fitCircle(sub) : fitEllipse(sub); if (f) fits.push(f); }
  if (kinds.includes('circle')) {
    const n = sample.length;
    for (let k = 0; k < 120; k++) { const a = (k * 7919) % n, b = (a + Math.floor(n / 3) + k * 31) % n, c = (a + Math.floor((2 * n) / 3) + k * 17) % n; const cc = circumcircle(sample[a], sample[b], sample[c]); if (cc) fits.push(cc); }
  }
  const size = (f) => (f.kind === 'circle' ? 2 * f.r : 2 * f.a);
  const sane = (f) => {
    if (!isFinite(f.cx) || !isFinite(f.cy)) return false;
    if (f.kind === 'circle' && (f.r < 2.5 || size(f) > maxSize)) return false;
    if (f.kind === 'ellipse' && (f.b < 2 || f.a / f.b > 4 || size(f) > maxSize)) return false;
    if (bbox) { const m = 0.6 * Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]); if (f.cx < bbox[0] - m || f.cx > bbox[2] + m || f.cy < bbox[1] - m || f.cy > bbox[3] + m) return false; }
    return true;
  };
  const bestOf = {};
  for (const f of fits) {
    if (!sane(f)) continue;
    const m = measureShape(f, sample, tol);
    const score = m.inliers.length - 0.1 * m.rms;
    if (!bestOf[f.kind] || score > bestOf[f.kind].score) bestOf[f.kind] = { f, score };
  }
  const results = {};
  for (const k of kinds) {
    if (!bestOf[k]) continue;
    let f = bestOf[k].f, m = measureShape(f, all, tol);
    for (let it = 0; it < 3; it++) {
      const g = k === 'circle' ? fitCircle(m.inliers) : fitEllipse(m.inliers);
      if (!g || !sane(g)) break;
      const m2 = measureShape(g, all, tol);
      if (m2.inliers.length < m.inliers.length) break;
      f = g; m = m2;
    }
    const ok = m.rms <= m.tol && m.coverage >= minCoverage[k] && m.inliers.length >= Math.max(16, 0.3 * N);
    results[k] = { shape: f, ...m, inliers: undefined, inlierCount: m.inliers.length, accepted: ok };
  }
  const c = results.circle?.accepted ? results.circle : null, e = results.ellipse?.accepted ? results.ellipse : null;
  let pick = null;
  if (c && e) pick = prefer === 'ellipse' || (e.rms < 0.75 * c.rms && e.inlierCount >= c.inlierCount) ? e : c;
  else pick = c || e;
  return { pick, candidates: results };
}

// ---- tiny 3x3 linear algebra ----
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}
const tr3 = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const add3 = (p, q) => p.map((v, i) => v + q[i]);
function mul3(p, q) { const o = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += p[i * 3 + k] * q[k * 3 + j]; return o; }
// real eigenvalues of a 3x3 matrix (characteristic cubic)
function eig3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const c2 = -(a + e + i), c1 = a * e + a * i + e * i - b * d - c * g - f * h, c0 = -(a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g));
  return cubicRoots(1, c2, c1, c0);
}
function cubicRoots(A, B, C, D) {
  const b = B / A, c = C / A, d = D / A, p = c - b * b / 3, q = 2 * b * b * b / 27 - b * c / 3 + d, disc = q * q / 4 + p * p * p / 27;
  if (disc > 1e-14) { const s = Math.sqrt(disc), u = Math.cbrt(-q / 2 + s), v = Math.cbrt(-q / 2 - s); return [u + v - b / 3]; }
  if (Math.abs(p) < 1e-14) return [-b / 3];
  const r = Math.sqrt(-p / 3), phi = Math.acos(Math.max(-1, Math.min(1, -q / (2 * r * r * r))));
  return [0, 1, 2].map((k) => 2 * r * Math.cos((phi - 2 * Math.PI * k) / 3) - b / 3);
}
function nullVec(m, lam) {
  const r = [[m[0] - lam, m[1], m[2]], [m[3], m[4] - lam, m[5]], [m[6], m[7], m[8] - lam]];
  const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  let best = null, bn = 0;
  for (const [x, y] of [[0, 1], [0, 2], [1, 2]]) { const v = cr(r[x], r[y]), n = hyp(...v); if (n > bn) { bn = n; best = v; } }
  return best && bn > 1e-12 ? best.map((v) => v / bn) : null;
}
