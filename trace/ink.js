// Ink mode: line art (dark contour lines over flat colors) is split into two layers.
//
//   1. INK  — the near-black pixels, vectorized at the source resolution as filled shapes with real thickness
//             (tapers kept). The outline is the 0.5 iso-contour of a field normalized between the ink level
//             and the LOCAL background, so the anti-aliasing gives sub-pixel edges: f = (L − Link) / (Lbg − Link).
//             Marching squares → Douglas–Peucker → the existing Schneider fit (bezier.js).
//   2. FILLS — the ink pixels are inpainted with the nearest non-ink color and the result is traced by the
//             normal guided tracer; the fills only need to be right where the ink does not cover them.
//
// The ink is drawn on top, one path per spatial cluster (≈ one character / object), inside a group "tinta".
// Deterministic: no randomness, scan-order queues, fixed tie-breaks.
import { labImage } from './quantize.js';
import { douglasPeucker } from './simplify.js';
import { fitChain } from './bezier.js';
import { normalizeImage } from './image.js';

const r2 = (v) => Math.round(v * 100) / 100;
const hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

// ------------------------------------------------------------------------------------------------- analysis
// ink level = 1st percentile of L*; core = pixels darker than ink level + `margin`
function inkLevel(lab, N) {
  const h = new Uint32Array(101);
  for (let i = 0; i < N; i++) h[Math.max(0, Math.min(100, Math.round(lab[i * 3])))]++;
  let acc = 0; for (let L = 0; L <= 100; L++) { acc += h[L]; if (acc >= 0.01 * N) return L; }
  return 100;
}
function dilate(mask, W, H, r) {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      out[i] = cur[i] || (x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1]) || (y > 0 && cur[i - W]) || (y < H - 1 && cur[i + W]) ? 1 : 0;
    }
    cur = out;
  }
  return cur;
}

// Is this image line art? Ink drawings are full of RIDGES — pixels darker than BOTH sides across some direction
// (a line) — while flat vector illustrations only have steps between regions. Measured (share of the non-white
// foreground): chibi sheet 13 %, watercolor manga 6 %, anime frame 1.4 %; wolf 0.3 %, city 0.03 %, icon sheet 0 %.
//   ridgeShare = ridge pixels (L* < 60, ≥ 25 darker than both sides at 1 or 2 px) / foreground pixels (L* < 97)
//   line art when ridgeShare ≥ 1 % (anime frame with a busy background: 1.4 %) and the darkest 1 % is really dark (inkL ≤ 30)
export function detectInk(raw, { maxSide = 1600, minRidgeShare = 0.01 } = {}) {
  const img = normalizeImage(raw, { maxSide }); // composites alpha over white: transparent pixels are not ink
  const W = img.width, H = img.height, N = W * H;
  const lab = labImage(img);
  const inkL = inkLevel(lab, N);
  const L = (x, y) => lab[(Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 3];
  let ridge = 0, fg = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = L(x, y); if (v < 97) fg++;
    if (v >= 60) continue;
    let hit = false;
    for (const [nx, ny] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      for (const o of [1, 2]) if (L(x + nx * o, y + ny * o) - v >= 25 && L(x - nx * o, y - ny * o) - v >= 25) { hit = true; break; }
      if (hit) break;
    }
    if (hit) ridge++;
  }
  const ridgeShare = fg ? ridge / fg : 0;
  return { isLineArt: inkL <= 30 && ridgeShare >= minRidgeShare, inkL, ridgeShare: Math.round(ridgeShare * 10000) / 10000 };
}

