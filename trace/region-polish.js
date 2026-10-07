// Region Polish: topology, before edges. "These three raster fragments are one iris" is a hypothesis the reviewer
// may state (a region intent); the engine proves or rejects it with the pixels. Two entry points:
//
//   1. region intents from directives:  { section, regions: { count: preserve|simplify|single, merge: none|compatible|aggressive, protect } }
//   2. semantic consolidation (no directive needed): fragments whose own pixels do not really support their own
//      color are absorbed by a compatible neighbour of the same semantic owner.
//
// A merge "a into b" is only accepted when ALL measurable gates pass:
//   - adjacency (they share boundary);
//   - same semantic owner (tiny raster fragments may also join their parent/sibling section: their assignment is unreliable);
//   - color compatibility (paint ΔE under the merge level's limit);
//   - not protected: thin features, distinct details (compact, contrasting against every neighbour: highlights, pupils),
//     sections marked protect;
//   - pixel loss: pixels of `a` that matched a's paint (ΔE <= 10) and do not match b's paint, net, per merge and per section.
// Merged regions keep the SURVIVOR's paint: no new colors appear. Output: a new region map; contours are rebuilt from it.
import { buildRAG, regionsFromIds, deltaE } from './rag.js';
import { rgbToLab, hex } from './quantize.js';
import { directiveResolver } from './section-polish.js';

const LEVELS = {
  //            fragment ΔE  same-role ΔE  single ΔE   per-merge net loss (share of a)  section budget (share, abs px)
  fragments: { frag: 30, role: 0, single: 0, perMerge: 0.3, budget: [0.015, 3] },
  compatible: { frag: 30, role: 10, single: 22, perMerge: 0.6, budget: [0.02, 4] },
  aggressive: { frag: 45, role: 16, single: 35, perMerge: 1.0, budget: [0.05, 8] },
};

