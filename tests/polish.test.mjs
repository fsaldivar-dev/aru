// Section/Region Polish tests (node --test tests/). No dependencies, deterministic, uses references/wolf.png locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { decodePNG } from '../tools/png.mjs';
import { ManualVisionProvider } from '../vision/manual-provider.js';
import { ManualPolishProvider } from '../vision/polish-provider.js';
import { runVision } from '../vision/provider.js';
import { runReviewRounds } from '../vision/review-loop.js';
import { prepare, traceGuided } from '../trace/guided.js';
import { validateDirectives, DIRECTIVES_SCHEMA } from '../trace/section-polish.js';
import { checkTopology } from '../trace/validate.js';
import { sectionMasks, measureSections, designedScores } from '../trace/designed.js';
import { labImage } from '../trace/quantize.js';
import { fitEllipse, consensusShape } from '../trace/conics.js';
import { detectThin } from '../trace/thin.js';
import { parse } from '../src/parser.js';
import { buildScene } from '../src/scene.js';
import { applyOperation, selectNodes } from '../src/ops.js';
import { toAru } from '../src/serialize.js';

const hasReference = ['wolf.png', 'wolf.context.json', 'wolf.polish.v2.json'].every(name => fs.existsSync(`references/${name}`));
const referenceTest = (name, fn) => test(name, { skip: hasReference ? false : 'Local third-party benchmark fixture is not distributed' }, fn);
let raw, ctxJson, vision, prep, directives, base, polished;
if (hasReference) {
raw = decodePNG('references/wolf.png');
ctxJson = JSON.parse(fs.readFileSync('references/wolf.context.json', 'utf8'));
vision = await runVision(new ManualVisionProvider(ctxJson), raw);
prep = prepare(raw, vision.context);
directives = JSON.parse(fs.readFileSync('references/wolf.polish.v2.json', 'utf8')).directives;
base = traceGuided(prep, { regularize: true, abstraction: 0.5 });
polished = traceGuided(prep, { regularize: true, abstraction: 0.5, polish: directives });
}
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

referenceTest('vocabulary: geometry, unknown sections and bad region intents are rejected; region intents and confidence accepted', () => {
  const { directives: ok, errors } = validateDirectives({ directives: [
    { section: 'wolf.head.leftEye.iris', shape: 'circle', confidence: 'high', regions: { count: 'single', merge: 'compatible' } },
    { section: 'wolf.neck', path: 'M0 0 L1 1' },
    { section: 'wolf.neck', regions: { count: 'single', points: [[1, 2]] } },
    { section: 'wolf.tail', edges: 'straight' },
    { section: 'sun', confidence: 'certain' },
  ] }, vision.context);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].regions.count, 'single');
  assert.equal(errors.length, 4);
  assert.match(errors.join(' '), /not allowed/);
  // the structured-output schema has no geometry fields at all
  const keys = JSON.stringify(DIRECTIVES_SCHEMA);
  for (const k of ['"points"', '"path"', '"svg"', '"cx"', '"bezier"']) assert.ok(!keys.includes(k));
});

referenceTest('topology: shared chains stay closed loops and nothing is uncovered after region + edge + junction polish', () => {
  const t = checkTopology(polished.T);
  assert.equal(t.loopBreaks, 0);
  assert.equal(t.uncovered, 0);
  assert.ok(polished.sectionPolish.junctions.accepted > 0, 'some junctions moved');
});

referenceTest('determinism: same image + context + directives = same ARU, also through a saved review round', async () => {
  const again = traceGuided(prepare(raw, vision.context), { regularize: true, abstraction: 0.5, polish: directives });
  assert.equal(md5(again.aru), md5(polished.aru));
  const saved = [];
  const out = await runReviewRounds({ prep: prepare(raw, vision.context), provider: new ManualPolishProvider({ directives }), rounds: 1, tier: 'full', encode: () => new Uint8Array(0), save: (n, rec) => saved.push(rec) });
  const replay = traceGuided(prepare(raw, vision.context), { regularize: true, abstraction: 0.5, polish: JSON.parse(JSON.stringify(saved[0].cumulative)) });
  assert.equal(md5(replay.aru), md5(out.result.aru));
});

referenceTest('semantic editing survives polish: part:iris role:primary selects both irises', () => {
  const sel = selectNodes(polished.scene, 'part:iris role:primary');
  assert.equal(new Set(sel.map((n) => n.semantic)).size, 2);
  assert.ok(applyOperation(polished.scene, { operation: 'set', target: 'part:iris role:primary', property: 'fill', value: '#3A7BFF' }).ok);
});

