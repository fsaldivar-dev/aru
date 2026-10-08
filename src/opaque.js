// An illustration owns its background; the artboard colour alone is not part of an imported group.
import { uniqueName } from './edit.js';

export function opaqueColor(color) {
  const h = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(color));
  if (!h) return '#FFFFFF';
  const rgb = h[1].length <= 4 ? h[1].slice(0, 3).split('').map((c) => c + c).join('') : h[1].slice(0, 6);
  return '#' + rgb.toUpperCase();
}

export function withOpaqueBackground(scene, { color = scene.background, bounds = [0, 0, scene.width, scene.height], keep = () => true } = {}) {
  // Filtering and gradient renaming during insertion must not damage the winning trace used by reviews.
  const copy = (n) => {
    if (!keep(n)) return null;
    const c = JSON.parse(JSON.stringify({ ...n, children: [] }));
    c.children = (n.children || []).map(copy).filter(Boolean);
    return c.type === 'group' && !c.children.length ? null : c;
  };
  const root = { ...scene.root, children: scene.root.children.map(copy).filter(Boolean) };
  if (!root.children.length) return { ...scene, root };
  let parent = root;
  // Retain the identity of a single semantic group (including icon packs). A clipped/translucent/transformed
  // group needs a separate wrapper so its clipping or opacity cannot make the background transparent.
  const g = root.children.length === 1 && root.children[0];
  if (g?.type === 'group' && !g.clip && g.opacity === 1 && !g.rotate &&
      g.at.every((v) => v === 0) && g.scale.every((v) => v === 1)) parent = g;
  const [x0, y0, x1, y1] = bounds;
  if (!bounds.every(Number.isFinite) || x1 <= x0 || y1 <= y0) throw new Error('La ilustración necesita un área de fondo válida');
  parent.children.unshift({
    id: -1, type: 'rect', name: uniqueName(parent, 'Fondo_opaco'), label: 'Fondo opaco',
    semantic: 'illustration.background', role: 'background', at: [(x0 + x1) / 2, (y0 + y1) / 2],
    rotate: 0, scale: [1, 1], opacity: 1, layer: Math.min(2, ...parent.children.map((c) => c.layer ?? 2)) - 1,
    fill: opaqueColor(color), fillOpacity: 1, stroke: 'none', strokeWidth: 1,
    geom: { size: [x1 - x0, y1 - y0], corner: 0 }, children: [],
  });
  return { ...scene, root, gradients: JSON.parse(JSON.stringify(scene.gradients)) };
}

// The PNG is a complete image. Alpha in paths, holes, shadows and rounded corners is composited onto this colour.
export async function opaquePng(scene, render, { width = scene.width, height = scene.height } = {}) {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(render(scene, { dataAttrs: false, animate: false }).replace(/(<svg[^>]*\bwidth=")[^"]+/, '$1' + Math.round(width)).replace(/(<svg[^>]*\bheight=")[^"]+/, '$1' + Math.round(height)));
  await img.decode();
  const cv = document.createElement('canvas'); cv.width = Math.round(width); cv.height = Math.round(height);
  const g = cv.getContext('2d');
  g.fillStyle = opaqueColor(scene.background); g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/png');
}
