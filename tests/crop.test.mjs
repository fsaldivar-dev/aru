import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { decodePNG } from '../tools/png.mjs';
import { cropToSubject, contrastBackdrop } from '../trace/crop.js';

// "logo": a disc (the subject) + a thin bar beside it + text-like block, on white
function logo() {
  const W = 200, H = 100, data = new Uint8ClampedArray(W * H * 4).fill(255);
  const set = (x, y, c) => data.set([...c, 255], (y * W + x) * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (Math.hypot(x - 45, y - 50) < 32) set(x, y, [60, 110, 100]);
    if (x >= 82 && x <= 83 && y >= 15 && y <= 85) set(x, y, [30, 50, 45]); // divider bar, 5 px from the disc
    if (x >= 110 && x <= 190 && y >= 35 && y <= 65) set(x, y, [200, 100, 60]); // wordmark
  }
  return { width: W, height: H, data };
}

test('cropToSubject: a tight AI box grows to the whole subject, the bar beside it is removed', () => {
  const img = logo();
  // AI box cuts the disc on every side; the bar is outside the box but inside the search window
  const r = cropToSubject(img, { x: 0.1, y: 0.25, w: 0.26, h: 0.5 });
  assert.equal(r.refined, true);
  assert.ok(r.box.x * 200 <= 13.5 && (r.box.x + r.box.w) * 200 >= 77, `disc fully inside: ${JSON.stringify(r.box)}`);
  assert.ok(r.box.y * 100 <= 18.5 && (r.box.y + r.box.h) * 100 >= 82, `disc fully inside vertically: ${JSON.stringify(r.box)}`);
  assert.ok((r.box.x + r.box.w) * 200 <= 82, `the bar is outside the crop: ${JSON.stringify(r.box)}`);
  // no bar pixels in the cropped image
  let dark = 0; for (let i = 0; i < r.raw.data.length; i += 4) if (r.raw.data[i] < 40 && r.raw.data[i + 1] < 60) dark++;
  assert.equal(dark, 0);
});

test('cropToSubject: busy backdrop -> the AI box is used as is', { skip: fs.existsSync('references/wolf.png') ? false : 'Local third-party benchmark fixture is not distributed' }, () => {
  const img = decodePNG('references/wolf.png');
  const r = cropToSubject(img, { x: 0.2, y: 0.1, w: 0.6, h: 0.8 });
  assert.equal(r.refined, false);
});

test('contrastBackdrop: a base equal to the outline is moved away, a contrasting one is kept', () => {
  assert.equal(contrastBackdrop('#F3EFE8', ['#1F3329']), '#F3EFE8');
  const c = contrastBackdrop('#1F3A2E', ['#1F3329']);
  assert.notEqual(c, '#1F3A2E');
  const L = (h) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
  assert.ok(L(c) > L('#1F3A2E'), `lighter: ${c}`);
});
