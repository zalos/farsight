// Review follow-up: actual owner admission/lifecycle against retained plans, with a deterministic private clock.
// No runtime deadline reset, sleep, worker replacement or changes to the generic pending-pause block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathOwnerFixture } from './path-owner-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
import { openStore } from '../dist/store/index.js';
import { loadPlan } from '../dist/execution/plans.js';
import { runPlan, followWorkspaceRun, adoptWorkspaceSettings } from '../dist/service/local.js';

test(
  'a genuine late owner run.start preserves the planned path admission deadline and holds work with runDeadline before any attempt',
  needsStore,
  async (t) => {
    const f = await pathOwnerFixture(t),
      prepared: any = await f.call(true),
      id = prepared.facts.runId;
    let store = await openStore(f.ws.storePath);
    const original = store.ledger.getRun(id).envelope,
      plan = (await loadPlan(store, id, 1)).plan,
      expires = Date.parse(original.createdAt) + original.budgets.deadlineMs;
    store.close();
    const clock = t.mock.method(Date, 'now', () => expires + 1);
    let result: any;
    try {
      result = await runPlan(f.ws, { planId: id, confirm: true, now: new Date() });
    } finally {
      clock.mock.restore();
    }
    assert.equal(result.exitCode, 3, JSON.stringify(result));
    assert.equal(result.reasonCode, 'sentinel.service.executionFailed');
    assert.equal(result.facts.runOutcome, 'execution-failure');
    store = await openStore(f.ws.storePath);
    try {
      const after = store.ledger.getRun(id).envelope;
      assert.equal(after.createdAt, original.createdAt);
      assert.deepEqual(after.budgets, original.budgets);
      const events = store.ledger.readEvents({ runId: id, limit: 500 }).events;
      assert.equal(
        events.some((e) => ['attempt-started', 'work-published', 'staging-registered'].includes(e.kind)),
        false,
      );
      for (const unit of plan.units) {
        assert.equal(store.ledger.countAttempts(unit), 0);
        assert.equal(store.ledger.getPublication(unit), null);
        assert.equal(store.ledger.getWork(unit).state, 'blocked');
        assert.ok(
          events.some(
            (e) =>
              e.kind === 'work-state' &&
              e.work?.id === unit.id &&
              e.payload.reason === 'sentinel.execution.runDeadline',
          ),
        );
      }
    } finally {
      store.close();
    }
  },
);

for (const mode of ['retry', 'rerun'] as const)
  test(
    `ordinary request-pin-absent ${mode} waits or refuses under current policy with no task records despite owner reopening`,
    needsStore,
    async (t) => {
      const f = await pathOwnerFixture(t),
        id = f.parent.disclosure.runId;
      let store = await openStore(f.ws.storePath);
      assert.equal((await loadPlan(store, id, f.parent.disclosure.revision)).pathRequest, undefined);
      let sequence = store.ledger.currentSequence();
      store.close();
      const waiting: any = await followWorkspaceRun(f.ws, { mode, runId: id, confirm: false, now: new Date() });
      assert.equal(waiting.exitCode, 4, JSON.stringify(waiting));
      store = await openStore(f.ws.storePath);
      assert.deepEqual(
        store.ledger.readEvents({ after: sequence, limit: 500 }).events.map((e) => e.kind),
        ['epoch-opened', 'epoch-opened'],
        'only operation and verification owner epochs; no plan/run/work/stage/attempt',
      );
      store.close();
      writeFileSync(
        f.settings,
        JSON.stringify({
          ...f.value,
          grants: f.value.grants.filter((g: any) => !g.actions.includes('capture.source')),
        }),
      );
      assert.equal(adoptWorkspaceSettings(f.ws, { confirm: true, now: new Date() }).outcome, 'prepared');
      store = await openStore(f.ws.storePath);
      sequence = store.ledger.currentSequence();
      store.close();
      const denied: any = await followWorkspaceRun(f.ws, { mode, runId: id, confirm: true, now: new Date() });
      assert.equal(denied.reasonCode, 'sentinel.admission.noGrant', JSON.stringify(denied));
      store = await openStore(f.ws.storePath);
      try {
        assert.deepEqual(
          store.ledger.readEvents({ after: sequence, limit: 500 }).events.map((e) => e.kind),
          ['epoch-opened'],
          'only verification owner epoch; denied preflight opened no store or task',
        );
      } finally {
        store.close();
      }
    },
  );