export function polishRegions(reg, assign, ctx, img, lab, imp, directives = [], { consolidate = true, thinMask = null, exclude = null } = {}) {
  const W = reg.width, H = reg.height;
  const nodes = buildRAG(reg.ids, W, H, lab, imp);
  const regById = new Map(reg.regions.map((r) => [r.id, r]));
  const pathOf = (id) => assign.get(id)?.path ?? 'background';
  const resolve = directiveResolver(directives);
  const parentOf = (p) => (p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '');
  // pixels per region (merged lists grow by concatenation)
  const pix = new Map();
  for (let i = 0; i < reg.ids.length; i++) { const id = reg.ids[i]; let a = pix.get(id); if (!a) pix.set(id, (a = [])); a.push(i); }
  const paintLab = new Map(reg.regions.map((r) => [r.id, rgbToLab(...r.color)]));
  const colorAt = (id, i) => {
    const g = regById.get(id).gradient;
    if (!g) return paintLab.get(id);
    const x = (i % W) + 0.5, y = Math.floor(i / W) + 0.5, dx = g.x2 - g.x1, dy = g.y2 - g.y1, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - g.x1) * dx + (y - g.y1) * dy) / L2));
    return g.lab0.map((v, k) => v + (g.lab1[k] - v) * t);
  };
  const good = (id, i) => { const c = colorAt(id, i); return Math.hypot(lab[i * 3] - c[0], lab[i * 3 + 1] - c[1], lab[i * 3 + 2] - c[2]) <= 10; };
  // thin features: regions mostly covered by the thin mask are protected
  const thin = new Set();
  if (thinMask) for (const [id, list] of pix) { let k = 0; for (const i of list) if (thinMask[i]) k++; if (k >= 0.5 * list.length && k >= 6) thin.add(id); }

  // section areas and "group" areas (a section with its parent's family) for the fragment size
  const secArea = new Map(), groupArea = new Map();
  for (const r of reg.regions) { const p = pathOf(r.id); secArea.set(p, (secArea.get(p) || 0) + r.area); const g = parentOf(p) || p; groupArea.set(g, (groupArea.get(g) || 0) + r.area); }
  const fragAreaOf = (p) => Math.max(6, Math.min(40, 0.03 * (groupArea.get(parentOf(p) || p) || 0)));
  const policyOf = (p) => {
    if (exclude?.has(p)) return { mode: 'preserve', level: null, protect: false, directive: resolve(p), excluded: true };
    const d = resolve(p);
    if (d?.regions) return { mode: d.regions.count, level: d.regions.merge === 'none' ? null : d.regions.merge, protect: !!d.regions.protect, directive: d };
    return consolidate ? { mode: 'fragments', level: 'fragments', protect: false, directive: null } : { mode: 'preserve', level: null, protect: false, directive: null };
  };
  const relation = (pa, pb) => (pa === pb ? 'same' : pa.startsWith(pb + '.') || pb.startsWith(pa + '.') ? 'family' : parentOf(pa) && parentOf(pa) === parentOf(pb) ? 'sibling' : 'other');
  // anti-aliasing blend: its paint lies BETWEEN its two main neighbours (dE(a,n1) + dE(a,n2) ≈ dE(n1,n2))
  const blend = (n) => {
    const top = [...n.neighbors].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 2);
    if (top.length < 2) return false;
    const la = paintLab.get(n.id), l1 = paintLab.get(top[0][0]), l2 = paintLab.get(top[1][0]), d12 = deltaE(l1, l2);
    return d12 > 12 && deltaE(la, l1) + deltaE(la, l2) <= 1.25 * d12;
  };
  // distinct detail: big enough, compact, not a blend, contrasting against every significant neighbour (highlight, pupil)
  const distinct = (n) => {
    if (n.area < 6 || blend(n)) return false;
    const compact = (4 * Math.PI * n.area) / (n.perimeter * n.perimeter);
    if (compact < 0.25) return false;
    let minDE = Infinity;
    for (const [bid, len] of n.neighbors) if (len >= 0.2 * n.perimeter) minDE = Math.min(minDE, deltaE(paintLab.get(n.id), paintLab.get(bid)));
    return minDE >= 25 && minDE < Infinity;
  };
  const parent = new Map();
  const find = (x) => { while (parent.has(x)) x = parent.get(x); return x; };
  const spent = new Map(); // section -> net pixel loss used
  const report = new Map();
  const entryOf = (p) => {
    if (!report.has(p)) { const pol = policyOf(p); report.set(p, { section: p, excluded: !!pol.excluded, mode: pol.mode, level: pol.level, directive: !!pol.directive, confidence: pol.directive?.confidence ?? null, regionsBefore: 0, regionsAfter: 0, merged: 0, rejected: { color: 0, loss: 0, protected: 0, budget: 0 }, lossPx: 0 }); }
    return report.get(p);
  };
  for (const r of reg.regions) entryOf(pathOf(r.id)).regionsBefore++;

  const netLoss = (a, b) => { let l = 0; for (const i of pix.get(a)) { const ga = good(a, i), gb = good(b, i); if (ga && !gb) l++; else if (!ga && gb) l--; } return l; };
  for (let pass = 0; pass < 20; pass++) {
    const cands = [];
    for (const a of nodes.values()) {
      const pa = pathOf(a.id), pol = policyOf(pa);
      if (!pol.level || pol.mode === 'preserve') continue;
      const ra = regById.get(a.id);
      if (ra.gradient) continue;
      const L = LEVELS[pol.level], frag = a.area < fragAreaOf(pa);
      const isThin = thin.has(a.id), isDistinct = distinct(a), isBlend = frag && blend(a);
      for (const [bid, len] of a.neighbors) {
        const b = nodes.get(bid); if (!b) continue;
        const pb = pathOf(bid), rel = relation(pa, pb);
        if (b.area < a.area || (b.area === a.area && bid > a.id)) continue; // the smaller one disappears
        const dE = deltaE(paintLab.get(a.id), paintLab.get(bid));
        let kind = null;
        if (frag && (rel === 'same' || rel === 'family' || rel === 'sibling') && (dE <= L.frag || isBlend)) kind = 'fragment';
        else if (rel === 'same' && pol.mode !== 'fragments' && dE <= L.role) kind = 'role';
        else if (rel === 'same' && pol.mode === 'single' && dE <= L.single) kind = 'single';
        if (!kind) { if (rel === 'same' && pol.mode !== 'fragments') entryOf(pa).rejected.color++; continue; }
        if (isThin || (isDistinct && kind !== 'role') || (pol.protect && kind !== 'fragment') || policyOf(pb).protect && kind !== 'fragment') { entryOf(pa).rejected.protected++; continue; }
        cands.push({ a: a.id, b: bid, kind, dE, cost: dE * Math.sqrt(a.area) - len * 0.01, section: pa });
      }
    }
    if (!cands.length) break;
    cands.sort((x, y) => x.cost - y.cost || x.a - y.a || x.b - y.b);
    const touched = new Set();
    let merged = 0;
    for (const c of cands) {
      if (touched.has(c.a) || touched.has(c.b) || !nodes.has(c.a) || !nodes.has(c.b)) continue;
      const pol = policyOf(c.section), L = LEVELS[pol.level], e = entryOf(c.section);
      const loss = netLoss(c.a, c.b), area = nodes.get(c.a).area;
      if (loss > L.perMerge * area && loss > 1) { e.rejected.loss++; continue; }
      const cap = L.budget[0] * (secArea.get(c.section) || 0) + L.budget[1];
      if ((spent.get(c.section) || 0) + Math.max(0, loss) > cap) { e.rejected.budget++; continue; }
      spent.set(c.section, (spent.get(c.section) || 0) + Math.max(0, loss));
      // merge a into b: RAG, pixel lists, union-find
      const A = nodes.get(c.a), B = nodes.get(c.b);
      const shared = A.neighbors.get(B.id) || 0;
      B.area += A.area; B.perimeter += A.perimeter - 2 * shared;
      for (const [nid, l] of A.neighbors) { if (nid === B.id) continue; const N = nodes.get(nid); N.neighbors.delete(A.id); N.neighbors.set(B.id, (N.neighbors.get(B.id) || 0) + l); B.neighbors.set(nid, (B.neighbors.get(nid) || 0) + l); }
      B.neighbors.delete(A.id); nodes.delete(A.id);
      for (const i of pix.get(c.a)) pix.get(c.b).push(i);
      pix.delete(c.a);
      parent.set(c.a, c.b);
      e.merged++; e.lossPx += Math.max(0, loss); (e.kinds ||= {})[c.kind] = (e.kinds[c.kind] || 0) + 1;
      touched.add(c.a); touched.add(c.b); merged++;
    }
    if (!merged) break;
  }
  const totalMerged = parent.size;
  if (!totalMerged) return { reg, changed: false, report: [...report.values()], stats: { merged: 0, thinProtected: thin.size } };
  // relabel; survivors keep their paint (and gradient, label)
  const ids = new Int32Array(reg.ids.length);
  for (let i = 0; i < ids.length; i++) ids[i] = find(reg.ids[i]);
  const regions = regionsFromIds(ids, W, H, img, (id) => regById.get(id).label, [], hex).map((r) => {
    const o = regById.get(r.id);
    return { ...r, color: o.color, sourceColor: o.sourceColor, paletteColor: o.paletteColor, label: o.label, gradient: o.gradient, thinFeature: thin.has(r.id) || undefined };
  });
  const labelById = new Map(regions.map((r) => [r.id, r.label]));
  const labels = new Uint16Array(ids.length);
  for (let i = 0; i < ids.length; i++) labels[i] = labelById.get(ids[i]);
  for (const r of regions) { const e = report.get(pathOf(r.id)); if (e) e.regionsAfter++; }
  return { reg: { width: W, height: H, ids, labels, regions, merged: (reg.merged || 0) + totalMerged }, changed: true, report: [...report.values()], stats: { merged: totalMerged, thinProtected: thin.size } };
}
