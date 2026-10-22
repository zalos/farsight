// Container lifecycle faults the real daemon will not produce on demand, through a daemon stand-in behind the
// package-internal DockerRunner seam: a create whose output is lost, a create that fails after the daemon made
// the container, a removal the daemon refuses, a name collision, cancellation and a store closed mid-create.
// Always run; no container runtime is used.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ContainerBackend, LABELS, containerName } from '../dist/execution/isolation.js';
import { DEFAULT_ADAPTER_LIMITS, createAdapterRegistry } from '../dist/execution/registry.js';
import { superviseAttempt } from '../dist/execution/supervisor.js';
import { runBoundedSync, succeeded, spawnWorker } from '../dist/execution/processes.js';
import { isExecutionError } from '../dist/execution/errors.js';
import { currentHost } from '../dist/store/runtime.js';
import { boundOwner } from '../dist/store/owner-binding.js';
import { inputs, removeScratch, scratch, storeIn, work } from './execution-helpers.ts';

const PIN = `example/tool@sha256:${'e'.repeat(64)}`;
const policy = { qualified: [{ host: currentHost(), backend: 'docker-engine' as const, server: 'linux-arm64', status: 'measured' as const, evidence: 'stand-in' }] };
const result = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, exitSignal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr),
  stdoutExceeded: false, stderrExceeded: false, timedOut: false, canceled: false, spawnError: null });
const is = (code: string) => (e: unknown) => isExecutionError(e) && e.code === code;

/** A tiny daemon: containers by id and name, labels, and switchable faults. */
function standIn(faults: { createOutput?: 'lost' | 'error'; rmFails?: boolean; createDelayMs?: number } = {}) {
  const containers = new Map<string, { Id: string; Name: string; Config: { Labels: Record<string, string>; Image: string }; State: { Running: boolean } }>();
  const find = (ref: string) => [...containers.values()].find(c => c.Id === ref || c.Name === ref);
  const handle = (args: readonly string[]) => {
    const [cmd, ...rest] = args;
    if (cmd === 'version') return result(0, JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: 'stand-in' }));
    if (cmd === 'info') return result(0, JSON.stringify({ OperatingSystem: 'Stand-in Engine', MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true, CgroupVersion: '2' }));
    if (cmd === 'image') return result(0, JSON.stringify({ Id: `sha256:${'e'.repeat(64)}`, Os: 'linux', Architecture: 'arm64', RepoDigests: [PIN], Config: { Env: [] } }));
    if (cmd === 'create') {
      const labels: Record<string, string> = {};
      let name = '';
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--label') { const [k, ...v] = rest[++i]!.split('='); labels[k!] = v.join('='); }
        if (rest[i] === '--name') name = rest[++i]!;
      }
      const id = randomBytes(32).toString('hex');
      containers.set(id, { Id: id, Name: name, Config: { Labels: labels, Image: PIN }, State: { Running: false } });
      if (faults.createOutput === 'lost') return result(0, '');
      if (faults.createOutput === 'error') return result(1, '', 'Error response from daemon: synthetic failure after creation');
      return result(0, `${id}\n`);
    }
    if (cmd === 'inspect') {
      const ref = rest.at(-1)!;
      const c = find(ref);
      return c ? result(0, JSON.stringify(c)) : result(1, '', `Error: No such container: ${ref}`);
    }
    if (cmd === 'ps') {
      const filter = rest[rest.indexOf('--filter') + 1]!.replace(/^label=/, '');
      const [k, ...v] = filter.split('=');
      return result(0, [...containers.values()].filter(c => c.Config.Labels[k!] === v.join('=')).map(c => c.Id).join('\n'));
    }
    if (cmd === 'rm') {
      if (faults.rmFails) return result(1, '', 'Error response from daemon: synthetic removal refusal');
      containers.delete(rest.at(-1)!);
      return result(0, rest.at(-1)!);
    }
    if (cmd === 'kill') return result(0, '');
    return result(1, '', `unhandled ${cmd}`);
  };
  const runner = {
    run: async (args: readonly string[]) => {
      if (args[0] === 'create' && faults.createDelayMs) await new Promise(r => setTimeout(r, faults.createDelayMs));
      return handle(args);
    },
    runSync: (args: readonly string[]) => handle(args),
    start: () => spawnWorker(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: {} }),
  };
  return { containers, runner, faults };
}

