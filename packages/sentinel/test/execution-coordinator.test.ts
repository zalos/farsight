// The coordinator in one process, against a real store from openStore() and real built-in worker processes.
// Always run. A "crash" here closes the store at a boundary (ownership lost mid-step), so recovery's state
// transitions are exercised every run; real SIGKILLs at the same boundaries are in execution-recovery-kill.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { WorkerFiles, processesCarrying } from '../dist/execution/recovery.js';
import { Coordinator, COORDINATOR_BOUNDARIES } from '../dist/execution/coordinator.js';
import { bindingId, executionBinding } from '../dist/execution/plan.js';
import { decide, orderPlan, ReservationPool, retryable, DEFAULT_RETRY } from '../dist/execution/scheduler.js';
import { isExecutionError } from '../dist/execution/errors.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { ledgerState, publications, syntheticPlan, syntheticRegistry } from './coordinator-helpers.ts';

const roots: string[] = [];
after(() => roots.forEach(removeScratch));
const fresh = (label: string) => {
  const s = scratch(label);
  roots.push(s.root);
  return s;
};
const is = (code: string) => (e: unknown) => isExecutionError(e) && e.code === code;
/** Open a coordinator on a synthetic plan's run. */
const open = (store: any, p: any, s: any, extra: Record<string, unknown> = {}) =>
  Coordinator.open({ store, runId: p.runId, run: p.run, registry: p.registry, scratchRoot: s.work, ...extra });
/** A unit's execution binding as the coordinator records it, read back from the store and checked reachable. */
async function bindingOf(store: any, p: any, id: string) {
  const unit = p.plan.units.find((u: any) => u.id === id);
  const work = store.ledger.getWork({ id, revision: 1 }).envelope;
  const expected = executionBinding(
    p.plan,
    work,
    p.registry.get(unit.adapterId),
    unit.inputs.map((i: any) => i.content),
  );
  const stored = JSON.parse((await store.readArtifact(bindingId(expected))).toString('utf8'));
  assert.ok((await store.inspect()).reachable.includes(bindingId(expected)), 'the binding is retained');
  return stored;
}
/** The diamond as scheduler inputs: ids and dependencies only. */
const diamond = () => {
  const w = (id: string, deps: string[]) => ({
    id: `work-${id}`,
    revision: 1,
    state: 'pending',
    dependencies: deps.map((d) => ({ id: `work-${d}`, revision: 1 })),
  });
  return [w('A', []), w('B', ['A']), w('C', ['A']), w('D', ['B', 'C'])] as any[];
};

test('the plan must be a DAG of this run with dependencies inside it', () => {
  const works = diamond();
  assert.deepEqual(
    orderPlan(works).map((w: any) => w.id),
    ['work-A', 'work-B', 'work-C', 'work-D'],
  );
  const cyclic = works.map((w: any) =>
    w.id === 'work-A' ? { ...w, dependencies: [{ id: 'work-D', revision: 1 }] } : w,
  );
  assert.throws(() => orderPlan(cyclic), is('sentinel.execution.planInvalid'));
  const dangling = [{ ...works[0], dependencies: [{ id: 'work-X', revision: 1 }] }];
  assert.throws(() => orderPlan(dangling), is('sentinel.execution.planInvalid'));
  assert.ok(orderPlan(dangling, new Set(['work-X@1'])), 'a dependency on reused published work is outside the plan');
  assert.throws(() => orderPlan([works[0], works[0]]), is('sentinel.execution.planInvalid'));
});

test('readiness follows publication; a failed or blocked dependency blocks its dependents', () => {
  const c = new Map<string, any>([
    ['work-A@1', { created: true, workState: 'published', attempts: 1 }],
    ['work-B@1', { created: true, workState: 'failed', attempts: 3 }],
  ]);
  const d = decide(diamond(), c, DEFAULT_RETRY);
  assert.deepEqual(
    d.map((x: any) => x.state),
    ['published', 'failed', 'ready', 'blocked'],
  );
  assert.match(d[3].reason, /work-B@1 failed/);
});

