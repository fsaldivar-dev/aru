// Metrics for "visual complexity vs document complexity" evaluation.
import { walkScene } from './scene.js';
import { toAru } from './serialize.js';

export function approxTokens(text) {
  // Heuristic calibrated against real BPE tokenizers (tiktoken o200k/cl100k, see tools/bpe_tokens.py):
  // within about 7% on ARU and SVG files. Words ~7 chars/token, digit runs ~3 digits/token,
  // punctuation runs ~2 chars/token, long indentation ~8 spaces/token.
  const m = text.match(/[A-Za-z_]+|\d+|[^\sA-Za-z0-9_]+|\n|  +/g) || [];
  let n = 0;
  for (const t of m) {
    if (/^[A-Za-z_]+$/.test(t)) n += Math.max(1, Math.ceil(t.length / 7));
    else if (/^\d+$/.test(t)) n += Math.ceil(t.length / 3);
    else if (/^ +$/.test(t)) n += Math.ceil(t.length / 8);
    else n += Math.ceil(t.length / 2);
  }
  return n;
}

export function byteLength(text) {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : Buffer.byteLength(text, 'utf8');
}

export function sceneMetrics(scene) {
  const m = { objects: 0, source: 0, expanded: 0, authored: 0, generated: 0, groups: 0, paths: 0, points: 0, beziers: 0, shapes: {}, maxDepth: 0, named: 0 };
  walkScene(scene.root, (n, depth) => {
    if (n === scene.root) return;
    m.objects++; m.maxDepth = Math.max(m.maxDepth, depth);
    if (n.generated) m.generated++; else m.authored++;
    if (n.origin === 'source') m.source++; else if (n.origin === 'expanded') m.expanded++;
    if (n.type === 'group' || n.type === 'fur') m.groups++;
    m.shapes[n.type] = (m.shapes[n.type] || 0) + 1;
    if (n.explicitName && n.origin === 'source') m.named++;
    if (n.type === 'path') {
      m.paths++;
      for (const c of n.geom.commands) {
        if (c.cmd === 'move' || c.cmd === 'line') m.points += 1;
        else if (c.cmd === 'curve') { m.points += 3; m.beziers++; }
        else if (c.cmd === 'quad' || c.cmd === 'smooth') { m.points += 2; m.beziers++; }
        else if (c.cmd === 'arc') m.points += 1;
      }
    } else if (n.type === 'polygon') m.points += n.geom.points.length;
    else if (n.type === 'line') m.points += 2;
    else m.points += 1; // center point of circle/ellipse/rect
  });
  return m;
}

export function textMetrics(text) {
  return { bytes: byteLength(text), chars: text.length, lines: text.split('\n').length, tokens: approxTokens(text), charsPer4: Math.round(text.length / 4) };
}

export function svgMetrics(svg) {
  const nodes = (svg.match(/<(?!\/|stop\b)[A-Za-z]/g) || []).length; // elements, excluding gradient <stop>s
  const numbers = (svg.match(/-?\d+(\.\d+)?/g) || []).length;
  const numericChars = (svg.match(/-?\d+(\.\d+)?/g) || []).join('').length;
  return { ...textMetrics(svg), nodes, numbers, numericShare: numericChars / Math.max(1, svg.length) };
}

export function aruReadability(text) {
  const numbers = (text.match(/-?\d+(\.\d+)?/g) || []).length;
  const numericChars = (text.match(/-?\d+(\.\d+)?/g) || []).join('').length;
  return { numbers, numericShare: numericChars / Math.max(1, text.length) };
}

// Semantic level: how much geometry does each semantic instruction buy?
export function semanticMetrics(scene, src) {
  const lines = src.split('\n'), out = [];
  for (const [name, rt] of scene.blueprints || []) {
    const bp = rt.bp;
    const count = (n) => n.props.length + n.children.reduce((s, c) => s + 1 + count(c), 0);
    const instructions = 1 + count(bp.ast);
    const semSrc = lines.slice(bp.ast.line - 1, bp.ast.endLine).join('\n');
    const g = { objects: 0, primitives: 0, paths: 0, polygons: 0, beziers: 0, points: 0 };
    walkScene(rt.root, (n) => {
      if (!n.generated) return;
      g.objects++;
      if (n.type !== 'group') g.primitives++;
      if (n.type === 'path') { g.paths++; for (const c of n.geom.commands) { if (c.cmd === 'curve' || c.cmd === 'quad') { g.beziers++; g.points += c.cmd === 'curve' ? 3 : 2; } else if (c.cmd !== 'close') g.points++; } }
      else if (n.type === 'polygon') { g.polygons++; g.points += n.geom.points.length; }
      else if (n.type !== 'group') g.points++;
    });
    const mini = { width: scene.width, height: scene.height, background: 'none', gradients: {}, root: { children: [rt.root] } };
    const geoText = toAru(mini, { precision: 2 });
    const kinds = {}; for (const e of bp.elements) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    const defs = [...bp.landmarkDefs.values()];
    const semTok = approxTokens(semSrc), geoTok = approxTokens(geoText);
    out.push({
      name, instructions, landmarks: defs.length, landmarksAuthored: defs.filter((d) => d.kind !== 'mirror').length,
      elements: bp.elements.length, mirrored: bp.elements.filter((e) => e.mirrorOf).length, kinds,
      regions: kinds.region || 0, expansions: [...rt.expansions.values()].reduce((a, b) => a + b, 0),
      generated: g, sourceTokens: semTok, sourceLines: semSrc.split('\n').length, geometryTokens: geoTok,
      geometryText: geoText, compileMs: rt.timings.resolve + rt.timings.compile, resolveMs: rt.timings.resolve,
      expansionObjects: g.primitives / instructions, expansionTokens: geoTok / Math.max(1, semTok),
    });
  }
  return out;
}
