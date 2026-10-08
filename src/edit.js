import { normalizeResource, markResourceCopy } from './resources.js';
// Scene editing operations used by the Studio (and by batch / AI operation lists). Pure functions on a scene:
// they mutate the node tree; the caller serializes with toAru() and recompiles, so ids and paths are rebuilt.
// Every operation takes a LIST of node ids, so single edits and batch edits are the same code path.
import { applyTransform } from './scene.js';
import { PRESETS } from './anim.js';
import { indexedParent, invalidateSceneIndex } from './scene-index.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

export const parentOf = indexedParent;
const nodesOf = (scene, ids) => ids.map((id) => scene.byId.get(id)).filter(Boolean);
export function uniqueName(parent, base) {
  const clean = String(base || 'item').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'item';
  const taken = new Set(parent.children.map((c) => c.name));
  if (!taken.has(clean)) return clean;
  let k = 2; while (taken.has(`${clean}_${k}`)) k++;
  return `${clean}_${k}`;
}
export const displayName = (n) => n.label || n.name;

// ---- properties (one or many) ----
const PATCHABLE = new Set(['label', 'fill', 'stroke', 'strokeWidth', 'opacity', 'at', 'rotate', 'scale', 'hidden', 'locked', 'animate', 'semantic', 'role', 'fillOpacity', 'shadow', 'inner', 'resource']);
export function setProps(scene, ids, patch) {
  const nodes = nodesOf(scene, ids);
  if (patch.resource != null) {
    patch = { ...patch, resource: normalizeResource(patch.resource) };
    if (patch.resource.key && (nodes.length !== 1 || [...scene.byId.values()].some(n => !ids.includes(n.id) && n.resource?.key === patch.resource.key))) throw new Error('La clave del recurso ya existe o se asignaría a varias capas');
  }
  for (const n of nodes) for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) throw new Error(`property '${k}' cannot be edited`);
    if (v === null || v === undefined || v === '') delete n[k];
    else n[k] = clone(v);
    if (k === 'stroke' && n.stroke && n.strokeWidth === undefined) n.strokeWidth = 1;
  }
  return nodes.length;
}
export function translate(scene, ids, dx, dy) {
  for (const n of nodesOf(scene, ids)) n.at = [n.at[0] + dx, n.at[1] + dy];
}

// ---- batch rename: pattern tokens {name} {label} {type} {semantic} {part} {i} {n} {i0} ----
export function renameBatch(scene, ids, pattern, { start = 1 } = {}) {
  const nodes = nodesOf(scene, ids);
  nodes.forEach((n, k) => {
    const part = String(n.semantic || '').split('.').pop();
    n.label = pattern.replace(/\{(name|label|type|semantic|part|i|n|i0)\}/g, (_, t) => ({ name: n.name, label: displayName(n), type: n.type, semantic: n.semantic || '', part, i: String(start + k), n: String(nodes.length), i0: String(k).padStart(2, '0') })[t]);
  });
  return nodes.length;
}

// ---- batch animation with stagger ----
export function animateBatch(scene, ids, { preset, duration = 0.6, delay = 0, stagger = 0, repeat = 'once', ease = 'ease-out' }) {
  const nodes = nodesOf(scene, ids);
  if (preset === 'none') { for (const n of nodes) delete n.animate; return nodes.length; }
  if (!PRESETS[preset]) throw new Error(`unknown animation '${preset}'`);
  nodes.forEach((n, k) => { n.animate = { preset, duration, delay: Math.round((delay + k * stagger) * 1000) / 1000, repeat, ease }; });
  return nodes.length;
}

