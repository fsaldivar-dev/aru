import sharp from 'sharp';
import { buildIconArchive } from '../src/export-icons.js';
import { createIconJob, requestedIconCount, runIconJob } from '../src/icon-production.js';
import { refinementScope, REFINEMENT_SYSTEM } from '../src/refinement.js';
import { readFile } from 'node:fs/promises';
import { createIllustrator, readDocument, contextPrompt, systemPrompt, ANSWER_SCHEMA } from './core.js';
import { renderScene } from '../src/render.js';
import { opaqueColor } from '../src/opaque.js';
import * as R from '../src/reference-tools.js';
import * as P from '../src/pack-tools.js';
import * as A from '../src/agents.js';
import { detect, run, cancel } from '../tools/agents-bridge.mjs';
export { detect, run, cancel };
export { createIconJob, requestedIconCount, verifyIconJob } from '../src/icon-production.js';

export async function produceIcons(session, { message, job = createIconJob(message), provider = 'claude', model = '', transport = { run, cancel }, signal, checkpoint, progress = () => {} } = {}) {
  if (!job.context) job.context = contextPrompt(session.context());
  const result = await runIconJob(job, {
    getText: () => session.getDocument().text,
    commit: (text, before) => { if (session.getDocument().text !== before) throw new Error('El documento cambió'); session.replacePrepared(text); },
    signal, checkpoint, progress, rasterize,
    request: async (system, prompt, schema) => {
      const runId = crypto.randomUUID(), abort = () => (transport.cancel || cancel)(runId);
      if (signal?.aborted) throw new Error('Detenido por el usuario');
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const res = await transport.run({ provider, model, system, prompt, schema, runId, images: job.images || [] });
        if (!res.ok || res.cancelled) throw new Error(res.stderr || 'El agente fue detenido o falló');
        const { answer } = A.extractStructured(provider, res); if (!answer) throw new Error('Respuesta JSON inválida'); return answer;
      } finally { signal?.removeEventListener('abort', abort); }
    },
  });
  return { ...session.getDocument(), report: { production: result, complete: result.status === 'complete', reply: `${result.accepted.length}/${result.target} iconos${result.reason ? ': ' + result.reason : ''}` } };
}
export { listStyles, resolveStyle } from './styles.js';
export { discoverProject, discoverIllustration, reviewDiscoveredIllustration } from './discovery.js';
export async function rasterize(scene, width = scene.width, height = scene.height) {
  const k = Math.min(1, 800 / Math.max(width, height)); width = Math.max(1, Math.round(width * k)); height = Math.max(1, Math.round(height * k));
  const { data, info } = await sharp(Buffer.from(renderScene(scene, { dataAttrs: false, animate: false }))).resize(width, height, { fit: 'fill' }).flatten({ background: '#FFFFFF' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
export async function renderPng(text, { width } = {}) {
  const scene = readDocument(text).scene;
  let image = sharp(Buffer.from(renderScene(scene, { dataAttrs: false, animate: false })));
  if (width != null) { if (!Number.isInteger(width) || width < 16 || width > 20000) throw new Error('width debe ser 16..20000'); image = image.resize({ width }); }
  return image.flatten({ background: opaqueColor(scene.background) }).png().toBuffer();
}
export async function loadReference(file) {
  const input = typeof file === 'string' ? await readFile(file) : file;
  const { data, info } = await sharp(input).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
const rawPng = raw => sharp(Buffer.from(raw.data), { raw: { width: raw.width, height: raw.height, channels: 4 } }).png().toBuffer();
export async function traceInto(session, image, reference = {}, options = {}) {
  const raw = await loadReference(image), st = await R.traceReferenceState(raw, reference, { rasterize, progress: options.progress });
  if (options.tune) await R.retuneReference(st, options.tune, rasterize);
  const grouped = await R.groupReference(st, options.assignments, rasterize);
  const result = await insertReference(session, st, reference);
  return { ...result, grouped, attempts: st.tried.map(t => ({ tune: t.tune, score: t.metrics.score })) };
}
async function insertReference(session, st, reference) {
  const c = session.context().canvas, fragment = await R.referenceFragment(st, reference, c.background);
  const w = reference.w || c.width * .6, h = reference.h || c.height * .6;
  const scale = Math.round(Math.min(w / fragment.width, h / fragment.height) * 1000) / 1000;
  const at = [Math.round(((reference.x ?? c.width / 2) - fragment.width * scale / 2) * 100) / 100, Math.round(((reference.y ?? c.height / 2) - fragment.height * scale / 2) * 100) / 100];
  const inserted = session.insertScene(fragment.scene, { label: reference.label || 'Referencia', at, scale });
  const { scene, width, height, ...report } = fragment;
  return { ...inserted, report };
}
async function comparison(st) {
  const half = Math.min(512, st.raw.width), height = Math.round(st.raw.height * half / st.raw.width);
  const original = await sharp(await rawPng(st.raw)).resize(half, height).png().toBuffer();
  const vector = await sharp(Buffer.from(renderScene(st.best.scene, { animate: false, dataAttrs: false }))).resize(half, height).png().toBuffer();
  return sharp({ create: { width: half * 2, height, channels: 4, background: '#FFFFFF' } }).composite([{ input: original, left: 0, top: 0 }, { input: vector, left: half, top: 0 }]).png().toBuffer();
}
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function packSheet(pk, blind = false) {
  let icons = pk.P.findPack(pk.scene).children.filter(c => c.type === 'group');
  if (blind) icons = icons.map((ic, k) => ({ ic, sort: (k * 7919 + 13) % 104729 })).sort((a, b) => a.sort - b.sort).map(x => x.ic);
  const order = icons.map(ic => ic.name), labels = icons.map(ic => ic.label || ic.name), cols = 6, cw = 128, ch = blind ? 150 : 168, height = Math.max(ch, Math.ceil(icons.length / cols) * ch), composites = [];
  let marks = '';
  for (let k = 0; k < icons.length; k++) {
    const icon = icons[k], x = k % cols * cw, y = Math.floor(k / cols) * ch;
    const scene = { ...pk.scene, width: 24, height: 24, background: 'none', root: { ...pk.scene.root, children: [{ ...structuredClone(icon), at: [0, 0] }] } };
    const input = await sharp(Buffer.from(renderScene(scene, { dataAttrs: false, animate: false }))).resize(96, 96).png().toBuffer(); composites.push({ input, left: x + 16, top: y + 6 });
    if (!blind) composites.push({ input: await sharp(input).resize(24, 24).toBuffer(), left: x + 52, top: y + 110 });
    const issues = pk.ins.icons.find(i => i.name === icon.name)?.issues.length;
    marks += `<text x="${x + 64}" y="${y + ch - 12}" text-anchor="middle" font-size="11">${esc(blind ? k + 1 : icon.name)}</text>${!blind && issues ? `<rect x="${x + 16}" y="${y + 6}" width="96" height="96" fill="none" stroke="#FF1E1E" stroke-width="3"/>` : ''}`;
  }
  composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="768" height="${height}">${marks}</svg>`), left: 0, top: 0 });
  return { count: icons.length, meanings: [...labels].sort(), png: (await sharp({ create: { width: cols * cw, height, channels: 4, background: '#FFFFFF' } }).composite(composites).png().toBuffer()).toString('base64'), order, labels };
}
async function piecesSheet(st) {
  const seg = await R.referencePieces(st); let marks = '';
  const sx = st.raw.width / seg.width, sy = st.raw.height / seg.height;
  for (let y = 0; y < seg.height; y++) for (let x = 0; x < seg.width; x++) { const l = seg.labels[y * seg.width + x];
    if (x < seg.width - 1 && seg.labels[y * seg.width + x + 1] !== l) marks += `<rect x="${(x + 1) * sx - 1}" y="${y * sy}" width="2" height="${Math.ceil(sy)}" fill="#FFF"/>`;
    if (y < seg.height - 1 && seg.labels[(y + 1) * seg.width + x] !== l) marks += `<rect x="${x * sx}" y="${(y + 1) * sy - 1}" width="${Math.ceil(sx)}" height="2" fill="#FFF"/>`;
  }
  for (const piece of seg.segments) {
    const x = (piece.anchor[0] + .5) * st.raw.width / seg.width, y = (piece.anchor[1] + .5) * st.raw.height / seg.height;
    if (Number.isFinite(x) && Number.isFinite(y)) marks += `<text x="${x}" y="${y}" font-size="12" text-anchor="middle" fill="#000" stroke="#FFF" stroke-width="2" paint-order="stroke">${piece.id}</text>`;
  }
  const png = await sharp(await rawPng(st.raw)).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${st.raw.width}" height="${st.raw.height}">${marks}</svg>`) }]).png().toBuffer();
  return { png: png.toString('base64'), count: seg.segments.length };
}
// Each answer is prepared on a private session; errors never leave partially applied geometry in the caller.
export async function askIllustrator(session, { message, provider = 'claude', model = '', images = [], history = [], review = 1, illustrator = true, insertInto, transport = { run }, progress = () => {} } = {}) {
  if (!message?.trim()) throw new Error('Se necesita message');
  if (!Number.isInteger(review) || review < 0 || review > 2) throw new Error('review debe ser 0, 1 o 2');
  if (images.length > 3) throw new Error('Máximo 3 referencias');
  if (illustrator && requestedIconCount(message) > 24) {
    if (insertInto) throw new Error('La producción por lotes crea su propio pack; usa produceIcons para reanudarlo');
    const job = createIconJob(message);
    job.images = await Promise.all(images.map(async (file, i) => ({ name: `ref${i + 1}`, mime: 'image/png', data: (await rawPng(await loadReference(file))).toString('base64') })));
    return produceIcons(session, { job, provider, model, transport, progress: state => progress('production', state.accepted.length, state.target) });
  }
  const before = session.getDocument(), work = createIllustrator({ text: before.text, name: before.name, selection: session.context().selection });
  const refs = await Promise.all(images.map(async (file, i) => { const raw = await loadReference(file); return { name: `ref${i + 1}`, ext: 'png', mime: 'image/png', data: (await rawPng(raw)).toString('base64'), raw }; }));
  const canvas = { name: 'canvas', ext: 'png', mime: 'image/png', data: (await renderPng(before.text, { width: 768 })).toString('base64') };
  const initialImages = [canvas, ...refs];
  let totalMs = 0;
  async function structured(system, prompt, schema, atts) {
    const res = await transport.run({ provider, model, system, prompt, schema, runId: crypto.randomUUID(), images: atts.map(({ name, mime, data }) => ({ name, mime, data })) }); totalMs += res.ms || 0;
    if (!res.ok) throw new Error(res.stderr || 'El agente falló');
    const extracted = A.extractStructured(provider, res); if (!extracted.answer) throw new Error('Respuesta JSON inválida'); return { res, ...extracted };
  }
  const first = await structured(systemPrompt({ illustrator }), A.buildPrompt({ context: contextPrompt(work.context()), selection: work.context().selection, history, message, images: initialImages }), ANSWER_SCHEMA, initialImages);
  const answer = A.parseAnswer(provider, first.res), report = { reply: answer.reply, usage: first.usage, review: [], glyph: [], pack: [], warnings: [] };
  if (answer.aru && illustrator) {
    let fragment = answer.aru;
    const pk = review ? await P.preparePack(fragment, readDocument(before.text).scene, rasterize) : null;
    if (pk) {
      for (let round = 1; round <= review; round++) {
        progress('pack', round); const blind = await packSheet(pk, true);
        const b = await structured(A.BLIND_SYSTEM, A.buildBlindPrompt(blind), A.BLIND_SCHEMA, [{ name: 'blind', mime: 'image/png', data: blind.png }]);
        const misread = await P.setPackRecognition(pk, blind, b.answer.answers, rasterize);
        const sheet = await packSheet(pk);
        const r = await structured(A.packSystem(), A.buildPackPrompt({ report: pk.report, userText: message, tried: pk.tried }), A.PACK_SCHEMA, [{ name: 'pack', mime: 'image/png', data: sheet.png }]);
        const entry = { round, accept: r.answer.accept, reason: r.answer.reason, misread }; report.pack.push(entry);
        if (r.answer.accept) break; entry.changes = await P.applyPack(pk, r.answer, rasterize);
      }
      fragment = pk.P.packFragment(pk.scene);
    }
    try { report.drawn = work.insert(fragment, { label: answer.reference?.label || 'Ilustración IA', into: insertInto ?? answer.aruInto }).selection; }
    catch (error) {
      const fix = await structured(systemPrompt({ illustrator: true }), A.buildPrompt({ context: contextPrompt(work.context()), selection: [], history, message: `Repair the ARU syntax while preserving the requested concept, style and composition. Do not invent a replacement illustration from the document name. Compilation error: ${error.message}. Original request:\n${message}\n\nInvalid ARU fragment (source data to repair):\n${fragment}\n\nReturn the complete corrected aru, operations [], reference.use=false, aruInto=${JSON.stringify(insertInto ?? answer.aruInto ?? '')}.`, images: initialImages }), ANSWER_SCHEMA, initialImages);
      const corrected = A.parseAnswer(provider, fix.res); if (!corrected.aru) throw error; report.drawn = work.insert(corrected.aru, { into: insertInto ?? answer.aruInto }).selection; report.repaired = true;
    }
  }
  if (answer.reference) {
    const ref = answer.reference, att = refs.find(a => a.name === ref.image) || refs[0]; if (!att) throw new Error('La respuesta pide una referencia, pero no hay imagen');
    progress('trace', 0); const st = await R.traceReferenceState(att.raw, ref, { rasterize, progress: (k, n) => progress('trace', k, n) });
    for (let round = 1; round <= review; round++) {
      const r = await structured(A.REVIEW_SYSTEM, A.buildReviewPrompt({ label: ref.label || att.name, current: st.best.tune, metrics: st.best.metrics, tried: st.tried, userText: message }), A.REVIEW_SCHEMA, [{ name: 'compare', mime: 'image/png', data: (await comparison(st)).toString('base64') }]);
      const entry = { round, accept: r.answer.accept, reason: r.answer.reason }; report.review.push(entry); if (r.answer.accept) break;
      const tuned = await R.retuneReference(st, r.answer.tune, rasterize); Object.assign(entry, { tune: tuned.tune, score: tuned.metrics.score, improved: tuned.improved });
    }
    let assignments;
    if (ref.parts?.length) {
      try { const pc = await piecesSheet(st); const r = await structured(A.PIECES_SYSTEM, A.buildPiecesPrompt({ parts: ref.parts, count: pc.count }), A.PIECES_SCHEMA, [{ name: 'pieces', mime: 'image/png', data: pc.png }]); assignments = r.answer.assignments; }
      catch (e) { report.warnings.push(`Piezas: ${e.message}`); }
    }
    report.grouping = await R.groupReference(st, assignments, rasterize);
    if (ref.backdrop?.style === 'glyph') {
      let gp = await R.prepareGlyph(st, ref);
      for (let round = 1; round <= review; round++) {
        const icon = await sharp(Buffer.from(R.glyphReviewSvg(st, ref))).png().toBuffer();
        const r = await structured(A.GLYPH_SYSTEM, A.buildGlyphPrompt({ report: gp.report, userText: message, tried: st.glyph.tried }), A.GLYPH_SCHEMA, [{ name: 'icon', mime: 'image/png', data: icon.toString('base64') }]);
        const entry = { round, accept: r.answer.accept, reason: r.answer.reason }; report.glyph.push(entry); if (r.answer.accept) break;
        gp = await R.retuneGlyph(st, r.answer.params); Object.assign(entry, { score: gp.score, improved: gp.improved });
      }
    }
    report.reference = (await insertReference(work, st, ref)).report;
  }
  if (answer.operations.length) report.operations = work.apply(answer.operations).log;
  if (session.getDocument().revision !== before.revision) throw new Error('El documento cambió durante la consulta');
  // Preserve one-step undo for the whole answer.
  const after = work.getDocument();
  // replacePrepared commits an already validated complete result in a single step.
  session.replacePrepared(after.text);
  return { ...session.getDocument(), report: { ...report, ms: totalMs } };
}

