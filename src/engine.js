// Engine facade: .aru text -> tokens -> AST -> scene graph -> SVG, with timings and errors.
import { parse } from './parser.js';
import { buildScene } from './scene.js';
import { renderScene } from './render.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Number(process.hrtime.bigint()) / 1e6);

export function compile(src, opts = {}) {
  const result = { ok: false, ast: null, scene: null, svg: '', errors: [], warnings: [], timings: {}, tokenCount: 0 };
  let t0 = now();
  try {
    const { ast, tokenCount } = parse(src);
    result.ast = ast; result.tokenCount = tokenCount;
    result.timings.parse = now() - t0;
  } catch (e) {
    result.errors.push({ message: e.message, line: e.line, col: e.col, stage: 'parse' });
    result.timings.parse = now() - t0;
    return result;
  }
  t0 = now();
  try {
    result.scene = buildScene(result.ast);
    result.errors.push(...result.scene.errors.map((e) => ({ ...e, stage: 'scene' })));
    result.warnings.push(...result.scene.warnings);
  } catch (e) {
    result.errors.push({ message: e.message, line: e.line, col: e.col, stage: 'scene' });
    result.timings.scene = now() - t0;
    return result;
  }
  result.timings.scene = now() - t0;
  t0 = now();
  result.svg = renderScene(result.scene, opts);
  result.timings.render = now() - t0;
  result.ok = result.errors.length === 0;
  return result;
}

export { parse, buildScene, renderScene };
