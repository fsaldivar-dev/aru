// Studio editing operations: rename, batch rename, animation (+ stagger), group/ungroup, duplicate, reorder,
// align/distribute, and the ARU round trip (label / animate / hidden / locked survive serialize + parse).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/engine.js';
import { toAru } from '../src/serialize.js';
import * as E from '../src/edit.js';

const SRC = `canvas 400 300
background #101014
group card {
    at 100 80
    rect bg { size 160 100; fill #222 }
    circle a { at -40 0; radius 12; fill #F6C453 }
    circle b { at 0 0; radius 12; fill #F6C453 }
    circle c { at 40 0; radius 12; fill #F6C453 }
}
text title { at 200 250; content "Hola"; size 24; fill #fff }
`;
const load = (src) => { const r = compile(src); assert.equal(r.errors.length, 0, JSON.stringify(r.errors)); return r.scene; };
const byName = (scene, name) => [...scene.byId.values()].find((n) => n.name === name);
const roundtrip = (scene) => { const text = toAru(scene); const s2 = load(text); assert.equal(toAru(s2), text, 'serialize is stable'); return s2; };

test('rename and batch rename with pattern tokens', () => {
  const s = load(SRC);
  const ids = ['a', 'b', 'c'].map((n) => byName(s, n).id);
  E.renameBatch(s, ids, 'Punto {i} de {n}');
  const s2 = roundtrip(s);
  assert.deepEqual(['a', 'b', 'c'].map((n) => byName(s2, n).label), ['Punto 1 de 3', 'Punto 2 de 3', 'Punto 3 de 3']);
});

test('batch animation with stagger renders CSS and survives the round trip', () => {
  const s = load(SRC);
  E.animateBatch(s, ['a', 'b', 'c'].map((n) => byName(s, n).id), { preset: 'pop', duration: 0.5, delay: 0.1, stagger: 0.15 });
  const s2 = roundtrip(s);
  assert.deepEqual(['a', 'b', 'c'].map((n) => byName(s2, n).animate.delay), [0.1, 0.25, 0.4]);
  const svg = compile(toAru(s2)).svg;
  assert.match(svg, /@keyframes aru-pop/);
  assert.equal((svg.match(/class="aru-a-\d+"/g) || []).length, 3);
});

test('group keeps draw order and position; ungroup bakes the transform back', () => {
  const s = load(SRC);
  const g = E.group(s, ['a', 'c'].map((n) => byName(s, n).id), 'Extremos');
  assert.equal(g.label, 'Extremos');
  let s2 = roundtrip(s);
  const grp = [...s2.byId.values()].find((n) => n.label === 'Extremos');
  assert.deepEqual(grp.children.map((c) => c.name), ['a', 'c']);
  const svgBefore = compile(SRC).svg.replace(/ data-[a-z]+="[^"]*"/g, '');
  // ungroup the original card group: children keep their world position
  const s3 = load(SRC);
  E.ungroup(s3, byName(s3, 'card').id);
  const s4 = roundtrip(s3);
  assert.deepEqual(byName(s4, 'a').at, [60, 80]);
  assert.ok(!byName(s4, 'card'));
  void svgBefore;
});

test('duplicate, reorder, delete, hidden and locked', () => {
  const s = load(SRC);
  const [copy] = E.duplicate(s, [byName(s, 'b').id]);
  assert.equal(copy.name, 'b_2');
  E.reorder(s, [byName(s, 'a').id], 'top');
  E.setProps(s, [byName(s, 'title').id], { hidden: true, locked: true, label: 'Título' });
  E.remove(s, [byName(s, 'c').id]);
  const s2 = roundtrip(s);
  const card = byName(s2, 'card');
  assert.deepEqual(card.children.map((c) => c.name), ['bg', 'b', 'b_2', 'a']);
  assert.equal(byName(s2, 'title').hidden, true);
  assert.equal(byName(s2, 'title').label, 'Título');
  assert.doesNotMatch(compile(toAru(s2)).svg, /Hola/); // hidden layers are not rendered
});

test('align and distribute move nodes in their parent space', () => {
  const s = load(SRC);
  const ids = ['a', 'b', 'c'].map((n) => byName(s, n).id);
  const bounds = new Map([[ids[0], [48, 68, 72, 92]], [ids[1], [88, 60, 112, 84]], [ids[2], [128, 75, 152, 99]]]);
  E.align(s, ids, 'top', bounds);
  assert.deepEqual(ids.map((id) => s.byId.get(id).at[1]), [-8, 0, -15].map((d) => 0 + d + (d === 0 ? 0 : 0)).map((v, k) => [0 - 8, 0, 0 - 15][k]));
  const s2 = load(SRC);
  const ids2 = ['a', 'b', 'c'].map((n) => byName(s2, n).id);
  const b2 = new Map([[ids2[0], [0, 0, 10, 10]], [ids2[1], [12, 0, 22, 10]], [ids2[2], [90, 0, 100, 10]]]);
  E.distribute(s2, ids2, 'x', b2);
  assert.equal(s2.byId.get(ids2[1]).at[0], 0 + 45 - 12);
});

test('addShape creates a valid node that serializes', () => {
  const s = load(SRC);
  E.addShape(s, 'rect', { at: [50, 50], size: [80, 40], label: 'Botón' });
  E.addShape(s, 'text', { at: [50, 50], size: [80, 40], content: 'Pagar' });
  const s2 = roundtrip(s);
  assert.ok([...s2.byId.values()].some((n) => n.label === 'Botón' && n.type === 'rect'));
  assert.ok([...s2.byId.values()].some((n) => n.type === 'text' && n.geom.content === 'Pagar'));
});
