const requestId = value => typeof value === 'string' && value.trim() ? value : null;
const cloneMessages = messages => {
  if (!Array.isArray(messages)) throw new TypeError('El historial debe ser una lista de mensajes.');
  return structuredClone(messages);
};

/** Recover only requests with a stable ID. Legacy messages cannot be paired safely. */
export function recoverInterruptedMessages(messages) {
  const result = cloneMessages(messages);
  const answered = new Set(result.filter(message => message?.role === 'bot').map(message => requestId(message.replyTo)).filter(Boolean));
  for (const message of result.slice()) {
    const id = message?.role === 'user' ? requestId(message.id) : null;
    if (!id || answered.has(id)) continue;
    result.push({ role: 'bot', replyTo: id, status: 'interrupted',
      error: 'La sesión se cerró o se recargó antes de registrar el resultado de esta solicitud. Revisa el lienzo antes de reintentar; no se repetirá automáticamente.',
      retry: { text: message.text, mode: message.mode, refinement: message.refinement } });
    answered.add(id);
  }
  return result;
}

/**
 * One outcome per request. A late actual result can replace the provisional
 * interrupted marker; it cannot overwrite an already recorded terminal result.
 */
export function appendOutcome(messages, outcome) {
  const result = cloneMessages(messages), id = requestId(outcome?.replyTo);
  if (outcome?.role !== 'bot' || !id) throw new TypeError('El resultado necesita role bot y el identificador replyTo de su solicitud.');
  const index = result.findIndex(message => message?.role === 'bot' && message.replyTo === id);
  if (index < 0) result.push(structuredClone(outcome));
  else if (result[index].status === 'interrupted' && outcome.status !== 'interrupted') result[index] = structuredClone(outcome);
  return result;
}
