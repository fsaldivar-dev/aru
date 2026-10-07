// Visual + numeric benchmark for Section Polish iterations.
//   node tools/polish-bench.mjs [--directives references/wolf.polish.v2.json] [--replay out/polish-claude2] [--tag v2]
// Columns: REFERENCE | CURRENT REGULARIZED | PREVIOUS SECTION POLISH (snapshot out/polish-v1) | NEW SECTION POLISH
// Rows: crops named in BENCH_CROPS (benchmark configuration only; the engine knows nothing about wolves).
import fs from 'node:fs';
import { decodePNG, encodePNG } from './png.mjs';
import { ManualVisionProvider } from '../vision/manual-provider.js';
import { runVision } from '../vision/provider.js';
import { prepare, traceGuided } from '../trace/guided.js';
import { polishMetrics } from '../trace/polish.js';
import { checkTopology } from '../trace/validate.js';
import { junctionSpikes } from '../trace/junctions.js';
import { renderCropRGB, referenceCropRGB, sideBySide } from '../trace/review.js';
import { restore } from './snapshot-trace.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const tag = opt('--tag', 'new');
const BENCH_CROPS = [ // [name, section path or null, pixel box override]
  ['left eye', 'wolf.head.leftEye'], ['right eye', 'wolf.head.rightEye'], ['sun rim', null, [40, 170, 110, 170]], ['nose', 'wolf.head.muzzle.nose'], ['ear', 'wolf.leftEar'], ['fur junction', null, [420, 270, 110, 110]],
];
const raw = decodePNG('references/wolf.png');
const v = await runVision(new ManualVisionProvider(JSON.parse(fs.readFileSync('references/wolf.context.json', 'utf8'))), raw);
const prep = prepare(raw, v.context);
let directives;
if (opt('--replay')) { const d = opt('--replay'); const rounds = fs.readdirSync(d).filter((f) => /^review\.round\d+\.json$/.test(f)).sort(); directives = JSON.parse(fs.readFileSync(fs.existsSync(`${d}/review.final.json`) ? `${d}/review.final.json` : `${d}/${rounds[rounds.length - 1]}`, 'utf8')).cumulative; }
else directives = JSON.parse(fs.readFileSync(opt('--directives', 'references/wolf.polish.v2.json'), 'utf8')).directives;
const t0 = performance.now();
const NEW = traceGuided(prep, { quality: 0.75, regularize: true, abstraction: 0.5, polish: directives, polishOptions: JSON.parse(opt('--options', '{}')) });
const newMs = performance.now() - t0;
const REG = restore(JSON.parse(fs.readFileSync('out/polish-v1/regularized.json', 'utf8')));
const V1 = restore(JSON.parse(fs.readFileSync('out/polish-v1/polish-v1.json', 'utf8')));
const img = NEW.img, W = img.width, H = img.height;
const boxOf = (T, path) => { const rs = T.regions.filter((r) => (T.paths ? T.paths.get(r.id) : NEW.assign.get(r.id).path).startsWith(path)); const b = [Math.min(...rs.map((r) => r.bounds[0])), Math.min(...rs.map((r) => r.bounds[1])), Math.max(...rs.map((r) => r.bounds[2])), Math.max(...rs.map((r) => r.bounds[3]))]; const w = b[2] - b[0], h = b[3] - b[1], m = Math.max(6, Math.round(0.25 * Math.max(w, h))); const s = Math.max(w, h) + 2 * m; return [Math.max(0, Math.round((b[0] + b[2]) / 2 - s / 2)), Math.max(0, Math.round((b[1] + b[3]) / 2 - s / 2)), Math.min(W, s), Math.min(H, s)]; };
const dir = `out/polish-bench-${tag}`; fs.mkdirSync(dir, { recursive: true });
const rows = [];
for (const [name, path, box0] of BENCH_CROPS) {
  const box = box0 || boxOf(REG, path), scale = Math.max(2, Math.round(300 / Math.max(box[2], box[3])));
  const cells = [referenceCropRGB(img, box, scale), renderCropRGB(REG, box, scale), renderCropRGB(V1, box, scale), renderCropRGB(NEW.T, box, scale)];
  const row = cells.reduce((a, b) => sideBySide(a, b, 6));
  fs.writeFileSync(`${dir}/${name.replace(/ /g, '-')}.png`, encodePNG(row));
  rows.push(row);
}
// stack rows
const Wt = Math.max(...rows.map((r) => r.width)), Ht = rows.reduce((a, r) => a + r.height + 8, 0), out = new Uint8ClampedArray(Wt * Ht * 4).fill(255);
let oy = 0; for (const r of rows) { for (let y = 0; y < r.height; y++) out.set(r.data.subarray(y * r.width * 4, (y + 1) * r.width * 4), ((oy + y) * Wt) * 4); oy += r.height + 8; }
fs.writeFileSync(`${dir}/crops.png`, encodePNG({ width: Wt, height: Ht, data: out }));
fs.writeFileSync(`${dir}/full.png`, encodePNG([referenceCropRGB(img, [0, 0, W, H], 1), renderCropRGB(REG, [0, 0, W, H], 1), renderCropRGB(V1, [0, 0, W, H], 1), renderCropRGB(NEW.T, [0, 0, W, H], 1)].reduce((a, b) => sideBySide(a, b, 6))));
// numbers
const snapRow = (S) => ({ wfid: S.metrics.weightedFidelity, rough: S.polish.edgeRoughness, points: S.metrics.outputPoints, regions: S.regions.length, flat: S.polish.unnecessaryCorners });
const regS = JSON.parse(fs.readFileSync('out/polish-v1/regularized.json', 'utf8')), v1S = JSON.parse(fs.readFileSync('out/polish-v1/polish-v1.json', 'utf8'));
const pn = polishMetrics(NEW.T, NEW.assign);
const table = {
  'current regularized': { ...snapRow(regS) },
  'previous polish': { ...snapRow(v1S) },
  'new polish': { wfid: NEW.metrics.weightedFidelity, rough: pn.edgeRoughness, points: NEW.metrics.outputPoints, regions: NEW.T.regions.length, flat: pn.unnecessaryCorners, spikes: junctionSpikes(NEW.T.chains, NEW.T.fits, W, H), topology: checkTopology(NEW.T), ms: Math.round(newMs) },
};
console.log(''.padEnd(22) + ['wfid', 'rough', 'points', 'regions', 'flat'].map((k) => k.padStart(9)).join(''));
for (const [k, r] of Object.entries(table)) console.log(k.padEnd(22) + [(r.wfid * 100).toFixed(2) + '%', r.rough.toFixed(3), r.points, r.regions, r.flat].map((x) => String(x).padStart(9)).join(''));
console.log('new: spikes', JSON.stringify(table['new polish'].spikes), 'topology', JSON.stringify(table['new polish'].topology), `${table['new polish'].ms} ms`);
fs.writeFileSync(`${dir}/numbers.json`, JSON.stringify({ table, regionPolish: NEW.regionPolish?.report, sectionPolish: NEW.sectionPolish && { report: NEW.sectionPolish.report, junctions: NEW.sectionPolish.junctions, shapes: NEW.sectionPolish.shapes, totals: NEW.sectionPolish.totals } }, null, 1));
export { NEW };
