// CLI: node tools/trace.mjs references/wolf.png [--colors 12 --simplification 1 --minRegionArea 20 --curveTolerance 1.5] [--out out/wolf-trace]
import fs from 'node:fs';
import { decodePNG } from './png.mjs';
import { traceImage } from '../trace/index.js';
import { renderScene } from '../src/render.js';
import { approxTokens } from '../src/metrics.js';

const file = process.argv[2] || 'references/wolf.png';
const opt = {};
for (const k of ['colors', 'simplification', 'minRegionArea', 'curveTolerance', 'cornerAngle', 'maxSide', 'smooth']) {
  const i = process.argv.indexOf('--' + k); if (i > 0) opt[k] = Number(process.argv[i + 1]);
}
const outBase = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const res = traceImage(decodePNG(file), opt);
const m = res.metrics;
const svg = renderScene(res.scene, { dataAttrs: false });
if (outBase) { fs.writeFileSync(outBase + '.svg', svg); fs.writeFileSync(outBase + '.aru', res.aru); }
const f = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : v);
console.log(`== ReferenceTracer: ${file} ${JSON.stringify(res.options)}`);
for (const k of ['paletteSize', 'regions', 'mergedSmallRegions', 'chains', 'rawContourPoints', 'densePoints', 'simplifiedPoints', 'lineSegments', 'bezierSegments', 'outputPoints', 'compressionRatio', 'meanTraceError', 'maxTraceError', 'meanColorErrorRegions', 'meanColorErrorVector', 'pixelsWithin30', 'regionAgreement', 'uncovered'])
  console.log(`${k.padStart(24)}  ${f(m[k])}`);
console.log(`${'ARU geometry'.padStart(24)}  ${res.aru.length} chars, ~${approxTokens(res.aru)} tokens`);
console.log(`${'timings ms'.padStart(24)}  ${Object.entries(m.timings).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}  · total ${m.totalMs.toFixed(0)}`);
