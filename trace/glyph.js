// Glyph icons (a subject as ONE flat colour with its interior lines cut out) — built, inspected and scored so that an
// AI can steer them to a professional result. The AI never draws: it reads the INSPECTION report and moves LEVERS;
// the tool rebuilds, measures again and keeps a change only if the ICON SCORE improves.
//
// Units: "icon px" = one pixel of the icon shown at 48 px (the size where icon defects show). At the 1024 px working
// raster, 1 icon px ≈ 21 px.
//
//   rawGlyph(fills, ink, sw, sh)   fills ∪ − ink, rasterized (≤ 1024 px)                 -> { mask, W, H, k }
//   buildGlyph(raw, params)        levers -> cleaned mask -> blurred iso-contour -> ONE compound path
//      openThin   (icon px)  removes protrusions thinner than this
//      closeCuts  (icon px)  closes cuts / gaps narrower than this
//      minFeature (icon px)  removes islands and fills holes smaller than minFeature² icon px²
//      smooth     (icon px)  fit tolerance: wobble / stair steps smaller than this go, corners stay sharp
//   inspect(built, raw)            specks, thin parts, thin cuts, roughness, saw-teeth, fidelity, score + markers
import { rasterLoops, isoLoops, fitLoop, flatten } from './ink.js';

export const GLYPH_DEFAULTS = { openThin: 0, closeCuts: 0, minFeature: 1.5, smooth: 0.25 };
export const GLYPH_LIMITS = { openThin: [0, 2], closeCuts: [0, 2], minFeature: [0, 4], smooth: [0, 1.5] };
export const normGlyphParams = (p = {}) => Object.fromEntries(Object.entries(GLYPH_DEFAULTS).map(([k, d]) => {
  const v = Number(p[k]); const [a, b] = GLYPH_LIMITS[k]; return [k, Number.isFinite(v) ? Math.round(Math.max(a, Math.min(b, v)) * 100) / 100 : d];
}));

// ------------------------------------------------------------------------------------------------- raster helpers
export function flattenCommands(commands, k = 1) {
  const loops = []; let cur = null, p = [0, 0], start = [0, 0];
  for (const { cmd, args } of commands) {
    if (cmd === 'move') { if (cur && cur.length > 2) loops.push(cur); p = [args[0] * k, args[1] * k]; start = p; cur = [p]; }
    else if (cmd === 'line') { p = [args[0] * k, args[1] * k]; cur?.push(p); }
    else if (cmd === 'curve') {
      const [c1x, c1y, c2x, c2y, x, y] = args.map((v) => v * k);
      for (let t = 1; t <= 10; t++) { const u = t / 10, v = 1 - u; cur?.push([v * v * v * p[0] + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * x, v * v * v * p[1] + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * y]); }
      p = [x, y];
    } else if (cmd === 'quad') {
      const [cx, cy, x, y] = args.map((v) => v * k);
      for (let t = 1; t <= 8; t++) { const u = t / 8, v = 1 - u; cur?.push([v * v * p[0] + 2 * v * u * cx + u * u * x, v * v * p[1] + 2 * v * u * cy + u * u * y]); }
      p = [x, y];
    } else if (cmd === 'close') { if (cur && cur.length > 2) loops.push(cur); cur = null; p = start; }
  }
  if (cur && cur.length > 2) loops.push(cur);
  return loops;
}
// each path is rasterized on its own (its holes stay holes) and the results are OR-ed
function unionMask(pathsCommands, W, H, k) {
  const m = new Uint8Array(W * H);
  for (const cmds of pathsCommands) { const r = rasterLoops(flattenCommands(cmds, k), W, H); for (let i = 0; i < m.length; i++) if (r[i]) m[i] = 1; }
  return m;
}
export function rawGlyph(fillPaths, inkPaths, sw, sh, { size = 1024 } = {}) {
  const k = size / Math.max(sw, sh), W = Math.max(1, Math.round(sw * k)), H = Math.max(1, Math.round(sh * k));
  const F = unionMask(fillPaths, W, H, k), I = unionMask(inkPaths, W, H, k), mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = F[i] && !I[i] ? 1 : 0;
  return { mask, W, H, k, iconPx: Math.max(W, H) / 48 };
}

