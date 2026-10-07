// Compile examples/logos/*.aru -> out/logos/<name>.svg + transparent <name>.png (headless Chrome) + a contact sheet.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compile } from '../src/engine.js';
import { renderScene } from '../src/render.js';
import { sceneMetrics, approxTokens } from '../src/metrics.js';

const outDir = path.resolve('out/logos');
fs.mkdirSync(outDir, { recursive: true });
const shell = execFileSync('bash', ['-lc', 'find ~/.cache/puppeteer/chrome-headless-shell -name chrome-headless-shell -type f | head -1']).toString().trim();
const shot = (html, png, w, h, transparent) => execFileSync(shell, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${w},${h}`, ...(transparent ? ['--default-background-color=00000000'] : []), `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
const names = [];
for (const f of fs.readdirSync('examples/logos').filter((x) => x.endsWith('.aru'))) {
  const name = path.basename(f, '.aru'), src = fs.readFileSync(`examples/logos/${f}`, 'utf8');
  // `// dark-variant #from>#to ...` produces a negative version for dark backgrounds
  const dv = /\/\/ dark-variant (.+)/.exec(src);
  if (dv) {
    let dsrc = src;
    for (const pair of dv[1].trim().split(/\s+/)) { const [a, b] = pair.split('>'); dsrc = dsrc.split(a).join(b); }
    const rd = compile(dsrc);
    fs.writeFileSync(path.join(outDir, `${name}-dark.svg`), renderScene(rd.scene, { dataAttrs: false }));
    const htmlD = path.join(outDir, `_${name}-dark.html`);
    fs.writeFileSync(htmlD, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:${rd.scene.width}px}</style><img src="${name}-dark.svg">`);
    shot(htmlD, path.join(outDir, `${name}-dark.png`), rd.scene.width, rd.scene.height, true);
    fs.unlinkSync(htmlD);
  }
  const r = compile(src);
  if (!r.ok) { console.log(name, r.errors); continue; }
  fs.writeFileSync(path.join(outDir, `${name}.svg`), renderScene(r.scene, { dataAttrs: false }));
  const html = path.join(outDir, `_${name}.html`);
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:${r.scene.width}px}</style><img src="${name}.svg">`);
  shot(html, path.join(outDir, `${name}.png`), r.scene.width, r.scene.height, true);
  fs.unlinkSync(html);
  const sm = sceneMetrics(r.scene);
  console.log(`${name.padEnd(26)} ${String(src.split('\n').length).padStart(4)} lines  ~${approxTokens(src)} tokens  ${sm.objects} objects`);
  names.push(name);
}
const sheet = path.join(outDir, '_sheet.html');
fs.writeFileSync(sheet, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#888;font:18px system-ui}.r{display:grid;grid-template-columns:repeat(${names.length},1fr)}.c{padding:10px}.l{background:#fff}.d{background:#15171c}img{width:100%;display:block}</style>
<div class="r">${names.map((n) => `<div class="c l"><img src="${n}.svg"></div>`).join('')}</div>
<div class="r">${names.map((n) => `<div class="c d"><img src="${fs.existsSync(path.join(outDir, `${n}-dark.svg`)) ? n + '-dark' : n}.svg"></div>`).join('')}</div>`);
shot(sheet, path.join(outDir, 'contact-sheet.png'), 1800, 760, false);
fs.unlinkSync(sheet);
