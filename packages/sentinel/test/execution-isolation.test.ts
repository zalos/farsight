// Real-container isolation canaries. They run only with SENTINEL_ISOLATION=1 (the dedicated CI job sets it);
// there, a missing or unqualified container runtime or a missing pinned image is a failure, never a skip.
// Without it, only these real-container cases skip, with the reason below; the pure argument and validation
// checks at the top always run.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { ContainerBackend, createArgs, validateContainer, LABELS, ISOLATION_POLICY, isolationQualification } from '../dist/execution/isolation.js';
import { createAdapterRegistry, DEFAULT_ADAPTER_LIMITS } from '../dist/execution/registry.js';
import { createExecutionService } from '../dist/execution/service.js';
import { delayedOomInspects } from './container-state-fixtures.ts';
import { diagnosticRunner, preserveDiagnosticOutcome } from './helpers/isolation-diagnostic.ts';
import { isExecutionError } from '../dist/execution/errors.js';
import { inputs, removeScratch, runAttempt, scratch, storeIn, work, WORKER } from './execution-helpers.ts';

/** node:22-alpine as an OCI index pinned by digest (linux/arm64 and linux/amd64). Installed ahead; never pulled here. */
export const CANARY_IMAGE = 'node@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9';
const enabled = process.env.SENTINEL_ISOLATION === '1';
const skip = !enabled && 'real-container canary: set SENTINEL_ISOLATION=1 with a qualified local Docker and the pinned canary image installed';
const is = (code: string) => (e: unknown) => isExecutionError(e) && e.code === code;

const spec = {
  image: { reference: CANARY_IMAGE, id: `sha256:${'9'.repeat(64)}`, os: 'linux', architecture: 'arm64', env: ['PATH=/usr/bin'] },
  command: ['node', '-e', '0'], limits: { ...DEFAULT_ADAPTER_LIMITS }, inputDir: '/private/in', outputDir: '/private/out',
  labels: { owner: 'nonce', store: 'store-1', attempt: 'att-1', epoch: 'epoch-1', invocation: `sha256:${'a'.repeat(64)}` },
  adapter: { id: 'tool', digest: `sha256:${'b'.repeat(64)}` }, user: '501:20',
};

