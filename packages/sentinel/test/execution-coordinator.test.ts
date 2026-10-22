// The coordinator in one process, against a real store from openStore() and real built-in worker processes.
// Always run. A "crash" here closes the store at a boundary (ownership lost mid-step), so recovery's state
// transitions are exercised every run; real SIGKILLs at the same boundaries are in execution-recovery-kill.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Coordinator, COORDINATOR_BOUNDARIES } from '../dist/execution/coordinator.js';
import { decide, orderPlan, ReservationPool, retryable, DEFAULT_RETRY } from '../dist/execution/scheduler.js';
import { readHistory } from '../dist/execution/recovery.js';
import { isExecutionError } from '../dist/execution/errors.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { publications, syntheticPlan } from './coordinator-helpers.ts';

const roots: string[] = [];
after(() => roots.forEach(removeScratch));
const fresh = (label: string) => { const s = scratch(label); roots.push(s.root); return s; };
const is = (code: string) => (e: unknown) => isExecutionError(e) && e.code === code;

test('the plan must be a DAG of this run with dependencies inside it', () => {
  const s = fresh('dag');
  const { plan } = syntheticPlan(s.root);
  assert.deepEqual(orderPlan(plan.works).map((w: any) => w.id), ['work-A', 'work-B', 'work-C', 'work-D']);
  const cyclic = plan.works.map((w: any) => w.id === 'work-A' ? { ...w, dependencies: [{ id: 'work-D', revision: 1 }] } : w);
  assert.throws(() => orderPlan(cyclic), is('sentinel.execution.planInvalid'));
  const dangling = [{ ...plan.works[0], dependencies: [{ id: 'work-X', revision: 1 }] }];
  assert.throws(() => orderPlan(dangling), is('sentinel.execution.planInvalid'));
  assert.throws(() => orderPlan([plan.works[0], plan.works[0]]), is('sentinel.execution.planInvalid'));
});

test('readiness follows publication; a failed or blocked dependency blocks its dependents', () => {
  const s = fresh('decide');
  const { plan } = syntheticPlan(s.root);
  const c = new Map<string, any>([['work-A@1', { created: true, workState: 'published', attempts: 1 }], ['work-B@1', { created: true, workState: 'failed', attempts: 3 }]]);
  const d = decide(plan.works, c, DEFAULT_RETRY);
  assert.deepEqual(d.map((x: any) => x.state), ['published', 'failed', 'ready', 'blocked']);
  assert.match(d[3].reason, /work-B@1 failed/);
});

test('reservations are bounded and released once; retries are bounded and only for retryable reasons', () => {
  const pool = new ReservationPool({ slots: 2, memoryBytes: 1024, cpus: 2 });
  const a = pool.tryReserve('a', { memoryBytes: 600, cpus: 1 })!;
  assert.equal(pool.tryReserve('b', { memoryBytes: 600, cpus: 1 }), null, 'memory is reserved');
  const b = pool.tryReserve('b', { memoryBytes: 400, cpus: 1 })!;
  assert.equal(pool.tryReserve('c', { memoryBytes: 1, cpus: 1 }), null, 'slots are reserved');
  pool.release(a); pool.release(b);
  assert.equal(pool.held, 0);
  assert.throws(() => pool.tryReserve('huge', { memoryBytes: 4096, cpus: 1 }), is('sentinel.execution.resourceExceeded'));
  assert.equal(retryable('sentinel.execution.workerExited', 1, DEFAULT_RETRY), true);
  assert.equal(retryable('sentinel.execution.workerExited', 3, DEFAULT_RETRY), false);
  assert.equal(retryable('sentinel.execution.outputMismatch', 1, DEFAULT_RETRY), false, 'integrity is never retried');
});

test('a run executes the whole DAG once, publishing every unit exactly once', async () => {
  const s = fresh('run');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root);
    const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work });
    const summary = await c.run();
    assert.equal(summary.state, 'completed');
    assert.equal(summary.outcome, 'complete-coverage');
    assert.equal(summary.published, 4);
    assert.deepEqual([...publications(store, 'run-e4').values()], [1, 1, 1, 1]);
    // Order: A before B and C, both before D.
    const order: string[] = [];
    let after = 0;
    for (;;) { const p = store.ledger.readEvents({ after, limit: 500 }); for (const e of p.events) if (e.kind === 'work-published') order.push(e.work!.id); if (!p.more) break; after = p.cursor; }
    assert.equal(order[0], 'work-A'); assert.equal(order[3], 'work-D');
    // Running it again is a no-op: the run is complete.
    assert.equal((await (await Coordinator.open({ store, plan, registry, scratchRoot: s.work })).run()).published, 4);
  } finally { store.close(); }
});

test('a retryable failure is retried within its bound; an integrity failure is final and blocks dependents', async () => {
  const s = fresh('retry');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root, { B: 'fail-once', C: 'tampered-output' }, { argument: join(s.root, 'fail-once-marker') });
    const summary = await (await Coordinator.open({ store, plan, registry, scratchRoot: s.work })).run();
    const byId = Object.fromEntries(summary.units.map((u: any) => [u.ref.id, u.state]));
    assert.deepEqual(byId, { 'work-A': 'published', 'work-B': 'published', 'work-C': 'failed', 'work-D': 'blocked' });
    assert.equal(summary.state, 'completed');
    assert.equal(summary.outcome, 'execution-failure');
    assert.ok(summary.failures.some((f: any) => f.work.id === 'work-B' && f.code === 'sentinel.execution.workerExited'));
    assert.ok(summary.failures.some((f: any) => f.work.id === 'work-C' && f.code === 'sentinel.execution.outputMismatch'));
    assert.equal(readHistory(store).attemptCount.get('work-B@1'), 2, 'one retry');
    assert.equal(readHistory(store).attemptCount.get('work-C@1'), 1, 'never retried');
  } finally { store.close(); }
});

