// The framework inspection through the real coordinator (ADR 44): an original synthetic tree captured and then
// removed from disk, parsed and inventoried by the actual bootstrap, an admitted plan of the shipped pack's
// repository-scoped checks, and the built-in child run behind its generated closure entry. The driver receives only
// the coordinator's retained evidence; nothing is installed, downloaded or run from the target, and no model is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { admitPlan } from '../dist/execution/plans.js';
import { executionProfileRecord } from '../dist/execution/profile.js';
import { loadBootstrap } from '../dist/execution/bootstrap.js';
import { createCapabilityTable, planBootstrap, planAnalysis, plannerSnapshotFrom, plannerAnalysisFrom, plannerLockFrom } from '../dist/planner/index.js';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { emptyLock, lockDigest, readPackDirectory, validatePack } from '../dist/rules/index.js';
import { canonicalJsonBytes } from '../dist/store/objects.js';
import { CONTROLS_SUPPORTED_RULES, frameworkControlsAdapter } from '../dist/frameworks/controls/index.js';
import { workerClosure } from '../dist/frameworks/controls/closure.js';
import { builtinWorkerFiles } from '../dist/execution/assets.js';
const FRAMEWORK_CONTROLS_WORKER = builtinWorkerFiles('framework-controls').worker;
import { policyView } from './planner-helpers.ts';
import { commitRepo, needsStore, unlock } from './snapshot-helpers.ts';
import { scratch, removeScratch, storeIn } from './execution-helpers.ts';
import { RESOURCES } from './coordinator-helpers.ts';
import { ORDER } from './express-fixtures.ts';

const HERE = import.meta.dirname;
const PACK_DIR = fileURLToPath(new URL('../rules/framework-controls', import.meta.url));
const E2 = join(HERE, 'fixtures/framework-feasibility/sources/nest-validation');
const PARSE = { selection: { gitignore: true, testFiles: 'include' as const }, limits: { maxFiles: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20, maxEntries: 10_000, maxDurationMs: 60_000 } };
const D = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const FAMILIES = CONTROLS_SUPPORTED_RULES.map(r => r.familyId);

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.includes('.fixture')) out[f.replace('.fixture', '')] = readFileSync(join(dir, f), 'utf8');
  return out;
}
function wide(routers: number, routes: number): Record<string, string> {
  const files: Record<string, string> = { ...ORDER };
  const mounts: string[] = [];
  for (let r = 0; r < routers; r++) {
    files[`src/routers/r${r}.ts`] = `import express from 'express';\nconst router = express.Router();\n${
      Array.from({ length: routes }, (_, i) => `router.get('/item${i}', (req, res) => { res.json({ n: ${i} }); });`).join('\n')}\nexport default router;\n`;
    mounts.push(`import r${r} from './routers/r${r}.js';\napp.use('/r${r}', r${r});`);
  }
  files['src/app.ts'] = files['src/app.ts']!.replace('export default app;', `${mounts.join('\n')}\nexport default app;`);
  return files;
}

