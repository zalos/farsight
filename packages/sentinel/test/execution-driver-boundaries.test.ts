// Trusted driver boundaries through a real admitted plan, durable store and isolated child worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Coordinator } from '../dist/execution/coordinator.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { ObjectStore } from '../dist/store/objects.js';
import { scratch, storeIn, removeScratch } from './execution-helpers.ts';
import { syntheticPlan, UNITS } from './coordinator-helpers.ts';

const ALL = Object.fromEntries(UNITS.map((u) => [u, 'covering-ok']));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function setup(t: any, resources = {}, runDeadline = 600000) {
  const s = scratch('driver-boundary');
  t.after(() => removeScratch(s.root));
  const store = await storeIn(s.root);
  t.after(() => store.close());
  const p = await syntheticPlan(store, s.root, ALL, { resources, deadlineMs: runDeadline });
  return { s, store, p };
}
function driver(p: any, over: any = {}) {
  return {
    adapterId: 'test-covering-ok',
    implementationDigest: p.registry.get('test-covering-ok').digest,
    supportedRules: () => p.plan.pins.rules,
    async prepare(ctx: any) {
      return { job: { unit: ctx.unit.id }, auxiliary: [] };
    },
    async normalize(ctx: any, v: any) {
      return {
        coverage: {
          coveredChecks: v.result.coveredChecks,
          scannedSet: v.result.scannedSet,
          skipped: [],
          unresolvedFrontiers: [],
          granularity: 'per-file-per-rule',
        },
        records: [
          {
            value: { schema: 'sentinel-test-driver-record/draft-1', work: ctx.unit.id },
            schema: 'sentinel-test-driver-record/draft-1',
          },
        ],
      };
    },
    ...over,
  };
}
function options(f: any, d: any, extra: any = {}) {
  return {
    store: f.store,
    runId: f.p.runId,
    run: f.p.run,
    registry: f.p.registry,
    scratchRoot: f.s.work,
    retry: { maxAttempts: 1 },
    drivers: createCheckDriverRegistry([d], f.p.registry),
    ...extra,
  };
}
function assertNoScratch(f: any) {
  assert.deepEqual(
    readdirSync(f.s.work).filter((n) => n.startsWith('prep.') || n.startsWith('att-')),
    [],
  );
  assert.deepEqual(f.store.ledger.listOpenStages(500), []);
}
async function assertFailedAttemptKeepsInvocation(f: any) {
  const [row] = f.store.ledger.listAttempts({ id: f.p.ids.A, revision: 1 });
  assert.ok(row);
  const attempt = f.store.ledger.getAttempt(row.id);
  assert.equal(attempt.state, 'failed');
  assert.equal(attempt.envelope.error.code, 'sentinel.execution.deadlineExceeded');
  const invocation = JSON.parse((await f.store.readArtifact(attempt.envelope.invocation)).toString('utf8'));
  assert.equal(invocation.adapter.digest, f.p.registry.get('test-covering-ok').digest);
}

test('elapsed unit deadline aborts the driver signal before a delayed timer notification', async (t) => {
  const f = await setup(t, { deadlineMs: 1000 });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const delayedTimer = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => (ms === 1000 ? delayedTimer.signal : timeout(ms)));
  const monotonicNow = performance.now();
  let elapsed = 0;
  t.mock.method(performance, 'now', () => monotonicNow + elapsed);
  let signal: AbortSignal | undefined;
  let notifications = 0;
  const d = driver(f.p, {
    async prepare(ctx: any) {
      if (ctx.unit.id === f.p.ids.A) {
        signal = ctx.signal;
        signal!.addEventListener(
          'abort',
          () => {
            notifications++;
          },
          { once: true },
        );
        assert.equal(signal!.aborted, false);
        // The clock can pass its boundary before the event loop delivers the timeout event.
        elapsed += 1001;
      }
      return { job: { unit: ctx.unit.id }, auxiliary: [] };
    },
  });
  const summary = await (await Coordinator.open(options(f, d))).run();
  assert.equal(delayedTimer.signal.aborted, false);
  assert.equal(f.store.ledger.getPublication({ id: f.p.ids.A, revision: 1 }), null);
  assert.deepEqual(f.store.ledger.listAttempts({ id: f.p.ids.A, revision: 1 }), []);
  assert.ok(summary.failures.some((e) => e.code === 'sentinel.execution.deadlineExceeded'));
  assert.equal(signal?.aborted, true);
  assert.equal(signal?.reason?.name, 'TimeoutError');
  assert.equal(notifications, 1);
  assertNoScratch(f);
});

