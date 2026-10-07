// Section Polish: the last pass, one semantic section at a time.
//
// A reviewer (a person, or an AI that looks at the reference and the current vector side by side) says HOW a
// section should be cleaned, never WHERE its points go:
//   { section: 'wolf.leftEar', edges: 'straight', corners: 'sharp', simplify: 0.6 }
//   { section: 'wolf.head.leftEye.iris', shape: 'circle' }
// The engine re-fits that section's shared chains deterministically from the MEASURED pixel boundary and keeps the
// change only if (1) the new outline stays within a geometric tolerance of the measured boundary and (2) the pixel
// fidelity inside the section does not drop. Junction endpoints never move, so neighbouring regions still tile exactly.
// Bad advice is therefore harmless: it is measured and rejected, and the report says why.
import { densify, douglasPeucker, segDist } from './simplify.js';
import { fitCubic, traceError, bez } from './bezier.js';
import { taubin, fitEllipse, ellipseSegs, signedArea, edgeParams } from './edges.js';
import { rasterizeTrace } from './raster.js';
import { rgbToLab, labImage } from './quantize.js';
import { consensusShape, shapeDistance, shapeTol } from './conics.js';
import { optimizeJunctions, shiftFit, vkey, junctionSpikes } from './junctions.js';
import { styleEvidence, shapeSupport, intentAgreement, CONFIDENCE } from './style-evidence.js';
import { sectionMasks, measureSections, designedScores } from './designed.js';

const lerp = (a, b, t) => a + (b - a) * t;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], len = (v) => Math.hypot(v[0], v[1]);
const norm = (v) => { const l = len(v) || 1; return [v[0] / l, v[1] / l]; };

// ---------------------------------------------------------------------------------------------------------------
// Directive vocabulary. Small, closed and geometry-free: a provider can only choose among these words.
export const ENUMS = {
  scope: ['all', 'outline', 'inside'],          // outline = edges against other sections; inside = edges between its own regions
  edges: ['auto', 'straight', 'curved'],        // what the edges of this section should be made of
  corners: ['keep', 'sharp', 'soften', 'remove'],
  shape: ['none', 'circle', 'ellipse'],         // analytic shape for the section's outlines (partial / multi-chain; validated by the pixels)
  confidence: ['low', 'medium', 'high'],        // the reviewer's own certainty: evidence only, never a bypass of any gate
};
// Region-level intent (topology), also closed and geometry-free:
//   count:   preserve = do not change which regions exist | simplify = merge same-role fragments | single = one main shape + distinct details
//   merge:   none | compatible (close colors, small loss) | aggressive (larger color/loss allowance)
//   protect: true = these regions are deliberate; never absorb them into neighbours
export const REGION_ENUMS = { count: ['preserve', 'simplify', 'single'], merge: ['none', 'compatible', 'aggressive'] };
const FORBIDDEN = ['path', 'paths', 'd', 'svg', 'bezier', 'commands', 'curve', 'curves', 'points', 'coords', 'polygon', 'image', 'pixels', 'x', 'y', 'cx', 'cy', 'r', 'bounds', 'box', 'controlPoints'];
const DEFAULTS = { scope: 'all', edges: 'auto', corners: 'keep', shape: 'none', simplify: 0.5, confidence: 'medium', reason: '' };

// JSON schema of a provider answer (also used for structured output by API providers)
export const DIRECTIVES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['directives'],
  properties: {
    directives: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['section', 'edges', 'corners', 'shape', 'simplify', 'confidence', 'reason'],
        properties: {
          section: { type: 'string' },
          scope: { type: 'string', enum: ENUMS.scope },
          edges: { type: 'string', enum: ENUMS.edges },
          corners: { type: 'string', enum: ENUMS.corners },
          shape: { type: 'string', enum: ENUMS.shape },
          simplify: { type: 'number' },
          confidence: { type: 'string', enum: ENUMS.confidence },
          regions: {
            type: 'object', additionalProperties: false,
            properties: { count: { type: 'string', enum: REGION_ENUMS.count }, merge: { type: 'string', enum: REGION_ENUMS.merge }, protect: { type: 'boolean' } },
          },
          reason: { type: 'string' },
        },
      },
    },
  },
};

export function validateDirectives(input, ctx) {
  const list = Array.isArray(input) ? input : input?.directives;
  if (!Array.isArray(list)) return { directives: [], errors: ['directives must be an array'] };
  const known = new Set(['background', ...ctx.nodes.map((n) => n.path)]);
  const errors = [], directives = [], seen = new Set();
  list.forEach((d, i) => {
    const where = `directives[${i}]`;
    if (!d || typeof d !== 'object') { errors.push(`${where}: must be an object`); return; }
    const bad = Object.keys(d).filter((k) => FORBIDDEN.includes(k));
    if (bad.length) { errors.push(`${where}: '${bad.join("', '")}' is not allowed — a reviewer says how to polish, the tracer produces geometry`); return; }
    const unknown = Object.keys(d).filter((k) => !(k in ENUMS) && !['section', 'simplify', 'reason', 'regions'].includes(k));
    if (unknown.length) { errors.push(`${where}: unknown key '${unknown.join("', '")}'`); return; }
    if (d.regions !== undefined) {
      const R = d.regions;
      if (!R || typeof R !== 'object' || Array.isArray(R)) { errors.push(`${where}.regions must be an object`); return; }
      const badR = Object.keys(R).filter((k) => !['count', 'merge', 'protect'].includes(k));
      if (badR.length) { errors.push(`${where}.regions: unknown key '${badR.join("', '")}'`); return; }
      for (const k of Object.keys(REGION_ENUMS)) if (R[k] !== undefined && !REGION_ENUMS[k].includes(R[k])) { errors.push(`${where}.regions.${k}: '${R[k]}' is not one of ${REGION_ENUMS[k].join('|')}`); return; }
      if (R.protect !== undefined && typeof R.protect !== 'boolean') { errors.push(`${where}.regions.protect must be true or false`); return; }
    }
    if (!known.has(d.section)) { errors.push(`${where}: unknown section '${d.section}'`); return; }
    for (const k of Object.keys(ENUMS)) if (d[k] !== undefined && !ENUMS[k].includes(d[k])) { errors.push(`${where}.${k}: '${d[k]}' is not one of ${ENUMS[k].join('|')}`); return; }
    if (d.simplify !== undefined && !(typeof d.simplify === 'number' && d.simplify >= 0 && d.simplify <= 1)) { errors.push(`${where}.simplify must be within 0..1`); return; }
    if (seen.has(d.section)) { errors.push(`${where}: duplicate section '${d.section}' (first one kept)`); return; }
    seen.add(d.section);
    const out = { ...DEFAULTS, ...d };
    if (d.regions) out.regions = { count: 'simplify', merge: 'compatible', protect: false, ...d.regions };
    directives.push(out);
  });
  return { directives, errors };
}

