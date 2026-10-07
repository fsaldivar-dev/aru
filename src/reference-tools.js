// Shared reference workflow: used by Studio, embeddable hosts and the CLI. No DOM or file access.
import { compile as compileAru } from './engine.js';
import { contextFromParts } from './agents.js';
import { rgbToLab } from '../trace/quantize.js';
import { labToRgb } from '../trace/rag.js';
import { withOpaqueBackground } from './opaque.js';
const r2 = (v) => Math.round(v * 100) / 100;
export async function traceReferenceState(raw, ref, { rasterize, progress = () => {} }) {
  let parts = ref.parts || [];
  // crop: only that area of the reference is vectorized (the wolf of a logo, without the wordmark); the parts' boxes
  // and polygons (normalized to the whole image) are converted to the crop
  const cl = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  let c = ref.crop, cropNote = null;
  if (c && c.w > 0.02 && c.h > 0.02) {
    // the AI's box is approximate: on a plain backdrop the crop is MEASURED around the subject (whole silhouette, no
    // divider bars or neighbours; trace/crop.js), so any reasonable box gives the same crop; busy backdrop: box as is
    const { cropToSubject } = await import('../trace/crop.js');
    const r = cropToSubject(raw, { x: cl(c.x), y: cl(c.y), w: cl(c.w), h: cl(c.h) });
    raw = r.raw; c = r.box;
    if (r.refined) cropNote = `recorte ajustado al sujeto${r.removed ? ' (sin elementos vecinos)' : ''}`;
    const fx = (v) => (v - c.x) / c.w, fy = (v) => (v - c.y) / c.h;
    parts = parts.map((p) => ({ ...p, x: fx(p.x), y: fy(p.y), w: p.w / c.w, h: p.h / c.h, polygon: Array.isArray(p.polygon) ? p.polygon.map((q) => [fx(q[0]), fy(q[1])]) : p.polygon }))
      .filter((p) => p.x < 1 && p.y < 1 && p.x + p.w > 0 && p.y + p.h > 0)
      .map((p) => { const x = Math.max(0, p.x), y = Math.max(0, p.y); return { ...p, x, y, w: Math.min(1, p.x + p.w) - x, h: Math.min(1, p.y + p.h) - y }; });
  }
  let context = contextFromParts(parts), partsNote = null;
  // a malformed description of the parts must never break the vectorization: trace without parts and say so
  { const { validateContext } = await import('../vision/context.js'); const errs = validateContext(context); if (errs.length) { partsNote = `partes descartadas (${errs[0]})`; context = { version: 1, scene: 'illustration', background: { importance: 0.5 }, objects: [] }; } }
  const A = await import('../trace/autotune.js');
  const tunes = A.defaultTunes(raw);
  if (ref.abstraction != null && Math.abs(ref.abstraction - 0.5) > 0.05) tunes.push({ ...tunes[0], abstraction: Math.max(0, Math.min(1, ref.abstraction)) });
  const tuned = await A.traceBest(raw, context, { rasterize, tunes, onProgress: progress });
  const st = { A, ...tuned };
  // the AI's parts are context, not truth: the best tune is also traced WITHOUT them and the score decides, so a
  // provider that describes the image worse cannot make the result worse
  const out = { ...st, raw, context, aiContext: context, partsNote: [cropNote, partsNote].filter(Boolean).join(' · ') || null };
  for (const t of st.tried) t.neutral = !context.objects.length;
  if (context.objects.length) {
    const neutral = { version: 1, scene: 'illustration', background: { importance: 0.5 }, objects: [] };
    const cand = await st.A.traceWithTune(raw, neutral, st.best.tune);
    cand.metrics = await st.A.scoreCandidate(raw, cand, rasterize);
    st.tried.push({ tune: cand.tune, metrics: cand.metrics, neutral: true });
    if (cand.metrics.score > st.best.metrics.score + 1e-9) { out.best = cand; out.context = neutral; }
  }
  return out;
}

