// Real process death at every coordinator boundary (E4): a coordinator process sends itself SIGKILL there, and a
// fresh process recovers from the ledger and finishes the same run. Zero lost and zero duplicate accepted outputs.
//
// SENTINEL_RECOVERY_SMOKE=1 runs one kill per boundary (selected CI); SENTINEL_RECOVERY_FULL=1 runs 20 per
// boundary (dedicated job / release gate). Either mode fails, not skips, when a prerequisite is missing. Without
// either, only these process-kill cases skip, with the reason below; recovery's state transitions are still
// tested in-process by execution-coordinator.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COORDINATOR_BOUNDARIES } from '../dist/execution/coordinator.js';
import { argumentsOf, WorkerFiles } from '../dist/execution/recovery.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { ledgerState, publications, unitIdsOf } from './coordinator-helpers.ts';
import { loadPlan } from '../dist/execution/plans.js';

const full = process.env.SENTINEL_RECOVERY_FULL === '1';
const smoke = process.env.SENTINEL_RECOVERY_SMOKE === '1';
const repetitions = full ? 20 : smoke ? 1 : 0;
const skip = repetitions === 0 && 'process-kill recovery: set SENTINEL_RECOVERY_SMOKE=1 (one kill per boundary) or SENTINEL_RECOVERY_FULL=1 (20 per boundary)';
const child = fileURLToPath(new URL('./helpers/coordinator-kill-child.ts', import.meta.url));
const roots: string[] = [];
after(() => roots.forEach(removeScratch));

