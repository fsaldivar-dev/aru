import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/engine.js';
import { toAru } from '../src/serialize.js';
import { insertFragment } from '../src/edit.js';
import { opaqueColor, withOpaqueBackground } from '../src/opaque.js';
import { findPack } from '../trace/iconpack.js';

const donut = `canvas 64 64
background none
group figure {
    path ring { move 4 4; line 60 4; line 60 60; line 4 60; close; move 20 20; line 20 44; line 44 44; line 44 20; close; fill #C8643A }
    rect backdrop { at 32 32; size 64 64; fill #FFFFFF }
}`;

test('opaque fragment: filtering preserves holes and an editable background survives insertion and serialization', () => {
  const src = compile(donut).scene, before = toAru(src), commands = src.byPath.get('figure.ring').geom.commands;
  const fragment = withOpaqueBackground(src, { color: '#f4f1ea', keep: (n) => n.name !== 'backdrop' });
  const doc = compile('canvas 128 128\nbackground none').scene;
  insertFragment(doc, fragment, { at: [16, 16], scale: 0.5 });
  const saved = compile(toAru(doc));
  assert.equal(saved.errors.length, 0);
  const g = saved.scene.root.children[0], figure = g.children[0];
  assert.equal(figure.children[0].label, 'Fondo opaco');
  assert.equal(figure.children[0].fill, '#F4F1EA');
  assert.equal(figure.children[0].opacity, 1);
  assert.equal(figure.children[0].fillOpacity, 1);
  const geometry = (cs) => cs.map(({ cmd, args }) => ({ cmd, args }));
  assert.deepEqual(geometry(figure.children[1].geom.commands), geometry(commands), 'compound path and counter unchanged');
  assert.deepEqual(g.at, [16, 16]); assert.deepEqual(g.scale, [0.5, 0.5]);
  assert.equal(toAru(src), before, 'winning trace not changed by filtering or insertion');
});

test('a translucent or clipped subject cannot apply its alpha or clipping to the opaque background', () => {
  for (const props of ['opacity 0.4', 'clip ring']) {
    const src = compile(donut.replace('group figure {', `group figure { ${props};`)).scene;
    const frag = withOpaqueBackground(src);
    assert.equal(frag.root.children[0].type, 'rect');
    assert.equal(frag.root.children[0].opacity, 1);
    assert.equal(frag.root.children[1].type, 'group');
  }
});

test('background uses measured fragment bounds and does not become a canvas-sized frame', () => {
  const frag = withOpaqueBackground(compile(donut).scene, { bounds: [4, 8, 60, 48] });
  const bg = frag.root.children[0].children[0];
  assert.deepEqual(bg.at, [32, 28]); assert.deepEqual(bg.geom.size, [56, 40]);
  assert.throws(() => withOpaqueBackground(compile(donut).scene, { bounds: [0, 0, NaN, 64] }), /área/);
});

test('opaque background leaves icon pack identity and its three icon groups intact', () => {
  const src = compile('canvas 96 32\nbackground none\ngroup pack { semantic ui.iconpack; group a { circle x { radius 8 } } group b { circle y { radius 8 } } group c { circle z { radius 8 } } }').scene;
  const frag = compile(toAru(withOpaqueBackground(src))).scene;
  assert.ok(findPack(frag));
  assert.equal(findPack(frag).children.filter((c) => c.type === 'group').length, 3);
});

test('no transparent paint can be used as the solid background; empty fragments stay empty', () => {
  assert.equal(opaqueColor('none'), '#FFFFFF'); assert.equal(opaqueColor('transparent'), '#FFFFFF');
  assert.equal(opaqueColor('#ABC0'), '#AABBCC'); assert.equal(opaqueColor('#10203000'), '#102030');
  assert.equal(withOpaqueBackground(compile('canvas 64 64\nbackground none').scene).root.children.length, 0);
});