// a section's directive also covers its sub-sections unless they have their own (longest prefix wins)
export function directiveResolver(directives) {
  const cache = new Map();
  return (p) => {
    if (cache.has(p)) return cache.get(p);
    let best = null;
    for (const d of directives) if ((p === d.section || p.startsWith(d.section + '.')) && (!best || d.section.length > best.section.length)) best = d;
    cache.set(p, best);
    return best;
  };
}

// Sections a reviewer can address: semantic paths that own regions, with their measured state.
export function describeSections(T, assign, ctx) {
  const by = new Map();
  for (const r of T.regions) {
    const a = assign.get(r.id);
    let s = by.get(a.path);
    if (!s) by.set(a.path, (s = { section: a.path, type: a.node?.type ?? 'background', label: a.node?.label ?? '', importance: a.node?.importance ?? ctx.background.importance, visualIntent: a.node?.visualIntent ?? {}, regions: 0, area: 0, bounds: [Infinity, Infinity, -Infinity, -Infinity], chains: new Set() }));
    s.regions++; s.area += r.area;
    s.bounds = [Math.min(s.bounds[0], r.bounds[0]), Math.min(s.bounds[1], r.bounds[1]), Math.max(s.bounds[2], r.bounds[2]), Math.max(s.bounds[3], r.bounds[3])];
    for (const loop of [r.outer, ...r.holeLoops]) for (const ref of loop.refs) s.chains.add(ref.chain);
  }
  return [...by.values()].map((s) => {
    const fits = [...s.chains].map((c) => T.fits[c]);
    return { ...s, chains: s.chains.size, segments: fits.reduce((a, f) => a + f.segs.length, 0), curveRatio: ratio(fits), roughness: roughness(fits) };
  }).sort((a, b) => b.importance - a.importance || b.area - a.area);
}

