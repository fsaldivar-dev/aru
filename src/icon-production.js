// A production job is independent of a provider. Only validated, committed icons count.
import { readDocument, boundsOf } from '../plugin/core.js';
import { toAru } from './serialize.js';
import { systemPrompt } from './agents.js';

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
export function createIconJob(message, { target = requestedIconCount(message), batchSize = 16 } = {}) {
  if (!Number.isInteger(target) || target < 1 || target > 1000) throw new Error('El lote admite entre 1 y 1000 iconos');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 24) throw new Error('batchSize debe ser 1..24');
  return { version: 1, id: `production_${crypto.randomUUID().replaceAll('-', '')}`, message, target, batchSize, status: 'paused', accepted: [], attempts: 0, reason: '', documentKey: null, issues: [] };
}
const labelKey = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Ignore IDs, names, labels and colour changes: renaming/repainting a drawing is not a new icon.
function geometry(node) {
  const geom = node.type === 'path' ? { ...node.geom, commands: node.geom.commands.map(({ cmd, args }) => ({ cmd, args })) } : node.geom;
  return { type: node.type, at: node.at, scale: node.scale, rotate: node.rotate, geom,
    children: node.children?.map(geometry) };
}
export const iconSignature = icon => JSON.stringify(geometry(icon));
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
  if (job.version !== 1 || !Array.isArray(job.accepted) || !Number.isInteger(job.target) || job.target < 1 || job.target > 1000 || !Number.isInteger(job.batchSize) || job.batchSize < 1 || job.batchSize > 24 || job.accepted.length > job.target) throw new Error('Estado de producción inválido');
  if (job.documentKey && job.documentKey !== documentKey(text)) throw new Error('El documento cambió desde el último lote. No se puede reanudar sobre otra versión');
  const pack = readDocument(text).scene.root.children.find(n => n.name === job.id);
  const icons = pack?.children.filter(n => n.type === 'group') || [];
  if (icons.length !== job.accepted.length || job.accepted.some((entry, i) => {
    const copy = structuredClone(icons[i]); if (!copy || copy.name !== entry.id || copy.label !== entry.label) return true;
    copy.at = [0, 0]; return iconSignature(copy) !== entry.signature;
  })) throw new Error('El inventario del pack ya no coincide con el trabajo guardado');
  return icons.length;
}

