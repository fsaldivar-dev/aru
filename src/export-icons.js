// Shared by the browser, embedded editor and CLI. Export never edits the source document.
import { readDocument, boundsOf } from '../plugin/core.js';
import { parentOf } from './edit.js';
import { toAru } from './serialize.js';
import { renderScene } from './render.js';
import { opaqueColor } from './opaque.js';
const walk = (n, fn) => { fn(n); for (const c of n.children || []) walk(c, fn); };
const slug = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'icono';
export function listIconBatches(text) {
  const { scene } = readDocument(text), result = [];
  walk(scene.root, n => {
    const icons = n.children?.filter(c => c.type === 'group' && !c.hidden) || [];
    if (n !== scene.root && n.type === 'group' && !n.hidden && (icons.length >= 2 || icons.length === 1 && n.semantic === 'ui.iconpack')) result.push({ path: n.path, label: n.label || n.name, count: icons.length, explicit: n.semantic === 'ui.iconpack' || n.name === 'pack' });
  });
  return result;
}
export function prepareIconExports(text, { group, paths, sizes = [24, 48, 96], formats = ['png', 'svg', 'aru'], cellSize = 24, padding = 2, background } = {}) {
  const { scene } = readDocument(text);
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > 8 || sizes.some(s => !Number.isInteger(s) || s < 16 || s > 2048)) throw new Error('Tamaños: entre 16 y 2048 px, máximo 8');
  if (!Array.isArray(formats) || !formats.length || formats.some(f => !['png', 'svg', 'aru'].includes(f))) throw new Error('Formatos: png, svg, aru');
  if (!(Number.isFinite(padding) && padding >= 0 && padding <= 100) || !(cellSize === null || Number.isFinite(cellSize) && cellSize >= 1 && cellSize <= 20000)) throw new Error('Celda o margen inválidos');
  if (background != null && !/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(background)) throw new Error('Fondo hexadecimal opaco');
  let batch = group && scene.byPath.get(group);
  if (!group && !paths) { const explicit = listIconBatches(text).filter(b => b.explicit); if (explicit.length !== 1) throw new Error('Elige un grupo de iconos con --group'); batch = scene.byPath.get(explicit[0].path); }
  if (group && (!batch || batch.type !== 'group')) throw new Error('No existe el grupo de iconos');
  if (paths && (!Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length)) throw new Error('Selecciona al menos un icono, sin duplicados');
  const icons = paths ? paths.map(p => scene.byPath.get(p)) : batch.children.filter(c => c.type === 'group' && !c.hidden);
  if (!icons.length || icons.length > 1000 || icons.some(n => !n || n.type !== 'group' || (batch && !batch.children.includes(n)))) throw new Error('El lote debe contener entre 1 y 1000 grupos de iconos');
  for (const n of icons) for (let a = n; a && a !== scene.root; a = parentOf(scene, a)) if (a.hidden) throw new Error(`Icono oculto: ${n.path}`);
  const used = new Set(), color = background || opaqueColor(scene.background);
  const entries = icons.map(icon => {
    // Keep inherited paint/effects, discard the placement of the pack on the editor artboard.
    let tree = structuredClone(icon); tree.at = [0, 0];
    for (let a = parentOf(scene, icon); a && a !== scene.root; a = parentOf(scene, a)) {
      const siblingClip = tree.clip && !tree.children.some(c => c.name === tree.clip);
      if (siblingClip || (a.clip && !a.children.some(c => c.name === a.clip && c === parentOf(scene, icon)))) throw new Error(`Recorte externo en ${icon.path}; coloca el recorte dentro del icono antes de exportar`);
      tree = { ...structuredClone(a), at: [0, 0], rotate: 0, scale: [1, 1], children: [tree], animate: null };
    }
    if (tree.clip && !tree.children.some(c => c.name === tree.clip)) throw new Error(`Recorte externo en ${icon.path}`);
    const root = { ...scene.root, children: [tree] }, b = boundsOf(root);
    let base = slug(icon.label || icon.name), name = base, i = 2; while (used.has(name.toLowerCase())) name = `${base}-${i++}`; used.add(name.toLowerCase());
    return { path: icon.path, label: icon.label || icon.name, name, bounds: b, tree };
  });
  if (entries.length * [...new Set(sizes)].reduce((sum, size) => sum + size * size, 0) > 64000000 && formats.includes('png')) throw new Error('El lote es demasiado grande; reduce tamaños o exporta menos iconos');
  const extent = cellSize ?? Math.max(...entries.map(e => Math.max(e.bounds[2] - e.bounds[0], e.bounds[3] - e.bounds[1]) + padding * 2), 1);
  return { version: 1, group: batch?.path || null, background: color, sizes: [...new Set(sizes)], formats: [...new Set(formats)], cellSize, extent, entries: entries.map(e => {
    const b = e.bounds, at = cellSize != null ? [0, 0] : [extent / 2 - (b[0] + b[2]) / 2, extent / 2 - (b[1] + b[3]) / 2];
    const wrapper = { ...scene.root, name: 'Exportacion', at, children: [e.tree] };
    const isolated = { ...scene, width: extent, height: extent, background: color, root: { ...scene.root, children: [wrapper] } };
    const usedPaint = new Set(); walk(wrapper, n => { usedPaint.add(n.fill); usedPaint.add(n.stroke); }); isolated.gradients = Object.fromEntries(Object.entries(scene.gradients).filter(([name]) => usedPaint.has(name)));
    const aru = toAru(isolated, { precision: null }), compiled = readDocument(aru).scene;
    return { path: e.path, label: e.label, name: e.name, bounds: b, warnings: cellSize != null && (b[0] < 0 || b[1] < 0 || b[2] > extent || b[3] > extent) ? ['El contenido excede la celda; usa ajustar al contenido o una celda mayor'] : [], aru, svg: renderScene(compiled, { dataAttrs: false, animate: false }), scene: compiled };
  }) };
}
export async function buildIconArchive(text, options = {}, png) {
  const plan = prepareIconExports(text, options), files = [], manifest = { ...plan, entries: [] };
  if (plan.formats.includes('png') && typeof png !== 'function') throw new Error('Se necesita un renderizador PNG');
  for (const e of plan.entries) {
    const names = [];
    for (const format of plan.formats) {
      if (format === 'png') for (const size of plan.sizes) { const name = `png/${size}/${e.name}.png`; files.push({ name, data: await png(e.scene, size) }); names.push(name); }
      else { const name = `${format}/${e.name}.${format}`; files.push({ name, data: e[format] }); names.push(name); }
    }
    const { scene, svg, aru, ...metadata } = e; manifest.entries.push({ ...metadata, files: names });
  }
  files.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
  return { data: zipStore(files), manifest, fileCount: files.length };
}
// Standard ZIP (stored entries, CRC32, UTF-8 names). No dependency or platform-specific compressor.
export function zipStore(files) {
  const encoder = new TextEncoder(), parts = [], central = [], seen = new Set(); let offset = 0;
  const crc = data => { let c = 0xffffffff; for (const v of data) { c ^= v; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const header = size => { const bytes = new Uint8Array(size); return [bytes, new DataView(bytes.buffer)]; };
  if (files.length > 65535) throw new Error('Demasiados archivos para ZIP');
  for (const file of files) {
    if (!file.name || file.name.startsWith('/') || file.name.includes('\\') || file.name.split('/').some(p => p === '..' || p === '.') || seen.has(file.name)) throw new Error('Nombre ZIP inválido o duplicado'); seen.add(file.name);
    const name = encoder.encode(file.name), data = typeof file.data === 'string' ? encoder.encode(file.data) : new Uint8Array(file.data), checksum = crc(data);
    if (name.length > 65535 || data.length > 0xffffffff || offset + data.length > 0xffffffff) throw new Error('Archivo demasiado grande para ZIP');
    const [h, v] = header(30); v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true); v.setUint16(12, 33, true); v.setUint32(14, checksum, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, name.length, true);
    parts.push(h, name, data);
    const [c, cv] = header(46); cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true); cv.setUint16(14, 33, true); cv.setUint32(16, checksum, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.push(c, name); offset += h.length + name.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0), [end, ev] = header(22); ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end], result = new Uint8Array(offset + centralSize + end.length); let pos = 0; for (const p of all) { result.set(p, pos); pos += p.length; } return result;
}
