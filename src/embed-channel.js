export function embedChannel() {
  const params = new URLSearchParams(location.search), channel = params.get('embed'), parentOrigin = params.get('parentOrigin');
  if (!channel || window.parent === window) return null;
  let origin; try { origin = new URL(parentOrigin).origin; } catch { throw new Error('parentOrigin inválido'); }
  if (!/^https?:/.test(origin) || origin !== parentOrigin) throw new Error('parentOrigin debe ser un origen HTTP(S)');
  const pending = new Map(); let seq = 0;
  const send = value => window.parent.postMessage({ channel, ...value }, origin);
  let handle;
  window.addEventListener('message', async event => {
    const m = event.data;
    if (event.source !== window.parent || event.origin !== origin || m?.channel !== channel) return;
    if (m.type === 'agentResponse') { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.type === 'request' && handle) {
      try { send({ type: 'response', id: m.id, result: await handle(m.method, m.args) }); }
      catch (e) { send({ type: 'response', id: m.id, error: { message: e.message, details: e.details || null } }); }
    }
  });
  return {
    change: document => send({ type: 'change', document }),
    production: value => send({ type: 'production', ...value }),
    bind(fn) { handle = fn; send({ type: 'ready' }); },
    agent(method, args = {}) { const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('El transporte de IA no respondió')); }, 370000); pending.set(id, { resolve, reject, timer }); send({ type: 'agent', id, method, args }); }); },
  };
}