/** Capture, remove the source, bootstrap, plan the shipped pack's checks; returns what running the checks needs. */
async function planned(t: any, layout: Record<string, string>, limits: Record<string, number> = {}) {
  const s = scratch('framework-controls-driver');
  t.after(() => removeScratch(s.root));
  const store = await storeIn(s.root);
  t.after(() => { if (store.held) store.close(); });
  const repo = join(s.root, 'repo');
  commitRepo(repo, layout);
  const { snapshot } = await captureSnapshot(store, { mode: 'committed-tree', sources: [{ sourceId: 'app', repositoryId: 'example/app', root: repo }] });
  unlock(repo);
  rmSync(repo, { recursive: true, force: true });
  const entryDir = join(s.root, 'entry');
  mkdirSync(entryDir, { mode: 0o700 });
  const adapter = frameworkControlsAdapter({ entryDir, limits: { timeoutMs: 60_000, helloTimeoutMs: 15_000, cancelGraceMs: 1_000, ...limits } });
  const registry = createAdapterRegistry([adapter.definition, ...(['capture', 'parse', 'inventory'] as const).map(operation => ({ id: `controls-${operation}`, version: '1', kind: 'operation' as const, operation }))]);
  const files = readPackDirectory(PACK_DIR);
  const pack = validatePack(files);
  const now = new Date('2026-10-22T12:00:00.000Z');
  const at = '2026-10-22T12:00:00.000000000Z';
  const base = emptyLock(now);
  const lock = { ...base, revision: 2, previous: lockDigest(base), packs: [{ ...structuredClone((pack as any).entry), promotion: { receipt: D('fixture owner receipt'), at } }], tools: [], databases: [] };
  const pin = lockDigest(lock as any);
  const profile = { id: 'framework-controls-fixture', registry,
    capabilities: createCapabilityTable(registry, [{ capability: 'framework-order', adapterId: adapter.definition.id, evidence: 'the built-in framework inspection over retained parser evidence' }]),
    permits: ['framework-order'], operations: { capture: 'controls-capture', parse: 'controls-parse', inventory: 'controls-inventory' } };
  const record = executionProfileRecord(profile as any, { capture: RESOURCES, parse: RESOURCES, inventory: RESOURCES, check: RESOURCES } as any, PARSE);
  const { policy, view } = policyView(FAMILIES);
  const runId = 'run-framework-controls';
  const boot = planBootstrap({ runId, sourceIds: ['app'], profile: profile as any });
  await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: record });
  const run = { schema: 'sentinel-run/draft-1', id: runId, parentId: null, baselineId: null, snapshotId: snapshot.id, planRevision: 1, coordinatorEpoch: store.epoch,
    ruleLockDigest: pin, toolLockDigest: pin, policyRevisionDigest: policy.revision, requestedScope: { sourceIds: ['app'], profile: profile.id },
    budgets: { maxTokens: null, maxCost: null, deadlineMs: 600_000 }, createdAt: new Date().toISOString(), state: 'planned' } as any;
  const booted = await (await Coordinator.open({ store, runId, run, registry, scratchRoot: s.work })).run();
  assert.equal(booted.published, boot.units.length, JSON.stringify(booted.failures));
  const inventory = boot.units.find(u => u.stage === 'inventory')!;
  const evidence = await loadBootstrap(store, runId, { id: inventory.id, revision: inventory.revision });
  const plan = planAnalysis({ runId, revision: 2, previous: boot, bootstrap: [{ id: inventory.id, revision: inventory.revision }], profile: profile as any,
    snapshot: plannerSnapshotFrom(evidence.snapshot), analyses: evidence.analyses.map(a => plannerAnalysisFrom(a as any)), lock: plannerLockFrom(lock as any, [pack], pin), policy: view });
  assert.deepEqual(plan.checks.map((c: any) => [c.familyId, c.scopeKind, c.scopeId, c.state]).sort(), FAMILIES.map(f => [f, 'repository', 'app', 'planned']).sort(),
    'one repository check per family, all planned');
  await admitPlan(store, { plan, ruleLock: lock as any, policy, profile: record });
  store.ledger.advanceRunPlan(runId, 2);
  const drivers = createCheckDriverRegistry([adapter.driver], registry);
  const open = () => Coordinator.open({ store, runId, registry, scratchRoot: s.work, drivers, packs: [{ pack, files }], retry: { maxAttempts: 1 } });
  return { store, plan, adapter, registry, open, snapshot };
}