// ---------------------------------------------------------------------------------------------------------------
export function polishSections(T, assign, ctx, img, input, { abstraction = 0.5, lab = null, junctions = true, generalShapes = true, acceptance = true } = {}) {
  const { directives, errors } = validateDirectives(input, ctx);
  const E = edgeParams(abstraction);
  const W = T.width, H = T.height;
  const L = lab || labImage(img);
  const nodeByPath = new Map(ctx.nodes.map((n) => [n.path, n]));
  const depthOf = (d) => (d.section === 'background' ? -1 : nodeByPath.get(d.section).depth);
  const impOf = (d) => (d.section === 'background' ? ctx.background.importance : nodeByPath.get(d.section).importance);
  // a section's directive also covers its sub-sections unless they have their own (longest prefix wins)
  const dirCache = new Map();
  const dirOfPath = (p) => {
    if (dirCache.has(p)) return dirCache.get(p);
    let best = null;
    for (const d of directives) if ((p === d.section || p.startsWith(d.section + '.')) && (!best || d.section.length > best.section.length)) best = d;
    dirCache.set(p, best);
    return best;
  };
  const dirOfRegion = (rid) => (rid < 0 ? null : dirOfPath(assign.get(rid).path));
  const better = (a, b) => (!b ? a : !a ? b : depthOf(a) !== depthOf(b) ? (depthOf(a) > depthOf(b) ? a : b) : impOf(a) >= impOf(b) ? a : b);
  // 1. who decides each shared chain: the more specific (deeper) section among its two sides, if its scope accepts it
  const chainDir = T.chains.map((c) => {
    const dl = dirOfRegion(c.left), dr = dirOfRegion(c.right), same = !!dl && dl === dr;
    const ok = (d) => d && (d.scope === 'all' || (d.scope === 'inside' ? same : !same));
    return better(ok(dl) ? dl : null, ok(dr) ? dr : null);
  });
  // 2. analytic shapes (partial, multi-chain): circle / ellipse candidates per section AND per region, by deterministic
  //    consensus over the MEASURED boundaries; each chain takes the candidate it actually lies on (per-point weights,
  //    so an iris cut by the eyelid keeps the eyelid line and still gets a true arc on its visible part)
  const conic = new Map();
  const shapeLog = [];
  const bestShape = new Map(), allShapes = new Map();
  const chainPts = new Map(); const ptsOf = (ci) => { if (!chainPts.has(ci)) chainPts.set(ci, densify(T.chains[ci])); return chainPts.get(ci); };
  const bySection = new Map();
  for (const r of T.regions) {
    const d = dirOfRegion(r.id);
    if (!d || d.shape === 'none' || r.area < 20) continue;
    if (!bySection.has(d)) bySection.set(d, []);
    bySection.get(d).push(r);
  }
  if (generalShapes) {
    for (const [d, regs] of bySection) {
      const tolShape = lerp(0.7, 1.4, d.simplify);
      const kinds = d.shape === 'ellipse' ? ['ellipse', 'circle'] : ['circle', 'ellipse'];
      const opts = { kinds, tol: tolShape, maxSize: 0.9 * Math.max(W, H), prefer: d.shape === 'ellipse' ? 'ellipse' : null };
      const chainsOf = (rs) => [...new Set(rs.flatMap((r) => r.outer.refs.map((ref) => ref.chain)))];
      const bboxOf = (rs) => [Math.min(...rs.map((r) => r.bounds[0])), Math.min(...rs.map((r) => r.bounds[1])), Math.max(...rs.map((r) => r.bounds[2])), Math.max(...rs.map((r) => r.bounds[3]))];
      const cands = [];
      const whole = consensusShape(chainsOf(regs).map(ptsOf), { ...opts, bbox: bboxOf(regs) });
      if (whole?.pick) cands.push({ ...whole.pick, from: 'section' });
      for (const r of regs) if (r.area >= 30) { const one = consensusShape(chainsOf([r]).map(ptsOf), { ...opts, bbox: bboxOf([r]) }); if (one?.pick) cands.push({ ...one.pick, from: `region${r.id}` }); }
      // evidence uses the section-level consensus when there is one (it explains the most), else the best region shape
      bestShape.set(d, cands.find((c) => c.from === 'section') || [...cands].sort((a, b) => b.inlierRatio * b.coverage - a.inlierRatio * a.coverage)[0] || null);
      allShapes.set(d, cands);
      shapeLog.push({ section: d.section, candidates: cands.map((c) => ({ kind: c.shape.kind, from: c.from, rms: +c.rms.toFixed(2), coverage: Math.round(c.coverage), inlierRatio: +c.inlierRatio.toFixed(2) })) });
      for (const ci of chainsOf(regs)) {
        const D = ptsOf(ci);
        let best = null;
        for (const c of cands) { const Tl = shapeTol(c.shape, tolShape); const inl = D.filter((p) => shapeDistance(c.shape, p).d <= 2 * Tl).length / D.length; if (inl >= 0.5 && (!best || inl > best.inl)) best = { ...c, tol: Tl, inl }; }
        if (!best) continue;
        const prev = conic.get(ci);
        if (!prev || better(prev.dir, d) === d) conic.set(ci, { ...best, dir: d });
        chainDir[ci] = better(chainDir[ci], d); // a validated arc belongs to the more specific of its two sides
      }
    }
  }
  else {
    const loopPts = (r) => r.outer.refs.flatMap((ref) => { const D = densify(T.chains[ref.chain]); return ref.reversed ? D.slice().reverse() : D; });
    const maxR = 0.75 * Math.max(W, H);
    for (const [d, regs] of bySection) {
      const tolShape = lerp(0.7, 1.4, d.simplify);
      const whole = consensusCircle(regs.flatMap(loopPts), tolShape, maxR);
      for (const r of regs) {
        const c = whole || consensusCircle(loopPts(r), tolShape, maxR);
        if (!c) continue;
        for (const ref of r.outer.refs) {
          const ch = T.chains[ref.chain], D = densify(ch);
          const inl = D.filter((p) => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) <= 2 * c.tol).length / D.length;
          if (inl < 0.8) continue;
          const island = ch.closed && !ch.atJunction;
          let shape = { ...c, kind: 'circle' };
          if (island && d.shape === 'ellipse') { const e = fitEllipse(D.slice(0, -1), 1.2 * tolShape); if (e) shape = { ...e, kind: 'ellipse', tol: tolShape }; }
          const prev = conic.get(ref.chain);
          if (!prev || better(prev.dir, d) === d) conic.set(ref.chain, { ...shape, dir: d });
          chainDir[ref.chain] = better(chainDir[ref.chain], d); // a validated arc belongs to the more specific of its two sides
        }
      }
    }
  }
  // 3. section by section (directive order is deterministic): propose, check geometry, check pixels, accept or reject
  const regLab = new Map(T.regions.map((r) => [r.id, rgbToLab(...r.color)]));
  const regById = new Map(T.regions.map((r) => [r.id, r]));
  const colorAt = (id, i) => {
    if (id < 0) return [100, 0, 0];
    const g = regById.get(id).gradient;
    if (!g) return regLab.get(id);
    const x = (i % W) + 0.5, y = Math.floor(i / W) + 0.5, dx = g.x2 - g.x1, dy = g.y2 - g.y1, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - g.x1) * dx + (y - g.y1) * dy) / L2));
    return g.lab0.map((v, k) => v + (g.lab1[k] - v) * t);
  };
  const good = (id, i) => { const c = colorAt(id, i); return Math.hypot(L[i * 3] - c[0], L[i * 3 + 1] - c[1], L[i * 3 + 2] - c[2]) <= 10; };
  let fits = T.fits.slice();
  const changedChains = new Map(); // chain -> 'line' | 'curve' | 'arc' (accepted changes, for the debug view)
  let ids = rasterizeTrace({ ...T, fits });
  // 2b. joint junction optimization: every junction moves as one entity (all incident chains together);
  //     each move is checked against the pixels in a window around it and reverted if that window loses matches
  let endMoves = new Map(); // vertex key -> [x, y] (accepted)
  const junctionReport = { junctions: 0, proposed: 0, accepted: 0, revertedPixels: 0, spikesBefore: 0, spikesAfter: 0 };
  if (junctions) {
    const R = lerp(2, 4, abstraction);
    const jr = optimizeJunctions(T.chains, fits, { W, H, radius: R });
    junctionReport.junctions = jr.stats.junctions; junctionReport.proposed = jr.stats.proposed;
    junctionReport.spikesBefore = junctionSpikes(T.chains, fits, W, H).spikes;
    let live = new Map([...jr.moves].map(([k, m]) => [k, m]));
    for (let round = 0; round < 3 && live.size; round++) {
      const cand = applyMoves(T.chains, T.fits === fits ? fits : fits, live);
      const ids2 = rasterizeTrace({ ...T, fits: cand });
      const bad = [];
      for (const [k, m] of live) {
        const r = Math.ceil(R) + 3, x0 = Math.max(0, Math.floor(m.from[0]) - r), y0 = Math.max(0, Math.floor(m.from[1]) - r), x1 = Math.min(W, Math.ceil(m.from[0]) + r), y1 = Math.min(H, Math.ceil(m.from[1]) + r);
        let g0 = 0, g1 = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * W + x; n++; if (good(ids[i], i)) g0++; if (good(ids2[i], i)) g1++; }
        if (g1 < g0 - Math.max(1, 0.01 * n)) bad.push(k);
      }
      if (!bad.length) { fits = cand; ids = ids2; endMoves = new Map([...live].map(([k, m]) => [k, m.to])); break; }
      junctionReport.revertedPixels += bad.length;
      for (const k of bad) live.delete(k);
    }
    junctionReport.accepted = endMoves.size;
    junctionReport.spikesAfter = junctionSpikes(T.chains, fits, W, H).spikes;
  }
  const moveOf = (ch) => { const a = ch.points[0], b = ch.points[ch.points.length - 1]; return { a: endMoves.get(vkey(a)) || null, b: endMoves.get(vkey(b)) || null }; };
  const report = [];
  const totals = { directives: directives.length, accepted: 0, rejected: 0, chainsChanged: 0, chainsRejected: 0, pointsBefore: 0, pointsAfter: 0 };
  const secMasks = acceptance ? sectionMasks(T, assign) : null;
  const TAU = { low: 0.01, medium: 0.003, high: 0.001 }; // required improvement: a less confident reviewer must show more
  for (const d0 of directives) {
    const mine = [];
    chainDir.forEach((cd, ci) => { if (cd === d0) mine.push(ci); });
    // ---- style evidence: Vision proposes + VisualIntent suggests + Pixels measure ----
    const vi = d0.section === 'background' ? {} : nodeByPath.get(d0.section).visualIntent || {};
    const ev = mine.length ? styleEvidence(mine.map((ci) => T.chains[ci])) : null;
    const agree = intentAgreement(d0, vi), conf = CONFIDENCE[d0.confidence] ?? 0.6;
    const d = { ...d0 };
    const style = { intent: agree, confidence: d0.confidence, pixels: {}, decisions: [] };
    const supports = [];
    if (d0.edges === 'straight' || d0.edges === 'curved') {
      const e = ev?.[d0.edges]; style.pixels[d0.edges] = e || null;
      if (!e || e.support < 0.25) { d.edges = 'auto'; style.decisions.push(`${d0.edges} edges not supported by the pixels -> auto`); }
      supports.push(e?.support ?? 0);
    }
    let useShape = d0.shape !== 'none';
    if (useShape) {
      const sh = shapeSupport(bestShape.get(d0) || null); style.pixels.shape = sh;
      if (sh.support < 0.25) { useShape = false; d.shape = 'none'; style.decisions.push(`${d0.shape} not supported by the pixels (${sh.reason || `coverage ${sh.coverage}°, inliers ${sh.inlierRatio}`})`); }
      supports.push(sh.support);
    }
    const pix = supports.length ? supports.reduce((a, b) => a + b, 0) / supports.length : 0.6;
    style.evidence = +(0.6 * pix + 0.25 * (agree + 1) / 2 + 0.15 * conf).toFixed(3);
    if (style.evidence < 0.45 && d.simplify > 0.3) { d.simplify = 0.3; style.decisions.push('weak evidence -> careful (simplify 0.3)'); }
    const conflict = agree < 0 ? `directive contradicts visualIntent ${JSON.stringify(vi)}` : null;
    const entry = { section: d.section, reason: d.reason, confidence: d0.confidence, directive: { scope: d0.scope, edges: d0.edges, corners: d0.corners, shape: d0.shape, simplify: d0.simplify }, applied: { edges: d.edges, shape: d.shape, simplify: d.simplify }, style, chains: mine.length, changed: 0, arcs: 0, rejectedGeometry: 0, rejectedComplexity: 0, rejectedRough: 0, status: 'no-op', conflict };
    const before = mine.map((ci) => fits[ci]);
    entry.pointsBefore = points(before); entry.roughBefore = roughness(before); entry.curveBefore = ratio(before);
    const cand = fits.slice(), touched = [];
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ci of mine) {
      const ch = T.chains[ci], shape = conic.get(ci);
      const mv = moveOf(ch);
      const f = refitChain(ch, d, E, useShape && shape?.dir === d0 ? shape : null, mv);
      if (!f) continue;
      const D = densify(ch), s = d.simplify;
      // geometric gate vs the MEASURED boundary; a moved junction legitimately adds its own displacement near the end
      const moved = Math.max(mv.a ? Math.hypot(mv.a[0] - ch.points[0][0], mv.a[1] - ch.points[0][1]) : 0, mv.b ? Math.hypot(mv.b[0] - ch.points[ch.points.length - 1][0], mv.b[1] - ch.points[ch.points.length - 1][1]) : 0);
      const arcTol = (f.arc ? shape.tol : 0) + moved;
      if (!f.arc) dropFlatJoints(f, D, 0.55 + 0.8 * s + 0.2 * moved, 1.6 + 2.2 * s + 0.5 * moved);
      const te = traceError(D, f);
      if (te.sum / te.n > 0.55 + 0.8 * s + 0.5 * arcTol || te.max > 1.6 + 2.2 * s + arcTol) { entry.rejectedGeometry++; continue; }
      if (!f.arc && points([f]) > points([fits[ci]]) * 1.25 + 3) { entry.rejectedComplexity++; continue; }
      // polish must not make an edge wobblier than it was (knobs, hooks)
      if (roughness([f]) > roughness([fits[ci]]) * 1.3 + 0.1) { entry.rejectedRough++; continue; }
      cand[ci] = f; entry.changed++; if (f.arc) entry.arcs++; touched.push([ci, f.arc ? 'arc' : f.beziers ? 'curve' : 'line']);
      for (const p of ch.points) { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); }
    }
    if (!entry.changed) { entry.status = mine.length ? 'no-op' : 'no-chains'; entry.pointsAfter = entry.pointsBefore; entry.roughAfter = entry.roughBefore; entry.curveAfter = entry.curveBefore; report.push(entry); totals.chainsRejected += entry.rejectedGeometry + entry.rejectedComplexity + entry.rejectedRough; continue; }
    // pixel check in the changed area (bbox + 3 px): the share of pixels within ΔE 10 must not drop beyond a small allowance
    const ids2 = rasterizeTrace({ ...T, fits: cand });
    const x0 = Math.max(0, Math.floor(bb[0]) - 3), y0 = Math.max(0, Math.floor(bb[1]) - 3), x1 = Math.min(W, Math.ceil(bb[2]) + 3), y1 = Math.min(H, Math.ceil(bb[3]) + 3);
    let n = 0, g0 = 0, g1 = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * W + x; n++; if (good(ids[i], i)) g0++; if (good(ids2[i], i)) g1++; }
    entry.fidelityBefore = g0 / n; entry.fidelityAfter = g1 / n;
    const allow = 0.004 + 0.02 * d.simplify;
    const after = mine.map((ci) => cand[ci]);
    entry.pointsAfter = points(after); entry.roughAfter = roughness(after); entry.curveAfter = ratio(after);
    const lost = entry.fidelityBefore - entry.fidelityAfter > allow, rougher = entry.roughAfter > entry.roughBefore * 1.15 + 0.05;
    // ---- section acceptance score: hard gates passed; is the section measurably better? ----
    let noGain = false;
    if (!lost && !rougher && acceptance) {
      const affected = new Set();
      for (const [ci] of touched) for (const rid of [T.chains[ci].left, T.chains[ci].right]) if (rid >= 0) affected.add(assign.get(rid)?.path ?? 'background');
      const shapes = useShape && allShapes.get(d0)?.length ? new Map([[d0.section, allShapes.get(d0)]]) : null;
      const mB = measureSections({ ...T, fits }, assign, L, secMasks, null, { ids, only: affected, shapes });
      const mA = measureSections({ ...T, fits: cand }, assign, L, secMasks, null, { ids: ids2, only: affected, shapes });
      const dB = designedScores(mB, mB, ctx), dA = designedScores(mA, mB, ctx);
      // own section (and sub-sections) measure the gain; neighbours can only subtract (harm), never add
      let num = 0, den = 0, harm = 0;
      const own = (p) => p === d0.section || p.startsWith(d0.section + '.');
      for (const p of affected) {
        const b = dB.sections.get(p), a = dA.sections.get(p); if (!b || !a) continue;
        const imp = p === 'background' ? ctx.background.importance : nodeByPath.get(p)?.importance ?? 0.5, w = Math.max(0.05, imp) * Math.sqrt(Math.max(1, mB.sections.get(p).baseArea));
        if (own(p)) { num += w * (a.designed - b.designed); den += w; } else harm += w * Math.min(0, a.designed - b.designed);
      }
      if (den) num += harm; else { num = harm; den = 1; }
      if (typeof process !== 'undefined' && process.env?.ARU_DEBUG_ACCEPT === d0.section) for (const p of affected) { const b = dB.sections.get(p), a = dA.sections.get(p); console.log('ACCEPT', p, 'before', b.designed.toFixed(3), JSON.stringify(Object.fromEntries(Object.entries(b.components || {}).map(([k, v]) => [k, +v.toFixed(3)]))), 'after', a.designed.toFixed(3), 'pres', a.preservation.toFixed(3), JSON.stringify(Object.fromEntries(Object.entries(a.components || {}).map(([k, v]) => [k, +v.toFixed(3)])))); }
      const nodes = (fs) => fs.reduce((a, f) => a + f.segs.reduce((t, g) => t + (g.t === 'C' ? 1.5 : 1), 0), 0); // anchor nodes; a cubic's handles cost half a node
      const segsB = nodes(before), segsA = nodes(after);
      const dDesigned = den ? num / den : 0, complexity = (segsB - segsA) / Math.max(1, segsB); // primitives, not control points
      entry.improvement = +(dDesigned + 0.15 * complexity).toFixed(4);
      entry.designedDelta = +dDesigned.toFixed(4);
      noGain = entry.improvement <= (TAU[d0.confidence] ?? 0.003);
    }
    if (lost || rougher || noGain) {
      entry.status = lost ? 'rejected-pixels' : rougher ? 'rejected-rougher' : 'rejected-score';
      entry.pointsAfter = entry.pointsBefore; entry.roughAfter = entry.roughBefore; entry.curveAfter = entry.curveBefore;
      totals.rejected++;
    } else {
      entry.status = 'accepted';
      fits = cand; ids = ids2;
      for (const [ci, k] of touched) changedChains.set(ci, k);
      totals.accepted++; totals.chainsChanged += entry.changed;
    }
    totals.chainsRejected += entry.rejectedGeometry + entry.rejectedComplexity + entry.rejectedRough;
    report.push(entry);
  }
  totals.pointsBefore = points(T.fits); totals.pointsAfter = points(fits);
  junctionReport.spikesFinal = junctionSpikes(T.chains, fits, W, H).spikes;
  return { fits, report, totals, errors, directives, changedChains, junctions: junctionReport, shapes: shapeLog, endMoves };
}

