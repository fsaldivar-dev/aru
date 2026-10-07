// Multi-pass review: the reviewer sees the result of its own directives and may revise them.
//
//   round 1: reference + current (regularized)            -> directives -> tracer applies -> accept/reject per section
//   round 2: reference + new result + previous directives + what the engine did with them -> revised directives
//   round 3: only if sections are still problematic (hard limit)
//
// Every round is saved (review.round1.json ...). The final ARU depends only on the image, the context and the LAST
// round's cumulative directives, so replaying that file reproduces it exactly without calling any model.
// Vision cost control: sections that already look designed are not sent; tiers off | important | full; small sub-sections
// share their parent's crops when the parent's detail view shows them well enough.
import { traceGuided } from '../trace/guided.js';
import { labImage } from '../trace/quantize.js';
import { densify } from '../trace/simplify.js';
import { sectionMasks, measureSections, designedScores } from '../trace/designed.js';
import { consensusShape } from '../trace/conics.js';
import { detailBox, detailScale, contextView, referenceCropRGB, renderCropRGB } from '../trace/review.js';
import { validateDirectives, ENUMS, REGION_ENUMS, roughness } from '../trace/section-polish.js';

export const TIERS = ['off', 'important', 'full'];
export const MAX_ROUNDS = 3;

export const REVIEW_RULES = [
  'Prefer the simplest visual explanation supported by the reference.',
  'Do not preserve raster artifacts merely because they exist.',
  'Do not request simplification when it changes the intended visual structure.',
  'Use region directives (regions.count / regions.merge / regions.protect) when fragmentation is the problem.',
  'Use edge directives (edges / corners / simplify) when geometry is the problem.',
  'Use analytic shapes (circle / ellipse) only when the reference visibly supports them.',
  'State your confidence honestly; the tracer still measures every directive and rejects what the pixels do not support.',
];

// measured evidence for one section of a result (no geometry, only numbers and names)
export function sectionEvidence(res, ctx, m, d, prevRound) {
  const node = ctx.nodes.find((n) => n.path === m.section);
  const sym = (ctx.relations || []).filter((r) => r.type === 'symmetric' && (m.section.startsWith(r.a) || m.section.startsWith(r.b))).map((r) => (m.section.startsWith(r.a) ? r.b : r.a) + m.section.slice((m.section.startsWith(r.a) ? r.a : r.b).length));
  // current analytic candidate (measured on the section's own boundaries)
  const chainIds = new Set();
  for (const r of res.T.regions) if ((res.assign.get(r.id)?.path ?? 'background') === m.section) for (const ref of r.outer.refs) chainIds.add(ref.chain);
  let analytic = null;
  if (chainIds.size && m.area >= 30 && m.area < 0.5 * res.T.width * res.T.height) {
    const cs = consensusShape([...chainIds].map((c) => densify(res.T.chains[c])), { tol: 1, maxSize: 0.9 * Math.max(res.T.width, res.T.height) });
    const best = cs && (cs.pick || cs.candidates.circle || cs.candidates.ellipse);
    if (best) analytic = { kind: best.shape.kind, accepted: !!cs.pick, rms: +best.rms.toFixed(2), coveragePct: Math.round(best.coverage / 3.6), inlierRatio: +best.inlierRatio.toFixed(2) };
  }
  const ev = {
    section: m.section, type: node?.type ?? 'background', label: node?.label ?? '', importance: node?.importance ?? ctx.background.importance,
    visualIntent: node?.visualIntent ?? {}, symmetricWith: sym,
    regions: m.regionCount, tinyRegions: m.tiny, colorRoles: m.roles, points: m.points, curveRatio: +m.curveRatio.toFixed(2), roughness: +m.roughness.toFixed(2),
    nearFlatVertices: m.flatVertices, fidelity: +m.fidelity.toFixed(2), dominantColors: m.dominantColors, analyticCandidate: analytic,
    designedScore: +d.designed.toFixed(3), components: d.components && Object.fromEntries(Object.entries(d.components).map(([k, v]) => [k, +v.toFixed(2)])),
  };
  if (prevRound) ev.previous = prevRound;
  return ev;
}