async function published(store: any, plan: any) {
  const out: Record<string, any[]> = {};
  for (const unit of plan.units) {
    const pub = store.ledger.getPublication({ id: unit.id, revision: unit.revision });
    if (!pub) continue;
    for (const o of pub.outputs) {
      const value = JSON.parse((await store.readArtifact(o.id)).toString());
      (out[o.schema] ??= []).push({ id: o.id, privacy: o.privacy, value, attemptId: pub.attemptId, unit });
    }
  }
  return out;
}
const report = (out: Record<string, any[]>) => out['sentinel-driver-report/draft-1']!.find(r => r.value.kind === 'framework-inspection')!.value;
const family = (rep: any, f: string) => rep.checks.find((c: any) => c.familyId === `sentinel.controls.${f}`);

test('the driver is bound to the closure entry, which pins the worker, the libraries and the driver itself', t => {
  const s = scratch('framework-controls-binding');
  t.after(() => removeScratch(s.root));
  const a = frameworkControlsAdapter({ entryDir: s.root });
  const registry = createAdapterRegistry([a.definition]);
  assert.equal(a.driver.implementationDigest, registry.get('framework-controls').digest);
  assert.deepEqual(a.driver.reads, { analysis: true });
  assert.ok(readFileSync(a.definition.module, 'utf8').includes('/frameworks/controls/driver.js'), 'the entry\'s manifest lists the driver');
  assert.notEqual(a.closureDigest, workerClosure(FRAMEWORK_CONTROLS_WORKER).digest, 'the driver is part of the pinned closure');
  // The shipped pack's rules at exactly the digests the driver supports.
  const pack: any = validatePack(readPackDirectory(PACK_DIR));
  assert.deepEqual(pack.entry.rules.map((r: any) => ({ familyId: r.familyId, revision: r.revision, definitionDigest: r.definitionDigest })), [...CONTROLS_SUPPORTED_RULES]);
});

test('Express, source removed after capture: unknown and unmodeled properties keep every family partial; zero findings', needsStore, async t => {
  const fx = await planned(t, ORDER);
  const done = await (await fx.open()).run();
  assert.equal(done.state, 'completed', JSON.stringify(done.failures));
  assert.equal(done.published, fx.plan.units.length, JSON.stringify(done.failures));
  const out = await published(fx.store, fx.plan);
  assert.equal(out['sentinel-driver-finding/draft-1'], undefined, 'an inspection publishes no finding');
  const rep = report(out);
  assert.equal(rep.assessment, 'none');
  assert.equal(rep.findings, 0);
  assert.equal(rep.recognised, true);
  assert.equal(rep.extent, 3);
  assert.deepEqual(rep.checks.map((c: any) => c.state), ['partial', 'partial', 'partial']);
  assert.ok(family(rep, 'authentication').reasons.includes('sentinel.express.refusalUnproven'));
  assert.ok(family(rep, 'input-validation').reasons.includes('sentinel.controls.propertyNotModeled'));
  const row = rep.inspected.find((r: any) => r.surfaceId === 'app::route::GET /reports' && r.property === 'authentication');
  assert.deepEqual([row.state, row.verdict], ['established', 'does-not-apply']);
  // Coverage names the published report's own canonical digest, and is never complete.
  const r = out['sentinel-driver-report/draft-1']!.find(x => x.value.kind === 'framework-inspection')!;
  assert.equal(r.id, `sha256:${createHash('sha256').update(canonicalJsonBytes(r.value)).digest('hex')}`);
  assert.equal(r.privacy, 'source-derived');
  assert.equal(r.value.attemptId, r.attemptId);
  const coverage = out['sentinel-coverage/draft-1']!.map(c => c.value);
  assert.equal(coverage.length, 3);
  for (const c of coverage) { assert.equal(c.status, 'partial'); assert.equal(c.granularity, 'aggregate'); }
  // Each library's envelopes are published as they are: Express with its facts, Nest and Spring empty here, Next none.
  assert.deepEqual(out['sentinel-controls/draft-1']!.map(e => [e.value.framework.id, e.value.facts.length > 0]).sort(), [['express', true], ['nest', false], ['spring', false]]);
  // The attempt's binding names the retained evidence and its four fixed roles; the source inputs are every captured file.
  const inspected = await fx.store.inspect();
  assert.equal(inspected.ok, true, JSON.stringify(inspected.errors));
  const unit = fx.plan.units.find((u: any) => u.stage === 'check')!;
  const values = await Promise.all(inspected.reachable.map(async (id: string) => { try { return JSON.parse((await fx.store.readArtifact(id)).toString()); } catch { return null; } }));
  const binding = values.find(v => v?.schema === 'sentinel-execution-binding/draft-1' && v.work.id === unit.id);
  assert.deepEqual(binding.derived.auxiliary.map((a: any) => a.role).sort(), ['analysis-artifact', 'analysis-index', 'analysis-result', 'snapshot-manifest']);
  assert.deepEqual(binding.derived.analysis.result, rep.analysis.result);
  assert.deepEqual(binding.sourceInputs, unit.inputs.map((i: any) => i.content).sort());
  assert.equal(unit.inputs.length, Object.keys(ORDER).length, 'configuration, manifests and code: the whole captured source');
});