// ---------------------------------------------------------------------------------------------------------------
// Re-fit one chain under a directive, from its measured (densified) pixel boundary.
function refitChain(ch, d, E, shape, mv = {}) {
  const D = densify(ch).map((p) => p.slice());
  if (mv.a) D[0] = mv.a.slice();
  if (mv.b) D[D.length - 1] = mv.b.slice();
  const island = ch.closed && !ch.atJunction;
  const pts = island ? D.slice(0, -1) : D.slice();
  const n = pts.length;
  if (n < 4) return null;
  const s = d.simplify, tol = lerp(0.9, 2.8, s);
  if (shape) return shape.shape ? arcFitGeneral(pts, island, shape, D) : arcFit(pts, island, shape, D);
  const cornerAngle = { keep: E.cornerAngle, sharp: E.cornerAngle - 12, soften: E.cornerAngle + 25, remove: 400 }[d.corners];
  const pinned = findCorners(pts, island, cornerAngle);
  let iters = Math.round(E.smoothIter * (0.6 + 1.6 * s));
  if (d.corners === 'remove' || d.corners === 'soften') iters = Math.round(iters * 1.3);
  const pinSet = new Set(island ? pinned : [0, ...pinned, n - 1]);
  const sm = taubin(pts, pinSet, iters, island);
  const at = (i) => sm[((i % n) + n) % n];
  const P = island ? pinned : [...new Set([0, ...pinned, n - 1])].sort((a, b) => a - b);
  const runs = [];
  if (island && !P.length) runs.push({ a: 0, b: n, closed: true });
  else { for (let j = 0; j + 1 < P.length; j++) runs.push({ a: P[j], b: P[j + 1] }); if (island) runs.push({ a: P[P.length - 1], b: P[0] + n }); }
  const segs = [];
  let beziers = 0, lines = 0;
  for (const r of runs) {
    const rp = []; for (let i = r.a; i <= r.b; i++) rp.push(at(i));
    const m = rp.length;
    if (m < 3) { segs.push({ t: 'L', p: rp[m - 1] }); lines++; continue; }
    let chordDev = 0; for (let i = 1; i < m - 1; i++) chordDev = Math.max(chordDev, segDist(rp[i], rp[0], rp[m - 1]));
    let mode = d.edges;
    if (mode === 'auto') mode = !r.closed && chordDev <= 0.8 * tol ? 'straight' : douglasPeucker(rp, tol).length - 1 <= 2 && !r.closed ? 'straight' : 'curved';
    if (r.closed && mode === 'straight' && douglasPeucker(rp, tol).length < 4) mode = 'curved';
    if (mode === 'curved' && !r.closed && chordDev <= 0.5 * tol) mode = 'straight'; // already a clean line: do not bend it
    if (mode === 'straight') {
      const keep = mergeCollinear(rp, douglasPeucker(rp, tol), tol);
      for (const k of keep.slice(1)) { segs.push({ t: 'L', p: rp[k] }); lines++; }
      continue;
    }
    const off = Math.max(1, Math.min(3, Math.floor((m - 1) / 3)));
    let t1 = norm(sub(rp[off], rp[0])), t2 = norm(sub(rp[m - 1 - off], rp[m - 1]));
    if (r.closed) { t1 = norm(sub(rp[1], rp[m - 2])); t2 = [-t1[0], -t1[1]]; }
    const out = [];
    fitCubic(rp, 0, m - 1, t1, t2, 0.7 * tol, out, 0);
    for (const c of out) segs.push({ t: 'C', c1: c[1], c2: c[2], p: c[3] });
    beziers += out.length;
  }
  return { start: at(runs[0].a), segs, beziers, lines, corners: P.length };
}

