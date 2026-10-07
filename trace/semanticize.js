// Semanticization: attach every traced region to the most specific VisualContext node it belongs to.
// The tracer never needed to know what an iris is; this step only labels geometry that already exists.
//   overlap    = share of the region's pixels inside the node's shape (bounds / polygon / mask)
//   choose     = deepest node with overlap >= 0.6 (ties: smaller node); else best node with overlap >= 0.3
//   containment: a region left unassigned inherits the node of its geometric parent region
//   name       = nearest generic color name (amber, black, white...), so `wolf.head.leftEye.iris.amber`
import { nodeContains, nodeBounds } from '../vision/context.js';
import { rgbToLab } from './quantize.js';

const COLOR_NAMES = {
  black: '#111111', charcoal: '#333338', gray: '#808080', silver: '#C0C0C0', white: '#F5F5F5', cream: '#F0E6D2', beige: '#D8C3A5',
  brown: '#7B4A2E', darkBrown: '#4A2C20', red: '#C0392B', orange: '#E67E22', amber: '#F0A030', yellow: '#F1C40F', green: '#3C9A4A',
  teal: '#1F8A8A', cyan: '#7FD3DD', lightBlue: '#A9CCE3', blue: '#2E6FD8', navy: '#1B2A4A', purple: '#7D3C98', pink: '#E58FB0', slate: '#4A5A66',
};
const NAMED = Object.entries(COLOR_NAMES).map(([k, h]) => [k, rgbToLab(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16))]);
export function colorName(rgb) {
  const l = rgbToLab(...rgb);
  let best = 'color', bd = Infinity;
  for (const [k, c] of NAMED) { const d = Math.hypot(l[0] - c[0], l[1] - c[1], l[2] - c[2]); if (d < bd) { bd = d; best = k; } }
  return best;
}

export function semanticize(T, ctx) {
  const W = T.width, H = T.height;
  const samples = new Map();
  const counts = new Map(T.regions.map((r) => [r.id, 0]));
  for (let i = 0; i < T.ids.length; i++) counts.set(T.ids[i], counts.get(T.ids[i]) + 1);
  const seen = new Map();
  for (let i = 0; i < T.ids.length; i++) {
    const id = T.ids[i], step = Math.max(1, Math.floor(counts.get(id) / 200));
    const k = seen.get(id) || 0; seen.set(id, k + 1);
    if (k % step) continue;
    if (!samples.has(id)) samples.set(id, []);
    samples.get(id).push(i);
  }
  const nodes = ctx.nodes.filter((n) => !n.ignore && n.shapeOwner);
  const area = (n) => { const b = nodeBounds(n); return b[2] * b[3]; };
  const out = new Map();
  for (const r of T.regions) {
    const px = samples.get(r.id) || [];
    let best = null, bestScore = -1, fallback = null, fo = 0;
    for (const n of nodes) {
      let inside = 0;
      for (const i of px) { const x = i % W, y = (i - x) / W; if (nodeContains(n, (x + 0.5) / W, (y + 0.5) / H)) inside++; }
      const ov = inside / Math.max(1, px.length);
      if (ov >= 0.6) { const score = n.depth * 10 - area(n); if (score > bestScore) { bestScore = score; best = { n, ov }; } }
      else if (ov >= 0.3 && ov > fo) { fo = ov; fallback = { n, ov }; }
    }
    const pick = best || fallback;
    out.set(r.id, { path: pick ? pick.n.path : 'background', node: pick ? pick.n : null, overlap: pick ? pick.ov : 0, colorName: colorName(r.color), via: best ? 'overlap' : fallback ? 'partial-overlap' : 'none' });
  }
  // containment: unassigned regions inherit their geometric parent's node
  const byId = new Map(T.regions.map((r) => [r.id, r]));
  for (const r of T.regions) {
    const a = out.get(r.id);
    if (a.node || r.parent === null) continue;
    let p = byId.get(r.parent);
    while (p && !out.get(p.id).node && p.parent !== null) p = byId.get(p.parent);
    const pa = p && out.get(p.id);
    if (pa?.node) Object.assign(a, { path: pa.path, node: pa.node, via: 'containment' });
  }
  // role inside each part: regions of the part's dominant color are `primary`, the rest `detail`
  const byPath = new Map();
  // weight = area × overlap²: a region spilling out of the part (eyelid crossing an iris box) is not its body
  for (const r of T.regions) { const a = out.get(r.id); if (!byPath.has(a.path)) byPath.set(a.path, new Map()); const m = byPath.get(a.path); m.set(a.colorName, (m.get(a.colorName) || 0) + r.area * (a.overlap || 0) ** 2); }
  for (const r of T.regions) {
    const a = out.get(r.id), m = byPath.get(a.path);
    let dom = null, da = -1; for (const [k, v] of m) if (v > da) { da = v; dom = k; }
    a.role = a.colorName === dom ? 'primary' : 'detail';
  }
  return out;
}
