// Playground mode for ReferenceTracer: reference and selected stage side by side, vision context + corrections,
// quality budget / automatic quality search, debug stages, semantic scene graph and metrics.
import { loadImageBrowser } from '../trace/image.js';
import { traceImage, DEFAULTS } from '../trace/index.js';
import { prepare, traceGuided } from '../trace/guided.js';
import { qualitySearch } from '../trace/quality-search.js';
import { optimizeTrace } from '../trace/optimize.js';
import { polishMetrics } from '../trace/polish.js';
import { ManualVisionProvider } from '../vision/manual-provider.js';
import { runVision } from '../vision/provider.js';
import { ManualPolishProvider, runPolish } from '../vision/polish-provider.js';
import { applyCorrections } from '../vision/context.js';
import { renderScene } from './render.js';
import { approxTokens } from './metrics.js';
import { walkScene } from './scene.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLIDERS = [
  { key: 'colors', label: 'colors', min: 2, max: 32, step: 1 },
  { key: 'simplification', label: 'simplification (DP ε, px)', min: 0.2, max: 4, step: 0.1 },
  { key: 'minRegionArea', label: 'minRegionArea (px²)', min: 0, max: 400, step: 1 },
  { key: 'curveTolerance', label: 'curveTolerance (px)', min: 0.3, max: 6, step: 0.1 },
];
const STAGES = ['Reference', 'Vision', 'Importance', 'Quantized', 'Regions', 'Contours', 'Simplified', 'Raw Trace', 'Regularized', 'Semantic', 'Error', 'Polish Map', 'Section Polish', 'Final'];
const REFS = [
  ['references/wolf.png', 'wolf.png (benchmark)', 'references/wolf.context.json', 'references/wolf.polish.v2.json'], ['references/city.png', 'city.png'], ['references/icons.png', 'icons.png'],
  ['out/flat-city.svg', 'our flat-city.svg (ground truth)'], ['out/icons.svg', 'our icons.svg (ground truth)'],
];
const hueRGB = (id) => { const h = (id * 137.508) % 360, s = 0.65, l = 0.55, k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))); };
const hashHue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return hueRGB(h % 997); };
const ramp = (t) => { t = Math.max(0, Math.min(1, t)); const stops = [[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 149, 64], [240, 249, 33]]; const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), u = f - i; return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * u)); };

