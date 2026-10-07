// Perceptual Regularizer (edge level): turns measured pixel boundaries into the clean edges they probably were.
// Per shared chain (endpoints = junctions, never moved, so neighbouring regions still tile exactly):
//   1. corners: multi-scale turning angle on the measured polyline (fur spikes, ear tips, plane corners survive)
//   2. curvature regularization: Taubin λ/μ smoothing with corners + junctions pinned (removes the zig-zag of
//      pixels, JPEG blocks and anti-aliasing without shrinking the shape)
//   3. classification of every run between pinned points: straight | curve; closed islands may be ellipses
//   4. angle snapping to DOMINANT angles, only if the picture actually speaks a linear language
//   5. output: lines for straight runs, Schneider cubics on the regularized points for curves, analytic ellipses
import { densify, segDist } from './simplify.js';
import { fitCubic } from './bezier.js';

const lerp = (a, b, t) => a + (b - a) * t;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], len = (v) => Math.hypot(v[0], v[1]);
const norm = (v) => { const l = len(v) || 1; return [v[0] / l, v[1] / l]; };

export function edgeParams(A) {
  return { smoothIter: Math.round(lerp(4, 16, A)), cornerAngle: lerp(40, 60, A), cornerK: 4, lineTol: lerp(0.8, 2.0, A), curveTol: lerp(1.0, 2.4, A), ellipseTol: lerp(0.9, 1.8, A), snapDeg: lerp(2.5, 6, A) };
}

export function regularizeChains(chains, { abstraction = 0.5, intentFor = () => null, width = Infinity, height = Infinity } = {}) {
  const E = edgeParams(abstraction);
  const work = chains.map((c) => prepareChain(c, E, intentFor(c), width, height));
  // dominant angles from straight runs, weighted by length
  const hist = new Float64Array(180);
  let straightLen = 0, totalLen = 0;
  for (const w of work) {
    totalLen += w.length;
    const m = w.sm.length;
    for (const r of w.runs) if (r.straight) { const A = w.sm[r.a % m], B = w.sm[r.b % m]; const L = len(sub(B, A)); const ang = ((Math.atan2(B[1] - A[1], B[0] - A[0]) * 180 / Math.PI) % 180 + 180) % 180; hist[Math.round(ang) % 180] += L; straightLen += L; }
  }
  const smooth = new Float64Array(180);
  for (let i = 0; i < 180; i++) for (let k = -2; k <= 2; k++) smooth[i] += hist[(i + k + 180) % 180];
  const dominant = [];
  const linearLanguage = totalLen > 0 && straightLen / totalLen > 0.25;
  if (linearLanguage) for (let i = 0; i < 180; i++) if (smooth[i] >= 0.12 * straightLen && smooth[i] >= smooth[(i + 179) % 180] && smooth[i] > smooth[(i + 1) % 180]) dominant.push(i);
  const stats = { chains: chains.length, corners: 0, straight: 0, curves: 0, ellipses: 0, snapped: 0, linearLanguage, dominantAngles: dominant.slice(0, 4), straightShare: totalLen ? straightLen / totalLen : 0 };
  const simp = [], fits = [];
  for (const w of work) {
    if (dominant.length) stats.snapped += snapRuns(w, dominant.slice(0, 4), E.snapDeg);
    const f = emit(w, E);
    stats.corners += w.pinned.length; stats.straight += f.lines; stats.curves += f.beziers; if (f.ellipse) stats.ellipses++;
    simp.push({ dense: w.D, keep: w.keep, isLoop: w.island });
    fits.push(f);
  }
  return { simp, fits, stats };
}

