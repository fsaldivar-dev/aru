// CLI: node tools/guided-trace.mjs references/wolf.png references/wolf.context.json [--quality 0.75] [--target 0.95] [--search]
import fs from 'node:fs';
import { decodePNG } from './png.mjs';
import { ManualVisionProvider } from '../vision/manual-provider.js';
import { runVision } from '../vision/provider.js';
import { prepare, traceGuided } from '../trace/guided.js';
import { qualitySearch } from '../trace/quality-search.js';
import { renderScene } from '../src/render.js';

const [file = 'references/wolf.png', ctxFile = 'references/wolf.context.json'] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^\d/.test(a));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const raw = decodePNG(file);
const vision = await runVision(new ManualVisionProvider(JSON.parse(fs.readFileSync(ctxFile, 'utf8'))), raw);
const prep = prepare(raw, vision.context);
let res;
if (process.argv.includes('--search')) {
  const s = qualitySearch(prep, { targetFidelity: arg('target', 0.95), quality: arg('quality', 0.6) });
  for (const h of s.history) console.log(`iter ${h.iteration}: weighted ${(h.weightedFidelity * 100).toFixed(1)}% pixel ${(h.pixelFidelity * 100).toFixed(1)}% regions ${h.regions} points ${h.outputPoints} colors ${h.globalColors}+${h.localColors} ${h.changes.join('; ')}`);
  res = s.result;
} else res = traceGuided(prep, { quality: arg('quality', 0.75) });
const m = res.metrics;
console.log(`vision ${vision.provider} ${vision.ms.toFixed(1)} ms`);
for (const k of ['pixelFidelity', 'weightedFidelity', 'meanColorError', 'weightedColorError', 'pixelsWithinRGB30', 'regionAgreement', 'regions', 'globalColors', 'localColors', 'bezierSegments', 'outputPoints', 'compressionRatio', 'meanTraceError', 'maxTraceError', 'aruBytes', 'traceMs'])
  console.log(`${k.padStart(20)}  ${typeof m[k] === 'number' && !Number.isInteger(m[k]) ? m[k].toFixed(3) : m[k]}`);
console.log('saliency', JSON.stringify(res.saliency));
console.log('local palettes', res.q.zoneStats.filter((z) => z.localColors).map((z) => `${z.target}: ${z.localColors} (ΔE ${z.errBefore.toFixed(1)}→${z.errAfter.toFixed(1)})`).join(' | '));
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
if (out) { fs.writeFileSync(out + '.svg', renderScene(res.scene, { dataAttrs: false })); fs.writeFileSync(out + '.aru', res.aru); }
