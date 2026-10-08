// Reference originals belong to the document, not to the lifetime of its chat panel.
// Callers resize uploads to <= 1024 px before saving (as addImage does). Thumbnails
// are never promoted to originals. IndexedDB also works in the desktop WebView.
const REF_NAME = /^ref[1-9]\d*$/i;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const copy = refs => refs.map(ref => ({ ...ref }));
const values = refs => refs instanceof Map ? [...refs.values()] : Array.isArray(refs) ? refs : [];

function originals(refs) {
  const result = new Map();
  for (const ref of values(refs)) {
    if (!ref || !REF_NAME.test(ref.name || '') || !MIME_EXT[ref.mime] || typeof ref.data !== 'string' || !ref.data.trim()) continue;
    const name = ref.name.toLowerCase();
    result.set(name, { name, mime: ref.mime, ext: MIME_EXT[ref.mime], data: ref.data,
      ...(typeof ref.thumb === 'string' ? { thumb: ref.thumb } : {}),
      ...(Number.isFinite(ref.w) ? { w: ref.w } : {}), ...(Number.isFinite(ref.h) ? { h: ref.h } : {}) });
  }
  return [...result.values()];
}

/** Names are stable image IDs, even when the image is not among the latest uploads. */
export function referenceNames(message = '') {
  return [...new Set([...String(message).matchAll(/\bref\s*#?\s*([1-9]\d*)(?:\.(?:png|jpe?g|webp))?\b/gi)].map(match => `ref${match[1]}`))];
}

function missingReferences(names, legacy = false) {
  const error = new Error(`${names.length ? `No están disponibles las imágenes originales ${names.join(', ')}` : 'La imagen original anterior ya no está disponible'}. ${legacy ? 'El historial conserva una miniatura, pero no el original. ' : ''}Vuelve a adjuntar la referencia y usa su nuevo identificador antes de continuar.`);
  error.code = 'REFERENCE_ORIGINAL_MISSING'; error.referenceNames = names;
  return error;
}

/**
 * Select the actual transport images. Explicit IDs and every pending attachment
 * are mandatory; neither may be silently replaced by a recent unrelated image.
 * An optional canvas uses one remaining slot, followed by up to two recent refs.
 * `history` is only evidence of a lost legacy original, never an image source.
 */
export function chooseReferenceImages(message, pending = [], stored = [], options = {}) {
  const { limit = 4, canvas = null, history = [] } = typeof options === 'number' ? { limit: options } : options;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('El límite de imágenes debe ser un entero mayor que cero.');
  const previous = originals(stored), fresh = originals(pending);
  if (fresh.length !== values(pending).length) throw new Error('Una imagen adjunta no contiene un original válido. Vuelve a adjuntarla antes de continuar.');
  const available = new Map([...previous, ...fresh].map(ref => [ref.name, ref]));
  const requested = referenceNames(message), missing = requested.filter(name => !available.has(name));
  const hasLegacyThumbnails = history.some(item => item?.thumbs?.length);
  if (missing.length) throw missingReferences(missing, hasLegacyThumbnails);
  const refersBack = /(?:\b(?:imagen|im[aá]genes|referencia|referencias|foto|fotos)\b.{0,32}\b(?:anterior|anteriores|antes|adjunt[aé]|adjunta|adjuntas|pas[aé])\b|\b(?:esa|esas|esta|estas|misma|mismas)\s+(?:imagen|im[aá]genes|referencia|referencias|foto|fotos)\b|\b(?:vector[ií]zala|vector[ií]zalas|c[aá]lcala|c[aá]lcalas)\b)/i.test(message);
  if (!available.size && hasLegacyThumbnails && refersBack) throw missingReferences([], true);
  const selected = new Map();
  for (const name of requested) selected.set(name, available.get(name));
  for (const ref of fresh) selected.set(ref.name, ref);
  if (selected.size > limit) {
    const error = new Error(`La solicitud necesita ${selected.size} referencias y admite ${limit} imágenes por turno. Quita adjuntos o divide el pedido; no se omitió ninguna referencia.`);
    error.code = 'REFERENCE_LIMIT_EXCEEDED'; error.referenceNames = [...selected.keys()]; throw error;
  }
  const images = copy([...selected.values()]);
  if (canvas && images.length < limit) {
    if (typeof canvas.data !== 'string' || !canvas.data || !MIME_EXT[canvas.mime]) throw new Error('La captura del lienzo no contiene una imagen válida.');
    images.push({ ...canvas, name: 'canvas', ext: MIME_EXT[canvas.mime] });
  }
  const older = previous.filter(ref => !selected.has(ref.name)).slice(-Math.min(2, limit - images.length));
  // Array.slice(-0) would otherwise append every older image to a full request.
  if (images.length < limit) images.push(...copy(older));
  return { images, referenceNames: images.filter(image => image.name !== 'canvas').map(image => image.name) };
}

function indexedBackend(factory, databaseName) {
  let opening;
  const open = () => opening ||= new Promise((resolve, reject) => {
    let request, settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    try { request = factory.open(databaseName, 1); } catch (error) { fail(error); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('documents')) request.result.createObjectStore('documents', { keyPath: 'id' }); };
    request.onerror = () => fail(request.error || new Error('No se pudo abrir el almacén de referencias.'));
    request.onblocked = () => fail(new Error('Otra ventana bloquea el almacén de referencias.'));
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      settled = true;
      database.onversionchange = () => { database.close(); opening = null; };
      resolve(database);
    };
  }).catch(error => { opening = null; throw error; });
  async function transact(id, mode, operation) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('documents', mode), store = transaction.objectStore('documents');
      let request;
      try { request = operation(store); } catch (error) { transaction.abort(); reject(error); return; }
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || request.error || new Error(`No se pudieron guardar las referencias de ${id}.`));
    });
  }
  return {
    load: async id => (await transact(id, 'readonly', store => store.get(id)))?.refs || [],
    save: (id, refs) => transact(id, 'readwrite', store => store.put({ id, refs })),
    clear: id => transact(id, 'readwrite', store => store.delete(id)),
  };
}

