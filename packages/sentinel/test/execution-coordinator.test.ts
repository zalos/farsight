// The coordinator in one process, against a real store from openStore() and real built-in worker processes.
// Always run. A "crash" here closes the store at a boundary (ownership lost mid-step), so recovery's state
// transitions are exercised every run; real SIGKILLs at the same boundaries are in execution-recovery-kill.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { WorkerFiles, processesCarrying } from '../dist/execution/recovery.js';
import { influenceManifest } from '../dist/execution/plan.js';
import { Coordinator, COORDINATOR_BOUNDARIES } from '../dist/execution/coordinator.js';
import { decide, orderPlan, ReservationPool, retryable, DEFAULT_RETRY } from '../dist/execution/scheduler.js';
import { isExecutionError } from '../dist/execution/errors.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { ledgerState, publications, syntheticPlan } from './coordinator-helpers.ts';

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
    // Every worker succeeded, but the plan named no required coverage: that is partial, never complete.
    assert.equal(summary.outcome, 'partial-coverage');
    assert.ok(summary.coverage.every((c: any) => c.verdict === 'unevaluated'));
    assert.equal(summary.clean, false);
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
    assert.equal(store.ledger.listAttempts({ id: 'work-B', revision: 1 }).length, 2, 'one retry');
    assert.equal(store.ledger.listAttempts({ id: 'work-C', revision: 1 }).length, 1, 'never retried');
    // Every failure is in the ledger, with its code and whether it was retryable, and D is held with its reason.
    const [c1] = store.ledger.listAttempts({ id: 'work-C', revision: 1 });
    const recorded = store.ledger.getAttempt(c1.id);
    assert.deepEqual(recorded.envelope.error, { code: 'sentinel.execution.outputMismatch', retryable: false });
    assert.equal(store.ledger.getWork({ id: 'work-D', revision: 1 }).state, 'blocked');
    assert.equal(store.ledger.getWork({ id: 'work-D', revision: 1 }).reason, 'sentinel.execution.dependencyFailed');
    assert.equal(store.ledger.getRun('run-e4').outcome, 'execution-failure');
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
      const l = ledgerState(second, plan);
      assert.equal(l.running, 0, 'no attempt left running');
      assert.equal(l.openStages, 0, 'no stage left open');
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

test('a disk or resource failure is recorded with the attempt and survives a reopen', async () => {
  const s = fresh('disk');
  const { plan, registry } = syntheticPlan(s.root, { A: 'big-artifact' });
  const store = await storeIn(s.root);
  const summary = await (await Coordinator.open({ store, plan, registry, scratchRoot: s.work })).run();
  assert.equal(summary.outcome, 'execution-failure');
  store.close();
  const reopened = await storeIn(s.root);
  try {
    const [a] = reopened.ledger.listAttempts({ id: 'work-A', revision: 1 });
    const recorded = reopened.ledger.getAttempt(a.id);
    assert.equal(recorded.state, 'failed');
    assert.deepEqual(recorded.envelope.error, { code: 'sentinel.object.tooLarge', retryable: false });
    assert.equal(reopened.ledger.getWork({ id: 'work-A', revision: 1 }).state, 'failed');
    assert.equal(reopened.ledger.getRun('run-e4').outcome, 'execution-failure');
    assert.equal(reopened.ledger.listOpenStages(500).length, 0, 'the refused publication left no stage open');
  } finally { reopened.close(); }
});

test('a crash while the run is canceling leaves its stale attempts terminal after recovery', async () => {
  const s = fresh('cancel-crash');
  const { plan, registry } = syntheticPlan(s.root, { A: 'hang' }, { limits: { timeoutMs: 20_000 } });
  const first = await storeIn(s.root);
  const hooks = { at: (b: string) => { if (b === 'after-attempt-start') { first.ledger.setRunState('run-e4', 'canceling'); first.close(); } } };
  await (await Coordinator.open({ store: first, plan, registry, scratchRoot: s.work, hooks })).run().catch(() => undefined);
  const second = await storeIn(s.root);
  try {
    const c = await Coordinator.open({ store: second, plan, registry, scratchRoot: s.work });
    assert.equal(c.recovery.interrupted.length, 1);
    assert.equal(c.recovery.interrupted[0].workState, 'failed', 'a canceling run admits no further attempt');
    const summary = await c.run();
    assert.equal(summary.state, 'canceled');
    const [a] = second.ledger.listAttempts({ id: 'work-A', revision: 1 });
    assert.equal(a.state, 'interrupted');
    assert.deepEqual(second.ledger.getAttempt(a.id).envelope.error, { code: 'sentinel.store.staleEpoch', retryable: false });
    assert.equal(second.ledger.getWork({ id: 'work-A', revision: 1 }).state, 'failed');
    assert.equal(summary.published, 0);
  } finally { second.close(); }
});

