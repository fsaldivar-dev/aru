// A production job is independent of a provider. Only validated, committed icons count.
import { readDocument, boundsOf } from '../plugin/core.js';
import { toAru } from './serialize.js';
import { systemPrompt } from './agents.js';
import { productionBrief, briefPrompt } from './production-brief.js';
import { listIconBatches } from './export-icons.js';
import { parentOf } from './edit.js';
import { applyMaterial, applyPalette } from './materials.js';

export function requestedIconCount(message) {
  if (!/\b(crea\w*|genera\w*|dibuj\w*|pack|lote|produce|create|generate)\b/i.test(message)) return null;
  const m = /\b(\d+)\s+(?:[\wáéíóúñ-]+\s+){0,3}(?:iconos?|icons?)\b/i.exec(message);
  return m ? Number(m[1]) : null;
}
export const PRODUCTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['icons'], properties: {
    icons: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'purpose', 'aru'], properties: {
      label: { type: 'string' }, purpose: { type: 'string' }, aru: { type: 'string' },
    } } },
  },
};
export function createIconJob(message, { target = requestedIconCount(message), batchSize = 16, ...settings } = {}) {
  if (!Number.isInteger(target) || target < 1 || target > 1000) throw new Error('El lote admite entre 1 y 1000 iconos');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 24) throw new Error('batchSize debe ser 1..24');
  return { version: 1, id: `production_${crypto.randomUUID().replaceAll('-', '')}`, message, target, batchSize, status: 'paused', accepted: [], attempts: 0, reason: '', documentKey: null, issues: [], brief: productionBrief(message, settings), requested: target, existing: [], inventoryReady: false, nextIcon: 1 };
}
const labelKey = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Ignore IDs, names, labels and colour changes: renaming/repainting a drawing is not a new icon.
function geometry(node) {
  const geom = node.type === 'path' ? { ...node.geom, commands: node.geom.commands.map(({ cmd, args }) => ({ cmd, args })) } : node.geom;
  return { type: node.type, at: node.at, scale: node.scale, rotate: node.rotate, geom,
    children: node.children?.map(geometry) };
}
export const iconSignature = icon => JSON.stringify(geometry(icon), (k,v) => ['line','col','source'].includes(k) ? undefined : v);
// Compare actual silhouettes too: differently encoded paths may rasterise to the same icon.
async function visualSignature(icon, rasterize) {
  if (!rasterize) return null;
  const scene = readDocument('canvas 24 24\nbackground #FFFFFF\n').scene, copy = structuredClone(icon);
  const ink = n => { for (const p of ['fill', 'stroke']) if (n[p] != null && n[p] !== 'none') n[p] = '#000000'; delete n.shadow; n.inner = []; n.opacity = 1; for (const c of n.children || []) ink(c); };
  ink(copy); scene.root.children = [copy];
  const raw = await rasterize(scene, 32, 32); let bits = '', visible = false;
  for (let i = 0; i < raw.data.length; i += 16) { let byte = 0; for (let b = 0; b < 4 && i + b * 4 < raw.data.length; b++) if (raw.data[i + b * 4] < 240) { byte |= 1 << b; visible = true; } bits += byte.toString(16); }
  if (!visible) throw new Error('El dibujo no produce píxeles visibles');
  return bits;
}
// Local concurrency token, not a cryptographic integrity claim.
export function documentKey(text) { let a = 2166136261, b = 5381; for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); } return `${text.length}:${a >>> 0}:${b >>> 0}`; }

export function verifyIconJob(job, text) {
  if (job.version !== 1 || !Array.isArray(job.accepted) || !Number.isInteger(job.target) || job.target < 0 || job.target > 1000 || !Number.isInteger(job.batchSize) || job.batchSize < 1 || job.batchSize > 24 || job.accepted.length > job.target) throw new Error('Estado de producción inválido');
  const pack = readDocument(text).scene.root.children.find(n => n.name === job.id);
  const icons = pack?.children.filter(n => n.type === 'group') || [];
  const current = new Map(icons.map(n => [n.name, n]));
  const missing = [], modified = [];
  for (const entry of job.accepted) {
    const copy = structuredClone(current.get(entry.id));
    if (!copy) { missing.push(entry.id); continue; }
    copy.at = [0,0];
    const savedSignature=JSON.stringify(JSON.parse(entry.signature),(k,v)=>['line','col','source'].includes(k)?undefined:v);
    if (iconSignature(copy) !== savedSignature) modified.push(entry.id);
  }
  if (missing.length || modified.length || icons.length !== job.accepted.length) {
    const error = new Error(`Inventario modificado: ${icons.length} piezas presentes; ${missing.length} ausentes; ${modified.length} con geometría distinta. Revalida el pack antes de continuar.`);
    error.details = { count: icons.length, missing, modified }; throw error;
  }
  return icons.length;
}