export async function retuneReference(st, tune, rasterize) {
  const t = st.A.normTune(tune);
  const neutral = !st.context.objects.length; // tries are compared within the context in use (AI parts or none)
  const prev = st.tried.find((x) => !!x.neutral === neutral && st.A.tuneKey(x.tune) === st.A.tuneKey(t));
  if (prev) return { tune: t, metrics: prev.metrics, improved: false, repeated: true };
  const cand = await st.A.traceWithTune(st.raw, st.context, t);
  cand.metrics = await st.A.scoreCandidate(st.raw, cand, rasterize);
  st.tried.push({ tune: t, metrics: cand.metrics, neutral, points: cand.res.metrics.outputPoints + (cand.ink?.points || 0) });
  const improved = cand.metrics.score > st.best.metrics.score + 1e-9;
  if (improved) st.best = cand;
  return { tune: t, metrics: cand.metrics, improved };
}
// original | current best, side by side (PNG base64, ≤ 1024 px wide) for the AI review

export function referenceKeep(st, ref) {
  const res = st.best.res, T = res.T, W = T.width, H = T.height, ids = T.ids, count = new Map();
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { const id = ids[y * W + x]; count.set(id, (count.get(id) || 0) + 1); }
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { const id = ids[y * W + x]; count.set(id, (count.get(id) || 0) + 1); }
  const byId = new Map(T.regions.map((r) => [r.id, r]));
  const domId = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  const domLab = domId != null ? rgbToLab(...byId.get(domId).color) : null;
  const drop = new Set();
  // the AI decides (it sees the image) whether enclosed areas of the backdrop color are holes (letter counters) or highlights;
  // the measured role protects a part's MAIN region of that color (the white "t" of an icon is its part's primary region)
  if (!ref.keepBackground && domLab) for (const r of T.regions) { const l = rgbToLab(...r.color); if ((count.has(r.id) || (ref.dropHoles && (st.best.assign || res.assign).get(r.id)?.role !== 'primary')) && Math.hypot(l[0] - domLab[0], l[1] - domLab[1], l[2] - domLab[2]) < 12) drop.add(`region${String(r.id).padStart(3, '0')}`); }
  // degenerate slivers (collapsed to a line by simplification) are invisible noise
  const sliver = (n) => { const xs = [], ys = []; for (const c of n.geom?.commands || []) for (let i = 0; i + 1 < c.args.length; i += 2) { xs.push(c.args[i]); ys.push(c.args[i + 1]); } return xs.length && Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < 1.2; };
  return { keep: (n) => !(n.type === 'path' && (drop.has(n.meta?.geomId) || sliver(n))), dropped: drop.size };
}
// GLYPH icons (trace/glyph.js): the subject as ONE compound path (fills minus ink), cleaned by levers the AI sets after
// reading the inspection; the icon score decides

export async function prepareGlyph(st, ref) {
  const G = await import('../trace/glyph.js');
  const { keep } = referenceKeep(st, ref), fills = [], inks = [];
  const walk = (n, ink) => { for (const c of n.children || []) { const isInk = ink || (c.type === 'group' && c.name === 'tinta'); if (c.type === 'path' && keep(c)) (isInk ? inks : fills).push(c.geom.commands); walk(c, isInk); } };
  walk(st.best.scene.root, false);
  const raw = G.rawGlyph(fills, inks, st.best.scene.width, st.best.scene.height);
  const built = G.buildGlyph(raw, G.GLYPH_DEFAULTS), ins = G.inspect(built, raw);
  st.glyph = { G, raw, sw: st.best.scene.width, sh: st.best.scene.height, best: { built, ins }, tried: [{ params: built.params, score: ins.score }] };
  return { inspection: ins, params: built.params, report: G.inspectionReport(ins, built.params) };
}

