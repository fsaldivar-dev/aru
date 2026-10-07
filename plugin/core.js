import { previewRefinement } from '../src/refinement.js';
import { listMaterials } from '../src/materials.js';
import { freeTranslation } from './layout.js';
import { compile } from '../src/engine.js';
import { toAru } from '../src/serialize.js';
import { previewBatch } from '../src/batch.js';
import { renderScene } from '../src/render.js';
import { applyTransform, localBounds } from '../src/scene.js';
import { selectNodes } from '../src/ops.js';
import { insertFragment, parentOf, uniqueName } from '../src/edit.js';
import { withOpaqueBackground } from '../src/opaque.js';
import { ANSWER_SCHEMA, systemPrompt } from '../src/agents.js';
export const EMPTY_DOCUMENT = 'canvas 800 600\nbackground #FFFFFF\n';
export class AruError extends Error { constructor(message, details = null) { super(message); this.name = 'AruError'; this.details = details; } }
export function readDocument(text) {
  const r = compile(text);
  if (!r.scene || r.errors.length) throw new AruError('Documento ARU inválido', r.errors);
  return r;
}
const union = (a, b) => !a ? b : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
// Conservative bounds include control points, text estimates, strokes and effects. Hosts can inject exact measurement.
export function boundsOf(n) {
  let b;
  if (n.children?.length) { for (const c of n.children) if (!c.hidden) b = union(b, transformedBounds(c, boundsOf(c))); }
  else if (n.type === 'text') {
    const g = n.geom, w = String(g.content || '').length * (g.size || 16) * .65, h = g.size || 16;
    const x = g.anchor === 'middle' ? -w / 2 : g.anchor === 'end' ? -w : 0;
    b = [x, -h, x + w, h * .3];
  } else b = localBounds(n);
  b ||= [0, 0, 0, 0];
  const pad = (n.stroke && n.stroke !== 'none' ? (n.strokeWidth || 1) / 2 : 0) + (n.shadow ? n.shadow.blur * 3 + Math.max(Math.abs(n.shadow.dx), Math.abs(n.shadow.dy)) : 0);
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}
function transformedBounds(n, b) {
  return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(([x, y]) => applyTransform(n, x, y)).reduce((a, [x, y]) => union(a, [x, y, x, y]), null);
}
export function documentContext(text, { name = 'Sin título', selection = [], measureBounds } = {}) {
  const { scene, warnings } = readDocument(text), layers = [];
  function walk(parent, chain = [], locked = false) {
    for (const n of parent.children) {
      let bounds = measureBounds?.(n);
      if (!bounds) { bounds = boundsOf(n); for (const a of [n, ...chain]) bounds = transformedBounds(a, bounds); }
      const cmds = n.geom?.commands || [];
      layers.push({ path: n.path, parent: parent.path || null, type: n.type, label: n.label || n.name,
        semantic: n.semantic || null, role: n.role || null, locked: !!(locked || n.locked), hidden: !!n.hidden,
        fill: n.fill ?? null, opacity: n.opacity, bounds: bounds.map(v => Math.round(v * 100) / 100),
        ...(n.type === 'path' ? { pathInfo: { commands: cmds.length, subpaths: cmds.filter(c => c.cmd === 'move').length, closed: cmds.some(c => c.cmd === 'close'), verbs: [...new Set(cmds.map(c => c.cmd))] } } : {}) });
      walk(n, [n, ...chain], locked || n.locked);
    }
  }
  walk(scene.root);
  return { version: 1, name, canvas: { width: scene.width, height: scene.height, background: scene.background }, selection: selection.filter(p => scene.byPath.has(p)), layers, materials: listMaterials(), warnings, boundsMode: measureBounds ? 'measured' : 'conservative',
    instructions: 'Consulta contexto y render antes de editar. Usa paths o selectores part:, role:, type:, semantic:, name:; selection requiere selección explícita. Usa referencia para ilustrar desde una base. Los grupos conservan capas editables. Simplifica antes de suavizar. No modifiques capas bloqueadas. PNG siempre tiene fondo opaco.', tools: ['apply', 'preview', 'insert', 'trace', 'render', 'ask', 'refine', 'export-icons'], schema: ANSWER_SCHEMA };
}
export function contextPrompt(context) { return `Document context (JSON):\n${JSON.stringify(context)}\nBounds are ${context.boundsMode}; inspect the rendered canvas for visual decisions.`; }
export { ANSWER_SCHEMA, systemPrompt };
export function createIllustrator({ text = EMPTY_DOCUMENT, name = 'Sin título', selection = [], onChange = () => {}, measureBounds } = {}) {
  readDocument(text);
  let current = text, selected = selection.slice(), past = [], future = [], revision = 0;
  const replace = (next, record = true) => {
    readDocument(next);
    if (next !== current) { if (record) { past.push(current); if (past.length > 200) past.shift(); future = []; } current = next; revision++; selected = selected.filter(p => readDocument(current).scene.byPath.has(p)); onChange({ text: current, revision }); }
    return { text: current, revision };
  };
  const api = {
    replacePrepared: next => replace(next),
    getDocument: () => ({ text: current, name, revision }),
    load(next, options = {}) { readDocument(next); name = options.name || name; selected = []; past = []; future = []; return replace(next, false); },
    select(paths) { const scene = readDocument(current).scene; if (!Array.isArray(paths) || paths.some(p => !scene.byPath.has(p))) throw new AruError('Selección inválida'); selected = paths.slice(); return selected; },
    context: () => ({ ...documentContext(current, { name, selection: selected, measureBounds }), revision }),
    preview(operations) {
      if (!Array.isArray(operations)) throw new AruError('operations debe ser un array');
      const sc = readDocument(current).scene;
      for (const op of operations) {
        for (const target of [op?.target, op?.other].filter(Boolean)) {
          const ns = target === 'selection' ? selected.map(p => sc.byPath.get(p)) : sc.byPath.has(target) ? [sc.byPath.get(target)] : selectNodes(sc, target);
          for (const n of ns.filter(Boolean)) { let a = n; while (a && a !== sc.root) { if (a.locked && !(a === n && op.op === 'set' && op.locked === false && Object.keys(op).every(k => ['op', 'target', 'locked'].includes(k)))) throw new AruError(`Capa bloqueada: ${n.path}`); a = parentOf(sc, a); } }
        }
      }
      const r = previewBatch(current, operations, selected);
      if (r.log.some(l => !l.ok)) throw new AruError('Lote rechazado; no se aplicó ningún cambio', r.log);
      return { text: r.text, log: r.log, svg: renderScene(r.scene, { dataAttrs: false, animate: false }) };
    },
    apply(operations, { expectedRevision } = {}) { if (expectedRevision != null && expectedRevision !== revision) throw new AruError('El documento cambió; vuelve a consultar el contexto'); const r = api.preview(operations); return { ...replace(r.text), log: r.log }; },
    previewRefinement(operations, options = {}) { const r = previewRefinement(current, operations, { selection: selected, ...options }); return { ...r, svg: renderScene(readDocument(r.text).scene, { dataAttrs: false, animate: false }) }; },
    refine(operations, options = {}) { if (options.expectedRevision != null && options.expectedRevision !== revision) throw new AruError('El documento cambió; vuelve a consultar el contexto'); const r = api.previewRefinement(operations, options); return { ...r, ...replace(r.text) }; },
    insert(fragment, { label = 'Ilustración', at, scale = 1, opaque = true, fit = true, into = null } = {}) {
      const scene = readDocument(current).scene, fr = readDocument(`canvas ${scene.width} ${scene.height}\nbackground none\n${fragment}`).scene;
      if (!fr.root.children.length) throw new AruError('El fragmento está vacío');
      if (into) { insertInto(scene, fr, into, label); return replace(toAru(scene)); }
      return api.insertScene(opaque ? withOpaqueBackground(fr, { color: scene.background, bounds: boundsOf(fr.root) }) : fr, { label, at, scale, fit });
    },
    insertScene(fragment, { label = 'Referencia', at, scale = 1, fit = true } = {}) {
      if (!Number.isFinite(scale) || scale <= 0 || (at && (at.length !== 2 || !at.every(Number.isFinite)))) throw new AruError('Posición/escala inválida');
      const scene = readDocument(current).scene;
      at ||= [0, 0];
      const added = insertFragment(scene, fragment, { label, at, scale });
      if (fit) { const box = transformedBounds(added, boundsOf(added)), others = scene.root.children.filter(n => n !== added && !n.hidden).map(n => transformedBounds(n, boundsOf(n))); const [mx, my] = freeTranslation(box, others, scene); added.at = [added.at[0] + mx, added.at[1] + my]; const b = boundsOf(scene.root); const dx = b[0] < 0 ? Math.round(40 - b[0]) : 0, dy = b[1] < 0 ? Math.round(40 - b[1]) : 0; for (const n of scene.root.children) n.at = [n.at[0] + dx, n.at[1] + dy]; scene.width = Math.ceil(Math.max(scene.width, b[2] + dx + 40)); scene.height = Math.ceil(Math.max(scene.height, b[3] + dy + 40)); }
      const result = replace(toAru(scene));
      selected = readDocument(current).scene.root.children.filter(n => n.name === added.name).map(n => n.path);
      return { ...result, selection: selected };
    },
    svg: ({ animate = false } = {}) => renderScene(readDocument(current).scene, { dataAttrs: false, animate }),
    undo() { if (!past.length) return false; future.push(current); replace(past.pop(), false); return true; },
    redo() { if (!future.length) return false; past.push(current); replace(future.pop(), false); return true; },
  };
  return api;
}

