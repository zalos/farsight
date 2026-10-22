// The ledger's execution operations (schema 3): held work with its reason, interruption of earlier epochs'
// attempts under the current fence, recorded attempt errors, and typed reads of runs, attempts and open stages.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { syntheticPlan } from './coordinator-helpers.ts';

const roots: string[] = [];
after(() => roots.forEach(removeScratch));
const fresh = () => { const s = scratch('ledger-exec'); roots.push(s.root); return s; };
const code = (c: string) => (e: any) => e?.code === c;
const now = () => new Date().toISOString();

async function seeded() {
  const s = fresh();
  const store = await storeIn(s.root);
  const { plan } = syntheticPlan(s.root);
  store.ledger.createRun({ ...plan.run, state: 'running', coordinatorEpoch: store.epoch });
  const [a, b] = plan.works;
  store.ledger.createWork({ ...a, state: 'ready', coordinatorEpoch: store.epoch });
  store.ledger.createWork({ ...b, state: 'pending', coordinatorEpoch: store.epoch });
  return { s, store, plan, A: { id: a.id, revision: 1 }, B: { id: b.id, revision: 1 } };
}
const attempt = (store: any, work: any, id: string, ordinal = 1) => store.ledger.startAttempt({
  schema: 'sentinel-attempt/draft-1', id, work, ordinal, coordinatorEpoch: store.epoch, operationId: id,
  worker: { kind: 'owned-child', pid: 4242, processStartedAt: now() }, startedAt: now(), usage: { certainty: 'not-applicable' }, state: 'running',
});

test('work is released and held with a catalog reason; illegal moves are refused', async () => {
  const { s, store, B } = await seeded();
  assert.throws(() => store.ledger.setWorkState(B, 'blocked'), code('sentinel.store.invalidInput'), 'a hold needs a reason');
  assert.throws(() => store.ledger.setWorkState(B, 'ready', { reasonCode: 'sentinel.execution.dependencyFailed' }), code('sentinel.store.invalidInput'));
  assert.throws(() => store.ledger.setWorkState(B, 'blocked', { reasonCode: 'not a key' }), code('sentinel.store.invalidInput'));
  store.ledger.setWorkState(B, 'blocked', { reasonCode: 'sentinel.execution.dependencyFailed' });
  assert.throws(() => store.ledger.setWorkState(B, 'blocked', { reasonCode: 'sentinel.execution.dependencyFailed' }), code('sentinel.store.wrongState'));
  store.close();
  const again = await storeIn(s.root);
  try {
    const { envelope, ...row } = again.ledger.getWork(B);
    assert.deepEqual(row, { work: B, runId: 'run-e4', state: 'blocked', activeAttemptId: null, reason: 'sentinel.execution.dependencyFailed' });
    assert.equal(envelope.id, B.id, 'the envelope it was created with');
    again.ledger.setWorkState(B, 'ready');
    assert.equal(again.ledger.getWork(B).reason, null);
    const events = again.ledger.readEvents({ after: 0, limit: 500 }).events.filter((e: any) => e.kind === 'work-state');
    assert.deepEqual(events.map((e: any) => [e.payload.from, e.payload.to]), [['pending', 'blocked'], ['blocked', 'ready']]);
  } finally { again.close(); }
});

test('an attempt error is recorded, bounded and validated, and survives a reopen', async () => {
  const { s, store, A } = await seeded();
  attempt(store, A, 'att-err');
  const base = { work: A, attemptId: 'att-err', state: 'failed' as const, endedAt: now(), workState: 'failed' as const };
  assert.throws(() => store.ledger.endAttempt({ ...base, error: { code: 'nope', retryable: false } }), code('sentinel.store.invalidInput'));
  assert.throws(() => store.ledger.endAttempt({ ...base, error: { code: 'sentinel.execution.workerExited', retryable: false, detail: { blob: 'x'.repeat(5000) } } }), code('sentinel.store.invalidInput'));
  assert.throws(() => store.ledger.endAttempt({ ...base, error: { code: 'sentinel.execution.workerExited', retryable: false, diagnostics: `sha256:${'5'.repeat(64)}` } }), code('sentinel.store.notFound'));
  store.ledger.endAttempt({ ...base, error: { code: 'sentinel.object.tooLarge', retryable: false, detail: { limit: 16777216 } } });
  store.close();
  const again = await storeIn(s.root);
  try {
    const a = again.ledger.getAttempt('att-err');
    assert.deepEqual(a.envelope.error, { code: 'sentinel.object.tooLarge', retryable: false });
    assert.deepEqual(a.errorDetail, { limit: 16777216 });
    assert.equal(again.ledger.readEvents({ after: 0, limit: 500 }).events.find((e: any) => e.kind === 'attempt-ended').payload.code, 'sentinel.object.tooLarge');
  } finally { again.close(); }
});

