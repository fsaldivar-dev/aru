// Benchmark for the Perceptual Regularizer: raw vision-guided trace vs regularized at several abstraction levels.
//   node tools/regularize-bench.mjs [image.png] [context.json] [--tag name]
import fs from 'node:fs';
import { decodePNG } from './png.mjs';
import { ManualVisionProvider } from '../vision/manual-provider.js';
import { runVision } from '../vision/provider.js';
import { prepare, traceGuided } from '../trace/guided.js';
import { polishMetrics } from '../trace/polish.js';
import { renderScene } from '../src/render.js';
import { applyOperation, selectNodes } from '../src/ops.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const file = args[0] || 'references/wolf.png', ctxFile = args[1] || 'references/wolf.context.json';
const tag = process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : 'wolf';
const raw = decodePNG(file);
const ctxJson = fs.existsSync(ctxFile) ? JSON.parse(fs.readFileSync(ctxFile, 'utf8')) : { version: 1, scene: 'unknown', background: { importance: 0.5 }, objects: [] };
const vision = await runVision(new ManualVisionProvider(ctxJson), raw);
const prep = prepare(raw, vision.context);
const configs = [['raw guided', { regularize: false }], ['A=0.25', { regularize: true, abstraction: 0.25 }], ['A=0.50', { regularize: true, abstraction: 0.5 }], ['A=0.75', { regularize: true, abstraction: 0.75 }]];
const rows = [];
for (const [name, o] of configs) {
  const r = traceGuided(prep, { quality: 0.75, ...o });
  const p = polishMetrics(r.T, r.assign);
  let editOk = '–';
  if (vision.context.nodes.some((n) => n.type === 'iris')) {
    const sel = selectNodes(r.scene, 'part:iris role:primary');
    const res = applyOperation(r.scene, { operation: 'set', target: 'part:iris role:primary', property: 'fill', value: '#3A7BFF' });
    editOk = res.ok ? sel.map((n) => n.name.replace(/~\d+/, '')).join('+') : 'FAILED';
  }
  fs.writeFileSync(`out/reg-${tag}-${name.replace(/[^a-z0-9.]/gi, '')}.svg`, renderScene(traceGuided(prep, { quality: 0.75, ...o }).scene, { dataAttrs: false }));
  rows.push({ name, m: r.metrics, p, editOk });
}
const pct = (v) => (v * 100).toFixed(1) + '%', pad = (s, n) => String(s).padStart(n);
const cols = [
  ['weighted fidelity', (r) => pct(r.m.weightedFidelity)], ['pixel fidelity', (r) => pct(r.m.pixelFidelity)], ['polish score', (r) => r.p.polishScore.toFixed(3)],
  ['regions', (r) => r.p.regionCount], ['tiny regions', (r) => r.p.tinyRegions], ['colors', (r) => r.p.colors], ['near-duplicate colors', (r) => r.p.nearDuplicateColors],
  ['edge roughness', (r) => r.p.edgeRoughness.toFixed(2)], ['unnecessary corners', (r) => r.p.unnecessaryCorners], ['curve ratio', (r) => pct(r.p.curveRatio)],
  ['regions per part', (r) => r.p.semanticFragmentation.toFixed(1)], ['Bézier curves', (r) => r.m.bezierSegments], ['output points', (r) => r.m.outputPoints],
  ['ARU bytes', (r) => r.m.aruBytes], ['trace ms', (r) => r.m.traceMs.toFixed(0)], ['regularize ms', (r) => (r.m.timings.regularize ?? 0).toFixed(0)], ['iris edit', (r) => r.editOk],
];
console.log(`== ${tag}`);
console.log(''.padEnd(24) + rows.map((r) => pad(r.name, 14)).join(''));
for (const [k, f] of cols) console.log(k.padEnd(24) + rows.map((r) => pad(f(r), 14)).join(''));
fs.writeFileSync(`out/reg-${tag}.json`, JSON.stringify(rows.map((r) => ({ name: r.name, metrics: { ...r.m, timings: r.m.timings }, polish: { ...r.p, roughByChain: undefined, tinyIds: undefined }, edit: r.editOk })), null, 1));
