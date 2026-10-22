// The foundation-preview path in one process, canonically: a synthetic workspace adopted and with the built-in pack
// promoted by its owner; the CLI's canonical plan (capture, the admitted bootstrap published by the coordinator's own
// operations, the analysis planned from that evidence and admitted); the coordinator runs the preview detector as a
// real worker; coverage and findings are read back from the ledger. A file the detector cannot read is reported
// skipped, so its required check stays partial: nothing is covered that was not read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, qualificationFor, SQLITE_RELEASE_POLICY } from '../dist/store/index.js';
import { adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, scratchUnder, removeScratch, workspaceOf } from '../dist/service/local.js';
import { canonicalResult, executeRun, planWorkspaceCanonical, previewFindingsOf } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { initWorkspace } from '../dist/cli/init.js';
import { loadPlan } from '../dist/execution/plans.js';
import { detect, PREVIEW_RULE } from '../dist/adapters/preview-detector.js';
import { unlock } from './snapshot-helpers.ts';

const QUALIFIED = qualificationFor(SQLITE_RELEASE_POLICY, `${process.platform}-${process.arch}`, process.versions.sqlite ?? '') !== undefined;
const needsStore = QUALIFIED || process.env.CI ? {} : { skip: 'not a qualified store host' };

test('the preview detector flags SQL assembled from strings and nothing else', () => {
  assert.deepEqual(detect('a.ts', 'const q = "SELECT * FROM users WHERE id = " + id;', 'x').map(f => f.line), [1]);
  assert.deepEqual(detect('A.java', 'String q = "DELETE FROM t WHERE k = " + key;', 'x').length, 1);
  assert.equal(detect('a.ts', 'const q = `UPDATE t SET a = ${v}`;', 'x').length, 1);
  assert.equal(detect('a.ts', 'db.query("SELECT * FROM users WHERE id = ?", [id]);', 'x').length, 0, 'a parameterized query');
  assert.equal(detect('a.ts', '// "SELECT * FROM users WHERE id = " + id', 'x').length, 0, 'a comment');
  assert.equal(detect('a.py', 'q = "SELECT * FROM t WHERE x = " + y', 'x').length, 0, 'a language it does not check');
});

test('canonical plan → admitted analysis → coordinator → coverage records and findings; an unreadable file stays partial', needsStore, async t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-slice-')));
  t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'ws');
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src/users.ts'), 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n');
  writeFileSync(join(path, 'src/Orders.java'), 'class Orders { String q = "SELECT * FROM orders WHERE id = ?"; }\n');
  writeFileSync(join(path, 'src/latin1.ts'), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0xe9, 0x3b, 0x0a])); // not UTF-8
  writeFileSync(join(path, 'README.md'), '# not checked\n');
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path });
  adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
  assert.equal(promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('foundation-preview')!), confirm: true, now: new Date() }).outcome, 'prepared');
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);

  const store = await openStore(ws.storePath);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const work = scratchUnder(ws);
  try {
    const planned = await planWorkspaceCanonical(store, { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() });
    assert.equal(planned.outcome, 'prepared');
    const { plan } = await loadPlan(store, planned.disclosure.runId, planned.disclosure.revision);
    const scopes = plan.checks.filter(c => c.state === 'planned').map(c => c.scopeId).sort();
    assert.deepEqual(scopes, ['workspace:src/Orders.java', 'workspace:src/latin1.ts', 'workspace:src/users.ts'], 'TS/JS/Java files only');
    assert.ok(plan.units.every(u => u.scopes.length <= 1), 'one scope per unit, so every finding names its file');
    assert.ok(plan.pins.rules.every(r => r.familyId === PREVIEW_RULE));

    const summary = await executeRun(store, planned.disclosure.runId, { scratchRoot: work });
    assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
    assert.equal(summary.kind, 'analysis');
    // Coverage from the coverage records: the unreadable file's check was named but its scope skipped, so it is partial.
    assert.equal(summary.coverage!.requiredComplete, 2);
    assert.equal(summary.outcome, 'partial-coverage', 'never complete while a required scope was not read');
    const findings = (await previewFindingsOf(store, planned.disclosure.runId))!;
    assert.deepEqual(findings.findings.map((f: any) => [f.path, f.line]), [['src/users.ts', 1]]);
    assert.deepEqual([findings.scanned, findings.skipped], [2, 1]);
    // The CLI's reading of it: required coverage incomplete, the foundation-preview label kept.
    const read = await canonicalResult(store, 'run', planned.disclosure.runId, { executing: false });
    assert.deepEqual([read.outcome, read.reasonCode, read.facts.label], ['required-coverage-incomplete', 'sentinel.service.previewNotCoverage', 'foundation-preview']);
  } finally { removeScratch(work); }
});

