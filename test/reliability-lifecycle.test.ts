import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLifecycleRecord, transitionOperation, legacyReference, type OperationRecord } from '../src/reliability/lifecycle.ts';
const h = 'a'.repeat(64);
const operation: OperationRecord = { version: 1, kind: 'operation', id: 'operation-1', revision: 0,
  binding: { taskId: 'author', requirements: h, source: h, approval: h, runtime: h },
  phase: 'preparing', status: 'pending', outcome: 'none', reservations: [], evidence: [] };
test('versioned records reject stale, incomplete and invented completion', () => {
  assert.deepEqual(parseLifecycleRecord(operation), operation);
  for (const wrong of [{ ...operation, version: 2 }, { ...operation, unexpected: true },
    { ...operation, status: 'completed', outcome: 'succeeded' },
    { ...operation, binding: { ...operation.binding, approval: true } },
    { ...operation, reservations: ['request-1', 'request-1'] },
    { ...operation, kind: 'legacy-trusted' }, { ...operation, status: ['pending'] }, { ...operation, outcome: ['none'] }]) assert.throws(() => parseLifecycleRecord(wrong));
  assert.throws(() => transitionOperation(operation, 2, { type: 'start' }), /Stale/);
  const started = transitionOperation(operation, 0, { type: 'start' });
  assert.equal(operation.status, 'pending');
  const reserved = transitionOperation(started, 1, { type: 'reserve', requestId: 'request-1' });
  const interrupted = transitionOperation(reserved, 2, { type: 'pause', outcome: 'provider-interruption' });
  const resumed = transitionOperation(parseLifecycleRecord(JSON.parse(JSON.stringify(interrupted))) as OperationRecord, 3, { type: 'start' });
  assert.deepEqual(resumed.reservations, ['request-1']);
  assert.throws(() => transitionOperation(resumed, 4, { type: 'reserve', requestId: 'request-1' }), /duplicate/);
  assert.throws(() => transitionOperation(resumed, 4, { type: 'finish', evidence: [] }), /Completion/);
  const prepared = transitionOperation(resumed, 4, { type: 'finish', evidence: ['outline-review-1'] });
  assert.equal(prepared.phase, 'preparing');
  assert.equal(prepared.status, 'completed', 'operation completion is not application or task completion');
  assert.throws(() => transitionOperation(resumed, 4, { type: 'advance', phase: 'applying' }), /phase/);
  let next = resumed;
  for (const phase of ['building', 'verifying', 'reviewing', 'applying'] as const) next = transitionOperation(next, next.revision, { type: 'advance', phase });
  next = transitionOperation(next, next.revision, { type: 'finish', evidence: ['proof-1', 'decision-1'] });
  assert.equal(next.status, 'completed');
  assert.throws(() => transitionOperation(next, next.revision, { type: 'start' }), /cannot start/);
});
test('record distinctions preserve limitations and exact-candidate final approval', () => {
  const base = { version: 1, id: 'record-1', revision: 0, binding: operation.binding };
  for (const record of [
    { ...base, kind: 'task', requirementsRef: 'features-1' },
    { ...base, kind: 'candidate', digest: h, metadataVersion: 1, artifactRef: 'source-1' },
    { ...base, kind: 'evidence', candidate: h, producer: 'browser-1', evidenceKind: 'automatic', verdict: 'incomplete', artifactRef: 'proof-1', limitations: ['No screen-reader evidence.'] },
    { ...base, kind: 'decision', candidate: h, operation: 'operation-1', decision: 'approve', purpose: 'application', evidence: ['proof-1'] },
  ]) assert.deepEqual(parseLifecycleRecord(record), record);
  assert.throws(() => parseLifecycleRecord({ ...base, kind: 'decision', candidate: null, operation: 'operation-1', decision: 'approve', purpose: 'application', evidence: [] }), /exact candidate/);
  assert.deepEqual(legacyReference('preparation', h), { version: 1, owner: 'preparation', digest: h });
  assert.throws(() => legacyReference('preparation', 'not-a-hash'));
  const unapproved = { ...operation, status: 'running' as const, binding: { ...operation.binding, approval: null } };
  assert.throws(() => transitionOperation(unapproved, 0, { type: 'advance', phase: 'building' }), /approved/);
});