function prepareChain(chain, E, intent, W, H) {
  let D = densify(chain);
  const island = chain.closed && !chain.atJunction;
  const pts = island ? D.slice(0, -1) : D.slice();
  const n = pts.length;
  // intent hints (validated by the pixels: they only move thresholds)
  let cornerAngle = E.cornerAngle, iters = E.smoothIter;
  if (intent?.edge === 'sharp' || intent?.geometry === 'geometric' || intent?.geometry === 'angular') { cornerAngle -= 10; iters = Math.round(iters * 0.7); }
  if (intent?.edge === 'smooth' || intent?.edge === 'analytic' || intent?.geometry === 'organic-clean' || intent?.geometry === 'circular') { cornerAngle += 12; iters = Math.round(iters * 1.3); }
  if (intent?.edge === 'irregular') iters = Math.round(iters * 0.5);
  // circular / analytic parts (irises, pupils, suns, round logos): only very sharp turns are corners
  if (intent?.edge === 'analytic' || intent?.geometry === 'circular') cornerAngle = Math.max(cornerAngle, 110);
  let length = 0; for (let i = 1; i < n; i++) length += len(sub(pts[i], pts[i - 1]));
  if (n < 4) return { D, island, sm: pts, n, pinned: [0, n - 1], runs: [{ a: 0, b: n - 1, straight: true }], keep: [0, n - 1], length, intent, free: new Set() };
  // 1. corners, measured on a lightly pre-smoothed copy and required to PERSIST across scales (k and 2k):
  //    an ear tip or fur spike is a corner at 4 px and at 8 px; a 2-4 px JPEG/pixel step is not.
  const pre = taubin(pts, new Set(island ? [] : [0, n - 1]), 2, island);
  const k = E.cornerK;
  const angleAt = (i, kk) => {
    if (!island && (i - kk < 0 || i + kk > n - 1)) return null;
    const p = pre[(((i - kk) % n) + n) % n], c = pre[i], q = pre[(i + kk) % n]; // kk can exceed n on tiny islands
    const v1 = sub(c, p), v2 = sub(q, c), l1 = len(v1), l2 = len(v2);
    if (!l1 || !l2) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))) * 180 / Math.PI;
  };
  const ang = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a4 = angleAt(i, k); if (a4 === null) continue;
    const a8 = angleAt(i, 2 * k);
    ang[i] = a8 === null ? a4 * 0.85 : Math.min(a4, a8 / 0.75); // must hold at the coarser scale too
  }
  const corners = [];
  for (let i = 0; i < n; i++) {
    if (ang[i] <= cornerAngle) continue;
    let isMax = true;
    for (let j = -k; j <= k && isMax; j++) { if (!j) continue; const jj = island ? (i + j + n) % n : i + j; if (jj < 0 || jj >= n) continue; if (ang[jj] > ang[i] || (ang[jj] === ang[i] && j < 0)) isMax = false; }
    if (isMax) corners.push(i);
  }
  const pinned = island ? corners : [...new Set([0, ...corners, n - 1])].sort((a, b) => a - b);
  const pinSet = new Set(pinned);
  // 2. Taubin smoothing (λ = 0.5, μ = -0.53), pinned points fixed
  const sm = taubin(pts, island ? pinSet : new Set([...pinSet, 0, n - 1]), iters, island);
  // 3. runs between pinned points
  const runs = [];
  if (island && !pinned.length) runs.push({ a: 0, b: n, closed: true });
  else {
    const P = island ? pinned : pinned;
    for (let j = 0; j + 1 < P.length; j++) runs.push({ a: P[j], b: P[j + 1] });
    if (island) runs.push({ a: P[P.length - 1], b: P[0] + n, wrap: true });
  }
  const at = (i) => sm[i % n];
  for (const r of runs) {
    if (r.closed) { r.straight = false; continue; }
    const A = at(r.a), B = at(r.b);
    let dmax = 0; for (let i = r.a + 1; i < r.b; i++) dmax = Math.max(dmax, segDist(at(i), A, B));
    r.straight = dmax <= E.lineTol;
  }
  // merge consecutive straight runs that are really one line (joint turns < 15° and the union stays straight)
  for (let j = 0; j + 1 < runs.length; j++) {
    const r1 = runs[j], r2 = runs[j + 1];
    if (!r1.straight || !r2.straight || r1.closed || r2.closed) continue;
    const A = at(r1.a), M = at(r1.b), B = at(r2.b);
    const v1 = sub(M, A), v2 = sub(B, M);
    const turn = Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1])) * 180 / Math.PI;
    let dmax = 0; for (let i = r1.a + 1; i < r2.b; i++) dmax = Math.max(dmax, segDist(at(i), A, B));
    if (turn < 15 && dmax <= E.lineTol) { runs.splice(j, 2, { a: r1.a, b: r2.b, straight: true, wrap: r2.wrap }); const idx = pinned.indexOf(r1.b % n); if (idx >= 0) pinned.splice(idx, 1); j--; }
  }
  // corners that may move: never junctions, never points on the image border (they are the canvas frame)
  const onBorder = (p) => p[0] <= 0.01 || p[1] <= 0.01 || p[0] >= W - 0.01 || p[1] >= H - 0.01;
  const free = new Set((island ? pinned : pinned.filter((i) => i !== 0 && i !== n - 1)).filter((i) => !onBorder(pts[i])));
  return { D, island, sm, n, pinned, runs, keep: island ? pinned : pinned, length, intent, free, at };
}

