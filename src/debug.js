// Debug overlays for the playground. Produces SVG markup drawn on top of the rendered scene.
// Modes: final | blueprint | regions | landmarks | geometry
import { walkScene } from './scene.js';
import { hashString } from './geom.js';

const f = (n) => Math.round(n * 10) / 10;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function debugOverlay(scene, mode, opts = {}) {
  if (mode === 'final') return '';
  const fs = Math.max(8, scene.width / 85), dot = fs * 0.35;
  const out = [`<g class="aru-debug" pointer-events="none" font-family="ui-monospace,Menlo,monospace" font-size="${f(fs)}">`];
  const label = (x, y, text, color = '#fff') => out.push(`<text x="${f(x + dot * 1.6)}" y="${f(y - dot * 1.2)}" fill="${color}" stroke="#000" stroke-width="${f(fs / 4)}" paint-order="stroke">${esc(text)}</text>`);

  for (const [, rt] of scene.blueprints) {
    const bp = rt.bp, L = bp.allLandmarks();
    const lm = new Map(L.map((l) => [l.name, l.p]));
    if (mode === 'blueprint') {
      const F = bp.frame;
      out.push(`<rect x="${F.x}" y="${F.y}" width="${F.w}" height="${F.h}" fill="none" stroke="#9aa4ff" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>`);
      label(F.x, F.y + fs * 1.6, `blueprint ${bp.name}  ·  light ${bp.light}  ·  symmetry ${bp.symmetry.mode}`, '#c7ccff');
      if (bp.symmetry.mode !== 'none') {
        const ax = bp.axisAbs();
        out.push(`<line x1="${f(ax)}" y1="${F.y}" x2="${f(ax)}" y2="${F.y + F.h}" stroke="#ff4fd8" stroke-width="1.5" stroke-dasharray="10 6" vector-effect="non-scaling-stroke"/>`);
      }
      // connections: the anchor chain of every region / contour (how landmarks are wired into geometry)
      for (const el of bp.elements) {
        const d = rt.debug.get(el.name);
        if (!d?.anchors || d.anchors.length < 2) continue;
        const pts = d.anchors.map((a) => a.p);
        const closed = d.kind === 'region';
        out.push(`<polyline points="${(closed ? [...pts, pts[0]] : pts).map((p) => `${f(p[0])},${f(p[1])}`).join(' ')}" fill="none" stroke="${hue(el.name)}" stroke-width="1" opacity="0.85" vector-effect="non-scaling-stroke"/>`);
      }
      // mirror pairs
      for (const l of L) if (l.def.kind === 'mirror') { const a = lm.get(l.def.of); out.push(`<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(l.p[0])}" y2="${f(l.p[1])}" stroke="#ff4fd8" stroke-width="0.8" stroke-dasharray="2 4" opacity="0.7" vector-effect="non-scaling-stroke"/>`); }
    }
    if (mode === 'regions') {
      for (const el of bp.elements) {
        const d = rt.debug.get(el.name);
        if (!d?.boundary) continue;
        const c = hue(el.name);
        out.push(`<polygon points="${d.boundary.map((p) => `${f(p[0])},${f(p[1])}`).join(' ')}" fill="${c}" fill-opacity="0.22" stroke="${c}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`);
      }
      for (const el of bp.elements) {
        const d = rt.debug.get(el.name);
        if (!d?.boundary) continue;
        const cx = d.boundary.reduce((s, p) => s + p[0], 0) / d.boundary.length, cy = d.boundary.reduce((s, p) => s + p[1], 0) / d.boundary.length;
        label(cx - fs * 2, cy, el.name + (el.mirrorOf ? ` ⇐ ${el.mirrorOf}` : ''), hue(el.name, 85));
      }
    }
    if (mode === 'blueprint' || mode === 'landmarks') {
      for (const l of L) {
        const col = l.def.kind === 'mirror' ? '#ff9ff0' : l.def.kind === 'expr' ? '#7dd3fc' : '#fde047';
        const sel = opts.selectedLandmark === l.name;
        out.push(`<circle cx="${f(l.p[0])}" cy="${f(l.p[1])}" r="${f(sel ? dot * 2.2 : dot)}" fill="${col}" stroke="#000" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
        label(l.p[0], l.p[1], l.name, col);
      }
    }
  }
  if (mode === 'geometry') out.push(geometryOverlay(scene, dot));
  out.push('</g>');
  return out.join('');
}

function hue(name, light = 62) { return `hsl(${hashString(name) % 360} 85% ${light}%)`; }

// anchor points and Bézier control points of every final path, in canvas space
function geometryOverlay(scene, dot) {
  const anchors = [], ctrls = [], handles = [];
  const visit = (node, M) => {
    for (const n of node.children) {
      if (n.hidden) continue;
      const m = mulM(M, local(n));
      if (n.type === 'path') {
        let cur = [0, 0];
        for (const c of n.geom.commands) {
          const a = c.args;
          const P = (i) => apply(m, [a[i], a[i + 1]]);
          if (c.cmd === 'move' || c.cmd === 'line') { cur = P(0); anchors.push(cur); }
          else if (c.cmd === 'curve') { const c1 = P(0), c2 = P(2), e = P(4); handles.push([cur, c1], [e, c2]); ctrls.push(c1, c2); anchors.push(e); cur = e; }
          else if (c.cmd === 'quad' || c.cmd === 'smooth') { const q = P(0), e = P(2); handles.push([cur, q], [e, q]); ctrls.push(q); anchors.push(e); cur = e; }
        }
      } else if (n.type === 'polygon') for (const p of n.geom.points) anchors.push(apply(m, p));
      visit(n, m);
    }
  };
  visit(scene.root, [1, 0, 0, 1, 0, 0]);
  const pts = (arr, r, fill) => arr.map((p) => `<rect x="${f(p[0] - r)}" y="${f(p[1] - r)}" width="${f(2 * r)}" height="${f(2 * r)}" fill="${fill}"/>`).join('');
  return `<g>${handles.map(([a, b]) => `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" stroke="#f472b6" stroke-width="0.6" vector-effect="non-scaling-stroke"/>`).join('')}` +
    `${pts(ctrls, dot * 0.55, '#f472b6')}${pts(anchors, dot * 0.45, '#fde047')}</g>`;
}

// 2D affine [a b c d e f]
function local(n) {
  const r = (n.rotate || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), [sx, sy] = n.scale || [1, 1];
  return [c * sx, s * sx, -s * sy, c * sy, n.at?.[0] || 0, n.at?.[1] || 0];
}
const mulM = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function semanticDescendantIds(node) { const ids = []; walkScene(node, (n) => { if (n !== node && n.type !== 'group' && n.type !== 'fur') ids.push(n.id); }); return ids; }
