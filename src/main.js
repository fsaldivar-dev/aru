import { compile } from './engine.js';
import { applyOperation } from './ops.js';
import { renderScene } from './render.js';
import { sceneMetrics, textMetrics, svgMetrics, aruReadability, semanticMetrics } from './metrics.js';
import { walkScene } from './scene.js';
import { toAru } from './serialize.js';
import { debugOverlay, semanticDescendantIds } from './debug.js';
import { initTracer } from './tracer-ui.js';

const $ = (s) => document.querySelector(s);
const editor = $('#editor'), compiledEl = $('#compiled'), errorsEl = $('#errors'), host = $('#canvasHost'), treeEl = $('#tree'), inspectorEl = $('#inspector'), metricsEl = $('#metrics'), statusEl = $('#status');
const EXAMPLES = ['wolf-blueprint.aru', 'scatter-tree.aru', 'cat-on-rock.aru', 'flat-city.aru', 'icons.aru', 'wolf.aru', 'mountains-generated.aru', 'basic.aru', 'features.aru'];

// selection: { kind: 'node', path } | { kind: 'element', bp, name } | { kind: 'landmark', bp, name } | { kind: 'blueprint', bp }
let state = { result: null, sel: null, mode: 'final', view: 'source', tab: 'semantic' };

// ---------- compile & render ----------
function update() {
  const src = editor.value;
  const t0 = performance.now();
  const result = compile(src);
  state.result = result;
  if (result.svg) {
    const t1 = performance.now();
    host.innerHTML = result.svg;
    result.timings.dom = performance.now() - t1;
  }
  if (!result.scene?.blueprints?.size && state.tab === 'semantic') state.tab = 'geometry';
  if (result.scene?.blueprints?.size && state.tabAuto !== false) state.tab = 'semantic';
  renderErrors(result);
  refreshAll();
  const total = performance.now() - t0;
  statusEl.textContent = result.ok ? `parse ${result.timings.parse.toFixed(1)}ms · scene+compile ${result.timings.scene.toFixed(1)}ms · svg ${result.timings.render.toFixed(1)}ms · total ${total.toFixed(1)}ms` : 'errors';
  try { localStorage.setItem('aru-src', src); } catch {}
}
function rerenderFromScene() {
  const r = state.result; if (!r?.scene) return;
  const t0 = performance.now();
  r.svg = renderScene(r.scene);
  host.innerHTML = r.svg;
  r.timings.render = performance.now() - t0;
  refreshAll();
}
function refreshAll() { renderTree(); renderMetrics(); renderCompiled(); applyMode(); applySelection(); }

function renderErrors(r) {
  const parts = [];
  for (const e of r.errors) parts.push(`<div class="err" data-line="${e.line || ''}">✖ ${e.stage === 'parse' ? 'syntax' : 'scene'}${e.line ? ` line ${e.line}${e.col ? ':' + e.col : ''}` : ''}: ${esc(e.message)}</div>`);
  for (const w of r.warnings) parts.push(`<div class="warn" data-line="${w.line || ''}">⚠ ${w.line ? `line ${w.line}: ` : ''}${esc(w.message)}</div>`);
  if (!parts.length) parts.push('<div class="ok">✓ no errors</div>');
  errorsEl.innerHTML = parts.join('');
}
errorsEl.addEventListener('click', (e) => { const line = Number(e.target.closest('[data-line]')?.dataset.line); if (line) gotoLine(line); });
function gotoLine(line) {
  setView('source');
  const lines = editor.value.split('\n');
  let pos = 0; for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  editor.focus(); editor.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
  editor.scrollTop = Math.max(0, (line - 5) * 18);
}

