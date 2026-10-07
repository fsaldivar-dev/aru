// Prepares desktop/dist for the Tauri app: the Studio, the Lab and the engine modules, plus the example documents.
// Third-party reference images (references/) are NOT copied: they are local benchmark material only.
//   node tools/build-desktop.mjs && (cd desktop/src-tauri && cargo run)            development
//   node tools/build-desktop.mjs && (cd desktop && npx --yes @tauri-apps/cli@2 build)   bundle (.app / .dmg)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'desktop', 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
const copy = (rel) => fs.cpSync(path.join(root, rel), path.join(dist, rel), { recursive: true, filter: (src) => !/\.DS_Store$/.test(src) });
for (const rel of ['index.html', 'lab.html', 'src', 'plugin', 'trace', 'vision', 'examples']) copy(rel);
let n = 0; (function count(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? count(p) : n++; } })(dist);
console.log(`desktop/dist ready: ${n} files`);
