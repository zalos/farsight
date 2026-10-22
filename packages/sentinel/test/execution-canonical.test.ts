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
    const { runId, run, registry } = await syntheticPlan(store, s.root, { A: 'covering-ok', B: 'covering-ok', C: 'covering-ok', D: 'covering-ok' });
    const c = await Coordinator.open({ store, runId, run, registry, scratchRoot: s.work });
    const summary = await c.run();
    assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
    assert.equal(summary.outcome, 'complete-coverage');
    assert.equal(summary.published, 4);
    assert.equal(summary.coverage!.requiredComplete, 4);
    assert.ok([...publications(store, runId).values()].every(n => n === 1));
    const report = await store.inspect();
    assert.equal(report.ok, true, JSON.stringify(report.errors));
  } finally { store.close(); }
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
  } finally { store.close(); }
});

test('a result finer than its trusted adapter establishes is recorded at the adapter\'s granularity, so it does not complete a per-file check', async () => {
  const s = scratch('canonical-coarse');
  roots.push(s.root);
  const store = await storeIn(s.root);
  try {
    const { syntheticRegistry, UNITS } = await import('./coordinator-helpers.ts');
    const { createAdapterRegistry } = await import('../dist/execution/registry.js');
    // The same covering worker, registered as an engine that establishes only aggregate coverage.
    const fine = syntheticRegistry(s.root, ['covering-ok']);
    const t = fine.get('test-covering-ok') as any;
    const registry = createAdapterRegistry([{ id: t.id, version: t.version, kind: 'built-in', isolation: 'child', module: t.module, limits: t.limits, coverage: 'aggregate' }]);
    const behaviours = Object.fromEntries(UNITS.map(u => [u, 'covering-ok']));
    const { runId, run } = await syntheticPlan(store, s.root, behaviours, { registry });
    const summary = await (await Coordinator.open({ store, runId, run, registry, scratchRoot: s.work })).run();
    assert.equal(summary.published, 4);
    assert.equal(summary.outcome, 'partial-coverage');
    assert.ok(summary.coverage!.checks.every(c => c.reasonCode === 'sentinel.plan.coverageTooCoarse'), JSON.stringify(summary.coverage!.checks));
  } finally { store.close(); }
});