// ---------- debug modes ----------
function applyMode() {
  const svg = host.querySelector('svg'); if (!svg) return;
  svg.querySelectorAll('.aru-debug').forEach((n) => n.remove());
  host.classList.toggle('wire', state.mode === 'geometry');
  host.classList.toggle('dim', ['blueprint', 'regions', 'landmarks'].includes(state.mode));
  const markup = debugOverlay(state.result.scene, state.mode, { selectedLandmark: state.sel?.kind === 'landmark' ? state.sel.name : null });
  if (markup) svg.insertAdjacentHTML('beforeend', markup);
}
$('#modes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]'); if (!b) return;
  state.mode = b.dataset.mode;
  $('#modes').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  applyMode(); applySelection();
});
function setView(v) {
  state.view = v;
  $('#views').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.view === v));
  $('#editorPane').classList.toggle('show-compiled', v === 'compiled');
  renderCompiled();
}
$('#views').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
function renderCompiled() {
  if (state.view !== 'compiled' || !state.result?.scene) return;
  compiledEl.value = '// ARU Geometry compiled from the source (read-only). The renderer only understands this level.\n' + toAru(state.result.scene, { precision: 2 });
}

// ---------- trees ----------
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  state.tab = b.dataset.tab; state.tabAuto = false; renderTree(); applySelection();
});
function renderTree() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  const r = state.result; if (!r?.scene) { treeEl.innerHTML = ''; return; }
  treeEl.innerHTML = state.tab === 'semantic' ? semanticTree(r.scene) : geometryTree(r.scene);
}
function semanticTree(scene) {
  if (!scene.blueprints.size) return '<span class="hint">No blueprint in this document (pure ARU Geometry).</span>';
  let html = '';
  for (const [name, rt] of scene.blueprints) {
    const bp = rt.bp;
    const row = (sel, inner) => `<div class="row" data-sel='${esc(JSON.stringify(sel))}'>${inner}</div>`;
    const node = (t) => {
      if (t.kind === 'group') return `<li>${row({ kind: 'node', path: rt.root.path + '.' + t.name }, `<span class="toggle">▸</span><span class="kind">group</span> <b>${esc(t.name)}</b>`)}<ul>${t.children.map(node).join('')}</ul></li>`;
      const el = bp.byName.get(t.element), n = rt.nodes.get(t.element);
      let count = 0; if (n) walkScene(n, (x) => { if (x !== n && x.type !== 'group') count++; });
      return `<li>${row({ kind: 'element', bp: name, name: t.element }, `<span class="kind">${el.kind}</span> <b>${esc(t.element)}</b>${el.mirrorOf ? ` <span class="mir">⇐ mirror ${esc(el.mirrorOf)}${el.exact ? ' (exact)' : ''}</span>` : ''} <span class="gen">${count} shapes</span>`)}</li>`;
    };
    const lms = bp.allLandmarks().map((l) => `<li>${row({ kind: 'landmark', bp: name, name: l.name }, `<span class="lm">◆</span> ${esc(l.name)} <span class="gen">${l.def.kind === 'mirror' ? '⇐ ' + esc(l.def.of) : l.def.kind === 'expr' ? 'derived' : ''}</span>`)}</li>`).join('');
    const pal = [...bp.paletteDefs.keys()].map((k) => `<li><div class="row"><span class="swatch" style="background:${bp.color(k)}"></span> ${esc(k)} <span class="gen">${bp.color(k)}</span></div></li>`).join('');
    html += `<ul><li>${row({ kind: 'blueprint', bp: name }, `<span class="kind">blueprint</span> <b>${esc(name)}</b> <span class="gen">symmetry ${bp.symmetry.mode} · light ${esc(bp.light)}</span>`)}
      <ul>${bp.tree.children.map(node).join('')}
        <li><div class="row"><span class="toggle">▸</span><span class="kind">landmarks</span> <span class="gen">${bp.landmarkDefs.size}</span></div><ul>${lms}</ul></li>
        <li><div class="row"><span class="toggle">▸</span><span class="kind">palette</span></div><ul>${pal}</ul></li>
      </ul></li></ul>`;
  }
  return html;
}
function geometryTree(scene) {
  const showGen = $('#chkGenerated').checked;
  const build = (node) => {
    const kids = node.children.filter((c) => showGen || !c.generated || c.type === 'group');
    let html = '<ul>';
    for (const c of kids) {
      const sw = c.type !== 'group' && c.type !== 'fur' ? `<span class="swatch" style="background:${swatchColor(c, scene)}"></span>` : '<span class="toggle">▸</span>';
      const tag = c.semanticKind ? `<span class="kind">${c.semanticKind}</span>` : (c.semantic ? `<span class="sem">${esc(c.semantic)}</span>` : '');
      html += `<li><div class="row" data-sel='${esc(JSON.stringify({ kind: 'node', path: c.path }))}'>${sw}<span class="type">${c.type}</span> <b>${esc(c.name)}</b> ${tag}${c.cloneOf ? `<span class="gen">← ${esc(c.cloneOf)}</span>` : ''}</div>`;
      if (c.children.length) html += build(c);
      html += '</li>';
    }
    return html + '</ul>';
  };
  return build(scene.root);
}
function swatchColor(n, scene) {
  const f = n.fill && n.fill !== 'none' ? n.fill : (n.stroke && n.stroke !== 'none' ? n.stroke : '#000');
  if (scene.gradients[f]) return `linear-gradient(90deg, ${scene.gradients[f].stops.map((s) => s.color).join(',')})`;
  return f;
}
treeEl.addEventListener('click', (e) => { const row = e.target.closest('.row[data-sel]'); if (row) select(JSON.parse(row.dataset.sel)); });
$('#chkGenerated').addEventListener('change', renderTree);