const runChild = (root: string, killAt: string, unit = 'work-B', behaviourB = '') => spawnSync(process.execPath,
  ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', child, root, killAt, unit, behaviourB], { encoding: 'utf8', timeout: 120_000 });

test('the kill matrix has its prerequisites', { skip }, () => {
  // Recovery verifies a dead coordinator's child workers through the fixed process table reader.
  if (process.platform === 'darwin') accessSync('/bin/ps', constants.X_OK);
  const argv = argumentsOf(process.pid);
  assert.ok(Array.isArray(argv) && argv.length > 0, 'the kernel argument list of this process is readable');
});

for (const boundary of COORDINATOR_BOUNDARIES) {
  test(`SIGKILL at ${boundary}, ${repetitions || 'no'} repetition(s): recovery finishes with each output accepted once`, { skip }, async t => {
    for (let rep = 0; rep < repetitions; rep++) {
      const s = scratch(`kill-${boundary}`);
      roots.push(s.root);
      const killed = runChild(s.root, boundary);
      assert.equal(killed.signal, 'SIGKILL', `rep ${rep}: the coordinator died at ${boundary} (${killed.stderr.slice(0, 300)})`);
      const finished = runChild(s.root, 'none');
      assert.equal(finished.status, 0, `rep ${rep}: ${finished.stderr.slice(0, 500)}`);
      const summary = JSON.parse(finished.stdout.trim().split('\n').at(-1)!);
      assert.equal(summary.state, 'completed');
      assert.equal(summary.published, 4);
      const store = await storeIn(s.root);
      try {
        const counts = publications(store, 'run-e4');
        const { plan } = await loadPlan(store, 'run-e4', 1);
        assert.deepEqual([...counts.keys()].sort(), Object.values(unitIdsOf(plan)).sort(), `rep ${rep}: nothing lost`);
        assert.ok([...counts.values()].every(n => n === 1), `rep ${rep}: nothing duplicated ${JSON.stringify([...counts])}`);
        const l = ledgerState(store, plan);
        assert.equal(l.running, 0, `rep ${rep}: no attempt left running`);
        assert.equal(l.openStages, 0, `rep ${rep}: no stage left open`);
        // Every worker identity was settled: recovery proved it stopped, or the worker exited and was reaped.
        assert.deepEqual(new WorkerFiles(store.storePath).list(), { records: [], unresolved: [] }, `rep ${rep}: no worker obligation left`);
        assert.equal(summary.recovery.clean, true, `rep ${rep}: recovery is clean`);
        if (rep === 0) t.diagnostic(`${boundary}: recovery ${JSON.stringify({ interrupted: summary.recovery.interrupted.length, stopped: summary.recovery.stoppedWorkers.length, aborted: summary.recovery.abortedStages.length })}`);
      } finally { store.close(); }
    }
  });
}

test(`parent loss before start: the worker exits on its own at end of stdin, having written nothing, ${repetitions || 'no'} repetition(s)`, { skip }, async () => {
  for (let rep = 0; rep < repetitions; rep++) {
    const s = scratch('kill-prestart');
    roots.push(s.root);
    // after-spawn: the worker exists with its identity journaled; its coordinator dies before recording the attempt,
    // so no start is ever sent. Nothing stops the worker here: no recovery runs until it is gone.
    assert.equal(runChild(s.root, 'after-spawn').signal, 'SIGKILL');
    const store0 = await storeIn(s.root);
    const [journaled] = new WorkerFiles(store0.storePath).list().records;
    store0.close();
    assert.ok(journaled && journaled.pid > 0, 'the worker was started and journaled');
    let gone = false;
    for (let i = 0; i < 100 && !gone; i++) {
      const v = argumentsOf(journaled.pid);
      gone = v === null || (Array.isArray(v) && !v.includes(`--sentinel-token=${journaled.token}`));
      if (!gone) await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(gone, `rep ${rep}: the worker exited by itself once its coordinator was gone`);
    const prefix = `${journaled.attempt.replace(/[^A-Za-z0-9._-]/g, '_')}-`;
    const attemptDirs = readdirSync(join(s.root, 'work')).filter(d => d.startsWith(prefix));
    assert.equal(attemptDirs.length, 1, `rep ${rep}: the unauthorized worker's attempt folder is there to inspect`);
    assert.deepEqual(readdirSync(join(s.root, 'work', attemptDirs[0]!, 'output')), [], `rep ${rep}: an unauthorized worker wrote nothing`);
    const finished = runChild(s.root, 'none');
    assert.equal(finished.status, 0, finished.stderr.slice(0, 500));
    const summary = JSON.parse(finished.stdout.trim().split('\n').at(-1)!);
    assert.deepEqual(summary.recovery.stoppedWorkers, [], `rep ${rep}: recovery had nothing to stop`);
    assert.equal(summary.published, 4);
  }
});

test(`a worker that outlives its dead coordinator is stopped by verified identity, ${repetitions || 'no'} repetition(s)`, { skip }, async () => {
  for (let rep = 0; rep < repetitions; rep++) {
    const s = scratch('kill-orphan');
    roots.push(s.root);
    // after-spawn: the worker exists and its identity is durable, but no attempt is in the ledger yet.
    assert.equal(runChild(s.root, rep % 2 ? 'after-attempt-start' : 'after-spawn', 'work-B', 'linger-ok').signal, 'SIGKILL');
    // The orphan is alive before recovery runs.
    const store0 = await storeIn(s.root);
    const [journaled] = new WorkerFiles(store0.storePath).list().records;
    store0.close();
    const worker = { pid: journaled.pid };
    assert.ok(journaled.pid > 0 && argumentsOf(journaled.pid)?.includes(`--sentinel-token=${journaled.token}`), 'the orphaned worker is running with its token');
    const finished = runChild(s.root, 'none', 'work-B', 'linger-ok');
    assert.equal(finished.status, 0, finished.stderr.slice(0, 500));
    const summary = JSON.parse(finished.stdout.trim().split('\n').at(-1)!);
    assert.deepEqual(summary.recovery.stoppedWorkers, [worker!.pid], 'recovery stopped exactly the recorded worker');
    assert.ok(!argumentsOf(worker!.pid)?.includes(`--sentinel-token=${journaled.token}`), 'it is gone');
    assert.equal(summary.published, 4);
  }
});
