// Document library: projects that contain documents. Two backends, one API:
//   - files   (desktop app): a workspace folder, by default ~/Documents/ARU Studio/<Project>/<Document>.aru
//             real files the user can see, copy and version; deletes go to <workspace>/.papelera
//   - browser (web Studio):  localStorage (index + one key per document)
// API: list() -> { projects: [{ id, name, docs: [{ id, name, project, updated }] }] }
//      read(id) · write(id, text) · create(projectId, name, text) -> id · rename(id, name) -> id · move(id, projectId) -> id
//      duplicate(id) -> id · remove(id) · createProject(name) -> id · renameProject(id, name) -> id · removeProject(id)
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }, del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } } };
const cleanName = (s, fallback) => String(s || '').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80) || fallback;
const unique = (name, taken) => { if (!taken.has(name.toLowerCase())) return name; let k = 2; while (taken.has(`${name} ${k}`.toLowerCase())) k++; return `${name} ${k}`; };

// ---------------------------------------------------------------- browser backend
function browserLibrary() {
  const KEY = 'aru-lib';
  const idx = () => store.get(KEY) || { projects: [], docs: [] };
  const put = (x) => store.set(KEY, x);
  const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    kind: 'browser', rootLabel: 'este navegador',
    async list() {
      const x = idx();
      return { projects: x.projects.map((p) => ({ ...p, docs: x.docs.filter((d) => d.project === p.id).sort((a, b) => b.updated - a.updated) })) };
    },
    async read(id) { const t = localStorage.getItem(`aru-doc:${id}`); if (t == null) throw new Error('documento no encontrado'); return t; },
    async write(id, text) {
      const x = idx(), d = x.docs.find((v) => v.id === id); if (!d) throw new Error('documento no encontrado');
      try { localStorage.setItem(`aru-doc:${id}`, text); } catch { throw new Error('el almacenamiento del navegador está lleno: exporta o borra documentos'); }
      d.updated = Date.now(); put(x);
    },
    async createProject(name) { const x = idx(); const p = { id: newId('p'), name: unique(cleanName(name, 'Proyecto'), new Set(x.projects.map((v) => v.name.toLowerCase()))), created: Date.now() }; x.projects.push(p); put(x); return p.id; },
    async renameProject(id, name) { const x = idx(), p = x.projects.find((v) => v.id === id); p.name = unique(cleanName(name, p.name), new Set(x.projects.filter((v) => v !== p).map((v) => v.name.toLowerCase()))); put(x); return id; },
    async removeProject(id) { const x = idx(); if (x.docs.some((d) => d.project === id)) throw new Error('el proyecto no está vacío'); x.projects = x.projects.filter((p) => p.id !== id); put(x); },
    async create(project, name, text) {
      const x = idx();
      const d = { id: newId('d'), name: unique(cleanName(name, 'Sin título'), new Set(x.docs.filter((v) => v.project === project).map((v) => v.name.toLowerCase()))), project, created: Date.now(), updated: Date.now() };
      try { localStorage.setItem(`aru-doc:${d.id}`, text); } catch { throw new Error('el almacenamiento del navegador está lleno: exporta o borra documentos'); }
      x.docs.push(d); put(x); return d.id;
    },
    async rename(id, name) { const x = idx(), d = x.docs.find((v) => v.id === id); d.name = unique(cleanName(name, d.name), new Set(x.docs.filter((v) => v.project === d.project && v !== d).map((v) => v.name.toLowerCase()))); put(x); return id; },
    async move(id, project) { const x = idx(), d = x.docs.find((v) => v.id === id); d.project = project; d.name = unique(d.name, new Set(x.docs.filter((v) => v.project === project && v !== d).map((v) => v.name.toLowerCase()))); put(x); return id; },
    async duplicate(id) { const x = idx(), d = x.docs.find((v) => v.id === id); return this.create(d.project, `${d.name} copia`, await this.read(id)); },
    async remove(id) { const x = idx(); x.docs = x.docs.filter((d) => d.id !== id); put(x); store.del(`aru-doc:${id}`); },
    nameOf: async (id) => idx().docs.find((d) => d.id === id)?.name ?? null,
    projectOf: async (id) => idx().docs.find((d) => d.id === id)?.project ?? null,
  };
}

