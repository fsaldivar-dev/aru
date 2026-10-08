import { resolveCreatedOperations } from './assistant-flow.js';
import { assistantFlow, validateAssistantAnswer } from './assistant-flow.js';
import { refinementSystem } from './refinement.js';
import { createReferenceStore, chooseReferenceImages } from './chat-references.js';
import { appendOutcome, recoverInterruptedMessages } from './chat-outcomes.js';
import { needsPackRecognition } from './pack-tools.js';
import { modelOptions, validModel } from './model-options.js';
import { listStyles, resolveStyle } from '../plugin/styles.js';
import { productionBrief, briefPrompt } from './production-brief.js';
import { opaquePng } from './opaque.js';
import { renderScene } from './render.js';
import { listMaterials } from './materials.js';
import { createIconJob, requestedIconCount, runIconJob, productionStatus, synchronizeIconJob, revalidateIconJob, productionReview, PRODUCTION_REVIEW_SCHEMA } from './icon-production.js';
// Assistant panel: chat with the AI CLIs installed on this machine (Claude, Codex, Antigravity, Gemini).
// Each message can carry images: a render of the artboard ("ver lienzo") and reference images the user attaches.
// The answer may contain: batch operations, a reference to vectorize (AI gives context, the tracer draws) and, in
// illustrator mode, an ARU fragment. Everything one answer does is undone with one click.
import { PROVIDERS, systemPrompt, ANSWER_SCHEMA, buildPrompt, parseAnswer, detectAgents as defaultDetectAgents, runAgent as defaultRunAgent, cancelAgent as defaultCancelAgent, isDesktop, REVIEW_SCHEMA, REVIEW_SYSTEM, buildReviewPrompt, PIECES_SCHEMA, PIECES_SYSTEM, buildPiecesPrompt, GLYPH_SCHEMA, GLYPH_SYSTEM, buildGlyphPrompt, PACK_SCHEMA, packSystem, buildPackPrompt, BLIND_SCHEMA, BLIND_SYSTEM, buildBlindPrompt, extractStructured } from './agents.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const embedMode = typeof location !== 'undefined' && !!new URLSearchParams(location.search).get('embed');
const store = { get(k) { if (embedMode) return null; try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { if (embedMode) return true; try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } } };

