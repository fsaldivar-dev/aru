// Procedural Compiler: Blueprint element -> Geometry IR ("ARU Geometry").
//
// Output IR nodes are plain objects that map 1:1 to low-level ARU geometry:
//   { type: 'group'|'path'|'polygon'|'ellipse'|'circle'|'instance', name, fill, stroke, strokeWidth, opacity,
//     at, rotate, scale, clip, cap, join, geom, children }
// The scene builder materializes them; the renderer never sees semantic concepts.
//
// Generic operations only (no object catalog): region, contour (interpolation), edge (fur spikes),
// planes (bands / fan), fur (locks), spot (rings), scatter, mirror. Every random choice is seeded by
// blueprint seed + element name + operation, so recompiling one element reproduces it exactly.

import { evaluate } from './expr.js';
import {
  add, sub, mul, dot, len, norm, perp, lerp2, rot, lerp, clamp, pick, dirVector, hashString, rng,
  area, centroid, bbox, inside, clipHalfPlane, interpolate, flatten, measure, segsToCommands, lineSegs, roundPts, shadeColor,
} from './geom.js';

const ENV0 = { vars: {}, seedPath: [] };

// ---------- property access on a semantic AST node ----------
function readProps(ast) {
  const map = new Map();
  for (const p of ast.props) { if (!map.has(p.key)) map.set(p.key, []); map.get(p.key).push(p); }
  const last = (k) => { const a = map.get(k); return a ? a[a.length - 1] : null; };
  return {
    has: (k) => map.has(k),
    raw: (k) => last(k)?.values ?? null,
    all: (k) => map.get(k) ?? [],
    val: (k, d) => { const p = last(k); return p && p.values.length ? evaluate(p.values[0], ENV0) : d; },
    vals: (k) => { const p = last(k); return p ? p.values.map((v) => evaluate(v, ENV0)) : []; },
    list: (k) => { const p = last(k); if (!p) return null; const v = p.values[0]; return v?.kind === 'list' ? v.items : p.values; },
  };
}
const nameOf = (v) => (v?.kind === 'ident' ? v.name.replace(/^landmark\./, '') : null);

// ---------- entry point ----------
export function compileElement(bp, el) {
  const ctx = { bp, el, deps: new Set(), expansions: 0, debug: { kind: el.kind } };
  const seedBase = hashString(`${bp.name}:${el.name}`) + Math.round(bp.seed * 7919);
  ctx.rand = (tag) => rng(seedBase + hashString(tag));
  let ir;
  if (el.exact) {
    // exact symmetry: reflect the compiled source about the axis
    ctx.deps.add('el:' + el.mirrorOf);
    const src = compileElement(bp, bp.byName.get(el.mirrorOf));
    const ax = bp.axisAbs();
    // keep the source root's own transform (spots are positioned/rotated on their root group)
    ir = { type: 'group', name: el.name, at: [2 * ax, 0], scale: [-1, 1], children: [{ ...src.ir, name: 'reflected' }] };
    ctx.expansions = src.expansions + 1;
    const flip = (pts) => pts?.map(([x, y]) => [2 * ax - x, y]);
    ctx.debug = { ...src.debug, boundary: flip(src.debug.boundary), anchors: src.debug.anchors?.map((a) => ({ ...a, p: [2 * ax - a.p[0], a.p[1]] })), path: flip(src.debug.path) };
  } else {
    switch (el.kind) {
      case 'region': ir = compileRegion(ctx, el.ast); break;
      case 'contour': ir = compileContour(ctx, el.ast); break;
      case 'spot': ir = compileSpot(ctx, el.ast); break;
      case 'scatter': ir = compileScatter(ctx, el.ast); break;
      default: ir = { type: 'group', name: el.name, children: [] };
    }
  }
  const P = readProps(el.ast);
  ir.name = el.name;
  if (P.has('semantic')) ir.semantic = String(P.val('semantic'));
  if (P.has('role')) ir.role = String(P.val('role'));
  if (P.has('opacity')) ir.opacity = P.val('opacity');
  return { ir, deps: ctx.deps, expansions: ctx.expansions, debug: ctx.debug };
}

