// Pure geometry helpers for the procedural compiler. Points are [x, y] arrays in canvas space.
// Nothing here knows about ARU, scenes or rendering.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const len = (a) => Math.hypot(a[0], a[1]);
export const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const perp = (a) => [-a[1], a[0]];
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
export const rot = (a, deg) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [a[0] * c - a[1] * s, a[0] * s + a[1] * c]; };
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- deterministic randomness ----------
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// mulberry32: tiny seeded PRNG; same seed -> same sequence
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// value or {range:[lo,hi]} -> number
export const pick = (v, r, dflt) => (v && v.range ? lerp(v.range[0], v.range[1], r()) : (typeof v === 'number' ? v : dflt));

// ---------- named directions ----------
const DIRS = {
  right: [1, 0], left: [-1, 0], down: [0, 1], bottom: [0, 1], up: [0, -1], top: [0, -1],
  'bottom-right': [1, 1], 'bottom-left': [-1, 1], 'top-right': [1, -1], 'top-left': [-1, -1],
  'down-right': [1, 1], 'down-left': [-1, 1], 'up-right': [1, -1], 'up-left': [-1, -1],
};
export function dirVector(v) {
  if (typeof v === 'number') return rot([1, 0], v);
  const d = DIRS[v];
  return d ? norm(d) : null;
}

// ---------- polygons ----------
export function area(poly) { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
export function centroid(poly) {
  let x = 0, y = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], c = p[0] * q[1] - q[0] * p[1];
    a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-9) { const m = poly.reduce((s, p) => add(s, p), [0, 0]); return mul(m, 1 / Math.max(1, poly.length)); }
  return [x / (3 * a), y / (3 * a)];
}
export function bbox(poly) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of poly) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
}
export function inside(poly, [x, y]) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}
// Sutherland–Hodgman against one half-plane: keep points p with dot(p - origin, n) >= 0
export function clipHalfPlane(poly, origin, n) {
  const out = [], f = (p) => dot(sub(p, origin), n);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) out.push(lerp2(a, b, fa / (fa - fb)));
  }
  return out;
}

// ---------- curves ----------
// A boundary is a list of cubic segments {p0, c1, c2, p1, line}. `anchorSeg[i]` = segment that starts at anchor i.
export function interpolate(points, { closed = true, mode = 'smooth', sharp = new Set(), tension = 1, r = Math.random, bulge = 0.06, noise = 0.08 } = {}) {
  let pts = points.map((p) => [...p]);
  let anchorAt = pts.map((_, i) => i);
  if (mode === 'angular' || mode === 'organic') {
    // insert one extra vertex per edge: pushed outward (angular facets) or jittered (organic wobble)
    const c = centroid(pts), dense = [], at = [];
    const nEdges = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < pts.length; i++) {
      at.push(dense.length); dense.push(pts[i]);
      if (i >= nEdges) continue;
      const a = pts[i], b = pts[(i + 1) % pts.length], m = lerp2(a, b, 0.5), L = len(sub(b, a));
      let n = norm(perp(sub(b, a))); if (dot(n, sub(m, c)) < 0) n = mul(n, -1);
      const k = mode === 'angular' ? bulge * (0.6 + r() * 0.8) : (r() - 0.35) * noise * 2;
      dense.push(add(lerp2(a, b, 0.5 + (r() - 0.5) * 0.2), mul(n, k * L)));
    }
    pts = dense; anchorAt = at;
    if (mode === 'angular') { // straight facets
      const segs = linear(pts, closed);
      return { segs, anchorSeg: anchorAt };
    }
    sharp = new Set([...sharp].map((i) => anchorAt[i]));
  }
  if (mode === 'linear') return { segs: linear(pts, closed), anchorSeg: anchorAt };
  // Catmull-Rom -> cubic Bézier: the LLM gives points, the engine invents the control points
  const n = pts.length, segs = [], t = tension / 6;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n];
    const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(i - 1, 0)];
    const next = closed ? pts[(i + 2) % n] : pts[Math.min(i + 2, n - 1)];
    const c1 = sharp.has(i) ? lerp2(p0, p1, 1 / 3) : add(p0, mul(sub(p1, prev), t));
    const c2 = sharp.has((i + 1) % n) ? lerp2(p0, p1, 2 / 3) : sub(p1, mul(sub(next, p0), t));
    segs.push({ p0, c1, c2, p1, line: false });
  }
  return { segs, anchorSeg: anchorAt };
}
function linear(pts, closed) {
  const segs = [], n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) { const p0 = pts[i], p1 = pts[(i + 1) % n]; segs.push({ p0, c1: lerp2(p0, p1, 1 / 3), c2: lerp2(p0, p1, 2 / 3), p1, line: true }); }
  return segs;
}
export function cubicAt(s, t) {
  const u = 1 - t;
  return [
    u * u * u * s.p0[0] + 3 * u * u * t * s.c1[0] + 3 * u * t * t * s.c2[0] + t * t * t * s.p1[0],
    u * u * u * s.p0[1] + 3 * u * u * t * s.c1[1] + 3 * u * t * t * s.c2[1] + t * t * t * s.p1[1],
  ];
}
export function flatten(segs, steps = 10) {
  const out = [];
  for (const s of segs) { const k = s.line ? 1 : steps; for (let i = 0; i < k; i++) out.push(cubicAt(s, i / k)); }
  if (segs.length) out.push(segs[segs.length - 1].p1);
  return out;
}
// polyline with cumulative arc length, sampled by fraction 0..1
export function measure(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = cum[cum.length - 1] || 1;
  const at = (f) => {
    const d = clamp(f, 0, 1) * total;
    let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    return lerp2(pts[i - 1], pts[i], (d - cum[i - 1]) / seg);
  };
  const tangent = (f) => norm(sub(at(Math.min(1, f + 0.01)), at(Math.max(0, f - 0.01))));
  return { at, tangent, total };
}
export function segsToCommands(segs, closed) {
  if (!segs.length) return [];
  const r = (v) => Math.round(v * 100) / 100;
  const cmds = [{ cmd: 'move', args: segs[0].p0.map(r) }];
  for (const s of segs) cmds.push(s.line ? { cmd: 'line', args: s.p1.map(r) } : { cmd: 'curve', args: [...s.c1, ...s.c2, ...s.p1].map(r) });
  if (closed) cmds.push({ cmd: 'close', args: [] });
  return cmds;
}
export const lineSegs = (pts) => pts.slice(0, -1).map((p, i) => ({ p0: p, c1: lerp2(p, pts[i + 1], 1 / 3), c2: lerp2(p, pts[i + 1], 2 / 3), p1: pts[i + 1], line: true }));
export const roundPts = (pts) => pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);

// ---------- colors ----------
export function parseHex(c) {
  let h = String(c).replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase();
export function mixColor(a, b, t) { const A = parseHex(a), B = parseHex(b); if (!A || !B) return a; return toHex(A.map((v, i) => lerp(v, B[i], t))); }
export const shadeColor = (c, amt) => (amt >= 0 ? mixColor(c, '#FFFFFF', amt) : mixColor(c, '#000000', -amt));
