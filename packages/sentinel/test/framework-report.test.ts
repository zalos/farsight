import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { frameworkFixture } from './framework-canonical-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
import { ORDER } from './express-fixtures.ts';
import { fullReport, assessRun, withholdSecretRun } from '../dist/service/full-report.js';
import { scannerReportOf } from '../dist/reports/scanner.js';
import { executeRun } from '../dist/service/canonical.js';
import { publicRegistry } from '../dist/service/scanner-profile.js';
import { frameworkAdapter } from '../dist/service/framework-adapter.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { validateEnvelope } from '../dist/validate.js';
const req = (f: any) => ({
  store: f.store,
  runId: f.runId,
  workspace: f.path,
  trustDir: f.ws.trustDir,
  now: new Date('2026-10-22T00:00:00Z'),
  disclosure: 'shareable' as const,
});

test(
  'genuine inspection is one source-bound section in every format, with no fact findings; replay is read only',
  needsStore,
  async (t) => {
    const f = await frameworkFixture(t, ORDER);
    const r = await fullReport(req(f));
    assert.equal(r.document.findings.length, 0);
    assert.equal(r.document.counts.observations.n, 0);
    assert.equal(r.document.inspections.length, 1);
    const inspection = r.document.inspections[0];
    assert.equal(inspection.assessment, 'none');
    assert.equal(inspection.extent, 3);
    assert.equal(inspection.rows.length, 9);
    assert.equal(r.document.counts.controlAnswers.n, 9);
    assert.equal(
      r.document.counts.controlAnswers.breakdown.reduce((n: any, p: any) => n + p.n, 0),
      9,
    );
    assert.ok(r.document.gaps.length > 0);
    assert.match(r.markdown, /Framework control inspection/);
    assert.match(r.html, /Framework control inspection/);
    assert.deepEqual(r.sarif.runs[0].properties.inspections, r.document.inspections);
    assert.equal(r.sarif.runs[0].results.length, 0);
    const minimal = await scannerReportOf(f.store, f.runId, req(f).now, { trustDir: f.ws.trustDir });
    assert.deepEqual(minimal.inspections, r.document.inspections);
    assert.equal(minimal.reports.length, 0);
    rmSync(join(f.path, 'src'), { recursive: true, force: true });
    const after = await fullReport(req(f));
    assert.equal(after.json, r.json);
    assert.equal(after.document.ledgerSequence, r.document.ledgerSequence);
    const withheld = withholdSecretRun(r.document, new Map());
    assert.equal(validateEnvelope('report', withheld).ok, true);
    assert.equal(withheld.inspections[0].assessment, 'none');
    for (const row of withheld.inspections[0].rows) assert.match(row.surfaceId, /^withheld-/);
  },
);

for (const mode of [
  'missing',
  'duplicate',
  'finding',
  'wrong-analysis',
  'wrong-source',
  'wrong-row',
  'wrong-check',
  'wrong-coverage',
] as const)
  test(`genuine accepted inspection with ${mode} normalized report refuses`, needsStore, async (t) => {
    const f = await frameworkFixture(t, ORDER, { run: false });
    const registry = publicRegistry(f.ws.trustDir),
      base = frameworkAdapter(f.ws.trustDir).driver;
    const drivers = createCheckDriverRegistry(
      [
        {
          ...base,
          async normalize(ctx: any, v: any) {
            const n = await base.normalize(ctx, v);
            return {
              ...n,
              ...(mode === 'wrong-coverage'
                ? { coverage: { ...n.coverage, skipped: [], unresolvedFrontiers: [] } }
                : {}),
              records: n.records.flatMap((r: any) => {
                if (r.schema !== 'sentinel-driver-report/draft-1') return [r];
                const value = structuredClone(r.value);
                if (mode === 'missing') return [];
                if (mode === 'duplicate') return [r, { ...r, value: { ...value, extra: true } }];
                if (mode === 'finding')
                  return [
                    r,
                    {
                      schema: 'sentinel-driver-finding/draft-1',
                      privacy: 'source-derived',
                      value: { kind: 'invented' },
                    },
                  ];
                if (mode === 'wrong-analysis') value.analysis.index = value.analysis.artifact;
                if (mode === 'wrong-source') value.sourceId = 'other-source';
                if (mode === 'wrong-row') value.inspected[0].surfaceId = 'other-source::route';
                if (mode === 'wrong-check') value.checks[0].state = 'complete';
                return [{ ...r, value }];
              }),
            };
          },
        },
      ],
      registry,
    );
    const done = await executeRun(f.store, f.runId, {
      scratchRoot: f.work,
      trustDir: f.ws.trustDir,
      registry,
      drivers,
    });
    assert.equal(done.state, 'completed', JSON.stringify(done));
    await assert.rejects(fullReport(req(f)), (e: any) => e.code === 'sentinel.report.evidenceUnbound');
  });

test('missing accepted raw inspection bytes refuses rather than becoming an empty section', needsStore, async (t) => {
  const f = await frameworkFixture(t, ORDER);
  const pub = f.store.ledger.getPublication(f.admitted.plan.units[0]);
  const output = pub.outputs.find((o: any) => o.schema === 'application/vnd.sentinel.framework-controls+json');
  assert.ok(output);
  const hex = output.id.slice(7),
    dir = join(f.store.storePath, 'objects/sha256', hex.slice(0, 2));
  for (const name of readdirSync(dir).filter((n) => n.startsWith(hex + '.'))) unlinkSync(join(dir, name));
  await assert.rejects(
    assessRun(f.store, f.runId, { trustDir: f.ws.trustDir }),
    (e: any) => e.code === 'sentinel.report.evidenceUnbound',
  );
});

