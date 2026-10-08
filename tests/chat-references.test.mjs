import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseReferenceImages, createReferenceStore, referenceNames } from '../src/chat-references.js';

const ref = (n, overrides = {}) => ({ name: `ref${n}`, mime: 'image/png', data: `original-${n}`, thumb: `thumbnail-${n}`, w: 1024, h: 768, ...overrides });
const canvas = { name: 'canvas', mime: 'image/png', data: 'current-canvas' };
function persistentBackend() {
  const documents = new Map();
  return {
    documents,
    async load(id) { return structuredClone(documents.get(id) || []); },
    async save(id, refs) { documents.set(id, structuredClone(refs)); },
    async clear(id) { documents.delete(id); },
  };
}

test('reference originals and stable IDs survive a new store and remain scoped to their document', async () => {
  const backend = persistentBackend(), first = createReferenceStore({ backend });
  const uploaded = [ref(12)];
  assert.deepEqual(await first.save('music', uploaded), { persisted: true, count: 1 });
  uploaded[0].data = 'mutated-outside-store';
  await first.save('automation', [ref(13)]);
  const restarted = createReferenceStore({ backend });
  const restored = await restarted.load('music');
  assert.equal(restored[0].name, 'ref12');
  assert.equal(restored[0].data, 'original-12');
  assert.equal(restored[0].ext, 'png');
  restored[0].data = 'modified-consumer-copy';
  assert.equal((await restarted.load('music'))[0].data, 'original-12');
  assert.equal((await restarted.load('automation'))[0].name, 'ref13');
  assert.deepEqual(await restarted.load('unrelated'), []);
});

test('save replaces removed references and clear deletes only the requested document', async () => {
  const backend = persistentBackend(), store = createReferenceStore({ backend });
  await store.save('music', [ref(1), ref(2)]);
  await store.save('automation', [ref(3)]);
  await store.save('music', [ref(2)]);
  assert.deepEqual((await createReferenceStore({ backend }).load('music')).map(x => x.name), ['ref2']);
  assert.deepEqual(await store.clear('music'), { persisted: true, count: 0 });
  const restarted = createReferenceStore({ backend });
  assert.deepEqual(await restarted.load('music'), []);
  assert.equal((await restarted.load('automation')).length, 1);
  await restarted.save('automation', []);
  assert.equal(backend.documents.has('automation'), false);
});

test('a clear queued behind an in-flight save cannot resurrect deleted originals', async () => {
  const backend = persistentBackend();
  let release, started;
  const saving = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const write = backend.save;
  backend.save = async (...args) => { started(); await gate; return write(...args); };
  const store = createReferenceStore({ backend });
  const pendingSave = store.save('music', [ref(1)]);
  await saving;
  const pendingClear = store.clear('music');
  release();
  await Promise.all([pendingSave, pendingClear]);
  assert.deepEqual(await store.load('music'), []);
  assert.deepEqual(await createReferenceStore({ backend }).load('music'), []);
});

test('embedded reference stores are isolated memory sessions and never invoke persistence', async () => {
  const backend = { load() { throw new Error('must not read'); }, save() { throw new Error('must not write'); }, clear() { throw new Error('must not clear'); } };
  const store = createReferenceStore({ persistent: false, backend });
  assert.deepEqual(await store.save('embedded', [ref(1)]), { persisted: false, count: 1 });
  assert.equal((await store.load('embedded'))[0].data, 'original-1');
  assert.deepEqual(await createReferenceStore({ persistent: false, backend }).load('embedded'), []);
  await store.clear('embedded');
  assert.deepEqual(await store.load('embedded'), []);
});

test('storage failure reports temporary retention and does not read back an obsolete persisted copy', async () => {
  const backend = persistentBackend(), warnings = [];
  await backend.save('music', [ref(1)]);
  backend.save = async () => { throw new Error('QuotaExceededError'); };
  backend.clear = async () => { throw new Error('blocked'); };
  const store = createReferenceStore({ backend, onWarning: warning => warnings.push(warning) });
  const saved = await store.save('music', [ref(2)]);
  assert.equal(saved.persisted, false);
  assert.match(saved.reason, /QuotaExceededError.*solo durante esta sesión/);
  assert.equal((await store.load('music'))[0].name, 'ref2');
  assert.equal(store.status().persistent, false);
  assert.equal(warnings.length, 1);
  const cleared = await store.clear('music');
  assert.equal(cleared.persisted, false);
  assert.deepEqual(await store.load('music'), []);
  // No false promise: a failed disk deletion really does leave the old disk data.
  assert.equal((await createReferenceStore({ backend }).load('music'))[0].name, 'ref1');
});

test('a temporarily blocked read can recover original references without recreating the store', async () => {
  const backend = persistentBackend();
  await backend.save('music', [ref(12)]);
  const read = backend.load;
  let blocked = true;
  backend.load = async id => { if (blocked) throw new Error('temporarily blocked'); return read(id); };
  const store = createReferenceStore({ backend });
  assert.deepEqual(await store.load('music'), []);
  blocked = false;
  assert.equal((await store.load('music'))[0].data, 'original-12');
  assert.equal(store.status().persistent, true);
});