// ---------------------------------------------------------------- files backend (Tauri)
function filesLibrary(invoke, root) {
  const docId = (project, name) => `${project}/${name}.aru`;
  const split = (id) => { const [project, file] = id.split('/'); return { project, name: file.replace(/\.aru$/, '') }; };
  return {
    kind: 'files', rootLabel: root,
    async list() {
      const raw = await invoke('ws_list');
      return { projects: raw.map((p) => ({ id: p.name, name: p.name, docs: p.docs.map((d) => ({ id: docId(p.name, d.name), name: d.name, project: p.name, updated: d.modified })).sort((a, b) => b.updated - a.updated) })) };
    },
    read: (id) => invoke('ws_read', { rel: id }),
    write: (id, text) => invoke('ws_write', { rel: id, contents: text }),
    async createProject(name) {
      const taken = new Set((await invoke('ws_list')).map((p) => p.name.toLowerCase()));
      const n = unique(cleanName(name, 'Proyecto'), taken); await invoke('ws_mkdir', { rel: n }); return n;
    },
    async renameProject(id, name) {
      const taken = new Set((await invoke('ws_list')).filter((p) => p.name !== id).map((p) => p.name.toLowerCase()));
      const n = unique(cleanName(name, id), taken); if (n !== id) await invoke('ws_rename', { from: id, to: n }); return n;
    },
    async removeProject(id) { const p = (await invoke('ws_list')).find((v) => v.name === id); if (p?.docs.length) throw new Error('el proyecto no está vacío'); await invoke('ws_trash', { rel: id }); },
    async create(project, name, text) {
      const p = (await invoke('ws_list')).find((v) => v.name === project);
      const n = unique(cleanName(name, 'Sin título'), new Set((p?.docs || []).map((d) => d.name.toLowerCase())));
      const id = docId(project, n); await invoke('ws_write', { rel: id, contents: text }); return id;
    },
    async rename(id, name) {
      const { project, name: old } = split(id);
      const p = (await invoke('ws_list')).find((v) => v.name === project);
      const n = unique(cleanName(name, old), new Set((p?.docs || []).filter((d) => d.name !== old).map((d) => d.name.toLowerCase())));
      if (n === old) return id;
      const to = docId(project, n); await invoke('ws_rename', { from: id, to }); return to;
    },
    async move(id, project) {
      const { name } = split(id);
      const p = (await invoke('ws_list')).find((v) => v.name === project);
      const n = unique(name, new Set((p?.docs || []).map((d) => d.name.toLowerCase())));
      const to = docId(project, n); await invoke('ws_rename', { from: id, to }); return to;
    },
    async duplicate(id) { const { project, name } = split(id); return this.create(project, `${name} copia`, await this.read(id)); },
    remove: (id) => invoke('ws_trash', { rel: id }),
    nameOf: async (id) => split(id).name,
    projectOf: async (id) => split(id).project,
  };
}

export async function openLibrary() {
  const t = typeof window !== 'undefined' ? window.__TAURI__ : null;
  if (t?.core) { const invoke = t.core.invoke; const root = await invoke('ws_root'); return filesLibrary(invoke, root); }
  return browserLibrary();
}
export const DOC_PRESETS = [
  ['Lienzo libre', 1200, 800], ['Post cuadrado', 1080, 1080], ['Historia / vertical', 1080, 1920], ['Presentación 16:9', 1920, 1080],
  ['Icono de app', 1024, 1024], ['Logo', 1200, 1200], ['Tarjeta', 1050, 600], ['A4 vertical', 794, 1123],
];