test(
  'unrecognized source retains partial required inspection even over an empty parser extent',
  needsStore,
  async (t) => {
    const f = await frameworkFixture(t, { 'src/example.ts': 'export const answer=42;\n' });
    const r = await fullReport(req(f));
    assert.equal(r.document.inspections[0].recognised, false);
    assert.equal(r.document.inspections[0].extent, 0);
    assert.equal(r.document.counts.controlAnswers.n, 0);
    assert.ok(r.document.gaps.length >= 3);
    assert.ok(r.document.inspections[0].checks.every((c) => c.state === 'partial'));
    assert.equal(r.document.completeness, 'partial');
  },
);

test(
  'two genuine captured sources keep original analysis identities and independent inspection extents after removal',
  needsStore,
  async (t) => {
    const f = await frameworkFixture(t, ORDER, { run: false });
    const { commitRepo, unlock } = await import('./snapshot-helpers.ts');
    const alpha = join(f.dir, 'alpha');
    commitRepo(alpha, ORDER);
    const other = join(f.dir, 'neighbor');
    commitRepo(other, { ...ORDER, 'src/app.ts': ORDER['src/app.ts'].replace('/reports', '/neighbor') });
    const { captureSnapshot } = await import('../dist/snapshot/index.js');
    const { RuleLockBook } = await import('../dist/service/rule-locks.js');
    const { publicAvailability, publicProfile } = await import('../dist/service/scanner-profile.js');
    const {
      planBootstrap,
      planAnalysis,
      plannerSnapshotFrom,
      plannerAnalysisFrom,
      plannerLockFrom,
      plannerPolicyFrom,
    } = await import('../dist/planner/index.js');
    const { admitPlan } = await import('../dist/execution/plans.js');
    const { Coordinator } = await import('../dist/execution/coordinator.js');
    const { loadBootstrap } = await import('../dist/execution/bootstrap.js');
    const { snapshot } = await captureSnapshot(f.store, {
      mode: 'committed-tree',
      sources: [
        { sourceId: 'alpha', repositoryId: 'example/alpha', root: alpha },
        { sourceId: 'beta', repositoryId: 'example/beta', root: other },
      ],
    });
    for (const path of [alpha, other]) {
      unlock(path);
      rmSync(path, { recursive: true, force: true });
    }
    const book = new RuleLockBook(f.ws.trustDir),
      current = book.current();
    assert.ok(current);
    const packs = book.packsOf(current.lock),
      registry = publicRegistry(f.ws.trustDir);
    const available = await publicAvailability(f.ws.trustDir, current.lock, packs, [], f.work),
      profile = publicProfile(registry, available, packs);
    const runId = 'run-two-framework-sources',
      boot = planBootstrap({ runId, sourceIds: ['alpha', 'beta'], profile: profile.planner });
    await admitPlan(f.store, { plan: boot, ruleLock: null, policy: null, profile: profile.record });
    const run: any = {
      schema: 'sentinel-run/draft-1',
      id: runId,
      parentId: null,
      baselineId: null,
      snapshotId: snapshot.id,
      planRevision: 1,
      coordinatorEpoch: f.store.epoch,
      ruleLockDigest: current.digest,
      toolLockDigest: current.digest,
      policyRevisionDigest: f.terms.policy.revision,
      requestedScope: { sourceIds: ['alpha', 'beta'], profile: profile.planner.id },
      budgets: { maxTokens: null, maxCost: null, deadlineMs: 600000 },
      createdAt: new Date().toISOString(),
      state: 'planned',
    };
    const booted = await (await Coordinator.open({ store: f.store, runId, run, registry, scratchRoot: f.work })).run();
    assert.equal(booted.published, boot.units.length, JSON.stringify(booted));
    const inventory = boot.units.find((u) => u.stage === 'inventory');
    const evidence = await loadBootstrap(f.store, runId, inventory);
    const plan = planAnalysis({
      runId,
      revision: 2,
      previous: boot,
      bootstrap: [inventory],
      profile: profile.planner,
      snapshot: plannerSnapshotFrom(snapshot),
      analyses: evidence.analyses.map((a) => plannerAnalysisFrom(a)),
      lock: plannerLockFrom(current.lock, packs, current.digest),
      policy: plannerPolicyFrom(f.terms.policy),
    });
    await admitPlan(f.store, { plan, ruleLock: current.lock, policy: f.terms.policy, profile: profile.record });
    f.store.ledger.advanceRunPlan(runId, 2);
    const done = await executeRun(f.store, runId, { scratchRoot: f.work, trustDir: f.ws.trustDir });
    assert.equal(done.state, 'completed', JSON.stringify(done));
    assert.equal(done.published, 2);
    const report = await fullReport({ ...req(f), runId });
    assert.equal(report.document.inspections.length, 2);
    for (const section of report.document.inspections) {
      const original = evidence.record.analyses.find((a) => a.sourceId === section.sourceId);
      assert.deepEqual(section.analysis, {
        result: original.result,
        index: original.index,
        artifact: original.artifact,
        manifest: evidence.record.manifest,
      });
      assert.equal(section.extent, 3);
      assert.equal(section.rows.length, 9);
      assert.ok(section.rows.every((r) => r.surfaceId.startsWith(section.sourceId + '::')));
      const otherSource = section.sourceId === 'alpha' ? 'beta' : 'alpha';
      assert.equal(JSON.stringify(section).includes(otherSource + '::'), false);
    }
    assert.equal(report.document.counts.controlAnswers.n, 18);
    assert.equal(report.document.findings.length, 0);
  },
);