// ---------- region ----------
function compileRegion(ctx, ast) {
  const { bp } = ctx, P = readProps(ast), s = bp.s;
  // anchors: own list, or a scaled copy of another region's anchors (`from earL; scale 0.6; pivot ...`)
  let items = P.list('anchors') || [], mode = P.val('interpolation', null), sharpNames = (P.list('sharp') || []).map(nameOf);
  let transform = (p) => p;
  if (P.has('from')) {
    const srcName = String(P.val('from')), src = bp.byName.get(srcName);
    if (!src) { bp.warnings.push({ message: `region ${ast.name}: unknown source '${srcName}'`, line: ast.line }); }
    else {
      const SP = readProps(src.ast);
      items = SP.list('anchors') || [];
      mode = mode || SP.val('interpolation', null);
      if (!sharpNames.length) sharpNames = (SP.list('sharp') || []).map(nameOf);
      const k = P.val('scale', 0.7);
      const pivot = P.has('pivot') ? ctx.bp.point(P.raw('pivot')[0], ctx.deps) : null;
      transform = (p, all) => { const c = pivot || centroid(all); return add(c, mul(sub(p, c), k)); };
    }
  }
  mode = mode || 'smooth';
  const names = items.map(nameOf);
  let points = items.map((v) => bp.point(v, ctx.deps));
  const raw = points;
  points = points.map((p) => transform(p, raw));
  if (points.length < 3) { bp.warnings.push({ message: `region ${ast.name} needs at least 3 anchors`, line: ast.line }); return { type: 'group', name: ast.name, children: [] }; }
  const sharp = new Set(sharpNames.map((n) => names.indexOf(n)).filter((i) => i >= 0));
  const { segs, anchorSeg } = interpolate(points, { closed: true, mode, sharp, r: ctx.rand('shape'), bulge: P.val('bulge', 0.06), noise: P.val('noise', 0.08) });
  ctx.expansions++;
  const basePoly = flatten(segs, 8);
  const fill = bp.color(P.raw('fill')?.[0] ?? '#888888', ctx.deps);

  // ---- edges: replace boundary stretches with procedural spikes ----
  const replacements = new Map(), skip = new Set(), layerPolys = [];
  let edgeIdx = 0;
  for (const e of ast.children.filter((c) => c.type === 'edge')) {
    const EP = readProps(e);
    const between = (EP.list('between') || []).map(nameOf);
    const pairs = [between];
    if (EP.val('sides', null) === 'both') pairs.push([between[1], between[0]].map((n) => n && (/L$/.test(n) ? n.slice(0, -1) + 'R' : /R$/.test(n) ? n.slice(0, -1) + 'L' : n)));
    for (const [A, B] of pairs) {
      const ia = A ? names.indexOf(A) : 0, ib = B ? names.indexOf(B) : 0;
      if (ia < 0 || ib < 0) { bp.warnings.push({ message: `edge in ${ast.name}: '${ia < 0 ? A : B}' is not an anchor of this region`, line: e.line }); continue; }
      const range = [];
      let k = anchorSeg[ia]; const end = A && B ? anchorSeg[ib] : (anchorSeg[ia] + segs.length) % segs.length;
      do { range.push(k); k = (k + 1) % segs.length; } while (k !== end && range.length <= segs.length);
      if (range.some((i) => skip.has(i))) { bp.warnings.push({ message: `edges overlap in ${ast.name}`, line: e.line }); continue; }
      const res = furEdge(ctx, EP, range.map((i) => segs[i]), basePoly, fill, `edge${edgeIdx++}`);
      replacements.set(range[0], res.segs); range.forEach((i) => skip.add(i));
      layerPolys.push(...res.layers);
      ctx.expansions++;
    }
  }
  const finalSegs = [];
  for (let i = 0; i < segs.length; i++) { if (replacements.has(i)) finalSegs.push(...replacements.get(i)); else if (!skip.has(i)) finalSegs.push(segs[i]); }
  const finalPoly = flatten(finalSegs, 8);
  const shape = { type: 'path', name: 'shape', fill, geom: { commands: segsToCommands(finalSegs, true) } };

  const body = { type: 'group', name: 'body', clip: 'shape', children: [shape] };
  let pi = 0, fi = 0;
  for (const c of ast.children) {
    if (c.type === 'planes') { body.children.push(planes(ctx, readProps(c), finalPoly, fill, `planes${pi ? pi + 1 : ''}`, pi)); pi++; ctx.expansions++; }
    if (c.type === 'fur') { body.children.push(furLocks(ctx, readProps(c), basePoly, fill, `fur${fi ? fi + 1 : ''}`, fi)); fi++; ctx.expansions++; }
    if (c.type === 'scatter') { /* scatter inside a region is declared as its own element */ }
  }
  if (layerPolys.length) body.children.push({ type: 'group', name: 'edgeLayers', children: layerPolys });
  ctx.debug = { kind: 'region', boundary: finalPoly, base: basePoly, anchors: names.map((n, i) => ({ name: n, p: points[i] })) };
  ctx.bp.compiled.set(ast.name, { polygon: finalPoly });
  return { type: 'group', name: ast.name, children: [body] };
}

