// Real canonical planning, bootstrap and same-attempt publication for each available pinned scanner. No target
// code runs; fixtures are original, databases are synthetic/offline, and the checkout is removed before bootstrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { productionDrivers } from '../dist/adapters/drivers/index.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { admitPlan } from '../dist/execution/plans.js';
import { executionProfileRecord } from '../dist/execution/profile.js';
import { loadBootstrap } from '../dist/execution/bootstrap.js';
import {
  createCapabilityTable,
  planBootstrap,
  planAnalysis,
  plannerSnapshotFrom,
  plannerAnalysisFrom,
  plannerLockFrom,
} from '../dist/planner/index.js';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { emptyLock, lockDigest, readPackDirectory, validatePack } from '../dist/rules/index.js';
import { loadChecksBundle } from '../dist/adapters/trivy/index.js';
import { policyView } from './planner-helpers.ts';
import { commitRepo, unlock } from './snapshot-helpers.ts';
import { scratch, removeScratch, storeIn } from './execution-helpers.ts';
import { PARSE, RESOURCES } from './coordinator-helpers.ts';
import { PACKS } from './driver-helpers.ts';
import { syntheticSnapshot } from './osv-helpers.ts';
const D = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const skip =
  process.env.SENTINEL_ISOLATION !== '1' &&
  'pinned container qualification: set SENTINEL_ISOLATION=1 with existing images and checks';
