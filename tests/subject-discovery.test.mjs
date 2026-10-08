import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { discoverSubjects } from '../plugin/subject-discovery.js';
import { imageCandidates } from '../plugin/visual-discovery.js';

const source = subject => `https://reference.example/${encodeURIComponent(subject)}`;
function researchPlan(subjects, suffix = '') {
  return { subjects: subjects.map(subject => ({ subject, visualQueries: [`${subject} photo${suffix}`, `${subject} anatomy${suffix}`], sources: [{ url: source(subject), title: subject, insight: 'Visible object anatomy' }] })), uncertainty: '' };
}
function result(answer, sources = null) {
  return { ok: true, ms: 1, stdout: [
    ...(sources ? [{ message: { content: [{ type: 'tool_use', id: 'search1', name: 'WebSearch', input: { query: 'generic object anatomy' } }] } }, { message: { content: [{ type: 'tool_result', tool_use_id: 'search1', content: sources.join(' ') }] } }] : []),
    { type: 'result', structured_output: answer },
  ].map(item => JSON.stringify(item)).join('\n') };
}
const observed = subject => ({ selected: [{ id: 1, observations: `Se observa la silueta de ${subject}.`, use: 'Conservar sus proporciones reconocibles.' }], brief: `Dibujar ${subject} con su silueta reconocible.`, features: ['Silueta alargada visible', 'Piezas diferenciadas visibles'], uncertainty: '' });
async function resourceFixture() {
  const first = await sharp({ create: { width: 150, height: 150, channels: 3, background: '#B94432' } }).png().toBuffer();
  const second = await sharp({ create: { width: 150, height: 150, channels: 3, background: '#148866' } }).png().toBuffer();
  return async url => {
    if (url.includes('api.openverse.org')) return { mime: 'application/json', url, data: Buffer.from(JSON.stringify({ results: [1, 2].map(i => ({ url: `https://images.example/${i}.png`, foreign_landing_url: 'https://reference.example/photo', title: `Object ${i}`, license: 'cc0' })) })) };
    if (url.includes('commons.wikimedia.org')) return { mime: 'application/json', url, data: Buffer.from('{}') };
    if (url.includes('images.example')) return { mime: 'image/png', url, data: url.includes('/1.') ? first : second };
    return { mime: 'text/html', url, data: Buffer.from('<html></html>') };
  };
}
function transportFixture(visual = req => result(observed(JSON.parse(req.prompt).subject))) {
  return { run: async req => {
    if (req.research) {
      const input = JSON.parse(req.prompt), plan = researchPlan(input.subjects, input.retry ? ' alternate' : '');
      return result(plan, plan.subjects.flatMap(s => s.sources.map(s => s.url)));
    }
    return visual(req);
  } };
}

test('object discovery inspects pixels for every object and retains sources with stable unique sheet IDs', async () => {
  const calls = [], resource = await resourceFixture(), delegate = transportFixture();
  const report = await discoverSubjects({ subjects: ['guitar', 'keyboard', 'maracas'], resource, transport: { run: async req => { calls.push(req); return delegate.run(req); } } });
  assert.equal(report.mode, 'subject-visual-discovery');
  assert.deepEqual(report.subjects.map(s => s.subject), ['guitar', 'keyboard', 'maracas']);
  assert.deepEqual(report.visual.images.map(i => i.id), [1, 2, 3]);
  assert.equal(report.observedReferenceImages, 3);
  assert.equal(calls.filter(c => c.research).length, 1);
  assert.equal(calls.filter(c => !c.research).length, 3);
  assert.match(calls[0].system, /not an app identity/);
  for (const subject of report.subjects) {
    assert.equal(subject.images.length, 1);
    assert.equal(subject.images[0].subject, subject.subject);
    assert.equal(subject.images[0].sha256.length, 64);
    assert.equal(subject.attempts.length, 1);
    assert(subject.attempts[0].researchEvidence.some(e => e.tool === 'WebSearch' && e.completed));
    assert(subject.evidence.some(e => e.provider === 'openverse' && e.completed));
    assert.equal((await sharp(Buffer.from(subject.images[0].data, 'base64')).metadata()).width, 150);
  }
  for (const request of calls.filter(c => !c.research)) {
    assert.deepEqual(request.images.map(i => i.name), ['candidates']);
    assert.equal((await sharp(Buffer.from(request.images[0].data, 'base64')).metadata()).width, 960);
  }
});

test('object discovery rejects partial research coverage rather than drawing missing subjects from memory', async () => {
  let resourceCalls = 0;
  await assert.rejects(discoverSubjects({ subjects: ['guitar', 'maracas'], resource: async () => { resourceCalls++; }, transport: { run: async () => result(researchPlan(['guitar']), [source('guitar')]) } }), /no cubrió todos/);
  assert.equal(resourceCalls, 0);
});

test('object discovery requires real web search evidence and refuses invented source URLs', async () => {
  const plan = researchPlan(['guitar']);
  await assert.rejects(discoverSubjects({ subjects: ['guitar'], transport: { run: async () => result(plan) } }), /no completó ninguna búsqueda/);
  await assert.rejects(discoverSubjects({ subjects: ['guitar'], transport: { run: async () => result(plan, ['https://unrelated.example/page']) } }), /Fuente sin evidencia/);
});