test('pause lets in-flight work finish and publish, admits nothing new, and resumes to completion', async () => {
  const s = fresh('pause');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root, { A: 'slow-ok' });
    const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work });
    const running = c.run();
    await new Promise(r => setTimeout(r, 500));
    c.pause();
    const paused = await running;
    assert.equal(paused.state, 'paused');
    assert.deepEqual([...publications(store, 'run-e4').keys()], ['work-A'], 'the in-flight unit published while pausing');
    assert.equal(paused.units.find((u: any) => u.ref.id === 'work-B').state, 'ready', 'nothing new was admitted');
    const resumed = await (await Coordinator.open({ store, plan, registry, scratchRoot: s.work })).run();
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.published, 4);
  } finally { store.close(); }
});

test('cancel stops the workers and revokes publication, even for a result already in hand', async () => {
  const s = fresh('cancel');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root, { A: 'hang' }, { limits: { timeoutMs: 20_000, cancelGraceMs: 500 } });
    const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work });
    const running = c.run();
    await new Promise(r => setTimeout(r, 400));
    c.cancel();
    const summary = await running;
    assert.equal(summary.state, 'canceled');
    assert.equal(summary.published, 0);
    // A result already produced is refused once the run is canceling.
    const s2 = fresh('cancel-late');
    const store2 = await storeIn(s2.root);
    try {
      const p2 = syntheticPlan(s2.root);
      let c2: any;
      const hooks = { at: (b: string) => { if (b === 'before-staging') c2.cancel(); } };
      c2 = await Coordinator.open({ store: store2, plan: p2.plan, registry: p2.registry, scratchRoot: s2.work, hooks });
      const late = await c2.run();
      assert.equal(late.state, 'canceled');
      assert.equal(late.published, 0, 'the ledger refused the publication');
      assert.ok(late.failures.some((f: any) => f.code === 'sentinel.execution.canceled'));
    } finally { store2.close(); }
  } finally { try { store.close(); } catch { /* closed */ } }
});

for (const boundary of COORDINATOR_BOUNDARIES) {
  test(`a coordinator that loses its store at ${boundary} is finished by the next, with each unit published once`, async () => {
    const s = fresh(`crash-${boundary}`);
    const { plan, registry } = syntheticPlan(s.root);
    const first = await storeIn(s.root);
    let fired = false;
    const hooks = { at: (b: string, ctx: any) => { if (b === boundary && ctx.work.id === 'work-B' && !fired) { fired = true; try { first.close(); } catch { /* reported by the close */ } } } };
    await (await Coordinator.open({ store: first, plan, registry, scratchRoot: s.work, hooks })).run().catch(() => undefined);
    assert.ok(fired);
    try { first.close(); } catch { /* already closed */ }
    const second = await storeIn(s.root);
    try {
      const c = await Coordinator.open({ store: second, plan, registry, scratchRoot: s.work });
      const summary = await c.run();
      assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
      assert.equal(summary.published, 4);
      assert.deepEqual([...publications(second, 'run-e4').values()].sort(), [1, 1, 1, 1], 'no lost and no duplicate publication');
      const h = readHistory(second);
      assert.equal([...h.attempts.values()].filter(a => a.state === 'running').length, 0, 'no attempt left running');
      assert.equal(h.openStages.size, 0, 'no stage left open');
      if (boundary === 'after-staging' || boundary === 'after-objects') assert.ok(c.recovery.abortedStages.length >= 1, 'the open stage was aborted');
    } finally { second.close(); }
  });
}

test('a late write from an earlier epoch is refused by the ledger', async () => {
  const s = fresh('late');
  const { plan, registry } = syntheticPlan(s.root);
  const first = await storeIn(s.root);
  let stale: { work: any; attemptId: string } | undefined;
  const hooks = { at: (b: string, ctx: any) => { if (b === 'after-attempt-start' && ctx.work.id === 'work-A' && !stale) { stale = ctx; first.close(); } } };
  await (await Coordinator.open({ store: first, plan, registry, scratchRoot: s.work, hooks })).run().catch(() => undefined);
  const second = await storeIn(s.root);
  try {
    await (await Coordinator.open({ store: second, plan, registry, scratchRoot: s.work })).run();
    assert.throws(() => second.ledger.endAttempt({ work: stale!.work, attemptId: stale!.attemptId, state: 'failed', endedAt: new Date().toISOString(), workState: 'ready' }),
      (e: any) => ['sentinel.store.alreadyPublished', 'sentinel.store.notActiveAttempt', 'sentinel.store.staleEpoch'].includes(e.code));
    assert.equal([...publications(second, 'run-e4').values()].reduce((a, b) => a + b, 0), 4);
  } finally { second.close(); }
});
