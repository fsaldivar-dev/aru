import { normalizeResource } from './resources.js';
// Scene graph builder: AST -> Scene (plain data, no rendering).
// Expands repeat / clone / define, evaluates expressions, resolves gradients, sorts layers,
// and runs generators (fur) so the scene contains concrete geometry only.

import { evaluate, rand } from './expr.js';
import { resolveBlueprint } from './blueprint.js';
import { compileElement, scatterInstances, shapePolygon } from './procedural.js';
import { rng, hashString } from './geom.js';
import { parseAnimate } from './anim.js';
import { invalidateSceneIndex } from './scene-index.js';

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export const LAYERS = { background: 0, far: 1, mid: 2, near: 3, foreground: 4 };
const SHAPES = new Set(['circle', 'ellipse', 'rect', 'polygon', 'path', 'line', 'text']);
// text: content, font, size, weight, anchor (start|middle|end), spacing, italic, baseline, arc <radius> [top|bottom]
const TEXT_KEYS = new Set(['content', 'font', 'size', 'weight', 'anchor', 'spacing', 'italic', 'baseline', 'arc']);
const PATH_CMDS = new Set(['move', 'line', 'curve', 'quad', 'close', 'smooth', 'arc']);

export class SceneError extends Error {
  constructor(message, line, col) { super(message); this.name = 'SceneError'; this.line = line; this.col = col; }
}

export function buildScene(ast) {
  const scene = {
    width: 800, height: 600, background: '#ffffff',
    gradients: {}, root: null, byPath: new Map(), byId: new Map(),
    warnings: [], errors: [], nextId: 1, blueprints: new Map(),
  };
  const names = collectNames(ast);
  const env = { vars: {}, seedPath: [], names, scene, depth: 0 };

  // document-level properties
  for (const p of ast.props) {
    const vals = p.values.map((v) => evaluate(v, env));
    if (p.key === 'canvas') { scene.width = vals[0] ?? 800; scene.height = vals[1] ?? 600; }
    else if (p.key === 'background') scene.background = String(vals[0] ?? '#fff');
    else scene.warnings.push(warn(`Unknown document property '${p.key}'`, p));
  }
  // gradients first (any depth; they are global)
  walkAst(ast, (n) => { if (n.type === 'gradient') scene.gradients[n.name || `g${Object.keys(scene.gradients).length}`] = buildGradient(n, env, scene); });

  const root = { id: 0, type: 'group', name: 'scene', path: '', children: [], at: [0, 0], rotate: 0, scale: [1, 1], opacity: 1, layer: 2 };
  scene.root = root;
  scene.byId.set(0, root);
  buildChildren(ast, root, env);
  return scene;
}

function warn(message, node) { return { message, line: node?.line, col: node?.col }; }

function walkAst(node, fn) { fn(node); for (const c of node.children || []) walkAst(c, fn); }

function collectNames(ast) {
  const names = new Map();
  walkAst(ast, (n) => { if (n.name && n.type !== 'gradient' && n.type !== 'clone' && !names.has(n.name)) names.set(n.name, n); });
  return names;
}

// ---------- gradients ----------
function buildGradient(n, env, scene) {
  const g = { type: 'linear', angle: 90, cx: 0.5, cy: 0.5, r: 0.5, stops: [] };
  const args = n.args.map((a) => evaluate(a, env));
  if (args[1] === 'linear' || args[1] === 'radial') g.type = args[1];
  if (typeof args[2] === 'number') g.angle = args[2];
  if (g.type === 'radial') { if (typeof args[2] === 'number') g.cx = args[2]; if (typeof args[3] === 'number') g.cy = args[3]; if (typeof args[4] === 'number') g.r = args[4]; }
  for (const p of n.props) {
    const v = p.values.map((x) => evaluate(x, env));
    switch (p.key) {
      case 'linear': g.type = 'linear'; if (typeof v[0] === 'number') g.angle = v[0]; break;
      case 'radial': g.type = 'radial'; if (typeof v[0] === 'number') g.cx = v[0]; if (typeof v[1] === 'number') g.cy = v[1]; if (typeof v[2] === 'number') g.r = v[2]; break;
      case 'angle': g.angle = v[0]; break;
      case 'from': g.user = { ...(g.user || {}), x1: v[0], y1: v[1] }; break; // canvas-space linear gradient
      case 'to': g.user = { ...(g.user || {}), x2: v[0], y2: v[1] }; break;
      case 'stop': g.stops.push({ pos: v[0], color: String(v[1]), opacity: typeof v[2] === 'number' ? v[2] : 1 }); break;
      case 'stops': { // evenly spaced list of colors
        const cols = (Array.isArray(v[0]) ? v[0] : v).map(String);
        cols.forEach((c, i) => g.stops.push({ pos: cols.length === 1 ? 0 : i / (cols.length - 1), color: c, opacity: 1 }));
        break;
      }
      default: scene.warnings.push(warn(`Unknown gradient property '${p.key}'`, p));
    }
  }
  if (g.stops.length === 0) scene.warnings.push(warn(`Gradient '${n.name}' has no stops`, n));
  return g;
}

