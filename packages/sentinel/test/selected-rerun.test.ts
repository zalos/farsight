// Selected-stage reruns, end to end with the real modules: an owner-adopted workspace with the built-in pack
// promoted, planned and run; then a strict subset of its analysis rerun as a linked child run over the parent's
// retained snapshot and published bootstrap, under the terms in effect now. Only the selected units run; the rest
// are held with their reason; the parent's results are untouched; changed terms are refused, never widened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, qualificationFor, SQLITE_RELEASE_POLICY } from '../dist/store/index.js';
import { adoptedPolicy, adoptWorkspaceSettings, followWorkspaceRun, promoteRulePack, scratchUnder, removeScratch, workspaceOf } from '../dist/service/local.js';
import { executeRun, planWorkspaceCanonical, previewFindingsOf, previewRerun, rerunEnvelopeOf, rerunRun } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { initWorkspace } from '../dist/cli/init.js';
import { loadPlan } from '../dist/execution/plans.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { checkSelection, NOT_SELECTED, selectionClosure } from '../dist/execution/selection.js';
import { unlock } from './snapshot-helpers.ts';

const QUALIFIED = qualificationFor(SQLITE_RELEASE_POLICY, `${process.platform}-${process.arch}`, process.versions.sqlite ?? '') !== undefined;
const needsStore = QUALIFIED || process.env.CI ? {} : { skip: 'not a qualified store host' };
const FILES = {
  'src/users.ts': 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n',
  'src/orders.ts': 'export const all = () => db.query("SELECT * FROM orders WHERE id = ?", [1]);\n',
  'src/Audit.java': 'class Audit { String q = "DELETE FROM audit WHERE k = " + key; }\n',
};

/** An adopted workspace with the built-in pack promoted, planned and run to completion. */
async function ranParent(t: any) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-selrerun-')));
  t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'ws');
  for (const [p, text] of Object.entries(FILES)) { mkdirSync(join(path, p, '..'), { recursive: true }); writeFileSync(join(path, p), text); }
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path });
  adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
  promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('foundation-preview')!), confirm: true, now: new Date() });
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const work = scratchUnder(ws);
  t.after(() => removeScratch(work));
  const planned = await planWorkspaceCanonical(store, { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() });
  const parentId = planned.disclosure.runId;
  const done = await executeRun(store, parentId, { scratchRoot: work });
  assert.equal(done.state, 'completed', JSON.stringify(done.failures));
  const { plan } = await loadPlan(store, parentId, planned.disclosure.revision);
  const terms = { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() };
  return { dir, path, ws, store, work, parentId, plan, terms };
}

