// Edit-cost experiment: one scene-graph operation vs. the minimal set of SVG lines that would have to change.
import fs from 'node:fs';
import { compile } from '../src/engine.js';
import { renderScene } from '../src/render.js';
import { applyOperation } from '../src/ops.js';
import { approxTokens } from '../src/metrics.js';

const file = process.argv[2] || 'examples/cat-on-rock.aru';
const src = fs.readFileSync(file, 'utf8');
const EDITS = [
  ['cat.tail.scale = 1.2', { operation: 'set', target: 'cat.tail', property: 'scale', value: 1.2 }],
  ['cat.leftEye.fill = green', { operation: 'set', target: 'cat.head.eyeL.iris', property: 'fill', value: '#5BD36B' }],
  ['mountains.opacity = 0.8', { operation: 'set', target: 'mountains', property: 'opacity', value: 0.8 }],
  ['background trees 20% smaller', { operation: 'scale', target: 'semantic:plant.tree role:background', value: 0.8 }],
  ['all grass darker', { operation: 'set', target: 'semantic:plant.grass', property: 'opacity', value: 0.7 }],
  ['remove the birds', { operation: 'delete', target: 'birds' }],
];
const pad = (s, n) => String(s).padStart(n);
console.log(`${'edit'.padEnd(32)}${pad('op tokens', 10)}${pad('objects', 9)}${pad('SVG lines changed', 19)}${pad('SVG patch tokens', 18)}`);
for (const [label, op] of EDITS) {
  const r = compile(src);
  const before = renderScene(r.scene, { dataAttrs: false }).split('\n');
  const res = applyOperation(r.scene, op);
  const after = renderScene(r.scene, { dataAttrs: false }).split('\n');
  // minimal line diff (LCS would be ideal; same-length positional compare + length delta is enough here)
  let changed = 0, patch = '';
  if (before.length === after.length) { for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) { changed++; patch += after[i] + '\n'; } }
  else { const a = new Set(after); for (const l of before) if (!a.has(l)) { changed++; patch += l + '\n'; } }
  const opTok = approxTokens(JSON.stringify(op));
  console.log(`${label.padEnd(32)}${pad(opTok, 10)}${pad(res.message.match(/\d+/)[0], 9)}${pad(changed, 19)}${pad(approxTokens(patch), 18)}`);
}
