import { RESOURCE_KINDS, listResources, normalizeResource, resourcePrompt } from './resources.js';
// ARU Studio: layers, named groups, animations and batch editing on top of the ARU engine.
// The ARU text is the single source of truth: every visual edit runs an operation from edit.js on the scene,
// serializes it back with toAru() and recompiles. Undo/redo are text snapshots; the code drawer and the canvas
// can never disagree. Selection is kept by node path, so it survives recompiles.
import { listIconBatches, prepareIconExports, buildIconArchive } from './export-icons.js';
import { refinementScope } from './refinement.js';
import { compile } from './engine.js';
import { layerWindow, LAYER_ROW_HEIGHT } from './layer-window.js';
import { toAru } from './serialize.js';
import { renderScene } from './render.js';
import { selectNodes } from './ops.js';
import * as E from './edit.js';
import { PRESETS, PRESET_NAMES, EASES, LOOPING } from './anim.js';
import { applyBatch, previewBatch, BATCH_EXAMPLE } from './batch.js';
import { pathSummary } from './path-edit.js';
import { withOpaqueBackground, opaquePng } from './opaque.js';
import { initChat } from './chat.js';
import { projectContext, workspacePrompt } from './workspace-context.js';
import { openLibrary, DOC_PRESETS } from './library.js';
import { isDesktop, contextFromParts } from './agents.js';
import { compile as compileAru } from './engine.js';
import { rgbToLab } from '../trace/quantize.js';
import { preparePack, applyPack, setPackRecognition } from './pack-tools.js';
import { traceReferenceState, retuneReference, referenceKeep, prepareGlyph, retuneGlyph, referenceFragment, groupReference, glyphReviewSvg } from './reference-tools.js';

import { freeTranslation } from '../plugin/layout.js';
import { embedChannel } from './embed-channel.js';
import { createIllustrator, sceneContext, readDocument, EMPTY_DOCUMENT, insertInto } from '../plugin/core.js';
const embedded = embedChannel();
let embedRevision = 0, embedEpoch = 0, documentRevision = 0;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');
const r2 = (v) => Math.round(v * 100) / 100;
const store = { get(k) { if (embedded) return null; try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { if (embedded) return; try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };

const ICON = {
  group: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9h16M4 15h16M9 4v16M15 4v16"/></svg>',
  rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="5" width="16" height="14" rx="2"/></svg>',
  circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg>',
  ellipse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="9" ry="6"/></svg>',
  path: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 18c4-12 8 4 16-10"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/><circle cx="20" cy="8" r="1.5" fill="currentColor"/></svg>',
  polygon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 21 19H3z"/></svg>',
  line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 19 19 5"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 6V4h14v2M12 4v16M9 20h6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m9 6 6 6-6 6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9M6.2 6.2A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.2-.9"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.3L20 10l-5.8 1.8L12 18l-2.2-6.2L4 10l5.8-1.7z"/></svg>',
  hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 9h16M4 15h16M9 4v16M15 4v16"/></svg>',
  alignL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 3v18"/><rect x="8" y="6" width="10" height="4" rx="1"/><rect x="8" y="14" width="6" height="4" rx="1"/></svg>',
  alignC: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18"/><rect x="6" y="6" width="12" height="4" rx="1"/><rect x="8" y="14" width="8" height="4" rx="1"/></svg>',
  alignR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 3v18"/><rect x="6" y="6" width="10" height="4" rx="1"/><rect x="10" y="14" width="6" height="4" rx="1"/></svg>',
  alignT: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 4h18"/><rect x="6" y="8" width="4" height="10" rx="1"/><rect x="14" y="8" width="4" height="6" rx="1"/></svg>',
  alignM: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18"/><rect x="6" y="6" width="4" height="12" rx="1"/><rect x="14" y="8" width="4" height="8" rx="1"/></svg>',
  alignB: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 20h18"/><rect x="6" y="6" width="4" height="10" rx="1"/><rect x="14" y="10" width="4" height="6" rx="1"/></svg>',
  distH: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4v16M20 4v16"/><rect x="9" y="8" width="6" height="8" rx="1"/></svg>',
  distV: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h16M4 20h16"/><rect x="8" y="9" width="8" height="6" rx="1"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 14 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 10 6 6 6-6"/></svg>',
  top: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 4h14M6 15l6-6 6 6"/></svg>',
  bottom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 20h14M6 9l6 6 6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
};

// ------------------------------------------------------------------------------------------------- state
const S = {
  name: 'Sin título', text: '', scene: null, svg: '', errors: [], warnings: [],
  sel: [], anchor: null, past: [], future: [],
  tool: 'select', zoom: 1, pan: [0, 0], open: new Set(), filter: '', live: false,
  rtab: 'props', panels:store.get('aru-panels') || {leftCollapsed:matchMedia('(max-width:760px)').matches,rightCollapsed:matchMedia('(max-width:960px)').matches}, embeddedProject:null, userView: false, docPath: null, lib: null, doc: null, projects: [], anim: { duration: 0.6, delay: 0, stagger: 0.08, repeat: 'once', ease: 'ease-out' },
};
const node = (path) => S.scene?.byPath.get(path) || null;
const selNodes = () => S.sel.map(node).filter(Boolean);
const selIds = () => selNodes().map((n) => n.id);
function pathsAfterSerialization(scene) {
  // One traversal per edit, including newly created nodes; never one traversal per selected layer.
  const paths = new Map();
  (function walk(parent, prefix) { for (const n of parent.children) { const path = prefix ? `${prefix}.${slug(n.name)}` : slug(n.name); paths.set(n, path); walk(n, path); } })(scene.root, '');
  return paths;
}
function ancestors(n) { const out = []; let p = E.parentOf(S.scene, n); while (p && p !== S.scene.root) { out.unshift(p); p = E.parentOf(S.scene, p); } return out; }
const isLocked = (n) => n.locked || ancestors(n).some((a) => a.locked);

// ------------------------------------------------------------------------------------------------- document
function load(text, { name, record = false, keepSel = false, fit = false, docPath = undefined, prepared } = {}) {
  const r = prepared || compile(text, { dataAttrs: true });
  if (!r.scene) { toast(r.errors[0]?.message || 'No se pudo compilar', true); return false; }
  if (record && S.text && S.text !== text) { S.past.push(S.text); if (S.past.length > 200) S.past.shift(); S.future = []; }
  if (S.text !== text || name && S.name !== name) documentRevision++;
  S.text = text; S.scene = r.scene; S.svg = r.svg; S.errors = r.errors; S.warnings = r.warnings;
  if (name) { S.name = name; if (embedded) $('#docName').value = name; }
  if (docPath !== undefined) S.docPath = docPath;
  if (!keepSel) S.sel = []; else S.sel = S.sel.filter((p) => S.scene.byPath.has(p));
  // open the first two levels by default for new documents
  if (!keepSel) { S.open = new Set(); for (const c of S.scene.root.children) if (c.type === 'group') { S.open.add(c.path); } }
  renderAll();
  if (fit) { S.userView = false; fitView(); }
  save();
  return true;
}
// run edit operations on the scene, serialize, recompile; `fn` may return nodes (objects) to select afterwards
function commit(fn, msg) {
  try {
    const out = fn(S.scene), paths = pathsAfterSerialization(S.scene);
    let nextSel = null;
    if (out && (Array.isArray(out) ? out.length && typeof out[0] === 'object' : typeof out === 'object')) nextSel = (Array.isArray(out) ? out : [out]).map((n) => paths.get(n)).filter(Boolean);
    const keep = S.sel.map((p) => { const n = node(p); return n ? paths.get(n) : null; }).filter(Boolean);
    const text = toAru(S.scene, { precision: 3 });
    S.sel = nextSel || keep;
    for (const p of S.sel) for (const a of ancestorsOfPath(p)) S.open.add(a);
    load(text, { record: true, keepSel: true });
    if (msg) toast(msg);
  } catch (e) { toast(e.message, true); load(S.text, { keepSel: true }); }
}
const ancestorsOfPath = (p) => { const parts = p.split('.'), out = []; for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('.')); return out; };
function undo() { if (!S.past.length) return; S.future.push(S.text); load(S.past.pop(), { keepSel: true }); }
function redo() { if (!S.future.length) return; S.past.push(S.text); load(S.future.pop(), { keepSel: true }); }
let saveTimer = null, saving = null;
function save() {
  if (embedded) { embedRevision++; embedded.change({ text: S.text, name: S.name, revision: embedRevision }); $('#saveText').textContent = 'Guardado por la aplicación'; return; }
  if (!S.lib || !S.doc) return;
  $('#saveDot').classList.add('dirty'); $('#saveText').textContent = 'Guardando…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
async function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!S.lib || !S.doc) return;
  const { id } = S.doc, text = S.text;
  try {
    saving = S.lib.write(id, text); await saving;
    thumbs.delete(id);
    $('#saveDot').classList.remove('dirty');
    $('#saveText').textContent = S.lib.kind === 'files' ? `Guardado en ${S.doc.project}` : 'Guardado en este navegador';
  } catch (e) { $('#saveText').textContent = `No se pudo guardar: ${e.message}`; toast(`No se pudo guardar: ${e.message}`, true); }
  saving = null;
}

