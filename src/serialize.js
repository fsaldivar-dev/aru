// Scene graph -> ARU text. Emits a FLAT document (every repeat/clone/fur expanded into concrete nodes).
import { animateToAru } from './anim.js';

// Used (a) to persist the scene after operations and (b) to measure how much of ARU's compactness
// comes from its syntax vs. from its generative constructs (repeat / clone / fur).

let P = 1000;
const f = (n) => P === null ? String(n) : (Math.round(n * P) / P).toString();
const pair = (p) => `${f(p[0])} ${f(p[1])}`;

export function toAru(scene, { keepNames = true, precision = 3 } = {}) {
  P = precision === null ? null : 10 ** precision;
  const out = [`canvas ${f(scene.width)} ${f(scene.height)}`, `background ${scene.background}`, ''];
  for (const [name, g] of Object.entries(scene.gradients)) {
    const head = g.type === 'radial' ? `gradient ${name} radial ${f(g.cx)} ${f(g.cy)} ${f(g.r)}` : `gradient ${name} linear ${f(g.angle)}`;
    out.push(`${head} {`);
    if (g.user) out.push(`    from ${f(g.user.x1)} ${f(g.user.y1)}`, `    to ${f(g.user.x2)} ${f(g.user.y2)}`);
    for (const s of g.stops) out.push(`    stop ${f(s.pos)} ${s.color}${s.opacity !== 1 ? ' ' + f(s.opacity) : ''}`);
    out.push('}');
  }
  out.push('');
  const LAYER_NAMES = ['background', 'far', 'mid', 'near', 'foreground'];
  const emit = (n, depth) => {
    const ind = '    '.repeat(depth);
    const props = [];
    if (n.at[0] || n.at[1]) props.push(`at ${pair(n.at)}`);
    if (n.rotate) props.push(`rotate ${f(n.rotate)}`);
    if (n.scale[0] !== 1 || n.scale[1] !== 1) props.push(n.scale[0] === n.scale[1] ? `scale ${f(n.scale[0])}` : `scale ${pair(n.scale)}`);
    if (depth === 0 && n.layer !== 2) props.push(`layer ${LAYER_NAMES[n.layer] ?? n.layer}`);
    if (n.label) props.push(`label "${String(n.label).replace(/"/g, "'")}"`);
    if (n.hidden) props.push('hidden 1');
    if (n.locked) props.push('locked 1');
    if (n.animate) props.push(animateToAru(n.animate));
    if (n.semantic) props.push(`semantic ${n.semantic}`);
    if (n.role) props.push(`role ${n.role}`);
    if (n.clip) props.push(`clip ${n.clip}`);
    if (n.type === 'fur') { const t = scene.byId.get(n.clipTarget); if (t) props.push(`clip ${keepNames ? t.name.replace(/[^A-Za-z0-9_]/g, '_') : t.name}`); }
    const g = n.geom || {};
    switch (n.type) {
      case 'circle': props.push(`radius ${f(g.radius)}`); break;
      case 'ellipse': case 'rect': props.push(`size ${pair(g.size)}`); if (g.corner) props.push(`corner ${f(g.corner)}`); break;
      case 'polygon': props.push(`points ${g.points.map(pair).join(' ')}`); break;
      case 'line': props.push(`from ${pair(g.from)}`, `to ${pair(g.to)}`); break;
      case 'text': props.push(`content "${g.content}"`, `font "${g.font}"`, `size ${f(g.size)}`, `weight ${g.weight}`, `anchor ${g.anchor}`); if (g.spacing) props.push(`spacing ${f(g.spacing)}`); if (g.arc) props.push(`arc ${f(g.arc)} ${g.arcSide}`); break;
      case 'path': for (const c of g.commands) props.push(c.args.length ? `${c.cmd} ${c.args.map(f).join(' ')}` : c.cmd); break;
    }
    const fillDefault = n.type === 'line' ? 'none' : null;
    if (n.fill !== fillDefault && n.fill != null) props.push(`fill ${n.fill}`);
    if (n.fillOpacity !== undefined) props[props.length - 1] += ` ${f(n.fillOpacity)}`;
    if (n.stroke != null) props.push(n.stroke === 'none' ? 'stroke none' : `stroke ${n.stroke} ${f(n.strokeWidth)}`);
    if (n.cap) props.push(`cap ${n.cap}`);
    if (n.join) props.push(`join ${n.join}`);
    if (n.dash) props.push(`dash ${n.dash.map(f).join(' ')}`);
    if (n.opacity !== 1) props.push(`opacity ${f(n.opacity)}`);
    const fx = (k, e) => `${k} ${f(e.dx)} ${f(e.dy)} ${f(e.blur)} ${e.color} ${f(e.opacity)}`;
    if (n.shadow) props.push(fx('shadow', n.shadow));
    for (const e of n.inner || []) props.push(fx('inner', e));
    const type = n.type === 'fur' ? 'group' : n.type;
    const name = keepNames ? ' ' + n.name.replace(/[^A-Za-z0-9_]/g, '_') : '';
    if (type === 'group') {
      out.push(`${ind}group${name} {`);
      for (const p of props) out.push(`${ind}    ${p}`);
      for (const c of n.children) emit(c, depth + 1);
      out.push(`${ind}}`);
    } else {
      out.push(`${ind}${type}${name} { ${props.join('; ')} }`);
    }
  };
  for (const c of scene.root.children) emit(c, 0);
  return out.join('\n') + '\n';
}