function iconFragment(scene,icon) {
  const paints=new Set(); const visit=n=>{paints.add(n.fill);paints.add(n.stroke);for(const c of n.children||[]) visit(c);}; visit(icon);
  const gradients=Object.fromEntries(Object.entries(scene.gradients).filter(([name])=>paints.has(name)));
  return toAru({...scene,gradients,width:24,height:24,background:'none',root:{...scene.root,children:[icon]}},{precision:null});
}

export function synchronizeIconJob(job, text) {
  const count = verifyIconJob(job, text), scene = readDocument(text).scene;
  const pack = scene.root.children.find(n => n.name === job.id);
  for (const entry of job.accepted) {
    const icon = structuredClone(pack.children.find(n => n.name === entry.id)); icon.at = [0,0];
    entry.label = icon.label || entry.label;
    entry.aru = iconFragment(scene,icon).replace(/^canvas[^\n]*\nbackground[^\n]*\n/, '');
  }
  job.documentKey = documentKey(text); return count;
}
export function productionStatus(job, text) {
  try { const count = verifyIconJob(job,text); return { valid:true, count, target:job.target, existing:job.existing?.length || 0, status:count === job.target ? 'complete' : job.status === 'complete' ? 'paused' : job.status }; }
  catch(error) { return {valid:false, count:error.details?.count ?? 0, target:job.target, status:'modified', reason:error.message, ...error.details}; }
}
// Explicit reconciliation accepts valid user edits and removes missing entries from the inventory.
// It does not change the document or silently restore deleted drawings.
export async function revalidateIconJob(job, text, { rasterize } = {}) {
  const scene = readDocument(text).scene, pack = scene.root.children.find(n => n.name === job.id);
  const icons = pack?.children.filter(n => n.type === 'group') || [];
  if(icons.length > job.target) throw new Error('El pack supera el objetivo; revisa las piezas añadidas');
  const entries = [], labels = new Set(), shapes = new Set(), visuals = new Set();
  for(const node of icons) {
    const copy=structuredClone(node); copy.at=[0,0];
    const previous=job.accepted.find(e=>e.id===node.name), label=node.label || node.name;
    const aru=iconFragment(scene,copy).replace(/^canvas[^\n]*\nbackground[^\n]*\n/, '');
    prepareIcon({label,purpose:previous?.purpose || label,aru},node.name,job.id);
    const signature=iconSignature(copy), visual=await visualSignature(copy,rasterize), key=labelKey(label);
    if(labels.has(key) || shapes.has(signature) || visual && visuals.has(visual)) throw new Error(`Pieza repetida: ${node.path}`);
    labels.add(key); shapes.add(signature); if(visual) visuals.add(visual);
    entries.push({id:node.name,label,purpose:previous?.purpose || label,aru,signature,visualSignature:visual});
  }
  job.accepted=entries;
  job.nextIcon=Math.max(job.nextIcon || 1,...icons.map(n=>Number(/^icon_(\d+)$/.exec(n.name)?.[1] || 0)+1));
  job.status=entries.length===job.target?'complete':'paused'; job.reason=''; job.issues=[];
  delete job.qualityReview;
  synchronizeIconJob(job,text); return productionStatus(job,text);
}