// Fur edge: turn a stretch of boundary into controlled angular spikes (+ optional inner rows of locks).
function furEdge(ctx, EP, rangeSegs, regionPoly, fill, tag) {
  const { bp } = ctx, s = bp.s, r = ctx.rand(tag);
  const pts = flatten(rangeSegs, 10), M = measure(pts);
  const N = Math.max(1, Math.round(EP.val('spikes', M.total / (s * 0.06))));
  const lengthR = EP.val('length', { range: [0.05, 0.1] });
  const variation = EP.val('variation', 0.3);
  const dirWord = EP.val('direction', 'outward');
  const flow = dirVector(EP.val('flow', 'down')) || [0, 1];
  const flowAmt = EP.val('lean', 0.45);
  const layers = EP.val('layers', 1);
  const colors = (EP.list('colors') || []).map((c) => bp.color(c, ctx.deps));
  const cuts = [0];
  for (let j = 1; j < N; j++) cuts.push(j / N + (r() - 0.5) * variation / N);
  cuts.push(1);
  const Q = [M.at(0)], spikes = [];
  for (let j = 0; j < N; j++) {
    const a = cuts[j], b = cuts[j + 1], f = a + (b - a) * (0.5 + (r() - 0.5) * 0.3);
    const P0 = M.at(f);
    let n = perp(M.tangent(f));
    if (inside(regionPoly, add(P0, mul(n, 1.5)))) n = mul(n, -1);
    if (dirWord === 'inward') n = mul(n, -1);
    else if (dirWord !== 'outward') n = dirVector(dirWord) || n;
    const L = pick(lengthR, r, 0.08) * s * (1 + (r() - 0.5) * variation);
    const d = norm(add(n, mul(flow, flowAmt)));
    const tip = add(P0, mul(d, L));
    Q.push(tip, M.at(b));
    spikes.push({ A: M.at(a), B: M.at(b), P0, n, d, L });
  }
  const out = { segs: lineSegs(roundPts(Q)), layers: [] };
  // inner rows: smaller locks set back from the edge, in shifted colors -> depth without extra source
  for (let k = 1; k < layers; k++) {
    const col = colors[(k - 1) % Math.max(1, colors.length)] || shadeColor(fill, k % 2 ? -0.14 * k : 0.1);
    spikes.forEach((sp, j) => {
      if (r() < 0.25) return;
      const depth = sp.L * 0.55 * k;
      const A = sub(sp.A, mul(sp.n, depth)), B = sub(sp.B, mul(sp.n, depth));
      const tip = add(sub(sp.P0, mul(sp.n, depth)), mul(sp.d, sp.L * (0.95 - 0.1 * k)));
      out.layers.push({ type: 'polygon', name: `${tag}row${k}_${j}`, fill: col, geom: { points: roundPts([lerp2(A, B, 0.1), tip, lerp2(A, B, 0.9)]) } });
    });
  }
  return out;
}