// interior points projected on the measured circle; endpoints (junctions) stay; cubics with circle tangents
function arcFit(pts, island, shape, D) {
  const n = pts.length;
  if (island) {
    const e = shape.kind === 'ellipse' ? shape : { cx: shape.cx, cy: shape.cy, a: shape.r, b: shape.r, theta: 0 };
    return { ...ellipseSegs(e, signedArea(D) < 0), beziers: 4, lines: 0, corners: 0, arc: true };
  }
  const { cx, cy, r } = shape;
  if (n < 10) return null; // too short to be an arc: a projection would only add a hook at the junction
  // junction endpoints never move; the projection eases in over ~6 px so the arc meets them without a hook
  const arcLen = [0]; for (let i = 1; i < n; i++) arcLen.push(arcLen[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = arcLen[n - 1], ramp = Math.min(6, total / 4);
  const proj = pts.map((p, i) => {
    const w = Math.min(1, Math.min(arcLen[i], total - arcLen[i]) / ramp);
    const dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx, dy) || 1;
    return [p[0] + w * (cx + dx * r / l - p[0]), p[1] + w * (cy + dy * r / l - p[1])];
  });
  const off = Math.min(3, Math.floor((n - 1) / 3));
  const t1 = norm(sub(proj[off], proj[0])), t2 = norm(sub(proj[n - 1 - off], proj[n - 1]));
  const out = [];
  fitCubic(proj, 0, n - 1, t1, t2, 0.6, out, 0);
  return { start: proj[0], segs: out.map((c) => ({ t: 'C', c1: c[1], c2: c[2], p: c[3] })), beziers: out.length, lines: 0, corners: 2, arc: true };
}

// general analytic fit: every point moves toward the shape by a weight that reflects how well it agrees with it
// (partial arcs: points on the eyelid line keep their place); endpoints never move (they are shared junctions)
function arcFitGeneral(pts, island, entry, D) {
  const sh = entry.shape, Tl = entry.tol, n = pts.length;
  const m = pts.map((p) => shapeDistance(sh, p));
  let w = m.map((x) => Math.max(0, Math.min(1, (2.5 * Tl - x.d) / Tl)));
  // smooth the weights along the chain (no abrupt switches between "on the circle" and "off")
  const sm = w.map((_, i) => { let a = 0, k = 0; for (let j = -2; j <= 2; j++) { const jj = island ? (i + j + n) % n : i + j; if (jj < 0 || jj >= n) continue; a += w[jj]; k++; } return a / k; });
  w = sm;
  const meanW = w.reduce((a, b) => a + b, 0) / n;
  if (meanW < 0.5) return null;
  if (island && meanW >= 0.9) {
    const e = sh.kind === 'ellipse' ? sh : { cx: sh.cx, cy: sh.cy, a: sh.r, b: sh.r, theta: 0 };
    return { ...ellipseSegs(e, signedArea(D) < 0), beziers: 4, lines: 0, corners: 0, arc: true };
  }
  const arcLen = [0]; for (let i = 1; i < n; i++) arcLen.push(arcLen[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = arcLen[n - 1];
  // ease-in near endpoints that are OFF the shape (the junction stays, the arc meets it without a hook)
  const e0 = m[0].d, e1 = m[n - 1].d, ramp0 = Math.min(6, total / 4) * Math.min(1, e0 / Tl), ramp1 = Math.min(6, total / 4) * Math.min(1, e1 / Tl);
  const proj = pts.map((p, i) => {
    if (!island && (i === 0 || i === n - 1)) return p;
    let wi = w[i];
    if (!island) { if (ramp0 > 0) wi *= Math.min(1, arcLen[i] / ramp0); if (ramp1 > 0) wi *= Math.min(1, (total - arcLen[i]) / ramp1); }
    return [p[0] + wi * (m[i].q[0] - p[0]), p[1] + wi * (m[i].q[1] - p[1])];
  });
  const out = [];
  if (island) {
    const rp = [...proj, proj[0]], t1 = norm(sub(proj[1], proj[n - 1]));
    fitCubic(rp, 0, n, t1, [-t1[0], -t1[1]], 0.6, out, 0);
  } else {
    const off = Math.min(3, Math.floor((n - 1) / 3)) || 1;
    fitCubic(proj, 0, n - 1, norm(sub(proj[off], proj[0])), norm(sub(proj[n - 1 - off], proj[n - 1])), 0.6, out, 0);
  }
  return { start: proj[0], segs: out.map((c) => ({ t: 'C', c1: c[1], c2: c[2], p: c[3] })), beziers: out.length, lines: 0, corners: 2, arc: true, arcWeight: meanW };
}

// apply junction moves to every chain that ends at a moved vertex
function applyMoves(chains, fits, moves) {
  return fits.map((f, ci) => {
    const ch = chains[ci];
    if (ch.closed && !ch.atJunction) return f;
    const a = moves.get(vkey(ch.points[0])), b = moves.get(vkey(ch.points[ch.points.length - 1]));
    if (!a && !b) return f;
    const g = shiftFit(f, a ? [a.to[0] - a.from[0], a.to[1] - a.from[1]] : null, b ? [b.to[0] - b.from[0], b.to[1] - b.from[1]] : null);
    // a moved endpoint can leave two lines nearly collinear: drop that joint if the outline stays on the measured boundary
    const mv = Math.max(a ? Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]) : 0, b ? Math.hypot(b.to[0] - b.from[0], b.to[1] - b.from[1]) : 0);
    return g.segs.length > 1 ? dropFlatJoints({ ...g, segs: g.segs.slice() }, densify(ch), 0.6 + 0.5 * mv, 1.8 + mv) : g;
  });
}

// multi-scale persistent corners (same rule as the edge regularizer, with the directive's threshold)
function findCorners(pts, island, cornerAngle, k = 4) {
  const n = pts.length;
  if (cornerAngle >= 180 || n < 2 * k + 1) return [];
  const pre = taubin(pts, new Set(island ? [] : [0, n - 1]), 2, island);
  const angleAt = (i, kk) => {
    if (!island && (i - kk < 0 || i + kk > n - 1)) return null;
    const p = pre[(i - kk + n) % n], c = pre[i], q = pre[(i + kk) % n];
    const v1 = sub(c, p), v2 = sub(q, c), l1 = len(v1), l2 = len(v2);
    if (!l1 || !l2) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))) * 180 / Math.PI;
  };
  const ang = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = angleAt(i, k); if (a === null) continue; const b = angleAt(i, 2 * k); ang[i] = b === null ? a * 0.85 : Math.min(a, b / 0.75); }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (ang[i] <= cornerAngle) continue;
    let isMax = true;
    for (let j = -k; j <= k && isMax; j++) { if (!j) continue; const jj = island ? (i + j + n) % n : i + j; if (jj < 0 || jj >= n) continue; if (ang[jj] > ang[i] || (ang[jj] === ang[i] && j < 0)) isMax = false; }
    if (isMax && (island || (i > 0 && i < n - 1))) out.push(i);
  }
  return out;
}