test('missing IndexedDB has an honest in-memory fallback and no thumbnail migration', async () => {
  const store = createReferenceStore({ indexedDB: null });
  const saved = await store.save('music', [ref(1)]);
  assert.equal(saved.persisted, false);
  assert.match(saved.reason, /solo durante esta sesión/);
  assert.equal((await store.load('music')).length, 1);
  await assert.rejects(store.save('music', [{ name: 'ref1', thumb: 'tiny-old-preview', mime: 'image/png' }]), /imágenes originales/);
  await assert.rejects(store.save('music', [ref(1, { w: 4096 })]), /1024/);
  await assert.rejects(store.save('', [ref(1)]), /identificador del documento/);
  await assert.rejects(store.save('music', [ref(1), ref(1)]), /identificadores únicos/);
  await assert.rejects(store.save('music', undefined), /lista completa/);
  assert.equal((await store.load('music'))[0].data, 'original-1');
});

test('explicit older IDs outrank recent unrelated references without displacing pending uploads', () => {
  const old = [ref(12), ref(13), ref(14), ref(15)], fresh = [ref(16)];
  const chosen = chooseReferenceImages('Reinterpreta REF12.png con ref 16', fresh, old, { canvas });
  assert.deepEqual(chosen.images.map(x => x.name), ['ref12', 'ref16', 'canvas', 'ref15']);
  assert.deepEqual(chosen.referenceNames, ['ref12', 'ref16', 'ref15']);
  assert.equal(chosen.images[0].data, 'original-12');
  chosen.images[0].data = 'caller-mutated';
  assert.equal(old[0].data, 'original-12');
  assert.deepEqual(referenceNames('Usa ref12, REF12.webp, ref #15 y no xref17 ni ref19extra.'), ['ref12', 'ref15']);
});

test('explicit missing IDs stop the request instead of falling back to the latest unrelated image', () => {
  assert.throws(() => chooseReferenceImages('Usa ref12', [], [ref(13), ref(14)]), error => {
    assert.equal(error.code, 'REFERENCE_ORIGINAL_MISSING');
    assert.deepEqual(error.referenceNames, ['ref12']);
    assert.match(error.message, /Vuelve a adjuntar.*nuevo identificador/);
    return true;
  });
  assert.throws(() => chooseReferenceImages('Usa ref12', [], [], { history: [{ role: 'user', thumbs: ['legacy-thumbnail'] }] }), /miniatura, pero no el original/);
});

test('legacy chat thumbnails never pretend to be accessible originals', () => {
  const history = [{ role: 'user', text: 'Crea desde la imagen', thumbs: ['legacy-thumbnail'] }];
  for (const message of ['Usa la imagen anterior', 'Vectorízala', 'Transforma esa referencia']) {
    assert.throws(() => chooseReferenceImages(message, [], [], { history }), /original anterior.*miniatura/);
  }
  assert.deepEqual(chooseReferenceImages('Crea un icono de un piano', [], [], { history }), { images: [], referenceNames: [] });
  assert.equal(chooseReferenceImages('Usa la imagen anterior', [], [ref(12)], { history }).images[0].data, 'original-12');
});

test('required references fill the transport limit before the optional canvas and never silently truncate', () => {
  const result = chooseReferenceImages('Usa ref1', [ref(2), ref(3), ref(4)], [ref(1), ref(8), ref(9)], { canvas });
  assert.deepEqual(result.images.map(x => x.name), ['ref1', 'ref2', 'ref3', 'ref4']);
  assert.throws(() => chooseReferenceImages('Usa ref1 y ref5', [ref(2), ref(3), ref(4)], [ref(1), ref(5)], { canvas }), error => {
    assert.equal(error.code, 'REFERENCE_LIMIT_EXCEEDED');
    assert.match(error.message, /necesita 5 referencias.*admite 4.*no se omitió/);
    return true;
  });
});

test('same-session follow-ups retain recent originals with bounded images and current uploads winning IDs', () => {
  assert.deepEqual(chooseReferenceImages('Hazlo más claro', [], [ref(1), ref(2), ref(3)], { canvas }).images.map(x => x.name), ['canvas', 'ref2', 'ref3']);
  assert.deepEqual(chooseReferenceImages('Usa ref2', [ref(2, { data: 'reuploaded-original' })], new Map([['ref2', ref(2)]]), 1).images.map(x => x.data), ['reuploaded-original']);
  assert.deepEqual(chooseReferenceImages('Mira el lienzo', [], [ref(1), ref(2)], { limit: 1, canvas }).images.map(x => x.name), ['canvas']);
  assert.throws(() => chooseReferenceImages('Crea', [{ name: 'ref1', thumb: 'not-original' }], []), /original válido/);
});