test('reservations are bounded and released once; retries are bounded and only for retryable reasons', () => {
  const pool = new ReservationPool({ slots: 2, memoryBytes: 1024, cpus: 2 });
  const a = pool.tryReserve('a', { memoryBytes: 600, cpus: 1 })!;
  assert.equal(pool.tryReserve('b', { memoryBytes: 600, cpus: 1 }), null, 'memory is reserved');
  const b = pool.tryReserve('b', { memoryBytes: 400, cpus: 1 })!;
  assert.equal(pool.tryReserve('c', { memoryBytes: 1, cpus: 1 }), null, 'slots are reserved');
  pool.release(a);
  pool.release(b);
  assert.equal(pool.held, 0);
  assert.throws(
    () => pool.tryReserve('huge', { memoryBytes: 4096, cpus: 1 }),
    is('sentinel.execution.resourceExceeded'),
  );
  assert.equal(retryable('sentinel.execution.workerExited', 1, DEFAULT_RETRY), true);
  assert.equal(retryable('sentinel.execution.workerExited', 3, DEFAULT_RETRY), false);
  assert.equal(retryable('sentinel.execution.outputMismatch', 1, DEFAULT_RETRY), false, 'integrity is never retried');
});

test('a run executes the whole DAG once, publishing every unit exactly once', async () => {
  const s = fresh('run');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root);
    const summary = await (await open(store, p, s)).run();
    assert.equal(summary.state, 'completed');
    // Every worker succeeded but reported no coverage: work alone completes no check, so the run is partial.
    assert.equal(summary.outcome, 'partial-coverage');
    assert.equal(summary.coverage!.requiredComplete, 0);
    assert.equal(summary.coverageRecords, 4, 'one record per assigned check, each not-run');
    assert.equal(summary.published, 4);
    assert.deepEqual([...publications(store, 'run-e4').values()], [1, 1, 1, 1]);
    // Order: A before B and C, both before D.
    const order: string[] = [];
    let after = 0;
    for (;;) {
      const page = store.ledger.readEvents({ after, limit: 500 });
      for (const e of page.events) if (e.kind === 'work-published') order.push(e.work!.id);
      if (!page.more) break;
      after = page.cursor;
    }
    assert.equal(order[0], p.ids.A);
    assert.equal(order[3], p.ids.D);
    // Running it again is a no-op: the run is complete. The run is recorded, so its id alone opens it.
    assert.equal(
      (await (await Coordinator.open({ store, runId: p.runId, registry: p.registry, scratchRoot: s.work })).run())
        .published,
      4,
    );
  } finally {
    store.close();
  }
});

