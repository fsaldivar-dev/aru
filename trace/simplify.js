// Stage 5: contour simplification.
// (a) densify: a crack chain is a staircase of unit edges; we replace it by the polyline through the edge
//     midpoints (endpoints/junctions kept), which removes the 90° pixel steps without moving the boundary
//     by more than half a pixel. This dense polyline is the reference every later error is measured against.
// (b) Douglas–Peucker with tolerance ε (pixels), endpoints fixed. Closed loops are split at the point
//     farthest from their start so DP has two fixed anchors.

export function densify(chain) {
  const p = chain.points, n = p.length;
  const mids = [];
  for (let i = 0; i + 1 < n; i++) mids.push([(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2]);
  if (chain.closed && !chain.atJunction) return [...mids, mids[0]]; // island loop: no fixed vertex, start anywhere
  return [p[0], ...mids, p[n - 1]];
}

export function douglasPeucker(pts, eps, a = 0, b = pts.length - 1) {
  const keep = new Uint8Array(pts.length);
  keep[a] = keep[b] = 1;
  const stack = [[a, b]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j <= i + 1) continue;
    let dmax = -1, idx = -1;
    for (let k = i + 1; k < j; k++) { const d = segDist(pts[k], pts[i], pts[j]); if (d > dmax) { dmax = d; idx = k; } }
    if (dmax > eps) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  const out = [];
  for (let k = a; k <= b; k++) if (keep[k]) out.push(k);
  return out;
}

export function simplifyChain(chain, eps) {
  const dense = densify(chain);
  const isLoop = dense.length > 3 && dense[0][0] === dense[dense.length - 1][0] && dense[0][1] === dense[dense.length - 1][1];
  let keep;
  if (isLoop) {
    let far = 1, fd = -1;
    for (let k = 1; k < dense.length - 1; k++) { const d = Math.hypot(dense[k][0] - dense[0][0], dense[k][1] - dense[0][1]); if (d > fd) { fd = d; far = k; } }
    const k1 = douglasPeucker(dense, eps, 0, far), k2 = douglasPeucker(dense, eps, far, dense.length - 1);
    keep = [...k1, ...k2.slice(1)];
  } else keep = douglasPeucker(dense, eps);
  return { dense, keep, isLoop };
}

export function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