test('an unreadable journal record is kept, reported and makes recovery not clean', async () => {
  const s = fresh('journal');
  const store = await storeIn(s.root);
  try {
    const dir = new WorkerFiles(store.storePath).dir;
    writeFileSync(join(dir, 'garbage.json'), '{not json', { mode: 0o600 });
    writeFileSync(join(dir, 'big.json'), 'x'.repeat(8192), { mode: 0o600 });
    writeFileSync(join(dir, 'fields.json'), '{"attempt":"a"}', { mode: 0o600 });
    symlinkSync('/etc/hosts', join(dir, 'link.json'));
    mkdirSync(join(dir, 'folder.json'), { mode: 0o700 });
    const { plan, registry } = syntheticPlan(s.root);
    const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work, cleanupWaitMs: 0 });
    const reasons = Object.fromEntries(c.recovery.unresolved.map((u: any) => [u.file, u.reason]));
    assert.deepEqual(reasons, { 'garbage.json': 'not JSON', 'big.json': 'too large', 'fields.json': 'missing fields', 'link.json': 'a link', 'folder.json': 'not a regular file' });
    assert.equal(c.recovery.clean, false);
    // Unconfirmed cleanup blocks admission: a record that cannot be read may describe a worker still running.
    const blocked = await c.run();
    assert.equal(blocked.blockedByCleanup.length, 5);
    assert.equal(blocked.published, 0, 'nothing was admitted');
    for (const f of ['garbage.json', 'big.json', 'fields.json', 'link.json', 'folder.json']) assert.ok(existsSync(join(dir, f)), `${f} is kept`);
    // An explicit acknowledgement moves them, byte for byte, to the terminal-unknown journal; admission continues.
    assert.equal(c.acknowledgeUnknownCleanup().length, 5);
    const summary = await c.run();
    assert.equal(summary.published, 4);
    assert.deepEqual(summary.blockedByCleanup, []);
    assert.equal(summary.unknownCleanup.length, 5, 'kept for audit');
    assert.equal(summary.clean, false, 'acknowledged cleanup is never reported clean');
  } finally { store.close(); }
});

test('a recorded pid now held by an unrelated process is never killed', async () => {
  const s = fresh('pid-reuse');
  const store = await storeIn(s.root);
  const unrelated = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    await new Promise(r => unrelated.once('spawn', r));
    new WorkerFiles(store.storePath).record({ attempt: 'att-earlier', store: store.storeId, epoch: 'epoch-earlier', pid: unrelated.pid!, token: '00000000-0000-4000-8000-000000000000', kernelStart: '' });
    const { plan, registry } = syntheticPlan(s.root);
    const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work });
    assert.deepEqual(c.recovery.stoppedWorkers, []);
    assert.equal(unrelated.exitCode, null, 'the unrelated process is still running');
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
    assert.deepEqual(new WorkerFiles(store.storePath).list().records, [], 'the record is settled: our worker had exited');
  } finally { unrelated.kill('SIGKILL'); store.close(); }
});

test('work the plan disables is held with its reason, and the run completes with partial coverage', async () => {
  const s = fresh('disabled');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root, {}, { held: { D: 'sentinel.execution.planInvalid' } });
    const summary = await (await Coordinator.open({ store, plan, registry, scratchRoot: s.work })).run();
    assert.equal(summary.published, 3);
    assert.equal(summary.outcome, 'partial-coverage');
    const d = store.ledger.getWork({ id: 'work-D', revision: 1 });
    assert.deepEqual({ state: d.state, reason: d.reason }, { state: 'disabled-by-policy', reason: 'sentinel.execution.planInvalid' });
  } finally { store.close(); }
});

