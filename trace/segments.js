// Pieces for semantic grouping ("Set-of-Mark"): the ~300 traced regions are merged into ~30 coherent PIECES, which
// are drawn numbered over the image so a vision model can say which part each piece belongs to. The AI names, the
// tracer cuts: piece boundaries always follow traced region boundaries.
//
// Agglomerative merge on the region adjacency graph, cheapest edge first:
//   cost = ΔE(piece colors) · (1 + 3·inkBarrier) · sizeFactor
//   inkBarrier = share of the shared boundary covered by ink (line art: outlines separate objects)
//   sizeFactor = min(1, sqrt(smaller area / 0.5 % of the image))  — tiny pieces merge first
// Deterministic (ties by ids). Each piece gets an anchor: its pixel farthest from any piece boundary (label spot).
import { rgbToLab } from './quantize.js';

export function buildSegments(T, { target = 30, inkMask = null, inkW = 0, inkH = 0 } = {}) {
  const W = T.width, H = T.height, N = W * H, ids = T.ids;
  const regs = T.regions, idx = new Map(regs.map((r, k) => [r.id, k]));
  const n = regs.length;
  const area = regs.map((r) => r.area), lab = regs.map((r) => rgbToLab(...r.color));
  const inkAt = (x, y) => (inkMask ? inkMask[Math.min(inkH - 1, Math.floor((y + 0.5) * inkH / H)) * inkW + Math.min(inkW - 1, Math.floor((x + 0.5) * inkW / W))] : 0);
  // adjacency: boundary length and inked boundary per region pair
  const adj = new Map(); // key a*n+b (a<b) -> [len, inked]
  const touch = (i, j, x, y) => {
    const a = idx.get(ids[i]), b = idx.get(ids[j]); if (a === b || a === undefined || b === undefined) return;
    const k = a < b ? a * n + b : b * n + a, e = adj.get(k) || [0, 0];
    e[0]++; if (inkAt(x, y)) e[1]++; adj.set(k, e);
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (x < W - 1) touch(i, i + 1, x, y); if (y < H - 1) touch(i, i + W, x, y); }
  // pieces (union-find) with area-weighted Lab and adjacency maps
  const par = [...Array(n).keys()], find = (a) => (par[a] === a ? a : (par[a] = find(par[a])));
  const pArea = area.slice(), pLab = lab.map((l, k) => l.map((v) => v * area[k]));
  const nb = Array.from({ length: n }, () => new Map()); // piece -> neighbour piece -> [len, inked]
  for (const [k, e] of adj) { const a = Math.floor(k / n), b = k % n; nb[a].set(b, e.slice()); nb[b].set(a, e.slice()); }
  const total = area.reduce((s, v) => s + v, 0);
  const colorOf = (p) => pLab[p].map((v) => v / pArea[p]);
  const cost = (a, b, e) => {
    const ca = colorOf(a), cb = colorOf(b);
    const dE = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
    const barrier = e[1] / Math.max(1, e[0]);
    const size = Math.min(1, Math.sqrt(Math.min(pArea[a], pArea[b]) / (0.005 * total)));
    return dE * (1 + 3 * barrier) * size;
  };
  let count = n;
  while (count > target) {
    let best = null, bc = Infinity;
    for (let a = 0; a < n; a++) { if (find(a) !== a) continue; for (const [b, e] of nb[a]) { if (b < a) continue; const c = cost(a, b, e); if (c < bc - 1e-12) { bc = c; best = [a, b]; } } }
    if (!best) break;
    const [a, b] = best; // merge b into a
    par[b] = a; pArea[a] += pArea[b]; for (let k = 0; k < 3; k++) pLab[a][k] += pLab[b][k];
    for (const [c, e] of nb[b]) {
      if (c === a) continue;
      const cur = nb[a].get(c) || [0, 0], m = [cur[0] + e[0], cur[1] + e[1]];
      nb[a].set(c, m); nb[c].delete(b); nb[c].set(a, m);
    }
    nb[a].delete(b); nb[b] = new Map(); count--;
  }
  // number the pieces in reading order of their anchors
  const roots = [...new Set(regs.map((_, k) => find(k)))];
  const segPix = new Int32Array(N);
  for (let i = 0; i < N; i++) { const k = idx.get(ids[i]); segPix[i] = k === undefined ? -1 : find(k); }
  // distance to the nearest piece boundary (chamfer 3-4), anchor = farthest pixel of each piece
  const d = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, s = segPix[i];
    d[i] = x === 0 || y === 0 || x === W - 1 || y === H - 1 || segPix[i - 1] !== s || segPix[i + 1] !== s || segPix[i - W] !== s || segPix[i + W] !== s ? 0 : 1e9;
  }
  for (let y = 1; y < H; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (d[i]) d[i] = Math.min(d[i], d[i - 1] + 3, d[i - W] + 3, d[i - W - 1] + 4, d[i - W + 1] + 4); }
  for (let y = H - 2; y >= 0; y--) for (let x = W - 2; x >= 1; x--) { const i = y * W + x; if (d[i]) d[i] = Math.min(d[i], d[i + 1] + 3, d[i + W] + 3, d[i + W + 1] + 4, d[i + W - 1] + 4); }
  const anchor = new Map();
  for (let i = 0; i < N; i++) { const s = segPix[i]; if (s < 0) continue; const a = anchor.get(s); if (!a || d[i] > a.d) anchor.set(s, { d: d[i], x: i % W, y: (i / W) | 0 }); }
  roots.sort((p, q) => { const A = anchor.get(p), B = anchor.get(q); return Math.round(A.y / (H / 12)) - Math.round(B.y / (H / 12)) || A.x - B.x; });
  const number = new Map(roots.map((p, k) => [p, k + 1]));
  const segments = roots.map((p) => ({ id: number.get(p), area: pArea[p], color: colorOf(p), anchor: [anchor.get(p).x, anchor.get(p).y], radius: anchor.get(p).d / 3, regions: regs.filter((_, k) => find(k) === p).map((r) => r.id) }));
  const segOf = new Map(); for (const s of segments) for (const r of s.regions) segOf.set(r, s.id);
  const labels = new Int32Array(N); for (let i = 0; i < N; i++) labels[i] = segPix[i] < 0 ? 0 : number.get(segPix[i]);
  return { segments, segOf, labels, width: W, height: H };
}
