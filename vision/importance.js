// ImportanceMap: a continuous 0..1 map over the traced image built ONLY from the VisualContext.
// Painting order: background, then each node (parents before parts; geometry-less parts before shaped siblings),
// so the most specific node wins. Approximate shapes are feathered outward (max(original, blurred)) so that
// a slightly-too-small eye box still covers the eye's edge.
import { nodeContains } from './context.js';

export function importanceMap(ctx, W, H, { feather = 0.012 } = {}) {
  const N = W * H;
  const map = new Float32Array(N).fill(ctx.background.importance);
  const owner = new Int16Array(N).fill(-1);      // deepest context node per pixel (-1 = background)
  const preserve = new Uint8Array(N), ignore = new Uint8Array(N);
  const order = [...ctx.nodes].sort((a, b) => a.depth - b.depth || (a.hasShape - b.hasShape) || a.index - b.index);
  for (const n of order) {
    const s = n.shapeOwner;
    if (!s) continue;
    // scan only the node's bounding box
    let [bx, by, bw, bh] = s.bounds || bboxOf(s);
    const x0 = Math.max(0, Math.floor(bx * W)), x1 = Math.min(W, Math.ceil((bx + bw) * W)), y0 = Math.max(0, Math.floor(by * H)), y1 = Math.min(H, Math.ceil((by + bh) * H));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!nodeContains(n, (x + 0.5) / W, (y + 0.5) / H)) continue;
      const i = y * W + x;
      // `ignore` marks an overlaid artifact (watermark, compression noise): it does not lower the importance of
      // the content underneath, it only tells the tracer to drop small regions there and skip it semantically.
      if (n.ignore) { ignore[i] = 1; continue; }
      map[i] = n.importance;
      owner[i] = n.index;
      preserve[i] = n.preserve ? 1 : 0;
    }
  }
  const r = Math.max(1, Math.round(feather * Math.max(W, H)));
  const blurred = boxBlur(boxBlur(map, W, H, r), W, H, r);
  for (let i = 0; i < N; i++) if (blurred[i] > map[i]) map[i] = blurred[i];
  return { map, owner, preserve, ignore, width: W, height: H, at: (x, y) => map[Math.min(H - 1, Math.max(0, Math.floor(y))) * W + Math.min(W - 1, Math.max(0, Math.floor(x)))] };
}
function bboxOf(s) {
  if (s.polygon) { const xs = s.polygon.map((p) => p[0]), ys = s.polygon.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; }
  return [0, 0, 1, 1];
}
function boxBlur(src, W, H, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) { let acc = 0; const row = y * W; for (let x = -r; x < W; x++) { if (x + r < W) acc += src[row + x + r]; if (x - r - 1 >= 0) acc -= src[row + x - r - 1]; if (x >= 0) tmp[row + x] = acc / (Math.min(W - 1, x + r) - Math.max(0, x - r) + 1); } }
  for (let x = 0; x < W; x++) { let acc = 0; for (let y = -r; y < H; y++) { if (y + r < H) acc += tmp[(y + r) * W + x]; if (y - r - 1 >= 0) acc -= tmp[(y - r - 1) * W + x]; if (y >= 0) out[y * W + x] = acc / (Math.min(H - 1, y + r) - Math.max(0, y - r) + 1); } }
  return out;
}
