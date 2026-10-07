// TracePlan: VisualContext + ImportanceMap + quality -> budgets and per-zone rules the tracer can query.
// quality (0..1) defines a BUDGET (colors, regions, points, tolerances, target fidelity), not a linear knob.
// Zones are context nodes (+ background); the quality search refines zones through `overrides`.
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function budgetFromQuality(q) {
  q = clamp(q, 0, 1);
  return {
    quality: q,
    colors: Math.round(lerp(4, 20, Math.pow(q, 0.9))),      // global palette
    maxLocalColors: q < 0.3 ? 0 : q < 0.6 ? 2 : q < 0.85 ? 3 : 4, // per important zone, on top of the global palette
    minRegionArea: Math.round(lerp(150, 8, q)),               // base; modulated by local importance
    simplification: lerp(3.0, 0.6, q),                        // base DP ε (px); modulated per edge
    curveTolerance: lerp(4.0, 1.0, q),                        // base Bézier tolerance (px); modulated per edge
    maxRegions: Math.round(lerp(40, 500, q)),
    maxPoints: Math.round(lerp(500, 4500, q)),
    targetFidelity: lerp(0.75, 0.97, q),
  };
}

export function makePlan(ctx, imp, { quality = 0.75, overrides = {} } = {}) {
  const budget = budgetFromQuality(quality);
  const zo = overrides.zones || {};
  const mkZone = (target, importance, node) => {
    const o = zo[target] || {};
    const colorBudget = importance >= 0.8 ? 'high' : importance >= 0.55 ? 'medium' : 'low';
    return {
      target, importance, nodeIndex: node ? node.index : -1, type: node?.type ?? 'background',
      colorBudget, localColors: colorBudget === 'high' ? budget.maxLocalColors : colorBudget === 'medium' ? Math.floor(budget.maxLocalColors / 2) : 0,
      geometryTolerance: importance >= 0.8 ? 'low' : importance >= 0.5 ? 'medium' : 'high',
      preserveSmallRegions: !!node?.preserve || importance >= 0.9,
      extraColors: o.extraColors || 0, areaScale: o.areaScale ?? 1, geomScale: o.geomScale ?? 1,
    };
  };
  const zones = [mkZone('background', ctx.background.importance, null)];
  const byNode = new Map();
  for (const n of ctx.nodes) { if (n.ignore) continue; const z = mkZone(n.path, n.importance, n); zones.push(z); byNode.set(n.index, z); }
  const zoneOfOwner = (owner) => (owner >= 0 && byNode.get(owner)) || zones[0];
  const W = imp.width;
  const plan = {
    quality, budget: { ...budget, colors: budget.colors + (overrides.globalColorBoost || 0) }, zones, context: ctx, imp,
    zoneAt: (i) => zoneOfOwner(imp.owner[i]),
    // what the tracer asks: how important is this pixel and which rules apply here?
    at: (x, y) => { const i = Math.floor(y) * W + Math.floor(x); return { importance: imp.map[i], zone: zoneOfOwner(imp.owner[i]), preserve: !!imp.preserve[i], ignore: !!imp.ignore[i] }; },
    minAreaFor: (importance, zone) => plan.budget.minRegionArea * lerp(2.0, 0.12, importance) * (zone?.areaScale ?? 1),
    tolerances: (edgeImportance, zone) => ({
      eps: plan.budget.simplification * lerp(2.2, 0.35, edgeImportance) * (zone?.geomScale ?? 1),
      curve: plan.budget.curveTolerance * lerp(2.0, 0.5, edgeImportance) * (zone?.geomScale ?? 1),
    }),
  };
  return plan;
}
