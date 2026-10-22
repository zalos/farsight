// Capture, then a new owner and a coordinator that recovers, through real Git checkouts and the real store.
// Snapshot admission releases its stages in the same transaction that records the snapshot, so recovery (which
// reads open stages from the ledger's staging rows, never from events) neither sees nor tries to release them; a
// capture that crashes before admission leaves its stages open, and recovery aborts every one, page after page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { git, needsStore, scratch as snapScratch, writeTree } from './snapshot-helpers.ts';
import { storeIn } from './execution-helpers.ts';
import { syntheticPlan } from './coordinator-helpers.ts';
import { mkdirSync, chmodSync } from 'node:fs';

/** 600 tracked files: with one artifact per stage, 601 stages (600 contents and the roots), above one 500-row page. */
const manyFiles = () => Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`src/f${String(i).padStart(3, '0')}.ts`, `export const v${i} = ${i};\n`]));
/** A committed fixture with Git's background housekeeping off, so nothing changes the repository while it is read. */
function quietRepo(root: string, files: Record<string, string>) {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet']);
  git(root, ['config', 'gc.auto', '0']);
  git(root, ['config', 'maintenance.auto', 'false']);
  writeTree(root, files);
  git(root, ['add', '--all', '--force']);
  git(root, ['commit', '--quiet', '--no-verify', '-m', 'fixture']);
}
const workDir = (root: string) => { const w = join(root, 'work'); mkdirSync(w, { recursive: true, mode: 0o700 }); chmodSync(w, 0o700); return w; };

test('an admitted capture survives checkout deletion and a new owner; recovery releases nothing and the run completes', needsStore, async t => {
  const dir = snapScratch(t, 'sentinel-exec-capture-');
  const repo = join(dir, 'repo');
  quietRepo(repo, manyFiles());
  const first = await storeIn(dir);
  const { record, snapshot } = await captureSnapshot(first, { mode: 'committed-tree', stageSize: 1, sources: [{ sourceId: 'app', repositoryId: 'example/app', root: repo }] });
  assert.equal(first.ledger.listOpenStages(500).length, 0, 'admission released every stage');
  first.close();
  rmSync(repo, { recursive: true, force: true }); // the checkout is gone
  const second = await storeIn(dir);
  try {
    const { plan, registry } = syntheticPlan(dir);
    const c = await Coordinator.open({ store: second, plan, registry, scratchRoot: workDir(dir) });
    assert.deepEqual(c.recovery.abortedStages, [], 'no already-released stage is touched');
    assert.equal(c.recovery.clean, true);
    assert.equal((await c.run()).published, 4);
    // The snapshot and its roots are retained: nothing of it is a prune candidate.
    assert.deepEqual(second.ledger.getSnapshot(snapshot.id), record);
    const plan2 = await second.planPrune();
    assert.equal(plan2.ok, true);
    assert.equal(plan2.candidates.length, 0, 'every captured object is reachable from the snapshot roots');
  } finally { second.close(); }
});

test('a capture that crashes with 601 stages open is recovered: every stage is aborted, across pages', needsStore, async t => {
  const dir = snapScratch(t, 'sentinel-exec-capture-crash-');
  const repo = join(dir, 'repo');
  quietRepo(repo, manyFiles());
  const first = await storeIn(dir);
  let staged: readonly string[] = [];
  // The owner is lost once every stage is registered: the capture's own abort cannot run any more.
  const failure = await captureSnapshot(first, { mode: 'committed-tree', stageSize: 1, sources: [{ sourceId: 'app', repositoryId: 'example/app', root: repo }],
    onStaged: ids => { staged = [...ids]; first.close(); } }).then(() => null, (e: any) => e);
  assert.equal(failure?.code, 'sentinel.store.ownerClosed', String(failure?.stack ?? failure));
  assert.equal(staged.length, 601);
  rmSync(repo, { recursive: true, force: true });
  const second = await storeIn(dir);
  try {
    assert.equal(second.ledger.listOpenStages(500).length, 500, 'more open stages than one page');
    const { plan, registry } = syntheticPlan(dir);
    const c = await Coordinator.open({ store: second, plan, registry, scratchRoot: workDir(dir) });
    assert.deepEqual([...c.recovery.abortedStages].sort(), [...staged].sort(), 'every open stage, and only those');
    assert.deepEqual(second.ledger.listOpenStages(500), []);
    assert.equal((await c.run()).published, 4);
  } finally { second.close(); }
});
