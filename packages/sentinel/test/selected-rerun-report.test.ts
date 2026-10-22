// Selected-stage reruns, end to end with the real modules: an owner-adopted workspace with the built-in pack
// promoted, planned and run; then a strict subset of its analysis rerun as a linked child run over the parent's
// retained snapshot and published bootstrap, under the terms in effect now. Only the selected units run; the rest
// are held with their reason; the parent's results are untouched; changed terms are refused, never widened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, qualificationFor, SQLITE_RELEASE_POLICY } from '../dist/store/index.js';
import { adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, scratchUnder, removeScratch, workspaceOf } from '../dist/service/local.js';
import { executeRun, planWorkspaceCanonical, rerunRun } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { initWorkspace } from '../dist/cli/init.js';
import { loadPlan } from '../dist/execution/plans.js';
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


import { selectedRerun } from '../dist/service/canonical.js';
import { admitPlan } from '../dist/execution/plans.js';
import { assessRun, fullReport } from '../dist/service/full-report.js';
import { digestOf } from '../dist/store/ledger-json.js';

// Real owner-held canonical captures, parser operations, workers and accepted publications. Negative cases admit
// an intentionally inconsistent analysis with the ordinary owner APIs; they never invent a publication/capability.
test('selected child and grandchild full reports reuse only the proven retained bootstrap; parent report is immutable', needsStore, async t => {
  const f = await ranParent(t);
  const request = { store: f.store, workspace: f.path, trustDir: f.ws.trustDir, now: new Date('2026-10-22T12:00:00Z'), disclosure: 'private' as const };
  const parentBefore = await fullReport({ ...request, runId: f.parentId });
  const parentEvents = JSON.stringify(f.store.ledger.readEvents({ runId: f.parentId, limit: 500 }));
  rmSync(join(f.path, 'src'), { recursive: true });
  let parentId = f.parentId, chosen = f.plan.units[0]!.id;
  for (let generation = 0; generation < 2; generation++) {
    const child: any = await rerunRun(f.store, parentId, [chosen], f.terms);
    const id = child.disclosure.runId;
    assert.equal((await rerunRun(f.store, parentId, [chosen], f.terms) as any).disclosure.runId, id, 'pending request joins');
    assert.equal((await executeRun(f.store, id, { scratchRoot: f.work })).state, 'completed');
    const assessment = await assessRun(f.store, id, { trustDir: f.ws.trustDir });
    assert.equal(assessment.snapshot.id, f.plan.pins.snapshotId);
    assert.equal(assessment.coverage.length, 1);
    const report = await fullReport({ ...request, runId: id });
    assert.equal(report.document.completeness, 'partial', 'held required units remain gaps');
    const admitted = await loadPlan(f.store, id, 1);
    for (const held of admitted.selection!.held) assert.equal(f.store.ledger.countAttempts({ id: held.unit, revision: 1 }), 0);
    const fresh: any = await rerunRun(f.store, parentId, [chosen], f.terms);
    assert.notEqual(fresh.disclosure.runId, id, 'terminal request makes a fresh child');
    parentId = id; chosen = admitted.selection!.selected[0]!.unit;
  }
  assert.equal((await fullReport({ ...request, runId: f.parentId })).json, parentBefore.json);
  assert.equal(JSON.stringify(f.store.ledger.readEvents({ runId: f.parentId, limit: 500 })), parentEvents);
});