test('a work resource policy lowers the attempt limits: deadline and process output', async () => {
  const s = fresh('resources');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root, { A: 'hang', B: 'stderr-flood' }, { resources: { A: { deadlineMs: 800 }, B: { maxOutputBytes: 64 * 1024 } } });
    const summary = await (await Coordinator.open({ store, plan, registry, scratchRoot: s.work, retry: { maxAttempts: 1 } })).run();
    const codeOf = (id: string) => store.ledger.getAttempt(store.ledger.listAttempts({ id, revision: 1 })[0].id).envelope.error?.code;
    assert.equal(codeOf('work-A'), 'sentinel.execution.deadlineExceeded', 'the 800 ms deadline applied, not the adapter 15 s');
    assert.equal(summary.units.find((u: any) => u.ref.id === 'work-B').state, 'blocked', 'B never ran: A failed');
    const s2 = fresh('resources-output');
    const store2 = await storeIn(s2.root);
    try {
      const p2 = syntheticPlan(s2.root, { A: 'stderr-flood' }, { resources: { A: { maxOutputBytes: 64 * 1024 } } });
      await (await Coordinator.open({ store: store2, plan: p2.plan, registry: p2.registry, scratchRoot: s2.work, retry: { maxAttempts: 1 } })).run();
      const [a] = store2.ledger.listAttempts({ id: 'work-A', revision: 1 });
      assert.equal(store2.ledger.getAttempt(a.id).envelope.error?.code, 'sentinel.execution.stderrBudget', 'the 64 KiB process output bound applied');
    } finally { store2.close(); }
  } finally { store.close(); }
});

test('directory sync: supported is synced; a failure that is not "unsupported" fails the step', async () => {
  const { syncDirectory } = await import('../dist/execution/durability.js');
  const s = fresh('sync');
  assert.equal(syncDirectory(s.work), 'synced');
  writeFileSync(join(s.root, 'a-file'), 'x');
  assert.throws(() => syncDirectory(join(s.root, 'a-file')), (e: any) => e.code === 'sentinel.execution.durabilityFailed' && e.detail.osCode === 'ENOTDIR');
  assert.throws(() => syncDirectory(join(s.root, 'absent')), (e: any) => e.code === 'sentinel.execution.durabilityFailed' && e.detail.osCode === 'ENOENT');
});

test('work revisions of another run are refused, as is a recorded run with another identity', async () => {
  const s = fresh('cross-run');
  const store = await storeIn(s.root);
  try {
    const first = syntheticPlan(s.root);
    await (await Coordinator.open({ store, plan: first.plan, registry: first.registry, scratchRoot: s.work })).run();
    // The same work ids and revisions under a new run: refused before anything runs, not reported complete.
    const second = syntheticPlan(s.root, {}, { runId: 'run-e5' });
    await assert.rejects(Coordinator.open({ store, plan: second.plan, registry: second.registry, scratchRoot: s.work }),
      (e: any) => is('sentinel.execution.planInvalid')(e) && /belongs to run run-e4/.test(e.detail.reason));
    // The same run id with another snapshot: refused.
    const altered = syntheticPlan(s.root);
    altered.plan.run.snapshotId = 'snap-other';
    await assert.rejects(Coordinator.open({ store, plan: altered.plan, registry: altered.registry, scratchRoot: s.work }),
      (e: any) => is('sentinel.execution.planInvalid')(e) && /another snapshotId/.test(e.detail.reason));
    assert.equal([...publications(store, 'run-e5').values()].length, 0);
  } finally { store.close(); }
});

test('the plan is frozen at open and bound to its adapter, actual inputs and influence manifest', async () => {
  const s = fresh('bound');
  const store = await storeIn(s.root);
  try {
    // A declared fingerprint, stage digest or manifest that does not match is refused before execution.
    // The declared fingerprint is bound through the manifest: changing either without the other is refused.
    for (const [field, value, reason] of [['inputFingerprint', `sha256:${'7'.repeat(64)}`, /influence manifest/], ['influenceManifest', `sha256:${'8'.repeat(64)}`, /influence manifest/]] as const) {
      const p = syntheticPlan(s.root);
      (p.plan.works[0] as any)[field] = value;
      await assert.rejects(Coordinator.open({ store, plan: p.plan, registry: p.registry, scratchRoot: s.work }), (e: any) => is('sentinel.execution.planInvalid')(e) && reason.test(e.detail.reason), field);
    }
    const wrongStage = syntheticPlan(s.root);
    wrongStage.plan.works[0].stage = { ...wrongStage.plan.works[0].stage, implementationDigest: `sha256:${'9'.repeat(64)}` };
    await assert.rejects(Coordinator.open({ store, plan: wrongStage.plan, registry: wrongStage.registry, scratchRoot: s.work }), (e: any) => /not adapter/.test(e.detail?.reason ?? ''));
    // After open, changing the caller's objects or callbacks changes nothing that executes.
    const p = syntheticPlan(s.root);
    const approved = p.plan.works[0].inputFingerprint;
    const c = await Coordinator.open({ store, plan: p.plan, registry: p.registry, scratchRoot: s.work });
    p.plan.works[0].inputFingerprint = `sha256:${'a'.repeat(64)}`;
    p.plan.adapterFor = () => 'test-hang';
    p.plan.inputsFor = () => [];
    const summary = await c.run();
    assert.equal(summary.published, 4);
    assert.equal(store.ledger.getWork({ id: 'work-A', revision: 1 }).envelope.inputFingerprint, approved);
    // The influence manifest is published with the result, so the binding can be inspected.
    const outputs = store.ledger.getPublication({ id: 'work-A', revision: 1 }).outputs;
    assert.ok(outputs.some((o: any) => o.schema === 'sentinel-influence/draft-1' && o.id === p.plan.works[0].influenceManifest));
  } finally { store.close(); }
});