test('a retryable failure is retried within its bound; an integrity failure is final and blocks dependents', async () => {
  const s = fresh('retry');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(
      store,
      s.root,
      { B: 'fail-once', C: 'tampered-output' },
      { argument: join(s.root, 'fail-once-marker') },
    );
    const summary = await (await open(store, p, s)).run();
    const byId = Object.fromEntries(summary.units.map((u: any) => [u.ref.id, u.state]));
    assert.deepEqual(byId, {
      [p.ids.A]: 'published',
      [p.ids.B]: 'published',
      [p.ids.C]: 'failed',
      [p.ids.D]: 'blocked',
    });
    assert.equal(summary.state, 'completed');
    assert.equal(summary.outcome, 'execution-failure');
    assert.ok(summary.failures.some((f: any) => f.work.id === p.ids.B && f.code === 'sentinel.execution.workerExited'));
    assert.ok(
      summary.failures.some((f: any) => f.work.id === p.ids.C && f.code === 'sentinel.execution.outputMismatch'),
    );
    assert.equal(store.ledger.listAttempts({ id: p.ids.B, revision: 1 }).length, 2, 'one retry');
    assert.equal(store.ledger.listAttempts({ id: p.ids.C, revision: 1 }).length, 1, 'never retried');
    // Every failure is in the ledger, with its code and whether it was retryable, and D is held with its reason.
    const [c1] = store.ledger.listAttempts({ id: p.ids.C, revision: 1 });
    const recorded = store.ledger.getAttempt(c1.id);
    assert.deepEqual(recorded.envelope.error, { code: 'sentinel.execution.outputMismatch', retryable: false });
    assert.equal(store.ledger.getWork({ id: p.ids.D, revision: 1 }).state, 'blocked');
    assert.equal(store.ledger.getWork({ id: p.ids.D, revision: 1 }).reason, 'sentinel.execution.dependencyFailed');
    assert.equal(store.ledger.getRun('run-e4').outcome, 'execution-failure');
    // The failed attempt still names a durable invocation record and execution binding.
    const record = JSON.parse((await store.readArtifact(recorded.envelope.invocation)).toString('utf8'));
    assert.equal(record.attemptId, c1.id);
    const binding = await bindingOf(store, p, p.ids.C);
    assert.equal(binding.schema, 'sentinel-execution-binding/draft-1');
    assert.equal(
      binding.influenceManifest,
      store.ledger.getWork({ id: p.ids.C, revision: 1 }).envelope.influenceManifest,
    );
    const report = await store.inspect();
    assert.equal(report.ok, true, JSON.stringify(report.errors));
  } finally {
    store.close();
  }
});

test('pause lets in-flight work finish and publish, admits nothing new, and resumes to completion', async () => {
  const s = fresh('pause');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, { A: 'slow-ok' });
    let c: any;
    // Paused once A's attempt is recorded and its worker runs: A is in flight, nothing else has been admitted.
    const hooks = {
      at: (b: string, ctx: any) => {
        if (b === 'after-attempt-start' && ctx.work.id === p.ids.A) c.pause();
      },
    };
    c = await open(store, p, s, { hooks });
    const running = c.run();
    const paused = await running;
    assert.equal(paused.state, 'paused');
    assert.deepEqual(
      [...publications(store, 'run-e4').keys()],
      [p.ids.A],
      'the in-flight unit published while pausing',
    );
    assert.equal(paused.units.find((u: any) => u.ref.id === p.ids.B).state, 'ready', 'nothing new was admitted');
    const resumed = await (await open(store, p, s)).run();
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.published, 4);
  } finally {
    store.close();
  }
});

test('cancel stops the workers and revokes publication, even for a result already in hand', async () => {
  const s = fresh('cancel');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, { A: 'hang' }, { limits: { timeoutMs: 20_000, cancelGraceMs: 500 } });
    const c = await open(store, p, s);
    const running = c.run();
    await new Promise((r) => setTimeout(r, 400));
    c.cancel();
    const summary = await running;
    assert.equal(summary.state, 'canceled');
    assert.equal(summary.published, 0);
    // A result already produced is refused once the run is canceling.
    const s2 = fresh('cancel-late');
    const store2 = await storeIn(s2.root);
    try {
      const p2 = await syntheticPlan(store2, s2.root);
      let c2: any;
      const hooks = {
        at: (b: string) => {
          if (b === 'before-staging') c2.cancel();
        },
      };
      c2 = await open(store2, p2, s2, { hooks });
      const late = await c2.run();
      assert.equal(late.state, 'canceled');
      assert.equal(late.published, 0, 'the ledger refused the publication');
      assert.ok(late.failures.some((f: any) => f.code === 'sentinel.execution.canceled'));
    } finally {
      store2.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      /* closed */
    }
  }
});