// ------------------------------------------------------------------------------------------------- iso-contours
// Marching squares on the pixel-center grid, padded by one "outside" pixel. Inside: f < 0.5.
// Each directed segment goes from an EXIT crossing to an ENTER crossing (walking the cell clockwise), which
// keeps the inside on the right: outer loops and holes get opposite orientations, so nonzero filling works.
// Saddles are resolved with the cell-center average.
export function isoLoops(f, W, H) {
  const Wp = W + 2, Hp = H + 2;
  const F = (x, y) => (x < 1 || y < 1 || x > W || y > H ? 1 : f[(y - 1) * W + (x - 1)]);
  const pts = new Map(), next = new Map();
  const hId = (x, y) => (y * Wp + x) * 2, vId = (x, y) => (y * Wp + x) * 2 + 1;
  const cross = (id, x0, y0, f0, x1, y1, f1) => {
    if (!pts.has(id)) { const t = (0.5 - f0) / (f1 - f0); pts.set(id, [x0 + (x1 - x0) * t - 0.5, y0 + (y1 - y0) * t - 0.5]); }
    return id;
  };
  for (let y = 0; y < Hp - 1; y++) for (let x = 0; x < Wp - 1; x++) {
    const a = F(x, y), b = F(x + 1, y), c = F(x + 1, y + 1), d = F(x, y + 1);
    const ia = a < 0.5, ib = b < 0.5, ic = c < 0.5, id = d < 0.5;
    if (ia === ib && ib === ic && ic === id) continue;
    // clockwise: T (a→b), R (b→c), B (c→d), L (d→a)
    const edges = [[ia, ib, () => cross(hId(x, y), x, y, a, x + 1, y, b)], [ib, ic, () => cross(vId(x + 1, y), x + 1, y, b, x + 1, y + 1, c)], [ic, id, () => cross(hId(x, y + 1), x + 1, y + 1, c, x, y + 1, d)], [id, ia, () => cross(vId(x, y), x, y + 1, d, x, y, a)]];
    const xs = []; for (const [p, q, mk] of edges) if (p !== q) xs.push({ exit: p, id: mk() });
    if (xs.length === 2) { const e = xs[0].exit ? 0 : 1; next.set(xs[e].id, xs[1 - e].id); }
    else { // saddle: 4 crossings alternating exit/enter
      const centerIn = (a + b + c + d) / 4 < 0.5;
      for (let k = 0; k < 4; k++) if (xs[k].exit) next.set(xs[k].id, xs[(k + (centerIn ? 1 : 3)) % 4].id);
    }
  }
  const loops = [], seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = []; let cur = start;
    while (cur !== undefined && !seen.has(cur)) { seen.add(cur); loop.push(pts.get(cur)); cur = next.get(cur); }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}
const signedArea = (p) => { let s = 0; for (let i = 0, n = p.length; i < n; i++) { const a = p[i], b = p[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const bbox = (p) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of p) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// closed loop -> fitted segments (start at the sharpest point so the forced corner falls on a real corner)
function smoothLoop(p, iters) { // Taubin λ|μ on a closed loop: removes pixel wiggle without shrinking thin strokes
  let a = p;
  for (let it = 0; it < iters; it++) for (const w of [0.5, -0.53]) {
    const n = a.length, b = new Array(n);
    for (let i = 0; i < n; i++) { const u = a[(i - 1 + n) % n], c = a[i], v = a[(i + 1) % n]; b[i] = [c[0] + w * ((u[0] + v[0]) / 2 - c[0]), c[1] + w * ((u[1] + v[1]) / 2 - c[1])]; }
    a = b;
  }
  return a;
}
export function fitLoop(loop0, { eps, tol, cornerAngle, smooth, gain }) {
  const loop = smooth ? smoothLoop(loop0, smooth) : loop0;
  const n = loop.length, k = Math.min(3, Math.floor(n / 3));
  let best = 0, bestTurn = -1;
  for (let i = 0; i < n; i++) {
    const p = loop[(i - k + n) % n], c = loop[i], q = loop[(i + k) % n];
    const v1 = [c[0] - p[0], c[1] - p[1]], v2 = [q[0] - c[0], q[1] - c[1]];
    const l = Math.hypot(...v1) * Math.hypot(...v2); if (!l) continue;
    const turn = Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / l)));
    if (turn > bestTurn + 1e-9) { bestTurn = turn; best = i; }
  }
  const dense = [...loop.slice(best), ...loop.slice(0, best)]; dense.push(dense[0]);
  let far = 1, fd = -1;
  for (let i = 1; i < dense.length - 1; i++) { const d = Math.hypot(dense[i][0] - dense[0][0], dense[i][1] - dense[0][1]); if (d > fd) { fd = d; far = i; } }
  const keep = [...douglasPeucker(dense, eps, 0, far), ...douglasPeucker(dense, eps, far, dense.length - 1).slice(1)];
  return fitChain({ dense, keep }, { curveTolerance: tol, cornerAngle, gain });
}

