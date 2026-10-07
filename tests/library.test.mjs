// Browser document library (localStorage backend): projects, unique names, rename/move/duplicate/remove.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { openLibrary } = await import('../src/library.js');

test('documents live in projects and never overwrite each other', async () => {
  const lib = await openLibrary();
  assert.equal(lib.kind, 'browser');
  const p = await lib.createProject('Boxeo');
  const a = await lib.create(p, 'Guantes', 'canvas 10 10');
  const b = await lib.create(p, 'Guantes', 'canvas 20 20');
  const l = (await lib.list()).projects[0];
  assert.deepEqual(l.docs.map((d) => d.name).sort(), ['Guantes', 'Guantes 2']);
  assert.equal(await lib.read(a), 'canvas 10 10');
  assert.equal(await lib.read(b), 'canvas 20 20');
  await lib.write(a, 'canvas 30 30');
  assert.equal(await lib.read(b), 'canvas 20 20', 'writing one document leaves the other intact');
  const q = await lib.createProject('Boxeo');
  assert.equal((await lib.list()).projects.find((x) => x.id === q).name, 'Boxeo 2');
  await lib.move(b, q); await lib.rename(a, 'Guantes v1 / final');
  const c = await lib.duplicate(a);
  const names = (await lib.list()).projects.map((x) => `${x.name}:${x.docs.map((d) => d.name).sort().join(',')}`);
  assert.deepEqual(names, ['Boxeo:Guantes v1 final,Guantes v1 final copia', 'Boxeo 2:Guantes 2']);
  await assert.rejects(lib.removeProject(p), /no está vacío/);
  await lib.remove(c); await lib.remove(a); await lib.removeProject(p);
  assert.deepEqual((await lib.list()).projects.map((x) => x.name), ['Boxeo 2']);
  assert.equal(mem.has(`aru-doc:${a}`), false);
});
