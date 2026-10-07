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
  const tryScene = async (scene, what) => {
    const ins = await pk.P.inspectPack(scene, pk.P.findPack(scene), rasterize, { recognition: pk.recognition });
    const kept = ins.score > pk.ins.score + 1e-9;
    pk.tried.push({ what, score: ins.score, kept }); out.push({ what, score: ins.score, kept });
    if (kept) { pk.scene = scene; pk.ins = ins; }
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
    const prevRec = pk.recognition?.get(rd.icon); pk.recognition?.delete(rd.icon); // a new drawing must pass the blind test again
    const baseIns = await pk.P.inspectPack(res.scene, pk.P.findPack(res.scene), rasterize);
    if (await tryScene(pk.P.applyPackLevers(res.scene, pk.levers, baseIns), `redibujo ${rd.icon}`)) { pk.base = res.scene; pk.baseIns = baseIns; }
    else if (prevRec) pk.recognition.set(rd.icon, prevRec);
  }
  pk.report = pk.P.packReport(pk.ins, pk.levers);
  return out;
}
// blind test sheet: the icons numbered in a shuffled (deterministic) order, no labels; returns the order for scoring

export async function setPackRecognition(pk, blind, answers, rasterize) {
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^otro:\s*/, '').trim();
  const icons = pk.P.findPack(pk.scene).children.filter((c) => c.type === 'group'), byName = new Map(icons.map((ic) => [ic.name, ic]));
  pk.recognition = new Map();
  for (const a of answers || []) {
    const name = blind.order[a.icon - 1]; if (!name) continue;
    const ic = byName.get(name), label = ic.label || ic.name;
    pk.recognition.set(name, { ok: norm(a.meaning) === norm(label), readAs: String(a.meaning || '').replace(/^otro:\s*/i, '') });
  }
  pk.ins = await pk.P.inspectPack(pk.scene, pk.P.findPack(pk.scene), rasterize, { recognition: pk.recognition });
  pk.report = pk.P.packReport(pk.ins, pk.levers);
  return [...pk.recognition].filter(([, r]) => !r.ok).map(([n, r]) => `${n}→${r.readAs}`);
}
// what the AI sees: every icon at 96 px (red frame = issues) with the same icon at 24 px under it