// ---- structure ----
export function group(scene, ids, label = 'Grupo') {
  const nodes = nodesOf(scene, ids);
  if (!nodes.length) throw new Error('nothing selected');
  const parent = parentOf(scene, nodes[0]);
  if (nodes.some((n) => parentOf(scene, n) !== parent)) throw new Error('to group, select layers that share the same parent');
  const idx = nodes.map((n) => parent.children.indexOf(n)).sort((a, b) => a - b);
  const g = { id: -1, type: 'group', name: uniqueName(parent, label), label, at: [0, 0], rotate: 0, scale: [1, 1], fill: null, stroke: null, strokeWidth: 1, opacity: 1, layer: nodes[0].layer ?? 2, geom: {}, children: [] };
  for (const i of idx) g.children.push(parent.children[i]);
  const keep = parent.children.filter((c) => !nodes.includes(c));
  keep.splice(idx[idx.length - 1] - (idx.length - 1), 0, g); // where the topmost member was
  parent.children = keep;
  invalidateSceneIndex(scene);
  return g;
}
export function ungroup(scene, id) {
  const g = scene.byId.get(id);
  if (!g || g.type !== 'group') throw new Error('select a group to ungroup');
  const parent = parentOf(scene, g), at = parent.children.indexOf(g);
  const uniform = Math.abs(g.scale[0] - g.scale[1]) < 1e-9;
  if (!uniform && g.rotate) throw new Error('cannot ungroup a group with rotation and non-uniform scale');
  for (const c of g.children) {
    // bake the group's transform into each child (exact for translate + rotate + uniform scale)
    c.at = applyTransform(g, c.at[0], c.at[1]);
    c.rotate = (c.rotate || 0) + (g.rotate || 0);
    c.scale = [c.scale[0] * g.scale[0], c.scale[1] * g.scale[1]];
    if (c.fill == null && g.fill != null) c.fill = g.fill;
    if (c.stroke == null && g.stroke != null) { c.stroke = g.stroke; c.strokeWidth = g.strokeWidth; }
    if (g.opacity !== 1) c.opacity = (c.opacity ?? 1) * g.opacity;
    if (!c.semantic && g.semantic) c.semantic = g.semantic;
    c.name = uniqueName({ children: parent.children.filter((x) => x !== g) }, c.name);
  }
  parent.children.splice(at, 1, ...g.children);
  invalidateSceneIndex(scene);
  return g.children;
}
export function duplicate(scene, ids, offset = [16, 16]) {
  const out = [];
  for (const n of nodesOf(scene, ids)) {
    const parent = parentOf(scene, n), copy = clone(n); markResourceCopy(copy);
    copy.name = uniqueName(parent, n.name); copy.label = n.label ? `${n.label} copia` : undefined;
    copy.at = [n.at[0] + offset[0], n.at[1] + offset[1]];
    parent.children.splice(parent.children.indexOf(n) + 1, 0, copy);
    out.push(copy);
  }
  invalidateSceneIndex(scene);
  return out;
}
export function remove(scene, ids) {
  const byParent = new Map();
  for (const n of nodesOf(scene, ids)) {
    const p = parentOf(scene, n); if (!p) continue;
    if (!byParent.has(p)) byParent.set(p, new Set());
    byParent.get(p).add(n);
  }
  for (const [parent, removed] of byParent) parent.children = parent.children.filter(n => !removed.has(n));
  invalidateSceneIndex(scene);
}
// 'up' = drawn above the next sibling, 'top' = above all siblings
export function reorder(scene, ids, dir) {
  const nodes = nodesOf(scene, ids);
  const sorted = dir === 'up' || dir === 'top' ? [...nodes].reverse() : nodes;
  for (const n of sorted) {
    const p = parentOf(scene, n), a = p.children, i = a.indexOf(n);
    a.splice(i, 1);
    const j = dir === 'up' ? Math.min(a.length, i + 1) : dir === 'down' ? Math.max(0, i - 1) : dir === 'top' ? a.length : 0;
    a.splice(j, 0, n);
  }
}
// move nodes into another group (or the root), keeping draw order among them
export function moveInto(scene, ids, targetId, index = null) {
  const target = targetId == null ? scene.root : scene.byId.get(targetId);
  if (!target || (target.type !== 'group' && target !== scene.root)) throw new Error('drop target must be a group');
  const nodes = nodesOf(scene, ids).filter((n) => n !== target && !isAncestor(n, target));
  for (const n of nodes) { const p = parentOf(scene, n); p.children.splice(p.children.indexOf(n), 1); }
  const at = index == null ? target.children.length : Math.min(index, target.children.length);
  target.children.splice(at, 0, ...nodes);
  invalidateSceneIndex(scene);
}
const isAncestor = (a, b) => { let found = false; (function w(n) { for (const c of n.children) { if (c === b) found = true; else w(c); } })(a); return found; };

