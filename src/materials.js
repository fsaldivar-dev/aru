// Recipes paint existing silhouettes. No geometry, hierarchy or SVG arithmetic from the agent.
import { localBounds } from './scene.js';
import { parentOf } from './edit.js';
const PROFILES = {
  neon: { label: 'Neón', color: '#9C59FF', description: 'Luz saturada y resplandor exterior', surface: 'emissive' },
  chrome: { label: 'Cromado', color: '#7691B8', description: 'Bandas de reflexión claras y oscuras', surface: 'metal' },
  glass: { label: 'Cristal', color: '#298CA5', description: 'Superficie tintada y bordes luminosos', surface: 'glass' },
  clay: { label: 'Clay', color: '#C77B62', description: 'Volumen mate con luces y sombras suaves', surface: 'matte' },
  fruits: { label: 'Fruits', color: '#80BB18', description: 'Gel saturado con brillo concentrado', surface: 'gel' },
};
export const listMaterials = () => Object.entries(PROFILES).map(([id, p]) => ({ id, ...p }));
const walk = (n, fn) => { fn(n); for (const c of n.children || []) walk(c, fn); };
const mix = (a, b, t) => '#' + [0, 2, 4].map(i => Math.round(parseInt(a.slice(i + 1, i + 3), 16) * (1 - t) + parseInt(b.slice(i + 1, i + 3), 16) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
const hash = text => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36); };
const fx = (dx, dy, blur, color, opacity) => ({ dx, dy, blur, color, opacity });
function inherited(scene, node, key, fallback) {
  for (let n = node; n; n = parentOf(scene, n)) {
    // A default width of 1 without a stroke declaration inherits its parent's width.
    if (key === 'strokeWidth' && n.stroke == null && n.strokeWidth === 1) continue;
    if (n[key] != null) return n[key];
  }
  return fallback;
}
function recipe(preset, color, strength, unit) {
  const light = t => mix(color, '#FFFFFF', t * strength), dark = t => mix(color, '#142130', t * strength);
  let stops, shadow = null, inner = [];
  switch (preset) {
    case 'neon': stops = [[0, light(.8)], [.45, color], [1, dark(.18)]]; shadow = fx(0, 0, unit * 1.3, color, .75 * strength); break;
    case 'chrome': stops = [[0, dark(.6)], [.27, light(.9)], [.43, light(.98)], [.48, dark(.85)], [.65, dark(.45)], [.87, light(.8)], [1, dark(.5)]]; shadow = fx(0, unit * .4, unit * .5, '#142130', .35 * strength); inner = [fx(0, unit * .25, unit * .12, '#FFFFFF', .8 * strength), fx(0, -unit * .2, unit * .2, '#142130', .6 * strength)]; break;
    case 'glass': stops = [[0, light(.8)], [.12, light(.4)], [.16, light(.94)], [.2, light(.3)], [.48, dark(.32)], [.75, light(.08)], [.92, light(.5)], [1, dark(.15)]]; shadow = fx(0, unit * .6, unit, '#142130', .25 * strength); inner = [fx(unit * .15, unit * .3, unit * .15, '#FFFFFF', .85 * strength), fx(-unit * .1, -unit * .3, unit * .3, '#FFFFFF', .45 * strength)]; break;
    case 'clay': stops = [[0, light(.25)], [.55, color], [1, dark(.35)]]; shadow = fx(unit * .35, unit * .7, unit * .9, '#332C36', .28 * strength); inner = [fx(unit * .25, unit * .35, unit * .65, '#FFFFFF', .5 * strength), fx(-unit * .25, -unit * .4, unit * .65, '#332C36', .4 * strength)]; break;
    case 'fruits': stops = [[0, light(.85)], [.15, light(.6)], [.28, color], [.65, dark(.12)], [1, dark(.55)]]; shadow = fx(0, unit * .4, unit * .6, '#203014', .3 * strength); inner = [fx(unit * .15, unit * .25, unit * .12, '#FFFFFF', .9 * strength), fx(0, -unit * .4, unit * .35, '#173914', .45 * strength)]; break;
  }
  return { stops: stops.map(([pos, c]) => ({ pos, color: c, opacity: 1 })), shadow, inner };
}
export function applyMaterial(scene, ids, { preset, color, strength = 1 } = {}) {
  if (!Object.hasOwn(PROFILES, preset)) throw new Error('Material: neon, chrome, glass, clay o fruits');
  color ??= PROFILES[preset].color; strength ??= 1;
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('El material necesita color #RRGGBB');
  if (!Number.isFinite(strength) || strength <= 0 || strength > 1) throw new Error('Intensidad del material: mayor que 0 y hasta 1');
  const leaves = new Set();
  for (const id of ids) {
    const n = scene.byId.get(id); if (!n) throw new Error('Pieza inexistente');
    // Preflight the entire target before any mutation, including inherited locks.
    for (let a = n; a && a !== scene.root; a = parentOf(scene, a)) if (a.locked) throw new Error(`Capa bloqueada: ${a.path}`);
    walk(n, c => { if (c.locked) throw new Error(`Capa bloqueada: ${c.path}`); });
    walk(n, c => { if (c.geom && !['group', 'fur'].includes(c.type)) leaves.add(c); });
  }
  const patches = [];
  for (const n of leaves) {
    if (inherited(scene, n, 'hidden', false)) continue;
    const channels = ['fill', 'stroke'].filter(key => inherited(scene, n, key, key === 'fill' ? '#000000' : 'none') !== 'none');
    if (!channels.length) continue;
    const [x0, y0, x1, y1] = localBounds(n), width = inherited(scene, n, 'strokeWidth', 1);
    // Relief is proportional to the painted region, not the size of the selected pack.
    const unit = Math.max(.05, Math.min(20, channels.includes('fill') ? Math.max(1, Math.min(x1 - x0, y1 - y0)) * .12 : width * .5));
    const r = recipe(preset, color.toUpperCase(), strength, unit), pad = channels.includes('stroke') ? width / 2 : 0;
    const g = preset === 'fruits' && channels.includes('fill')
      ? { type: 'radial', angle: .25, cx: .25, cy: .18, r: 1, stops: [[0, mix(color, '#FFFFFF', .95 * strength)], [.12, mix(color, '#FFFFFF', .85 * strength)], [.26, color.toUpperCase()], [.64, color.toUpperCase()], [1, mix(color, '#173914', .65 * strength)]].map(([pos,c])=>({pos,color:c,opacity:1})) }
      : { type: 'linear', angle: 90, cx: .5, cy: .5, r: .5, stops: r.stops, user: { x1: x0 - pad, y1: y0 - pad, x2: x1 + pad, y2: y1 + pad } };
    // Content-addressed, never overwrite a source gradient (even a namespace collision).
    const json = JSON.stringify(g), base = `aru_mat_${preset}_${hash(json)}`; let name = base, i = 2;
    while (scene.gradients[name] && JSON.stringify(scene.gradients[name]) !== json) name = `${base}_${i++}`;
    patches.push({ n, channels, name, g, r, width });
  }
  for (const { n, channels, name, g, r, width } of patches) {
    scene.gradients[name] = g;
    for (const key of channels) n[key] = name;
    if (channels.includes('stroke')) n.strokeWidth = width;
    n.shadow = r.shadow; n.inner = r.inner;
  }
  return `${patches.length} pieza(s), material ${preset}`;
}
