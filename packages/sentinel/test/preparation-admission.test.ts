// Genuine store rows and physically re-hashed bytes. Faults delay real I/O/SQL, never fabricate acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { ObjectStore } from '../dist/store/objects.js';
import { withAdmissionFence, admissionFenceCheckpoint } from '../dist/store/admission-fence.js';
import { boundOwner } from '../dist/store/owner-binding.js';
import { captureWithBudget } from '../dist/snapshot/capture.js';
import { GitReadBudget } from '../dist/snapshot/git.js';
import { admitPlan } from '../dist/execution/plans.js';
import { planBootstrap } from '../dist/planner/index.js';
import { foundationProfile } from '../dist/service/trusted-profile.js';
import { preparationClock, PreparationError } from '../dist/service/preparation-clock.js';
import { needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';
const code = (s: string) => (e: any) => e?.code === s;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (const phase of ['snapshot', 'plan'] as const)
  for (const boundary of ['physical verification', 'last transaction insert'] as const)
    test(`${phase} rolls back acceptance after ${boundary} crosses the ORIGINAL clock`, needsStore, async (t) => {
      const dir = scratch(t),
        { store } = await openCaptureStore(t, dir),
        root = join(dir, 'repo');
      mkdirSync(root);
      writeFileSync(join(root, 'one.ts'), 'export const one=1;');
      const deadlineAt = new Date(Date.now() + 500).toISOString(),
        clock = preparationClock(store, {
          acceptedAt: new Date(Date.parse(deadlineAt) - 600000).toISOString(),
          deadlineAt,
        });
      let delayed = false;
      if (boundary === 'physical verification') {
        const original = ObjectStore.prototype.measureSync;
        t.mock.method(ObjectStore.prototype, 'measureSync', function (this: any, ...args: any[]) {
          const r = (original as any).apply(this, args);
          if (!delayed) {
            delayed = true;
            sleep(750);
          }
          return r;
        });
      } else {
        const original = DatabaseSync.prototype.prepare;
        t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
          const stmt = original.call(this, sql);
          if (sql.includes(`INSERT INTO ${phase === 'snapshot' ? 'snapshots' : 'plans'} `)) {
            const run = stmt.run;
            t.mock.method(stmt, 'run', function (this: any, ...args: any[]) {
              const result = (run as any).apply(this, args);
              delayed = true;
              sleep(750);
              return result;
            });
          }
          return stmt;
        });
      }
      const runId = `run-prep-${phase}-${boundary === 'physical verification' ? 'verify' : 'transaction'}`;
      const call = () =>
        phase === 'snapshot'
          ? captureWithBudget(
              store,
              { mode: 'working-copy', sources: [{ sourceId: 'workspace', repositoryId: 'fixture', root }] },
              new GitReadBudget(),
              () => clock.stillWithin(),
            )
          : admitPlan(
              store,
              {
                plan: planBootstrap({ runId, sourceIds: ['workspace'], profile: foundationProfile().planner }),
                ruleLock: null,
                policy: null,
                profile: foundationProfile().record,
              },
              () => clock.stillWithin(),
            );
      await assert.rejects(call(), code('sentinel.preparation.expired'));
      assert.equal(delayed, true, 'actual physical read or real transaction insertion completed');
      const events = store.ledger.readEvents({ after: 0, limit: 500 }).events;
      assert.equal(events.filter((e) => e.kind === `${phase}-admitted`).length, 0);
      assert.equal(store.ledger.getPlan(runId, 1), undefined);
      assert.equal(store.ledger.listOpenStages().length, 0, 'expiry does not veto cleanup');
      const db = new DatabaseSync(join(store.storePath, 'ledger.sqlite'), { readOnly: true });
      try {
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()!.n,
          0,
          'rolled-back artifact acceptance supplies no committed rows',
        );
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()!.n, 0);
      } finally {
        db.close();
      }
    });