for (const boundary of COORDINATOR_BOUNDARIES) {
  test(`a coordinator that loses its store at ${boundary} is finished by the next, with each unit published once`, async () => {
    const s = fresh(`crash-${boundary}`);
    const first = await storeIn(s.root);
    const p = await syntheticPlan(first, s.root);
    let fired = false;
    const hooks = {
      at: (b: string, ctx: any) => {
        if (b === boundary && ctx.work.id === p.ids.B && !fired) {
          fired = true;
          try {
            first.close();
          } catch {
            /* reported by the close */
          }
        }
      },
    };
    await (await open(first, p, s, { hooks })).run().catch(() => undefined);
    assert.ok(fired);
    try {
      first.close();
    } catch {
      /* already closed */
    }
    const second = await storeIn(s.root);
    try {
      const c = await open(second, p, s);
      const summary = await c.run();
      assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
      assert.equal(summary.published, 4);
      assert.deepEqual(
        [...publications(second, 'run-e4').values()].sort(),
        [1, 1, 1, 1],
        'no lost and no duplicate publication',
      );
      const l = ledgerState(second, p.plan);
      assert.equal(l.running, 0, 'no attempt left running');
      assert.equal(l.openStages, 0, 'no stage left open');
      if (boundary === 'after-staging' || boundary === 'after-objects')
        assert.ok(c.recovery.abortedStages.length >= 1, 'the open stage was aborted');
    } finally {
      second.close();
    }
  });
}

test('a late write from an earlier epoch is refused by the ledger', async () => {
  const s = fresh('late');
  const first = await storeIn(s.root);
  const p = await syntheticPlan(first, s.root);
  let stale: { work: any; attemptId: string } | undefined;
  const hooks = {
    at: (b: string, ctx: any) => {
      if (b === 'after-attempt-start' && ctx.work.id === p.ids.A && !stale) {
        stale = ctx;
        first.close();
      }
    },
  };
  await (await open(first, p, s, { hooks })).run().catch(() => undefined);
  const second = await storeIn(s.root);
  try {
    await (await open(second, p, s)).run();
    assert.throws(
      () =>
        second.ledger.endAttempt({
          work: stale!.work,
          attemptId: stale!.attemptId,
          state: 'failed',
          endedAt: new Date().toISOString(),
          workState: 'ready',
        }),
      (e: any) =>
        ['sentinel.store.alreadyPublished', 'sentinel.store.notActiveAttempt', 'sentinel.store.staleEpoch'].includes(
          e.code,
        ),
    );
    assert.equal(
      [...publications(second, 'run-e4').values()].reduce((a, b) => a + b, 0),
      4,
    );
  } finally {
    second.close();
  }
});

test('a disk or resource failure is recorded with the attempt and survives a reopen', async () => {
  const s = fresh('disk');
  const store = await storeIn(s.root);
  const p = await syntheticPlan(store, s.root, { A: 'big-artifact' });
  const summary = await (await open(store, p, s)).run();
  assert.equal(summary.outcome, 'execution-failure');
  store.close();
  const reopened = await storeIn(s.root);
  try {
    const [a] = reopened.ledger.listAttempts({ id: p.ids.A, revision: 1 });
    const recorded = reopened.ledger.getAttempt(a.id);
    assert.equal(recorded.state, 'failed');
    assert.deepEqual(recorded.envelope.error, { code: 'sentinel.object.tooLarge', retryable: false });
    assert.equal(reopened.ledger.getWork({ id: p.ids.A, revision: 1 }).state, 'failed');
    assert.equal(reopened.ledger.getRun('run-e4').outcome, 'execution-failure');
    assert.equal(reopened.ledger.listOpenStages(500).length, 0, 'the refused publication left no stage open');
  } finally {
    reopened.close();
  }
});