// ---------- nodes ----------
function buildChildren(astNode, parent, env) {
  for (const child of astNode.children) buildNode(child, parent, env);
  // stable sort by layer
  parent.children = parent.children.map((c, i) => [c, i]).sort((a, b) => (a[0].layer - b[0].layer) || (a[1] - b[1])).map((x) => x[0]);
}

function buildNode(ast, parent, env, overrides = null) {
  const scene = env.scene;
  switch (ast.type) {
    case 'gradient': case 'define': return; // handled globally / only instantiated through clone
    case 'repeat': return buildRepeat(ast, parent, env);
    case 'clone': return buildClone(ast, parent, env);
    case 'fur': return buildFur(ast, parent, env);
    case 'ridge': return buildRidge(ast, parent, env);
    case 'blueprint': return buildBlueprint(ast, parent, env);
    case 'scatter': return buildScatter(ast, parent, env);
  }
  if (!SHAPES.has(ast.type) && ast.type !== 'group') { scene.warnings.push(warn(`Unknown node type '${ast.type}'`, ast)); return; }

  const node = newNode(scene, ast.type, ast.name, parent, env, ast);
  node.source = { line: ast.line, col: ast.col };
  const childEnv = env.repeatNames ? { ...env, repeatNames: false } : env; // only the instance itself gets the [i] suffix
  applyProps(node, ast.props, env);
  if (overrides) applyProps(node, overrides, env);
  if (ast.type === 'path') finalizePath(node, ast, env);
  if (ast.type === 'group') buildChildren(ast, node, childEnv);
  parent.children.push(node);
  return node;
}

function newNode(scene, type, name, parent, env, ast) {
  const id = scene.nextId++;
  let finalName = name;
  if (env.vars.i !== undefined && env.repeatNames) finalName = `${name || type}[${env.vars.i}]`;
  if (!finalName) finalName = `${type}#${parent.children.length + 1}`;
  const node = {
    id, type, name: finalName, path: parent.path ? `${parent.path}.${finalName}` : finalName,
    at: [0, 0], rotate: 0, scale: [1, 1],
    fill: type === 'line' ? 'none' : null, stroke: null, strokeWidth: 1, opacity: 1,
    layer: 2, semantic: null, role: null, generated: !!env.generated,
    origin: env.generated ? 'generated' : (env.expanded ? 'expanded' : 'source'), explicitName: !!name,
    geom: defaultGeom(type), children: [],
  };
  if (scene.byPath.has(node.path)) { // disambiguate duplicate names
    let k = 2; while (scene.byPath.has(`${node.path}~${k}`)) k++;
    node.path = `${node.path}~${k}`; node.name = `${node.name}~${k}`;
  }
  scene.byPath.set(node.path, node); scene.byId.set(id, node);
  return node;
}

function defaultGeom(type) {
  switch (type) {
    case 'circle': return { radius: 50 };
    case 'ellipse': return { size: [100, 60] };
    case 'rect': return { size: [100, 60], corner: 0 };
    case 'polygon': return { points: [] };
    case 'line': return { from: [0, 0], to: [100, 0] };
    case 'path': return { commands: [] };
    case 'text': return { content: '', font: 'Helvetica Neue, Arial, sans-serif', size: 32, weight: 400, anchor: 'middle', spacing: 0, italic: false, baseline: 'central', arc: null, arcSide: 'top' };
    default: return {};
  }
}

