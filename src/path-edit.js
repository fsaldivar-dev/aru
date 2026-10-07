// Intent-level path editing. The caller owns history/persistence; all validation happens before mutation.
// Distances are in canvas units, even inside rotated/non-uniformly scaled groups.
import { applyTransform } from './scene.js';
import { douglasPeucker } from '../trace/simplify.js';
import { lerp2, sub, add, mul, norm, len } from './geom.js';

const command = (cmd, args = []) => ({ cmd, args: [...args] });
const EPS = 1e-9;
const samePoint = (a, b) => len(sub(a, b)) < EPS;
function number(value, fallback, min, max, name) {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`${name}: usa un número entre ${min} y ${max}`);
  return n;
}
function index(scene) {
  const parents = new Map();
  const walk = (n) => { for (const c of n.children) { parents.set(c, n); walk(c); } };
  walk(scene.root);
  const chain = (n) => { const out = []; while (n) { out.push(n); n = parents.get(n); } return out; };
  const world = (n, p) => chain(n).reduce((v, a) => applyTransform(a, ...v), p);
  const matrix = (n) => {
    const o = world(n, [0, 0]), x = sub(world(n, [1, 0]), o), y = sub(world(n, [0, 1]), o);
    const det = x[0] * y[1] - y[0] * x[1];
    if (Math.abs(det) < EPS) throw new Error(`${n.path}: transformación no invertible`);
    const trace = len(x) ** 2 + len(y) ** 2;
    const scale = Math.sqrt((trace + Math.sqrt(Math.max(0, trace * trace - 4 * det * det))) / 2);
    const local = (p) => { const v = sub(p, o); return [(v[0] * y[1] - v[1] * y[0]) / det, (x[0] * v[1] - x[1] * v[0]) / det]; };
    return { world: (p) => world(n, p), local, scale };
  };
  const unlocked = (n) => { if (chain(n).some((a) => a.locked)) throw new Error(`${n.path}: capa bloqueada`); };
  return { parents, matrix, unlocked };
}

// Normalize supported commands into subpaths; keep closures and holes separate. No implicit arc conversion.
function read(node) {
  if (node.type !== 'path') throw new Error(`${node.path}: selecciona un path o un grupo con paths`);
  const paths = []; let p = null, cursor = null;
  for (const c of node.geom.commands) {
    const count = { move: 2, line: 2, curve: 6, quad: 4, close: 0 }[c.cmd];
    if (count === undefined) throw new Error(`${node.path}: ${c.cmd} todavía no admite edición de trazos`);
    if (c.args.length !== count || !c.args.every(Number.isFinite)) throw new Error(`${node.path}: comando ${c.cmd} inválido`);
    const a = c.args;
    if (c.cmd === 'move') { p = { start: [...a], segments: [], closed: false }; paths.push(p); cursor = [...a]; continue; }
    if (!p || p.closed) throw new Error(`${node.path}: cada subtrazo debe comenzar con move`);
    if (c.cmd === 'close') {
      if (!samePoint(cursor, p.start)) p.segments.push({ p0: cursor, p1: [...p.start], kind: 'line' });
      p.closed = true; cursor = p.start; continue;
    }
    const s = { p0: cursor, p1: a.slice(-2), kind: c.cmd };
    if (c.cmd === 'curve') { s.c1 = a.slice(0, 2); s.c2 = a.slice(2, 4); }
    if (c.cmd === 'quad') { s.c1 = lerp2(cursor, a.slice(0, 2), 2 / 3); s.c2 = lerp2(s.p1, a.slice(0, 2), 2 / 3); s.quad = a.slice(0, 2); }
    p.segments.push(s); cursor = s.p1;
  }
  if (!paths.length || paths.some((x) => !x.segments.length)) throw new Error(`${node.path}: trazo vacío`);
  return paths;
}
function write(paths) {
  const out = [];
  for (const p of paths) {
    out.push(command('move', p.start));
    for (const s of p.segments) {
      if (s.kind === 'line') out.push(command('line', s.p1));
      else if (s.kind === 'quad') out.push(command('quad', [...s.quad, ...s.p1]));
      else out.push(command('curve', [...s.c1, ...s.c2, ...s.p1]));
    }
    if (p.closed) out.push(command('close'));
  }
  return out;
}
const turn = (a, b) => !len(a) || !len(b) ? 180 : Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (len(a) * len(b))))) * 180 / Math.PI;
const incoming = (s) => sub(s.p1, s.c2 ?? s.p0);
const outgoing = (s) => sub(s.c1 ?? s.p1, s.p0);
const bounded = (old, next, strength, tolerance) => {
  const delta = mul(sub(next, old), strength), distance = len(delta);
  return add(old, mul(delta, distance > tolerance ? tolerance / distance : 1));
};