const counts = (store: any, runId: string) => {
  const kinds: Record<string, number> = {};
  for (let after = 0; ;) { const p = store.ledger.readEvents({ runId, after, limit: 500 }); for (const e of p.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1; if (!p.more) return kinds; after = p.cursor; }
};
const snapshotsAdmitted = (store: any) => {
  let n = 0;
  for (let after = 0; ;) { const p = store.ledger.readEvents({ after, limit: 500 }); n += p.events.filter((e: any) => e.kind === 'snapshot-admitted').length; if (!p.more) return n; after = p.cursor; }
};

test('a strict subset reruns exactly the selected units over the parent\'s retained inputs, with its source gone', needsStore, async t => {
  const { store, path, parentId, plan, terms, work } = await ranParent(t);
  assert.equal(plan.units.length, 3);
  const chosen = plan.units.find(u => u.scopes[0] === 'workspace:src/users.ts')!.id;
  const parentEvents = counts(store, parentId);
  const parentFindings = await previewFindingsOf(store, parentId);
  const snapshots = snapshotsAdmitted(store);

  const preview: any = await previewRerun(store, parentId, [chosen], terms);
  assert.deepEqual([preview.selected, preview.downstream, preview.all, preview.units.length, preview.held.length], [[chosen], [], false, 1, 2]);
  assert.ok(preview.held.every((h: any) => h.parentUnit && h.parentUnit !== chosen), 'each held unit names its parent counterpart');
  assert.ok(preview.requiredHeld >= 2, 'the held required checks are disclosed: this rerun cannot complete required coverage');
  const rerun: any = await rerunRun(store, parentId, [chosen], terms);
  assert.equal(rerun.outcome, 'prepared');
  assert.deepEqual({ ...rerun.preview }, { ...preview }, 'what was previewed is exactly what was admitted');
  const childId = rerun.disclosure.runId;
  assert.equal((await rerunRun(store, parentId, [chosen], terms) as any).outcome, 'kept');

  const admitted = await loadPlan(store, childId, 1);
  assert.ok(admitted.selection, 'admitted with its selection');
  assert.deepEqual(admitted.selection!.parent, { runId: parentId, revision: plan.revision, planDigest: plan.digest, snapshotId: plan.pins.snapshotId });
  assert.equal(admitted.plan.pins.snapshotId, plan.pins.snapshotId, 'the parent\'s snapshot, never a new capture');
  assert.ok(admitted.plan.units.every(u => u.stage === 'check'), 'no capture or parse unit: the parent\'s bootstrap is reused as published');

  // The source is gone (the store beside it in .farsight stays): everything the rerun needs is retained.
  rmSync(join(path, 'src'), { recursive: true, force: true });
  assert.equal(store.ledger.getRun(childId), null, 'not run until `run`');
  const summary = await executeRun(store, childId, { scratchRoot: work });
  assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
  assert.equal(summary.outcome, 'partial-coverage', 'held required checks keep it incomplete: nothing is reused as coverage');
  const ran = admitted.selection!.selected[0]!.unit;
  for (const u of admitted.plan.units) {
    const attempts = store.ledger.listAttempts({ id: u.id, revision: 1 });
    if (u.id === ran) { assert.equal(attempts.length, 1); assert.ok(store.ledger.getPublication({ id: u.id, revision: 1 })); continue; }
    assert.deepEqual(attempts, [], 'a held unit never runs');
    const row = store.ledger.getWork({ id: u.id, revision: 1 })!;
    assert.deepEqual([row.state, row.reason], ['disabled-by-policy', NOT_SELECTED]);
  }
  assert.equal(store.ledger.getRun(childId)!.envelope.parentId, parentId);
  assert.equal(snapshotsAdmitted(store), snapshots, 'nothing was captured again');
  assert.deepEqual(counts(store, parentId), parentEvents, 'the parent run is untouched');
  assert.deepEqual(await previewFindingsOf(store, parentId), parentFindings, 'its results unchanged');
  assert.equal((await previewFindingsOf(store, childId))!.findings.length, 1, 'the selected unit\'s own finding');
  // Asked again once that run has ended, the same parent and selection is a fresh run, never the ended one handed back;
  // a repeat of the fresh request while it waits joins it.
  const childEvents = counts(store, childId);
  const again: any = await rerunRun(store, parentId, [chosen], terms);
  assert.equal(again.outcome, 'prepared');
  assert.notEqual(again.disclosure.runId, childId);
  assert.deepEqual([again.preview.selected, again.preview.units.length, again.preview.held.length], [[chosen], 1, 2]);
  assert.equal((await rerunRun(store, parentId, [chosen], terms) as any).disclosure.runId, again.disclosure.runId, 'the waiting request is joined');
  assert.equal((await rerunRun(store, parentId, [chosen], terms) as any).outcome, 'kept');
  assert.equal((await executeRun(store, again.disclosure.runId, { scratchRoot: work })).state, 'completed');
  assert.deepEqual(counts(store, childId), childEvents, 'the earlier rerun is untouched');
  assert.equal(snapshotsAdmitted(store), snapshots, 'still nothing captured again');
  const report = await store.inspect();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

test('a selected rerun resumes after a crash and stops on cancel; held units never run either way', needsStore, async t => {
  const { store, parentId, plan, terms, work, ws } = await ranParent(t);
  const chosen = plan.units.slice(0, 2).map(u => u.id);
  const rerun: any = await rerunRun(store, parentId, chosen, terms);
  const childId = rerun.disclosure.runId;
  const admitted = await loadPlan(store, childId, 1);
  const { scannerExecution } = await import('../dist/service/scanner-profile.js');
  const { publicRegistry } = await import('../dist/service/scanner-profile.js');
  const assets = await scannerExecution(store, childId, ws.trustDir, work, publicRegistry());
  let crashed = false;
  const hooks = { at: (b: string) => { if (b === 'after-attempt-start' && !crashed) { crashed = true; store.close(); } } };
  await (await Coordinator.open({ ...assets, store, runId: childId, run: (await rerunEnvelopeOf(store, childId))!, registry: publicRegistry(), scratchRoot: work, hooks })).run().catch(() => undefined);
  assert.ok(crashed);
  const reopened = await openStore(ws.storePath);
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  assert.equal((await rerunRun(reopened, childId, [], terms) as any).reasonCode, 'sentinel.service.runNotEnded', 'a run that has not ended is resumed, not rerun');
  const resumed = await executeRun(reopened, childId, { scratchRoot: work });
  assert.equal(resumed.state, 'completed', JSON.stringify(resumed.failures));
  const runs = new Set(admitted.selection!.selected.map(s => s.unit));
  for (const u of admitted.plan.units) {
    const published = reopened.ledger.getPublication({ id: u.id, revision: 1 });
    assert.equal(!!published, runs.has(u.id), `${u.id}: published exactly when selected`);
  }
  // Cancel: a second selection, canceled before it runs anything, publishes nothing and stays canceled.
  const other: any = await rerunRun(reopened, parentId, [plan.units[2]!.id], terms);
  const c = await Coordinator.open({ ...(await scannerExecution(reopened, other.disclosure.runId, ws.trustDir, work, publicRegistry())), store: reopened,
    runId: other.disclosure.runId, run: (await rerunEnvelopeOf(reopened, other.disclosure.runId))!, registry: publicRegistry(), scratchRoot: work });
  c.pause();
  await c.run();
  c.cancel();
  const canceled = await c.run();
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.published, 0);
  // Retry of the canceled selection: only what it selected and did not publish, never its held units.
  reopened.close();
  const retried: any = await followWorkspaceRun(ws, { mode: 'retry', runId: other.disclosure.runId, confirm: true, now: new Date() });
  assert.equal(retried.outcome, 'prepared', JSON.stringify(retried));
  assert.deepEqual([retried.facts.parentId, retried.facts.preview.all, retried.facts.preview.units.length, retried.facts.preview.held.length], [other.disclosure.runId, false, 1, 2]);
  assert.deepEqual(retried.facts.preview.selected, other.preview.units, 'the selection\'s own unit, by its id in that run');
});

test('refusals: unknown or not-ended parents, unknown stages, a selection that is not the same work now', needsStore, async t => {
  const { store, parentId, plan, terms, dir } = await ranParent(t);
  const chosen = plan.units[0]!.id;
  assert.equal((await rerunRun(store, 'run-' + '0'.repeat(32), [chosen], terms) as any).reasonCode, 'sentinel.service.runUnknown');
  assert.equal((await rerunRun(store, parentId, ['work-nope'], terms) as any).reasonCode, 'sentinel.service.stageUnknown');
  // An admitted rerun that has not run is not an ended parent.
  const child: any = await rerunRun(store, parentId, [chosen], terms);
  assert.equal((await rerunRun(store, child.disclosure.runId, [], terms) as any).reasonCode, 'sentinel.service.runUnknown');
  // Another implementation of the detector (as another build would have): the selected unit is not the same work.
  const { foundationProfile } = await import('../dist/service/trusted-profile.js');
  const { createAdapterRegistry } = await import('../dist/execution/registry.js');
  const { publicRegistry } = await import('../dist/service/scanner-profile.js');
  const base = publicRegistry();
  const changed = createAdapterRegistry(base.ids.map(id => ({ ...(base.get(id) as any), ...(id === 'sentinel.preview.detector' ? { version: 'other-build' } : {}) })));
  const stale: any = await rerunRun(store, parentId, [chosen], { ...terms, profile: foundationProfile(changed) });
  assert.deepEqual([stale.reasonCode, stale.facts.stale], ['sentinel.service.selectionStale', [chosen]]);
  // A changed rule lock (the same pack with other rule bytes) is refused before anything is planned.
  const pack = join(dir, 'changed-pack');
  cpSync(realpathSync.native(builtinPackDir('foundation-preview')!), pack, { recursive: true });
  const { readPackDirectory, validatePack } = await import('../dist/rules/index.js');
  const files = readPackDirectory(pack);
  const rulePath = [...files.keys()].find(k => k.startsWith('detectors/') || k.endsWith('.yml'))!;
  writeFileSync(join(pack, rulePath), Buffer.concat([Buffer.from(readFileSync(join(pack, rulePath))), Buffer.from('\n# changed\n')]));
  void validatePack;
  const ws = workspaceOf(terms.workspace, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  promoteRulePack(ws, { packDir: pack, confirm: true, now: new Date() });
  await assert.rejects(rerunRun(store, parentId, [chosen], terms), (e: any) => e.code === 'sentinel.service.ruleUnsupported');
});

test('a parent canceled before its analysis has no bootstrap to reuse: a selected rerun of it is refused, never recaptured', needsStore, async t => {
  const { store, parentId, work } = await ranParent(t);
  const { foundationProfile } = await import('../dist/service/trusted-profile.js');
  const { publicRegistry } = await import('../dist/service/scanner-profile.js');
  const { planBootstrap } = await import('../dist/planner/index.js');
  const { admitPlan } = await import('../dist/execution/plans.js');
  const profile = foundationProfile(publicRegistry());
  const runId = 'run-' + 'b'.repeat(32);
  const boot = planBootstrap({ runId, sourceIds: ['workspace'], profile: profile.planner });
  await admitPlan(store, { plan: boot, ruleLock: null, policy: null, profile: profile.record });
  const parent = store.ledger.getRun(parentId)!.envelope;
  const run = { ...parent, id: runId, parentId: null, planRevision: 1, coordinatorEpoch: store.epoch, state: 'planned' };
  const c = await Coordinator.open({ store, runId, run: run as any, registry: publicRegistry(), scratchRoot: work });
  c.pause();
  await c.run();
  c.cancel();
  assert.equal((await c.run()).state, 'canceled');
  const snapshots = snapshotsAdmitted(store);
  const leaf = boot.units.find(u => !boot.units.some(o => o.dependencies.some(d => d.id === u.id)))!;
  const refused: any = await previewRerun(store, runId, [leaf.id], { trustDir: '', policy: null as any, scratchRoot: work });
  assert.equal(refused.reasonCode, 'sentinel.service.bootstrapUnavailable');
  assert.equal(snapshotsAdmitted(store), snapshots, 'nothing was captured to make up for it');
});

test('a selection that needs an analysis unit it does not run is refused: reusing one is not supported (PR 27)', () => {
  // The synthetic diamond A → {B, C} → D: choosing B runs B and D, and D also needs C, which does not run.
  const u = (id: string, deps: string[] = []) => ({ id, dependencies: deps.map(d => ({ id: d, revision: 1 })) });
  const units = [u('A'), u('B', ['A']), u('C', ['A']), u('D', ['B', 'C'])];
  assert.deepEqual(((r) => [[...r.run].sort(), r.needed])(selectionClosure(units, ['B'])), [['B', 'D'], ['A', 'C']]);
  assert.deepEqual(((r) => [[...r.run].sort(), r.needed])(selectionClosure(units, ['A'])), [['A', 'B', 'C', 'D'], []]);
  assert.deepEqual(((r) => [[...r.run].sort(), r.needed])(selectionClosure(units, ['D'])), [['D'], ['B', 'C']]);
  // Units that depend only on the reused bootstrap (outside the revision) need nothing: the shipped planner's case.
  assert.deepEqual(selectionClosure([u('x', ['boot']), u('y', ['boot'])], ['x']).needed, []);
});

test('a selection that does not fit its revision is refused at admission', () => {
  const unit = (id: string, deps: string[] = []) => ({ id, revision: 1, dependencies: deps.map(d => ({ id: d, revision: 1 })) });
  const plan: any = { kind: 'analysis', units: [unit('a'), unit('b', ['a']), unit('c')], reused: [{ id: 'boot', revision: 1 }] };
  const sel = (over: any) => ({ schema: 'sentinel-rerun-selection/draft-1', parent: {}, selected: [{ parentUnit: 'pa', unit: 'a' }], downstream: ['b'],
    held: [{ unit: 'c', parentUnit: null }], reused: [{ id: 'boot', revision: 1 }], ...over });
  assert.doesNotThrow(() => checkSelection(plan, sel({}) as any));
  const refused = (s: any, re: RegExp) => assert.throws(() => checkSelection(plan, s), (e: any) => e.code === 'sentinel.execution.planInvalid' && re.test(e.detail.reason));
  refused(sel({ downstream: [], held: [{ unit: 'b', parentUnit: null }, { unit: 'c', parentUnit: null }] }), /must run too/);
  refused(sel({ selected: [{ parentUnit: 'pb', unit: 'b' }], downstream: [], held: [{ unit: 'a', parentUnit: null }, { unit: 'c', parentUnit: null }] }), /which is held/);
  refused(sel({ held: [] }), /run or held, once/);
  refused(sel({ reused: [] }), /other work than the revision/);
});

test('under a changed policy the rerun is planned and admitted under that policy, never the parent\'s', needsStore, async t => {
  const { store, parentId, plan, terms, ws } = await ranParent(t);
  const path = join(ws.path, '.farsight/sentinel/settings.json');
  writeFileSync(path, readFileSync(path, 'utf8').replace('"medium"', '"high"'));
  adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted && adopted.policy.revision !== plan.pins.policyDigest);
  const rerun: any = await rerunRun(store, parentId, [plan.units[0]!.id], { ...terms, policy: (adopted as any).policy });
  assert.equal(rerun.outcome, 'prepared', JSON.stringify(rerun));
  const admitted = await loadPlan(store, rerun.disclosure.runId, 1);
  assert.equal(admitted.plan.pins.policyDigest, (adopted as any).policy.revision);
  assert.notEqual(rerun.disclosure.runId, (await rerunRun(store, parentId, [plan.units[0]!.id], terms) as any).disclosure.runId, 'another policy is another rerun');
});