// ---------- selection & highlighting ----------
function select(sel) { state.sel = sel; applyMode(); applySelection(); }
function applySelection() {
  const r = state.result; if (!r?.scene) return;
  const svg = host.querySelector('svg');
  svg?.querySelectorAll('.aru-overlay').forEach((el) => el.remove());
  let style = document.getElementById('hlStyle');
  if (!style) { style = document.createElement('style'); style.id = 'hlStyle'; document.head.append(style); }
  style.textContent = '';
  treeEl.querySelectorAll('.row.selected').forEach((el) => el.classList.remove('selected'));
  const sel = state.sel;
  if (!sel) { inspectorEl.innerHTML = '<span class="hint">Select an object, a semantic element or a landmark.</span>'; return; }
  const key = JSON.stringify(sel);
  const row = [...treeEl.querySelectorAll('.row[data-sel]')].find((x) => x.dataset.sel === key);
  if (row) { row.classList.add('selected'); row.scrollIntoView({ block: 'nearest' }); }
  if (sel.kind === 'node') {
    const node = r.scene.byPath.get(sel.path);
    if (!node) return;
    highlight(node.type === 'group' ? semanticDescendantIds(node) : [node.id]);
    return renderNodeInspector(node);
  }
  const rt = r.scene.blueprints.get(sel.bp); if (!rt) return;
  if (sel.kind === 'blueprint') { highlight(semanticDescendantIds(rt.root)); return renderBlueprintInspector(rt); }
  if (sel.kind === 'element') {
    const n = rt.nodes.get(sel.name); if (!n) return;
    highlight(semanticDescendantIds(n));
    return renderElementInspector(rt, sel.name);
  }
  if (sel.kind === 'landmark') {
    const affected = rt.bp.affected(rt.bp.landmarkKeys(sel.name), rt.deps);
    highlight(affected.flatMap((el) => semanticDescendantIds(rt.nodes.get(el.name))));
    return renderLandmarkInspector(rt, sel.name, affected);
  }
}
function highlight(ids) {
  if (!ids.length) return;
  const sel = ids.map((id) => `#canvasHost svg [data-id="${id}"]`).join(',');
  document.getElementById('hlStyle').textContent = `${sel} { stroke:#ff2d95 !important; stroke-width:1.4px !important; vector-effect:non-scaling-stroke; stroke-opacity:1 !important; }`;
}
host.addEventListener('click', (e) => {
  const el = e.target.closest('[data-aru]'); if (!el) return;
  let node = state.result.scene.byId.get(Number(el.dataset.id));
  // climb to the semantic element that generated this geometry
  if (state.tab === 'semantic') {
    let p = node, path = node.path;
    while (p && !p.semanticElement) { path = path.split('.').slice(0, -1).join('.'); p = state.result.scene.byPath.get(path); }
    if (p?.semanticElement) { for (const [bpName, rt] of state.result.scene.blueprints) if (rt.nodes.get(p.semanticElement) === p) return select({ kind: 'element', bp: bpName, name: p.semanticElement }); }
  }
  if (node) select({ kind: 'node', path: node.path });
});

