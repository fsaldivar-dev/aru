// Polish metrics: observable properties of a clean, deliberate vector (not pixel fidelity).
//   regionCount, tinyRegionRatio, nearDuplicateColors, edgeRoughness, averageVerticesPerRegion, curveRatio,
//   unnecessaryCorners, fragmentation, semanticFragmentation  ->  polishScore in 0..1
import { rgbToLab } from './quantize.js';
import { bez } from './bezier.js';

const de = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function polishMetrics(T, assign = null) {
  const N = T.width * T.height, tinyArea = Math.max(12, N * 0.0002);
  const regions = T.regions;
  const tiny = regions.filter((r) => r.area < tinyArea);
  // fills: flat colors (gradients count as their two end colors)
  const fills = new Map();
  // a gradient is one deliberate fill (its mid color), not two palette entries
  for (const r of regions) { const c = r.color; const k = c.map(Math.round).join(','); if (!fills.has(k)) fills.set(k, rgbToLab(...c)); }
  const labs = [...fills.values()];
  let nearDup = 0;
  for (let i = 0; i < labs.length; i++) if (labs.some((l, j) => j !== i && de(l, labs[i]) < 5)) nearDup++;
  // edges: roughness = turning per 10 px along the OUTPUT geometry; unnecessary corners = line joints that barely turn
  let turn = 0, length = 0, joints = 0, flatJoints = 0, beziers = 0, lines = 0, vertices = 0;
  const roughByChain = [];
  T.fits.forEach((f, ci) => {
    const pts = [f.start];
    let cur = f.start, kinds = [];
    for (const s of f.segs) {
      if (s.t === 'L') { pts.push(s.p); lines++; kinds.push('L'); }
      else { const b = [cur, s.c1, s.c2, s.p]; for (let i = 1; i <= 8; i++) pts.push(bez(b, i / 8)); beziers++; kinds.push('C'); }
      cur = s.p; vertices++;
    }
    let ct = 0, cl = 0;
    for (let i = 1; i + 1 < pts.length; i++) {
      const a = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]], b = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]];
      const la = Math.hypot(...a), lb = Math.hypot(...b); if (!la || !lb) continue;
      ct += Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])); cl += la;
    }
    if (pts.length > 1) cl += Math.hypot(pts[pts.length - 1][0] - pts[pts.length - 2][0], pts[pts.length - 1][1] - pts[pts.length - 2][1]);
    // line-line joints that turn < 12 degrees are vertices a designer would not have placed
    let p = f.start;
    for (let i = 0; i + 1 < f.segs.length; i++) {
      const s1 = f.segs[i], s2 = f.segs[i + 1];
      if (s1.t === 'L' && s2.t === 'L') {
        joints++;
        const a = [s1.p[0] - p[0], s1.p[1] - p[1]], b = [s2.p[0] - s1.p[0], s2.p[1] - s1.p[1]];
        const ang = Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * 180 / Math.PI;
        if (ang < 12) flatJoints++;
      }
      p = s1.p;
    }
    turn += ct; length += cl;
    roughByChain[ci] = cl ? (ct / cl) * 10 : 0;
  });
  const edgeRoughness = length ? (turn / length) * 10 : 0;
  // semantic fragmentation: regions per assigned part
  let semanticFragmentation = 0;
  if (assign) {
    const per = new Map();
    for (const r of regions) { const a = assign.get(r.id); if (a?.node) per.set(a.path, (per.get(a.path) || 0) + 1); }
    semanticFragmentation = per.size ? [...per.values()].reduce((a, b) => a + b, 0) / per.size : 0;
  }
  const m = {
    regionCount: regions.length, tinyRegions: tiny.length, tinyRegionRatio: tiny.length / Math.max(1, regions.length),
    colors: fills.size, nearDuplicateColors: nearDup, edgeRoughness, averageVerticesPerRegion: (2 * vertices) / Math.max(1, regions.length),
    curveRatio: beziers / Math.max(1, beziers + lines), unnecessaryCorners: flatJoints, unnecessaryCornerRatio: flatJoints / Math.max(1, joints),
    fragmentation: tiny.length / Math.max(1, N / 10000), semanticFragmentation,
  };
  const sub = {
    simplicity: 1 / (1 + m.regionCount / 150),
    tiny: 1 - m.tinyRegionRatio,
    palette: 1 - m.nearDuplicateColors / Math.max(1, m.colors),
    smoothness: 1 / (1 + m.edgeRoughness / 2),
    corners: 1 - m.unnecessaryCornerRatio,
    semantic: assign ? 1 / (1 + Math.max(0, m.semanticFragmentation - 3) / 8) : 1,
  };
  m.sub = sub;
  m.polishScore = Object.values(sub).reduce((a, b) => a + b, 0) / Object.keys(sub).length;
  m.roughByChain = roughByChain;
  m.tinyIds = new Set(tiny.map((r) => r.id));
  return m;
}

// optimization score; weights move from fidelity to polish/simplicity as abstraction grows
export function optimizationScore(weightedFidelity, polish, outputPoints, abstraction) {
  const wF = 1 - 0.6 * abstraction, wP = 0.3 + 0.6 * abstraction, wC = 0.1 + 0.4 * abstraction;
  return wF * weightedFidelity + wP * polish - wC * Math.min(1, outputPoints / 5000);
}
