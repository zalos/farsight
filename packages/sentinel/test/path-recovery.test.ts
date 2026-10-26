// Real SIGKILL, no thrown-error approximation: accepted path publications survive loss of their coordinator.
// Fixed seams are already present in Coordinator. Only the owned child kills itself; no repeat-until-green loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathOwnerFixture } from './path-owner-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
import { openStore } from '../dist/store/index.js';
import { loadPlan } from '../dist/execution/plans.js';
import { runPlan, previewReport } from '../dist/service/local.js';
for (const boundary of ['after-objects', 'after-publish'])
  test(
    `actual paths coordinator SIGKILL ${boundary} recovers source-removed evidence with exactly one accepted publication`,
    needsStore,
    async (t) => {
      const f = await pathOwnerFixture(t),
        prepared: any = await f.call(true),
        id = prepared.facts.runId;
      const killed = spawnSync(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          '--experimental-strip-types',
          join(import.meta.dirname, 'helpers/path-kill-child.ts'),
          f.ws.storePath,
          f.ws.trustDir,
          id,
          boundary,
        ],
        { encoding: 'utf8', timeout: 120000 },
      );
      assert.equal(killed.error, undefined);
      assert.equal(killed.signal, 'SIGKILL', killed.stderr.slice(0, 1000));
      let store = await openStore(f.ws.storePath);
      const plan = (await loadPlan(store, id, 1)).plan,
        unit = plan.units.find((u) => u.adapterId === 'bounded-paths')!;
      const before = store.ledger.getPublication(unit);
      assert.equal(Boolean(before), boundary === 'after-publish');
      const oldAttempts = store.ledger.countAttempts(unit);
      assert.equal(oldAttempts, 1);
      store.close();
      const resumed: any = await runPlan(f.ws, { planId: id, confirm: true, now: new Date() });
      assert.equal(resumed.facts.state, 'completed', JSON.stringify(resumed));
      store = await openStore(f.ws.storePath);
      try {
        const events = store.ledger.readEvents({ runId: id, limit: 500 }).events;
        assert.equal(events.filter((e) => e.kind === 'work-published').length, 1);
        assert.ok(store.ledger.getPublication(unit));
        assert.equal(store.ledger.countAttempts(unit), boundary === 'after-publish' ? oldAttempts : oldAttempts + 1);
        assert.equal(store.ledger.getWork(unit).state, 'published');
        if (before) assert.deepEqual(store.ledger.getPublication(unit), before);
      } finally {
        store.close();
      }
      const report: any = await previewReport(f.ws, { runId: id, now: new Date() });
      assert.equal(report.structuralPaths.length, 1);
      assert.equal(report.structuralPaths[0].evidence.results[0].outcome, 'reached');
      assert.equal(report.observations.length, 0);
    },
  );

test(
  'real process death after exact path admission before run creation rejoins that retained generation',
  needsStore,
  async (t) => {
    const f = await pathOwnerFixture(t),
      preview: any = await f.call(),
      id = preview.facts.runId;
    const killed = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--experimental-strip-types',
        join(import.meta.dirname, 'helpers/path-admission-kill-child.ts'),
        f.path,
        join(f.dir, 'owner'),
        f.requestFile,
      ],
      { encoding: 'utf8', timeout: 120000 },
    );
    assert.equal(killed.error, undefined);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr.slice(0, 1000));
    let store = await openStore(f.ws.storePath);
    const admitted = await loadPlan(store, id, 1);
    assert.equal(store.ledger.getRun(id), null);
    assert.equal(admitted.pathRequest.ancestor.runId, f.request.ancestor.runId);
    store.close();
    const recovered: any = await f.call(true);
    assert.equal(recovered.outcome, 'kept', JSON.stringify(recovered));
    assert.equal(recovered.facts.runId, id);
    assert.equal(recovered.facts.generation, 0);
    assert.equal(recovered.facts.planDigest, admitted.plan.digest);
    store = await openStore(f.ws.storePath);
    try {
      assert.equal(store.ledger.getRun(id).state, 'planned');
      for (const unit of admitted.plan.units) assert.equal(store.ledger.countAttempts(unit), 0);
    } finally {
      store.close();
    }
    const resumed: any = await runPlan(f.ws, { planId: id, confirm: true, now: new Date() });
    assert.equal(resumed.facts.state, 'completed', JSON.stringify(resumed));
  },
);
