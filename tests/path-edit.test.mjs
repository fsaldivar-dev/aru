import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compile } from '../src/engine.js';
import { toAru } from '../src/serialize.js';
import { applyBatch, previewBatch } from '../src/batch.js';
import { applyTransform } from '../src/scene.js';
import { ANSWER_SCHEMA, parseAnswer, systemPrompt } from '../src/agents.js';
import { pathSummary } from '../src/path-edit.js';

const load = (text) => { const r = compile(text); assert.deepEqual(r.errors, []); return r.scene; };
const commands = (scene, path) => scene.byPath.get(path).geom.commands;
const run = (scene, ...ops) => { const r = applyBatch(scene, ops); assert.deepEqual(r.log.filter((l) => !l.ok), [], JSON.stringify(r.log)); return r; };
const roundtrip = (scene) => { const text = toAru(scene); const out = load(text); assert.equal(toAru(out), text); return out; };
const DRAWING = `canvas 200 160
background none
group wolf {
  semantic character.head
  path outline { move 0 0; line 5 0.1; line 10 0; line 10 10; line 0 10; close; move 3 3; line 3 7; line 7 7; line 7 3; close; fill #2F5148 }
  path muzzle { move 20 0; curve 23 0 25 4 30 5; curve 33 8 38 10 40 10; fill none; stroke #111 2 }
}
rect badge { at 100 100; size 20 20; fill #EA7431 }
`;

test('simplify preserves corners, holes, existing curves, names and unrelated layers across persistence', () => {
  const scene = load(DRAWING), badge = JSON.stringify(scene.byPath.get('badge')), muzzle = JSON.stringify(commands(scene, 'wolf.muzzle'));
  const r = run(scene, { op: 'simplify', target: 'wolf', tolerance: 0.2 });
  assert.match(r.log[0].message, /1 punto\(s\) retirados/);
  assert.equal(JSON.stringify(commands(scene, 'wolf.muzzle')), muzzle);
  assert.equal(JSON.stringify(scene.byPath.get('badge')), badge);
  const c = commands(roundtrip(scene), 'wolf.outline');
  assert.equal(c.filter((x) => x.cmd === 'move').length, 2);
  assert.equal(c.filter((x) => x.cmd === 'close').length, 2);
  assert.ok(c.some((x) => x.cmd === 'line' && x.args[0] === 10 && x.args[1] === 0));
  assert.ok(!c.some((x) => x.cmd === 'line' && x.args[0] === 5));
  assert.equal(scene.byPath.get('wolf').semantic, 'character.head');
});

test('smooth aligns tangent handles, bounds their movement in canvas units and keeps endpoints', () => {
  const scene = load(`canvas 300 200
group frame { at 80 20; rotate 35; scale 3 1.5
  path cheek { rotate 20; move 0 0; curve 3 0 7 2 10 2; curve 13 4 17 4 20 4; fill none; stroke #111 2 }
}`);
  const n = scene.byPath.get('frame.cheek'), frame = scene.byPath.get('frame'), before = structuredClone(n.geom.commands);
  run(scene, { op: 'smooth', target: n.path, tolerance: 0.3, strength: 1 });
  const after = n.geom.commands;
  assert.deepEqual(after[0].args, before[0].args);
  assert.deepEqual(after[2].args.slice(-2), before[2].args.slice(-2));
  let moved = false;
  const world = (p) => applyTransform(frame, ...applyTransform(n, ...p));
  for (let k = 1; k < 3; k++) for (let i = 0; i < 4; i += 2) {
    const a = world(before[k].args.slice(i, i + 2)), b = world(after[k].args.slice(i, i + 2));
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]); assert.ok(d <= 0.3000001); moved ||= d > 0.001;
  }
  assert.ok(moved); assert.match(pathSummary(n), /2 curves/); roundtrip(scene);
});

test('smooth preserves sharp polyline corners and closed subpath count', () => {
  const scene = load(DRAWING);
  run(scene, { op: 'smooth', target: 'wolf.outline', tolerance: 1 });
  const c = commands(roundtrip(scene), 'wolf.outline');
  assert.equal(c.filter((x) => x.cmd === 'move').length, 2);
  assert.equal(c.filter((x) => x.cmd === 'close').length, 2);
  const edge = c.find((x) => x.cmd === 'curve' && x.args.at(-2) === 10 && x.args.at(-1) === 10);
  assert.deepEqual(edge.args, [10, 10 / 3, 10, 20 / 3, 10, 10].map((v) => Math.round(v * 1000) / 1000));
});

