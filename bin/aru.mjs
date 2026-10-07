#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createIllustrator, EMPTY_DOCUMENT, ANSWER_SCHEMA, systemPrompt } from '../plugin/core.js';
const args = process.argv.slice(2), command = args.shift() || 'help', flags = {}, positionals = [];
let inputFile, inputHash;
function output(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function hash(text) { return createHash('sha256').update(text).digest('hex'); }
async function stdin() { let text = ''; for await (const c of process.stdin) text += c; return text; }
const readJson = async value => JSON.parse(value === '-' ? await stdin() : await fs.readFile(value, 'utf8'));
async function write(file, data, { noOverwrite = false } = {}) {
  const full = path.resolve(file), temp = path.join(path.dirname(full), `.${path.basename(full)}.${randomUUID()}.tmp`);
  if (inputFile && full === path.resolve(inputFile)) { const now = await fs.readFile(full, 'utf8'); if (hash(now) !== inputHash) throw new Error('El archivo cambió durante la operación; vuelve a consultar el contexto'); }
  try { await fs.writeFile(temp, data, { flag: 'wx' }); if (noOverwrite) { await fs.link(temp, full); await fs.unlink(temp); } else await fs.rename(temp, full); }
  finally { await fs.rm(temp, { force: true }); }
  return full;
}
try {
  const booleans = new Set(['write', 'dry-run', 'animate', 'force', 'plan', 'text-only', 'resume']);
  const values = new Set(['out', 'ops', 'fragment', 'image', 'reference', 'select', 'expected-hash', 'message', 'provider', 'model', 'review', 'width', 'height', 'background', 'format', 'port', 'into', 'label', 'repo', 'style', 'previous', 'feedback', 'group', 'sizes', 'formats', 'cell', 'mode', 'color', 'strength', 'job', 'batch-size']);
  while (args.length) {
    const a = args.shift(); if (!a.startsWith('--')) { positionals.push(a); continue; }
    const k = a.slice(2); if (!booleans.has(k) && !values.has(k)) throw new Error(`Opción desconocida: ${a}`);
    const v = booleans.has(k) ? true : args.shift(); if (v == null || (!booleans.has(k) && v.startsWith('--'))) throw new Error(`Falta el valor de ${a}`);
    if (k === 'image') (flags.image ||= []).push(v); else flags[k] = v;
  }
  if (command === 'help') { output({ name: 'ARU CLI', commands: {
    styles: 'aru styles (perfiles de apariencia para discover)',
    materials: 'aru materials (recetas para transformar una base)',
    material: 'aru material base.aru --select grupo --style chrome --out cromado.aru [--color #7691B8 --strength 1]',
    new: 'aru new --out dibujo.aru [--width 800 --height 600 --background #FFFFFF]',
    context: 'aru context dibujo.aru [--select grupo.capa]', schema: 'aru schema',
    apply: 'aru apply dibujo.aru --ops operaciones.json --out nuevo.aru | --write [--expected-hash HASH] [--dry-run]',
    preview: 'aru preview dibujo.aru --ops operaciones.json --out vista.svg',
    insert: 'aru insert dibujo.aru --fragment dibujo-parcial.aru --out nuevo.aru [--into grupo]',
    trace: 'aru trace dibujo.aru --image base.png [--reference ajustes.json] --out nuevo.aru',
    ask: 'aru ask dibujo.aru --message "Transforma la referencia en un icono" --image base.png --out nuevo.aru [--provider claude --review 1]',
    produce: 'aru produce base.aru --message "Crea 320 iconos vintage de música" --job trabajo.json --out pack.aru [--batch-size 16]; reanuda con el mismo comando y --resume',
    discover: 'aru discover --repo https://github.com/owner/repo --style "Material 3" --out icono.aru [--previous borrador.aru --feedback "Más personalidad" --plan --text-only]',
    refine: 'aru refine dibujo.aru --select grupo --message "Hazlo más suave" --mode contour --out refinado.aru',
    'export-icons': 'aru export-icons dibujo.aru --group iconos_app --out iconos.zip [--sizes 24,48,96 --formats png,svg,aru --cell 24|fit]',
    render: 'aru render dibujo.aru --out vista.png [--width 1024]', agents: 'aru agents', serve: 'aru serve [--port 8787]',
  }, protocol: 'stdout: JSON; stderr: progreso; código 0 éxito, 1 error; --ops - lee JSON por stdin', workflow: 'context → render → preview → apply → render; usa expected-hash para prevenir conflictos' }); }
  else if (command === 'materials') { if(positionals.length || Object.keys(flags).length) throw new Error('materials no recibe argumentos'); const {listMaterials}=await import('../plugin/index.js'); output({ok:true,materials:listMaterials()}); }
  else if (command === 'styles') { if(positionals.length || Object.keys(flags).length) throw new Error('styles no recibe argumentos'); const {listStyles}=await import('../plugin/styles.js'); output({ok:true,styles:listStyles()}); }
  else if (command === 'discover') {
    if (!flags.repo || !flags.style || (!flags.plan && !flags.out)) throw new Error('discover requiere --repo, --style y --out (o --plan)');
    if (flags.image?.length || positionals.length || flags.write || flags['dry-run']) throw new Error('discover busca sus propias referencias; usa --previous para un borrador rechazado o --plan para investigar sin dibujar');
    if (flags.out && !flags.force && await fs.stat(flags.out).catch(() => null)) throw new Error('El archivo de salida ya existe; usa otro nombre o --force');
    const { discoverProject, discoverIllustration } = await import('../plugin/discovery.js');
    const options = { repo: flags.repo, style: flags.style, provider: flags.provider || 'claude', model: flags.model || '', review: flags.review == null ? 1 : Number(flags.review), visual: !flags['text-only'], previous: flags.previous, feedback: flags.feedback || '', progress: (phase, status) => process.stderr.write(`${phase}: ${status}\n`) };
    async function referenceFiles(discovery) {
      if (!discovery.visual) return;
      const { referenceSheet } = await import('../plugin/visual-discovery.js');
      const refs = discovery.visual.images;
      if (flags.out) {
        const directory = path.resolve(flags.out.replace(/\.[^.]+$/, '') + '.references');
        await fs.mkdir(directory, { recursive: true });
        for (const ref of refs) ref.file = await write(path.join(directory, `ref-${ref.id}-${ref.sha256.slice(0,8)}.png`), Buffer.from(ref.data, 'base64'));
        discovery.visual.sheetFile = await write(path.join(directory, 'moodboard.png'), await referenceSheet(refs));
      }
      // The API carries the pixels; CLI JSON carries provenance and saved asset paths.
      discovery.visual.images = refs.map(({ data, ...metadata }) => metadata);
    }
    if (flags.plan) { const report = await discoverProject(options); await referenceFiles(report); output({ ok: true, report }); }
    else {
      const result = await discoverIllustration(options);
      await referenceFiles(result.report.discovery);
      output({ ok: true, file: await write(flags.out, result.text, { noOverwrite: !flags.force }), hash: hash(result.text), report: result.report });
    }
  }
  else if (command === 'schema') output({ version: 1, schema: ANSWER_SCHEMA, system: systemPrompt({ illustrator: true }) });
  else if (command === 'serve') {
    const port = Number(flags.port || 8787); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Puerto inválido');
    process.argv[2] = String(port); await import('../tools/serve.mjs');
  } else if (command === 'agents') { const { detect } = await import('../plugin/node.js'); output({ agents: detect() }); }
  else if (command === 'new') {
    if (!flags.out) throw new Error('new requiere --out');
    const w = Number(flags.width || 800), h = Number(flags.height || 600), bg = flags.background || '#FFFFFF';
    if (![w, h].every(v => Number.isInteger(v) && v >= 16 && v <= 20000) || !/^#[a-f\d]{3}([a-f\d]{3})?$/i.test(bg)) throw new Error('Canvas 16..20000 y background hexadecimal opaco');
    const text = `canvas ${w} ${h}\nbackground ${bg}\n`; const file = await write(flags.out, text, { noOverwrite: !flags.force }); output({ ok: true, file, hash: hash(text) });
  } else {
    const supported = ['context', 'inspect', 'apply', 'preview', 'insert', 'trace', 'ask', 'produce', 'refine', 'material', 'export-icons', 'render']; if (!supported.includes(command)) throw new Error(`Comando desconocido: ${command}`);
    if (positionals.length !== 1) throw new Error('Se necesita un archivo .aru');
    inputFile = positionals[0]; const text = await fs.readFile(inputFile, 'utf8'); inputHash = hash(text);
    if (flags['expected-hash'] && flags['expected-hash'] !== inputHash) throw new Error('Hash desactualizado: consulta context otra vez');
    const session = createIllustrator({ text, name: path.basename(inputFile) }); if (flags.select) session.select(flags.select.split(','));
    if (command === 'context' || command === 'inspect') output({ ok: true, hash: inputHash, ...session.context() });
    else if (command === 'export-icons') {
      if (!flags.out || path.resolve(flags.out) === path.resolve(inputFile)) throw new Error('export-icons requiere --out ZIP distinto al documento');
      const { exportIconArchive } = await import('../plugin/node.js');
      const result = await exportIconArchive(text, { group: flags.group, paths: flags.select?.split(','), sizes: flags.sizes ? flags.sizes.split(',').map(Number) : undefined, formats: flags.formats?.split(','), cellSize: flags.cell === 'fit' ? null : flags.cell ? Number(flags.cell) : 24, background: flags.background });
      output({ ok: true, file: await write(flags.out, result.data, { noOverwrite: !flags.force }), count: result.manifest.entries.length, fileCount: result.fileCount, manifest: result.manifest });
    }
    else if (command === 'render') {
      if (!flags.out) throw new Error('render requiere --out');
      const format = flags.format || path.extname(flags.out).slice(1).toLowerCase();
      if (!['svg', 'png'].includes(format)) throw new Error('Formato: svg o png');
      const data = format === 'svg' ? session.svg({ animate: !!flags.animate }) : await (await import('../plugin/node.js')).renderPng(text, { width: flags.width ? Number(flags.width) : undefined });
      if (path.resolve(flags.out) === path.resolve(inputFile)) throw new Error('render no puede reemplazar el documento');
      output({ ok: true, file: await write(flags.out, data), format, opaque: format === 'png' });
    } else if (command === 'preview') {
      if (!flags.ops) throw new Error('preview requiere --ops');
      const result = session.preview(await readJson(flags.ops));
      if (flags.out && path.resolve(flags.out) === path.resolve(inputFile)) throw new Error('preview no puede reemplazar el documento');
      output({ ok: true, hash: inputHash, ...result, ...(flags.out ? { file: await write(flags.out, result.svg) } : {}) });
    } else {
      if (!flags.out && !flags.write && !flags['dry-run']) throw new Error('Usa --out, --write o --dry-run');
      let report;
      let productionOutput = false;
      if (command === 'produce') {
        if (!flags.job || flags['dry-run'] || flags.image?.length || flags.select || flags.into) throw new Error('produce requiere --job; no admite dry-run, image, select ni into');
        const destination = path.resolve(flags.out || inputFile), jobFile = path.resolve(flags.job);
        if (jobFile === destination || jobFile === path.resolve(inputFile)) throw new Error('El checkpoint debe tener un archivo propio');
        const { createIconJob, produceIcons } = await import('../plugin/node.js');
        let job, sourceHash = inputHash;
        if (flags.resume) {
          const saved = await readJson(jobFile);
          if (saved.version !== 1 || saved.destination !== destination || ![saved.sourceHash, saved.outputHash, hash(saved.text)].includes(inputHash)) throw new Error('El checkpoint pertenece a otro documento o la base cambió');
          if (await fs.stat(destination).catch(() => null)) { const existing = await fs.readFile(destination, 'utf8'); if (![saved.sourceHash, saved.outputHash, hash(saved.text)].includes(hash(existing))) throw new Error('La salida fue editada; no se sobrescribirá al reanudar'); }
          sourceHash = saved.sourceHash; job = saved.job; session.load(saved.text);
        } else {
          if (await fs.stat(jobFile).catch(() => null)) throw new Error('El checkpoint ya existe; usa --resume o un nombre nuevo');
          if (destination !== path.resolve(inputFile) && !flags.force && await fs.stat(destination).catch(() => null)) throw new Error('La salida ya existe; usa otro nombre o --force');
          job = createIconJob(flags.message, { batchSize: flags['batch-size'] == null ? 16 : Number(flags['batch-size']) });
        }
        let outputHash = await fs.readFile(destination, 'utf8').then(hash).catch(() => null);
        const controller = new AbortController(), stop = () => controller.abort(); process.on('SIGINT', stop);
        try {
          report = (await produceIcons(session, { job, provider: flags.provider || 'claude', model: flags.model || '', signal: controller.signal,
            checkpoint: async (state, currentText) => {
              // The checkpoint contains the authoritative document: a crash between these two writes is resumable.
              await write(jobFile, JSON.stringify({ version: 1, sourceHash, outputHash, destination, job: state, text: currentText }, null, 2));
              const nowHash = await fs.readFile(destination, 'utf8').then(hash).catch(() => null);
              if (nowHash !== outputHash) throw new Error('La salida cambió durante la producción');
              await write(destination, currentText, { noOverwrite: outputHash === null }); outputHash = hash(currentText);
              if (destination === path.resolve(inputFile)) inputHash = outputHash;
            }, progress: state => process.stderr.write(`${state.status}: ${state.accepted.length}/${state.target}${state.reason ? ' · ' + state.reason : ''}\n`),
          })).report;
          productionOutput = true;
        } finally { process.removeListener('SIGINT', stop); }
      }
      if (command === 'material') report = session.refine([{ op: 'material', target: 'selection', preset: flags.style, color: flags.color, strength: flags.strength == null ? 1 : Number(flags.strength) }], { mode: 'style' });
      if (command === 'apply') { if (!flags.ops) throw new Error('apply requiere --ops'); report = session.apply(await readJson(flags.ops)).log; }
      if (command === 'insert') { if (!flags.fragment) throw new Error('insert requiere --fragment'); report = session.insert(await fs.readFile(flags.fragment, 'utf8'), { label: flags.label, into: flags.into }); }
      if (command === 'trace') { if (flags.image?.length !== 1) throw new Error('trace requiere una --image'); const { traceInto } = await import('../plugin/node.js'); report = await traceInto(session, flags.image[0], flags.reference ? await readJson(flags.reference) : {}); }
      if (command === 'refine') { const { refineIllustration } = await import('../plugin/node.js'); report = (await refineIllustration(session, { message: flags.message, mode: flags.mode || 'style', provider: flags.provider || 'claude', model: flags.model || '', progress: (what, k) => process.stderr.write(`${what}: ${k}\n`) })).report; }
      if (command === 'ask') { const { askIllustrator } = await import('../plugin/node.js'); report = (await askIllustrator(session, { message: flags.message, provider: flags.provider || 'claude', model: flags.model || '', review: flags.review == null ? 1 : Number(flags.review), images: flags.image || [], progress: (what, k, n) => process.stderr.write(`${what}: ${k}${n ? '/' + n : ''}\n`) })).report; }
      if (report?.text) { const { text: _, ...rest } = report; report = rest; }
      const next = session.getDocument();
      const file = productionOutput ? path.resolve(flags.out || inputFile) : flags['dry-run'] ? null : await write(flags.out || inputFile, next.text, { noOverwrite: !!flags.out && !flags.force && path.resolve(flags.out) !== path.resolve(inputFile) });
      const complete = report?.production ? report.production.status === 'complete' : true;
      output({ ok: complete, partial: !complete, file, dryRun: !!flags['dry-run'], hash: hash(next.text), previousHash: inputHash, report, ...(flags['dry-run'] ? { text: next.text, svg: session.svg() } : {}) });
      if (!complete) process.exitCode = 1;
    }
  }
} catch (error) { output({ ok: false, error: { message: error.message, details: error.details || null } }); process.exitCode = 1; }
