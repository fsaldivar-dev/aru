// Section Polish review loop (multi-pass):
//   node tools/polish-review.mjs --provider claude [--rounds 2] [--tier important|full|off] [--model opus] [--effort medium] [--tag claude2]
//   node tools/polish-review.mjs --directives references/wolf.polish.v2.json [--tag manual]      (ManualPolishProvider)
//   node tools/polish-review.mjs --replay out/polish-claude2                                     (no model call: last round's directives)
// Output in out/polish-<tag>/: review.round<N>.json (directives, evidence, decisions, cost), sent/round<N>-group<K>-{context,reference,current}.png,
// final.aru, before.svg, after.svg, summary.json
import fs from 'node:fs';
import { decodePNG, encodePNG } from './png.mjs';
import { ManualVisionProvider } from '../vision/manual-provider.js';
import { runVision } from '../vision/provider.js';
import { ManualPolishProvider } from '../vision/polish-provider.js';
import { runReviewRounds, MAX_ROUNDS } from '../vision/review-loop.js';
import { prepare, traceGuided } from '../trace/guided.js';
import { renderScene } from '../src/render.js';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const file = pos[0] || 'references/wolf.png', ctxFile = pos[1] || 'references/wolf.context.json';
const quality = Number(opt('--quality', 0.75)), abstraction = Number(opt('--abstraction', 0.5));
const raw = decodePNG(file);
const vision = await runVision(new ManualVisionProvider(JSON.parse(fs.readFileSync(ctxFile, 'utf8'))), raw);
const prep = prepare(raw, vision.context);

if (opt('--replay')) {
  const d = opt('--replay'), rounds = fs.readdirSync(d).filter((f) => /^review\.round\d+\.json$/.test(f)).sort();
  const last = fs.existsSync(`${d}/review.final.json`) ? JSON.parse(fs.readFileSync(`${d}/review.final.json`, 'utf8')) : JSON.parse(fs.readFileSync(`${d}/${rounds[rounds.length - 1]}`, 'utf8'));
  if (last.selectedRound !== undefined) rounds.push(`review.final.json (round ${last.selectedRound})`);
  const r = traceGuided(prep, { quality, regularize: true, abstraction, polish: last.cumulative });
  fs.writeFileSync(`${d}/replay.aru`, r.aru);
  const same = fs.existsSync(`${d}/final.aru`) && fs.readFileSync(`${d}/final.aru`, 'utf8') === r.aru;
  console.log(`replayed ${rounds[rounds.length - 1]} (${last.cumulative.length} directives): ARU identical to the recorded run: ${same}`);
  process.exit(same ? 0 : 1);
}

let provider;
if (opt('--directives')) provider = new ManualPolishProvider(fs.readFileSync(opt('--directives'), 'utf8'));
else if (opt('--provider') === 'claude') { const { ClaudeCliPolishProvider } = await import('../vision/claude-cli-polish-provider.js'); provider = new ClaudeCliPolishProvider({ model: opt('--model', 'opus'), effort: opt('--effort', 'medium') }); }
else { console.error('choose --provider claude, --directives <file> or --replay <dir>'); process.exit(1); }
const tag = opt('--tag', provider.name.replace(/[^a-z0-9]+/gi, '-'));
const dir = `out/polish-${tag}`;
fs.mkdirSync(`${dir}/sent`, { recursive: true });
for (const f of fs.readdirSync(dir)) if (/^review\.(round\d+|final)\.json$/.test(f)) fs.unlinkSync(`${dir}/${f}`);

const rounds = Math.min(MAX_ROUNDS, Number(opt('--rounds', opt('--directives') ? 1 : 2)));
let out;
try {
  out = await runReviewRounds({
    prep, provider, quality, abstraction, rounds, tier: opt('--tier', 'important'), encode: (rgb) => encodePNG(rgb),
    save: (name, rec, images = []) => {
      fs.writeFileSync(`${dir}/${name}`, JSON.stringify(rec, null, 1));
      if (rec.round) images.forEach((im, k) => { for (const v of ['context', 'reference', 'current']) fs.writeFileSync(`${dir}/sent/round${rec.round}-group${k + 1}-${v}.png`, Buffer.from(im[v])); });
    },
    log: (m) => console.log(m),
  });
} catch (e) { console.error(`reviewer ${provider.name} failed: ${e.message}`); process.exit(1); }
const R = out.result;
fs.writeFileSync(`${dir}/final.aru`, R.aru);
fs.writeFileSync(`${dir}/before.svg`, renderScene(out.base.scene, { dataAttrs: false }));
fs.writeFileSync(`${dir}/after.svg`, renderScene(R.scene, { dataAttrs: false }));
const cost = out.history.reduce((a, h) => a + (h.usage?.usd || 0), 0), secs = out.history.reduce((a, h) => a + h.ms, 0) / 1000;
const summary = {
  provider: provider.name, selectedRound: out.selectedRound, rounds: out.history.length, tier: opt('--tier', 'important'), costUsd: +cost.toFixed(4), reviewerSeconds: +secs.toFixed(1),
  sectionsConsidered: out.history[0]?.sectionsConsidered ?? 0, sectionsSentPerRound: out.history.map((h) => h.sectionsSent),
  designed: out.history.map((h) => [h.designedBefore, h.designedAfter]), directives: out.cumulative.length,
  weightedFidelity: { before: out.base.metrics.weightedFidelity, after: R.metrics.weightedFidelity }, points: { before: out.base.metrics.outputPoints, after: R.metrics.outputPoints },
};
fs.writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
