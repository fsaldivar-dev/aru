// Blueprint Resolver: Semantic AST (a `blueprint` block) -> Blueprint object.
//
// A Blueprint is independent of the geometric scene graph. It holds:
//   frame (canvas rect the normalized 0..1 coordinates map to), symmetry, light, seed,
//   landmarks (semantic points, possibly derived from other landmarks or mirrored),
//   palette (named colors), and an ordered list of semantic elements (region / contour / spot / scatter),
//   including mirror twins created by `mirror`.
// It also owns the dependency bookkeeping: which landmark depends on which, and (filled by the compiler)
// which element depends on which landmarks / palette entries / other elements.

import { evaluate } from './expr.js';
import { hashString, rng, mixColor, shadeColor, dirVector } from './geom.js';

const SEMANTIC_ELEMENTS = new Set(['region', 'contour', 'spot', 'scatter']);
const swapLR = (n) => (/L$/.test(n) ? n.slice(0, -1) + 'R' : /R$/.test(n) ? n.slice(0, -1) + 'L' : n);
const stripPrefix = (n, p) => (n.startsWith(p + '.') ? n.slice(p.length + 1) : n);
const ENV0 = { vars: {}, seedPath: [] };

export function resolveBlueprint(ast, scene) {
  const bp = {
    name: ast.name || 'blueprint', ast,
    frame: { x: 0, y: 0, w: scene.width, h: scene.height },
    symmetry: { mode: 'none', axis: 0.5, jitter: 0.008 },
    light: 'top-left', seed: 1,
    landmarkDefs: new Map(), paletteDefs: new Map(),
    elements: [], byName: new Map(), tree: { name: ast.name, kind: 'blueprint', children: [] },
    warnings: [], compiled: new Map(),
    lmCache: new Map(), lmDeps: new Map(),
  };
  const warn = (message, node) => bp.warnings.push({ message, line: node?.line, col: node?.col });
  const mirrors = [], tweaks = [];

  // ---- blueprint-level properties ----
  for (const p of ast.props) {
    const v = p.values.map((x) => evaluate(x, ENV0));
    switch (p.key) {
      case 'at': bp.frame.x = v[0]; bp.frame.y = v[1]; break;
      case 'size': bp.frame.w = v[0]; bp.frame.h = v[1] ?? v[0]; break;
      case 'light': bp.light = v[0]; break;
      case 'seed': bp.seed = v[0]; break;
      case 'layer': case 'semantic': case 'role': bp[p.key] = v[0]; break;
      default: warn(`Unknown blueprint property '${p.key}'`, p);
    }
  }

  // ---- walk children ----
  const walk = (node, groupPath, treeNode) => {
    for (const c of node.children) {
      switch (c.type) {
        case 'landmarks':
          for (const p of c.props) addLandmark(p.key, p.values, p);
          break;
        case 'landmark':
          addLandmark(c.name, c.args.slice(1), c);
          break;
        case 'palette':
          for (const p of c.props) bp.paletteDefs.set(p.key, p.values[0]);
          break;
        case 'symmetry': {
          const words = c.args.map((a) => evaluate(a, ENV0));
          if (words.includes('exact')) bp.symmetry.mode = 'exact'; else bp.symmetry.mode = 'soft';
          for (const p of c.props) {
            const v = evaluate(p.values[0], ENV0);
            if (p.key === 'axis') bp.symmetry.axis = v; else if (p.key === 'mode') bp.symmetry.mode = v; else if (p.key === 'jitter') bp.symmetry.jitter = v;
            else warn(`Unknown symmetry property '${p.key}'`, p);
          }
          break;
        }
        case 'mirror': mirrors.push({ node: c, names: c.args.map((a) => (a.kind === 'ident' ? a.name : null)).filter(Boolean) }); break;
        case 'tweak': tweaks.push(c); break;
        case 'group': {
          const t = { name: c.name, kind: 'group', children: [] };
          treeNode.children.push(t);
          walk(c, [...groupPath, c.name], t);
          break;
        }
        default:
          if (SEMANTIC_ELEMENTS.has(c.type)) {
            if (!c.name) { warn(`${c.type} needs a name`, c); break; }
            const el = { name: c.name, kind: c.type, ast: c, group: groupPath, treeNode: null };
            addElement(el, treeNode);
          } else warn(`'${c.type}' is not allowed inside a blueprint`, c);
      }
    }
  };
  const addElement = (el, treeNode, afterName = null) => {
    if (bp.byName.has(el.name)) { warn(`Duplicate semantic element '${el.name}'`, el.ast); return; }
    const t = { name: el.name, kind: el.kind, element: el.name, children: [] };
    el.treeNode = t; el.treeParent = treeNode;
    if (afterName) {
      const i = bp.elements.findIndex((e) => e.name === afterName);
      bp.elements.splice(i + 1, 0, el);
      const ti = treeNode.children.findIndex((x) => x.element === afterName);
      treeNode.children.splice(ti + 1, 0, t);
    } else { bp.elements.push(el); treeNode.children.push(t); }
    bp.byName.set(el.name, el);
  };
  function addLandmark(name, values, node) {
    if (!values.length) { warn(`Landmark '${name}' needs a position`, node); return; }
    if (values.length >= 2 && values[0].kind !== 'call' && values[0].kind !== 'ident') {
      bp.landmarkDefs.set(name, { kind: 'abs', value: [evaluate(values[0], ENV0), evaluate(values[1], ENV0)], line: node.line });
    } else bp.landmarkDefs.set(name, { kind: 'expr', ast: values[0], line: node.line });
  }
  walk(ast, [], bp.tree);

  // ---- symmetry: auto-mirror landmarks named ...L that have no ...R twin ----
  if (bp.symmetry.mode !== 'none') {
    for (const [name, def] of [...bp.landmarkDefs]) {
      if (!/L$/.test(name)) continue;
      const twin = swapLR(name), existing = bp.landmarkDefs.get(twin);
      if (existing && bp.symmetry.mode === 'exact') warn(`symmetry exact: '${twin}' is derived from '${name}', explicit value ignored`, { line: existing.line });
      if (!existing || bp.symmetry.mode === 'exact') bp.landmarkDefs.set(twin, { kind: 'mirror', of: name, line: def.line });
    }
  }

  // ---- mirror: create R twins of L elements (no geometry duplicated in the source) ----
  for (const m of mirrors) {
    const names = m.names.includes('all') ? bp.elements.filter((e) => /L$/.test(e.name) && !e.mirrorOf).map((e) => e.name) : m.names;
    for (const n of names) {
      const src = bp.byName.get(n);
      if (!src) { warn(`mirror: unknown element '${n}'`, m.node); continue; }
      if (bp.symmetry.mode === 'none') { warn('mirror needs a symmetry declaration', m.node); break; }
      const twinName = swapLR(n);
      if (twinName === n) { warn(`mirror: '${n}' must end with L or R`, m.node); continue; }
      const exact = bp.symmetry.mode === 'exact';
      // soft: the twin is a mirrored *description*, compiled against the twin landmarks with its own seed.
      // exact: the twin is the source geometry reflected about the axis.
      const twin = { name: twinName, kind: src.kind, ast: exact ? src.ast : mirrorAst(src.ast, bp), group: src.group, mirrorOf: n, exact };
      addElement(twin, src.treeParent, n);
    }
  }
  // ---- tweak: small post-mirror adjustments (soft symmetry) ----
  for (const t of tweaks) {
    const el = bp.byName.get(t.name);
    if (!el) { warn(`tweak: unknown element '${t.name}'`, t); continue; }
    if (el.exact) { warn(`tweak '${t.name}' ignored: exact mirrors cannot diverge`, t); continue; }
    // props override (last wins); a tweak child block (planes / edge / fur) replaces the blocks of the same type
    const replaced = new Set(t.children.map((c) => c.type));
    el.ast = { ...el.ast, props: [...el.ast.props, ...t.props], children: [...el.ast.children.filter((c) => !replaced.has(c.type)), ...t.children] };
  }

  // ---------- API used by the procedural compiler ----------
  const F = bp.frame;
  bp.s = Math.min(F.w, F.h);
  bp.axisAbs = () => F.x + bp.symmetry.axis * F.w;
  bp.abs = ([x, y]) => [F.x + x * F.w, F.y + y * F.h];

  // normalized landmark position; records landmark->landmark dependencies
  bp.landmark = (name, stack = []) => {
    name = stripPrefix(name, 'landmark');
    if (bp.lmCache.has(name)) return bp.lmCache.get(name);
    const def = bp.landmarkDefs.get(name);
    if (!def) { warn(`Unknown landmark '${name}'`); return [0.5, 0.5]; }
    if (stack.includes(name)) { warn(`Circular landmark '${name}'`); return [0.5, 0.5]; }
    const deps = new Set();
    let v;
    if (def.kind === 'abs') v = def.value;
    else if (def.kind === 'mirror') {
      deps.add(def.of);
      const src = bp.landmark(def.of, [...stack, name]);
      v = [2 * bp.symmetry.axis - src[0], src[1]];
      if (bp.symmetry.mode === 'soft' && bp.symmetry.jitter) { // soft: deterministic small asymmetry
        const r = rng(hashString(bp.name + name) + bp.seed);
        v = [v[0] + (r() - 0.5) * 2 * bp.symmetry.jitter, v[1] + (r() - 0.5) * 2 * bp.symmetry.jitter];
      }
    } else v = pointExpr(def.ast, (n) => { deps.add(n); return bp.landmark(n, [...stack, name]); });
    bp.lmDeps.set(name, deps);
    bp.lmCache.set(name, v);
    return v;
  };
  // absolute point from an AST value: landmark name, mid(a,b,t), offset(a,dx,dy), pt(x,y)
  bp.point = (astValue, deps) => bp.abs(pointExpr(astValue, (n) => { deps?.add('lm:' + stripPrefix(n, 'landmark')); return bp.landmark(n); }));
  function pointExpr(v, lm) {
    if (!v) return [0.5, 0.5];
    if (v.kind === 'ident') return lm(v.name);
    if (v.kind === 'call') {
      const a = v.args;
      const num = (i, d) => (a[i] ? evaluate(a[i], ENV0) : d);
      switch (v.name) {
        case 'mid': case 'lerp': { const p = pointExpr(a[0], lm), q = pointExpr(a[1], lm), t = num(2, 0.5); return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; }
        case 'offset': { const p = pointExpr(a[0], lm); return [p[0] + num(1, 0), p[1] + num(2, 0)]; }
        case 'pt': case 'p': return [num(0, 0.5), num(1, 0.5)];
      }
    }
    warn(`Cannot use '${v.name ?? v.value}' as a point`);
    return [0.5, 0.5];
  }
  bp.pointNames = (astValue) => { // landmark names referenced by a point expression (for debug connections)
    if (!astValue) return [];
    if (astValue.kind === 'ident') return [stripPrefix(astValue.name, 'landmark')];
    if (astValue.kind === 'call') return astValue.args.flatMap((x) => bp.pointNames(x));
    return [];
  };

  // color from an AST value or evaluated word: hex, CSS name, palette name (with or without `palette.`), shade(), mix()
  bp.color = (v, deps, depth = 0) => {
    if (v == null) return null;
    if (typeof v === 'string') return bp.color({ kind: v.startsWith('#') ? 'color' : 'ident', value: v, name: v }, deps, depth);
    if (v.kind === 'color' || v.kind === 'string') return v.value;
    if (v.kind === 'ident') {
      const n = stripPrefix(v.name, 'palette');
      if (bp.paletteDefs.has(n) && depth < 8) { deps?.add('pal:' + n); return bp.color(bp.paletteDefs.get(n), deps, depth + 1); }
      return v.name;
    }
    if (v.kind === 'call') {
      if (v.name === 'shade') return shadeColor(bp.color(v.args[0], deps, depth + 1), evaluate(v.args[1], ENV0));
      if (v.name === 'mix') return mixColor(bp.color(v.args[0], deps, depth + 1), bp.color(v.args[1], deps, depth + 1), v.args[2] ? evaluate(v.args[2], ENV0) : 0.5);
    }
    return String(evaluate(v, ENV0));
  };
  // direction in which shading increases (light comes from the opposite side)
  bp.shadeDir = (deps) => { deps?.add('light'); const l = dirVector(bp.light) || dirVector('top-left'); return [-l[0], -l[1]]; };

  bp.allLandmarks = () => [...bp.landmarkDefs.keys()].map((n) => ({ name: n, def: bp.landmarkDefs.get(n), p: bp.abs(bp.landmark(n)) }));

  // ---------- changes + invalidation ----------
  // returns the set of dependency keys that changed (lm:x, pal:x, light)
  bp.applyChange = (change) => {
    const keys = new Set();
    if (change.landmark) {
      const { name, value } = change.landmark;
      if (!bp.landmarkDefs.has(name)) throw new Error(`Unknown landmark '${name}'`);
      const def = bp.landmarkDefs.get(name);
      if (def.kind === 'mirror' && bp.symmetry.mode === 'exact') throw new Error(`'${name}' is an exact mirror of '${def.of}': move '${def.of}' instead`);
      bp.landmarkDefs.set(name, { kind: 'abs', value, line: def.line });
      // invalidate this landmark and every landmark derived from it
      const stale = new Set([name]);
      let grew = true;
      while (grew) { grew = false; for (const [n, d] of bp.lmDeps) if (!stale.has(n) && [...d].some((x) => stale.has(x))) { stale.add(n); grew = true; } }
      for (const n of stale) { bp.lmCache.delete(n); keys.add('lm:' + n); }
    }
    if (change.palette) { bp.paletteDefs.set(change.palette.name, { kind: 'color', value: change.palette.value }); keys.add('pal:' + change.palette.name); }
    if (change.light) { bp.light = change.light; keys.add('light'); }
    return keys;
  };
  // keys touched if landmark `name` moved (itself + every landmark derived from it)
  bp.landmarkKeys = (name) => {
    const stale = new Set([name]);
    let grew = true;
    while (grew) { grew = false; for (const [n, d] of bp.lmDeps) if (!stale.has(n) && [...d].some((x) => stale.has(x))) { stale.add(n); grew = true; } }
    return new Set([...stale].map((n) => 'lm:' + n));
  };
  // elements whose recorded dependencies intersect `keys` (transitively through el:x dependencies)
  bp.affected = (keys, elementDeps) => {
    const hit = new Set(keys), out = [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const el of bp.elements) {
        if (hit.has('el:' + el.name)) continue;
        const d = elementDeps.get(el.name);
        if (d && [...d].some((k) => hit.has(k))) { hit.add('el:' + el.name); grew = true; }
      }
    }
    for (const el of bp.elements) if (hit.has('el:' + el.name)) out.push(el);
    return out;
  };
  return bp;
}

