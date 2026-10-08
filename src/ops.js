// Operations on the scene graph (the future LLM -> scene graph interface).
// An operation never requires re-generating the document: it mutates the scene and we re-render.
//
//   { "operation": "set",       "target": "cat.tail",          "property": "scale",   "value": 1.2 }
//   { "operation": "set",       "target": "cat.leftEye",       "property": "fill",    "value": "green" }
//   { "operation": "scale",     "target": "semantic:plant.tree", "value": 0.8 }       (multiplies current scale)
//   { "operation": "translate", "target": "cat",               "value": [10, -5] }
//   { "operation": "delete",    "target": "forest.tree[2]" }
//
// Targets: a path ("cat.tail"), a query ("semantic:plant.tree role:background", AND of conditions;
//          semantic is prefix-matched, role is inherited from ancestors, also type:<t> name:<n>), or "*".

import { invalidateSceneIndex } from './scene-index.js';
import { walkScene, nodeLocalBounds, updateBlueprint } from './scene.js';

export function selectNodes(scene, target) {
  target = String(target).trim();
  if (target === '*') { const all = []; walkScene(scene.root, (n) => { if (n !== scene.root) all.push(n); }); return all; }
  if (!/^(semantic|role|type|name|part|tag|brand|kind|resource):/.test(target)) { const n = scene.byPath.get(target); return n ? [n] : []; }
  // query: space-separated conditions, all must match. semantic is prefix-matched (plant matches plant.tree.pine);
  // role is inherited from the nearest ancestor that declares one (a pine inside a background forest is background).
  const conds = target.split(/\s+/).map((c) => { const i = c.indexOf(':'); return [c.slice(0, i), c.slice(i + 1)]; });
  const res = [];
  const visit = (n, inheritedRole) => {
    const role = n.role || inheritedRole;
    if (n !== scene.root && conds.every(([k, v]) =>
      k === 'tag' ? !!n.resource?.tags.includes(v.toLocaleLowerCase()) :
      k === 'brand' ? n.resource?.brand?.toLocaleLowerCase() === v.toLocaleLowerCase() :
      k === 'kind' ? n.resource?.kind === v :
      k === 'resource' ? n.resource?.key === v :
      k === 'semantic' ? !!n.semantic && (n.semantic === v || n.semantic.startsWith(v + '.')) :
      k === 'role' ? role === v :
      k === 'type' ? n.type === v :
      k === 'name' ? n.name === v || n.name.startsWith(v + '[') :
      // part:<type or id> matches traced regions by the context node they were assigned to (e.g. part:iris)
      k === 'part' ? n.type !== 'group' && (n.meta?.partType === v || String(n.meta?.semantic || n.semantic || '').split('.').pop() === v) : false)) res.push(n); // works on parsed ARU text too (semantic is serialized, meta is not)
    for (const c of n.children) visit(c, role);
  };
  visit(scene.root, null);
  return res;
}

const NUMERIC_PAIR = new Set(['at', 'scale', 'size', 'from', 'to']);

export function applyOperation(scene, op) {
  const sem = semanticOperation(scene, op);
  if (sem) return sem;
  const nodes = selectNodes(scene, op.target);
  if (!nodes.length) return { ok: false, message: `No object matches '${op.target}'` };
  for (const n of nodes) {
    switch (op.operation) {
      case 'set': setProperty(n, op.property, op.value); break;
      case 'scale': { const f = Array.isArray(op.value) ? op.value : [op.value, op.value]; scaleAroundCenter(n, [n.scale[0] * f[0], n.scale[1] * f[1]], op.pivot); break; }
      case 'translate': n.at = [n.at[0] + (op.value[0] || 0), n.at[1] + (op.value[1] || 0)]; break;
      case 'rotate': n.rotate += Number(op.value) || 0; break;
      case 'delete': removeNode(scene, n); break;
      // { operation: 'adjust', target, property: 'lightness', value: 0.2 } -> lighter (+) / darker (−) fills, gradients too
      case 'adjust': adjustLightness(scene, n, Number(op.value) || 0); break;
      default: return { ok: false, message: `Unknown operation '${op.operation}'` };
    }
  }
  return { ok: true, message: `${op.operation} applied to ${nodes.length} object(s)` };
}

