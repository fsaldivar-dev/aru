// Vision-guided trace. Same measuring pipeline as traceImage (shared contours, DP, Schneider, raster fidelity);
// the VisualContext only changes WHERE the budget goes:
//   ImportanceMap -> TracePlan -> adaptive quantization -> saliency-aware merging -> per-edge tolerances
//   -> error maps -> semantic assignment -> semantic ARU.
import { normalizeImage } from './image.js';
import { findRegions } from './regions.js';
import { extractContours } from './contours.js';
import { simplifyChain } from './simplify.js';
import { fitChain, traceError } from './bezier.js';
import { compileSemantic, compileTrace } from './compiler.js';
import { importanceMap } from '../vision/importance.js';
import { makePlan } from './plan.js';
import { adaptiveQuantize } from './adaptive-quantize.js';
import { persistenceModel } from './persistence.js';
import { makeSaliencyDecider, budgetMerge } from './saliency.js';
import { chainTolerances } from './adaptive-simplify.js';
import { errorMaps } from './error-map.js';
import { semanticize } from './semanticize.js';
import { regularizeRegions } from './regularize.js';
import { regularizeChains } from './edges.js';
import { bilateral } from './prefilter.js';
import { harmonizeSymmetry } from './symmetry.js';
import { labImage } from './quantize.js';
import { polishSections, validateDirectives } from './section-polish.js';
import { polishRegions } from './region-polish.js';
import { detectThin } from './thin.js';
import { sectionMasks, measureSections, designedScores } from './designed.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function prepare(raw, ctx, { maxSide = 600 } = {}) {
  const img = normalizeImage(raw, { maxSide });
  const imp = importanceMap(ctx, img.width, img.height);
  return { img, imp, ctx, cache: new Map() };
}