// small, safe Markdown: escape first, then **bold**, *italic*, `code`, lists, paragraphs
export function md(text) {
  const lines = esc(text).split('\n'), out = [];
  let list = null;
  const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  for (const l of lines) {
    const m = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(l);
    if (m) { const t = m[1] ? 'ol' : 'ul'; if (list !== t) { if (list) out.push(`</${list}>`); out.push(`<${t}>`); list = t; } out.push(`<li>${inline(m[2])}</li>`); continue; }
    if (list) { out.push(`</${list}>`); list = null; }
    out.push(l.trim() ? `<p>${inline(l)}</p>` : '');
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

const SUGGEST = {create:['Un icono para automatizaciones móviles', 'Crea 24 iconos para un reproductor de música'],refine:['Conserva la silueta y mejora el contraste', 'Suaviza las curvas sin borrar esquinas'],consult:['¿Qué ves en el lienzo?', '¿Qué mejoraría la legibilidad a 24 px?']};

export function initChat(host, api) {
  const runAgent = api.runAgent || defaultRunAgent, detectAgents = api.detectAgents || defaultDetectAgents, cancelAgent = api.cancelAgent || defaultCancelAgent;
  const prefs = store.get('aru-chat-prefs') || {};
  const references = createReferenceStore({persistent:!embedMode});
  const C = {
    agents: null, provider: prefs.provider || 'claude', models: prefs.models || {}, auto: prefs.auto !== false,
    canvas: prefs.canvas !== false, illustrator: !!prefs.illustrator, review: Number.isInteger(prefs.review) ? prefs.review : 1,
    style: prefs.style || '', material: prefs.material || '', color: prefs.color || '', accent: prefs.accent || '', purpose: '', countMode: undefined,
    mode:'create', kind:'illustration', quantity:24, kindExplicit:false, quantityEdited:false, error:'', recipes:{create:{style:prefs.style||'',material:prefs.material||'',color:prefs.color||'',accent:prefs.accent||''},refine:prefs.refineAppearance||{style:'',material:'',color:'',accent:''}}, refine: 'style', suggestion:null, refsReady:Promise.resolve(), refsLoading:false, referenceWarning:'', docId: null, messages: [], busy: null, pending: [], refs: new Map(), refSeq: store.get('aru-chat-refseq') || 0, job: null, controller: null,
  };
  const savePrefs = () => {
    if(C.mode!=='consult') C.recipes[C.mode]=Object.fromEntries(['style','material','color','accent'].map(k=>[k,C[k]]));
    store.set('aru-chat-prefs',{provider:C.provider,models:C.models,canvas:C.canvas,review:C.review,...C.recipes.create,refineAppearance:C.recipes.refine});
  };
  // one conversation per document
  const saveMsgs = () => { if (C.docId) store.set(`aru-chat:${C.docId}`, C.messages.slice(-60)); store.set('aru-chat-refseq', C.refSeq); };
  const loadMsgs = id => {
    const saved=store.get(`aru-chat:${id}`),messages=recoverInterruptedMessages(Array.isArray(saved)?saved:[]);
    if(messages.length!==(saved?.length||0)) store.set(`aru-chat:${id}`,messages.slice(-60));
    return messages;
  };
  const saveOutcome = (docId,outcome,fallback=[]) => {
    const saved=C.docId===docId?C.messages:store.get(`aru-chat:${docId}`);
    const messages=appendOutcome(Array.isArray(saved)?saved:fallback,outcome);
    if(C.docId===docId) {C.messages=messages;saveMsgs();render();}
    else store.set(`aru-chat:${docId}`,messages.slice(-60));
  };

  host.innerHTML = `
    <div id="chatFlowHeader">
      <div class="flow-tabs" role="group" aria-label="Tarea del asistente"><button data-flow="create" aria-pressed="true">Crear</button><button data-flow="refine" aria-pressed="false">Refinar</button><button data-flow="consult" aria-pressed="false">Consultar</button></div>
      <p id="chatFlowHint" class="flow-help"></p>
    </div>
    <div class="chat-scroll" id="chatScroll">
    <div class="chat-head">
      <div id="chatCreateFields" class="flow-form">
        <div class="flow-row"><label class="flow-field">Resultado<select id="chatKind"><option value="illustration">Ilustración</option><option value="app-icon">Icono de app</option><option value="icon-pack">Pack de iconos</option></select></label><label id="chatQuantityField" class="flow-field" hidden>Cantidad<input id="chatQuantity" type="number" min="1" max="1000" value="24" inputmode="numeric"></label></div>
      </div>
      <div id="chatRefineFields" class="flow-form" hidden>
        <div id="chatTarget" class="flow-target"></div>
        <label class="flow-field">Qué quieres mejorar<select id="chatRefine"><option value="style">Color y acabado</option><option value="contour">Limpiar trazos</option><option value="redraw">Redibujar formas</option></select></label>
        <p id="chatRefineHelp" class="flow-help"></p>
      </div>
      <label id="chatPurposeField" class="flow-field">¿Para qué se usará?<input id="chatPurpose" placeholder="Ej. una app de automatizaciones móviles" maxlength="800"></label>
      <details id="chatAppearance" class="flow-appearance">
        <summary>Dirección visual <small id="chatAppearanceSummary">Opcional</small></summary>
        <div class="flow-form">
          <label class="flow-field">Estética<select id="chatStyle" aria-label="Estética"><option value="">Definir con mi descripción</option>${listStyles().map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
          <label class="flow-field">Acabado de superficie<select id="chatMaterial" aria-label="Acabado de superficie"><option value="">Según mi descripción</option>${listMaterials().map(m=>`<option value="${m.id}">${m.label}</option>`).join('')}</select></label>
          <p class="flow-help">La estética guía el lenguaje visual. El acabado añade luces y volumen: Fruits, cromado, cristal…</p>
          <div class="flow-colors"><label class="flow-field">Color principal<input id="chatColor" placeholder="#RRGGBB" maxlength="7" aria-label="Color principal"></label><label class="flow-field">Acento<input id="chatAccent" placeholder="#RRGGBB" maxlength="7" aria-label="Color de acento"></label></div>
          <p id="chatAppearanceTiming" class="flow-help"></p>
          <button class="btn sm" id="chatApplyAppearance" hidden>Aplicar acabado ahora</button>
        </div>
      </details>
      <details class="chat-settings" id="chatSettings"><summary>Motor y revisión <span id="chatIdentity" class="chat-identity"></span></summary>
        <div class="prov" id="chatProv"></div>
        <label class="chat-model-field">Modelo<select id="chatModel" aria-label="Modelo"></select></label>
        <label class="chat-model-field" id="chatCustomModelField" hidden>Modelo personalizado<input id="chatCustomModel" aria-label="Modelo personalizado" placeholder="ID del modelo" spellcheck="false"></label>
        <div class="line toggles"><label><input type="checkbox" id="chatCanvas"> Compartir vista del lienzo</label><label>Revisión visual <select id="chatReview"><option value="0">Sin revisión</option><option value="1">1 ronda</option><option value="2">2 rondas</option></select></label></div>
        <div class="faint" id="chatNote"></div>
      </details>
    </div>
    <div id="chatProduction" class="chat-production" hidden></div>
    <div class="conversation-tools"><span>Conversación</span><button class="link" id="chatClear">Limpiar</button></div>
    <div class="chat-log" id="chatLog"></div>
    </div>
    <div class="chat-compose" id="chatCompose">
      <div class="chat-active" id="chatActive" hidden><span id="chatActiveStatus"></span><button class="link" id="chatStopCompose">Detener</button></div>
      <div id="chatPlan" class="flow-plan"></div>
      <div class="atts" id="chatAtts"></div>
      <label id="chatInLabel" class="flow-input-label" for="chatIn">Describe lo que quieres crear</label>
      <textarea id="chatIn" rows="3" placeholder="Tema, formas y detalles que deben aparecer…"></textarea>
      <p id="chatError" class="flow-error" role="alert" hidden></p>
      <button class="btn sm" id="chatCorrect" hidden>Ir a Redibujar formas</button>
      <p id="chatReferenceWarning" class="flow-help" role="status" hidden></p>
      <div class="line chat-actions"><button class="btn sm icon" id="chatAttach" title="Añadir imagen de referencia"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.5 12.6 21a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/></svg></button><span class="faint" id="chatCtx"></span><button class="btn sm primary" id="chatSend">Crear ilustración</button></div>
      <input type="file" id="chatFile" accept="image/png,image/jpeg,image/webp" multiple hidden>
    </div>`;
  const $ = (s) => host.querySelector(s);

  const recipe = () => Object.fromEntries(['style','material','color','accent'].map(k=>[k,C[k]]));
  const currentFlow = text => assistantFlow({mode:C.mode,kind:C.kind,quantity:Number(C.quantity),purpose:C.purpose,refinement:C.refine,selection:api.selection(),message:text,hasReferences:!!C.pending.length,...recipe()});
  function inferRequest() {
    const count=requestedIconCount($('#chatIn').value);
    if(C.mode==='create' && count>1 && (!C.kindExplicit || C.kind==='icon-pack')) {
      C.kind='icon-pack';$('#chatKind').value=C.kind;
      if(!C.quantityEdited) {C.quantity=count;$('#chatQuantity').value=String(count);}
    }
  }
  function setMode(mode) {
    if(!['create','refine','consult'].includes(mode)) return;
    if(C.mode!=='consult') C.recipes[C.mode]=recipe();
    C.mode=mode; C.error='';C.suggestion=null;
    if(mode!=='consult') {Object.assign(C,C.recipes[mode] || {style:'',material:'',color:'',accent:''});for(const [id,key] of [['chatStyle','style'],['chatMaterial','material'],['chatColor','color'],['chatAccent','accent']]) $('#'+id).value=C[key];}
    render();
  }
  function renderWorkflow() {
    const creating=C.mode==='create',refining=C.mode==='refine',painting=refining&&['style','redraw'].includes(C.refine),sel=C.busy&&refining&&C.activeSelection?C.activeSelection:api.selection();
    for(const b of host.querySelectorAll('[data-flow]')) {b.setAttribute('aria-pressed',String(b.dataset.flow===C.mode));b.disabled=!!C.busy;}
    $('#chatFlowHint').textContent=creating?'De una idea o referencia a piezas nuevas y editables.':refining?'Trabaja sobre la selección: elige qué conservar y qué redibujar.':'Preguntas y orientación sobre tu proyecto. El lienzo no se modifica.';
    $('#chatCreateFields').hidden=!creating;$('#chatQuantityField').hidden=C.kind!=='icon-pack';$('#chatRefineFields').hidden=!refining;$('#chatPurposeField').hidden=!creating;
    $('#chatAppearance').hidden=!(creating||painting);
    $('#chatTarget').innerHTML=sel.length?`<b>${sel.length===1?'1 elemento seleccionado':sel.length+' elementos seleccionados'}</b><span>${esc((api.selectionNames?.(sel) || sel.map(p=>p.split('.').at(-1))).slice(0,3).join(', '))}${sel.length>3?'…':''}</span>`:'<b>Selecciona una pieza para continuar</b><span>Haz clic en el dibujo o elige un grupo en Capas.</span>';
    $('#chatRefineHelp').textContent=C.refine==='redraw'?'Reinterpreta las formas para que se reconozcan mejor. Conserva el propósito y la posición; modifica solo las piezas seleccionadas.':C.refine==='style'?'Cambia colores, luces y relieve. Conserva la silueta y las piezas.':'Suaviza y simplifica curvas existentes. Conserva colores, esquinas y huecos.';
    $('#chatAppearanceTiming').textContent=creating?'Se usará al crear. Cambiar estos ajustes no modifica el lienzo.':'Se usará al refinar la selección. «Aplicar acabado ahora» aplica solo material y colores, sin IA; la estética se interpreta al refinar.';
    $('#chatApplyAppearance').hidden=!(refining&&C.refine==='style');$('#chatApplyAppearance').disabled=!!C.busy||!sel.length||!(C.material||C.color||C.accent);
    const look=[resolveStyle(C.style)?.name || C.style,listMaterials().find(m=>m.id===C.material)?.label,C.color].filter(Boolean).join(' · ');
    $('#chatAppearanceSummary').textContent=look||'Opcional';
    const action=creating?(C.kind==='icon-pack'?`Crear ${C.quantity || '…'} iconos`:C.kind==='app-icon'?'Crear icono':'Crear ilustración'):refining?'Refinar selección':'Consultar';
    $('#chatSend').textContent=action;$('#chatSend').disabled=!!C.busy||C.refsLoading||refining&&!sel.length;
    $('#chatPlan').textContent=creating?`${C.kind==='icon-pack'?C.quantity+' iconos nuevos':C.kind==='app-icon'?'Un icono nuevo':'Una ilustración nueva'}${look?' · '+look:''}`:refining?(sel.length?`${sel.length} seleccionada(s) · ${C.refine==='redraw'?'redibujar formas dentro de la selección':C.refine==='style'?'conservar formas':'conservar colores y huecos'}`:'Elige en el lienzo qué quieres mejorar'):'Solo consulta · sin cambios en el lienzo';
    $('#chatInLabel').textContent=creating?'Describe lo que quieres crear':refining?'¿Qué quieres mejorar?':'Tu pregunta';
    $('#chatIn').placeholder=creating?'Tema, formas y detalles que deben aparecer…':refining?(C.refine==='redraw'?'Ej. distingue mejor la guitarra del violín…':C.refine==='style'?'Ej. más contraste y un acabado Fruits…':'Ej. suaviza el contorno sin perder las esquinas…'):'Ej. ¿por qué este icono pierde legibilidad?';
    $('#chatCtx').textContent=creating?'Añadir piezas nuevas':refining?'Solo la selección':'Solo lectura';
    $('#chatError').hidden=!C.error;$('#chatError').textContent=C.error;
    $('#chatCorrect').hidden=!C.suggestion;
    $('#chatReferenceWarning').hidden=!(C.referenceWarning||C.refsLoading);$('#chatReferenceWarning').textContent=C.refsLoading?'Recuperando las referencias de este documento…':C.referenceWarning;
    for(const el of host.querySelectorAll('#chatCreateFields input,#chatCreateFields select,#chatPurpose,#chatRefine,#chatStyle,#chatMaterial,#chatColor,#chatAccent,#chatModel,#chatCustomModel,#chatReview,#chatCanvas,[data-prov]')) el.disabled=!!C.busy;
    $('#chatAttach').disabled=!!C.busy;$('#chatClear').disabled=!!C.busy;
  }
  function applyCreatedAppearance(settings,paths=api.selection()) {
    if(!paths.length || !(settings.material||settings.color||settings.accent)) return;
    const scope=api.refinementScope('style',paths),op=settings.color||settings.accent?{op:'palette',target:'selection',color:settings.color,accent:settings.accent,material:settings.material}:{op:'material',target:'selection',preset:settings.material};
    api.refine([op],scope);
  }

  const appearance = () => ({style:C.style,material:C.material,color:C.color,accent:C.accent,purpose:C.purpose,history:C.messages.slice(),countMode:C.countMode});
  $('#chatStyle').value=C.style; $('#chatMaterial').value=C.material; $('#chatColor').value=C.color; $('#chatAccent').value=C.accent;
  const showBrief = brief => {
    if(!brief) return;
    for(const key of ['style','material','color','accent','purpose','countMode']) if(brief[key]!=null) C[key]=brief[key];
    const style=resolveStyle(C.style)?.id || C.style;
    if(style && ![...$('#chatStyle').options].some(o=>o.value===style)) $('#chatStyle').add(new Option(C.style,style));
    $('#chatPurpose').value=C.purpose;
    $('#chatStyle').value=style; $('#chatMaterial').value=C.material; $('#chatColor').value=C.color; $('#chatAccent').value=C.accent;
  };
  const recordPaint = (operations,log=[],selection=api.selection()) => {
    if(!C.job || !productionStatus(C.job,api.getText()).valid) return;
    C.job.brief ||= productionBrief(C.job.message);
    for(const [i,op] of operations.entries()) {
      if(log[i] && !log[i].ok) continue;
      const targets=op.target==='selection' ? selection : [op.target];
      if(!targets.includes(C.job.id)) continue;
      if(op.op==='palette') for(const key of ['color','accent','material']) if(op[key]) C.job.brief[key]=op[key];
      if(op.op==='material') {C.job.brief.material=op.preset; if(op.color) C.job.brief.color=op.color;}
    }
    synchronizeIconJob(C.job,api.getText()); store.set(`aru-production:${C.docId}`,C.job); api.productionProgress?.(C.job);
  };
  // ---------- attachments: downscaled to <= 1024 px (enough to see and to trace; fewer tokens) ----------
  async function addImage(file) {
    if(C.busy) return;const docAtUpload=C.docId;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { api.toast('Solo PNG, JPEG o WebP', true); return; }
    if (C.pending.length >= 3) { api.toast('Máximo 3 imágenes por mensaje', true); return; }
    const url = URL.createObjectURL(file);
    const img = new Image(); img.src = url;try {await img.decode();} finally {URL.revokeObjectURL(url);}
    if(C.docId!==docAtUpload||C.busy) return;
    const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    const png = file.type === 'image/png' || file.type === 'image/webp';
    const dataUrl = cv.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9);
    const th = document.createElement('canvas'), tk = Math.min(1, 160 / Math.max(cv.width, cv.height)); th.width = Math.round(cv.width * tk); th.height = Math.round(cv.height * tk); th.getContext('2d').drawImage(cv, 0, 0, th.width, th.height);
    const name = `ref${++C.refSeq}`;
    C.pending.push({ name, mime: png ? 'image/png' : 'image/jpeg', ext: png ? 'png' : 'jpg', data: dataUrl.split(',')[1], thumb: th.toDataURL('image/jpeg', 0.8), w: cv.width, h: cv.height });
    renderAtts();
  }
  function renderAtts() {
    $('#chatAtts').innerHTML = C.pending.map((a, i) => `<span class="att"><img src="${a.thumb}" alt=""><b>${a.name}</b><button data-rmatt="${i}" title="Quitar">×</button></span>`).join('');
    $('#chatAtts').style.display = C.pending.length ? 'flex' : 'none';
  }

  function renderProviders() {
    const list = C.agents || PROVIDERS.map((p) => ({ id: p.id, name: p.name, installed: null }));
    $('#chatProv').innerHTML = list.map((a) => `<button data-prov="${a.id}" class="${a.id === C.provider ? 'on' : ''}${a.installed === false ? ' off' : ''}" title="${esc(a.installed === false ? `${a.name} no está instalado` : a.version || a.name)}"><i class="st ${a.installed === false ? 'no' : a.installed ? 'yes' : ''}"></i>${esc(a.name)}</button>`).join('');
    const p = PROVIDERS.find((x) => x.id === C.provider), a = list.find((x) => x.id === C.provider);
    const selected=C.models[C.provider] || '', options=modelOptions(C.provider,a,selected);
    $('#chatModel').innerHTML=options.map(m=>`<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')+'<option value="__custom">Otro modelo…</option>';
    $('#chatModel').value=selected;
    $('#chatCustomModelField').hidden=true; $('#chatCustomModel').value=selected; $('#chatCustomModel').setAttribute('aria-invalid',String(!validModel(selected)));
    $('#chatIdentity').textContent=`${p.name} · ${options.find(m=>m.id===selected)?.label || selected}`;
    $('#chatNote').textContent = a?.installed === false ? `${p.name} no está instalado en este equipo.` : `${p.note}${a?.version ? ` · ${a.version}` : ''}${isDesktop() ? '' : ' · vía servidor local'} · ${a?.modelSource==='local-cache'?'Catálogo local de modelos':'Alias y modelos sugeridos; disponibilidad según el CLI'}`;
    $('#chatCanvas').checked = C.canvas; $('#chatReview').value = String(C.review);
  }
  function bubble(m, i) {
    if (m.role === 'user') return `<div class="msg user">${m.thumbs?.length ? `<div class="thumbs">${m.thumbs.map((t) => `<img src="${t}" alt="">`).join('')}</div>` : ''}${esc(m.text)}${m.references?.length?`<div class="faint">Referencias: ${esc(m.references.join(', '))}</div>`:''}</div>`;
    const ops = (m.operations || []).map((o, k) => `<li><b>${esc(o.op)}</b> ${esc(o.target ?? '')}${o.other ? ` ↔ ${esc(o.other)}` : ''}${o.preset ? ` · ${esc(o.preset)}` : ''}${o.fill ? ` · <i class="sw" style="background:${esc(o.fill)}"></i>${esc(o.fill)}` : ''}${o.pattern ? ` · “${esc(o.pattern)}”` : ''}${o.label && o.op !== 'rename' ? ` · “${esc(o.label)}”` : ''}${['smooth', 'simplify', 'weld', 'connect'].includes(o.op) && m.log?.[k]?.ok ? `<div class="faint">${esc(m.log[k].message)}</div>` : ''}</li>`).join('');
    const fails = (m.log || []).filter((l) => !l.ok).map((l) => `<div class="err">✗ ${esc(l.message)}</div>`).join('');
    const extra = [m.traced ? `<div class="ok">✓ Referencia vectorizada: <b>${esc(m.traced.label)}</b> · ${m.traced.regions} regiones${m.traced.score != null ? ` · puntuación ${m.traced.score}` : ` · ${m.traced.fidelity}% fidelidad`}${m.traced.tune ? ` · ${esc(m.traced.tune)}` : ''}${m.traced.note ? ` · ${esc(m.traced.note)}` : ''}</div>` : '',
      m.pack ? `<div class="faint">Pack de iconos: puntuación ${m.pack.start} → ${m.pack.end ?? m.pack.start}${m.pack.issues != null ? ` · ${m.pack.issues} iconos con avisos` : ''}${m.pack.recognition?` · reconocimiento: ${m.pack.recognition.recognized}/${m.pack.recognition.total}${m.pack.recognition.unverified?' · '+m.pack.recognition.unverified+' sin verificar':''}`:''}${m.pack.finalMisread?.length?`<br>Comprobación final: ${esc(m.pack.finalMisread.join(', '))}`:''}${m.pack.rounds.map((r) => `<br>Revisión ${r.round}${r.misread?.length ? ` (prueba ciega: no se reconocen ${esc(r.misread.join(', '))})` : ''}: ${r.accept ? 'aceptado' : esc((r.changes || []).map((c) => `${c.what}${c.error ? ` ✗ ${c.error}` : ` → ${c.score}${c.kept ? ' ✓' : ' ✗'}`}`).join(' · ') || 'sin cambios')} — ${esc(r.reason)}`).join('')}</div>` : '',
      m.glyph?.rounds?.length ? `<div class="faint">${m.glyph.rounds.map((r) => `Icono, revisión ${r.round}: ${r.accept ? 'aceptado' : r.repeated ? 'ajuste ya probado' : `${esc(Object.entries(r.params || {}).map(([k, v]) => `${k} ${v}`).join(', '))} → ${r.score}${r.improved ? ' (mejor, se queda)' : ' (no mejora, se descarta)'}`} — ${esc(r.reason)}`).join('<br>')}</div>` : '',
      m.review?.length ? `<div class="faint">${m.review.map((r) => `Revisión ${r.round}: ${r.accept ? 'aceptado' : r.repeated ? 'propuso un ajuste ya probado' : `propuso ${esc(r.tune ? `${r.tune.ink === 'on' ? 'tinta' : 'sin tinta'}, finas ${r.tune.faint}, abstracción ${r.tune.abstraction}, detalle ${r.tune.detail}` : '—')} → ${r.score}${r.improved ? ' (mejor, se queda)' : ' (no mejora, se descarta)'}`} — ${esc(r.reason)}`).join('<br>')}</div>` : '', m.traceError ? `<div class="err">✗ No se pudo vectorizar la referencia: ${esc(m.traceError)}</div>` : '', m.groupError ? `<div class="faint">Agrupación por piezas no disponible (${esc(m.groupError)}); se usaron las cajas de las partes.</div>` : '',
      m.drawn ? `<div class="ok">✓ Dibujado en ARU: <b>${esc(m.drawn.label)}</b> · ${m.drawn.layers} capas${m.drawn.repaired ? ' (corregido tras un error de sintaxis)' : ''}${m.drawn.note ? ` · ${esc(m.drawn.note)}` : ''}</div>` : '', m.aruErrors ? `<div class="err">✗ El ARU escrito por la IA no compila: ${esc(m.aruErrors.join(' · '))}</div>` : '',
      m.aruIgnored ? '<div class="faint">La IA propuso un dibujo en ARU, pero el modo ilustrador está apagado.</div>' : '',
      m.repair ? `<div class="faint">Corrección automática: ${m.repair.accepted?'la nueva propuesta pasó la validación':'la propuesta no se pudo corregir'}. Motivo inicial: ${esc(m.repair.reason)}</div>` : ''].join('');
    const changed = (m.applied || 0) + (m.traced ? 1 : 0) + (m.drawn ? 1 : 0);
    const state = m.error ? '' : changed && m.undo ? `<div class="ok">✓ ${m.applied ? `${m.applied} de ${m.operations.length} operaciones aplicadas · ` : ''}<button class="link" data-undo="${i}">Deshacer</button></div>` : m.operations?.length && !m.applied && !m.undone ? `<button class="btn sm" data-apply="${i}">Aplicar ${m.operations.length} operaciones</button>` : m.undone ? '<div class="faint">Deshecho.</div>' : '';
    const meta = [m.providerName, m.ms ? `${(m.ms / 1000).toFixed(1)} s` : '', m.usage?.usd != null ? `$${m.usage.usd.toFixed(3)}` : '', m.usage?.tokens ? `${m.usage.tokens} tokens` : '', m.sawCanvas ? 'vio el lienzo' : ''].filter(Boolean).join(' · ');
    return `<div class="msg bot${m.error ? ' error' : ''}"><div class="txt">${m.error ? esc(m.error) : md(m.text)}</div>${extra}${ops ? `<details${m.applied ? '' : ' open'}><summary>${m.operations.length} operaciones</summary><ul>${ops}</ul></details>` : ''}${fails}${state}${m.retry?`<button class="btn sm" data-retry="${i}">Preparar de nuevo</button>`:''}<div class="meta">${esc(meta)}</div></div>`;
  }
  function render() {
    const production = $('#chatProduction');
    production.hidden = !C.job;
    if (C.job) {
      const j=C.job, status=productionStatus(j,api.getText()), done=status.count, invalid=!status.valid;
      production.innerHTML = `<div class="line"><b>${invalid ? 'Inventario por revalidar' : status.status === 'complete' ? 'Pack completo' : j.status === 'running' ? 'Produciendo iconos' : 'Producción en pausa'}</b><span class="spacer"></span><span>${done} / ${j.target}</span></div><progress max="${Math.max(1,j.target)}" value="${done}" aria-label="Iconos aceptados"></progress><small>${invalid ? 'Piezas presentes en el pack' : status.status === 'complete' ? 'Cantidad verificada en el documento' : `${j.target-done} pendientes · lotes de ${j.batchSize}`}</small><small>${j.existing?.length || 0} previos · ${done} nuevos · ${(j.existing?.length || 0)+done} en total</small>${status.reason || j.reason && status.status !== 'complete' ? `<p>${esc(status.reason || j.reason)}</p>` : ''}${j.issues?.length ? `<details class="production-issues"><summary>Ver ${j.issues.length} observaciones del último lote</summary><ul>${j.issues.slice(0,8).map(i=>`<li><b>${esc(i.label)}</b>: ${esc(i.reason)}</li>`).join('')}</ul></details>` : ''}${!C.busy && invalid ? '<button class="btn sm" id="chatRevalidate">Revalidar inventario</button>' : !C.busy && status.status !== 'complete' ? '<button class="btn sm" id="chatResume">Reanudar pendientes</button>' : ''}`;
    }
    const log = $('#chatLog'), scroll=$('#chatScroll');
    const follow=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<40;
    if (!C.messages.length && !C.busy) log.innerHTML = `<div class="chat-empty"><div class="flow-quick">${SUGGEST[C.mode].map(t=>`<button data-sug="${esc(t)}">${esc(t)}<span>↗</span></button>`).join('')}</div></div>`;
    else log.innerHTML = C.messages.map(bubble).join('') + (C.busy ? `<div class="msg bot busy"><span class="dots"><i></i><i></i><i></i></span> ${esc(C.busy.status)} <span id="chatTimer">0 s</span> <button class="link" id="chatStop">Detener</button></div>` : '');
    if((C.messages.length || C.busy) && (follow || C.forceScroll)) scroll.scrollTop=scroll.scrollHeight;
    C.forceScroll=false;
    $('#chatActive').hidden=!C.busy; $('#chatActiveStatus').textContent=C.busy?.status || ''; $('#chatActiveStatus').title=C.busy?.status || '';
    renderWorkflow();

  }

  const assertActive=token=>{if(!token || token.cancelled || C.busy?.token!==token) throw new Error('Detenido');};
  async function ask(text, history, images, refinement = null, flow = null, selected = api.selection(),token=C.busy?.token) {
    assertActive(token);
    const p = PROVIDERS.find((x) => x.id === C.provider);
    const runId = `r${Date.now()}`;
    C.busy = { ...C.busy, runId };
    const res = await runAgent({ provider: C.provider, model: C.models[C.provider] || '', system: systemPrompt({ illustrator: flow ? flow.illustrator : C.illustrator }) + (refinement ? '\n' + refinementSystem(refinement.mode) : '') + (flow ? '\n'+flow.context : ''), prompt: buildPrompt({ context: api.context() + (C.job ? '\nVerified production inventory: '+JSON.stringify(productionStatus(C.job,api.getText())) : '') + (flow && !flow.appearance ? '' : '\n' + briefPrompt(productionBrief(text, {...appearance(),history:flow?[]:history}))) + (refinement ? '\nRefinement scope: ' + JSON.stringify(refinement) : ''), selection: selected, history, message: text, images }), schema: ANSWER_SCHEMA, runId, images: images.map(({ name, mime, data }) => ({ name, mime, data })) });
    assertActive(token);if (res.cancelled) throw new Error('Detenido');
    return { res, ans: parseAnswer(C.provider, res), p };
  }

  // one review round: the model sees original | result + the measured score and proposes a tune (or accepts)
  async function askStructured(system, prompt, schema, images,token=C.busy?.token) {
    assertActive(token);
    const runId = `s${Date.now()}`;
    C.busy = { ...C.busy, runId };
    const res = await runAgent({ provider: C.provider, model: C.models[C.provider] || '', system, prompt: (api.workspace?.() || '')+'\n'+prompt, schema, runId, images });
    assertActive(token);if (res.cancelled) throw new Error('Detenido');
    const { answer, usage } = extractStructured(C.provider, res);
    if (!answer) throw new Error('La respuesta no tiene el formato esperado');
    return { answer, usage, ms: res.ms || 0 };
  }
  async function review(st, label, png, userText,token=C.busy?.token) {
    const prompt = buildReviewPrompt({ label, current: st.best.tune, metrics: st.best.metrics, tried: st.tried, userText });
    const r = await askStructured(REVIEW_SYSTEM, prompt, REVIEW_SCHEMA, [{ name: 'compare', mime: 'image/png', data: png }],token);
    if (typeof r.answer.accept !== 'boolean') throw new Error('La revisión no tiene el formato esperado');
    return r;
  }

  async function send(text, {legacy=false,legacyRefine='off'} = {}) {
    text = text.trim(); if(C.busy) return;
    const requestedDoc=C.docId;await C.refsReady;if(C.busy||C.docId!==requestedDoc) return;
    const rawText=text;
    const flow=legacy?null:currentFlow(text);let settings=recipe();
    if(flow?.error) {C.error=flow.error;C.suggestion=flow.suggestion||null;renderWorkflow();return {error:C.error};}
    C.error='';
    if(flow) {text=flow.message;C.illustrator=flow.illustrator;C.auto=true;}
    else if(!text && !C.pending.length) return;
    if (!text) text = 'Vectoriza la imagen adjunta y colócala en el lienzo.';
    try {if(!flow || flow.appearance) settings=productionBrief(text,{...appearance(),history:flow?[]:C.messages});} catch(e) {C.error=e.message;renderWorkflow();return {error:e.message};}
    if(!validModel(C.models[C.provider] || '')) {api.toast('El ID del modelo debe usar letras, números, puntos, guiones, : o /',true);return;}
    const p = PROVIDERS.find((x) => x.id === C.provider), a = C.agents?.find((x) => x.id === C.provider);
    if (a && !a.installed) { api.toast(`${p.name} no está instalado`, true); return; }
    if((!flow||flow.mode==='consult') && C.job && /(?:cu[aá]ntos?.*(?:iconos|llevamos|faltan|hay)|(?:estado|status|avance).*(?:pack|lote|producci[oó]n))/i.test(text) && requestedIconCount(text)==null) {
      const status=productionStatus(C.job,api.getText());
      const msg={role:'bot',text:`Inventario verificado: ${status.count} de ${status.target} iconos nuevos; ${C.job.existing?.length || 0} previos. ${status.valid ? `${Math.max(0,status.target-status.count)} pendientes.` : status.reason}`};
      C.messages.push({role:'user',text},msg); $('#chatIn').value=''; saveMsgs(); render(); return msg;
    }
    try {chooseReferenceImages(rawText,C.pending,[...C.refs.values()],{history:C.messages});} catch(e) {C.error=e.message;renderWorkflow();return {error:C.error};}
    const target = flow?.target ?? requestedIconCount(text);
    if (flow?.mode==='create' && flow.target || legacy && target > 24 && legacyRefine === 'off') {
      if (!C.auto) { api.toast('Activa aplicar para producir y guardar cada lote automáticamente', true); return; }
      if (target > 1000) { api.toast('El límite por trabajo es de 1000 iconos; divide el pedido en varios trabajos', true); return; }
      try {return await produce(text,false,flow,rawText);} catch(e) {api.toast(e.message,true);return {error:e.message};}
    }
    const history = C.messages.slice(),selected=api.selection();C.activeSelection=selected;
    const requestId=crypto.randomUUID(),docAtStart=C.docId,token={cancelled:false};
    const structured=(...args)=>askStructured(...args,token);
    const newRefs = C.pending.splice(0);
    for (const r of newRefs) C.refs.set(r.name, r);
    const userMessage={id:requestId,role:'user',text:rawText||text,requestText:text,mode:flow?.mode,refinement:flow?.refinement,thumbs:newRefs.map(r=>r.thumb),references:newRefs.map(r=>r.name)};
    C.messages.push(userMessage);
    const messagesAtStart=C.messages;
    const refsAtStart=[...C.refs.values()];
    C.forceScroll=true;
    C.busy = { requestId,token, status: `${p.name} está pensando…`, t0: Date.now() };
    $('#chatIn').value = ''; renderAtts(); render(); saveMsgs();
    const tick = setInterval(() => { const t = host.querySelector('#chatTimer'); if (t && C.busy) t.textContent = `${Math.round((Date.now() - C.busy.t0) / 1000)} s`; }, 500);
    const msg = { role: 'bot', replyTo:requestId, providerName: p.name };
    const depth0 = api.depth();
    let createdResourceTarget = [];
    let expectedVersion = api.version?.();
    const stale = () => token.cancelled || C.docId !== docAtStart || (expectedVersion != null && api.version() !== expectedVersion); // the user switched documents while waiting: never apply here
    let outcomeRecorded=false;
    const recordOutcome=()=>{
      if(outcomeRecorded) return;outcomeRecorded=true;
      saveOutcome(docAtStart,msg,messagesAtStart);
    };
    const discardStale = () => {
      clearInterval(tick);msg.status=token.cancelled?'cancelled':'discarded';msg.error=token.cancelled?'Solicitud detenida. No se aplicó la respuesta pendiente. Puedes prepararla de nuevo.':'Respuesta no aplicada: el documento cambió mientras la IA trabajaba. Tus cambios se conservaron. Prepara la solicitud de nuevo sobre la versión actual.';msg.retry={text:rawText||text,mode:flow?.mode,refinement:flow?.refinement};
      if(C.busy?.requestId===requestId) C.busy=null;
      recordOutcome();return msg;
    };
    try {
      const saved=await references.save(docAtStart,refsAtStart);
      if(!saved.persisted && !embedMode && C.docId===docAtStart) C.referenceWarning='Las referencias solo están disponibles en esta sesión: '+(saved.reason||'no se pudieron guardar en este equipo.');
      if(stale()) return discardStale();
      const snap=C.canvas?await api.snapshot(flow?.mode==='refine'?selected:[]):null;
      const {images}=chooseReferenceImages(rawText,newRefs,refsAtStart,{history,canvas:snap?{name:'canvas',mime:'image/png',data:snap}:null});
      msg.sawCanvas=images.some(i=>i.name==='canvas');
      if(stale()) return discardStale();
      const refinement = flow ? flow.refinement ? api.refinementScope(flow.refinement,selected) : null : legacyRefine === 'off' ? null : api.refinementScope(legacyRefine,selected);
      msg.refinement = refinement;
      let { res, ans } = await ask(text, history, images, refinement,flow,selected,token);
      if(stale()) return discardStale();
      if(refinement) {
        const validateRefinement = answer => {
          if(flow) validateAssistantAnswer(flow,answer);
          if(answer.aru || answer.reference) throw new Error('La IA intentó reemplazar la base; el refinamiento fue rechazado');
          if(answer.operations.length) api.previewRefinement(answer.operations,refinement);
        };
        try { validateRefinement(ans); }
        catch(error) {
          if(stale()) return discardStale();
          if(!ans.operations?.length || /detenid|cancelad|documento cambi[oó]|revisi[oó]n cambi/i.test(error.message)) throw error;
          msg.repair={attempts:1,accepted:false,reason:error.message};
          C.busy.status='Corrigiendo la propuesta de refinamiento…';render();
          const repairPrompt=`La propuesta anterior fue rechazada antes de modificar el documento. Corrígela una sola vez manteniendo la solicitud, el modo y la selección originales.\nSolicitud original: ${text}\nError del motor: ${error.message}\nOperaciones rechazadas: ${JSON.stringify(ans.operations)}\nDevuelve la respuesta completa corregida con operaciones válidas para el alcance indicado, aru vacío y reference.use=false. No cambies nombres ni etiquetas con set; elimina los campos incompatibles. No amplíes el alcance para evitar la validación.`;
          const fixed=await ask(repairPrompt,history,images,refinement,flow,selected,token);
          if(stale()) return discardStale();
          validateRefinement(fixed.ans);
          const usage={...fixed.ans.usage};
          for(const key of ['usd','tokens']) if(typeof ans.usage?.[key]==='number'||typeof fixed.ans.usage?.[key]==='number') usage[key]=(ans.usage?.[key]||0)+(fixed.ans.usage?.[key]||0);
          ans={...fixed.ans,usage};res={...fixed.res,ms:(res.ms||0)+(fixed.res.ms||0)};msg.repair.accepted=true;
        }
      }
      if(flow) {validateAssistantAnswer(flow,ans);if(flow.mode==='create') {ans.aruInto=null;ans.operations=ans.operations.map(o=>({...o,target:o.target==='$created'?'$created':'root'}));}}
      if(ans.operations.length && !refinement) api.previewOperations(ans.operations.map(o=>o.op==='reuse'&&o.target==='$created'?{...o,target:'root'}:o),{selection:selected});
      msg.flow=flow?.mode;msg.applySelection=selected;
      if (refinement && (ans.aru || ans.reference)) throw new Error('La IA intentó reemplazar la base; el refinamiento fue rechazado');
      if (stale()) { return discardStale(); }
      msg.ms = res.ms;
      Object.assign(msg, { text: ans.reply, operations: ans.operations, usage: ans.usage });
      // 1) illustrator mode: ARU written by the AI (one automatic repair round if it does not compile)
      if (ans.aru) {
        if (!(flow?flow.illustrator:C.illustrator)) msg.aruIgnored = true;
        else {
          // icon packs: the tool inspects every icon; the AI sets pack levers / redraws flagged icons; the pack score decides
          let aruText = ans.aru;
          if (C.review > 0) {
            const pk = await api.packPrepare(aruText).catch(() => null);
            if (pk && !stale()) {
              msg.pack = { start: pk.ins.score, rounds: [] };
              for (let round = 1; round <= C.review && !stale(); round++) {
                // blind test first: can each icon be recognised without its label?
                C.busy.status = `Prueba ciega del pack (ronda ${round})…`; render();
                const blind = await api.packBlindPng(pk);
                const rb = await structured(BLIND_SYSTEM, buildBlindPrompt(blind), BLIND_SCHEMA, [{ name: 'blind', mime: 'image/png', data: blind.png }]);
                msg.ms += rb.ms; if (rb.usage?.usd != null) msg.usage = { ...(msg.usage || {}), usd: (msg.usage?.usd || 0) + rb.usage.usd };
                const misread = await api.packSetRecognition(pk, blind, rb.answer.answers);
                if (round === 1) msg.pack.start = pk.ins.score;
                C.busy.status = `${p.name} revisa el pack de iconos (ronda ${round})…`; render();
                const png = await api.packReviewPng(pk);
                const rp = await structured(packSystem(), buildPackPrompt({ report: pk.report, userText: text, tried: pk.tried }), PACK_SCHEMA, [{ name: 'pack', mime: 'image/png', data: png }]);
                msg.ms += rp.ms; if (rp.usage?.usd != null) msg.usage = { ...(msg.usage || {}), usd: (msg.usage?.usd || 0) + rp.usage.usd };
                const entry = { round, accept: !!rp.answer.accept, reason: rp.answer.reason || '', misread };
                msg.pack.rounds.push(entry);
                if (rp.answer.accept) break;
                C.busy.status = `Aplicando y midiendo los cambios de ${p.name}…`; render();
                entry.changes = await api.packApply(pk, rp.answer);
              }
              if(needsPackRecognition(pk) && !stale()) {
                C.busy.status='Comprobando que los últimos redibujos se reconocen…';render();
                const blind=await api.packBlindPng(pk);
                const rb=await structured(BLIND_SYSTEM,buildBlindPrompt(blind),BLIND_SCHEMA,[{name:'blind',mime:'image/png',data:blind.png}]);
                msg.ms+=rb.ms;if(rb.usage?.usd!=null) msg.usage={...(msg.usage||{}),usd:(msg.usage?.usd||0)+rb.usage.usd};
                msg.pack.finalMisread=await api.packSetRecognition(pk,blind,rb.answer.answers);
              }
              msg.pack.recognition=pk.ins.recognition;
              msg.pack.end = pk.ins.score; msg.pack.issues = pk.ins.icons.filter((i) => i.issues.length).length;
              aruText = api.packFragment(pk);
            }
          }
          if (stale()) { return discardStale(); }
          let r = api.insertAru(aruText, ans.reference?.label || null, ans.aruInto);
          if (!r.ok) {
            C.busy.status = 'Corrigiendo el ARU…'; render();
            const fix = await ask(`Your "aru" did not compile:\n${r.errors.join('\n')}\nReturn the complete corrected "aru" (same drawing), operations [] and reference.use=false.`, [...history, { role: 'user', text }, { role: 'bot', text: ans.reply }], images.filter((i) => i.name === 'canvas'),refinement,flow,selected,token);
            msg.ms += fix.res.ms;
            if (stale()) { return discardStale(); }
            if(flow) validateAssistantAnswer(flow,fix.ans);
            if (fix.ans.aru) { r = api.insertAru(fix.ans.aru, null, ans.aruInto); if (r.ok) r.repaired = true; }
          }
          expectedVersion=api.version?.();
          if (r.ok) createdResourceTarget = api.selection().slice();
          if(r.ok && flow?.mode==='create') applyCreatedAppearance(settings);
          expectedVersion = api.version?.();
          if (r.ok) msg.drawn = { label: r.label, layers: r.layers, repaired: !!r.repaired, note: r.note }; else msg.aruErrors = r.errors.slice(0, 3);
        }
      }
      // 2) reference: the AI gave context, the tracer measures and draws
      if (ans.reference) {
        const sentRefs=images.filter(i=>i.name!=='canvas');
        const att=ans.reference.image?sentRefs.find(i=>i.name===ans.reference.image):sentRefs.length===1?sentRefs[0]:null;
        if (!att) throw new Error('La IA pidió una referencia que no se envió en esta solicitud. No se sustituyó por otra imagen.');
        else {
          C.busy.status = `Vectorizando ${att.name} con el tracer…`; render();
          try {
            // auto-tune (deterministic), then up to C.review AI review rounds; the score keeps the best, then insert
            const st = await api.traceRefState(att, ans.reference, (k, n) => { assertActive(token);C.busy.status = `Vectorizando ${att.name}: variante ${k} de ${n}…`; render(); });
            msg.review = [];
            for (let round = 1; round <= C.review && !stale(); round++) {
              C.busy.status = `${p.name} revisa el resultado (ronda ${round})…`; render();
              const cmp = await api.compareRefPng(st);
              const rv = await review(st, ans.reference.label || att.name, cmp, text,token);
              msg.ms += rv.ms;
              if (rv.usage?.usd != null) msg.usage = { ...(msg.usage || {}), usd: (msg.usage?.usd || 0) + rv.usage.usd };
              const entry = { round, accept: !!rv.answer.accept, reason: rv.answer.reason || '' };
              msg.review.push(entry);
              if (rv.answer.accept) break;
              C.busy.status = `Probando el ajuste de ${p.name}…`; render();
              const out = await api.retraceRef(st, rv.answer.tune);
              Object.assign(entry, { tune: out.tune, score: out.metrics.score, improved: out.improved, repeated: !!out.repeated });
            }
            if (stale()) { return discardStale(); }
            // grouping: the AI sees the numbered pieces of the result and says which part each one belongs to
            let assignments = null;
            if (ans.reference.parts?.length) {
              C.busy.status = `${p.name} asigna cada pieza a su parte…`; render();
              try {
                const pc = await api.piecesRef(st);
                const ra = await structured(PIECES_SYSTEM, buildPiecesPrompt({ parts: ans.reference.parts, count: pc.count }), PIECES_SCHEMA, [{ name: 'pieces', mime: 'image/png', data: pc.png }]);
                msg.ms += ra.ms; if (ra.usage?.usd != null) msg.usage = { ...(msg.usage || {}), usd: (msg.usage?.usd || 0) + ra.usage.usd };
                assignments = Array.isArray(ra.answer?.assignments) ? ra.answer.assignments : null;
              } catch (e) { msg.groupError = e.message; }
            }
            if (stale()) { return discardStale(); }
            C.busy.status = 'Agrupando las capas por partes…'; render();
            const grp = await api.groupRef(st, assignments);
            msg.pieces = { assignments: (assignments || []).slice(0, 80), unknown: grp.unknownParts || [], moved: grp.byPieces || 0, ...(grp.reason ? { notGrouped: grp.reason } : {}) };
            if (stale()) { return discardStale(); }
            // glyph icons: the tool inspects the built icon (specks, thin parts, thin cuts, jagged edges, fidelity) and the
            // AI moves the cleanup levers; the icon score keeps the best
            if (ans.reference.backdrop?.style === 'glyph') {
              C.busy.status = 'Construyendo el glifo e inspeccionando su calidad…'; render();
              const gp = await api.glyphPrepare(st, ans.reference);
              let report = gp.report;
              msg.glyph = { start: gp.inspection.score, rounds: [] };
              for (let round = 1; round <= C.review && !stale(); round++) {
                C.busy.status = `${p.name} revisa el icono (ronda ${round})…`; render();
                const rg = await structured(GLYPH_SYSTEM, buildGlyphPrompt({ report, userText: text, tried: st.glyph?.tried || [] }), GLYPH_SCHEMA, [{ name: 'icon', mime: 'image/png', data: await api.glyphReviewPng(st, ans.reference) }]);
                msg.ms += rg.ms; if (rg.usage?.usd != null) msg.usage = { ...(msg.usage || {}), usd: (msg.usage?.usd || 0) + rg.usage.usd };
                const entry = { round, accept: !!rg.answer.accept, reason: rg.answer.reason || '' };
                msg.glyph.rounds.push(entry);
                if (rg.answer.accept) break;
                const out = await api.glyphRetune(st, rg.answer.params || {});
                Object.assign(entry, { params: out.params, score: out.score, improved: out.improved, repeated: !!out.repeated });
                report = out.report;
              }
            }
            if (stale()) { return discardStale(); }
            const t = await api.insertRef(st, att, ans.reference,()=>!stale());
            expectedVersion=api.version?.();
            if(flow?.mode==='create') applyCreatedAppearance(settings);
            expectedVersion = api.version?.();
            if (grp.grouped) t.note = [`${grp.groups} grupos por partes${assignments ? ` (${assignments.length} piezas asignadas por ${p.name})` : ''}`, t.note].filter(Boolean).join(' · ');
            else if (grp.reason) t.note = [`sin agrupar: ${grp.reason}`, t.note].filter(Boolean).join(' · ');
            msg.ref = { crop: ans.reference.crop || null, backdrop: ans.reference.backdrop || null, parts: (ans.reference.parts || []).slice(0, 40) };
            msg.traced = { label: ans.reference.label || att.name, regions: t.regions, fidelity: t.fidelity, score: t.score, tune: t.tune, note: t.note };
          } catch (e) { msg.traceError = e.message; }
        }
      }
      if (stale()) { return discardStale(); }
      // Resolve reuse only to the newly inserted illustration, even with auto-apply disabled.
      ans.operations = resolveCreatedOperations(ans.operations, createdResourceTarget);
      msg.operations = ans.operations;
      // 3) batch operations
      if (refinement && ans.operations.length && !C.auto) api.previewRefinement(ans.operations, refinement);
      if (ans.operations.length && C.auto) { const r = refinement ? api.refine(ans.operations, refinement) : api.apply(ans.operations,{selection:selected,expectedRevision:expectedVersion}); expectedVersion=api.version?.(); if(flow?.mode==='create' && !ans.operations.some(o=>o.op==='reuse')) applyCreatedAppearance(settings,r.createdPaths); msg.log = r.log; recordPaint(ans.operations,r.log,selected); msg.applied = r.log.filter((l) => l.ok).length; expectedVersion = api.version?.(); }
    } catch (e) { msg.error = e.message || String(e);msg.status=msg.error==='Detenido'?'cancelled':'failed';msg.retry={text:rawText||text,mode:flow?.mode,refinement:flow?.refinement}; }
    if (stale()) { return discardStale(); }
    if(msg.operations?.length && !msg.applied) msg.applyVersion=api.version?.();
    msg.undo = api.depth() > depth0 ? { from: depth0, to: api.depth() } : null;
    clearInterval(tick);
    C.busy = null;
    msg.status ||= 'complete';recordOutcome();
    return msg;
  }

  async function produce(text, resume = false, flow = null,rawText=text) {
    if (C.busy) return;
    const docId = C.docId, controller = new AbortController(), depth0 = api.depth(),token={cancelled:false},requestId=crypto.randomUUID();
    const providerName=PROVIDERS.find(p=>p.id===C.provider).name;
    const structured=(...args)=>askStructured(...args,token);
    const job = resume ? C.job : createIconJob(text,flow?{...appearance(),history:[],target:flow.target,countMode:'additional'}:appearance());
    if(resume) {setMode('create');C.kind='icon-pack';C.quantity=job.target;$('#chatKind').value=C.kind;$('#chatQuantity').value=C.quantity;showBrief(job.brief);}
    C.job = job; C.controller = controller;
    const pending=resume?[]:C.pending.slice();
    if(!resume) {
      for(const ref of pending) C.refs.set(ref.name,ref);
      job.images=chooseReferenceImages(rawText,pending,[...C.refs.values()],{history:C.messages}).images.map(({name,mime,data})=>({name,mime,data}));
      C.pending=[];
    }
    C.messages.push({id:requestId,role:'user',text:resume?`Reanuda la producción de ${job.target} iconos; conserva los que ya se guardaron.`:rawText,requestText:text,mode:flow?.mode||'create',thumbs:pending.map(r=>r.thumb),references:pending.map(r=>r.name)});
    const messagesAtStart=C.messages;
    job.context = api.context()+(flow?'\n'+flow.context:'');
    C.forceScroll=true;
    C.busy = { requestId,token,status: `Preparando ${job.target} iconos por lotes…`, t0: Date.now() };
    $('#chatIn').value = ''; renderAtts(); render(); saveMsgs();
    const tick = setInterval(() => { const t = $('#chatTimer'); if (t && C.busy) t.textContent = `${Math.round((Date.now() - C.busy.t0) / 1000)} s`; }, 500);
    let result;
    try {
      if(!resume) {const saved=await references.save(docId,[...C.refs.values()]);if(!saved.persisted&&!embedMode) C.referenceWarning='Las referencias solo están disponibles en esta sesión: '+(saved.reason||'almacenamiento no disponible');}
      if (!resume && C.canvas && job.images.length < 4) { const snap = await api.snapshot(); if (snap) job.images.push({ name: 'canvas', mime: 'image/png', data: snap }); }
      result = await runIconJob(job, {
        getText: () => { assertActive(token); if (C.docId !== docId) throw new Error('Se cambió de documento'); return api.getText(); },
        commit: (next, before) => { assertActive(token); if (C.docId !== docId || api.getText() !== before) throw new Error('El documento cambió'); api.commitProduction(next); },
        request: async (system, prompt, schema) => (await structured(system, prompt, schema, job.images || [])).answer,
        signal: controller.signal,
        rasterize: api.rasterizeProduction,
        reviewBatch: C.review && (job.brief?.style || job.brief?.material || job.brief?.purpose) ? async batch => {
          const sheet=productionReview(batch);
          const data=(await opaquePng(sheet.scene,renderScene)).split(',')[1];
          return (await structured('Evaluate the proposed icons against the binding brief before commitment.',sheet.prompt,PRODUCTION_REVIEW_SCHEMA,[{name:'batch',mime:'image/png',data}])).answer;
        } : undefined,
        checkpoint: async state => { if (!store.set(`aru-production:${docId}`, state)) throw new Error('No se pudo guardar el trabajo: almacenamiento local lleno o no disponible'); },
        progress: state => { if (C.docId === docId && C.busy?.requestId===requestId) { C.job = state; api.productionProgress?.(state); if (C.busy) C.busy.status = `${state.accepted.length} de ${state.target} · generando el siguiente lote…`; render(); } },
      });
    } catch (e) { result = { ...job, status: 'paused', reason: e.message }; store.set(`aru-production:${docId}`, result); }
    finally { clearInterval(tick); }
    if (C.docId !== docId) {
      const msg={role:'bot',replyTo:requestId,status:'cancelled',providerName,text:`Producción detenida al cambiar de documento: ${result.accepted.length} de ${result.target} iconos guardados. Abre el documento original para revisar o reanudar el trabajo.`};
      saveOutcome(docId,msg,messagesAtStart);return msg;
    }
    const ownsRequest=C.busy?.requestId===requestId;
    if(ownsRequest) {C.job = result; C.busy = null; C.controller = null;}
    const count = result.accepted.length, msg = { role: 'bot',replyTo:requestId,status:result.status==='complete'?'complete':token.cancelled?'cancelled':'paused',providerName,
      text: result.status === 'complete' ? `Pack completo: ${count} de ${result.target} iconos, en ${result.attempts} lotes. Puedes exportar el grupo como ZIP.` : `Solicitud incompleta: ${count} de ${result.target} iconos guardados. ${result.reason} Puedes reanudar los pendientes.`,
      production: result, drawn: count ? { label: `Pack de ${count} iconos`, layers: count } : null,
      undo: ownsRequest && api.depth() > depth0 ? { from: depth0, to: api.depth() } : null };
    saveOutcome(docId,msg,messagesAtStart); return msg;
  }

  host.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.prov) { C.provider = b.dataset.prov; savePrefs(); renderProviders(); render(); return; }
    if(b.dataset.flow) {if(!C.busy) setMode(b.dataset.flow);return;}
    if (b.dataset.sug) {if(C.mode==='refine') {C.refine=b.dataset.sug.startsWith('Suaviza')?'contour':'style';$('#chatRefine').value=C.refine;} $('#chatIn').value=b.dataset.sug;inferRequest();C.error='';renderWorkflow();$('#chatIn').focus();return; }
    if (b.dataset.rmatt) { C.pending.splice(Number(b.dataset.rmatt), 1); renderAtts(); return; }
    if (b.id === 'chatAttach') { $('#chatFile').click(); return; }
    if (b.id === 'chatSend') { send($('#chatIn').value); return; }
    if (b.id === 'chatClear') { const docId=C.docId;C.messages = []; C.refs.clear(); C.referenceWarning='';saveMsgs();render();const cleared=await references.clear(docId);if(C.docId===docId&&!cleared.persisted&&!embedMode) {C.referenceWarning=cleared.reason||'No se pudo borrar la copia persistente de las referencias.';render();}return; }
    if(b.id==='chatCorrect') {C.refine='redraw';$('#chatRefine').value='redraw';setMode('refine');$('#chatIn').focus();return;}
    if(b.dataset.retry) {const retry=C.messages[Number(b.dataset.retry)]?.retry;if(!retry||C.busy) return;setMode(retry.mode||'create');if(retry.refinement) {C.refine=retry.refinement;$('#chatRefine').value=C.refine;}$('#chatIn').value=retry.text;renderWorkflow();$('#chatIn').focus();return;}
    if (['chatStop','chatStopCompose'].includes(b.id)) { if(C.busy?.token) C.busy.token.cancelled=true;C.controller?.abort(); if (C.busy?.runId) cancelAgent(C.busy.runId); return; }
    if (b.id === 'chatRevalidate') { try { const status=await revalidateIconJob(C.job,api.getText(),{rasterize:api.rasterizeProduction}); store.set(`aru-production:${C.docId}`,C.job); api.productionProgress?.(C.job); api.toast(`${status.count} piezas revalidadas · ${status.target-status.count} pendientes`); render(); } catch(err) {api.toast(err.message,true);} return; }
    if (b.id === 'chatResume') { produce(C.job.message, true); return; }
    if (b.dataset.apply) { const m = C.messages[Number(b.dataset.apply)], d0 = api.depth(); let r; try { if(m.applyVersion==null || m.applyVersion!==api.version()) throw new Error('Esta propuesta corresponde a otra versión. Pide el cambio de nuevo.');r = m.refinement ? api.refine(m.operations, m.refinement) : api.apply(m.operations,{selection:m.applySelection || [],expectedRevision:m.applyVersion}); } catch (err) { api.toast(err.message, true); return; } m.log = r.log; recordPaint(m.operations,r.log,m.applySelection || m.refinement?.selection || []); m.applied = r.log.filter((l) => l.ok).length; m.undo = api.depth() > d0 ? { from: d0, to: api.depth() } : null; saveMsgs(); render(); return; }
    if (b.dataset.undo) { const m = C.messages[Number(b.dataset.undo)]; if (m.undo && api.undoRange(m.undo.from, m.undo.to)) { m.undo = null; m.undone = true; m.applied = 0; m.traced = null; m.drawn = null; saveMsgs(); render(); } else api.toast('Ya hubo otros cambios después: usa ⌘Z', true); }
  });
  $('#chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e.target.value); } e.stopPropagation(); });
  $('#chatIn').addEventListener('paste', (e) => { for (const it of e.clipboardData?.items || []) if (it.kind === 'file') { const f = it.getAsFile(); if (f) { e.preventDefault(); addImage(f); } } });
  const comp = $('#chatCompose');
  comp.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); comp.classList.add('drop'); } });
  comp.addEventListener('dragleave', () => comp.classList.remove('drop'));
  comp.addEventListener('drop', (e) => { e.preventDefault(); comp.classList.remove('drop'); for (const f of e.dataTransfer.files) addImage(f); });
  $('#chatFile').addEventListener('change', (e) => { for (const f of e.target.files) addImage(f); e.target.value = ''; });
  $('#chatModel').addEventListener('change', e=>{if(e.target.value==='__custom') {$('#chatCustomModelField').hidden=false;$('#chatCustomModel').focus();return;} C.models[C.provider]=e.target.value;savePrefs();renderProviders();});
  $('#chatCustomModel').addEventListener('input',e=>{C.models[C.provider]=e.target.value.trim();e.target.setAttribute('aria-invalid',String(!validModel(C.models[C.provider])));savePrefs();$('#chatIdentity').textContent=`${PROVIDERS.find(p=>p.id===C.provider).name} · ${C.models[C.provider] || 'Predeterminado del CLI'}`;});
  $('#chatCanvas').addEventListener('change', (e) => { C.canvas = e.target.checked; savePrefs(); render(); });
  $('#chatRefine').addEventListener('change',e=>{C.refine=e.target.value;C.error='';renderWorkflow();});
  $('#chatKind').addEventListener('change',e=>{C.kind=e.target.value;C.kindExplicit=true;C.error='';renderWorkflow();});
  $('#chatQuantity').addEventListener('input',e=>{C.quantity=e.target.value;C.quantityEdited=true;C.error='';renderWorkflow();});
  $('#chatPurpose').addEventListener('input',e=>{C.purpose=e.target.value;C.error='';renderWorkflow();});
  $('#chatIn').addEventListener('input',()=>{inferRequest();C.error='';C.suggestion=null;renderWorkflow();});
  for(const [id,key] of [['chatStyle','style'],['chatMaterial','material'],['chatColor','color'],['chatAccent','accent']]) $('#'+id).addEventListener(key==='color'||key==='accent'?'input':'change',e=>{C[key]=e.target.value;C.error='';savePrefs();renderWorkflow();});
  $('#chatApplyAppearance').addEventListener('click',()=>{
    if(C.busy || C.mode!=='refine' || C.refine!=='style') return;
    try {
      if(!C.material&&!C.color&&!C.accent) throw new Error('Elige un acabado o un color. La estética se interpreta con «Refinar selección».');
      if(C.accent&&!C.color) throw new Error('Añade un color principal para usar un acento.');
      productionBrief('',{material:C.material,color:C.color,accent:C.accent});
      const scope=api.refinementScope('style'),op=C.color||C.accent?{op:'palette',target:'selection',color:C.color,accent:C.accent,material:C.material}:{op:'material',target:'selection',preset:C.material};
      const result=api.refine([op],scope);recordPaint([op],result.log);C.error='';api.toast(`Acabado aplicado a ${result.changed.length} piezas · puedes deshacer`);render();
    } catch(e) {C.error=e.message;renderWorkflow();}
  });
  $('#chatReview').addEventListener('change', (e) => { C.review = Number(e.target.value); savePrefs(); });

  renderProviders(); renderAtts(); render();
  detectAgents().then((list) => { C.agents = list; if (!list.find((a) => a.id === C.provider)?.installed) { const first = list.find((a) => a.installed); if (first) C.provider = first.id; } renderProviders(); render(); })
    .catch((e) => { $('#chatNote').textContent = e.message; });
  return {
    refresh: render,
    // A selection change cannot invalidate the production inventory or chat history.
    refreshSelection: renderWorkflow,
    recordPaint,
    async moveReferences(from,to) {await C.refsReady;const refs=C.docId===from?[...C.refs.values()]:await references.load(from);const result=await references.save(to,refs);if(result.persisted||embedMode) await references.clear(from);return result;},
    dropReferences:id=>references.clear(id),

    getProduction: () => {if(!C.job) return null; if(productionStatus(C.job,api.getText()).valid) synchronizeIconJob(C.job,api.getText()); return structuredClone(C.job);},
    revalidateProduction: async job => {if(C.busy) throw new Error('El asistente está trabajando'); const candidate=structuredClone(job || C.job); if(!candidate) throw new Error('No hay trabajo'); await revalidateIconJob(candidate,api.getText(),{rasterize:api.rasterizeProduction}); C.job=candidate; store.set(`aru-production:${C.docId}`,C.job); api.productionProgress?.(C.job); render(); return structuredClone(C.job);},
    stopProduction: () => { if(C.busy?.token) C.busy.token.cancelled=true;C.controller?.abort(); if (C.busy?.runId) cancelAgent(C.busy.runId); return !!C.controller; },
    resumeProduction: async job => { if (C.busy) throw new Error('El asistente ya está trabajando'); if (job) C.job = structuredClone(job); if (!C.job) throw new Error('No hay una producción pendiente'); return produce(C.job.message, true); },
    async request(message, options = {}) {
      if (C.busy) throw new Error('El asistente ya está trabajando');
      if (typeof message !== 'string' || !message.trim()) throw new Error('Se necesita un mensaje');
      if(options.mode && !['create','refine','consult'].includes(options.mode)) throw new Error('mode debe ser create/refine/consult');
      if (options.provider && !PROVIDERS.some(p => p.id === options.provider)) throw new Error('Proveedor desconocido');
      if (options.provider) C.provider = options.provider;
      if (options.model != null) {if(!validModel(options.model)) throw new Error('ID de modelo inválido');C.models[C.provider] = options.model;}
      if (options.refine != null) { if (!['off', 'style', 'contour','redraw'].includes(options.refine)) throw new Error('refine debe ser off/style/contour/redraw'); if(options.refine!=='off') {C.refine = options.refine; $('#chatRefine').value = C.refine;} }
      if (options.review != null) { if (![0, 1, 2].includes(options.review)) throw new Error('review debe ser 0/1/2'); C.review = options.review; }
      if (options.illustrator != null) C.illustrator = !!options.illustrator;
      if(options.mode) {setMode(options.mode);if(options.kind) {C.kind=options.kind;$('#chatKind').value=C.kind;}if(options.quantity!=null) {C.quantity=options.quantity;$('#chatQuantity').value=C.quantity;}}
      for(const key of ['style','material','color','accent','purpose','countMode']) if(options[key] != null) C[key]=options[key];
      if(!options.mode || options.mode==='create' || options.mode==='refine'&&['style','redraw'].includes(C.refine)) productionBrief(message,appearance());
      showBrief(appearance());
      C.auto = true;
      if ((options.images || []).length > 3) throw new Error('Máximo 3 referencias');
      for (const image of options.images || []) {
        const bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
        await addImage(new File([bytes], `${image.name || 'referencia'}.png`, { type: image.mime }));
      }
      renderProviders();
      const result = await send(message,{legacy:!options.mode,legacyRefine:options.refine || 'off'});
      if (!result) throw new Error('Consulta cancelada o documento cambiado');
      if (result.error || result.traceError || result.aruErrors) throw new Error(result.error || result.traceError || result.aruErrors.join('; '));
      return result;
    },
    setDoc(id, { keep = false } = {}) {
      if (C.busy && !keep) { if(C.busy.token) C.busy.token.cancelled=true;C.controller?.abort(); if (C.busy.runId) cancelAgent(C.busy.runId); C.busy = null; }
      C.docId = id;
      if (!keep) { C.purpose='';$('#chatPurpose').value='';C.countMode=undefined;C.error='';C.messages = loadMsgs(id); C.job = store.get(`aru-production:${id}`); if (C.job?.status === 'running') { C.job.status = 'paused'; C.job.reason = 'Sesión interrumpida; reanuda los pendientes'; } C.refs.clear(); C.pending = [];C.referenceWarning='';C.suggestion=null;C.refsLoading=true;
        C.refsReady=references.load(id).then(refs=>{if(C.docId!==id) return;C.refs=new Map(refs.map(r=>[r.name,r]));C.referenceWarning=references.status().reason||'';C.refSeq=Math.max(C.refSeq,...refs.map(r=>Number(/^ref(\d+)$/.exec(r.name)?.[1]||0)));}).catch(e=>{if(C.docId===id) C.referenceWarning='No se pudieron recuperar las referencias: '+e.message;}).finally(()=>{if(C.docId===id) {C.refsLoading=false;render();}});
        renderAtts(); }
      render();
    },
  };
}