// ---- align / distribute (world bounds come from the renderer; deltas are converted to each node's parent space) ----
// bounds: Map id -> [x0, y0, x1, y1] in canvas units; scaleOf(id) -> accumulated parent scale [sx, sy]
export function align(scene, ids, mode, bounds, scaleOf = () => [1, 1]) {
  const bs = ids.map((id) => bounds.get(id)).filter(Boolean);
  if (bs.length < 2) return 0;
  const X0 = Math.min(...bs.map((b) => b[0])), X1 = Math.max(...bs.map((b) => b[2])), Y0 = Math.min(...bs.map((b) => b[1])), Y1 = Math.max(...bs.map((b) => b[3]));
  for (const id of ids) {
    const b = bounds.get(id), n = scene.byId.get(id); if (!b || !n) continue;
    let dx = 0, dy = 0;
    if (mode === 'left') dx = X0 - b[0]; else if (mode === 'right') dx = X1 - b[2]; else if (mode === 'center') dx = (X0 + X1) / 2 - (b[0] + b[2]) / 2;
    else if (mode === 'top') dy = Y0 - b[1]; else if (mode === 'bottom') dy = Y1 - b[3]; else if (mode === 'middle') dy = (Y0 + Y1) / 2 - (b[1] + b[3]) / 2;
    const s = scaleOf(id); n.at = [n.at[0] + dx / s[0], n.at[1] + dy / s[1]];
  }
  return ids.length;
}
export function distribute(scene, ids, axis, bounds, scaleOf = () => [1, 1]) {
  const items = ids.map((id) => ({ id, b: bounds.get(id) })).filter((x) => x.b);
  if (items.length < 3) return 0;
  const k = axis === 'x' ? 0 : 1;
  items.sort((a, b) => a.b[k] - b.b[k]);
  const first = items[0].b, last = items[items.length - 1].b;
  const total = items.reduce((s, x) => s + (x.b[k + 2] - x.b[k]), 0);
  const gap = (last[k + 2] - first[k] - total) / (items.length - 1);
  let cur = first[k];
  for (const { id, b } of items) {
    const n = scene.byId.get(id), d = cur - b[k], s = scaleOf(id);
    if (k === 0) n.at = [n.at[0] + d / s[0], n.at[1]]; else n.at = [n.at[0], n.at[1] + d / s[1]];
    cur += b[k + 2] - b[k] + gap;
  }
  return items.length;
}

// ---- new shapes ----
export function addShape(scene, type, { at = [0, 0], size = [100, 60], fill = '#A78BFA', parentId = null, label = null, content = 'Texto' } = {}) {
  const parent = parentId == null ? scene.root : scene.byId.get(parentId);
  const geom = type === 'rect' ? { size, corner: 8 } : type === 'ellipse' ? { size } : type === 'circle' ? { radius: Math.max(size[0], size[1]) / 2 } : type === 'text' ? { content, font: 'Inter, Helvetica Neue, Arial, sans-serif', size: Math.max(14, Math.round(size[1] * 0.6)), weight: 600, anchor: 'middle', spacing: 0, italic: false, baseline: 'central', arc: null, arcSide: 'top' } : type === 'group' ? {} : null;
  if (!geom) throw new Error(`cannot add '${type}'`);
  const n = { id: -1, type, name: uniqueName(parent, label || type), label: label || undefined, at, rotate: 0, scale: [1, 1], fill: type === 'group' ? null : fill, stroke: null, strokeWidth: 1, opacity: 1, layer: 2, geom, children: [] };
  parent.children.push(n);
  invalidateSceneIndex(scene);
  return n;
}

