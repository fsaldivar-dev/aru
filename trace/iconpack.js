// Icon PACKS (UI icons drawn by the AI in ARU) — inspected, steered and scored like the glyph icons: the tool measures
// what a professional icon designer checks, tells the AI which defect each icon has and which lever fixes it, applies
// the levers (or the AI's redraw of an icon). Geometry quality and blind recognition are scored separately:
// changing a drawing makes its recognition pending, never automatically correct.
//
// Convention (also in the AI's prompt): a pack is ONE group (frame) whose child groups are the icons; each icon's `at`
// is the top-left of its SIZE×SIZE design cell (24 by default) and its content uses local units 0..SIZE.
// Measured on a 4× render of each cell (1 design px = 4 raster px):
//   per icon  bbox / safe area (2 px keyline), visual weight (ink coverage), thin parts (< 1.5 px at 24), specks
//             (< 1 px²), detail (nodes), stroke widths, outline vs filled
//   per pack  duplicates (normalized silhouettes IoU ≥ 0.8), weight / size / stroke / style consistency
// Levers (deterministic, pack-wide): strokeWidth, caps, joins, fitSize (optical size of every icon), color.
// Redraws: the AI may rewrite flagged icons without degrading measured geometry; the new meaning must be retested.
import { maskOpen, maskComponents } from './glyph.js';
import { compile } from '../src/engine.js';
import { toAru } from '../src/serialize.js';

export const PACK_LEVERS = { strokeWidth: [1, 3], fitSize: [14, 22] };
const clone = (o) => JSON.parse(JSON.stringify(o));

// Explicit intent, never merely the number of parts in an illustration.
// `pack` is retained as the legacy frame name; new documents use semantic ui.iconpack.
export function findPack(scene) {
  const cands = scene.root.children.filter((n) => n.type === 'group' &&
    (n.semantic === 'ui.iconpack' || n.name === 'pack') &&
    n.children.filter((c) => c.type === 'group').length >= 3);
  return cands.sort((a, b) => b.children.length - a.children.length)[0] || null;
}

// one icon alone in its SIZE×SIZE cell (for rendering)
const MARGIN = 4; // design px around the cell, so content that overflows the cell is SEEN (and reported as cut off)
function cellScene(scene, icon, size, margin = 0) {
  const ic = { ...clone(icon), at: [margin, margin] };
  return { ...scene, width: size + 2 * margin, height: size + 2 * margin, background: 'none', root: { ...scene.root, children: [ic] } };
}

const walkNodes = (n, fn) => { fn(n); for (const c of n.children || []) walkNodes(c, fn); };
const CLOSED = new Set(['circle', 'ellipse', 'rect', 'polygon', 'path']);
const ARGS = { move: 2, line: 2, curve: 6, quad: 4 };
// does any ancestor group (inside the icon) set a fill?
function inheritsFill(icon, node) { let hit = false; const find = (g, chain) => { for (const c of g.children || []) { if (c === node) { hit = chain.some((a) => a.fill != null); return true; } if (c.type === 'group' && find(c, [...chain, c])) return true; } return false; }; find(icon, [icon]); return hit; }
// a curve drawn as a polyline: ≥ 4 consecutive vertices turning 8–55° with short segments (a heart, a pin, a bubble)
function faceted(m) {
  let pts = null;
  if (m.type === 'polygon') pts = m.geom?.points;
  else if (m.type === 'path') { const c = m.geom?.commands || []; if (c.some((x) => x.cmd === 'curve' || x.cmd === 'quad')) return false; pts = c.filter((x) => x.cmd === 'move' || x.cmd === 'line').map((x) => [x.args[0], x.args[1]]); }
  if (!pts || pts.length < 6) return false;
  let run = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1], v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2); if (!l1 || !l2) { run = 0; continue; }
    const t = (Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))) * 180) / Math.PI;
    run = t >= 8 && t <= 55 && l1 < 7 && l2 < 7 ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}
