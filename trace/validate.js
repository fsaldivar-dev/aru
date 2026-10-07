// Topology checks for the shared-chain representation (used by tests and benchmarks):
//   loopBreaks: consecutive chains of a region loop that do not meet exactly (a junction moved for one chain only)
//   uncovered:  pixels no region covers after rasterization (gaps)
import { reverseSegs } from './compiler.js';
import { rasterizeTrace } from './raster.js';

export function checkTopology(T, { eps = 1e-6 } = {}) {
  let loopBreaks = 0, loops = 0;
  const ends = (ref) => { const f = ref.reversed ? reverseSegs(T.fits[ref.chain]) : T.fits[ref.chain]; return [f.start, f.segs[f.segs.length - 1].p]; };
  for (const r of T.regions) for (const loop of [r.outer, ...r.holeLoops]) {
    loops++;
    const refs = loop.refs;
    for (let k = 0; k < refs.length; k++) {
      const [, e] = ends(refs[k]), [s] = ends(refs[(k + 1) % refs.length]);
      if (Math.abs(e[0] - s[0]) > eps || Math.abs(e[1] - s[1]) > eps) loopBreaks++;
    }
  }
  const ids = rasterizeTrace(T);
  let uncovered = 0; for (let i = 0; i < ids.length; i++) if (ids[i] < 0) uncovered++;
  return { loops, loopBreaks, uncovered };
}