const text = (pack: string, path: string) => readFileSync(join(PACKS, pack, path), 'utf8');
async function drive(
  t: any,
  packName: string,
  adapterId: string,
  layout: Record<string, string>,
  dbs: any[] = [],
  options: any = {},
) {
  const s = scratch('canonical-drivers');
  t.after(() => removeScratch(s.root));
  const store = await storeIn(s.root);
  t.after(() => store.close());
  const repo = join(s.root, 'repo');
  commitRepo(repo, layout);
  const { snapshot } = await captureSnapshot(store, {
    mode: 'committed-tree',
    sources: [{ sourceId: 'app', repositoryId: 'example/app', root: repo }],
  });
  unlock(repo);
  rmSync(repo, { recursive: true, force: true });
  const all = productionDrivers({
    maxAdvisoryAgeMs: 3650 * 86400000,
    databaseRecords: dbs.map((d) => ({ databaseId: d.databaseId, snapshotDigest: d.snapshotDigest, record: d.record })),
  });
  const entry = all.get(adapterId)!;
  const registry = createAdapterRegistry([
    entry.definition,
    ...['capture', 'parse', 'inventory'].map((operation) => ({
      id: `canonical-${operation}`,
      version: '1',
      kind: 'operation' as const,
      operation: operation as any,
    })),
  ]);
  const files = readPackDirectory(join(PACKS, packName));
  const pack = validatePack(files);
  const now = new Date();
  const at = now.toISOString().replace(/Z$/, '000000Z');
  const base = emptyLock(now);
  const lock = {
    ...base,
    revision: 2,
    previous: lockDigest(base),
    packs: [{ ...pack.entry, promotion: { receipt: D('fixture owner receipt'), at } }],
    tools: [
      {
        adapterId,
        version: entry.definition.version,
        artifactDigest: entry.definition.image.split('@')[1],
        platform: 'linux-arm64',
        rights: {
          spdx: 'Apache-2.0',
          origin: 'third-party' as const,
          upstream: { name: adapterId, revision: entry.definition.version },
        },
        promotion: { receipt: D('fixture tool receipt'), at },
      },
    ],
    databases: dbs.map((d) => ({
      databaseId: d.databaseId,
      snapshotDigest: d.snapshotDigest,
      capturedAt: at,
      rights: {
        spdx: 'CC-BY-4.0',
        origin: 'third-party' as const,
        upstream: { name: d.databaseId, revision: 'synthetic' },
      },
      promotion: { receipt: D('fixture database receipt'), at },
    })),
  };
  const pin = lockDigest(lock as any);
  const capabilities = [...new Set(pack.manifest.rules.flatMap((r) => r.requires))];
  const profile = {
    id: 'canonical-driver-fixture',
    registry,
    capabilities: createCapabilityTable(
      registry,
      capabilities.map((capability) => ({
        capability,
        adapterId,
        evidence: 'explicit installed pinned engine and offline fixture assets',
      })),
    ),
    permits: capabilities,
    operations: { capture: 'canonical-capture', parse: 'canonical-parse', inventory: 'canonical-inventory' },
  };
  const record = executionProfileRecord(
    profile as any,
    { capture: RESOURCES, parse: RESOURCES, inventory: RESOURCES, check: RESOURCES } as any,
    PARSE,
  );
  const { policy, view } = policyView(pack.manifest.rules.map((r) => r.familyId));
  const runId = 'run-canonical-driver';
  const boot = planBootstrap({ runId, sourceIds: ['app'], profile: profile as any });
  await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
  const run = {
    schema: 'sentinel-run/draft-1',
    id: runId,
    parentId: null,
    baselineId: null,
    snapshotId: snapshot.id,
    planRevision: 1,
    coordinatorEpoch: store.epoch,
    ruleLockDigest: pin,
    toolLockDigest: pin,
    policyRevisionDigest: policy.revision,
    requestedScope: { sourceIds: ['app'], profile: profile.id },
    budgets: { maxTokens: null, maxCost: null, deadlineMs: 600000 },
    createdAt: now.toISOString(),
    state: 'planned',
  } as any;
  const booted = await (await Coordinator.open({ store, runId, run, registry, scratchRoot: s.work })).run();
  assert.equal(booted.published, boot.units.length, JSON.stringify(booted.failures));
  const inventory = boot.units.find((u) => u.stage === 'inventory')!;
  const evidence = await loadBootstrap(store, runId, { id: inventory.id, revision: inventory.revision });
  const plan = planAnalysis({
    runId,
    revision: 2,
    previous: boot,
    bootstrap: [{ id: inventory.id, revision: inventory.revision }],
    profile: profile as any,
    snapshot: plannerSnapshotFrom(evidence.snapshot),
    analyses: evidence.analyses.map((a) => plannerAnalysisFrom(a as any)),
    lock: plannerLockFrom(lock as any, [pack], pin),
    policy: view,
  });
  assert.ok(plan.units.length > 0, JSON.stringify(plan.checks));
  await admitPlan(store, { plan, ruleLock: lock as any, policy, profile: record });
  store.ledger.advanceRunPlan(runId, 2);
  const drivers = createCheckDriverRegistry([entry.driver], registry);
  const done = await (
    await Coordinator.open({
      store,
      runId,
      registry,
      scratchRoot: s.work,
      drivers,
      packs: [{ pack, files }],
      databases: dbs,
      containers: true,
      ...options,
    })
  ).run();
  assert.equal(done.state, 'completed');
  assert.equal(done.published, plan.units.length, JSON.stringify(done.failures));
  const findings: any[] = [],
    coverage: any[] = [],
    reports: any[] = [];
  for (const unit of plan.units) {
    const pub = store.ledger.getPublication({ id: unit.id, revision: unit.revision })!;
    assert.ok(pub);
    const attempt = store.ledger.getAttempt(pub.attemptId)!;
    assert.equal(attempt.state, 'succeeded');
    for (const output of pub.outputs) {
      const value = JSON.parse((await store.readArtifact(output.id)).toString());
      if (output.schema === 'sentinel-driver-finding/draft-1') {
        assert.equal(value.attemptId, pub.attemptId);
        assert.equal(value.snapshotId, snapshot.id);
        assert.ok(value.assignedChecks.every((c: any) => unit.checks.includes(c.id)));
        findings.push(value);
        assert.equal(output.privacy, 'source-derived');
      }
      if (output.schema === 'sentinel-coverage/draft-1') {
        assert.equal(value.basis.attemptId, pub.attemptId);
        coverage.push(value);
      }
      if (output.schema === 'sentinel-driver-report/draft-1') reports.push(value);
    }
  }
  assert.equal(coverage.length, plan.checks.filter((c) => c.state === 'planned').length);
  assert.equal((await store.inspect()).ok, true);
  return { done, plan, findings, coverage, reports, store };
}

test(
  'canonical Pattern: positive/negative original rules, identical-byte paths, and unreported rule checks',
  { skip },
  async (t) => {
    const files = readPackDirectory(join(PACKS, 'pattern'));
    const pack = validatePack(files);
    const layout: Record<string, string> = {};
    for (const rule of pack.manifest.rules)
      for (const path of [...rule.fixtures.positive, ...rule.fixtures.negative])
        layout[path.replace('fixtures/', '').replace(/\.fixture$/, '')] = Buffer.from(files.get(path)!).toString();
    const duplicate =
      Object.keys(layout).find((p) => p.endsWith('.ts') && p.includes('unsafe')) ??
      Object.keys(layout).find((p) => p.endsWith('.ts'))!;
    layout['copy/' + duplicate] = layout[duplicate]!;
    const r = await drive(t, 'pattern', 'pattern-semgrep', layout);
    assert.ok(r.findings.length > 0);
    assert.ok(r.coverage.some((c) => c.status === 'complete'));
    assert.ok(r.coverage.some((c) => c.status === 'not-run'));
    const positive = new Set(
      pack.manifest.rules.flatMap((rule) =>
        rule.fixtures.positive.map((p) => `${rule.familyId} ${p.replace('fixtures/', '').replace(/\.fixture$/, '')}`),
      ),
    );
    for (const expected of positive)
      assert.ok(
        r.findings.some((f) => `${f.familyId} ${f.relativePath}` === expected),
        expected,
      );
    assert.ok(
      r.findings.every((f) => positive.has(`${f.familyId} ${f.relativePath}`) || f.relativePath.startsWith('copy/')),
    );
  },
);