function smooth(paths, { strength, tolerance, cornerAngle }) {
  for (const p of paths) {
    const segs = p.segments;
    // Read the original tangents before changing either side of a join.
    const joins = segs.map((s, i) => {
      const next = segs[(i + 1) % segs.length];
      return turn(incoming(s), outgoing(next)) < cornerAngle ? norm(add(norm(incoming(s)), norm(outgoing(next)))) : null;
    });
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      s.c1 ??= lerp2(s.p0, s.p1, 1 / 3); s.c2 ??= lerp2(s.p0, s.p1, 2 / 3);
      const before = i > 0 || p.closed ? joins[(i - 1 + segs.length) % segs.length] : null;
      const after = i + 1 < segs.length || p.closed ? joins[i] : null;
      if (before) s.c1 = bounded(s.c1, add(s.p0, mul(before, len(sub(s.c1, s.p0)))), strength, tolerance);
      if (after) s.c2 = bounded(s.c2, sub(s.p1, mul(after, len(sub(s.p1, s.c2)))), strength, tolerance);
      s.kind = 'curve';
    }
  }
}
function simplify(paths, { tolerance, cornerAngle }) {
  let removed = 0;
  for (const p of paths) {
    const out = [], segs = p.segments;
    for (let start = 0; start < segs.length;) {
      if (segs[start].kind !== 'line') { out.push(segs[start++]); continue; }
      let end = start; while (end < segs.length && segs[end].kind === 'line') end++;
      const pts = [segs[start].p0, ...segs.slice(start, end).map((s) => s.p1)];
      const anchors = [0];
      for (let k = 1; k + 1 < pts.length; k++) if (turn(sub(pts[k], pts[k - 1]), sub(pts[k + 1], pts[k])) >= cornerAngle) anchors.push(k);
      anchors.push(pts.length - 1);
      const keep = new Set();
      for (let k = 1; k < anchors.length; k++) for (const i of douglasPeucker(pts, tolerance, anchors[k - 1], anchors[k])) keep.add(i);
      const kept = [...keep].sort((a, b) => a - b);
      for (let k = 1; k < kept.length; k++) out.push({ kind: 'line', p0: pts[kept[k - 1]], p1: pts[kept[k]] });
      removed += pts.length - kept.length; start = end;
    }
    if (p.closed && out.every((s) => s.kind === 'line') && new Set(out.map((s) => s.p0.join(','))).size < 3) throw new Error('La tolerancia eliminaría un contorno cerrado; usa un valor menor');
    p.segments = out;
  }
  return removed;
}

export function refinePaths(scene, ids, op, options = {}) {
  const ctx = index(scene), found = new Set();
  const walk = (n) => { if (n.type === 'path') found.add(n); else if (n.type === 'group') n.children.forEach(walk); };
  for (const id of ids) { const n = scene.byId.get(id); if (!n) throw new Error('La capa ya no existe'); if (n.type !== 'path' && n.type !== 'group') throw new Error(`${n.path}: selecciona un path o un grupo con paths`); walk(n); }
  if (!found.size) throw new Error('No hay paths en la selección');
  const tolerance = number(options.tolerance, 1, 0.001, 100, 'tolerance');
  const strength = number(options.strength, 0.6, 0, 1, 'strength');
  const cornerAngle = number(options.cornerAngle, 60, 5, 175, 'cornerAngle');
  let removed = 0;
  const plans = [...found].map((n) => {
    ctx.unlocked(n); const paths = read(n), localTolerance = tolerance / ctx.matrix(n).scale;
    if (op === 'smooth') smooth(paths, { strength, tolerance: localTolerance, cornerAngle });
    else if (op === 'simplify') removed += simplify(paths, { tolerance: localTolerance, cornerAngle });
    else throw new Error(`Operación de trazo desconocida: ${op}`);
    return [n, write(paths)];
  });
  // All selected paths have passed validation; an invalid/locked child never leaves a partial edit.
  for (const [n, commands] of plans) {
    const current = n.geom.commands;
    if (current.length !== commands.length || current.some((c, i) => c.cmd !== commands[i].cmd || JSON.stringify(c.args) !== JSON.stringify(commands[i].args))) n.geom.commands = commands;
  }
  return `${plans.length} trazo(s)${op === 'simplify' ? ` · ${removed} punto(s) retirados; curvas conservadas` : ' · esquinas y anclas conservadas'}`;
}

