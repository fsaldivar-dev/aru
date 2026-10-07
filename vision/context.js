// VisualContext: what a vision model is allowed to say about an image. Context only, never geometry to draw.
//
// {
//   "version": 1, "scene": "stylized vector illustration",
//   "background": { "importance": 0.15, "label": "sky" },
//   "objects": [ Node ],
//   "relations": [ { "type": "symmetric", "a": "wolf.leftEye", "b": "wolf.rightEye" } ]
// }
// Node = { id, type, label?, importance 0..1, bounds? [x,y,w,h], polygon? [[x,y]...], mask? {width,height,rle|data},
//          preserve?, ignore?, colorHint?, parts?: [Node],
//          visualIntent?: { geometry: geometric|organic|organic-clean|circular|linear|mixed, edge: sharp|smooth|irregular|analytic,
//                           detail: low|medium|high, symmetry: paired|none } }
// All coordinates are normalized to the image (0..1), so a context is resolution independent.
// A node without geometry (e.g. a "fur" texture) applies to its parent's area without overriding sibling parts.

const FORBIDDEN = ['path', 'paths', 'd', 'svg', 'bezier', 'commands', 'curve', 'image', 'pixels'];

export function validateContext(ctx) {
  const errors = [];
  if (!ctx || typeof ctx !== 'object') return ['context must be an object'];
  if (!Array.isArray(ctx.objects)) errors.push('context.objects must be an array');
  const seen = new Set();
  const visit = (n, where) => {
    if (!n.id || typeof n.id !== 'string') errors.push(`${where}: node needs a string id`);
    for (const k of FORBIDDEN) if (k in n) errors.push(`${where}.${n.id}: '${k}' is not allowed — vision provides context, the tracer produces geometry`);
    if (n.importance !== undefined && !(n.importance >= 0 && n.importance <= 1)) errors.push(`${where}.${n.id}: importance must be within 0..1`);
    if (n.bounds && !(Array.isArray(n.bounds) && n.bounds.length === 4)) errors.push(`${where}.${n.id}: bounds must be [x, y, w, h]`);
    if (n.polygon && !(Array.isArray(n.polygon) && n.polygon.length >= 3)) errors.push(`${where}.${n.id}: polygon needs >= 3 points`);
    const p = `${where}.${n.id}`;
    if (seen.has(p)) errors.push(`${p}: duplicate id`);
    seen.add(p);
    for (const c of n.parts || []) visit(c, p);
  };
  for (const o of ctx.objects || []) visit(o, 'objects');
  return errors;
}

// Deep copy with defaults, dotted paths, depth and parent links. Returns { ...ctx, nodes: flat list }
export function normalizeContext(ctx) {
  const copy = JSON.parse(JSON.stringify(ctx));
  copy.background = { importance: 0.15, label: 'background', ...(copy.background || {}) };
  copy.relations = copy.relations || [];
  const nodes = [];
  const visit = (n, parent, depth) => {
    n.path = parent ? `${parent.path}.${n.id}` : n.id;
    n.depth = depth; n.parentPath = parent?.path ?? null;
    n.importance = n.importance ?? parent?.importance ?? 0.5;
    // visualIntent: small generic hints (geometry, edge, detail, symmetry); inherited, overridable per part
    n.visualIntent = { ...(parent?.visualIntent || {}), ...(n.visualIntent || {}) };
    n.type = n.type || 'part';
    n.hasShape = !!(n.bounds || n.polygon || n.mask);
    n.shapeOwner = n.hasShape ? n : parent?.shapeOwner ?? null; // geometry-less nodes use their parent's shape
    n.index = nodes.length;
    nodes.push(n);
    for (const c of n.parts || []) visit(c, n, depth + 1);
  };
  for (const o of copy.objects) visit(o, null, 0);
  Object.defineProperty(copy, 'nodes', { value: nodes, enumerable: false });
  return copy;
}

// is normalized point (x, y) inside the node's shape? polygon > mask > bounds
export function nodeContains(n, x, y) {
  const s = n.shapeOwner;
  if (!s) return false;
  if (s.polygon) return insidePolygon(s.polygon, x, y);
  if (s.mask) return maskAt(s.mask, x, y);
  const [bx, by, bw, bh] = s.bounds;
  return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
}
export function nodeBounds(n) {
  const s = n.shapeOwner;
  if (!s) return [0, 0, 1, 1];
  if (s.bounds) return s.bounds;
  if (s.polygon) { const xs = s.polygon.map((p) => p[0]), ys = s.polygon.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; }
  return [0, 0, 1, 1];
}
function insidePolygon(poly, x, y) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}
// mask: { width, height, data: [0/1...] } or run-length { width, height, rle: [zeros, ones, zeros, ...] } (row-major)
function maskAt(m, x, y) {
  if (!m._bits) {
    const bits = new Uint8Array(m.width * m.height);
    if (m.data) bits.set(m.data);
    else { let p = 0, v = 0; for (const run of m.rle) { bits.fill(v, p, p + run); p += run; v ^= 1; } }
    Object.defineProperty(m, '_bits', { value: bits, enumerable: false });
  }
  const px = Math.min(m.width - 1, Math.floor(x * m.width)), py = Math.min(m.height - 1, Math.floor(y * m.height));
  return m._bits[py * m.width + px] === 1;
}

// User corrections: [{ path, rename?, importance?, bounds?, polygon?, preserve?, ignore? }]
export function applyCorrections(ctx, corrections = []) {
  const copy = JSON.parse(JSON.stringify(ctx));
  const find = (path) => {
    const ids = path.split('.');
    let list = copy.objects, node = null;
    for (const id of ids) { node = (list || []).find((n) => n.id === id); if (!node) return null; list = node.parts; }
    return node;
  };
  for (const c of corrections) {
    const n = find(c.path);
    if (!n) continue;
    for (const k of ['importance', 'bounds', 'polygon', 'preserve', 'ignore', 'type', 'label']) if (c[k] !== undefined) n[k] = c[k];
    if (c.rename) n.id = c.rename;
  }
  return copy;
}
