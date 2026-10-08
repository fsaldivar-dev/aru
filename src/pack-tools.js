import { compile as compileAru } from './engine.js';
export async function preparePack(text, doc, rasterize) {
  const P = await import('../trace/iconpack.js');
  const r = compileAru(`canvas ${doc.width} ${doc.height}\nbackground none\n${text}`);
  if (!r.scene || r.errors.length) return null;
  const pack = P.findPack(r.scene); if (!pack) return null;
  const ins = await P.inspectPack(r.scene, pack, rasterize);
  return { P, scene: r.scene, base: r.scene, baseIns: ins, levers: {}, ins, tried: [], report: P.packReport(ins, {}) };
}

export async function applyPack(pk, answer, rasterize) {
  const out = [];
  const tryScene = async (scene, what, redraw = null) => {
    const beforeIcons = new Map(pk.P.findPack(pk.scene).children.map(icon => [icon.name, icon]));
    const gradientsChanged = JSON.stringify(scene.gradients) !== JSON.stringify(pk.scene.gradients);
    const changed = pk.P.findPack(scene).children.filter(icon => gradientsChanged || drawingKey(icon) !== drawingKey(beforeIcons.get(icon.name))).map(icon => icon.name);
    const recognition = new Map(pk.recognition || []);
    for (const name of changed) recognition.delete(name);
    const ins = await pk.P.inspectPack(scene, pk.P.findPack(scene), rasterize, { recognition });
    const beforeIcon = pk.ins.icons.find(icon => icon.name === redraw), afterIcon = ins.icons.find(icon => icon.name === redraw);
    const geometryImproved = ins.geometryScore > pk.ins.geometryScore + 1e-9;
    const nonRegressing = ins.geometryScore + 1e-9 >= pk.ins.geometryScore && (!redraw || afterIcon?.geometryScore + 1e-9 >= beforeIcon?.geometryScore);
    const unresolvedMeaning = redraw && beforeIcon?.recognition !== 'recognized' && afterIcon?.renderHash !== beforeIcon?.renderHash;
    // A meaning repair may leave measured geometry equally good. Keep that candidate for a blind test,
    // but never manufacture an improvement by deleting its old recognition failure.
    const kept = changed.length > 0 && nonRegressing && (geometryImproved || (unresolvedMeaning && changed.includes(redraw)));
    const attempt = { what, score: ins.score, geometryScore: ins.geometryScore, recognition: ins.recognition, kept, pending: kept && ins.recognition.unverified > 0 };
    pk.tried.push(attempt); out.push(attempt);
    if (kept) { pk.scene = scene; pk.ins = ins; pk.recognition = recognition; }
    return kept;
  };
  const lv = Object.fromEntries(Object.entries(answer.levers || {}).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  if (Object.keys(lv).length) {
    const levers = { ...pk.levers, ...lv };
    // levers always apply to the BASE pack (measured as such), never on top of an already scaled one
    if (!pk.baseIns) pk.baseIns = await pk.P.inspectPack(pk.base, pk.P.findPack(pk.base), rasterize);
    if (await tryScene(pk.P.applyPackLevers(pk.base, levers, pk.baseIns), `palancas ${JSON.stringify(lv)}`)) pk.levers = levers;
  }
  // a redraw goes into the BASE pack and through the same levers as every other icon (repair, stroke, size, colour),
  // so the pack stays consistent and a mistake the AI already chose to repair cannot come back
  for (const rd of (answer.redraw || []).slice(0, 8)) {
    const res = pk.P.applyRedraw(pk.base, rd.icon, rd.aru);
    if (!res.ok) { out.push({ what: `redibujo ${rd.icon}`, error: res.error }); continue; }
    const baseIns = await pk.P.inspectPack(res.scene, pk.P.findPack(res.scene), rasterize);
    if (await tryScene(pk.P.applyPackLevers(res.scene, pk.levers, baseIns), `redibujo ${rd.icon}`, rd.icon)) { pk.base = res.scene; pk.baseIns = baseIns; }
  }
  pk.report = pk.P.packReport(pk.ins, pk.levers);
  return out;
}
// Source positions and compiler IDs are not drawing changes. Re-submitting identical geometry cannot
// clear a failure or count as a retained correction.
const drawingKey = icon => JSON.stringify(icon, (key, value) => ['id', 'path', 'line', 'col'].includes(key) ? undefined : value);
export const needsPackRecognition = pk => (pk.ins?.recognition?.unverified ?? pk.ins?.icons.length ?? 0) > 0;
// blind test sheet: the icons numbered in a shuffled (deterministic) order, no labels; returns the order for scoring

export async function setPackRecognition(pk, blind, answers, rasterize) {
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^otro:\s*/, '').trim();
  const icons = pk.P.findPack(pk.scene).children.filter((c) => c.type === 'group'), byName = new Map(icons.map((ic) => [ic.name, ic]));
  pk.recognition = new Map();
  const seen = new Set();
  for (const a of answers || []) {
    if (!Number.isInteger(a?.icon) || typeof a.meaning !== 'string' || !norm(a.meaning)) continue;
    const name = blind.order[a.icon - 1], ic = byName.get(name); if (!ic) continue;
    // Multiple answers for the same numbered image are ambiguous. Leave it unverified, even if one
    // answer happens to match the intended label.
    if (seen.has(name)) { pk.recognition.delete(name); continue; }
    seen.add(name);
    const label = ic.label || ic.name;
    pk.recognition.set(name, { ok: norm(a.meaning) === norm(label), readAs: String(a.meaning || '').replace(/^otro:\s*/i, '') });
  }
  pk.ins = await pk.P.inspectPack(pk.scene, pk.P.findPack(pk.scene), rasterize, { recognition: pk.recognition });
  pk.report = pk.P.packReport(pk.ins, pk.levers);
  return pk.ins.icons.filter(icon => icon.recognition !== 'recognized').map(icon => `${icon.name}→${pk.recognition.get(icon.name)?.readAs || 'sin verificar'}`);
}
// what the AI sees: every icon at 96 px (red frame = issues) with the same icon at 24 px under it