test('object observer cannot choose an image ID that was never shown', async () => {
  const resource = await resourceFixture();
  await assert.rejects(discoverSubjects({ subjects: ['guitar'], resource, transport: transportFixture(() => result({ ...observed('guitar'), selected: [{ id: 999, observations: 'Guitar', use: 'Shape' }] })) }), /sin imagen observada/);
});

test('unrelated observed candidates trigger one alternate search then a clear coverage failure', async () => {
  const resource = await resourceFixture(), calls = [], delegate = transportFixture(() => result({ ...observed('guitar'), selected: [], uncertainty: 'Solo aparecen logos y carteles, no se observa una guitarra.' }));
  await assert.rejects(discoverSubjects({ subjects: ['guitar'], resource, transport: { run: async req => { calls.push(req); return delegate.run(req); } } }), error => {
    assert.equal(error.code, 'SUBJECT_REFERENCE_UNAVAILABLE');
    assert.equal(error.subject, 'guitar');
    assert.equal(error.details.attempts.length, 2);
    assert(error.details.attempts.every(a => a.selectedCount === 0));
    return true;
  });
  assert.equal(calls.filter(c => c.research).length, 2);
  const retry = JSON.parse(calls.find(c => c.research && JSON.parse(c.prompt).retry).prompt).retry;
  assert.deepEqual(retry.previousQueries, ['guitar photo', 'guitar anatomy']);
  assert.match(retry.reason, /logos y carteles/);
});

test('alternate search can recover a subject and retains both rejected and accepted evidence', async () => {
  let observations = 0;
  const report = await discoverSubjects({ subjects: ['guitar'], resource: await resourceFixture(), transport: transportFixture(() => result(++observations === 1 ? { ...observed('guitar'), selected: [], uncertainty: 'No se ve el instrumento completo' } : observed('guitar'))) });
  assert.equal(report.subjects[0].attempts.length, 2);
  assert.equal(report.subjects[0].attempts[0].selectedCount, 0);
  assert.equal(report.subjects[0].attempts[1].selectedCount, 1);
  assert.equal(report.visual.images.length, 1);
});

test('subject discovery bounds input, rejects duplicated subjects and unsupported research providers', async () => {
  for (const subjects of [[], Array(9).fill('guitar'), [''], ['guitar\nkeyboard']]) await assert.rejects(discoverSubjects({ subjects }), /entre 1 y 8/);
  await assert.rejects(discoverSubjects({ subjects: ['Guitarra', 'guitarra'] }), /no deben repetirse/);
  await assert.rejects(discoverSubjects({ subjects: ['guitar'], provider: 'codex' }), /requiere Claude/);
});

test('a single useful candidate is sufficient for one object; global visual discovery still requires two by default', async () => {
  const delegate = await resourceFixture();
  const resource = async url => {
    const response = await delegate(url);
    if (url.includes('api.openverse.org')) { const json = JSON.parse(response.data); json.results = json.results.slice(0, 1); response.data = Buffer.from(JSON.stringify(json)); }
    return response;
  };
  const plan = researchPlan(['guitar']).subjects[0];
  await assert.rejects(imageCandidates(plan, { resource }), /dos imágenes/);
  const report = await discoverSubjects({ subjects: ['guitar'], resource, transport: transportFixture() });
  assert.equal(report.visual.images.length, 1);
  assert.equal(report.subjects[0].attempts.length, 1);
});

test('a failed subject stops new scheduling and reports covered, failed and missing objects without embedding image data', async () => {
  const observedSubjects = [];
  let guitarResponseReady;
  const guitarResponse = new Promise(resolve => { guitarResponseReady = resolve; });
  const transport = transportFixture(async req => {
    const { subject } = JSON.parse(req.prompt); observedSubjects.push(subject);
    if (subject === 'guitar') {
      guitarResponseReady();
      return result({ ...observed(subject), selected: [{ id: 999, observations: 'Unknown image', use: 'Shape' }] });
    }
    // Image decoding may finish in either order under load. Hold the successful worker until
    // the failed worker has returned its invalid response, then drain its rejection microtasks.
    await guitarResponse;
    // Let the first worker propagate its failure before this in-flight observation completes.
    await new Promise(resolve => setImmediate(resolve));
    return result(observed(subject));
  });
  await assert.rejects(discoverSubjects({ subjects: ['guitar', 'keyboard', 'maracas', 'drums'], resource: await resourceFixture(), transport }), error => {
    assert.equal(error.subject, 'guitar');
    assert.deepEqual(error.details.coverage, { requested: ['guitar', 'keyboard', 'maracas', 'drums'], covered: ['keyboard'], missing: ['guitar', 'maracas', 'drums'] });
    assert.deepEqual(error.details.failures.map(f => f.subject), ['guitar']);
    assert.equal(error.details.completedSubjects.length, 1);
    const image = error.details.completedSubjects[0].images[0];
    assert.equal(image.data, undefined);
    assert.equal(image.sha256.length, 64);
    assert(image.sourceURL);
    assert(error.details.researchEvidence.length > 0);
    return true;
  });
  assert.deepEqual(observedSubjects.sort(), ['guitar', 'keyboard']);
});
