// Algorithm qualification over REAL temporary files/descriptors with a confined kernel-I/O fixture. Fake root
// ownership/filesystem types and notifications are explicit; these controls do not claim native OOM qualification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  watchOwnedCgroupMemory,
  cgroupMemoryIo,
  CGROUP_MEMORY_BOUNDS,
  cgroupMemoryFailure,
} from '../dist/execution/cgroup-memory.js';
import { ContainerBackend, LABELS } from '../dist/execution/isolation.js';
import { currentHost } from '../dist/store/runtime.js';

import { ID, PID, LIMIT, GROUP, record, kernel } from './cgroup-memory-fixture.ts';

test('exact local max+oom+kill delta retains immutable evidence after teardown, with every handle closed', (t) => {
  const k = kernel(t),
    w = k.start();
  assert.equal(w.observation().state, 'watching');
  w.arm();
  k.write(record(20, 1, 1));
  k.notify();
  assert.equal(w.observation().state, 'positive');
  assert.equal(k.held.size, 0);
  assert.equal(k.watchClosed(), true);
  fs.rmSync(k.leaf, { recursive: true });
  const e = w.finish()!;
  assert.equal(e.witness, 'cgroup-v2-local');
  assert.equal(e.resource, 'memory');
  assert.equal(e.identity.container, ID);
  assert.equal(e.identity.pid, PID);
  assert.equal(e.memoryMax, String(LIMIT));
  assert.deepEqual(e.baseline, { max: '0', oom: '0', oom_kill: '0' });
  assert.deepEqual(e.observed, { max: '20', oom: '1', oom_kill: '1' });
  assert.equal(Object.isFrozen(e.identity), true);
});
test('a queued watcher error after a positive preserves its immutable evidence and diagnostic state', async (t) => {
  const k = kernel(t),
    w = k.start();
  w.arm();
  k.write(record(20, 1, 1));
  k.notify();
  const evidence = w.finish(),
    observation = w.observation();
  assert.ok(evidence);
  assert.equal(observation.state, 'positive');
  queueMicrotask(() => k.watchError(Object.assign(Error('queued watcher teardown'), { code: 'ENOENT' })));
  await Promise.resolve();
  assert.equal(w.finish(), evidence);
  assert.deepEqual(w.observation(), observation);
  assert.equal(k.held.size, 0);
});
test('pre-arm notifications count no samples and cannot turn a later final-read failure into a raced observation', (t) => {
  const k = kernel(t),
    w = k.start();
  for (let i = 0; i < 3; i++) k.notify();
  assert.deepEqual(w.observation(), {
    state: 'watching',
    samples: 0,
    attempts: 1,
    burst: { triggered: false, reads: 0 },
  });
  w.arm();
  fs.unlinkSync(join(k.leaf, 'memory.events.local'));
  assert.equal(w.finish(), undefined);
  assert.deepEqual(w.observation(), {
    state: 'unavailable',
    samples: 0,
    attempts: 3,
    reason: 'kernel-object-gone',
    burst: { triggered: false, reads: 0 },
    failure: { phase: 'final', check: 'named-before' },
  });
  assert.equal(k.held.size, 0);
});
for (const [name, body] of [
  ['unchanged/plainSIGKILL', record()],
  ['kill alone/global ambiguity', record(0, 0, 1)],
  ['max only', record(2, 0, 0)],
  ['oom without kill', record(2, 1, 0)],
  ['kill without max', record(0, 1, 1)],
] as const)
  test(name + ' supplies no affirmative witness', (t) => {
    const k = kernel(t),
      w = k.start();
    w.arm();
    k.write(body);
    k.notify();
    assert.equal(w.finish(), undefined);
  });
