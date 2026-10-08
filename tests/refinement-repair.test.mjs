import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createIllustrator } from '../plugin/core.js';
import { refineIllustration } from '../plugin/node.js';

const original = await fs.readFile(new URL('./fixtures/desktop-instruments.aru', import.meta.url), 'utf8');
const rejected = JSON.parse(await fs.readFile(new URL('./fixtures/desktop-instruments-rejected.json', import.meta.url), 'utf8'));
const reply = (operations, text = 'Cambios preparados') => ({ ok: true, ms: 5, stdout: JSON.stringify({ structured_output: { reply: text, operations, aru: '', reference: { use: false }, aruInto: null } }) });
const source = 'canvas 4000 4000\nbackground #FFFFFF\ngroup selected { at 1800 1000; label "Objeto"; rect box { at 12 12; size 16 16; fill #234567 } }\nrect outside { at 3500 3500; size 300 300; fill #CC3311 }';
const valid = [{ op: 'set', target: 'selected.box', fill: '#0088FF' }];
const invalid = [{ op: 'set', target: 'selected', label: 'Otra identidad' }];

test('captured desktop redraw plus forbidden rename is repaired once without partial changes', async () => {
  let changes = 0, calls = 0;
  const session = createIllustrator({ text: original, selection: ['instrumentos'], onChange: () => changes++ });
  const corrected = rejected.operations.filter(op => op.op === 'redraw' && !op.target.includes('.tambor.'));
  const prompts = [], snapshots = [];
  const result = await refineIllustration(session, { mode: 'redraw', message: 'No logro distinguir la guitarra del violín', history: [{ role: 'user', text: 'Conserva los diez instrumentos originales' }], transport: { run: async req => {
    prompts.push(req.prompt); snapshots.push(req.images[0].data); calls++;
    assert.equal(session.getDocument().text, original, 'neither initial redraws nor rename were committed');
    assert.equal(changes, 0);
    assert.match(req.prompt, /Conserva los diez instrumentos originales/);
    return calls === 1 ? reply(rejected.operations, rejected.reply) : reply(corrected, 'Corregí guitarra y violín; conservé las otras identidades.');
  } } });
  assert.equal(calls, 2);
  assert.equal(changes, 1);
  assert.equal(snapshots[0], snapshots[1], 'the retry sees exactly the same captured selection');
  assert.match(prompts[1], /Actual validation error:\nEl refinamiento protege label/);
  assert.match(prompts[1], /Do not rename objects or repurpose/);
  assert.match(prompts[1], /"label":"Batería"/);
  assert.equal(result.report.attempts, 2);
  assert.equal(result.report.repaired, true);
  assert.match(result.report.repairError, /protege label/);
  assert.equal(result.report.ms, 10);
  assert.equal(session.context().layers.find(layer => layer.path === 'instrumentos.tambor').label, 'Tambor');
  session.undo(); assert.equal(session.getDocument().text, original, 'one undo restores the whole refinement');
});

test('repair is bounded to two attempts and leaves the original intact on repeated rejection', async () => {
  const session = createIllustrator({ text: source, selection: ['selected'] });
  let calls = 0;
  await assert.rejects(refineIllustration(session, { message: 'Azul', transport: { run: async () => { calls++; return reply([...valid, ...invalid]); } } }), error => {
    assert.match(error.message, /protege label/); assert.equal(error.attempts, 2); assert.match(error.repairError, /protege label/); return true;
  });
  assert.equal(calls, 2); assert.equal(session.getDocument().text, source);
});

test('selected snapshot enlarges tiny art on a large canvas and preserves captured selection', async () => {
  const session = createIllustrator({ text: source, selection: ['selected'] });
  const result = await refineIllustration(session, { message: 'Azul', transport: { run: async req => {
    const { data, info } = await sharp(Buffer.from(req.images[0].data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(req.images[0].name, 'base');
    assert(info.width >= 192 && info.height >= 192 && info.width <= 768 && info.height <= 768);
    let ink = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 100) ink++;
    assert(ink / (info.width * info.height) > .25, 'selected icon occupies substantial image area');
    session.select(['outside']); // Selection can move without changing the document revision.
    return reply(valid);
  } } });
  assert.equal(result.report.attempts, 1); assert.equal(result.report.repairError, null);
  assert.equal(session.context().layers.find(layer => layer.path === 'outside').fill, '#CC3311');
  assert.equal(session.context().layers.find(layer => layer.path === 'selected.box').fill, '#0088FF');
});

test('stale documents, transport errors and cancellations never trigger repair or a commit', async () => {
  for (const behavior of ['stale', 'failed', 'cancelled', 'aborted']) {
    const session = createIllustrator({ text: source, selection: ['selected'] }), controller = new AbortController();
    let calls = 0, cancelled = 0;
    await assert.rejects(refineIllustration(session, { message: 'Azul', signal: controller.signal, transport: {
      cancel: () => cancelled++,
      run: async () => { calls++;
        if (behavior === 'stale') session.setProject({ name: 'Otro proyecto' });
        if (behavior === 'failed') return { ok: false, stderr: 'Sin conexión' };
        if (behavior === 'cancelled') return { ...reply(invalid), cancelled: true };
        if (behavior === 'aborted') controller.abort();
        return reply(invalid);
      },
    } }), /cambió|Sin conexión|Detenido/);
    assert.equal(calls, 1, behavior); assert.equal(cancelled, behavior === 'aborted' ? 1 : 0);
    assert.equal(session.getDocument().text, source);
  }
});

test('CLI refine forwards history and writes only the successfully repaired result', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aru-refine-cli-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'base.aru'), output = path.join(dir, 'refined.aru'), history = path.join(dir, 'history.json'), count = path.join(dir, 'count');
  await fs.writeFile(input, source); await fs.writeFile(history, JSON.stringify([{ role: 'user', text: 'HISTORIAL_DEL_PROYECTO' }]));
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(dir, 'claude'), `#!/usr/bin/env node
import fs from 'node:fs';
if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
let input='';for await(const chunk of process.stdin)input+=chunk;
const prompt=JSON.parse(input).message.content[0].text;
if(!prompt.includes('HISTORIAL_DEL_PROYECTO')) { console.error('History was omitted');process.exit(1); }
let n=fs.existsSync(process.env.ARU_REFINE_COUNT)?Number(fs.readFileSync(process.env.ARU_REFINE_COUNT,'utf8')):0;
fs.writeFileSync(process.env.ARU_REFINE_COUNT,String(++n));
if(n===2&&!prompt.includes('El refinamiento protege label')) { console.error('Repair error missing');process.exit(1); }
console.log(JSON.stringify({type:'result',structured_output:{reply:'Listo',operations:n===1?[{op:'set',target:'selected',label:'Otra identidad'}]:[{op:'set',target:'selected.box',fill:'#0088FF'}]}}));
`, { mode: 0o755 });
  const run = spawnSync(process.execPath, ['bin/aru.mjs', 'refine', input, '--out', output, '--select', 'selected', '--message', 'Azul', '--history', history], { env: { ...process.env, PATH: dir + ':' + process.env.PATH, SHELL: '/bin/false', ARU_REFINE_COUNT: count }, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stdout + run.stderr); const report = JSON.parse(run.stdout).report;
  assert.equal(report.attempts, 2); assert.match(report.repairError, /protege label/);
  assert.equal(await fs.readFile(count, 'utf8'), '2'); assert.equal(await fs.readFile(input, 'utf8'), source);
  assert.match(await fs.readFile(output, 'utf8'), /#0088FF/);
});
