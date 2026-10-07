// Renderer: Scene -> SVG markup string. SVG is only a render target; ARU never exposes it.

import { animationCss } from './anim.js';
import { localBounds } from './scene.js';

let PREC = 100;
const fmt = (n) => (Math.round(n * PREC) / PREC).toString();

// effects -> one SVG <filter> per distinct combination (ids in first-use order: deterministic)
let EFFECTS = new Map();
function effectId(n) {
  // SVG's default objectBoundingBox filter has zero area on horizontal/vertical lines.
  // Give these silhouettes an explicit local region so adding relief never erases a stroke.
  let bounds = null;
  if (n.geom && n.type !== 'text') {
    const b = localBounds(n);
    if (b[2] === b[0] || b[3] === b[1]) {
      const effects = [n.shadow, ...(n.inner || [])].filter(Boolean);
      const pad = Math.max(1, n.strokeWidth || 1) + Math.max(0, ...effects.map(e => e.blur * 3 + Math.max(Math.abs(e.dx), Math.abs(e.dy))));
      bounds = [b[0] - pad, b[1] - pad, b[2] - b[0] + pad * 2, b[3] - b[1] + pad * 2];
    }
  }
  const key = JSON.stringify([n.shadow || null, n.inner || [], bounds]);
  if (!EFFECTS.has(key)) EFFECTS.set(key, { id: `fx-${EFFECTS.size + 1}`, shadow: n.shadow, inner: n.inner || [], bounds });
  return EFFECTS.get(key).id;
}
function effectSvg({ id, shadow, inner, bounds }) {
  const parts = [], f = (v) => fmt(v);
  let src = 'SourceGraphic';
  inner.forEach((e, k) => { // inner shadow / highlight: the offset, blurred silhouette subtracted from the shape, tinted
    parts.push(`<feOffset in="SourceAlpha" dx="${f(e.dx)}" dy="${f(e.dy)}" result="io${k}"/>`, `<feGaussianBlur in="io${k}" stdDeviation="${f(e.blur / 2)}" result="ib${k}"/>`,
      `<feComposite in="SourceAlpha" in2="ib${k}" operator="arithmetic" k1="-1" k2="1" k3="0" result="ia${k}"/>`, `<feFlood flood-color="${e.color}" flood-opacity="${f(e.opacity)}"/>`,
      `<feComposite in2="ia${k}" operator="in" result="is${k}"/>`, `<feMerge result="im${k}"><feMergeNode in="${src}"/><feMergeNode in="is${k}"/></feMerge>`);
    src = `im${k}`;
  });
  if (shadow) parts.push(`<feDropShadow in="${src}" dx="${f(shadow.dx)}" dy="${f(shadow.dy)}" stdDeviation="${f(shadow.blur / 2)}" flood-color="${shadow.color}" flood-opacity="${f(shadow.opacity)}"/>`);
  const region = bounds ? `filterUnits="userSpaceOnUse" x="${f(bounds[0])}" y="${f(bounds[1])}" width="${f(bounds[2])}" height="${f(bounds[3])}"` : 'x="-40%" y="-40%" width="180%" height="180%"';
  return `<filter id="${id}" ${region} color-interpolation-filters="sRGB">${parts.join('')}</filter>`;
}
export function renderScene(scene, opts = {}) {
  EFFECTS = new Map();
  const { pretty = true, dataAttrs = true, precision = 2, dedupe = false } = opts;
  PREC = 10 ** precision;
  const nl = pretty ? '\n' : '';
  const ind = (d) => (pretty ? '  '.repeat(d) : '');
  const out = [];
  const clips = [];
  // dedupe: identical group contents are emitted once in <defs> and referenced with <use> (what a careful SVG author would do)
  const shared = dedupe ? findSharedGroups(scene, { pretty: false, dataAttrs: false, clips: [], ind: () => '', nl: '' }) : null;
  const symbols = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(scene.width)} ${fmt(scene.height)}" width="${fmt(scene.width)}" height="${fmt(scene.height)}">`);
  // defs: gradients + clip paths (collected after walking)
  const body = [];
  // clip ids are numbered in render order, so identical scenes give identical SVG whatever their build history
  const anims = [];
  if (opts.animate !== false) walkRender(scene.root, body, 1, scene, { pretty, dataAttrs, clips, ind, nl, shared, symbols, clipSeq: 0, anims });
  else walkRender(scene.root, body, 1, scene, { pretty, dataAttrs, clips, ind, nl, shared, symbols, clipSeq: 0, anims: null });
  const defs = [];
  for (const [name, g] of Object.entries(scene.gradients)) defs.push(gradientSvg(name, g, ind, nl));
  for (const c of clips) defs.push(c);
  for (const c of symbols) defs.push(c);
  for (const e of EFFECTS.values()) defs.push(ind(2) + effectSvg(e));
  if (defs.length) out.push(`${ind(1)}<defs>${nl}${defs.join(nl)}${nl}${ind(1)}</defs>`);
  if (anims.length) out.push(ind(1) + animationCss(anims));
  if (scene.background !== 'none') out.push(`${ind(1)}<rect width="${fmt(scene.width)}" height="${fmt(scene.height)}" fill="${scene.background}"/>`);
  out.push(...body);
  out.push('</svg>');
  return out.join(nl);
}

