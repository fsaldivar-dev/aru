// Where do the tokens of an .aru file go? Per top-level section and per statement category.
import fs from 'node:fs';
import { parse } from '../src/parser.js';
import { buildScene, walkScene } from '../src/scene.js';
import { approxTokens } from '../src/metrics.js';

const file = process.argv[2] || 'examples/cat-on-rock.aru';
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');
const { ast } = parse(src);
const scene = buildScene(ast);

// ---- per top-level section (by source line ranges) ----
const tops = ast.children.map((c, i) => ({ node: c, start: c.line, end: (ast.children[i + 1]?.line ?? lines.length + 1) - 1 }));
const sceneTop = new Map(scene.root.children.map((n) => [n.name, n]));
const rows = [];
for (const t of tops) {
  const text = lines.slice(t.start - 1, t.end).filter((l) => !l.trim().startsWith('//')).join('\n');
  const sn = sceneTop.get(t.node.name);
  let objs = 0, paths = 0, pts = 0;
  if (sn) walkScene(sn, (n) => { objs++; if (n.type === 'path') { paths++; for (const c of n.geom.commands) pts += c.cmd === 'curve' ? 3 : c.cmd === 'quad' ? 2 : c.cmd === 'close' ? 0 : 1; } });
  rows.push({ section: `${t.node.type} ${t.node.name ?? ''}`.trim(), tokens: approxTokens(text), objects: objs, paths, points: pts });
}
rows.sort((a, b) => b.tokens - a.tokens);
const pad = (s, n) => String(s).padStart(n);
console.log(`\n== tokens per top-level section (${file}) ==`);
console.log(`${'section'.padEnd(26)}${pad('tokens', 8)}${pad('objects', 9)}${pad('paths', 7)}${pad('points', 8)}${pad('obj/100tok', 12)}`);
for (const r of rows) console.log(`${r.section.padEnd(26)}${pad(r.tokens, 8)}${pad(r.objects, 9)}${pad(r.paths, 7)}${pad(r.points, 8)}${pad(r.objects ? (100 * r.objects / r.tokens).toFixed(1) : '-', 12)}`);

// ---- per statement category ----
const CAT = {
  'path commands': ['move', 'line', 'curve', 'quad', 'close', 'smooth', 'arc'],
  'geometry': ['size', 'radius', 'points', 'from', 'to', 'corner'],
  'transform': ['at', 'scale', 'rotate'],
  'style': ['fill', 'stroke', 'opacity', 'cap', 'join', 'dash', 'width'],
  'gradients': ['gradient', 'stop', 'stops', 'linear', 'radial'],
  'semantics/layers': ['semantic', 'role', 'layer', 'clip'],
  'shape headers': ['circle', 'ellipse', 'rect', 'polygon', 'path', 'group'],
  'generative (repeat/clone/define/fur)': ['repeat', 'clone', 'define', 'fur', 'density', 'length', 'direction', 'colors', 'curl', 'seed', 'count'],
};
const lookup = {}; for (const [c, ks] of Object.entries(CAT)) for (const k of ks) lookup[k] = c;
const totals = {}; let other = 0;
for (const raw of lines) {
  const l = raw.replace(/\/\/.*$/, '');
  // split a line into statements: on ';' and on '{' / '}'
  for (const stmt of l.split(/[;{}]/)) {
    const s = stmt.trim(); if (!s) continue;
    const k = s.split(/\s+/)[0];
    // inside a path block, `line x y` is a command; at statement level `line name {` is a shape header — approximate by arg shape
    const cat = k === 'line' && /^line\s+-?[\d(]/.test(s) ? 'path commands' : (lookup[k] || 'other');
    totals[cat] = (totals[cat] || 0) + approxTokens(s);
  }
}
const braces = approxTokens(src.replace(/[^{}\n]/g, ''));
const comments = approxTokens(lines.filter((l) => l.includes('//')).map((l) => l.slice(l.indexOf('//'))).join('\n'));
totals['braces/newlines'] = braces; totals['comments'] = comments;
const sum = Object.values(totals).reduce((a, b) => a + b, 0);
console.log(`\n== tokens per statement category ==`);
for (const [c, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) console.log(`${c.padEnd(40)}${pad(v, 7)}${pad((100 * v / sum).toFixed(1) + '%', 8)}`);
