// Isolated editor mount. The host owns persistence and supplies the agent transport.
export function mountEditor(container, { text, name = 'Sin título', project, studioUrl = new URL('../index.html', import.meta.url), onChange = () => {}, onProduction = () => {}, agents, timeout = 120000 } = {}) {
  if (!container?.appendChild) throw new TypeError('Se necesita un elemento contenedor');
  const channel = crypto.randomUUID(), url = new URL(studioUrl, location.href);
  if (!/^https?:$/.test(url.protocol) || location.origin === 'null') throw new Error('Sirve el editor por HTTP(S)');
  url.searchParams.set('embed', channel); url.searchParams.set('parentOrigin', location.origin);
  const frame = document.createElement('iframe'); frame.title = 'ARU Studio'; frame.style.cssText = 'display:block;width:100%;height:100%;border:0';
  const pending = new Map(), runs = new Set(); let destroyed = false, sequence = 0, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error('El editor no respondió; revisa studioUrl y CSP')), timeout);
  const send = value => { if (!destroyed) frame.contentWindow.postMessage({ channel, ...value }, url.origin); };
  function request(method, args = {}) {
    if (destroyed) return Promise.reject(new Error('Editor destruido'));
    const id = ++sequence;
    return new Promise((resolve, reject) => { const expire = () => { pending.delete(id); reject(new Error(`Tiempo agotado: ${method}`)); }; const timer = setTimeout(expire, timeout); pending.set(id, { resolve, reject, timer, method, expire }); send({ type: 'request', id, method, args }); });
  }
  async function receive(event) {
    const m = event.data;
    if (destroyed || event.source !== frame.contentWindow || event.origin !== url.origin || m?.channel !== channel) return;
    if (m.type === 'ready') {
      clearTimeout(readyTimer);
      try { if (text !== undefined) await request('load', { text, name }); if(project!==undefined) await request('project',{project});readyResolve(api); } catch (e) { readyReject(e); }
    } else if (m.type === 'production') {
      // A long job has one RPC response but many committed batches. Progress renews its lease.
      for (const p of pending.values()) if (['ask', 'resumeProduction'].includes(p.method)) { clearTimeout(p.timer); p.timer = setTimeout(p.expire, Math.max(timeout, 370000)); }
      try { onProduction({ job: m.job, document: m.document }); } catch (e) { console.error('ARU onProduction:', e); }
    } else if (m.type === 'change') {
      try { onChange(m.document); } catch (e) { console.error('ARU onChange:', e); }
    } else if (m.type === 'response') {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) { const e = new Error(m.error.message); e.details = m.error.details; p.reject(e); } else p.resolve(m.result);
    } else if (m.type === 'agent') {
      const runId = m.args?.runId;
      try {
        if (!['detect', 'run', 'cancel'].includes(m.method)) throw new Error('Método de agente desconocido');
        if (m.method === 'run') runs.add(runId);
        const fn = agents?.[m.method];
        const result = fn ? await fn(m.args) : m.method === 'detect' ? [] : (() => { throw new Error('El host debe proporcionar agents.run/cancel'); })();
        send({ type: 'agentResponse', id: m.id, result });
      } catch (e) { send({ type: 'agentResponse', id: m.id, error: { message: e.message } }); }
      finally { if (m.method === 'run') runs.delete(runId); }
    }
  }
  const api = {
    element: frame, ready,
    load: (text, name) => request('load', { text, name }),
    getDocument: () => request('document'), context: () => request('context'),
    setProject: project => request('project',{project}),
    select: paths => request('select', { paths }),
    apply: (operations, options = {}) => request('apply', { operations, ...options }),
    refine: (operations, options = {}) => request('refine', { operations, ...options }),
    exportIcons: (options = {}) => request('exportIcons', options).then(r => ({ ...r, data: new Uint8Array(r.data) })),
    preview: operations => request('preview', { operations }),
    insert: (text, options = {}) => request('insert', { text, ...options }),
    trace: (image, reference = {}) => request('trace', { image, reference }),
    ask: (message, options = {}) => request('ask', { message, options }),
    getProduction: () => request('production'),
    stopProduction: () => request('stopProduction'),
    revalidateProduction: job => request('revalidateProduction',{job}),
    resumeProduction: job => request('resumeProduction', { job }),
    svg: () => request('svg'), png: () => request('png'), undo: () => request('undo'), redo: () => request('redo'),
    destroy() {
      if (destroyed) return; destroyed = true; clearTimeout(readyTimer); readyReject(new Error('Editor destruido')); window.removeEventListener('message', receive);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Editor destruido')); } pending.clear(); frame.remove();
      for (const runId of runs) Promise.resolve(agents?.cancel?.({ runId })).catch(() => {}); runs.clear();
    },
  };
  window.addEventListener('message', receive); frame.src = url.href; container.appendChild(frame);
  return api;
}