// chamfer (3-4) distance to the nearest pixel where mask != value, in px
function distanceTo(mask, W, H, value) {
  const d = new Float32Array(W * H), INF = 1e9;
  for (let i = 0; i < W * H; i++) d[i] = mask[i] === value ? INF : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!d[i]) continue; let v = d[i];
    v = Math.min(v, x > 0 ? d[i - 1] + 3 : 3, y > 0 ? d[i - W] + 3 : 3);
    if (y > 0) { if (x > 0) v = Math.min(v, d[i - W - 1] + 4); if (x < W - 1) v = Math.min(v, d[i - W + 1] + 4); }
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; if (!d[i]) continue; let v = d[i];
    v = Math.min(v, x < W - 1 ? d[i + 1] + 3 : 3, y < H - 1 ? d[i + W] + 3 : 3);
    if (y < H - 1) { if (x < W - 1) v = Math.min(v, d[i + W + 1] + 4); if (x > 0) v = Math.min(v, d[i + W - 1] + 4); }
    d[i] = v;
  }
  for (let i = 0; i < W * H; i++) d[i] /= 3;
  return d;
}
const erode = (m, W, H, r) => { const d = distanceTo(m, W, H, 1); const o = new Uint8Array(W * H); for (let i = 0; i < o.length; i++) o[i] = m[i] && d[i] > r ? 1 : 0; return o; };
const dilate = (m, W, H, r) => { const d = distanceTo(m, W, H, 0); const o = new Uint8Array(W * H); for (let i = 0; i < o.length; i++) o[i] = m[i] || d[i] <= r ? 1 : 0; return o; };
const open = (m, W, H, r) => (r > 0 ? dilate(erode(m, W, H, r), W, H, r) : m);
const close = (m, W, H, r) => (r > 0 ? erode(dilate(m, W, H, r), W, H, r) : m);

// connected components of value v (8-connected for the glyph, 4 for the gaps); border-touching gaps are the outside
function components(m, W, H, v) {
  const lab = new Int32Array(W * H).fill(-1), comps = [];
  for (let s = 0; s < W * H; s++) {
    if (m[s] !== v || lab[s] >= 0) continue;
    const c = { n: 0, sx: 0, sy: 0, border: false, px: [] }, st = [s]; lab[s] = comps.length;
    while (st.length) {
      const t = st.pop(), x = t % W, y = (t / W) | 0;
      c.n++; c.sx += x; c.sy += y; c.px.push(t); if (x === 0 || y === 0 || x === W - 1 || y === H - 1) c.border = true;
      const nb = v ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dy] of nb) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const u = yy * W + xx; if (m[u] === v && lab[u] < 0) { lab[u] = comps.length; st.push(u); } }
    }
    comps.push(c);
  }
  return comps;
}

// separable box blur ×3 ≈ Gaussian of the given sigma (px)
function blur(m, W, H, sigma) {
  let a = Float32Array.from(m);
  if (sigma <= 0.3) return a;
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  const pass = (src, horiz) => {
    const out = new Float32Array(W * H), n = 2 * r + 1;
    if (horiz) for (let y = 0; y < H; y++) { let s = 0; for (let x = -r; x <= r; x++) s += src[y * W + Math.max(0, Math.min(W - 1, x))]; for (let x = 0; x < W; x++) { out[y * W + x] = s / n; s += src[y * W + Math.min(W - 1, x + r + 1)] - src[y * W + Math.max(0, x - r)]; } }
    else for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += src[Math.max(0, Math.min(H - 1, y)) * W + x]; for (let y = 0; y < H; y++) { out[y * W + x] = s / n; s += src[Math.min(H - 1, y + r + 1) * W + x] - src[Math.max(0, y - r) * W + x]; } }
    return out;
  };
  for (let k = 0; k < 3; k++) a = pass(pass(a, true), false);
  return a;
}

