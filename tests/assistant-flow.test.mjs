import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantFlow, validateAssistantAnswer, correctiveIntent } from '../src/assistant-flow.js';
import { requestedIconCount } from '../src/icon-production.js';

test('a pack has one authoritative count and always adds that many new icons', () => {
  const flow = assistantFlow({ kind: 'icon-pack', quantity: 320, purpose: 'Un reproductor musical', message: 'Controles vintage en sepia', selection: ['existing-pack'] });
  assert.equal(flow.error, null);
  assert.equal(flow.target, 320);
  assert.match(flow.message, /^Crea exactamente 320 iconos nuevos/);
  assert.equal(requestedIconCount(flow.message), 320);
  assert.match(flow.message, /reproductor musical/);
  assert.match(flow.context, /Conserva la geometría y la apariencia de todos los dibujos existentes/);
  assert.match(flow.context, /selección actual sirve solo como referencia/);
  assert.match(flow.context, /no incluye los iconos que ya existen/);
  assert.equal(flow.canMutate, true);

  const mismatch = assistantFlow({ kind: 'icon-pack', quantity: 24, message: 'Crea un pack de 320 iconos de música' });
  assert.match(mismatch.error, /24.*320/);
  assert.equal(mismatch.canMutate, false);
  assert.equal(mismatch.target, null);
  assert.throws(() => validateAssistantAnswer(mismatch, { operations: [] }), /24.*320/);
  for (const quantity of [0, -1, 1.5, 1001, NaN, Infinity, '24']) {
    const invalid = assistantFlow({ kind: 'icon-pack', quantity, message: 'Controles' });
    assert.match(invalid.error, /entero entre 1 y 1000/);
    assert.equal(invalid.canMutate, false);
    assert.equal(invalid.target, null);
    assert.throws(() => validateAssistantAnswer(invalid, { operations: [] }), /entero entre 1 y 1000/);
  }
  for (const quantity of [1, 1000]) assert.equal(assistantFlow({ kind: 'icon-pack', quantity, message: 'Controles' }).error, null);
});

test('creation can start from a purpose or reference, but not just a chosen finish', () => {
  assert.equal(assistantFlow({ purpose: 'Una app de automatizaciones móviles', kind: 'app-icon' }).error, null);
  const reference = assistantFlow({ hasReferences: true });
  assert.equal(reference.error, null);
  assert.match(reference.message, /imágenes adjuntas como base/);
  assert.equal(reference.illustrator, true);
  assert.equal(reference.refinement, null);
  assert.equal(reference.appearance, true);
  assert.equal(reference.target, null);
  assert.equal(assistantFlow({ message: '  ', purpose: ' ', style: 'Fruits', material: 'glass' }).canMutate, false);
  // Sizes inside the brief do not create a conflicting icon count.
  assert.equal(assistantFlow({ kind: 'icon-pack', quantity: 24, message: 'Crea controles legibles a 320 px' }).error, null);
});