function applyProps(node, props, env) {
  const scene = env.scene;
  for (const p of props) {
    let v;
    try { v = p.values.map((x) => evaluate(x, env)); }
    catch (e) { scene.errors.push(warn(`${e.message} (in '${p.key}')`, p)); continue; }
    const n0 = typeof v[0] === 'number' ? v[0] : undefined;
    if (node.type === 'text' && TEXT_KEYS.has(p.key)) {
      const g = node.geom;
      if (p.key === 'content') g.content = v.map(String).join(' ');
      else if (p.key === 'font') g.font = v.map(String).join(', ');
      else if (p.key === 'size') g.size = n0 ?? 32;
      else if (p.key === 'weight') g.weight = v[0];
      else if (p.key === 'anchor') g.anchor = String(v[0]);
      else if (p.key === 'spacing') g.spacing = n0 ?? 0;
      else if (p.key === 'italic') g.italic = v[0] !== 0 && v[0] !== 'false';
      else if (p.key === 'baseline') g.baseline = String(v[0]);
      else if (p.key === 'arc') { g.arc = n0 ?? null; g.arcSide = v[1] === 'bottom' ? 'bottom' : 'top'; }
      continue;
    }
    switch (p.key) {
      case 'at': node.at = [n0 ?? 0, typeof v[1] === 'number' ? v[1] : 0]; break;
      case 'rotate': node.rotate = n0 ?? 0; break;
      case 'scale': node.scale = [n0 ?? 1, typeof v[1] === 'number' ? v[1] : (n0 ?? 1)]; break;
      case 'fill': node.fill = checkPaint(String(v[0] ?? 'none'), scene, p); if (typeof v[1] === 'number') node.fillOpacity = v[1]; break;
      case 'stroke': node.stroke = checkPaint(String(v[0] ?? 'none'), scene, p); if (typeof v[1] === 'number') node.strokeWidth = v[1]; break;
      case 'width': node.strokeWidth = n0 ?? 1; break;
      case 'opacity': node.opacity = n0 ?? 1; break;
      case 'cap': node.cap = String(v[0]); break;
      case 'join': node.join = String(v[0]); break;
      case 'dash': node.dash = v.filter((x) => typeof x === 'number'); break;
      // effects (rendered as SVG filters): shadow DX DY BLUR #COLOR OPACITY = drop shadow (elevation);
      // inner DX DY BLUR #COLOR OPACITY = inner shadow / highlight (relief), up to 2 per node; "none" clears
      case 'shadow': case 'inner': {
        if (String(v[0]) === 'none') { node[p.key] = null; break; }
        const nums = v.filter((x) => typeof x === 'number'), col = v.find((x) => typeof x === 'string' && /^#[0-9a-f]{3,8}$/i.test(x)) || '#000000';
        const fx = { dx: nums[0] ?? 0, dy: nums[1] ?? 4, blur: nums[2] ?? 6, color: col, opacity: nums[3] ?? 0.35 };
        if (p.key === 'shadow') node.shadow = fx; else node.inner = [...(node.inner || []), fx].slice(-2);
        break;
      }
      case 'layer': node.layer = typeof v[0] === 'number' ? v[0] : (LAYERS[v[0]] ?? (scene.warnings.push(warn(`Unknown layer '${v[0]}'`, p)), 2)); break;
      case 'semantic': node.semantic = String(v[0]); break;
      case 'role': node.role = String(v[0]); break;
      case 'name': node.name = String(v[0]); break; // used by clone overrides
      case 'clip': node.clip = String(v[0]); break; // group: clip children to the named child shape
      case 'hidden': node.hidden = v[0] !== false && v[0] !== 0; break;
      case 'locked': node.locked = v[0] !== false && v[0] !== 0; break;
      case 'resource': node.resource = normalizeResource(JSON.parse(String(v[0]))); break;
      case 'label': node.label = v.map(String).join(' '); break; // human name (spaces, accents); `name` stays the stable id
      case 'animate': { const r = parseAnimate(v); if (r.error) scene.warnings.push(warn(r.error, p)); else node.animate = r.anim; break; }
      case 'param': break; // handled when the define is cloned
      // geometry
      case 'radius':
        if (node.type === 'circle') node.geom.radius = n0 ?? 50;
        else if (node.type === 'ellipse') node.geom.size = [(n0 ?? 50) * 2, (typeof v[1] === 'number' ? v[1] : (n0 ?? 50)) * 2];
        else if (node.type === 'rect') node.geom.corner = n0 ?? 0;
        else scene.warnings.push(warn(`'radius' not applicable to ${node.type}`, p));
        break;
      case 'size':
        if (node.type === 'ellipse' || node.type === 'rect') node.geom.size = [n0 ?? 100, typeof v[1] === 'number' ? v[1] : (n0 ?? 100)];
        else if (node.type === 'circle') node.geom.radius = (n0 ?? 100) / 2;
        else scene.warnings.push(warn(`'size' not applicable to ${node.type}`, p));
        break;
      case 'corner': if (node.type === 'rect') node.geom.corner = n0 ?? 0; break;
      case 'points': {
        const nums = (Array.isArray(v[0]) ? v[0] : v).filter((x) => typeof x === 'number');
        const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
        node.geom.points = pts; break;
      }
      case 'from': node.geom.from = [n0 ?? 0, typeof v[1] === 'number' ? v[1] : 0]; break;
      case 'to': node.geom.to = [n0 ?? 0, typeof v[1] === 'number' ? v[1] : 0]; break;
      default:
        if (node.type === 'path' && PATH_CMDS.has(p.key)) { node.geom.commands.push({ cmd: p.key, args: v.filter((x) => typeof x === 'number'), line: p.line }); break; }
        scene.warnings.push(warn(`Unknown property '${p.key}' on ${node.type}`, p));
    }
  }
}

const CSS_COLORS = new Set('black white red green blue yellow orange purple pink brown gray grey cyan magenta transparent gold silver navy teal olive maroon lime aqua fuchsia beige coral crimson indigo ivory khaki lavender salmon tan turquoise violet wheat currentColor'.split(' '));
function checkPaint(v, scene, p) {
  if (v === 'none' || /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || scene.gradients[v] || CSS_COLORS.has(v)) return v;
  scene.warnings.push(warn(`'${v}' is not a color, gradient or none`, p));
  return v;
}

function finalizePath(node, ast, env) {
  const ok = { move: 2, line: 2, curve: 6, quad: 4, close: 0, smooth: 4, arc: 7 };
  for (const c of node.geom.commands) {
    if (c.args.length < ok[c.cmd]) env.scene.errors.push(warn(`'${c.cmd}' expects ${ok[c.cmd]} numbers, got ${c.args.length}`, c));
  }
  if (node.geom.commands.length && node.geom.commands[0].cmd !== 'move') env.scene.warnings.push(warn('Path should start with move', ast));
}

// ---------- repeat ----------
function buildRepeat(ast, parent, env) {
  const args = ast.args.map((a) => evaluate(a, env));
  const count = Math.max(0, Math.floor(typeof args[0] === 'number' ? args[0] : 0));
  const varName = typeof args[1] === 'string' ? args[1] : 'i';
  if (count > 5000) { env.scene.errors.push(warn('repeat count too large (max 5000)', ast)); return; }
  for (let i = 0; i < count; i++) {
    const sub = {
      ...env, repeatNames: true, expanded: true,
      vars: { ...env.vars, [varName]: i, n: count, t: count > 1 ? i / (count - 1) : 0 },
      seedPath: [...env.seedPath, i],
    };
    // the repeat body: common properties apply to each child instance (e.g. `repeat 5 { fill red; circle {...} }`)
    for (const child of ast.children) {
      const built = buildNode(child, parent, sub);
      if (built && ast.props.length) applyProps(built, ast.props, sub);
    }
  }
}

// ---------- clone ----------
function buildClone(ast, parent, env) {
  const refName = ast.args[0] && ast.args[0].kind === 'ident' ? ast.args[0].name : null;
  const ref = refName && env.names.get(refName);
  if (!ref) { env.scene.errors.push(warn(`clone: unknown object '${refName}'`, ast)); return; }
  if (env.depth > 32) { env.scene.errors.push(warn('clone nesting too deep (recursive clone?)', ast)); return; }
  const copy = deepCopyAst(ref);
  copy.type = ref.type === 'define' ? 'group' : ref.type;
  copy.name = ast.name || refName;
  copy.line = ast.line; copy.col = ast.col;
  // children declared inside the clone block are appended to the copy
  copy.children = [...copy.children, ...ast.children];
  // parameters: `param w 80` inside a define declares w (default 80); `clone house { w 120 }` sets it
  const vars = { ...env.vars };
  const paramNames = new Set();
  for (const p of ref.props) {
    if (p.key !== 'param') continue;
    const id = p.values[0] && p.values[0].kind === 'ident' ? p.values[0].name : null;
    if (!id) continue;
    paramNames.add(id);
    vars[id] = p.values[1] ? evaluate(p.values[1], { ...env, vars }) : 0;
  }
  const overrides = [];
  for (const p of ast.props) {
    if (paramNames.has(p.key)) vars[p.key] = p.values[0] ? evaluate(p.values[0], env) : 0;
    else overrides.push(p);
  }
  const sub = { ...env, vars, depth: env.depth + 1, expanded: true };
  const node = buildNode(copy, parent, sub, overrides);
  if (node) { node.cloneOf = refName; }
}

function deepCopyAst(n) {
  return { ...n, args: [...n.args], props: n.props.slice(), children: n.children.map(deepCopyAst) };
}

// ---------- fur generator ----------
// fur <targetName> [name] { density 0.5  length 18  width 2  direction radial|down|angle N|random
//                           colors [#a #b #c]  seed 1  curl 0.4  opacity 1  count N }
function buildFur(ast, parent, env) {
  const scene = env.scene;
  const targetName = ast.args[0] && ast.args[0].kind === 'ident' ? ast.args[0].name : null;
  const target = parent.children.find((c) => c.name === targetName);
  if (!target) { scene.errors.push(warn(`fur: target '${targetName}' must be a previously declared sibling shape`, ast)); return; }
  const node = newNode(scene, 'fur', ast.name || `fur_${targetName}`, parent, env, ast);
  node.fill = null; node.clipTarget = target.id; node.source = { line: ast.line };
  const opt = { density: 0.5, length: 18, width: 2, direction: 'radial', angle: 90, colors: ['#000000'], seed: 1, curl: 0.4, opacity: 1, count: null, taper: true };
  for (const p of ast.props) {
    const v = p.values.map((x) => evaluate(x, env));
    switch (p.key) {
      case 'density': opt.density = v[0]; break;
      case 'length': opt.length = v[0]; break;
      case 'width': opt.width = v[0]; break;
      case 'direction': opt.direction = String(v[0]); if (typeof v[1] === 'number') opt.angle = v[1]; break;
      case 'angle': opt.angle = v[0]; break;
      case 'colors': opt.colors = (Array.isArray(v[0]) ? v[0] : v).map(String); break;
      case 'seed': opt.seed = v[0]; break;
      case 'curl': opt.curl = v[0]; break;
      case 'count': opt.count = v[0]; break;
      case 'opacity': node.opacity = v[0]; break;
      case 'layer': node.layer = typeof v[0] === 'number' ? v[0] : (LAYERS[v[0]] ?? 2); break;
      case 'semantic': node.semantic = String(v[0]); break;
      case 'role': node.role = String(v[0]); break;
      default: scene.warnings.push(warn(`Unknown fur property '${p.key}'`, p));
    }
  }
  const bb = localBounds(target); // in target local coords
  const area = Math.max(1, (bb[2] - bb[0]) * (bb[3] - bb[1]) * (target.type === 'circle' || target.type === 'ellipse' ? Math.PI / 4 : 1));
  const count = Math.min(4000, Math.round(opt.count ?? opt.density * area / 100));
  const genEnv = { ...env, generated: true, repeatNames: false, vars: { ...env.vars } };
  const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  for (let k = 0; k < count; k++) {
    const r = (s) => rand(opt.seed * 1000 + s, { seedPath: [...env.seedPath, k] });
    let px, py;
    if (target.type === 'circle' || target.type === 'ellipse') {
      const a = r(1) * Math.PI * 2, d = Math.sqrt(r(2));
      px = cx + Math.cos(a) * d * (bb[2] - bb[0]) / 2; py = cy + Math.sin(a) * d * (bb[3] - bb[1]) / 2;
    } else { px = bb[0] + r(1) * (bb[2] - bb[0]); py = bb[1] + r(2) * (bb[3] - bb[1]); }
    let ang;
    if (opt.direction === 'radial') ang = Math.atan2(py - cy, px - cx);
    else if (opt.direction === 'down') ang = Math.PI / 2;
    else if (opt.direction === 'random') ang = r(3) * Math.PI * 2;
    else ang = opt.angle * Math.PI / 180;
    ang += (r(4) - 0.5) * 0.6;
    const len = opt.length * (0.6 + r(5) * 0.8);
    const curl = (r(6) - 0.5) * opt.curl * len;
    const ex = px + Math.cos(ang) * len, ey = py + Math.sin(ang) * len;
    const mx = (px + ex) / 2 - Math.sin(ang) * curl, my = (py + ey) / 2 + Math.cos(ang) * curl;
    const col = opt.colors[Math.floor(r(7) * opt.colors.length) % opt.colors.length];
    // transform from target local space into parent space (target.at / rotate / scale)
    const T = (x, y) => applyTransform(target, x, y);
    const [sx, sy] = T(px, py), [qx, qy] = T(mx, my), [tx, ty] = T(ex, ey);
    const stroke = newNode(scene, 'path', `hair${k}`, node, genEnv, ast);
    stroke.fill = 'none'; stroke.stroke = col; stroke.strokeWidth = opt.width * (0.7 + r(8) * 0.6); stroke.cap = 'round';
    stroke.geom.commands = [{ cmd: 'move', args: [sx, sy] }, { cmd: 'quad', args: [qx, qy, tx, ty] }];
    node.children.push(stroke);
  }
  node.furOptions = opt; node.furCount = count;
  parent.children.push(node);
}

export function applyTransform(node, x, y) {
  const [sx, sy] = node.scale; const r = node.rotate * Math.PI / 180;
  let X = x * sx, Y = y * sy;
  const c = Math.cos(r), s = Math.sin(r);
  return [X * c - Y * s + node.at[0], X * s + Y * c + node.at[1]];
}

// bounds of a shape in its own local coordinate space [minx, miny, maxx, maxy]
export function localBounds(node) {
  const g = node.geom;
  switch (node.type) {
    case 'circle': return [-g.radius, -g.radius, g.radius, g.radius];
    case 'ellipse': case 'rect': return [-g.size[0] / 2, -g.size[1] / 2, g.size[0] / 2, g.size[1] / 2];
    case 'polygon': return ptsBounds(g.points);
    case 'line': return ptsBounds([g.from, g.to]);
    case 'path': {
      const pts = [];
      for (const c of g.commands) for (let i = 0; i + 1 < c.args.length; i += 2) if (c.cmd !== 'arc' || i >= 5) pts.push([c.args[i], c.args[i + 1]]);
      return ptsBounds(pts);
    }
    default: return [0, 0, 0, 0];
  }
}
function ptsBounds(pts) {
  if (!pts.length) return [0, 0, 0, 0];
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
}

// ---------- traversal helpers ----------
export function walkScene(node, fn, depth = 0) { fn(node, depth); for (const c of node.children) walkScene(c, fn, depth + 1); }

// bounds of a node in its own local space (before its own transform). Groups = union of children in parent space.
export function nodeLocalBounds(node) {
  if (node.type !== 'group' && node.type !== 'fur') return localBounds(node);
  let b = null;
  for (const c of node.children) {
    if (c.hidden) continue;
    const cb = nodeLocalBounds(c);
    const corners = [[cb[0], cb[1]], [cb[2], cb[1]], [cb[2], cb[3]], [cb[0], cb[3]]].map(([x, y]) => applyTransform(c, x, y));
    for (const [x, y] of corners) b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
  }
  return b || [0, 0, 0, 0];
}

// ---------- ridge generator ----------
// ridge name { from x y; to x y; base y; peaks n; height min max; seed s; fill paint
//              light x [color] [opacity]; snow fraction [color]; layer/semantic/role }
// Produces: group(name){ clip shape; path shape; group light; group snow } — lighting is derived from the light x.
function buildRidge(ast, parent, env) {
  const scene = env.scene;
  const o = { from: [0, 330], to: [scene.width, 330], base: scene.height, peaks: 6, height: [60, 120], seed: 1, fill: '#666', light: null, lightColor: '#F2B9A6', lightOpacity: 0.45, snow: 0, snowColor: '#FBE6DA', rim: null };
  const g = newNode(scene, 'group', ast.name || 'ridge', parent, env, ast);
  g.source = { line: ast.line };
  for (const p of ast.props) {
    const v = p.values.map((x) => evaluate(x, env));
    switch (p.key) {
      case 'from': o.from = [v[0], v[1]]; break;
      case 'to': o.to = [v[0], v[1]]; break;
      case 'base': o.base = v[0]; break;
      case 'peaks': o.peaks = Math.max(1, Math.round(v[0])); break;
      case 'height': o.height = [v[0], v[1] ?? v[0]]; break;
      case 'seed': o.seed = v[0]; break;
      case 'fill': o.fill = checkPaint(String(v[0]), scene, p); break;
      case 'light': o.light = v[0]; if (v[1] !== undefined) o.lightColor = String(v[1]); if (typeof v[2] === 'number') o.lightOpacity = v[2]; break;
      case 'snow': o.snow = v[0]; if (v[1] !== undefined) o.snowColor = String(v[1]); break;
      case 'rim': o.rim = String(v[0]); break;
      default: applyProps(g, [p], env);
    }
  }
  const r = (k) => rand(o.seed * 7919 + k, { seedPath: env.seedPath });
  const lerp = (a, b, t) => a + (b - a) * t;
  const baseY = (x) => lerp(o.from[1], o.to[1], (x - o.from[0]) / (o.to[0] - o.from[0]));
  // alternating valley / peak points
  const pts = [[o.from[0], o.from[1]]];
  const step = (o.to[0] - o.from[0]) / o.peaks;
  const peaks = [];
  for (let i = 0; i < o.peaks; i++) {
    const px = o.from[0] + step * (i + 0.5) + (r(i * 3) - 0.5) * step * 0.4;
    const py = baseY(px) - lerp(o.height[0], o.height[1], r(i * 3 + 1));
    peaks.push(pts.length); pts.push([px, py]);
    if (i < o.peaks - 1) { const vx = o.from[0] + step * (i + 1) + (r(i * 3 + 2) - 0.5) * step * 0.3; pts.push([vx, baseY(vx) - lerp(0, o.height[0] * 0.5, r(i * 3 + 5))]); }
  }
  pts.push([o.to[0], o.to[1]]);
  const cmds = [{ cmd: 'move', args: [o.from[0], o.base] }, { cmd: 'line', args: pts[0] }];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    cmds.push({ cmd: 'quad', args: [(ax + bx) / 2, (ay + by) / 2 - Math.abs(by - ay) * 0.12, bx, by] }); // slightly convex slopes
  }
  cmds.push({ cmd: 'line', args: [o.to[0], o.base] }, { cmd: 'close', args: [] });
  const genEnv = { ...env, generated: true, repeatNames: false };
  const shape = newNode(scene, 'path', 'shape', g, genEnv, ast);
  shape.geom.commands = cmds; shape.fill = o.fill; g.children.push(shape);
  g.clip = 'shape';
  const sub = (name, fill, opacity) => { const n = newNode(scene, 'group', name, g, genEnv, ast); n.fill = fill; n.opacity = opacity; g.children.push(n); return n; };
  const poly = (grp, points) => { const n = newNode(scene, 'polygon', `face${grp.children.length + 1}`, grp, genEnv, ast); n.geom.points = points; grp.children.push(n); };
  if (o.light !== null) {
    const L = sub('light', o.lightColor, o.lightOpacity);
    for (const pi of peaks) {
      const P = pts[pi], side = o.light >= P[0] ? 1 : -1, N = pts[pi + side];
      poly(L, [P, N, [lerp(P[0], N[0], 0.3), P[1] + (N[1] - P[1]) * 1.5]]);
    }
  }
  if (o.snow > 0) {
    const S = sub('snow', o.snowColor, 0.85);
    for (const pi of peaks) {
      const P = pts[pi], A = pts[pi - 1], B = pts[pi + 1], f = o.snow;
      const a = [lerp(P[0], A[0], f), lerp(P[1], A[1], f)], b = [lerp(P[0], B[0], f), lerp(P[1], B[1], f)];
      const m1 = [lerp(a[0], b[0], 0.33), lerp(a[1], b[1], 0.33) - 6], m2 = [lerp(a[0], b[0], 0.66), lerp(a[1], b[1], 0.66) + 4];
      poly(S, [P, b, m2, m1, a]);
    }
  }
  if (o.rim) { const rim = newNode(scene, 'path', 'rim', g, genEnv, ast); rim.geom.commands = cmds.slice(1, -2); rim.fill = 'none'; rim.stroke = o.rim; rim.strokeWidth = 2.5; rim.opacity = 0.5; g.children.push(rim); }
  parent.children.push(g);
  return g;
}