// ------------------------------------------------------------------------------------------------- build
export function buildGlyph(raw, params0 = {}) {
  const params = normGlyphParams(params0), { W, H, iconPx } = raw;
  let m = raw.mask;
  m = open(m, W, H, (params.openThin * iconPx) / 2);
  m = close(m, W, H, (params.closeCuts * iconPx) / 2);
  const minA = (params.minFeature * iconPx) ** 2;
  if (minA > 0) {
    m = m.slice();
    for (const c of components(m, W, H, 1)) if (c.n < minA) for (const i of c.px) m[i] = 0;          // specks of glyph
    for (const c of components(m, W, H, 0)) if (!c.border && c.n < minA) for (const i of c.px) m[i] = 1; // pinholes
  }
  // outline: iso 0.5 of a barely blurred mask (anti-aliasing only), then the Schneider fit with corner detection.
  // `smooth` is the fit tolerance: it removes wobble and stair steps smaller than itself, while corners (fur tips,
  // ear points) are split points of the fit and stay sharp — a blur would round them into blobs
  const b = blur(m, W, H, 0.1 * iconPx), f = new Float32Array(W * H);
  for (let i = 0; i < f.length; i++) f[i] = 1 - b[i];
  // the minFeature lever also applies AFTER the outline is traced: the iso-contour can leave a tiny island or pinhole
  const minLoop = Math.max((0.35 * iconPx) ** 2, 1.15 * minA); // 15 % margin: rasterized area < traced area
  const loops = isoLoops(f, W, H).filter((l) => Math.abs(area(l)) >= minLoop);
  const tol = Math.max(0.08, params.smooth) * iconPx;
  const fits = loops.map((l) => fitLoop(l, { eps: 0.6 * tol, tol, cornerAngle: 55, smooth: 2 + Math.round(4 * params.smooth), gain: 1.6 }));
  const polys = fits.map(flatten);
  const final = rasterLoops(polys, W, H);
  return { params, fits, polys, mask: final, W, H, iconPx, k: raw.k };
}
const area = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };

// ------------------------------------------------------------------------------------------------- inspect
// Defects, each with markers (x, y in raster px) so the AI can SEE where they are:
//   specks    islands or pinholes smaller than 1 icon px² (invisible at 48 px, dirt when enlarged)
//   thin      glyph parts narrower than 0.75 icon px (break up or vanish at 48 px)
//   thinCuts  cuts narrower than 0.75 icon px (fill in at 48 px)
//   roughness perimeter / perimeter after smoothing at ≤ 0.75 icon px − 1 (stair steps, wobble; clean art ≤ 0.03)
//   teeth     saw-teeth: alternating sharp turns closer than 1 icon px apart
//   fidelity  IoU with the raw glyph (how much of the original silhouette is kept)
export function inspect(built, raw) {
  const { W, H, iconPx, mask } = built;
  const specks = [];
  for (const c of components(mask, W, H, 1)) if (c.n < iconPx * iconPx) specks.push({ x: c.sx / c.n, y: c.sy / c.n, kind: 'isla' });
  for (const c of components(mask, W, H, 0)) if (!c.border && c.n < iconPx * iconPx) specks.push({ x: c.sx / c.n, y: c.sy / c.n, kind: 'agujero' });
  const rT = 0.375 * iconPx, area1 = mask.reduce((s, v) => s + v, 0) || 1;
  const opened = open(mask, W, H, rT), closed = close(mask, W, H, rT);
  let thinN = 0, cutN = 0; const thinPts = [], cutPts = [];
  const step = Math.max(1, Math.round(iconPx));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (mask[i] && !opened[i]) { thinN++; if (x % step === 0 && y % step === 0) thinPts.push({ x, y }); }
    if (!mask[i] && closed[i]) { cutN++; if (x % step === 0 && y % step === 0) cutPts.push({ x, y }); }
  }
  // roughness + saw-teeth on the outline, resampled every 0.5 icon px
  let P = 0, Ps = 0, teeth = 0; const teethPts = [];
  for (const poly of built.polys) {
    // roughness at the scale of icon pixels only (≤ ~0.75 icon px): designed spikes and curves are not roughness
    const fine = resample(poly, 0.25 * iconPx); if (fine.length < 12) continue;
    P += perimeter(fine); Ps += perimeter(smoothClosed(fine, 3));
    const rs = resample(poly, 0.5 * iconPx);
    const n = rs.length, turn = (i) => { const a = rs[(i - 1 + n) % n], b = rs[i], c = rs[(i + 1) % n]; return Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])); };
    for (let i = 0; i < n; i++) { const t0 = turn(i), t1 = turn((i + 1) % n); if (Math.abs(t0) > 0.6 && Math.abs(t1) > 0.6 && Math.sign(t0) !== Math.sign(t1)) { teeth++; if (teethPts.length < 40) teethPts.push({ x: rs[i][0], y: rs[i][1] }); } }
  }
  const roughness = Ps ? P / Ps - 1 : 0;
  let inter = 0, uni = 0; for (let i = 0; i < mask.length; i++) { const a = mask[i], b = raw.mask[i]; if (a && b) inter++; if (a || b) uni++; }
  const fidelity = uni ? inter / uni : 1;
  const thin = thinN / area1, thinCuts = cutN / area1;
  // icon score: quality (no defects) and fidelity both matter; neither can be bought with the other
  const quality = Math.max(0, 1 - Math.min(0.4, 0.04 * specks.length) - Math.min(0.3, 4 * thin) - Math.min(0.3, 4 * thinCuts) - Math.min(0.3, 6 * Math.max(0, roughness - 0.03)) - Math.min(0.3, 0.01 * teeth));
  const fid = Math.min(1, Math.max(0, (fidelity - 0.8) / 0.2)); // 0.8 IoU -> 0, 1.0 -> 1
  const score = Math.round((0.6 * quality + 0.4 * fid) * 1000) / 1000;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { score, quality: r3(quality), fidelity: r3(fidelity), specks: specks.length, thin: r3(thin), thinCuts: r3(thinCuts), roughness: r3(roughness), teeth,
    markers: { specks, thin: thinPts.slice(0, 60), thinCuts: cutPts.slice(0, 60), teeth: teethPts } };
}
function resample(poly, d) {
  const out = [poly[0]]; let acc = 0;
  for (let i = 1; i <= poly.length; i++) {
    const a = poly[i - 1], b = poly[i % poly.length]; let seg = Math.hypot(b[0] - a[0], b[1] - a[1]); let t0 = 0;
    while (acc + seg >= d) { const t = (d - acc) / seg; const p = [a[0] + (b[0] - a[0]) * (t0 + t * (1 - t0)), a[1] + (b[1] - a[1]) * (t0 + t * (1 - t0))]; out.push(p); t0 += t * (1 - t0); seg *= (1 - t); acc = 0; }
    acc += seg;
  }
  return out;
}
const perimeter = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += Math.hypot(b[0] - a[0], b[1] - a[1]); } return s; };
function smoothClosed(p, it) { let a = p; for (let k = 0; k < it; k++) { const n = a.length; a = a.map((c, i) => { const u = a[(i - 1 + n) % n], v = a[(i + 1) % n]; return [(u[0] + 2 * c[0] + v[0]) / 4, (u[1] + 2 * c[1] + v[1]) / 4]; }); } return a; }

