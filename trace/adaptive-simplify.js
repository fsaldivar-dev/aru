// Adaptive geometry: each shared chain gets its own Douglas–Peucker ε and Bézier tolerance from its EDGE IMPORTANCE
//   edgeImportance = contrast' × semantic' × curvature'
//   contrast'  = 0.2 + 0.8·min(1, ΔE(left,right)/40)       (barely visible edges -> aggressive simplification)
//   semantic'  = 0.3 + 0.7·(0.5·mean + 0.5·max importance along the chain)
//   curvature' = 0.75 + 0.25·min(1, turning per 40 px / π)
// Tolerances are capped by the size of the smaller adjacent region so tiny shapes (pupils) keep their outline.
import { rgbToLab } from './quantize.js';

export function chainTolerances(chain, dense, regionsById, plan) {
  const imp = plan.imp, W = imp.width, H = imp.height;
  const pts = chain.points, step = Math.max(1, Math.floor(pts.length / 24));
  let s = 0, mx = 0, n = 0;
  const owners = new Map();
  for (let k = 0; k < pts.length; k += step) {
    const x = Math.min(W - 1, Math.max(0, Math.floor(pts[k][0]))), y = Math.min(H - 1, Math.max(0, Math.floor(pts[k][1])));
    const v = imp.map[y * W + x]; s += v; mx = Math.max(mx, v); n++;
    owners.set(imp.owner[y * W + x], (owners.get(imp.owner[y * W + x]) || 0) + 1);
  }
  const semantic = 0.5 * (s / n) + 0.5 * mx;
  const A = regionsById.get(chain.left), B = regionsById.get(chain.right);
  const la = A ? (A._lab ||= rgbToLab(...A.color)) : null, lb = B ? (B._lab ||= rgbToLab(...B.color)) : null;
  const contrast = la && lb ? Math.min(1, Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]) / 40) : 0.5;
  let turn = 0, length = 0;
  for (let i = 1; i + 1 < dense.length; i++) {
    const a = [dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]], b = [dense[i + 1][0] - dense[i][0], dense[i + 1][1] - dense[i][1]];
    turn += Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])); length += Math.hypot(a[0], a[1]);
  }
  const curvature = Math.min(1, turn / Math.PI / Math.max(1, length / 40));
  const edgeImportance = (0.2 + 0.8 * contrast) * (0.3 + 0.7 * semantic) * (0.75 + 0.25 * curvature);
  let owner = -1, oc = -1; for (const [o, k] of owners) if (k > oc) { oc = k; owner = o; }
  const zone = plan.zones.find((z) => z.nodeIndex === owner) || plan.zones[0];
  let { eps, curve } = plan.tolerances(edgeImportance, zone);
  // noise floor: below ~1 px DP and Bézier fitting reproduce pixel staircases, not shape (measured: ε 0.35-0.7 made
  // eyes LOOK worse). Important edges get the floor plus a preference for curves; low-importance edges get coarser.
  eps = Math.max(1.0, eps); curve = Math.max(1.2, curve);
  const smallest = Math.min(A?.area ?? Infinity, B?.area ?? Infinity);
  if (Number.isFinite(smallest)) { eps = Math.min(eps, Math.max(0.5, 0.25 * Math.sqrt(smallest))); curve = Math.min(curve, Math.max(0.7, 0.35 * Math.sqrt(smallest))); }
  // important, curved edges accept Béziers more readily (smooth round shapes instead of polygons)
  const curveGain = edgeImportance > 0.5 ? 1.3 : 0.8;
  return { eps, curve, curveGain, edgeImportance, semantic, contrast, curvature, zone: zone.target };
}