test(
  'admission veto is store/context-bound, nested only tightens and first refusal cannot be swallowed',
  needsStore,
  async (t) => {
    const dir = scratch(t),
      a = await openCaptureStore(t, dir, join(dir, 'a')),
      b = await openCaptureStore(t, dir, join(dir, 'b'));
    const ownerA = boundOwner(a.store),
      ownerB = boundOwner(b.store);
    let checks = 0;
    const error = new PreparationError('sentinel.preparation.canceled');
    assert.throws(
      () =>
        withAdmissionFence(
          { ...a.store },
          () => {},
          () => {},
        ),
      TypeError,
    );
    withAdmissionFence(
      a.store,
      () => {
        checks++;
      },
      () => {
        admissionFenceCheckpoint(ownerB);
        assert.equal(checks, 1);
        withAdmissionFence(
          a.store,
          () => {},
          () => admissionFenceCheckpoint(ownerA),
        );
      },
    );
    assert.throws(
      () =>
        withAdmissionFence(
          a.store,
          () => {},
          () => {
            try {
              withAdmissionFence(
                a.store,
                () => {
                  throw error;
                },
                () => {},
              );
            } catch {}
            a.store.close();
          },
        ),
      (e) => e === error,
    );
    admissionFenceCheckpoint(ownerB);
    b.store.ledger.registerStaging('unrelated-allowed', [
      { id: 'sha256:' + 'a'.repeat(64), schema: 'application/json', privacy: 'metadata' },
    ]);
    b.store.ledger.abortStaging('unrelated-allowed');
  },
);
test('escaping async work cannot reuse a closed synchronous admission fence', needsStore, async (t) => {
  const dir = scratch(t),
    { store } = await openCaptureStore(t, dir),
    owner = boundOwner(store);
  let late!: Promise<void>;
  withAdmissionFence(
    store,
    () => {},
    () => {
      late = Promise.resolve().then(() => admissionFenceCheckpoint(owner));
    },
  );
  await assert.rejects(late, code('sentinel.store.invalidInput'));
});
test(
  'owner loss and cancellation veto before commit, while legacy admission remains unchanged',
  needsStore,
  async (t) => {
    const dir = scratch(t),
      { store } = await openCaptureStore(t, dir);
    const controller = new AbortController(),
      now = Date.now(),
      clock = preparationClock(
        store,
        { acceptedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 600000).toISOString() },
        controller.signal,
      );
    controller.abort();
    assert.throws(
      () =>
        withAdmissionFence(
          store,
          () => clock.stillWithin(),
          () => assert.fail('cannot enter body'),
        ),
      code('sentinel.preparation.canceled'),
    );
    const profile = foundationProfile(),
      plan = planBootstrap({ runId: 'run-legacy-after-veto', sourceIds: ['workspace'], profile: profile.planner });
    assert.equal(
      (await admitPlan(store, { plan, profile: profile.record, ruleLock: null, policy: null })).runId,
      plan.runId,
    );
    store.close();
    assert.throws(
      () =>
        withAdmissionFence(
          store,
          () => {},
          () => {},
        ),
      code('sentinel.store.ownerClosed'),
    );
  },
);

