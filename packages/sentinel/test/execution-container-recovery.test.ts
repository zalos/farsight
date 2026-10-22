// Crash recovery with real containers (SENTINEL_ISOLATION=1, a qualified local runtime and the pinned canary image;
// without it these skip with the reason below). A real coordinator process is killed by bounded fault injection
// around the real Docker client; a fresh process recovers from the ledger, the journals and the ownership labels.
//
// One repetition per case is the CI smoke. With SENTINEL_RECOVERY_FULL=1 as well, each case runs 20 times (the E4
// full gate for real containers): every repetition must accept each output once, leave no owned container, and
// leave two unrelated containers (another store's, and an unlabelled one) untouched.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IntentFiles } from '../dist/execution/recovery.js';
import { LABELS } from '../dist/execution/isolation.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { CANARY_IMAGE, containerPlan, publications } from './coordinator-helpers.ts';
import { Coordinator } from '../dist/execution/coordinator.js';

const enabled = process.env.SENTINEL_ISOLATION === '1';
const REPS = process.env.SENTINEL_RECOVERY_FULL === '1' ? 20 : 1;
const skip = !enabled && 'real-container recovery: set SENTINEL_ISOLATION=1 with a qualified local Docker and the pinned canary image installed';
const child = fileURLToPath(new URL('./helpers/container-kill-child.ts', import.meta.url));
const roots: string[] = [];
after(() => roots.forEach(removeScratch));
const run = (root: string, scenario: string, waitMs = 30_000) => spawnSync(process.execPath,
  ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', child, root, scenario, String(waitMs)], { encoding: 'utf8', timeout: 240_000 });
const docker = (...args: string[]) => spawnSync(['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker'].find(p => spawnSync(p, ['--version']).status === 0)!, args, { encoding: 'utf8' });
const storeContainers = (storeId: string) => docker('ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${LABELS.store}=${storeId}`).stdout.trim().split('\n').filter(Boolean);
const summaryOf = (r: ReturnType<typeof run>) => JSON.parse(r.stdout.trim().split('\n').at(-1)!);

async function storeIdOf(root: string) { const s = await storeIn(root); try { return s.storeId; } finally { s.close(); } }

// Two containers that are not ours: recovery must never touch them, in any repetition.
let unrelated: string[] = [];
before(() => {
  if (!enabled) return;
  unrelated = [
    docker('create', '--pull', 'never', '--label', `${LABELS.store}=store-unrelated`, '--label', `${LABELS.owner}=owner-unrelated`, CANARY_IMAGE, 'true').stdout.trim(),
    docker('create', '--pull', 'never', CANARY_IMAGE, 'true').stdout.trim(),
  ];
});
after(() => { for (const id of unrelated) docker('rm', '--force', id); });
const unrelatedIntact = () => { for (const id of unrelated) assert.equal(docker('inspect', '--type', 'container', '--format', '{{.Id}}', id).stdout.trim(), id, 'an unrelated container is untouched'); };

test('a create whose reply is lost to a crash: recovery removes the container by its labels and finishes the run' + (REPS > 1 ? `, ${REPS} repetitions` : ''), { skip }, async () => {
  for (let rep = 0; rep < REPS; rep++) {
    const s = scratch('ctr-lost'); roots.push(s.root);
    assert.equal(run(s.root, 'lost-reply').signal, 'SIGKILL');
    const id = await storeIdOf(s.root);
    assert.equal(storeContainers(id).length, 1, 'the daemon made the container; the dead coordinator never learned its id');
    const finished = run(s.root, 'none');
    assert.equal(finished.status, 0, finished.stderr.slice(0, 600));
    const summary = summaryOf(finished);
    assert.equal(summary.state, 'completed');
    assert.equal(summary.published, 4);
    assert.equal(summary.recovery.removedContainers.length, 1);
    assert.equal(summary.recovery.settledIntents.length, 1, 'its journaled intent was settled');
    assert.equal(summary.recovery.clean, true);
    assert.deepEqual(storeContainers(id), []);
    const store = await storeIn(s.root);
    try { assert.ok([...publications(store, 'run-e4').values()].every(n => n === 1)); } finally { store.close(); }
    unrelatedIntact();
  }
});

test('a container that appears after recovery first looked: admission waits, then the late container is removed and the run finishes' + (REPS > 1 ? `, ${REPS} repetitions` : ''), { skip }, async () => {
  for (let rep = 0; rep < REPS; rep++) {
    const s = scratch('ctr-late'); roots.push(s.root);
    assert.equal(run(s.root, 'before-create').signal, 'SIGKILL');
    const store0 = await storeIn(s.root);
    const [intent] = new IntentFiles(store0.storePath).list().records;
    const publishedBefore = [...publications(store0, 'run-e4').keys()];
    store0.close();
    assert.ok(intent, 'the create intent was journaled before the crash');
    // The recovering coordinator runs asynchronously; the daemon commits the old create late, while it waits.
    const child2 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', child, s.root, 'none', '20000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child2.stdout.on('data', b => { out += b; });
    child2.stderr.on('data', b => { err += b; });
    const exited = new Promise<number | null>(r => child2.on('close', r));
    await new Promise(r => setTimeout(r, 2_500));
    const labels = Object.entries({ owner: intent.owner, store: intent.store, attempt: intent.attempt, epoch: intent.epoch, invocation: intent.invocation })
      .flatMap(([k, v]) => ['--label', `${(LABELS as any)[k]}=${v}`]);
    const lateAt = Date.now();
    const lateId = docker('create', '--pull', 'never', '--name', intent.name, ...labels, CANARY_IMAGE, 'true').stdout.trim();
    assert.match(lateId, /^[0-9a-f]{64}$/);
    assert.equal(await exited, 0, err.slice(0, 600));
    const summary = JSON.parse(out.trim().split('\n').at(-1)!);
    assert.equal(summary.state, 'completed');
    assert.equal(summary.published, 4);
    assert.deepEqual(summary.blocked, []);
    assert.ok(summary.recovery.settledIntents.includes(intent.name) || summary.recovery.removedContainers.includes(lateId), 'the late container was found and removed');
    assert.deepEqual(storeContainers(intent.store), []);
    // Nothing new was admitted while the create was unconfirmed: every attempt after the crash started after it appeared.
    const store = await storeIn(s.root);
    try {
      for (const w of ['work-A', 'work-B', 'work-C', 'work-D']) {
        if (publishedBefore.includes(w)) continue;
        for (const a of store.ledger.listAttempts({ id: w, revision: 1 })) {
          const started = Date.parse(store.ledger.getAttempt(a.id).envelope.startedAt);
          assert.ok(started >= lateAt, `${w} attempt ${a.id} started before the pending create was resolved`);
        }
      }
      assert.ok([...publications(store, 'run-e4').values()].every(n => n === 1));
    } finally { store.close(); }
    unrelatedIntact();
  }
});

test('a crash while the run is canceling: its running container is removed and the stale attempt ends terminal' + (REPS > 1 ? `, ${REPS} repetitions` : ''), { skip }, async () => {
  for (let rep = 0; rep < REPS; rep++) {
    const s = scratch('ctr-cancel'); roots.push(s.root);
    assert.equal(run(s.root, 'cancel').signal, 'SIGKILL');
    const id = await storeIdOf(s.root);
    assert.equal(storeContainers(id).length, 1, 'the hung worker container outlived its coordinator');
    const finished = run(s.root, 'none-cancel');
    assert.equal(finished.status, 0, finished.stderr.slice(0, 600));
    const summary = summaryOf(finished);
    assert.equal(summary.state, 'canceled');
    assert.equal(summary.published, 0);
    assert.deepEqual(summary.recovery.interrupted.map((i: any) => i.workState), ['failed']);
    assert.equal(summary.recovery.removedContainers.length, 1);
    assert.deepEqual(storeContainers(id), []);
    unrelatedIntact();
  }
});

test('within one epoch, a create without a confirmed answer holds admission until its late container is removed, then retries' + (REPS > 1 ? `, ${REPS} repetitions` : ''), { skip }, async () => {
  for (let rep = 0; rep < REPS; rep++) {
    const s = scratch('ctr-pending'); roots.push(s.root);
    const store = await storeIn(s.root);
    try {
      const { plan, registry } = await containerPlan(s.root);
      let deferred = false;
      let appearedAt = 0;
      // Bounded fault: work-A's first create reports a timeout at once, and the daemon commits it 1.8 s later,
      // after the create's own reconcile window has looked and found nothing.
      const wrapRunner = (real: any) => ({
        ...real,
        run: async (args: readonly string[], signal?: AbortSignal) => {
          if (args[0] === 'create' && !deferred) {
            deferred = true;
            setTimeout(() => { void real.run(args).then(() => { appearedAt = Date.now(); }); }, 1_800);
            return { exitCode: null, exitSignal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutExceeded: false, stderrExceeded: false, timedOut: true, canceled: false, spawnError: null };
          }
          return real.run(args, signal);
        },
      });
      const c = await Coordinator.open({ store, plan, registry, scratchRoot: s.work, containers: true, cleanupWaitMs: 20_000, backendOptions: { wrapRunner } });
      const summary = await c.run();
      assert.ok(appearedAt > 0, 'the late container did appear');
      assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
      assert.equal(summary.published, 4);
      assert.ok(summary.failures.some((f: any) => f.code === 'sentinel.execution.reconciliationPending'));
      const [a] = store.ledger.listAttempts({ id: 'work-A', revision: 1 });
      assert.ok(Date.parse(store.ledger.getAttempt(a.id).envelope.startedAt) >= appearedAt, 'no attempt started before the pending create resolved');
      assert.deepEqual(storeContainers(store.storeId), []);
    } finally { store.close(); }
    unrelatedIntact();
  }
});