// ---------- inspectors ----------
const dl = (rows) => `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
const r3 = (x) => Math.round(x * 1000) / 1000;
function renderNodeInspector(n) {
  const rows = [['path', esc(n.path)], ['type', n.type], ['origin', n.origin || '–'], ['semantic', esc(n.semantic || '–')], ['at', n.at.map(r3).join(' ')], ['rotate', r3(n.rotate)], ['scale', n.scale.map(r3).join(' ')], ['fill', esc(n.fill ?? 'inherit')], ['opacity', n.opacity], ['children', n.children.length]];
  if (n.geom?.commands) rows.push(['commands', n.geom.commands.length]);
  if (n.geom?.points) rows.push(['points', n.geom.points.length]);
  inspectorEl.innerHTML = dl(rows) + (n.source?.line ? `<button id="btnGoto">go to line ${n.source.line}</button>` : '');
  inspectorEl.querySelector('#btnGoto')?.addEventListener('click', () => gotoLine(n.source.line));
}
function renderBlueprintInspector(rt) {
  const bp = rt.bp;
  inspectorEl.innerHTML = dl([['blueprint', esc(bp.name)], ['frame', `${bp.frame.x} ${bp.frame.y} ${bp.frame.w}×${bp.frame.h}`], ['symmetry', `${bp.symmetry.mode} (axis ${bp.symmetry.axis})`], ['light', esc(bp.light)], ['seed', bp.seed], ['landmarks', bp.landmarkDefs.size], ['elements', bp.elements.length]]) +
    `<div class="hint" style="margin-top:6px">light:</div>` + ['top-left', 'top-right', 'left', 'right'].map((d) => `<button class="depbtn" data-op='${JSON.stringify({ operation: 'set', target: bp.name + '.light', value: d })}'>${d}</button>`).join('');
  wireOpButtons();
}
function renderElementInspector(rt, name) {
  const bp = rt.bp, el = bp.byName.get(name), deps = [...(rt.deps.get(name) || [])];
  const dependents = bp.affected(new Set(['el:' + name]), rt.deps).map((e) => e.name);
  let shapes = 0; walkScene(rt.nodes.get(name), (x) => { if (x.type !== 'group') shapes++; });
  const chip = (k) => { const [t, n] = k.split(':'); return t === 'lm' ? `<a href="#" data-lm="${esc(n)}">◆${esc(n)}</a>` : esc(k); };
  inspectorEl.innerHTML = dl([['element', esc(name)], ['kind', el.kind], ['mirror', el.mirrorOf ? `${esc(el.mirrorOf)} (${el.exact ? 'exact' : 'soft'})` : '–'], ['generated', `${shapes} shapes`], ['expansions', rt.expansions.get(name)], ['depends on', deps.map(chip).join(' ') || '–'], ['dependents', dependents.join(', ') || '–'], ['source line', el.ast.line]]) +
    `<button id="btnGoto">go to line ${el.ast.line}</button>`;
  inspectorEl.querySelector('#btnGoto').addEventListener('click', () => gotoLine(el.ast.line));
  inspectorEl.querySelectorAll('[data-lm]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); select({ kind: 'landmark', bp: bp.name, name: a.dataset.lm }); }));
}
function renderLandmarkInspector(rt, name, affected) {
  const bp = rt.bp, def = bp.landmarkDefs.get(name), p = bp.landmark(name);
  const op = (dx, dy, label) => `<button class="depbtn" data-op='${JSON.stringify({ operation: 'move', target: `${bp.name}.${name}`, value: [dx, dy] })}'>${label}</button>`;
  inspectorEl.innerHTML = dl([['landmark', esc(name)], ['position', `${r3(p[0])} ${r3(p[1])} (normalized)`], ['definition', def.kind === 'mirror' ? `mirror of ${esc(def.of)}` : def.kind === 'expr' ? 'derived expression' : 'explicit'], ['affects', `${affected.length}/${bp.elements.length} elements`], ['', esc(affected.map((e) => e.name).join(', ') || '–')]]) +
    `<div class="hint" style="margin-top:6px">move (recompiles only dependents):</div>${op(-0.01, 0, '← x')}${op(0.01, 0, 'x →')}${op(0, -0.01, '↑ y')}${op(0, 0.01, 'y ↓')}`;
  wireOpButtons();
}
function wireOpButtons() { inspectorEl.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', () => runOp(JSON.parse(b.dataset.op)))); }

// ---------- operations ----------
function runOp(op) {
  const r = state.result; if (!r?.scene) return;
  const t0 = performance.now();
  const res = applyOperation(r.scene, op);
  const out = $('#opsResult');
  if (res.ok) rerenderFromScene();
  out.textContent = res.message + (res.ok ? ` · total incl. render ${(performance.now() - t0).toFixed(1)} ms` : '');
  out.className = res.ok ? 'ok' : 'err';
}
$('#btnApplyOp').addEventListener('click', () => {
  let op; try { op = JSON.parse($('#opsInput').value); } catch (e) { const out = $('#opsResult'); out.textContent = 'Invalid JSON: ' + e.message; out.className = 'err'; return; }
  for (const o of Array.isArray(op) ? op : [op]) runOp(o);
});

// ---------- metrics ----------
function renderMetrics() {
  const r = state.result; if (!r?.scene) { metricsEl.innerHTML = ''; return; }
  const sm = sceneMetrics(r.scene), tm = textMetrics(editor.value);
  const sem = semanticMetrics(r.scene, editor.value);
  let html = '';
  for (const m of sem) {
    const rows = [
      ['<b>EXPANSION (tokens)</b>', `<b>${m.expansionTokens.toFixed(1)}×</b> geometry/source`], ['expansion (primitives)', `${m.expansionObjects.toFixed(2)} per instruction`],
      ['semantic instructions', m.instructions], ['landmarks', `${m.landmarks} (${m.landmarksAuthored} authored)`], ['regions', m.regions],
      ['elements', `${m.elements} (${m.mirrored} mirrored)`], ['procedural expansions', m.expansions], ['generated objects', m.generated.objects],
      ['generated paths / polygons', `${m.generated.paths} / ${m.generated.polygons}`], ['generated Bézier curves', m.generated.beziers], ['generated points', m.generated.points],
      ['source tokens (blueprint)', m.sourceTokens], ['generated geometry tokens', m.geometryTokens], ['compile (resolve+procedural)', `${m.compileMs.toFixed(2)} ms`], ['render → svg', `${r.timings.render.toFixed(2)} ms`],
    ];
    html += `<table><tr><th colspan="2">blueprint ${esc(m.name)}</th></tr>${rows.map(([k, v]) => `<tr><th>${k}</th><td class="num">${v}</td></tr>`).join('')}</table><br>`;
  }
  const rows = [['objects (total)', sm.objects], ['paths', sm.paths], ['points', sm.points], ['bézier curves', sm.beziers], ['.aru lines / tokens', `${tm.lines} / ${tm.tokens}`], ['parse', `${r.timings.parse.toFixed(2)} ms`], ['scene (incl. compile)', `${r.timings.scene.toFixed(2)} ms`]];
  html += `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td class="num">${v}</td></tr>`).join('')}</table>`;
  metricsEl.innerHTML = html;
  $('#metricsHint').textContent = '';
}