// ------------------------------------------------------------------------------------------------- rasterizer (metrics)
// nonzero scanline fill of flattened loops at pixel centers
export function rasterLoops(loops, W, H) {
  const out = new Uint8Array(W * H), edges = [];
  for (const p of loops) for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length]; if (a[1] === b[1]) continue;
    edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1], 1] : [b[0], b[1], a[0], a[1], -1]);
  }
  edges.sort((e, f) => e[1] - f[1]);
  for (let y = 0; y < H; y++) {
    const cy = y + 0.5, xs = [];
    for (const e of edges) { if (e[1] > cy) break; if (e[3] <= cy) continue; xs.push([e[0] + ((cy - e[1]) * (e[2] - e[0])) / (e[3] - e[1]), e[4]]); }
    xs.sort((a, b) => a[0] - b[0]);
    let w = 0;
    for (let k = 0; k + 1 < xs.length; k++) {
      w += xs[k][1]; if (!w) continue;
      for (let x = Math.max(0, Math.ceil(xs[k][0] - 0.5)); x < Math.min(W, Math.ceil(xs[k + 1][0] - 0.5)); x++) out[y * W + x] = 1;
    }
  }
  return out;
}
export function flatten(fit) {
  const pts = [fit.start]; let p = fit.start;
  for (const s of fit.segs) {
    if (s.t === 'L') pts.push(s.p);
    else for (let t = 1; t <= 8; t++) { const u = t / 8, v = 1 - u; pts.push([0, 1].map((k) => v * v * v * p[k] + 3 * v * v * u * s.c1[k] + 3 * v * u * u * s.c2[k] + u * u * u * s.p[k])); }
    p = s.p;
  }
  return pts;
}

