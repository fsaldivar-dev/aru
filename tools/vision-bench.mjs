// Benchmark: global tracing (12 / 16 colors) vs vision-guided tracing, all measured with the SAME importance map.
import fs from 'node:fs';
import { decodePNG } from './png.mjs';
import { ManualVisionProvider } from '../vision/manual-provider.js';
import { runVision } from '../vision/provider.js';
import { traceImage } from '../trace/index.js';
import { prepare, traceGuided, measureGlobal } from '../trace/guided.js';
import { qualitySearch } from '../trace/quality-search.js';
import { errorMaps } from '../trace/error-map.js';
import { renderScene } from '../src/render.js';

const raw = decodePNG('references/wolf.png');
const vision = await runVision(new ManualVisionProvider(JSON.parse(fs.readFileSync('references/wolf.context.json', 'utf8'))), raw);
const prep = prepare(raw, vision.context);
const ctx = vision.context;
// fidelity per semantic part (pixels whose deepest context node lies in the part's subtree)
const PARTS = ['wolf.head.leftEye', 'wolf.head.rightEye', 'wolf.head.muzzle.nose', 'wolf.head.muzzle.mouth', 'wolf.leftEar', 'wolf.rightEar', 'wolf.fur'];
function partFidelity(err) {
  const out = {};
  for (const part of PARTS) {
    let n = 0, ok = 0, e = 0;
    for (let i = 0; i < err.length; i++) {
      const o = prep.imp.owner[i]; if (o < 0) continue;
      const p = ctx.nodes[o].path;
      const hit = part === 'wolf.fur' ? (p === 'wolf' || p === 'wolf.fur') : (p === part || p.startsWith(part + '.'));
      if (!hit) continue;
      n++; e += err[i]; if (err[i] <= 10) ok++;
    }
    out[part] = { fidelity: ok / n, meanErr: e / n };
  }
  return out;
}
const rows = [];
for (const colors of [12, 16]) {
  const r = traceImage(raw, { colors });
  const m = measureGlobal(r, prep.imp);
  const em = errorMaps({ ...r.T, regionsById: new Map(r.T.regions.map((x) => [x.id, x])) }, r.img, prep.imp);
  rows.push({ name: `global ${colors} colors`, m, parts: partFidelity(em.err), visionMs: 0 });
  fs.writeFileSync(`out/bench-global${colors}.svg`, renderScene(r.scene, { dataAttrs: false }));
}
const fixed = traceGuided(prep, { quality: 0.75 });
rows.push({ name: 'vision-guided q=0.75', m: fixed.metrics, parts: partFidelity(fixed.errorMaps.err), visionMs: vision.ms });
fs.writeFileSync('out/bench-guided.svg', renderScene(fixed.scene, { dataAttrs: false }));
const search = qualitySearch(prep, { targetFidelity: 0.93, quality: 0.6, maxIterations: 6 });
const sr = search.result;
rows.push({ name: 'vision-guided search→0.93', m: sr.metrics, parts: partFidelity(sr.errorMaps.err), visionMs: vision.ms });
fs.writeFileSync('out/bench-search.svg', renderScene(sr.scene, { dataAttrs: false }));
fs.writeFileSync('out/bench-search.aru', sr.aru);

const pct = (v) => (v * 100).toFixed(1) + '%';
const cols = [
  ['pixel fidelity (ΔE≤10)', (m) => pct(m.pixelFidelity)], ['weighted fidelity', (m) => pct(m.weightedFidelity)],
  ['mean color error ΔE', (m) => m.meanColorError.toFixed(2)], ['weighted color error ΔE', (m) => m.weightedColorError.toFixed(2)],
  ['pixels ΔRGB≤30', (m) => pct(m.pixelsWithinRGB30)], ['regions / paths', (m) => m.regions], ['colors (global+local)', (m) => `${m.globalColors}+${m.localColors}`],
  ['Bézier segments', (m) => m.bezierSegments], ['output points', (m) => m.outputPoints], ['geometry compression', (m) => m.compressionRatio.toFixed(1) + '×'],
  ['ARU bytes', (m) => m.aruBytes], ['trace ms', (m) => m.traceMs.toFixed(0)],
];
const pad = (s, n) => String(s).padStart(n);
console.log(''.padEnd(26) + rows.map((r) => pad(r.name, 28)).join(''));
for (const [k, f] of cols) console.log(k.padEnd(26) + rows.map((r) => pad(f(r.m), 28)).join(''));
console.log('vision analysis ms'.padEnd(26) + rows.map((r) => pad(r.visionMs.toFixed(2), 28)).join(''));
console.log('\n-- fidelity per part (share of pixels with ΔE ≤ 10 / mean ΔE)');
for (const p of PARTS) console.log(p.padEnd(26) + rows.map((r) => pad(`${pct(r.parts[p].fidelity)} / ${r.parts[p].meanErr.toFixed(1)}`, 28)).join(''));
console.log('\n-- quality search history');
for (const h of search.history) console.log(`  iter ${h.iteration}: weighted ${pct(h.weightedFidelity)} pixel ${pct(h.pixelFidelity)} regions ${h.regions} points ${h.outputPoints} colors ${h.globalColors}+${h.localColors} | ${h.changes.join('; ')}`);
fs.writeFileSync('out/bench.json', JSON.stringify({ rows: rows.map((r) => ({ name: r.name, metrics: { ...r.m, timings: undefined }, parts: r.parts })), history: search.history }, null, 1));
