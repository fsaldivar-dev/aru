// Saliency-aware small-region filter. Replaces "area < minRegionArea -> merge" with:
//   keep if area >= minArea(local importance, zone)
//   otherwise score = 0.4·contrast + 0.35·persistence + 0.25·compactness   (what the PIXELS say)
//   keep if score >= threshold(importance) = lerp(0.85, 0.45, importance)   (what VISION says: where to be lenient)
//   preserve zones lower the threshold further; `ignore` zones (overlaid artifacts) always merge.
// Importance gates the decision instead of adding to it: noise inside an eye is still noise.
// contrast = ΔE to the dominant neighbour color / 35; compactness = 4πA/P² (slivers ≈ 0, blobs ≈ 0.8).
const lerp = (a, b, t) => a + (b - a) * t;

export function makeSaliencyDecider({ plan, labelLab, persistence, W, thinMask = null }) {
  const imp = plan.imp;
  const stats = { evaluated: 0, keptBySize: 0, keptBySaliency: 0, mergedNoise: 0, mergedIgnored: 0, mergedLowSaliency: 0 };
  const decide = (c, info) => {
    stats.evaluated++;
    const area = c.pixels.length, step = Math.max(1, Math.floor(area / 64));
    let isum = 0, imax = 0, n = 0, pres = false, ign = 0;
    const owners = new Map();
    for (let k = 0; k < area; k += step) {
      const p = c.pixels[k], v = imp.map[p];
      isum += v; imax = Math.max(imax, v); n++;
      if (imp.preserve[p]) pres = true;
      if (imp.ignore[p]) ign++;
      owners.set(imp.owner[p], (owners.get(imp.owner[p]) || 0) + 1);
    }
    const importance = 0.5 * (isum / n) + 0.5 * imax;
    if (thinMask) { let t = 0; for (let k = 0; k < area; k += step) if (thinMask[c.pixels[k]]) t++; if (t / n >= 0.5) { stats.keptThin = (stats.keptThin || 0) + 1; return false; } }
    if (ign / n > 0.5 && !pres) { stats.mergedIgnored++; return true; }
    // artifacts are removed everywhere, whatever the importance (preserve protects details, not noise)
    let dom = -1, dc = -1; for (const [l, k] of info.border) if (k > dc) { dc = k; dom = l; }
    const a = labelLab[c.label], b = dom >= 0 ? labelLab[dom] : a;
    const contrast = Math.min(1, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 35);
    // pixel blocks (<= 4 px) are noise, unless a preserved detail with strong contrast (an eye highlight)
    if (area <= 4 && !(pres && contrast > 0.6)) { stats.mergedNoise++; return true; }
    // ΔE < ~10 to the dominant neighbour = gradient banding or compression blocks, never a critical detail
    if (contrast < 0.3) { stats.mergedLowContrast = (stats.mergedLowContrast || 0) + 1; return true; }
    let owner = -1, oc = -1; for (const [o, k] of owners) if (k > oc) { oc = k; owner = o; }
    const zone = plan.zones.find((z) => z.nodeIndex === owner) || plan.zones[0];
    if (area >= plan.minAreaFor(importance, zone)) { stats.keptBySize++; return false; }
    const compact = Math.min(1, (4 * Math.PI * area) / Math.max(1, info.perimeter * info.perimeter));
    const persist = persistence.score(c, c.label, W);
    const score = 0.4 * contrast + 0.35 * persist + 0.25 * compact;
    const threshold = lerp(0.85, 0.45, importance) - (pres ? 0.15 : 0);
    if (score >= threshold) { stats.keptBySaliency++; return false; }
    stats.mergedLowSaliency++;
    return true;
  };
  return { decide, stats };
}

// Budget phase: when more regions survive than the quality budget allows, merge the LOWEST-VALUE small regions.
//   value = pixelScore × lerp(0.25, 1, importance) × (1 + log10(area))
// Vision decides where detail is worth paying for; pixels decide what is real; the budget decides how much.
export function budgetMerge(reg, plan, labelLab, persistence, findRegions, q, img, thinMask = null) {
  const over = reg.regions.length - plan.budget.maxRegions;
  if (over <= 0) return { reg, merged: 0 };
  const { width: W, height: H, ids } = reg, imp = plan.imp;
  const border = new Map(), info = new Map(reg.regions.map((r) => [r.id, { sum: 0, n: 0, per: 0 }]));
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i], x = i % W, I = info.get(id);
    I.sum += imp.map[i]; I.n++;
    for (const j of [x < W - 1 ? i + 1 : -1, i + W < ids.length ? i + W : -1]) {
      if (j < 0 || ids[j] === id) continue;
      const a = ids[j]; I.per++; info.get(a).per++;
      for (const [p, o] of [[id, a], [a, id]]) { let m = border.get(p); if (!m) border.set(p, (m = new Map())); m.set(o, (m.get(o) || 0) + 1); }
    }
  }
  const byId = new Map(reg.regions.map((r) => [r.id, r]));
  const cap = plan.budget.minRegionArea * 6;
  const scored = [];
  for (const r of reg.regions) {
    if (r.area >= cap) continue;
    const I = info.get(r.id), b = border.get(r.id);
    if (!b) continue;
    let dom = -1, dc = -1; for (const [o, k] of b) if (k > dc) { dc = k; dom = o; }
    const la = labelLab[r.label], lb = labelLab[byId.get(dom).label];
    const contrast = Math.min(1, Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]) / 35);
    const compact = Math.min(1, (4 * Math.PI * r.area) / Math.max(1, I.per * I.per));
    const pixels = []; for (let i = 0; i < ids.length && pixels.length < r.area; i++) if (ids[i] === r.id) pixels.push(i);
    const persist = persistence.score({ pixels }, r.label, W);
    const importance = I.sum / I.n;
    const preserved = pixels.some((p) => imp.preserve[p]) || (thinMask && pixels.filter((p) => thinMask[p]).length >= 0.5 * pixels.length);
    const value = (0.4 * contrast + 0.35 * persist + 0.25 * compact) * (0.25 + 0.75 * importance) * (1 + Math.log10(r.area)) + (preserved ? 10 : 0);
    scored.push({ r, value });
  }
  scored.sort((a, b) => a.value - b.value);
  const victims = new Set(scored.slice(0, over).map((s) => s.r.firstPixel));
  const out = findRegions({ ...q, labels: reg.labels }, img, {
    candidateArea: cap, maxPasses: 3,
    decide: (c) => { let m = Infinity; for (const p of c.pixels) if (p < m) m = p; return victims.has(m); },
  });
  return { reg: out, merged: victims.size };
}