// ======================================================================================
// Semantic level: blueprint -> (resolver) -> blueprint object -> (procedural compiler) -> geometry IR
// The scene builder only *materializes* IR into scene nodes. No procedural logic lives here or in the renderer.
// ======================================================================================

function buildBlueprint(ast, parent, env) {
  const scene = env.scene;
  const t0 = nowMs();
  const bp = resolveBlueprint(ast, scene);
  const t1 = nowMs();
  const root = newNode(scene, 'group', bp.name, parent, env, ast);
  root.source = { line: ast.line };
  root.semanticKind = 'blueprint';
  if (bp.layer !== undefined) root.layer = typeof bp.layer === 'number' ? bp.layer : (LAYERS[bp.layer] ?? 2);
  if (bp.semantic) root.semantic = String(bp.semantic);
  if (bp.role) root.role = String(bp.role);
  parent.children.push(root);
  const rt = { bp, root, nodes: new Map(), parents: new Map(), deps: new Map(), expansions: new Map(), debug: new Map(), groupNodes: new Map(), env, timings: {} };
  for (const el of bp.elements) compileAndMount(rt, el, groupNodeFor(rt, el.group));
  rt.timings = { resolve: t1 - t0, compile: nowMs() - t1 };
  for (const w of bp.warnings) scene.warnings.push(w);
  scene.blueprints.set(bp.name, rt);
  return root;
}