// ARU mistakes that render wrong without any compiler error — each with the exact fix (and auto-fixable by `repair`)
export function lintIcon(icon) {
  const out = [];
  walkNodes(icon, (m) => {
    if (m === icon || m.type === 'group') return;
    const stroked = m.stroke && m.stroke !== 'none';
    if (m.type === 'path') for (const c of m.geom?.commands || []) if (ARGS[c.cmd] && c.args.length > ARGS[c.cmd]) { out.push({ kind: 'args', node: m.name, text: `«${m.name}»: "${c.cmd}" con ${c.args.length} números — un punto por comando: "move X Y" y luego "line X Y" por cada punto (repair lo corrige)` }); break; }
    if (CLOSED.has(m.type) && m.fill == null && stroked && !inheritsFill(icon, m)) out.push({ kind: 'defaultFill', node: m.name, text: `«${m.name}» tiene trazo pero no "fill": se rellena de NEGRO por defecto — añade "fill none" (repair lo corrige)` });
    if (faceted(m)) out.push({ kind: 'faceted', node: m.name, text: `«${m.name}» es una curva hecha de tramos rectos (se ve facetada) — dibújala con "curve" (Bézier)` });
    if (!stroked && m.fill === 'none') out.push({ kind: 'invisible', node: m.name, text: `«${m.name}» es invisible ("fill none" y sin "stroke") — añade "stroke COLOR 2" (repair lo corrige)` });
  });
  return out;
}