test(
  'canonical OSV: pinned offline snapshot, vulnerable/clean locks and unread package manifest',
  { skip },
  async (t) => {
    const s = scratch('canonical-osv-db');
    t.after(() => removeScratch(s.root));
    const db = syntheticSnapshot(s.root, 'npm', [1], '2026-10-21T00:00:00.000000000Z');
    const r = await drive(
      t,
      'advisories',
      'advisories-osv',
      {
        'bad/package-lock.json': text('advisories', 'fixtures/vulnerable-package-lock-json.fixture'),
        'good/package-lock.json': text('advisories', 'fixtures/clean-package-lock-json.fixture'),
        'package.json': '{"name":"fixture","dependencies":{"a":"^1.0.0"}}\n',
      },
      [{ databaseId: 'osv:npm', snapshotDigest: db.snapshot.sha256, path: db.path, record: db.snapshot }],
    );
    assert.ok(r.findings.some((f) => f.name === 'sentinel-fixture-alpha'));
    assert.ok(r.findings.every((f) => f.occurrences.every((o: any) => o.relativePath.startsWith('bad/'))));
    assert.ok(r.coverage.some((c) => c.status === 'complete'));
    assert.ok(r.coverage.some((c) => c.status === 'not-run'));
    assert.equal(r.done.outcome, 'partial-coverage');
  },
);

test(
  'canonical Trivy: pinned acquired bundle, positive/negative Dockerfiles and unrecognized YAML',
  { skip },
  async (t) => {
    const dir = process.env.SENTINEL_TRIVY_CHECKS_DIR;
    assert.ok(dir);
    const held = loadChecksBundle(join(dir, 'checks'));
    assert.ok(held);
    const record = JSON.parse(readFileSync(join(dir, 'checks', held.bundle.layer.slice(7) + '.json'), 'utf8'));
    const r = await drive(
      t,
      'infrastructure',
      'iac-trivy',
      {
        'bad/Dockerfile': text('infrastructure', 'fixtures/root-dockerfile.fixture'),
        'good/Dockerfile': text('infrastructure', 'fixtures/hardened-dockerfile.fixture'),
        'notes/settings.yaml': 'name: settings\nitems: [1]\n',
      },
      [{ databaseId: 'trivy-checks', snapshotDigest: held.bundle.layer, path: held.path, record }],
    );
    assert.ok(r.findings.some((f) => f.checkId === 'DS-0002' && f.relativePath === 'bad/Dockerfile'));
    assert.ok(!r.findings.some((f) => f.relativePath === 'good/Dockerfile'));
    assert.ok(r.coverage.some((c) => c.status === 'complete'));
    assert.ok(r.coverage.some((c) => c.status === 'not-run'));
  },
);

test(
  'canonical zizmor: positive/negative workflows remain offline-limited and unaudited YAML stays unknown',
  { skip },
  async (t) => {
    const r = await drive(t, 'ci', 'ci-zizmor', {
      '.github/workflows/bad.yml': text('ci', 'fixtures/injection-workflow-yml.fixture'),
      '.github/workflows/good.yml': text('ci', 'fixtures/hardened-workflow-yml.fixture'),
      '.github/workflows/notes.yml': 'name: notes\nitems: [1]\n',
    });
    assert.ok(r.findings.some((f) => f.primary.relativePath.endsWith('/bad.yml')));
    assert.ok(!r.findings.some((f) => f.primary.relativePath.endsWith('/good.yml')));
    assert.ok(r.coverage.some((c) => c.status === 'partial'));
    assert.ok(r.coverage.some((c) => c.status === 'not-run'));
    assert.ok(!r.coverage.some((c) => c.status === 'complete'));
    assert.equal(r.done.outcome, 'partial-coverage');
  },
);