test('refinement preflight rejects locked, unsupported and invalid children without partial mutation', () => {
  for (const child of ['path b { locked 1; move 0 0; line 5 5 }', 'path b { move 0 0; arc 3 3 0 0 1 5 5 }', 'path b { move 0 0 4 4; line 5 5 }']) {
    const scene = load(`canvas 50 50\ngroup g { path a { move 0 0; line 2 0.1; line 4 0 }; ${child} }`), before = toAru(scene);
    const out = applyBatch(scene, [{ op: 'smooth', target: 'g' }]);
    assert.equal(out.log[0].ok, false); assert.equal(toAru(scene), before);
  }
  const scene = load(DRAWING.replace('semantic character.head', 'semantic character.head; locked 1'));
  const before = toAru(scene);
  assert.equal(applyBatch(scene, [{ op: 'simplify', target: 'wolf.outline' }]).log[0].ok, false);
  assert.equal(toAru(scene), before);
  for (const tolerance of [NaN, -1, 0, '1', 101]) assert.equal(applyBatch(load(DRAWING), [{ op: 'smooth', target: 'wolf', tolerance }]).log[0].ok, false);
});

test('simplify respects transformed tolerance, deduplicates a group plus its child and keeps two-curve loops', () => {
  const scene = load(`canvas 100 100\ngroup g { scale 10; path p { move 0 0; line 1 0.1; line 2 0 }; path loop { move 4 0; curve 8 0 8 8 4 8; curve 0 8 0 0 4 0; close } }`);
  run(scene, { op: 'simplify', target: 'g', tolerance: 0.5 });
  assert.equal(commands(scene, 'g.p').length, 3, 'a one-unit deviation cannot be removed at tolerance .5');
  const result = applyBatch(scene, [{ op: 'simplify', target: 'selection', tolerance: 1.1 }], { selection: [scene.byPath.get('g').id, scene.byPath.get('g.p').id] });
  assert.match(result.log[0].message, /2 trazo\(s\)/); assert.equal(commands(scene, 'g.p').length, 2);
  assert.equal(commands(scene, 'g.loop').filter((x) => x.cmd === 'curve').length, 2);
});

test('weld coincides endpoints across nested transforms, moves adjacent handles and keeps both styles', () => {
  const scene = load(`canvas 300 300
group ga { at 80 60; rotate 90; scale 2 1; path a { move 0 0; curve 1 0 4 0 5 0; fill none; stroke #111 2 } }
group gb { at 82 70; rotate 30; scale 1 2; path b { move 0 0; curve 2 0 5 0 6 0; fill none; stroke #EA7431 4 } }`);
  const original = structuredClone(commands(scene, 'ga.a'));
  run(scene, { op: 'weld', target: 'ga.a', other: 'gb.b', maxDistance: 3 });
  const a = scene.byPath.get('ga.a'), b = scene.byPath.get('gb.b');
  const wa = applyTransform(scene.byPath.get('ga'), ...a.geom.commands.at(-1).args.slice(-2));
  const wb = applyTransform(scene.byPath.get('gb'), ...b.geom.commands[0].args);
  assert.ok(Math.hypot(wa[0] - wb[0], wa[1] - wb[1]) < 1e-8);
  const delta = a.geom.commands.at(-1).args.slice(-2).map((v, i) => v - original.at(-1).args.slice(-2)[i]);
  assert.deepEqual(a.geom.commands.at(-1).args.slice(2, 4), original.at(-1).args.slice(2, 4).map((v, i) => v + delta[i]));
  const persisted = roundtrip(scene); assert.equal(persisted.byPath.get('gb.b').stroke, '#EA7431');
  assert.equal(persisted.byPath.get('ga.a').strokeWidth, 2);
});

