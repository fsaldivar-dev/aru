import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { compile } from '../src/engine.js';
import { preparePack, applyPack, setPackRecognition, needsPackRecognition } from '../src/pack-tools.js';
import { createIllustrator } from '../plugin/core.js';
import { rasterize, askIllustrator } from '../plugin/node.js';

const triangle = 'polygon shape { points 4 4 20 20 4 20; fill #222222 }';
const mirrored = 'polygon shape { points 20 4 4 20 20 20; fill #222222 }';
const pack = `group pack { semantic ui.iconpack
  group home { label "Inicio"; ${triangle} }
  group search { at 32 0; label "Buscar"; rect shape { at 12 12; size 16 16; fill #222222 } }
  group user { at 64 0; label "Perfil"; circle shape { at 12 12; radius 8; fill #222222 } }
}`;
const doc = compile('canvas 200 80\nbackground #FFFFFF').scene;
const blind = { order: ['home', 'search', 'user'] };
const answers = meaning => [{ icon: 1, meaning }, { icon: 2, meaning: 'Buscar' }, { icon: 3, meaning: 'Perfil' }];
const prepare = () => preparePack(pack, doc, rasterize);

test('unverified and incomplete blind recognition cannot imply recognized or perfect quality', async () => {
  const pk = await prepare();
  assert.deepEqual(pk.ins.recognition, { recognized: 0, failed: 0, unverified: 3, total: 3, complete: false });
  assert(needsPackRecognition(pk));
  assert(pk.ins.score < pk.ins.geometryScore);
  assert(pk.ins.icons.every(icon => icon.issues.some(issue => /reconocimiento pendiente/.test(issue))));
  await setPackRecognition(pk, blind, [{ icon: 1, meaning: 'Inicio' }, { icon: 9, meaning: 'Perfil' }, { icon: 2, meaning: '' }], rasterize);
  assert.deepEqual(pk.ins.recognition, { recognized: 1, failed: 0, unverified: 2, total: 3, complete: false });
  assert.match(pk.report, /1\/3 recognized, 0 failed, 2 unverified/);
  await setPackRecognition(pk, blind, [...answers('Inicio'), { icon: 1, meaning: 'Otro: triángulo' }], rasterize);
  assert.equal(pk.ins.recognition.unverified, 1, 'conflicting duplicate answers are not trusted');
});

test('a same-quality redraw of a failed icon stays pending without a score boost', async () => {
  const pk = await prepare();
  await setPackRecognition(pk, blind, answers('Otro: triángulo'), rasterize);
  const before = pk.ins.score, geometry = pk.ins.geometryScore;
  const changes = await applyPack(pk, { redraw: [{ icon: 'home', aru: mirrored }] }, rasterize);
  assert.equal(changes[0].kept, true);
  assert.equal(changes[0].pending, true);
  assert.equal(pk.ins.geometryScore, geometry);
  assert.equal(pk.ins.score, before, 'removing a failure must not increase the score');
  assert.deepEqual(pk.ins.recognition, { recognized: 2, failed: 0, unverified: 1, total: 3, complete: false });
  assert(needsPackRecognition(pk));
  await setPackRecognition(pk, blind, answers('Inicio'), rasterize);
  assert.equal(needsPackRecognition(pk), false);
  assert.equal(pk.ins.recognition.recognized, 3);
  assert(pk.ins.score > before, 'only successful fresh recognition removes the semantic penalty');
});

test('no-op and worse redraws retain the old failure and drawing', async () => {
  for (const aru of [triangle, triangle.replace('shape', 'renamed'), '']) {
    const pk = await prepare();
    await setPackRecognition(pk, blind, answers('Otro: triángulo'), rasterize);
    const before = pk.P.packFragment(pk.scene), score = pk.ins.score;
    const changes = await applyPack(pk, { redraw: [{ icon: 'home', aru }] }, rasterize);
    assert.equal(changes[0].kept, false, aru);
    assert.equal(pk.P.packFragment(pk.scene), before);
    assert.equal(pk.ins.recognition.failed, 1);
    assert.equal(pk.recognition.get('home').ok, false);
    assert.equal(pk.ins.score, score);
  }
});

test('geometry cleanup invalidates recognition only for drawings it changed', async () => {
  const outlined = `group pack { semantic ui.iconpack
    group home { label "Inicio"; path roof { move 3 11; line 12 4; line 21 11; fill none; stroke #222222 1 } }
    group search { at 32 0; label "Buscar"; circle lens { at 10 10; radius 7; fill none; stroke #222222 3 } }
    group user { at 64 0; label "Perfil"; circle head { at 12 8; radius 5; fill none; stroke #222222 2 } }
  }`;
  const pk = await preparePack(outlined, doc, rasterize);
  await setPackRecognition(pk, blind, answers('Inicio'), rasterize);
  const before = pk.ins.geometryScore;
  const changes = await applyPack(pk, { levers: { strokeWidth: 2 } }, rasterize);
  assert.equal(changes[0].kept, true);
  assert(pk.ins.geometryScore > before);
  assert.deepEqual(pk.ins.recognition, { recognized: 1, failed: 0, unverified: 2, total: 3, complete: false });
  assert.equal(pk.recognition.get('user').ok, true);
  assert(needsPackRecognition(pk));
});

for (const recognized of [false, true]) test(`Node review rechecks the last redraw and reports ${recognized ? 'recognized' : 'still misread'} output`, async () => {
  const replies = [
    { reply: 'Pack', aru: pack, operations: [], reference: { use: false }, aruInto: '' },
    { answers: answers('Otro: triángulo') },
    { accept: false, reason: 'Corregir Inicio', levers: {}, redraw: [{ icon: 'home', aru: mirrored }] },
    { answers: answers(recognized ? 'Inicio' : 'Otro: triángulo') },
  ];
  const session = createIllustrator({ text: 'canvas 200 80\nbackground #FFFFFF' });
  const calls = [];
  const result = await askIllustrator(session, { message: 'Dibuja un pack de iconos', review: 1, transport: { run: async req => {
    calls.push(req.images[0].name);
    if (req.images[0].name === 'blind') {
      const pixels = await sharp(Buffer.from(req.images[0].data, 'base64')).extract({ left: 52, top: 110, width: 24, height: 24 }).removeAlpha().raw().toBuffer();
      assert(pixels.some(value => value < 200), 'the blind sheet includes the actual 24px rendering described to the model');
    }
    return { ok: true, stdout: JSON.stringify({ structured_output: replies.shift() }) };
  } } });
  assert.deepEqual(calls, ['canvas', 'blind', 'pack', 'blind']);
  assert.equal(result.report.packFinalRecognition.misread.length, recognized ? 0 : 1);
  assert.equal(result.report.packRecognition.recognized, recognized ? 3 : 2);
  assert.equal(result.report.packRecognition.failed, recognized ? 0 : 1);
  assert.equal(result.report.packRecognition.unverified, 0);
  assert.equal(result.report.warnings.some(warning => /no se reconocen/.test(warning)), !recognized);
  assert.match(session.getDocument().text, /points 20 4 4 20 20 20/);
});
