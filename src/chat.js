import { REFINEMENT_SYSTEM } from './refinement.js';
import { listMaterials } from './materials.js';
import { createIconJob, requestedIconCount, runIconJob, verifyIconJob } from './icon-production.js';
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

const SUGGEST = ['¿Qué ves en el lienzo?', 'Dale un acabado cromado a la selección', '¿Cómo puedo mejorar el contraste?'];

export function initChat(host, api) {
  const runAgent = api.runAgent || defaultRunAgent, detectAgents = api.detectAgents || defaultDetectAgents, cancelAgent = api.cancelAgent || defaultCancelAgent;
  const prefs = store.get('aru-chat-prefs') || {};
  const C = {
    agents: null, provider: prefs.provider || 'claude', models: prefs.models || { codex: 'gpt-5.5' }, auto: prefs.auto !== false,
    canvas: prefs.canvas !== false, illustrator: !!prefs.illustrator, review: Number.isInteger(prefs.review) ? prefs.review : 1,
    refine: 'off', docId: null, messages: [], busy: null, pending: [], refs: new Map(), refSeq: store.get('aru-chat-refseq') || 0, job: null, controller: null,
  };
  const savePrefs = () => store.set('aru-chat-prefs', { provider: C.provider, models: C.models, auto: C.auto, canvas: C.canvas, illustrator: C.illustrator, review: C.review });
  // one conversation per document
  const saveMsgs = () => { if (C.docId) store.set(`aru-chat:${C.docId}`, C.messages.slice(-60)); store.set('aru-chat-refseq', C.refSeq); };

  host.innerHTML = `
    <div class="chat-head">
      <div class="assistant-heading"><span>Tu mesa de trabajo</span><small>EDITAR CON IA</small></div>
      <details class="chat-settings"><summary>Motor y ajustes</summary>
      <div class="prov" id="chatProv"></div>
      <div class="line"><label class="field" style="flex:1"><span class="k">Modelo</span><input id="chatModel" placeholder="por defecto del CLI" spellcheck="false"></label></div>
      <div class="line toggles">
        <label title="Enviar una imagen del artboard con cada mensaje"><input type="checkbox" id="chatCanvas"> ver lienzo</label>
        <label title="Aplicar los cambios en cuanto llega la respuesta (siempre con deshacer)"><input type="checkbox" id="chatAuto"> aplicar</label>
        <label title="La IA puede dibujar escribiendo ARU (trazados, curvas). Apagado: solo edita, vectoriza referencias y agrega formas simples"><input type="checkbox" id="chatIll"> modo ilustrador</label>
        <label title="Al vectorizar una referencia, la IA ve original | resultado y propone ajustes; el Studio los mide y solo se queda con lo que puntúa mejor">revisión <select id="chatReview"><option value="0">no</option><option value="1">1 ronda</option><option value="2">2 rondas</option></select></label>
      </div>
      <div class="faint" id="chatNote"></div>
      </details>
      <label class="line" title="Protege las piezas seleccionadas y conserva su estructura">Conservar base <select id="chatRefine"><option value="off">Edición libre</option><option value="style">Cambiar estilo</option><option value="contour">Afinar curvas</option></select></label>
      <div class="line"><label>Material <select id="chatMaterial">${listMaterials().map(m => `<option value="${m.id}">${m.label}</option>`).join('')}</select></label><button class="btn sm" id="chatApplyMaterial" title="Aplica a las piezas seleccionadas, con deshacer">Aplicar a selección</button></div>
    </div>
    <div id="chatProduction" class="chat-production" hidden></div>
    <div class="chat-log" id="chatLog"></div>
    <div class="chat-compose" id="chatCompose">
      <div class="atts" id="chatAtts"></div>
      <textarea id="chatIn" rows="3" placeholder="¿Qué quieres cambiar? Puedes pegar una referencia…"></textarea>
      <div class="line"><button class="btn sm icon" id="chatAttach" title="Adjuntar imagen de referencia (también puedes pegar o arrastrar)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.5 12.6 21a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/></svg></button>
        <span class="faint" id="chatCtx"></span><span class="spacer"></span><button class="btn sm ghost" id="chatClear" title="Borrar la conversación">Limpiar</button><button class="btn sm primary" id="chatSend">Enviar</button></div>
      <input type="file" id="chatFile" accept="image/png,image/jpeg,image/webp" multiple hidden>
    </div>`;
  const $ = (s) => host.querySelector(s);

  // ---------- attachments: downscaled to <= 1024 px (enough to see and to trace; fewer tokens) ----------
  async function addImage(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { api.toast('Solo PNG, JPEG o WebP', true); return; }
    if (C.pending.length >= 3) { api.toast('Máximo 3 imágenes por mensaje', true); return; }
    const url = URL.createObjectURL(file);
    const img = new Image(); img.src = url; await img.decode();
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
    $('#chatModel').value = C.models[C.provider] ?? '';
    $('#chatModel').setAttribute('list', 'chatModels');
    $('#chatNote').textContent = a?.installed === false ? `${p.name} no está instalado en este equipo.` : `${p.note}${a?.version ? ` · ${a.version}` : ''}${isDesktop() ? '' : ' · vía servidor local'}`;
    let dl = document.getElementById('chatModels'); if (!dl) { dl = document.createElement('datalist'); dl.id = 'chatModels'; document.body.appendChild(dl); }
    dl.innerHTML = p.models.filter(Boolean).map((m) => `<option value="${esc(m)}">`).join('');
    $('#chatCanvas').checked = C.canvas; $('#chatAuto').checked = C.auto; $('#chatIll').checked = C.illustrator; $('#chatReview').value = String(C.review);
  }
  function bubble(m, i) {
    if (m.role === 'user') return `<div class="msg user">${m.thumbs?.length ? `<div class="thumbs">${m.thumbs.map((t) => `<img src="${t}" alt="">`).join('')}</div>` : ''}${esc(m.text)}</div>`;
    const ops = (m.operations || []).map((o, k) => `<li><b>${esc(o.op)}</b> ${esc(o.target ?? '')}${o.other ? ` ↔ ${esc(o.other)}` : ''}${o.preset ? ` · ${esc(o.preset)}` : ''}${o.fill ? ` · <i class="sw" style="background:${esc(o.fill)}"></i>${esc(o.fill)}` : ''}${o.pattern ? ` · “${esc(o.pattern)}”` : ''}${o.label && o.op !== 'rename' ? ` · “${esc(o.label)}”` : ''}${['smooth', 'simplify', 'weld', 'connect'].includes(o.op) && m.log?.[k]?.ok ? `<div class="faint">${esc(m.log[k].message)}</div>` : ''}</li>`).join('');
    const fails = (m.log || []).filter((l) => !l.ok).map((l) => `<div class="err">✗ ${esc(l.message)}</div>`).join('');
    const extra = [m.traced ? `<div class="ok">✓ Referencia vectorizada: <b>${esc(m.traced.label)}</b> · ${m.traced.regions} regiones${m.traced.score != null ? ` · puntuación ${m.traced.score}` : ` · ${m.traced.fidelity}% fidelidad`}${m.traced.tune ? ` · ${esc(m.traced.tune)}` : ''}${m.traced.note ? ` · ${esc(m.traced.note)}` : ''}</div>` : '',
      m.pack ? `<div class="faint">Pack de iconos: puntuación ${m.pack.start} → ${m.pack.end ?? m.pack.start}${m.pack.issues != null ? ` · ${m.pack.issues} iconos con avisos` : ''}${m.pack.rounds.map((r) => `<br>Revisión ${r.round}${r.misread?.length ? ` (prueba ciega: no se reconocen ${esc(r.misread.join(', '))})` : ''}: ${r.accept ? 'aceptado' : esc((r.changes || []).map((c) => `${c.what}${c.error ? ` ✗ ${c.error}` : ` → ${c.score}${c.kept ? ' ✓' : ' ✗'}`}`).join(' · ') || 'sin cambios')} — ${esc(r.reason)}`).join('')}</div>` : '',
      m.glyph?.rounds?.length ? `<div class="faint">${m.glyph.rounds.map((r) => `Icono, revisión ${r.round}: ${r.accept ? 'aceptado' : r.repeated ? 'ajuste ya probado' : `${esc(Object.entries(r.params || {}).map(([k, v]) => `${k} ${v}`).join(', '))} → ${r.score}${r.improved ? ' (mejor, se queda)' : ' (no mejora, se descarta)'}`} — ${esc(r.reason)}`).join('<br>')}</div>` : '',
      m.review?.length ? `<div class="faint">${m.review.map((r) => `Revisión ${r.round}: ${r.accept ? 'aceptado' : r.repeated ? 'propuso un ajuste ya probado' : `propuso ${esc(r.tune ? `${r.tune.ink === 'on' ? 'tinta' : 'sin tinta'}, finas ${r.tune.faint}, abstracción ${r.tune.abstraction}, detalle ${r.tune.detail}` : '—')} → ${r.score}${r.improved ? ' (mejor, se queda)' : ' (no mejora, se descarta)'}`} — ${esc(r.reason)}`).join('<br>')}</div>` : '', m.traceError ? `<div class="err">✗ No se pudo vectorizar la referencia: ${esc(m.traceError)}</div>` : '', m.groupError ? `<div class="faint">Agrupación por piezas no disponible (${esc(m.groupError)}); se usaron las cajas de las partes.</div>` : '',
      m.drawn ? `<div class="ok">✓ Dibujado en ARU: <b>${esc(m.drawn.label)}</b> · ${m.drawn.layers} capas${m.drawn.repaired ? ' (corregido tras un error de sintaxis)' : ''}${m.drawn.note ? ` · ${esc(m.drawn.note)}` : ''}</div>` : '', m.aruErrors ? `<div class="err">✗ El ARU escrito por la IA no compila: ${esc(m.aruErrors.join(' · '))}</div>` : '',
      m.aruIgnored ? '<div class="faint">La IA propuso un dibujo en ARU, pero el modo ilustrador está apagado.</div>' : ''].join('');
    const changed = (m.applied || 0) + (m.traced ? 1 : 0) + (m.drawn ? 1 : 0);
    const state = m.error ? '' : changed && m.undo ? `<div class="ok">✓ ${m.applied ? `${m.applied} de ${m.operations.length} operaciones aplicadas · ` : ''}<button class="link" data-undo="${i}">Deshacer</button></div>` : m.operations?.length && !m.applied && !m.undone ? `<button class="btn sm" data-apply="${i}">Aplicar ${m.operations.length} operaciones</button>` : m.undone ? '<div class="faint">Deshecho.</div>' : '';
    const meta = [m.providerName, m.ms ? `${(m.ms / 1000).toFixed(1)} s` : '', m.usage?.usd != null ? `$${m.usage.usd.toFixed(3)}` : '', m.usage?.tokens ? `${m.usage.tokens} tokens` : '', m.sawCanvas ? 'vio el lienzo' : ''].filter(Boolean).join(' · ');
    return `<div class="msg bot${m.error ? ' error' : ''}"><div class="txt">${m.error ? esc(m.error) : md(m.text)}</div>${extra}${ops ? `<details${m.applied ? '' : ' open'}><summary>${m.operations.length} operaciones</summary><ul>${ops}</ul></details>` : ''}${fails}${state}<div class="meta">${esc(meta)}</div></div>`;
  }
  function render() {
    const production = $('#chatProduction');
    production.hidden = !C.job;
    if (C.job) {
      const j = C.job, done = j.accepted.length;
      let invalid = ''; if (!C.busy) { try { verifyIconJob(j, api.getText()); } catch (e) { invalid = e.message; } }
      production.innerHTML = `<div class="line"><b>${invalid ? 'Documento modificado' : j.status === 'complete' ? 'Pack completo' : j.status === 'running' ? 'Produciendo iconos' : 'Producción en pausa'}</b><span class="spacer"></span><span>${invalid ? '—' : done} / ${j.target}</span></div><progress max="${j.target}" value="${invalid ? 0 : done}" aria-label="Iconos aceptados"></progress><small>${invalid ? 'Inventario pendiente de validar' : j.status === 'complete' ? 'Cantidad verificada en el documento' : `${j.target - done} pendientes · lotes de ${j.batchSize}`}</small>${invalid || j.reason ? `<p>${esc(invalid || j.reason)}</p>` : ''}${!C.busy && !invalid && j.status !== 'complete' ? '<button class="btn sm" id="chatResume">Reanudar pendientes</button>' : ''}`;
    }
    const log = $('#chatLog');
    if (!C.messages.length && !C.busy) log.innerHTML = `<div class="chat-empty"><div class="assistant-sketch" aria-hidden="true"><svg viewBox="0 0 160 70" fill="none"><path d="M9 48C31 48 25 15 51 22S69 58 93 39 111 14 142 26" stroke="currentColor" stroke-width="2"/><circle cx="51" cy="22" r="4"/><circle cx="93" cy="39" r="4"/><path d="M51 5v12M93 44v18" stroke="currentColor"/></svg></div><h2>Empieza con una idea.</h2><p>Selecciona una pieza y pide un cambio de color, acabado o trazo. También puedes traer una imagen de referencia. Cada cambio se puede deshacer.</p><div class="sugs">${SUGGEST.map((s) => `<button data-sug="${esc(s)}">${esc(s)}<span aria-hidden="true">↗</span></button>`).join('')}</div></div>`;
    else log.innerHTML = C.messages.map(bubble).join('') + (C.busy ? `<div class="msg bot busy"><span class="dots"><i></i><i></i><i></i></span> ${esc(C.busy.status)} <span id="chatTimer">0 s</span> <button class="link" id="chatStop">Detener</button></div>` : '');
    log.scrollTop = C.messages.length || C.busy ? log.scrollHeight : 0;
    $('#chatSend').disabled = !!C.busy;
    const sel = api.selection();
    $('#chatCtx').textContent = `${sel.length ? `${sel.length} capa(s) seleccionada(s)` : 'documento completo'}${C.canvas ? ' · ve el lienzo' : ''}`;
  }

  async function ask(text, history, images, refinement = null) {
    const p = PROVIDERS.find((x) => x.id === C.provider);
    const runId = `r${Date.now()}`;
    C.busy = { ...C.busy, runId };
    const res = await runAgent({ provider: C.provider, model: C.models[C.provider] || '', system: systemPrompt({ illustrator: C.illustrator }) + (refinement ? '\n' + REFINEMENT_SYSTEM : ''), prompt: buildPrompt({ context: api.context() + (refinement ? '\nRefinement scope: ' + JSON.stringify(refinement) : ''), selection: api.selection(), history, message: text, images }), schema: ANSWER_SCHEMA, runId, images: images.map(({ name, mime, data }) => ({ name, mime, data })) });
    if (res.cancelled) throw new Error('Detenido');
    return { res, ans: parseAnswer(C.provider, res), p };
  }

  // one review round: the model sees original | result + the measured score and proposes a tune (or accepts)
  async function askStructured(system, prompt, schema, images) {
    const runId = `s${Date.now()}`;
    C.busy = { ...C.busy, runId };
    const res = await runAgent({ provider: C.provider, model: C.models[C.provider] || '', system, prompt, schema, runId, images });
    if (res.cancelled) throw new Error('Detenido');
    const { answer, usage } = extractStructured(C.provider, res);
    if (!answer) throw new Error('La respuesta no tiene el formato esperado');
    return { answer, usage, ms: res.ms || 0 };
  }
  async function review(st, label, png, userText) {
    const prompt = buildReviewPrompt({ label, current: st.best.tune, metrics: st.best.metrics, tried: st.tried, userText });
    const r = await askStructured(REVIEW_SYSTEM, prompt, REVIEW_SCHEMA, [{ name: 'compare', mime: 'image/png', data: png }]);
    if (typeof r.answer.accept !== 'boolean') throw new Error('La revisión no tiene el formato esperado');
    return r;
  }

  async function send(text) {
    text = text.trim(); if ((!text && !C.pending.length) || C.busy) return;
    if (!text) text = 'Vectoriza la imagen adjunta y colócala en el lienzo.';
    const p = PROVIDERS.find((x) => x.id === C.provider), a = C.agents?.find((x) => x.id === C.provider);
    if (a && !a.installed) { api.toast(`${p.name} no está instalado`, true); return; }
    const target = requestedIconCount(text);
    if (target > 24 && C.refine === 'off') {
      if (!C.auto) { api.toast('Activa aplicar para producir y guardar cada lote automáticamente', true); return; }
      if (target > 1000) { api.toast('El límite por trabajo es de 1000 iconos; divide el pedido en varios trabajos', true); return; }
      return produce(text);
    }
    const history = C.messages.slice();
    const newRefs = C.pending.splice(0);
    for (const r of newRefs) C.refs.set(r.name, r);
    C.messages.push({ role: 'user', text, thumbs: newRefs.map((r) => r.thumb) });
    C.busy = { status: `${p.name} está pensando…`, t0: Date.now() };
    $('#chatIn').value = ''; renderAtts(); render(); saveMsgs();
    const tick = setInterval(() => { const t = host.querySelector('#chatTimer'); if (t && C.busy) t.textContent = `${Math.round((Date.now() - C.busy.t0) / 1000)} s`; }, 500);
    const msg = { role: 'bot', providerName: p.name };
    const depth0 = api.depth(), docAtStart = C.docId;
    let expectedVersion = api.version?.();
    const stale = () => C.docId !== docAtStart || (expectedVersion != null && api.version() !== expectedVersion); // the user switched documents while waiting: never apply here
    const discardStale = () => { clearInterval(tick); if (C.docId === docAtStart) { C.busy = null; api.toast('El documento cambió; la respuesta anterior se descartó'); render(); } };
    try {
      // images: the artboard + this message's references + up to two earlier ones (so "vectorízala" still works)
      // at most 4 images per run: this message's references first, then the artboard, then the latest earlier references
      const MAX_IMAGES = 4, images = [];
      const fresh = newRefs.slice(0, MAX_IMAGES);
      if (newRefs.length > MAX_IMAGES) api.toast(`Se envían ${MAX_IMAGES} imágenes por mensaje; las demás se quedan para el siguiente.`, true);
      if (C.canvas && fresh.length < MAX_IMAGES) { const snap = await api.snapshot(); if (snap) { images.push({ name: 'canvas', mime: 'image/png', ext: 'png', data: snap }); msg.sawCanvas = true; } }
      const room = MAX_IMAGES - images.length - fresh.length;
      const older = room > 0 ? [...C.refs.values()].filter((r) => !newRefs.includes(r)).slice(-Math.min(2, room)) : [];
      images.push(...older, ...fresh);
      const refinement = C.refine === 'off' ? null : api.refinementScope(C.refine);
      msg.refinement = refinement;
      let { res, ans } = await ask(text, history, images, refinement);
      if (refinement && (ans.aru || ans.reference)) throw new Error('La IA intentó reemplazar la base; el refinamiento fue rechazado');
      if (stale()) { discardStale(); return; }
      msg.ms = res.ms;
      Object.assign(msg, { text: ans.reply, operations: ans.operations, usage: ans.usage });
      // 1) illustrator mode: ARU written by the AI (one automatic repair round if it does not compile)
      if (ans.aru) {
        if (!C.illustrator) msg.aruIgnored = true;
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
                const rb = await askStructured(BLIND_SYSTEM, buildBlindPrompt(blind), BLIND_SCHEMA, [{ name: 'blind', mime: 'image/png', data: blind.png }]);
                msg.ms += rb.ms; if (rb.usage?.usd != null) msg.usage = { ...(msg.usage || {}), usd: (msg.usage?.usd || 0) + rb.usage.usd };
                const misread = await api.packSetRecognition(pk, blind, rb.answer.answers);
                if (round === 1) msg.pack.start = pk.ins.score;
                C.busy.status = `${p.name} revisa el pack de iconos (ronda ${round})…`; render();
                const png = await api.packReviewPng(pk);
                const rp = await askStructured(packSystem(), buildPackPrompt({ report: pk.report, userText: text, tried: pk.tried }), PACK_SCHEMA, [{ name: 'pack', mime: 'image/png', data: png }]);
                msg.ms += rp.ms; if (rp.usage?.usd != null) msg.usage = { ...(msg.usage || {}), usd: (msg.usage?.usd || 0) + rp.usage.usd };
                const entry = { round, accept: !!rp.answer.accept, reason: rp.answer.reason || '', misread };
                msg.pack.rounds.push(entry);
                if (rp.answer.accept) break;
                C.busy.status = `Aplicando y midiendo los cambios de ${p.name}…`; render();
                entry.changes = await api.packApply(pk, rp.answer);
              }
              msg.pack.end = pk.ins.score; msg.pack.issues = pk.ins.icons.filter((i) => i.issues.length).length;
              aruText = api.packFragment(pk);
            }
          }
          if (stale()) { discardStale(); return; }
          let r = api.insertAru(aruText, ans.reference?.label || null, ans.aruInto);
          if (!r.ok) {
            C.busy.status = 'Corrigiendo el ARU…'; render();
            const fix = await ask(`Your "aru" did not compile:\n${r.errors.join('\n')}\nReturn the complete corrected "aru" (same drawing), operations [] and reference.use=false.`, [...history, { role: 'user', text }, { role: 'bot', text: ans.reply }], images.filter((i) => i.name === 'canvas'));
            msg.ms += fix.res.ms;
            if (stale()) { discardStale(); return; }
            if (fix.ans.aru) { r = api.insertAru(fix.ans.aru, null, ans.aruInto); if (r.ok) r.repaired = true; }
          }
          expectedVersion = api.version?.();
          if (r.ok) msg.drawn = { label: r.label, layers: r.layers, repaired: !!r.repaired, note: r.note }; else msg.aruErrors = r.errors.slice(0, 3);
        }
      }
      // 2) reference: the AI gave context, the tracer measures and draws
      if (ans.reference) {
        const att = C.refs.get(ans.reference.image) || newRefs[0] || [...C.refs.values()].pop();
        if (!att) msg.traceError = 'no hay ninguna imagen adjunta';
        else {
          C.busy.status = `Vectorizando ${att.name} con el tracer…`; render();
          try {
            // auto-tune (deterministic), then up to C.review AI review rounds; the score keeps the best, then insert
            const st = await api.traceRefState(att, ans.reference, (k, n) => { C.busy.status = `Vectorizando ${att.name}: variante ${k} de ${n}…`; render(); });
            msg.review = [];
            for (let round = 1; round <= C.review && !stale(); round++) {
              C.busy.status = `${p.name} revisa el resultado (ronda ${round})…`; render();
              const cmp = await api.compareRefPng(st);
              const rv = await review(st, ans.reference.label || att.name, cmp, text);
              msg.ms += rv.ms;
              if (rv.usage?.usd != null) msg.usage = { ...(msg.usage || {}), usd: (msg.usage?.usd || 0) + rv.usage.usd };
              const entry = { round, accept: !!rv.answer.accept, reason: rv.answer.reason || '' };
              msg.review.push(entry);
              if (rv.answer.accept) break;
              C.busy.status = `Probando el ajuste de ${p.name}…`; render();
              const out = await api.retraceRef(st, rv.answer.tune);
              Object.assign(entry, { tune: out.tune, score: out.metrics.score, improved: out.improved, repeated: !!out.repeated });
            }
            if (stale()) { discardStale(); return; }
            // grouping: the AI sees the numbered pieces of the result and says which part each one belongs to
            let assignments = null;
            if (ans.reference.parts?.length) {
              C.busy.status = `${p.name} asigna cada pieza a su parte…`; render();
              try {
                const pc = await api.piecesRef(st);
                const ra = await askStructured(PIECES_SYSTEM, buildPiecesPrompt({ parts: ans.reference.parts, count: pc.count }), PIECES_SCHEMA, [{ name: 'pieces', mime: 'image/png', data: pc.png }]);
                msg.ms += ra.ms; if (ra.usage?.usd != null) msg.usage = { ...(msg.usage || {}), usd: (msg.usage?.usd || 0) + ra.usage.usd };
                assignments = Array.isArray(ra.answer?.assignments) ? ra.answer.assignments : null;
              } catch (e) { msg.groupError = e.message; }
            }
            if (stale()) { discardStale(); return; }
            C.busy.status = 'Agrupando las capas por partes…'; render();
            const grp = await api.groupRef(st, assignments);
            msg.pieces = { assignments: (assignments || []).slice(0, 80), unknown: grp.unknownParts || [], moved: grp.byPieces || 0, ...(grp.reason ? { notGrouped: grp.reason } : {}) };
            if (stale()) { discardStale(); return; }
            // glyph icons: the tool inspects the built icon (specks, thin parts, thin cuts, jagged edges, fidelity) and the
            // AI moves the cleanup levers; the icon score keeps the best
            if (ans.reference.backdrop?.style === 'glyph') {
              C.busy.status = 'Construyendo el glifo e inspeccionando su calidad…'; render();
              const gp = await api.glyphPrepare(st, ans.reference);
              let report = gp.report;
              msg.glyph = { start: gp.inspection.score, rounds: [] };
              for (let round = 1; round <= C.review && !stale(); round++) {
                C.busy.status = `${p.name} revisa el icono (ronda ${round})…`; render();
                const rg = await askStructured(GLYPH_SYSTEM, buildGlyphPrompt({ report, userText: text, tried: st.glyph?.tried || [] }), GLYPH_SCHEMA, [{ name: 'icon', mime: 'image/png', data: await api.glyphReviewPng(st, ans.reference) }]);
                msg.ms += rg.ms; if (rg.usage?.usd != null) msg.usage = { ...(msg.usage || {}), usd: (msg.usage?.usd || 0) + rg.usage.usd };
                const entry = { round, accept: !!rg.answer.accept, reason: rg.answer.reason || '' };
                msg.glyph.rounds.push(entry);
                if (rg.answer.accept) break;
                const out = await api.glyphRetune(st, rg.answer.params || {});
                Object.assign(entry, { params: out.params, score: out.score, improved: out.improved, repeated: !!out.repeated });
                report = out.report;
              }
            }
            if (stale()) { discardStale(); return; }
            const t = await api.insertRef(st, att, ans.reference);
            expectedVersion = api.version?.();
            if (grp.grouped) t.note = [`${grp.groups} grupos por partes${assignments ? ` (${assignments.length} piezas asignadas por ${p.name})` : ''}`, t.note].filter(Boolean).join(' · ');
            else if (grp.reason) t.note = [`sin agrupar: ${grp.reason}`, t.note].filter(Boolean).join(' · ');
            msg.ref = { crop: ans.reference.crop || null, backdrop: ans.reference.backdrop || null, parts: (ans.reference.parts || []).slice(0, 40) };
            msg.traced = { label: ans.reference.label || att.name, regions: t.regions, fidelity: t.fidelity, score: t.score, tune: t.tune, note: t.note };
          } catch (e) { msg.traceError = e.message; }
        }
      }
      if (stale()) { discardStale(); return; }
      // 3) batch operations
      if (refinement && ans.operations.length && !C.auto) api.previewRefinement(ans.operations, refinement);
      if (ans.operations.length && C.auto) { const r = refinement ? api.refine(ans.operations, refinement) : api.apply(ans.operations); msg.log = r.log; msg.applied = r.log.filter((l) => l.ok).length; expectedVersion = api.version?.(); }
    } catch (e) { msg.error = e.message || String(e); }
    if (stale()) { discardStale(); return; }
    msg.undo = api.depth() > depth0 ? { from: depth0, to: api.depth() } : null;
    clearInterval(tick);
    C.busy = null;
    C.messages.push(msg);
    render(); saveMsgs();
    return msg;
  }

  async function produce(text, resume = false) {
    if (C.busy) return;
    const docId = C.docId, controller = new AbortController(), depth0 = api.depth();
    const job = resume ? C.job : createIconJob(text);
    C.job = job; C.controller = controller;
    if (!resume) C.messages.push({ role: 'user', text });
    const images = C.pending.splice(0).map(({ name, mime, data }) => ({ name, mime, data }));
    // References stay with the job across pause/resume. Embedded hosts receive the job in the reply.
    if (!resume) { job.images = images; job.context = api.context(); }
    C.busy = { status: `Preparando ${job.target} iconos por lotes…`, t0: Date.now() };
    $('#chatIn').value = ''; renderAtts(); render(); saveMsgs();
    const tick = setInterval(() => { const t = $('#chatTimer'); if (t && C.busy) t.textContent = `${Math.round((Date.now() - C.busy.t0) / 1000)} s`; }, 500);
    let result;
    try {
      if (!resume && C.canvas && job.images.length < 4) { const snap = await api.snapshot(); if (snap) job.images.push({ name: 'canvas', mime: 'image/png', data: snap }); }
      result = await runIconJob(job, {
        getText: () => { if (C.docId !== docId) throw new Error('Se cambió de documento'); return api.getText(); },
        commit: (next, before) => { if (C.docId !== docId || api.getText() !== before) throw new Error('El documento cambió'); api.commitProduction(next); },
        request: async (system, prompt, schema) => (await askStructured(system, prompt, schema, job.images || [])).answer,
        signal: controller.signal,
        rasterize: api.rasterizeProduction,
        checkpoint: async state => { if (!store.set(`aru-production:${docId}`, state)) throw new Error('No se pudo guardar el trabajo: almacenamiento local lleno o no disponible'); },
        progress: state => { if (C.docId === docId) { C.job = state; api.productionProgress?.(state); if (C.busy) C.busy.status = `${state.accepted.length} de ${state.target} · generando el siguiente lote…`; render(); } },
      });
    } catch (e) { result = { ...job, status: 'paused', reason: e.message }; store.set(`aru-production:${docId}`, result); }
    finally { clearInterval(tick); }
    if (C.docId !== docId) return;
    C.job = result; C.busy = null; C.controller = null;
    const count = result.accepted.length, msg = { role: 'bot', providerName: PROVIDERS.find(p => p.id === C.provider).name,
      text: result.status === 'complete' ? `Pack completo: ${count} de ${result.target} iconos, en ${result.attempts} lotes. Puedes exportar el grupo como ZIP.` : `Solicitud incompleta: ${count} de ${result.target} iconos guardados. ${result.reason} Puedes reanudar los pendientes.`,
      production: result, drawn: count ? { label: `Pack de ${count} iconos`, layers: count } : null,
      undo: api.depth() > depth0 ? { from: depth0, to: api.depth() } : null };
    C.messages.push(msg); render(); saveMsgs(); return msg;
  }

  host.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.prov) { C.provider = b.dataset.prov; savePrefs(); renderProviders(); render(); return; }
    if (b.dataset.sug) { send(b.dataset.sug); return; }
    if (b.dataset.rmatt) { C.pending.splice(Number(b.dataset.rmatt), 1); renderAtts(); return; }
    if (b.id === 'chatAttach') { $('#chatFile').click(); return; }
    if (b.id === 'chatSend') { send($('#chatIn').value); return; }
    if (b.id === 'chatClear') { C.messages = []; C.refs.clear(); saveMsgs(); render(); return; }
    if (b.id === 'chatStop') { C.controller?.abort(); if (C.busy?.runId) cancelAgent(C.busy.runId); return; }
    if (b.id === 'chatResume') { produce(C.job.message, true); return; }
    if (b.dataset.apply) { const m = C.messages[Number(b.dataset.apply)], d0 = api.depth(); let r; try { r = m.refinement ? api.refine(m.operations, m.refinement) : api.apply(m.operations); } catch (err) { api.toast(err.message, true); return; } m.log = r.log; m.applied = r.log.filter((l) => l.ok).length; m.undo = api.depth() > d0 ? { from: d0, to: api.depth() } : null; saveMsgs(); render(); return; }
    if (b.dataset.undo) { const m = C.messages[Number(b.dataset.undo)]; if (m.undo && api.undoRange(m.undo.from, m.undo.to)) { m.undo = null; m.undone = true; m.applied = 0; m.traced = null; m.drawn = null; saveMsgs(); render(); } else api.toast('Ya hubo otros cambios después: usa ⌘Z', true); }
  });
  $('#chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e.target.value); } e.stopPropagation(); });
  $('#chatIn').addEventListener('paste', (e) => { for (const it of e.clipboardData?.items || []) if (it.kind === 'file') { const f = it.getAsFile(); if (f) { e.preventDefault(); addImage(f); } } });
  const comp = $('#chatCompose');
  comp.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); comp.classList.add('drop'); } });
  comp.addEventListener('dragleave', () => comp.classList.remove('drop'));
  comp.addEventListener('drop', (e) => { e.preventDefault(); comp.classList.remove('drop'); for (const f of e.dataTransfer.files) addImage(f); });
  $('#chatFile').addEventListener('change', (e) => { for (const f of e.target.files) addImage(f); e.target.value = ''; });
  $('#chatModel').addEventListener('change', (e) => { C.models[C.provider] = e.target.value.trim(); savePrefs(); });
  $('#chatAuto').addEventListener('change', (e) => { C.auto = e.target.checked; savePrefs(); });
  $('#chatCanvas').addEventListener('change', (e) => { C.canvas = e.target.checked; savePrefs(); render(); });
  $('#chatRefine').addEventListener('change', e => { C.refine = e.target.value; api.toast(C.refine === 'off' ? 'Edición libre' : 'Selecciona las piezas y pide el cambio; sus nombres y estructura quedan protegidos'); });
  $('#chatApplyMaterial').addEventListener('click', () => {
    if (C.busy) { api.toast('Espera a que termine el cambio en curso', true); return; }
    try { const scope = api.refinementScope('style'); const r = api.refine([{ op: 'material', target: 'selection', preset: $('#chatMaterial').value }], scope); api.toast(`Material aplicado a ${r.changed.length} piezas · puedes deshacer`); }
    catch (e) { api.toast(e.message, true); }
  });
  $('#chatReview').addEventListener('change', (e) => { C.review = Number(e.target.value); savePrefs(); });
  $('#chatIll').addEventListener('change', (e) => { C.illustrator = e.target.checked; savePrefs(); api.toast(C.illustrator ? 'Modo ilustrador: la IA puede dibujar escribiendo ARU' : 'Modo ilustrador apagado'); });

  renderProviders(); renderAtts(); render();
  detectAgents().then((list) => { C.agents = list; if (!list.find((a) => a.id === C.provider)?.installed) { const first = list.find((a) => a.installed); if (first) C.provider = first.id; } renderProviders(); render(); })
    .catch((e) => { $('#chatNote').textContent = e.message; });
  return {
    refresh: render,
    getProduction: () => C.job ? structuredClone(C.job) : null,
    stopProduction: () => { C.controller?.abort(); if (C.controller && C.busy?.runId) cancelAgent(C.busy.runId); return !!C.controller; },
    resumeProduction: async job => { if (C.busy) throw new Error('El asistente ya está trabajando'); if (job) C.job = structuredClone(job); if (!C.job) throw new Error('No hay una producción pendiente'); return produce(C.job.message, true); },
    async request(message, options = {}) {
      if (C.busy) throw new Error('El asistente ya está trabajando');
      if (typeof message !== 'string' || !message.trim()) throw new Error('Se necesita un mensaje');
      if (options.provider && !PROVIDERS.some(p => p.id === options.provider)) throw new Error('Proveedor desconocido');
      if (options.provider) C.provider = options.provider;
      if (options.model != null) C.models[C.provider] = options.model;
      if (options.refine != null) { if (!['off', 'style', 'contour'].includes(options.refine)) throw new Error('refine debe ser off/style/contour'); C.refine = options.refine; $('#chatRefine').value = C.refine; }
      if (options.review != null) { if (![0, 1, 2].includes(options.review)) throw new Error('review debe ser 0/1/2'); C.review = options.review; }
      if (options.illustrator != null) C.illustrator = !!options.illustrator;
      C.auto = true;
      if ((options.images || []).length > 3) throw new Error('Máximo 3 referencias');
      for (const image of options.images || []) {
        const bytes = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
        await addImage(new File([bytes], `${image.name || 'referencia'}.png`, { type: image.mime }));
      }
      renderProviders();
      const result = await send(message);
      if (!result) throw new Error('Consulta cancelada o documento cambiado');
      if (result.error || result.traceError || result.aruErrors) throw new Error(result.error || result.traceError || result.aruErrors.join('; '));
      return result;
    },
    setDoc(id, { keep = false } = {}) {
      if (C.busy && !keep) { C.controller?.abort(); if (C.busy.runId) cancelAgent(C.busy.runId); C.busy = null; }
      C.docId = id;
      if (!keep) { C.messages = store.get(`aru-chat:${id}`) || []; C.job = store.get(`aru-production:${id}`); if (C.job?.status === 'running') { C.job.status = 'paused'; C.job.reason = 'Sesión interrumpida; reanuda los pendientes'; } C.refs.clear(); C.pending = []; renderAtts(); }
      render();
    },
  };
}
