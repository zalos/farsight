// Genuine accepted ancestor and admitted task through the real Coordinator/Supervisor. Normalizer fault probes
// are test-only malformed values offered to the trusted driver; the genuine accepted invocation stays unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { retainedFixture } from './retained-analysis-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
import { PATHS_APP } from './paths-fixtures.ts';
import { policyView } from './planner-helpers.ts';
import { Coordinator } from '../dist/execution/coordinator.js';
import { loadBootstrap } from '../dist/execution/bootstrap.js';
import { admitPlan, loadPlan } from '../dist/execution/plans.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { executionProfileRecord } from '../dist/execution/profile.js';
import {
  createCapabilityTable,
  planAnalysis,
  plannerSnapshotFrom,
  plannerAnalysisFrom,
  plannerLockFrom,
} from '../dist/planner/index.js';
import { retainedSourceForAdmission } from '../dist/execution/retained-source.js';
import { pathRequestOf } from '../dist/analysis/paths/request.js';
import { boundedPathsAdapter } from '../dist/analysis/paths/driver.js';
import { PATHS_TASK_REPORT_SCHEMA } from '../dist/analysis/paths/definitions.js';
import { readPackDirectory, validatePack, emptyLock, lockDigest } from '../dist/rules/index.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { canonicalJsonBytes } from '../dist/store/objects.js';
import { createHash } from 'node:crypto';
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function task(t: any, canceled = false) {
  const f = await retainedFixture(t, { otherSource: true, extraFiles: PATHS_APP });
  const parent = await Coordinator.open({ store: f.store, runId: f.run.id, registry: f.registry, scratchRoot: f.work });
  if (canceled) parent.cancel();
  assert.equal((await parent.run()).state, canceled ? 'canceled' : 'completed');
  const request = pathRequestOf({
    schema: 'sentinel-path-request/draft-1',
    ancestor: { runId: f.run.id, revision: 2, planDigest: f.analysis.digest },
    snapshotId: f.snapshot.id,
    sourceId: 'app',
    queries: [{ from: 'app::src/routes.ts::getUser', to: 'app::src/db.ts::query' }],
    bounds: { edgeKinds: ['calls'], maxDepth: 12, maxFanout: 256, maxVisited: 50000 },
  });
  const timing = { signal: new AbortController().signal, deadlineAt: performance.now() + 60000 };
  const proof = await retainedSourceForAdmission(
    f.store,
    { ...request.value.ancestor, snapshotId: f.snapshot.id, sourceId: 'app' },
    timing,
  );
  const entryDir = join(f.dir, 'entry');
  mkdirSync(entryDir, { mode: 0o700 });
  const fixed = boundedPathsAdapter({ entryDir });
  const registry = createAdapterRegistry([
    fixed.definition,
    ...(['capture', 'parse', 'inventory'] as const).map((operation) => ({
      id: `retained-${operation}`,
      version: '1',
      kind: 'operation' as const,
      operation,
    })),
  ]);
  const facts = [
    { capability: 'source-bytes', adapterId: 'bounded-paths', evidence: 'shipped structural pack' },
    { capability: 'call-occurrence', adapterId: 'bounded-paths', evidence: 'retained parser', perFileParse: true },
  ];
  const profile = {
    id: 'path-driver-fixture',
    registry,
    capabilities: createCapabilityTable(registry, facts),
    permits: facts.map((f) => f.capability),
    operations: { capture: 'retained-capture', parse: 'retained-parse', inventory: 'retained-inventory' },
  };
  const record = executionProfileRecord(profile as any, f.record.resources, f.record.parse),
    pack = validatePack(readPackDirectory(builtinPackDir('bounded-paths')!)),
    files = readPackDirectory(builtinPackDir('bounded-paths')!);
  const lock = {
    ...emptyLock(new Date()),
    packs: [{ ...pack.entry, promotion: { receipt: `sha256:${'1'.repeat(64)}`, at: '2026-10-22T00:00:00Z' } }],
  };
  const { policy, view } = policyView(['sentinel.paths.call-reachability', 'sentinel.fixture.required-security']);
  const bootstrap = await loadBootstrap(f.store, f.run.id, f.inventory);
  const plan = planAnalysis({
    runId: 'run-real-path',
    bootstrap: [f.inventory],
    profile,
    snapshot: plannerSnapshotFrom(f.snapshot),
    analyses: bootstrap.analyses.map((a) => plannerAnalysisFrom(a)),
    lock: plannerLockFrom(lock as any, [pack], lockDigest(lock as any)),
    policy: view,
    pathRequest: request.value,
  } as any);
  assert.equal(plan.units.length, 1, JSON.stringify({ checks: plan.checks, gaps: plan.ruleGaps }));
  await admitPlan(f.store, {
    plan,
    ruleLock: lock as any,
    policy,
    profile: record,
    pathRequest: { document: request.value, proof, timing },
  });
  const run = {
    ...f.run,
    id: plan.runId,
    parentId: f.run.id,
    planRevision: 1,
    ruleLockDigest: plan.pins.ruleLockDigest,
    toolLockDigest: plan.pins.ruleLockDigest,
    policyRevisionDigest: plan.pins.policyDigest,
    createdAt: new Date().toISOString(),
    requestedScope: { sourceIds: ['app', 'other'], profile: record.id },
  };
  return { ...f, fixed, registry, plan, run, request, pack, files };
}
for (const canceled of [false, true])
  test(
    `real path task accepts structural evidence from its ${canceled ? 'canceled' : 'completed'} ancestor and leaves required security gaps`,
    needsStore,
    async (t) => {
      const f = await task(t, canceled);
      let faultChecks = 0;
      const driver = {
        ...f.fixed.driver,
        async normalize(ctx: any, verified: any) {
          const invalid = (e: any) => e.code === 'sentinel.drivers.contextInvalid';
          for (const changed of [
            { ...verified, job: { ...verified.job, request: `sha256:${'f'.repeat(64)}` } },
            {
              ...verified,
              binding: {
                ...verified.binding,
                derived: { ...verified.binding.derived, job: `sha256:${'f'.repeat(64)}` },
              },
            },
            { ...verified, binding: { ...verified.binding, sourceInputs: [] } },
            { ...verified, binding: { ...verified.binding, influenceManifest: `sha256:${'f'.repeat(64)}` } },
            { ...verified, result: { ...verified.result, attemptId: 'foreign-attempt' } },
          ]) {
            await assert.rejects(f.fixed.driver.normalize(ctx, changed), invalid);
            faultChecks++;
          }
          const original = JSON.parse(Buffer.from(verified.output(verified.outputs[0].id)).toString());
          assert.ok(
            original.evidence.results[0].paths[0].steps.some((s: any) => s.sites.length),
            'citation tamper control has genuine parser sites',
          );
          for (const patch of [
            { request: `sha256:${'f'.repeat(64)}` },
            { actualReadSet: [] },
            { usage: { ...original.usage, reads: -1 } },
            { evidence: { ...original.evidence, sourceId: 'other' } },
            { evidence: { ...original.evidence, graphDigest: `sha256:${'f'.repeat(64)}` } },
            {
              evidence: {
                ...original.evidence,
                results: original.evidence.results.map((r: any) => ({
                  ...r,
                  paths: r.paths.map((p: any) => ({ ...p, steps: p.steps.map((s: any) => ({ ...s, sites: [] })) })),
                })),
              },
            },
          ]) {
            const bytes = canonicalJsonBytes({ ...original, ...patch }),
              id = hash(bytes),
              outputs = [{ ...verified.outputs[0], id, bytes: bytes.length }];
            const graphFault =
              patch.evidence &&
              (patch.evidence.graphDigest !== original.evidence.graphDigest ||
                patch.evidence.results !== original.evidence.results);
            await assert.rejects(
              f.fixed.driver.normalize(ctx, { ...verified, outputs, output: () => bytes }),
              graphFault ? (e: any) => e.code === 'sentinel.paths.unbound' : invalid,
            );
            faultChecks++;
          }
          return f.fixed.driver.normalize(ctx, verified);
        },
      };
      const drivers = createCheckDriverRegistry([driver], f.registry);
      const coordinator = await Coordinator.open({
        store: f.store,
        runId: f.plan.runId,
        run: f.run as any,
        registry: f.registry,
        drivers,
        packs: [{ pack: f.pack, files: f.files }],
        scratchRoot: f.work,
      });
      const done = await coordinator.run();
      assert.equal(done.state, 'completed', JSON.stringify(done.failures));
      assert.equal(done.published, 1, JSON.stringify(done));
      assert.equal(faultChecks, 11);
      const admitted = await loadPlan(f.store, f.plan.runId, 1);
      assert.deepEqual(admitted.pathRequest, f.request.value);
      const unit = f.plan.units[0],
        pub = f.store.ledger.getPublication(unit)!;
      assert.ok(pub);
      const record = pub.outputs.find((o) => o.schema === PATHS_TASK_REPORT_SCHEMA);
      assert.ok(record);
      const report = JSON.parse((await f.store.readArtifact(record.id)).toString());
      assert.equal(report.kind, 'structural-call-reachability');
      assert.equal(report.assessment, 'none');
      assert.equal(report.findings, 0);
      assert.equal(report.evidence.results[0].outcome, 'reached');
      assert.equal(report.request, f.request.id);
      assert.ok(f.plan.ruleGaps.some((g) => g.familyId === 'sentinel.fixture.required-security' && g.required));
      assert.equal(
        pub.outputs.some((o) => o.schema === 'sentinel-driver-finding/draft-1'),
        false,
      );
      const attempt = f.store.ledger.getAttempt(pub.attemptId)!,
        inv = JSON.parse((await f.store.readArtifact(attempt.envelope.invocation!)).toString());
      assert.equal(inv.job, report.job);
    },
  );