function setProperty(n, prop, value) {
  if (NUMERIC_PAIR.has(prop)) {
    const pair = Array.isArray(value) ? value : [value, value];
    if (prop === 'size') n.geom.size = pair; else if (prop === 'from' || prop === 'to') n.geom[prop] = pair;
    else if (prop === 'scale') scaleAroundCenter(n, pair);
    else n[prop] = pair;
    return;
  }
  if (prop === 'radius' || prop === 'corner' || prop === 'points' || prop === 'commands') { n.geom[prop] = value; return; }
  if (prop === 'x') { n.at = [Number(value), n.at[1]]; return; }
  if (prop === 'y') { n.at = [n.at[0], Number(value)]; return; }
  n[prop] = value;
}

function removeNode(scene, node) {
  walkScene(scene.root, (p) => { const i = p.children.indexOf(node); if (i >= 0) p.children.splice(i, 1); });
  walkScene(node, (c) => { scene.byPath.delete(c.path); scene.byId.delete(c.id); });
  invalidateSceneIndex(scene);
}

// Shapes are authored in their parent's coordinate space, so a naive scale would pivot on the parent origin
// (cat.tail would fly away). Default pivot = center of the object's own bounds; pivot "origin" keeps the raw behaviour.
function scaleAroundCenter(n, newScale, pivot = 'center') {
  if (pivot === 'origin') { n.scale = newScale; return; }
  const b = nodeLocalBounds(n);
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const r = n.rotate * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const map = (sc) => { const x = cx * sc[0], y = cy * sc[1]; return [x * c - y * s, x * s + y * c]; };
  const before = map(n.scale), after = map(newScale);
  n.at = [n.at[0] + before[0] - after[0], n.at[1] + before[1] - after[1]];
  n.scale = newScale;
}

// ---------- semantic operations (blueprints) ----------
// { "operation": "move", "target": "wolf.eyeL", "value": [0.03, 0] }        landmark, normalized units
// { "operation": "set",  "target": "wolf.eyeL", "property": "x", "value": 0.39 }
// { "operation": "set",  "target": "wolf.palette.eye", "value": "#4AA3FF" }
// { "operation": "set",  "target": "wolf.light", "value": "top-right" }
// Only the elements that depend on the changed concept are recompiled.
function semanticOperation(scene, op) {
  const parts = String(op.target || '').split('.');
  const rt = scene.blueprints?.get(parts[0]);
  if (!rt || parts.length < 2) return null;
  const bp = rt.bp;
  let rest = parts.slice(1);
  if (rest[0] === 'landmarks') rest = rest.slice(1);
  let change;
  if (rest[0] === 'palette' && rest[1]) change = { palette: { name: rest[1], value: String(op.value) } };
  else if (rest[0] === 'light' && rest.length === 1) change = { light: op.value };
  else if (bp.landmarkDefs.has(rest[0])) {
    const prop = op.property || rest[1];
    if (op.operation !== 'move' && !['x', 'y', 'position'].includes(prop) && !Array.isArray(op.value)) return null;
    const cur = bp.landmark(rest[0]);
    let v;
    if (op.operation === 'move') v = [cur[0] + (op.value?.[0] || 0), cur[1] + (op.value?.[1] || 0)];
    else if (prop === 'x') v = [Number(op.value), cur[1]];
    else if (prop === 'y') v = [cur[0], Number(op.value)];
    else v = op.value;
    change = { landmark: { name: rest[0], value: v.map((x) => Math.round(x * 10000) / 10000) } };
  } else return null;
  try {
    const res = updateBlueprint(scene, parts[0], change);
    return { ok: true, ...res, message: `${op.operation} ${op.target}: recompiled ${res.recompiled.length}/${res.total} elements in ${res.ms.toFixed(1)} ms → ${res.recompiled.join(', ') || 'none'}` };
  } catch (e) { return { ok: false, message: e.message }; }
}

function adjustLightness(scene, n, amt) {
  if (n.type === 'group') return;
  const shift = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex;
    const v = parseInt(m[1], 16), c = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    const t = amt >= 0 ? c.map((x) => x + (255 - x) * amt) : c.map((x) => x * (1 + amt));
    return '#' + t.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  const g = scene.gradients[n.fill];
  if (g) { const name = `${n.fill}_adj${n.id}`; scene.gradients[name] = { ...g, stops: g.stops.map((s) => ({ ...s, color: shift(s.color) })) }; n.fill = name; if (n.stroke && scene.gradients[n.stroke]) n.stroke = name; return; }
  n.fill = shift(n.fill);
  if (n.stroke && n.stroke !== 'none' && !scene.gradients[n.stroke]) n.stroke = shift(n.stroke);
}
