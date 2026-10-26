// Pure daemon evidence controls: 137 is ambiguous; only an affirmative, currently owned observation proves OOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerBackend, LABELS } from '../dist/execution/isolation.js';
import { currentHost } from '../dist/store/runtime.js';
import { delayedOomInspects } from './container-state-fixtures.ts';
import { scratch, removeScratch } from './execution-helpers.ts';
const ID = 'e'.repeat(64),
  OWNER = { owner: 'state-observation-owner' };
const result = (stdout: string, exitCode = 0) => ({
  exitCode,
  exitSignal: null,
  stdout: Buffer.from(stdout),
  stderr: Buffer.from(exitCode ? 'No such container' : ''),
  stdoutExceeded: false,
  stderrExceeded: false,
  timedOut: false,
  canceled: false,
  spawnError: null,
});
async function backend(
  t: any,
  inspect: (ordinal: number, signal?: AbortSignal) => Promise<any> | any,
  wrap = (r: any) => r,
) {
  const s = scratch('state-settling');
  t.after(() => removeScratch(s.root));
  let count = 0;
  const runner: any = {
    run: async (args: string[], signal?: AbortSignal) => {
      if (args[0] === 'version') return result(JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: 'stand-in' }));
      if (args[0] === 'info')
        return result(
          JSON.stringify({
            OperatingSystem: 'Engine',
            MemoryLimit: true,
            SwapLimit: true,
            CpuCfsQuota: true,
            PidsLimit: true,
          }),
        );
      return inspect(++count, signal);
    },
  };
  const value = await ContainerBackend.connect({
    privateDir: s.root,
    runner: wrap(runner),
    policy: {
      qualified: [
        {
          host: currentHost(),
          backend: 'docker-engine',
          server: 'linux-arm64',
          status: 'measured',
          evidence: 'state fixture',
        },
      ],
    },
  });
  return { value, count: () => count };
}
const state = (oom: boolean, labels = { [LABELS.owner]: OWNER.owner }) =>
  result(
    JSON.stringify({ Id: ID, Config: { Labels: labels }, State: { Status: 'exited', ExitCode: 137, OOMKilled: oom } }),
  );

test('a delayed affirmative owned OOM observation settles, while persistent 137 stays unknown', async (t) => {
  const late = await backend(t, (n) => state(n >= 3));
  assert.equal((await late.value.state(ID, OWNER))?.oomKilled, true);
  assert.equal(late.count(), 3);
  const unknown = await backend(t, () => state(false));
  assert.deepEqual(await unknown.value.state(ID, OWNER), { status: 'exited', exitCode: 137, oomKilled: false });
  assert.equal(unknown.count(), 4);
});

test('absence, cancellation and lost ownership stop settling without accepting stale affirmative evidence', async (t) => {
  const absent = await backend(t, (n) => (n === 1 ? state(false) : result('', 1)));
  assert.equal(await absent.value.state(ID, OWNER), null);
  assert.equal(absent.count(), 2);
  const changed = await backend(t, (n) => state(n > 1, { [LABELS.owner]: n === 1 ? OWNER.owner : 'unrelated' }));
  await assert.rejects(changed.value.state(ID, OWNER), (e: any) => e.code === 'sentinel.execution.cleanupFailed');
  assert.equal(changed.count(), 2);
  const ac = new AbortController();
  const canceled = await backend(t, (n) => {
    if (n === 1) setTimeout(() => ac.abort(), 10);
    return state(false);
  });
  assert.equal(await canceled.value.state(ID, OWNER, ac.signal), null);
  await new Promise((r) => setTimeout(r, 75));
  assert.equal(canceled.count(), 1);
});

test('a stuck or late client cannot extend the final-state window or resurrect OOM evidence', async (t) => {
  let release!: () => void;
  const stuck = await backend(
    t,
    () =>
      new Promise((resolve) => {
        release = () => resolve(state(true));
      }),
  );
  const start = performance.now();
  assert.equal(await stuck.value.state(ID, OWNER), null);
  assert.ok(performance.now() - start < 1000, 'bounded independently of a misbehaving client');
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stuck.count(), 1);
  const ac = new AbortController();
  ac.abort();
  assert.equal(await stuck.value.state(ID, OWNER, ac.signal), null);
  assert.equal(stuck.count(), 1);
});

test('the native delay adapter counts initial terminal observations, including real false flags', async (t) => {
  let delayed!: ReturnType<typeof delayedOomInspects>;
  const naturalDelay = await backend(
    t,
    (n) => state(n >= 3),
    (runner) => (delayed = delayedOomInspects(runner)).runner,
  );
  assert.deepEqual(await naturalDelay.value.state(ID, OWNER), { status: 'exited', exitCode: 137, oomKilled: true });
  assert.equal(naturalDelay.count(), 3);
  assert.deepEqual(
    delayed.observations.map((o) => [o.rawOomKilled, o.masked]),
    [
      [false, true],
      [false, true],
      [true, false],
    ],
  );
  const immediate = await backend(
    t,
    () => state(true),
    (runner) => (delayed = delayedOomInspects(runner)).runner,
  );
  assert.equal((await immediate.value.state(ID, OWNER))?.oomKilled, true);
  assert.equal(immediate.count(), 3, 'two hidden observations followed by one genuine affirmative observation');
  const noOom = await backend(
    t,
    () => state(false),
    (runner) => delayedOomInspects(runner).runner,
  );
  assert.deepEqual(await noOom.value.state(ID, OWNER), { status: 'exited', exitCode: 137, oomKilled: false });
  assert.equal(noOom.count(), 4, 'the adapter cannot invent OOM from a SIGKILL-shaped exit');
});
