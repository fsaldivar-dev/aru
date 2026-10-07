// Writes examples/index.json (the Studio's document list; a static host cannot list folders).
import fs from 'node:fs';
import path from 'node:path';
const root = 'examples', out = [];
const walk = (d) => { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.aru')) out.push({ path: p, group: path.relative(root, d) || 'ejemplos', name: f.replace(/\.aru$/, '').replace(/-/g, ' ') }); } };
walk(root);
fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(out, null, 1));
console.log(`${out.length} documents -> examples/index.json`);