export function traceGuided(prep, { quality = 0.75, overrides = {}, semantic = true, regularize = false, abstraction = 0.5, symmetryStrength = null, polish = null, polishOptions = {}, thin = null } = {}) {
  const t = {};
  let t0 = now();
  const { img, imp, ctx } = prep;
  const plan = makePlan(ctx, imp, { quality, overrides }); t.plan = now() - t0; t0 = now();
  // regularized traces quantize an edge-preserving filtered copy (JPEG blocks, AA noise); colors/fidelity use the original
  let qimg = img;
  if (regularize && !(typeof process !== 'undefined' && process.env?.ARU_NO_PREFILTER)) {
    const key = `bilateral${abstraction}`;
    qimg = prep.cache.get(key) || bilateral(img, prep.cache.get('lab') || (prep.cache.set('lab', labImage(img)), prep.cache.get('lab')), { sigmaR: 6 + 6 * abstraction });
    prep.cache.set(key, qimg);
  }
  t.prefilter = now() - t0; t0 = now();
  // thin features (polish mode, or explicit `thin`): detected on the ORIGINAL pixels, protected through quantization and merging
  const useThin = thin ?? (!!polish && regularize && polishOptions.thin !== false);
  let thinInfo = null;
  if (useThin) { const lab0 = prep.cache.get('lab') || (prep.cache.set('lab', labImage(img)), prep.cache.get('lab')); thinInfo = prep.cache.get('thin') || detectThin(img, lab0); prep.cache.set('thin', thinInfo); }
  const thinMask = thinInfo?.mask || null;
  const q = adaptiveQuantize(qimg, plan, { cache: prep.cache, cacheKey: regularize ? `f${abstraction}` : '', thinMask });
  q.thinMask = thinMask;
  if (qimg !== img) q.lab = prep.cache.get('lab'); // downstream color statistics use the ORIGINAL pixels
  t.quantize = now() - t0; t0 = now();
  const persistence = persistenceModel(img, q.labelLab); t.persistence = now() - t0; t0 = now();
  const sal = makeSaliencyDecider({ plan, labelLab: q.labelLab, persistence, W: img.width, thinMask });
  let reg = findRegions(q, img, { decide: sal.decide, candidateArea: Math.ceil(plan.budget.minRegionArea * 2) });
  const bm = budgetMerge(reg, plan, q.labelLab, persistence, findRegions, q, img, thinMask);
  reg = bm.reg; sal.stats.budgetMerged = bm.merged;
  t.regions = now() - t0; t0 = now();
  let regStats = null;
  if (regularize) { const rr = regularizeRegions(reg, img, q.lab, plan, { abstraction, thinMask }); reg = rr.reg; regStats = rr.stats; }
  t.regularize = now() - t0; t0 = now();
  // geometry from a region map: contours -> edges -> semantics -> symmetry (run again if Region Polish changes topology)
  const geometry = (reg) => {
    const con = extractContours(reg); t.contours = (t.contours || 0) + now() - t0; t0 = now();
    const regionsById = new Map(reg.regions.map((r) => [r.id, r]));
    const chainInfo = [], simp = [];
    let fits = [], edgeStats = null;
    if (regularize) {
      // intent of a chain = visualIntent of the more important context node among its two regions (validated later by the pixels)
      const owner = regionOwners(reg, imp);
      const nodeOf = (rid) => (owner.get(rid) >= 0 ? ctx.nodes[owner.get(rid)] : null);
      const intentFor = (c) => { const a = nodeOf(c.left), b = nodeOf(c.right); const n = !a ? b : !b ? a : (a.importance >= b.importance ? a : b); return n?.visualIntent || null; };
      const er = regularizeChains(con.chains, { abstraction, intentFor, width: img.width, height: img.height });
      simp.push(...er.simp); fits = er.fits; edgeStats = er.stats;
    } else for (const c of con.chains) {
      const s0 = simplifyChain(c, 1); // dense polyline is independent of ε
      const tol = chainTolerances(c, s0.dense, regionsById, plan);
      const s = simplifyChain(c, tol.eps);
      simp.push(s); chainInfo.push(tol);
      fits.push(fitChain(s, { curveTolerance: tol.curve, gain: tol.curveGain }));
    }
    t.geometry = (t.geometry || 0) + now() - t0; t0 = now();
    const errs = simp.map((s, i) => traceError(s.dense, fits[i]));
    for (const r of reg.regions) { r.traceError = 0; for (const loop of [r.outer, ...r.holeLoops]) for (const ref of loop.refs) r.traceError = Math.max(r.traceError, errs[ref.chain].max); }
    const T = { width: img.width, height: img.height, ids: reg.ids, regions: reg.regions, regionsById, chains: con.chains, simp, fits, palette: q.paletteHex };
    const assign = semanticize(T, ctx); t.semanticize = (t.semanticize || 0) + now() - t0; t0 = now();
    let symStats = null;
    if (regularize) {
      symStats = harmonizeSymmetry(T, assign, ctx, symmetryStrength ?? 0.3 + 0.5 * abstraction);
      t.regularize += now() - t0; t0 = now();
    }
    return { con, chainInfo, simp, fits, edgeStats, errs, T, assign, symStats };
  };
  let G = geometry(reg);
  let regionPolish = null, sectionPolish = null;
  if (polish && regularize) {
    // Region Polish (topology): region intents + semantic consolidation, gated by the pixels; then geometry again
    const lab = prep.cache.get('lab') || (prep.cache.set('lab', labImage(img)), prep.cache.get('lab'));
    const { directives } = validateDirectives(polish, ctx);
    const ropts = { consolidate: polishOptions.consolidate !== false, thinMask: q.thinMask || null };
    regionPolish = polishRegions(reg, G.assign, ctx, img, lab, imp, directives, ropts);
    if (regionPolish.changed) {
      let G2 = geometry(regionPolish.reg);
      // acceptance: a section whose designedScore drops after its merges keeps its original regions
      if (polishOptions.acceptance !== false) {
        const masks = sectionMasks(G.T, G.assign);
        const mB = measureSections(G.T, G.assign, lab, masks, imp), mA = measureSections(G2.T, G2.assign, lab, masks, imp);
        const dB = designedScores(mB, mB, ctx), dA = designedScores(mA, mB, ctx);
        const worse = new Set();
        for (const e of regionPolish.report) { if (!e.merged) continue; const b = dB.sections.get(e.section), a = dA.sections.get(e.section); e.designedBefore = +(b?.designed ?? 0).toFixed(3); e.designedAfter = +(a?.designed ?? 0).toFixed(3); if (a && b && a.designed < b.designed - 0.005) worse.add(e.section); }
        if (worse.size) {
          const retry = polishRegions(reg, G.assign, ctx, img, lab, imp, directives, { ...ropts, exclude: worse });
          retry.reverted = [...worse];
          for (const e of retry.report) { const old = regionPolish.report.find((x) => x.section === e.section); if (old) { e.designedBefore = old.designedBefore; e.designedAfter = worse.has(e.section) ? old.designedBefore : old.designedAfter; } }
          regionPolish = retry;
          G2 = regionPolish.changed ? geometry(regionPolish.reg) : G;
        }
      }
      reg = regionPolish.changed ? regionPolish.reg : reg; G = G2;
    }
    t.regionPolish = now() - t0; t0 = now();
  }
  const { con, chainInfo, simp, edgeStats, errs, T, assign, symStats } = G;
  let { fits } = G;
  if (polish) {
    // Section Polish: per-section directives (from a PolishProvider) re-fit chains; measured, accepted or rejected
    const lab = prep.cache.get('lab') || (prep.cache.set('lab', labImage(img)), prep.cache.get('lab'));
    sectionPolish = polishSections(T, assign, ctx, img, polish, { abstraction, lab, ...polishOptions });
    fits = sectionPolish.fits; T.fits = fits;
    const errs2 = simp.map((s, i) => traceError(s.dense, fits[i]));
    errs.splice(0, errs.length, ...errs2);
    for (const r of reg.regions) { r.traceError = 0; for (const loop of [r.outer, ...r.holeLoops]) for (const ref of loop.refs) r.traceError = Math.max(r.traceError, errs[ref.chain].max); }
    t.sectionPolish = now() - t0; t0 = now();
  }
  const em = errorMaps(T, img, imp); t.errorMaps = now() - t0; t0 = now();
  const out = semantic ? compileSemantic(T, assign, ctx, { outWidth: img.sourceWidth, outHeight: img.sourceHeight }) : compileTrace(T, { outWidth: img.sourceWidth, outHeight: img.sourceHeight });
  t.compile = now() - t0;
  return { img, imp, plan, q, reg, con, simp, fits, chainInfo, T, errorMaps: em, assign, saliency: sal.stats, regularizer: regStats, edges: edgeStats, symmetry: symStats, regionPolish, sectionPolish, thin: thinInfo && { pixels: thinInfo.pixels, components: thinInfo.components.length }, scene: out.scene, aru: out.aru, metrics: summarize(T, con, simp, fits, errs, em, out.aru, t, q) };
}

