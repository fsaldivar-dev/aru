// Joint junction optimization. A junction (3+ chains meeting at one pixel corner) is moved as ONE entity: every
// incident chain receives the same new endpoint, so the shared topology is preserved exactly (no gaps, no overlaps).
//
//   for each junction J, candidates c on a 0.25 px grid within radius R:
//     junctionCost(c) = curvatureDiscontinuity  Σ dist(c, tangent line of each incident edge)²    (edges meet where they point)
//                     + pixelError proxy        λ · |c − J|² / R²                                 (stay near the measurement)
//                     + spikePenalty            wedges narrower than 18° between neighbouring edges
//                     + tinySegmentPenalty      an incident edge whose first stretch would become shorter than 1.5 px
//   hard constraints: |c − J| <= min(R, 0.45 · shortest incident chain); the cyclic order of incident edges is unchanged
// Moves are then validated with the pixels (rasterize, local window around each junction) by the caller.
import { bez } from './bezier.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], len = (v) => Math.hypot(v[0], v[1]);
export const vkey = (p) => `${p[0]},${p[1]}`;

// polyline of a fit, oriented FROM its start
export function fitPolyline(f) {
  const pts = [f.start];
  let cur = f.start;
  for (const s of f.segs) { if (s.t === 'L') pts.push(s.p); else { const b = [cur, s.c1, s.c2, s.p]; for (let i = 1; i <= 10; i++) pts.push(bez(b, i / 10)); } cur = s.p; }
  return pts;
}
// point at arc length `d` and samples in [d0, d1] from the start of a polyline
function walk(poly, d0, d1, dAnchor) {
  const out = []; let acc = 0, anchor = poly[poly.length - 1];
  let anchorSet = false;
  for (let i = 1; i < poly.length; i++) {
    const seg = len(sub(poly[i], poly[i - 1]));
    for (let t = 0.25; t <= seg && seg > 0; t += 0.5) {
      const d = acc + t, p = [poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t / seg, poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t / seg];
      if (d >= d0 && d <= d1) out.push(p);
      if (!anchorSet && d >= dAnchor) { anchor = p; anchorSet = true; }
    }
    acc += seg;
  }
  return { samples: out, anchor, length: acc };
}

export function findJunctions(chains, W, H) {
  const ends = new Map();
  chains.forEach((c, ci) => {
    if (c.closed && !c.atJunction) return;
    const a = c.points[0], b = c.points[c.points.length - 1];
    for (const [p, atStart] of [[a, true], [b, false]]) { const k = vkey(p); if (!ends.has(k)) ends.set(k, { p, ends: [] }); ends.get(k).ends.push({ ci, atStart }); }
  });
  const onBorder = (p) => p[0] <= 0 || p[1] <= 0 || p[0] >= W || p[1] >= H;
  return [...ends.values()].filter((j) => j.ends.length >= 3 && !onBorder(j.p));
}