// ------------------------------------------------------------------------------------------------- inspect
// rasterize(scene, W, H) -> RGBA on white (injected: canvas in the browser, Chrome in Node)
export async function inspectPack(scene, pack, rasterize, { size = 24, recognition = null } = {}) {
  const R = 4, M = MARGIN, W = (size + 2 * M) * R, icons = [], list = pack.children.filter((c) => c.type === 'group');
  const imgs = await Promise.all(list.map((icon) => rasterize(cellScene(scene, icon, size, M), W, W))); // all cells at once
  for (const [k, icon] of list.entries()) {
    const img = imgs[k];
    let renderHash = 2166136261;
    for (const value of img.data) renderHash = Math.imul(renderHash ^ value, 16777619) >>> 0;
    const mask = new Uint8Array(W * W);
    for (let i = 0; i < mask.length; i++) { const p = i * 4; if (Math.max(255 - img.data[p], 255 - img.data[p + 1], 255 - img.data[p + 2]) > 40) mask[i] = 1; }
    let x0 = W, y0 = W, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { n++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    const empty = n === 0;
    const bbox = empty ? [0, 0, 0, 0] : [x0 / R - M, y0 / R - M, (x1 + 1) / R - M, (y1 + 1) / R - M]; // cell coordinates
    const thinMask = maskOpen(mask, W, W, 0.75 * R); // parts thinner than 1.5 design px vanish
    let thin = 0; for (let i = 0; i < mask.length; i++) if (mask[i] && !thinMask[i]) thin++;
    const specks = maskComponents(mask, W, W, 1).filter((c) => c.n < R * R).length;
    // what the ARU says: nodes, stroke widths, filled vs outline
    // stroke widths as RENDERED (width × accumulated group scale): fitSize compensates widths for its scale
    let nodes = 0, filled = 0, stroked = 0; const widths = new Set();
    const visit = (m, k) => {
      for (const c of m.children || []) {
        const kk = k * (c.type === 'group' ? Math.abs(c.scale?.[0] ?? 1) : 1);
        if (c.type === 'group') { visit(c, kk); continue; }
        nodes += c.type === 'path' ? Math.max(1, (c.geom?.commands || []).length / 3) : 1;
        if ((c.fill && c.fill !== 'none') || (c.fill == null && CLOSED.has(c.type) && !inheritsFill(icon, c))) filled++;
        if (c.stroke && c.stroke !== 'none') { stroked++; widths.add(Math.round(c.strokeWidth * kk * 10) / 10); }
      }
    };
    visit(icon, 1);
    const lint = lintIcon(icon);
    icons.push({ name: icon.name, label: icon.label || icon.name, renderHash, empty, bbox, lint, size: Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]),
      weight: n / ((size * R) ** 2), cut: !empty && (bbox[0] < -0.01 || bbox[1] < -0.01 || bbox[2] > size + 0.01 || bbox[3] > size + 0.01), thin: n ? thin / n : 0, specks, nodes: Math.round(nodes), widths: [...widths], style: stroked && !filled ? 'outline' : filled && !stroked ? 'filled' : 'mixed',
      outside: !empty && (bbox[0] < 1 || bbox[1] < 1 || bbox[2] > size - 1 || bbox[3] > size - 1), sig: signature(mask, W, x0, y0, x1, y1) });
  }
  // pack consistency
  const live = icons.filter((i) => !i.empty), med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const mWeight = med(live.map((i) => i.weight)), mSize = med(live.map((i) => i.size));
  const styleCount = {}; for (const i of live) styleCount[i.style] = (styleCount[i.style] || 0) + 1;
  const mainStyle = Object.entries(styleCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'outline';
  const allWidths = new Set(live.flatMap((i) => i.widths));
  const dups = [];
  for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) { const s = iou(live[a].sig, live[b].sig); if (s >= 0.8) dups.push([live[a].name, live[b].name, Math.round(s * 100) / 100]); }
  const dupOf = new Map(); for (const [a, b] of dups) { dupOf.set(b, a); }
  const recognitionSummary = { recognized: 0, failed: 0, unverified: 0, total: icons.length, complete: false };
  for (const i of icons) {
    const issues = []; let pen = 0; const add = (w, t) => { issues.push(t); pen += w; };
    if (i.empty) add(0.6, 'vacío (no se ve nada)');
    if (i.cut) add(0.5, 'se sale de su celda de 24 (queda cortado)');
    else if (i.outside) add(0.15, 'se sale de la zona segura (1–23)');
    if (dupOf.has(i.name)) add(0.4, `repite la silueta de «${dupOf.get(i.name)}»`);
    for (const l of i.lint) add(l.kind === 'faceted' ? 0.2 : 0.3, l.text);
    if (!i.empty && i.style !== mainStyle) add(0.25, `estilo ${i.style} en un pack ${mainStyle}`);
    if (!i.empty && mSize && Math.abs(i.size - mSize) / mSize > 0.15) add(0.15, `tamaño óptico ${i.size.toFixed(1)} px frente a ${mSize.toFixed(1)} del pack`);
    if (!i.empty && mWeight && Math.abs(i.weight - mWeight) / mWeight > 0.4) add(0.15, `peso visual ${(i.weight * 100).toFixed(0)} % frente a ${(mWeight * 100).toFixed(0)} %`);
    if (i.thin > 0.08) add(0.15, `${(i.thin * 100).toFixed(0)} % de trazos de menos de 1,5 px`);
    if (i.specks) add(0.1, `${i.specks} motas`);
    if (i.nodes > 40) add(0.15, `demasiado detalle para 24 px (${i.nodes} nodos)`);
    i.geometryScore = Math.max(0, 1 - pen);
    const rec = recognition?.get(i.name);
    i.recognition = rec?.ok === true ? 'recognized' : rec?.ok === false ? 'failed' : 'unverified';
    recognitionSummary[i.recognition]++;
    // Unverified carries exactly the failed-recognition penalty. Removing an old failure after a redraw
    // must not improve the score; only a fresh successful blind test can release this penalty.
    if (i.recognition === 'failed') add(0.4, `en la prueba ciega no se reconoce como «${i.label}» (se leyó como «${rec.readAs}»)`);
    else if (i.recognition === 'unverified') add(0.4, `reconocimiento pendiente: «${i.label}» todavía no tiene una prueba ciega válida para este dibujo`);
    i.issues = issues;
    i.score = Math.max(0, 1 - pen);
  }
  const consistency = Math.max(0, 1 - 0.15 * Math.max(0, allWidths.size - 1) - 0.1 * Math.max(0, Object.keys(styleCount).length - 1) - 0.08 * dups.length);
  // a pack is as professional as its WORST icon: mean and minimum both count
  const aggregate = key => {
    const mean = icons.reduce((s, i) => s + i[key], 0) / Math.max(1, icons.length), worst = Math.min(1, ...icons.map(i => i[key]));
    return Math.round((0.4 * mean + 0.2 * worst + 0.4 * consistency) * 1000) / 1000;
  };
  recognitionSummary.complete = recognitionSummary.unverified === 0;
  return { score: aggregate('score'), geometryScore: aggregate('geometryScore'), recognition: recognitionSummary,
    consistency: Math.round(consistency * 1000) / 1000, icons, duplicates: dups, widths: [...allWidths], mainStyle, medianSize: mSize, medianWeight: mWeight, size };
}
// normalized silhouette: the content box resampled to 16×16
function signature(mask, W, x0, y0, x1, y1) {
  const s = new Uint8Array(256); if (x1 < 0) return s;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, side = Math.max(w, h), ox = x0 - (side - w) / 2, oy = y0 - (side - h) / 2;
  for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) {
    let on = 0, tot = 0;
    for (let y = Math.floor(oy + (j * side) / 16); y < Math.floor(oy + ((j + 1) * side) / 16); y++) for (let x = Math.floor(ox + (i * side) / 16); x < Math.floor(ox + ((i + 1) * side) / 16); x++) { tot++; if (x >= 0 && y >= 0 && x < W && y < W && mask[y * W + x]) on++; }
    s[j * 16 + i] = tot && on / tot > 0.3 ? 1 : 0;
  }
  return s;
}
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; } return u ? i / u : 0; };