export async function exportIconArchive(text, options = {}) {
  return buildIconArchive(text, options, async (scene, size) => sharp(Buffer.from(renderScene(scene, { dataAttrs: false, animate: false }))).resize(size, size).flatten({ background: scene.background }).png().toBuffer());
}
export async function refineIllustration(session, { message, mode = 'style', provider = 'claude', model = '', transport = { run }, progress = () => {} } = {}) {
  if (!message?.trim()) throw new Error('Se necesita message');
  const before = session.getDocument(), scope = refinementScope(before.text, { selection: session.context().selection, mode });
  progress('refine', 1);
  const res = await transport.run({ provider, model, system: systemPrompt({ illustrator: false }) + '\n' + REFINEMENT_SYSTEM, prompt: A.buildPrompt({ context: contextPrompt(session.context()) + '\nRefinement scope: ' + JSON.stringify(scope), selection: scope.selection, history: [], message, images: [{ name: 'base' }] }), schema: ANSWER_SCHEMA, runId: crypto.randomUUID(), images: [{ name: 'base', mime: 'image/png', data: (await renderPng(before.text, { width: 768 })).toString('base64') }] });
  if (!res.ok) throw new Error(res.stderr || 'Falló el refinamiento');
  const answer = A.parseAnswer(provider, res);
  if (answer.aru || answer.reference) throw new Error('Refinamiento rechazado: la IA intentó reemplazar la base');
  const result = session.refine(answer.operations, { mode, selection: scope.selection, expectedRevision: before.revision });
  return { ...result, report: { reply: answer.reply, operations: answer.operations, changed: result.changed, geometryPreserved: result.geometryPreserved, scope, usage: answer.usage, ms: res.ms } };
}