test('refinement needs an explicit selection and an actionable appearance brief', () => {
  const missing = assistantFlow({ mode: 'refine', message: 'Hazlos azules' });
  assert.match(missing.error, /Selecciona en el lienzo/);
  assert.equal(missing.canMutate, false);
  const empty = assistantFlow({ mode: 'refine', selection: ['icon'], purpose: 'Un reproductor musical' });
  assert.match(empty.error, /Describe qué color o acabado/);
  assert.equal(empty.canMutate, false);
  const flow = assistantFlow({ mode: 'refine', selection: ['pack/play'], color: '#3344ff', material: 'cristal' });
  assert.equal(flow.error, null);
  assert.equal(flow.refinement, 'style');
  assert.equal(flow.illustrator, false);
  assert.equal(flow.appearance, true);
  assert.match(flow.message, /#3344ff/);
  assert.match(flow.context, /pack\/play/);
  assert.match(flow.context, /Conserva la geometría/);
  assert.match(flow.context, /No añadas ni elimines piezas/);
  assert.equal(flow.target, null);
});

test('cleaning curves never inherits a previously chosen finish or palette', () => {
  const flow = assistantFlow({ mode: 'refine', refinement: 'contour', selection: ['logo'], style: 'Fruits', material: 'chrome', color: '#FF00FF' });
  assert.equal(flow.error, null);
  assert.equal(flow.appearance, false);
  assert.equal(flow.illustrator, false);
  assert.equal(flow.refinement, 'contour');
  assert.match(flow.message, /suaviza las curvas/);
  assert.match(flow.context, /conserva los colores/);
  assert.match(flow.context, /huecos y conexiones/);
  assert.doesNotMatch(flow.context, /Fruits|chrome|#FF00FF/);
});

test('an accent requires a primary color only when the task actually uses appearance', () => {
  for (const options of [{ mode: 'create', message: 'Un icono de cámara' }, { mode: 'refine', selection: ['icon'], refinement: 'style', message: 'Mejora el contraste' }]) {
    const invalid = assistantFlow({ ...options, accent: '#FFCC00', color: '  ' });
    assert.match(invalid.error, /color principal/);
    assert.equal(invalid.canMutate, false);
    assert.throws(() => validateAssistantAnswer(invalid, { operations: [] }), /color principal/);
    const valid = assistantFlow({ ...options, color: '#224488', accent: '#FFCC00' });
    assert.equal(valid.error, null);
    assert.match(valid.context, /Color principal: #224488; Color de acento: #FFCC00/);
  }
  for (const options of [{ mode: 'consult', message: '¿Cómo mejoro la legibilidad?' }, { mode: 'refine', refinement: 'contour', selection: ['icon'] }]) {
    const flow = assistantFlow({ ...options, accent: '#FFCC00' });
    assert.equal(flow.error, null);
    assert.equal(flow.appearance, false);
    assert.doesNotMatch(flow.context, /#FFCC00/);
  }
});

test('consultation cannot mutate even when stale editing controls remain selected', () => {
  const flow = assistantFlow({ mode: 'consult', kind: 'icon-pack', quantity: 320, refinement: 'free', selection: ['logo'], message: '¿Cómo harías más legible este logo?', style: 'Fruits', material: 'glass', color: '#00ffff' });
  assert.equal(flow.error, null);
  assert.equal(flow.canMutate, false);
  assert.equal(flow.illustrator, false);
  assert.equal(flow.appearance, false);
  assert.equal(flow.refinement, null);
  assert.equal(flow.target, null);
  assert.match(flow.context, /Solo lectura/);
  assert.doesNotMatch(flow.context, /Fruits|glass|#00ffff|320/);
  assert.match(assistantFlow({ mode: 'consult' }).error, /Escribe la pregunta/);
});

test('unknown tasks and unsupported refinements fail closed', () => {
  assert.equal(assistantFlow({ mode: 'refine', refinement: 'free', selection: ['character'], message: 'Añade una bufanda' }).canMutate, false);
  assert.equal(assistantFlow({ mode: 'unknown', message: 'Borra todo' }).canMutate, false);
  assert.equal(assistantFlow({ kind: 'unknown', message: 'Crea algo' }).canMutate, false);
});

test('a creation answer cannot mix a valid new drawing with deletion or edits to an existing one', () => {
  const flow = assistantFlow({ message: 'Un icono de cámara' });
  const drawing = { aru: 'canvas 24 24\ncircle lens 12 12 4', aruInto: null, reference: null, operations: [] };
  assert.equal(validateAssistantAnswer(flow, drawing), drawing);
  for (const operation of [{ op: 'delete', target: 'existing-logo' }, { op: 'set', target: 'existing-logo' }, { op: 'add', target: 'existing-logo' }]) {
    assert.throws(() => validateAssistantAnswer(flow, { ...drawing, operations: [operation] }), /Solo se permite añadir dibujos nuevos/);
  }
  assert.throws(() => validateAssistantAnswer(flow, { ...drawing, aruInto: 'existing-logo' }), /pieza existente/);
  for (const target of [null, undefined, '', 'root', 'canvas']) {
    assert.doesNotThrow(() => validateAssistantAnswer(flow, { ...drawing, operations: [{ op: 'add', target }] }));
  }
});

test('consultation rejects every mutation channel before the caller changes the document', () => {
  const flow = assistantFlow({ mode: 'consult', message: '¿Qué mejorarías?' });
  const answer = { reply: 'Mejoraría el contraste.', operations: [], aru: '', reference: null, aruInto: null };
  assert.doesNotThrow(() => validateAssistantAnswer(flow, answer));
  for (const changes of [{ operations: [{ op: 'set', target: 'icon', fill: '#000000' }] }, { aru: 'circle icon 12 12 6' }, { reference: { use: true, image: 'ref1' } }, { aruInto: 'icon' }]) {
    assert.throws(() => validateAssistantAnswer(flow, { ...answer, ...changes }), /durante una consulta/);
  }
  assert.throws(() => validateAssistantAnswer(flow, { ...answer, operations: null }), /formato válido/);
});

test('refinement rejects replacement drawings and delegates scoped operations to its own validator', () => {
  const flow = assistantFlow({ mode: 'refine', selection: ['icon'], color: '#123456' });
  const answer = { operations: [{ op: 'palette', target: 'icon', color: '#123456' }], aru: '', reference: null, aruInto: null };
  assert.doesNotThrow(() => validateAssistantAnswer(flow, answer));
  assert.throws(() => validateAssistantAnswer(flow, { ...answer, aru: 'circle replacement 12 12 6' }), /añadir o reemplazar/);
  assert.throws(() => validateAssistantAnswer(flow, { ...answer, reference: { use: true } }), /añadir o reemplazar/);
  assert.throws(() => validateAssistantAnswer(assistantFlow({ mode: 'refine' }), answer), /Selecciona/);
});

test('corrective feedback cannot silently become a new collection', () => {
  for (const message of ['no logro distinguir entre el bajo, la guitarra, la batería y el violín', 'mejóralos', 'hazlos más reconocibles', 'corrige los instrumentos', 'se ven iguales']) {
    assert.deepEqual(correctiveIntent(message)?.refinement, 'redraw');
    const flow = assistantFlow({ message, selection: ['pack'] });
    assert.equal(flow.canMutate, false);
    assert.equal(flow.suggestion.mode, 'refine');
    assert.equal(flow.suggestion.refinement, 'redraw');
    assert.equal(flow.message, message);
    assert.match(flow.error, /Selecciona los iconos/);
    assert.throws(() => validateAssistantAnswer(flow, { aru: 'group accidental {}', operations: [] }), /corrección/);
  }
  for (const message of ['no, te pedí nuevos iconos pero con diferente estilo', 'Crea nuevos iconos de instrumentos, los anteriores son confusos', 'Genera otro pack', 'Quiero otros instrumentos', 'Crea un icono de guitarra', 'Una app que ayuda a distinguir instrumentos']) {
    assert.equal(correctiveIntent(message), null);
    assert.equal(assistantFlow({ message }).error, null);
  }
  assert.equal(correctiveIntent('No crees nuevos iconos, corrige los anteriores').refinement, 'redraw');
});

test('redraw is explicit, selected, contextual and keeps top-level insert channels closed', () => {
  const missing = assistantFlow({ mode: 'refine', refinement: 'redraw', message: 'Hazlos más reconocibles' });
  assert.equal(missing.canMutate, false);
  assert.match(missing.error, /Selecciona/);
  assert.match(assistantFlow({ mode: 'refine', refinement: 'redraw', selection: ['pack'] }).error, /Describe qué falla/);
  const flow = assistantFlow({ mode: 'refine', refinement: 'redraw', selection: ['pack.guitarra'], message: 'Haz la silueta reconocible', color: '#F29A44' });
  assert.equal(flow.error, null);
  assert.equal(flow.refinement, 'redraw');
  assert.equal(flow.illustrator, false);
  assert.match(flow.context, /formas interiores/);
  assert.match(flow.context, /pack.guitarra/);
  assert.match(flow.context, /#F29A44/);
  const answer = { operations: [{ op: 'redraw', target: 'pack.guitarra', aru: 'path cuerpo { move 2 2; line 10 10 }' }], aru: '', reference: null };
  assert.doesNotThrow(() => validateAssistantAnswer(flow, answer));
  assert.throws(() => validateAssistantAnswer(flow, { ...answer, aru: answer.operations[0].aru }), /añadir o reemplazar/);
  assert.throws(() => validateAssistantAnswer(flow, { ...answer, reference: { use: true } }), /añadir o reemplazar/);
});