// line-line joints that turn < 12° (between two runs, or left by DP) are vertices a designer would not place:
// remove them while the outline stays within the same geometric gate
function dropFlatJoints(f, D, meanTol, maxTol) {
  for (let guard = 0; guard < 50; guard++) {
    let removed = false;
    let p = f.start;
    for (let i = 0; i + 1 < f.segs.length; i++) {
      const s1 = f.segs[i], s2 = f.segs[i + 1];
      if (s1.t === 'L' && s2.t === 'L') {
        const a = sub(s1.p, p), b = sub(s2.p, s1.p);
        const ang = Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * 180 / Math.PI;
        if (ang < 12) {
          const trial = { ...f, segs: [...f.segs.slice(0, i), ...f.segs.slice(i + 1)] };
          const te = traceError(D, trial);
          if (te.sum / te.n <= meanTol && te.max <= maxTol) { f.segs = trial.segs; f.lines--; removed = true; break; }
        }
      }
      p = s1.p;
    }
    if (!removed) return f;
  }
  return f;
}

// drop DP vertices whose two lines are nearly collinear and whose union stays within tolerance
function mergeCollinear(pts, keep, tol) {
  const k = keep.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let j = 1; j + 1 < k.length; j++) {
      const A = pts[k[j - 1]], M = pts[k[j]], B = pts[k[j + 1]];
      const v1 = sub(M, A), v2 = sub(B, M);
      const turn = Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1])) * 180 / Math.PI;
      if (turn >= 14) continue;
      let dmax = 0; for (let i = k[j - 1] + 1; i < k[j + 1]; i++) dmax = Math.max(dmax, segDist(pts[i], A, B));
      if (dmax <= (turn < 8 ? 1.5 * tol : tol)) { k.splice(j, 1); changed = true; break; }
    }
  }
  return k;
}