// Visual planes: big flat facets of color that read as form. `bands` = cuts across a shading direction,
// `fan` = wedges radiating from a focus landmark. Facets are generous polygons clipped by the region shape.
function planes(ctx, PP, poly, fill, tag, idx) {
  const { bp } = ctx, r = ctx.rand(tag);
  const count = Math.max(1, Math.round(PP.val('count', 5)));
  const mode = PP.val('mode', 'bands');
  const dirWord = PP.val('direction', null);
  const shade = dirWord != null ? (dirVector(dirWord) || bp.shadeDir(ctx.deps)) : bp.shadeDir(ctx.deps);
  const pal = (PP.list('palette') || []).map((c) => bp.color(c, ctx.deps));
  const palette = pal.length ? pal : [fill, shadeColor(fill, -0.1), shadeColor(fill, -0.22)];
  const variation = PP.val('variation', 0.15);
  const opacity = PP.val('opacity', 1);
  const [x0, y0, x1, y1] = bbox(poly), pad = Math.max(x1 - x0, y1 - y0);
  const rect = [[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x1 + pad, y1 + pad], [x0 - pad, y1 + pad]];
  const c = centroid(poly);
  const children = [];
  // contrast < 1 pulls facets toward the middle of the palette (a soft fill light)
  const contrast = PP.val('contrast', 1);
  const colorAt = (t0) => { const t = 0.5 + (t0 - 0.5) * contrast; return palette[clamp(Math.round(clamp(t + (r() - 0.5) * variation, 0, 1) * (palette.length - 1)), 0, palette.length - 1)]; };
  if (mode === 'fan') {
    const focus = PP.has('focus') ? bp.point(PP.raw('focus')[0], ctx.deps) : c;
    const M = measure([...poly, poly[0]]);
    const start = r();
    for (let i = 0; i < count; i++) {
      const f0 = start + (i + (i ? (r() - 0.5) * 0.5 : 0)) / count, f1 = start + (i + 1) / count;
      const pts = [focus];
      for (let k = 0; k <= 4; k++) pts.push(add(focus, mul(sub(M.at((lerp(f0, f1, k / 4)) % 1), focus), 1.7)));
      const mid = M.at((lerp(f0, f1, 0.5)) % 1);
      const t = (dot(norm(sub(mid, focus)), shade) + 1) / 2;
      children.push({ type: 'polygon', name: `facet${i + 1}`, fill: colorAt(t), geom: { points: roundPts(pts) } });
    }
  } else {
    const proj = poly.map((p) => dot(p, shade)), lo = Math.min(...proj), hi = Math.max(...proj), pc = dot(c, shade);
    const angleJ = PP.val('angle', 22);
    const cuts = [], angles = [];
    for (let k = 0; k <= count; k++) {
      const edge = k === 0 || k === count;
      cuts.push(lo + (hi - lo) * k / count + (edge ? (k ? pad : -pad) : (r() - 0.5) * variation * (hi - lo) / count));
      angles.push(edge ? 0 : (r() - 0.5) * 2 * angleJ);
    }
    for (let k = 0; k < count; k++) {
      const qa = add(c, mul(shade, cuts[k] - pc)), na = rot(shade, angles[k]);
      const qb = add(c, mul(shade, cuts[k + 1] - pc)), nb = rot(shade, angles[k + 1]);
      let band = clipHalfPlane(rect, qa, na);
      band = clipHalfPlane(band, qb, mul(nb, -1));
      if (band.length < 3) continue;
      children.push({ type: 'polygon', name: `band${k + 1}`, fill: colorAt(count === 1 ? 0 : k / (count - 1)), geom: { points: roundPts(band) } });
    }
  }
  return { type: 'group', name: tag, opacity: opacity !== 1 ? opacity : undefined, children };
}