function snapRuns(w, dominant, snapDeg) {
  let snapped = 0;
  for (const r of w.runs) {
    if (!r.straight || r.closed) continue;
    const ia = r.a % w.n, ib = r.b % w.n, A = w.sm[ia], B = w.sm[ib], L = len(sub(B, A));
    if (L < 6) continue;
    const ang = Math.atan2(B[1] - A[1], B[0] - A[0]) * 180 / Math.PI;
    let target = null;
    for (const d of dominant) for (const cand of [d, d - 180, d + 180, d - 360]) if (Math.abs(ang - cand) <= snapDeg && (target === null || Math.abs(ang - cand) < Math.abs(ang - target))) target = cand;
    if (target === null || Math.abs(ang - target) < 0.2) continue;
    const t = target * Math.PI / 180, dir = [Math.cos(t), Math.sin(t)], maxMove = Math.min(2, 0.08 * L + 1);
    const fa = w.free.has(ia), fb = w.free.has(ib);
    if (fb && !fa) { const nb = [A[0] + dir[0] * L, A[1] + dir[1] * L]; if (len(sub(nb, B)) <= maxMove) { w.sm[ib] = nb; snapped++; } }
    else if (fa && !fb) { const na = [B[0] - dir[0] * L, B[1] - dir[1] * L]; if (len(sub(na, A)) <= maxMove) { w.sm[ia] = na; snapped++; } }
    else if (fa && fb) { const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]; const na = [m[0] - dir[0] * L / 2, m[1] - dir[1] * L / 2], nb = [m[0] + dir[0] * L / 2, m[1] + dir[1] * L / 2]; if (len(sub(na, A)) <= maxMove) { w.sm[ia] = na; w.sm[ib] = nb; snapped++; } }
  }
  return snapped;
}

function emit(w, E) {
  const segs = [];
  let beziers = 0, lines = 0, ellipse = false;
  // very short chains are tiny junction-to-junction joints: one straight segment (islands keep their points)
  if (w.n < 4) { const p = w.sm; return w.island ? { start: p[0], segs: [...p.slice(1), p[0]].map((q) => ({ t: 'L', p: q })), beziers: 0, lines: p.length, corners: 0 } : { start: p[0], segs: [{ t: 'L', p: p[p.length - 1] }], beziers: 0, lines: 1, corners: 0 }; }
  // closed island without corners: try an analytic ellipse (pupils, irises, suns, dots)
  if (w.island && w.runs.length === 1 && w.runs[0].closed && w.intent?.geometry !== 'geometric') {
    const e = fitEllipse(w.sm, E.ellipseTol);
    if (e) return { ...ellipseSegs(e, signedArea(w.D) < 0), beziers: 4, lines: 0, corners: 0, ellipse: true };
  }
  const n = w.n, at = (i) => w.sm[i % n];
  const start = at(w.runs[0].a);
  for (const r of w.runs) {
    const end = r.closed ? at(0) : at(r.b);
    if (r.straight) { segs.push({ t: 'L', p: end }); lines++; continue; }
    const pts = []; for (let i = r.a; i <= (r.closed ? n : r.b); i++) pts.push(at(i));
    if (pts.length < 3) { segs.push({ t: 'L', p: end }); lines++; continue; }
    const off = Math.max(1, Math.min(3, Math.floor((pts.length - 1) / 3)));
    let t1 = norm(sub(pts[off], pts[0])), t2 = norm(sub(pts[pts.length - 1 - off], pts[pts.length - 1]));
    if (r.closed) { t1 = norm(sub(pts[1], pts[pts.length - 2])); t2 = [-t1[0], -t1[1]]; }
    // circular intent: if the run is (validated) an arc, fit the cubic to the points projected on that circle
    let fitPts = pts;
    if ((w.intent?.geometry === 'circular' || w.intent?.edge === 'analytic') && pts.length >= 8) {
      const c = fitCircle(pts);
      if (c && c.rms <= E.ellipseTol && c.r > 2) fitPts = pts.map((p, i) => (i === 0 || i === pts.length - 1 ? p : [c.cx + (p[0] - c.cx) * c.r / Math.hypot(p[0] - c.cx, p[1] - c.cy), c.cy + (p[1] - c.cy) * c.r / Math.hypot(p[0] - c.cx, p[1] - c.cy)]));
    }
    const out = [];
    fitCubic(fitPts, 0, fitPts.length - 1, t1, t2, E.curveTol, out, 0);
    for (const c of out) segs.push({ t: 'C', c1: c[1], c2: c[2], p: c[3] });
    beziers += out.length;
  }
  return { start, segs, beziers, lines, corners: w.pinned.length, ellipse };
}