// Deterministic consensus circle: circumcircles of point triples taken at fixed strides along the outlines, scored
// by inliers; the best one is refined by a Kåsa fit on its inliers. Occluded parts are simply outliers.
export function consensusCircle(all, tol, maxR) {
  const N = all.length;
  if (N < 24) return null;
  const step = Math.max(1, Math.floor(N / 500)), pts = all.filter((_, i) => i % step === 0), n = pts.length;
  // a big circle may wobble more in absolute pixels than a small one (same relative precision)
  const tolFor = (r) => tol * Math.max(1, Math.sqrt(r / 40));
  const inliersOf = (c, set) => set.filter((p) => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) <= 1.5 * tolFor(c.r));
  let best = null, bestN = 0;
  for (let k = 0; k < 240; k++) {
    const a = (k * 7919) % n, b = (a + Math.floor(n / 3) + k * 31) % n, c = (a + Math.floor((2 * n) / 3) + k * 17) % n;
    const cc = circumcircle(pts[a], pts[b], pts[c]);
    if (!cc || cc.r < 2.5 || cc.r > maxR) continue;
    const m = inliersOf(cc, pts).length;
    if (m > bestN) { bestN = m; best = cc; }
  }
  if (!best) return null;
  let c = best, use = inliersOf(c, all);
  for (let it = 0; it < 3; it++) { const k = kasa(use); if (!k || k.r > maxR) break; c = k; use = inliersOf(c, all); }
  if (use.length < Math.max(20, 0.3 * N)) return null;
  let se = 0; for (const p of use) se += (Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) ** 2;
  const rms = Math.sqrt(se / use.length);
  // the circle must cover a real arc (>= 120°), not a nearly straight piece of a huge circle
  const angs = use.map((p) => Math.atan2(p[1] - c.cy, p[0] - c.cx)).sort((x, y) => x - y);
  let gap = angs[0] + 2 * Math.PI - angs[angs.length - 1];
  for (let i = 1; i < angs.length; i++) gap = Math.max(gap, angs[i] - angs[i - 1]);
  const span = 2 * Math.PI - gap;
  return rms <= tolFor(c.r) && span >= (2 * Math.PI) / 3 ? { cx: c.cx, cy: c.cy, r: c.r, rms, span, tol: tolFor(c.r) } : null;
}
function circumcircle(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) };
}
function kasa(pts) {
  const n = pts.length; if (n < 6) return null;
  let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) { const u = p[0] - mx, v = p[1] - my; suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
  const det = suu * svv - suv * suv; if (Math.abs(det) < 1e-9) return null;
  const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
  const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

// ---------------------------------------------------------------------------------------------------------------
export function points(fits) { return fits.reduce((s, f) => s + f.segs.reduce((t, g) => t + (g.t === 'L' ? 1 : 3), 0), 0); }
function ratio(fits) { let b = 0, l = 0; for (const f of fits) for (const s of f.segs) if (s.t === 'C') b++; else l++; return b / Math.max(1, b + l); }
// turning per 10 px along the output geometry (same definition as polishMetrics.edgeRoughness)
export function roughness(fits) {
  let turn = 0, length = 0;
  for (const f of fits) {
    const pts = [f.start];
    let cur = f.start;
    for (const s of f.segs) { if (s.t === 'L') pts.push(s.p); else { const b = [cur, s.c1, s.c2, s.p]; for (let i = 1; i <= 8; i++) pts.push(bez(b, i / 8)); } cur = s.p; }
    for (let i = 1; i < pts.length; i++) {
      const a = sub(pts[i], pts[i - 1]), la = len(a); length += la;
      if (i + 1 < pts.length) { const b = sub(pts[i + 1], pts[i]); if (la && len(b)) turn += Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])); }
    }
  }
  return length ? (turn / length) * 10 : 0;
}
