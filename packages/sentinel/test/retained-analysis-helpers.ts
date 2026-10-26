// Real capture, parser, bootstrap and admitted canonical plan. Faults alter a coordinator-produced document BEFORE
// identification, so the real store still hashes it and the real coordinator publishes it through its actual
// operation attempt. No accepted publication, receipt, owner capability or worker result is manufactured here.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { bootstrapIo, loadBootstrap } from '../dist/execution/bootstrap.js';
import { admitPlan } from '../dist/execution/plans.js';
import { executionProfileRecord } from '../dist/execution/profile.js';
import {
  createCapabilityTable,
  plannerAnalysisFrom,
  plannerSnapshotFrom,
  plannerLockFrom,
  planAnalysis,
  planBootstrap,
} from '../dist/planner/index.js';
import { lockDigest } from '../dist/rules/index.js';
import { commitRepo, scratch, unlock } from './snapshot-helpers.ts';
import { storeIn } from './execution-helpers.ts';
import { lockedRules, policyView } from './planner-helpers.ts';
import { PARSE, RESOURCES } from './coordinator-helpers.ts';

export async function retainedFixture(
  t: any,
  options: {
    fault?: (value: any, snapshot: any) => void;
    scope?: 'source-file' | 'repository';
    incomplete?: boolean;
    items?: (items: any[]) => void;
    bootstrap?: 'none' | 'parse' | 'two';
    otherSource?: boolean;
    extraFiles?: Record<string, string>;
  } = {},
) {
  const dir = scratch(t, 'sentinel-retained-'),
    work = join(dir, 'work'),
    repo = join(dir, 'repo');
  mkdirSync(work, { mode: 0o700 });
  commitRepo(repo, {
    'src/app.ts': 'export const app = (code: string) => eval(code);\n',
    'src/other.ts': 'export const other = 1;\n',
    'package.json': '{"name":"original-retained-fixture","private":true}\n',
    ...options.extraFiles,
  });
  const store = await storeIn(dir);
  t.after(() => {
    if (store.held) store.close();
  });
  const sources = [{ sourceId: 'app', repositoryId: 'example/retained-fixture', root: repo }];
  const otherRepo = join(dir, 'other-repo');
  if (options.otherSource) {
    commitRepo(otherRepo, {
      'src/neighbor.ts': 'export const neighbor = 2;\n',
      'package.json': '{"name":"original-neighbor-fixture"}\n',
    });
    sources.push({ sourceId: 'other', repositoryId: 'example/other-fixture', root: otherRepo });
  }
  const { snapshot } = await captureSnapshot(store, { mode: 'committed-tree', sources });
  for (const source of sources) {
    unlock(source.root);
    rmSync(source.root, { recursive: true });
  }
  const module = join(dir, 'trusted-fixture-worker.mjs');
  writeFileSync(
    module,
    `globalThis.SENTINEL_BEHAVIOR = 'covering-ok';\nawait import(${JSON.stringify(new URL('./fixtures/workers/hostile-worker.mjs', import.meta.url).href)});\n`,
  );
  const registry = createAdapterRegistry([
    {
      id: 'sentinel-pattern',
      version: '1',
      kind: 'built-in',
      isolation: 'child',
      module,
      coverage: 'per-file-per-rule',
      limits: { timeoutMs: 15000, helloTimeoutMs: 5000, cancelGraceMs: 1000 },
    },
    ...(['capture', 'parse', 'inventory'] as const).map((stage) => ({
      id: `retained-${stage}`,
      version: '1',
      kind: 'operation' as const,
      operation: stage,
    })),
  ]);
  const capabilities = createCapabilityTable(registry, [
    { capability: 'source-bytes', adapterId: 'sentinel-pattern', evidence: 'original fixture' },
    { capability: 'pattern-match', adapterId: 'sentinel-pattern', evidence: 'original fixture' },
  ]);
  const profile = {
    id: 'retained-profile',
    registry,
    capabilities,
    permits: ['source-bytes', 'pattern-match'],
    operations: { capture: 'retained-capture', parse: 'retained-parse', inventory: 'retained-inventory' },
  };
  const parse = options.incomplete ? { ...PARSE, limits: { ...PARSE.limits, maxFiles: 1 } } : PARSE;
  const record = executionProfileRecord(
    profile,
    { capture: RESOURCES, parse: RESOURCES, inventory: RESOURCES, check: RESOURCES },
    parse,
  );
  const rules = lockedRules(
    [
      {
        familyId: 'sentinel.retained.fixture',
        adapterId: 'sentinel-pattern',
        scopeKind: options.scope ?? 'repository',
      },
    ],
    [],
  );
  rules.lock = { ...rules.lock, databases: [] };
  rules.pin = lockDigest(rules.lock as any);
  rules.view = plannerLockFrom(rules.lock as any, [rules.pack], rules.pin);
  const { policy, view } = policyView(['sentinel.retained.fixture']);
  const boot = planBootstrap({ runId: 'run-retained', sourceIds: sources.map((s) => s.sourceId), profile });
  await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
  const run: any = {
    schema: 'sentinel-run/draft-1',
    id: 'run-retained',
    parentId: null,
    baselineId: null,
    snapshotId: snapshot.id,
    planRevision: 1,
    coordinatorEpoch: store.epoch,
    ruleLockDigest: rules.pin,
    toolLockDigest: rules.pin,
    policyRevisionDigest: policy.revision,
    requestedScope: { sourceIds: sources.map((s) => s.sourceId), profile: profile.id },
    budgets: { maxTokens: null, maxCost: null, deadlineMs: 600000 },
    createdAt: '2026-10-22T00:00:00Z',
    state: 'planned',
  };
  const original: any = {},
    originals = new Map<string, any>(),
    previous = bootstrapIo.beforePrepare;
  bootstrapIo.beforePrepare = (items) => {
    for (const item of items) {
      const value: any = item.value;
      if (value.schema === 'sentinel-parser-index/draft-1') original.index = structuredClone(value);
      if (value.schema === 'sentinel-parser-result/draft-1') original.result = structuredClone(value);
      if (value.format === 'farsight-analysis') original.artifact = structuredClone(value);
      item.value = structuredClone(value);
      options.fault?.(item.value, { ...snapshot, manifest: store.ledger.getSnapshot(snapshot.id)!.manifest });
    }
    if (items.some((i) => i.schema === 'sentinel-parser-result/draft-1'))
      originals.set(original.result.sourceId, structuredClone(original));
    const artifact: any = items.find((i) => i.schema === 'farsight-analysis');
    const index: any = items.find((i) => i.schema === 'sentinel-parser-index/draft-1');
    const result: any = items.find((i) => i.schema === 'sentinel-parser-result/draft-1');
    if (result) {
      if (artifact && JSON.stringify(artifact.value) !== JSON.stringify(original.artifact))
        result.value.artifact = store.objects.identifyCanonicalJson(artifact.value).id;
      if (index && JSON.stringify(index.value) !== JSON.stringify(original.index))
        result.value.index = store.objects.identifyCanonicalJson(index.value).id;
      result.links = [result.value.artifact, result.value.index];
    }
    options.items?.(items);
  };
  try {
    const booted = await (await Coordinator.open({ store, runId: run.id, run, registry, scratchRoot: work })).run();
    assert.equal(booted.published, boot.units.length, JSON.stringify(booted.failures));
  } finally {
    bootstrapIo.beforePrepare = previous;
  }
  const inventory = boot.units.find((u) => u.stage === 'inventory')!;
  if (!options.fault && !options.items) await loadBootstrap(store, run.id, inventory);
  const parseUnit = boot.units.find((u) => u.stage === 'parse')!;
  const bootstrap =
    options.bootstrap === 'none'
      ? []
      : options.bootstrap === 'parse'
        ? [parseUnit]
        : options.bootstrap === 'two'
          ? [inventory, parseUnit]
          : [inventory];
  const analysis = planAnalysis({
    runId: run.id,
    revision: 2,
    previous: boot,
    bootstrap: bootstrap.map((u) => ({ id: u.id, revision: u.revision })),
    profile,
    snapshot: plannerSnapshotFrom(snapshot),
    analyses: [...originals].map(([sourceId, original]) => plannerAnalysisFrom({ sourceId, ...original })),
    lock: rules.view,
    policy: view,
  });
  assert.ok(analysis.units.length > 0, JSON.stringify(analysis.checks));
  await admitPlan(store, { plan: analysis, ruleLock: rules.lock, policy, profile: record });
  store.ledger.advanceRunPlan(run.id, analysis.revision);
  return {
    store,
    dir,
    work,
    repo,
    otherRepo,
    snapshot,
    registry,
    profile,
    record,
    rules,
    policy,
    view,
    boot,
    inventory,
    run,
    analysis,
  };
}