export async function retuneGlyph(st, params) {
  const g = st.glyph, p = g.G.normGlyphParams(params), key = JSON.stringify(p);
  const prev = g.tried.find((t) => JSON.stringify(t.params) === key);
  if (prev) return { params: p, score: prev.score, improved: false, repeated: true, report: g.G.inspectionReport(g.best.ins, g.best.built.params) };
  const built = g.G.buildGlyph(g.raw, p), ins = g.G.inspect(built, g.raw);
  g.tried.push({ params: p, score: ins.score });
  const improved = ins.score > g.best.ins.score + 1e-9;
  if (improved) g.best = { built, ins };
  return { params: p, score: ins.score, improved, report: g.G.inspectionReport(g.best.ins, g.best.built.params) };
}
// what the AI sees: the icon large with the inspector's markers + the same icon at 96 and 48 px (PNG base64)

export async function referenceFragment(st, ref, background) {
  const res = st.best.res, ink = st.best.ink, T = res.T;
  let backdropNote = null;
  const hex6 = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const { keep, dropped } = referenceKeep(st, ref);
  const drop = { size: dropped };
  let scene = { ...st.best.scene, root: JSON.parse(JSON.stringify(st.best.scene.root)), gradients: JSON.parse(JSON.stringify(st.best.scene.gradients)) }, sw = scene.width, sh = scene.height;
  // backdrop (app icon / avatar): a base shape with the traced subject centred inside it and CLIPPED by it
  const bd = ref.backdrop;
  if (bd && ['squircle', 'circle', 'square'].includes(bd.shape)) {
    const pad = Math.max(0.06, Math.min(0.4, Number(bd.padding) || (bd.style === 'glyph' ? 0.1 : 0.12))), side = Math.max(sw, sh) / (1 - 2 * pad), B = r2(side);
    // the base must contrast with the subject's outline (ink colours; else its largest colour)
    const { contrastBackdrop } = await import('../trace/crop.js');
    const outline = st.best.inkData ? [...new Set(st.best.inkData.paths.map((p) => p.color))] : [hex6(([...st.best.res.T.regions].sort((x, y) => y.area - x.area)[0] || { color: [0, 0, 0] }).color)];
    const asked = /^#[0-9a-f]{6}$/i.test(bd.color || '') ? bd.color.toUpperCase() : '#1E1E24';
    const glyph = bd.style === 'glyph', depth = Math.max(0, Math.min(1, Number(bd.depth) || 0));
    const color = glyph ? asked : contrastBackdrop(asked, outline);
    if (color !== asked) backdropNote = `base aclarada/oscurecida a ${color} para que contraste con el contorno`;
    let motifChildren = scene.root.children, glyphColorUsed = null;
    if (glyph) {
      // glyph: ONE compound path (fills minus ink), cleaned with the levers the AI set (or the defaults); its colour
      // must contrast with the base (else white or near-black, whichever is farther)
      let gc = /^#[0-9a-f]{6}$/i.test(bd.glyphColor || '') ? bd.glyphColor.toUpperCase() : '#FFFFFF';
      const L = (h) => rgbToLab(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));
      const dE = (a, b) => { const x = L(a), y = L(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
      if (dE(gc, color) < (depth > 0 ? 12 : 30)) gc = dE('#FFFFFF', color) >= dE('#16161A', color) ? '#FFFFFF' : '#16161A'; // with depth the glyph's shadow separates it
      if (!st.glyph) await prepareGlyph(st, ref);
      const { built, ins } = st.glyph.best;
      motifChildren = compileAru(`canvas ${sw} ${sh}\nbackground none\n${st.glyph.G.glyphToAru(built, { fill: gc })}`).scene.root.children;
      glyphColorUsed = gc;
      backdropNote = [backdropNote, `estilo glifo (${gc} sobre ${color}) · icono ${ins.score} (motas ${ins.specks}, fidelidad ${ins.fidelity})`].filter(Boolean).join(' · ');
    }
    // SOFT 3D (depth > 0): gradient base lifted by a drop shadow, top highlight + bottom shade, and a raised glyph
    // (gradient + its own shadow). Deterministic from the base colour; all effects are plain ARU (shadow / inner)
    const shade = (hex, dL) => { const l = rgbToLab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)); return '#' + labToRgb([Math.max(0, Math.min(100, l[0] + dL)), l[1], l[2]]).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase(); };
    const dark = shade(color, -38), fx = (k, dx, dy, b, c, o) => `${k} ${r2(dx)} ${r2(dy)} ${r2(b)} ${c} ${r2(o)}`;
    const grads = depth > 0 ? `gradient baseGrad linear 90 { stop 0 ${shade(color, 6 + 6 * depth)}; stop 1 ${shade(color, -(4 + 6 * depth))} }\n` : '';
    const baseFx = depth > 0 ? `; ${fx('shadow', 0, B * 0.035 * depth, B * 0.08 * depth, dark, 0.32)}; ${fx('inner', 0, B * 0.02, B * 0.03, '#FFFFFF', 0.5 * depth + 0.1)}; ${fx('inner', 0, -B * 0.025, B * 0.05, dark, 0.22 * depth)}` : '';
    const baseFill = depth > 0 ? 'baseGrad' : color;
    const shape = bd.shape === 'circle' ? `circle base { at ${B / 2} ${B / 2}; radius ${B / 2}; label "Base"; fill ${baseFill}${baseFx} }` : `rect base { at ${B / 2} ${B / 2}; size ${B} ${B}; corner ${bd.shape === 'squircle' ? r2(B * 0.225) : 0}; label "Base"; fill ${baseFill}${baseFx} }`;
    const glyphGrad = depth > 0 && glyphColorUsed ? `gradient glyphGrad linear 90 { stop 0 ${glyphColorUsed}; stop 1 ${shade(glyphColorUsed, -(6 + 8 * depth))} }\n` : '';
    const base = compileAru(`canvas ${B} ${B}\nbackground none\n${grads}${glyphGrad}${shape}`).scene;
    if (depth > 0) {
      const lift = { dx: 0, dy: r2(B * 0.02 * depth), blur: r2(B * 0.035 * depth), color: dark, opacity: 0.38 };
      const relief = { dx: 0, dy: r2(-B * 0.008), blur: r2(B * 0.012), color: dark, opacity: 0.16 };
      for (const n of motifChildren) { if (glyphColorUsed && n.type === 'path') { n.fill = 'glyphGrad'; n.inner = [relief]; } n.shadow = lift; }
      backdropNote = [backdropNote, `relieve ${depth}`].filter(Boolean).join(' · ');
    }
    const motif = { id: -1, type: 'group', name: 'motivo', label: 'Motivo', clip: 'base', at: [r2((B - sw) / 2), r2((B - sh) / 2)], rotate: 0, scale: [1, 1], fill: null, stroke: null, strokeWidth: 1, opacity: 1, layer: 2, geom: {}, children: motifChildren };
    scene = { ...base, gradients: { ...scene.gradients, ...base.gradients }, root: { ...base.root, children: [...base.root.children, motif] } };
    sw = sh = B;
  }
  scene = withOpaqueBackground(scene, { color: background, keep });
  return { scene, width: sw, height: sh, regions: T.regions.length - drop.size, fidelity: Math.round(res.metrics.weightedFidelity * 1000) / 10, score: st.best.metrics?.score ?? null, tune: st.A.describeTune(st.best.tune), note: [ink ? `modo tinta (${ink.clusters} grupos de trazo)` : null, st.partsNote, backdropNote, "fondo opaco editable"].filter(Boolean).join(" · ") || null };
}