/**
 * save replaces the document's complete reference list; clear removes that list.
 * The optional async backend {load,save,clear} permits host-owned persistence.
 * persistent:false is an isolated in-memory store for embedded editors.
 * Memory remains usable on storage failure; callers must show the returned
 * persisted:false warning instead of promising survival after a restart.
 */
export function createReferenceStore({ persistent = true, indexedDB = globalThis.indexedDB,
  databaseName = 'aru-chat-references', backend, onWarning = () => {} } = {}) {
  const storage = persistent ? backend || (indexedDB?.open ? indexedBackend(indexedDB, databaseName) : null) : null;
  const memory = new Map(), queues = new Map();
  let reason = persistent && !storage ? 'El almacenamiento persistente no está disponible; las referencias se conservarán solo durante esta sesión.' : null;
  let lastWarning;
  const warn = error => {
    reason = `No se pudieron guardar o recuperar las referencias de forma persistente (${error?.message || 'almacenamiento no disponible'}). Las referencias nuevas se conservarán solo durante esta sesión.`;
    if (lastWarning !== reason) { lastWarning = reason; try { onWarning(reason); } catch { /* Host reporting must not disable the memory fallback. */ } }
  };
  function enqueue(id, operation) {
    if (typeof id !== 'string' || !id.trim()) return Promise.reject(new Error('Se necesita el identificador del documento para guardar sus referencias.'));
    const next = (queues.get(id) || Promise.resolve()).then(operation);
    queues.set(id, next.catch(() => {}));
    return next;
  }
  const result = (persisted, count) => ({ persisted, count, ...(reason ? { reason } : {}) });
  return {
    status: () => ({ persistent: !!storage && !reason, reason }),
    load(id) {
      return enqueue(id, async () => {
        if (memory.has(id)) return copy(memory.get(id));
        if (storage) {
          try { const refs = originals(await storage.load(id)); memory.set(id, refs); reason = null; return copy(refs); }
          catch (error) { warn(error); }
        }
        // Do not cache a failed read: a later read may recover persistent originals.
        return [];
      });
    },
    save(id, refs) {
      if (!(refs instanceof Map) && !Array.isArray(refs)) return Promise.reject(new Error('Se necesita la lista completa de referencias; usa clear para borrarlas.'));
      const normalized = originals(refs);
      if (normalized.length !== values(refs).length) return Promise.reject(new Error('Las referencias deben incluir identificadores únicos y sus imágenes originales PNG, JPEG o WebP.'));
      if (normalized.some(ref => ref.w > 1024 || ref.h > 1024)) return Promise.reject(new Error('Reduce las imágenes de referencia a un máximo de 1024 píxeles antes de guardarlas.'));
      return enqueue(id, async () => {
        memory.set(id, copy(normalized));
        if (storage) {
          try { if (normalized.length) await storage.save(id, copy(normalized)); else await storage.clear(id); reason = null; return result(true, normalized.length); }
          catch (error) { warn(error); }
        }
        return result(false, normalized.length);
      });
    },
    clear(id) {
      return enqueue(id, async () => {
        // Keep a tombstone in memory even if deleting the persistent copy fails.
        memory.set(id, []);
        if (storage) {
          try { await storage.clear(id); reason = null; return result(true, 0); }
          catch (error) { warn(error); }
        }
        return result(false, 0);
      });
    },
  };
}