// semantic groups (`group eyes { ... }` inside a blueprint) become plain group nodes
function groupNodeFor(rt, groupPath) {
  let parent = rt.root, key = '';
  for (const g of groupPath) {
    key += '/' + g;
    if (!rt.groupNodes.has(key)) {
      const n = newNode(rt.env.scene, 'group', g, parent, rt.env, null);
      n.semanticKind = 'group'; n.origin = 'semantic';
      parent.children.push(n);
      rt.groupNodes.set(key, n);
    }
    parent = rt.groupNodes.get(key);
  }
  return parent;
}

function compileAndMount(rt, el, parentNode, index = -1) {
  const res = compileElement(rt.bp, el);
  rt.deps.set(el.name, res.deps);
  rt.expansions.set(el.name, res.expansions);
  rt.debug.set(el.name, res.debug);
  const genEnv = { ...rt.env, generated: true, repeatNames: false, expanded: false };
  const node = materialize(res.ir, parentNode, genEnv);
  node.generated = false; node.origin = 'semantic';
  node.semanticKind = el.kind; node.semanticElement = el.name; node.mirrorOf = el.mirrorOf || null; node.exactMirror = !!el.exact;
  node.source = { line: el.ast.line };
  if (index >= 0) { parentNode.children.pop(); parentNode.children.splice(index, 0, node); }
  rt.nodes.set(el.name, node); rt.parents.set(el.name, parentNode);
  return node;
}

