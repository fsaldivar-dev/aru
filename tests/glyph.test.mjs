import test from 'node:test';
import assert from 'node:assert/strict';
import { rawGlyph, buildGlyph, inspect, normGlyphParams, glyphToAru, inspectionReport } from '../trace/glyph.js';
import { compile } from '../src/engine.js';

// a disc glyph (r 40 in a 100×100 scene) with a tiny speck beside it and a hairline cut across it
const circle = (cx, cy, r, n = 48) => [{ cmd: 'move', args: [cx + r, cy] }, ...Array.from({ length: n - 1 }, (_, i) => ({ cmd: 'line', args: [cx + r * Math.cos(((i + 1) / n) * 2 * Math.PI), cy + r * Math.sin(((i + 1) / n) * 2 * Math.PI)] })), { cmd: 'close', args: [] }];
const rect = (x0, y0, x1, y1) => [{ cmd: 'move', args: [x0, y0] }, { cmd: 'line', args: [x1, y0] }, { cmd: 'line', args: [x1, y1] }, { cmd: 'line', args: [x0, y1] }, { cmd: 'close', args: [] }];
const fills = [circle(50, 50, 40), circle(95, 8, 0.6)];     // disc + speck (0.6 scene px ≈ 6 raster px)
const ink = [rect(10, 49.75, 90, 50.25)];                     // thin cut (≈ 0.24 icon px) through the disc

test('inspect: the raw glyph shows the speck and the hairline cut', () => {
  const raw = rawGlyph(fills, ink, 100, 100);
  const ins = inspect(buildGlyph(raw, { openThin: 0, closeCuts: 0, minFeature: 0, smooth: 0 }), raw);
  assert.ok(ins.specks >= 1, `specks ${ins.specks}`);
  assert.ok(ins.thinCuts > 0, `thin cuts ${ins.thinCuts}`);
  assert.match(inspectionReport(ins, normGlyphParams({})), /minFeature/);
});

test('levers fix the defects and the score rewards it; ONE compound path that compiles', () => {
  const raw = rawGlyph(fills, ink, 100, 100);
  const dirty = inspect(buildGlyph(raw, { openThin: 0, closeCuts: 0, minFeature: 0, smooth: 0 }), raw);
  const built = buildGlyph(raw, { minFeature: 1, closeCuts: 0.5, smooth: 0.25 });
  const clean = inspect(built, raw);
  assert.equal(clean.specks, 0);
  assert.ok(clean.thinCuts < dirty.thinCuts);
  assert.ok(clean.score > dirty.score, `${dirty.score} -> ${clean.score}`);
  assert.ok(clean.fidelity > 0.95, `fidelity ${clean.fidelity}`);
  const aru = `canvas 100 100\nbackground none\n${glyphToAru(built)}`;
  const r = compile(aru);
  assert.equal(r.errors.length, 0);
  assert.equal(r.scene.root.children.filter((n) => n.type === 'path').length, 1);
});

test('normGlyphParams clamps to the limits', () => {
  assert.deepEqual(normGlyphParams({ openThin: 9, closeCuts: -1, minFeature: 'x', smooth: 0.333 }), { openThin: 2, closeCuts: 0, minFeature: 1.5, smooth: 0.33 });
});

test('minFeature holds on the final outline (no speck reappears after the fit)', () => {
  // a disc with many small bumps and dots that are below minFeature
  const dots = Array.from({ length: 12 }, (_, i) => circle(10 + i * 7, 95, 0.9, 12));
  const raw = rawGlyph([circle(50, 45, 35), ...dots], [], 100, 100);
  for (const mf of [1, 1.5, 2]) assert.equal(inspect(buildGlyph(raw, { minFeature: mf, smooth: 0.25 }), raw).specks, 0, `minFeature ${mf}`);
});