// Fur locks: stylized tufts (not hairs) scattered inside the region, flowing in a direction, in layers.
function furLocks(ctx, FP, poly, fill, tag) {
  const { bp } = ctx, s = bp.s, r = ctx.rand(tag);
  const A = Math.abs(area(poly));
  const count = Math.min(400, Math.round(FP.val('count', FP.val('density', 0.5) * A / (s * s) * 260)));
  const lengthR = FP.val('length', { range: [0.04, 0.09] });
  const widthK = FP.val('width', 0.32);
  const layers = Math.max(1, FP.val('layers', 2));
  const style = FP.val('style', 'angular');
  const colorsRaw = (FP.list('colors') || []).map((c) => bp.color(c, ctx.deps));
  const colors = colorsRaw.length ? colorsRaw : [shadeColor(fill, -0.12), shadeColor(fill, 0.14), shadeColor(fill, -0.24)];
  const dirRaw = FP.raw('direction')?.[0];
  const dirWord = dirRaw ? evaluate(dirRaw, ENV0) : 'outward';
  const awayFrom = dirRaw?.kind === 'ident' && bp.landmarkDefs.has(dirRaw.name.replace(/^landmark\./, '')) ? bp.point(dirRaw, ctx.deps) : null;
  const flow = dirVector(FP.val('flow', 'down')) || [0, 1], flowAmt = FP.val('lean', 0.3);
  const c = centroid(poly);
  const pts = placeInPolygon(poly, count, r, Math.sqrt(A / Math.max(1, count)) * 0.45);
  const children = [];
  pts.forEach((p, i) => {
    const k = i % layers;
    let d;
    if (awayFrom) d = norm(sub(p, awayFrom));
    else if (dirWord === 'outward') d = norm(sub(p, c));
    else if (dirWord === 'inward') d = norm(sub(c, p));
    else d = dirVector(dirWord) || [0, 1];
    d = norm(add(d, mul(flow, flowAmt)));
    d = rot(d, (r() - 0.5) * 30);
    const L = pick(lengthR, r, 0.06) * s * (1 - 0.18 * k), w = L * widthK;
    const q = perp(d), bl = add(p, mul(q, -w / 2)), br = add(p, mul(q, w / 2)), tip = add(p, mul(d, L));
    const bend = mul(q, w * (r() - 0.5) * 1.2);
    const col = colors[k % colors.length];
    if (style === 'smooth') {
      const m = add(lerp2(p, tip, 0.5), bend);
      children.push({ type: 'path', name: `lock${i + 1}`, fill: col, geom: { commands: [
        { cmd: 'move', args: roundPts([bl])[0] }, { cmd: 'quad', args: roundPts([m, tip]).flat() },
        { cmd: 'quad', args: roundPts([add(m, mul(q, w * 0.3)), br]).flat() }, { cmd: 'close', args: [] }] } });
    } else {
      const notch = add(add(lerp2(p, tip, 0.55), mul(q, w * 0.55)), bend);
      children.push({ type: 'polygon', name: `lock${i + 1}`, fill: col, geom: { points: roundPts([bl, add(tip, bend), notch, br]) } });
    }
  });
  return { type: 'group', name: tag, children };
}

