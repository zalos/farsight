// Actual owner promotion, capture, parse operation and framework worker; the optional index fault is injected at the
// trusted bootstrap producer BEFORE hashing/publication. No successful capability, receipt or publication is forged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { frameworkFixture } from './framework-canonical-helpers.ts';
import { ORDER } from './express-fixtures.ts';
import { commitRepo, unlock, needsStore } from './snapshot-helpers.ts';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { RuleLockBook } from '../dist/service/rule-locks.js';
import { publicRegistry, publicAvailability, publicProfile } from '../dist/service/scanner-profile.js';
import {
  planBootstrap,
  planAnalysis,
  plannerSnapshotFrom,
  plannerAnalysisFrom,
  plannerLockFrom,
  plannerPolicyFrom,
} from '../dist/planner/index.js';
import { admitPlan } from '../dist/execution/plans.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { bootstrapIo, loadBootstrap } from '../dist/execution/bootstrap.js';
import { executeRun } from '../dist/service/canonical.js';
import { fullReport } from '../dist/service/full-report.js';
import { md } from '../dist/reports/markdown.js';
import { inspectionText } from '../dist/reports/inspection.js';
import { STRINGS } from '@farsight/core/dist/strings.js';

async function captured(t: any, mode: 'empty' | 'outside' | 'positive') {
  const f = await frameworkFixture(t, ORDER, { run: false }),
    repo = join(f.dir, 'captured-app');
  commitRepo(repo, {
    'package.json': JSON.stringify({
      name: 'original-completeness-example',
      private: true,
      dependencies: { express: '4.21.2' },
    }),
    'src/app.ts':
      mode === 'empty'
        ? 'export const originalExample=42;\n'
        : "import express from 'express';const app=express();app.get('/visible',(_req,res)=>res.send('example'));app.get('/hidden',(_req,res)=>res.send('example'));app.listen(3000);\n",
  });
  const { snapshot } = await captureSnapshot(f.store, {
    mode: 'committed-tree',
    sources: [{ sourceId: 'app', repositoryId: 'example/completeness', root: repo }],
  });
  unlock(repo);
  rmSync(repo, { recursive: true, force: true });
  const book = new RuleLockBook(f.ws.trustDir),
    current = book.current();
  assert.ok(current);
  const packs = book.packsOf(current.lock),
    registry = publicRegistry(f.ws.trustDir);
  const profile = publicProfile(
      registry,
      await publicAvailability(f.ws.trustDir, current.lock, packs, [], f.work),
      packs,
    ),
    runId = 'run-' + mode;
  const boot = planBootstrap({ runId, sourceIds: ['app'], profile: profile.planner });
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
    requestedScope: { sourceIds: ['app'], profile: profile.planner.id },
    budgets: { maxTokens: null, maxCost: null, deadlineMs: 600000 },
    createdAt: new Date().toISOString(),
    state: 'planned',
  };
  const previous = bootstrapIo.beforePrepare;
  let hidden: string | undefined;
  if (mode === 'outside')
    bootstrapIo.beforePrepare = (items) => {
      const index = items.find((i) => i.schema === 'sentinel-parser-index/draft-1'),
        result = items.find((i) => i.schema === 'sentinel-parser-result/draft-1');
      if (!index) return;
      index.value = structuredClone(index.value);
      result.value = structuredClone(result.value);
      for (const n of (index.value as any).nodes)
        if (n.kind === 'route' && n.nodeId.includes('/hidden')) {
          n.kind = 'function';
          hidden = n.nodeId;
        }
      (result.value as any).index = f.store.objects.identifyCanonicalJson(index.value).id;
      result.links = [(result.value as any).artifact, (result.value as any).index];
    };
  try {
    const done = await (await Coordinator.open({ store: f.store, runId, run, registry, scratchRoot: f.work })).run();
    assert.equal(done.published, boot.units.length, JSON.stringify(done));
  } finally {
    bootstrapIo.beforePrepare = previous;
  }
  const inventory = boot.units.find((u) => u.stage === 'inventory')!,
    evidence = await loadBootstrap(f.store, runId, inventory);
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
  const unit = plan.units[0]!,
    pub = f.store.ledger.getPublication(unit)!;
  const read = async (schema: string) =>
    JSON.parse((await f.store.readArtifact(pub.outputs.find((o) => o.schema === schema)!.id)).toString());
  const driver = await read('sentinel-driver-report/draft-1'),
    raw = await read('application/vnd.sentinel.framework-controls+json');
  const report = await fullReport({
    store: f.store,
    runId,
    workspace: f.path,
    trustDir: f.ws.trustDir,
    now: new Date(),
    disclosure: 'shareable',
  });
  return { driver, raw, report, hidden };
}