test('connect reverses both endpoint directions as needed, retains target identity and removes other from indexes', () => {
  for (const endpoint of ['start', 'end']) for (const otherEndpoint of ['start', 'end']) {
    const a = endpoint === 'end' ? 'move 0 0; curve 3 0 7 0 10 0' : 'move 10 0; curve 7 0 3 0 0 0';
    const b = otherEndpoint === 'start' ? 'move 0 0; quad 5 3 10 0' : 'move 10 0; quad 5 3 0 0';
    const scene = load(`canvas 100 60\ngroup g { path a { ${a}; fill none; stroke #111 2; label "Mejilla" }; path b { at 11 0; ${b}; fill none; stroke #111 2 } }`);
    const bId = scene.byPath.get('g.b').id;
    run(scene, { op: 'connect', target: 'g.a', other: 'g.b', endpoint, otherEndpoint, maxDistance: 2 }, { op: 'set', target: 'g.a', stroke: '#EA7431' });
    assert.ok(!scene.byId.has(bId)); assert.ok(!scene.byPath.has('g.b'));
    const c = commands(roundtrip(scene), 'g.a');
    assert.deepEqual(c[0].args, [0, 0]); assert.deepEqual(c.at(-1).args.slice(-2), [21, 0]);
    assert.equal(c.filter((x) => x.cmd === 'move').length, 1); assert.equal(c.length, 3);
    assert.equal(scene.byPath.get('g.a').label, 'Mejilla');
  }
});

test('joins reject far endpoints, closed paths, mixed style and non-adjacent layers without side effects', () => {
  for (const extra of [
    { source: 'path b { at 50 0; move 0 0; line 10 0; fill none; stroke #111 2 }', op: 'weld' },
    { source: 'path b { at 10 0; move 0 0; line 10 0; close; fill none; stroke #111 2 }', op: 'weld' },
    { source: 'path b { at 10 0; move 0 0; line 10 0; fill none; stroke #F00 2 }', op: 'connect' },
    { source: 'circle c { radius 3 }; path b { at 10 0; move 0 0; line 10 0; fill none; stroke #111 2 }', op: 'connect' },
  ]) {
    const scene = load(`canvas 100 60\npath a { move 0 0; line 10 0; fill none; stroke #111 2 }\n${extra.source}`), before = toAru(scene);
    assert.equal(applyBatch(scene, [{ op: extra.op, target: 'a', other: 'b' }]).log[0].ok, false);
    assert.equal(toAru(scene), before);
  }
});

test('joins choose the nearest endpoints without the AI calculating coordinates', () => {
  const scene = load('canvas 100 80\npath a { move 10 0; line 0 0; fill none; stroke #111 2 }\npath b { move 11 0; line 20 0; fill none; stroke #111 2 }');
  const result = run(scene, { op: 'weld', target: 'a', other: 'b', maxDistance: 2 });
  assert.deepEqual(commands(scene, 'a')[0].args, [10.5, 0]);
  assert.deepEqual(commands(scene, 'b')[0].args, [10.5, 0]);
  assert.match(result.log[0].message, /start ↔ start/);
});

test('preview is independent; parsed AI geometry operations use the exact same batch path', () => {
  const parsed = parseAnswer('codex', { code: 0, output: JSON.stringify({ reply: 'Suavizo la base', operations: [{ op: 'simplify', target: 'wolf', tolerance: .2, other: null }] }) });
  const before = load(DRAWING), saved = toAru(before);
  const preview = previewBatch(saved, parsed.operations);
  assert.equal(toAru(before), saved);
  assert.notEqual(preview.text, saved);
  run(before, ...parsed.operations); assert.equal(toAru(before), preview.text);
  for (const op of ['simplify', 'smooth', 'weld', 'connect']) assert.ok(ANSWER_SCHEMA.properties.operations.items.properties.op.enum.includes(op));
  assert.match(systemPrompt(), /not a persistent constraint/);
});

test('the traced Sajaru base supports scoped refinement with wordmark and palette untouched', () => {
  const source = fs.readFileSync(new URL('../examples/sajaru-base-editable.aru', import.meta.url), 'utf8');
  const scene = load(source), target = [...scene.byPath.values()].find((n) => n.type === 'group' && n.name === 'tinta_wolf');
  assert.ok(target);
  const originalOthers = [...scene.byPath.values()].filter((n) => n.type !== 'group' && !n.path.startsWith(`${target.path}.`)).map((n) => [n.path, JSON.stringify(n.geom), n.fill]);
  const closed = target.children.map((n) => commands(scene, n.path).filter((c) => c.cmd === 'close').length);
  run(scene, { op: 'simplify', target: target.path, tolerance: 0.3 }, { op: 'smooth', target: target.path, tolerance: 0.4 });
  assert.deepEqual(target.children.map((n) => commands(scene, n.path).filter((c) => c.cmd === 'close').length), closed);
  for (const [path, geom, fill] of originalOthers) { assert.equal(JSON.stringify(scene.byPath.get(path).geom), geom); assert.equal(scene.byPath.get(path).fill, fill); }
  roundtrip(scene);
});
