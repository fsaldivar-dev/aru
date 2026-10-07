import test from 'node:test';
import assert from 'node:assert/strict';
import { createIconJob, requestedIconCount, runIconJob, verifyIconJob } from '../src/icon-production.js';
import { createIllustrator, readDocument } from '../plugin/core.js';
import { produceIcons, askIllustrator, exportIconArchive } from '../plugin/node.js';

const base = 'canvas 800 600\nbackground #FFFFFF\n';
const icon = i => ({ label: `Function ${i}`, purpose: `Distinct function ${i}`, aru: `path mark { move 4 4; line ${8 + i / 100} 12; line 20 20; fill none; stroke #604631 1.8 }\n` + Array.from({ length: 9 }, (_, bit) => `line bit${bit} { from 4 ${3 + bit * 2}; to ${i & (1 << bit) ? 18 : 8} ${3 + bit * 2}; stroke #604631 1 }`).join('\n') });
function harness() { let text = base; return { getText: () => text, commit: next => { text = next; } }; }

test('requested explicit icon counts; does not interpret dimensions or ordinary edit requests', () => {
  assert.equal(requestedIconCount('Genera un pack de 320 iconos que no se repitan'), 320);
  assert.equal(requestedIconCount('create 48 vintage music icons'), 48);
  assert.equal(requestedIconCount('Exporta los iconos a 320 px'), null);
  assert.equal(requestedIconCount('Cambia el color de 50 iconos'), null);
});
test('320 requested: partial replies are continued, inventory is passed and actual direct groups reach exactly 320', async () => {
  const h = harness(), job = createIconJob('Crea 320 iconos vintage'), counts = [];
  let serial = 0;
  await runIconJob(job, { ...h, request: async (system, prompt) => {
    assert.match(prompt, /Target: 320/); if (serial) assert.match(prompt, /Function 0/);
    const asked = Number(/EXACTLY (\d+)/.exec(prompt)[1]);
    // A provider delivers only eight per answer. The engine must still fulfil 320.
    return { icons: Array.from({ length: Math.min(8, asked) }, () => icon(serial++)) };
  }, checkpoint: async (state, text) => { assert.equal(verifyIconJob(state, text), state.accepted.length); counts.push(state.accepted.length); } });
  assert.equal(job.status, 'complete'); assert.equal(job.accepted.length, 320); assert.equal(job.attempts, 40);
  assert.equal(readDocument(h.getText()).scene.root.children[0].children.length, 320);
  assert(counts.includes(24)); assert(counts.includes(312));
});
test('renaming/repainting geometry, duplicate labels, empty/invalid/clipped drawings rejected; pause after three empty batches', async () => {
  const h = harness(), job = createIconJob('Crea 4 iconos'); let n = 0;
  await runIconJob(job, { ...h, request: async () => ({ icons: n++ === 0 ? [icon(1)] : [
    { ...icon(1), label: 'Other', aru: icon(1).aru.replace('mark', 'changed').replace('#604631', '#FF0000') },
    { ...icon(2), label: 'function 1' },
    { ...icon(3), aru: 'group empty {}' },
    { ...icon(4), aru: 'rect invisible { at 12 12; size 16 16; fill none; stroke none }' },
  ] }) });
  assert.equal(job.status, 'paused'); assert.equal(job.accepted.length, 1); assert.equal(job.attempts, 4);
  assert(job.issues.some(e => /Geometría repetida/.test(e.reason)));
  assert(job.issues.some(e => /Nombre repetido/.test(e.reason)));
});
test('stop keeps committed work; JSON checkpoint resumes only pending slots and honours original target', async () => {
  const h = harness(), job = createIconJob('Crea 33 iconos'), controller = new AbortController(); let serial = 0, checkpoint;
  await runIconJob(job, { ...h, signal: controller.signal, request: async () => ({ icons: Array.from({ length: 16 }, () => icon(serial++)) }),
    checkpoint: async state => { checkpoint = JSON.parse(JSON.stringify(state)); if (state.accepted.length === 16) controller.abort(); } });
  assert.equal(job.status, 'paused'); assert.equal(job.accepted.length, 16);
  const asked = [];
  await runIconJob(checkpoint, { ...h, request: async (_, prompt) => { const count = Number(/EXACTLY (\d+)/.exec(prompt)[1]); asked.push(count); return { icons: Array.from({ length: count }, () => icon(serial++)) }; } });
  assert.equal(checkpoint.status, 'complete'); assert.deepEqual(asked, [16, 1]); assert.equal(verifyIconJob(checkpoint, h.getText()), 33);
});
test('document edits during a call are preserved; undo prevents false completion/resume', async () => {
  const h = harness(), job = createIconJob('Crea 30 iconos');
  await runIconJob(job, { ...h, request: async () => { h.commit(base + 'circle user { at 100 100; radius 10 }'); return { icons: [icon(1)] }; } });
  assert.equal(job.status, 'paused'); assert.equal(job.accepted.length, 0); assert.match(h.getText(), /circle user/);
  await assert.rejects(runIconJob(job, { ...h }), /documento cambió/);
  const s = createIllustrator({ text: base });
  const result = await produceIcons(s, { job: createIconJob('Crea 1 icono'), transport: { run: async () => ({ ok: true, stdout: JSON.stringify({ structured_output: { icons: [icon(1)] } }) }) } });
  assert(result.report.complete); s.undo(); assert.throws(() => verifyIconJob(result.report.production, s.getDocument().text), /documento cambió/);
});
test('node ask auto-routes large requests; per-batch undo, original content and ZIP exports survive', async () => {
  const original = base + 'circle original { at 20 20; radius 5; fill #FF0000 }', s = createIllustrator({ text: original }); let serial = 0;
  const r = await askIllustrator(s, { message: 'Crea 25 iconos', review: 0, transport: { run: async req => {
    assert(req.schema.properties.icons); const count = Number(/EXACTLY (\d+)/.exec(req.prompt)[1]);
    return { ok: true, stdout: JSON.stringify({ structured_output: { icons: Array.from({ length: count }, () => icon(serial++)) } }) };
  } } });
  assert(r.report.complete); assert.equal(r.report.production.accepted.length, 25);
  assert(readDocument(s.getDocument().text).scene.root.children.some(n => n.name === 'original'));
  const zip = await exportIconArchive(s.getDocument().text, { group: r.report.production.id, sizes: [24], formats: ['svg', 'aru'] });
  assert.equal(zip.manifest.entries.length, 25);
  s.undo(); assert.equal(readDocument(s.getDocument().text).scene.root.children[1].children.length, 16);
  s.undo(); assert.equal(s.getDocument().text, original);
});
test('gradient names are isolated across jobs and repeated colours do not evade geometry checks', async () => {
  const h = harness(), entry = { label: 'Glass', purpose: 'Glass icon', aru: 'gradient glass linear 90 { stop 0 #FFF; stop 1 #ACE }\ncircle body { at 12 12; radius 8; fill glass; stroke none }' };
  const first = createIconJob('Crea 1 icono'), second = createIconJob('Crea 1 icono');
  await runIconJob(first, { ...h, request: async () => ({ icons: [entry] }) });
  await runIconJob(second, { ...h, request: async () => ({ icons: [entry] }) });
  assert.equal(first.status, 'complete'); assert.equal(second.status, 'complete'); assert.equal(Object.keys(readDocument(h.getText()).scene.gradients).length, 2);
});
