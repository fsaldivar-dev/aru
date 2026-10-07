// Region Adjacency Graph + region statistics.
// Each node: area, sums for mean Lab, neighbors Map(id -> shared boundary length), perimeter, bounds,
// importance (mean / max), semantic owner (majority context node), preserve flag. Nodes merge in O(degree).
import { rgbToLab } from './quantize.js';

export function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f3 = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = f3(fx) * 0.95047, Y = f3(fy), Z = f3(fz) * 1.08883;
  const lin = [X * 3.2406 + Y * -1.5372 + Z * -0.4986, X * -0.9689 + Y * 1.8758 + Z * 0.0415, X * 0.0557 + Y * -0.204 + Z * 1.057];
  return lin.map((c) => Math.max(0, Math.min(255, Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)))));
}
export const deltaE = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

export function buildRAG(ids, W, H, lab, imp) {
  const nodes = new Map();
  const node = (id) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, area: 0, L: 0, A: 0, B: 0, impSum: 0, impMax: 0, owners: new Map(), preserve: false, perimeter: 0, neighbors: new Map(), x0: W, y0: H, x1: 0, y1: 0, first: -1 }));
    return n;
  };
  for (let i = 0; i < ids.length; i++) {
    const n = node(ids[i]), x = i % W, y = (i - x) / W;
    if (n.first < 0) n.first = i;
    n.area++; n.L += lab[i * 3]; n.A += lab[i * 3 + 1]; n.B += lab[i * 3 + 2];
    const v = imp.map[i]; n.impSum += v; if (v > n.impMax) n.impMax = v;
    n.owners.set(imp.owner[i], (n.owners.get(imp.owner[i]) || 0) + 1);
    if (imp.preserve[i]) n.preserve = true;
    if (x < n.x0) n.x0 = x; if (x > n.x1) n.x1 = x; if (y < n.y0) n.y0 = y; if (y > n.y1) n.y1 = y;
    // boundaries (right and down neighbours; image border counts toward perimeter)
    if (x === 0 || x === W - 1) n.perimeter++;
    if (y === 0 || y === H - 1) n.perimeter++;
    for (const j of [x < W - 1 ? i + 1 : -1, y < H - 1 ? i + W : -1]) {
      if (j < 0 || ids[j] === ids[i]) continue;
      const m = node(ids[j]);
      n.neighbors.set(m.id, (n.neighbors.get(m.id) || 0) + 1); m.neighbors.set(n.id, (m.neighbors.get(n.id) || 0) + 1);
      n.perimeter++; m.perimeter++;
    }
  }
  return nodes;
}
export const meanLab = (n) => [n.L / n.area, n.A / n.area, n.B / n.area];
export const ownerOf = (n) => { let o = -1, c = -1; for (const [k, v] of n.owners) if (v > c) { c = v; o = k; } return o; };

// merge node a into node b (b survives)
export function mergeNodes(nodes, a, b) {
  const shared = a.neighbors.get(b.id) || 0;
  b.area += a.area; b.L += a.L; b.A += a.A; b.B += a.B; b.impSum += a.impSum; b.impMax = Math.max(b.impMax, a.impMax);
  for (const [k, v] of a.owners) b.owners.set(k, (b.owners.get(k) || 0) + v);
  b.preserve = b.preserve || a.preserve;
  b.perimeter = b.perimeter + a.perimeter - 2 * shared;
  b.x0 = Math.min(b.x0, a.x0); b.y0 = Math.min(b.y0, a.y0); b.x1 = Math.max(b.x1, a.x1); b.y1 = Math.max(b.y1, a.y1);
  b.first = Math.min(b.first, a.first);
  for (const [nid, len] of a.neighbors) {
    if (nid === b.id) continue;
    const n = nodes.get(nid);
    n.neighbors.delete(a.id);
    n.neighbors.set(b.id, (n.neighbors.get(b.id) || 0) + len);
    b.neighbors.set(nid, (b.neighbors.get(nid) || 0) + len);
  }
  b.neighbors.delete(a.id);
  if (a.grad || b.grad) b.grad = b.grad || a.grad;
  nodes.delete(a.id);
}

// Rebuild the `reg` structure expected by the tracer from a relabelled id map
export function regionsFromIds(ids, W, H, img, labelOf, paletteHex, hex) {
  const map = new Map();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]; let r = map.get(id);
    if (!r) map.set(id, (r = { id, area: 0, x0: W, y0: H, x1: 0, y1: 0, sx: 0, sy: 0, acc: [0, 0, 0, 0], all: [0, 0, 0, 0], first: i }));
    const x = i % W, y = (i - x) / W;
    r.area++; r.sx += x + 0.5; r.sy += y + 0.5;
    if (x < r.x0) r.x0 = x; if (x > r.x1) r.x1 = x; if (y < r.y0) r.y0 = y; if (y > r.y1) r.y1 = y;
    const interior = x > 0 && x < W - 1 && y > 0 && y < H - 1 && ids[i - 1] === id && ids[i + 1] === id && ids[i - W] === id && ids[i + W] === id;
    const T = interior ? r.acc : r.all;
    T[0] += img.data[i * 4]; T[1] += img.data[i * 4 + 1]; T[2] += img.data[i * 4 + 2]; T[3]++;
  }
  return [...map.values()].map((r) => {
    const src = r.acc[3] ? r.acc : r.all;
    const color = [src[0] / src[3], src[1] / src[3], src[2] / src[3]];
    return { id: r.id, label: labelOf(r.id), area: r.area, bounds: [r.x0, r.y0, r.x1 + 1, r.y1 + 1], centroid: [r.sx / r.area, r.sy / r.area], firstPixel: r.first, color, sourceColor: hex(color), paletteColor: paletteHex[labelOf(r.id)] ?? hex(color) };
  });
}
export { rgbToLab };