for (const canceled of [false, true]) {
  test(
    `elapsed run deadline notifies the driver with delayed timer delivery${canceled ? ', preserving cancellation first' : ''}`,
    { timeout: 10_000 },
    async (t) => {
      const f = await setup(t, {}, 1000);
      const wallNow = Date.parse(f.p.run.createdAt);
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: wallNow });
      let elapsed = 0;
      t.mock.method(Date, 'now', () => wallNow + elapsed);
      let signal: AbortSignal | undefined;
      let notifications = 0;
      let coordinator: Coordinator;
      const d = driver(f.p, {
        async prepare(ctx: any) {
          if (ctx.unit.id === f.p.ids.A) {
            signal = ctx.signal;
            signal!.addEventListener(
              'abort',
              () => {
                notifications++;
              },
              { once: true },
            );
            assert.equal(signal!.aborted, false);
            elapsed = 1001;
            if (canceled) coordinator.cancel();
          }
          return { job: { unit: ctx.unit.id }, auxiliary: [] };
        },
      });
      coordinator = await Coordinator.open(options(f, d));
      const summary = await coordinator.run();
      assert.equal(f.store.ledger.getPublication({ id: f.p.ids.A, revision: 1 }), null);
      assert.deepEqual(f.store.ledger.listAttempts({ id: f.p.ids.A, revision: 1 }), []);
      assert.equal(signal?.aborted, true);
      assert.equal(notifications, 1);
      if (canceled) {
        assert.equal(summary.state, 'canceled');
        assert.ok(summary.failures.some((e) => e.code === 'sentinel.execution.canceled'));
        assert.equal(
          summary.failures.some((e) => e.code === 'sentinel.execution.runDeadline'),
          false,
        );
      } else {
        assert.ok(summary.failures.some((e) => e.code === 'sentinel.execution.runDeadline'));
      }
      assertNoScratch(f);
    },
  );
}

for (const phase of ['prepare', 'normalize'] as const) {
  test(`one unit deadline includes driver ${phase}`, async (t) => {
    const f = await setup(t, { deadlineMs: 1000 });
    const d = driver(f.p);
    const original = d[phase];
    let signal: AbortSignal | undefined;
    d[phase] = async (...args: any[]) => {
      if (args[0].unit.id === f.p.ids.A) {
        signal = args[0].signal;
        await delay(1200);
      }
      return original(...args);
    };
    const summary = await (await Coordinator.open(options(f, d))).run();
    assert.equal(f.store.ledger.getPublication({ id: f.p.ids.A, revision: 1 }), null);
    assert.ok(summary.failures.some((e) => e.code === 'sentinel.execution.deadlineExceeded'));
    assert.equal(signal?.aborted, true);
    if (phase === 'prepare') assert.deepEqual(f.store.ledger.listAttempts({ id: f.p.ids.A, revision: 1 }), []);
    else await assertFailedAttemptKeepsInvocation(f);
    assertNoScratch(f);
  });
}

for (const phase of ['prepare', 'normalize'] as const)
  for (const mode of ['cancel', 'run-deadline', 'throw'] as const) {
    test(`driver ${phase} ${mode} refuses publication and releases its files`, async (t) => {
      const f = await setup(t, {}, mode === 'run-deadline' ? 1000 : 600000);
      const d = driver(f.p);
      const original = d[phase];
      let c: Coordinator;
      let called = false;
      d[phase] = async (...args: any[]) => {
        if (args[0].unit.id === f.p.ids.A) {
          called = true;
          if (mode === 'cancel') c.cancel();
          if (mode === 'throw')
            throw Object.assign(new Error('synthetic driver failure'), { code: 'sentinel.execution.inputMismatch' });
          await delay(mode === 'run-deadline' ? 1200 : 30);
        }
        return original(...args);
      };
      c = await Coordinator.open(options(f, d));
      const summary = await c.run();
      assert.ok(called);
      assert.equal(f.store.ledger.getPublication({ id: f.p.ids.A, revision: 1 }), null);
      assert.equal(summary.state, mode === 'cancel' ? 'canceled' : 'completed');
      assertNoScratch(f);
    });
  }

test('opening rebinds a driver to the actual registry and admitted implementation', async (t) => {
  const f = await setup(t);
  const d = driver(f.p);
  const drivers = createCheckDriverRegistry([d], f.p.registry);
  const a = f.p.registry.get(d.adapterId);
  const registry = createAdapterRegistry([
    {
      id: a.id,
      version: 'different-build',
      kind: a.kind,
      isolation: a.isolation,
      module: a.module,
      coverage: a.coverage,
      limits: a.limits,
    },
  ]);
  const next = await syntheticPlan(f.store, f.s.root, ALL, { runId: 'run-new-build', registry });
  assert.notEqual(registry.get(a.id).digest, d.implementationDigest);
  await assert.rejects(
    Coordinator.open({ store: f.store, runId: next.runId, run: next.run, registry, scratchRoot: f.s.work, drivers }),
    (e: any) => e.code === 'sentinel.execution.planInvalid' && /implementation digest/.test(e.detail.reason),
  );
  assert.deepEqual(f.store.ledger.listAttempts({ id: next.ids.A, revision: 1 }), []);
});

