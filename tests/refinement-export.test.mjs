import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createIllustrator, readDocument, prepareIconExports, listIconBatches } from '../plugin/index.js';
import { refineIllustration, exportIconArchive } from '../plugin/node.js';
const base = `canvas 240 160
background none
gradient verde linear 90 { stop 0 #DDF8CA; stop 1 #22885A }
group pack { at 80 50; scale 2; fill none; stroke #203329 2; semantic ui.iconpack
 group casa { label "Inicio"; path techo { move 3 10; line 12 3; line 21 10 } }
 group lupa { at 40 0; label "Buscar"; circle aro { at 10 10; radius 6; fill verde } }
 group otra { at 80 0; label "Buscar"; line trazo { from 3 12; to 21 12 } }
}
rect ajeno { at 30 120; size 20 20; fill #ABCDEF }
`;
const answer = operations => ({ ok: true, stdout: JSON.stringify({ structured_output: { reply: 'Listo', operations, reference: { use: false }, aru: '', aruInto: '' } }), ms: 1 });
test('protected style edits retain geometry, semantic pieces, outside layers and one-step undo', () => {
 const s = createIllustrator({ text: base, selection: ['pack.casa'] }), before = s.getDocument();
 const r = s.refine([{ op: 'set', target: 'pack.casa.techo', stroke: '#0088FF', shadow: '0 1 2 #000000 0.2' }]);
 const geometry = text => readDocument(text).scene.byPath.get('pack.casa.techo').geom.commands.map(({cmd,args})=>({cmd,args})); assert.deepEqual(geometry(r.text), geometry(base));
 assert(r.geometryPreserved); assert.deepEqual(r.changed, ['pack.casa.techo']);
 s.refine([{ op: 'set', target: 'pack.casa', stroke: '#3388AA' }]); s.undo();
 s.undo(); assert.equal(s.getDocument().text, before.text); s.redo(); assert.match(s.getDocument().text, /#0088FF/);
 for (const op of [{ op: 'delete', target: 'pack.casa' }, { op: 'set', target: 'ajeno', fill: '#000' }, { op: 'set', target: 'pack.casa', hidden: true }, { op: 'set', target: 'pack.casa', opacity: 0 }, { op: 'set', target: 'pack.casa', semantic: 'otro' }]) { const current = s.getDocument().text; assert.throws(() => s.refine([op])); assert.equal(s.getDocument().text, current); }
 assert.throws(() => s.refine([{ op: 'smooth', target: 'pack.casa.techo' }]), /incompatible/);
 assert.throws(() => s.refine([], { expectedRevision: 0 }), /cambió/);
});
test('style changes do not round high precision coordinates in selected or unrelated paths', () => {
 const text = base.replace('move 3 10', 'move 3.12345678912345 10').replace('circle aro { at 10 10', 'circle aro { at 10.987654321098 10');
 const s = createIllustrator({text, selection:['pack.casa']}); s.refine([{op:'set',target:'pack.casa.techo',stroke:'#FF8800'}]);
 assert.equal(readDocument(s.getDocument().text).scene.byPath.get('pack.casa.techo').geom.commands[0].args[0], 3.12345678912345);
 assert.equal(readDocument(s.getDocument().text).scene.byPath.get('pack.lupa.aro').at[0], 10.987654321098);
});
test('inherited style cannot silently alter a locked descendant, and contour mode preserves topology', () => {
 const locked = createIllustrator({ text: base.replace('path techo {', 'path techo { locked 1;'), selection: ['pack.casa'] });
 assert.throws(() => locked.refine([{ op: 'set', target: 'pack.casa', stroke: '#F00' }]), /bloqueado/);
 const s = createIllustrator({ text: base, selection: ['pack.casa'] });
 const r = s.refine([{ op: 'simplify', target: 'pack.casa', tolerance: .5 }], { mode: 'contour' });
 assert.deepEqual([...readDocument(r.text).scene.byPath.keys()], [...readDocument(base).scene.byPath.keys()]);
 assert.throws(() => s.refine([{ op: 'set', target: 'pack.casa', fill: '#F00' }], { mode: 'contour' }), /incompatible/);
});
test('AI refinement sends base image and explicit scope, rejects redraws and concurrent edits atomically', async () => {
 const s = createIllustrator({ text: base, selection: ['pack.casa'] });
 const r = await refineIllustration(s, { message: 'Azul y relieve', transport: { run: async req => { assert.match(req.system, /operations ONLY/); assert.match(req.prompt, /pack.casa.techo/); assert.equal(req.images[0].name, 'base'); return answer([{ op: 'set', target: 'pack.casa.techo', stroke: '#0088FF' }]); } } });
 assert(r.report.geometryPreserved); s.undo(); assert.equal(s.getDocument().text, base);
 const redraw = answer([]); const payload = JSON.parse(redraw.stdout); payload.structured_output.aru = 'circle nuevo { radius 40 }'; redraw.stdout = JSON.stringify(payload);
 await assert.rejects(refineIllustration(s, { message: 'Azul', transport: { run: async () => redraw } }), /reemplazar/); assert.equal(s.getDocument().text, base);
 await assert.rejects(refineIllustration(s, { message: 'Azul', transport: { run: async () => { s.apply([{ op: 'translate', target: 'ajeno', dx: 1 }]); return answer([{ op: 'set', target: 'pack.casa.techo', stroke: '#0088FF' }]); } } }), /cambió/); assert(!s.getDocument().text.includes('#0088FF'));
});
test('icon extraction removes pack placement, retains inherited paint, editable shapes and collision-free filenames', () => {
 assert.equal(listIconBatches(base)[0].count, 3);
 const plan = prepareIconExports(base);
 assert.deepEqual(plan.entries.map(e => e.name), ['inicio', 'buscar', 'buscar-2']);
 assert.match(plan.entries[0].svg, /stroke="#203329"/); assert(!plan.entries[0].svg.includes('translate(80'));
 assert(!plan.entries[0].svg.includes('scale(2)')); assert.match(plan.entries[1].svg, /url\(#g-verde\)/);
 assert(!plan.entries[1].svg.includes('translate(40')); assert(!plan.entries[0].aru.includes('ajeno'));
 assert(readDocument(plan.entries[0].aru).scene.byPath.has('Exportacion.pack.casa.techo'));
 assert.throws(() => prepareIconExports(base, { paths: ['ajeno'] }), /grupos/);
 assert.throws(() => prepareIconExports(base, { group: 'pack', paths: ['pack.casa', 'pack.casa'] }), /duplicados/);
 assert.throws(() => prepareIconExports(base, { sizes: [NaN] }), /Tamaños/);
 assert.throws(() => prepareIconExports(base, { formats: [] }), /Formatos/);
 const fit = prepareIconExports(base, { cellSize: null }); assert(fit.entries.every(e => e.scene.width === fit.extent));
});
test('ZIP contains independent opaque PNGs at requested sizes, ARU, SVG and manifest, CLI refuses overwrite', async t => {
 const result = await exportIconArchive(base, { sizes: [24, 48] });
 assert.equal(result.fileCount, 13); assert.equal(result.manifest.entries.length, 3);
 const buffer = Buffer.from(result.data), files = new Map(); let offset = 0;
 while (buffer.readUInt32LE(offset) === 0x04034b50) { const length = buffer.readUInt32LE(offset + 18), nl = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28), name = buffer.subarray(offset + 30, offset + 30 + nl).toString(), start = offset + 30 + nl + extra; files.set(name, buffer.subarray(start, start + length)); offset = start + length; }
 assert.equal(files.size, 13); assert.equal(JSON.parse(files.get('manifest.json')).entries.length, 3);
 for (const [name, data] of files) if (name.endsWith('.png')) { const size = Number(name.split('/')[1]), { data: pixels, info } = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); assert.equal(info.width, size); assert.equal(info.height, size); for (let i = 3; i < pixels.length; i += 4) assert.equal(pixels[i], 255); }
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aru-export-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
 const source = path.join(directory, 'pack.aru'), out = path.join(directory, 'pack.zip'); await fs.writeFile(source, base);
 const json = JSON.parse(execFileSync(process.execPath, ['bin/aru.mjs', 'export-icons', source, '--out', out, '--sizes', '24', '--formats', 'png,aru'], { encoding: 'utf8' })); assert.equal(json.count, 3);
 assert.throws(() => execFileSync(process.execPath, ['bin/aru.mjs', 'export-icons', source, '--out', out], { encoding: 'utf8' })); assert.equal(await fs.readFile(source, 'utf8'), base);
});
