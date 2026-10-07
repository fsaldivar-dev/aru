import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { decodePNG } from '../tools/png.mjs';
import { detectInk, extractInk, inkToAru, traceWithInk } from '../trace/ink.js';
import { parse } from '../src/parser.js';

// synthetic line art: a 2 px black ring (anti-aliased) filled with orange, a faint 1 px stroke touching it, on white
function lineArt(W = 200, H = 160) {
  const data = new Uint8ClampedArray(W * H * 4);
  const cx = 90, cy = 80, R = 50;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = [255, 255, 255];
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d < R) c = [240, 140, 40];
    const ink = Math.max(0, Math.min(1, 1.5 - Math.abs(d - R)));       // ring, ~3 px with soft edges
    const faint = x >= 140 && x < 185 && y === 80 ? 0.6 : 0; // thin, lighter stroke attached to the ring
    const a = Math.max(ink, x > 135 ? faint : 0);
    c = c.map((v) => v * (1 - a) + 10 * a);
    data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
  }
  return { width: W, height: H, data };
}

test('detectInk: synthetic line art is detected', () => {
  assert.equal(detectInk(lineArt()).isLineArt, true);
});
test('detectInk: the local wolf reference is not line art', { skip: fs.existsSync('references/wolf.png') ? false : 'Local third-party benchmark fixture is not distributed' }, () => {
  assert.equal(detectInk(decodePNG('references/wolf.png')).isLineArt, false);
});

test('extractInk: ring = one outer + one hole, faint stroke kept, fills inpainted', () => {
  const img = lineArt(), r = extractInk(img);
  assert.equal(r.paths.length, 1, 'the ring and the attached stroke form one cluster');
  assert.equal(r.stats.outers, 1); assert.equal(r.stats.holes, 1);
  assert.ok(r.stats.inkIoU > 0.75, `ink IoU ${r.stats.inkIoU}`);
  assert.ok(r.paths[0].box[2] > 175, 'the faint stroke (hysteresis) reaches x ≈ 185');
  // inpainted: no dark pixels left on the ring
  const i = (80 * img.width + 40) * 4; // on the ring (x = 40, y = 80)
  assert.ok(r.inpainted.data[i] > 200, 'ring pixel replaced by a neighbour color');
  // deterministic
  assert.equal(inkToAru(extractInk(img)), inkToAru(r));
});

test('traceWithInk: valid ARU, ink group on top', () => {
  const img = lineArt();
  const out = traceWithInk(img, () => ({ aru: 'canvas 200 160\nbackground #FFFFFF\n\ngroup fills {\n    rect r { at 100 80; size 200 160; fill #FFFFFF }\n}\n', metrics: {} }));
  const { ast, errors } = parse(out.aru);
  assert.equal(errors?.length ?? 0, 0);
  const m = out.aru.match(/path tinta_1 \{ move .*fill #([0-9A-F]{6}) \}/);
  assert.ok(m, 'ink path on top');
  assert.ok([0, 2, 4].every((k) => parseInt(m[1].slice(k, k + 2), 16) < 0x30), `ink color is dark (#${m[1]})`);
  assert.ok(ast);
});

test('detectInk: a transparent background is not ink (alpha composited over white)', () => {
  const img = lineArt();
  for (let i = 0; i < img.width * img.height; i++) { const p = i * 4; if (img.data[p] === 255 && img.data[p + 1] === 255) img.data.set([0, 0, 0, 0], p); }
  const d = detectInk(img);
  assert.equal(d.isLineArt, true);
  assert.ok(d.ridgeShare > 0.015, `ridge share ${d.ridgeShare}`);
  assert.equal(extractInk(img).stats.outers, 1, 'only the ring, not the transparent area');
});