// ---------- export & compare ----------
function exportSvg() { const r = state.result; return r?.scene ? renderScene(r.scene, { pretty: true, dataAttrs: false }) : ''; }
$('#btnExport').addEventListener('click', () => {
  const svg = exportSvg(); if (!svg) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); a.download = 'illustration.svg'; a.click();
});
$('#btnCompare').addEventListener('click', () => {
  const svg = exportSvg(); if (!svg) return;
  const svgOpt = renderScene(state.result.scene, { pretty: true, dataAttrs: false, dedupe: true });
  const a = textMetrics(editor.value), ar = aruReadability(editor.value), s = svgMetrics(svg), o = svgMetrics(svgOpt), sm = sceneMetrics(state.result.scene);
  const ratio = (x, y) => (typeof x === 'number' && typeof y === 'number' && x ? (y / x).toFixed(1) + '×' : '');
  const rows = [['bytes', a.bytes, s.bytes, o.bytes], ['lines', a.lines, s.lines, o.lines], ['tokens ≈', a.tokens, s.tokens, o.tokens], ['elements', sm.objects, s.nodes, o.nodes], ['numeric literals', ar.numbers, s.numbers, o.numbers]];
  metricsEl.innerHTML = `<table><tr><th></th><th>ARU</th><th>SVG flat</th><th></th><th>SVG &lt;use&gt;</th><th></th></tr>${rows.map(([k, x, y, z]) => `<tr><th>${k}</th><td class="num">${x}</td><td class="num">${y}</td><td class="num">${ratio(x, y)}</td><td class="num">${z}</td><td class="num">${ratio(x, z)}</td></tr>`).join('')}</table><div class="hint">Neither SVG is minified. Operations edit the scene, not the ARU text.</div>`;
});

