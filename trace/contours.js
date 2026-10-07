// Stage 4: contour extraction on the pixel-crack grid.
//
// Boundaries run along pixel edges (grid vertices are pixel corners), so they are exact.
// Instead of tracing each region independently, we extract SHARED chains: maximal runs of boundary edges
// between two junctions (vertices where 3+ boundary edges meet). Each chain separates exactly two regions
// (or a region and the image outside, id -1). Every region's outline is then assembled from the chains it
// touches, so neighbouring regions reuse the *same* simplified geometry: no gaps, no overlaps.
//
// Orientation convention (y down): walking a chain, `right` is the region on the right-hand side.
// A region's outer loop runs clockwise on screen (positive shoelace area), its holes counter-clockwise.

export function extractContours(reg) {
  const { width: W, height: H, ids } = reg;
  const id = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : ids[y * W + x]);
  // boundary edges: horizontal edge (x,y)-(x+1,y) separates (x,y-1)|(x,y); vertical (x,y)-(x,y+1) separates (x-1,y)|(x,y)
  const hB = (x, y) => x >= 0 && x < W && y >= 0 && y <= H && id(x, y - 1) !== id(x, y);
  const vB = (x, y) => x >= 0 && x <= W && y >= 0 && y < H && id(x - 1, y) !== id(x, y);
  const hSeen = new Uint8Array(W * (H + 1)), vSeen = new Uint8Array((W + 1) * H);
  // the 4 possible edges at vertex (x,y): E, S, W, N
  const edgesAt = (x, y) => {
    const e = [];
    if (hB(x, y)) e.push({ d: [1, 0], key: ['h', x, y] });
    if (vB(x, y)) e.push({ d: [0, 1], key: ['v', x, y] });
    if (hB(x - 1, y)) e.push({ d: [-1, 0], key: ['h', x - 1, y] });
    if (vB(x, y - 1)) e.push({ d: [0, -1], key: ['v', x, y - 1] });
    return e;
  };
  const seen = ([t, x, y]) => (t === 'h' ? hSeen[y * W + x] : vSeen[y * (W + 1) + x]);
  const mark = ([t, x, y]) => { if (t === 'h') hSeen[y * W + x] = 1; else vSeen[y * (W + 1) + x] = 1; };
  const isJunction = (x, y) => edgesAt(x, y).length >= 3;
  // regions on each side of a directed unit edge from (x,y) with direction (dx,dy)
  const sides = (x, y, dx, dy) => ({
    right: id(Math.floor(x + dx / 2 - dy / 2), Math.floor(y + dy / 2 + dx / 2)),
    left: id(Math.floor(x + dx / 2 + dy / 2), Math.floor(y + dy / 2 - dx / 2)),
  });

  const chains = [];
  const walk = (x0, y0, first, atJunction) => {
    const pts = [[x0, y0]];
    let x = x0, y = y0, e = first;
    const s = sides(x0, y0, e.d[0], e.d[1]);
    for (;;) {
      mark(e.key);
      x += e.d[0]; y += e.d[1];
      pts.push([x, y]);
      if ((x === x0 && y === y0) || isJunction(x, y)) break;
      const next = edgesAt(x, y).find((c) => !seen(c.key));
      if (!next) break;
      e = next;
    }
    const closed = pts.length > 2 && pts[0][0] === x && pts[0][1] === y;
    chains.push({ id: chains.length, points: pts, closed, atJunction, right: s.right, left: s.left });
  };
  // 1) chains that start at junctions
  for (let y = 0; y <= H; y++) for (let x = 0; x <= W; x++) {
    if (!isJunction(x, y)) continue;
    for (const e of edgesAt(x, y)) if (!seen(e.key)) walk(x, y, e, true);
  }
  // 2) remaining closed loops without any junction (islands)
  for (let y = 0; y <= H; y++) for (let x = 0; x <= W; x++) for (const e of edgesAt(x, y)) if (!seen(e.key)) walk(x, y, e, false);

  // ---- assemble region loops from oriented chains ----
  const byRegion = new Map();
  for (const c of chains) for (const [rid, reversed] of [[c.right, false], [c.left, true]]) {
    if (rid < 0) continue;
    if (!byRegion.has(rid)) byRegion.set(rid, []);
    byRegion.get(rid).push({ chain: c.id, reversed });
  }
  const pts = (ref) => (ref.reversed ? [...chains[ref.chain].points].reverse() : chains[ref.chain].points);
  const loopsOf = new Map();
  for (const [rid, refs] of byRegion) {
    const start = new Map();
    for (const r of refs) { const p = pts(r)[0], k = p[0] + ',' + p[1]; if (!start.has(k)) start.set(k, []); start.get(k).push(r); }
    const used = new Set(), loops = [];
    for (const r0 of refs) {
      if (used.has(r0)) continue;
      used.add(r0);
      const loop = [r0];
      let cur = pts(r0);
      const origin = cur[0];
      let guard = 0;
      while (!(cur[cur.length - 1][0] === origin[0] && cur[cur.length - 1][1] === origin[1]) && guard++ < 100000) {
        const end = cur[cur.length - 1], cands = (start.get(end[0] + ',' + end[1]) || []).filter((r) => !used.has(r));
        if (!cands.length) break;
        // at a pinch vertex the region touches itself: take the sharpest right turn (keeps 4-connected loops apart)
        const din = [end[0] - cur[cur.length - 2][0], end[1] - cur[cur.length - 2][1]];
        let best = cands[0], bestA = -Infinity;
        for (const c of cands) { const p = pts(c), dout = [p[1][0] - p[0][0], p[1][1] - p[0][1]]; const a = Math.atan2(din[0] * dout[1] - din[1] * dout[0], din[0] * dout[0] + din[1] * dout[1]); if (a > bestA) { bestA = a; best = c; } }
        used.add(best); loop.push(best); cur = pts(best);
      }
      const poly = loop.flatMap((r) => pts(r).slice(0, -1));
      loops.push({ refs: loop, area: shoelace(poly), poly });
    }
    loops.sort((a, b) => b.area - a.area);
    loopsOf.set(rid, { outer: loops[0], holes: loops.slice(1).filter((l) => l.area < 0) });
  }

  // ---- hierarchy: parent = region owning the smallest hole that contains this region ----
  const holes = [];
  for (const [rid, L] of loopsOf) for (const h of L.holes) holes.push({ rid, area: -h.area, poly: h.poly, bb: bbox(h.poly) });
  for (const r of reg.regions) {
    const L = loopsOf.get(r.id);
    r.outer = L.outer; r.holeLoops = L.holes; r.holes = L.holes.length;
    const fx = r.firstPixel % W, fy = (r.firstPixel - fx) / W, p = [fx + 0.5, fy + 0.5];
    let parent = null, pa = Infinity;
    for (const h of holes) {
      if (h.rid === r.id || h.area >= pa || p[0] < h.bb[0] || p[0] > h.bb[2] || p[1] < h.bb[1] || p[1] > h.bb[3]) continue;
      if (inside(h.poly, p)) { parent = h.rid; pa = h.area; }
    }
    r.parent = parent;
  }
  const byId = new Map(reg.regions.map((r) => [r.id, r]));
  for (const r of reg.regions) { let d = 0, p = r.parent; while (p !== null && d < 1000) { d++; p = byId.get(p).parent; } r.depth = d; }
  const rawPoints = chains.reduce((s, c) => s + c.points.length - 1, 0);
  return { chains, rawPoints };
}

export function shoelace(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
function bbox(p) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const [x, y] of p) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; } return [a, b, c, d]; }
export function inside(poly, [x, y]) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}