test('a crash while the run is canceling leaves its stale attempts terminal after recovery', async () => {
  const s = fresh('cancel-crash');
  const first = await storeIn(s.root);
  const p = await syntheticPlan(first, s.root, { A: 'hang' }, { limits: { timeoutMs: 20_000 } });
  const hooks = {
    at: (b: string) => {
      if (b === 'after-attempt-start') {
        first.ledger.setRunState('run-e4', 'canceling');
        first.close();
      }
    },
  };
  await (await open(first, p, s, { hooks })).run().catch(() => undefined);
  const second = await storeIn(s.root);
  try {
    const c = await open(second, p, s);
    assert.equal(c.recovery.interrupted.length, 1);
    assert.equal(c.recovery.interrupted[0].workState, 'failed', 'a canceling run admits no further attempt');
    const summary = await c.run();
    assert.equal(summary.state, 'canceled');
    const [a] = second.ledger.listAttempts({ id: p.ids.A, revision: 1 });
    assert.equal(a.state, 'interrupted');
    assert.deepEqual(second.ledger.getAttempt(a.id).envelope.error, {
      code: 'sentinel.store.staleEpoch',
      retryable: false,
    });
    assert.equal(second.ledger.getWork({ id: p.ids.A, revision: 1 }).state, 'failed');
    assert.equal(summary.published, 0);
  } finally {
    second.close();
  }
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
    const p = await syntheticPlan(store, s.root);
    const c = await open(store, p, s, { cleanupWaitMs: 0 });
    const reasons = Object.fromEntries(c.recovery.unresolved.map((u: any) => [u.file, u.reason]));
    assert.deepEqual(reasons, {
      'garbage.json': 'not JSON',
      'big.json': 'too large',
      'fields.json': 'missing fields',
      'link.json': 'a link',
      'folder.json': 'not a regular file',
    });
    assert.equal(c.recovery.clean, false);
    // Unconfirmed cleanup blocks admission: a record that cannot be read may describe a worker still running.
    const blocked = await c.run();
    assert.equal(blocked.blockedByCleanup.length, 5);
    assert.equal(blocked.published, 0, 'nothing was admitted');
    for (const f of ['garbage.json', 'big.json', 'fields.json', 'link.json', 'folder.json'])
      assert.ok(existsSync(join(dir, f)), `${f} is kept`);
    // An explicit acknowledgement moves them, byte for byte, to the terminal-unknown journal; admission continues.
    assert.equal(c.acknowledgeUnknownCleanup().length, 5);
    const summary = await c.run();
    assert.equal(summary.published, 4);
    assert.deepEqual(summary.blockedByCleanup, []);
    assert.equal(summary.unknownCleanup.length, 5, 'kept for audit');
    assert.equal(summary.clean, false, 'acknowledged cleanup is never reported clean');
  } finally {
    store.close();
  }
});

test('a recorded pid now held by an unrelated process is never killed', async () => {
  const s = fresh('pid-reuse');
  const store = await storeIn(s.root);
  const unrelated = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    await new Promise((r) => unrelated.once('spawn', r));
    new WorkerFiles(store.storePath).record({
      attempt: 'att-earlier',
      store: store.storeId,
      epoch: 'epoch-earlier',
      pid: unrelated.pid!,
      token: '00000000-0000-4000-8000-000000000000',
      kernelStart: '',
    });
    const p = await syntheticPlan(store, s.root);
    const c = await open(store, p, s);
    assert.deepEqual(c.recovery.stoppedWorkers, []);
    assert.equal(unrelated.exitCode, null, 'the unrelated process is still running');
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
    assert.deepEqual(
      new WorkerFiles(store.storePath).list().records,
      [],
      'the record is settled: our worker had exited',
    );
  } finally {
    unrelated.kill('SIGKILL');
    store.close();
  }
});

test("the profile's stage resources lower the attempt limits: deadline and process output", async () => {
  const s = fresh('resources');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, { A: 'hang' }, { resources: { deadlineMs: 800 } });
    const summary = await (await open(store, p, s, { retry: { maxAttempts: 1 } })).run();
    const codeOf = (st: any, id: string) =>
      st.ledger.getAttempt(st.ledger.listAttempts({ id, revision: 1 })[0].id).envelope.error?.code;
    assert.equal(
      codeOf(store, p.ids.A),
      'sentinel.execution.deadlineExceeded',
      'the 800 ms deadline applied, not the adapter 15 s',
    );
    assert.equal(summary.units.find((u: any) => u.ref.id === p.ids.B).state, 'blocked', 'B never ran: A failed');
    const s2 = fresh('resources-output');
    const store2 = await storeIn(s2.root);
    try {
      const p2 = await syntheticPlan(
        store2,
        s2.root,
        { A: 'stderr-flood' },
        { resources: { maxOutputBytes: 64 * 1024 } },
      );
      await (await open(store2, p2, s2, { retry: { maxAttempts: 1 } })).run();
      assert.equal(
        codeOf(store2, p2.ids.A),
        'sentinel.execution.stderrBudget',
        'the 64 KiB process output bound applied',
      );
    } finally {
      store2.close();
    }
  } finally {
    store.close();
  }
});