function gradientSvg(name, g, ind, nl) {
  const stops = g.stops.map((s) => `${ind(3)}<stop offset="${fmt(s.pos * 100)}%" stop-color="${s.color}"${s.opacity !== 1 ? ` stop-opacity="${fmt(s.opacity)}"` : ''}/>`).join(nl);
  if (g.type === 'radial') {
    return `${ind(2)}<radialGradient id="g-${name}" cx="${fmt(g.cx)}" cy="${fmt(g.cy)}" r="${fmt(g.r)}">${nl}${stops}${nl}${ind(2)}</radialGradient>`;
  }
  if (g.user) return `${ind(2)}<linearGradient id="g-${name}" gradientUnits="userSpaceOnUse" x1="${fmt(g.user.x1)}" y1="${fmt(g.user.y1)}" x2="${fmt(g.user.x2)}" y2="${fmt(g.user.y2)}">${nl}${stops}${nl}${ind(2)}</linearGradient>`;
  // angle: 0 = left->right, 90 = top->bottom (in bounding-box units)
  const a = g.angle * Math.PI / 180;
  const x1 = 0.5 - Math.cos(a) / 2, y1 = 0.5 - Math.sin(a) / 2, x2 = 0.5 + Math.cos(a) / 2, y2 = 0.5 + Math.sin(a) / 2;
  return `${ind(2)}<linearGradient id="g-${name}" x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}">${nl}${stops}${nl}${ind(2)}</linearGradient>`;
}

function paint(v, scene) {
  if (v == null) return null;
  if (v === 'none') return 'none';
  if (scene.gradients[v]) return `url(#g-${v})`;
  return v;
}

function transformAttr(n) {
  const parts = [];
  // compare the *printed* values so near-identity transforms (0.9996) are omitted consistently
  const [tx, ty, r, sx, sy] = [n.at[0], n.at[1], n.rotate, n.scale[0], n.scale[1]].map(fmt);
  if (tx !== '0' || ty !== '0') parts.push(`translate(${tx} ${ty})`);
  if (r !== '0') parts.push(`rotate(${r})`);
  if (sx !== '1' || sy !== '1') parts.push(`scale(${sx} ${sy})`);
  return parts.length ? ` transform="${parts.join(' ')}"` : '';
}

function styleAttrs(n, scene, isGroup) {
  const a = [];
  // null fill/stroke = not set on this node -> inherited from the enclosing group (SVG inheritance)
  const f = paint(n.fill, scene); if (f !== null) a.push(`fill="${f}"`);
  if (n.fillOpacity !== undefined) a.push(`fill-opacity="${fmt(n.fillOpacity)}"`);
  if (n.stroke !== null) {
    a.push(`stroke="${paint(n.stroke, scene)}"`);
    if (n.stroke !== 'none') a.push(`stroke-width="${fmt(n.strokeWidth)}"`);
  } else if (n.strokeWidth !== 1 && !isGroup) a.push(`stroke-width="${fmt(n.strokeWidth)}"`);
  if (n.cap) a.push(`stroke-linecap="${n.cap}"`);
  if (n.join) a.push(`stroke-linejoin="${n.join}"`);
  if (n.dash && n.dash.length) a.push(`stroke-dasharray="${n.dash.map(fmt).join(' ')}"`);
  if (n.opacity !== 1) a.push(`opacity="${fmt(n.opacity)}"`);
  if (n.shadow || (n.inner && n.inner.length)) a.push(`filter="url(#${effectId(n)})"`);
  return a.length ? ' ' + a.join(' ') : '';
}