// ------------------------------------------------------------------------------------------------- extraction
export function extractInk(raw, { maxSide = 1600, margin = 12, weakMargin = 55, ridge = 18, seedRidge = 30, seedLen = 8, halo = 2, minArea = 2, eps = 0.4, tol = 0.5, cornerAngle = 60, smooth = 2, gain = 1.5, faint = 0.85, speckSize = null, clusterGap = null } = {}) {
  const t0 = performance.now();
  const img = normalizeImage(raw, { maxSide });
  const W = img.width, H = img.height, N = W * H, k = 1 / img.scale; // k: ink pixels -> source pixels
  const lab = labImage(img);
  const inkL = inkLevel(lab, N);
  const core = new Uint8Array(N); for (let i = 0; i < N; i++) if (lab[i * 3] < inkL + margin) core[i] = 1;
  // hysteresis: faint, thin strokes (anti-aliased lines under 1 px never reach the ink level) join the ink when they
  // are a RIDGE — darker than both sides across some direction — and touch strong ink (8-connected).
  // Strong ridges (contrast ≥ seedRidge) at least `seedLen` px long are ink on their own: brown anime outlines and
  // isolated hatching never reach near-black, so they would otherwise need a black neighbour to survive.
  const L = (x, y) => lab[(Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 3];
  const weak = new Uint8Array(N), seed = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, v = lab[i * 3]; if (core[i] || v >= inkL + weakMargin) continue;
    let best = 0;
    for (const [nx, ny] of [[1, 0], [0, 1], [1, 1], [1, -1]]) for (const o of [1, 2]) best = Math.max(best, Math.min(L(x + nx * o, y + ny * o), L(x - nx * o, y - ny * o)) - v);
    if (best >= ridge) weak[i] = 1;
    if (best >= seedRidge) seed[i] = 1;
  }
  const strong = core.slice(), stack = [];
  { // keep seed components of at least seedLen pixels (8-connected)
    const seen = new Uint8Array(N);
    for (let s0 = 0; s0 < N; s0++) {
      if (!seed[s0] || seen[s0]) continue;
      const comp = [s0], st = [s0]; seen[s0] = 1;
      while (st.length) {
        const i = st.pop(), x = i % W, y = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx; if (seed[j] && !seen[j]) { seen[j] = 1; comp.push(j); st.push(j); }
        }
      }
      if (comp.length >= seedLen) for (const i of comp) strong[i] = 1;
    }
  }
  for (let i = 0; i < N; i++) if (strong[i]) stack.push(i);
  while (stack.length) {
    const i = stack.pop(), x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx; if (weak[j] && !strong[j]) { strong[j] = 1; stack.push(j); }
    }
  }
  const zone = dilate(strong, W, H, halo);
  // inpaint the zone with the nearest outside color (multi-source BFS, scan order)
  const fill = new Uint8ClampedArray(img.data), done = new Uint8Array(N), q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (!zone[i]) { done[i] = 1; const x = i % W, y = (i / W) | 0; if ((x > 0 && zone[i - 1]) || (x < W - 1 && zone[i + 1]) || (y > 0 && zone[i - W]) || (y < H - 1 && zone[i + W])) q[qt++] = i; }
  while (qh < qt) {
    const i = q[qh++], x = i % W, y = (i / W) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      if (j < 0 || done[j]) continue;
      done[j] = 1; fill[j * 4] = fill[i * 4]; fill[j * 4 + 1] = fill[i * 4 + 1]; fill[j * 4 + 2] = fill[i * 4 + 2]; q[qt++] = j;
    }
  }
  const inpainted = { width: W, height: H, data: fill };
  const bgLab = labImage(inpainted);
  // normalized field: 0 at the ink level, 1 at the local background
  const f = new Float32Array(N);
  // the zero of the field is the LOCAL darkest ink (3×3 min): a faint line is drawn at its half-maximum width
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!zone[i]) { f[i] = 1; continue; }
    let m = 100; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = Math.max(0, Math.min(H - 1, y + dy)) * W + Math.max(0, Math.min(W - 1, x + dx)); if (strong[j] && lab[j * 3] < m) m = lab[j * 3]; }
    // faint = 1: a faint line is drawn at its half-maximum width; < 1 draws it narrower (closer to its real amount of ink)
    const lo = m === 100 ? inkL : Math.min(inkL + (Math.max(inkL, m) - inkL) * faint, lab[i * 3]); // no ink in 3×3: plain ink level
    f[i] = Math.max(0, Math.min(1.5, (lab[i * 3] - lo) / Math.max(10, bgLab[i * 3] - lo)));
  }
  const tIso = performance.now();
  // loops, hierarchy (holes go with the smallest outer that contains them), tiny specks dropped
  // specks: tiny COMPACT islands or holes (watercolor noise where a dark wash crosses the threshold) are dropped;
  // short dashes survive because they are elongated
  const speck = speckSize ?? Math.max(3, 0.004 * Math.hypot(W, H));
  const isSpeck = (l) => Math.max(l.box[2] - l.box[0], l.box[3] - l.box[1]) < speck && Math.abs(l.area) > 0.3 * (l.box[2] - l.box[0]) * (l.box[3] - l.box[1]);
  const all = isoLoops(f, W, H).map((p) => ({ p, area: signedArea(p), box: bbox(p) }));
  const loops = all.filter((l) => Math.abs(l.area) >= minArea && !isSpeck(l));
  const outers = loops.filter((l) => l.area > 0).sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  const holes = loops.filter((l) => l.area < 0);
  for (const o of outers) o.holes = [];
  for (const h of holes) {
    let best = null;
    for (const o of outers) {
      if (o.box[0] > h.box[0] || o.box[1] > h.box[1] || o.box[2] < h.box[2] || o.box[3] < h.box[3]) continue;
      if ((!best || o.area < best.area) && inside(h.p[0], o.p)) best = o;
    }
    if (best) best.holes.push(h);
  }
  // clusters: connected components of the ink mask dilated by `gap` px (strokes closer than that belong together)
  const gap = clusterGap ?? Math.max(2, Math.round(0.004 * Math.hypot(W, H)));
  const inkMask = new Uint8Array(N); for (let i = 0; i < N; i++) if (f[i] < 0.5) inkMask[i] = 1;
  const grown = dilate(inkMask, W, H, gap), comp = new Int32Array(N).fill(-1);
  let nComp = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (!grown[s0] || comp[s0] >= 0) continue;
    const st = [s0]; comp[s0] = nComp;
    while (st.length) {
      const i = st.pop(), x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx; if (grown[j] && comp[j] < 0) { comp[j] = nComp; st.push(j); }
      }
    }
    nComp++;
  }
  const compOf = (loop) => { // a loop point lies on the iso-line: take the grown component at the nearest pixel
    const [px, py] = loop.p[0], x = Math.max(0, Math.min(W - 1, Math.round(px))), y = Math.max(0, Math.min(H - 1, Math.round(py)));
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && comp[yy * W + xx] >= 0) return comp[yy * W + xx]; }
    return -1;
  };
  const find = (i) => { const c = compOf(outers[i]); return c >= 0 ? `c${c}` : `o${i}`; };
  const clusters = new Map();
  outers.forEach((o, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(o); });
  // ink color: mean of each component's OWN darkest ink pixels (solid, f < 0.3, within 20 L* of the component's
  // minimum — edges and faint strokes would wash it out), snapped to the global ink color when close
  const minL = new Float32Array(nComp).fill(100); let gMin = 100;
  for (let i = 0; i < N; i++) if (f[i] < 0.3) { const c = comp[i], v = lab[i * 3]; if (v < gMin) gMin = v; if (c >= 0 && v < minL[c]) minL[c] = v; }
  const acc = new Float64Array(nComp * 4), tot = [0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    if (f[i] >= 0.3) continue;
    const c0 = comp[i], v0 = lab[i * 3];
    if (v0 > (c0 >= 0 ? minL[c0] : gMin) + 20) continue;
    const c = comp[i], r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    if (v0 <= gMin + 20) { tot[0] += r; tot[1] += g; tot[2] += b; tot[3]++; }
    if (c >= 0) { acc[c * 4] += r; acc[c * 4 + 1] += g; acc[c * 4 + 2] += b; acc[c * 4 + 3]++; }
  }
  const globalInk = tot[3] ? [tot[0] / tot[3], tot[1] / tot[3], tot[2] / tot[3]] : [17, 17, 17];
  const colorOf = (key) => { const c = key[0] === 'c' ? +key.slice(1) : -1; return c >= 0 && acc[c * 4 + 3] ? [acc[c * 4] / acc[c * 4 + 3], acc[c * 4 + 1] / acc[c * 4 + 3], acc[c * 4 + 2] / acc[c * 4 + 3]] : null; };
  const fitOpts = { eps, tol, cornerAngle, smooth, gain };
  const paths = [], flat = [];
  let points = 0, beziers = 0;
  for (const [key, group] of clusters) {
    const box = group.reduce((b, o) => [Math.min(b[0], o.box[0]), Math.min(b[1], o.box[1]), Math.max(b[2], o.box[2]), Math.max(b[3], o.box[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    const c = colorOf(key) || globalInk;
    const dE = Math.hypot(c[0] - globalInk[0], c[1] - globalInk[1], c[2] - globalInk[2]);
    const subpaths = [], units = [];
    for (const o of group) {
      const unit = { fits: [], samples: [] }; // one outer loop + its holes: they must stay in the same path (nonzero)
      for (const l of [o, ...o.holes]) {
        const fit = fitLoop(l.p, fitOpts);
        subpaths.push(fit); unit.fits.push(fit); flat.push(flatten(fit));
        points += 1 + fit.segs.reduce((s, g) => s + (g.t === 'C' ? 3 : 1), 0); beziers += fit.beziers;
      }
      // samples along the outer loop AND the holes (≤ 24 each, ink pixels): an outline's outer edge only touches the
      // backdrop, its inner edge (a hole of the ink) touches the subject it belongs to
      for (const l of [o, ...o.holes]) { const step = Math.max(1, Math.floor(l.p.length / 24)); for (let i = 0; i < l.p.length; i += step) unit.samples.push(l.p[i]); }
      units.push(unit);
    }
    paths.push({ box: box.map((v) => v * k), color: hex(dE < 24 ? globalInk : c), subpaths, units, area: group.reduce((s, o) => s + o.area - o.holes.reduce((t, h) => t - h.area, 0), 0) * k * k });
  }
  paths.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  // ink accuracy: rasterized fitted ink vs the field's ink pixels
  const ras = rasterLoops(flat, W, H);
  let inter = 0, uni = 0, nRas = 0, nField = 0;
  for (let i = 0; i < N; i++) { const a = ras[i], b = f[i] < 0.5; if (a) nRas++; if (b) nField++; if (a && b) inter++; if (a || b) uni++; }
  return {
    k, width: W, height: H, inpainted, paths, inkColor: hex(globalInk),
    stats: { inkL, loops: loops.length, specks: all.length - loops.length, outers: outers.length, holes: holes.length, clusters: paths.length, points, beziers, inkIoU: uni ? Math.round((inter / uni) * 1000) / 1000 : 1, inkPixels: uni, areaRatio: nField ? Math.round((nRas / nField) * 1000) / 1000 : 1, ms: Math.round(performance.now() - t0), isoMs: Math.round(performance.now() - tIso) },
  };
}

// fitted ink -> ARU text (group "tinta", one path per cluster); coordinates × scale (default: back to SOURCE pixels)
export function inkToAru(ink, { name = 'tinta', label = 'Tinta', scale = ink.k } = {}) {
  const k = scale, P = (p) => `${r2(p[0] * k)} ${r2(p[1] * k)}`;
  const lines = [`group ${name} {`, `    label "${label}"`];
  ink.paths.forEach((path, idx) => {
    const cmds = [];
    for (const fit of path.subpaths) {
      cmds.push(`move ${P(fit.start)}`);
      for (const s of fit.segs) cmds.push(s.t === 'L' ? `line ${P(s.p)}` : `curve ${P(s.c1)} ${P(s.c2)} ${P(s.p)}`);
      cmds.push('close');
    }
    lines.push(`    path ${name}_${idx + 1} { ${cmds.join('; ')}; fill ${path.color} }`);
  });
  lines.push('}');
  return lines.join('\n');
}

// the fitted ink as a pixel mask at the ink resolution (1 = ink)
export function inkRaster(ink) {
  const flat = []; for (const path of ink.paths) for (const fit of path.subpaths) flat.push(flatten(fit));
  return rasterLoops(flat, ink.width, ink.height);
}

// ink grouped by SEMANTIC part: partOf(samples in ink pixels) -> { name, label } per unit (outer + holes). Every unit
// keeps its color; one path per (part, color). The whole group stays on top of all fills.
export function inkToAruGrouped(ink, partOf, { name = 'tinta', label = 'Tinta', scale = ink.k } = {}) {
  const k = scale, P = (p) => `${r2(p[0] * k)} ${r2(p[1] * k)}`;
  const parts = new Map(); // part name -> { label, byColor: Map(color -> [fits]) }
  for (const path of ink.paths) for (const u of path.units) {
    const g = partOf(u.samples) || { name: 'otros', label: 'Otros' };
    if (!parts.has(g.name)) parts.set(g.name, { label: g.label, byColor: new Map() });
    const bc = parts.get(g.name).byColor;
    if (!bc.has(path.color)) bc.set(path.color, []);
    bc.get(path.color).push(...u.fits);
  }
  const lines = [`group ${name} {`, `    label "${label}"`];
  let n = 0;
  for (const [pname, g] of parts) {
    lines.push(`    group ${name}_${pname} {`, `        label "${String(g.label).replace(/"/g, "'")}"`);
    for (const [color, fits] of g.byColor) {
      const cmds = [];
      for (const fit of fits) { cmds.push(`move ${P(fit.start)}`); for (const s of fit.segs) cmds.push(s.t === 'L' ? `line ${P(s.p)}` : `curve ${P(s.c1)} ${P(s.c2)} ${P(s.p)}`); cmds.push('close'); }
      lines.push(`        path trazo_${++n} { ${cmds.join('; ')}; fill ${color} }`);
    }
    lines.push('    }');
  }
  lines.push('}');
  return lines.join('\n');
}

// Full ink-mode trace: ink layer at source resolution + fills traced on the inpainted image.
//   traceFills(inpaintedRaw) -> { aru, metrics, T } is supplied by the caller (guided tracer with its options),
//   so this module stays independent of the vision/context pipeline.
export function traceWithInk(raw, traceFills, inkOptions = {}) {
  const ink = extractInk(raw, inkOptions);
  // the fills see the inpainted image at the ink resolution; the guided tracer downsamples it as usual
  const inpaintedRaw = { width: ink.width, height: ink.height, data: ink.inpainted.data };
  const fills = traceFills(inpaintedRaw);
  // fills were compiled at the inpainted image's size: rescale to the source size if the ink was downsampled
  let aru = fills.aru;
  const s = ink.k;
  if (Math.abs(s - 1) > 1e-6) aru = wrapScaled(aru, s, raw.width, raw.height);
  aru = `${aru.trimEnd()}\n\n${inkToAru(ink)}\n`;
  return { aru, fills, ink, metrics: { ...fills.metrics, ink: ink.stats } };
}
// canvas line → source size; every top-level group scaled by s (fills are only top-level groups + gradients)
function wrapScaled(aru, s, W, H) {
  const out = []; let depth = 0;
  for (const line of aru.split('\n')) {
    if (depth === 0 && line.startsWith('canvas ')) { out.push(`canvas ${W} ${H}`); continue; }
    const opens = (line.match(/{/g) || []).length, closes = (line.match(/}/g) || []).length;
    out.push(line);
    if (depth === 0 && /^group\s/.test(line) && opens > closes) out.push(`    scale ${r2(s)}`);
    depth += opens - closes;
  }
  return out.join('\n');
}
