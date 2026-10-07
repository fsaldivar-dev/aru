// Agents bridge (Node): runs the AI CLIs installed on this machine for the Studio chat.
// Same contract as the Tauri backend (desktop/src-tauri/src/agents.rs):
//   detect()            -> [{ id, name, bin, installed, path, version }]
//   run({ provider, model, system, prompt, schema, runId }) -> { ok, code, stdout, stderr, output, ms, runId }
//   cancel(runId)
// Only these four CLIs can run, and their command lines are built HERE from fixed templates; the page only
// supplies text (system, prompt), a JSON schema and a model name. Each run gets its own temporary directory.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENTS = { claude: { name: 'Claude', bin: 'claude' }, codex: { name: 'Codex', bin: 'codex' }, agy: { name: 'Antigravity', bin: 'agy' }, gemini: { name: 'Gemini', bin: 'gemini' } };
const TIMEOUT_MS = 6 * 60 * 1000;
const running = new Map();

// PATH of a login shell + the usual install locations (GUI apps and services start with a minimal PATH)
let searchPath = null;
function pathDirs() {
  if (searchPath) return searchPath;
  const dirs = new Set((process.env.PATH || '').split(':'));
  try { for (const d of execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 4000 }).split(':')) dirs.add(d); } catch { /* no login shell */ }
  const h = os.homedir();
  for (const d of ['.local/bin', '.cargo/bin', '.npm-global/bin', '.bun/bin', 'Library/pnpm', 'bin', '.volta/bin']) dirs.add(path.join(h, d));
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) dirs.add(d);
  searchPath = [...dirs].filter(Boolean);
  return searchPath;
}
function resolveBin(bin) {
  for (const d of pathDirs()) { const p = path.join(d, bin); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ } }
  return null;
}

let detected = null;
export function detect() {
  if (detected) return detected;
  detected = Object.entries(AGENTS).map(([id, a]) => {
    const p = resolveBin(a.bin);
    let version = null;
    if (p) try { version = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 8000, env: { ...process.env, PATH: pathDirs().join(':') } }).trim().split('\n')[0]; } catch { /* keep null */ }
    return { id, name: a.name, bin: a.bin, installed: !!p, path: p, version };
  });
  return detected;
}

// attached images: validated, written into the run directory (name.ext)
const MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
function writeImages(req, dir) {
  const imgs = Array.isArray(req.images) ? req.images : [];
  if (imgs.length > 4) throw new Error('at most 4 images');
  return imgs.map((im) => {
    if (!/^[a-z0-9_-]{1,32}$/.test(im.name || '') || !MIME[im.mime] || typeof im.data !== 'string') throw new Error('invalid image');
    const buf = Buffer.from(im.data, 'base64');
    if (!buf.length || buf.length > 6e6) throw new Error('image too large (max 6 MB)');
    const file = path.join(dir, `${im.name}.${MIME[im.mime]}`);
    fs.writeFileSync(file, buf);
    return { file, mime: im.mime, data: im.data, name: `${im.name}.${MIME[im.mime]}` };
  });
}

// fixed argument templates per CLI
function command(req, dir) {
  const model = req.model && /^[A-Za-z0-9._:\-/]{1,64}$/.test(req.model) ? req.model : null;
  const schema = JSON.stringify(req.schema);
  fs.writeFileSync(path.join(dir, 'schema.json'), schema);
  const images = writeImages(req, dir);
  const full = `${req.system}\n\n${req.prompt}`;
  switch (req.provider) {
    case 'claude': {
      // stream-json input: the prompt and the images as content blocks. No MCP servers: the user's connectors are not
      // needed here and an unauthorized one would leak into the reply
      const content = [{ type: 'text', text: req.prompt }, ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } }))];
      const researchTools = req.research === true ? ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'] : ['--tools', ''];
      return { args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--json-schema', schema, ...researchTools, '--disable-slash-commands', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config', '--system-prompt', req.system, '--no-session-persistence', '--effort', 'low', ...(model ? ['--model', model] : [])], stdin: JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n' };
    }
    case 'codex': return { args: ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--color', 'never', ...images.flatMap((i) => ['--image', i.file]), '--output-schema', path.join(dir, 'schema.json'), '-o', path.join(dir, 'out.json'), ...(model ? ['-m', model] : []), '-'], stdin: full, output: path.join(dir, 'out.json') };
    // agy has many tools (shell, browser…); headless mode denies them and then returns NO output. The images are files
    // here: tell it to open them with view_file only (read-only) and answer directly.
    case 'agy': return { args: ['-p', images.length ? `${full}\n\nThe attached images are files in the current directory (${images.map((i) => i.name).join(', ')}). Open them ONLY with view_file. Do not run commands or use any other tool. Then reply with the JSON.` : full, '--output-format', 'json', '--json-schema', path.join(dir, 'schema.json'), '--disable-slash-commands', ...(model ? ['--model', model] : [])], stdin: '' };
    case 'gemini': return { args: ['-p', `${full}\n\n${images.map((i) => `@${i.name}`).join(' ')}\n\nReply ONLY with a JSON object matching this schema:\n${schema}`, '--output-format', 'json', ...(model ? ['-m', model] : [])], stdin: '' };
    default: throw new Error(`unknown provider '${req.provider}'`);
  }
}

export function run(req) {
  return new Promise((resolve, reject) => {
    const a = AGENTS[req.provider];
    if (!a) return reject(new Error(`unknown provider '${req.provider}'`));
    if (req.research === true && req.provider !== 'claude') return reject(new Error('Discovery web requiere Claude; los otros transportes no habilitan búsqueda todavía'));
    if (typeof req.prompt !== 'string' || typeof req.system !== 'string' || !req.schema || typeof req.schema !== 'object') return reject(new Error('prompt, system and schema are required'));
    const bin = resolveBin(a.bin);
    if (!bin) return reject(new Error(`${a.name} no está instalado (no se encontró '${a.bin}')`));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-agent-'));
    let cmd;
    try { cmd = command(req, dir); } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); return reject(e); }
    const runId = String(req.runId || Date.now());
    const t0 = Date.now();
    const child = spawn(bin, cmd.args, { cwd: dir, env: { ...process.env, PATH: pathDirs().join(':'), NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    running.set(runId, child);
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); running.delete(runId); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); running.delete(runId);
      let output = null;
      if (cmd.output) try { output = fs.readFileSync(cmd.output, 'utf8'); } catch { /* none */ }
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ ok: code === 0, code: code ?? (signal ? 130 : -1), cancelled: signal === 'SIGTERM', stdout, stderr: stderr.slice(-4000), output, ms: Date.now() - t0, runId });
    });
    child.stdin.end(cmd.stdin || '');
  });
}

export function cancel(runId) { const c = running.get(String(runId)); if (c) { c.kill('SIGTERM'); return true; } return false; }