export const PRODUCTION_REVIEW_SCHEMA = {type:'object',additionalProperties:false,required:['accept','styleMatch','purposeMatch','smallLegibility','reason'],properties:{accept:{type:'boolean'},styleMatch:{type:'boolean'},purposeMatch:{type:'boolean'},smallLegibility:{type:'boolean'},reason:{type:'string'}}};
export function productionReview({text,job,icons}) {
  const scene=readDocument(text).scene, pack=scene.root.children.find(n=>n.name===job.id);
  const names=new Set(icons.map(e=>e.id)), candidates=pack.children.filter(n=>names.has(n.name));
  const cols=Math.min(6,candidates.length), children=[];
  candidates.forEach((n,i)=>{
    const x=i%cols*104,y=Math.floor(i/cols)*128;
    children.push({...structuredClone(n),at:[x+12,y+4],scale:[3,3]});
    children.push({...structuredClone(n),name:`small_${i}`,at:[x+36,y+82],scale:[1,1]});
  });
  return {scene:{...scene,width:cols*104,height:Math.ceil(candidates.length/cols)*128,background:'#FFFFFF',root:{...scene.root,children}},
    prompt:`Review this proposed batch BEFORE commitment. The sheet shows each icon at 72px and 24px. Check requested style, app purpose, palette, silhouette and recognition at 24px. Reject unrelated metaphors (e.g. DJ equipment for mobile automation), generic outlines when glossy Fruits was requested, or illegible tiny details. Return accept=true only when styleMatch, purposeMatch and smallLegibility are all true. Labels and functions in sheet order: ${JSON.stringify(icons.map(({label,purpose})=>({label,purpose})))}\n${briefPrompt(job.brief)}`};
}

async function seedInventory(job,text,rasterize) {
  job.brief ||= productionBrief(job.message);
  if (job.inventoryReady) return;
  const scene = readDocument(text).scene, batches = listIconBatches(text);
  // Prefer explicit packs; do not mistake the groups of a logo for icons.
  const paths = batches.filter(b => b.path !== job.id).filter(b => b.explicit || /(?:icon|pack)/i.test(b.label)).map(b => b.path);
  const included = new Set(); job.existing ||= [];
  for (const path of paths) for (const node of scene.byPath.get(path).children.filter(n => n.type === 'group' && !n.hidden)) {
    if(included.has(node.id)) continue; included.add(node.id);
    const copy=structuredClone(node); copy.at=[0,0];
    for(const key of ['fill','stroke','strokeWidth','cap','join']) {
      if(copy[key]!=null && !(key==='strokeWidth' && node.stroke==null && copy.strokeWidth===1)) continue;
      for(let ancestor=parentOf(scene,node);ancestor;ancestor=parentOf(scene,ancestor)) if(ancestor[key]!=null) {copy[key]=ancestor[key];break;}
    }
    const label=copy.label || copy.name;
    job.existing.push({ id:node.path,label,purpose:copy.semantic || label,signature:iconSignature(copy),visualSignature:await visualSignature(copy,rasterize),
      aru:iconFragment(scene,copy) });
  }
  job.requested ||= job.target;
  if(job.brief.countMode === 'total') job.target=Math.max(0,job.requested-job.existing.length);
  job.inventoryReady=true;
}