referenceTest('designedScore rewards cleanup but collapses when content is erased', () => {
  const lab = labImage(prep.img), masks = sectionMasks(base.T, base.assign);
  const mb = measureSections(base.T, base.assign, lab, masks, prep.imp);
  const dP = designedScores(measureSections(polished.T, polished.assign, lab, masks, prep.imp), mb, vision.context).designedScore;
  const bg = base.T.regions.find((r) => base.assign.get(r.id).path === 'background').color;
  const wiped = { ...base.T, regions: base.T.regions.map((r) => (base.assign.get(r.id).path.startsWith('wolf') ? { ...r, color: bg, gradient: null } : r)) };
  const dW = designedScores(measureSections(wiped, base.assign, lab, masks, prep.imp), mb, vision.context).designedScore;
  const dB = designedScores(mb, mb, vision.context).designedScore;
  assert.ok(dP > dB, `polish ${dP} > regularized ${dB}`);
  assert.ok(dW < 0.1 * dB, `erased ${dW} collapses`);
});

referenceTest('confidence never bypasses measurement: a high-confidence circle on a faceted ear gets no arcs', () => {
  const r = traceGuided(prep, { regularize: true, abstraction: 0.5, polish: [{ section: 'wolf.leftEar', shape: 'circle', edges: 'curved', corners: 'remove', simplify: 1, confidence: 'high' }] });
  const e = r.sectionPolish.report.find((x) => x.section === 'wolf.leftEar');
  assert.equal(e.arcs, 0, 'no chain lies on a circle, so no arc, whatever the confidence');
  assert.equal(e.style.intent, -1, 'the contradiction with visualIntent is recorded');
  assert.ok(e.status !== 'accepted' || e.improvement > 0.001, 'accepted only with a measured improvement');
});

referenceTest('region intent: a single iris loses its raster fragments, distinct details (highlight) are protected', () => {
  const rp = polished.regionPolish.report;
  const hl = rp.find((e) => e.section === 'wolf.head.leftEye.highlight');
  assert.ok(hl.regionsAfter >= 1, 'highlight still exists');
  const total = rp.reduce((a, e) => a + e.merged, 0);
  assert.ok(total > 10);
});

test('conics: exact ellipse recovery and a partial (occluded) iris-like arc', () => {
  const E = (cx, cy, a, b, th, t0, t1, n) => Array.from({ length: n }, (_, k) => { const t = t0 + (t1 - t0) * k / (n - 1), u = a * Math.cos(t), v = b * Math.sin(t); return [cx + u * Math.cos(th) - v * Math.sin(th), cy + u * Math.sin(th) + v * Math.cos(th)]; });
  const e = fitEllipse(E(50, 40, 20, 12, 0.4, 0, 6.28, 80));
  assert.ok(Math.abs(e.a - 20) < 1e-6 && Math.abs(e.b - 12) < 1e-6 && Math.abs(e.cx - 50) < 1e-6);
  const lid = Array.from({ length: 29 }, (_, k) => [86 + k, 91]);
  const r = consensusShape([E(100, 100, 13, 13, 0, 3.6, 7.8, 60), lid], { tol: 1 });
  assert.ok(r.pick && Math.hypot(r.pick.shape.cx - 100, r.pick.shape.cy - 100) < 0.5);
});

test('thin features: a 1 px line is detected, a 1 px dot is not', () => {
  const W = 40, H = 40, data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let x = 5; x < 35; x++) { const o = (20 * W + x) * 4; data[o] = data[o + 1] = data[o + 2] = 20; }
  const o = (5 * W + 5) * 4; data[o] = data[o + 1] = data[o + 2] = 20;
  const img = { width: W, height: H, data };
  const t = detectThin(img, labImage(img));
  assert.equal(t.components.length, 1);
  assert.ok(t.mask[20 * W + 20] && !t.mask[5 * W + 5]);
});

referenceTest('final test: edit the Semantic ARU text directly, then re-abstract keeping semantics', () => {
  // "haz los iris azules": parse the saved ARU, no trace / vision / regularize
  const scene = buildScene(parse(polished.aru).ast);
  const res = applyOperation(scene, { operation: 'set', target: 'part:iris role:primary', property: 'fill', value: '#2F6BFF' });
  assert.ok(res.ok);
  assert.match(toAru(scene), /#2F6BFF/i);
  // "simplifica toda la ilustración": recompile with more abstraction, same context and directives
  const simple = traceGuided(prep, { regularize: true, abstraction: 0.75, polish: directives });
  assert.ok(simple.metrics.outputPoints < polished.metrics.outputPoints);
  const paths = (r) => new Set([...r.assign.values()].map((a) => a.path));
  for (const p of ['wolf.head.leftEye.iris', 'wolf.head.rightEye.iris', 'wolf.head.muzzle.nose', 'sun']) assert.ok(paths(simple).has(p), p);
  assert.ok(applyOperation(simple.scene, { operation: 'set', target: 'part:iris role:primary', property: 'fill', value: '#2F6BFF' }).ok);
  assert.equal(checkTopology(simple.T).loopBreaks, 0);
});
