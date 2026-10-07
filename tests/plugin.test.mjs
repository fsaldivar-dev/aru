import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createIllustrator, documentContext } from '../plugin/index.js';
import { renderPng, traceInto, askIllustrator } from '../plugin/node.js';
const base = 'canvas 320 240\nbackground #FFFFFF\ngroup base { at 0 0; circle ojo { at 40 40; radius 15; fill #333333; semantic cara.ojo } }\n';
test('plugin: atomic batch, revision, selection, undo/redo and invalid-load retention', () => {
  const s = createIllustrator({ text: base }); s.select(['base.ojo']);
  assert.throws(() => s.apply([{ op: 'set', target: 'selection', fill: '#FF0000' }, { op: 'unknown', target: 'base' }])); assert.equal(s.getDocument().text, base);
  s.apply([{ op: 'set', target: 'selection', fill: '#FF0000' }], { expectedRevision: 0 });
  assert.throws(() => s.apply([{ op: 'translate', target: 'base', dx: 5 }], { expectedRevision: 0 }));
  assert.throws(() => s.load('bad {')); assert.match(s.getDocument().text, /#FF0000/);
  assert(s.undo()); assert.equal(s.getDocument().text, base); assert(s.redo()); assert.match(s.getDocument().text, /#FF0000/);
  assert.equal(s.context().layers.find(l => l.path === 'base.ojo').semantic, 'cara.ojo');
});
test('plugin: inherited lock is protected', () => {
  const s = createIllustrator({ text: base.replace('at 0 0;', 'at 0 0; locked;') });
  assert.throws(() => s.apply([{ op: 'set', target: 'base.ojo', fill: '#FF0000' }]), /bloqueada/);
});
test('plugin: canvas-space insert into rotated/scaled nested group keeps world bounds and remaps gradients', () => {
  const s = createIllustrator({ text: 'canvas 400 400\nbackground #FFF\ngradient tinta linear 90 { stop 0 #000; stop 1 #FFF }\ngroup destino { at 80 60; scale 2; rotate 30; circle old { at 0 0; radius 1; fill tinta } }' });
  s.insert('gradient tinta linear 90 { stop 0 #F00; stop 1 #FF0 }\ncircle detalle { at 200 200; radius 10; fill tinta }', { into: 'destino', label: 'nuevo' });
  const l = s.context().layers.find(l => l.path.endsWith('.detalle'));
  assert(Math.abs(l.bounds[0] - 190) < 10); assert(Math.abs(l.bounds[2] - 210) < 10); // transformed bounding boxes are conservative
  assert.match(l.fill, /tinta/); assert.notEqual(l.fill, 'tinta');
  s.undo(); assert(!s.context().layers.some(l => l.path.endsWith('.detalle')));
});
test('plugin: reference, editable opaque background, glyph and PNG all-alpha opaque', async () => {
  const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="white"/><circle cx="40" cy="40" r="25" fill="#205F45"/><circle cx="40" cy="40" r="12" fill="white"/></svg>')).png().toBuffer();
  const s = createIllustrator({ text: base });
  const r = await traceInto(s, image, { label: 'Glifo', dropHoles: true, backdrop: { shape: 'squircle', style: 'glyph', color: '#C8643A', glyphColor: '#FFFFFF', depth: .5 } });
  assert(r.attempts.length >= 2); assert(s.context().layers.some(l => l.semantic === 'illustration.background'));
  const { data, info } = await sharp(await renderPng(s.getDocument().text)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += info.channels) assert.equal(data[i], 255);
});
test('plugin: agent gets schema/context/canvas, prepares one undo transaction and rejects stale output', async () => {
  const answer = { reply: 'Listo', operations: [{ op: 'set', target: 'base.ojo', fill: '#AABBCC' }], reference: { use: false }, aru: '', aruInto: '' };
  const s = createIllustrator({ text: base });
  const transport = { run: async req => { assert.match(req.prompt, /cara.ojo/); assert(req.images.some(i => i.name === 'canvas')); assert(req.schema.properties.operations); return { ok: true, stdout: JSON.stringify({ structured_output: answer }), ms: 1 }; } };
  await askIllustrator(s, { message: 'Cambia el ojo', transport, review: 0 }); assert.match(s.getDocument().text, /#AABBCC/); s.undo(); assert.equal(s.getDocument().text, base);
  const stale = { run: async () => { s.apply([{ op: 'translate', target: 'base', dx: 3 }]); return { ok: true, stdout: JSON.stringify({ structured_output: answer }) }; } };
  await assert.rejects(askIllustrator(s, { message: 'Cambia el ojo', transport: stale, review: 0 }), /cambió/); assert(!s.getDocument().text.includes('#AABBCC'));
});
test('plugin: packs use blind recognition and scored cleanup before insertion', async () => {
  const pack = 'group pack { label "Pack"; semantic ui.iconpack; group home { label "Inicio"; path roof { move 3 11; line 12 4; line 21 11; fill none; stroke #2F5148 1 } } group search { at 40 0; label "Buscar"; circle lens { at 10 10; radius 7; fill none; stroke #2F5148 3 } } group user { at 80 0; label "Perfil"; circle head { at 12 8; radius 5; fill none; stroke #2F5148 2 } } }';
  const replies = [{ reply: 'Pack', operations: [], reference: { use: false }, aru: pack, aruInto: '' }, { answers: [{ icon: 1, meaning: 'Inicio' }, { icon: 2, meaning: 'Buscar' }, { icon: 3, meaning: 'Perfil' }] }, { accept: false, reason: 'Unificar trazos', levers: { stroke: 2 }, redraw: [] }];
  let index = 0;
  const s = createIllustrator({ text: base });
  const result = await askIllustrator(s, { message: 'Mejora este pack', review: 1, transport: { run: async req => {
    if (index === 1) { assert.match(req.prompt, /Icons: 1..3/); assert.equal(req.images[0].name, 'blind'); }
    if (index === 2) assert.equal(req.images[0].name, 'pack');
    return { ok: true, stdout: JSON.stringify({ structured_output: replies[index++] }) };
  } } });
  assert.equal(index, 3); assert.equal(result.report.pack.length, 1); assert(s.context().layers.some(l => l.semantic === 'ui.iconpack'));
  s.undo(); assert.equal(s.getDocument().text, base);
});
test('plugin: reference review, numbered pieces and glyph inspection share one workflow', async () => {
  const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="white"/><circle cx="40" cy="40" r="25" fill="#205F45"/><circle cx="40" cy="40" r="12" fill="white"/></svg>')).png().toBuffer();
  let calls = 0;
  const transport = { run: async req => {
    let answer;
    if (calls === 0) answer = { reply: 'Glifo desde referencia', operations: [], aru: '', aruInto: '', reference: { use: true, image: 'ref1', label: 'Glifo', parts: [{ name: 'aro', x: 0, y: 0, w: 1, h: 1 }], dropHoles: true, backdrop: { shape: 'squircle', style: 'glyph', color: '#C8643A', glyphColor: '#FFFFFF' } } };
    if (calls === 1) { assert.equal(req.images[0].name, 'compare'); answer = { accept: true, reason: 'Fiel', tune: { ink: 'off', faint: 1, abstraction: .5, detail: 'high' } }; }
    if (calls === 2) { assert.equal(req.images[0].name, 'pieces'); answer = { assignments: [{ piece: 1, part: 'aro' }] }; }
    if (calls === 3) { assert.equal(req.images[0].name, 'icon'); const info = await sharp(Buffer.from(req.images[0].data, 'base64')).metadata(); assert.equal(info.width, 744); assert.equal(info.height, 560); answer = { accept: true, reason: 'Limpio', params: {} }; }
    calls++; return { ok: true, stdout: JSON.stringify({ structured_output: answer }) };
  } };
  const s = createIllustrator(); const r = await askIllustrator(s, { message: 'Transforma la base', images: [image], transport, review: 1 });
  assert.equal(calls, 4); assert.equal(r.report.review.length, 1); assert.equal(r.report.glyph.length, 1); assert(r.report.reference.score > 0); assert(s.context().layers.some(l => l.semantic === 'illustration.background'));
});