// Geometry IR -> scene nodes
export function materialize(ir, parent, env) {
  const scene = env.scene;
  if (ir.type === 'instance') {
    const g = newNode(scene, 'group', ir.name, parent, env, null);
    g.at = ir.at || [0, 0]; g.rotate = ir.rotate || 0; g.scale = ir.scale || [1, 1];
    parent.children.push(g);
    const sub = { ...env, vars: { ...env.vars, ...ir.vars }, seedPath: [...env.seedPath, ir.vars.i] };
    for (const a of ir.template) buildNode(deepCopyAst(a), g, sub);
    return g;
  }
  const n = newNode(scene, ir.type, ir.name, parent, env, null);
  for (const k of ['at', 'rotate', 'scale', 'fill', 'stroke', 'strokeWidth', 'opacity', 'cap', 'join', 'clip', 'semantic', 'role', 'fillOpacity', 'meta', 'resource', 'label', 'animate', 'hidden', 'locked', 'shadow', 'inner']) if (ir[k] !== undefined) n[k] = ir[k];
  if (ir.geom) n.geom = { ...n.geom, ...ir.geom };
  for (const c of ir.children || []) materialize(c, n, env);
  parent.children.push(n);
  return n;
}

function unregister(scene, node) { walkScene(node, (c) => { scene.byPath.delete(c.path); scene.byId.delete(c.id); }); }

