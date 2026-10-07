// Auto-tune: trace with a few parameter sets ("tunes"), render each result, score it against the source
// (trace/score.js) and keep the best. Deterministic: same image + context + tunes = same choice.
// The rasterizer is injected (browser: canvas; Node: headless Chrome) so this module has no DOM.
//
//   tune = { ink: 'on' | 'off', faint: 0.5..1, abstraction: 0..1, detail: 'low' | 'medium' | 'high' }
//   traceWithTune(raw, context, tune)                       -> { tune, res, scene, aru, ink }
//   traceBest(raw, context, { rasterize, tunes?, polish? }) -> { best, tried: [{ tune, metrics }] }
import { ManualVisionProvider } from '../vision/manual-provider.js';
import { runVision } from '../vision/provider.js';
import { prepare, traceGuided } from './guided.js';
import { detectInk, extractInk, inkToAru, inkToAruGrouped } from './ink.js';
import { semanticize } from './semanticize.js';
import { compileSemantic } from './compiler.js';
import { scoreRender } from './score.js';
import { compile } from '../src/engine.js';
import { toAru } from '../src/serialize.js';

export const DETAIL = { low: 0.6, medium: 0.75, high: 0.9 };
const clamp = (v, a, b, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d);
export const normTune = (t = {}) => ({ ink: t.ink === 'on' ? 'on' : 'off', faint: clamp(t.faint, 0.5, 1, 0.85), abstraction: clamp(t.abstraction, 0, 1, 0.5), detail: DETAIL[t.detail] ? t.detail : 'medium' });
export const tuneKey = (t) => `${t.ink}|${t.faint}|${t.abstraction}|${t.detail}`;
export const describeTune = (t) => `${t.ink === 'on' ? `tinta (finas ${t.faint})` : 'sin tinta'} · abstracción ${t.abstraction} · detalle ${t.detail}`;

// default candidates: the detector's choice first, then its alternatives
export function defaultTunes(raw) {
  const lineArt = detectInk(raw).isLineArt;
  return lineArt
    ? [{ ink: 'on', faint: 0.85, abstraction: 0.5, detail: 'medium' }, { ink: 'on', faint: 1, abstraction: 0.35, detail: 'high' }, { ink: 'off', faint: 0.85, abstraction: 0.5, detail: 'medium' }]
    : [{ ink: 'off', faint: 0.85, abstraction: 0.5, detail: 'medium' }, { ink: 'on', faint: 0.85, abstraction: 0.5, detail: 'medium' }];
}

export async function traceWithTune(raw, context, tune0, { polish = null } = {}) {
  const tune = normTune(tune0);
  const fills = async (img) => {
    const v = await runVision(new ManualVisionProvider(context), img);
    return traceGuided(prepare(img, v.context), { quality: DETAIL[tune.detail], regularize: true, abstraction: tune.abstraction, polish });
  };
  if (tune.ink === 'off') { const res = await fills(raw); return { tune, res, scene: res.scene, aru: res.aru, ink: null }; }
  const ink = extractInk(raw, { faint: tune.faint });
  const res = await fills({ width: ink.width, height: ink.height, data: ink.inpainted.data });
  const inkScene = compile(`canvas ${ink.width} ${ink.height}\nbackground none\n${inkToAru(ink, { scale: 1 })}`).scene;
  for (const g of res.scene.root.children) if (g.type === 'group' && g.name === 'background' && !g.label) g.label = 'Colores';
  res.scene.root.children.push(...inkScene.root.children);
  return { tune, res, scene: res.scene, aru: toAru(res.scene, { precision: 2 }), ink: ink.stats, inkData: ink };
}

// rasterize(scene, width, height) -> Promise<{ width, height, data: RGBA }>
export async function scoreCandidate(raw, cand, rasterize) {
  const img = await rasterize(cand.scene, raw.width, raw.height);
  return scoreRender(raw, img);
}

export async function traceBest(raw, context, { rasterize, tunes = null, polish = null, onProgress = () => {} } = {}) {
  const list = (tunes || defaultTunes(raw)).map(normTune);
  const seen = new Set(), tried = [];
  let best = null;
  for (const [k, tune] of list.entries()) {
    if (seen.has(tuneKey(tune))) continue; seen.add(tuneKey(tune));
    onProgress(k + 1, list.length, tune);
    const cand = await traceWithTune(raw, context, tune, { polish });
    cand.metrics = await scoreCandidate(raw, cand, rasterize);
    tried.push({ tune, metrics: cand.metrics, points: cand.res.metrics.outputPoints + (cand.ink?.points || 0) });
    // strictly better score wins; ties keep the earlier (simpler / detector's) choice
    if (!best || cand.metrics.score > best.metrics.score + 1e-9) best = cand;
  }
  return { best, tried };
}