test('pre-start activity is the fresh baseline, never a new attempt witness', (t) => {
  const k = kernel(t),
    w = k.start();
  k.write(record(2, 1, 1));
  k.notify();
  w.arm();
  assert.equal(w.finish(), undefined);
});
test('init PID disappearance alone preserves the bound exact kernel object; no substitute PID/group is used', (t) => {
  const k = kernel(t),
    w = k.start();
  w.arm();
  fs.rmSync(k.proc, { recursive: true });
  k.write(record(2, 1, 1));
  k.notify();
  assert.ok(w.finish());
});
for (const [name, mutate] of [
  ['PID reuse', (k: any) => k.setProcess('78')],
  ['PID migration', (k: any) => k.setProcess('77', '/system.slice/other.scope')],
  ['leaf removed', (k: any) => fs.rmSync(k.leaf, { recursive: true })],
  ['events removed', (k: any) => fs.unlinkSync(join(k.leaf, 'memory.events.local'))],
  [
    'events inode replaced',
    (k: any) => {
      fs.renameSync(join(k.leaf, 'memory.events.local'), join(k.leaf, 'old'));
      k.write(record(20, 1, 1));
    },
  ],
  [
    'leaf inode replaced',
    (k: any) => {
      fs.renameSync(k.leaf, k.leaf + '-old');
      fs.mkdirSync(k.leaf);
      k.write(record(20, 1, 1));
      fs.writeFileSync(join(k.leaf, 'memory.max'), String(LIMIT));
    },
  ],
  ['wrong limit', (k: any) => fs.writeFileSync(join(k.leaf, 'memory.max'), 'max\n')],
  [
    'ancestor link',
    (k: any) => {
      fs.renameSync(join(k.cg, 'system.slice'), join(k.cg, 'old'));
      fs.symlinkSync(join(k.cg, 'old'), join(k.cg, 'system.slice'));
    },
  ],
  ['untrusted ownership', (k: any) => k.wrongUid()],
  ['writable leaf', (k: any) => fs.chmodSync(k.leaf, 0o777)],
] as const)
  test(name + ' invalidates new evidence and closes handles', (t) => {
    const k = kernel(t),
      w = k.start();
    w.arm();
    k.write(record(20, 1, 1));
    mutate(k);
    k.notify();
    assert.equal(w.finish(), undefined);
    assert.equal(k.held.size, 0);
    assert.equal(w.observation().state, 'raced');
  });
for (const [name, body] of [
  ['duplicate', 'max 2\noom 1\noom_kill 1\noom 1\n'],
  ['negative', 'max -2\noom 1\noom_kill 1\n'],
  ['missing', 'max 20\noom 1\n'],
  ['oversized', 'x'.repeat(4097)],
] as const)
  test('malformed ' + name + ' record is not evidence', (t) => {
    const k = kernel(t),
      w = k.start();
    w.arm();
    k.write(body);
    k.notify();
    assert.equal(w.finish(), undefined);
    assert.equal(k.held.size, 0);
  });
test('a decreased cumulative counter never becomes a fresh baseline', (t) => {
  const k = kernel(t);
  k.write(record(3, 2, 1));
  const w = k.start();
  w.arm();
  k.write(record(2, 3, 2));
  k.notify();
  assert.equal(w.finish(), undefined);
  assert.equal(w.observation().state, 'raced');
});
test('a notification whose read races disappearance records raced, never a positive', (t) => {
  const k = kernel(t),
    w = k.start();
  w.arm();
  k.afterRead((path) => {
    if (path.endsWith('memory.events.local')) fs.unlinkSync(join(k.leaf, 'memory.events.local'));
  });
  k.write(record(20, 1, 1));
  k.notify();
  assert.equal(w.finish(), undefined);
  assert.equal(w.observation().state, 'raced');
  assert.equal(w.observation().reason, 'kernel-object-gone');
});
test('exact leaf identity refuses a substring and never opens parent counters', (t) => {
  const k = kernel(t);
  k.setProcess('77', GROUP + '-other');
  const w = k.start();
  assert.equal(w.finish(), undefined);
  assert.equal(w.observation().state, 'unavailable');
  assert.equal(k.held.size, 0);
});
test('watcher failure closes without fallback', (t) => {
  const k = kernel(t);
  k.watchFailure();
  const failed = k.start();
  assert.equal(failed.finish(), undefined);
  assert.equal(k.held.size, 0);
});
test('notification sampling shares the total128 setup arm and final attempt cap', (t) => {
  const k = kernel(t),
    w = k.start();
  w.arm();
  for (let i = 0; i < CGROUP_MEMORY_BOUNDS.attempts + 2; i++) k.notify();
  assert.equal(w.observation().state, 'exhausted');
  assert.equal(w.observation().samples, CGROUP_MEMORY_BOUNDS.attempts - 2);
  assert.equal(w.observation().attempts, CGROUP_MEMORY_BOUNDS.attempts);
  assert.equal(w.finish(), undefined);
  assert.equal(k.held.size, 0);
});
test('close before arm prevents late samples or a new baseline', (t) => {
  const k = kernel(t),
    w = k.start();
  w.close();
  k.write(record(20, 1, 1));
  w.arm();
  k.notify();
  assert.equal(w.finish(), undefined);
  assert.equal(k.held.size, 0);
});