export async function runReviewRounds({ prep, provider, encode, quality = 0.75, abstraction = 0.5, rounds = 2, tier = 'important', goodScore = 0.6, maxImportant = 8, save = () => {}, log = () => {} }) {
  if (!TIERS.includes(tier)) throw new Error(`tier must be one of ${TIERS.join('|')}`);
  rounds = Math.max(1, Math.min(MAX_ROUNDS, rounds));
  const ctx = prep.ctx, img = prep.img, W = img.width, H = img.height;
  const lab = prep.cache.get('lab') || (prep.cache.set('lab', labImage(img)), prep.cache.get('lab'));
  const base = traceGuided(prep, { quality, regularize: true, abstraction });
  const masks = sectionMasks(base.T, base.assign);
  const mBase = measureSections(base.T, base.assign, lab, masks, prep.imp);
  let cumulative = [];
  let current = base;
  const history = [];
  let lastStatus = new Map(); // section -> { directive, status, region }
  let best = { round: 0, designed: designedScores(mBase, mBase, ctx).designedScore, cumulative: [], result: base };
  for (let round = 1; round <= rounds; round++) {
    const mNow = measureSections(current.T, current.assign, lab, masks, prep.imp);
    const dNow = designedScores(mNow, mBase, ctx);
    // ---- which sections need Vision? ----
    const considered = [];
    for (const [p, b] of mBase.sections) {
      if (b.area < 20) continue; // sections made only of raster fragments
      const ds = dNow.sections.get(p), m = mNow.sections.get(p);
      if (!m || !m.regionCount) continue;
      const node = ctx.nodes.find((n) => n.path === p), imp = node?.importance ?? ctx.background.importance;
      let send = false, why = 'good designedScore';
      if (tier === 'off') why = 'tier off';
      else if (round === 1) {
        if (ds.designed >= goodScore) why = `designed ${ds.designed.toFixed(2)} >= ${goodScore}`;
        else if (tier === 'important' && imp < 0.5) why = 'importance < 0.5 (tier important)';
        else { send = true; why = `designed ${ds.designed.toFixed(2)} < ${goodScore}`; }
      } else {
        const st = lastStatus.get(p);
        const net = st ? st.designedAfter - st.designedBefore : 0;
        if (st && net < -0.005) { send = true; why = 'score dropped after previous directive'; }
        else if (st && /rejected|no-op/.test(st.status) && net < 0.01 && ds.designed < goodScore) { send = true; why = `previous directive ${st.status}, no net gain`; }
        else why = st ? (net >= 0.01 ? 'section improved' : 'previous directive accepted') : 'not reviewed';
      }
      considered.push({ section: p, designed: +ds.designed.toFixed(3), importance: imp, send, why, bounds: boundsOf(current, p) });
    }
    // important tier: at most `maxImportant` sections, the worst (importance-weighted gap to goodScore) first
    if (tier === 'important' && round === 1) {
      const ranked = considered.filter((c) => c.send).sort((a, b) => (goodScore - b.designed) * b.importance - (goodScore - a.designed) * a.importance || a.section.localeCompare(b.section));
      for (const c of ranked.slice(maxImportant)) { c.send = false; c.why = `beyond the ${maxImportant} most needed (tier important)`; }
    }
    const sent = considered.filter((c) => c.send);
    if (!sent.length) { log(`round ${round}: no section needs review`); break; }
    // ---- grouping: a small sub-section shares its selected ancestor's crops when they show it well ----
    const groups = [];
    for (const c of [...sent].sort((a, b) => a.section.split('.').length - b.section.split('.').length || a.section.localeCompare(b.section))) {
      const side = Math.max(c.bounds[2] - c.bounds[0], c.bounds[3] - c.bounds[1]);
      const host = groups.find((g) => c.section.startsWith(g.lead.section + '.') && contains(g.box, c.bounds) && Math.max(g.box[2], g.box[3]) <= 3.5 * Math.max(side, 8));
      if (host) { host.members.push(c); continue; }
      // a large section (a sun, the background) gets a DETAIL window on its roughest outline stretch, not the whole image
      let box = detailBox(c.bounds, W, H);
      if (Math.max(c.bounds[2] - c.bounds[0], c.bounds[3] - c.bounds[1]) > 0.45 * Math.max(W, H)) {
        const hs = hotspot(current, c.section);
        if (hs) { const s = Math.round(0.3 * Math.max(W, H)); box = [Math.max(0, Math.min(W - s, Math.round(hs[0] - s / 2))), Math.max(0, Math.min(H - s, Math.round(hs[1] - s / 2))), s, s]; }
      }
      groups.push({ lead: c, members: [c], box });
    }
    // ---- request ----
    const request = { round, image: { width: W, height: H }, rules: REVIEW_RULES, vocabulary: { ...ENUMS, regions: REGION_ENUMS }, groups: [] };
    for (const g of groups) {
      const k = detailScale(g.box);
      const ref = referenceCropRGB(img, g.box, k), cur = renderCropRGB(current.T, g.box, k), cv = contextView(img, g.box);
      const members = g.members.map((c) => sectionEvidence(current, ctx, mNow.sections.get(c.section), dNow.sections.get(c.section), lastStatus.get(c.section)));
      request.groups.push({ sections: members, images: { context: encode(cv), reference: encode(ref), current: encode(cur) }, imagePixels: cv.width * cv.height + ref.width * ref.height + cur.width * cur.height });
    }
    log(`round ${round}: ${sent.length} of ${considered.length} sections sent in ${groups.length} groups (tier ${tier})`);
    const t0 = Date.now();
    const raw = await provider.review(request);
    const ms = Date.now() - t0;
    const { directives, errors } = validateDirectives(raw, ctx);
    // only sections that were sent may be (re)directed in this round
    const sentSet = new Set(sent.map((c) => c.section));
    const accepted = directives.filter((d) => sentSet.has(d.section) || [...sentSet].some((s) => d.section.startsWith(s + '.'))); // never an unsent ancestor
    const byS = new Map(cumulative.map((d) => [d.section, d]));
    for (const d of accepted) byS.set(d.section, d);
    cumulative = [...byS.values()];
    // ---- apply ----
    const next = traceGuided(prep, { quality, regularize: true, abstraction, polish: cumulative });
    const mNext = measureSections(next.T, next.assign, lab, masks, prep.imp);
    const dNext = designedScores(mNext, mBase, ctx);
    const status = new Map();
    for (const e of next.sectionPolish?.report || []) status.set(e.section, e);
    const regionRep = new Map((next.regionPolish?.report || []).map((e) => [e.section, e]));
    lastStatus = new Map();
    for (const d of cumulative) {
      const e = status.get(d.section), rr = regionRep.get(d.section);
      lastStatus.set(d.section, {
        directive: { edges: d.edges, corners: d.corners, shape: d.shape, simplify: d.simplify, regions: d.regions, confidence: d.confidence },
        status: e?.status ?? 'no-chains', why: e ? whyOf(e) : 'no edges owned', region: rr ? { mode: rr.mode, merged: rr.merged, regionsBefore: rr.regionsBefore, regionsAfter: rr.regionsAfter, rejected: rr.rejected } : null,
        designedBefore: +(dNow.sections.get(d.section)?.designed ?? 0).toFixed(3), designedAfter: +(dNext.sections.get(d.section)?.designed ?? 0).toFixed(3),
      });
    }
    // ---- cost per section (apportioned by estimated tokens: image pixels / 750 + text chars / 4) ----
    const usage = provider.lastUsage || null;
    const est = request.groups.map((g) => g.imagePixels / 750 + JSON.stringify(g.sections).length / 4);
    const estSum = est.reduce((a, b) => a + b, 0) || 1;
    const perSection = {};
    request.groups.forEach((g, i) => { for (const s of g.sections) perSection[s.section] = { estTokens: Math.round(est[i] / g.sections.length), usd: usage?.usd != null ? +((usage.usd * est[i]) / estSum / g.sections.length).toFixed(4) : null }; });
    const record = {
      round, tier, provider: provider.name, ms, usage, sectionsConsidered: considered.length, sectionsSent: sent.length, groups: groups.map((g) => g.members.map((m) => m.section)),
      considered: considered.map(({ bounds, ...c }) => c), evidence: request.groups.map((g) => g.sections), raw, errors, directives: accepted, cumulative,
      applied: Object.fromEntries([...lastStatus].map(([k, v]) => [k, v])), perSection,
      designedBefore: +dNow.designedScore.toFixed(4), designedAfter: +dNext.designedScore.toFixed(4), weightedFidelityAfter: +next.metrics.weightedFidelity.toFixed(4),
    };
    save(`review.round${round}.json`, record, request.groups.map((g) => g.images));
    history.push(record);
    if (dNext.designedScore > best.designed + 1e-9) best = { round, designed: dNext.designedScore, cumulative: cumulative.map((d) => ({ ...d })), result: next };
    log(`round ${round}: ${accepted.length} directives (${errors.length} invalid), designedScore ${dNow.designedScore.toFixed(3)} -> ${dNext.designedScore.toFixed(3)}, ${(ms / 1000).toFixed(1)} s${usage?.usd != null ? `, $${usage.usd.toFixed(3)}` : ''}`);
    current = next;
  }
  // keep the BEST round, not the last: a later round may trade one section against another and lose overall
  const final = { selectedRound: best.round, designedScore: +best.designed.toFixed(4), cumulative: best.cumulative, rounds: history.map((h) => ({ round: h.round, designedAfter: h.designedAfter, usd: h.usage?.usd ?? null })) };
  save('review.final.json', final);
  if (best.round !== history.length) log(`selected round ${best.round} (designedScore ${best.designed.toFixed(3)}) over the last round`);
  return { result: best.result, cumulative: best.cumulative, history, base, selectedRound: best.round };
}

