// Static server for ARU Studio / Lab (no dependencies) + the local agents bridge for the chat.
//   node tools/serve.mjs [port]      -> http://localhost:<port>/  (Studio)  ·  /lab.html (Lab)
// The bridge (/api/agents*) only answers same-origin requests that carry the `x-aru-bridge` header (a custom
// header forces a CORS preflight that this server never approves), and the server listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, run, cancel } from './agents-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8787);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.aru': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };
const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function bridgeAllowed(req) {
  if (req.headers['x-aru-bridge'] !== '1') return false;
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}
async function body(req) { let s = ''; for await (const c of req) { s += c; if (s.length > 32e6) throw new Error('request too large'); } return JSON.parse(s || '{}'); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/agents')) {
    if (!bridgeAllowed(req)) return json(res, 403, { error: 'forbidden' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/agents') return json(res, 200, detect());
      if (req.method === 'POST' && url.pathname === '/api/agents/run') return json(res, 200, await run(await body(req)));
      if (req.method === 'POST' && url.pathname === '/api/agents/cancel') return json(res, 200, { cancelled: cancel((await body(req)).runId) });
      return json(res, 404, { error: 'not found' });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.resolve(root, '.' + p);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`ARU Studio: http://localhost:${port}/  ·  Lab: http://localhost:${port}/lab.html`));
