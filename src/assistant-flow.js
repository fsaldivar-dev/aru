import { requestedIconCount } from './icon-production.js';

const clean = value => typeof value === 'string' ? value.trim() : '';

/** A routing suggestion, never permission to edit a drawing automatically. */
export function correctiveIntent(message) {
  const text = clean(message).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // A fresh collection remains a creation request even when it follows criticism.
  const fresh = /\b(?:crea|crear|genera|generar|dibuja|dibujar|haz|hacer|quiero|pedi|necesito)\b[\s\S]{0,80}\b(?:nuev[oa]s?|otr[oa]s?)\b/.test(text);
  const negatedFresh = /\bno\s+(?:me\s+)?(?:crees|generes|dibujes|hagas|quiero)\b/.test(text);
  if (fresh && !negatedFresh) return null;
  const correction = /\b(?:mejoral[oa]s?|corrigel[oa]s?|arreglal[oa]s?|redibujal[oa]s?|refinal[oa]s?|rehazl[oa]s?)\b/.test(text)
    || /\b(?:hazl[oa]s?|quiero\s+que\s+sean|deberian\s+ser)\s+(?:mas|menos)\b/.test(text)
    || /\bno\s+(?:(?:logro|puedo|se\s+pueden?)\s+)?(?:distinguir|reconocer|diferenciar|entiendo)\b/.test(text)
    || /\b(?:se\s+ven|quedaron|estan|son)\s+(?:iguales|confusos|borrosos|irreconocibles)\b/.test(text)
    || /\b(?:corrige|mejora|arregla|redibuja)\s+(?:estos|esos|los|las|el|la)\b/.test(text);
  return correction ? { mode: 'refine', refinement: 'redraw', reason: 'Parece una corrección de dibujos existentes. Selecciona los iconos y elige Refinar → Redibujar para corregirlos sin crear otra colección.' } : null;
}

/** Resolve the user's chosen task before sending any request to an agent. */
export function assistantFlow({ mode = 'create', kind = 'illustration', quantity = 24,
  purpose = '', refinement = 'style', selection = [], message = '', hasReferences = false,
  style = '', material = '', color = '', accent = '' } = {}) {
  const brief = clean(message), intent = clean(purpose);
  const appearance = [['Estilo', style], ['Acabado', material], ['Color principal', color], ['Color de acento', accent]]
    .map(([label, value]) => [label, clean(value)]).filter(([, value]) => value);
  const result = { error: null, mode, message: brief, context: '', illustrator: mode === 'create',
    refinement: null, canMutate: mode !== 'consult', appearance: false, target: null };
  const fail = error => ({ ...result, error, canMutate: false });
  const appearanceContext = () => appearance.length
    ? `Apariencia solicitada: ${appearance.map(([label, value]) => `${label}: ${value}`).join('; ')}.` : '';

  if (mode === 'consult') {
    if (!brief) return fail('Escribe la pregunta que quieres hacer sobre tu proyecto o el lienzo.');
    result.context = 'Tarea: consultar. Responde a la pregunta usando el proyecto y el documento actuales. Solo lectura: no crees, cambies ni elimines dibujos; no devuelvas operaciones de edición.';
    return result;
  }

  if((mode==='create' || mode==='refine'&&['style','redraw'].includes(refinement)) && clean(accent)&&!clean(color)) return fail('Añade un color principal para usar un acento.');

  if (mode === 'create') {
    const suggestion = correctiveIntent(brief);
    if (suggestion) return { ...fail(suggestion.reason), suggestion };
    if (!['illustration', 'app-icon', 'icon-pack'].includes(kind)) return fail('Elige qué quieres crear: una ilustración, un icono de app o un conjunto de iconos.');
    if (kind === 'icon-pack') {
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return fail('La cantidad debe ser un número entero entre 1 y 1000 iconos.');
      const writtenCount = requestedIconCount(brief);
      if (writtenCount !== null && writtenCount !== quantity) return fail(`En Cantidad elegiste ${quantity} iconos, pero tu solicitud pide ${writtenCount}. Usa la misma cantidad en ambos lugares para continuar.`);
      result.target = quantity;
    }
    if (!brief && !intent && !hasReferences) return fail('Cuéntame qué quieres crear o para qué servirá. También puedes adjuntar una imagen de referencia.');
    const opening = kind === 'icon-pack' ? `Crea exactamente ${quantity} iconos nuevos` : kind === 'app-icon' ? 'Crea un icono nuevo para una app' : 'Crea una ilustración nueva';
    result.message = `${opening}.${intent ? `\nPropósito: ${intent}` : ''}${brief ? `\nSolicitud: ${brief}` : ''}${hasReferences ? '\nUsa las imágenes adjuntas como base visual.' : ''}`;
    result.appearance = true;
    result.context = ['Tarea: crear. Añade únicamente dibujos nuevos y editables. Conserva la geometría y la apariencia de todos los dibujos existentes; no los reemplaces ni elimines. La selección actual sirve solo como referencia y no como destino de edición.',
      kind === 'icon-pack' ? `Entrega ${quantity} iconos nuevos y distintos, organizados como un conjunto. La cantidad cuenta solo las piezas nuevas; no incluye los iconos que ya existen.` : '',
      appearanceContext()].filter(Boolean).join('\n');
    return result;
  }

  if (mode === 'refine') {
    if (!Array.isArray(selection) || selection.length === 0) return fail('Selecciona en el lienzo el dibujo o los iconos que quieres modificar.');
    if (!['style', 'contour', 'redraw'].includes(refinement)) return fail('Elige cómo quieres modificar la selección: color y acabado, limpiar trazos o redibujar.');
    result.refinement = refinement;
    const scope = `Tarea: modificar únicamente la selección actual (${JSON.stringify(selection)}). Conserva intacto todo lo que esté fuera de ella. No generes otra colección ni sustituyas el documento.`;
    if (refinement === 'contour') {
      result.message = brief || 'Limpia los trazos de la selección: suaviza las curvas y corrige pequeñas irregularidades sin cambiar el dibujo.';
      result.context = `${scope}\nLimpieza de trazos: conserva los colores, los acabados, la composición y la topología del dibujo, incluidos sus huecos y conexiones. Ajusta las curvas existentes sin cambiar su identidad. Ignora cualquier estilo, material o paleta de los controles de apariencia: no se aplican en esta tarea.`;
    } else if (refinement === 'style') {
      if (!brief && appearance.length === 0) return fail('Describe qué color o acabado quieres, o elige una opción de apariencia antes de continuar.');
      result.message = brief || `Cambia la apariencia de la selección. ${appearanceContext()}`;
      result.appearance = true;
      result.context = `${scope}\nColor y acabado: modifica solo la apariencia. Conserva la geometría, la silueta, las curvas, los huecos, las conexiones y la composición. No añadas ni elimines piezas. ${appearanceContext()}`.trim();
    } else {
      if (!brief) return fail('Describe qué falla en el dibujo y cómo quieres corregirlo.');
      result.appearance = true;
      result.context = `${scope}\nRedibujar: puedes cambiar las formas interiores de los grupos seleccionados para que expresen mejor su propósito. Conserva la identidad, el nombre, la función y la colocación de cada icono; mejora sus rasgos reconocibles. Mantén la apariencia actual salvo los cambios solicitados. Usa operaciones redraw con el fragmento ARU en coordenadas locales del grupo; no devuelvas un dibujo separado ni reemplaces el lienzo. ${appearanceContext()}`.trim();
    }
    return result;
  }

  return fail('Elige una tarea: crear, modificar la selección o consultar.');
}

