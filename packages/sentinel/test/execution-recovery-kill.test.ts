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
import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COORDINATOR_BOUNDARIES } from '../dist/execution/coordinator.js';
import { processStartTime, readHistory } from '../dist/execution/recovery.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { publications } from './coordinator-helpers.ts';

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
  accessSync('/bin/ps', constants.X_OK);
  assert.notEqual(processStartTime(process.pid), null, 'the process table reader reports this process');
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
        assert.deepEqual([...counts.keys()].sort(), ['work-A', 'work-B', 'work-C', 'work-D'], `rep ${rep}: nothing lost`);
        assert.ok([...counts.values()].every(n => n === 1), `rep ${rep}: nothing duplicated ${JSON.stringify([...counts])}`);
        const h = readHistory(store);
        assert.equal([...h.attempts.values()].filter(a => a.state === 'running').length, 0, `rep ${rep}: no attempt left running`);
        assert.equal(h.openStages.size, 0, `rep ${rep}: no stage left open`);
        // Every worker the dead coordinator started is gone (recovery stopped it, or it ended on its own).
        for (const [id] of h.attempts) {
          const w = store.ledger.getAttempt(id)?.envelope.worker;
          if (w?.kind !== 'owned-child') continue;
          const started = processStartTime(w.pid);
          assert.ok(started === null || Math.abs(started - Date.parse(w.processStartedAt)) > 3_000, `rep ${rep}: worker ${w.pid} survived`);
        }
        if (rep === 0) t.diagnostic(`${boundary}: recovery ${JSON.stringify({ stale: summary.recovery.staleAttempts.length, stopped: summary.recovery.stoppedChildren.length, aborted: summary.recovery.abortedStages.length })}`);
      } finally { store.close(); }
    }
  });
}

test(`a worker that outlives its dead coordinator is stopped by verified identity, ${repetitions || 'no'} repetition(s)`, { skip }, async () => {
  for (let rep = 0; rep < repetitions; rep++) {
    const s = scratch('kill-orphan');
    roots.push(s.root);
    assert.equal(runChild(s.root, 'after-attempt-start', 'work-B', 'linger-ok').signal, 'SIGKILL');
    // The orphan is alive before recovery runs.
    const store0 = await storeIn(s.root);
    const h0 = readHistory(store0);
    const orphan = [...h0.attempts].find(([, a]) => a.work.id === 'work-B' && a.state === 'running');
    const worker = orphan && store0.ledger.getAttempt(orphan[0])?.envelope.worker;
    store0.close();
    assert.ok(worker?.kind === 'owned-child' && processStartTime(worker.pid) !== null, 'the orphaned worker is running');
    const finished = runChild(s.root, 'none', 'work-B', 'linger-ok');
    assert.equal(finished.status, 0, finished.stderr.slice(0, 500));
    const summary = JSON.parse(finished.stdout.trim().split('\n').at(-1)!);
    assert.deepEqual(summary.recovery.stoppedChildren, [worker!.pid], 'recovery stopped exactly the recorded worker');
    assert.equal(processStartTime(worker!.pid), null);
    assert.equal(summary.published, 4);
  }
});