// Mirror a semantic description: L<->R names, left<->right words, negated angles/offsets, reflected literal points.
function mirrorAst(ast, bp) {
  const NEG_ANGLE = new Set(['angle', 'rotation', 'tilt']);
  const val = (v, key, idx) => {
    if (!v) return v;
    switch (v.kind) {
      case 'ident': {
        if (v.name === 'left') return { ...v, name: 'right' };
        if (v.name === 'right') return { ...v, name: 'left' };
        if (v.name.startsWith('palette.')) return v;
        return { ...v, name: swapLR(v.name) };
      }
      case 'num':
        if (NEG_ANGLE.has(key)) return { ...v, value: -v.value };
        if (key === 'direction') return { ...v, value: 180 - v.value };
        if (key === 'ring' && idx === 3) return { ...v, value: -v.value }; // ring dx
        return v;
      case 'neg': return { ...v, e: val(v.e, key, idx) };
      case 'bin':
        if (v.op === '..' && NEG_ANGLE.has(key)) return { ...v, l: val(v.r, key, idx), r: val(v.l, key, idx) };
        return { ...v, l: val(v.l, key, idx), r: val(v.r, key, idx) };
      case 'list': return { ...v, items: v.items.map((x) => val(x, key, idx)) };
      case 'call': {
        if (v.name === 'offset') return { ...v, args: [val(v.args[0]), negate(v.args[1]), v.args[2]] };
        if ((v.name === 'pt' || v.name === 'p') && v.args[0]?.kind === 'num') return { ...v, args: [{ kind: 'num', value: 2 * bp.symmetry.axis - v.args[0].value }, v.args[1]] };
        return { ...v, args: v.args.map((x) => val(x, key, idx)) };
      }
      default: return v;
    }
  };
  const negate = (v) => (v?.kind === 'num' ? { ...v, value: -v.value } : v ? { kind: 'neg', e: v } : v);
  const node = (n) => ({
    ...n, name: n.name ? swapLR(n.name) : n.name,
    args: n.args.map((a, i) => val(a, n.type, i)),
    props: n.props.map((p) => ({ ...p, values: p.values.map((v, i) => val(v, p.key, i)) })),
    children: n.children.map(node),
  });
  return node(ast);
}