test('directory sync: supported is synced; a failure that is not "unsupported" fails the step', async () => {
  const { syncDirectory } = await import('../dist/execution/durability.js');
  const s = fresh('sync');
  assert.equal(syncDirectory(s.work), 'synced');
  writeFileSync(join(s.root, 'a-file'), 'x');
  assert.throws(
    () => syncDirectory(join(s.root, 'a-file')),
    (e: any) => e.code === 'sentinel.execution.durabilityFailed' && e.detail.osCode === 'ENOTDIR',
  );
  assert.throws(
    () => syncDirectory(join(s.root, 'absent')),
    (e: any) => e.code === 'sentinel.execution.durabilityFailed' && e.detail.osCode === 'ENOENT',
  );
});

test('only an admitted revision runs: an unknown run, a run with another identity and a changed registry are refused', async () => {
  const s = fresh('admitted-only');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root);
    await (await open(store, p, s)).run();
    // A run whose plan was never admitted.
    await assert.rejects(
      Coordinator.open({
        store,
        runId: 'run-never',
        run: { ...p.run, id: 'run-never' },
        registry: p.registry,
        scratchRoot: s.work,
      }),
      (e: any) => is('sentinel.execution.planInvalid')(e) && /was not admitted/.test(e.detail.reason),
    );
    // The same run id with another snapshot: refused.
    await assert.rejects(
      open(store, { ...p, run: { ...p.run, snapshotId: 'snap-other' } }, s),
      (e: any) => is('sentinel.execution.planInvalid')(e) && /another snapshotId/.test(e.detail.reason),
    );
    // An adapter whose module changed since admission is no longer the adapter the plan pins.
    const changed = syntheticRegistry(join(s.root, 'changed'), ['ok'], { timeoutMs: 14_000 });
    await assert.rejects(
      Coordinator.open({ store, runId: p.runId, registry: changed, scratchRoot: s.work }),
      (e: any) =>
        is('sentinel.execution.planInvalid')(e) && /another digest|no longer registered/.test(e.detail.reason),
    );
  } finally {
    store.close();
  }
});

test("the plan is read back from the ledger: changing the caller's plan or run objects after admission changes nothing", async () => {
  const s = fresh('bound');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root);
    const approved = p.plan.units[0].inputFingerprint;
    p.plan.units[0].inputFingerprint = `sha256:${'a'.repeat(64)}`;
    p.plan.units[0].inputs = [];
    const c = await open(store, p, s);
    p.run.budgets.deadlineMs = 1;
    const summary = await c.run();
    assert.equal(summary.published, 4);
    assert.equal(store.ledger.getWork({ id: p.plan.units[0].id, revision: 1 }).envelope.inputFingerprint, approved);
    // Each work names the canonical influence manifest, which is a stored record.
    const w = store.ledger.getWork({ id: p.ids.A, revision: 1 }).envelope;
    const manifest = JSON.parse((await store.readArtifact(w.influenceManifest)).toString('utf8'));
    assert.equal(manifest.schema, 'sentinel-influence/draft-1');
    assert.deepEqual(manifest.unit, { id: p.ids.A, revision: 1 });
  } finally {
    store.close();
  }
});