test('backend witness setup checks all exact owned labels before kernel reads', async (t) => {
  const k = kernel(t),
    labels = {
      owner: 'owner',
      store: 'store',
      attempt: 'attempt',
      epoch: 'epoch',
      invocation: 'sha256:' + 'b'.repeat(64),
    };
  const answer = (value: any) => ({
    exitCode: 0,
    exitSignal: null,
    stdout: Buffer.from(JSON.stringify(value)),
    stderr: Buffer.alloc(0),
    stdoutExceeded: false,
    stderrExceeded: false,
    timedOut: false,
    canceled: false,
    spawnError: null,
  });
  let forge = false;
  const backend = await ContainerBackend.connect({
    privateDir: k.root,
    policy: {
      qualified: [
        {
          host: currentHost(),
          backend: 'docker-engine',
          server: 'linux-amd64',
          status: 'measured',
          evidence: 'unit fixture only',
        },
      ],
    },
    runner: {
      run: async (args: any) => {
        if (args[0] === 'version') return answer({ Os: 'linux', Arch: 'amd64' });
        if (args[0] === 'info')
          return answer({
            OperatingSystem: 'Engine fixture',
            MemoryLimit: true,
            SwapLimit: true,
            CpuCfsQuota: true,
            PidsLimit: true,
            CgroupVersion: '2',
          });
        return answer({
          Id: ID,
          Config: {
            Labels: Object.fromEntries(
              Object.entries(labels).map(([key, value]) => [
                (LABELS as any)[key],
                forge && key === 'invocation' ? 'sha256:' + 'f'.repeat(64) : value,
              ]),
            ),
          },
          State: { Running: true, Pid: PID },
        });
      },
    } as any,
  });
  assert.equal(backend.supportsLocalMemoryWitness, process.platform === 'linux' && currentHost() === 'linux-x64');
  // Exercise exact-owned setup on every host; this override simulates ONLY the native platform gate, not kernel qualification.
  Object.defineProperty(backend, 'supportsLocalMemoryWitness', { value: true });
  const watch = await backend.prepareMemoryWitness(ID, labels, LIMIT, new AbortController().signal);
  assert.ok(watch);
  watch.close();
  const opened = k.opened.length;
  assert.equal(
    await backend.prepareMemoryWitness(ID, { owner: labels.owner } as any, LIMIT, new AbortController().signal),
    undefined,
    'all five owned labels are mandatory',
  );
  forge = true;
  assert.equal(await backend.prepareMemoryWitness(ID, labels, LIMIT, new AbortController().signal), undefined);
  assert.equal(k.opened.length, opened);
});

test('classification preserves raw lifecycle precedence and refuses every unqualified exit shape', (t) => {
  const k = kernel(t),
    w = k.start();
  w.arm();
  k.write(record(20, 1, 1));
  k.notify();
  const e = w.finish()!;
  const facts = {
    ownerHeld: true,
    aborted: false,
    state: 'failed',
    code: 'sentinel.execution.workerExited',
    containerExit: 137,
    clientExit: 137,
    clientSignal: null,
  };
  assert.equal(cgroupMemoryFailure(e, facts), e);
  for (const delta of [
    { ownerHeld: false },
    { aborted: true },
    { state: 'canceled' },
    { state: 'timed-out' },
    { state: 'succeeded' },
    { code: 'sentinel.execution.canceled' },
    { code: 'sentinel.execution.deadlineExceeded' },
    { code: 'sentinel.execution.cleanupFailed' },
    { code: 'sentinel.execution.protocolViolation' },
    { code: 'sentinel.execution.stdoutBudget' },
    { code: 'sentinel.execution.stderrBudget' },
    { containerExit: 0 },
    { containerExit: null },
    { containerExit: undefined },
    { clientExit: 0 },
    { clientExit: null },
    { clientSignal: 'SIGKILL' },
  ]) {
    assert.equal(cgroupMemoryFailure(e, { ...facts, ...delta } as any), undefined, JSON.stringify(delta));
  }
  assert.equal(cgroupMemoryFailure(undefined, facts), undefined, '137 alone never supplies evidence');
});

test('missing local counters never fall back to hierarchical or parent positives', (t) => {
  const k = kernel(t);
  fs.unlinkSync(join(k.leaf, 'memory.events.local'));
  fs.writeFileSync(join(k.leaf, 'memory.events'), record(20, 1, 1));
  fs.writeFileSync(join(k.cg, 'memory.events.local'), record(20, 1, 1));
  const w = k.start();
  assert.equal(w.finish(), undefined);
  assert.equal(k.held.size, 0);
  assert.equal(w.observation().state, 'unavailable');
});
test('a symlink counter file or non-kernel root cannot supply a baseline', (t) => {
  const k = kernel(t);
  fs.renameSync(join(k.leaf, 'memory.events.local'), join(k.leaf, 'elsewhere'));
  fs.symlinkSync(join(k.leaf, 'elsewhere'), join(k.leaf, 'memory.events.local'));
  const linked = k.start();
  assert.equal(linked.finish(), undefined);
  assert.equal(k.held.size, 0);
  (cgroupMemoryIo as any).statfsSync = () => ({ type: 123 });
  const wrong = k.start();
  assert.equal(wrong.finish(), undefined);
  assert.equal(k.held.size, 0);
});