function prepareIcon(entry, id, namespace, { material = '' } = {}) {
  if (!entry || typeof entry.label !== 'string' || !labelKey(entry.label) || entry.label.length > 100 || typeof entry.purpose !== 'string' || !entry.purpose.trim() || typeof entry.aru !== 'string') throw new Error('Icono sin nombre, propósito o dibujo');
  if (entry.aru.length > 32000) throw new Error('Dibujo demasiado largo');
  const { scene } = readDocument(`canvas 24 24\nbackground none\n${entry.aru}`);
  const prototype = readDocument('canvas 24 24\nbackground none\ngroup icon { fill none; stroke #243D48 1.8; cap round; join round }').scene.root.children[0];
  // Single wrapper supplied by the model is unwrapped only when it carries no transform/style.
  prototype.children = scene.root.children;
  prototype.name = id; prototype.label = entry.label.trim().replace(/"/g, "'").replace(/[\r\n]/g, ' '); prototype.semantic = 'ui.icon';
  let visible = 0;
  const gradients = {}, gradientNames = new Map(Object.keys(scene.gradients).map(name => [name, `${namespace}_${id}_${name}`]));
  for (const [name, value] of Object.entries(scene.gradients)) gradients[gradientNames.get(name)] = value;
  const visit = (n, fill = 'none', stroke = '#243D48') => {
    if (n.hidden || n.opacity === 0 || n.clip || n.animate || n.locked) throw new Error('No se admiten piezas ocultas, recortadas o animadas');
    if(material) {delete n.shadow; n.inner=[];}
    if (n.type === 'text') throw new Error('Un nombre escrito no cuenta como icono');
    for (const property of ['fill', 'stroke']) if (gradientNames.has(n[property])) n[property] = gradientNames.get(n[property]);
    fill = n.fill ?? fill; stroke = n.stroke ?? stroke;
    if (n.type !== 'group' && ((fill !== 'none' && n.fillOpacity !== 0) || (stroke !== 'none' && n.strokeWidth !== 0))) visible++;
    for (const c of n.children || []) visit(c, fill, stroke);
  };
  visit(prototype); prototype.productionGradients = gradients;
  if (!visible) throw new Error('Dibujo vacío');
  const b = boundsOf(prototype);
  if (!b || !b.every(Number.isFinite) || b[0] < -3 || b[1] < -3 || b[2] > 27 || b[3] > 27 || b[2] - b[0] < 2 || b[3] - b[1] < 2) throw new Error(`El dibujo debe caber en la celda local 0..24; límites calculados: ${JSON.stringify(b)}`);
  return prototype;
}

function appendIcons(text, job, icons) {
  const { scene } = readDocument(text);
  let pack = scene.root.children.find(n => n.name === job.id);
  if (!pack) {
    pack = readDocument(`canvas 24 24\nbackground none\ngroup ${job.id} { semantic ui.iconpack; label "Producción de ${job.target} iconos" }`).scene.root.children[0];
    pack.at = [32, scene.root.children.length ? scene.height + 32 : 32];
    pack.scale = [3, 3];
    scene.root.children.push(pack);
  }
  const columns = Math.min(16, Math.ceil(Math.sqrt(job.target))), cell = 36;
  for (const icon of icons) { const index = pack.children.length; Object.assign(scene.gradients, icon.productionGradients); delete icon.productionGradients; icon.at = [index % columns * cell, Math.floor(index / columns) * cell]; pack.children.push(icon); }
  // The engine owns placement. Existing content remains untouched and the canvas grows.
  scene.width = Math.max(scene.width, pack.at[0] + columns * cell * pack.scale[0] + 32);
  scene.height = Math.max(scene.height, pack.at[1] + Math.ceil(pack.children.length / columns) * cell * pack.scale[1] + 32);
  const painted = readDocument(toAru(scene, { precision:null })).scene;
  const newIcons = painted.root.children.find(n => n.name === job.id).children.filter(n => icons.some(i => i.name === n.name));
  const brief = job.brief || {};
  if(brief.color) applyPalette(painted,newIcons.map(n=>n.id),{color:brief.color,accent:brief.accent,material:brief.material});
  else if(brief.material) applyMaterial(painted,newIcons.map(n=>n.id),{preset:brief.material});
  const next = toAru(painted, { precision: null }); readDocument(next); return next;
}

export async function runIconJob(job, { getText, commit, request, checkpoint = async () => {}, progress = () => {}, signal, rasterize, reviewBatch } = {}) {
  verifyIconJob(job, getText());
  await seedInventory(job,getText(),rasterize);
  synchronizeIconJob(job,getText());
  job.status = 'running'; job.reason = ''; let stalled = 0;
  async function save() { await checkpoint(structuredClone(job), getText()); progress(structuredClone(job)); }
  try {
    await save();
    while (job.accepted.length < job.target) {
      if (signal?.aborted) throw new Error('Detenido por el usuario');
      const before = getText(), count = Math.min(job.batchSize, job.target - job.accepted.length);
      const prompt = `PRODUCTION JOB. Original request: ${job.message}\nTarget: ${job.target}. Accepted: ${job.accepted.length}. Draw EXACTLY ${count} NEW icons in this response; the tool will call you again until the target is met. Do not reduce the target, offer a first pack, ask to continue, or produce placeholders.\nInventory (exclude these meanings and labels): ${JSON.stringify([...(job.existing || []),...job.accepted].map(({ label, purpose }) => ({ label, purpose })))}\nPrevious accepted drawings to match the style: ${JSON.stringify((job.accepted.length ? job.accepted : job.existing || []).slice(0, 3).map(({ label, aru }) => ({ label, aru })))}\nLast rejected items: ${JSON.stringify(job.issues.slice(-12))}\nChoose distinct useful functions for the original app, systematically covering different categories. Each icon needs its own recognisable geometry, not just a renamed, recoloured or numbered duplicate. Return JSON icons with label, purpose and aru. Each aru is a fragment of drawable ARU shapes in LOCAL coordinates 0..24, no canvas/background, text, global placement, or pack. Gradients are allowed with definitions included in the fragment. Use explicit paint per shape. If no appearance was requested, use a neutral dark outline #243D48, 1.8px round stroke; no implicit vintage palette. Explicit paint per shape when needed. When a binding material is present, omit shadows/inner effects: the engine computes them. Keep visible geometry within 2..22 and use only local coordinates, never 512 or canvas placement. Keep the requested style across ALL batches.`;
      const answer = await request(systemPrompt({ illustrator: true }) + '\nPRODUCTION OVERRIDE: for this job return ONLY the production schema {icons:[{label,purpose,aru}]}, not the ordinary chat answer schema.', prompt + '\n' + briefPrompt(job.brief) + (job.context ? `\nStarting document context (reference for app purpose/style, not a request to replace it):\n${job.context}` : ''), PRODUCTION_SCHEMA);
      if (signal?.aborted) throw new Error('Detenido por el usuario');
      if (getText() !== before) throw new Error('El documento cambió mientras se dibujaba el lote; se descartó esta respuesta');
      if (!Array.isArray(answer?.icons)) throw new Error('El proveedor no devolvió un lote de iconos');
      const accepted = [], entries = [], labels = new Set([...(job.existing || []),...job.accepted].map(e => labelKey(e.label))), signatures = new Set([...(job.existing || []),...job.accepted].map(e => e.signature)), visual = new Set([...(job.existing || []),...job.accepted].map(e => e.visualSignature).filter(Boolean));
      const issues = [];
      for (const entry of answer.icons.slice(0, count)) {
        try {
          const icon = prepareIcon(entry, `icon_${String((job.nextIcon || job.accepted.length + 1) + entries.length).padStart(4, '0')}`, job.id, job.brief), key = labelKey(entry.label), signature = iconSignature(icon);
          if (labels.has(key)) throw new Error('Nombre repetido');
          if (signatures.has(signature)) throw new Error('Geometría repetida');
          const rendered = await visualSignature(icon, rasterize);
          if (rendered && visual.has(rendered)) throw new Error('Silueta repetida a 32 px');
          if (rendered) visual.add(rendered);
          labels.add(key); signatures.add(signature); accepted.push(icon);
          entries.push({ id: icon.name, label: icon.label, purpose: entry.purpose.trim(), aru: entry.aru, signature, visualSignature: rendered });
        } catch (e) { issues.push({ label: entry?.label || '?', reason: e.message }); }
      }
      if (answer.icons.length !== count) issues.push({ label: 'lote', reason: `Se pidieron ${count} y llegaron ${answer.icons.length}` });
      job.attempts++; job.issues = issues;
      if (accepted.length) {
        if (signal?.aborted) throw new Error('Detenido por el usuario');
        if (getText() !== before) throw new Error('El documento cambió durante la validación; se descartó el lote');
        const next = appendIcons(before, job, accepted);
        if(reviewBatch) {
          const review=await reviewBatch({text:next,job:structuredClone(job),icons:entries});
          if(getText() !== before) throw new Error('El documento cambió durante la revisión visual');
          if(!review?.accept || review.styleMatch === false || review.purposeMatch === false || review.smallLegibility === false) { job.issues.push({label:'calidad',reason:review?.reason || 'El lote no cumple el brief visual'}); stalled++; await save(); if(stalled>=3) throw new Error('Tres lotes sin superar la revisión visual'); continue; }
          job.qualityReview=review;
        }
        await commit(next, before);
        job.accepted.push(...entries); job.nextIcon=(job.nextIcon || job.accepted.length-entries.length+1)+entries.length; job.documentKey = documentKey(getText()); stalled = 0;
        synchronizeIconJob(job, getText());
      } else stalled++;
      await save();
      if (stalled >= 3) throw new Error('Tres lotes sin iconos nuevos válidos. Revisa los rechazos antes de reanudar');
    }
    verifyIconJob(job, getText()); job.status = 'complete';
  } catch (e) { job.status = 'paused'; job.reason = e.message || String(e); }
  await save(); return job;
}
