// The coordinator's own scratch: the input restore lasts one drive; what a crashed owner left is removed only when
// it is provably unused (an earlier epoch's restore; an ended attempt with no obligation), and kept otherwise.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Coordinator } from '../dist/execution/coordinator.js';
import { WorkerFiles } from '../dist/execution/recovery.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { syntheticPlan } from './coordinator-helpers.ts';

const roots: string[] = [];
after(() => roots.forEach(removeScratch));
const restores = (dir: string) => readdirSync(dir).filter(n => n.startsWith('inputs.'));
const workDirs = (dir: string) => readdirSync(dir).filter(n => n.startsWith('att-'));
/** What a SIGKILLed owner leaves: its sealed restore under its own epoch (an in-process close still runs finally). */
function deadRestore(dir: string, epoch: string) {
  const path = join(dir, `inputs.${epoch}.${randomUUID()}`);
  mkdirSync(join(path, 'synthetic', 'src'), { recursive: true });
  writeFileSync(join(path, 'synthetic', 'src', 'a.ts'), 'x');
  chmodSync(join(path, 'synthetic', 'src', 'a.ts'), 0o400);
  chmodSync(join(path, 'synthetic', 'src'), 0o500);
  chmodSync(join(path, 'synthetic'), 0o500);
  return path;
}

test('a completed drive leaves no input restore and no attempt folder behind', async () => {
  const s = scratch('scratch-done'); roots.push(s.root);
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, { B: 'tampered-output' });
    const summary = await (await Coordinator.open({ store, runId: p.runId, run: p.run, registry: p.registry, scratchRoot: s.work })).run();
    assert.equal(summary.state, 'completed');
    assert.deepEqual(restores(s.work), [], 'the restore lasted the drive');
    assert.deepEqual(workDirs(s.work), [], 'failed and published attempts released their folders');
  } finally { store.close(); }
});

test('after a crash, an earlier owner\'s restore and a confirmed-stopped attempt\'s folder are removed on open', async () => {
  const s = scratch('scratch-crash'); roots.push(s.root);
  const first = await storeIn(s.root);
  const p = await syntheticPlan(first, s.root, { A: 'hang' }, { limits: { timeoutMs: 20_000 } });
  let left: string[] = [];
  const hooks = { at: (b: string) => { if (b === 'after-attempt-start' && !left.length) { left = [...restores(s.work), ...workDirs(s.work)]; first.close(); } } };
  await (await Coordinator.open({ store: first, runId: p.runId, run: p.run, registry: p.registry, scratchRoot: s.work, hooks })).run().catch(() => undefined);
  assert.equal(left.length, 2, `the crashed drive had a restore and an attempt folder: ${left}`);
  const epoch = first.epoch;
  const second = await storeIn(s.root);
  try {
    deadRestore(s.work, epoch);
    const ours = deadRestore(s.work, second.epoch);
    const c = await Coordinator.open({ store: second, runId: p.runId, registry: p.registry, scratchRoot: s.work });
    assert.equal(c.scratch.removedRestores.length, 1);
    assert.equal(c.scratch.removedWorkDirs.length, 1, 'the attempt ended under the new fence and its worker was stopped');
    assert.deepEqual([...restores(s.work), ...workDirs(s.work)], [ours.slice(s.work.length + 1)], 'only this owner\'s own restore name is kept');
  } finally { second.close(); }
});

test('while recovery holds anything it cannot confirm, a crashed attempt\'s folder is kept', async () => {
  const s = scratch('scratch-uncertain'); roots.push(s.root);
  const first = await storeIn(s.root);
  const p = await syntheticPlan(first, s.root, { A: 'hang' }, { limits: { timeoutMs: 20_000 } });
  let crashed = false;
  const hooks = { at: (b: string) => { if (b === 'after-attempt-start' && !crashed) { crashed = true; first.close(); } } };
  await (await Coordinator.open({ store: first, runId: p.runId, run: p.run, registry: p.registry, scratchRoot: s.work, hooks })).run().catch(() => undefined);
  const epoch = first.epoch;
  const second = await storeIn(s.root);
  try {
    deadRestore(s.work, epoch);
    writeFileSync(join(new WorkerFiles(second.storePath).dir, 'garbage.json'), '{not json', { mode: 0o600 });
    const c = await Coordinator.open({ store: second, runId: p.runId, registry: p.registry, scratchRoot: s.work, cleanupWaitMs: 0 });
    assert.equal(c.recovery.clean, false);
    assert.equal(c.scratch.removedWorkDirs.length, 0);
    assert.equal(workDirs(s.work).length, 1, 'kept: an unreadable record might describe a worker still using it');
    assert.equal(c.scratch.removedRestores.length, 1, 'a dead owner\'s restore is read by no worker, so it goes');
  } finally { second.close(); }
});

test('an acknowledged terminal-unknown record is not a stop: a later open still keeps the crashed attempt\'s folder', async () => {
  const s = scratch('scratch-acknowledged'); roots.push(s.root);
  const first = await storeIn(s.root);
  const p = await syntheticPlan(first, s.root, { A: 'hang' }, { limits: { timeoutMs: 20_000 } });
  let crashed = false;
  const hooks = { at: (b: string) => { if (b === 'after-attempt-start' && !crashed) { crashed = true; first.close(); } } };
  await (await Coordinator.open({ store: first, runId: p.runId, run: p.run, registry: p.registry, scratchRoot: s.work, hooks })).run().catch(() => undefined);
  const second = await storeIn(s.root);
  try {
    // An unreadable record (it might describe a worker still running) blocks, then is acknowledged as unknown.
    writeFileSync(join(new WorkerFiles(second.storePath).dir, 'garbage.json'), '{not json', { mode: 0o600 });
    const c = await Coordinator.open({ store: second, runId: p.runId, registry: p.registry, scratchRoot: s.work, cleanupWaitMs: 0 });
    assert.equal(workDirs(s.work).length, 1);
    assert.equal(c.acknowledgeUnknownCleanup().length, 1);
  } finally { second.close(); }
  // A later owner sees a clean recovery (the record is in the terminal-unknown journal), and still keeps the folder.
  const third = await storeIn(s.root);
  try {
    const c = await Coordinator.open({ store: third, runId: p.runId, registry: p.registry, scratchRoot: s.work });
    assert.equal(c.recovery.clean, true);
    assert.equal(c.scratch.removedWorkDirs.length, 0, 'acknowledgement is never proof that a worker stopped');
    assert.equal(workDirs(s.work).length, 1);
  } finally { third.close(); }
});
