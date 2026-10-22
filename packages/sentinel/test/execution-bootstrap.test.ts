// Capture → parse → canonical plan → execute → resume, end to end with the real modules. A synthetic repository is
// captured into a real store; a bootstrap revision (PR 06 planBootstrap) is admitted and run by the coordinator's own
// capture, parse and inventory operations; an analysis revision is planned (PR 06 planAnalysis) from exactly what
// that bootstrap published, admitted with a promoted rule lock and the effective policy, and executed by a built-in
// check worker; the run is crashed at boundaries in both revisions and resumed by a new owner and coordinator.
// Synthetic fixtures only; nothing is scanned, no network, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { admitPlan, loadPlan } from '../dist/execution/plans.js';
import { executionProfileRecord } from '../dist/execution/profile.js';
import { loadBootstrap } from '../dist/execution/bootstrap.js';
import { createCapabilityTable, plannerAnalysisFrom, plannerSnapshotFrom, planAnalysis, planBootstrap } from '../dist/planner/index.js';
import { commitRepo, needsStore, scratch, unlock } from './snapshot-helpers.ts';
import { storeIn } from './execution-helpers.ts';
import { lockedRules, policyView } from './planner-helpers.ts';
import { publications, PARSE, RESOURCES } from './coordinator-helpers.ts';

const WORKER = fileURLToPath(new URL('./fixtures/workers/hostile-worker.mjs', import.meta.url));
const REPO = {
  'src/util.ts': 'export function run(code: string) {\n  return eval(code);\n}\n',
  'src/app.ts': 'export const app = () => 1;\n',
  'lib/helper.js': 'module.exports = function helper() { return 2; };\n',
};
const RULE = 'sentinel.ts.eval';

