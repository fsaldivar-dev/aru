// Compile every texture in examples/textures (+ the wedding one), export SVG + PNG (headless Chrome) and measure.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compile } from '../src/engine.js';
import { renderScene } from '../src/render.js';
import { sceneMetrics, approxTokens } from '../src/metrics.js';

const outDir = path.resolve('out/textures');
fs.mkdirSync(outDir, { recursive: true });
const shell = execFileSync('bash', ['-lc', 'find ~/.cache/puppeteer/chrome-headless-shell -name chrome-headless-shell -type f | head -1']).toString().trim();
const files = [...fs.readdirSync('examples/textures').filter((f) => f.endsWith('.aru')).map((f) => `examples/textures/${f}`), 'examples/wedding-texture.aru'];
const rows = [];
for (const f of files) {
  const name = path.basename(f, '.aru').replace('wedding-texture', 'boda');
  const src = fs.readFileSync(f, 'utf8');
  const t0 = performance.now();
  const r = compile(src);
  const ms = performance.now() - t0;
  if (!r.ok) { console.log(name, 'ERRORS', r.errors); continue; }
  const svg = renderScene(r.scene, { dataAttrs: false });
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
  const html = path.join(outDir, `_${name}.html`);
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}img{display:block;width:${r.scene.width}px;height:${r.scene.height}px}</style><img src="${name}.svg">`);
  execFileSync(shell, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${r.scene.width},${r.scene.height}`, `--screenshot=${path.join(outDir, `${name}.png`)}`, `file://${html}`], { stdio: 'ignore' });
  fs.unlinkSync(html);
  const sm = sceneMetrics(r.scene);
  rows.push({ name, lines: src.split('\n').length, tokens: approxTokens(src), objects: sm.objects, paths: sm.paths, svgKB: Math.round(svg.length / 1024), pngKB: Math.round(fs.statSync(path.join(outDir, `${name}.png`)).size / 1024), ms });
}
const pad = (s, n) => String(s).padStart(n);
console.log(`${'texture'.padEnd(12)}${pad('ARU lines', 10)}${pad('tokens', 8)}${pad('objects', 9)}${pad('paths', 7)}${pad('SVG KB', 8)}${pad('PNG KB', 8)}${pad('compile ms', 11)}`);
for (const r of rows) console.log(`${r.name.padEnd(12)}${pad(r.lines, 10)}${pad(r.tokens, 8)}${pad(r.objects, 9)}${pad(r.paths, 7)}${pad(r.svgKB, 8)}${pad(r.pngKB, 8)}${pad(r.ms.toFixed(1), 11)}`);
fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(rows, null, 1));