// Incremental update: apply a semantic change, recompile ONLY the dependent elements.
export function updateBlueprint(scene, name, change) {
  const rt = scene.blueprints.get(name);
  if (!rt) throw new Error(`Unknown blueprint '${name}'`);
  const t0 = nowMs();
  const keys = rt.bp.applyChange(change);
  const affected = rt.bp.affected(keys, rt.deps);
  for (const el of affected) {
    const old = rt.nodes.get(el.name), parent = rt.parents.get(el.name);
    const idx = parent.children.indexOf(old);
    parent.children.splice(idx, 1);
    unregister(scene, old);
    compileAndMount(rt, el, parent, idx);
  }
  invalidateSceneIndex(scene);
  return { changed: [...keys], recompiled: affected.map((e) => e.name), total: rt.bp.elements.length, ms: nowMs() - t0 };
}

// Geometric scatter (outside blueprints): scatter leaves { inside crown; count 30; scale 0.8..1.2; rotation -20..20; seed 3; <template> }
function buildScatter(ast, parent, env) {
  const scene = env.scene;
  const P = { val: (k, d) => { const p = ast.props.find((x) => x.key === k); return p ? evaluate(p.values[0], env) : d; } };
  const target = parent.children.find((c) => c.name === P.val('inside', ''));
  if (!target) { scene.errors.push(warn(`scatter: 'inside' must name a previously declared sibling shape`, ast)); return; }
  const g = newNode(scene, 'group', ast.name || 'scatter', parent, env, ast);
  g.source = { line: ast.line };
  for (const p of ast.props) if (['layer', 'semantic', 'role', 'opacity', 'resource', 'label', 'animate', 'hidden', 'locked', 'shadow', 'inner'].includes(p.key)) applyProps(g, [p], env);
  parent.children.push(g);
  const r = rng(hashString(ast.name || 'scatter') + Math.round(P.val('seed', 1) * 7919));
  const inst = scatterInstances(P, shapePolygon(target), r, ast.children, ast.name || 'item');
  const sub = { ...env, expanded: true, repeatNames: false };
  for (const ir of inst) materialize(ir, g, sub);
}
