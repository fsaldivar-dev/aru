// Verifies the semantic pipeline:
//  1. determinism: same source -> byte-identical SVG
//  2. incremental update == full recompile: moving a landmark through an operation (recompiling only dependents)
//     must produce exactly the same picture as editing the source and compiling everything again.
import fs from 'node:fs';
import { compile } from '../src/engine.js';
import { renderScene } from '../src/render.js';
import { applyOperation } from '../src/ops.js';

const file = process.argv[2] || 'examples/wolf-blueprint.aru';
const src = fs.readFileSync(file, 'utf8');
const svg = (r) => renderScene(r.scene, { dataAttrs: false });

const a = compile(src), b = compile(src);
console.log(`determinism: ${svg(a) === svg(b) ? 'identical' : 'DIFFERENT'}`);

const CASES = [
  { op: { operation: 'move', target: 'wolf.eyeL', value: [0.03, 0] }, edit: (s) => s.replace(/eyeL\s+0\.36 0\.45/, 'eyeL     0.39 0.45') },
  { op: { operation: 'set', target: 'wolf.nose', property: 'y', value: 0.7 }, edit: (s) => s.replace(/nose\s+0\.50 0\.67/, 'nose     0.50 0.7') },
  { op: { operation: 'set', target: 'wolf.palette.eye', value: '#4AA3FF' }, edit: (s) => s.replace(/eye\s+#F39A25/, 'eye      #4AA3FF') },
  { op: { operation: 'set', target: 'wolf.light', value: 'top-right' }, edit: (s) => s.replace('light top-left', 'light top-right') },
];
for (const c of CASES) {
  const inc = compile(src);
  const t0 = performance.now();
  const res = applyOperation(inc.scene, c.op);
  const tInc = performance.now() - t0;
  const edited = c.edit(src);
  if (edited === src) { console.log('  (source edit did not match)'); continue; }
  const t1 = performance.now();
  const full = compile(edited);
  const tFull = performance.now() - t1;
  const same = svg(inc) === svg(full);
  console.log(`${JSON.stringify(c.op)}\n  recompiled ${res.recompiled.length}/${res.total}: ${res.recompiled.join(', ')}\n  incremental ${tInc.toFixed(2)} ms vs full ${tFull.toFixed(2)} ms · result identical to full recompile: ${same}`);
}
