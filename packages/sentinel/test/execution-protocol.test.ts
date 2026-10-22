// The bounded worker protocol and the supervisor, with real worker processes but no container: every test here
// always runs. Built-in workers are local children by design; external tools never are (tested below), and the
// container cases live in execution-isolation.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SENTINEL_EXECUTION_STRINGS } from '@farsight/core/dist/strings-sentinel-execution.js';
import { FrameDecoder, WorkerSession, encodeFrame } from '../dist/execution/protocol.js';
import { superviseAttempt, inputFingerprintOf } from '../dist/execution/supervisor.js';
import { createAdapterRegistry, TRUSTED_ADAPTERS, DEFAULT_ADAPTER_LIMITS } from '../dist/execution/registry.js';
import { EXECUTION_ERROR_CODES, isExecutionError } from '../dist/execution/errors.js';
import { builtInRegistry, inputs, ownerIn, removeScratch, scratch, work } from './execution-helpers.ts';

const s = scratch('protocol');
const owner = await ownerIn(s.root);
after(() => { owner.close(); removeScratch(s.root); });
const captured = inputs(s.root);
const is = (code: string) => (e: unknown) => isExecutionError(e) && e.code === code;
let n = 0;

async function run(behaviour: string, limits: Record<string, number> = {}, extra: Record<string, unknown> = {}) {
  const registry = builtInRegistry(join(s.root, `r${++n}`), [behaviour], limits);
  return superviseAttempt({ owner, registry, adapterId: `test-${behaviour}`, attemptId: `attempt-${n}`, work, inputs: captured, scratchRoot: s.work, ...extra });
}

test('every execution code is a catalog entry and every catalog entry a code', () => {
  assert.deepEqual([...EXECUTION_ERROR_CODES].sort(), Object.keys(SENTINEL_EXECUTION_STRINGS).sort());
});

test('framing: the size limit is enforced before any decode, across chunks', () => {
  const d = new FrameDecoder({ maxFrameBytes: 1024 });
  assert.throws(() => d.push(Buffer.alloc(1025, 0x41)), is('sentinel.execution.frameTooLarge'));
  assert.throws(() => d.push(Buffer.from('\n')), is('sentinel.execution.frameTooLarge'), 'a failed decoder stays failed');
  const d2 = new FrameDecoder({ maxFrameBytes: 1024 });
  d2.push(Buffer.alloc(600, 0x41));
  assert.throws(() => d2.push(Buffer.alloc(600, 0x41)), is('sentinel.execution.frameTooLarge'));
});

test('framing: invalid UTF-8, invalid JSON, schema-invalid and unterminated frames are refused', () => {
  assert.throws(() => new FrameDecoder().push(Buffer.from([0x7b, 0xff, 0x7d, 0x0a])), is('sentinel.execution.frameMalformed'));
  assert.throws(() => new FrameDecoder().push(Buffer.from('{nope}\n')), is('sentinel.execution.frameMalformed'));
  assert.throws(() => new FrameDecoder().push(Buffer.from('{"protocol":"sentinel-worker/draft-1","type":"progress"}\n')), is('sentinel.execution.messageInvalid'));
  const d = new FrameDecoder();
  d.push(Buffer.from('{"partial":'));
  assert.throws(() => d.end(), is('sentinel.execution.frameMalformed'));
  assert.throws(() => new FrameDecoder({ maxTotalBytes: 10 }).push(Buffer.alloc(11)), is('sentinel.execution.stdoutBudget'));
});

test('framing: a frame split byte by byte decodes once, and two frames in one chunk decode as two', () => {
  const hello = { protocol: 'sentinel-worker/draft-1', type: 'hello', supported: ['sentinel-worker/draft-1'], adapterId: 'a', adapterDigest: `sha256:${'a'.repeat(64)}` } as const;
  const bytes = encodeFrame(hello as any);
  const d = new FrameDecoder();
  const out = [];
  for (const b of bytes) out.push(...d.push(Buffer.from([b])));
  assert.equal(out.length, 1);
  assert.equal(new FrameDecoder().push(Buffer.concat([bytes, bytes])).length, 2);
});

