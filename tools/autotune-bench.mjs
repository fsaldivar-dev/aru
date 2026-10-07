// Auto-tune benchmark: every candidate tune is traced, rendered with headless Chrome and scored (trace/score.js).
//   node tools/autotune-bench.mjs image.png [more.png ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodePNG } from './png.mjs';
import { traceBest, describeTune } from '../trace/autotune.js';
import { renderScene } from '../src/render.js';

const CHROME = process.env.CHROME || `${os.homedir()}/.cache/puppeteer/chrome/mac_arm-146.0.7680.31/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-autotune-'));
let n = 0;
async function rasterize(scene, W, H) {
  const id = n++, svg = path.join(tmp, `r${id}.svg`), html = path.join(tmp, `r${id}.html`), png = path.join(tmp, `r${id}.png`);
  fs.writeFileSync(svg, renderScene(scene, { dataAttrs: false }));
  fs.writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:#fff}img{display:block;width:${W}px;height:${H}px}</style><img src="r${id}.svg">`);
  // headless Chrome's viewport is ~87 px shorter than --window-size: render in a taller window and crop the top W×H
  for (let t = 0; t < 4; t++) try { execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--force-device-scale-factor=1', `--window-size=${W},${H + 200}`, `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' }); break; } catch { /* flaky: retry */ }
  const shot = decodePNG(png);
  return { width: W, height: H, data: shot.data.slice(0, W * H * 4) };
}
const ctx = { version: 1, scene: 'illustration', background: { importance: 0.5 }, objects: [] };
for (const file of process.argv.slice(2)) {
  const t0 = performance.now();
  const { best, tried } = await traceBest(decodePNG(file), ctx, { rasterize });
  console.log(`== ${path.basename(path.dirname(file))}/${path.basename(file)}  (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  for (const t of tried) console.log(`  ${t === tried.find((x) => x.metrics === best.metrics) ? '★' : ' '} ${describeTune(t.tune).padEnd(52)} score ${t.metrics.score}  líneas ${t.metrics.lineRecall}  precisión ${t.metrics.linePrecision}  ±30 ${t.metrics.within30}  ΔE ${t.metrics.dE}  pts ${t.points}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