// ---- insert another scene (a traced reference, an ARU fragment written by the AI) as one named group ----
// gradients are copied under prefixed names (no clashes); `keep(node)` can drop nodes (e.g. the plain backdrop)
export function insertFragment(scene, frag, { at = [0, 0], scale = 1, label = 'Importado', keep = null } = {}) {
  const base = uniqueName({ children: [] }, label).toLowerCase();
  const rename = new Map();
  for (const [name, g] of Object.entries(frag.gradients || {})) {
    let k = `${base}_${name}`, j = 2;
    while (scene.gradients[k]) k = `${base}_${name}_${j++}`;
    scene.gradients[k] = clone(g); rename.set(name, k);
  }
  const fix = (n) => {
    if (rename.has(n.fill)) n.fill = rename.get(n.fill);
    if (rename.has(n.stroke)) n.stroke = rename.get(n.stroke);
    if (n.children) { if (keep) n.children = n.children.filter(keep); n.children.forEach(fix); if (keep) n.children = n.children.filter((c) => c.type !== 'group' || c.children.length); }
  };
  let kids = keep ? frag.root.children.filter(keep) : frag.root.children.slice();
  kids.forEach(fix);
  kids = kids.filter((c) => c.type !== 'group' || c.children.length);
  // a fragment that is already ONE group at identity placement goes in as itself (no redundant wrapper)
  if (kids.length === 1 && kids[0].type === 'group' && at[0] === 0 && at[1] === 0 && scale === 1) {
    const g = kids[0];
    g.name = uniqueName(scene.root, g.name); g.label = g.label || label;
    scene.root.children.push(g);
    invalidateSceneIndex(scene);
    return g;
  }
  const g = { id: -1, type: 'group', name: uniqueName(scene.root, label), label, at, rotate: 0, scale: [scale, scale], fill: null, stroke: null, strokeWidth: 1, opacity: 1, layer: 2, geom: {}, children: kids };
  scene.root.children.push(g);
  invalidateSceneIndex(scene);
  return g;
}

// ---- operation lists (batch / AI): [{ op: 'rename' | 'set' | 'animate' | 'group' | ..., ids|target, ... }] ----
export const OPERATIONS = ['set', 'material', 'palette', 'translate', 'rename', 'animate', 'group', 'ungroup', 'duplicate', 'reuse', 'delete', 'reorder', 'add', 'canvas', 'smooth', 'simplify', 'weld', 'connect'];

// Reuse reads a source (even a locked original); only the destination is mutated.
export function reuseResource(scene, source, target = 'root', { x = 0, y = 0, scale = 1, label } = {}) {
  if (!source?.resource || !source.resource.reusable) throw new Error('El origen no es un recurso reutilizable');
  if (![x, y, scale].every(Number.isFinite) || scale <= 0) throw new Error('Posición o escala de reutilización inválida');
  const parent = target === 'root' ? scene.root : scene.byPath.get(target);
  if (!parent || parent.type !== 'group') throw new Error('El destino debe ser un grupo o root');
  for (let n = parent; n && n !== scene.root; n = parentOf(scene, n)) if (n.locked) throw new Error('Destino bloqueado');
  if (source.clip && !source.children.some(n => n.name === source.clip)) throw new Error('El recorte del recurso depende de otra capa; agrúpala con el recurso antes de reutilizarlo');
  const copy = clone(source); markResourceCopy(copy);
  // Inherited paint must travel with a resource detached from its original parent.
  for (const key of ['fill', 'stroke', 'cap', 'join']) if (copy[key] == null) {
    for (let a = parentOf(scene, source); a; a = parentOf(scene, a)) if (a[key] != null) { copy[key] = a[key]; if (key === 'stroke') copy.strokeWidth = a.strokeWidth; break; }
  }
  for (let a = parentOf(scene, source); a; a = parentOf(scene, a)) copy.opacity *= a.opacity ?? 1;
  delete copy.locked; delete copy.hidden;
  const gradients = {};
  function paints(n) { for (const p of [n.fill, n.stroke]) if (scene.gradients[p]) gradients[p] = scene.gradients[p]; for (const c of n.children) paints(c); }
  paints(copy);
  // The insertion helper namespaces just the gradients used by this resource.
  const added = insertFragment(scene, { root: { children: [copy] }, gradients }, { label: label || source.label || source.name });
  scene.root.children.splice(scene.root.children.indexOf(added), 1);
  added.name = uniqueName(parent, source.name); added.label = label || source.label || source.name;
  added.at = [x, y]; added.scale = [source.scale[0] * scale, source.scale[1] * scale]; added.rotate = source.rotate;
  // Non-group shapes receive an insertion wrapper: placement belongs to that wrapper.
  if (copy !== added) { copy.at = [0, 0]; copy.scale = [1, 1]; copy.rotate = 0; added.resource = copy.resource; delete copy.resource; }
  parent.children.push(added); invalidateSceneIndex(scene); return added;
}