// Measure a plain (global) trace with the same importance map, for fair comparisons
export function measureGlobal(res, imp) {
  const T = { ...res.T, regionsById: new Map(res.T.regions.map((r) => [r.id, r])) };
  const em = errorMaps(T, res.img, imp);
  const errs = res.simp.map((s, i) => traceError(s.dense, res.fits[i]));
  return summarize(T, res.con, res.simp, res.fits, errs, em, res.aru, res.metrics.timings, res.q);
}

export function summarize(T, con, simp, fits, errs, em, aru, timings, q) {
  const bezierSegments = fits.reduce((s, f) => s + f.beziers, 0), lineSegments = fits.reduce((s, f) => s + f.lines, 0);
  const outputPoints = lineSegments + 3 * bezierSegments;
  const errSum = errs.reduce((s, e) => s + e.sum, 0), errN = errs.reduce((s, e) => s + e.n, 0);
  return {
    ...em.metrics,
    regions: T.regions.length, paths: T.regions.length, chains: con.chains.length,
    globalColors: q.globalColors ?? q.palette.length, localColors: q.localColors ?? 0,
    rawContourPoints: con.rawPoints, simplifiedPoints: simp.reduce((s, x) => s + x.keep.length - 1, 0),
    bezierSegments, lineSegments, outputPoints, compressionRatio: con.rawPoints / Math.max(1, outputPoints),
    meanTraceError: errSum / Math.max(1, errN), maxTraceError: Math.max(0, ...errs.map((e) => e.max)),
    aruBytes: new TextEncoder().encode(aru).length, timings, traceMs: Object.values(timings).reduce((a, b) => a + b, 0),
  };
}

function regionOwners(reg, imp) {
  const counts = new Map();
  for (let i = 0; i < reg.ids.length; i++) { const id = reg.ids[i]; let m = counts.get(id); if (!m) counts.set(id, (m = new Map())); const o = imp.owner[i]; m.set(o, (m.get(o) || 0) + 1); }
  const out = new Map();
  for (const [id, m] of counts) { let o = -1, c = -1; for (const [k, v] of m) if (v > c) { c = v; o = k; } out.set(id, o); }
  return out;
}