function trusted(root: string, bootstrap = true, stage: Record<string, Record<string, number>> = {}) {
  const dir = join(root, 'adapters');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const module = join(dir, 'pattern.mjs');
  writeFileSync(module, `globalThis.SENTINEL_BEHAVIOR = 'covering-ok';\nawait import(${JSON.stringify(new URL(`file://${WORKER}`).href)});\n`);
  const registry = createAdapterRegistry([
    { id: 'sentinel-pattern', version: '1', kind: 'built-in', isolation: 'child', module, coverage: 'per-file-per-rule', limits: { timeoutMs: 15_000, helloTimeoutMs: 5_000, cancelGraceMs: 1_000 } },
    { id: 'sentinel-capture', version: '1', kind: 'operation', operation: 'capture' },
    { id: 'sentinel-parse', version: '1', kind: 'operation', operation: 'parse' },
    { id: 'sentinel-inventory', version: '1', kind: 'operation', operation: 'inventory' },
  ]);
  const capabilities = createCapabilityTable(registry, [
    { capability: 'source-bytes', adapterId: 'sentinel-pattern', evidence: 'synthetic: built-in pattern adapter' },
    { capability: 'pattern-match', adapterId: 'sentinel-pattern', evidence: 'synthetic: built-in pattern adapter' },
  ]);
  const profile = { id: 'profile-local', registry, capabilities, permits: ['source-bytes', 'pattern-match'],
    ...(bootstrap ? { operations: { capture: 'sentinel-capture', parse: 'sentinel-parse', inventory: 'sentinel-inventory' } } : {}) };
  const record = executionProfileRecord(profile as any, { capture: { ...RESOURCES, ...stage.capture }, parse: { ...RESOURCES, ...stage.parse },
    inventory: { ...RESOURCES, ...stage.inventory }, check: RESOURCES } as any, PARSE);
  return { registry, profile, record };
}

async function captured(t: any, dir: string) {
  const repo = join(dir, 'repo');
  commitRepo(repo, REPO);
  const store = await storeIn(dir);
  const { snapshot } = await captureSnapshot(store, { mode: 'committed-tree', sources: [{ sourceId: 'app', repositoryId: 'example/app', root: repo }] });
  // The checkout is gone before anything else: everything after reads only the store.
  unlock(repo);
  rmSync(repo, { recursive: true, force: true });
  return { store, snapshot };
}

const runEnvelope = (snapshotId: string, lockPin: string, policyRevision: string, profileId: string) => ({
  schema: 'sentinel-run/draft-1', id: 'run-boot', parentId: null, baselineId: null, snapshotId, planRevision: 1, coordinatorEpoch: 'epoch-planning',
  ruleLockDigest: lockPin, toolLockDigest: lockPin, policyRevisionDigest: policyRevision, requestedScope: { sourceIds: ['app'], profile: profileId },
  budgets: { maxTokens: null, maxCost: null, deadlineMs: 600_000 }, createdAt: '2026-10-22T00:00:00Z', state: 'planned',
}) as any;

test('capture, parse and inventory publish verified evidence; the analysis is planned from it, executed, and resumed after crashes', needsStore, async t => {
  const dir = scratch(t, 'sentinel-exec-boot-');
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  let { store, snapshot } = await captured(t, dir);
  const { registry, profile, record } = trusted(dir);
  const { lock, pin, pack } = lockedRules([{ familyId: RULE, adapterId: 'sentinel-pattern' }], []);
  const { policy, view: policyFor } = policyView([RULE]);
  void pack;

  // 1. The bootstrap revision, admitted with its profile, and the run that names the captured snapshot.
  const boot = planBootstrap({ runId: 'run-boot', sourceIds: ['app'], profile: profile as any });
  await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
  const run = runEnvelope(snapshot.id, pin, policy.revision, profile.id);

  // 2. Crash while the parse operation runs: the owner is lost just after its attempt is recorded.
  const parseUnit = boot.units.find(u => u.stage === 'parse')!;
  let crashed = false;
  const crash = { at: (b: string, ctx: any) => { if (!crashed && b === 'after-attempt-start' && ctx.work.id === parseUnit.id) { crashed = true; store.close(); } } };
  await (await Coordinator.open({ store, runId: run.id, run, registry, scratchRoot: work, hooks: crash })).run().catch(() => undefined);
  assert.ok(crashed);
  try { store.close(); } catch { /* closed by the crash */ }
  store = await storeIn(dir);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const resumedBoot = await Coordinator.open({ store, runId: run.id, registry, scratchRoot: work });
  assert.equal(resumedBoot.recovery.interrupted.length, 1, 'the parse attempt the crash left running is interrupted');
  const booted = await resumedBoot.run();
  assert.equal(booted.kind, 'bootstrap');
  assert.equal(booted.state, 'running', 'a published bootstrap leaves the run running for its analysis');
  assert.equal(booted.published, boot.units.length, JSON.stringify(booted.failures));
  // Each bootstrap attempt is the coordinator's own operation, naming the operation adapter the plan pinned.
  for (const u of boot.units) {
    const attempts = store.ledger.listAttempts({ id: u.id, revision: 1 });
    const last = store.ledger.getAttempt(attempts.at(-1)!.id)!;
    assert.deepEqual(last.envelope.worker, { kind: 'coordinator-operation', adapterId: u.adapterId, adapterDigest: u.implementationDigest });
    const invocation = JSON.parse((await store.readArtifact(last.envelope.invocation!)).toString('utf8'));
    assert.equal(invocation.operation, u.stage);
    assert.equal(invocation.influenceManifest, store.ledger.getWork({ id: u.id, revision: 1 })!.envelope.influenceManifest);
  }

  // 3. Plan the analysis from exactly what the bootstrap published.
  const inventoryUnit = boot.units.find(u => u.stage === 'inventory')!;
  const evidence = await loadBootstrap(store, run.id, { id: inventoryUnit.id, revision: 1 });
  assert.equal(evidence.snapshot.id, snapshot.id);
  const analysis = planAnalysis({ runId: run.id, revision: 2, previous: boot, bootstrap: [{ id: inventoryUnit.id, revision: 1 }], profile: profile as any,
    snapshot: plannerSnapshotFrom(evidence.snapshot), analyses: evidence.analyses.map(a => plannerAnalysisFrom(a as any)),
    lock: lockedRules([{ familyId: RULE, adapterId: 'sentinel-pattern' }], []).view, policy: policyFor });
  const planned = analysis.checks.filter(c => c.state === 'planned');
  assert.ok(planned.length >= 2, `checks were planned over the captured TypeScript files: ${JSON.stringify(analysis.checks.map(c => [c.scopeId, c.state]))}`);
  await admitPlan(store, { plan: analysis, ruleLock: lock as any, policy, profile: record });
  store.ledger.advanceRunPlan(run.id, 2);
  assert.equal(store.ledger.getRun(run.id)!.planRevision, 2);

  // 4. Execute the analysis; crash after the first check unit's objects are stored, before it publishes.
  const first = analysis.units[0]!;
  crashed = false;
  const crash2 = { at: (b: string, ctx: any) => { if (!crashed && b === 'after-objects' && ctx.work.id === first.id) { crashed = true; store.close(); } } };
  await (await Coordinator.open({ store, runId: run.id, registry, scratchRoot: work, hooks: crash2 })).run().catch(() => undefined);
  assert.ok(crashed);
  try { store.close(); } catch { /* closed */ }
  store = await storeIn(dir);
  const resumed = await Coordinator.open({ store, runId: run.id, registry, scratchRoot: work });
  assert.ok(resumed.recovery.abortedStages.length >= 1, 'the open stage the crash left is aborted');
  const done = await resumed.run();
  assert.equal(done.kind, 'analysis');
  assert.equal(done.state, 'completed', JSON.stringify(done.failures));
  assert.equal(done.published, analysis.units.length);
  // The outcome is PR 06's evaluation of the coverage records alone.
  assert.equal(done.coverage!.requiredComplete, planned.filter(c => c.required).length);
  assert.equal(done.outcome, analysis.requiredCoverageAchievable ? 'complete-coverage' : 'partial-coverage');
  const counts = publications(store, run.id);
  assert.ok([...counts.values()].every(n => n === 1), `each output accepted once: ${JSON.stringify([...counts])}`);
  assert.equal(counts.size, boot.units.length + analysis.units.length, 'nothing lost across both revisions');
  // Everything the run produced is retained: the admitted plans, the evidence, the records.
  const report = await store.inspect();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  // The only prune candidates are what the crashed attempt stored before its publication was aborted and the retry
  // did not store again: its result and one coverage envelope per check (both name the attempt; the scope and
  // limitation records are the same bytes in the retry). Nothing the run relies on is one.
  const prune = await store.planPrune();
  assert.equal(prune.candidates.length, 1 + first.checks.length, 'the aborted attempt\'s own objects wait for collection');
  const kept = new Set(report.reachable);
  for (const r of [1, 2].map(n => store.ledger.getPlan(run.id, n)!)) for (const id of [r.plan, r.profile, r.ruleLock, r.policy]) if (id) assert.ok(kept.has(id));
  for (const u of [...boot.units, ...analysis.units]) for (const o of store.ledger.getPublication({ id: u.id, revision: 1 })!.outputs) assert.ok(kept.has(o.id), `${o.schema} is retained`);
  assert.equal((await loadPlan(store, run.id, 2)).plan.digest, analysis.digest);
  store.close();
});

test('a bootstrap stage with no bound operation is held, never run by a generic worker; the run ends as an execution failure', needsStore, async t => {
  const dir = scratch(t, 'sentinel-exec-boot-unbound-');
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const { store, snapshot } = await captured(t, dir);
  t.after(() => store.close());
  const { registry, profile, record } = trusted(dir, false);
  const { pin } = lockedRules([{ familyId: RULE, adapterId: 'sentinel-pattern' }], []);
  const { policy } = policyView([RULE]);
  const boot = planBootstrap({ runId: 'run-boot', sourceIds: ['app'], profile: profile as any });
  await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
  const summary = await (await Coordinator.open({ store, runId: 'run-boot', run: runEnvelope(snapshot.id, pin, policy.revision, profile.id), registry, scratchRoot: work })).run();
  assert.equal(summary.published, 0);
  assert.equal(summary.state, 'completed');
  assert.equal(summary.outcome, 'execution-failure');
  for (const u of boot.units) assert.deepEqual(store.ledger.listAttempts({ id: u.id, revision: 1 }), [], 'no attempt of any kind');
  const capture = store.ledger.getWork({ id: boot.units[0]!.id, revision: 1 })!;
  assert.deepEqual([capture.state, capture.reason], ['blocked', 'sentinel.plan.operationUnbound']);
});

test('capture refuses a run whose snapshot holds other sources than the plan parses: nothing is published for it', needsStore, async t => {
  const dir = scratch(t, 'sentinel-exec-boot-mismatch-');
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const { store, snapshot } = await captured(t, dir);
  t.after(() => store.close());
  const { registry, profile, record } = trusted(dir);
  const { pin } = lockedRules([{ familyId: RULE, adapterId: 'sentinel-pattern' }], []);
  const { policy } = policyView([RULE]);
  // The plan parses `lib`; the run's snapshot holds only `app`.
  const boot = planBootstrap({ runId: 'run-boot', sourceIds: ['lib'], profile: profile as any });
  await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
  const run = { ...runEnvelope(snapshot.id, pin, policy.revision, profile.id), requestedScope: { sourceIds: ['lib'], profile: profile.id } };
  const summary = await (await Coordinator.open({ store, runId: 'run-boot', run, registry, scratchRoot: work, retry: { maxAttempts: 1 } })).run();
  assert.equal(summary.published, 0);
  assert.equal(summary.outcome, 'execution-failure');
  const capture = boot.units.find(u => u.stage === 'capture')!;
  const [a] = store.ledger.listAttempts({ id: capture.id, revision: 1 });
  assert.equal(store.ledger.getAttempt(a!.id)!.envelope.error?.code, 'sentinel.execution.bootstrapEvidence');
});

for (const [label, parse, code, field] of [
  ['its deadline', { deadlineMs: 1 }, 'sentinel.execution.deadlineExceeded', 'deadlineMs'],
  ['its memory bound', { memoryBytes: 1 }, 'sentinel.execution.resourceExceeded', 'resource'],
] as const) {
  test(`a bootstrap operation is held to ${label}: the attempt fails and nothing of it is published`, needsStore, async t => {
    const dir = scratch(t, 'sentinel-exec-boot-grant-');
    const work = join(dir, 'work');
    mkdirSync(work, { mode: 0o700 });
    const { store, snapshot } = await captured(t, dir);
    t.after(() => store.close());
    const { registry, profile, record } = trusted(dir, true, { parse });
    const { pin } = lockedRules([{ familyId: RULE, adapterId: 'sentinel-pattern' }], []);
    const { policy } = policyView([RULE]);
    const boot = planBootstrap({ runId: 'run-boot', sourceIds: ['app'], profile: profile as any });
    await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
    const summary = await (await Coordinator.open({ store, runId: 'run-boot', run: runEnvelope(snapshot.id, pin, policy.revision, profile.id), registry,
      scratchRoot: work, retry: { maxAttempts: 1 } })).run();
    const parseUnit = boot.units.find(u => u.stage === 'parse')!;
    assert.equal(store.ledger.getPublication({ id: parseUnit.id, revision: 1 }), null, 'the parse published nothing');
    const [a] = store.ledger.listAttempts({ id: parseUnit.id, revision: 1 });
    const ended = store.ledger.getAttempt(a!.id)!;
    assert.equal(ended.state, 'failed');
    assert.equal(ended.envelope.error?.code, code);
    assert.ok(ended.errorDetail && field in ended.errorDetail, JSON.stringify(ended.errorDetail));
    assert.equal(summary.outcome, 'execution-failure');
    assert.deepEqual(store.ledger.listOpenStages(500), [], 'nothing was staged for it');
  });
}

test('a bootstrap operation canceled while it runs publishes nothing, though it finished its work', needsStore, async t => {
  const dir = scratch(t, 'sentinel-exec-boot-cancel-');
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const { store, snapshot } = await captured(t, dir);
  t.after(() => store.close());
  const { registry, profile, record } = trusted(dir);
  const { pin } = lockedRules([{ familyId: RULE, adapterId: 'sentinel-pattern' }], []);
  const { policy } = policyView([RULE]);
  const boot = planBootstrap({ runId: 'run-boot', sourceIds: ['app'], profile: profile as any });
  await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
  const parseUnit = boot.units.find(u => u.stage === 'parse')!;
  let c: any;
  const hooks = { at: (b: string, ctx: any) => { if (b === 'after-attempt-start' && ctx.work.id === parseUnit.id) c.cancel(); } };
  c = await Coordinator.open({ store, runId: 'run-boot', run: runEnvelope(snapshot.id, pin, policy.revision, profile.id), registry, scratchRoot: work, hooks });
  const summary = await c.run();
  assert.equal(summary.state, 'canceled');
  assert.equal(store.ledger.getPublication({ id: parseUnit.id, revision: 1 }), null);
  const [a] = store.ledger.listAttempts({ id: parseUnit.id, revision: 1 });
  assert.equal(store.ledger.getAttempt(a!.id)!.state, 'canceled');
});

test('maxOutputBytes bounds process output, which an operation does not produce: a 1-byte grant does not stop a parse', needsStore, async t => {
  const dir = scratch(t, 'sentinel-exec-boot-output-');
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const { store, snapshot } = await captured(t, dir);
  t.after(() => store.close());
  const { registry, profile, record } = trusted(dir, true, { parse: { maxOutputBytes: 1 } });
  const { pin } = lockedRules([{ familyId: RULE, adapterId: 'sentinel-pattern' }], []);
  const { policy } = policyView([RULE]);
  const boot = planBootstrap({ runId: 'run-boot', sourceIds: ['app'], profile: profile as any });
  await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
  const summary = await (await Coordinator.open({ store, runId: 'run-boot', run: runEnvelope(snapshot.id, pin, policy.revision, profile.id), registry, scratchRoot: work })).run();
  assert.equal(summary.published, boot.units.length, JSON.stringify(summary.failures));
});

/** Hold the analysis artifact's object write for `ms`: the window between the grant check and acceptance. */
async function slowAnalysisWrites(t: any, ms: number) {
  const { bootstrapIo } = await import('../dist/execution/bootstrap.js');
  bootstrapIo.beforeWrite = async (value: any) => { if (value?.analysis?.fingerprint) await new Promise(r => setTimeout(r, ms)); };
  t.after(() => { bootstrapIo.beforeWrite = undefined; });
}

for (const [label, grant, budget, code] of [
  ['the unit deadline', { deadlineMs: 1_000 }, 600_000, 'sentinel.execution.deadlineExceeded'],
  ['the run deadline', {}, 1_000, 'sentinel.execution.runDeadline'],
] as const) {
  test(`${label} passing while a bootstrap operation's objects are written refuses its publication`, needsStore, async t => {
    const dir = scratch(t, 'sentinel-exec-boot-window-');
    const work = join(dir, 'work');
    mkdirSync(work, { mode: 0o700 });
    const { store, snapshot } = await captured(t, dir);
    t.after(() => store.close());
    const { registry, profile, record } = trusted(dir, true, { parse: grant });
    const { pin } = lockedRules([{ familyId: RULE, adapterId: 'sentinel-pattern' }], []);
    const { policy } = policyView([RULE]);
    const boot = planBootstrap({ runId: 'run-boot', sourceIds: ['app'], profile: profile as any });
    await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
    const run = { ...runEnvelope(snapshot.id, pin, policy.revision, profile.id), budgets: { maxTokens: null, maxCost: null, deadlineMs: budget } };
    await slowAnalysisWrites(t, 1_200);
    await (await Coordinator.open({ store, runId: 'run-boot', run, registry, scratchRoot: work, retry: { maxAttempts: 1 } })).run();
    const parseUnit = boot.units.find(u => u.stage === 'parse')!;
    assert.equal(store.ledger.getPublication({ id: parseUnit.id, revision: 1 }), null, 'nothing accepted after the deadline');
    const [a] = store.ledger.listAttempts({ id: parseUnit.id, revision: 1 });
    assert.equal(store.ledger.getAttempt(a!.id)!.envelope.error?.code, code);
    assert.deepEqual(store.ledger.listOpenStages(500), [], 'its stage was aborted');
    assert.equal(store.ledger.getPublication({ id: boot.units.find(u => u.stage === 'inventory')!.id, revision: 1 }), null);
  });
}