test(
  'recognised framework with zero indexed surfaces is partial in actual driver and accepted report',
  needsStore,
  async (t) => {
    const f = await captured(t, 'empty');
    assert.equal(f.driver.recognised, true);
    assert.equal(f.driver.extent, 0);
    for (const c of f.driver.checks) {
      assert.equal(c.state, 'partial');
      assert.ok(c.reasons.includes('sentinel.controls.surfaceExtentUnproven'));
    }
    assert.deepEqual(f.report.document.inspections[0].checks, f.driver.checks);
    assert.equal(f.report.document.counts.controlAnswers.n, 0);
    assert.equal(f.report.document.findings.length, 0);
  },
);
test(
  'indexed non-surface control facts leave a bounded explicit partial reason in driver and report',
  needsStore,
  async (t) => {
    const f = await captured(t, 'outside');
    assert.ok(f.hidden);
    assert.ok(f.raw.libraries.some((l) => l.envelopes.some((e) => e.facts.some((x) => x.surfaceId === f.hidden))));
    assert.equal(f.driver.extent, 1);
    for (const c of f.driver.checks) {
      assert.equal(c.state, 'partial');
      assert.ok(c.reasons.includes('sentinel.controls.surfaceOutsideExtent'));
    }
    assert.deepEqual(f.report.document.inspections[0].checks, f.driver.checks);
    assert.equal(
      f.driver.inspected.some((r) => r.surfaceId === f.hidden),
      false,
    );
    assert.equal(f.report.document.findings.length, 0);
  },
);
test('a genuine full nonempty indexed extent still establishes supported control answers', needsStore, async (t) => {
  const f = await captured(t, 'positive');
  assert.equal(f.driver.extent, 2);
  for (const family of ['authentication', 'authorization']) {
    const c = f.driver.checks.find((c) => c.familyId === 'sentinel.controls.' + family);
    assert.equal(c.state, 'complete');
    assert.deepEqual(c.reasons, []);
  }
  assert.ok(
    f.report.document.inspections[0].rows
      .filter((r) => r.property !== 'input-validation')
      .every((r) => r.state === 'established'),
  );
  assert.ok(f.report.document.definitions.some((d) => d.key === 'sentinel.controls.versionItem'));
  assert.ok(f.report.html.includes('express 4.21.2'));
  assert.ok(f.report.markdown.includes(md('express 4.21.2')));
  assert.ok(
    inspectionText(f.report.document).some((i) => i.lines.some((l) => l.includes('modeled versions express 4.21.2'))),
  );
});
const rendered = (change: any) =>
  inspectionText({
    definitions: Object.entries(STRINGS).map(([key, v]) => ({
      key,
      text: { business: v.professional, code: v.hud },
      define: v.define,
    })),
    inspections: [
      {
        sourceId: 'app',
        limitationKey: 'sentinel.controls.limitation.inspectionOnly',
        libraries: [],
        checks: [],
        rows: [],
        frontiers: [],
        ...change,
      },
    ],
  } as any)[0].lines;
for (const [field, change, literal] of [
  [
    'surface',
    {
      rows: [
        {
          surfaceId: 'app::route::GET /{property}/{reason}',
          property: 'authentication',
          state: 'established',
          verdict: 'applies',
          reasonCode: null,
        },
      ],
    },
    'app::route::GET /{property}/{reason}',
  ],
  [
    'check',
    { checks: [{ familyId: 'example.{state}.{reasons}', state: 'partial', reasons: ['sentinel.controls.conflict'] }] },
    'example.{state}.{reasons}',
  ],
  ['frontier', { frontiers: [{ scopeId: 'app:{reason}', reasonCode: 'sentinel.controls.conflict' }] }, 'app:{reason}'],
] as const)
  test('inspection rendering preserves literal source placeholders in ' + field, () => {
    assert.ok(rendered(change).some((l) => l.includes(literal)));
  });
test('modeled versions are readable catalog items, while unresolved versions stay explicit', () => {
  const lines = rendered({
    libraries: [
      { framework: 'express', versions: ['4.21.2'], supportedScope: { versions: { express: '4.21.2' } } },
      { framework: 'next', versions: [null], supportedScope: { versions: { next: '14.2.25', react: '18.3.1' } } },
    ],
  });
  assert.ok(lines.some((l) => l.includes('express 4.21.2')));
  assert.ok(lines.some((l) => l.includes('next 14.2.25; react 18.3.1')));
  assert.ok(lines.some((l) => l.includes('resolved versions unresolved')));
  assert.ok(lines.every((l) => !l.includes('{"')));
});
