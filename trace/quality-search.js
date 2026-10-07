// Automatic quality search: reach a target WEIGHTED fidelity with as little geometry as possible.
// Bounded loop (no grid search):
//   1. trace with the plan for `quality`
//   2. measure the weighted error map, aggregated per context zone
//   3. take the zones with the largest weighted error mass (Σ importance·ΔE) that are still below target
//   4. give them more budget: local colors, smaller min-area, finer geometry; background errors -> +2 global colors
//   5. re-trace (cached stages) and repeat until target, budget or iteration limit
import { traceGuided } from './guided.js';

export function qualitySearch(prep, { targetFidelity = 0.95, quality = 0.6, maxIterations = 6, topZones = 2, onStep = null } = {}) {
  const overrides = { zones: {}, globalColorBoost: 0 };
  const history = [], exhausted = new Set(), lastFid = new Map();
  let res = null, best = null, stall = 0, prevW = -1;
  for (let it = 0; it <= maxIterations; it++) {
    res = traceGuided(prep, { quality, overrides: JSON.parse(JSON.stringify(overrides)) });
    const m = res.metrics;
    const entry = { iteration: it, weightedFidelity: m.weightedFidelity, pixelFidelity: m.pixelFidelity, regions: m.regions, outputPoints: m.outputPoints, globalColors: m.globalColors, localColors: m.localColors, changes: [] };
    history.push(entry);
    const meets = (r) => r.metrics.weightedFidelity >= targetFidelity;
    if (!best || (meets(res) && (!meets(best) || m.outputPoints < best.metrics.outputPoints)) || (!meets(best) && m.weightedFidelity > best.metrics.weightedFidelity)) best = res;
    onStep?.(entry, res);
    if (m.weightedFidelity >= targetFidelity) { entry.changes.push('target reached'); break; }
    if (m.outputPoints > res.plan.budget.maxPoints * 1.5 || m.regions > res.plan.budget.maxRegions * 1.5) { entry.changes.push('complexity budget exhausted'); break; }
    stall = m.weightedFidelity - prevW < 0.002 ? stall + 1 : 0; prevW = m.weightedFidelity;
    if (stall >= 2) { entry.changes.push('no further improvement'); break; }
    if (it === maxIterations) break;
    // zones that did not improve after their last refinement are exhausted
    for (const z of res.errorMaps.zones) if (lastFid.has(z.owner) && z.fidelity - lastFid.get(z.owner) < 0.003) exhausted.add(z.owner);
    const zones = res.errorMaps.zones.filter((z) => z.fidelity < targetFidelity && z.n > 20 && !exhausted.has(z.owner)).slice(0, topZones);
    if (!zones.length) { entry.changes.push('all zones exhausted'); break; }
    let boosted = false;
    for (const z of zones) {
      lastFid.set(z.owner, z.fidelity);
      const node = z.owner >= 0 ? prep.ctx.nodes[z.owner] : null;
      const name = node ? node.path : 'background';
      const colorShare = z.colorLoss / Math.max(1e-9, z.colorLoss + z.geomLoss);
      if (colorShare >= 0.6) {
        // the error is in the COLORS: more palette, not more points
        if (!node || node.importance < 0.55) { if (!boosted) { overrides.globalColorBoost = Math.min(overrides.globalColorBoost + 2, 12); boosted = true; } entry.changes.push(`${name}: color error ${(colorShare * 100).toFixed(0)}% → +2 global colors`); }
        else { const o = (overrides.zones[name] ||= { extraColors: 0, areaScale: 1, geomScale: 1 }); o.extraColors = Math.min(o.extraColors + 1, 4); o.areaScale *= 0.7; entry.changes.push(`${name}: color error ${(colorShare * 100).toFixed(0)}% → +1 local color, min-area ×0.7`); }
      } else {
        // the error is in the SHAPES: finer geometry and keep smaller regions there
        const o = (overrides.zones[name] ||= { extraColors: 0, areaScale: 1, geomScale: 1 }); o.areaScale *= 0.6; o.geomScale *= 0.7;
        entry.changes.push(`${name}: geometry error ${((1 - colorShare) * 100).toFixed(0)}% → min-area ×0.6, tolerance ×0.7`);
      }
    }
  }
  return { result: best, last: res, history, overrides };
}