test('an earlier epoch\'s running attempts are interrupted under the new fence: ready while the run admits work, failed once it is canceling', async () => {
  const { s, store, A, B } = await seeded();
  store.ledger.setWorkState(B, 'ready');
  attempt(store, A, 'att-old-a');
  attempt(store, B, 'att-old-b');
  store.close();
  const second = await storeIn(s.root);
  try {
    assert.deepEqual(second.ledger.interruptStaleAttempts().map((r: any) => [r.attemptId, r.workState]), [['att-old-a', 'ready'], ['att-old-b', 'ready']]);
    assert.deepEqual(second.ledger.interruptStaleAttempts(), [], 'nothing is interrupted twice');
    assert.equal(second.ledger.getAttempt('att-old-a').state, 'interrupted');
    assert.deepEqual(second.ledger.getAttempt('att-old-a').envelope.error, { code: 'sentinel.store.staleEpoch', retryable: true });
    assert.throws(() => second.ledger.endAttempt({ work: A, attemptId: 'att-old-a', state: 'failed', endedAt: now(), workState: 'ready' }), code('sentinel.store.notActiveAttempt'));
    // A canceling run: the interrupted work cannot run again, so it ends failed.
    attempt(second, A, 'att-new-a', 2);
    second.ledger.setRunState('run-e4', 'canceling');
    second.close();
    const third = await storeIn(s.root);
    try {
      assert.deepEqual(third.ledger.interruptStaleAttempts().map((r: any) => [r.attemptId, r.workState]), [['att-new-a', 'failed']]);
      assert.equal(third.ledger.getWork(A).state, 'failed');
      assert.deepEqual(third.ledger.listAttempts(A).map((a: any) => [a.ordinal, a.state]), [[1, 'interrupted'], [2, 'interrupted']]);
    } finally { third.close(); }
  } catch (e) { try { second.close(); } catch { /* closed */ } throw e; }
});

test('a run reads back with its durable outcome, and open stages list in order', async () => {
  const { s, store, A } = await seeded();
  attempt(store, A, 'att-stage');
  store.ledger.registerStaging('stage.att-stage', [{ id: `sha256:${'6'.repeat(64)}`, schema: 'text/plain', privacy: 'metadata' }], { work: A, attemptId: 'att-stage' });
  assert.deepEqual(store.ledger.listOpenStages(500).map((x: any) => [x.stageId, x.attemptId, x.epoch === store.epoch]), [['stage.att-stage', 'att-stage', true]]);
  store.ledger.abortStaging('stage.att-stage');
  store.ledger.endAttempt({ work: A, attemptId: 'att-stage', state: 'failed', endedAt: now(), workState: 'failed' });
  store.ledger.setRunState('run-e4', 'completed', { outcome: 'execution-failure' });
  store.close();
  const again = await storeIn(s.root);
  try {
    const run = again.ledger.getRun('run-e4');
    assert.deepEqual({ state: run.state, outcome: run.outcome }, { state: 'completed', outcome: 'execution-failure' });
    assert.equal(again.ledger.getRun('run-absent'), null);
    assert.equal(again.ledger.readEvents({ after: 0, limit: 500 }).events.filter((e: any) => e.kind === 'run-state').at(-1).payload.outcome, 'execution-failure');
    assert.deepEqual(again.ledger.listOpenStages(500), []);
    assert.throws(() => again.ledger.setWorkState({ id: 'work-B', revision: 1 }, 'ready'), code('sentinel.store.wrongState'), 'an ended run moves no work');
  } finally { again.close(); }
});

test('attempts are listed in bounded pages by ordinal, and counted exactly', async () => {
  const { store, A } = await seeded();
  try {
    for (let i = 1; i <= 3; i++) {
      attempt(store, A, `att-page-${i}`, i);
      store.ledger.endAttempt({ work: A, attemptId: `att-page-${i}`, state: 'failed', endedAt: now(), workState: 'ready' });
    }
    assert.equal(store.ledger.countAttempts(A), 3);
    assert.deepEqual(store.ledger.listAttempts(A, { limit: 2 }).map((a: any) => a.ordinal), [1, 2]);
    assert.deepEqual(store.ledger.listAttempts(A, { afterOrdinal: 2, limit: 2 }).map((a: any) => a.ordinal), [3]);
    assert.throws(() => store.ledger.listAttempts(A, { limit: 501 }), code('sentinel.store.invalidInput'));
  } finally { store.close(); }
});