export function pathData(commands) {
  const parts = [];
  for (const c of commands) {
    const a = c.args.map(fmt);
    switch (c.cmd) {
      case 'move': parts.push(`M${a[0]} ${a[1]}`); break;
      case 'line': parts.push(`L${a[0]} ${a[1]}`); break;
      case 'curve': parts.push(`C${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} ${a[5]}`); break;
      case 'quad': parts.push(`Q${a[0]} ${a[1]} ${a[2]} ${a[3]}`); break;
      case 'smooth': parts.push(`S${a[0]} ${a[1]} ${a[2]} ${a[3]}`); break;
      case 'arc': parts.push(`A${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} ${a[5]} ${a[6]}`); break;
      case 'close': parts.push('Z'); break;
    }
  }
  return parts.join(' ');
}

export function shapeMarkup(n) {
  const g = n.geom;
  switch (n.type) {
    case 'circle': return ['circle', `r="${fmt(g.radius)}"`];
    case 'ellipse': return ['ellipse', `rx="${fmt(g.size[0] / 2)}" ry="${fmt(g.size[1] / 2)}"`];
    case 'rect': return ['rect', `x="${fmt(-g.size[0] / 2)}" y="${fmt(-g.size[1] / 2)}" width="${fmt(g.size[0])}" height="${fmt(g.size[1])}"${g.corner ? ` rx="${fmt(g.corner)}"` : ''}`];
    case 'polygon': return ['polygon', `points="${g.points.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(' ')}"`];
    case 'line': return ['line', `x1="${fmt(g.from[0])}" y1="${fmt(g.from[1])}" x2="${fmt(g.to[0])}" y2="${fmt(g.to[1])}"`];
    case 'path': return ['path', `d="${pathData(g.commands)}"`];
  }
  return null;
}

