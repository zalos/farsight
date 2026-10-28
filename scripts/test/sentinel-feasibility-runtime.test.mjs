import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, preview, resourcePreflight } from '../sentinel-feasibility-runtime.mjs';
import { execute } from '../sentinel-feasibility-scanners.mjs';
import {
  classifyFailure,
  missingContainerExecutable,
  missingImage,
  validateIsolation,
  containerTrial,
  IMAGE,
} from '../sentinel-feasibility/runtime-matrix/containers.mjs';
import {
  admission,
  payload,
  sha,
  LIMITS,
  verifyTrialIdentity,
  verifyInputIdentity,
  verifyTrialOutcome,
  resourceTrials,
  trialAccounting,
} from '../sentinel-feasibility/runtime-matrix/resources.mjs';

test('preview has no execution side effects and run requires explicit output', () => {
  assert.equal(parseArgs([]).run, false);
  assert.throws(() => parseArgs(['--run']), /fresh-directory/);
  assert.throws(() => parseArgs(['--image', 'other']), /Unknown/);
  assert.equal(preview().state, 'preview');
  assert.ok(preview().gaps.some((value) => value.includes('synthetic')));
});
test('real missing executable has a retained ENOENT classification', async () => {
  const result = await execute('/sentinel-executable-intentionally-absent', [], { timeout: 500 });
  assert.equal(classifyFailure(result), 'missing-executable');
  assert.equal(result.spawnError, 'ENOENT');
});
test('bounded process executor distinguishes timeout, cancellation and output budget', async () => {
  const timeout = await execute(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 100 });
  assert.equal(classifyFailure(timeout), 'timeout');
  assert.ok(timeout.wallMs < 5000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const cancelled = await execute(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
    timeout: 5000,
    signal: controller.signal,
  });
  clearTimeout(timer);
  assert.equal(classifyFailure(cancelled), 'cancelled');
  const output = await execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], {
    timeout: 2000,
    maxOutput: 512,
  });
  assert.equal(classifyFailure(output), 'output-budget-exhausted');
  assert.ok(Buffer.byteLength(output.stdout) <= 512);
});
test('missing container executable requires completed exact-path failure, never interruption or unrelated missing files', () => {
  const result = {
    exitCode: 127,
    stderr:
      'exec: "/sentinel-executable-intentionally-absent": stat /sentinel-executable-intentionally-absent: no such file or directory',
  };
  assert.equal(missingContainerExecutable(result), true);
  for (const changed of [
    { exitCode: 0 },
    { exitCode: null },
    { timedOut: true },
    { cancelled: true },
    { outputExceeded: true },
    { spawnError: 'ENOENT' },
    { exitSignal: 'SIGKILL' },
    { stderr: 'stat /unrelated: no such file or directory' },
    { stderr: '/sentinel-executable-intentionally-absent: permission denied' },
  ]) {
    assert.equal(missingContainerExecutable({ ...result, ...changed }), false);
  }
});
test('missing immutable image requires completed exact-reference absence, never interruptions or unrelated images', () => {
  const reference = 'farsight-sentinel-intentionally-absent@sha256:' + '0'.repeat(64);
  const result = { exitCode: 1, stderr: `Error response from daemon: No such image: ${reference}\n` };
  assert.equal(missingImage(result, reference), true);
  for (const changed of [
    { exitCode: 0 },
    { exitCode: null },
    { timedOut: true },
    { cancelled: true },
    { outputExceeded: true },
    { spawnError: 'ENOENT' },
    { exitSignal: 'SIGKILL' },
    { stderr: 'Error response from daemon: No such image: unrelated@sha256:' + '1'.repeat(64) },
    { stderr: result.stderr + 'unexpected trailing diagnostic' },
  ]) {
    assert.equal(missingImage({ ...result, ...changed }, reference), false);
  }
  assert.equal(missingImage(result, 'farsight-sentinel-intentionally-absent:latest'), false);
});
test('quota admission refuses unavailable controllers, impossible requests and unknown measurements', () => {
  const vm = {
    MemTotal: 8 * 1024 ** 3,
    NCPU: 8,
    MemoryLimit: true,
    SwapLimit: true,
    CpuCfsQuota: true,
    PidsLimit: true,
  };
  assert.equal(resourcePreflight(vm, { memoryBytes: 256 * 1024 ** 2, cpus: 1 }).admitted, true);
  assert.equal(resourcePreflight(vm, { memoryBytes: vm.MemTotal + 1, cpus: 1 }).reason, 'VM_RESOURCE_BUDGET_EXHAUSTED');
  assert.equal(resourcePreflight(vm, { memoryBytes: 1, cpus: 9 }).admitted, false);
  assert.equal(
    resourcePreflight({ ...vm, PidsLimit: false }, { memoryBytes: 1, cpus: 1 }).reason,
    'REQUIRED_RESOURCE_CONTROLLER_UNAVAILABLE',
  );
  assert.equal(resourcePreflight({}, { memoryBytes: 1, cpus: 1 }).reason, 'VM_QUOTAS_UNAVAILABLE');
  assert.equal(admission({ inputBytes: 1, totalBytes: 1, trials: 1, measurementAvailable: false }).state, 'gap');
  assert.equal(admission({ inputBytes: LIMITS.maxInputBytes + 1, totalBytes: 1, trials: 1 }).admitted, false);
});
test('original JSON payloads retain deterministic identity, distinct content and requested size', () => {
  for (const kind of ['parser', 'scan']) {
    const bytes = payload(kind, 65_536),
      decoded = JSON.parse(bytes);
    assert.ok(bytes.length >= 65_536 && bytes.length < 67_000);
    assert.equal(sha(bytes), sha(payload(kind, 65_536)));
    const rows = decoded.nodes ?? decoded.results;
    assert.ok(rows.length > 100);
    assert.notEqual(rows[0].path, rows[1].path);
  }
  assert.notEqual(sha(payload('parser', 65_536)), sha(payload('scan', 65_536)));
});
test('fresh codec child measures bytes and roundtrips retained JSON without decoding source', async () => {
  const out = await mkdtemp(join(tmpdir(), 'sentinel-runtime-unit-'));
  try {
    const input = payload('scan', 65_536);
    await writeFile(join(out, 'input.json'), input);
    for (const codec of ['raw', 'gzip', 'zstd']) {
      const result = await execute(
        process.execPath,
        [
          resolve('scripts/sentinel-feasibility/runtime-matrix/codec-worker.mjs'),
          join(out, 'input.json'),
          join(out, codec),
          codec,
        ],
        { timeout: 5000 },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const metric = JSON.parse(result.stdout);
      if (metric.state === 'unavailable') {
        assert.equal(codec, 'zstd');
        continue;
      }
      assert.equal(metric.state, 'measured');
      assert.equal(metric.rawSha256, sha(input));
      assert.equal(metric.encodedSha256, sha(await readFile(join(out, codec))));
      assert.ok(metric.childLifetimeMaxRssKiB > 0);
      assert.match(metric.memoryProvenance, /not codec-only/);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
test('parent rejects wrong or missing claimed input/output identities and changed/missing retained artifacts', async () => {
  const out = await mkdtemp(join(tmpdir(), 'sentinel-runtime-identities-'));
  try {
    const original = Buffer.from('original synthetic JSON bytes'),
      encoded = Buffer.from('trusted encoded output');
    const inputPath = join(out, 'input'),
      artifactPath = join(out, 'encoded');
    await writeFile(inputPath, original);
    await writeFile(artifactPath, encoded);
    const expectedInput = { bytes: original.length, sha256: sha(original) };
    const metric = {
      state: 'measured',
      codec: 'gzip',
      rawBytes: original.length,
      rawSha256: sha(original),
      encodedBytes: encoded.length,
      encodedSha256: sha(encoded),
    };
    const options = { inputPath, artifactPath, expectedInput, metric, codec: 'gzip' };
    assert.equal((await verifyTrialIdentity(options)).verified, true);
    for (const changed of [
      { rawBytes: 1 },
      { rawSha256: '0'.repeat(64) },
      { rawSha256: undefined },
      { encodedBytes: undefined },
      { encodedSha256: undefined },
      { codec: 'raw' },
    ]) {
      await assert.rejects(
        verifyTrialIdentity({ ...options, metric: { ...metric, ...changed } }),
        /TRIAL_METRIC_IDENTITY_MISMATCH/,
      );
    }
    await assert.rejects(
      verifyTrialIdentity({ ...options, metric: { ...metric, encodedBytes: 1 } }),
      /ENCODED_ARTIFACT_IDENTITY_MISMATCH/,
    );
    await assert.rejects(
      verifyTrialIdentity({ ...options, metric: { ...metric, encodedSha256: '0'.repeat(64) } }),
      /ENCODED_ARTIFACT_IDENTITY_MISMATCH/,
    );
    await writeFile(artifactPath, Buffer.from('X'.repeat(encoded.length)));
    await assert.rejects(verifyTrialIdentity(options), /ENCODED_ARTIFACT_IDENTITY_MISMATCH/);
    await rm(artifactPath);
    await assert.rejects(verifyTrialIdentity(options), /ENCODED_ARTIFACT_MISSING/);
    await writeFile(artifactPath, encoded);
    await writeFile(inputPath, Buffer.from('X'.repeat(original.length)));
    await assert.rejects(verifyTrialIdentity(options), /INPUT_ARTIFACT_IDENTITY_MISMATCH/);
    await assert.rejects(verifyInputIdentity(inputPath, expectedInput), /INPUT_ARTIFACT_IDENTITY_MISMATCH/);
    await rm(inputPath);
    await assert.rejects(verifyTrialIdentity(options), /INPUT_ARTIFACT_MISSING/);
    await assert.rejects(verifyInputIdentity(inputPath, expectedInput), /INPUT_ARTIFACT_MISSING/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
test('only completed exact zstd API unavailability is a gap, without fabricated output or metrics', async () => {
  const out = await mkdtemp(join(tmpdir(), 'sentinel-runtime-unavailable-'));
  try {
    const bytes = Buffer.from('original synthetic input');
    const inputPath = join(out, 'input'),
      artifactPath = join(out, 'absent-output');
    await writeFile(inputPath, bytes);
    const expectedInput = { bytes: bytes.length, sha256: sha(bytes) };
    const metric = { state: 'unavailable', codec: 'zstd', reason: 'NODE_ZSTD_API_UNAVAILABLE' };
    const options = { inputPath, artifactPath, expectedInput, metric, codec: 'zstd', execution: { exitCode: 0 } };
    const outcome = await verifyTrialOutcome(options);
    assert.equal(outcome.state, 'unavailable');
    assert.equal(outcome.artifactAbsent, true);
    assert.deepEqual(outcome.inputIdentity, expectedInput);
    assert.equal(outcome.identity, undefined);
    for (const codec of ['raw', 'gzip'])
      await assert.rejects(verifyTrialOutcome({ ...options, codec }), /UNEXPECTED_CODEC_UNAVAILABLE/);
    for (const changed of [
      { codec: 'raw' },
      { reason: 'OTHER_REASON' },
      { reason: undefined },
      { codec: undefined },
      { encodedBytes: 0 },
      { encodeMs: 0 },
    ]) {
      await assert.rejects(
        verifyTrialOutcome({ ...options, metric: { ...metric, ...changed } }),
        /UNEXPECTED_CODEC_UNAVAILABLE/,
      );
    }
    for (const changed of [
      { exitCode: 1 },
      { exitCode: null },
      { timedOut: true },
      { cancelled: true },
      { outputExceeded: true },
      { spawnError: 'ENOENT' },
      { exitSignal: 'SIGKILL' },
    ]) {
      await assert.rejects(
        verifyTrialOutcome({ ...options, execution: { exitCode: 0, ...changed } }),
        /RESOURCE_CHILD_FAILED/,
      );
    }
    await assert.rejects(
      verifyTrialOutcome({ ...options, metric: { ...metric, state: 'failed' } }),
      /TRIAL_METRIC_IDENTITY_MISMATCH/,
    );
    await writeFile(artifactPath, 'unexpected');
    await assert.rejects(verifyTrialOutcome(options), /UNAVAILABLE_CODEC_ARTIFACT_PRESENT/);
    await rm(artifactPath);
    await writeFile(inputPath, 'changed');
    await assert.rejects(verifyTrialOutcome(options), /INPUT_ARTIFACT_IDENTITY_MISMATCH/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
test('synthetic injected unavailable zstd attempts preserve all 54 rows and verified raw/gzip siblings', async () => {
  const out = await mkdtemp(join(tmpdir(), 'sentinel-runtime-synthetic-continuation-'));
  try {
    // Mocked child protocol only: these bytes/metrics are not performance or compression observations.
    const runner = async (_program, args) => {
      const [, inputPath, artifactPath, codec] = args;
      if (codec === 'zstd')
        return {
          exitCode: 0,
          stdout: JSON.stringify({ state: 'unavailable', codec, reason: 'NODE_ZSTD_API_UNAVAILABLE' }),
          stderr: '',
        };
      const input = await readFile(inputPath),
        encoded = Buffer.from(`synthetic ${codec} child output`);
      await writeFile(artifactPath, encoded, { flag: 'wx' });
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: 'measured',
          codec,
          rawBytes: input.length,
          rawSha256: sha(input),
          encodedBytes: encoded.length,
          encodedSha256: sha(encoded),
        }),
        stderr: '',
      };
    };
    const result = await resourceTrials(out, runner);
    assert.deepEqual(result.accounting, {
      expectedTrials: 54,
      attemptedTrials: 54,
      measuredTrials: 36,
      unavailableTrials: 18,
      passed: true,
    });
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].unavailableTrials, 18);
    assert.equal(result.trials.filter((t) => t.state === 'measured' && t.identity.verified).length, 36);
    for (const trial of result.trials.filter((t) => t.state === 'unavailable')) {
      assert.equal(trial.codec, 'zstd');
      assert.equal(trial.artifact, null);
      assert.equal(trial.identity, undefined);
      assert.deepEqual(Object.keys(trial.metric).sort(), ['codec', 'reason', 'state']);
    }
    assert.ok(result.inputs.every((input) => input.finalIdentity.sha256 === input.sha256));
    const progress = JSON.parse(await readFile(join(out, 'resources/progress.json'), 'utf8'));
    assert.equal(progress.trials.length, 54);
    assert.equal(trialAccounting(result.trials.slice(1), result.inputs).passed, false);
    const duplicate = structuredClone(result.trials);
    duplicate[1] = structuredClone(duplicate[0]);
    assert.equal(trialAccounting(duplicate, result.inputs).passed, false);
    const invalid = structuredClone(result.trials);
    invalid[2].codec = 'gzip';
    assert.equal(trialAccounting(invalid, result.inputs).passed, false);
    const failed = structuredClone(result.trials);
    failed[2].execution.timedOut = true;
    assert.equal(trialAccounting(failed, result.inputs).passed, false);
    const changedInputs = structuredClone(result.inputs);
    changedInputs[0].finalIdentity.sha256 = '0'.repeat(64);
    assert.equal(trialAccounting(result.trials, changedInputs).passed, false);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
function container(owner = 'mine') {
  return {
    Id: 'a'.repeat(64),
    Image: 'sha256:' + 'b'.repeat(64),
    Config: { Image: IMAGE, User: '65534:65534', Labels: { 'org.farsight.sentinel-feasibility.owner': owner } },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Memory: 268435456,
      MemorySwap: 268435456,
      NanoCpus: 1_000_000_000,
      PidsLimit: 32,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=1m,mode=1777' },
    },
    Mounts: [],
  };
}
test('container policy rejects host exposure, executable tmpfs and weakened inspected limits', () => {
  assert.equal(validateIsolation(container(), 'mine').networkMode, 'none');
  for (const mutate of [
    (v) => v.Mounts.push({ Destination: '/host' }),
    (v) => (v.HostConfig.NetworkMode = 'host'),
    (v) => (v.HostConfig.Memory = 0),
    (v) => (v.HostConfig.MemorySwap = -1),
    (v) => (v.HostConfig.Tmpfs['/tmp'] = 'rw,exec,size=1m'),
    (v) => (v.HostConfig.Tmpfs['/tmp'] = 'rw,noexec,nosuid,size=11m,mode=1777'),
    (v) => (v.HostConfig.Tmpfs['/tmp'] = 'rw,noexec,size=1m,mode=1777'),
    (v) => (v.Config.User = '0'),
    (v) => (v.Config.Image = 'semgrep:latest'),
    (v) => (v.Config.Labels['org.farsight.sentinel-feasibility.owner'] = 'other'),
  ]) {
    const value = container();
    mutate(value);
    assert.throws(() => validateIsolation(value, 'mine'), /MISMATCH/);
  }
});
test('foreign ownership prevents both start and removal; cleanup stays inspectable', async () => {
  const commands = [];
  const runner = async (_program, args) => {
    commands.push(args);
    return {
      exitCode: 0,
      stdout: args[0] === 'create' ? 'a'.repeat(64) : JSON.stringify([container('foreign')]),
      stderr: '',
    };
  };
  const result = await containerTrial('timeout', runner);
  assert.equal(result.state, 'failed');
  assert.equal(result.cleanup.state, 'cleanup-failed');
  assert.ok(commands.every((args) => !['start', 'rm'].includes(args[0])));
});