test('coverage decides the outcome: complete only with every required check covered; a skipped scope is not complete', async () => {
  const s1 = fresh('covered');
  const store1 = await storeIn(s1.root);
  try {
    const all = await syntheticPlan(store1, s1.root, {
      A: 'covering-ok',
      B: 'covering-ok',
      C: 'covering-ok',
      D: 'covering-ok',
    });
    const summary = await (await open(store1, all, s1)).run();
    assert.equal(summary.outcome, 'complete-coverage');
    assert.equal(summary.coverage!.complete, true);
    assert.equal(summary.clean, true);
  } finally {
    store1.close();
  }
  const s2 = fresh('skipped');
  const store2 = await storeIn(s2.root);
  let skip: any;
  try {
    skip = await syntheticPlan(store2, s2.root, {
      A: 'covering-ok',
      B: 'skip-scope',
      C: 'covering-ok',
      D: 'covering-ok',
    });
    const summary = await (await open(store2, skip, s2)).run();
    assert.equal(summary.published, 4, 'every worker succeeded');
    assert.equal(summary.outcome, 'partial-coverage', 'a skipped required scope is not complete coverage');
    const bCheck = skip.plan.units.find((u: any) => u.id === skip.ids.B).checks[0];
    const b = summary.coverage!.checks.find((c: any) => c.checkId === bCheck)!;
    assert.deepEqual(
      { complete: b.complete, status: b.status, reason: b.reasonCode },
      { complete: false, status: 'partial', reason: 'sentinel.plan.coverageNotComplete' },
    );
  } finally {
    store2.close();
  }
  // The records are durable: a new coordinator reads them back from the publications.
  const again = await storeIn(s2.root);
  try {
    const resumed = await (await open(again, skip, s2)).run();
    assert.equal(resumed.coverage!.requiredComplete, 3);
    assert.equal(resumed.coverageRecords, 4);
  } finally {
    again.close();
  }
});

test('a store closed from the attempt-recording callback stops exactly the worker it was starting', async () => {
  const s = fresh('callback-close');
  const store = await storeIn(s.root);
  const p = await syntheticPlan(store, s.root, { A: 'hang' }, { limits: { timeoutMs: 20_000 } });
  let token = '';
  // Closed inside the callback after the attempt was recorded: nothing throws, so only the guard can stop it.
  const hooks = {
    at: (b: string) => {
      if (b === 'after-attempt-start' && !token) {
        token = new WorkerFiles(store.storePath).list().records[0].token;
        try {
          store.close();
        } catch {
          /* reported by the close */
        }
      }
    },
  };
  const started = Date.now();
  await (await open(store, p, s, { hooks })).run().catch(() => undefined);
  assert.ok(token, 'the worker was started');
  assert.deepEqual(processesCarrying(token), [], 'no process carries its token: the guard stopped it');
  assert.ok(Date.now() - started < 5_000, 'stopped at the close, not at its deadline');
});

test('a pause asked for before run() holds that run; the next run() resumes it', async () => {
  const s = fresh('pause-first');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root);
    const c = await open(store, p, s);
    c.pause();
    const paused = await c.run();
    assert.equal(paused.state, 'paused');
    assert.equal(paused.published, 0, 'nothing was admitted');
    assert.equal((await c.run()).published, 4);
  } finally {
    store.close();
  }
});

test('a pause asked for right after run() starts holds the run, and the next run() resumes it', async () => {
  const s = fresh('pause-race');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root);
    const c = await open(store, p, s);
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
    assert.ok([...publications(store, 'run-e4').values()].every((n) => n === 1));
  } finally {
    store.close();
  }
});

test('a run() while a drive is active returns that drive; it never starts a second one', async () => {
  const s = fresh('run-twice');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root);
    const c = await open(store, p, s);
    const first = c.run();
    assert.equal(c.run(), first);
    const done = await first;
    assert.equal(done.published, 4);
    assert.ok(
      [...publications(store, 'run-e4').values()].every((n) => n === 1),
      'each output accepted once',
    );
  } finally {
    store.close();
  }
});