function walkRender(node, out, depth, scene, ctx) {
  const { ind, nl, dataAttrs, clips } = ctx;
  for (const n of node.children) {
    if (n.hidden) continue;
    const start = out.length;
    try {
    const data = dataAttrs ? ` data-aru="${n.path}" data-id="${n.id}"` : '';
    if (n.type === 'group' || n.type === 'fur') {
      let clipAttr = '';
      // clip target: fur -> its target; `clip name` -> a child shape, or else a sibling shape
      let clipTarget = n.type === 'fur' ? scene.byId.get(n.clipTarget) : null, siblingClip = n.type === 'fur';
      if (!clipTarget && n.clip) {
        clipTarget = n.children.find((c) => c.name === n.clip) || null;
        if (!clipTarget) { clipTarget = node.children.find((c) => c.name === n.clip && c !== n) || null; siblingClip = !!clipTarget; }
      }
      const hasOwnTransform = transformAttr(n) !== '';
      if (clipTarget && siblingClip && hasOwnTransform) { // sibling lives in parent space: clip an outer wrapper instead
        const sm = shapeMarkup(clipTarget), cid = `clip-${ctx.clipSeq = (ctx.clipSeq || 0) + 1}`;
        clips.push(`${ind(2)}<clipPath id="${cid}"><${sm[0]} ${sm[1]}${transformAttr(clipTarget)}/></clipPath>`);
        out.push(`${ind(depth)}<g clip-path="url(#${cid})">`);
        out.push(`${ind(depth + 1)}<g${data}${transformAttr(n)}${styleAttrs(n, scene, true)}>`);
        walkRender(n, out, depth + 2, scene, ctx);
        out.push(`${ind(depth + 1)}</g>`, `${ind(depth)}</g>`);
        continue;
      }
      if (clipTarget) {
        const sm = shapeMarkup(clipTarget);
        if (sm) {
          const cid = `clip-${ctx.clipSeq = (ctx.clipSeq || 0) + 1}`;
          clips.push(`${ind(2)}<clipPath id="${cid}"><${sm[0]} ${sm[1]}${transformAttr(clipTarget)}/></clipPath>`);
          clipAttr = ` clip-path="url(#${cid})"`;
        }
      }
      if (ctx.shared && !clipAttr) {
        const key = ctx.shared.keyOf.get(n);
        if (key && ctx.shared.count.get(key) > 1) {
          let id = ctx.shared.ids.get(key);
          if (!id) {
            id = `s${ctx.shared.ids.size + 1}`; ctx.shared.ids.set(key, id);
            const inner = []; walkRender(n, inner, 3, scene, ctx);
            ctx.symbols.push(`${ind(2)}<g id="${id}">${nl}${inner.join(nl)}${nl}${ind(2)}</g>`);
          }
          out.push(`${ind(depth)}<use href="#${id}"${data}${transformAttr(n)}${styleAttrs(n, scene, true)}/>`);
          continue;
        }
      }
      out.push(`${ind(depth)}<g${data}${transformAttr(n)}${styleAttrs(n, scene, true)}${clipAttr}>`);
      walkRender(n, out, depth + 1, scene, ctx);
      out.push(`${ind(depth)}</g>`);
      continue;
    }
    if (n.type === 'text') { out.push(textMarkup(n, data, depth, scene, ctx)); continue; }
    const sm = shapeMarkup(n);
    if (!sm) continue;
    out.push(`${ind(depth)}<${sm[0]}${data} ${sm[1]}${transformAttr(n)}${styleAttrs(n, scene, false)}/>`);
    } finally {
      // animated node: wrap whatever it emitted in a class whose CSS animation runs around its own centre
      if (n.animate && ctx.anims && out.length > start) {
        const cls = `aru-a-${ctx.anims.length + 1}`;
        ctx.anims.push({ cls, anim: n.animate });
        out.splice(start, 0, `${ind(depth)}<g class="${cls}">`);
        out.push(`${ind(depth)}</g>`);
      }
    }
  }
}

function findSharedGroups(scene, flatCtx) {
  const keyOf = new Map(), count = new Map();
  const visit = (n) => {
    for (const c of n.children) {
      if ((c.type === 'group') && !c.clip && c.children.length) {
        const inner = []; walkRender(c, inner, 0, scene, { ...flatCtx, clips: [] });
        const key = inner.join('');
        if (key.length > 60 && !key.includes('clip-path')) { keyOf.set(c, key); count.set(key, (count.get(key) || 0) + 1); }
      }
      visit(c);
    }
  };
  visit(scene.root);
  return { keyOf, count, ids: new Map() };
}

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// text, straight or along a circular arc (badges / crests). Fonts are system fonts: convert to outlines for print.
function textMarkup(n, data, depth, scene, ctx) {
  const g = n.geom, ind = ctx.ind;
  const attrs = `font-family="${xmlEsc(g.font)}" font-size="${fmt(g.size)}" font-weight="${xmlEsc(g.weight)}"${g.italic ? ' font-style="italic"' : ''}${g.spacing ? ` letter-spacing="${fmt(g.spacing)}"` : ''} dominant-baseline="${xmlEsc(g.baseline)}"${styleAttrs(n, scene, false)}`;
  if (!g.arc) return `${ind(depth)}<text${data} text-anchor="${xmlEsc(g.anchor)}"${transformAttr(n)} ${attrs}>${xmlEsc(g.content)}</text>`;
  const R = fmt(g.arc), id = `arc-${ctx.textSeq = (ctx.textSeq || 0) + 1}`;
  const d = g.arcSide === 'bottom' ? `M-${R} 0 A${R} ${R} 0 0 0 ${R} 0` : `M-${R} 0 A${R} ${R} 0 0 1 ${R} 0`;
  return `${ind(depth)}<g${data}${transformAttr(n)}><path id="${id}" d="${d}" fill="none"/><text ${attrs}><textPath href="#${id}" startOffset="50%" text-anchor="middle">${xmlEsc(g.content)}</textPath></text></g>`;
}