export function initTracer({ onOpenInEditor }) {
  const st = {
    active: false, raw: null, res: null, opts: { ...DEFAULTS }, stage: 'Final', selected: null, timer: null, src: REFS[0][0],
    guided: true, rawContext: null, corrections: [], context: null, visionMs: 0, quality: 0.75, target: 0.93, history: null, prep: null,
    regularize: true, abstraction: 0.5, rawCache: new Map(), regCache: new Map(), polish: null,
    sectionPolish: true, polishRaw: null, directives: null, polishErrors: [],
  };
  const pane = $('#tracerPane');
  pane.innerHTML = `
    <label class="tl">reference <select id="trRef">${REFS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    <label class="tl">or upload <input type="file" id="trFile" accept="image/*"></label>
    <div class="tl"><label><input type="checkbox" id="trGuided" checked> vision-guided (needs a VisualContext)</label></div>
    <div id="trGuidedBox">
      <div class="tl"><div>quality <b id="v-quality"></b> <span class="hint" id="trBudget"></span></div><input type="range" id="s-quality" min="0.1" max="1" step="0.05" value="${st.quality}"></div>
      <div class="tl"><div>abstraction <b id="v-abstraction"></b> <span class="hint">0 trace · 0.25 clean · 0.5 designed · 0.75 simplified · 1 icon</span></div><input type="range" id="s-abstraction" min="0" max="1" step="0.05" value="0.5"></div>
      <div class="tl"><label><input type="checkbox" id="trRegularize" checked> Perceptual regularization</label> <button id="trOptimize">Optimize (score)</button></div>
      <div class="tl">target weighted fidelity <input id="trTarget" type="number" min="0.5" max="0.99" step="0.01" value="${st.target}" style="width:64px"> <button id="trSearch">Auto quality search</button></div>
      <details class="tl" id="trPolishBox"><summary>Section polish (PolishProvider) — directives per section</summary>
        <div class="hint">A reviewer (person or AI looking at reference vs vector) says how each section should be cleaned: edges straight|curved|auto, corners keep|sharp|soften|remove, shape none|circle|ellipse, simplify 0..1, confidence low|medium|high, regions {count preserve|simplify|single, merge none|compatible|aggressive, protect}. No geometry. Every directive is measured (style evidence, hard gates, designedScore improvement) and may be rejected.</div>
        <label><input type="checkbox" id="trSecPolish" checked> apply section polish (needs regularization)</label>
        <textarea id="trPolishJson" spellcheck="false" style="width:100%;height:110px;background:#1b1c21;color:#ccc;font:11px ui-monospace,monospace;border:1px solid #3a3b45"></textarea>
        <button id="trPolishApply">Apply directives</button> <span class="hint" id="trPolishErr"></span>
        <div id="trPolishReport" class="hint"></div>
      </details>
      <details class="tl" id="trVision" open><summary>VisualContext (ManualVisionProvider) — corrections</summary>
        <div id="trNodes" class="hint"></div>
        <textarea id="trCtx" spellcheck="false" style="width:100%;height:120px;background:#1b1c21;color:#ccc;font:11px ui-monospace,monospace;border:1px solid #3a3b45"></textarea>
        <button id="trCtxApply">Apply JSON</button> <span class="hint" id="trCtxErr"></span>
      </details>
    </div>
    <div id="trGlobalBox">${SLIDERS.map((s) => `<div class="tl"><div>${s.label} <b id="v-${s.key}"></b></div><input type="range" id="s-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${st.opts[s.key]}"></div>`).join('')}</div>
    <div class="tl">stage <span class="seg" id="trStages">${STAGES.map((s) => `<button data-stage="${s}" class="${s === st.stage ? 'on' : ''}">${s}</button>`).join('')}</span></div>
    <button id="trOpen">Open traced ARU in editor</button>
    <div id="trInfo" class="hint"></div><div id="trHistory" class="hint"></div>`;

  for (const s of SLIDERS) {
    const el = $('#s-' + s.key);
    $('#v-' + s.key).textContent = el.value;
    el.addEventListener('input', () => { $('#v-' + s.key).textContent = el.value; st.opts[s.key] = Number(el.value); schedule(); });
  }
  $('#v-quality').textContent = st.quality;
  $('#v-abstraction').textContent = st.abstraction;
  $('#s-abstraction').addEventListener('input', (e) => { st.abstraction = Number(e.target.value); $('#v-abstraction').textContent = st.abstraction; schedule(); });
  $('#trRegularize').addEventListener('change', (e) => { st.regularize = e.target.checked; schedule(); });
  $('#trSecPolish').addEventListener('change', (e) => { st.sectionPolish = e.target.checked; schedule(); });
  $('#trPolishApply').addEventListener('click', async () => {
    try { st.polishRaw = JSON.parse($('#trPolishJson').value); await review(); run(); }
    catch (e) { $('#trPolishErr').textContent = e.message; }
  });
  $('#trOptimize').addEventListener('click', () => {
    if (!st.prep) return;
    $('#trInfo').textContent = 'optimizing…';
    setTimeout(() => {
      const o = optimizeTrace(st.prep, { abstraction: st.abstraction });
      st.res = o.result; st.quality = o.entry.quality; $('#s-quality').value = st.quality; $('#v-quality').textContent = st.quality;
      st.history = o.tried.map((e, i) => ({ iteration: i, weightedFidelity: e.weightedFidelity, regions: e.regions, outputPoints: e.outputPoints, changes: [`A ${e.abstraction} q ${e.quality} score ${e.score.toFixed(3)} polish ${e.polish.toFixed(2)}${e === o.entry ? ' ← best' : ''}`] }));
      afterTrace('optimized');
    }, 10);
  });
  $('#s-quality').addEventListener('input', (e) => { st.quality = Number(e.target.value); $('#v-quality').textContent = st.quality; st.history = null; schedule(); });
  $('#trTarget').addEventListener('change', (e) => { st.target = Number(e.target.value); });
  $('#trGuided').addEventListener('change', (e) => { st.guided = e.target.checked; syncMode(); schedule(); });
  $('#trRef').addEventListener('change', (e) => { st.src = e.target.value; load(st.src); });
  $('#trFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) { st.rawContext = null; load(URL.createObjectURL(f), true); } });
  $('#trStages').addEventListener('click', (e) => {
    const b = e.target.closest('[data-stage]'); if (!b) return;
    st.stage = b.dataset.stage;
    $('#trStages').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    drawStage();
  });
  $('#trOpen').addEventListener('click', () => { if (st.res) onOpenInEditor(st.res.aru); });
  $('#trCtxApply').addEventListener('click', async () => {
    try { st.rawContext = JSON.parse($('#trCtx').value); st.corrections = []; await analyze(); run(); $('#trCtxErr').textContent = ''; }
    catch (e) { $('#trCtxErr').textContent = e.message; }
  });
  $('#trSearch').addEventListener('click', () => {
    if (!st.prep) return;
    $('#trInfo').textContent = 'searching…';
    setTimeout(() => {
      const s = qualitySearch(st.prep, { targetFidelity: st.target, quality: st.quality, maxIterations: 6 });
      st.res = s.result; st.history = s.history; st.selected = null;
      afterTrace(`quality search: ${s.history.length} traces`);
    }, 10);
  });

  function syncMode() {
    const g = st.guided && !!st.rawContext;
    $('#trGuidedBox').style.display = st.guided ? '' : 'none';
    $('#trGlobalBox').style.display = g ? 'none' : '';
  }
  function schedule() { clearTimeout(st.timer); st.timer = setTimeout(run, 220); }
  async function load(src, isUpload = false) {
    $('#trInfo').textContent = 'loading…';
    try {
      st.raw = await loadImageBrowser(src);
      const entry = REFS.find((r) => r[0] === src);
      st.rawContext = null; st.corrections = []; st.history = null;
      if (!isUpload && entry?.[2]) st.rawContext = await (await fetch(entry[2])).json();
      st.polishRaw = !isUpload && entry?.[3] ? await (await fetch(entry[3])).json() : null;
      $('#trPolishJson').value = st.polishRaw ? JSON.stringify(st.polishRaw, null, 1) : '{ "directives": [] }';
      $('#trCtx').value = st.rawContext ? JSON.stringify(st.rawContext, null, 1) : '// paste a VisualContext JSON here (objects/parts with bounds or polygons, importance, preserve/ignore)';
      await analyze(); await review(); syncMode(); run();
    } catch (e) { $('#trInfo').textContent = e.message; }
  }
  // Vision step: the provider is swappable; the tracer only sees the VisualContext it returns
  async function analyze() {
    st.context = null; st.prep = null;
    if (!st.rawContext || !st.raw) return;
    const corrected = applyCorrections(st.rawContext, st.corrections);
    const v = await runVision(new ManualVisionProvider(corrected), st.raw);
    st.context = v.context; st.visionMs = v.ms;
    st.prep = prepare(st.raw, st.context);
    renderNodes();
  }
  // Polish review step: provider swappable like VisionProvider (manual JSON here; an API provider runs from the CLI)
  async function review() {
    st.directives = null; st.polishErrors = [];
    if (!st.polishRaw || !st.context) { $('#trPolishErr').textContent = ''; return; }
    const r = await runPolish(new ManualPolishProvider(st.polishRaw), { image: { width: st.raw.width, height: st.raw.height }, sections: [] }, st.context);
    st.directives = r.directives; st.polishErrors = r.errors;
    $('#trPolishErr').textContent = r.errors.length ? r.errors.join(' · ') : `${r.directives.length} directives`;
  }
  function run() {
    if (!st.raw) return;
    $('#trInfo').textContent = 'tracing…';
    setTimeout(() => {
      if (st.guided && st.prep) st.res = traceGuided(st.prep, { quality: st.quality, regularize: st.regularize, abstraction: st.abstraction, polish: st.sectionPolish && st.regularize && st.directives?.length ? st.directives : null });
      else st.res = traceImage(st.raw, st.opts);
      st.selected = null;
      afterTrace();
    }, 10);
  }
  function afterTrace(prefix = '') {
    const R = st.res, m = R.metrics;
    st.polish = R.T && R.assign ? polishMetrics(R.T, R.assign) : null;
    const ms = m.traceMs ?? m.totalMs;
    $('#trInfo').textContent = `${prefix ? prefix + ' · ' : ''}${R.img.width}×${R.img.height} px · ${st.prep && st.guided ? 'vision-guided' : 'global'} trace ${ms.toFixed(0)} ms`;
    if (R.plan) { const b = R.plan.budget; $('#trBudget').textContent = `→ ${b.colors} colors (+${b.maxLocalColors}/zone), min area ${b.minRegionArea}, ≤${b.maxRegions} regions`; }
    $('#trHistory').innerHTML = st.history ? `<table>${st.history.map((h) => `<tr><td>#${h.iteration}</td><td>${(h.weightedFidelity * 100).toFixed(1)}%</td><td>${h.regions} reg</td><td>${h.outputPoints} pts</td><td>${esc(h.changes.join('; '))}</td></tr>`).join('')}</table>` : '';
    renderPolishReport();
    drawReference(); drawStage(); renderTree(); renderMetrics(); renderInspector();
  }
  function renderPolishReport() {
    const sp = st.res.sectionPolish;
    if (!sp) { $('#trPolishReport').innerHTML = st.regularize ? '' : 'section polish runs on regularized traces'; return; }
    const col = { accepted: '#7fdc8a', 'no-op': '#999', 'no-chains': '#999', 'rejected-pixels': '#ff7a7a', 'rejected-rougher': '#ffb36b', 'rejected-score': '#ffb36b', 'rejected-style': '#ff7a7a' };
    const rp = st.res.regionPolish, j = sp.junctions || {};
    const regionHtml = rp ? `<div>regions: ${rp.stats?.merged ?? 0} fragments merged${rp.reverted?.length ? ` · reverted (score dropped): ${rp.reverted.map((x) => esc(x.split('.').slice(-2).join('.'))).join(', ')}` : ''}${st.res.thin ? ` · thin features protected: ${st.res.thin.components}` : ''}</div><table>${rp.report.filter((e) => e.merged || e.directive).map((e) => `<tr><td>${esc(e.section.split('.').slice(-2).join('.'))}</td><td>${e.mode}${e.level ? '/' + e.level : ''}</td><td>${e.regionsBefore}→${e.regionsAfter}</td><td>${e.excluded ? '<span style="color:#ffb36b">reverted</span>' : ''}</td></tr>`).join('')}</table>` : '';
    const junctionHtml = `<div>junctions: ${j.accepted ?? 0} of ${j.junctions ?? 0} moved as one entity (${j.revertedPixels ?? 0} reverted by pixels)</div>`;
    $('#trPolishReport').innerHTML = regionHtml + junctionHtml + `<div>${sp.totals.accepted} accepted · ${sp.totals.rejected} rejected · ${sp.totals.chainsChanged} chains re-fitted · points ${sp.totals.pointsBefore} → ${sp.totals.pointsAfter} · ${(st.res.metrics.timings.sectionPolish ?? 0).toFixed(0)} ms</div><table>${sp.report.map((e) => `<tr title="${esc(e.reason)}"><td>${esc(e.section.split('.').slice(-2).join('.'))}</td><td>${e.directive.edges}/${e.directive.corners}${e.directive.shape !== 'none' ? '/' + e.directive.shape : ''}</td><td style="color:${col[e.status]}">${e.status}</td><td>${e.changed}/${e.chains}${e.arcs ? ' · ' + e.arcs + ' arcs' : ''}</td><td>rough ${e.roughBefore.toFixed(2)}→${e.roughAfter.toFixed(2)}</td><td title="${esc((e.style?.decisions || []).join('; '))}">${e.improvement !== undefined ? 'Δ ' + e.improvement.toFixed(3) : ''}</td><td>${e.confidence ?? ''}</td></tr>`).join('')}</table>`;
  }

  // ---------- vision node list with corrections ----------
  function renderNodes() {
    if (!st.context) { $('#trNodes').innerHTML = ''; return; }
    $('#trNodes').innerHTML = st.context.nodes.map((n) => `<div style="margin:2px 0 2px ${n.depth * 12}px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input data-path="${esc(n.path)}" data-k="rename" value="${esc(n.id)}" style="width:86px;background:#1b1c21;color:#ddd;border:1px solid #3a3b45;font-size:11px">
      <span>${esc(n.type)}</span>
      <input type="range" data-path="${esc(n.path)}" data-k="importance" min="0" max="1" step="0.05" value="${n.importance}" style="width:70px" title="importance"><b>${n.importance}</b>
      <label><input type="checkbox" data-path="${esc(n.path)}" data-k="preserve" ${n.preserve ? 'checked' : ''}>preserve</label>
      <label><input type="checkbox" data-path="${esc(n.path)}" data-k="ignore" ${n.ignore ? 'checked' : ''}>ignore</label>
      ${n.bounds ? `<input data-path="${esc(n.path)}" data-k="bounds" value="${n.bounds.join(' ')}" style="width:120px;background:#1b1c21;color:#ddd;border:1px solid #3a3b45;font-size:11px" title="bounds x y w h">` : ''}
    </div>`).join('');
  }
  $('#trNodes').addEventListener('change', async (e) => {
    const el = e.target, path = el.dataset.path, k = el.dataset.k; if (!path) return;
    const c = { path };
    if (k === 'importance') c.importance = Number(el.value);
    else if (k === 'preserve' || k === 'ignore') c[k] = el.checked;
    else if (k === 'bounds') c.bounds = el.value.trim().split(/[\s,]+/).map(Number);
    else if (k === 'rename') c.rename = el.value.trim();
    st.corrections.push(c); st.history = null;
    await analyze(); run();
  });

  // ---------- drawing ----------
  const W = () => st.res.img.width, H = () => st.res.img.height;
  function rasterCanvas(pixel) {
    const c = document.createElement('canvas'); c.width = W(); c.height = H();
    const ctx = c.getContext('2d'), im = ctx.createImageData(W(), H());
    for (let i = 0; i < W() * H(); i++) { const [r, g, b] = pixel(i); im.data[i * 4] = r; im.data[i * 4 + 1] = g; im.data[i * 4 + 2] = b; im.data[i * 4 + 3] = 255; }
    ctx.putImageData(im, 0, 0);
    return c;
  }
  const refPixel = (i) => { const d = st.res.img.data; return [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]; };
  const grayRef = (i, k = 0.45) => { const [r, g, b] = refPixel(i), v = (r + g + b) / 3 * k; return [v, v, v]; };
  function drawReference() { $('#tvRef').replaceChildren(rasterCanvas(refPixel)); }
  function overlay(inner) { return `<svg viewBox="0 0 ${W()} ${H()}" class="ov" fill="none" stroke-width="0.8">${inner}</svg>`; }
  function drawStage() {
    if (!st.res) return;
    const R = st.res, box = $('#tvStage'), pal = R.q.palette;
    $('#tvStageName').textContent = st.stage + (R.plan ? '' : ' (global)');
    const imp = R.imp || st.prep?.imp;
    switch (st.stage) {
      case 'Reference': box.replaceChildren(rasterCanvas(refPixel)); return;
      case 'Vision': {
        box.replaceChildren(rasterCanvas((i) => grayRef(i, 0.8)));
        if (!st.context) return;
        const f = (p) => `${(p[0] * W()).toFixed(1)},${(p[1] * H()).toFixed(1)}`;
        const shapes = st.context.nodes.filter((n) => n.hasShape).map((n) => {
          const col = n.ignore ? '#ff4d4d' : `rgb(${hashHue(n.path).join(',')})`, dash = n.ignore ? ' stroke-dasharray="4 3"' : '';
          const poly = n.polygon ? n.polygon : [[n.bounds[0], n.bounds[1]], [n.bounds[0] + n.bounds[2], n.bounds[1]], [n.bounds[0] + n.bounds[2], n.bounds[1] + n.bounds[3]], [n.bounds[0], n.bounds[1] + n.bounds[3]]];
          const [lx, ly] = poly.reduce((m, p) => [Math.min(m[0], p[0]), Math.min(m[1], p[1])], [1, 1]);
          return `<polygon points="${poly.map(f).join(' ')}" stroke="${col}" stroke-width="1.6"${dash}/><text x="${(lx * W() + 2).toFixed(1)}" y="${(ly * H() - 2).toFixed(1)}" fill="${col}" stroke="#000" stroke-width="2" paint-order="stroke" font-size="${Math.max(8, W() / 55)}" font-family="monospace">${esc(n.id)} ${n.ignore ? 'ignore' : n.importance}${n.preserve ? ' ★' : ''}</text>`;
        }).join('');
        box.insertAdjacentHTML('beforeend', overlay(shapes));
        return;
      }
      case 'Importance': box.replaceChildren(imp ? rasterCanvas((i) => { const g = grayRef(i, 0.35); const c = ramp(imp.map[i]); return c.map((v, k) => v * 0.8 + g[k] * 0.2); }) : rasterCanvas((i) => grayRef(i))); return;
      case 'Quantized': box.replaceChildren(rasterCanvas((i) => { const l = R.q.labels[i]; const local = R.q.paletteScope && R.q.paletteScope[l] !== 'global'; return pal[l]; })); return;
      case 'Regions': box.replaceChildren(rasterCanvas((i) => hueRGB(R.reg.ids[i]))); return;
      case 'Contours': case 'Simplified': {
        const base = rasterCanvas((i) => { const c = pal[R.reg.labels[i]]; return c.map((v) => 40 + v * 0.35); });
        const lines = st.stage === 'Contours'
          ? R.con.chains.map((c, i) => `<polyline points="${c.points.map((p) => p.join(',')).join(' ')}" stroke="rgb(${hueRGB(i).join(',')})"/>`).join('')
          : R.simp.map((s, i) => {
            const pts = s.keep.map((k) => s.dense[k]);
            const col = R.chainInfo ? `rgb(${ramp(R.chainInfo[i].edgeImportance).join(',')})` : `rgb(${hueRGB(i).join(',')})`;
            return `<polyline points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" stroke="${col}"/>` + pts.map((p) => `<rect x="${(p[0] - 0.6).toFixed(1)}" y="${(p[1] - 0.6).toFixed(1)}" width="1.2" height="1.2" fill="#fff"/>`).join('');
          }).join('');
        box.replaceChildren(base); box.insertAdjacentHTML('beforeend', overlay(lines));
        return;
      }
      case 'Semantic': {
        if (!R.assign) { box.replaceChildren(rasterCanvas((i) => hueRGB(R.reg.ids[i]))); return; }
        const col = new Map([...R.assign].map(([id, a]) => [id, a.node ? hashHue(a.path) : [70, 70, 78]]));
        box.replaceChildren(rasterCanvas((i) => col.get(R.reg.ids[i])));
        return;
      }
      case 'Raw Trace': case 'Regularized': {
        if (!st.prep) { box.replaceChildren(rasterCanvas((i) => grayRef(i))); return; }
        const wantReg = st.stage === 'Regularized', cache = wantReg ? st.regCache : st.rawCache, key = `${st.quality}|${st.abstraction}`;
        let other = (R.plan && !!R.regularizer === wantReg) ? R : cache.get(key);
        if (!other) { other = traceGuided(st.prep, { quality: st.quality, regularize: wantReg, abstraction: st.abstraction }); cache.set(key, other); }
        box.innerHTML = renderScene(other.scene, { dataAttrs: false });
        const sv = box.querySelector('svg'); sv.removeAttribute('width'); sv.removeAttribute('height');
        const p = polishMetrics(other.T, other.assign);
        $('#tvStageName').textContent = `${st.stage} · ${other.metrics.regions} regions · polish ${p.polishScore.toFixed(2)} · weighted ${(other.metrics.weightedFidelity * 100).toFixed(1)}%`;
        return;
      }
      case 'Section Polish': {
        const sp = R.sectionPolish;
        box.innerHTML = renderScene(R.scene, { dataAttrs: false });
        const sv = box.querySelector('svg'); sv.removeAttribute('width'); sv.removeAttribute('height'); sv.style.opacity = '0.45';
        if (!sp) { $('#tvStageName').textContent = 'Section Polish · off (enable regularization + directives)'; return; }
        const colors = { line: '#7fdc8a', curve: '#ffd166', arc: '#4cc9f0' };
        const toPath = (f) => `M${f.start.map((v) => v.toFixed(1)).join(' ')}` + f.segs.map((s) => (s.t === 'L' ? `L${s.p.map((v) => v.toFixed(1)).join(' ')}` : `C${[...s.c1, ...s.c2, ...s.p].map((v) => v.toFixed(1)).join(' ')}`)).join('');
        const lines = [...sp.changedChains].map(([ci, k]) => `<path d="${toPath(R.fits[ci])}" stroke="${colors[k]}" stroke-width="1.4"/>`).join('');
        box.insertAdjacentHTML('beforeend', overlay(lines));
        $('#tvStageName').textContent = `Section Polish · ${sp.changedChains.size} chains re-fitted · green = straight · yellow = curve · blue = true arc`;
        return;
      }
      case 'Polish Map': {
        const P = st.polish; if (!P) { box.replaceChildren(rasterCanvas((i) => grayRef(i))); return; }
        // tiny regions in red over a dimmed reference; rough edges as orange lines
        box.replaceChildren(rasterCanvas((i) => (P.tinyIds.has(R.T.ids[i]) ? [255, 60, 90] : grayRef(i, 0.5))));
        const lines = R.fits.map((f, ci) => P.roughByChain[ci] > 1.2 ? `<polyline points="${[f.start, ...f.segs.map((s) => s.p)].map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" stroke="#ffa53b"/>` : '').join('');
        box.insertAdjacentHTML('beforeend', overlay(lines));
        $('#tvStageName').textContent = `Polish Map · red = tiny regions (${P.tinyRegions}) · orange = rough edges`;
        return;
      }
      case 'Error': {
        const em = R.errorMaps; if (!em) { box.replaceChildren(rasterCanvas((i) => grayRef(i))); return; }
        box.replaceChildren(rasterCanvas((i) => ramp(em.weighted[i] / 20)));
        return;
      }
    }
    // Final: the vector result, rendered by the normal ARU renderer
    box.innerHTML = renderScene(R.scene);
    const svg = box.querySelector('svg'); svg.removeAttribute('width'); svg.removeAttribute('height');
    svg.addEventListener('click', (e) => { const el = e.target.closest('[data-id]'); if (el) select(Number(el.dataset.id)); });
    highlight();
  }
  function highlight() {
    const svg = $('#tvStage svg:not(.ov)'); if (!svg) return;
    svg.querySelectorAll('.trsel').forEach((n) => n.classList.remove('trsel'));
    if (st.selected != null) svg.querySelectorAll(`[data-id="${st.selected}"], [data-id="${st.selected}"] *`).forEach((n) => n.classList.add('trsel'));
  }
  function select(id) { st.selected = id; if (st.stage !== 'Final') { st.stage = 'Final'; $('#trStages').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.stage === 'Final')); drawStage(); } highlight(); renderInspector(); renderTree(); }

  // ---------- bottom panels: scene graph (semantic when guided), inspector, metrics ----------
  function renderTree() {
    if (!st.active || !st.res) return;
    const scene = st.res.scene;
    const build = (n) => {
      let html = '<ul>';
      for (const c of n.children) {
        const isShape = c.type !== 'group';
        let count = 0; if (!isShape) walkScene(c, (x) => { if (x.type !== 'group') count++; });
        html += `<li><div class="row${c.id === st.selected ? ' selected' : ''}" data-tid="${c.id}">${isShape ? `<span class="swatch" style="background:${c.fill}"></span><span class="type">path</span>` : '<span class="toggle">▸</span><span class="kind">group</span>'} <b>${esc(c.name)}</b> <span class="gen">${isShape ? `${c.meta?.geomId ?? ''} · ${Math.round(c.meta?.area ?? 0)} px²` : `${count} regions`}</span></div>`;
        if (!isShape && c.children.length) html += build(c);
        html += '</li>';
      }
      return html + '</ul>';
    };
    $('#tree').innerHTML = build(scene.root);
  }
  function renderInspector() {
    if (!st.active) return;
    const n = st.selected != null && st.res?.scene.byId.get(st.selected);
    if (!n) { $('#inspector').innerHTML = '<span class="hint">Click a region in the Final view or in the scene graph.</span>'; return; }
    const m = n.meta || {};
    const rows = [['path', esc(n.path)], ['type', n.type]];
    for (const [k, v] of Object.entries(m)) rows.push([k, k === 'sourceColor' ? `<span class="swatch" style="background:${v}"></span> ${v}` : esc(Array.isArray(v) ? v.join(' ') : v)]);
    $('#inspector').innerHTML = `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  }
  function renderMetrics() {
    if (!st.active || !st.res) return;
    const m = st.res.metrics, f = (v, d = 2) => (v === undefined ? '–' : Number.isInteger(v) ? v : v.toFixed(d)), pct = (v) => (v === undefined ? '–' : (v * 100).toFixed(1) + '%');
    const guided = !!st.res.plan;
    const rows = guided ? [
      ['<b>weighted fidelity</b>', `<b>${pct(m.weightedFidelity)}</b>`], ['pixel fidelity (ΔE≤10)', pct(m.pixelFidelity)], ['weighted color error ΔE', f(m.weightedColorError)], ['mean color error ΔE', f(m.meanColorError)],
      ['regions / paths', m.regions], ['colors global + local', `${m.globalColors} + ${m.localColors}`], ['Bézier segments', m.bezierSegments], ['output points', m.outputPoints],
      ['geometry compression', f(m.compressionRatio, 1) + '×'], ['mean / max trace error', `${f(m.meanTraceError)} / ${f(m.maxTraceError)} px`], ['ARU', `${m.aruBytes} bytes · ~${approxTokens(st.res.aru)} tokens`],
      ['trace time', `${f(m.traceMs, 0)} ms`], ['vision analysis', `${f(st.visionMs)} ms (manual)`],
      ['small regions', `kept ${st.res.saliency.keptBySize}+${st.res.saliency.keptBySaliency} · noise ${st.res.saliency.mergedNoise} · low saliency ${st.res.saliency.mergedLowSaliency} · budget ${st.res.saliency.budgetMerged} · ignored ${st.res.saliency.mergedIgnored}`],
      ...(st.polish ? [['<b>polish score</b>', `<b>${st.polish.polishScore.toFixed(3)}</b>`], ['tiny regions', `${st.polish.tinyRegions} (${(st.polish.tinyRegionRatio * 100).toFixed(0)}%)`], ['colors / near-duplicates', `${st.polish.colors} / ${st.polish.nearDuplicateColors}`], ['edge roughness', st.polish.edgeRoughness.toFixed(2)], ['curve ratio', (st.polish.curveRatio * 100).toFixed(0) + '%'], ['regions per part', st.polish.semanticFragmentation.toFixed(1)]] : []),
      ...(st.res.regularizer ? [['regularizer', `${st.res.regularizer.merged} merges · ${st.res.regularizer.gradients} gradients · ${st.res.edges.ellipses} ellipses · ${st.res.edges.snapped} snapped · ${(m.timings.regularize ?? 0).toFixed(0)} ms`]] : []),
      ['local palettes', st.res.q.zoneStats.filter((z) => z.localColors).map((z) => `${esc(z.target.split('.').slice(-2).join('.'))} ${z.localColors}`).join(', ') || '–'],
    ] : [
      ['regions', m.regions], ['palette colors', m.paletteSize], ['rawContourPoints', m.rawContourPoints], ['simplifiedPoints', m.simplifiedPoints], ['bezierSegments', m.bezierSegments],
      ['compressionRatio', f(m.compressionRatio, 1) + '×'], ['meanTraceError', `${f(m.meanTraceError)} px`], ['maxTraceError', `${f(m.maxTraceError)} px`],
      ['pixels within ΔRGB 30', pct(m.pixelsWithin30)], ['ARU', `${st.res.aru.length} chars · ~${approxTokens(st.res.aru)} tokens`], ['trace time', `${f(m.totalMs, 0)} ms`],
    ];
    $('#metrics').innerHTML = `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td class="num">${v}</td></tr>`).join('')}</table>`;
  }
  $('#tree').addEventListener('click', (e) => { if (!st.active) return; const r = e.target.closest('[data-tid]'); if (r) select(Number(r.dataset.tid)); });

  return {
    activate() { st.active = true; if (!st.raw) load(st.src); else { renderTree(); renderMetrics(); renderInspector(); } },
    deactivate() { st.active = false; },
  };
}
