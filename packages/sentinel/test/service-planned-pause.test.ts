// A genuine captured/published parent and canonically admitted selected child: no path module or synthetic adapter.
// Record the canonical child's own planned envelope, then exercise direct and held-service setup interleavings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishedReadonly } from './service-readonly-helpers.ts';
import { Coordinator } from '../dist/execution/coordinator.js';
import { publicRegistry, scannerExecution } from '../dist/service/scanner-profile.js';
import { currentPlan, rerunRun, rerunEnvelopeOf } from '../dist/service/canonical.js';
import { confirmForService } from '../dist/service/local.js';
import { loadPlan } from '../dist/execution/plans.js';
const by = Object.freeze({ principal: 'agent' as const, channel: 'local-service' as const });
async function prepared(t: any) {
  const f = await publishedReadonly(t),
    parent = await loadPlan(f.store, f.runId),
    selected = parent.plan.units.find((u) => u.stage === 'check')!;
  assert.ok(parent.plan.units.length > 1, 'a strict selected child');
  const next = await rerunRun(f.store, f.runId, [selected.id], {
    workspace: f.ws.path,
    trustDir: f.ws.trustDir,
    policy: f.policy,
    scratchRoot: f.work,
    now: new Date(),
  });
  assert.ok('disclosure' in next, JSON.stringify(next));
  const runId = next.disclosure.runId,
    run = await rerunEnvelopeOf(f.store, runId);
  assert.ok(run && run.state === 'planned');
  f.store.ledger.createRun(run);
  const plan = (await loadPlan(f.store, runId, 1)).plan;
  return { ...f, runId, plan, before: f.store.ledger.getRun(runId)!.envelope };
}
function unchanged(f: any) {
  const after = f.store.ledger.getRun(f.runId)!.envelope;
  assert.equal(after.createdAt, f.before.createdAt);
  assert.deepEqual(after.budgets, f.before.budgets);
  for (const unit of f.plan.units)
    assert.equal(f.store.ledger.countAttempts({ id: unit.id, revision: unit.revision }), 0, 'no child worker launched');
}
for (const cancel of [false, true])
  test(
    `pending prepared run pause ${cancel ? 'with cancel preserves cancellation precedence' : 'uses legal states and launches no worker'}`,
    { timeout: 60000 },
    async (t) => {
      const f = await prepared(t),
        registry = publicRegistry(f.ws.trustDir),
        assets = await scannerExecution(f.store, f.runId, f.ws.trustDir, f.work, registry);
      const c = await Coordinator.open({ ...assets, store: f.store, runId: f.runId, registry, scratchRoot: f.work });
      c.pause();
      if (cancel) c.cancel();
      const summary = await c.run();
      assert.equal(summary.state, cancel ? 'canceled' : 'paused');
      unchanged(f);
    },
  );
test(
  'public service pause during genuine start setup pauses a planned selected child without a worker',
  { timeout: 60000 },
  async (t) => {
    const f = await prepared(t),
      original = Coordinator.open,
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let opens = 0;
    const gate = t.mock.method(Coordinator, 'open', async function (options: any) {
      assert.equal(options.runId, f.runId);
      opens++;
      entered.resolve();
      await release.promise;
      return original.call(Coordinator, options);
    });
    let start: Promise<any> | undefined;
    try {
      const receipt = async (action: 'run.start' | 'run.pause') => {
        const c = confirmForService(f.ws, {
          command: action,
          action,
          plan: await currentPlan(f.store, f.runId),
          planId: f.runId,
          confirm: true,
          now: new Date(),
          storeId: f.store.storeId,
        });
        assert.ok('receiptId' in c, JSON.stringify(c));
        return c.receiptId;
      };
      start = f.service.handle('run.start', { planId: f.runId, receiptId: await receipt('run.start') }, by);
      await entered.promise;
      const pause: any = await f.service.handle(
        'run.pause',
        { runId: f.runId, receiptId: await receipt('run.pause') },
        by,
      );
      assert.equal(pause.outcome, 'requested');
      release.resolve();
      assert.equal((await start).outcome, 'submitted');
      const waited: any = await f.service.handle('run.wait', { runId: f.runId, timeoutMs: 1000 }, by);
      assert.equal(waited.facts.state, 'paused', JSON.stringify(waited));
      assert.equal(waited.facts.error, undefined);
      assert.equal(opens, 1);
      unchanged(f);
    } finally {
      release.resolve();
      if (start) await start;
      gate.mock.restore();
    }
  },
);