const s = scratch('faults');
after(() => removeScratch(s.root));
const spec = (owner = `nonce-${randomBytes(4).toString('hex')}`) => ({
  image: { reference: PIN, id: `sha256:${'e'.repeat(64)}`, os: 'linux', architecture: 'arm64', env: [] },
  command: ['tool'], limits: { ...DEFAULT_ADAPTER_LIMITS }, inputDir: s.work, outputDir: s.work,
  labels: { owner, store: 'store-1', attempt: 'att-1', epoch: 'epoch-1', invocation: `sha256:${'a'.repeat(64)}` },
  adapter: { id: 'tool', digest: `sha256:${'b'.repeat(64)}` }, user: '501:20',
});
const connect = (d: ReturnType<typeof standIn>) => ContainerBackend.connect({ privateDir: s.root, policy, runner: d.runner as any });

test('a create whose output is lost is reconciled by name and labels; nothing is left', async () => {
  const d = standIn({ createOutput: 'lost' });
  const b = await connect(d);
  await assert.rejects(b.create(spec()), is('sentinel.execution.commandFailed'));
  assert.equal(d.containers.size, 0);
});

test('a create that fails after the daemon made the container leaves nothing', async () => {
  const d = standIn({ createOutput: 'error' });
  const b = await connect(d);
  await assert.rejects(b.create(spec()), is('sentinel.execution.commandFailed'));
  assert.equal(d.containers.size, 0);
});

test('when the removal is refused, the failure keeps the container identity and nothing is claimed removed', async () => {
  const d = standIn({ createOutput: 'lost', rmFails: true });
  const b = await connect(d);
  const sp = spec();
  await assert.rejects(b.create(sp), (e: unknown) => is('sentinel.execution.cleanupFailed')(e)
    && (e as any).detail.name === containerName(sp.labels.owner) && (e as any).detail.owner === sp.labels.owner
    && (e as any).detail.store === 'store-1' && (e as any).detail.attempt === 'att-1' && (e as any).detail.epoch === 'epoch-1'
    && String((e as any).detail.container).includes([...d.containers.keys()][0]!));
  assert.equal(d.containers.size, 1, 'the container the daemon kept is reported, not forgotten');
});

test('a container under the generated name but with other labels is never removed', async () => {
  const d = standIn({ createOutput: 'lost' });
  const b = await connect(d);
  const sp = spec();
  // Someone else's container already holds the name; the stand-in's create still adds ours with our labels.
  d.containers.set('f'.repeat(64), { Id: 'f'.repeat(64), Name: containerName(sp.labels.owner), Config: { Labels: { [LABELS.owner]: 'someone-else' }, Image: PIN }, State: { Running: false } });
  await assert.rejects(b.create(sp), is('sentinel.execution.cleanupFailed'));
  assert.ok(d.containers.has('f'.repeat(64)), 'the unrelated container is untouched');
  assert.equal(d.containers.size, 1, 'ours, found by its labels, was removed');
});

test('a cancellation during a create lets it finish, then removes what it made', async () => {
  const d = standIn({ createDelayMs: 100 });
  const b = await connect(d);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(b.create(spec(), ac.signal), is('sentinel.execution.canceled'));
  assert.equal(d.containers.size, 0);
});

test('a store closed while a create is in flight leaves no container and no success', async () => {
  for (const faults of [{ createDelayMs: 200 }, { createDelayMs: 200, createOutput: 'lost' as const }]) {
    const d = standIn(faults);
    const b = await connect(d);
    const other = scratch('faults-close');
    const st = await storeIn(other.root);
    const registry = createAdapterRegistry([{ id: 'tool', version: '1', kind: 'external', isolation: 'container', image: PIN, command: ['tool'] }]);
    const pending = superviseAttempt({ owner: boundOwner(st), registry, adapterId: 'tool', attemptId: 'attempt-close', work, inputs: inputs(other.root),
      scratchRoot: other.work, backend: b }).then(o => ({ o }), (e: unknown) => ({ e }));
    await new Promise(r => setTimeout(r, 50));
    st.close();
    const done = await pending;
    assert.equal(d.containers.size, 0, JSON.stringify(faults));
    if ('o' in done) assert.notEqual(done.o.state, 'succeeded');
    removeScratch(other.root);
  }
});

test('a synchronous run holds each stream to its own limit', () => {
  const r = runBoundedSync(process.execPath, ['-e', 'process.stdout.write("o".repeat(100)); process.stderr.write("e".repeat(2048))'],
    { env: {}, timeoutMs: 10_000, maxStdoutBytes: 4096, maxStderrBytes: 1024 });
  assert.equal(r.stderrExceeded, true);
  assert.equal(r.stderr.byteLength, 1024);
  assert.equal(r.stdoutExceeded, false);
  assert.equal(succeeded(r), false);
  const big = runBoundedSync(process.execPath, ['-e', 'process.stdout.write("o".repeat(8192))'], { env: {}, timeoutMs: 10_000, maxStdoutBytes: 4096, maxStderrBytes: 1024 });
  assert.equal(big.stdoutExceeded, true);
  assert.equal(big.stdout.byteLength, 4096);
});