for (const boundary of ['physical verification', 'last transaction insert'] as const)
  test(
    `actual Coordinator bootstrap refuses publication after ${boundary} crosses preparation expiry`,
    needsStore,
    async (t) => {
      const { captureSnapshot } = await import('../dist/snapshot/index.js'),
        { Coordinator } = await import('../dist/execution/coordinator.js');
      const { Ledger } = await import('../dist/store/ledger.js'),
        { withAsyncAdmissionFence } = await import('../dist/store/admission-fence.js');
      const dir = scratch(t),
        { store } = await openCaptureStore(t, dir),
        root = join(dir, 'repo');
      mkdirSync(root);
      writeFileSync(join(root, 'one.ts'), 'export const one=1;');
      const { snapshot } = await captureSnapshot(store, {
          mode: 'working-copy',
          sources: [{ sourceId: 'workspace', repositoryId: 'local-workspace', root }],
        }),
        profile = foundationProfile(),
        runId = `run-prep-boot-${boundary === 'physical verification' ? 'verify' : 'sql'}`;
      const plan = planBootstrap({ runId, sourceIds: ['workspace'], profile: profile.planner });
      await admitPlan(store, { plan, profile: profile.record, ruleLock: null, policy: null });
      const deadlineAt = new Date(Date.now() + 1000).toISOString(),
        acceptedAt = new Date(Date.parse(deadlineAt) - 600000).toISOString(),
        clock = preparationClock(store, { acceptedAt, deadlineAt });
      store.ledger.createRun({
        schema: 'sentinel-run/draft-1',
        id: runId,
        parentId: null,
        baselineId: null,
        snapshotId: snapshot.id,
        planRevision: 1,
        coordinatorEpoch: store.epoch,
        ruleLockDigest: `sha256:${'a'.repeat(64)}`,
        toolLockDigest: `sha256:${'a'.repeat(64)}`,
        policyRevisionDigest: `sha256:${'b'.repeat(64)}`,
        requestedScope: { sourceIds: ['workspace'], profile: profile.planner.id },
        budgets: { maxTokens: null, maxCost: null, deadlineMs: 600000 },
        createdAt: acceptedAt,
        state: 'planned',
      });
      let delayed = false,
        publishing = false;
      const publish = Ledger.prototype.publish;
      t.mock.method(Ledger.prototype, 'publish', function (this: Ledger, ...args: any[]) {
        publishing = true;
        try {
          return (publish as any).apply(this, args);
        } finally {
          publishing = false;
        }
      });
      if (boundary === 'physical verification') {
        const original = ObjectStore.prototype.measureSync;
        t.mock.method(ObjectStore.prototype, 'measureSync', function (this: any, ...args: any[]) {
          const result = (original as any).apply(this, args);
          if (publishing && !delayed) {
            delayed = true;
            sleep(1250);
          }
          return result;
        });
      } else {
        const original = DatabaseSync.prototype.prepare;
        t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
          const stmt = original.call(this, sql);
          if (sql.includes('INSERT INTO publications ')) {
            const run = stmt.run;
            t.mock.method(stmt, 'run', function (this: any, ...args: any[]) {
              const result = (run as any).apply(this, args);
              if (!delayed) {
                delayed = true;
                sleep(1250);
              }
              return result;
            });
          }
          return stmt;
        });
      }
      const scratchRoot = join(store.storePath, 'scratch', 'fixture');
      mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
      await assert.rejects(
        withAsyncAdmissionFence(
          store,
          () => clock.stillWithin(),
          async () => {
            const c = await Coordinator.open({ store, runId, registry: profile.planner.registry, scratchRoot });
            await c.run();
          },
        ),
        code('sentinel.preparation.expired'),
      );
      assert.equal(delayed, true);
      const events = store.ledger.readEvents({ after: 0, limit: 500 }).events;
      assert.equal(events.filter((e) => e.kind === 'work-published').length, 0);
      assert.ok(
        events.some((e) => e.kind === 'attempt-ended'),
        'failure recording is not vetoed',
      );
      assert.equal(store.ledger.listOpenStages().length, 0, 'cleanup remains possible');
      for (const u of plan.units) {
        assert.equal(store.ledger.getPublication({ id: u.id, revision: u.revision }), null);
      }
    },
  );

test(
  'asynchronous preparation fence does not leak into unrelated concurrent operations on the same genuine store',
  needsStore,
  async (t) => {
    const { withAsyncAdmissionFence } = await import('../dist/store/admission-fence.js'),
      dir = scratch(t),
      { store } = await openCaptureStore(t, dir),
      profile = foundationProfile();
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
        release = r;
      }),
      error = new PreparationError('sentinel.preparation.canceled');
    let refuse = false;
    const guarded = withAsyncAdmissionFence(
      store,
      () => {
        if (refuse) throw error;
      },
      async () => {
        await blocked;
        await admitPlan(store, {
          plan: planBootstrap({ runId: 'run-scoped-refused', sourceIds: ['workspace'], profile: profile.planner }),
          profile: profile.record,
          ruleLock: null,
          policy: null,
        });
      },
    );
    refuse = true;
    const unguarded = await admitPlan(store, {
      plan: planBootstrap({ runId: 'run-unrelated-allowed', sourceIds: ['workspace'], profile: profile.planner }),
      profile: profile.record,
      ruleLock: null,
      policy: null,
    });
    assert.equal(unguarded.runId, 'run-unrelated-allowed');
    release();
    await assert.rejects(guarded, (e) => e === error);
    assert.equal(store.ledger.getPlan('run-scoped-refused', 1), undefined);
    assert.equal(store.ledger.listOpenStages().length, 0);
  },
);
