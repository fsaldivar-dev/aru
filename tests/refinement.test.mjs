import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/engine.js';
import { previewRefinement, refinementScope, refinementSystem } from '../src/refinement.js';
import { createIllustrator } from '../plugin/index.js';
import { ANSWER_SCHEMA, parseAnswer } from '../src/agents.js';

const base = `canvas 320 160
background #F8F4EA
gradient amber linear 90 { stop 0 #F29A44; stop 1 #8B492A }
group pack { at 40 30; scale 2; fill none; stroke #604631 1.8; semantic ui.iconpack
 group guitar { at 10 0; label "Guitarra"; semantic instrument.guitar; rotate 4; scale 1.2
  circle body { at 12 15; radius 5; fill amber }
  line neck { from 12 3; to 12 15 }
 }
 group piano { at 50 0; label "Piano"; rect body { at 12 12; size 20 16; fill amber } }
}
rect outside { at 250 100; size 20 20; fill amber }
`;
const body = 'path body { move 4 18; curve 1 10 8 8 10 12; line 11 3; line 14 3; line 15 12; curve 22 8 23 18 18 21; quad 11 24 4 18; close; fill #F29A44; stroke #604631 1.8 }';
const redraw = (target = 'pack.guitar', aru = body) => ({ op: 'redraw', target, aru });
const draw = ops => previewRefinement(base, ops, { mode: 'redraw', selection: ['pack.guitar'] });
const scene = text => compile(text).scene;
const shape = node => JSON.parse(JSON.stringify(node, (k, v) => ['id', 'source', 'line', 'col'].includes(k) ? undefined : v));

test('redraw replaces geometry inside one group, preserves purpose, placement, outside art and undo', () => {
  const session = createIllustrator({ text: base, selection: ['pack.guitar'] });
  const before = scene(base), result = session.refine([redraw()], { mode: 'redraw' }), after = scene(result.text);
  assert.equal(result.geometryPreserved, false);
  assert.equal(after.byPath.get('pack.guitar.body').type, 'path');
  assert.equal(after.byPath.has('pack.guitar.neck'), false);
  for (const field of ['at', 'scale', 'rotate', 'semantic', 'label', 'name']) assert.deepEqual(after.byPath.get('pack.guitar')[field], before.byPath.get('pack.guitar')[field]);
  for (const path of ['pack.piano', 'outside']) assert.deepEqual(shape(after.byPath.get(path)), shape(before.byPath.get(path)));
  assert.equal(after.width, 320); assert.equal(after.background, '#F8F4EA');
  session.undo(); assert.equal(session.getDocument().text, base);
  const scope = refinementScope(base, { mode: 'redraw', selection: ['pack.guitar'] });
  assert.deepEqual(scope.groups[0].localBounds, [7, 3, 17, 20]);
  assert.match(refinementSystem('redraw'), /LOCAL coordinates/);
  assert.match(refinementSystem('style'), /Never redraw/);
  assert.match(refinementSystem('contour'), /Never redraw/);
});

test('redraw is atomic across mixed operations and rejects every scope escape', () => {
  const session = createIllustrator({ text: base, selection: ['pack.guitar'] });
  for (const bad of [
    redraw('outside'), redraw('pack.piano'), redraw('root'), redraw('*'),
    { op: 'delete', target: 'outside' }, { op: 'delete', target: 'pack.guitar' },
    { op: 'ungroup', target: 'pack.guitar' }, { op: 'group', target: 'pack.guitar' },
    { op: 'add', target: 'outside', shape: 'rect' }, { op: 'add', target: 'root', shape: 'rect' },
    { op: 'moveInto', target: 'pack.guitar', other: 'outside' },
    { op: 'weld', target: 'pack.guitar.body', other: 'pack.piano.body' },
    { op: 'connect', target: 'pack.guitar.body', other: 'pack.piano.body' },
    { op: 'set', target: 'pack.piano', fill: '#FF0000' },
    { op: 'set', target: 'pack.guitar', semantic: 'instrument.piano' },
    { op: 'translate', target: 'pack.guitar', dx: 200, dy: 0 },
    { op: 'canvas', target: 'root', w: 500, h: 500 },
  ]) {
    assert.throws(() => session.refine([redraw(), bad], { mode: 'redraw' }), bad.op);
    assert.equal(session.getDocument().text, base);
  }
  assert.throws(() => draw([redraw('type:group')]), /sale|ruta exacta/);
});

test('redraw protects locked descendants and ancestors and needs a group selection', () => {
  for (const text of [base.replace('group pack {', 'group pack { locked 1;'), base.replace('circle body {', 'circle body { locked 1;')]) {
    assert.throws(() => previewRefinement(text, [redraw()], { mode: 'redraw', selection: ['pack.guitar'] }), /bloquead/);
  }
  assert.throws(() => previewRefinement(base, [redraw('pack.guitar.body')], { mode: 'redraw', selection: ['pack.guitar.body'] }), /grupo del icono/);
  for (const mode of ['style', 'contour']) assert.throws(() => previewRefinement(base, [redraw()], { mode, selection: ['pack.guitar'] }), /incompatible/);
});