// ---------- app switch: Editor | Tracer ----------
const tracer = initTracer({ onOpenInEditor: (aru) => { editor.value = aru; switchApp('editor'); state.sel = null; update(); } });
function switchApp(app) {
  document.body.classList.toggle('tracer', app === 'tracer');
  $('#apps').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.app === app));
  if (app === 'tracer') tracer.activate(); else { tracer.deactivate(); refreshAll(); }
}
$('#apps').addEventListener('click', (e) => { const b = e.target.closest('[data-app]'); if (b) switchApp(b.dataset.app); });

// ---------- examples / boot ----------
const sel = $('#examples');
for (const ex of EXAMPLES) { const o = document.createElement('option'); o.value = ex; o.textContent = ex; sel.append(o); }
sel.addEventListener('change', async () => { editor.value = await (await fetch(`examples/${sel.value}`)).text(); state.sel = null; state.tabAuto = true; update(); });
let timer = null;
editor.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 150); });
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { e.preventDefault(); const s = editor.selectionStart; editor.setRangeText('    ', s, editor.selectionEnd, 'end'); editor.dispatchEvent(new Event('input')); }
});
(async () => {
  let src = null; try { src = localStorage.getItem('aru-src'); } catch {}
  const params = new URLSearchParams(location.search);
  const ex = params.get('example') || (src ? null : EXAMPLES[0]);
  if (ex) { try { src = await (await fetch(`examples/${ex}`)).text(); sel.value = ex; } catch {} }
  if (params.get('mode')) { state.mode = params.get('mode'); $('#modes').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.mode === state.mode)); }
  editor.value = src || 'canvas 400 300\nbackground #eee\ncircle { at 200 150; radius 80; fill #f6c453 }\n';
  update();
  if (params.get('app') === 'tracer') switchApp('tracer');
})();

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