const rootTarget = target => target == null || typeof target === 'string' && ['', 'root', 'canvas'].includes(target.trim());

/** Validate the complete parsed answer before applying any part of it. */
export function validateAssistantAnswer(flow, answer) {
  if (flow?.error) throw new Error(flow.error);
  if (!flow || !['create', 'refine', 'consult'].includes(flow.mode)) throw new Error('La tarea de la IA no es válida. Elige crear, modificar o consultar.');
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.operations)) throw new Error('La respuesta de la IA no tiene un formato válido; no se aplicó ningún cambio.');
  const drawing = typeof answer.aru === 'string' ? answer.aru.trim() : answer.aru;
  if (flow.mode === 'consult') {
    if (drawing || answer.reference || answer.operations.length || answer.aruInto) throw new Error('La IA propuso cambios durante una consulta. No se aplicó ningún cambio; vuelve a preguntar o elige una tarea de edición.');
  } else if (flow.mode === 'refine') {
    if (drawing || answer.reference || answer.aruInto) throw new Error('La IA intentó añadir o reemplazar dibujos al modificar la selección. No se aplicó ningún cambio.');
    // The existing refinement validator enforces operation types and exact selected paths.
  } else {
    if (!rootTarget(answer.aruInto)) throw new Error('La IA intentó insertar el dibujo dentro de una pieza existente. Crear solo permite añadir dibujos nuevos; no se aplicó ningún cambio.');
    if (answer.operations.some(operation => !operation || !(operation.op === 'add' && rootTarget(operation.target) || operation.op === 'reuse' && (rootTarget(operation.target) || operation.target === '$created' && !!drawing)))) throw new Error('La IA intentó modificar dibujos existentes en la tarea Crear. Solo se permite añadir dibujos nuevos; no se aplicó ningún cambio.');
  }
  return answer;
}

// Reserved target is resolved only after a successful creation, never against an old selection.
export function resolveCreatedOperations(operations, created = []) {
  return operations.map(op => {
    if (op.target !== '$created') return op;
    if (op.op !== 'reuse' || created.length !== 1) throw new Error('No hay una ilustración nueva única donde reutilizar el recurso');
    return { ...op, target: created[0] };
  });
}
