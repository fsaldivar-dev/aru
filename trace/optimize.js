// Automatic optimization for the regularized trace (bounded, deterministic):
//   score = wF·weightedFidelity + wP·polish − wC·complexity, weights set by the REQUESTED abstraction.
// Measured: with abstraction itself as a free variable the score grows monotonically with it (fidelity is nearly
// flat, polish and simplicity keep improving), so the search would always pick the most abstract candidate.
// Abstraction is therefore treated as the user's STYLE decision and kept fixed; the search tunes the budget
// (quality) at that abstraction. `spread` > 0 still allows exploring neighbours explicitly.
import { traceGuided } from './guided.js';
import { polishMetrics, optimizationScore } from './polish.js';

export function optimizeTrace(prep, { abstraction = 0.5, qualities = [0.55, 0.7, 0.85], spread = 0, onStep = null } = {}) {
  const tried = [];
  let best = null;
  for (const a of [...new Set([abstraction - spread, abstraction, abstraction + spread])].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100)) {
    for (const q of qualities) {
      const r = traceGuided(prep, { quality: q, regularize: true, abstraction: a });
      const p = polishMetrics(r.T, r.assign);
      const score = optimizationScore(r.metrics.weightedFidelity, p.polishScore, r.metrics.outputPoints, abstraction);
      const entry = { abstraction: a, quality: q, score, weightedFidelity: r.metrics.weightedFidelity, polish: p.polishScore, regions: r.metrics.regions, outputPoints: r.metrics.outputPoints };
      tried.push(entry); onStep?.(entry);
      // fidelity floor: abstraction may trade fidelity for cleanliness, but not without limit
      const floor = 0.92 - 0.12 * abstraction;
      entry.meetsFloor = r.metrics.weightedFidelity >= floor;
      const better = !best || (entry.meetsFloor && !best.entry.meetsFloor) || (entry.meetsFloor === best.entry.meetsFloor && score > best.entry.score);
      if (better) best = { entry, result: r, polish: p };
    }
  }
  return { ...best, tried };
}