export async function groupReference(st, assignments = null, rasterize) {
  let pieceParts = null;
  if (assignments?.length && st.pieces?.forBest === st.best) pieceParts = new Map(assignments.filter((a) => Number.isInteger(a.piece) && typeof a.part === 'string').map((a) => [a.piece, a.part.trim()]));
  const g = await st.A.regroup(st.best, st.raw, st.aiContext, pieceParts ? { pieces: st.pieces.seg, pieceParts } : {});
  if (!g) return { grouped: false };
  // safety: grouping must not change the drawing. Compare both renders pixel by pixel; anti-aliasing at the new group
  // borders moves well under 1 % of the pixels (wolf: 0.18 %), a lost or misplaced shape moves far more
  const [a, b] = await Promise.all([rasterize(st.best.scene, st.raw.width, st.raw.height), rasterize(g.scene, st.raw.width, st.raw.height)]);
  // a pixel counts as changed only if NO pixel within 1 px in the other render has its colour: sub-pixel shifts of the
  // seams between groups are not changes, a lost or moved shape is
  const W = a.width, H = a.height, near = (P, i, Q, x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = (yy * W + xx) * 4; if (Math.abs(P[i] - Q[j]) + Math.abs(P[i + 1] - Q[j + 1]) + Math.abs(P[i + 2] - Q[j + 2]) <= 30) return true;
    }
    return false;
  };
  let diff = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (!near(a.data, i, b.data, x, y) || !near(b.data, i, a.data, x, y)) diff++; }
  const share = diff / (W * H);
  if (share > 0.01) return { grouped: false, reason: `la versión agrupada cambiaba el ${(share * 100).toFixed(1)} % del dibujo` };
  g.metrics = st.best.metrics; st.best = g;
  let groups = 0; const countG = (n) => { for (const c of n.children || []) if (c.type === 'group') { groups++; countG(c); } }; countG(g.scene.root);
  return { grouped: true, groups, byPieces: g.byPieces || 0, unknownParts: g.unknownParts || [] };
}