function whyOf(e) {
  if (e.status === 'accepted') return `${e.changed}/${e.chains} edges re-fitted${e.arcs ? `, ${e.arcs} arcs` : ''}`;
  if (e.status === 'rejected-pixels') return 'pixel fidelity in the section dropped beyond the allowance';
  if (e.status === 'rejected-rougher') return 'the result was rougher than before';
  if (e.status === 'rejected-score') return `no measurable improvement (sectionImprovement ${e.improvement?.toFixed?.(3)})`;
  if (e.status === 'rejected-style') return `pixels do not support the requested style (${e.style?.reason ?? ''})`;
  if (e.status === 'no-op') return `no edge could be re-fitted within the gates (${e.rejectedGeometry} off pixels, ${e.rejectedRough} rougher, ${e.rejectedComplexity} more complex)`;
  return e.status;
}
function boundsOf(res, p) {
  const rs = res.T.regions.filter((r) => (res.assign.get(r.id)?.path ?? 'background') === p);
  return [Math.min(...rs.map((r) => r.bounds[0])), Math.min(...rs.map((r) => r.bounds[1])), Math.max(...rs.map((r) => r.bounds[2])), Math.max(...rs.map((r) => r.bounds[3]))];
}
// midpoint of the roughest outline chain (roughness × length) of a section
function hotspot(res, p) {
  let best = null, bs = 0;
  const pathOf = (id) => (id < 0 ? null : res.assign.get(id)?.path ?? 'background');
  res.T.chains.forEach((c, ci) => {
    const a = pathOf(c.left), b = pathOf(c.right);
    if (a !== p && b !== p) return;
    if (a === b) return; // outline only
    const n = c.points.length; if (n < 20) return;
    const sc = roughness([res.T.fits[ci]]) * n;
    if (sc > bs) { bs = sc; best = c.points[n >> 1]; }
  });
  return best;
}
const contains = (box, b) => b[0] >= box[0] && b[1] >= box[1] && b[2] <= box[0] + box[2] && b[3] <= box[1] + box[3];
