#!/usr/bin/env node
import { listResources } from '../src/resources.js';
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
  const booleans = new Set(['write', 'dry-run', 'animate', 'force', 'plan', 'text-only', 'resume', 'revalidate']);
  const values = new Set(['out', 'ops', 'fragment', 'image', 'reference', 'select', 'expected-hash', 'message', 'provider', 'model', 'review', 'width', 'height', 'background', 'format', 'port', 'into', 'label', 'repo', 'style', 'styles', 'subjects', 'usage', 'previous', 'feedback', 'group', 'sizes', 'formats', 'cell', 'mode', 'color', 'strength', 'job', 'batch-size', 'material', 'accent', 'purpose', 'count-mode', 'history', 'project', 'tag', 'brand', 'kind', 'query']);
  while (args.length) {
    const a = args.shift(); if (!a.startsWith('--')) { positionals.push(a); continue; }
    const k = a.slice(2); if (!booleans.has(k) && !values.has(k)) throw new Error(`Opción desconocida: ${a}`);
    const v = booleans.has(k) ? true : args.shift(); if (v == null || (!booleans.has(k) && v.startsWith('--'))) throw new Error(`Falta el valor de ${a}`);
    if (k === 'image') (flags.image ||= []).push(v); else flags[k] = v;
  }
  if (command === 'help') { output({ name: 'ARU CLI', commands: {
    styles: 'aru styles (23 perfiles de apariencia para discover y produce)',
    materials: 'aru materials (recetas para transformar una base)',
    material: 'aru material base.aru --select grupo --style chrome --out cromado.aru [--color #7691B8 --strength 1]',
    new: 'aru new --out dibujo.aru [--width 800 --height 600 --background #FFFFFF]',
    resources: 'aru resources dibujo.aru [--tag musaru --brand Musaru --kind logo --query splash]',
    context: 'aru context dibujo.aru [--select grupo.capa --project nombre]', schema: 'aru schema',
    apply: 'aru apply dibujo.aru --ops operaciones.json --out nuevo.aru | --write [--expected-hash HASH] [--dry-run]',
    preview: 'aru preview dibujo.aru --ops operaciones.json --out vista.svg',
    insert: 'aru insert dibujo.aru --fragment dibujo-parcial.aru --out nuevo.aru [--into grupo]',
    trace: 'aru trace dibujo.aru --image base.png [--reference ajustes.json] --out nuevo.aru',
    ask: 'aru ask dibujo.aru --message "Transforma la referencia en un icono" --image base.png --out nuevo.aru [--provider claude --review 1]',
    produce: 'aru produce base.aru --message "Crea 320 iconos vintage de música" --job trabajo.json --out pack.aru [--batch-size 16 --style "Material 3" --material fruits --color #2463EB --accent #FFD426 --purpose "Automatización móvil" --count-mode additional|total]; reanuda con el mismo comando y --resume',
    inventory: 'aru inventory pack.aru --job trabajo.json [--revalidate] (sin generar ni editar dibujos)',
    palette: 'aru palette base.aru --select pack --color #2463EB --accent #FFD426 --out azul.aru [--material fruits]',
    discover: 'aru discover --repo https://github.com/owner/repo --style "Material 3" --out icono.aru [--previous borrador.aru --feedback "Más personalidad" --plan --text-only]',
    'explore-icons': 'aru explore-icons --subjects "Guitarra eléctrica,Teclado musical,Maracas,Batería acústica" --styles "material-3-expressive,apple-minimal,frutiger-fruits,dark-aero,funky-seasons,y2k-chrome" --out exploracion [--usage ui-controls|illustrated --provider claude --review 1]; predeterminado: ui-controls (botones e indicadores)',
    refine: 'aru refine dibujo.aru --select grupo --message "Hazlo más suave" --mode contour|style|redraw --out refinado.aru [--history historial.json]',
    'export-icons': 'aru export-icons dibujo.aru --group iconos_app --out iconos.zip [--sizes 24,48,96 --formats png,svg,aru --cell 24|fit]',
    render: 'aru render dibujo.aru --out vista.png [--width 1024]', agents: 'aru agents', serve: 'aru serve [--port 8787]',
  }, protocol: 'stdout: JSON; stderr: progreso; código 0 éxito, 1 error; --ops - lee JSON por stdin', workflow: 'context → render → preview → apply → render; usa expected-hash para prevenir conflictos' }); }
  else if (command === 'materials') { if(positionals.length || Object.keys(flags).length) throw new Error('materials no recibe argumentos'); const {listMaterials}=await import('../plugin/index.js'); output({ok:true,materials:listMaterials()}); }
  else if (command === 'styles') { if(positionals.length || Object.keys(flags).length) throw new Error('styles no recibe argumentos'); const {listStyles}=await import('../plugin/styles.js'); output({ok:true,styles:listStyles()}); }
  else if (command === 'explore-icons') {
    if (!flags.subjects || !flags.styles || !flags.out) throw new Error('explore-icons requiere --subjects, --styles y --out');
    const allowed = new Set(['subjects', 'styles', 'usage', 'out', 'provider', 'model', 'review', 'force']);
    if (positionals.length || Object.keys(flags).some(flag => !allowed.has(flag))) throw new Error('explore-icons investiga sus propias referencias; solo admite --subjects, --styles, --usage, --out, --provider, --model, --review y --force');
    if (!flags.force && await fs.stat(flags.out).catch(() => null)) throw new Error('La carpeta de salida ya existe; usa otro nombre o --force');
    const { exploreIconStyles } = await import('../plugin/node.js');
    const report = await exploreIconStyles({ subjects: flags.subjects.split(','), styles: flags.styles.split(','), usage: flags.usage || 'ui-controls', outputDir: flags.out, provider: flags.provider || 'claude', model: flags.model || '', review: flags.review == null ? 1 : Number(flags.review), progress: (phase, status) => process.stderr.write(`${phase}: ${status}\n`) });
    const saved = JSON.parse(await fs.readFile(path.join(path.resolve(flags.out), 'report.json'), 'utf8'));
    output({ ok: report.complete, reportFile: path.resolve(flags.out, 'report.json'), ...saved });
    if (!report.complete) process.exitCode = 1;
  }
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
    const supported = ['resources', 'context', 'inspect', 'apply', 'preview', 'insert', 'trace', 'ask', 'produce', 'refine', 'material', 'palette', 'inventory', 'export-icons', 'render']; if (!supported.includes(command)) throw new Error(`Comando desconocido: ${command}`);
    if (positionals.length !== 1) throw new Error('Se necesita un archivo .aru');
    inputFile = positionals[0]; const text = await fs.readFile(inputFile, 'utf8'); inputHash = hash(text);
    if (flags['expected-hash'] && flags['expected-hash'] !== inputHash) throw new Error('Hash desactualizado: consulta context otra vez');
    const session = createIllustrator({ text, name: path.basename(inputFile),project:flags.project?{name:flags.project}:null }); if (flags.select) session.select(flags.select.split(','));
    if (command === 'context' || command === 'inspect') output({ ok: true, hash: inputHash, ...session.context() });
    else if (command === 'resources') { const { readDocument } = await import('../plugin/core.js'); output({ ok:true, hash:inputHash, resources:listResources(readDocument(text).scene, flags) }); }
    else if (command === 'inventory') {
      if(!flags.job) throw new Error('inventory requiere --job');
      const saved=await readJson(flags.job), job=saved.job || saved;
      const {productionStatus,revalidateIconJob}=await import('../plugin/node.js');
      if(flags.revalidate) {
        if(saved.destination && path.resolve(inputFile)!==saved.destination) throw new Error('Revalida el documento de salida del checkpoint');
        await revalidateIconJob(job,text,{rasterize:(await import('../plugin/node.js')).rasterize});
        await write(flags.job,JSON.stringify(saved.job ? {...saved,job,text,outputHash:inputHash} : job,null,2));
      }
      const status=productionStatus(job,text); output({ok:status.valid,...status,job}); if(!status.valid) process.exitCode=1;
    }
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
        const { createIconJob, produceIcons, verifyIconJob, revalidateIconJob, rasterize } = await import('../plugin/node.js');
        let job, sourceHash = inputHash;
        if (flags.resume) {
          const saved = await readJson(jobFile);
          if (saved.version !== 1 || saved.destination !== destination) throw new Error('El checkpoint pertenece a otro documento');
          job=saved.job; sourceHash=saved.sourceHash;
          const existing=await fs.readFile(destination,'utf8').catch(()=>null);
          // A crash after saving the checkpoint may leave the previous output on disk.
          // Otherwise validate and retain the current document, including safe paint edits.
          let current=saved.text;
          if(existing!=null && ![saved.outputHash,hash(saved.text)].includes(hash(existing))) current=existing;
          if(path.resolve(inputFile)!==destination && inputHash!==saved.sourceHash) throw new Error('La base cambió; reanuda usando el documento de salida como entrada');
          try {verifyIconJob(job,current);} catch(error) {
            if(!flags.revalidate) throw error;
            await revalidateIconJob(job,current,{rasterize});
          }
          session.load(current);
        } else {
          if (await fs.stat(jobFile).catch(() => null)) throw new Error('El checkpoint ya existe; usa --resume o un nombre nuevo');
          if (destination !== path.resolve(inputFile) && !flags.force && await fs.stat(destination).catch(() => null)) throw new Error('La salida ya existe; usa otro nombre o --force');
          job = createIconJob(flags.message, { style:flags.style, material:flags.material, color:flags.color, accent:flags.accent, purpose:flags.purpose, countMode:flags['count-mode'], history:flags.history ? await readJson(flags.history) : [], batchSize: flags['batch-size'] == null ? 16 : Number(flags['batch-size']) });
        }
        let outputHash = await fs.readFile(destination, 'utf8').then(hash).catch(() => null);
        const controller = new AbortController(), stop = () => controller.abort(); process.on('SIGINT', stop);
        try {
          report = (await produceIcons(session, { job, style:flags.style, material:flags.material, color:flags.color, accent:flags.accent, purpose:flags.purpose, countMode:flags['count-mode'], provider: flags.provider || 'claude', model: flags.model || '', review:flags.review==null ? 1 : Number(flags.review), signal: controller.signal,
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
      if (command === 'palette') report=session.refine([{op:'palette',target:'selection',color:flags.color,accent:flags.accent,material:flags.material}],{mode:'style'});
      if (command === 'material') report = session.refine([{ op: 'material', target: 'selection', preset: flags.style, color: flags.color, strength: flags.strength == null ? 1 : Number(flags.strength) }], { mode: 'style' });
      if (command === 'apply') { if (!flags.ops) throw new Error('apply requiere --ops'); report = session.apply(await readJson(flags.ops)).log; }
      if (command === 'insert') { if (!flags.fragment) throw new Error('insert requiere --fragment'); report = session.insert(await fs.readFile(flags.fragment, 'utf8'), { label: flags.label, into: flags.into }); }
      if (command === 'trace') { if (flags.image?.length !== 1) throw new Error('trace requiere una --image'); const { traceInto } = await import('../plugin/node.js'); report = await traceInto(session, flags.image[0], flags.reference ? await readJson(flags.reference) : {}); }
      if (command === 'refine') {
        const { refineIllustration } = await import('../plugin/node.js');
        const controller = new AbortController(), stop = () => controller.abort(); process.on('SIGINT', stop);
        try { report = (await refineIllustration(session, { message: flags.message, mode: flags.mode || 'style', provider: flags.provider || 'claude', model: flags.model || '', history: flags.history ? await readJson(flags.history) : [], signal: controller.signal, progress: (what, k) => process.stderr.write(`${what}: ${k}\n`) })).report; }
        finally { process.removeListener('SIGINT', stop); }
      }
      if (command === 'ask') { const { askIllustrator } = await import('../plugin/node.js'); report = (await askIllustrator(session, { message: flags.message, style:flags.style, material:flags.material, color:flags.color, accent:flags.accent, purpose:flags.purpose, countMode:flags['count-mode'], history:flags.history ? await readJson(flags.history) : [], provider: flags.provider || 'claude', model: flags.model || '', review: flags.review == null ? 1 : Number(flags.review), images: flags.image || [], progress: (what, k, n) => process.stderr.write(`${what}: ${k}${n ? '/' + n : ''}\n`) })).report; }
      if (report?.text) { const { text: _, ...rest } = report; report = rest; }
      const next = session.getDocument();
      const file = productionOutput ? path.resolve(flags.out || inputFile) : flags['dry-run'] ? null : await write(flags.out || inputFile, next.text, { noOverwrite: !!flags.out && !flags.force && path.resolve(flags.out) !== path.resolve(inputFile) });
      const complete = report?.production ? report.production.status === 'complete' : true;
      output({ ok: complete, partial: !complete, file, dryRun: !!flags['dry-run'], hash: hash(next.text), previousHash: inputHash, report, ...(flags['dry-run'] ? { text: next.text, svg: session.svg() } : {}) });
      if (!complete) process.exitCode = 1;
    }
  }
} catch (error) { output({ ok: false, error: { message: error.message, details: error.details || null } }); process.exitCode = 1; }
