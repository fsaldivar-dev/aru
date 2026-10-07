// ReferenceTracer: Image -> quantize -> regions -> contours -> simplify -> Bézier -> ARU Geometry.
// Independent of Blueprint / ProceduralCompiler. Every stage is deterministic and timed.
import { normalizeImage } from './image.js';
import { quantize } from './quantize.js';
import { findRegions } from './regions.js';
import { extractContours } from './contours.js';
import { simplifyChain } from './simplify.js';
import { fitChain, traceError } from './bezier.js';
import { compileTrace } from './compiler.js';
import { fidelity } from './raster.js';

export const DEFAULTS = { maxSide: 600, colors: 12, smooth: 1, simplification: 1.0, minRegionArea: 20, curveTolerance: 1.5, cornerAngle: 50, mode: 'stack' };

export function traceImage(raw, options = {}) {
  const o = { ...DEFAULTS, ...options }, t = {};
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let t0 = now();
  const img = normalizeImage(raw, { maxSide: o.maxSide }); t.normalize = now() - t0; t0 = now();
  const q = quantize(img, { colors: o.colors, smooth: o.smooth }); t.quantize = now() - t0; t0 = now();
  const reg = findRegions(q, img, { minRegionArea: o.minRegionArea }); t.regions = now() - t0; t0 = now();
  const con = extractContours(reg); t.contours = now() - t0; t0 = now();
  const simp = con.chains.map((c) => simplifyChain(c, o.simplification)); t.simplify = now() - t0; t0 = now();
  const fits = simp.map((s) => fitChain(s, { curveTolerance: o.curveTolerance, cornerAngle: o.cornerAngle })); t.bezier = now() - t0; t0 = now();
  // trace error per chain, then per region (max over the chains of its loops)
  const errs = simp.map((s, i) => traceError(s.dense, fits[i]));
  for (const r of reg.regions) {
    r.traceError = 0;
    for (const loop of [r.outer, ...r.holeLoops]) for (const ref of loop.refs) r.traceError = Math.max(r.traceError, errs[ref.chain].max);
  }
  const T = { width: img.width, height: img.height, ids: reg.ids, regions: reg.regions, chains: con.chains, simp, fits, palette: q.paletteHex };
  t.errors = now() - t0; t0 = now();
  const out = compileTrace(T, { outWidth: img.sourceWidth, outHeight: img.sourceHeight, mode: o.mode }); t.compile = now() - t0; t0 = now();
  const fid = fidelity(T, img); t.fidelity = now() - t0;

  const simplifiedPoints = simp.reduce((s, x) => s + x.keep.length - 1, 0);
  const bezierSegments = fits.reduce((s, f) => s + f.beziers, 0), lineSegments = fits.reduce((s, f) => s + f.lines, 0);
  const outputPoints = lineSegments + 3 * bezierSegments;
  const errSum = errs.reduce((s, e) => s + e.sum, 0), errN = errs.reduce((s, e) => s + e.n, 0);
  const metrics = {
    regions: reg.regions.length, mergedSmallRegions: reg.merged, paletteSize: q.palette.length, chains: con.chains.length,
    rawContourPoints: con.rawPoints, densePoints: errN, simplifiedPoints, bezierSegments, lineSegments, outputPoints,
    compressionRatio: con.rawPoints / Math.max(1, outputPoints),
    meanTraceError: errSum / Math.max(1, errN), maxTraceError: Math.max(0, ...errs.map((e) => e.max)),
    ...fid, timings: t, totalMs: Object.values(t).reduce((a, b) => a + b, 0),
  };
  return { options: o, img, q, reg, con, simp, fits, T, scene: out.scene, aru: out.aru, metrics };
}