// ---------- spot: a shape at a landmark built from concentric rings (eyes, noses, buttons, seeds...) ----------
function compileSpot(ctx, ast) {
  const { bp } = ctx, P = readProps(ast), s = bp.s;
  const c = bp.point(P.raw('at')?.[0], ctx.deps);
  const [w0, h0] = P.vals('size'); const W = (w0 ?? 0.1) * s, H = (h0 ?? w0 ?? 0.1) * s;
  const shape = String(P.val('shape', 'round'));
  const rings = P.all('ring').map((p) => ({ color: bp.color(p.values[0], ctx.deps), scale: p.values[1] ? evaluate(p.values[1], ENV0) : 1, shape: p.values[2] ? evaluate(p.values[2], ENV0) : shape, dx: p.values[3] ? evaluate(p.values[3], ENV0) : 0, dy: p.values[4] ? evaluate(p.values[4], ENV0) : 0 }));
  if (!rings.length) rings.push({ color: bp.color(P.raw('fill')?.[0] ?? '#000', ctx.deps), scale: 1, shape, dx: 0, dy: 0 });
  const mk = (rg, i) => spotShape(rg.shape, W * rg.scale, H * rg.scale, `r${i}`, rg.color, [rg.dx * W, rg.dy * H]);
  const children = [mk(rings[0], 0)];
  if (rings.length > 1) children.push({ type: 'group', name: 'window', clip: 'r1', children: rings.slice(1).map((rg, i) => mk(rg, i + 1)) });
  ctx.expansions++;
  ctx.debug = { kind: 'spot', anchors: [{ name: bp.pointNames(P.raw('at')?.[0])[0] || 'at', p: c }], boundary: flatten(spotOutline(shape, W, H).map((sg) => ({ ...sg, p0: add(rot(sg.p0, P.val('angle', 0)), c), c1: add(rot(sg.c1, P.val('angle', 0)), c), c2: add(rot(sg.c2, P.val('angle', 0)), c), p1: add(rot(sg.p1, P.val('angle', 0)), c) })), 6) };
  return { type: 'group', name: ast.name, at: roundPts([c])[0], rotate: P.val('angle', 0), children };
}
function spotOutline(shape, W, H) {
  const w = W / 2, h = H / 2;
  if (shape === 'almond') return [
    { p0: [-w, 0], c1: [-w * 0.5, -h * 1.33], c2: [w * 0.5, -h * 1.33], p1: [w, 0] },
    { p0: [w, 0], c1: [w * 0.5, h * 1.33], c2: [-w * 0.5, h * 1.33], p1: [-w, 0] }];
  if (shape === 'triangle' || shape === 'diamond') {
    const v = shape === 'triangle' ? [[-w, -h], [w, -h], [0, h]] : [[0, -h], [w, 0], [0, h], [-w, 0]];
    return interpolate(v, { closed: true, mode: 'smooth', tension: 0.35 }).segs;
  }
  const k = 0.5523; // circle/ellipse as 4 cubics
  return [
    { p0: [w, 0], c1: [w, h * k], c2: [w * k, h], p1: [0, h] }, { p0: [0, h], c1: [-w * k, h], c2: [-w, h * k], p1: [-w, 0] },
    { p0: [-w, 0], c1: [-w, -h * k], c2: [-w * k, -h], p1: [0, -h] }, { p0: [0, -h], c1: [w * k, -h], c2: [w, -h * k], p1: [w, 0] }];
}
function spotShape(shape, W, H, name, fill, [dx, dy]) {
  const at = dx || dy ? roundPts([[dx, dy]])[0] : undefined;
  if (shape === 'circle') return { type: 'circle', name, fill, at, geom: { radius: Math.round(Math.min(W, H) * 50) / 100 } };
  if (shape === 'round') return { type: 'ellipse', name, fill, at, geom: { size: roundPts([[W, H]])[0] } };
  return { type: 'path', name, fill, at, geom: { commands: segsToCommands(spotOutline(shape, W, H), true) } };
}

// ---------- contour: a line through landmarks; the engine invents the Bézier handles ----------
function compileContour(ctx, ast) {
  const { bp } = ctx, P = readProps(ast), s = bp.s;
  const items = P.list('through') || [];
  const pts = items.map((v) => bp.point(v, ctx.deps));
  const closed = !!P.val('closed', 0);
  const mode = P.val('interpolation', 'smooth');
  const names = items.map(nameOf);
  const sharp = new Set((P.list('sharp') || []).map(nameOf).map((n) => names.indexOf(n)).filter((i) => i >= 0));
  const { segs } = interpolate(pts, { closed, mode, sharp, r: ctx.rand('contour') });
  ctx.expansions++;
  const flat = flatten(segs, 12);
  ctx.debug = { kind: 'contour', path: flat, anchors: names.map((n, i) => ({ name: n, p: pts[i] })) };
  if (P.has('width')) { // tapered brush stroke -> filled polygon
    const wv = P.val('width'), w0 = (wv.range ? wv.range[0] : wv) * s, w1 = (wv.range ? wv.range[1] : wv) * s;
    const M = measure(flat), L = [], R = [], n = 28;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1), p = M.at(f), q = perp(M.tangent(f)), w = lerp(w0, w1, f) / 2;
      L.push(add(p, mul(q, w))); R.push(sub(p, mul(q, w)));
    }
    const fill = bp.color(P.raw('fill')?.[0] ?? P.raw('stroke')?.[0] ?? '#000', ctx.deps);
    return { type: 'group', name: ast.name, children: [{ type: 'polygon', name: 'brush', fill, geom: { points: roundPts([...L, ...R.reverse()]) } }] };
  }
  const st = P.raw('stroke');
  const stroke = bp.color(st?.[0] ?? '#000', ctx.deps), sw = (st?.[1] ? evaluate(st[1], ENV0) : 0.004) * s;
  const fill = P.has('fill') ? bp.color(P.raw('fill')[0], ctx.deps) : 'none';
  return { type: 'group', name: ast.name, children: [{ type: 'path', name: 'line', fill, stroke, strokeWidth: Math.round(sw * 100) / 100, cap: 'round', join: 'round', geom: { commands: segsToCommands(segs, closed) } }] };
}