export function signedArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
export function fitEllipse(pts, tol) {
  const n = pts.length; if (n < 12) return null;
  let cx = 0, cy = 0; for (const p of pts) { cx += p[0]; cy += p[1]; } cx /= n; cy /= n;
  let sxx = 0, syy = 0, sxy = 0; for (const p of pts) { const dx = p[0] - cx, dy = p[1] - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const a = Math.sqrt(2 * l1), b = Math.sqrt(2 * Math.max(l2, 1e-6));
  if (b < 1.5 || a / b > 6) return null;
  const c = Math.cos(theta), s = Math.sin(theta);
  let se = 0, me = 0;
  for (const p of pts) {
    const dx = p[0] - cx, dy = p[1] - cy, u = (dx * c + dy * s) / a, v = (-dx * s + dy * c) / b;
    const e = Math.abs(Math.hypot(u, v) - 1) * Math.min(a, b); se += e * e; me = Math.max(me, e);
  }
  const rms = Math.sqrt(se / n);
  return rms <= tol && me <= 2.5 * tol ? { cx, cy, a, b, theta } : null;
}
export function ellipseSegs({ cx, cy, a, b, theta }, reverse) {
  const k = 0.5523, c = Math.cos(theta), s = Math.sin(theta);
  const P = (x, y) => [cx + x * c - y * s, cy + x * s + y * c];
  let quads = [
    [[a, 0], [a, k * b], [k * a, b], [0, b]], [[0, b], [-k * a, b], [-a, k * b], [-a, 0]],
    [[-a, 0], [-a, -k * b], [-k * a, -b], [0, -b]], [[0, -b], [k * a, -b], [a, -k * b], [a, 0]],
  ];
  if (reverse) quads = quads.reverse().map((q) => [q[3], q[2], q[1], q[0]]);
  return { start: P(...quads[0][0]), segs: quads.map((q) => ({ t: 'C', c1: P(...q[1]), c2: P(...q[2]), p: P(...q[3]) })) };
}

export function taubin(pts, pinned, iters, cyclic) {
  const n = pts.length;
  let sm = pts.map((p) => [...p]);
  for (let it = 0; it < iters; it++) for (const f of [0.5, -0.53]) {
    const nx = sm.map((p) => [...p]);
    for (let i = 0; i < n; i++) {
      if (pinned.has(i)) continue;
      if (!cyclic && (i === 0 || i === n - 1)) continue;
      const a = sm[(i - 1 + n) % n], b = sm[(i + 1) % n];
      nx[i] = [sm[i][0] + f * ((a[0] + b[0]) / 2 - sm[i][0]), sm[i][1] + f * ((a[1] + b[1]) / 2 - sm[i][1])];
    }
    sm = nx;
  }
  return sm;
}

// algebraic (Kåsa) circle fit
export function fitCircle(pts) {
  const n = pts.length; let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z; }
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], b = [sxz, syz, sz];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A); if (Math.abs(D) < 1e-9) return null;
  const sol = [0, 1, 2].map((k) => det(A.map((row, r) => row.map((v, c) => (c === k ? b[r] : v)))) / D);
  const cx = sol[0] / 2, cy = sol[1] / 2, r = Math.sqrt(Math.max(0, sol[2] + cx * cx + cy * cy));
  let se = 0; for (const [x, y] of pts) se += (Math.hypot(x - cx, y - cy) - r) ** 2;
  return { cx, cy, r, rms: Math.sqrt(se / n) };
}
