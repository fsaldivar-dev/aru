import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRender } from '../trace/score.js';
import { traceBest, normTune, defaultTunes } from '../trace/autotune.js';

function lineArt(W = 160, H = 120) { // black ring on orange, white background
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x + 0.5 - 80, y + 0.5 - 60); let c = d < 40 ? [240, 140, 40] : [255, 255, 255];
    const a = Math.max(0, Math.min(1, 1.5 - Math.abs(d - 40))); c = c.map((v) => v * (1 - a) + 10 * a);
    data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
  }
  return { width: W, height: H, data };
}
const blank = (W, H) => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });

test('score: identical = perfect; a blank render loses the lines', () => {
  const img = lineArt();
  const same = scoreRender(img, img);
  assert.equal(same.score, 1); assert.equal(same.lineRecall, 1); assert.equal(same.dE, 0);
  const empty = scoreRender(img, blank(img.width, img.height));
  assert.ok(empty.lineRecall < 0.05, `recall ${empty.lineRecall}`);
  assert.ok(empty.score < same.score - 0.3);
});

test('autotune: the score decides (mock raster: only the ink candidate looks like the source)', async () => {
  const img = lineArt();
  assert.equal(defaultTunes(img)[0].ink, 'on', 'line art: ink first');
  const ctx = { version: 1, scene: 'illustration', background: { importance: 0.5 }, objects: [] };
  const rasterize = async (scene, W, H) => (scene.root.children.some((g) => g.name === 'tinta') ? img : blank(W, H));
  // even when the list starts with ink OFF, the measured best is the ink candidate
  const { best, tried } = await traceBest(img, ctx, { rasterize, tunes: [{ ink: 'off' }, { ink: 'on' }] });
  assert.equal(tried.length, 2);
  assert.equal(best.tune.ink, 'on');
  assert.deepEqual(normTune({ ink: 'x', faint: 7, abstraction: -1, detail: 'ultra' }), { ink: 'off', faint: 1, abstraction: 0, detail: 'medium' });
});

test('pieces + regroup: the AI names pieces, the tracer keeps the pixels', async () => {
  const { buildSegments } = await import('../trace/segments.js');
  const { traceWithTune, regroup } = await import('../trace/autotune.js');
  // two discs (red left, blue right) on white
  const W = 160, H = 100, data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = Math.hypot(x - 45, y - 50) < 30 ? [220, 40, 40] : Math.hypot(x - 115, y - 50) < 30 ? [40, 60, 220] : [255, 255, 255];
    data.set([...c, 255], (y * W + x) * 4);
  }
  const img = { width: W, height: H, data };
  const neutral = { version: 1, scene: 'x', background: { importance: 0.5 }, objects: [] };
  const cand = await traceWithTune(img, neutral, { ink: 'off' });
  const seg = buildSegments(cand.res.T, { target: 3 });
  assert.equal(seg.segments.length, 3);
  // parts with deliberately WRONG boxes (swapped): the piece assignment must win
  const ctx = { version: 1, scene: 'x', background: { importance: 0.2 }, objects: [{ id: 'izq', label: 'Izquierda', bounds: [0.5, 0, 0.5, 1], parts: [] }, { id: 'der', label: 'Derecha', bounds: [0, 0, 0.5, 1], parts: [] }] };
  const pieceOf = (x, y) => seg.labels[Math.floor(y * seg.height / H) * seg.width + Math.floor(x * seg.width / W)];
  const pieceParts = new Map([[pieceOf(45, 50), 'Izquierda'], [pieceOf(115, 50), 'der'], [pieceOf(2, 2), 'background']]);
  const g = await regroup(cand, img, ctx, { pieces: seg, pieceParts });
  assert.deepEqual(g.unknownParts, []);
  const groups = Object.fromEntries(g.scene.root.children.filter((n) => n.type === 'group').map((n) => [n.name, n]));
  const fills = (n) => n.children.filter((c) => c.type === 'path').map((c) => c.fill);
  assert.ok(fills(groups.izq).some((f) => /^#D|^#C|^#E/.test(f)), `left = red: ${fills(groups.izq)}`);
  assert.ok(fills(groups.der).some((f) => /^#[23]/.test(f)), `right = blue: ${fills(groups.der)}`);
  assert.equal(groups.izq.label, 'Izquierda');
});

test('regroup: one background group even when the AI calls it "fondo"', async () => {
  const { traceWithTune, regroup } = await import('../trace/autotune.js');
  const W = 120, H = 80, data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([...(Math.hypot(x - 60, y - 40) < 25 ? [200, 50, 50] : [240, 240, 240]), 255], (y * W + x) * 4);
  const img = { width: W, height: H, data };
  const cand = await traceWithTune(img, { version: 1, scene: 'x', background: { importance: 0.5 }, objects: [] }, { ink: 'off' });
  // only the disc has a part; the backdrop is the AI's "fondo" part with a box that misses the corners
  const ctx = { version: 1, scene: 'x', background: { importance: 0.2 }, objects: [{ id: 'fondo', label: 'Fondo', bounds: [0, 0, 1, 0.2], parts: [] }, { id: 'disco', label: 'Disco', bounds: [0.25, 0.15, 0.5, 0.7], parts: [] }] };
  const g = await regroup(cand, img, ctx);
  const names = g.scene.root.children.filter((n) => n.type === 'group').map((n) => n.name);
  assert.ok(!names.includes('background'), `groups: ${names}`);
  assert.ok(names.includes('fondo') && names.includes('disco'), `groups: ${names}`);
});