// Canvas-space additions into a transformed group. Uniform scales and rotations compose without skew.
export function insertInto(scene, fragment, path, label = 'Capa IA') {
  const target = scene.byPath.get(path); if (!target || target.type !== 'group') throw new AruError(`No existe el grupo: ${path}`);
  const chain = []; for (let n = target; n && n !== scene.root; n = parentOf(scene, n)) { if (n.locked) throw new AruError('Grupo bloqueado'); chain.unshift(n); }
  let tx = 0, ty = 0, scale = 1, rotation = 0;
  for (const n of chain) {
    if (Math.abs(n.scale[0] - n.scale[1]) > 1e-8 || Math.abs(n.scale[0]) < 1e-8) throw new AruError('La inserción en coordenadas de lienzo necesita escala uniforme no nula');
    const angle = rotation * Math.PI / 180, [x, y] = n.at;
    tx += scale * (x * Math.cos(angle) - y * Math.sin(angle)); ty += scale * (x * Math.sin(angle) + y * Math.cos(angle));
    scale *= n.scale[0]; rotation += n.rotate || 0;
  }
  const wrapper = { ...scene.root, name: 'adicion', label, children: fragment.root.children };
  const added = insertFragment(scene, { ...fragment, root: { ...fragment.root, children: [wrapper] } }, { label });
  scene.root.children.splice(scene.root.children.indexOf(added), 1);
  const angle = -rotation * Math.PI / 180;
  added.name = uniqueName(target, label); added.label = label; added.at = [(-tx * Math.cos(angle) + ty * Math.sin(angle)) / scale, (-tx * Math.sin(angle) - ty * Math.cos(angle)) / scale]; added.scale = [1 / scale, 1 / scale]; added.rotate = -rotation;
  target.children.push(added); return added;
}