test('a run whose bootstrap could not publish is finished: planning again names it, and a rerun plans after it', needsStore, async t => {
  const { foundationProfile, foundationRegistry } = await import('../dist/service/trusted-profile.js');
  const { followRun } = await import('../dist/service/canonical.js');
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-bootfail-')));
  t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'ws');
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src/users.ts'), 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n');
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path });
  adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
  promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('foundation-preview')!), confirm: true, now: new Date() });
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const work = scratchUnder(ws);
  try {
    // No bootstrap operation is bound: the stages are held, never run by a generic worker, and the run ends failed.
    const unbound = foundationProfile(foundationRegistry(), { operations: false });
    const opts = { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date(), profile: unbound };
    let failedRun = '';
    await assert.rejects(planWorkspaceCanonical(store, opts), (e: any) => { failedRun = e.facts?.runId; return e.code === 'sentinel.service.bootstrapFailed'; });
    assert.equal(store.ledger.getRun(failedRun)!.state, 'completed');
    assert.equal(store.ledger.getRun(failedRun)!.outcome, 'execution-failure');
    // The same content again names the same finished run, at once, executing nothing.
    const events = store.ledger.readEvents({ runId: failedRun, after: 0, limit: 500 }).events.length;
    await assert.rejects(planWorkspaceCanonical(store, opts), (e: any) => e.code === 'sentinel.service.bootstrapFailed' && e.facts.runId === failedRun);
    assert.equal(store.ledger.readEvents({ runId: failedRun, after: 0, limit: 500 }).events.length, events, 'nothing ran again');
    // A rerun plans a new run after it, under the shipped profile.
    const next = await followRun(store, failedRun, 'rerun', { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() });
    assert.ok('disclosure' in next && next.outcome === 'prepared' && next.disclosure.runId !== failedRun);
  } finally { removeScratch(work); }
});

test('a selected rerun previews its consequences from the parent plan: downstream reruns, prerequisites are reused', needsStore, async t => {
  const { syntheticPlan, unitIdsOf } = await import('./coordinator-helpers.ts');
  const { previewRerun } = await import('../dist/service/canonical.js');
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-rerun-')));
  t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const store = await openStore(join(dir, 'store'));
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  // The synthetic diamond: A → {B, C} → D, run to completion.
  const planned = await syntheticPlan(store, dir, {}, { runId: 'run-diamond' });
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const summary = await executeRun(store, 'run-diamond', { scratchRoot: work, registry: planned.registry, run: planned.run });
  assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
  const id = unitIdsOf(planned.plan);
  const preview: any = await previewRerun(store, 'run-diamond', [id.B!]);
  assert.deepEqual(preview.selected, [id.B]);
  assert.deepEqual(preview.downstream, [id.D], 'what depends on B runs again with it');
  assert.deepEqual(preview.prerequisites, [id.A, id.C].sort(), 'what B and D depend on and is not rerun (A, and C for D) is reused as published');
  assert.equal(preview.all, false);
  const fromA: any = await previewRerun(store, 'run-diamond', [id.A!]);
  assert.deepEqual([fromA.downstream, fromA.prerequisites, fromA.all], [[id.B, id.C, id.D].sort(), [], true], 'selecting the root reruns everything');
  assert.equal(((await previewRerun(store, 'run-diamond', ['work-missing'])) as any).reasonCode, 'sentinel.service.stageUnknown');
});

test('a promoted pack that names the preview detector for any other rule, or for its rule with other bytes, is refused before anything runs', needsStore, async t => {
  const { cpSync, readFileSync: read } = await import('node:fs');
  const { unsupportedRules } = await import('../dist/service/trusted-profile.js');
  for (const variant of ['another-family', 'same-family-other-bytes'] as const) {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `sentinel-unsupported-${variant}-`)));
    t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
    // A copy of the shipped pack, changed the way an owner could change it.
    const pack = join(dir, 'pack');
    cpSync(realpathSync.native(builtinPackDir('foundation-preview')!), pack, { recursive: true });
    const manifestPath = join(pack, 'sentinel-pack.json');
    const manifest = JSON.parse(read(manifestPath, 'utf8'));
    const family = variant === 'another-family' ? 'sentinel.sol.required-rule' : PREVIEW_RULE;
    manifest.packId = `custom-${variant}`;
    manifest.rules[0].familyId = family;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const detector = join(pack, manifest.rules[0].implementation.rulePath);
    writeFileSync(detector, JSON.stringify({ ...JSON.parse(read(detector, 'utf8')), familyId: family, marker: 'SOL_ONLY_MARKER_NOT_IN_INPUT' }));

    const path = join(dir, 'ws');
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src/query.ts'), 'export const lookup = (id: string) => db.query("SELECT * FROM invoice WHERE id = " + id);\n');
    const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
    initWorkspace({ workspace: path });
    // The owner asks for the custom family and adopts it.
    const settingsPath = join(path, '.farsight/sentinel/settings.json');
    writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(read(settingsPath, 'utf8')), mandatoryRules: [family] }));
    adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
    assert.equal(promoteRulePack(ws, { packDir: pack, confirm: true, now: new Date() }).outcome, 'prepared', 'promotion itself is the owner\'s to make');
    const adopted = adoptedPolicy(ws);
    assert.ok('policy' in adopted);
    const store = await openStore(ws.storePath);
    const work = scratchUnder(ws);
    try {
      await assert.rejects(planWorkspaceCanonical(store, { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() }),
        (e: any) => e.code === 'sentinel.service.ruleUnsupported' && e.facts.unsupported[0].familyId === family, variant);
      // Nothing analysis-related was admitted: no plan revision 2 exists for any run.
      const runs = new Set(store.ledger.readEvents({ after: 0, limit: 500 }).events.filter((e: any) => e.runId).map((e: any) => e.runId));
      for (const id of runs) assert.equal(store.ledger.getPlan(id as string, 2), undefined, `${variant}: no analysis admitted`);
    } finally { removeScratch(work); store.close(); }
  }
  // The shipped rule itself is supported; the same pins with other definition bytes are not.
  const { supportedRules } = await import('../dist/service/trusted-profile.js');
  const [shipped] = supportedRules();
  assert.deepEqual(unsupportedRules({ pins: { rules: [{ ...shipped, packDigest: 'x' }] } } as any), []);
  assert.equal(unsupportedRules({ pins: { rules: [{ ...shipped, packDigest: 'x', definitionDigest: `sha256:${'0'.repeat(64)}` }] } } as any).length, 1);
});