// ------------------------------------------------------------------------------------------------- levers + redraws
// returns a NEW scene (the input is not modified)
export function applyPackLevers(scene0, levers = {}, inspection = null) {
  const scene = clone(scene0), pack = findPack(scene); if (!pack) return scene;
  const sw = Number(levers.strokeWidth), fit = Number(levers.fitSize), hex = /^#[0-9a-f]{6}$/i;
  if (levers.repair) repairPack(pack, { color: hex.test(levers.color || '') ? levers.color : null, width: Number.isFinite(sw) ? sw : null });
  for (const icon of pack.children.filter((c) => c.type === 'group')) {
    let s = 1;
    // fitSize: every icon scaled about its content centre to the same optical size, centred in its cell
    const ins = inspection?.icons.find((i) => i.name === icon.name);
    if (Number.isFinite(fit) && ins && !ins.empty && ins.size > 0) {
      s = Math.max(0.5, Math.min(2, fit / ins.size));
      const cx = (ins.bbox[0] + ins.bbox[2]) / 2, cy = (ins.bbox[1] + ins.bbox[3]) / 2, half = inspection.size / 2;
      const inner = { id: -1, type: 'group', name: 'contenido', at: [half - s * cx, half - s * cy], rotate: 0, scale: [s, s], fill: null, stroke: null, strokeWidth: 1, opacity: 1, layer: 2, geom: {}, children: icon.children };
      icon.children = [inner];
    }
    walkNodes(icon, (m) => {
      if (m === icon) return;
      const stroked = m.stroke && m.stroke !== 'none';
      if (stroked && Number.isFinite(sw)) m.strokeWidth = Math.round((sw / s) * 1000) / 1000; // the rendered width stays sw
      else if (stroked && s !== 1) m.strokeWidth = Math.round((m.strokeWidth / s) * 1000) / 1000;
      if (stroked && ['round', 'butt', 'square'].includes(levers.caps)) m.cap = levers.caps;
      if (stroked && ['round', 'miter', 'bevel'].includes(levers.joins)) m.join = levers.joins;
      if (hex.test(levers.color || '')) { if (stroked) m.stroke = levers.color; if (m.fill && m.fill !== 'none' && m.type !== 'group') m.fill = levers.color; }
    });
  }
  return scene;
}
// repair (lever): fixes the lint mistakes deterministically — multi-point move/line split into move + lines, default
// black fills of stroked shapes -> fill none, invisible shapes -> stroked with the pack colour/width; path coordinates
// with no stroke and no fill in an outline pack get the pack stroke
function repairPack(pack, { color, width }) {
  const strokes = []; walkNodes(pack, (m) => { if (m.stroke && m.stroke !== 'none') strokes.push([m.stroke, m.strokeWidth]); });
  const freq = (a) => { const c = new Map(); for (const v of a) c.set(v, (c.get(v) || 0) + 1); return [...c].sort((x, y) => y[1] - x[1])[0]?.[0]; };
  const col = color || freq(strokes.map((x) => x[0])) || '#222222', wid = width || freq(strokes.map((x) => x[1])) || 2;
  for (const icon of pack.children.filter((c) => c.type === 'group')) walkNodes(icon, (m) => {
    if (m === icon || m.type === 'group') return;
    if (m.type === 'path') {
      const cmds = [];
      for (const c of m.geom?.commands || []) {
        const n = ARGS[c.cmd];
        if (n && c.args.length > n && (c.cmd === 'move' || c.cmd === 'line')) {
          const pts = c.args.slice(0, c.args.length - (c.args.length % 2));
          for (let i = 0; i < pts.length; i += 2) cmds.push({ cmd: i === 0 ? c.cmd : 'line', args: [pts[i], pts[i + 1]] });
        } else cmds.push(c);
      }
      m.geom.commands = cmds;
    }
    const stroked = m.stroke && m.stroke !== 'none';
    if (CLOSED.has(m.type) && m.fill == null && stroked && !inheritsFill(icon, m)) m.fill = 'none';
    if (!stroked && (m.fill === 'none' || (m.type === 'path' && m.fill == null))) { m.fill = 'none'; m.stroke = col; m.strokeWidth = wid; m.cap = m.cap || 'round'; m.join = m.join || 'round'; }
  });
}
// redraw: replace an icon's content with the AI's ARU (local 0..SIZE units)
export function applyRedraw(scene0, name, aru, { size = 24 } = {}) {
  const r = compile(`canvas ${size} ${size}\nbackground none\n${aru}`);
  if (!r.scene || r.errors.length) return { ok: false, error: r.errors[0]?.message || 'no compila' };
  const scene = clone(scene0), pack = findPack(scene), icon = pack?.children.find((c) => c.name === name);
  if (!icon) return { ok: false, error: `no existe el icono «${name}»` };
  icon.children = clone(r.scene.root.children);
  for (const [k, g] of Object.entries(r.scene.gradients || {})) scene.gradients[k] = g;
  return { ok: true, scene };
}
export const sceneToAru = (scene) => toAru(scene, { precision: 3 });