// Semantic grouping AFTER the geometry was chosen: the regions of the winning trace are assigned to the AI's parts
// (semanticize: overlap with each part's polygon/box, deepest part wins) and recompiled one group per part; each ink
// unit goes to the part under most of its outline (non-background preferred), inside the top "Tinta" group.
// Only labels and grouping change, never a pixel (the caller re-scores to make sure).
const safeName = (path) => path.replace(/[^A-Za-z0-9_]/g, '_');
export async function regroup(cand, raw, context, { pieces = null, pieceParts = null } = {}) {
  if (!context?.objects?.length) return null;
  const vctx = (await runVision(new ManualVisionProvider(context), raw)).context;
  const T = cand.res.T, img = cand.res.img;
  const assign = semanticize(T, vctx);
  // the AI's own background part ("background", "fondo", type background…): leftovers and generic "background" go there,
  // so there is ONE background group
  const bgNode = vctx.nodes.filter((n) => /^(background|fondo|bg|backdrop)$/i.test(n.id) || /background|fondo/i.test(n.type || '') || /^fondo$/i.test(n.label || '')).sort((a, b) => a.depth - b.depth)[0] || null;
  if (bgNode) for (const a of assign.values()) if (a.path === 'background') Object.assign(a, { path: bgNode.path, node: bgNode });
  // pieces assigned by the AI (Set-of-Mark): a region goes to its piece's part; the polygons only refine INSIDE that part
  let byPieces = 0; const unknown = new Set();
  if (pieces && pieceParts) {
    // the model may answer with the path, its case, the label or only the last segment: resolve to a context node
    const norm = (t) => String(t).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9.]+/g, '_');
    const byKey = new Map();
    for (const n of vctx.nodes) for (const k of [n.path, n.label, n.id]) if (k && !byKey.has(norm(k))) byKey.set(norm(k), n);
    const resolve = (P) => { const k = norm(P); if (k === 'background' || k === 'fondo') return byKey.get(k) || bgNode; return byKey.get(k) || byKey.get(k.split('.').pop()) || undefined; };
    for (const r of T.regions) {
      const P = pieceParts.get(pieces.segOf.get(r.id)); if (!P) continue;
      const n = resolve(P);
      if (n === undefined) { unknown.add(P); continue; } // unknown name: keep the polygon assignment
      const path = n ? n.path : 'background', a = assign.get(r.id);
      if (a.path === path || a.path.startsWith(path + '.')) continue;
      Object.assign(a, { path, node: n, via: 'pieces' }); byPieces++;
    }
  }
  const out = compileSemantic(T, assign, vctx, { outWidth: img.sourceWidth, outHeight: img.sourceHeight });
  // keep the ORIGINAL paint order as far as groups allow: every group (and every child inside it) is ordered by the
  // earliest region it contains in the ungrouped order (containment depth, then area). Otherwise a backdrop group
  // painted after the eyes would cover their edges with its seam stroke.
  const rank = new Map([...T.regions].sort((a, b) => a.depth - b.depth || b.area - a.area).map((r, k) => [`region${String(r.id).padStart(3, '0')}`, k]));
  const first = (n) => (n.type === 'path' ? rank.get(n.meta?.geomId) ?? Infinity : Math.min(Infinity, ...(n.children || []).map(first)));
  const sortTree = (n) => { if (!n.children) return; const key = new Map(n.children.map((c) => [c, first(c)])); n.children.sort((a, b) => key.get(a) - key.get(b)); n.children.forEach(sortTree); };
  sortTree(out.scene.root);
  const labelOf = new Map(vctx.nodes.map((n) => [n.path, n.label || n.id]));
  const label = (path) => (path === 'background' ? 'Fondo' : labelOf.get(path) || path.split('.').pop());
  const walk = (n) => { if (n.type === 'group' && n.semantic && !n.label) n.label = label(n.semantic); for (const c of n.children || []) walk(c); };
  walk(out.scene.root);
  if (cand.inkData) {
    const ink = cand.inkData, sx = T.width / ink.width, sy = T.height / ink.height;
    const partOf = (samples) => {
      const count = new Map();
      for (const [px, py] of samples) {
        const x = Math.max(0, Math.min(T.width - 1, Math.floor(px * sx))), y = Math.max(0, Math.min(T.height - 1, Math.floor(py * sy)));
        const path = assign.get(T.ids[y * T.width + x])?.path ?? 'background';
        count.set(path, (count.get(path) || 0) + 1);
      }
      const ranked = [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      // an outline sits ON the border between the subject and the backdrop: prefer the subject's side (≥ 10 %)
      const isBg = (p) => p === 'background' || (bgNode && (p === bgNode.path || p.startsWith(bgNode.path + '.')));
      const fg = ranked.find(([p, c]) => !isBg(p) && c >= 0.1 * samples.length);
      const path = (fg || ranked[0] || ['background'])[0];
      return { name: safeName(path), label: label(path) };
    };
    const inkScene = compile(`canvas ${ink.width} ${ink.height}\nbackground none\n${inkToAruGrouped(ink, partOf, { scale: 1 })}`).scene;
    out.scene.root.children.push(...inkScene.root.children);
  }
  return { ...cand, scene: out.scene, aru: toAru(out.scene, { precision: 2 }), assign, grouped: true, byPieces, unknownParts: [...unknown] };
}