test('a run planned by another installation is refused at start, never submitted, and wait and status say why after a restart', needsStore, async t => {
  const { OwnerService } = await import('../dist/service/owner-service.js');
  const { confirmForService, statusIn } = await import('../dist/service/local.js');
  const { currentPlan } = await import('../dist/service/canonical.js');
  const { createAdapterRegistry } = await import('../dist/execution/registry.js');
  const { ownExecutable } = await import('../dist/service/package-paths.js');
  const { PREVIEW_DETECTOR_ID } = await import('../dist/adapters/preview-detector.js');
  const { OPERATIONS } = await import('../dist/service/trusted-profile.js');
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-other-install-')));
  t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'ws');
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src/users.ts'), 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n');
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path });
  adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
  promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('foundation-preview')!), confirm: true, now: new Date() });
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  // The same adapters, but the detector is another build's: its registered digest differs from the one planned under.
  const other = createAdapterRegistry([
    { id: PREVIEW_DETECTOR_ID, version: 'preview-1-other-build', kind: 'built-in', isolation: 'child', module: ownExecutable(), coverage: 'per-file-per-rule' },
    { id: OPERATIONS.capture, version: '1', kind: 'operation', operation: 'capture' },
    { id: OPERATIONS.parse, version: '1', kind: 'operation', operation: 'parse' },
    { id: OPERATIONS.inventory, version: '1', kind: 'operation', operation: 'inventory' },
  ]);
  const by = { principal: 'agent', channel: 'local-service' } as const;

  const store = await openStore(ws.storePath);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const work = scratchUnder(ws);
  let runId: string;
  try {
    const planned = await planWorkspaceCanonical(store, { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() });
    runId = planned.disclosure.runId;
  } finally { removeScratch(work); }
  const plan = await currentPlan(store, runId);

  for (const attempt of [1, 2]) {
    // A fresh service each time: the second stands for a restart. Neither accepts the run.
    const service = new OwnerService(store, ws, { registry: other });
    const confirmed = confirmForService(ws, { command: 'run', action: 'run.start', plan, planId: runId, confirm: true, now: new Date(), storeId: store.storeId });
    assert.ok('receiptId' in confirmed);
    const started: any = await service.handle('run.start', { planId: runId, receiptId: confirmed.receiptId }, by);
    assert.equal(started.outcome, 'configuration-failure', `attempt ${attempt}: ${JSON.stringify(started)}`);
    assert.equal(started.reasonCode, 'sentinel.service.runNotExecutable');
    assert.match(String(started.facts.reason), /another digest/);
    const waited: any = await service.handle('run.wait', { runId, timeoutMs: 300 }, by);
    assert.deepEqual([waited.outcome, waited.reasonCode], ['configuration-failure', 'sentinel.service.runNotExecutable'], 'never awaiting');
    const status: any = await service.handle('run.status', { runId }, by);
    assert.equal(status.reasonCode, 'sentinel.service.runNotExecutable');
    assert.match(String(status.facts.notExecutable.reason), /another digest/);
    await service.stop();
  }
  // Nothing of the analysis started (awaiting means no unit has work), and the installation that planned it can still
  // execute it: there, it waits to run.
  const here = await canonicalResult(store, 'wait', runId, { executing: false });
  assert.deepEqual([here.outcome, here.reasonCode], ['prepared', 'sentinel.service.runAwaiting']);
  const status = await statusIn(store, { runId });
  assert.equal(status.reasonCode, undefined);
});
