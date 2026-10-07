// Parameter sweep for ReferenceTracer on one image: how fidelity trades against geometry size.
import { decodePNG } from './png.mjs';
import { traceImage } from '../trace/index.js';
import { approxTokens } from '../src/metrics.js';
const file = process.argv[2] || 'references/wolf.png';
const raw = decodePNG(file);
const runs = [
  ['colors', [4, 6, 8, 12, 16, 24, 32]],
  ['simplification', [0.5, 1, 2, 3]],
  ['minRegionArea', [0, 5, 20, 80, 300]],
  ['curveTolerance', [0.5, 1.5, 3, 6]],
];
const pad = (s, n) => String(s).padStart(n);
console.log(`== sweep ${file} (defaults: colors 12, simplification 1, minRegionArea 20, curveTolerance 1.5)`);
console.log(`${'param'.padEnd(15)}${pad('value', 6)}${pad('regions', 8)}${pad('rawPts', 8)}${pad('outPts', 7)}${pad('bez', 5)}${pad('compr', 7)}${pad('meanErr', 8)}${pad('maxErr', 7)}${pad('agree%', 7)}${pad('within30%', 10)}${pad('colorErr', 9)}${pad('tokens', 8)}${pad('ms', 6)}`);
for (const [k, vals] of runs) for (const v of vals) {
  const r = traceImage(raw, { [k]: v }), m = r.metrics;
  console.log(`${k.padEnd(15)}${pad(v, 6)}${pad(m.regions, 8)}${pad(m.rawContourPoints, 8)}${pad(m.outputPoints, 7)}${pad(m.bezierSegments, 5)}${pad(m.compressionRatio.toFixed(1), 7)}${pad(m.meanTraceError.toFixed(2), 8)}${pad(m.maxTraceError.toFixed(2), 7)}${pad((m.regionAgreement * 100).toFixed(1), 7)}${pad((m.pixelsWithin30 * 100).toFixed(1), 10)}${pad(m.meanColorErrorVector.toFixed(1), 9)}${pad(approxTokens(r.aru), 8)}${pad(m.totalMs.toFixed(0), 6)}`);
}
