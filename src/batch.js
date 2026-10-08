// Batch operations: a JSON list (typed by a person or returned by an AI) applied in one step.
//   [{ "op": "rename",  "target": "part:iris", "pattern": "Iris {i}" },
//    { "op": "set",     "target": "part:iris role:primary", "fill": "#3A7BFF" },
//    { "op": "animate", "target": "type:circle", "preset": "pop", "duration": 0.5, "stagger": 0.08 },
//    { "op": "group",   "target": "selection", "label": "Botones" }]
// Targets: "selection", a layer path, or a selector understood by selectNodes (part:, role:, type:, semantic:, name:, *).
// Operations never carry geometry: the vocabulary is the same closed set the Studio uses.
import { selectNodes } from './ops.js';
import * as E from './edit.js';
import { refinePaths, joinPaths } from './path-edit.js';
import { compile } from './engine.js';
import { toAru } from './serialize.js';
import { applyMaterial, applyPalette } from './materials.js';

const SET_KEYS = ['label', 'fill', 'stroke', 'strokeWidth', 'opacity', 'hidden', 'locked', 'rotate', 'semantic', 'role', 'shadow', 'inner', 'resource'];
// effects as text: "DX DY BLUR #COLOR OPACITY" ("none" clears); inner accepts two separated by "|"
const parseFx = (t) => { const m = String(t).trim().match(/^(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s+(#[0-9a-f]{3,8})\s+([\d.]+)$/i); return m ? { dx: +m[1], dy: +m[2], blur: +m[3], color: m[4], opacity: Math.max(0, Math.min(1, +m[5])) } : null; };
const val = (o, k) => (o[k] === null || o[k] === undefined ? undefined : o[k]);

function resolve(scene, target, selection) {
  if (target === 'selection') return selection.slice();
  if (scene.byPath.has(target)) return [scene.byPath.get(target).id];
  const hits = selectNodes(scene, target).map((n) => n.id);
  if (hits.length) return hits;
  // forgiving: "part:card.dot" / "name:card.dot" written for a layer path
  const m = /^(part|name|semantic):(.+)$/.exec(String(target).trim());
  if (m && scene.byPath.has(m[2])) return [scene.byPath.get(m[2]).id];
  return [];
}

export function applyBatch(scene, ops, { selection = [] } = {}) {
  const log = [], created = [];
  ops.forEach((o, k) => {
    const where = `#${k + 1} ${o?.op ?? '?'}`;
    try {
      if (!o || typeof o !== 'object' || !o.op) throw new Error('each operation needs an "op"');
      const free = o.op === 'canvas' || (['add', 'reuse'].includes(o.op) && (!o.target || o.target === 'root'));
      const ids = free ? [] : resolve(scene, o.target ?? 'selection', selection);
      if (!ids.length && !free) throw new Error(`no layer matches '${o.target}'`);
      let detail = null;
      switch (o.op) {
        case 'reuse': {
          const sources = resolve(scene, o.other, selection);
          if (sources.length !== 1) throw new Error('Reutilizar requiere un único recurso de origen');
          if (!free && ids.length !== 1) throw new Error('Reutilizar requiere un único destino');
          created.push(E.reuseResource(scene, scene.byId.get(sources[0]), free ? 'root' : scene.byId.get(ids[0]).path, { x: o.x ?? 0, y: o.y ?? 0, scale: o.scale ?? 1, label: o.label })); break;
        }
        case 'palette': detail = applyPalette(scene, ids, o); break;
        case 'material': detail = applyMaterial(scene, ids, o); break;
        case 'smooth': case 'simplify': detail = refinePaths(scene, ids, o.op, o); break;
        case 'weld': case 'connect': detail = joinPaths(scene, ids, resolve(scene, o.other, selection), o.op, o); break;
        case 'rename': E.renameBatch(scene, ids, String(o.pattern ?? o.label ?? '{name}')); break;
        case 'set': {
          const patch = {};
          for (const key of SET_KEYS) if (val(o, key) !== undefined) patch[key] = o[key] === false ? null : o[key];
          if (typeof patch.shadow === 'string') patch.shadow = patch.shadow === 'none' ? null : (parseFx(patch.shadow) ?? (() => { throw new Error('shadow: "DX DY BLUR #COLOR OPACITY"'); })());
          if (typeof patch.inner === 'string') patch.inner = patch.inner === 'none' ? null : patch.inner.split('|').map((x) => parseFx(x) ?? (() => { throw new Error('inner: "DX DY BLUR #COLOR OPACITY" (two with |)'); })()).slice(0, 2);
          if (!Object.keys(patch).length) throw new Error(`nothing to set (use ${SET_KEYS.join(', ')})`);
          E.setProps(scene, ids, patch); break;
        }
        case 'animate': E.animateBatch(scene, ids, { preset: o.preset, duration: o.duration ?? 0.6, delay: o.delay ?? 0, stagger: o.stagger ?? 0, repeat: o.repeat ?? 'once', ease: o.ease ?? 'ease-out' }); break;
        case 'translate': E.translate(scene, ids, Number(o.dx) || 0, Number(o.dy) || 0); break;
        case 'group': created.push(E.group(scene, ids, o.label || 'Grupo')); break;
        case 'ungroup': for (const id of ids) created.push(...E.ungroup(scene, id)); break;
        case 'duplicate': created.push(...E.duplicate(scene, ids, o.offset || [16, 16])); break;
        case 'delete': E.remove(scene, ids); break;
        case 'reorder': E.reorder(scene, ids, o.dir || 'top'); break;
        case 'canvas': {
          const w = Math.round(Number(o.w)), h = Math.round(Number(o.h));
          if (!(w >= 16 && w <= 20000 && h >= 16 && h <= 20000)) throw new Error('canvas needs w and h between 16 and 20000');
          scene.width = w; scene.height = h; break;
        }
        case 'add': {
          const parent = ids.length === 1 && scene.byId.get(ids[0])?.type === 'group' ? ids[0] : null;
          const shape = o.shape || 'rect';
          created.push(E.addShape(scene, shape, { at: [Number(o.x) || scene.width / 2, Number(o.y) || scene.height / 2], size: [Number(o.w) || 160, Number(o.h) || 60], fill: val(o, 'fill') ?? (shape === 'text' ? '#ECECF1' : '#A78BFA'), parentId: parent, label: val(o, 'label') ?? null, content: val(o, 'text') ?? 'Texto' }));
          break;
        }
        default: throw new Error(`unknown op '${o.op}' (${E.OPERATIONS.join(', ')})`);
      }
      log.push({ ok: true, message: `${where}: ${detail ?? `${ids.length} capa(s)`}` });
    } catch (e) { log.push({ ok: false, message: `${where}: ${e.message}` }); }
  });
  return { log, created };
}

// Preview owns a fresh scene, so canceling cannot change the document or its history.
export function previewBatch(text, ops, selection = [], serializeOptions = {}) {
  const base = compile(text);
  if (!base.scene || base.errors.length) throw new Error('Corrige el documento antes de previsualizar');
  const result = applyBatch(base.scene, ops, { selection: selection.map((p) => base.scene.byPath.get(p)?.id).filter((id) => id !== undefined) });
  const nextText = toAru(base.scene, serializeOptions), next = compile(nextText);
  if (!next.scene || next.errors.length) throw new Error('El lote produciría un documento inválido');
  return { ...result, text: nextText, scene: next.scene };
}

export const BATCH_EXAMPLE = JSON.stringify([
  { op: 'rename', target: 'type:circle', pattern: 'Punto {i}' },
  { op: 'animate', target: 'type:circle', preset: 'pop', duration: 0.5, delay: 0.1, stagger: 0.06 },
  { op: 'animate', target: 'type:text', preset: 'slide-up', duration: 0.6, delay: 0.4 },
  { op: 'set', target: 'selection', opacity: 0.9 },
], null, 2);