for (const mode of ['foreign-inventory', 'noninventory', 'wrong-revision', 'parent-digest', 'parent-revision', 'missing-selection', 'parent-not-ended']) {
  test('retained report refuses ' + mode + ' despite real accepted producer evidence', needsStore, async t => {
    const f = await ranParent(t);
    const foreign: any = await rerunRun(f.store, f.parentId, [], f.terms);
    const foreignId = foreign.disclosure.runId;
    if (mode !== 'parent-not-ended') assert.equal((await executeRun(f.store, foreignId, { scratchRoot: f.work })).state, 'completed');
    assert.equal(f.store.ledger.getRun(foreignId)!.envelope.snapshotId, f.plan.pins.snapshotId, 'foreign producer is the same capture, but a sibling of this child');
    const candidate: any = await selectedRerun(f.store, f.parentId, [f.plan.units[0]!.id], f.terms);
    assert.ok(candidate.plan);
    const plan = structuredClone(candidate.plan), selection = structuredClone(candidate.selection);
    if (['foreign-inventory', 'noninventory', 'wrong-revision', 'parent-not-ended'].includes(mode)) {
      const boot = (await loadPlan(f.store, ['foreign-inventory', 'parent-not-ended'].includes(mode) ? foreignId : f.parentId, 1)).plan;
      const unit = boot.units.find(u => u.stage === (mode === 'noninventory' ? 'parse' : 'inventory'))!;
      const ref = { id: unit.id, revision: unit.revision };
      assert.ok(f.store.ledger.getPublication(ref), 'the replacement producer actually published');
      if (mode === 'wrong-revision') ref.revision++;
      plan.reused = [ref]; selection.reused = [ref];
      for (const u of plan.units) u.dependencies = [ref];
      if (mode === 'parent-not-ended') {
        const foreignPlan = (await loadPlan(f.store, foreignId)).plan;
        selection.parent = { runId: foreignId, revision: foreignPlan.revision, planDigest: foreignPlan.digest, snapshotId: foreignPlan.pins.snapshotId! };
      }
    } else if (mode === 'parent-digest') selection.parent.planDigest = `sha256:${'0'.repeat(64)}`;
    else if (mode === 'parent-revision') selection.parent.revision = 1;
    plan.digest = digestOf((({ digest: _d, ...rest }) => rest)(plan));
    await admitPlan(f.store, { plan, selection: mode === 'missing-selection' ? null : selection, ruleLock: candidate.current.lock, policy: f.terms.policy, profile: candidate.profile.record });
    // The real ledger may record a completed analysis with missing work; that would normally produce gaps. It must
    // not make a foreign bootstrap authoritative. No work/result/publication is inserted for this hostile child.
    const parent = f.store.ledger.getRun(f.parentId)!.envelope;
    f.store.ledger.createRun({ ...parent, id: plan.runId, parentId: mode === 'parent-not-ended' ? foreignId : f.parentId, planRevision: 1, coordinatorEpoch: f.store.epoch, state: 'planned' });
    f.store.ledger.setRunState(plan.runId, 'running');
    f.store.ledger.setRunState(plan.runId, 'completed', { outcome: 'partial-coverage' });
    await assert.rejects(assessRun(f.store, plan.runId, { trustDir: f.ws.trustDir }), (e: any) => e.code === 'sentinel.report.evidenceUnbound');
  });
}

test('retained child report refuses a lost accepted inventory invocation instead of treating publication metadata as authority', needsStore, async t => {
  const f = await ranParent(t);
  const child: any = await rerunRun(f.store, f.parentId, [f.plan.units[0]!.id], f.terms);
  const id = child.disclosure.runId;
  assert.equal((await executeRun(f.store, id, { scratchRoot: f.work })).state, 'completed');
  assert.equal((await assessRun(f.store, id, { trustDir: f.ws.trustDir })).snapshot.id, f.plan.pins.snapshotId);
  const ref = f.plan.reused[0]!;
  const publication = f.store.ledger.getPublication(ref)!;
  const invocation = f.store.ledger.getAttempt(publication.attemptId)!.envelope.invocation!;
  const hex = invocation.slice(7), dir = join(f.store.storePath, 'objects', 'sha256', hex.slice(0, 2));
  const { readdirSync, unlinkSync } = await import('node:fs');
  const copies = readdirSync(dir).filter(n => n.startsWith(hex + '.'));
  assert.ok(copies.length > 0);
  for (const name of copies) unlinkSync(join(dir, name));
  await assert.rejects(assessRun(f.store, id, { trustDir: f.ws.trustDir }), (e: any) => e.code === 'sentinel.report.evidenceUnbound');
});