test('Nest E2: input validation established on every route, kept partial by the named adapter-route gap', needsStore, async t => {
  const fx = await planned(t, tree(E2));
  const done = await (await fx.open()).run();
  assert.equal(done.state, 'completed', JSON.stringify(done.failures));
  const rep = report(await published(fx.store, fx.plan));
  const iv = rep.inspected.filter((r: any) => r.property === 'input-validation');
  assert.deepEqual(iv.map((r: any) => [r.surfaceId, r.state, r.verdict]), [
    ['app::route::POST /users/unvalidated', 'established', 'does-not-apply'], ['app::route::POST /users/validated', 'established', 'applies']]);
  assert.deepEqual(family(rep, 'input-validation'), { checkId: family(rep, 'input-validation').checkId, familyId: 'sentinel.controls.input-validation', state: 'partial', reasons: ['sentinel.nest.adapterRouteNotModeled'] });
});

test('a source no library recognises is never complete, even with nothing to inspect', needsStore, async t => {
  const fx = await planned(t, { 'package.json': '{"name":"original-plain-fixture","private":true}\n', 'src/util.ts': 'export const add = (a: number, b: number) => a + b;\n' });
  const done = await (await fx.open()).run();
  assert.equal(done.state, 'completed', JSON.stringify(done.failures));
  const out = await published(fx.store, fx.plan);
  const rep = report(out);
  assert.deepEqual([rep.recognised, rep.extent], [false, 0]);
  for (const c of rep.checks) assert.deepEqual([c.state, c.reasons], ['partial', ['sentinel.controls.frameworkNotRecognized']]);
  for (const c of out['sentinel-coverage/draft-1']!) assert.equal(c.value.status, 'partial');
});

test('the supervised child is killed at its deadline and cancel stops it; nothing is published', needsStore, async t => {
  const slow = await planned(t, wide(150, 40), { timeoutMs: 400, helloTimeoutMs: 400, cancelGraceMs: 100 });
  const timed = await (await slow.open()).run();
  assert.equal(timed.published, 0, JSON.stringify(timed));
  assert.ok(timed.failures.some((f: any) => ['sentinel.execution.deadlineExceeded', 'sentinel.execution.protocolViolation'].includes(f.code)), JSON.stringify(timed.failures));
  assert.equal((await published(slow.store, slow.plan))['sentinel-driver-report/draft-1'], undefined);

  const canceled = await planned(t, wide(150, 40), { cancelGraceMs: 100 });
  const coordinator = await canceled.open();
  const running = coordinator.run();
  setTimeout(() => coordinator.cancel(), 600);
  const t0 = Date.now();
  const summary = await running;
  assert.equal(summary.published, 0, JSON.stringify(summary));
  assert.ok(Date.now() - t0 < 5_000, 'stopped well before the job would have finished');
  assert.equal((await published(canceled.store, canceled.plan))['sentinel-driver-report/draft-1'], undefined);
});