test('session: the coordinator binding is the only authority', () => {
  const binding = { attemptId: 'att-1', work, coordinatorEpoch: owner.epoch, adapterId: 'a', adapterDigest: `sha256:${'a'.repeat(64)}`,
    inputFingerprint: inputFingerprintOf(captured.map(c => c.id)), inputs: captured.map(c => c.id), deadlineAt: '2099-01-01T00:00:00Z' };
  const session = new WorkerSession(binding);
  const step = session.receive({ protocol: 'sentinel-worker/draft-1', type: 'hello', supported: ['sentinel-worker/draft-1'], adapterId: 'a', adapterDigest: binding.adapterDigest });
  assert.deepEqual(step.send.map(m => m.type), ['welcome', 'start']);
  const start = step.send[1] as any;
  assert.equal(start.coordinatorEpoch, owner.epoch);
  assert.equal(start.seq, 0);
  assert.throws(() => session.receive({ protocol: 'sentinel-worker/draft-1', type: 'progress', attemptId: 'att-1', work, coordinatorEpoch: 'epoch-forged', seq: 0, completed: 0, planned: 1 }),
    (e: unknown) => is('sentinel.execution.protocolViolation')(e) && (e as any).detail.rule === 'coordinator-epoch');
  assert.equal(session.phase, 'failed');
});

test('the production registry is empty, and external tools may only be containers pinned by digest', () => {
  assert.deepEqual([...TRUSTED_ADAPTERS.ids], []);
  assert.throws(() => TRUSTED_ADAPTERS.get('semgrep'), is('sentinel.execution.adapterUnknown'));
  const ext = { id: 'tool', version: '1', kind: 'external', isolation: 'container', image: `example/tool@sha256:${'a'.repeat(64)}`, command: ['tool'] } as const;
  assert.throws(() => createAdapterRegistry([{ ...ext, isolation: 'child' } as any]), is('sentinel.execution.adapterIsolationRefused'));
  assert.throws(() => createAdapterRegistry([{ ...ext, image: 'example/tool:latest' }]), is('sentinel.execution.adapterInvalid'));
  assert.throws(() => createAdapterRegistry([{ ...ext, limits: { memoryBytes: 1 } }]), is('sentinel.execution.adapterInvalid'));
  assert.throws(() => createAdapterRegistry([ext, ext]), is('sentinel.execution.adapterInvalid'));
  const a = createAdapterRegistry([ext]).get('tool');
  const b = createAdapterRegistry([{ ...ext, command: ['tool', '--other'] }]).get('tool');
  assert.notEqual(a.digest, b.digest, 'the digest covers the command');
  assert.equal(a.limits.memoryBytes, DEFAULT_ADAPTER_LIMITS.memoryBytes);
});

test('an external adapter without a container backend is refused; nothing runs on the host instead', async () => {
  const registry = createAdapterRegistry([{ id: 'tool', version: '1', kind: 'external', isolation: 'container', image: `example/tool@sha256:${'a'.repeat(64)}`, command: ['tool'] }]);
  await assert.rejects(superviseAttempt({ owner, registry, adapterId: 'tool', attemptId: 'attempt-ext', work, inputs: captured, scratchRoot: s.work }),
    is('sentinel.execution.isolationUnavailable'));
});