for (const phase of ['invocation', 'result', 'normalized-record'] as const) {
  test(`unit deadline includes durable ${phase} writes`, { timeout: 30_000 }, async (t) => {
    const f = await setup(t, { deadlineMs: 1000 });
    const d = driver(f.p);
    const coordinator = await Coordinator.open(options(f, d));
    // Keep a real watchdog independent of the controlled notification clock below.
    const realTimeout = setTimeout;
    const realClearTimeout = clearTimeout;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = new AbortController();
    t.mock.method(AbortSignal, 'timeout', (ms: number) => (ms === 1000 ? deadline.signal : timeout(ms)));
    let elapsed = 0;
    t.mock.method(performance, 'now', () => elapsed);
    const original = ObjectStore.prototype.putCanonicalJson;
    let reached = false;
    let written = false;
    t.mock.method(ObjectStore.prototype, 'putCanonicalJson', async function (value: any, opts: any) {
      const match =
        phase === 'invocation'
          ? value?.format === 'sentinel-invocation/draft-1'
          : phase === 'result'
            ? value?.type === 'result'
            : value?.schema === 'sentinel-test-driver-record/draft-1';
      const selected = !reached && match;
      if (selected) reached = true;
      const receipt = await original.call(this, value, opts);
      if (selected) {
        written = true;
        // The actual awaited durable write completes across the modeled unit boundary.
        elapsed = 1001;
        deadline.abort();
      }
      return receipt;
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      watchdog = realTimeout(() => {
        t.mock.timers.reset();
        t.mock.restoreAll();
        coordinator.cancel();
        reject(new Error(`durable ${phase} boundary was not reached within the real watchdog`));
      }, 25_000);
    });
    const running = coordinator.run();
    let summary;
    try {
      summary = await Promise.race([running, guard]);
    } catch (error) {
      await running;
      throw error;
    } finally {
      realClearTimeout(watchdog);
    }
    assert.ok(reached, JSON.stringify(summary.failures));
    assert.ok(written, JSON.stringify(summary.failures));
    assert.equal(f.store.ledger.getPublication({ id: f.p.ids.A, revision: 1 }), null);
    assert.ok(summary.failures.some((e) => e.code === 'sentinel.execution.deadlineExceeded'));
    if (phase === 'invocation') assert.deepEqual(f.store.ledger.listAttempts({ id: f.p.ids.A, revision: 1 }), []);
    else await assertFailedAttemptKeepsInvocation(f);
    assertNoScratch(f);
  });
}

test('the worker receives only the budget preparation left, and a timely result still publishes', async (t) => {
  const f = await setup(t, { deadlineMs: 2000 });
  const d = driver(f.p);
  const prepare = d.prepare;
  d.prepare = async (ctx: any) => {
    if (ctx.unit.id === f.p.ids.A) await delay(300);
    return prepare(ctx);
  };
  const summary = await (await Coordinator.open(options(f, d))).run();
  assert.equal(summary.outcome, 'complete-coverage', JSON.stringify(summary.failures));
  const [a] = f.store.ledger.listAttempts({ id: f.p.ids.A, revision: 1 });
  const invocation = JSON.parse(
    (await f.store.readArtifact(f.store.ledger.getAttempt(a.id).envelope.invocation)).toString('utf8'),
  );
  assert.ok(invocation.limits.timeoutMs > 0 && invocation.limits.timeoutMs <= 1700, JSON.stringify(invocation.limits));
  assertNoScratch(f);
});

for (const variant of ['symlink', 'sealed-source'] as const) {
  test(`driver input boundary ${variant}`, async (t) => {
    const f = await setup(t);
    let verified = false;
    const d = driver(f.p, {
      async prepare(ctx: any) {
        const file = join(ctx.workDir, 'config.json');
        writeFileSync(file, 'original configuration');
        if (variant === 'symlink') {
          const link = join(ctx.workDir, 'linked.json');
          symlinkSync(file, link);
          return { job: {}, auxiliary: [{ path: link, role: 'config' }] };
        }
        return { job: {}, auxiliary: [{ path: file, role: 'config' }] };
      },
      async normalize(ctx: any, v: any) {
        for (const i of ctx.inputs) {
          assert.equal('sha256:' + createHash('sha256').update(v.sealed(i.id)).digest('hex'), i.id);
          verified = true;
        }
        return {
          coverage: {
            coveredChecks: v.result.coveredChecks,
            scannedSet: v.result.scannedSet,
            skipped: [],
            unresolvedFrontiers: [],
            granularity: 'per-file-per-rule',
          },
          records: [],
        };
      },
    });
    const summary = await (await Coordinator.open(options(f, d))).run();
    if (variant === 'symlink') {
      assert.equal(summary.published, 0);
      assert.ok(summary.failures.some((e) => e.code === 'sentinel.execution.inputMismatch'));
    } else {
      assert.ok(verified);
      assert.equal(summary.outcome, 'complete-coverage');
    }
    assertNoScratch(f);
  });
}