function endpoint(p, end) { return end === 'start' ? p.start : p.segments.at(-1).p1; }
function moveEndpoint(p, end, point) {
  const delta = sub(point, endpoint(p, end));
  if (end === 'start') {
    p.start = [...point]; const s = p.segments[0]; s.p0 = [...point];
    if (s.c1) s.c1 = add(s.c1, delta);
    if (s.kind === 'quad') { s.kind = 'curve'; }
  } else {
    const s = p.segments.at(-1); s.p1 = [...point]; if (s.c2) s.c2 = add(s.c2, delta);
    if (s.kind === 'quad') { s.kind = 'curve'; }
  }
}
function reverse(p) {
  p.start = [...p.segments.at(-1).p1];
  p.segments = p.segments.reverse().map((s) => ({ ...s, p0: s.p1, p1: s.p0, c1: s.c2, c2: s.c1 }));
}
export function joinPaths(scene, ids, otherIds, op, options = {}) {
  if (ids.length !== 1 || otherIds.length !== 1) throw new Error('La unión necesita dos rutas exactas: target y other');
  const a = scene.byId.get(ids[0]), b = scene.byId.get(otherIds[0]), ctx = index(scene);
  if (a === b) throw new Error('Selecciona dos trazos distintos');
  ctx.unlocked(a); ctx.unlocked(b);
  const ap = read(a), bp = read(b);
  if (ap.length !== 1 || bp.length !== 1 || ap[0].closed || bp[0].closed) throw new Error('La unión necesita dos paths abiertos de un solo subtrazo');
  const requestedA = options.endpoint ?? 'auto', requestedB = options.otherEndpoint ?? 'auto';
  if (![requestedA, requestedB].every((x) => ['auto', 'start', 'end'].includes(x))) throw new Error('endpoint y otherEndpoint: auto, start o end');
  const maxDistance = number(options.maxDistance, 8, 0.001, 1000, 'maxDistance');
  const ma = ctx.matrix(a), mb = ctx.matrix(b);
  const candidates = [];
  for (const ea of requestedA === 'auto' ? ['end', 'start'] : [requestedA]) for (const eb of requestedB === 'auto' ? ['start', 'end'] : [requestedB]) {
    candidates.push({ ea, eb, distance: len(sub(ma.world(endpoint(ap[0], ea)), mb.world(endpoint(bp[0], eb)))) });
  }
  const { ea: endA, eb: endB } = candidates.sort((x, y) => x.distance - y.distance)[0];
  const wa = ma.world(endpoint(ap[0], endA)), wb = mb.world(endpoint(bp[0], endB));
  const distance = len(sub(wa, wb));
  if (distance > maxDistance) throw new Error(`Extremos a ${distance.toFixed(2)} unidades; supera maxDistance=${maxDistance}`);
  if (op === 'connect') {
    const parent = ctx.parents.get(a);
    if (parent !== ctx.parents.get(b) || Math.abs(parent.children.indexOf(a) - parent.children.indexOf(b)) !== 1) throw new Error('connect necesita capas contiguas del mismo grupo; usa weld para conservar ambas capas');
    if (a.fill !== 'none' || b.fill !== 'none') throw new Error('connect necesita fill none; usa weld para conservar rellenos y capas');
    const keys = ['stroke', 'strokeWidth', 'opacity', 'cap', 'join', 'dash', 'shadow', 'inner', 'animate', 'clip', 'rotate', 'scale', 'hidden'];
    if (keys.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))) throw new Error('connect necesita trazos con el mismo estilo y escala; usa weld para conservar estilos');
    if ([...scene.byId.values()].some((n) => n.clipTarget === b.id || n.clip === b.path || (n.clip === b.name && ctx.parents.get(n) === parent))) throw new Error('Otro elemento usa esta capa como recorte; usa weld para conservarla');
  } else if (op !== 'weld') throw new Error(`Operación de unión desconocida: ${op}`);
  const midpoint = lerp2(wa, wb, 0.5);
  moveEndpoint(ap[0], endA, ma.local(midpoint)); moveEndpoint(bp[0], endB, mb.local(midpoint));
  if (op === 'connect') {
    if (endA === 'start') reverse(ap[0]); if (endB === 'end') reverse(bp[0]);
    for (const s of bp[0].segments) for (const k of ['p0', 'p1', 'c1', 'c2', 'quad']) if (s[k]) s[k] = ma.local(mb.world(s[k]));
    ap[0].segments.push(...bp[0].segments);
    a.geom.commands = write(ap);
    const parent = ctx.parents.get(b); parent.children.splice(parent.children.indexOf(b), 1);
    scene.byId.delete(b.id); scene.byPath.delete(b.path);
  } else { a.geom.commands = write(ap); b.geom.commands = write(bp); }
  return `${op === 'connect' ? 'Un trazo continuo' : 'Dos extremos coincidentes; capas conservadas'} · ${endA} ↔ ${endB} · separación previa ${distance.toFixed(2)}`;
}

export function pathSummary(node) {
  if (node.type !== 'path') return '';
  const c = node.geom.commands;
  const subpaths = c.filter((x) => x.cmd === 'move').length, closures = c.filter((x) => x.cmd === 'close').length;
  return ` pathInfo=[${c.filter((x) => ['move', 'line', 'curve', 'quad'].includes(x.cmd)).length} anchors; ${subpaths} subpaths; ${closures ? `${closures} closed` : 'open'}; ${c.filter((x) => x.cmd === 'line').length} lines; ${c.filter((x) => x.cmd === 'curve' || x.cmd === 'quad').length} curves]`;
}