test('an honest worker succeeds; outputs are re-hashed; the binding is the supervisor’s own', async () => {
  const o = await run('progress-then-ok');
  assert.equal(o.state, 'succeeded', JSON.stringify({ code: o.code, detail: o.detail, d: o.diagnostics.text }));
  assert.equal(o.coordinatorEpoch, owner.epoch);
  assert.equal(o.outputs.length, 1);
  const summary = JSON.parse(readFileSync(o.outputs[0].path, 'utf8'));
  assert.deepEqual(summary.read.map((r: any) => r.id), captured.map(c => c.id));
  assert.equal(o.worker?.kind, 'owned-child');
  assert.match(o.invocation.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(o.invocation.record.coordinatorEpoch, owner.epoch);
  assert.deepEqual(o.invocation.record.environmentNames, ['SENTINEL_INPUT', 'SENTINEL_OUTPUT', 'SENTINEL_ADAPTER_ID', 'SENTINEL_ADAPTER_DIGEST']);
});

test('stderr is bounded diagnostics and never protocol', async () => {
  const o = await run('stderr-flood', { stderrBytes: 4096 });
  assert.equal(o.state, 'succeeded');
  assert.equal(o.diagnostics.truncated, true);
  assert.equal(o.diagnostics.text.length, 4096);
  assert.ok(o.diagnostics.bytes >= 1024 * 1024);
});

const refusals: Array<[string, string, Record<string, number>?]> = [
  ['huge-frame', 'sentinel.execution.frameTooLarge'],
  ['bad-json', 'sentinel.execution.frameMalformed'],
  ['bad-utf8', 'sentinel.execution.frameMalformed'],
  ['schema-invalid', 'sentinel.execution.messageInvalid'],
  ['message-before-hello', 'sentinel.execution.messageInvalid'],
  ['forged-epoch', 'sentinel.execution.protocolViolation'],
  ['other-attempt', 'sentinel.execution.protocolViolation'],
  ['other-revision', 'sentinel.execution.protocolViolation'],
  ['seq-gap', 'sentinel.execution.protocolViolation'],
  ['heartbeat', 'sentinel.execution.protocolViolation'],
  ['wrong-adapter', 'sentinel.execution.adapterIdentityMismatch'],
  ['old-version', 'sentinel.execution.versionRefused'],
  ['wrong-fingerprint', 'sentinel.execution.resultMismatch'],
  ['stdout-flood', 'sentinel.execution.stdoutBudget', { stdoutBytes: 65_536 }],
  ['unlisted-output', 'sentinel.execution.outputMismatch'],
  ['tampered-output', 'sentinel.execution.outputMismatch'],
  ['linked-output', 'sentinel.execution.outputMismatch'],
  ['phantom-reference', 'sentinel.execution.outputMismatch'],
  ['exit-nonzero-after-result', 'sentinel.execution.workerExited'],
  ['frame-after-result', 'sentinel.execution.protocolViolation'],
  ['output-flood', 'sentinel.execution.outputTooLarge', { outputBytes: 4 * 1024 * 1024 }],
  ['no-hello', 'sentinel.execution.protocolViolation', { helloTimeoutMs: 300 }],
  ['hang', 'sentinel.execution.deadlineExceeded', { timeoutMs: 800 }],
];
for (const [behaviour, code, limits] of refusals) {
  test(`a hostile worker (${behaviour}) ends ${code.split('.').pop()} with no accepted result`, async () => {
    const o = await run(behaviour, limits);
    assert.equal(o.code, code, JSON.stringify({ state: o.state, detail: o.detail, stderr: o.diagnostics.text.slice(0, 300) }));
    assert.notEqual(o.state, 'succeeded');
    assert.equal(o.result, undefined);
    assert.deepEqual(o.outputs, []);
    assert.ok(o.exit, 'the worker process was reaped');
  });
}

test('cancel: an acknowledging worker ends canceled; one that ignores it is stopped after the grace', async () => {
  const c1 = new AbortController();
  const p1 = run('ack-cancel', {}, { signal: c1.signal });
  setTimeout(() => c1.abort(), 300);
  const o1 = await p1;
  assert.equal(o1.state, 'canceled');
  assert.equal(o1.detail?.forced, undefined);
  const c2 = new AbortController();
  const p2 = run('ignore-cancel', { cancelGraceMs: 300 }, { signal: c2.signal });
  setTimeout(() => c2.abort(), 300);
  const o2 = await p2;
  assert.equal(o2.state, 'canceled');
  assert.equal(o2.detail?.forced, true);
});

test('an input whose bytes differ from its digest is refused before any worker starts', async () => {
  const bad = [{ ...captured[0]!, id: `sha256:${'3'.repeat(64)}` }];
  const registry = builtInRegistry(join(s.root, 'bad-input'), ['ok']);
  await assert.rejects(superviseAttempt({ owner, registry, adapterId: 'test-ok', attemptId: 'attempt-bad', work, inputs: bad, scratchRoot: s.work }),
    is('sentinel.execution.inputMismatch'));
});

test('a built-in module changed after registration is refused', async () => {
  const dir = join(s.root, 'changed');
  const registry = builtInRegistry(dir, ['ok']);
  writeFileSync(join(dir, 'adapters', 'ok.mjs'), 'process.exit(0);\n');
  await assert.rejects(superviseAttempt({ owner, registry, adapterId: 'test-ok', attemptId: 'attempt-changed', work, inputs: captured, scratchRoot: s.work }),
    is('sentinel.execution.adapterIdentityMismatch'));
});

test('a closed owner refuses new attempts', async () => {
  const other = scratch('closed');
  const o = await ownerIn(other.root);
  o.close();
  await assert.rejects(superviseAttempt({ owner: o, registry: builtInRegistry(other.root, ['ok']), adapterId: 'test-ok', attemptId: 'attempt-x', work, inputs: inputs(other.root), scratchRoot: other.work }),
    (e: unknown) => (e as any).code === 'sentinel.store.ownerClosed');
  removeScratch(other.root);
});