// the report the AI reads
export function packReport(ins, levers) {
  const bad = ins.icons.filter((i) => i.issues.length);
  return `Icon pack inspection (${ins.icons.length} icons, ${ins.size}×${ins.size} design grid, safe area 1–23, professional UI icons: one style, one stroke width, same optical size, no duplicates, legible at 24 px):
- pack score ${ins.score} (geometry ${ins.geometryScore}, consistency ${ins.consistency}); main style ${ins.mainStyle}; stroke widths in use ${JSON.stringify(ins.widths)}; median optical size ${ins.medianSize.toFixed(1)} px
- blind recognition: ${ins.recognition.recognized}/${ins.recognition.total} recognized, ${ins.recognition.failed} failed, ${ins.recognition.unverified} unverified. Geometry measurements do not establish meaning; every changed drawing needs a fresh blind test.
- duplicates: ${ins.duplicates.length ? ins.duplicates.map(([a, b, s]) => `${a} ≈ ${b} (${s})`).join(', ') : 'none'}
${bad.length ? bad.map((i) => `- ${i.name} («${i.label}»): ${i.issues.join('; ')}`).join('\n') : '- no icon has issues'}
Levers (whole pack, deterministic): repair true|false (fixes the ARU mistakes listed above: multi-point move, default black fill, invisible shapes), strokeWidth ${JSON.stringify(PACK_LEVERS.strokeWidth)} (one width for all strokes), caps round|butt|square, joins round|miter|bevel,
fitSize ${JSON.stringify(PACK_LEVERS.fitSize)} (scales every icon to the same optical size, centred), color #RRGGBB (one colour).
Current levers: ${JSON.stringify(levers)}.
Redraw ONLY icons that a lever cannot fix (duplicates, empty, illegible, too detailed, wrong style): give their new ARU content in local 0..${ins.size} units (no group wrapper, no "at" for the icon itself).`;
}

// the pack as an ARU FRAGMENT (no canvas/background lines) for insertion
export const packFragment = (scene) => sceneToAru(scene).split('\n').filter((l) => !/^(canvas|background) /.test(l)).join('\n').trim();
