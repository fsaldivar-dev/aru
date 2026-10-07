// Stage 7: traced regions -> Geometric Scene Graph (the existing ARU Geometry level).
// Each region becomes one `path` whose outline is assembled from the shared, fitted chains.
// Paint order: containment depth first (parents under children), then area descending. With mode 'stack'
// a region is filled without its holes (its children cover them exactly), which avoids anti-aliasing seams;
// mode 'cut' emits holes as extra subpaths instead.
import { parse } from '../src/parser.js';
import { buildScene, materialize } from '../src/scene.js';
import { toAru } from '../src/serialize.js';

const r2 = (v) => Math.round(v * 100) / 100;

export function loopCommands(loop, fits, k) {
  const cmds = [];
  for (const ref of loop.refs) {
    const f = fits[ref.chain];
    const segs = ref.reversed ? reverseSegs(f) : { start: f.start, segs: f.segs };
    if (!cmds.length) cmds.push({ cmd: 'move', args: [r2(segs.start[0] * k), r2(segs.start[1] * k)] });
    for (const s of segs.segs) {
      if (s.t === 'L') cmds.push({ cmd: 'line', args: [r2(s.p[0] * k), r2(s.p[1] * k)] });
      else cmds.push({ cmd: 'curve', args: [s.c1, s.c2, s.p].flat().map((v) => r2(v * k)) });
    }
  }
  cmds.push({ cmd: 'close', args: [] });
  return cmds;
}
export function reverseSegs(f) {
  const pts = [f.start, ...f.segs.map((s) => s.p)];
  const out = [];
  for (let i = f.segs.length - 1; i >= 0; i--) {
    const s = f.segs[i], to = pts[i];
    out.push(s.t === 'L' ? { t: 'L', p: to } : { t: 'C', c1: s.c2, c2: s.c1, p: to });
  }
  return { start: pts[pts.length - 1], segs: out };
}

export function compileTrace(T, { outWidth, outHeight, mode = 'stack', name = 'trace' } = {}) {
  const k = outWidth / T.width;
  const regions = [...T.regions].sort((a, b) => a.depth - b.depth || b.area - a.area);
  const bg = regions.filter((r) => r.depth === 0).sort((a, b) => b.area - a.area)[0]?.sourceColor || '#FFFFFF';
  const children = regions.map((r) => {
    const cmds = loopCommands(r.outer, T.fits, k);
    if (mode === 'cut') for (const h of r.holeLoops) cmds.push(...loopCommands(h, T.fits, k));
    return {
      type: 'path', name: `region${String(r.id).padStart(3, '0')}`, fill: r.sourceColor, geom: { commands: cmds },
      meta: {
        sourceColor: r.sourceColor, paletteColor: r.paletteColor, area: r.area * k * k, bounds: r.bounds.map((v) => r2(v * k)), centroid: r.centroid.map((v) => r2(v * k)),
        parent: r.parent === null ? null : `region${String(r.parent).padStart(3, '0')}`, holes: r.holes, depth: r.depth, traceError: r2(r.traceError * k),
      },
    };
  });
  const { ast } = parse(`canvas ${Math.round(outWidth)} ${Math.round(outHeight)}\nbackground ${bg}`);
  const scene = buildScene(ast);
  const env = { vars: {}, seedPath: [], names: new Map(), scene, depth: 0, generated: true, repeatNames: false };
  const root = materialize({ type: 'group', name, children, meta: { tracer: 'ReferenceTracer v1' } }, scene.root, env);
  root.semantic = 'trace.reference';
  return { scene, aru: toAru(scene, { precision: 2 }) };
}

// Semantic compilation: regions grouped by their VisualContext node (wolf > head > leftEye > iris > amber).
// Grouping changes paint order, so every region is emitted WITH its holes (cut mode): regions then tile the
// picture without overlapping and any order is correct. Stable geometric ids are kept in meta.geomId.
export function compileSemantic(T, assign, ctx, { outWidth, outHeight, seamStroke = 0.6 } = {}) {
  const k = outWidth / T.width;
  const gradients = {};
  const groups = new Map();
  const groupFor = (path, node) => {
    if (groups.has(path)) return groups.get(path);
    const g = { type: 'group', name: path.split('.').pop(), semantic: path, meta: { partType: node?.type ?? 'background', importance: node?.importance ?? ctx.background.importance }, children: [], _order: node ? node.index : -1 };
    groups.set(path, g);
    if (node?.parentPath) groupFor(node.parentPath, ctx.nodes.find((x) => x.path === node.parentPath)).children.push(g);
    return g;
  };
  const regions = [...T.regions].sort((a, b) => a.depth - b.depth || b.area - a.area);
  for (const r of regions) {
    const a = assign.get(r.id);
    const g = groupFor(a.path, a.node);
    const cmds = loopCommands(r.outer, T.fits, k);
    for (const h of r.holeLoops) cmds.push(...loopCommands(h, T.fits, k));
    const geomId = `region${String(r.id).padStart(3, '0')}`;
    let paint = r.sourceColor;
    if (r.gradient) { // linear gradient in canvas coordinates
      const gr = r.gradient; paint = `ramp${geomId.slice(6)}`;
      gradients[paint] = { type: 'linear', angle: 0, cx: 0.5, cy: 0.5, r: 0.5, user: { x1: r2(gr.x1 * k), y1: r2(gr.y1 * k), x2: r2(gr.x2 * k), y2: r2(gr.y2 * k) }, stops: [{ pos: 0, color: hex6(gr.c0), opacity: 1 }, { pos: 1, color: hex6(gr.c1), opacity: 1 }] };
    }
    g.children.push({
      type: 'path', name: a.colorName, fill: paint, semantic: a.path, role: a.role, geom: { commands: cmds },
      // a hairline stroke in the fill color hides anti-aliasing seams between exactly-touching regions
      ...(seamStroke ? { stroke: paint, strokeWidth: seamStroke, join: 'round' } : {}),
      meta: {
        geomId, semantic: a.path, partType: a.node?.type ?? 'background', role: a.role, confidence: Math.round(a.overlap * 100) / 100, assignedBy: a.via,
        sourceColor: r.sourceColor, area: r.area * k * k, bounds: r.bounds.map((v) => r2(v * k)), centroid: r.centroid.map((v) => r2(v * k)),
        parent: r.parent === null ? null : `region${String(r.parent).padStart(3, '0')}`, holes: r.holes, depth: r.depth, traceError: r2(r.traceError * k),
      },
    });
  }
  const roots = [...groups.values()].filter((g) => !g.semantic.includes('.')).sort((a, b) => a._order - b._order);
  const bg = regions.filter((r) => r.depth === 0).sort((a, b) => b.area - a.area)[0]?.sourceColor || '#FFFFFF';
  const { ast } = parse(`canvas ${Math.round(outWidth)} ${Math.round(outHeight)}\nbackground ${bg}`);
  const scene = buildScene(ast);
  Object.assign(scene.gradients, gradients);
  const env = { vars: {}, seedPath: [], names: new Map(), scene, depth: 0, generated: true, repeatNames: false };
  for (const g of roots) materialize(g, scene.root, env);
  return { scene, aru: toAru(scene, { precision: 2 }) };
}

const hex6 = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