function prepareIcon(entry, id, namespace) {
  if (!entry || typeof entry.label !== 'string' || !labelKey(entry.label) || entry.label.length > 100 || typeof entry.purpose !== 'string' || !entry.purpose.trim() || typeof entry.aru !== 'string') throw new Error('Icono sin nombre, propósito o dibujo');
  if (entry.aru.length > 32000) throw new Error('Dibujo demasiado largo');
  const { scene } = readDocument(`canvas 24 24\nbackground none\n${entry.aru}`);
  const prototype = readDocument('canvas 24 24\nbackground none\ngroup icon { fill none; stroke #604631 1.8; cap round; join round }').scene.root.children[0];
  // Single wrapper supplied by the model is unwrapped only when it carries no transform/style.
  prototype.children = scene.root.children;
  prototype.name = id; prototype.label = entry.label.trim().replace(/"/g, "'").replace(/[\r\n]/g, ' '); prototype.semantic = 'ui.icon';
  let visible = 0;
  const gradients = {}, gradientNames = new Map(Object.keys(scene.gradients).map(name => [name, `${namespace}_${id}_${name}`]));
  for (const [name, value] of Object.entries(scene.gradients)) gradients[gradientNames.get(name)] = value;
  const visit = (n, fill = 'none', stroke = '#604631') => {
    if (n.hidden || n.opacity === 0 || n.clip || n.animate || n.locked) throw new Error('No se admiten piezas ocultas, recortadas o animadas');
    if (n.type === 'text') throw new Error('Un nombre escrito no cuenta como icono');
    for (const property of ['fill', 'stroke']) if (gradientNames.has(n[property])) n[property] = gradientNames.get(n[property]);
    fill = n.fill ?? fill; stroke = n.stroke ?? stroke;
    if (n.type !== 'group' && ((fill !== 'none' && n.fillOpacity !== 0) || (stroke !== 'none' && n.strokeWidth !== 0))) visible++;
    for (const c of n.children || []) visit(c, fill, stroke);
  };
  visit(prototype); prototype.productionGradients = gradients;
  if (!visible) throw new Error('Dibujo vacío');
  const b = boundsOf(prototype);
  if (!b || !b.every(Number.isFinite) || b[0] < -3 || b[1] < -3 || b[2] > 27 || b[3] > 27 || b[2] - b[0] < 2 || b[3] - b[1] < 2) throw new Error('El dibujo debe caber en la celda local 0..24');
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
  const next = toAru(scene, { precision: null }); readDocument(next); return next;
}

export async function runIconJob(job, { getText, commit, request, checkpoint = async () => {}, progress = () => {}, signal, rasterize } = {}) {
  verifyIconJob(job, getText());
  job.documentKey ||= documentKey(getText());
  job.status = 'running'; job.reason = ''; let stalled = 0;
  async function save() { await checkpoint(structuredClone(job), getText()); progress(structuredClone(job)); }
  try {
    await save();
    while (job.accepted.length < job.target) {
      if (signal?.aborted) throw new Error('Detenido por el usuario');
      const before = getText(), count = Math.min(job.batchSize, job.target - job.accepted.length);
      const prompt = `PRODUCTION JOB. Original request: ${job.message}\nTarget: ${job.target}. Accepted: ${job.accepted.length}. Draw EXACTLY ${count} NEW icons in this response; the tool will call you again until the target is met. Do not reduce the target, offer a first pack, ask to continue, or produce placeholders.\nInventory (exclude these meanings and labels): ${JSON.stringify(job.accepted.map(({ label, purpose }) => ({ label, purpose })))}\nPrevious accepted drawings to match the style: ${JSON.stringify(job.accepted.slice(0, 3).map(({ label, aru }) => ({ label, aru })))}\nLast rejected items: ${JSON.stringify(job.issues.slice(-12))}\nChoose distinct useful functions for the original app, systematically covering different categories. Each icon needs its own recognisable geometry, not just a renamed, recoloured or numbered duplicate. Return JSON icons with label, purpose and aru. Each aru is a fragment of drawable ARU shapes in LOCAL coordinates 0..24, no canvas/background, text, global placement, or pack. Gradients are allowed with definitions included in the fragment. Default outline if unspecified: sepia #604631, 1.8px round stroke, no fill; accents rust #AB4D2F. Explicit paint per shape when needed. Keep the requested style across ALL batches.`;
      const answer = await request(systemPrompt({ illustrator: true }) + '\nPRODUCTION OVERRIDE: for this job return ONLY the production schema {icons:[{label,purpose,aru}]}, not the ordinary chat answer schema.', prompt + (job.context ? `\nStarting document context (reference for app purpose/style, not a request to replace it):\n${job.context}` : ''), PRODUCTION_SCHEMA);
      if (signal?.aborted) throw new Error('Detenido por el usuario');
      if (getText() !== before) throw new Error('El documento cambió mientras se dibujaba el lote; se descartó esta respuesta');
      if (!Array.isArray(answer?.icons)) throw new Error('El proveedor no devolvió un lote de iconos');
      const accepted = [], entries = [], labels = new Set(job.accepted.map(e => labelKey(e.label))), signatures = new Set(job.accepted.map(e => e.signature)), visual = new Set(job.accepted.map(e => e.visualSignature).filter(Boolean));
      const issues = [];
      for (const entry of answer.icons.slice(0, count)) {
        try {
          const icon = prepareIcon(entry, `icon_${String(job.accepted.length + entries.length + 1).padStart(4, '0')}`, job.id), key = labelKey(entry.label), signature = iconSignature(icon);
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
        await commit(next, before);
        job.accepted.push(...entries); job.documentKey = documentKey(getText()); stalled = 0;
        verifyIconJob(job, getText());
      } else stalled++;
      await save();
      if (stalled >= 3) throw new Error('Tres lotes sin iconos nuevos válidos. Revisa los rechazos antes de reanudar');
    }
    verifyIconJob(job, getText()); job.status = 'complete';
  } catch (e) { job.status = 'paused'; job.reason = e.message || String(e); }
  await save(); return job;
}