test('the create arguments pin every isolation control and never pull', () => {
  const args = createArgs(spec, 'arm64');
  const flag = (name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
  assert.deepEqual(flag('--pull'), ['never']);
  assert.deepEqual(flag('--network'), ['none']);
  assert.deepEqual(flag('--user'), ['501:20']);
  assert.deepEqual(flag('--cap-drop'), ['ALL']);
  assert.deepEqual(flag('--security-opt'), ['no-new-privileges:true']);
  assert.deepEqual(flag('--memory'), flag('--memory-swap'));
  assert.deepEqual(flag('--log-driver'), ['none']);
  assert.ok(args.includes('--read-only') && args.includes('--init'));
  assert.deepEqual(flag('--mount'), ['type=bind,source=/private/in,target=/input,readonly', 'type=bind,source=/private/out,target=/output']);
  assert.ok(!args.some(a => /docker\.sock|privileged|host/.test(a)), 'no socket, privilege or host namespace');
  assert.equal(args.at(-3), CANARY_IMAGE);
});

test('a container whose settings differ from the spec is refused, naming the setting', () => {
  const good = {
    Id: 'c'.repeat(64), Image: `sha256:${'9'.repeat(64)}`,
    Config: { Image: CANARY_IMAGE, User: '501:20', OpenStdin: true, Tty: false, Env: ['PATH=/usr/bin', 'HOME=/tmp', 'SENTINEL_INPUT=/input', 'SENTINEL_OUTPUT=/output', 'SENTINEL_ADAPTER_ID=tool', `SENTINEL_ADAPTER_DIGEST=sha256:${'b'.repeat(64)}`],
      Labels: { [LABELS.owner]: 'nonce', [LABELS.store]: 'store-1', [LABELS.attempt]: 'att-1', [LABELS.epoch]: 'epoch-1', [LABELS.invocation]: `sha256:${'a'.repeat(64)}` } },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], IpcMode: 'none',
      Memory: spec.limits.memoryBytes, MemorySwap: spec.limits.memoryBytes, NanoCpus: spec.limits.cpus * 1e9, PidsLimit: spec.limits.pids,
      LogConfig: { Type: 'none' }, Init: true, Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${spec.limits.tmpfsBytes},mode=1777` },
      Ulimits: [{ Name: 'fsize', Soft: spec.limits.outputBytes, Hard: spec.limits.outputBytes }, { Name: 'core', Soft: 0, Hard: 0 }] },
    Mounts: [{ Type: 'bind', Source: '/private/in', Destination: '/input', RW: false }, { Type: 'bind', Source: '/private/out', Destination: '/output', RW: true }],
  };
  validateContainer(good, spec);
  const variants: Array<[string, (c: any) => void]> = [
    ['network', c => { c.HostConfig.NetworkMode = 'bridge'; }],
    ['read-only root', c => { c.HostConfig.ReadonlyRootfs = false; }],
    ['mounts', c => { c.Mounts.push({ Type: 'bind', Destination: '/var/run/docker.sock', RW: true }); }],
    ['mounts', c => { c.Mounts[0].RW = true; }],
    ['environment', c => { c.Config.Env.push('SSH_AUTH_SOCK=/tmp/agent'); }],
    ['label epoch', c => { c.Config.Labels[LABELS.epoch] = 'epoch-other'; }],
    ['privileged', c => { c.HostConfig.Privileged = true; }],
    ['capabilities', c => { c.HostConfig.CapAdd = ['NET_ADMIN']; }],
    ['memory', c => { c.HostConfig.MemorySwap = -1; }],
    ['user', c => { c.Config.User = '0:0'; }],
    ['image id', c => { c.Image = `sha256:${'8'.repeat(64)}`; }],
    ['mount source', c => { c.Mounts[0].Source = '/private/elsewhere'; }],
    ['mount source', c => { c.Mounts[1].Source = '/private/in'; }],
    ['ulimits', c => { c.HostConfig.Ulimits = []; }],
    ['ulimits', c => { c.HostConfig.Ulimits[0].Hard = spec.limits.outputBytes * 2; }],
    ['ulimits', c => { c.HostConfig.Ulimits.push({ Name: 'nofile', Soft: 1_000_000, Hard: 1_000_000 }); }],
    ['environment', c => { c.Config.Env.push('NODE_OPTIONS=--inspect'); }],
  ];
  for (const [setting, change] of variants) {
    const c = structuredClone(good); change(c);
    assert.throws(() => validateContainer(c, spec), (e: unknown) => is('sentinel.execution.isolationMismatch')(e) && (e as any).detail.setting === setting, setting);
  }
});

test('isolation qualification is exact host, runtime and server triples', () => {
  assert.equal(isolationQualification(ISOLATION_POLICY, 'darwin-arm64', 'docker-desktop', 'linux-arm64')?.status, 'measured');
  assert.equal(isolationQualification(ISOLATION_POLICY, 'linux-x64', 'docker-engine', 'linux-amd64')?.status, 'measured');
  assert.equal(isolationQualification(ISOLATION_POLICY, 'darwin-arm64', 'docker-engine', 'linux-arm64'), undefined);
  assert.equal(isolationQualification(ISOLATION_POLICY, 'darwin-arm64', 'docker-desktop', 'linux-amd64'), undefined, 'no emulation');
  assert.equal(isolationQualification(ISOLATION_POLICY, 'linux-arm64', 'docker-engine', 'linux-arm64'), undefined);
});

// Real containers from here on.
const s = scratch('isolation');
let store: Awaited<ReturnType<typeof storeIn>>;
let backend: ContainerBackend;
const source = readFileSync(WORKER, 'utf8');
const captured = inputs(s.root);
const secret = join(s.work, 'secret-canary.txt');
writeFileSync(secret, 'synthetic canary that no worker may read\n');
// Proxy settings in Sentinel's own environment must not reach the daemon's effects or a container.
const PROXY_ENV = { HTTP_PROXY: 'http://192.0.2.1:3128', HTTPS_PROXY: 'http://192.0.2.1:3128', NO_PROXY: '*', http_proxy: 'http://192.0.2.1:3128' };
before(async () => {
  if (!enabled) return;
  Object.assign(process.env, PROXY_ENV);
  store = await storeIn(s.root);
  backend = await ContainerBackend.connect({ privateDir: s.root });
});
after(() => { try { store?.close(); } catch { /* reported by its own test */ } removeScratch(s.root); });

let n = 0;
const clamp = (l: Record<string, number>) => ({ ...l, helloTimeoutMs: Math.min(l.helloTimeoutMs!, l.timeoutMs!), cancelGraceMs: Math.min(l.cancelGraceMs!, l.timeoutMs!) });
function registryFor(behaviour: string, limits: Record<string, number> = {}, argument?: string) {
  return createAdapterRegistry([{
    id: `canary-${behaviour}`, version: '0.0.0-test', kind: 'external', isolation: 'container', image: CANARY_IMAGE,
    command: ['node', '--input-type=module', '-e', source, behaviour, ...(argument ? [argument] : [])],
    limits: clamp({ timeoutMs: 30_000, cancelGraceMs: 2_000, helloTimeoutMs: 15_000, memoryBytes: 256 * 1024 * 1024, pids: 64, tmpfsBytes: 16 * 1024 * 1024, ...limits }),
  }]);
}
const run = (behaviour: string, limits: Record<string, number> = {}, argument?: string, signal?: AbortSignal) =>
  runAttempt(store, s.work, registryFor(behaviour, limits, argument),
    { adapterId: `canary-${behaviour}`, attemptId: `attempt-c${++n}`, work, inputs: captured, ...(signal ? { signal } : {}) }, true);
const docker = (...args: string[]) => spawnSync(backendDocker(), args, { encoding: 'utf8', env: { ...process.env } });
const backendDocker = () => ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker'].find(p => spawnSync(p, ['--version']).status === 0)!;
const absent = (id: string) => /no such (container|object)/i.test(docker('inspect', '--type', 'container', id).stderr);
const canary = (text: string) => JSON.parse(/canary (\{.*\})/.exec(text)?.[1] ?? '{}');

// Optional bounded observations of these original attempts. The suite command, expectations, worker bytes,
// delayed mask, grants and test-file concurrency stay unchanged. Tracing perturbs timing; hooks retain evidence
// even when an original assertion fails, and a passing trace cannot explain a historical failure.
const tracing = process.env.SENTINEL_ISOLATION_DIAGNOSTIC === '1';
let traceCount = 0;
function traceContext(t: any, kind: string) {
  let trace: ReturnType<typeof diagnosticRunner> | undefined, outcome: any, error: any, facts: any;
  let saved: Promise<void> | undefined;
  const flush = () => !tracing ? Promise.resolve() : saved ??= preserveDiagnosticOutcome(retain,message=>t.diagnostic(`native diagnostic unavailable ${kind}: ${message}`));
  async function retain() {
    const directory = process.env.SENTINEL_DIAGNOSTIC_OUT!;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const report = { kind, workerSha256: createHash('sha256').update(source).digest('hex'), image: CANARY_IMAGE, backend: facts,
      outcome: outcome && { state: outcome.state, code: outcome.code, detail: outcome.detail, exit: outcome.exit,
        container: outcome.container, cleanup: outcome.cleanup, stopConfirmed: outcome.stopConfirmed, protocol: outcome.protocol,
        diagnostics: { bytes: outcome.diagnostics.bytes, truncated: outcome.diagnostics.truncated },
        invocationLimits: outcome.invocation?.record?.limits },
      error: error && { name: error.name, code: error.code },
      trace: trace ? await trace.finish() : { unavailable: 'backend wrapper not reached' } };
    writeFileSync(join(directory, `${kind}.json`), JSON.stringify(report, null, 2)+'\n', { mode: 0o600, flag: 'wx' });
    t.diagnostic(`retained native diagnostic ${kind}: ${JSON.stringify({ code: outcome?.code, container: outcome?.container?.id, traceDropped: (report.trace as any).dropped })}`);
  }
  if (tracing) {
    assert.ok(process.env.SENTINEL_DIAGNOSTIC_OUT, 'explicit private evidence directory required');
    assert.ok(++traceCount <= 4, 'only the original three memory calls and plain SIGKILL are observed');
    t.after(flush);
  }
  return {
    flush,
    wrapRunner: (real: any) => tracing ? (trace = diagnosticRunner(real)).runner : real,
    result: (value: any) => { outcome = value; return value; },
    failed: (value: any) => { error = value; },
    backend: (value: any) => { facts = value; },
  };
}
async function observedAttempt(t: any, kind: string, registry: any, attempt: any) {
  if (!tracing) return runAttempt(store, s.work, registry, attempt, true);
  const context = traceContext(t, kind);
  try {
    const service = await createExecutionService(store, { scratchRoot: s.work, registry, containers: true, wrapRunner: context.wrapRunner });
    context.backend(service.backend?.facts);
    return context.result(await service.run(attempt));
  } catch (error) { context.failed(error); throw error; }
  finally { await context.flush(); }
}

// Keep a failing native runner honest: report bounded daemon event facts, rather than infer OOM from 137.
function memoryEvidence(t: any, outcome: any) {
  if (outcome.code === 'sentinel.execution.resourceExceeded') return;
  const id = outcome.container?.id;
  if (!/^[0-9a-f]{64}$/.test(id ?? '')) return;
  const result = spawnSync(backendDocker(), ['events', '--since', new Date(Date.now() - 60_000).toISOString(),
    '--until', new Date().toISOString(), '--filter', `container=${id}`, '--format', '{{json .}}'],
  { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, env: { ...process.env } });
  const events = [];
  for (const line of (result.stdout ?? '').split('\n').filter(Boolean).slice(0, 32)) {
    try { const event = JSON.parse(line); if (event.Actor?.ID === id) events.push({ action: event.Action, timeNano: event.timeNano }); } catch { /* diagnostic only */ }
  }
  t.diagnostic(`unconfirmed memory canary ${JSON.stringify({ code: outcome.code, container: id, state: outcome.container?.state, events, eventQueryStatus: result.status })}`);
}

test('the backend is a qualified local runtime; its facts are printed for the run log', { skip }, t => {
  const f = backend.facts;
  t.diagnostic(`sentinel-isolation-qualification host=${f.host} backend=${f.backend} server=${f.server} engine=${f.serverVersion} os=${JSON.stringify(f.operatingSystem)} cgroup=${f.cgroupVersion} status=${f.qualification.status}`);
  assert.ok(isolationQualification(ISOLATION_POLICY, f.host, f.backend, f.server));
});

test('an honest worker in a container succeeds and its container is removed by exact identity', { skip }, async () => {
  const o = await run('ok');
  assert.equal(o.state, 'succeeded', JSON.stringify({ code: o.code, detail: o.detail, stderr: o.diagnostics.text.slice(0, 400) }));
  assert.equal(o.worker?.kind, 'owned-container');
  assert.deepEqual((o.worker as any).ownershipLabels, { store: store.storeId, attempt: o.attemptId, epoch: store.epoch });
  assert.equal(o.cleanup, 'removed-owned-container');
  assert.ok(absent(o.container!.id));
  assert.equal(o.outputs.length, 1);
});

test('a refused pre-start attempt removes only its confirmed-stopped container and scratch', { skip }, async () => {
  const attemptId = `attempt-c${++n}`;
  let owned = '';
  const error = Object.assign(new Error('synthetic invocation write exceeded its unit deadline'), { code: 'sentinel.execution.deadlineExceeded' });
  await assert.rejects(runAttempt(store, s.work, registryFor('ok'), {
    adapterId: 'canary-ok', attemptId, work, inputs: captured,
    onWorker: async (worker: any) => { owned = worker.containerId; await Promise.resolve(); throw error; },
  }, true), e => e === error);
  assert.ok(owned && absent(owned));
  assert.deepEqual(readdirSync(s.work).filter(name => name.startsWith(`${attemptId}-`)), []);
});

test('network canary: egress and name lookup fail, and the attempt is a recorded failure', { skip }, async t => {
  const o = await run('network');
  const report = canary(o.diagnostics.text);
  t.diagnostic(`network canary ${JSON.stringify(report)}`);
  assert.equal(o.code, 'sentinel.execution.workerExited', JSON.stringify(report));
  assert.ok(report.tcp && report.tcp !== 'ESCAPED' && report.dns && report.dns !== 'ESCAPED', JSON.stringify(report));
  assert.equal(o.cleanup, 'removed-owned-container');
});

test('host-file canary: no host path, sibling file, daemon socket or writable input/root is reachable', { skip }, async t => {
  const o = await run('hostfile', {}, secret);
  const report = canary(o.diagnostics.text);
  t.diagnostic(`host-file canary ${JSON.stringify({ ...report, environment: (report.environment ?? []).join(' ') })}`);
  assert.equal(o.code, 'sentinel.execution.workerExited', JSON.stringify(report));
  for (const k of ['hostPath', 'besideAttempt', 'dockerSocket', 'writeInput', 'writeRoot']) assert.ok(report[k] && report[k] !== 'ESCAPED', `${k}: ${report[k]}`);
  const leaked = (report.environment as string[]).filter(name => /^(USER|LOGNAME|SSH_|DOCKER_|GIT_|AWS_|GITHUB_|NPM_|PNPM_|CI$)|PROXY/i.test(name));
  assert.deepEqual(leaked, []);
});

test('resource canaries: memory, processes and temporary storage are bounded', { skip }, async t => {
  const memory = await observedAttempt(t, 'ordinary-memory', registryFor('memory', { memoryBytes: 64 * 1024 * 1024 }),
    { adapterId: 'canary-memory', attemptId: `attempt-c${++n}`, work, inputs: captured });
  memoryEvidence(t, memory);
  assert.equal(memory.code, 'sentinel.execution.resourceExceeded', JSON.stringify({ code: memory.code, c: memory.container?.state }));
  assert.equal(memory.container?.state?.oomKilled, true);
  const pids = await run('pids', { pids: 16 });
  const forked = canary(pids.diagnostics.text);
  assert.notEqual(pids.state, 'succeeded');
  assert.ok(typeof forked.started === 'number' && forked.started < 16, JSON.stringify(forked));
  const tmp = await run('tmpfs', { tmpfsBytes: 1024 * 1024 });
  assert.equal(canary(tmp.diagnostics.text).fillTmp, 'ENOSPC');
  t.diagnostic(`resource canaries oom=${memory.container?.state?.oomKilled} forked=${forked.started}/16 tmpfs=${canary(tmp.diagnostics.text).fillTmp}`);
  for (const o of [memory, pids, tmp]) assert.equal(o.cleanup, 'removed-owned-container');
});

test('a real OOM whose first inspect flags are delayed settles before owned cleanup; plain SIGKILL stays unidentified', { skip }, async t => {
  let delayed!: ReturnType<typeof delayedOomInspects>;
  const context = traceContext(t, 'delayed-memory');
  t.after(() => t.diagnostic(`delayed-OOM raw inspect trace ${JSON.stringify({ terminalReads: delayed?.terminalReads(), observations: delayed?.observations })}`));
  const service = await createExecutionService(store, { scratchRoot: s.work, registry: registryFor('memory', { memoryBytes: 64 * 1024 * 1024 }), containers: true,
    wrapRunner: real => (delayed = delayedOomInspects(context.wrapRunner(real))).runner,
  });
  context.backend(service.backend?.facts);
  const memory = await service.run({ adapterId: 'canary-memory', attemptId: `delayed-oom-${++n}`, work, inputs: captured })
    .then(context.result, error => { context.failed(error); throw error; }).finally(context.flush);
  memoryEvidence(t, memory);
  assert.equal(memory.code, 'sentinel.execution.resourceExceeded', JSON.stringify(memory.container?.state));
  assert.equal(memory.container?.state?.oomKilled, true);
  assert.equal(delayed.observations.filter(o => o.masked).length, 2, 'exactly the first two terminal observations were hidden');
  assert.ok(delayed.observations.some(o => !o.masked && o.rawOomKilled), 'the final classification required a real affirmative daemon observation after the delayed flags');
  assert.equal(memory.cleanup, 'removed-owned-container');
  const killed = await observedAttempt(t, 'plain-sigkill', registryFor('self-sigkill'),
    { adapterId: 'canary-self-sigkill', attemptId: `attempt-c${++n}`, work, inputs: captured });
  assert.equal(killed.container?.state?.exitCode, 137);
  assert.equal(killed.container?.state?.oomKilled, false);
  assert.equal(killed.code, 'sentinel.execution.workerExited');
  assert.equal(killed.cleanup, 'removed-owned-container');
});

test('cancellation during final container observation cannot revive a provisional success', { skip }, async () => {
  const controller = new AbortController();
  const service = await createExecutionService(store, { scratchRoot: s.work, registry: registryFor('ok'), containers: true,
    wrapRunner: real => ({ ...real, run: async (args, signal) => {
      const answer = await real.run(args, signal);
      if (args[0] === 'inspect' && args.includes('--format') && answer.exitCode === 0) {
        const container = JSON.parse(answer.stdout.toString('utf8'));
        if (container.State?.Status === 'exited' && container.State?.ExitCode === 0) controller.abort();
      }
      return answer;
    } }),
  });
  const outcome = await service.run({ adapterId: 'canary-ok', attemptId: `final-cancel-${++n}`, work, inputs: captured, signal: controller.signal });
  assert.equal(controller.signal.aborted, true);
  assert.equal(outcome.state, 'canceled');
  assert.equal(outcome.result, undefined);
  assert.deepEqual(outcome.outputs, []);
  assert.equal(outcome.cleanup, 'removed-owned-container');
});

test('malformed-output canary and deadline: the container itself is stopped and removed', { skip }, async () => {
  const frame = await run('huge-frame');
  assert.equal(frame.code, 'sentinel.execution.frameTooLarge');
  const late = await run('hang', { timeoutMs: 3_000 });
  assert.equal(late.state, 'timed-out');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 2_500);
  const stubborn = await run('ignore-cancel', { cancelGraceMs: 500 }, undefined, ac.signal);
  assert.equal(stubborn.state, 'canceled');
  for (const o of [frame, late, stubborn]) { assert.equal(o.cleanup, 'removed-owned-container'); assert.ok(absent(o.container!.id)); }
});

test('a missing pinned image is refused and never pulled', { skip }, async () => {
  const ref = `farsight-sentinel-intentionally-absent@sha256:${'0'.repeat(64)}`;
  await assert.rejects(backend.inspectImage(ref), is('sentinel.execution.imageMissing'));
  assert.notEqual(docker('image', 'inspect', ref).status, 0);
});

test('cleanup cannot target a container it does not own', { skip }, async () => {
  const created = docker('create', '--pull', 'never', '--label', `${LABELS.owner}=someone-else`, CANARY_IMAGE, 'true');
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.trim();
  try {
    assert.equal(await backend.remove(id, { owner: 'not-the-owner' }), 'cleanup-failed');
    await assert.rejects(backend.kill(id, { owner: 'not-the-owner' }), is('sentinel.execution.cleanupFailed'));
    assert.equal(backend.removeSync(id, { owner: 'not-the-owner' }), 'cleanup-failed');
    assert.equal(absent(id), false, 'the unrelated container is untouched');
  } finally { docker('rm', '--force', id); }
});

test('closing the store removes a running worker container before the lock is released', { skip }, async () => {
  const other = scratch('owner-close');
  const st = await storeIn(other.root);
  const service = await createExecutionService(st, { scratchRoot: other.work, registry: registryFor('hang'), containers: true });
  const pending = service.run({ adapterId: 'canary-hang', attemptId: 'attempt-close', work, inputs: inputs(other.root) } as any);
  let id: string | undefined;
  for (let i = 0; i < 100 && !id; i++) {
    await new Promise(r => setTimeout(r, 100));
    id = docker('ps', '-q', '--no-trunc', '--filter', `label=${LABELS.attempt}=attempt-close`).stdout.trim().split('\n')[0] || undefined;
  }
  assert.ok(id, 'the worker container started');
  st.close();
  assert.ok(absent(id!), 'removed during the store close');
  const outcome = await pending;
  assert.notEqual(outcome.state, 'succeeded');
  removeScratch(other.root);
});

test('closing the store at any moment around a container create leaves no container and no success', { skip }, async () => {
  for (const delay of [0, 10, 30, 60, 100, 150, 250, 400]) {
    const other = scratch(`close-${delay}`);
    const st = await storeIn(other.root);
    const service = await createExecutionService(st, { scratchRoot: other.work, registry: registryFor('ok'), containers: true });
    const attemptId = `attempt-race-${delay}`;
    let settledFirst = false;
    const pending = service.run({ adapterId: 'canary-ok', attemptId, work, inputs: inputs(other.root) } as any)
      .then(o => ({ o }), (e: unknown) => ({ e })).finally(() => { settledFirst = true; });
    await new Promise(r => setTimeout(r, delay));
    const closedFirst = !settledFirst;
    try { st.close(); } catch (e) { assert.equal((e as any).code, 'sentinel.store.resourceCloseFailed'); }
    const done = await pending;
    // The create may still have been in flight when the store closed; once the attempt has settled, nothing remains.
    await new Promise(r => setTimeout(r, 300));
    assert.equal(docker('ps', '--all', '--quiet', '--filter', `label=${LABELS.attempt}=${attemptId}`).stdout.trim(), '', `closed at ${delay} ms`);
    // An attempt that finished before the close may have succeeded; one the close interrupted never does.
    if (closedFirst && 'o' in done) assert.notEqual(done.o.state, 'succeeded', `closed at ${delay} ms`);
    removeScratch(other.root);
  }
});

test('effective identity inside the container: non-root, no capabilities, no new privileges, loopback only, read-only root', { skip }, async t => {
  const o = await run('identity');
  const r = canary(o.diagnostics.text);
  t.diagnostic(`identity canary ${JSON.stringify(r)}`);
  assert.notEqual(r.uid, 0);
  assert.equal(`${r.uid}:${r.gid}`, process.getuid?.() === 0 ? '65534:65534' : `${process.getuid?.()}:${process.getgid?.()}`);
  assert.equal(r.capEff, '0000000000000000');
  assert.equal(r.capPrm, '0000000000000000');
  assert.equal(r.capBnd, '0000000000000000');
  assert.equal(r.noNewPrivs, '1');
  assert.deepEqual(r.interfaces, ['lo']);
  assert.equal(r.rootWritable, 'EROFS');
  assert.equal(o.cleanup, 'removed-owned-container');
});

test('CPU and per-file size ceilings are enforced, not only configured', { skip }, async t => {
  const cpu = await run('cpu', { cpus: 1 });
  const ratio = canary(cpu.diagnostics.text).cpuRatio;
  const fsize = await run('fsize', { outputBytes: 4 * 1024 * 1024 });
  const big = join(fsize.workDir, 'output', 'big');
  const bytes = (() => { try { return statSync(big).size; } catch { return 0; } })();
  t.diagnostic(`enforcement cpu=${ratio} cores-used-of-1 throttled=${canary(cpu.diagnostics.text).throttled} periods fsize=${canary(fsize.diagnostics.text).fsize ?? `signal ${fsize.exit?.exitSignal ?? fsize.container?.state?.exitCode}`} bytes=${bytes}`);
  const throttled = canary(cpu.diagnostics.text).throttled;
  assert.ok(typeof ratio === 'number' && ratio > 0.5 && ratio <= 1.25, `three busy processes used ${ratio} CPUs under a 1-CPU ceiling`);
  assert.ok(typeof throttled === 'number' && throttled > 0, `the kernel throttled the cgroup ${throttled} times`);
  assert.notEqual(fsize.state, 'succeeded');
  assert.ok(bytes <= 4 * 1024 * 1024, `the file stopped at ${bytes} bytes`);
  for (const o of [cpu, fsize]) assert.equal(o.cleanup, 'removed-owned-container');
});

test('output overflow, cancellation and a failed start each end with the container confirmed removed', { skip }, async () => {
  const flood = await run('output-flood', { outputBytes: 2 * 1024 * 1024 });
  assert.equal(flood.code, 'sentinel.execution.outputTooLarge');
  assert.equal(flood.stopConfirmed, true, 'the daemon confirmed the stop');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 2_000);
  const cancelled = await run('ack-cancel', {}, undefined, ac.signal);
  assert.equal(cancelled.state, 'canceled');
  const registry = createAdapterRegistry([{ id: 'canary-absent', version: '0', kind: 'external', isolation: 'container', image: CANARY_IMAGE,
    command: ['/sentinel-executable-intentionally-absent'], limits: { timeoutMs: 20_000, helloTimeoutMs: 10_000 } }]);
  const absentExe = await runAttempt(store, s.work, registry, { adapterId: 'canary-absent', attemptId: 'attempt-absent', work, inputs: captured }, true);
  assert.equal(absentExe.code, 'sentinel.execution.workerExited');
  for (const o of [flood, cancelled, absentExe]) { assert.equal(o.cleanup, 'removed-owned-container'); assert.ok(absent(o.container!.id)); }
});

test('an ambiguous create is reconciled by its owner nonce, and nothing else is touched', { skip }, async () => {
  const nonce = randomUUID();
  const mine = docker('create', '--pull', 'never', '--label', `${LABELS.owner}=${nonce}`, CANARY_IMAGE, 'true').stdout.trim();
  const unrelated = docker('create', '--pull', 'never', '--label', `${LABELS.owner}=${randomUUID()}`, CANARY_IMAGE, 'true').stdout.trim();
  try {
    const result = await backend.reconcileOwned({ owner: nonce });
    assert.deepEqual(result, { removed: [mine], uncertain: [] });
    assert.ok(absent(mine));
    assert.equal(absent(unrelated), false);
  } finally { docker('rm', '--force', unrelated); docker('rm', '--force', mine); }
  // A create cut short at any moment leaves nothing behind under its nonce.
  const pin = await backend.inspectImage(CANARY_IMAGE);
  const dirs = join(s.root, 'ambiguous');
  mkdirSync(join(dirs, 'in'), { recursive: true }); mkdirSync(join(dirs, 'out'), { recursive: true });
  for (const ms of [0, 5, 20, 60, 150]) {
    const owner2 = randomUUID();
    const specCut = { image: pin, command: ['node', '-e', '0'], limits: { ...DEFAULT_ADAPTER_LIMITS }, inputDir: join(dirs, 'in'), outputDir: join(dirs, 'out'),
      labels: { owner: owner2, store: 'store-ambiguous', attempt: `attempt-cut-${ms}`, epoch: 'epoch-ambiguous', invocation: `sha256:${'c'.repeat(64)}` },
      adapter: { id: 'cut', digest: `sha256:${'d'.repeat(64)}` }, user: process.getuid?.() === 0 ? '65534:65534' : `${process.getuid?.()}:${process.getgid?.()}` };
    // Canceled at any moment: the create completes, the cancellation removes it, and the call says canceled.
    // (A cancellation that comes after the create returns is the supervisor's to act on; here the id is removed.)
    const outcome = await backend.create(specCut, AbortSignal.timeout(Math.max(ms, 1))).then(id => ({ id }), (e: unknown) => ({ e }));
    if ('id' in outcome) assert.equal(await backend.remove(outcome.id, specCut.labels), 'removed-owned-container');
    else assert.ok(is('sentinel.execution.canceled')(outcome.e), String(outcome.e));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(docker('ps', '--all', '--quiet', '--filter', `label=${LABELS.owner}=${owner2}`).stdout.trim(), '', `canceled at ${ms} ms`);
  }
});

test('a work resource policy lowers the container limits, and the kernel enforces them', { skip }, async t => {
  const policy = (p: Record<string, number>) => ({ deadlineMs: 120_000, memoryBytes: 2_147_483_648, cpuQuota: 2, maxPids: 128, maxOutputBytes: 4_194_304, ...p });
  const runWith = (behaviour: string, resources: Record<string, number>) =>
    (behaviour === 'memory' ? observedAttempt(t, 'policy-memory', registryFor(behaviour),
      { adapterId: `canary-${behaviour}`, attemptId: `attempt-p${++n}`, work, inputs: captured, resources: policy(resources) }) :
      runAttempt(store, s.work, registryFor(behaviour), { adapterId: `canary-${behaviour}`, attemptId: `attempt-p${++n}`, work, inputs: captured, resources: policy(resources) }, true));
  // The adapter allows 256 MiB; the policy's 64 MiB is what the container gets, and the worker is stopped by it.
  const memory = await runWith('memory', { memoryBytes: 64 * 1024 * 1024 });
  memoryEvidence(t, memory);
  assert.equal(memory.code, 'sentinel.execution.resourceExceeded');
  assert.equal(memory.invocation.record.limits.memoryBytes, 64 * 1024 * 1024);
  // A fractional CPU quota: three busy processes get about half a CPU.
  const cpu = await runWith('cpu', { cpuQuota: 0.5 });
  const ratio = canary(cpu.diagnostics.text).cpuRatio;
  assert.ok(ratio > 0.2 && ratio <= 0.65, `used ${ratio} CPUs under a 0.5 quota`);
  // Processes: the policy's 16 is below the adapter's 64.
  const pids = await runWith('pids', { maxPids: 16 });
  assert.ok(canary(pids.diagnostics.text).started < 16, JSON.stringify(canary(pids.diagnostics.text)));
  t.diagnostic(`policy enforcement oom=${memory.container?.state?.oomKilled} cpu=${ratio}/0.5 forked=${canary(pids.diagnostics.text).started}/16`);
  for (const o of [memory, cpu, pids]) assert.equal(o.cleanup, 'removed-owned-container');
});
