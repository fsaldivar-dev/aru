// Assistant chat: provider output parsing, null-field cleanup, and the batch ops the assistant uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswer, ANSWER_SCHEMA, buildPrompt } from '../src/agents.js';
import { applyBatch } from '../src/batch.js';
import { compile } from '../src/engine.js';
import { toAru } from '../src/serialize.js';

const ans = { reply: 'Listo', operations: [{ op: 'set', target: 'card.dot', fill: '#3A7BFF', label: null, stroke: null }] };
test('parses the structured answer of every CLI format', () => {
  const claude = parseAnswer('claude', { code: 0, stdout: JSON.stringify({ structured_output: ans, total_cost_usd: 0.02, duration_ms: 1200 }) });
  assert.equal(claude.reply, 'Listo'); assert.equal(claude.usage.usd, 0.02);
  assert.deepEqual(claude.operations[0], { op: 'set', target: 'card.dot', fill: '#3A7BFF' }, 'null fields are dropped');
  assert.equal(parseAnswer('codex', { code: 0, stdout: '', output: JSON.stringify(ans) }).operations.length, 1);
  assert.equal(parseAnswer('agy', { code: 0, stdout: JSON.stringify({ status: 'SUCCESS', structured_output: ans, usage: { total_tokens: 99 } }) }).usage.tokens, 99);
  assert.equal(parseAnswer('gemini', { code: 0, stdout: JSON.stringify({ response: 'Aquí tienes:\n' + JSON.stringify(ans) }) }).reply, 'Listo');
  assert.throws(() => parseAnswer('codex', { code: 1, stdout: '', output: null, stderr: 'model not supported' }), /model not supported/);
});

test('strict schema lists every field as required (OpenAI-compatible)', () => {
  const item = ANSWER_SCHEMA.properties.operations.items;
  assert.deepEqual(new Set(item.required), new Set(Object.keys(item.properties)));
  assert.equal(item.additionalProperties, false);
});

test('prompt carries context, selection and recent history', () => {
  const p = buildPrompt({ context: 'DOC', selection: ['a.b'], history: [{ role: 'user', text: 'hola' }, { role: 'bot', text: 'ok', applied: 2, log: [{ ok: true, message: '0 puntos retirados' }] }], message: 'azul' });
  assert.match(p, /DOC/); assert.match(p, /a\.b/); assert.match(p, /applied 2 operations/); assert.match(p, /User: azul$/);
  assert.match(p, /Engine results: OK 0 puntos retirados/);
});

test('assistant batch: path-style part: targets, add shapes, failures reported per op', () => {
  const r = compile('canvas 400 300\nbackground #111\ngroup card {\n    circle dot { radius 10; fill #F6C453 }\n}\n');
  const out = applyBatch(r.scene, [
    { op: 'set', target: 'part:card.dot', fill: '#3A7BFF' },
    { op: 'add', target: 'root', shape: 'text', x: 200, y: 260, w: 200, h: 40, text: 'Empezar', label: 'Botón' },
    { op: 'animate', target: 'type:nothing', preset: 'pop' },
  ]);
  assert.deepEqual(out.log.map((l) => l.ok), [true, true, false]);
  const text = toAru(r.scene);
  assert.match(text, /fill #3A7BFF/); assert.match(text, /content "Empezar"/); assert.match(text, /label "Botón"/);
  assert.equal(compile(text).errors.length, 0);
});

import { contextFromParts } from '../src/agents.js';
import { validateContext } from '../vision/context.js';
import { md } from '../src/chat.js';
import { insertFragment } from '../src/edit.js';

test('reference parts from the AI become a valid, nested VisualContext (no geometry)', () => {
  const ctx = contextFromParts([
    { path: 'glove', type: 'glove', importance: 0.9, x: 0.1, y: 0.1, w: 0.8, h: 0.8, geometry: 'organic-clean', edge: 'smooth' },
    { path: 'glove.cuff', importance: 0.6, x: 0.2, y: 0.7, w: 0.6, h: 0.2 },
    { path: 'bad path!', x: 0, y: 0, w: 1, h: 1 },
  ]);
  assert.deepEqual(validateContext(ctx), []);
  assert.equal(ctx.objects.length, 1);
  assert.equal(ctx.objects[0].parts[0].id, 'cuff');
  assert.deepEqual(ctx.objects[0].visualIntent, { geometry: 'organic-clean', edge: 'smooth' });
});

test('answers carry reference and aru; reference.use=false means no reference', () => {
  const base = { reply: 'ok', operations: [], aru: 'group g { rect r { size 10 10 } }', reference: { use: false, image: '', label: '', parts: [] } };
  const a = parseAnswer('claude', { code: 0, stdout: JSON.stringify({ type: 'result', structured_output: base }) });
  assert.equal(a.reference, null); assert.match(a.aru, /group g/);
  const b = parseAnswer('codex', { code: 0, output: JSON.stringify({ ...base, aru: '', reference: { use: true, image: 'ref1', label: 'Guante', x: null, parts: [] } }) });
  assert.equal(b.reference.image, 'ref1'); assert.equal('x' in b.reference, false);
  for (const k of ['reference', 'aru']) assert.ok(ANSWER_SCHEMA.required.includes(k));
});

test('chat markdown is escaped and minimal', () => {
  const h = md('Es el **icono**:\n- uno\n- `dos`\n<script>x</script>');
  assert.match(h, /<b>icono<\/b>/); assert.match(h, /<ul><li>uno<\/li><li><code>dos<\/code><\/li><\/ul>/);
  assert.doesNotMatch(h, /<script>/);
});

test('insertFragment: single group goes in as itself; gradients renamed; filter drops nodes', () => {
  const doc = compile('canvas 400 300\nbackground #111\ngradient g linear 0 { stop 0 #000; stop 1 #fff }\nrect r { size 10 10; fill g }\n').scene;
  const frag = compile('canvas 400 300\nbackground none\ngradient g linear 90 { stop 0 #f00; stop 1 #00f }\ngroup guante { label "Guante"; circle c { radius 10; fill g } rect bg { size 400 300; fill #FFFFFF } }\n').scene;
  const g = insertFragment(doc, frag, { label: 'Guante', keep: (n) => n.name !== 'bg' });
  assert.equal(g.name, 'guante'); assert.equal(g.children.length, 1);
  const text = toAru(doc);
  assert.match(text, /gradient guante_g linear/); assert.match(text, /fill guante_g/); assert.match(text, /fill g }/);
  assert.equal(compile(text).errors.length, 0);
});

test('contextFromParts: missing parents are created, so equal leaf ids under different parents stay valid', async () => {
  const { contextFromParts } = await import('../src/agents.js');
  const { validateContext, normalizeContext } = await import('../vision/context.js');
  const ctx = contextFromParts([
    { path: 'wolf.left.furStrands', x: 0.1, y: 0.2, w: 0.2, h: 0.3 },
    { path: 'wolf.right.furStrands', x: 0.6, y: 0.2, w: 0.2, h: 0.3 },
    { path: 'background', x: 0, y: 0, w: 1, h: 1 },
  ]);
  assert.deepEqual(validateContext(ctx), []);
  const paths = normalizeContext(ctx).nodes.map((n) => n.path);
  assert.ok(paths.includes('wolf.left.furStrands') && paths.includes('wolf.right.furStrands'), paths.join(', '));
});
