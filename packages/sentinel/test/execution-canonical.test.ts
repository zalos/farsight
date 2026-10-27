// The coordinator over an admitted canonical plan revision: the synthetic diamond end to end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../dist/execution/coordinator.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { publications, syntheticPlan } from './coordinator-helpers.ts';

const roots: string[] = [];
after(() => roots.forEach(removeScratch));

test('an admitted canonical plan runs to completion; coverage comes only from the coverage records', async () => {
  const s = scratch('canonical');
  roots.push(s.root);
  const store = await storeIn(s.root);
  try {
    const { runId, run, registry } = await syntheticPlan(store, s.root, {
      A: 'covering-ok',
      B: 'covering-ok',
      C: 'covering-ok',
      D: 'covering-ok',
    });
    const c = await Coordinator.open({ store, runId, run, registry, scratchRoot: s.work });
    const summary = await c.run();
    assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
    assert.equal(summary.outcome, 'complete-coverage');
    assert.equal(summary.published, 4);
    assert.equal(summary.coverage!.requiredComplete, 4);
    assert.ok([...publications(store, runId).values()].every((n) => n === 1));
    const report = await store.inspect();
    assert.equal(report.ok, true, JSON.stringify(report.errors));
  } finally {
    store.close();
  }
});

test('workers that report no coverage publish, and the run completes with partial coverage', async () => {
  const s = scratch('canonical-partial');
  roots.push(s.root);
  const store = await storeIn(s.root);
  try {
    const { runId, run, registry } = await syntheticPlan(store, s.root);
    const summary = await (await Coordinator.open({ store, runId, run, registry, scratchRoot: s.work })).run();
    assert.equal(summary.outcome, 'partial-coverage', JSON.stringify(summary.failures));
    assert.equal(summary.published, 4);
    assert.equal(summary.coverage!.requiredComplete, 0, 'work alone completes nothing');
    assert.equal(summary.coverageRecords, 4);
  } finally {
    store.close();
  }
});

test("a result finer than its trusted adapter establishes is recorded at the adapter's granularity, so it does not complete a per-file check", async () => {
  const s = scratch('canonical-coarse');
  roots.push(s.root);
  const store = await storeIn(s.root);
  try {
    const { syntheticRegistry, UNITS } = await import('./coordinator-helpers.ts');
    const { createAdapterRegistry } = await import('../dist/execution/registry.js');
    // The same covering worker, registered as an engine that establishes only aggregate coverage.
    const fine = syntheticRegistry(s.root, ['covering-ok']);
    const t = fine.get('test-covering-ok') as any;
    const registry = createAdapterRegistry([
      {
        id: t.id,
        version: t.version,
        kind: 'built-in',
        isolation: 'child',
        module: t.module,
        limits: t.limits,
        coverage: 'aggregate',
      },
    ]);
    const behaviours = Object.fromEntries(UNITS.map((u) => [u, 'covering-ok']));
    const { runId, run } = await syntheticPlan(store, s.root, behaviours, { registry });
    const summary = await (await Coordinator.open({ store, runId, run, registry, scratchRoot: s.work })).run();
    assert.equal(summary.published, 4);
    assert.equal(summary.outcome, 'partial-coverage');
    assert.ok(
      summary.coverage!.checks.every((c) => c.reasonCode === 'sentinel.plan.coverageTooCoarse'),
      JSON.stringify(summary.coverage!.checks),
    );
  } finally {
    store.close();
  }
});

test("a child run reuses its parent's published work over the same snapshot; another snapshot or an unrelated run is refused", async () => {
  const s = scratch('canonical-child');
  roots.push(s.root);
  const store = await storeIn(s.root);
  try {
    const parent = await syntheticPlan(store, s.root);
    assert.equal(
      (
        await (
          await Coordinator.open({
            store,
            runId: parent.runId,
            run: parent.run,
            registry: parent.registry,
            scratchRoot: s.work,
          })
        ).run()
      ).published,
      4,
    );
    // The rerun: a child run over the parent's snapshot whose A depends on the parent's published A.
    const reuse = [{ id: parent.ids.A!, revision: 1 }];
    const child = await syntheticPlan(
      store,
      s.root,
      {},
      { runId: 'run-child', parentId: parent.runId, snapshotId: parent.run.snapshotId, reuse },
    );
    const summary = await (
      await Coordinator.open({
        store,
        runId: child.runId,
        run: child.run,
        registry: child.registry,
        scratchRoot: s.work,
      })
    ).run();
    assert.equal(summary.published, 4, JSON.stringify(summary.failures));
    assert.equal(store.ledger.listAttempts(reuse[0]!).length, 1, 'the reused unit was not run again');
    // The same reuse without the parent link, or over another snapshot, is refused at open.
    const orphan = await syntheticPlan(
      store,
      s.root,
      {},
      { runId: 'run-orphan', snapshotId: parent.run.snapshotId, reuse },
    );
    await assert.rejects(
      Coordinator.open({ store, runId: orphan.runId, run: orphan.run, registry: orphan.registry, scratchRoot: s.work }),
      (e: any) => /not published in this run or in a parent run/.test(e.detail?.reason ?? ''),
    );
    const moved = await syntheticPlan(store, s.root, {}, { runId: 'run-moved', parentId: parent.runId, reuse });
    await assert.rejects(
      Coordinator.open({ store, runId: moved.runId, run: moved.run, registry: moved.registry, scratchRoot: s.work }),
      (e: any) => /not published in this run or in a parent run/.test(e.detail?.reason ?? ''),
    );
  } finally {
    store.close();
  }
});

test('the start says which scopes each input is', async () => {
  const s = scratch('canonical-input-scopes');
  roots.push(s.root);
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root);
    await (
      await Coordinator.open({ store, runId: p.runId, run: p.run, registry: p.registry, scratchRoot: s.work })
    ).run();
    const unit = p.plan.units.find((u: any) => u.id === p.ids.A);
    const [a] = store.ledger.listAttempts({ id: p.ids.A, revision: 1 });
    const record = JSON.parse(
      (await store.readArtifact(store.ledger.getAttempt(a.id).envelope.invocation)).toString('utf8'),
    );
    assert.deepEqual(
      record.assignment.inputScopes,
      unit.inputs.map((i: any) => ({ input: i.content, scopes: [`${i.sourceId}:${i.relativePath}`] })),
    );
  } finally {
    store.close();
  }
});