// the built glyph as ONE compound ARU path (scene coordinates)
export function glyphToAru(built, { name = 'glifo', label = 'Glifo', fill = '#FFFFFF' } = {}) {
  const k = built.k, r2 = (v) => Math.round(v * 100) / 100, P = (p) => `${r2(p[0] / k)} ${r2(p[1] / k)}`;
  const cmds = [];
  for (const fit of built.fits) { cmds.push(`move ${P(fit.start)}`); for (const s of fit.segs) cmds.push(s.t === 'L' ? `line ${P(s.p)}` : `curve ${P(s.c1)} ${P(s.c2)} ${P(s.p)}`); cmds.push('close'); }
  return `path ${name} { label "${label}"; ${cmds.join('; ')}; fill ${fill} }`;
}

// the report the AI reads: numbers, their meaning, and which lever fixes what (no geometry, only decisions)
export function inspectionReport(ins, params) {
  return `Icon inspection (units: icon px = 1 pixel of the icon shown at 48 px):
- score ${ins.score} (quality ${ins.quality}, fidelity to the original silhouette ${ins.fidelity} IoU)
- specks: ${ins.specks} islands/pinholes smaller than 1 icon px² (dirt when enlarged) -> raise minFeature (removes features smaller than minFeature² icon px²)
- thin parts: ${(ins.thin * 100).toFixed(1)} % of the glyph is narrower than 0.75 icon px (breaks up at 48 px) -> raise openThin (removes protrusions thinner than openThin) or accept if they are essential strokes
- thin cuts: ${(ins.thinCuts * 100).toFixed(1)} % (cuts narrower than 0.75 icon px fill in at 48 px) -> raise closeCuts (closes cuts narrower than closeCuts)
- roughness: ${ins.roughness} (professional ≤ 0.03) and ${ins.teeth} saw-teeth -> raise smooth (fit tolerance in icon px: removes wobble smaller than it, keeps corners sharp)
Current levers: ${JSON.stringify(params)}; limits: ${JSON.stringify(GLYPH_LIMITS)}.
Too much cleaning loses the identity (fidelity drops): change one or two levers at a time.`;
}

// mask utilities shared with the icon-pack inspector
export { open as maskOpen, close as maskClose, components as maskComponents };