// ------------------------------------------------------------------------------------------------- projects & documents
const thumbs = new Map(); // doc id -> svg data url
function activeProject() {return embedded ? S.embeddedProject : projectContext(S.projects.find(p=>p.id===S.doc?.project));}
function activeWorkspace() {return workspacePrompt(activeProject(),{id:S.doc?.id || null,name:S.name});}
function renderPanels() {
  const app=$('#app');
  for(const side of ['left','right']) {const collapsed=!!S.panels[side+'Collapsed'],b=$('#toggle'+(side==='left'?'Left':'Right')),label=`${collapsed?'Expandir':'Colapsar'} panel ${side==='left'?'izquierdo':'derecho'}`;
    app.classList.toggle(side+'-collapsed',collapsed); b.setAttribute('aria-expanded',String(!collapsed));b.setAttribute('aria-label',label);b.title=label;
    $('#'+side).inert=collapsed;
  }
  app.classList.toggle('props-open',!S.panels.rightCollapsed);
}
function openPanel(side) {S.panels[side+'Collapsed']=false;renderPanels();store.set('aru-panels',S.panels);}
function renderWorkspace() {
  const project=activeProject(),label=project?.name || (embedded?'Documento del anfitrión':'Sin proyecto');
  $('#workspaceProject').textContent=label;$('#workspaceProject').title=project?.description || label;
  $('#workspaceProject').disabled=!!embedded;
  $('#workspaceDocument').textContent=S.name;$('#workspaceDocument').title=S.name;
  $('#workspaceBar').title=`Proyecto: ${label} · Documento: ${S.name}`;
}
async function selectProject(id) {
  const project=S.projects.find(p=>p.id===id);if(!project) return;
  if(S.doc?.project===id) return;
  if(project.docs.length) await openDoc(project.docs[0].id);
  else newDocDialog({project:id});
}
function setDocChrome() {
  $('#docName').value = S.name;
  $('#crumbProject').textContent = S.projects.find((p) => p.id === S.doc?.project)?.name || 'Proyectos';
  renderWorkspace();
  try { localStorage.setItem('aru-last-doc', S.doc?.id || ''); } catch { /* ignore */ }
}
async function refreshLibrary() { S.projects = (await S.lib.list()).projects; renderWorkspace(); renderDocs(); }
async function openDoc(id, { fit = true } = {}) {
  if (S.doc && saveTimer) await flushSave();
  if (saving) await saving;
  const text = await S.lib.read(id);
  const project = await S.lib.projectOf(id), name = await S.lib.nameOf(id);
  S.doc = { id, project };
  S.past = []; S.future = []; S.sel = [];
  load(text, { name, fit, docPath: null });
  $('#saveDot').classList.remove('dirty'); clearTimeout(saveTimer); saveTimer = null; // opening is not an edit
  $('#saveText').textContent = S.lib.kind === 'files' ? `${project}/${name}.aru` : 'Guardado en este navegador';
  chatApi?.setDoc(id);
  if (!S.projects.length) S.projects = (await S.lib.list()).projects;
  setDocChrome(); renderDocs();
}
async function createDoc({ project, name, text }) {
  if (!project) project = S.doc?.project || S.projects[0]?.id || await S.lib.createProject('Mis documentos');
  const id = await S.lib.create(project, name, text);
  await refreshLibrary();
  await openDoc(id);
  return id;
}
const blankDoc = (w, h, bg) => `canvas ${w} ${h}\nbackground ${bg}\n`;
const relTime = (t) => { if (!t) return ''; const d = (Date.now() - t) / 1000; if (d < 60) return 'ahora'; if (d < 3600) return `hace ${Math.round(d / 60)} min`; if (d < 86400) return `hace ${Math.round(d / 3600)} h`; if (d < 172800) return 'ayer'; return new Date(t).toLocaleDateString('es', { day: 'numeric', month: 'short' }); };
async function thumbOf(doc) {
  if (thumbs.has(doc.id)) return thumbs.get(doc.id);
  try {
    const text = doc.id === S.doc?.id ? S.text : await S.lib.read(doc.id);
    const r = compileAru(text); if (!r.scene) throw 0;
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderScene(r.scene, { dataAttrs: false, animate: false, pretty: false }));
    thumbs.set(doc.id, url); return url;
  } catch { thumbs.set(doc.id, ''); return ''; }
}
const ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
let examples = null;
async function renderDocs() {
  const host = $('#docs'); if (!host || !S.lib) return;
  if (!examples) { try { examples = await (await fetch('examples/index.json')).json(); } catch { examples = []; } }
  const label = { ejemplos: 'Ejemplos', logos: 'Logos', textures: 'Texturas' };
  host.innerHTML = `
    <div class="lib-head"><span class="faint" title="${esc(S.lib.rootLabel)}">${S.lib.kind === 'files' ? esc(S.lib.rootLabel.replace(/^\/Users\/[^/]+/, '~')) : 'Guardado en este navegador'}</span>
      <button class="btn sm" data-lib="newDoc">${ICON_PLUS}Documento</button><button class="btn sm icon" data-lib="newProject" title="Nuevo proyecto">${ICON_FOLDER}</button></div>
    ${S.projects.map((p) => `<div class="proj${S.doc?.project===p.id?' active-project':''}">
      <div class="proj-h">${ICON_FOLDER}<button class="nm project-select" data-select-project="${esc(p.id)}" aria-current="${S.doc?.project===p.id?'true':'false'}">${esc(p.name)}</button><span class="faint">${S.doc?.project===p.id?'Activo · ':''}${p.docs.length}</span>
        <button class="ib" data-lib="newDocIn" data-project="${esc(p.id)}" title="Nuevo documento en ${esc(p.name)}">${ICON_PLUS}</button><button class="ib" data-projmenu="${esc(p.id)}" title="Opciones">${ICON_MORE}</button></div>
      ${p.docs.length ? p.docs.map((d) => `<div class="doc${S.doc?.id === d.id ? ' on' : ''}" data-open="${esc(d.id)}"><span class="th"><img data-thumb="${esc(d.id)}" alt=""></span><span class="meta"><b>${esc(d.name)}</b><span>${relTime(d.updated)}</span></span><button class="ib" data-docmenu="${esc(d.id)}" title="Opciones">${ICON_MORE}</button></div>`).join('') : '<div class="lib-empty">Vacío</div>'}
    </div>`).join('')}
    <details class="tpls" open><summary>Plantillas · crean un documento nuevo</summary>
      <button class="tpl" data-trace-img>${ICON.spark}<span>Importar imagen y trazar…</span></button>
      <button class="tpl" data-trace-wolf>${ICON.spark}<span>Lobo de referencia · contexto + pulido</span></button>
      ${(examples || []).map((d) => `<button class="tpl" data-template="${esc(d.path)}" title="${esc(label[d.group] || d.group)}">${ICON.hash}<span>${esc(d.name)}</span></button>`).join('')}
    </details>`;
  for (const img of $$('img[data-thumb]', host)) { const d = S.projects.flatMap((p) => p.docs).find((x) => x.id === img.dataset.thumb); thumbOf(d).then((u) => { if (u) img.src = u; }); }
  fetch('references/wolf.context.json').then((r) => { if (!r.ok) throw 0; }).catch(() => $('[data-trace-wolf]', host)?.remove());
}
function bindDocs() {
  const host = $('#docs');
  host.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-select-project],[data-docmenu],[data-projmenu],[data-lib],[data-open],[data-template],[data-trace-img],[data-trace-wolf]'); if (!t) return;
    try {
      if(t.dataset.selectProject) return await selectProject(t.dataset.selectProject);
      if (t.dataset.docmenu) return docMenu(t, t.dataset.docmenu);
      if (t.dataset.projmenu) return projectMenu(t, t.dataset.projmenu);
      if (t.dataset.lib === 'newDoc') return newDocDialog();
      if (t.dataset.lib === 'newDocIn') return newDocDialog({ project: t.dataset.project });
      if (t.dataset.lib === 'newProject') return newProjectDialog();
      if (t.dataset.open) return t.dataset.open !== S.doc?.id && openDoc(t.dataset.open);
      if (t.dataset.template) { const text = await (await fetch(t.dataset.template)).text(); await createDoc({ name: t.querySelector('span').textContent.trim(), text }); toast('Documento creado desde la plantilla'); return; }
      if ('traceImg' in t.dataset) return $('#imgIn').click();
      if ('traceWolf' in t.dataset) return traceImage('references/wolf.png', { ctx: 'references/wolf.context.json', polish: 'references/wolf.polish.v2.json', name: 'Lobo trazado' });
    } catch (err) { toast(err.message || String(err), true); }
  });
}
// ---- popover menus ----
function popover(anchor, items) {
  const pop = $('#pop'), r = anchor.getBoundingClientRect();
  pop.innerHTML = items.map((it, i) => (it === '-' ? '<div class="sep"></div>' : it.cap ? `<div class="cap">${esc(it.cap)}</div>` : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}"${it.disabled ? ' disabled' : ''}>${esc(it.label)}</button>`)).join('');
  pop.classList.add('on');
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = `${Math.min(innerWidth - pw - 8, r.right - pw)}px`; pop.style.top = `${Math.min(innerHeight - ph - 8, r.bottom + 4)}px`;
  pop.onclick = (e) => { const b = e.target.closest('button[data-i]'); if (!b) return; pop.classList.remove('on'); Promise.resolve(items[Number(b.dataset.i)].run()).catch((err) => toast(err.message || String(err), true)); };
}
addEventListener('pointerdown', (e) => { if (!e.target.closest('#pop, [data-docmenu], [data-projmenu]')) $('#pop')?.classList.remove('on'); });
function docMenu(anchor, id) {
  const doc = S.projects.flatMap((p) => p.docs).find((d) => d.id === id);
  const others = S.projects.filter((p) => p.id !== doc.project);
  popover(anchor, [
    { label: 'Abrir', run: () => openDoc(id) },
    { label: 'Renombrar…', run: () => renameDocDialog(doc) },
    { label: 'Duplicar', run: async () => { const nid = await S.lib.duplicate(id); await refreshLibrary(); toast('Documento duplicado'); return nid; } },
    ...(others.length ? ['-', { cap: 'Mover a' }, ...others.map((p) => ({ label: p.name, run: async () => { if (S.doc?.id === id) await flushSave(); const nid = await S.lib.move(id, p.id); await moveChat(id, nid); if (S.doc?.id === id) {S.doc = { id: nid, project: p.id };chatApi?.setDoc(nid,{keep:true});} await refreshLibrary(); setDocChrome(); toast(`Movido a ${p.name}`); } }))] : []),
    '-',
    { label: 'Eliminar…', danger: true, run: () => deleteDocDialog(doc) },
  ]);
}
function projectMenu(anchor, id) {
  const p = S.projects.find((x) => x.id === id);
  popover(anchor, [
    { label: 'Nuevo documento aquí…', run: () => newDocDialog({ project: id }) },
    { label: 'Renombrar proyecto…', run: () => renameProjectDialog(p) },
    '-',
    { label: p.docs.length ? 'Eliminar (vacíalo primero)' : 'Eliminar proyecto', danger: true, disabled: !!p.docs.length, run: async () => { await S.lib.removeProject(id); await refreshLibrary(); toast('Proyecto eliminado'); } },
  ]);
}
async function moveChat(from, to) {if(from===to) return;await chatApi?.moveReferences(from,to); try { const v = localStorage.getItem(`aru-chat:${from}`); if (v != null) { localStorage.setItem(`aru-chat:${to}`, v); localStorage.removeItem(`aru-chat:${from}`); } const job=localStorage.getItem(`aru-production:${from}`);if(job!=null) {localStorage.setItem(`aru-production:${to}`,job);localStorage.removeItem(`aru-production:${from}`);} } catch { /* ignore */ } }
// ---- dialogs ----
function dialog({ title, body, ok = 'Aceptar', danger = false, onOk, init }) {
  const m = $('#modal');
  m.innerHTML = `<form class="dlg" novalidate><header>${esc(title)}</header><div class="body">${body}<div class="err" id="dlgErr"></div></div><footer><button type="button" class="btn" data-cancel>Cancelar</button><button type="submit" class="btn primary"${danger ? ' style="background:var(--err);border-color:var(--err)"' : ''}>${esc(ok)}</button></footer></form>`;
  m.classList.add('on');
  const f = $('form', m), close = () => { if (m.firstChild !== f) return; m.classList.remove('on'); m.innerHTML = ''; };
  $('[data-cancel]', m).onclick = close;
  m.onmousedown = (e) => { if (e.target === m) close(); };
  f.onkeydown = (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); };
  // close only if this form is still the open one (onOk may open the next dialog)
  f.onsubmit = async (e) => { e.preventDefault(); try { await onOk(f); if (m.firstChild === f) close(); } catch (err) { const el = $('#dlgErr', f); if (el) el.textContent = err.message || String(err); } };
  init?.(f);
  setTimeout(() => $('input:not([type=hidden]),select', f)?.focus(), 30);
}
function newDocDialog({ project = null, name = 'Sin título' } = {}) {
  const proj = project || S.doc?.project || S.projects[0]?.id || '';
  dialog({
    title: 'Nuevo documento', ok: 'Crear documento',
    body: `<label class="lbl">Nombre<span class="field"><input name="name" value="${esc(name)}" spellcheck="false"></span></label>
      <label class="lbl">Proyecto<span class="field"><select name="project">${S.projects.map((p) => `<option value="${esc(p.id)}"${p.id === proj ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">+ Nuevo proyecto…</option></select></span></label>
      <label class="lbl" data-newproj style="display:${S.projects.length ? 'none' : 'flex'}">Nombre del nuevo proyecto<span class="field"><input name="newProject" value="${S.projects.length ? '' : 'Mis documentos'}" placeholder="Mi proyecto"></span></label>
      <div class="lbl">Tamaño<div class="presets">${DOC_PRESETS.map(([n, w, h], i) => { const k = 26 / Math.max(w, h); return `<button type="button" data-preset="${i}" class="${i === 0 ? 'on' : ''}"><i style="width:${Math.round(w * k)}px;height:${Math.round(h * k)}px"></i>${esc(n)}<span class="faint">${w}×${h}</span></button>`; }).join('')}</div></div>
      <div class="grid3"><label class="field"><span class="k">Ancho</span><input name="w" value="${DOC_PRESETS[0][1]}"></label><label class="field"><span class="k">Alto</span><input name="h" value="${DOC_PRESETS[0][2]}"></label>
        <label class="color"><input type="color" name="bg" value="#f4f1ea"><span class="faint">Fondo</span></label></div>
      <label class="faint"><input type="checkbox" name="transparent"> Fondo transparente</label>`,
    init: (f) => {
      f.project.onchange = () => { $('[data-newproj]', f).style.display = f.project.value === '__new' || !S.projects.length ? 'flex' : 'none'; };
      if (!S.projects.length) f.project.value = '__new';
      for (const b of $$('[data-preset]', f)) b.onclick = () => { $$('[data-preset]', f).forEach((x) => x.classList.toggle('on', x === b)); const [, w, h] = DOC_PRESETS[Number(b.dataset.preset)]; f.w.value = w; f.h.value = h; };
    },
    onOk: async (f) => {
      const w = Math.round(Number(f.w.value)), h = Math.round(Number(f.h.value));
      if (!(w >= 16 && w <= 10000 && h >= 16 && h <= 10000)) throw new Error('El tamaño debe estar entre 16 y 10000');
      let project = f.project.value;
      if (project === '__new' || !project) project = await S.lib.createProject(f.newProject.value || 'Mi proyecto');
      await createDoc({ project, name: f.name.value, text: blankDoc(w, h, f.transparent.checked ? 'none' : f.bg.value.toUpperCase()) });
      toast('Documento creado');
    },
  });
}
function newProjectDialog() {
  dialog({ title: 'Nuevo proyecto', ok: 'Crear proyecto', body: '<label class="lbl">Nombre<span class="field"><input name="name" value="Nuevo proyecto"></span></label><p>Después podrás crear documentos dentro o mover los existentes.</p>',
    onOk: async (f) => { const id = await S.lib.createProject(f.name.value); await refreshLibrary(); toast('Proyecto creado'); newDocDialog({ project: id }); } });
}
function renameDocDialog(doc) {
  dialog({ title: 'Renombrar documento', ok: 'Renombrar', body: `<label class="lbl">Nombre<span class="field"><input name="name" value="${esc(doc.name)}"></span></label>`,
    onOk: async (f) => { await renameDoc(doc.id, f.name.value); } });
}
async function renameDoc(id, name) {
  if (S.doc?.id === id) await flushSave();
  const nid = await S.lib.rename(id, name);
  await moveChat(id, nid);
  if (S.doc?.id === id) { S.doc.id = nid; S.name = await S.lib.nameOf(nid); chatApi?.setDoc(nid, { keep: true }); }
  thumbs.delete(id);
  await refreshLibrary(); setDocChrome();
}
function renameProjectDialog(p) {
  dialog({ title: 'Renombrar proyecto', ok: 'Renombrar', body: `<label class="lbl">Nombre<span class="field"><input name="name" value="${esc(p.name)}"></span></label>`,
    onOk: async (f) => {
      if (S.doc?.project === p.id) await flushSave();
      const nid = await S.lib.renameProject(p.id, f.name.value);
      if (nid !== p.id && S.lib.kind === 'files') { for (const d of p.docs) await moveChat(d.id, d.id.replace(`${p.id}/`, `${nid}/`)); if (S.doc?.project === p.id) {S.doc = { id: S.doc.id.replace(`${p.id}/`, `${nid}/`), project: nid };chatApi?.setDoc(S.doc.id,{keep:true});} }
      await refreshLibrary(); setDocChrome();
    } });
}
function deleteDocDialog(doc) {
  dialog({ title: 'Eliminar documento', ok: 'Eliminar', danger: true,
    body: `<p>¿Eliminar <b>${esc(doc.name)}</b>?${S.lib.kind === 'files' ? ' Se moverá a la carpeta <b>.papelera</b> de tu carpeta de trabajo, de donde puedes recuperarlo.' : ' Esta acción no se puede deshacer.'}</p>`,
    onOk: async () => {
      const wasOpen = S.doc?.id === doc.id;
      if (wasOpen) { clearTimeout(saveTimer); saveTimer = null; }
      await S.lib.remove(doc.id);
      await chatApi?.dropReferences(doc.id);
      try { localStorage.removeItem(`aru-chat:${doc.id}`);localStorage.removeItem(`aru-production:${doc.id}`); } catch { /* ignore */ }
      await refreshLibrary();
      if (wasOpen) { const next = S.projects.flatMap((p) => p.docs)[0]; if (next) await openDoc(next.id); else { S.doc = null; await ensureStartDoc(); } }
      toast('Documento eliminado');
    } });
}
async function ensureStartDoc() {
  // first run (or everything deleted): migrate the old single-document save, or start from a template
  S.projects = (await S.lib.list()).projects;
  if (S.projects.flatMap((p) => p.docs).length) return;
  const project = S.projects[0]?.id || await S.lib.createProject('Mis documentos');
  const old = store.get('aru-studio');
  if (old?.text) { await createDoc({ project, name: old.name || 'Documento', text: old.text }); try { localStorage.removeItem('aru-studio'); } catch { /* ignore */ } return; }
  const text = await (await fetch('examples/logos/sonus.aru')).text().catch(() => blankDoc(1200, 800, '#F4F1EA'));
  await createDoc({ project, name: 'Sonus · logo', text });
}

// ------------------------------------------------------------------------------------------------- render
function renderAll() { renderCanvas(); renderLayers(); renderProps(); renderCode(); renderStatus(); renderWorkspace(); chatApi?.refresh(); }
let canvasElements = new Map(), canvasBounds = new Map();
function renderCanvas() {
  const art = $('#art');
  art.innerHTML = S.svg;
  canvasElements = new Map($$('[data-id]', art).map(el => [Number(el.dataset.id), el]));
  canvasBounds = new Map();
  art.classList.toggle('paused', !S.live);
  $('#frameName').textContent = S.name;
  $('#frameSize').textContent = `${Math.round(S.scene.width)} × ${Math.round(S.scene.height)}`;
  applyView();
}
function applyView() {
  // Render filters at visible resolution instead of magnifying their raster surface.
  $('#board').style.transform = `translate3d(${S.pan[0]}px, ${S.pan[1]}px, 0)`;
  const svg = $('#art svg');
  if (svg) {
    // Reassigning even an identical SVG viewport invalidates every material filter during pan.
    const width = String(S.scene.width * S.zoom), height = String(S.scene.height * S.zoom);
    if (svg.getAttribute('width') !== width) svg.setAttribute('width', width);
    if (svg.getAttribute('height') !== height) svg.setAttribute('height', height);
  }
  $('#frameTitle').style.transform = `translate(${S.pan[0]}px, ${S.pan[1] - 24}px)`;
  $('#zoomVal').textContent = `${Math.round(S.zoom * 100)}%`;
  drawOverlay();
}
function fitView() {
  const st = $('#stage').getBoundingClientRect(), w = S.scene.width, h = S.scene.height;
  S.zoom = Math.max(0.05, Math.min(4, (st.width - 140) / w, (st.height - 190) / h));
  S.pan = [(st.width - w * S.zoom) / 2, (st.height - h * S.zoom) / 2 - 20];
  applyView();
}
function zoomAt(f, cx, cy) {
  S.userView = true;
  const z = Math.max(0.05, Math.min(16, S.zoom * f));
  S.pan = [cx - (cx - S.pan[0]) * (z / S.zoom), cy - (cy - S.pan[1]) * (z / S.zoom)];
  S.zoom = z; applyView();
}
const elOf = n => canvasElements.get(n.id) || null;
// Cache document-space bounds, independent of pan/zoom. A document render invalidates them;
// during a drag only the affected subtree and its ancestors need live DOM measurement.
function worldBounds(n) {
  const moving = drag?.moved && drag.affected.has(n.id);
  if (!moving && canvasBounds.has(n.id)) return canvasBounds.get(n.id);
  const el = elOf(n); if (!el) return null;
  const r = el.getBoundingClientRect(), b = $('#art').getBoundingClientRect();
  if (!r.width && !r.height) return null;
  const bounds = [(r.left-b.left)/S.zoom,(r.top-b.top)/S.zoom,(r.right-b.left)/S.zoom,(r.bottom-b.top)/S.zoom];
  if (!moving && !S.live) canvasBounds.set(n.id, bounds);
  return bounds;
}
function stageRect(n) {
  const b = worldBounds(n); if (!b) return null;
  return [S.pan[0]+b[0]*S.zoom,S.pan[1]+b[1]*S.zoom,(b[2]-b[0])*S.zoom,(b[3]-b[1])*S.zoom];
}
let hoverPath = null;
function drawOverlay() {
  const ov = $('#overlay'); if (!ov || !S.scene) return;
  const parts = [];
  if (hoverPath && !S.sel.includes(hoverPath)) { const n = node(hoverPath), r = n && stageRect(n); if (r) parts.push(`<div class="hoverbox" style="left:${r[0]}px;top:${r[1]}px;width:${r[2]}px;height:${r[3]}px"></div>`); }
  const nodes = selNodes();
  for (const n of nodes) {
    const r = stageRect(n); if (!r) continue;
    const handles = nodes.length === 1 ? [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => `<i class="h" style="left:${a * r[2] - 4.5}px;top:${b * r[3] - 4.5}px"></i>`).join('') : '';
    const tag = nodes.length === 1 ? `<span class="tag">${esc(E.displayName(n))}</span>` : '';
    parts.push(`<div class="selbox${nodes.length > 1 ? ' multi' : ''}" style="left:${r[0]}px;top:${r[1]}px;width:${r[2]}px;height:${r[3]}px">${tag}${handles}</div>`);
  }
  // frames: top-level groups with a name get a title above them (click = select, drag = move the whole frame);
  // a group that covers most of the canvas is a layer (e.g. "Tinta" / "Colores" of a trace), not a frame
  const canvasArea = S.scene.width * S.scene.height, stage = $('#stage');
  const stageWidth = stage.clientWidth, stageHeight = stage.clientHeight;
  for (const f of S.scene.root.children) {
    if (f.type !== 'group' || !f.label || f.hidden) continue;
    const r = stageRect(f), b = worldBounds(f); if (!r || !b) continue;
    if ((b[2] - b[0]) * (b[3] - b[1]) > 0.7 * canvasArea) continue;
    if (r[2] < 70 || r[0] > stageWidth || r[0]+r[2] < 0 || r[1]-22 > stageHeight || r[1] < 0) continue;
    parts.push(`<div class="ftitle${S.sel.includes(f.path) ? ' on' : ''}" data-frame="${esc(f.path)}" style="left:${r[0]}px;top:${r[1] - 22}px;max-width:${Math.max(90, r[2])}px" title="Arrastra para mover el frame">${ICON.hash}<b>${esc(f.label)}</b><span>${Math.round(b[2] - b[0])} × ${Math.round(b[3] - b[1])}</span></div>`);
  }
  if (marquee) parts.push(`<div class="marquee" style="left:${Math.min(marquee.x0, marquee.x1)}px;top:${Math.min(marquee.y0, marquee.y1)}px;width:${Math.abs(marquee.x1 - marquee.x0)}px;height:${Math.abs(marquee.y1 - marquee.y0)}px"></div>`);
  ov.innerHTML = parts.join('');
}

// ------------------------------------------------------------------------------------------------- layers
let flat = [], layerEntries = [], layerPaintFrame = null;
function matchesFilter() {
  const f = S.filter.trim();
  if (!f) return null;
  if (/^(part|role|type|semantic|name|tag|brand|kind|resource):|^\*$/.test(f)) { try { return new Set(selectNodes(S.scene, f).map((n) => n.path)); } catch { return new Set(); } }
  const q = f.toLowerCase(), set = new Set();
  for (const n of S.scene.byId.values()) if ([n.name, n.label, n.semantic, n.type, n.resource?.brand, n.resource?.purpose, ...(n.resource?.tags || [])].some((v) => String(v || '').toLowerCase().includes(q))) set.add(n.path);
  return set;
}
function renderLayers() {
  const host = $('#layers'), match = matchesFilter();
  const visibleByFilter = new Set();
  if (match) for (const p of match) { visibleByFilter.add(p); for (const a of ancestorsOfPath(p)) visibleByFilter.add(a); }
  flat = [];
  layerEntries = [];
  const walk = (parent, depth) => {
    for (const n of [...parent.children].reverse()) { // topmost first, like every design tool
      if (match && !visibleByFilter.has(n.path)) continue;
      const isGroup = n.type === 'group' || n.type === 'fur';
      const open = isGroup && (S.open.has(n.path) || (match && visibleByFilter.has(n.path) && !match.has(n.path)));
      flat.push(n.path);
      layerEntries.push({n,depth,isGroup,open});
      if (open) walk(n, depth + 1);
    }
  };
  walk(S.scene.root, 0);
  $('#layerCount').textContent = S.scene.byId.size;
  if (!host.dataset.noscroll && S.sel.length) {
    const selected = new Set(S.sel), index = layerEntries.findIndex(({n}) => selected.has(n.path));
    if (index >= 0) {
      const top = index * LAYER_ROW_HEIGHT, height = host.clientHeight || 400;
      if (top < host.scrollTop) host.scrollTop = top;
      else if (top + LAYER_ROW_HEIGHT > host.scrollTop + height) host.scrollTop = top + LAYER_ROW_HEIGHT - height;
    }
  }
  paintLayerWindow();
}
function paintLayerWindow() {
  const host = $('#layers'), selected = new Set(S.sel);
  const range = layerWindow(layerEntries.length, host.scrollTop, host.clientHeight || 400);
  const rows = [];
  for (const {n,depth,isGroup,open} of layerEntries.slice(range.start,range.end)) {
      const fill = typeof n.fill === 'string' && n.fill.startsWith('#') ? n.fill : null;
      rows.push(`<div class="row${isGroup ? ' group' : ''}${open ? ' open' : ''}${selected.has(n.path) ? ' sel' : ''}${n.hidden ? ' hidden-n' : ''}" style="--d:${depth}" data-path="${esc(n.path)}" draggable="true">
        ${isGroup && n.children.length ? `<button class="chev" data-chev>${ICON.chev}</button>` : '<span class="chev"></span>'}
        <span class="ti">${ICON[n.type] || ICON.path}</span>
        ${fill && !isGroup ? `<span class="sw" style="background:${fill}"></span>` : ''}
        <span class="nm" title="${esc(n.semantic || n.path)}">${esc(E.displayName(n))}</span>
        ${n.animate ? `<span class="badge" title="${esc(n.animate.preset)}">${ICON.spark}${esc(n.animate.preset)}</span>` : ''}
        ${isGroup ? `<span class="faint">${n.children.length}</span>` : ''}
        <button class="ib${n.locked ? ' on' : ''}" data-lock title="Bloquear">${n.locked ? ICON.lock : ICON.unlock}</button>
        <button class="ib${n.hidden ? ' on' : ''}" data-eye title="Mostrar/ocultar">${n.hidden ? ICON.eyeOff : ICON.eye}</button>
      </div>`);
  }
  host.innerHTML = layerEntries.length ? `<div aria-hidden="true" style="height:${range.before}px"></div>${rows.join('')}<div aria-hidden="true" style="height:${range.after}px"></div>` : '<div class="faint" style="padding:16px">Sin coincidencias.</div>';
}
function select(paths, { add = false, toggle = false } = {}) {
  if (toggle) { const s = new Set(S.sel); for (const p of paths) s.has(p) ? s.delete(p) : s.add(p); S.sel = [...s]; }
  else if (add) S.sel = [...new Set([...S.sel, ...paths])];
  else S.sel = [...paths];
  for (const p of S.sel) for (const a of ancestorsOfPath(p)) S.open.add(a);
  renderLayers(); renderProps(); drawOverlay(); renderStatus(); chatApi?.refreshSelection();
}

// ------------------------------------------------------------------------------------------------- properties
function common(nodes, get) { const v = nodes.map(get); return v.every((x) => JSON.stringify(x) === JSON.stringify(v[0])) ? v[0] : undefined; }

function resourceFields(node) {
  const r = node.resource || {};
  const text = (key, label, placeholder, max) => `<label>${label}<input data-resource="${key}" aria-label="${label}" maxlength="${max}" value="${esc(r[key] || '')}" placeholder="${placeholder}"></label>`;
  return `<details class="section resource-fields"${node.resource ? ' open' : ''}><summary>Identidad del recurso${r.source ? ' · variante' : ''}</summary>
    <p class="faint">Describe para qué sirve y qué debe conservar la IA al reutilizarlo.</p>
    <label>Tipo<select data-resource="kind" aria-label="Tipo de recurso">${Object.entries(RESOURCE_KINDS).map(([id,label])=>`<option value="${id}"${(r.kind || 'other')===id?' selected':''}>${label}</option>`).join('')}</select></label>
    ${text('brand','Marca o familia','Musaru',160)}
    ${text('key','Clave única','musaru.icono',120)}
    <label>Etiquetas<input data-resource="tags" aria-label="Etiquetas" value="${esc((r.tags || []).join(', '))}" placeholder="música, vinilo, oficial"></label>
    ${text('purpose','Propósito','Identidad de la app; usar en splash y portada',600)}
    <label>Rasgos que conservar<textarea data-resource="identity" aria-label="Rasgos que conservar" maxlength="2000" rows="3" placeholder="Vinilo oscuro, centro amarillo con m, fondo azul…">${esc(r.identity || '')}</textarea></label>
    <label class="resource-check"><input type="checkbox" data-resource="reusable"${r.reusable !== false ? ' checked' : ''}>La IA puede reutilizarlo</label>
    ${r.source ? `<p class="faint">Origen: ${esc(r.source)}</p>` : ''}
    <div class="line"><button class="btn sm" data-save-resource>Guardar identidad</button>${r.reusable ? '<button class="btn sm" data-reuse-resource>Reutilizar…</button>' : ''}${node.resource ? '<button class="btn sm" data-remove-resource title="Quitar solo la ficha, conserva el dibujo">Quitar ficha</button>' : ''}</div>
  </details>`;
}
function reuseResourceDialog(path) {
  const source = node(path); if (!source) return;
  const version = documentRevision;
  dialog({title:'Reutilizar recurso',ok:'Insertar copia editable',body:`<p>${esc(E.displayName(source))}. La copia conserva su identidad y registra el origen.</p>
    <label>Destino<select name="destination"><option value="root">Lienzo</option>${[...S.scene.byPath.values()].filter(n=>n.type==='group'&&!isLocked(n)&&n.path!==path).map(n=>`<option value="${esc(n.path)}">${esc(E.displayName(n))} · ${esc(n.path)}</option>`).join('')}</select></label>
    <p class="faint">X e Y son coordenadas locales del destino.</p><div class="grid3"><label>X<input name="x" type="number" value="${source.at[0]+24}" required></label><label>Y<input name="y" type="number" value="${source.at[1]+24}" required></label><label>Escala<input name="scale" type="number" min="0.001" step="any" value="1" required></label></div>`,onOk:form=>{
      if (documentRevision !== version) throw new Error('El documento cambió; vuelve a elegir el recurso');
      const r=createIllustrator({text:S.text}).preview([{op:'reuse',other:path,target:form.destination.value,x:Number(form.x.value),y:Number(form.y.value),scale:Number(form.scale.value)}]);
      load(r.text,{record:true,keepSel:true}); toast('Recurso reutilizado como copia editable');
    }});
}
function showResources() {
  const resources = listResources(S.scene);
  dialog({ title:'Recursos del documento',ok:'Cerrar',body:`<p class="faint">${resources.length} recursos guardados. Busca también por etiquetas en Capas.</p><div class="resource-catalog">${resources.map((r,i)=>`<article><strong>${esc(r.label)}</strong><span class="faint">${esc(RESOURCE_KINDS[r.kind])}${r.brand?' · '+esc(r.brand):''}${r.source?' · variante':''}</span><p>${esc(r.purpose || 'Sin propósito definido')}</p><p class="faint">${esc(r.tags.join(' · '))}</p>${r.source || r.key ? `<p class="faint">${r.source ? 'Origen' : 'Clave'}: ${esc(r.source || r.key)}</p>` : ''}<button type="button" class="btn sm" data-resource-select="${i}">Seleccionar</button>${r.reusable?` <button type="button" class="btn sm" data-resource-use="${i}">Reutilizar…</button>`:''}</article>`).join('') || '<p>Selecciona un grupo y abre Propiedades → Identidad del recurso para registrar el primero.</p>'}</div>`,onOk:()=>{},init:form=>{
    form.querySelectorAll('[data-resource-select]').forEach(b=>b.onclick=()=>{form.closest('#modal').classList.remove('on');select([resources[+b.dataset.resourceSelect].path]);$('#rightTabs [data-rtab="props"]')?.click();});
    form.querySelectorAll('[data-resource-use]').forEach(b=>b.onclick=()=>{const path=resources[+b.dataset.resourceUse].path;form.closest('#modal').classList.remove('on');reuseResourceDialog(path);});
  }});
}

function renderProps() {
  const host = $('#props'), nodes = selNodes();
  renderPanels();
  if (!nodes.length) { host.innerHTML = docPanel(); bindDoc(); return; }
  const one = nodes.length === 1 ? nodes[0] : null;
  const fill = common(nodes, (n) => n.fill), stroke = common(nodes, (n) => n.stroke), sw = common(nodes, (n) => n.strokeWidth), op = common(nodes, (n) => n.opacity);
  const anim = common(nodes, (n) => n.animate?.preset || 'none');
  const a0 = nodes.find((n) => n.animate)?.animate || S.anim;
  const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : null);
  const colorField = (key, v, label) => `<label class="color"><input type="color" data-color="${key}" value="${hex(v) ? (hex(v).length === 4 ? '#' + [...hex(v).slice(1)].map((c) => c + c).join('') : hex(v).slice(0, 7)) : '#000000'}"><input type="text" data-hex="${key}" value="${v === undefined || v === null ? '' : esc(v)}" placeholder="${v === undefined ? 'Mixto' : 'heredado'}"><button class="clear" data-clear="${key}" title="Quitar">×</button></label>`;
  host.innerHTML = `
  <div class="section">
    <h3>${one ? esc(one.type === 'group' ? 'Grupo' : one.type) : `${nodes.length} capas`}<span class="r">${one?.semantic ? `<span class="chip acc" title="semantic">${esc(one.semantic)}</span>` : ''}</span></h3>
    ${one ? `<div class="stack"><label class="field"><span class="k">Nombre</span><input data-prop="label" value="${esc(E.displayName(one))}"></label>
      <div class="faint">id <span class="kbd">${esc(one.path)}</span>${one.role ? ` · rol <span class="kbd">${esc(one.role)}</span>` : ''}</div></div>`
    : `<div class="stack"><label class="field"><span class="k">Renombrar</span><input id="renamePattern" value="{part} {i}" placeholder="{name} {i}"></label>
      <div class="line"><button class="btn sm" id="btnRename">Renombrar ${nodes.length} capas</button><span class="faint">{name} {label} {type} {part} {i} {n}</span></div></div>`}
  </div>
  ${one ? resourceFields(one) : ''}
  <div class="section">
    <h3>Transformación${one ? '' : '<span class="r">se aplica a todas</span>'}</h3>
    <div class="grid2">
      ${one ? `<label class="field"><span class="k">X</span><input data-num="x" value="${r2(one.at[0])}"></label><label class="field"><span class="k">Y</span><input data-num="y" value="${r2(one.at[1])}"></label>`
        : `<label class="field"><span class="k">ΔX</span><input data-delta="x" value="0"></label><label class="field"><span class="k">ΔY</span><input data-delta="y" value="0"></label>`}
      <label class="field"><span class="k">Rot</span><input data-num="rotate" value="${common(nodes, (n) => n.rotate) ?? ''}" placeholder="Mixto"></label>
      <label class="field"><span class="k">Escala</span><input data-num="scale" value="${common(nodes, (n) => n.scale[0]) ?? ''}" placeholder="Mixto"></label>
    </div>
  </div>
  <div class="section">
    <h3>Apariencia</h3>
    <div class="stack">
      <div class="line"><span class="faint" style="width:52px">Relleno</span>${colorField('fill', fill)}</div>
      <div class="line"><span class="faint" style="width:52px">Trazo</span>${colorField('stroke', stroke)}<label class="field" style="width:70px"><input data-num="strokeWidth" value="${sw ?? ''}" placeholder="—"></label></div>
      <div class="line"><span class="faint" style="width:52px">Opacidad</span><input type="range" min="0" max="1" step="0.05" data-range="opacity" value="${op ?? 1}"><span class="faint" style="width:34px;text-align:right">${op === undefined ? '—' : Math.round(op * 100) + '%'}</span></div>
    </div>
  </div>
  <div class="section">
    <h3>Animación<span class="r">${anim && anim !== 'none' ? `<span class="chip acc">${esc(anim)}</span>` : nodes.some((n) => n.animate) ? '<span class="chip">mixto</span>' : ''}</span></h3>
    <div class="anim-preview">${['none', ...PRESET_NAMES].map((p) => `<button data-preset="${p}" class="${anim === p ? 'on' : ''}"><span class="box"><i style="${p === 'none' ? 'opacity:.25' : `animation:aru-${p} 1.6s ease-in-out infinite${['fade-in', 'fade-out', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale-in', 'pop', 'draw'].includes(p) ? ' alternate' : ''}`}"></i></span>${p === 'none' ? 'ninguna' : p}</button>`).join('')}</div>
    <div class="grid3" style="margin-top:10px">
      <label class="field"><span class="k">Dur</span><input data-anim="duration" value="${a0.duration}"></label>
      <label class="field"><span class="k">Ret</span><input data-anim="delay" value="${a0.delay}"></label>
      <label class="field" title="Retraso extra por capa (lotes)"><span class="k">Esc</span><input data-anim="stagger" value="${nodes.length > 1 ? S.anim.stagger : 0}"></label>
    </div>
    <div class="grid2" style="margin-top:8px">
      <label class="field"><select data-anim="repeat">${['once', 'loop', 'alternate'].map((r) => `<option value="${r}"${a0.repeat === r ? ' selected' : ''}>${{ once: 'Una vez', loop: 'En bucle', alternate: 'Ida y vuelta' }[r]}</option>`).join('')}</select></label>
      <label class="field"><select data-anim="ease">${Object.keys(EASES).map((k) => `<option value="${k}"${a0.ease === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
    </div>
    <div class="line" style="margin-top:10px"><button class="btn sm" id="btnPlay">${ICON.play}Previsualizar</button>${nodes.length > 1 ? '<span class="faint">“Esc” escalona el retraso por capa</span>' : ''}</div>
  </div>
  <div class="section">
    <h3>Organizar</h3>
    <div class="stack">
      ${nodes.length > 1 ? `<div class="line"><span class="seg">${[['left', 'alignL'], ['center', 'alignC'], ['right', 'alignR']].map(([m, i]) => `<button data-align="${m}" title="Alinear ${m}">${ICON[i]}</button>`).join('')}</span><span class="seg">${[['top', 'alignT'], ['middle', 'alignM'], ['bottom', 'alignB']].map(([m, i]) => `<button data-align="${m}" title="Alinear ${m}">${ICON[i]}</button>`).join('')}</span><span class="seg"><button data-dist="x" title="Distribuir horizontal">${ICON.distH}</button><button data-dist="y" title="Distribuir vertical">${ICON.distV}</button></span></div>` : ''}
      <div class="line"><span class="seg">${[['top', 'top', 'Al frente'], ['up', 'up', 'Adelante'], ['down', 'down', 'Atrás'], ['bottom', 'bottom', 'Al fondo']].map(([d, i, t]) => `<button data-order="${d}" title="${t}">${ICON[i]}</button>`).join('')}</span>
        <span class="seg"><button data-flag="hidden" title="Mostrar/ocultar">${ICON.eye}</button><button data-flag="locked" title="Bloquear">${ICON.lock}</button></span></div>
      <div class="line" style="flex-wrap:wrap"><button class="btn sm" data-act="group">Agrupar</button>${one?.type === 'group' ? '<button class="btn sm" data-act="ungroup">Desagrupar</button><button class="btn sm" id="btnChildren">Seleccionar hijos</button>' : ''}<button class="btn sm" data-act="duplicate">Duplicar</button><button class="btn sm" data-act="delete">Eliminar</button></div>
      <div class="line"><button class="btn sm" id="btnUnoverlap" title="Mueve los frames seleccionados a espacio libre y amplía el lienzo si hace falta">Evitar solapes</button></div>
    </div>
  </div>
  <div class="section">
    <h3>Seleccionar en lote</h3>
    <div class="line" style="flex-wrap:wrap">
      <button class="btn sm" data-similar="fill">Mismo relleno</button><button class="btn sm" data-similar="type">Mismo tipo</button>${nodes.some((n) => n.semantic) ? '<button class="btn sm" data-similar="part">Misma parte</button>' : ''}<button class="btn sm" data-similar="parent">Hermanos</button>${one ? '<button class="btn sm" id="btnParent">Grupo padre</button>' : ''}
    </div>
  </div>
  ${nodes.every((n) => ['path', 'group'].includes(n.type)) ? `<div class="section"><h3>Afinar trazos</h3>
    <p class="faint">Conserva anclas y esquinas. Compara el cambio antes de aplicarlo.</p>
    <div class="line"><button class="btn sm" data-refine="simplify">Simplificar…</button><button class="btn sm" data-refine="smooth">Suavizar…</button></div>
  </div>` : ''}`;
  bindProps(nodes);
}
function bindProps(nodes) {
  const host = $('#props'), ids = nodes.map((n) => n.id);
  const on = (sel, ev, f) => $$(sel, host).forEach((el) => el.addEventListener(ev, f));
  on('[data-save-resource]', 'click', () => {
    try { const value = { ...nodes[0].resource };
      for (const input of $$('[data-resource]', host)) value[input.dataset.resource] = input.type === 'checkbox' ? input.checked : input.dataset.resource === 'tags' ? input.value.split(',') : input.value;
      const resource = normalizeResource(value);
      commit(s => E.setProps(s, ids, { resource }), 'Identidad del recurso guardada');
    } catch (e) { toast(e.message, true); }
  });
  on('[data-reuse-resource]', 'click', () => reuseResourceDialog(nodes[0].path));
  on('[data-remove-resource]', 'click', () => commit(s => E.setProps(s, ids, { resource: null }), 'Ficha de recurso quitada'));
  on('[data-refine]', 'click', (e) => showBatchPreview([{ op: e.currentTarget.dataset.refine, target: 'selection', tolerance: 1, strength: 0.6 }], 'Afinar trazos'));
  on('[data-prop="label"]', 'change', (e) => commit((s) => E.setProps(s, ids, { label: e.target.value.trim() || null }), 'Renombrado'));
  on('#btnRename', 'click', () => commit((s) => E.renameBatch(s, ids, $('#renamePattern').value), `${ids.length} capas renombradas`));
  on('[data-num]', 'change', (e) => {
    const k = e.target.dataset.num, v = Number(e.target.value); if (!isFinite(v)) return;
    commit((s) => { for (const id of ids) { const n = s.byId.get(id); if (k === 'x') n.at = [v, n.at[1]]; else if (k === 'y') n.at = [n.at[0], v]; else if (k === 'scale') n.scale = [v, v]; else n[k] = v; } });
  });
  on('[data-delta]', 'change', (e) => { const v = Number(e.target.value) || 0; commit((s) => E.translate(s, ids, e.target.dataset.delta === 'x' ? v : 0, e.target.dataset.delta === 'y' ? v : 0)); });
  on('[data-color]', 'change', (e) => commit((s) => E.setProps(s, ids, { [e.target.dataset.color]: e.target.value.toUpperCase() })));
  on('[data-color]', 'input', (e) => { for (const n of nodes) { const el = elOf(n); if (el) el.setAttribute(e.target.dataset.color, e.target.value); } });
  on('[data-hex]', 'change', (e) => { const v = e.target.value.trim(); commit((s) => E.setProps(s, ids, { [e.target.dataset.hex]: v || null })); });
  on('[data-clear]', 'click', (e) => commit((s) => E.setProps(s, ids, { [e.currentTarget.dataset.clear]: 'none' })));
  on('[data-range]', 'input', (e) => { for (const n of nodes) { const el = elOf(n); if (el) el.setAttribute('opacity', e.target.value); } });
  on('[data-range]', 'change', (e) => commit((s) => E.setProps(s, ids, { opacity: Number(e.target.value) })));
  on('[data-preset]', 'click', (e) => { readAnimFields(); S.anim.repeat = LOOPING.has(e.currentTarget.dataset.preset) ? 'loop' : 'once'; commit((s) => E.animateBatch(s, ids, { preset: e.currentTarget.dataset.preset, ...S.anim, stagger: ids.length > 1 ? S.anim.stagger : 0 }), e.currentTarget.dataset.preset === 'none' ? 'Animación quitada' : `Animación aplicada a ${ids.length} capa(s)`); play(); });
  on('[data-anim]', 'change', () => { readAnimFields(); const animated = nodes.filter((n) => n.animate); if (animated.length) commit((s) => E.animateBatch(s, animated.map((n) => n.id), { preset: animated[0].animate.preset, ...S.anim, stagger: animated.length > 1 ? S.anim.stagger : 0 })); });
  on('#btnPlay', 'click', play);
  on('[data-align]', 'click', (e) => { const b = new Map(nodes.map((n) => [n.id, worldBounds(n)])); commit((s) => E.align(s, ids, e.currentTarget.dataset.align, b, scaleOfId)); });
  on('[data-dist]', 'click', (e) => { const b = new Map(nodes.map((n) => [n.id, worldBounds(n)])); commit((s) => E.distribute(s, ids, e.currentTarget.dataset.dist, b, scaleOfId)); });
  on('[data-order]', 'click', (e) => commit((s) => E.reorder(s, ids, e.currentTarget.dataset.order)));
  on('[data-flag]', 'click', (e) => { const k = e.currentTarget.dataset.flag, v = !nodes.every((n) => n[k]); commit((s) => E.setProps(s, ids, { [k]: v || null })); });
  on('#btnUnoverlap', 'click', () => { const notes = []; for (const p of S.sel.slice()) { const n = placeFreely(p); if (n) notes.push(n); } const f = fitCanvas(); if (f) notes.push(f); toast(notes.length ? `Listo: ${[...new Set(notes)].join(' · ')}` : 'No hay solapes'); });
  on('#btnChildren', 'click', () => select(nodes[0].children.map((c) => c.path)));
  on('#btnParent', 'click', () => { const p = E.parentOf(S.scene, nodes[0]); if (p && p !== S.scene.root) select([p.path]); });
  on('[data-similar]', 'click', (e) => selectSimilar(e.currentTarget.dataset.similar));
  bindActs(host);
}
function readAnimFields() {
  for (const el of $$('[data-anim]', $('#props'))) { const k = el.dataset.anim; S.anim[k] = ['duration', 'delay', 'stagger'].includes(k) ? Math.max(0, Number(el.value) || 0) : el.value; }
}
// accumulated parent scale (for converting canvas deltas into each node's parent space)
function scaleOfId(id) { let sx = 1, sy = 1; const n = S.scene.byId.get(id); for (const a of ancestors(n)) { sx *= a.scale[0]; sy *= a.scale[1]; } return [sx, sy]; }
function selectSimilar(kind) {
  const nodes = selNodes(); if (!nodes.length) return;
  const all = [...S.scene.byId.values()];
  let res = [];
  if (kind === 'fill') { const f = new Set(nodes.map((n) => n.fill)); res = all.filter((n) => n.type !== 'group' && f.has(n.fill)); }
  if (kind === 'type') { const t = new Set(nodes.map((n) => n.type)); res = all.filter((n) => t.has(n.type)); }
  if (kind === 'part') { const p = new Set(nodes.map((n) => String(n.semantic || '').split('.').pop()).filter(Boolean)); res = all.filter((n) => n.type !== 'group' && p.has(String(n.semantic || '').split('.').pop())); }
  if (kind === 'parent') { const ps = new Set(nodes.map((n) => E.parentOf(S.scene, n))); res = [...ps].flatMap((p) => p.children); }
  select(res.filter((n) => !isLocked(n)).map((n) => n.path));
  toast(`${S.sel.length} capas seleccionadas`);
}
function docPanel() {
  const fills = new Map();
  for (const n of S.scene.byId.values()) if (n.type !== 'group' && typeof n.fill === 'string' && n.fill.startsWith('#')) fills.set(n.fill.toUpperCase(), (fills.get(n.fill.toUpperCase()) || 0) + 1);
  const pal = [...fills].sort((a, b) => b[1] - a[1]).slice(0, 18);
  const groups = [...S.scene.byId.values()].filter((n) => n.type === 'group').length, animated = [...S.scene.byId.values()].filter((n) => n.animate).length;
  return `
  <div class="section empty"><div class="big">${ICON.hash}</div><h2>Un espacio para crear</h2><p>Selecciona una capa para editarla, arrastra en el lienzo para seleccionar varias o usa una herramienta para dibujar.</p></div>
  <div class="section"><h3>Documento</h3><div class="stack">
    <div class="grid2"><label class="field"><span class="k">Ancho</span><input data-doc="w" value="${Math.round(S.scene.width)}"></label><label class="field"><span class="k">Alto</span><input data-doc="h" value="${Math.round(S.scene.height)}"></label></div>
    <div class="line"><span class="faint" style="width:52px">Fondo</span><label class="color"><input type="color" data-docbg value="${/^#[0-9a-f]{6}$/i.test(S.scene.background) ? S.scene.background : '#ffffff'}"><input type="text" data-docbgt value="${esc(S.scene.background)}"></label></div>
    <div class="faint">${S.scene.byId.size} capas · ${groups} grupos · ${animated} animadas</div>
    <div class="line"><button class="btn sm" id="btnFitCanvas" title="Ajusta el tamaño del lienzo a todo el contenido, con margen">Ajustar lienzo al contenido</button></div>
  </div></div>
  <div class="section"><h3>Paleta del documento<span class="r">${fills.size} colores</span></h3>
    <div class="swatches" style="margin-bottom:18px">${pal.map(([c, k]) => `<button style="background:${c}" data-swatch="${c}" title="${c} · ${k} capas"><span>${k}</span></button>`).join('')}</div>
    <div class="faint">Clic en un color: selecciona todas sus capas, para recolorearlas o animarlas en lote.</div>
  </div>
  <div class="section"><h3>Animaciones</h3><div class="stack"><div class="faint">${animated ? `${animated} capas animadas.` : 'Sin animaciones. Selecciona capas y elige un efecto.'}</div><div class="line"><button class="btn sm" id="btnPlayAll">${ICON.play}Reproducir</button><label class="faint"><input type="checkbox" id="chkLive" ${S.live ? 'checked' : ''}> en vivo en el lienzo</label></div></div></div>`;
}
function bindDoc() {
  const host = $('#props');
  for (const el of $$('[data-doc]', host)) el.addEventListener('change', () => { const w = Number($('[data-doc="w"]', host).value), h = Number($('[data-doc="h"]', host).value); if (w > 0 && h > 0) load(S.text.replace(/^canvas\s+[^\n]*/m, `canvas ${w} ${h}`), { record: true }); });
  const bg = (v) => load(S.text.replace(/^background\s+[^\n]*/m, `background ${v}`), { record: true });
  $('[data-docbg]', host).addEventListener('change', (e) => bg(e.target.value.toUpperCase()));
  $('[data-docbgt]', host).addEventListener('change', (e) => bg(e.target.value.trim() || 'none'));
  for (const b of $$('[data-swatch]', host)) b.addEventListener('click', () => { const c = b.dataset.swatch; select([...S.scene.byId.values()].filter((n) => String(n.fill).toUpperCase() === c && !isLocked(n)).map((n) => n.path)); toast(`${S.sel.length} capas con ${c}`); });
  $('#btnPlayAll', host).addEventListener('click', play);
  $('#btnFitCanvas', host).addEventListener('click', () => toast(fitCanvas({ shrink: true }) || 'El lienzo ya se ajusta al contenido'));
  $('#chkLive', host).addEventListener('change', (e) => { S.live = e.target.checked; renderCanvas(); });
}
function play() { const was = S.live; S.live = true; renderCanvas(); setTimeout(drawOverlay, maxAnimTime() * 1000 + 450); if (!was) setTimeout(() => { S.live = false; $('#art').classList.add('paused'); drawOverlay(); }, maxAnimTime() * 1000 + 400); }
function maxAnimTime() { let m = 0; for (const n of S.scene.byId.values()) if (n.animate && n.animate.repeat === 'once') m = Math.max(m, n.animate.delay + n.animate.duration); return Math.min(m || 1.5, 8); }

// ------------------------------------------------------------------------------------------------- code + batch drawers
function renderCode() {
  const ta = $('#code');
  if (document.activeElement !== ta) ta.value = S.text;
  const msgs = [...S.errors.map((e) => `<div class="err">${e.line ? `L${e.line}: ` : ''}${esc(e.message)}</div>`), ...S.warnings.slice(0, 40).map((w) => `<div class="warn">${w.line ? `L${w.line}: ` : ''}${esc(w.message)}</div>`)];
  $('#codeMsg').innerHTML = msgs.join('') || `<div class="ok">Sin errores · ${S.text.split('\n').length} líneas · ${(new TextEncoder().encode(S.text).length / 1024).toFixed(1)} KB</div><p>Los cambios en el lienzo reescriben este código, y lo que escribas aquí actualiza el lienzo.</p>`;
}
let codeTimer = null, codeBase = null;
function onCode() {
  if (codeBase === null) codeBase = S.text;
  clearTimeout(codeTimer);
  codeTimer = setTimeout(() => {
    const t = $('#code').value, r = compile(t);
    if (!r.scene || r.errors.length) { $('#codeMsg').innerHTML = r.errors.map((e) => `<div class="err">${e.line ? `L${e.line}: ` : ''}${esc(e.message)}</div>`).join(''); return; }
    const before = codeBase; codeBase = null;
    if (before !== t) { S.past.push(before); S.future = []; }
    load(t, { keepSel: true });
  }, 280);
}
function readBatch() {
  const ops = JSON.parse($('#batchIn').value);
  return Array.isArray(ops) ? ops : ops?.operations || [ops];
}
function runOps(ops) {
  const log = [];
  commit((s) => { const r = applyBatch(s, ops, { selection: S.sel.map((p) => s.byPath.get(p)?.id).filter(Boolean) }); log.push(...r.log); return r.created.length ? r.created : undefined; });
  $('#batchLog').innerHTML = log.map((l) => `<div class="${l.ok ? 'ok' : 'err'}">${l.ok ? '✓' : '✗'} ${esc(l.message)}</div>`).join('');
}
function runBatch() {
  try { runOps(readBatch()); } catch (e) { $('#batchLog').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function showBatchPreview(ops, title = 'Vista previa del lote') {
  try {
    const before = S.text, selection = S.sel.slice(), result = previewBatch(before, ops, selection);
    const image = (scene) => esc('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderScene(scene, { dataAttrs: false, animate: false })));
    const failed = result.log.some((l) => !l.ok);
    dialog({ title, ok: 'Aplicar cambios',
      body: `<div class="path-preview"><figure><figcaption>Antes</figcaption><img alt="Ilustración antes del cambio" src="${image(S.scene)}"></figure><figure><figcaption>Después</figcaption><img alt="Ilustración con el cambio propuesto" src="${image(result.scene)}"></figure></div>
        <div>${result.log.map((l) => `<p${l.ok ? '' : ' class="err"'}>${l.ok ? '✓' : '✗'} ${esc(l.message)}</p>`).join('')}</div>
        <p>${failed ? 'Corrige las operaciones con error para aplicar este lote.' : 'Puedes deshacer todos estos cambios en un solo paso.'}</p>`,
      init: (form) => { form.classList.add('path-preview-dialog'); $('button[type="submit"]', form).disabled = failed; },
      onOk: () => { if (failed) throw new Error('El lote contiene errores'); if (S.text !== before || JSON.stringify(S.sel) !== JSON.stringify(selection)) throw new Error('El documento cambió; vuelve a previsualizar'); runOps(ops); },
    });
  } catch (e) { toast(e.message, true); }
}
function layoutSummary() {
  const boxes = rootBoxes(); if (!boxes.length) return 'The canvas is empty: all of it is free.';
  const U = boxes.reduce((u, { b }) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const r = (v) => Math.round(v);
  return `Occupied area: x ${r(U[0])}..${r(U[2])}, y ${r(U[1])}..${r(U[3])}. Free space: ${U[2] < S.scene.width - 60 ? `right of x=${r(U[2])} (inside the canvas)` : `none to the right inside the canvas`}; ${U[3] < S.scene.height - 60 ? `below y=${r(U[3])}` : 'none below inside the canvas'}. New frames must not overlap existing bounds; enlarge the canvas (op canvas) if needed.`;
}
function aiContextForChat() { return aiContext().split('\n\nAnswer with a JSON array')[0]; }
function aiContext() {
  const lines = [], max = 600;
  let count = 0;
  (function walk(p, d) {
    for (const n of p.children) {
      if (count++ > max) return;
      const bb = n.type === 'group' && d <= 1 ? worldBounds(n) : null;
      lines.push(`${'  '.repeat(d)}- ${n.type} ${n.path}${n.label ? ` "${n.label}"` : ''}${bb ? ` bounds=[x ${Math.round(bb[0])}, y ${Math.round(bb[1])}, w ${Math.round(bb[2] - bb[0])}, h ${Math.round(bb[3] - bb[1])}]` : ''}${n.semantic ? ` semantic=${n.semantic}` : ''}${n.role ? ` role=${n.role}` : ''}${n.fill && n.type !== 'group' ? ` fill=${n.fill}` : ''}${n.animate ? ` animate=${n.animate.preset}` : ''}${n.hidden ? ' hidden' : ''}${isLocked(n) ? ' locked' : ''}${pathSummary(n)}`);
      if (n.children.length && d < 6) walk(n, d + 1);
    }
  })(S.scene.root, 0);
  return `You edit an ARU vector document through BATCH OPERATIONS only (never write geometry, paths or SVG).
Document "${S.name}", canvas ${S.scene.width}x${S.scene.height}, ${S.scene.byId.size} layers.
${activeWorkspace()}
${layoutSummary()}
${resourcePrompt(S.scene)}
Outline:
${lines.join('\n')}${count > max ? '\n  …' : ''}

Answer with a JSON array of operations. Targets: a layer path, "selection", or a selector (part:<name>, role:<role>, type:<type>, semantic:<path>, name:<name>, "*"; combine with spaces = AND).
Operations:
  {"op":"rename","target":T,"pattern":"Iris {i}"}            tokens {name} {label} {type} {part} {semantic} {i} {n}
  {"op":"set","target":T,"fill":"#RRGGBB","stroke":"#RRGGBB","strokeWidth":2,"opacity":0.8,"hidden":false,"locked":true,"label":"..."}
  {"op":"animate","target":T,"preset":one of ${PRESET_NAMES.join('|')}|none,"duration":0.6,"delay":0,"stagger":0.08,"repeat":"once|loop|alternate","ease":"${Object.keys(EASES).join('|')}"}
  {"op":"group","target":T,"label":"Name"}   {"op":"ungroup","target":T}   {"op":"duplicate","target":T}   {"op":"delete","target":T}
  {"op":"reorder","target":T,"dir":"top|up|down|bottom"}   {"op":"translate","target":T,"dx":0,"dy":-10}
  {"op":"simplify","target":T,"tolerance":1,"cornerAngle":60} removes redundant line points, keeps existing curves/corners/holes
  {"op":"smooth","target":T,"strength":0.6,"tolerance":1,"cornerAngle":60} aligns handles, keeps anchors and sharp corners
  {"op":"weld","target":"exact.open.path","other":"another.open.path","endpoint":"auto","otherEndpoint":"auto","maxDistance":8} nearest endpoints coincide, both layers kept
  {"op":"connect","target":"exact.open.path","other":"another.open.path","endpoint":"auto","otherEndpoint":"auto","maxDistance":8} one path; adjacent layers, same parent/style/scale, fill none
  Distances in canvas units; refinement accepts paths or groups; joins accept two single-subpath open paths only.
  Supports move/line/curve/quad/close; locked layers are protected. Simplify BEFORE smooth; welding is not a persistent constraint.
`;
}

// ------------------------------------------------------------------------------------------------- canvas interaction
let chatApi = null;
let marquee = null, drag = null, panDrag = null, spaceDown = false, draw = null;
function hitNode(e) {
  const el = e.target.closest?.('#art [data-id]');
  if (!el) return null;
  return S.scene.byId.get(Number(el.dataset.id)) || null;
}
// Figma-like: a click selects the child of the current focus group; double-click goes one level deeper
function pickTarget(hit, { deep = false } = {}) {
  if (!hit) return null;
  const chain = [...ancestors(hit), hit];
  if (deep) return chain[chain.length - 1];
  const cur = selNodes()[0];
  if (cur) {
    const i = chain.indexOf(cur);
    if (i >= 0) return cur;
    const parent = E.parentOf(S.scene, cur);
    const j = chain.indexOf(parent);
    if (j >= 0 && chain[j + 1]) return chain[j + 1];
  }
  return chain[0];
}
const stagePt = (e) => { const s = $('#stage').getBoundingClientRect(); return [e.clientX - s.left, e.clientY - s.top]; };
const canvasPt = (e) => { const [x, y] = stagePt(e); return [(x - S.pan[0]) / S.zoom, (y - S.pan[1]) / S.zoom]; };
function onPointerDown(e) {
  if (e.button === 1 || S.tool === 'hand' || spaceDown) { panDrag = { x: e.clientX, y: e.clientY, pan: S.pan.slice() }; $('#stage').classList.add('panning'); return; }
  if (e.button !== 0) return;
  if (['rect', 'ellipse', 'text', 'group'].includes(S.tool)) { const p = canvasPt(e); draw = { p0: p, p1: p }; return; }
  const ft = e.target.closest?.('.ftitle');
  if (ft) {
    const p = ft.dataset.frame;
    if (e.shiftKey || e.metaKey || e.ctrlKey) select([p], { toggle: true }); else if (!S.sel.includes(p)) select([p]);
    startDrag(e); return;
  }
  const hit = hitNode(e);
  const target = hit && !isLocked(hit) ? pickTarget(hit, { deep: e.metaKey || e.ctrlKey }) : null;
  // pressing inside the current selection's box moves the selection, even if another frame is drawn on top;
  // a click without dragging still selects what is under the pointer (on pointer up)
  if (!e.metaKey && !e.ctrlKey && !e.shiftKey && S.sel.length) {
    const [x, y] = stagePt(e);
    if (selNodes().some((n) => { const r = stageRect(n); return r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]; })) {
      startDrag(e); drag.clickSelect = target && !S.sel.includes(target.path) ? target.path : null; return;
    }
  }
  if (!target || e.shiftKey && !hit) { // marquee
    if (!e.shiftKey) select([]);
    const [x, y] = stagePt(e); marquee = { x0: x, y0: y, x1: x, y1: y, add: e.shiftKey };
    return;
  }
  if (e.metaKey || e.ctrlKey || e.shiftKey) select([target.path], { toggle: true });
  else if (!S.sel.includes(target.path)) select([target.path]);
  startDrag(e);
}
function startDrag(e) {
  const nodes = selNodes().filter((n) => !isLocked(n));
  const affected = new Set();
  const visit = n => { affected.add(n.id); for (const child of n.children) visit(child); };
  for (const n of nodes) { visit(n); for (const a of ancestors(n)) affected.add(a.id); }
  drag = { affected, start: stagePt(e), nodes: nodes.map((n) => ({ n, el: elOf(n), orig: elOf(n)?.getAttribute('transform') || '', s: scaleOfId(n.id) })), moved: false };
}
function onPointerMove(e) {
  if (panDrag) { S.userView = true; S.pan = [panDrag.pan[0] + e.clientX - panDrag.x, panDrag.pan[1] + e.clientY - panDrag.y]; applyView(); return; }
  if (draw) { draw.p1 = canvasPt(e); drawPreview(); return; }
  if (marquee) { [marquee.x1, marquee.y1] = stagePt(e); drawOverlay(); return; }
  if (drag) {
    const [x, y] = stagePt(e), dx = (x - drag.start[0]) / S.zoom, dy = (y - drag.start[1]) / S.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 1.5 / S.zoom) drag.moved = true;
    if (!drag.moved) return;
    for (const d of drag.nodes) if (d.el) d.el.setAttribute('transform', `translate(${dx / d.s[0]} ${dy / d.s[1]}) ${d.orig}`.trim());
    drag.delta = [dx, dy]; drawOverlay();
    return;
  }
  const hit = hitNode(e), t = hit && !isLocked(hit) ? pickTarget(hit) : null, hp = t?.path || null;
  if (hp !== hoverPath) { hoverPath = hp; drawOverlay(); }
}
function onPointerUp(e) {
  if (panDrag) { panDrag = null; $('#stage').classList.remove('panning'); return; }
  if (draw) { finishDraw(e); return; }
  if (marquee) {
    const s = $('#stage').getBoundingClientRect(), m = marquee; marquee = null;
    const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1), y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
    if (x1 - x0 > 3 && y1 - y0 > 3) {
      const inside = [];
      for (const n of S.scene.byId.values()) {
        if (n.type === 'group' || n.hidden || isLocked(n)) continue;
        const el = elOf(n); if (!el) continue;
        const r = el.getBoundingClientRect(), a = r.left - s.left, b = r.top - s.top;
        if (a >= x0 && b >= y0 && a + r.width <= x1 && b + r.height <= y1) inside.push(n.path);
      }
      select(inside, { add: m.add });
      toast(`${inside.length} capas seleccionadas`);
    } else drawOverlay();
    return;
  }
  if (drag) {
    const d = drag; drag = null;
    if (!d.moved && d.clickSelect) { select([d.clickSelect]); return; }
    if (d.moved && d.delta) commit((s) => { for (const x of d.nodes) { const n = s.byId.get(x.n.id); n.at = [n.at[0] + d.delta[0] / x.s[0], n.at[1] + d.delta[1] / x.s[1]]; } });
  }
}
function onDblClick(e) {
  const hit = hitNode(e); if (!hit || isLocked(hit)) return;
  const chain = [...ancestors(hit), hit], cur = selNodes()[0], i = cur ? chain.indexOf(cur) : -1;
  select([(chain[i + 1] || hit).path]);
}
function drawPreview() {
  const a = draw.p0, b = draw.p1, x0 = Math.min(a[0], b[0]) * S.zoom + S.pan[0], y0 = Math.min(a[1], b[1]) * S.zoom + S.pan[1];
  $('#overlay').innerHTML = `<div class="marquee" style="left:${x0}px;top:${y0}px;width:${Math.abs(b[0] - a[0]) * S.zoom}px;height:${Math.abs(b[1] - a[1]) * S.zoom}px;${S.tool === 'ellipse' ? 'border-radius:50%' : ''}"></div>`;
}
function finishDraw() {
  const a = draw.p0, b = draw.p1; draw = null;
  let w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
  if (w < 4 && h < 4) { w = S.tool === 'text' ? 160 : 120; h = S.tool === 'text' ? 48 : 80; }
  const cx = Math.min(a[0], b[0]) + (w > 4 ? w / 2 : 0), cy = Math.min(a[1], b[1]) + (h > 4 ? h / 2 : 0);
  // insert inside the selected group, in its local space (translate + scale)
  const sel = selNodes(), parent = sel.length === 1 && sel[0].type === 'group' ? sel[0] : null;
  let at = [cx, cy], size = [w, h];
  if (parent) { const chain = [...ancestors(parent), parent]; for (const g of chain) { at = [(at[0] - g.at[0]) / g.scale[0], (at[1] - g.at[1]) / g.scale[1]]; size = [size[0] / g.scale[0], size[1] / g.scale[1]]; } }
  const tool = S.tool;
  setTool('select');
  commit((s) => {
    if (tool === 'group') {
      const g = E.addShape(s, 'group', { at, parentId: parent?.id ?? null, label: 'Marco' });
      g.children.push({ id: -1, type: 'rect', name: 'fondo', label: 'Fondo', at: [0, 0], rotate: 0, scale: [1, 1], fill: '#1D1D22', stroke: '#2E2E35', strokeWidth: 1, opacity: 1, layer: 2, geom: { size, corner: 16 }, children: [] });
      return g;
    }
    return E.addShape(s, tool === 'ellipse' ? 'ellipse' : tool, { at, size, parentId: parent?.id ?? null, label: { rect: 'Rectángulo', ellipse: 'Elipse', text: 'Texto' }[tool], fill: tool === 'text' ? '#ECECF1' : '#A78BFA' });
  }, 'Capa creada');
}
function setTool(t) { S.tool = t; $$('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t)); $('#stage').className = t === 'hand' ? 'hand' : ['rect', 'ellipse', 'text', 'group'].includes(t) ? 'draw' : ''; }

// ------------------------------------------------------------------------------------------------- layers interaction
function bindLayers() {
  const host = $('#layers');
  $('#btnResources').onclick = showResources;
  host.addEventListener('scroll', () => { if (layerPaintFrame !== null) return; layerPaintFrame = requestAnimationFrame(() => { layerPaintFrame = null; paintLayerWindow(); }); }, {passive:true});
  new ResizeObserver(() => paintLayerWindow()).observe(host);
  host.addEventListener('click', (e) => {
    const row = e.target.closest('.row'); if (!row) return;
    const p = row.dataset.path, n = node(p); if (!n) return;
    if (e.target.closest('[data-chev]')) { S.open.has(p) ? S.open.delete(p) : S.open.add(p); renderLayers(); return; }
    if (e.target.closest('[data-eye]')) { commit((s) => E.setProps(s, [n.id], { hidden: n.hidden ? null : true })); return; }
    if (e.target.closest('[data-lock]')) { commit((s) => E.setProps(s, [n.id], { locked: n.locked ? null : true })); return; }
    if (e.shiftKey && S.anchor) { const a = flat.indexOf(S.anchor), b = flat.indexOf(p); if (a >= 0 && b >= 0) { select(flat.slice(Math.min(a, b), Math.max(a, b) + 1)); return; } }
    S.anchor = p;
    host.dataset.noscroll = '1';
    select([p], { toggle: e.metaKey || e.ctrlKey });
    delete host.dataset.noscroll;
  });
  host.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row'); if (!row || e.target.closest('button')) return;
    const n = node(row.dataset.path), nm = row.querySelector('.nm');
    nm.innerHTML = `<input value="${esc(E.displayName(n))}">`;
    const inp = nm.querySelector('input'); inp.focus(); inp.select();
    const done = (ok) => { if (ok && inp.value.trim() && inp.value.trim() !== E.displayName(n)) commit((s) => E.setProps(s, [n.id], { label: inp.value.trim() }), 'Renombrado'); else renderLayers(); };
    inp.addEventListener('keydown', (k) => { if (k.key === 'Enter') done(true); if (k.key === 'Escape') done(false); k.stopPropagation(); });
    inp.addEventListener('blur', () => done(true), { once: true });
  });
  host.addEventListener('mousemove', (e) => { const row = e.target.closest('.row'), p = row?.dataset.path || null; if (p !== hoverPath) { hoverPath = p; drawOverlay(); } });
  host.addEventListener('mouseleave', () => { hoverPath = null; drawOverlay(); });
  // drag & drop: on a group = put inside; elsewhere = place above that layer
  let dragPaths = null;
  host.addEventListener('dragstart', (e) => { const p = e.target.closest('.row')?.dataset.path; dragPaths = S.sel.includes(p) ? S.sel.slice() : [p]; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p); });
  const where = (e) => { const row = e.target.closest('.row'); if (!row) return null; const r = row.getBoundingClientRect(), n = node(row.dataset.path); const into = n.type === 'group' && e.clientY > r.top + r.height * 0.3 && e.clientY < r.bottom - r.height * 0.3; return { row, n, into }; };
  host.addEventListener('dragover', (e) => { const w = where(e); if (!w || dragPaths?.includes(w.n.path)) return; e.preventDefault(); $$('.drop-in,.drop-before', host).forEach((r) => r.classList.remove('drop-in', 'drop-before')); w.row.classList.add(w.into ? 'drop-in' : 'drop-before'); });
  host.addEventListener('dragleave', () => $$('.drop-in,.drop-before', host).forEach((r) => r.classList.remove('drop-in', 'drop-before')));
  host.addEventListener('drop', (e) => {
    e.preventDefault(); const w = where(e); if (!w || !dragPaths) return;
    const ids = dragPaths.map((p) => node(p)?.id).filter(Boolean); dragPaths = null;
    commit((s) => {
      const target = s.byId.get(w.n.id);
      if (w.into) { E.moveInto(s, ids, target.id); return ids.map((id) => s.byId.get(id)); }
      const parent = E.parentOf(s, target), moving = ids.map((id) => s.byId.get(id));
      E.moveInto(s, ids, parent === s.root ? null : parent.id, 0);
      // displayed above the target = right after it in draw order
      const kids = parent.children.filter((c) => !moving.includes(c)), idx = kids.indexOf(target) + 1;
      kids.splice(idx, 0, ...moving); parent.children = kids;
      return moving;
    }, 'Capas movidas');
  });
}

// ------------------------------------------------------------------------------------------------- actions, menus, keys
function act(a) {
  if (embedded && ['new', 'newProject', 'duplicateDoc', 'open', 'trace', 'workspace', 'lab'].includes(a)) { toast('El documento se administra desde la aplicación anfitriona'); return; }
  const ids = selIds();
  const need = () => { if (!ids.length) { toast('Selecciona al menos una capa', true); return false; } return true; };
  switch (a) {
    case 'group': if (need()) commit((s) => E.group(s, ids, ids.length > 1 ? 'Grupo' : `${E.displayName(s.byId.get(ids[0]))} grupo`), 'Agrupado'); break;
    case 'ungroup': if (need()) commit((s) => E.ungroup(s, ids[0]), 'Desagrupado'); break;
    case 'duplicate': if (need()) commit((s) => E.duplicate(s, ids), 'Duplicado'); break;
    case 'delete': if (need()) { commit((s) => { E.remove(s, ids); return []; }, `${ids.length} capa(s) eliminada(s)`); S.sel = []; renderAll(); } break;
    case 'new': newDocDialog(); break;
    case 'newProject': newProjectDialog(); break;
    case 'duplicateDoc': if (S.doc) flushSave().then(() => S.lib.duplicate(S.doc.id)).then((id) => refreshLibrary().then(() => openDoc(id))).then(() => toast('Documento duplicado')); break;
    case 'workspace': chooseWorkspace(); break;
    case 'open': openAruFile(); break;
    case 'trace': $('#imgIn').click(); break;
    case 'saveAru': saveFile(`${slug(S.name)}.aru`, S.text, 'aru'); break;
    case 'exportIcons': exportIconsDialog(); break;
    case 'exportPng': exportPng().catch((e) => toast(`No se pudo exportar: ${e.message}`, true)); break;
    case 'exportSvg': saveFile(`${slug(S.name)}.svg`, renderScene(S.scene, { dataAttrs: false }), 'svg'); break;
    case 'exportHtml': saveFile(`${slug(S.name)}.html`, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(S.name)}</title><style>html,body{margin:0;height:100%;background:#0f0f11;display:grid;place-items:center}svg{max-width:96vw;max-height:96vh;width:auto;height:auto}</style></head><body>${renderScene(S.scene, { dataAttrs: false })}</body></html>`, 'html'); break;
    case 'lab': if (isDesktop()) location.href = 'lab.html'; else window.open('lab.html', '_blank'); break;
  }
}
function bindActs(root) { for (const b of $$('[data-act]', root)) b.addEventListener('click', () => act(b.dataset.act)); }
const tauriInvoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
function exportIconsDialog() {
  const batches = listIconBatches(S.text);
  if (!batches.length) { toast('Agrupa cada icono y coloca los iconos dentro de un grupo de lote', true); return; }
  const preferred = batches.find(b => S.sel.includes(b.path)) || batches.find(b => b.explicit) || batches[0];
  const before = S.text;
  dialog({ title: 'Exportar iconos por lote', ok: 'Descargar ZIP', body: `
    <label class="lbl">Lote<select name="group">${batches.map(b => `<option value="${esc(b.path)}"${b.path === preferred.path ? ' selected' : ''}>${esc(b.label)} · ${b.count} iconos</option>`).join('')}</select></label>
    <div class="line"><button class="btn sm" type="button" data-check="all">Todos</button><button class="btn sm" type="button" data-check="none">Ninguno</button><span id="exportCount" class="faint"></span></div>
    <div id="exportIconsList" class="export-icons-list"></div>
    <label class="lbl">Tamaños PNG (px)<input name="sizes" value="24, 48, 96" placeholder="24, 48, 96"></label>
    <div class="line"><label><input type="checkbox" name="png" checked> PNG</label><label><input type="checkbox" name="svg" checked> SVG</label><label><input type="checkbox" name="aru" checked> ARU editable</label></div>
    <label class="lbl">Área de cada icono<select name="cell"><option value="24">Celda de 24 unidades</option><option value="fit">Ajustar al contenido</option></select></label>
    <label class="lbl">Fondo opaco<input type="color" name="background" value="#ffffff"></label>
    <p class="faint">Un archivo por icono, organizado por formato y tamaño. El documento original conserva sus capas.</p>`,
    init: f => {
      f.classList.add('export-icons-dialog');
      const updateCount = () => $('#exportCount', f).textContent = `${$$('input[name="icon"]:checked', f).length} seleccionados`;
      const updateList = () => {
        try {
        $('#dlgErr', f).textContent = '';
        const plan = prepareIconExports(before, { group: f.elements.group.value, formats: ['svg'], cellSize: f.elements.cell.value === 'fit' ? null : 24, background: f.elements.background.value });
        $('#exportIconsList', f).innerHTML = plan.entries.map(e => `<label class="export-icon"><input type="checkbox" name="icon" value="${esc(e.path)}" checked><img alt="${esc(e.label)}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(e.svg)}"><span>${esc(e.label)}${e.warnings.length ? '<small>Excede la celda: usa ajustar al contenido</small>' : ''}</span></label>`).join('');
        updateCount();
        } catch (error) { $('#exportIconsList', f).innerHTML = ''; $('#dlgErr', f).textContent = error.message; updateCount(); }
      };
      f.elements.group.onchange = updateList;
      for (const control of [f.elements.cell, f.elements.background]) control.onchange = () => { const selected = new Set($$('input[name="icon"]:checked', f).map(x => x.value)); updateList(); for (const input of $$('input[name="icon"]', f)) input.checked = selected.has(input.value); updateCount(); };
      $('#exportIconsList', f).onchange = updateCount;
      for (const btn of $$('[data-check]', f)) btn.onclick = () => { for (const input of $$('input[name="icon"]', f)) input.checked = btn.dataset.check === 'all'; updateCount(); };
      updateList();
    },
    onOk: async f => {
      const paths = $$('input[name="icon"]:checked', f).map(x => x.value), formats = ['png', 'svg', 'aru'].filter(v => f.elements[v].checked);
      const options = { group: f.elements.group.value, paths, formats, sizes: f.elements.sizes.value.split(',').map(v => Number(v.trim())), cellSize: f.elements.cell.value === 'fit' ? null : 24, background: f.elements.background.value };
      const button = $('button[type="submit"]', f); button.disabled = true; button.textContent = 'Preparando ZIP…';
      try {
        const result = await buildIconArchive(before, options, async (scene, size) => { const url = await opaquePng(scene, renderScene, { width: size, height: size }); return Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0)); });
        const name = `${slug(options.group)}-iconos.zip`;
        if (isDesktop()) {
          const path = await tauriInvoke('plugin:dialog|save', { options: { defaultPath: name, filters: [{ name: 'ZIP', extensions: ['zip'] }] } });
          if (!path) return;
          const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(new Blob([result.data])); });
          await tauriInvoke('write_zip', { path, data });
        } else download(name, result.data, 'application/zip');
        toast(`${result.manifest.entries.length} iconos exportados en ZIP`);
      } finally { button.disabled = false; button.textContent = 'Descargar ZIP'; }
    }
  });
}
async function exportPng() {
  const data = await opaquePng(S.scene, renderScene), name = `${slug(S.name)}.png`;
  if (!isDesktop()) {
    const a = document.createElement('a'); a.href = data; a.download = name; a.click();
    return;
  }
  const path = await tauriInvoke('plugin:dialog|save', { options: { defaultPath: name, filters: [{ name: 'PNG', extensions: ['png'] }] } });
  if (!path) return;
  await tauriInvoke('write_png', { path, data: data.split(',')[1] });
  toast(`Guardado: ${path.split('/').pop()}`);
}
async function saveFile(name, text, ext) {
  if (!isDesktop()) return download(name, text, { aru: 'text/plain', svg: 'image/svg+xml', html: 'text/html' }[ext] || 'text/plain');
  const path = await tauriInvoke('plugin:dialog|save', { options: { defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] } });
  if (!path) return;
  await tauriInvoke('write_text', { path, contents: text });
  toast(`Guardado: ${path.split('/').pop()}`);
}
async function openAruFile() {
  if (!isDesktop()) { $('#fileIn').click(); return; }
  const path = await tauriInvoke('plugin:dialog|open', { options: { multiple: false, directory: false, filters: [{ name: 'ARU', extensions: ['aru', 'txt'] }] } });
  if (!path) return;
  const text = await tauriInvoke('read_text', { path });
  await createDoc({ name: path.split('/').pop().replace(/\.aru$/, ''), text }); toast('Archivo importado como documento nuevo');
}
async function chooseWorkspace() {
  if (!isDesktop()) return;
  const path = await tauriInvoke('plugin:dialog|open', { options: { directory: true, multiple: false, title: 'Carpeta de trabajo de ARU Studio' } });
  if (!path) return;
  await flushSave();
  await tauriInvoke('ws_set_root', { path });
  S.lib = await openLibrary(); S.doc = null; thumbs.clear();
  await ensureStartDoc(); const first = S.projects.flatMap((p) => p.docs)[0]; if (first) await openDoc(first.id);
  toast(`Carpeta de trabajo: ${path}`);
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
let toastTimer = null;
function toast(msg, err = false) { const t = $('#toast'); t.textContent = msg; t.className = `show${err ? ' err' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 2200); }
function renderStatus() {
  const n = S.scene.byId.size, a = [...S.scene.byId.values()].filter((x) => x.animate).length;
  $('#statusInfo').textContent = `${n} capas · ${S.sel.length} seleccionada(s) · ${a} animada(s)${S.warnings.length ? ` · ${S.warnings.length} avisos` : ''}`;
  $('#btnUndo').disabled = !S.past.length; $('#btnRedo').disabled = !S.future.length;
}
function onKey(e) {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (e.key === ' ' && !typing) { spaceDown = true; $('#stage').classList.add('panning'); e.preventDefault(); return; }
  if (typing) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'g') { e.preventDefault(); act(e.shiftKey ? 'ungroup' : 'group'); return; }
  if (mod && k === 'd') { e.preventDefault(); act('duplicate'); return; }
  if (mod && k === 'a') { e.preventDefault(); select(S.scene.root.children.filter((n) => !isLocked(n)).map((n) => n.path)); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); const r = $('#stage').getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); return; }
  if (mod && k === '-') { e.preventDefault(); const r = $('#stage').getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); act('delete'); return; }
  if (e.key === 'Escape') { const n = selNodes()[0]; if (n) { const p = E.parentOf(S.scene, n); select(p && p !== S.scene.root ? [p.path] : []); } setTool('select'); return; }
  if (e.key === 'Enter') { const n = selNodes()[0]; if (n?.type === 'group' && n.children.length) select(n.children.map((c) => c.path)); return; }
  if (e.key.startsWith('Arrow') && S.sel.length) { e.preventDefault(); const d = e.shiftKey ? 10 : 1, ids = selIds(); commit((s) => E.translate(s, ids, e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0)); return; }
  if (e.shiftKey && e.key === '!') { fitView(); return; }
  const tools = { v: 'select', h: 'hand', r: 'rect', o: 'ellipse', t: 'text', f: 'group' };
  if (!mod && tools[k]) setTool(tools[k]);
}

// ------------------------------------------------------------------------------------------------- documents + tracing
// Raster -> vector with AUTO-TUNE (trace/autotune.js): a few parameter sets are traced, rendered, scored against the
// image (trace/score.js) and the best is kept. Line art is detected first (ink mode: crisp ink layer + fills traced
// with the ink removed), but the score has the last word. With polish directives (the wolf example) the designed
// pipeline runs as is.
// canvas raster of a scene on white, for scoring (≤ 800 px: the score compares at ≤ 600)
async function rasterForScore(scene, w, h) {
  const k = Math.min(1, 800 / Math.max(w, h)), W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderScene(scene, { dataAttrs: false, animate: false })); await img.decode();
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0, W, H);
  return { width: W, height: H, data: g.getImageData(0, 0, W, H).data };
}
async function traceRaster(raw, context, { polish = null, tunes = null, progress = () => {} } = {}) {
  const A = await import('../trace/autotune.js');
  if (polish) { const best = await A.traceWithTune(raw, context, { ink: 'off' }, { polish }); return { A, best, tried: [] }; }
  const { best, tried } = await A.traceBest(raw, context, { rasterize: rasterForScore, tunes, onProgress: progress });
  return { A, best, tried };
}
const tuneNote = (A, st) => st.tried.length ? `${A.describeTune(st.best.tune)} · puntuación ${st.best.metrics.score} (${st.tried.length} variantes)` : null;
async function traceImage(src, { ctx = null, polish = null, name = 'Imagen trazada' } = {}) {
  $('#busy').classList.add('on'); $('#busyText').textContent = 'Trazando la imagen con el ReferenceTracer…';
  await new Promise((r) => setTimeout(r, 30));
  try {
    const { loadImageBrowser } = await import('../trace/image.js');
    const raw = await loadImageBrowser(src);
    const context = ctx ? await (await fetch(ctx)).json() : { version: 1, scene: 'illustration', background: { importance: 0.5 }, objects: [] };
    const directives = polish ? (await (await fetch(polish)).json()).directives : null;
    const st = await traceRaster(raw, context, { polish: directives, progress: (k, n) => { $('#busyText').textContent = `Probando variante ${k} de ${n} y puntuándola…`; } });
    await createDoc({ name, text: st.best.aru });
    const res = st.best.res;
    toast(`${res.T.regions.length} regiones${st.best.ink ? ` + tinta (${st.best.ink.clusters} grupos de trazo)` : ''} · ${tuneNote(st.A, st) || `${Math.round(res.metrics.weightedFidelity * 1000) / 10}% fidelidad`}`);
  } catch (e) { toast(`No se pudo trazar: ${e.message}`, true); }
  $('#busy').classList.remove('on');
}

// ------------------------------------------------------------------------------------------------- layout: frames never overlap
const overlapArea = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const rootBoxes = (except = null) => S.scene.root.children.filter((n) => !n.hidden && n !== except).map((n) => ({ n, b: worldBounds(n) })).filter((x) => x.b && x.b[2] - x.b[0] > 0.5);
// move a top-level node to free space if it overlaps other content (measured on the render); returns a note or null
function placeFreely(path, { gap = 48 } = {}) {
  const n = node(path); if (!n || E.parentOf(S.scene, n) !== S.scene.root) return null;
  const b = worldBounds(n); if (!b) return null;
  const others = rootBoxes(n).map((x) => x.b);
  const [dx, dy] = freeTranslation(b, others, S.scene, gap);
  if (!dx && !dy) return null;
  commit((sc) => E.translate(sc, [n.id], dx, dy));
  return 'recolocado en espacio libre para no encimarse';
}
// grow (or, with shrink, fit) the canvas so every top-level element is inside, with a margin
function fitCanvas({ shrink = false, margin = 40 } = {}) {
  const boxes = rootBoxes(); if (!boxes.length) return null;
  const U = boxes.reduce((u, { b }) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const sx = U[0] < 0 || shrink ? Math.round(margin - U[0]) : 0, sy = U[1] < 0 || shrink ? Math.round(margin - U[1]) : 0;
  const W = Math.ceil(shrink ? U[2] - U[0] + 2 * margin : Math.max(S.scene.width, U[2] + sx + margin));
  const H = Math.ceil(shrink ? U[3] - U[1] + 2 * margin : Math.max(S.scene.height, U[3] + sy + margin));
  if (!sx && !sy && W === Math.round(S.scene.width) && H === Math.round(S.scene.height)) return null;
  commit((sc) => { if (sx || sy) E.translate(sc, sc.root.children.map((c) => c.id), sx, sy); sc.width = W; sc.height = H; });
  S.userView = false; fitView();
  return `lienzo ${shrink ? 'ajustado' : 'ampliado'} a ${W} × ${H}`;
}
function placeAndFit(path) { const notes = [placeFreely(path), fitCanvas()].filter(Boolean); return notes.join(' · ') || null; }

// ------------------------------------------------------------------------------------------------- assistant helpers
// render of the artboard (no animation, no data attributes) as PNG base64, for the AI to SEE the canvas
async function canvasPng(max = 768,selection=[]) {
  try {
    let box=[0,0,S.scene.width,S.scene.height];
    const boxes=selection.map(p=>S.scene.byPath.get(p)).filter(Boolean).map(worldBounds).filter(Boolean);
    if(boxes.length) {box=[Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];const pad=Math.max(4,(Math.max(box[2]-box[0],box[3]-box[1]))*.08);box=[box[0]-pad,box[1]-pad,box[2]+pad,box[3]+pad];}
    const width=Math.max(1,box[2]-box[0]),height=Math.max(1,box[3]-box[1]);
    const svg = renderScene(S.scene, { dataAttrs: false, animate: false }).replace(/viewBox="[^"]+"/,`viewBox="${box[0]} ${box[1]} ${width} ${height}"`).replace(/width="[^"]+"/,`width="${width}"`).replace(/height="[^"]+"/,`height="${height}"`);
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
    const k = Math.min(boxes.length?8:1, max / Math.max(width,height));
    const cv = document.createElement('canvas'); cv.width = Math.max(1,Math.round(width * k)); cv.height = Math.max(1,Math.round(height * k));
    const g = cv.getContext('2d'); g.fillStyle = '#ffffff'; if (S.scene.background === 'none') g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/png').split(',')[1];
  } catch { return null; }
}
// ICON PACKS drawn by the AI (trace/iconpack.js): inspected cell by cell, steered by the AI with pack levers and
// redraws; every change is kept only if the pack score improves. Returns null when the fragment is not a pack.
const packPrepare = (text) => preparePack(text, S.scene, rasterForScore);

const packApply = (pk, answer) => applyPack(pk, answer, rasterForScore);

async function packBlindPng(pk) {
  const icons = pk.P.findPack(pk.scene).children.filter((c) => c.type === 'group');
  const order = icons.map((ic, k) => ({ ic, key: (k * 7919 + 13) % 104729 })).sort((a, b) => a.key - b.key).map((x) => x.ic);
  const cols = Math.min(6, order.length), cw = 128, ch = 150, cv = document.createElement('canvas'); cv.width = cols * cw; cv.height = Math.ceil(order.length / cols) * ch;
  const g = cv.getContext('2d'); g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, cv.width, cv.height);
  for (const [k, icon] of order.entries()) {
    const x = (k % cols) * cw, y = Math.floor(k / cols) * ch;
    const cell = { ...pk.scene, width: 24, height: 24, background: 'none', root: { ...pk.scene.root, children: [{ ...JSON.parse(JSON.stringify(icon)), at: [0, 0] }] } };
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderScene(cell, { dataAttrs: false, animate: false })); await img.decode();
    g.drawImage(img, x + 16, y + 6, 96, 96); g.drawImage(img, x + 52, y + 108, 24, 24);
    g.fillStyle = '#C00'; g.font = 'bold 13px sans-serif'; g.fillText(String(k + 1), x + 4, y + 16);
  }
  const meanings = [...icons.map((ic) => ic.label || ic.name)].sort((a, b) => ((a.length * 31 + a.charCodeAt(0)) % 17) - ((b.length * 31 + b.charCodeAt(0)) % 17));
  return { png: cv.toDataURL('image/png').split(',')[1], order: order.map((ic) => ic.name), meanings, count: order.length };
}
// blind answers -> recognition per icon (ok / read as), then the pack is inspected again with it
const packSetRecognition = (pk, blind, answers) => setPackRecognition(pk, blind, answers, rasterForScore);

async function packReviewPng(pk) {
  const pack = pk.P.findPack(pk.scene), icons = pack.children.filter((c) => c.type === 'group'), cols = Math.min(6, icons.length), cw = 128, ch = 168;
  const cv = document.createElement('canvas'); cv.width = cols * cw; cv.height = Math.ceil(icons.length / cols) * ch;
  const g = cv.getContext('2d'); g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, cv.width, cv.height);
  for (const [k, icon] of icons.entries()) {
    const x = (k % cols) * cw, y = Math.floor(k / cols) * ch, info = pk.ins.icons.find((i) => i.name === icon.name);
    const cell = { ...pk.scene, width: 24, height: 24, background: 'none', root: { ...pk.scene.root, children: [{ ...JSON.parse(JSON.stringify(icon)), at: [0, 0] }] } };
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderScene(cell, { dataAttrs: false, animate: false })); await img.decode();
    g.strokeStyle = info?.issues.length ? '#FF1E1E' : '#DDDDDD'; g.lineWidth = info?.issues.length ? 3 : 1; g.strokeRect(x + 16, y + 6, 96, 96);
    g.drawImage(img, x + 16, y + 6, 96, 96); g.drawImage(img, x + 52, y + 110, 24, 24);
    g.fillStyle = '#222'; g.font = '11px sans-serif'; g.textAlign = 'center'; g.fillText(`${icon.name}${info?.issues.length ? ` (${info.issues.length})` : ''}`, x + cw / 2, y + 152);
  }
  return cv.toDataURL('image/png').split(',')[1];
}
// illustrator mode: an ARU fragment written by the AI, compiled in the document's canvas space, inserted as one group
function insertAru(text, label, into = null) {
  const head = `canvas ${S.scene.width} ${S.scene.height}\nbackground none\n`;
  const r = compileAru(head + text);
  if (!r.scene || r.errors.length) return { ok: false, errors: (r.errors.length ? r.errors : [{ message: 'no se pudo compilar' }]).slice(0, 5).map((e) => `${e.line ? `L${e.line - 2}: ` : ''}${e.message}`) };
  const layers = r.scene.byId.size - 1;
  if (!r.scene.root.children.length) return { ok: false, errors: ['el fragmento no contiene capas'] };
  // INTO an existing group (a shine on an icon): written in canvas coordinates, wrapped with the inverse of the group's
  // placement, added above its content and NOT moved by the free-space placement
  const target = into ? node(into) : null;
  if (into && (!target || target.type !== 'group')) return { ok: false, errors: [`no existe el grupo «${into}»`] };
  if (target) {
    const name = label || 'Capa IA';
    // Validate the complete transaction before changing the live document.
    const checked = readDocument(S.text).scene;
    try { insertInto(checked, r.scene, into, name); }
    catch (e) { return { ok: false, errors: [e.message] }; }
    load(toAru(checked), { record: true, keepSel: true });
    return { ok: true, layers, label: name, note: `dentro de «${target.label || target.name}»` };
  }
  const name = label || (r.scene.root.children.length === 1 ? E.displayName(r.scene.root.children[0]) : 'Ilustración IA');
  const fragment = withOpaqueBackground(r.scene, { color: S.scene.background, bounds: fragmentBounds(r.scene) });
  commit((sc) => E.insertFragment(sc, fragment, { label: name }), `Dibujado: ${name}`);
  const note = S.sel[0] ? placeAndFit(S.sel[0]) : null;
  return { ok: true, layers: layers + 1, label: name, note: [note, 'fondo opaco editable'].filter(Boolean).join(' · ') };
}
// Measure the actual drawing (including text) instead of giving every generated fragment an artboard-sized frame.
function fragmentBounds(scene) {
  const div = document.createElement('div'); div.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
  div.innerHTML = renderScene({ ...scene, background: 'none' }, { dataAttrs: false, animate: false });
  document.body.appendChild(div);
  try {
    const b = div.querySelector('svg').getBBox();
    // getBBox measures geometry; leave room for wide strokes and soft shadows too.
    let margin = 1;
    const visit = (n, scale = 1, stroke = null, width = 1) => {
      const k = scale * Math.max(...(n.scale || [1, 1]).map(Math.abs));
      const paint = n.stroke ?? stroke, sw = n.stroke != null ? n.strokeWidth : width;
      if (paint && paint !== 'none') margin = Math.max(margin, (sw || 1) * k / 2 + 1);
      if (n.shadow) margin = Math.max(margin, (Math.max(Math.abs(n.shadow.dx), Math.abs(n.shadow.dy)) + 2 * n.shadow.blur) * k + 1);
      for (const c of n.children || []) visit(c, k, paint, sw);
    };
    visit(scene.root);
    return [Math.floor(b.x - margin), Math.floor(b.y - margin), Math.ceil(b.x + b.width + margin), Math.ceil(b.y + b.height + margin)];
  } finally { div.remove(); }
}
// reference: the AI described the parts (context); the ReferenceTracer measures the pixels; the plain backdrop is dropped.
// Three steps so the chat can refine before anything is inserted:
//   traceRefState(att, ref)  auto-tune -> state { raw, context, best, tried }
//   retraceRef(state, tune)  one more candidate (an AI proposal); kept only if its score is higher
//   insertRef(state, att, ref)
async function traceRefState(att, ref, progress = () => {}) {
  const { loadImageBrowser } = await import('../trace/image.js');
  const raw = await loadImageBrowser(`data:${att.mime};base64,${att.data}`);
  return traceReferenceState(raw, ref, { rasterize: rasterForScore, progress });
}

const retraceRef = (st, tune) => retuneReference(st, tune, rasterForScore);

async function compareRefPng(st) {
  const raw = st.raw, half = Math.min(512, raw.width), k = half / raw.width, h = Math.round(raw.height * k);
  const src = document.createElement('canvas'); src.width = raw.width; src.height = raw.height;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raw.data), raw.width, raw.height), 0, 0);
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderScene(st.best.scene, { dataAttrs: false, animate: false })); await img.decode();
  const cv = document.createElement('canvas'); cv.width = half * 2 + 8; cv.height = h;
  const g = cv.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, h);
  g.drawImage(src, 0, 0, half, h); g.drawImage(img, half + 8, 0, half, h);
  return cv.toDataURL('image/png').split(',')[1];
}
// which traced paths stay when a reference is inserted: the plain backdrop (regions touching the image border in its
// dominant colour) and degenerate slivers go
const refKeep = referenceKeep;

const glyphPrepare = prepareGlyph;

const glyphRetune = retuneGlyph;

async function glyphReviewPng(st, ref) {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(glyphReviewSvg(st, ref)); await img.decode();
  const canvas = document.createElement('canvas'); canvas.width = 744; canvas.height = 560; canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}
async function insertRef(st, att, ref, guard = () => true) {
  const result = await referenceFragment(st, ref, S.scene.background);
  if (!guard()) throw new Error('El documento cambió durante el trazado');
  const { scene, width: sw, height: sh } = result;
  const bw = ref.w ?? S.scene.width * 0.6, bh = ref.h ?? S.scene.height * 0.6, k = Math.min(bw / sw, bh / sh);
  const cx = ref.x ?? S.scene.width / 2, cy = ref.y ?? S.scene.height / 2;
  commit((sc) => E.insertFragment(sc, scene, { at: [r2(cx - (sw * k) / 2), r2(cy - (sh * k) / 2)], scale: r2(k * 1000) / 1000, label: ref.label || att.name }), `Referencia vectorizada: ${ref.label || att.name}`);
  const note = S.sel[0] ? placeAndFit(S.sel[0]) : null;
  const { scene: _, width: __, height: ___, ...report } = result;
  return { ...report, note: [report.note, note].filter(Boolean).join(' · ') || null };
}

async function piecesRef(st) {
  const [{ buildSegments }, { inkRaster }] = await Promise.all([import('../trace/segments.js'), import('../trace/ink.js')]);
  const ink = st.best.inkData;
  const seg = buildSegments(st.best.res.T, ink ? { inkMask: inkRaster(ink), inkW: ink.width, inkH: ink.height } : {});
  st.pieces = { seg, forBest: st.best };
  const raw = st.raw, k = Math.min(1, 900 / Math.max(raw.width, raw.height)), W = Math.round(raw.width * k), H = Math.round(raw.height * k);
  const src = document.createElement('canvas'); src.width = raw.width; src.height = raw.height;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raw.data), raw.width, raw.height), 0, 0);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H); g.drawImage(src, 0, 0, W, H);
  // borders: piece label changes, drawn at the output scale (2 px white with a dark core)
  const sw = seg.width, sh = seg.height, L = seg.labels, sx = W / sw, sy = H / sh;
  g.fillStyle = 'rgba(255,255,255,0.95)';
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const l = L[y * sw + x];
    if (x < sw - 1 && L[y * sw + x + 1] !== l) g.fillRect((x + 1) * sx - 1, y * sy, 2, Math.ceil(sy));
    if (y < sh - 1 && L[(y + 1) * sw + x] !== l) g.fillRect(x * sx, (y + 1) * sy - 1, Math.ceil(sx), 2);
  }
  g.font = 'bold 15px -apple-system, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const p of seg.segments) {
    const x = (p.anchor[0] + 0.5) * sx, y = (p.anchor[1] + 0.5) * sy, t = String(p.id), w = g.measureText(t).width + 8;
    g.fillStyle = 'rgba(0,0,0,0.85)'; g.fillRect(x - w / 2, y - 10, w, 20);
    g.fillStyle = '#FFE14D'; g.fillText(t, x, y + 1);
  }
  return { png: cv.toDataURL('image/png').split(',')[1], count: seg.segments.length };
}
// group the winning geometry by the AI's parts (layers: Fondo, brazo, ojo, pelaje… and Tinta › each part).
// assignments [{ piece, part }] (from the pieces image) decide the part of each piece; polygons refine inside it.
// Only the grouping changes; it is re-scored and kept only if the render is the same (score within 0.003)
const groupRef = (st, assignments = null) => groupReference(st, assignments, rasterForScore);

async function traceReference(att, ref) { const st = await traceRefState(att, ref); await groupRef(st); return await insertRef(st, att, ref); }

// ------------------------------------------------------------------------------------------------- present
function present() {
  $('#presentArt').innerHTML = renderScene(S.scene, { dataAttrs: false });
  const svg = $('#presentArt svg'); const k = Math.min(innerWidth * 0.9 / S.scene.width, innerHeight * 0.85 / S.scene.height);
  svg.setAttribute('width', S.scene.width * k); svg.setAttribute('height', S.scene.height * k);
  $('#present').classList.add('on');
}

// ------------------------------------------------------------------------------------------------- boot
function bootDesktop() {
  if (!isDesktop()) return;
  document.body.classList.add('desktop');
  const top = $('#top');
  top.setAttribute('data-tauri-drag-region', '');
  for (const el of $$('.brand, .crumbs > span, .spacer', top)) el.setAttribute('data-tauri-drag-region', '');
}
function boot() {
  bootDesktop();
  // keyframes for the animation tiles in the properties panel
  const st = document.createElement('style');
  st.textContent = Object.entries(PRESETS).map(([k, v]) => `@keyframes aru-${k}{${v}}`).join('') + '#art.paused [class^="aru-a-"],#art.paused [class^="aru-a-"] *{animation:none!important}';
  document.head.appendChild(st);
  const stage = $('#stage');
  stage.addEventListener('pointerdown', (e) => { if (e.target.closest('#toolbar')) return; stage.setPointerCapture(e.pointerId); onPointerDown(e); });
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('dblclick', onDblClick);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); if (e.ctrlKey || e.metaKey) { const [x, y] = stagePt(e); zoomAt(Math.exp(-e.deltaY * 0.0022), x, y); } else { S.userView = true; S.pan = [S.pan[0] - e.deltaX, S.pan[1] - e.deltaY]; applyView(); } }, { passive: false });
  // keep the artboard fitted while the window settles / resizes, until the user moves the view
  new ResizeObserver(() => { if (S.scene && !S.userView) fitView(); else drawOverlay(); }).observe(stage);
  addEventListener('keydown', onKey);
  addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; $('#stage').classList.remove('panning'); } });
  addEventListener('resize', () => drawOverlay());
  for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  $('#btnUndo').addEventListener('click', undo); $('#btnRedo').addEventListener('click', redo);
  $('#zoomIn').addEventListener('click', () => { const r = stage.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); });
  $('#zoomOut').addEventListener('click', () => { const r = stage.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); });
  $('#zoomFit').addEventListener('click', fitView);
  $('#filter').addEventListener('input', (e) => { S.filter = e.target.value; renderLayers(); });
  $('#btnSelectFiltered').addEventListener('click', () => { const m = matchesFilter(); if (!m) { select(S.scene.root.children.map((n) => n.path)); return; } select([...m].filter((p) => !isLocked(node(p)))); toast(`${S.sel.length} capas seleccionadas`); });
  for (const b of $$('#leftTabs button')) b.addEventListener('click', () => { $$('#leftTabs button').forEach((x) => x.classList.toggle('on', x === b)); $('#leftLayers').style.display = b.dataset.tab === 'layers' ? 'flex' : 'none'; $('#docs').style.display = b.dataset.tab === 'docs' ? 'block' : 'none'; });
  for (const b of $$('#drawerTabs [data-pane]')) b.addEventListener('click', () => { $$('#drawerTabs [data-pane]').forEach((x) => x.classList.toggle('on', x === b)); $$('.pane').forEach((p) => p.classList.toggle('on', p.id === b.dataset.pane)); });
  $('#btnCode').addEventListener('click', () => { $('#drawer').classList.toggle('open'); setTimeout(drawOverlay, 220); });
  $('#btnCloseDrawer').addEventListener('click', () => { $('#drawer').classList.remove('open'); setTimeout(drawOverlay, 220); });
  $('#code').addEventListener('input', onCode);
  $('#btnBatch').addEventListener('click', runBatch);
  $('#btnBatchPreview').addEventListener('click', () => { try { showBatchPreview(readBatch()); } catch (e) { toast(e.message, true); } });
  $('#btnBatchExample').addEventListener('click', () => { $('#batchIn').value = BATCH_EXAMPLE; });
  $('#btnAI').addEventListener('click', async () => { const t = aiContext(); try { await navigator.clipboard.writeText(t); toast('Contexto IA copiado: pégalo en Claude y pega su respuesta en Lote / IA'); } catch { $('#drawer').classList.add('open'); $('#drawerTabs [data-pane="batchPane"]').click(); $('#batchIn').value = t; } });
  for (const m of $$('.menu')) { m.querySelector('[data-menu]').addEventListener('click', (e) => { e.stopPropagation(); m.classList.toggle('open'); }); }
  addEventListener('click', () => $$('.menu.open').forEach((m) => m.classList.remove('open')));
  bindActs($('#top')); bindActs($('#layerFoot'));
  $('#docName').addEventListener('change', (e) => { if (S.doc) renameDoc(S.doc.id, e.target.value).catch((err) => toast(err.message, true)); });
  const showProjects=()=>{if(embedded) return;openPanel('left');$('#leftTabs [data-tab="docs"]').click();};
  $('#crumbProject').addEventListener('click',showProjects);$('#workspaceProject').addEventListener('click',showProjects);
  for(const side of ['left','right']) $('#toggle'+(side==='left'?'Left':'Right')).addEventListener('click',()=>{S.panels[side+'Collapsed']=!S.panels[side+'Collapsed'];renderPanels();store.set('aru-panels',S.panels);});
  renderPanels();
  $('#btnPresent').addEventListener('click', present);
  $('#btnClosePresent').addEventListener('click', () => $('#present').classList.remove('on'));
  $('#present').addEventListener('click', (e) => { if (!e.target.closest('.close')) present(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#present').classList.remove('on'); });
  $('#fileIn').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; await createDoc({ name: f.name.replace(/\.aru$/, ''), text: await f.text() }); toast('Archivo importado como documento nuevo'); e.target.value = ''; });
  $('#imgIn').addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; traceImage(URL.createObjectURL(f), { name: f.name.replace(/\.[a-z]+$/i, '') }); e.target.value = ''; });
  bindLayers();
  // assistant chat: context = the AI outline of the document; operations go through the batch layer as ONE undo step
  const chat = chatApi = initChat($('#chat'), {
    ...(embedded ? { version: () => embedRevision, detectAgents: () => embedded.agent('detect'), runAgent: args => embedded.agent('run', args), cancelAgent: runId => embedded.agent('cancel', { runId }) } : {}),
    version: () => documentRevision,
    context: () => aiContextForChat(),
    workspace: activeWorkspace,
    getText: () => S.text,
    commitProduction: text => load(text, { record: true, keepSel: true }),
    rasterizeProduction: rasterForScore,
    productionProgress: job => embedded?.production({ job, document: { text: S.text, name: S.name, revision: embedRevision } }),
    selection: () => S.sel.slice(),
    selectionNames: paths => paths.map(p=>{const n=S.scene.byPath.get(p);return n?E.displayName(n):p;}),
    previewRefinement: (ops, options) => createIllustrator({ text: S.text, selection: S.sel }).previewRefinement(ops, options),
    refinementScope: (mode,selection=S.sel) => ({ ...refinementScope(S.text, { selection, mode }), expectedRevision: documentRevision }),
    refine: (ops, options) => { if (options.expectedRevision != null && options.expectedRevision !== documentRevision) throw new Error('El documento cambió; pide un refinamiento nuevo'); const r = createIllustrator({ text: S.text, selection: S.sel }).previewRefinement(ops, options); load(r.text, { record: true, keepSel: true }); return r; },
    depth: () => S.past.length,
    previewOperations: (ops,{selection=S.sel}={}) => createIllustrator({text:S.text,selection}).preview(ops),
    apply: (ops,{selection=S.sel,expectedRevision}={}) => {
      if(expectedRevision!=null && expectedRevision!==documentRevision) throw new Error('El documento cambió; solicita el cambio de nuevo');
      const before=new Set(S.scene.byPath.keys()),r=createIllustrator({text:S.text,selection}).preview(ops);
      load(r.text,{record:true,keepSel:true});
      const createdPaths=[...S.scene.byPath.keys()].filter(p=>!before.has(p));
      return {...r,createdPaths};
    },
    undoRange: (from, to) => { if (S.past.length !== to) return false; while (S.past.length > from) undo(); return true; },
    snapshot: selection => canvasPng(768,selection),
    insertAru: (text, label, into) => insertAru(text, label, into),
    traceReference: (att, ref) => traceReference(att, ref),
    traceRefState: (att, ref, progress) => traceRefState(att, ref, progress),
    retraceRef: (st, tune) => retraceRef(st, tune),
    compareRefPng: (st) => compareRefPng(st),
    insertRef: (st,att,ref,active=()=>true) => {const rev=documentRevision,id=S.doc?.id,epoch=embedEpoch;return insertRef(st,att,ref,()=>active()&&documentRevision===rev&&S.doc?.id===id&&embedEpoch===epoch);},
    groupRef: (st, assignments) => groupRef(st, assignments),
    glyphPrepare: (st, ref) => glyphPrepare(st, ref),
    packPrepare: (text) => packPrepare(text),
    packApply: (pk, answer) => packApply(pk, answer),
    packReviewPng: (pk) => packReviewPng(pk),
    packBlindPng: (pk) => packBlindPng(pk),
    packSetRecognition: (pk, blind, answers) => packSetRecognition(pk, blind, answers),
    packFragment: (pk) => pk.P.packFragment(pk.scene),
    glyphRetune: (st, params) => glyphRetune(st, params),
    glyphReviewPng: (st, ref) => glyphReviewPng(st, ref),
    piecesRef: (st) => piecesRef(st),
    toast,
  });
  for (const b of $$('#rightTabs button')) b.addEventListener('click', () => {
    openPanel('right');
    S.rtab = b.dataset.rtab; $$('#rightTabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('#props').style.display = S.rtab === 'props' ? '' : 'none'; $('#chat').style.display = S.rtab === 'chat' ? 'flex' : 'none';
    if (S.rtab === 'chat') { chat.refresh(); $('#chatIn')?.focus(); }
  });
  if (embedded) { bootEmbedded(); return; }
  bindDocs();
  (async () => {
    S.lib = await openLibrary();
    await ensureStartDoc();
    S.projects = (await S.lib.list()).projects;
    const all = S.projects.flatMap((p) => p.docs);
    let last = null; try { last = localStorage.getItem('aru-last-doc'); } catch { /* ignore */ }
    const start = all.find((d) => d.id === last) || all[0];
    if (start) await openDoc(start.id);
  })().catch((e) => toast(`No se pudo abrir la biblioteca: ${e.message}`, true));
  addEventListener('beforeunload', () => { if (saveTimer) flushSave(); });
}
function bootEmbedded() {
  const style = document.createElement('style');
  style.textContent = '[data-tab="docs"],#crumbProject,[data-act="newProject"],[data-act="duplicateDoc"],[data-act="workspace"],[data-act="lab"],[data-act="trace"]{display:none!important}'; document.head.appendChild(style);
  load(EMPTY_DOCUMENT, { fit: true });
  $('#docName').addEventListener('change', e => { S.name = e.target.value || 'Sin título'; save(); });
  for (const b of document.querySelectorAll('[data-act="new"],[data-act="open"]')) b.disabled = true;
  chatApi.setDoc(`embed:${++embedEpoch}`);
  embedded.bind(async (method, args = {}) => {
    const session = () => createIllustrator({ text: S.text, name: S.name, selection: S.sel });
    const doc = () => ({ text: S.text, name: S.name, revision: embedRevision });
    if (method === 'document') return doc();
    if (method === 'project') {S.embeddedProject=projectContext(args.project);documentRevision++;embedRevision++;chatApi.stopProduction();renderWorkspace();return S.embeddedProject;}
    if (method === 'context') return { ...sceneContext(S.scene, { name: S.name, selection: S.sel, project:activeProject(), measureBounds: worldBounds }), revision: embedRevision };
    if (method === 'load') { const prepared = readDocument(args.text, {dataAttrs:true}); embedEpoch++; S.past = []; S.future = []; S.sel = []; chatApi.setDoc(`embed:${embedEpoch}`); load(args.text, { name: args.name, fit: true, prepared }); return doc(); }
    if (method === 'select') { if (!Array.isArray(args.paths) || args.paths.some(p => !S.scene.byPath.has(p))) throw new Error('Selección inválida'); select(args.paths); return S.sel; }
    if (method === 'refine') { if (args.expectedRevision != null && args.expectedRevision !== embedRevision) throw new Error('El documento cambió'); const r = session().previewRefinement(args.operations, args); load(r.text, { record: true, keepSel: true }); chatApi.recordPaint(args.operations,r.log,args.selection || S.sel); return { ...doc(), changed: r.changed, geometryPreserved: r.geometryPreserved, log: r.log }; }
    if (method === 'exportIcons') { const r = await buildIconArchive(S.text, args, async (scene, size) => { const url = await opaquePng(scene, renderScene, { width: size, height: size }); return Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0)); }); return { ...r, data: Array.from(r.data) }; }
    if (method === 'preview') return session().preview(args.operations);
    if (method === 'apply') { if (args.expectedRevision != null && args.expectedRevision !== embedRevision) throw new Error('El documento cambió'); const r = session().preview(args.operations); load(r.text, { record: true, keepSel: true }); chatApi.recordPaint(args.operations,r.log,S.sel); return { ...doc(), log: r.log }; }
    if (method === 'insert') { const r = insertAru(args.text, args.label, args.into); if (!r.ok) throw new Error(r.errors.join('; ')); return { ...doc(), report: r }; }
    if (method === 'trace') {
      const epoch = embedEpoch, rev = embedRevision;
      const st = await traceRefState(args.image, args.reference, () => {});
      await groupRef(st);
      if (embedEpoch !== epoch || embedRevision !== rev) throw new Error('El documento cambió durante el trazado');
      const report = await insertRef(st, args.image, args.reference, () => embedEpoch === epoch && embedRevision === rev); return { ...doc(), report };
    }
    if (method === 'ask') { $('#rightTabs [data-rtab="chat"]').click(); const report = await chatApi.request(args.message, args.options); return { ...doc(), report }; }
    if (method === 'production') return chatApi.getProduction();
    if (method === 'stopProduction') return chatApi.stopProduction();
    if (method === 'revalidateProduction') return chatApi.revalidateProduction(args.job);
    if (method === 'resumeProduction') { $('#rightTabs [data-rtab="chat"]').click(); const report = await chatApi.resumeProduction(args.job); return { ...doc(), report }; }
    if (method === 'svg') return renderScene(S.scene, { dataAttrs: false, animate: false });
    if (method === 'png') return opaquePng(S.scene, renderScene);
    if (method === 'undo') { undo(); return doc(); }
    if (method === 'redo') { redo(); return doc(); }
    throw new Error(`Método desconocido: ${method}`);
  });
}
boot();
