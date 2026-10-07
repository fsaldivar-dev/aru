// PolishProvider: the reviewer of the last pass. It looks at each section (reference crop next to the current
// vector crop) and answers with polish DIRECTIVES from a closed vocabulary — never points, paths or curves.
//
//   class MyReviewer extends PolishProvider { get name() { return 'my-model'; } async review(request) { return { directives: [...] }; } }
//
// request = {
//   image: { width, height },
//   vocabulary: { scope, edges, corners, shape },          // the only words a directive may use, plus simplify 0..1
//   sections: [{ section, type, label, importance, visualIntent, regions, segments, curveRatio, roughness,
//                box: [x, y, w, h], reference?: PNG bytes, current?: PNG bytes }]
// }
// The answer must pass validateDirectives(); the engine (trace/section-polish.js) measures every directive and
// rejects the ones that do not fit the pixels, so a wrong answer costs nothing but a line in the report.
import { validateDirectives, ENUMS } from '../trace/section-polish.js';

export class PolishProvider {
  get name() { return 'abstract'; }
  // eslint-disable-next-line no-unused-vars
  async review(request) { throw new Error('PolishProvider.review() not implemented'); }
}

// a hand-written review: { directives: [...] } (every round gets the same list) or { rounds: [{ directives }, ...] }
export class ManualPolishProvider extends PolishProvider {
  constructor(directives) { super(); this.directives = typeof directives === 'string' ? JSON.parse(directives) : directives; }
  get name() { return 'manual'; }
  async review(request = {}) {
    const d = this.directives;
    if (d?.rounds) return JSON.parse(JSON.stringify(d.rounds[(request.round || 1) - 1] || { directives: [] }));
    return JSON.parse(JSON.stringify(d));
  }
}

export async function runPolish(provider, request, ctx) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const raw = await provider.review({ ...request, vocabulary: ENUMS });
  const { directives, errors } = validateDirectives(raw, ctx);
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { directives, errors, raw, provider: provider.name, ms };
}
