// ClaudeCliPolishProvider (Node only, optional): the reviewer is Claude through the local Claude Code CLI
// (`claude -p`), using the CLI's own login. No SDK, no npm dependency, no API key in this project.
//
// One non-interactive call per review round: CONTEXT + DETAIL crops of every group go in as image blocks (stream-json input),
// the answer comes back validated against DIRECTIVES_SCHEMA (--json-schema -> result.structured_output).
// The model gets NO tools (--tools ""), its own short system prompt and no saved session. It can only answer with
// directives; validateDirectives() runs again on top, and the engine measures every directive against the pixels.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { PolishProvider } from './polish-provider.js';
import { DIRECTIVES_SCHEMA } from '../trace/section-polish.js';

const SYSTEM = `You review the last polish pass of an image-to-vector tracer. You are a reviewer, not the illustrator:
you never produce paths, points, curves, coordinates or SVG. You state hypotheses in a closed vocabulary
("these fragments are one iris", "this edge should be smooth", "this is a circle", "this detail is noise");
the tracer proves or rejects each one with the pixels.

For each group you get: a CONTEXT image (whole reference, red box = where the group is), then a DETAIL crop of the
REFERENCE and a DETAIL crop of the CURRENT vector (same area, enlarged), plus measured evidence per section.

Directive fields:
- edges: "straight" (faceted/geometric), "curved" (organic/round), "auto" (let measurements decide).
- corners: "keep", "sharp", "soften", "remove".
- shape: "circle" / "ellipse" (partial shapes are fine, e.g. an iris cut by the eyelid) or "none".
- simplify 0..1: how much detail to drop (0.2 careful, 0.5 normal, 0.8 bold).
- regions (optional, topology): count "preserve" | "simplify" (merge same-role fragments) | "single" (one main shape + distinct details);
  merge "none" | "compatible" | "aggressive"; protect true for deliberate small details (catch lights, nostrils).
- scope: "all" | "outline" | "inside".
- confidence: "low" | "medium" | "high" — how sure you are from the images.
A directive on a section also covers its sub-sections unless they get their own.
Rules:
RULES
Only give directives for sections that need them. Use the exact section names. Keep fur spikes, ridges and other
intentionally jagged structure. In later rounds, "previous" tells you what you asked and what the tracer did with it:
revise rejected directives (different approach or lower simplify) or drop them; do not repeat a rejected directive unchanged.`;

export class ClaudeCliPolishProvider extends PolishProvider {
  constructor({ bin = 'claude', model = 'opus', effort = 'medium', maxSections = 24, maxBudgetUsd = 2, timeoutMs = 600000 } = {}) {
    super();
    Object.assign(this, { bin, model, effort, maxSections, maxBudgetUsd, timeoutMs });
  }
  get name() { return `claude-cli:${this.model}`; }

  async review(request) {
    const system = SYSTEM.replace('RULES', (request.rules || []).map((r) => `- ${r}`).join('\n'));
    const content = [{ type: 'text', text: `Round ${request.round || 1}. Image ${request.image.width}×${request.image.height}. Vocabulary: ${JSON.stringify(request.vocabulary)}.` }];
    for (const g of (request.groups || []).slice(0, this.maxSections)) {
      content.push({ type: 'text', text: `GROUP ${g.sections.map((x) => x.section).join(', ')}\nEvidence: ${JSON.stringify(g.sections)}\nImages: CONTEXT, REFERENCE detail, CURRENT detail.` });
      for (const png of [g.images.context, g.images.reference, g.images.current]) if (png) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') } });
    }
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--json-schema', JSON.stringify(DIRECTIVES_SCHEMA), '--tools', '', '--system-prompt', system,
      '--no-session-persistence', '--model', this.model, '--effort', this.effort, '--max-budget-usd', String(this.maxBudgetUsd),
    ];
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
    const out = await run(this.bin, args, line, this.timeoutMs);
    const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const result = events.find((e) => e.type === 'result');
    if (!result) throw new Error('ClaudeCliPolishProvider: the CLI returned no result');
    if (result.is_error || result.subtype !== 'success') throw new Error(`ClaudeCliPolishProvider: ${result.subtype}${result.api_error_status ? ` (API ${result.api_error_status})` : ''}: ${String(result.result ?? '').slice(0, 300)}`);
    if (!result.structured_output) throw new Error('ClaudeCliPolishProvider: no structured output in the result');
    const u = result.usage || {};
    this.lastUsage = { usd: result.total_cost_usd ?? null, inputTokens: u.input_tokens ?? 0, cacheCreationTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, durationApiMs: result.duration_api_ms ?? null };
    this.lastCostUsd = result.total_cost_usd;
    return result.structured_output;
  }
}

function run(bin, args, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    // run outside the project so no project instructions or settings leak into the review
    const child = spawn(bin, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`ClaudeCliPolishProvider: timed out after ${timeoutMs / 1000} s`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `ClaudeCliPolishProvider: '${bin}' not found — install Claude Code and log in (claude), or pass bin` : e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.includes('"type":"result"')) reject(new Error(`ClaudeCliPolishProvider: claude exited with ${code}: ${err.trim().slice(0, 400)}`));
      else resolve(out);
    });
    child.stdin.end(stdin);
  });
}
