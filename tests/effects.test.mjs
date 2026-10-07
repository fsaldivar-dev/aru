import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/engine.js';
import { toAru } from '../src/serialize.js';
import { applyBatch } from '../src/batch.js';

const src = `canvas 200 200
background none
group icono {
    shadow 0 8 16 #2F5148 0.3
    rect base { at 100 100; size 120 120; corner 28; fill #A8CBBE; inner 0 4 6 #FFFFFF 0.6; inner 0 -4 8 #2F5148 0.25 }
}
`;

test('shadow / inner: parsed, serialized round-trip, rendered as SVG filters', () => {
  const r = compile(src);
  assert.equal(r.errors.length, 0); assert.equal(r.warnings.length, 0);
  const base = r.scene.root.children[0].children[0];
  assert.deepEqual(base.inner.map((e) => e.dy), [4, -4]);
  assert.equal(r.scene.root.children[0].shadow.blur, 16);
  const again = compile(toAru(r.scene));
  assert.equal(toAru(again.scene), toAru(r.scene), 'stable round-trip');
  assert.match(r.svg, /<filter id="fx-1"[^>]*><feDropShadow[^>]*dy="8"/);
  assert.match(r.svg, /operator="arithmetic" k1="-1" k2="1" k3="0"/, 'inner = shape minus offset silhouette');
  assert.equal((r.svg.match(/filter="url\(#fx-/g) || []).length, 2);
});

test('batch set shadow / inner from text, "none" clears', () => {
  const scene = compile(src).scene;
  const r = applyBatch(scene, [{ op: 'set', target: 'icono.base', shadow: '0 10 16 #2F6B5A 0.35', inner: '0 3 4 #FFFFFF 0.9|0 -4 6 #5E9C88 0.45' }, { op: 'set', target: 'icono', shadow: 'none' }]);
  assert.ok(r.log.every((l) => l.ok), JSON.stringify(r.log));
  const base = scene.byPath.get('icono.base');
  assert.equal(base.shadow.dy, 10); assert.equal(base.inner.length, 2);
  assert.ok(!scene.byPath.get('icono').shadow);
  assert.equal(applyBatch(scene, [{ op: 'set', target: 'icono.base', shadow: 'big' }]).log[0].ok, false);
});
