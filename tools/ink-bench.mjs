// Ink mode benchmark: current Studio trace vs ink mode (ink layer + fills traced on the inpainted image).
//   node tools/ink-bench.mjs image.png [--out out/ink-name]   (writes <out>-studio.svg, <out>-ink.svg, <out>-ink.aru)
import fs from 'node:fs';
import { decodePNG } from './png.mjs';
import { ManualVisionProvider } from '../vision/manual-provider.js';
import { runVision } from '../vision/provider.js';
import { prepare, traceGuided } from '../trace/guided.js';
import { detectInk, traceWithInk } from '../trace/ink.js';
import { parse } from '../src/parser.js';
import { buildScene } from '../src/scene.js';
import { renderScene } from '../src/render.js';

const file = process.argv[2] || 'references/wolf.png';
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const raw = decodePNG(file);
const ctx = { version: 1, scene: 'illustration', background: { importance: 0.5 }, objects: [] };
const studio = { quality: 0.75, regularize: true, abstraction: 0.5 };
const fillsWith = (o) => async (img) => { const v = await runVision(new ManualVisionProvider(ctx), img); return traceGuided(prepare(img, v.context), o); };
const svgOf = (aru) => { const { ast } = parse(aru); return renderScene(buildScene(ast), { dataAttrs: false }); };
const pts = (aru) => (aru.match(/-?\d+(\.\d+)?/g) || []).length / 2 | 0;

const det = detectInk(raw);
console.log('detectInk', JSON.stringify(det));
let t = performance.now();
const base = await fillsWith(studio)(raw);
console.log(`studio actual      ${base.T.regions.length} regiones · ${base.metrics.outputPoints} pts · fidelidad ${(base.metrics.weightedFidelity * 100).toFixed(1)}% · ${(base.aru.length / 1024).toFixed(0)} KB · ${(performance.now() - t).toFixed(0)} ms`);
for (const [name, o] of [['tinta + regularize', studio], ['tinta + guiado', { quality: 0.75 }]]) {
  t = performance.now();
  const v = await runVision(new ManualVisionProvider(ctx), raw);
  let fills = null;
  const r = traceWithInk(raw, (img) => { fills = traceGuided(prepare(img, v.context), o); return fills; });
  const s = r.ink.stats;
  console.log(`${name.padEnd(18)} rellenos ${fills.T.regions.length} reg · ${fills.metrics.outputPoints} pts · fid. rellenos ${(fills.metrics.weightedFidelity * 100).toFixed(1)}% | tinta ${s.clusters} trazos, ${s.outers}+${s.holes} lazos, ${s.points} pts, IoU ${s.inkIoU} | total ${(r.aru.length / 1024).toFixed(0)} KB · ${(performance.now() - t).toFixed(0)} ms`);
  if (out) { const tag = name.includes('regularize') ? 'ink' : 'ink-guided'; fs.writeFileSync(`${out}-${tag}.aru`, r.aru); fs.writeFileSync(`${out}-${tag}.svg`, svgOf(r.aru)); }
}
if (out) fs.writeFileSync(`${out}-studio.svg`, svgOf(base.aru));