test("the retry policy and capacity are copied at open; changing the caller's objects later changes nothing", async () => {
  const s = fresh('frozen-config');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, { A: 'exit-nonzero-after-result' });
    const retry = { maxAttempts: 1 };
    const capacity = { slots: 1, memoryBytes: 2_147_483_648, cpus: 2 };
    const c = await open(store, p, s, { retry, capacity });
    retry.maxAttempts = 6;
    capacity.slots = 64;
    await c.run();
    assert.equal(
      store.ledger.listAttempts({ id: p.ids.A, revision: 1 }).length,
      1,
      'still one attempt: the ceiling at open',
    );
  } finally {
    store.close();
  }
});

test('an attempt names its invocation record, accepted with its start and linking the execution binding', async () => {
  const s = fresh('invocation');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root);
    await (await open(store, p, s)).run();
    const ref = { id: p.ids.A, revision: 1 };
    const [a] = store.ledger.listAttempts(ref);
    const invocationId = store.ledger.getAttempt(a.id).envelope.invocation;
    assert.match(invocationId, /^sha256:[0-9a-f]{64}$/);
    const record = JSON.parse((await store.readArtifact(invocationId)).toString('utf8'));
    const unit = p.plan.units.find((u: any) => u.id === p.ids.A);
    assert.equal(record.attemptId, a.id);
    assert.equal(record.adapter.digest, unit.implementationDigest);
    assert.deepEqual(record.inputs, unit.inputs.map((i: any) => i.content).sort());
    assert.deepEqual(
      record.assignment,
      {
        checks: unit.checks,
        scopes: unit.scopes,
        inputScopes: unit.inputs.map((i: any) => ({ input: i.content, scopes: [`${i.sourceId}:${i.relativePath}`] })),
      },
      "the start carried the plan's checks, scopes and input scopes",
    );
    const binding = await bindingOf(store, p, p.ids.A);
    assert.deepEqual(
      { schema: binding.schema, plan: binding.plan, inputFingerprint: binding.inputFingerprint },
      {
        schema: 'sentinel-execution-binding/draft-1',
        plan: { runId: p.runId, revision: 1, digest: p.plan.digest },
        inputFingerprint: unit.inputFingerprint,
      },
    );
    assert.notEqual(
      binding.protocolFingerprint,
      binding.inputFingerprint,
      "the plan's wider fingerprint is bound beside the protocol one, not forced equal",
    );
  } finally {
    store.close();
  }
});

test('the run budget bounds the whole run: running work is stopped at the deadline and what cannot start is held', async () => {
  const s = fresh('run-budget');
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, { A: 'hang' }, { limits: { timeoutMs: 60_000 }, deadlineMs: 800 });
    const started = Date.now();
    const summary = await (await open(store, p, s)).run();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4_000, `the run ended ${elapsed} ms after starting, near its 800 ms budget`);
    assert.equal(summary.state, 'completed');
    assert.equal(summary.outcome, 'execution-failure');
    const [a] = store.ledger.listAttempts({ id: p.ids.A, revision: 1 });
    assert.equal(store.ledger.getAttempt(a.id).envelope.error.code, 'sentinel.execution.runDeadline');
    assert.equal(summary.published, 0);
  } finally {
    store.close();
  }
});

test('an unrelated built-in exit 71 remains workerExited and retries within the existing policy', async () => {
  const s = fresh('unrelated-exit71'),
    store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, { A: 'exit71-before-hello' });
    const summary = await (await open(store, p, s)).run();
    assert.equal(summary.outcome, 'execution-failure');
    assert.equal(store.ledger.countAttempts({ id: p.ids.A, revision: 1 }), 3);
    const attempts = store.ledger.listAttempts({ id: p.ids.A, revision: 1 });
    assert.deepEqual(
      attempts.map((a: any) => store.ledger.getAttempt(a.id).envelope.error.code),
      Array(3).fill('sentinel.execution.workerExited'),
    );
    assert.equal(
      summary.failures.some((f: any) => f.code === 'sentinel.execution.closureRefused'),
      false,
    );
  } finally {
    store.close();
  }
});