test('fragment resources are private and cannot repaint siblings through shared gradients', () => {
  const source = `gradient amber linear 0 { stop 0 #000000; stop 1 #FFFFFF }
    circle body { at 12 12; radius 8; fill amber; stroke none }`;
  const result = draw([redraw('pack.guitar', source)]), before = scene(base), after = scene(result.text);
  assert.deepEqual(after.gradients.amber, before.gradients.amber);
  assert.equal(after.byPath.get('outside').fill, 'amber');
  const gradient = after.byPath.get('pack.guitar.body').fill;
  assert.match(gradient, /^aru_redraw_/);
  assert.equal(after.gradients[gradient].stops[0].color, '#000000');
  for (const aru of ['canvas 999 999\n' + body, 'background #000000\n' + body, 'group empty {}', '', 'circle broken { at 1 1;', 'circle bad { radius 4; fill missingGradient }', 'group invisible { hidden 1; circle hidden { radius 8; fill #FF0000 } }', 'group invisible { opacity 0; circle hidden { radius 8; fill #FF0000 } }', 'circle invisible { radius 8; fill none; stroke none }', 'path empty { fill #000000 }']) assert.throws(() => draw([redraw('pack.guitar', aru)]));
  assert.throws(() => draw([redraw(), { op: 'set', target: 'pack.guitar.body', fill: 'none', stroke: 'none' }]), /vaciar u ocultar/);
});

test('redraw preserves the existing group clipping contract', () => {
  const ownClip = base.replace('label "Guitarra";', 'label "Guitarra"; clip body;');
  assert.throws(() => previewRefinement(ownClip, [redraw('pack.guitar', body.replace('body', 'outline'))], { mode: 'redraw', selection: ['pack.guitar'] }), /forma usada como recorte/);
});

test('a redraw and follow-up paint validate newly created paths inside the same transaction', () => {
  const result = draw([redraw('selection', body.replace('body', 'soundboard')), { op: 'set', target: 'pack.guitar.soundboard', fill: '#224488' }]);
  assert.equal(scene(result.text).byPath.get('pack.guitar.soundboard').fill, '#224488');
  assert.equal(result.log.length, 2);
  assert.throws(() => previewRefinement(base, [redraw('selection')], { mode: 'redraw', selection: ['pack.guitar', 'pack.piano'] }), /ruta exacta/);
  const both = previewRefinement(base, [redraw(), redraw('pack.piano', 'rect keys { at 12 12; size 18 10; fill #FFFFFF }')], { mode: 'redraw', selection: ['pack'] });
  assert.equal(scene(both.text).byPath.has('pack.piano.keys'), true);
});

test('structured answers carry scoped fragment operations without enabling top-level replacement', () => {
  const schema = ANSWER_SCHEMA.properties.operations.items;
  assert(schema.properties.op.enum.includes('redraw'));
  assert(schema.required.includes('aru'));
  const answer = parseAnswer('codex', { code: 0, output: JSON.stringify({ reply: 'Corregido', operations: [redraw()], aru: '', aruInto: null, reference: { use: false } }) });
  assert.equal(answer.operations[0].aru, body);
  assert.equal(answer.aru, '');
});

test('a real redraw response cannot rename Tambor to Batería after valid geometry changes', () => {
  // Sanitized reproduction of the desktop replay: three valid redraw operations,
  // then a proposed naming clarification that used to give an opaque error.
  const text = `canvas 160 60\nbackground none\ngroup instrumentos {
    group guitarra { label "Guitarra"; group contenido { circle cuerpo { at 12 12; radius 7; fill none; stroke #2F5148 2 } } }
    group tambor { at 40 0; label "Tambor"; group contenido { rect caja { at 12 12; size 16 14; fill none; stroke #2F5148 2 } } }
    group violin { at 80 0; label "Violín"; group contenido { ellipse cuerpo { at 12 12; size 8 16; fill none; stroke #2F5148 2 } } }
  }`;
  const operations = [
    redraw('instrumentos.guitarra.contenido', 'path cuerpo { move 12 10; curve 9 10 8.5 12.5 9.5 14.5; curve 6 15.5 6.5 22 12 22; curve 17.5 22 18 15.5 14.5 14.5; curve 15.5 12.5 15 10 12 10; close; fill none; stroke #2F5148 2 }'),
    redraw('instrumentos.tambor.contenido', 'circle bombo { at 12 15; radius 5.5; fill none; stroke #2F5148 2 }\ncircle centro { at 12 15; radius 1.5; fill none; stroke #2F5148 1.6 }\nline platillo { from 3 6.5; to 8.5 6.5; stroke #2F5148 2 }\nline soporte { from 5.75 6.5; to 5.75 20.5; stroke #2F5148 1.6 }\nrect tom { at 17 6.5; size 5.5 4; corner 1; fill none; stroke #2F5148 2 }'),
    redraw('instrumentos.violin.contenido', 'path cuerpo { move 11 9; curve 8.5 9 8 11 9 12.5; curve 8 13.5 8.5 14.5 9 15; curve 7 16 7.5 21 11 21; curve 14.5 21 15 16 13 15; curve 13.5 14.5 14 13.5 13 12.5; curve 14 11 13.5 9 11 9; close; fill none; stroke #2F5148 2 }'),
    { op: 'set', target: 'instrumentos.tambor', label: 'Batería' },
  ];
  const session = createIllustrator({ text, selection: ['instrumentos'] });
  assert.throws(() => session.refine(operations, { mode: 'redraw' }), error => {
    assert.equal(error.code, 'REFINEMENT_IDENTITY_PROTECTED');
    assert.equal(error.field, 'label');
    assert.equal(error.target, 'instrumentos.tambor');
    assert.equal(error.operationIndex, 3);
    assert.match(error.message, /Tambor/);
    assert.match(error.message, /en reply/);
    assert.match(error.message, /No se aplicó ninguna operación/);
    return true;
  });
  assert.equal(session.getDocument().text, text);
  assert.equal(session.getDocument().revision, 0);
  assert.match(refinementSystem('redraw'), /Never emit rename or set label\/semantic\/role/);
  assert.match(refinementSystem('redraw'), /must remain a drum/);
  assert.match(refinementSystem('redraw'), /absent from the selected pack/);
});