test('coverage decides the outcome: complete only with every planned check and scope covered; skips are incomplete', async () => {
  const required = () => ({ checks: ['check-sql'], scope: ['src/app.ts'] });
  const s1 = fresh('covered');
  const store1 = await storeIn(s1.root);
  try {
    const all = syntheticPlan(s1.root, { A: 'covering-ok', B: 'covering-ok', C: 'covering-ok', D: 'covering-ok' }, { required });
    const summary = await (await Coordinator.open({ store: store1, plan: all.plan, registry: all.registry, scratchRoot: s1.work })).run();
    assert.equal(summary.outcome, 'complete-coverage');
    assert.equal(summary.clean, true);
  } finally { store1.close(); }
  const s2 = fresh('skipped');
  const store2 = await storeIn(s2.root);
  try {
    const skip = syntheticPlan(s2.root, { A: 'covering-ok', B: 'skip-scope', C: 'covering-ok', D: 'covering-ok' }, { required });
    const summary = await (await Coordinator.open({ store: store2, plan: skip.plan, registry: skip.registry, scratchRoot: s2.work })).run();
    assert.equal(summary.published, 4, 'every worker succeeded');
    assert.equal(summary.outcome, 'partial-coverage', 'a skipped required scope is not complete coverage');
    const b = summary.coverage.find((c: any) => c.work.id === 'work-B');
    assert.deepEqual({ verdict: b.verdict, missingScope: b.missingScope, skipped: b.skipped }, { verdict: 'incomplete', missingScope: ['src/app.ts'], skipped: [{ scopeId: 'src/app.ts', reasonCode: 'sentinel.coverage.unsupported' }] });
    assert.equal(summary.clean, false);
  } finally { store2.close(); }
  // The evaluation is durable: a new coordinator reads it back from the publication.
  const again = await storeIn(s2.root);
  try {
    const skip = syntheticPlan(s2.root, { A: 'covering-ok', B: 'skip-scope', C: 'covering-ok', D: 'covering-ok' }, { required });
    const resumed = await (await Coordinator.open({ store: again, plan: skip.plan, registry: skip.registry, scratchRoot: s2.work })).run();
    assert.equal(resumed.coverage.find((c: any) => c.work.id === 'work-B').verdict, 'incomplete');
  } finally { again.close(); }
});

test('a store closed from the attempt-recording callback stops exactly the worker it was starting', async () => {
  const s = fresh('callback-close');
  const store = await storeIn(s.root);
  const { plan, registry } = syntheticPlan(s.root, { A: 'hang' }, { limits: { timeoutMs: 20_000 } });
  let token = '';
  // Closed inside the callback after the attempt was recorded: nothing throws, so only the guard can stop it.
  const hooks = { at: (b: string) => { if (b === 'after-attempt-start' && !token) { token = new WorkerFiles(store.storePath).list().records[0].token; try { store.close(); } catch { /* reported by the close */ } } } };
  const started = Date.now();
  await (await Coordinator.open({ store, plan, registry, scratchRoot: s.work, hooks })).run().catch(() => undefined);
  assert.ok(token, 'the worker was started');
  assert.deepEqual(processesCarrying(token), [], 'no process carries its token: the guard stopped it');
  assert.ok(Date.now() - started < 5_000, 'stopped at the close, not at its deadline');
});

test('a pause asked for before run() holds that run; the next run() resumes it', async () => {
  const s = fresh('pause-first');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root);
    const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work });
    c.pause();
    const paused = await c.run();
    assert.equal(paused.state, 'paused');
    assert.equal(paused.published, 0, 'nothing was admitted');
    assert.equal((await c.run()).published, 4);
  } finally { store.close(); }
});