export async function referencePieces(st) {
  const [{ buildSegments }, { inkRaster }] = await Promise.all([import('../trace/segments.js'), import('../trace/ink.js')]);
  const ink = st.best.inkData;
  const seg = buildSegments(st.best.res.T, ink ? { inkMask: inkRaster(ink), inkW: ink.width, inkH: ink.height } : {});
  st.pieces = { seg, forBest: st.best };
  return seg;
}

// Identical review artwork in browser and Node: large glyph with defect markers plus 96/48 px views.
export function glyphReviewSvg(st, ref) {
  const { built, ins } = st.glyph.best;
  const color = /^#[0-9a-f]{6}$/i.test(ref.backdrop?.color || '') ? ref.backdrop.color : '#C8643A';
  const gc = /^#[0-9a-f]{6}$/i.test(ref.backdrop?.glyphColor || '') ? ref.backdrop.glyphColor : '#FFFFFF';
  const d = built.polys.map(poly => poly.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ') + ' Z').join(' ');
  const icon = (x, y, D) => {
    const s = .8 * D / Math.max(built.W, built.H), ox = x + D / 2 - built.W * s / 2, oy = y + D / 2 - built.H * s / 2;
    return { s, ox, oy, svg: `<circle cx="${x + D / 2}" cy="${y + D / 2}" r="${D / 2}" fill="${color}"/><path d="${d}" transform="translate(${ox} ${oy}) scale(${s})" fill="${gc}" fill-rule="nonzero"/>` };
  };
  const big = icon(8, 8, 544); let marks = '';
  for (const [key, color, radius] of [['specks', '#FF1E1E', 10], ['thin', '#FF9F1A', 3], ['thinCuts', '#1E7BFF', 3], ['teeth', '#E11EE1', 6]]) {
    for (const p of ins.markers[key]) marks += `<circle cx="${big.ox + p.x * big.s}" cy="${big.oy + p.y * big.s}" r="${radius}" fill="none" stroke="${color}" stroke-width="2"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="744" height="560"><rect width="744" height="560" fill="#FFFFFF"/>${big.svg}${marks}${icon(616, 120, 96).svg}${icon(640, 270, 48).svg}<g fill="#333" font-size="12" font-family="sans-serif"><text x="648" y="232">96 px</text><text x="648" y="336">48 px</text></g></svg>`;
}