export function optimizeJunctions(chains, fits, { W, H, radius = 3, lambda = 1.2, minGain = 0.15 } = {}) {
  const junctions = findJunctions(chains, W, H);
  const moves = new Map();
  let considered = 0, spikesBefore = 0, spikesAfter = 0;
  for (const J of junctions) {
    const rays = [];
    let minLen = Infinity;
    for (const e of J.ends) {
      const f = fits[e.ci];
      let poly = fitPolyline(f);
      if (!e.atStart) poly = poly.slice().reverse();
      const w = walk(poly, 2, 7, 4);
      minLen = Math.min(minLen, w.length);
      // tangent line of the edge, measured away from the junction (the first 2 px are where hooks live)
      let line = null;
      if (w.samples.length >= 3) {
        let mx = 0, my = 0; for (const p of w.samples) { mx += p[0]; my += p[1]; } mx /= w.samples.length; my /= w.samples.length;
        let sxx = 0, syy = 0, sxy = 0; for (const p of w.samples) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
        const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), n = [-Math.sin(th), Math.cos(th)];
        const resid = Math.sqrt(Math.max(0, (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy)) / w.samples.length);
        if (resid < 0.6) line = { m: [mx, my], n, w: Math.min(1, w.length / 6) };
      }
      rays.push({ anchor: w.anchor, line });
    }
    considered++;
    const R = Math.min(radius, 0.45 * minLen);
    if (R < 0.5) continue;
    const order = (c) => rays.map((r, i) => [Math.atan2(r.anchor[1] - c[1], r.anchor[0] - c[0]), i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const cyc = (o) => { const k = o.indexOf(0); return o.slice(k).concat(o.slice(0, k)).join(','); };
    const ord0 = cyc(order(J.p));
    const spikes = (c) => {
      const angs = rays.map((r) => Math.atan2(r.anchor[1] - c[1], r.anchor[0] - c[0])).sort((a, b) => a - b);
      let pen = 0, count = 0;
      for (let i = 0; i < angs.length; i++) { const g = ((i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI) - angs[i]) * 180 / Math.PI; if (g < 18) { pen += 2 * (18 - g) / 18; count++; } }
      return { pen, count };
    };
    const cost = (c) => {
      let k = 0;
      for (const r of rays) {
        if (r.line) { const d = (c[0] - r.line.m[0]) * r.line.n[0] + (c[1] - r.line.m[1]) * r.line.n[1]; k += r.line.w * d * d; }
        if (len(sub(r.anchor, c)) < 1.5) k += 2;
      }
      const dd = len(sub(c, J.p));
      return k + lambda * (dd * dd) / (R * R) + spikes(c).pen;
    };
    const c0 = cost(J.p);
    let best = J.p, bc = c0;
    for (let dy = -R; dy <= R + 1e-9; dy += 0.25) for (let dx = -R; dx <= R + 1e-9; dx += 0.25) {
      if (dx * dx + dy * dy > R * R) continue;
      const c = [J.p[0] + dx, J.p[1] + dy];
      if (c[0] <= 0 || c[1] <= 0 || c[0] >= W || c[1] >= H) continue;
      const v = cost(c);
      if (v < bc - 1e-9 && cyc(order(c)) === ord0) { bc = v; best = c; }
    }
    const s0 = spikes(J.p).count;
    spikesBefore += s0;
    if (best !== J.p && c0 - bc >= minGain && len(sub(best, J.p)) >= 0.25) { moves.set(vkey(J.p), { from: J.p, to: best, gain: c0 - bc, ends: J.ends }); spikesAfter += spikes(best).count; }
    else spikesAfter += s0;
  }
  return { moves, stats: { junctions: junctions.length, considered, proposed: moves.size, spikesBefore, spikesAfter } };
}

// move a fit's endpoints (keeps handle vectors: the control point next to a moved endpoint moves with it)
export function shiftFit(f, dStart, dEnd) {
  if (!dStart && !dEnd) return f;
  const segs = f.segs.map((s) => ({ ...s }));
  let start = f.start;
  if (dStart) { start = [start[0] + dStart[0], start[1] + dStart[1]]; if (segs[0].t === 'C') segs[0].c1 = [segs[0].c1[0] + dStart[0], segs[0].c1[1] + dStart[1]]; }
  if (dEnd) { const l = segs[segs.length - 1]; l.p = [l.p[0] + dEnd[0], l.p[1] + dEnd[1]]; if (l.t === 'C') l.c2 = [l.c2[0] + dEnd[0], l.c2[1] + dEnd[1]]; }
  return { ...f, start, segs };
}

// spikes in a set of fits: junction wedges narrower than 15° between neighbouring edges (measured 3 px out)
export function junctionSpikes(chains, fits, W, H) {
  let spikes = 0, n = 0;
  for (const J of findJunctions(chains, W, H)) {
    // the CURRENT junction position is the fit's endpoint (it may have moved)
    const e0 = J.ends[0], f0 = fits[e0.ci];
    const c = e0.atStart ? f0.start : f0.segs[f0.segs.length - 1].p;
    const angs = J.ends.map((e) => { let poly = fitPolyline(fits[e.ci]); if (!e.atStart) poly = poly.slice().reverse(); const a = walk(poly, 0, 0, 3).anchor; return Math.atan2(a[1] - c[1], a[0] - c[0]); }).sort((a, b) => a - b);
    for (let i = 0; i < angs.length; i++) { const g = ((i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI) - angs[i]) * 180 / Math.PI; if (g < 15) spikes++; }
    n++;
  }
  return { spikes, junctions: n };
}

// hooks: an edge that leaves a junction in one direction and bends away within ~2 px
// (direction over the first 1.5 px vs the edge direction between 2 and 6 px differs by more than 35°)
export function junctionHooks(chains, fits, W, H, { angle = 35 } = {}) {
  let hooks = 0, edges = 0;
  for (const J of findJunctions(chains, W, H)) for (const e of J.ends) {
    let poly = fitPolyline(fits[e.ci]); if (!e.atStart) poly = poly.slice().reverse();
    const w = walk(poly, 2, 6, 1.5);
    if (w.length < 6 || w.samples.length < 2) continue;
    edges++;
    const c = poly[0], near = w.anchor, a = w.samples[0], b = w.samples[w.samples.length - 1];
    const d1 = Math.atan2(near[1] - c[1], near[0] - c[0]), d2 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    let dd = Math.abs(d1 - d2) * 180 / Math.PI; if (dd > 180) dd = 360 - dd;
    if (dd > angle) hooks++;
  }
  return { hooks, edges };
}