test('a pause asked for right after run() starts holds the run, and the next run() resumes it', async () => {
  const s = fresh('pause-race');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root);
    const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work });
    // The review's sequence: the pause arrives while run() is still in its set-up awaits.
    const running = c.run();
    c.pause();
    const paused = await running;
    assert.equal(paused.state, 'paused');
    assert.equal(paused.published, 0, 'nothing was admitted');
    assert.equal(store.ledger.getRun('run-e4')!.state, 'paused');
    // The pause was honoured, so it is cleared: the next run() resumes to completion, each output once.
    const resumed = await c.run();
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.published, 4);
    assert.ok([...publications(store, 'run-e4').values()].every(n => n === 1));
  } finally { store.close(); }
});

test('a run() while a drive is active returns that drive; it never starts a second one', async () => {
  const s = fresh('run-twice');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root);
    const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work });
    const first = c.run();
    assert.equal(c.run(), first);
    const done = await first;
    assert.equal(done.published, 4);
    assert.ok([...publications(store, 'run-e4').values()].every(n => n === 1), 'each output accepted once');
  } finally { store.close(); }
});

test('the retry policy, capacity and plan are copied at open; changing the caller\'s objects later changes nothing', async () => {
  const s = fresh('frozen-config');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root, { A: 'exit-nonzero-after-result' });
    const retry = { maxAttempts: 1 };
    const capacity = { slots: 1, memoryBytes: 2_147_483_648, cpus: 2 };
    const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work, retry, capacity });
    retry.maxAttempts = 6;
    capacity.slots = 64;
    await c.run();
    assert.equal(store.ledger.listAttempts({ id: 'work-A', revision: 1 }).length, 1, 'still one attempt: the ceiling at open');
  } finally { store.close(); }
});

test('a successful attempt names its invocation record, published with the result and bound to the approved plan', async () => {
  const s = fresh('invocation');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root);
    await (await Coordinator.open({ store, plan, registry, scratchRoot: s.work })).run();
    const ref = { id: 'work-A', revision: 1 };
    const [a] = store.ledger.listAttempts(ref);
    const invocationId = store.ledger.getAttempt(a.id).envelope.invocation;
    assert.match(invocationId, /^sha256:[0-9a-f]{64}$/);
    const out = store.ledger.getPublication(ref).outputs.find((o: any) => o.schema === 'sentinel-invocation/draft-1');
    assert.equal(out?.id, invocationId, 'the attempt and the publication name the same record');
    const record = JSON.parse((await store.readArtifact(invocationId)).toString('utf8'));
    assert.equal(record.attemptId, a.id);
    assert.equal(record.adapter.digest, plan.works[0].stage.implementationDigest);
    assert.deepEqual(record.inputs, plan.inputsFor().map((i: any) => i.id).sort());
  } finally { store.close(); }
});

test('the run budget bounds the whole run: running work is stopped at the deadline and what cannot start is held', async () => {
  const s = fresh('run-budget');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root, { A: 'hang' }, { limits: { timeoutMs: 60_000 } });
    plan.run.budgets = { ...plan.run.budgets, deadlineMs: 800 };
    const started = Date.now();
    const summary = await (await Coordinator.open({ store, plan, registry, scratchRoot: s.work })).run();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4_000, `the run ended ${elapsed} ms after starting, near its 800 ms budget`);
    assert.equal(summary.state, 'completed');
    assert.equal(summary.outcome, 'execution-failure');
    const [a] = store.ledger.listAttempts({ id: 'work-A', revision: 1 });
    assert.equal(store.ledger.getAttempt(a.id).envelope.error.code, 'sentinel.execution.runDeadline');
    assert.equal(summary.published, 0);
  } finally { store.close(); }
});

test('a declared input fingerprint may cover more than the inputs: it is accepted when the manifest binds it', async () => {
  const s = fresh('wide-fingerprint');
  const store = await storeIn(s.root);
  try {
    const { plan, registry } = syntheticPlan(s.root);
    for (const w of plan.works) {
      w.inputFingerprint = `sha256:${'c'.repeat(64)}`; // e.g. inputs plus rules and configuration
      w.influenceManifest = influenceManifest(w, registry.get(plan.adapterFor(w)), plan.inputsFor().map((i: any) => i.id)).id;
    }
    const summary = await (await Coordinator.open({ store, plan, registry, scratchRoot: s.work })).run();
    assert.equal(summary.published, 4);
  } finally { store.close(); }
});