// ---------- scatter: N instances of a template inside a region ----------
function compileScatter(ctx, ast) {
  const { bp } = ctx, P = readProps(ast);
  const inName = String(P.val('inside', ''));
  const target = bp.compiled.get(inName);
  ctx.deps.add('el:' + inName);
  if (!target) { bp.warnings.push({ message: `scatter ${ast.name}: unknown or later region '${inName}'`, line: ast.line }); return { type: 'group', name: ast.name, children: [] }; }
  const children = scatterInstances(P, target.polygon, ctx.rand('scatter'), ast.children.filter((c) => !['edge', 'planes', 'fur'].includes(c.type)), ast.name);
  ctx.expansions++;
  ctx.debug = { kind: 'scatter', points: children.map((c) => c.at) };
  return { type: 'group', name: ast.name, children };
}
export function scatterInstances(P, poly, r, template, name) {
  const count = Math.round(P.val('count', 20));
  const scaleV = P.val('scale', 1), rotV = P.val('rotation', 0);
  const A = Math.abs(area(poly));
  const spacing = P.val('spacing', Math.sqrt(A / Math.max(1, count)) * 0.5);
  const pts = placeInPolygon(poly, count, r, spacing);
  return pts.map((p, i) => {
    const sc = pick(scaleV, r, 1);
    return { type: 'instance', name: `${name}${i + 1}`, at: roundPts([p])[0], rotate: Math.round(pick(rotV, r, 0) * 10) / 10, scale: [Math.round(sc * 100) / 100, Math.round(sc * 100) / 100], template, vars: { i, n: pts.length, t: pts.length > 1 ? i / (pts.length - 1) : 0 } };
  });
}

// deterministic dart throwing inside a polygon
export function placeInPolygon(poly, count, r, minDist = 0) {
  const [x0, y0, x1, y1] = bbox(poly), out = [];
  let tries = 0;
  while (out.length < count && tries < count * 60) {
    tries++;
    const p = [x0 + r() * (x1 - x0), y0 + r() * (y1 - y0)];
    if (!inside(poly, p)) continue;
    const md = tries > count * 30 ? minDist * 0.5 : minDist;
    if (md && out.some((q) => len(sub(p, q)) < md)) continue;
    out.push(p);
  }
  return out;
}

// polygon of a geometric scene shape in its parent's space (for top-level `scatter ... { inside shapeName }`)
export function shapePolygon(node) {
  const g = node.geom; let pts = [];
  const ring = (rx, ry) => { for (let i = 0; i < 32; i++) { const a = (i / 32) * Math.PI * 2; pts.push([Math.cos(a) * rx, Math.sin(a) * ry]); } };
  switch (node.type) {
    case 'circle': ring(g.radius, g.radius); break;
    case 'ellipse': ring(g.size[0] / 2, g.size[1] / 2); break;
    case 'rect': pts = [[-g.size[0] / 2, -g.size[1] / 2], [g.size[0] / 2, -g.size[1] / 2], [g.size[0] / 2, g.size[1] / 2], [-g.size[0] / 2, g.size[1] / 2]]; break;
    case 'polygon': pts = g.points.map((p) => [...p]); break;
    case 'path': {
      let cur = [0, 0];
      for (const c of g.commands) {
        const a = c.args;
        if (c.cmd === 'move' || c.cmd === 'line') { cur = [a[0], a[1]]; pts.push(cur); }
        else if (c.cmd === 'curve') { const sg = { p0: cur, c1: [a[0], a[1]], c2: [a[2], a[3]], p1: [a[4], a[5]] }; pts.push(...flatten([sg], 8).slice(1)); cur = sg.p1; }
        else if (c.cmd === 'quad') { const q = [a[0], a[1]], e = [a[2], a[3]]; const sg = { p0: cur, c1: lerp2(cur, q, 2 / 3), c2: lerp2(e, q, 2 / 3), p1: e }; pts.push(...flatten([sg], 8).slice(1)); cur = e; }
      }
    }
  }
  const [sx, sy] = node.scale;
  return pts.map(([x, y]) => add(rot([x * sx, y * sy], node.rotate), node.at));
}
