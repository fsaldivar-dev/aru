// Serialize a traced result (regions, loops, fits, assignment) so benchmarks can re-render it later,
// even after the engine changes:  import { snapshot } ...; fs.writeFileSync(file, JSON.stringify(snapshot(res)))
export function snapshot(res) {
  const T = res.T;
  return {
    width: T.width, height: T.height,
    regions: T.regions.map((r) => ({ id: r.id, depth: r.depth, area: r.area, color: r.color, gradient: r.gradient ? { x1: r.gradient.x1, y1: r.gradient.y1, x2: r.gradient.x2, y2: r.gradient.y2, c0: r.gradient.c0, c1: r.gradient.c1, lab0: r.gradient.lab0, lab1: r.gradient.lab1 } : null, outer: { refs: r.outer.refs }, holeLoops: r.holeLoops.map((h) => ({ refs: h.refs })), path: res.assign.get(r.id)?.path ?? 'background', bounds: r.bounds })),
    fits: T.fits,
    metrics: res.metrics,
  };
}
export function restore(s) {
  return { width: s.width, height: s.height, regions: s.regions, fits: s.fits, paths: new Map(s.regions.map((r) => [r.id, r.path])) };
}
