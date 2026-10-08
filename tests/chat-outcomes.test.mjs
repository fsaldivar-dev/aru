import test from 'node:test';
import assert from 'node:assert/strict';
import { appendOutcome, recoverInterruptedMessages } from '../src/chat-outcomes.js';

test('reload gives every modern unfinished request a persistent interrupted outcome and retry', () => {
  const messages = [
    { role: 'user', id: 'create-1', text: 'Crea cuatro instrumentos', mode: 'create', references: ['ref12'] },
    { role: 'user', id: 'redraw-2', text: 'El violín no se distingue', mode: 'refine', refinement: 'redraw' },
  ];
  const before = structuredClone(messages), recovered = recoverInterruptedMessages(messages);
  assert.deepEqual(messages, before);
  assert.equal(recovered.length, 4);
  for (const [index, user] of messages.entries()) {
    const outcome = recovered[index + 2];
    assert.equal(outcome.role, 'bot');
    assert.equal(outcome.replyTo, user.id);
    assert.equal(outcome.status, 'interrupted');
    assert.match(outcome.error, /antes de registrar el resultado.*Revisa el lienzo.*no se repetirá automáticamente/);
    assert.deepEqual(outcome.retry, { text: user.text, mode: user.mode, refinement: user.refinement });
  }
  recovered[0].references.push('ref13');
  assert.deepEqual(messages[0].references, ['ref12']);
});

test('repeated reloads do not duplicate recovered results or infer pairings for legacy messages', () => {
  const messages = [
    { role: 'user', text: 'Una solicitud antigua sin identificador' },
    { role: 'user', id: '', text: 'Otro formato antiguo' },
    { role: 'user', id: 'pending', text: 'Hazlos más claros', mode: 'refine' },
    { role: 'user', id: 'pending', text: 'An accidental duplicate request record' },
  ];
  const once = recoverInterruptedMessages(messages);
  assert.equal(once.filter(message => message.role === 'bot').length, 1);
  assert.deepEqual(recoverInterruptedMessages(once), once);
  assert.deepEqual(recoverInterruptedMessages(recoverInterruptedMessages(once)), once);
});

test('successful, failed, cancelled and discarded requests are already terminal', () => {
  for (const status of ['complete', 'failed', 'cancelled', 'discarded', 'interrupted', undefined]) {
    const messages = [{ role: 'user', id: 'request', text: 'Crea un icono' }, { role: 'bot', replyTo: 'request', status, text: 'Outcome recorded' }];
    assert.deepEqual(recoverInterruptedMessages(messages), messages);
  }
});

test('appending a normal outcome is immutable and idempotent by replyTo', () => {
  const messages = [{ role: 'user', id: 'request', text: 'Crea un icono' }];
  const outcome = { role: 'bot', replyTo: 'request', status: 'complete', text: 'Listo', operations: [{ op: 'add', target: 'root' }] };
  const once = appendOutcome(messages, outcome);
  assert.equal(messages.length, 1);
  assert.equal(once.length, 2);
  assert.deepEqual(appendOutcome(once, outcome), once);
  once[1].operations[0].target = 'changed-copy';
  assert.equal(outcome.operations[0].target, 'root');
});

test('a real late outcome replaces only the provisional interruption without retaining stale retry or error', () => {
  const original = recoverInterruptedMessages([{ role: 'user', id: 'request', text: 'Mejora el violín', mode: 'refine' }]);
  const actual = { role: 'bot', replyTo: 'request', status: 'discarded', error: 'El documento cambió', retry: { text: 'Mejora el violín', mode: 'refine' } };
  const result = appendOutcome(original, actual);
  assert.equal(result.length, 2);
  assert.deepEqual(result[1], actual);
  assert.equal(original[1].status, 'interrupted');
  const completed = appendOutcome(original, { role: 'bot', replyTo: 'request', status: 'complete', text: 'Listo' });
  assert.equal(completed[1].error, undefined);
  assert.equal(completed[1].retry, undefined);
});

test('a recovery marker or conflicting late delivery never overwrites an already recorded result', () => {
  const messages = [{ role: 'user', id: 'request', text: 'Crea' }, { role: 'bot', replyTo: 'request', status: 'discarded', error: 'Cambió el documento' }];
  for (const status of ['interrupted', 'complete', 'failed', 'discarded']) {
    assert.deepEqual(appendOutcome(messages, { role: 'bot', replyTo: 'request', status, text: 'Later delivery' }), messages);
  }
  assert.throws(() => appendOutcome(messages, { role: 'bot', text: 'No request ID' }), /replyTo/);
  assert.throws(() => appendOutcome(messages, { role: 'user', replyTo: 'request' }), /role bot/);
});
