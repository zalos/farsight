import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_LABEL,
  RUN_UID,
  buildImage,
  runOwnedContainer,
  cleanupOwnedContainer,
  loadCorpus,
  materializeCase,
  writeGeneratedFile,
  verifyAcquisitionInputs,
  evaluateCaseOutcome,
  parseProbeOutput,
} from '../sentinel-feasibility/frameworks/runtime.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ID = 'a'.repeat(64),
  IMAGE = 'sha256:' + 'b'.repeat(64);
const good = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
const absent = (identity) => ({ exitCode: 1, stdout: '', stderr: `Error: No such object: ${identity}\n` });
const interruptions = [
  { timedOut: true },
  { cancelled: true },
  { outputExceeded: true },
  { spawnError: 'ENOENT' },
  { exitSignal: 'SIGKILL' },
];
function docker({
  pre,
  post,
  createFlags,
  inspectFlags,
  postFlags,
  startFlags,
  removeFlags,
  absenceIdentity,
  absenceFlags,
  onCreate,
  onPre,
  onStart,
} = {}) {
  const calls = [];
  let owner,
    created = false,
    started = false,
    removed = false,
    inspections = 0;
  const tmpfs = {};
  const runner = async (program, args, options = {}) => {
    assert.equal(program, 'docker');
    calls.push({ args, options });
    if (args[0] === 'create') {
      created = true;
      owner = args.find((arg) => arg.startsWith(`${OWNER_LABEL}=`)).slice(OWNER_LABEL.length + 1);
      for (let n = 0; n < args.length; n++)
        if (args[n] === '--tmpfs') {
          const value = args[n + 1],
            at = value.indexOf(':');
          tmpfs[value.slice(0, at)] = value.slice(at + 1);
        }
      onCreate?.();
      return { ...good(ID), ...createFlags };
    }
    if (args[0] === 'inspect') {
      if (!created || removed) return { ...absent(absenceIdentity ?? args.at(-1)), ...absenceFlags };
      inspections++;
      const container = {
        Id: ID,
        Image: IMAGE,
        Platform: 'linux',
        Config: { Image: IMAGE, User: `${RUN_UID}:${RUN_UID}`, Labels: { [OWNER_LABEL]: owner } },
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          CapAdd: null,
          Privileged: false,
          SecurityOpt: ['no-new-privileges:true'],
          Tmpfs: structuredClone(tmpfs),
          Memory: 1073741824,
          MemorySwap: 1073741824,
          NanoCpus: 1000000000,
          PidsLimit: 256,
        },
        Mounts: [],
        State: { Status: started ? 'exited' : 'created', Running: false, OOMKilled: false, Dead: false, ExitCode: 0 },
      };
      if (inspections === 1) {
        pre?.(container);
        onPre?.();
      } else if (inspections === 2 && started) post?.(container);
      return {
        ...good(JSON.stringify([container])),
        ...(inspections === 1 ? inspectFlags : inspections === 2 && started ? postFlags : {}),
      };
    }
    if (args[0] === 'start') {
      started = true;
      onStart?.();
      return { ...good('SENTINEL_FIXTURE_PROBE_RESULT={"status":"ok"}\n'), ...startFlags };
    }
    if (args[0] === 'rm') {
      assert.equal(args.at(-1), ID);
      assert.ok(args.includes('--volumes'));
      removed = true;
      return { ...good(ID), ...removeFlags };
    }
    throw new Error('Unexpected fake Docker command');
  };
  return { runner, calls };
}
const run = (fixture, options = {}, signal) =>
  runOwnedContainer(
    { expectedImageId: IMAGE, image: IMAGE, caseId: 'original-test', ...options },
    fixture.runner,
    signal,
  );
test('owned lifecycle retains complete inspections and exact policy, with no acquisition or host mounts', async () => {
  const fixture = docker();
  const result = await run(fixture);
  assert.equal(result.state, 'measured');
  assert.equal(result.completed, true);
  assert.equal(result.preStartCheck.passed, true);
  assert.equal(result.postStartCheck.passed, true);
  assert.ok(result.preStartInspect.stdout);
  assert.ok(result.postStartInspect.stdout);
  assert.equal(result.cleanup.state, 'removed-owned-container');
  const create = fixture.calls[0].args;
  assert.equal(create[create.indexOf('--pull') + 1], 'never');
  assert.equal(create[create.indexOf('--platform') + 1], 'linux/arm64');
  assert.ok(!create.includes('--mount'));
  assert.ok(!fixture.calls.some((call) => ['build', 'pull'].includes(call.args[0])));
});
test('pre-start policy rejects wrong identities, all unbounded swap values, changed limits and unsafe mounts', async () => {
  for (const mutate of [
    (c) => (c.Image = 'sha256:' + 'c'.repeat(64)),
    (c) => (c.Config.User = '0'),
    (c) => (c.Platform = 'windows'),
    (c) => (c.Config.Labels[OWNER_LABEL] = 'foreign'),
    (c) => (c.HostConfig.ReadonlyRootfs = false),
    ...[-1, 0, undefined, 2147483648].map((value) => (c) => (c.HostConfig.MemorySwap = value)),
    (c) => (c.HostConfig.Memory = 0),
    (c) => (c.HostConfig.NanoCpus = 0),
    (c) => (c.HostConfig.PidsLimit = 0),
    (c) => (c.HostConfig.CapAdd = ['SYS_ADMIN']),
    (c) => (c.HostConfig.Privileged = true),
    (c) => (c.HostConfig.SecurityOpt = ['no-new-privileges:false']),
    (c) => c.HostConfig.SecurityOpt.push('seccomp=unconfined'),
    (c) => (c.HostConfig.Tmpfs['/tmp'] = 'rw,exec,nosuid,size=128m,mode=1777'),
    (c) => (c.HostConfig.Tmpfs['/tmp'] = 'rw,noexec,nosuid,size=1g,mode=1777'),
    (c) => (c.HostConfig.Tmpfs['/tmp'] += ',dev'),
    (c) => delete c.HostConfig.Tmpfs['/tmp'],
    (c) => (c.HostConfig.Tmpfs['/extra'] = 'rw,noexec,nosuid,size=1m,mode=1777'),
    (c) => c.Mounts.push({ Type: 'volume', Destination: '/data', RW: true }),
    (c) => c.Mounts.push({ Type: 'bind', Destination: '/host', RW: false }),
    (c) => c.Mounts.push({ Type: 'tmpfs', Destination: '/extra', RW: true }),
  ]) {
    const fixture = docker({ pre: mutate }),
      result = await run(fixture);
    assert.equal(result.state, 'failed');
    assert.ok(!fixture.calls.some((call) => call.args[0] === 'start'));
  }
});
test('requested extra tmpfs is exact and weak or duplicate requests fail before create', async () => {
  const fixture = docker();
  assert.equal(
    (await run(fixture, { extraTmpfs: ['/app/cache:rw,noexec,nosuid,size=64m,mode=1777'] })).state,
    'measured',
  );
  for (const extraTmpfs of [
    ['/tmp:rw,noexec,nosuid,size=1m,mode=1777'],
    ['/app/cache:rw,exec,nosuid,size=64m,mode=1777'],
    ['/app/cache:rw,noexec,nosuid,size=2g,mode=1777'],
    ['/app/../cache:rw,noexec,nosuid,size=1m,mode=1777'],
  ]) {
    const invalid = docker();
    assert.equal((await run(invalid, { extraTmpfs })).state, 'failed');
    assert.equal(invalid.calls.length, 0);
  }
  for (const options of [
    { expectedImageId: undefined },
    { memoryBytes: 0 },
    { memory: '2g' },
    { cpus: 0 },
    { cpus: 1e-20 },
    { pidsLimit: 0 },
  ]) {
    const invalid = docker();
    assert.equal((await run(invalid, options)).state, 'failed');
    assert.equal(invalid.calls.length, 0);
  }
});
test('interrupted create or ownership inspection cannot authorize a start; cleanup independently verifies ownership', async () => {
  for (const flags of interruptions) {
    for (const options of [{ createFlags: flags }, { inspectFlags: flags }]) {
      const fixture = docker(options),
        result = await run(fixture);
      assert.equal(result.state, 'failed');
      assert.ok(!fixture.calls.some((call) => call.args[0] === 'start'));
      assert.equal(result.cleanup.state, 'removed-owned-container');
    }
  }
});
test('already-aborted runs create nothing; cancellation after create or preinspection skips start but cleans unsignalled', async () => {
  const initial = new AbortController();
  initial.abort();
  const none = docker();
  const result = await run(none, {}, initial.signal);
  assert.equal(result.state, 'failed');
  assert.equal(result.cleanup.state, 'not-created');
  assert.equal(none.calls.length, 0);
  for (const boundary of ['onCreate', 'onPre']) {
    const controller = new AbortController(),
      fixture = docker({ [boundary]: () => controller.abort() });
    const cancelled = await run(fixture, {}, controller.signal);
    assert.equal(cancelled.state, 'failed');
    assert.equal(cancelled.cleanup.state, 'removed-owned-container');
    assert.ok(!fixture.calls.some((call) => call.args[0] === 'start'));
    assert.ok(
      fixture.calls.filter((call) => call.args[0] !== 'create').every((call) => call.options.signal === undefined),
    );
  }
});
test('post-start exit/identity/policy drift and interrupted cleanup never become measured', async () => {
  for (const post of [
    (c) => (c.State.ExitCode = 3),
    (c) => (c.State.Running = true),
    (c) => (c.State.OOMKilled = true),
    (c) => (c.Image = 'sha256:' + 'd'.repeat(64)),
    (c) => (c.HostConfig.MemorySwap = -1),
  ]) {
    const result = await run(docker({ post }));
    assert.equal(result.state, 'failed');
    assert.equal(result.completed, false);
  }
  for (const flags of interruptions) {
    assert.equal((await run(docker({ removeFlags: flags }))).cleanup.state, 'cleanup-failed');
    for (const options of [{ postFlags: flags }, { startFlags: flags }]) {
      const interrupted = await run(docker(options));
      assert.equal(interrupted.state, 'failed');
      assert.equal(interrupted.cleanup.state, 'removed-owned-container');
    }
  }
  const controller = new AbortController();
  const duringStart = await run(docker({ onStart: () => controller.abort() }), {}, controller.signal);
  assert.equal(duringStart.state, 'failed');
  assert.equal(duringStart.cleanup.state, 'removed-owned-container');
  for (const options of [
    { absenceIdentity: 'foreign' },
    { absenceFlags: { timedOut: true } },
    { absenceFlags: { stderr: `Error: No such object: ${ID}\nunrelated extra diagnostic` } },
  ]) {
    assert.equal((await run(docker(options))).cleanup.state, 'cleanup-failed');
  }
});
test('unknown or interrupted ownership inspection never authorizes removal and exact absence cannot name another identity', async () => {
  for (const flags of interruptions) {
    const calls = [],
      runner = async (_program, args) => {
        calls.push(args);
        return { ...good(JSON.stringify([{ Id: ID, Config: { Labels: { [OWNER_LABEL]: 'mine' } } }])), ...flags };
      };
    assert.equal((await cleanupOwnedContainer(runner, ID, 'mine')).state, 'cleanup-failed');
    assert.equal(calls.length, 1);
  }
  await assert.rejects(
    cleanupOwnedContainer(
      async () => {
        throw new Error('must not inspect');
      },
      ID,
      undefined,
    ),
    /owner are required/,
  );
  for (const identity of ['foreign', ID]) {
    const result = await cleanupOwnedContainer(async () => absent(identity), ID, 'mine');
    assert.equal(result.state, identity === ID ? 'not-found' : 'cleanup-failed');
  }
});
test('acquisition build and image inspection require complete success and native Linux ARM64 evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-framework-build-unit-'));
  try {
    await writeFile(join(directory, 'Dockerfile'), 'FROM inert-original-reference\n');
    for (const flags of interruptions)
      for (const step of ['build', 'inspect']) {
        const calls = [],
          runner = async (_program, args) => {
            calls.push(args);
            return {
              ...good(args[0] === 'build' ? '' : `${IMAGE}|linux|arm64`),
              ...((step === 'build' ? args[0] === 'build' : args[0] === 'image') ? flags : {}),
            };
          };
        const result = await buildImage({ buildDir: directory, tag: 'original-unit' }, runner);
        assert.equal(result.ok, false);
        if (step === 'build') assert.equal(calls.length, 1);
      }
    for (const observation of [`${IMAGE}|linux|amd64`, `${IMAGE}|windows|arm64`, 'not-an-id|linux|arm64']) {
      assert.equal(
        (
          await buildImage({ buildDir: directory, tag: 'original-unit' }, async (_p, args) =>
            good(args[0] === 'build' ? '' : observation),
          )
        ).ok,
        false,
      );
    }
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(
      buildImage(
        { buildDir: directory, tag: 'original-unit' },
        async () => {
          calls++;
          return good();
        },
        controller.signal,
      ),
      /cancelled/,
    );
    assert.equal(calls, 0);
    const positive = await buildImage({ buildDir: directory, tag: 'original-unit' }, async (_p, args) =>
      good(args[0] === 'build' ? '' : `${IMAGE}|linux|arm64`),
    );
    assert.equal(positive.ok, true);
    assert.ok(positive.inspection.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('fixed HTTP outcomes reject primitives, missing fields, invalid statuses and inconsistent booleans centrally', () => {
  const entry = {
    scenario: 'paired',
    expectedRuntime: { withoutToken: 401, withToken: 200 },
    observed: { withoutToken: 401, withToken: 200 },
    matchesExpected: true,
  };
  assert.equal(evaluateCaseOutcome([entry]).state, 'measured');
  for (const observed of [
    null,
    undefined,
    false,
    0,
    '',
    '200',
    [],
    {},
    { withoutToken: 401 },
    { withoutToken: '401', withToken: 200 },
    { withoutToken: 401, withToken: 0 },
    { withoutToken: 401, withToken: 600 },
    { withoutToken: 401, withToken: 200.5 },
  ]) {
    assert.equal(evaluateCaseOutcome([{ ...entry, observed }]).state, 'failed');
  }
  for (const matchesExpected of [null, undefined, 'true', false])
    assert.equal(evaluateCaseOutcome([{ ...entry, matchesExpected }]).state, 'failed');
  for (const expectedRuntime of [undefined, {}, { status: 'measured-not-assumed' }, { status: 0 }])
    assert.equal(evaluateCaseOutcome([{ ...entry, expectedRuntime }]).state, 'failed');
  const mismatch = { ...entry, observed: { withoutToken: 200, withToken: 200 }, matchesExpected: false };
  assert.equal(evaluateCaseOutcome([mismatch]).state, 'measured-with-mismatch');
  assert.equal(evaluateCaseOutcome([{ ...mismatch, matchesExpected: true }]).state, 'failed');
  assert.equal(evaluateCaseOutcome([entry, entry]).state, 'failed');
  assert.equal(
    parseProbeOutput({
      stdout: 'SENTINEL_FIXTURE_PROBE_RESULT={"status":"ok"}\nSENTINEL_FIXTURE_PROBE_RESULT={"status":"ok"}\n',
    }).ok,
    false,
  );
});
test('bounded no-follow source and generated contexts verify actual retained bytes and refuse symbolic parents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-framework-files-unit-'));
  try {
    const corpus = join(directory, 'corpus'),
      build = join(directory, 'build'),
      outside = join(directory, 'outside');
    await mkdir(corpus);
    await mkdir(outside);
    await mkdir(join(corpus, 'source'));
    const bytes = Buffer.from('original inert source\n'),
      file = { path: 'src/app.js', source: 'source/app.fixture', sha256: sha(bytes) };
    await writeFile(join(corpus, file.source), bytes);
    await writeFile(
      join(corpus, 'cases.json'),
      JSON.stringify({
        schemaVersion: 'sentinel-framework-feasibility-corpus-v1',
        cases: [{ id: 'original', files: [file] }],
      }),
    );
    assert.ok((await loadCorpus(corpus)).indexSha256);
    const materialized = await materializeCase({ files: [file] }, build, corpus);
    assert.equal(sha(await readFile(join(build, file.path))), file.sha256);
    assert.equal((await verifyAcquisitionInputs(build, materialized)).length, 1);
    const generated = await writeGeneratedFile(build, 'probe.sh', '#!/bin/sh\nexit 0\n', 0o755);
    assert.equal(sha(await readFile(join(build, 'probe.sh'))), generated.sha256);
    assert.equal((await stat(join(build, 'probe.sh'))).mode & 0o777, 0o755);
    await writeFile(join(build, file.path), 'changed');
    await assert.rejects(verifyAcquisitionInputs(build, materialized), /identity mismatch/);
    await assert.rejects(writeGeneratedFile(build, '../escaped', 'inert'), /Unsafe/);
    await assert.rejects(writeGeneratedFile(build, 'too-big', 'X'.repeat(2 * 1024 * 1024 + 1)), /bounds/);
    await symlink(outside, join(corpus, 'link'));
    await writeFile(join(outside, 'app.fixture'), bytes);
    await assert.rejects(
      materializeCase({ files: [{ ...file, source: 'link/app.fixture' }] }, join(directory, 'refused'), corpus),
      /plain directory/,
    );
    await rm(join(corpus, file.source));
    await symlink(join(outside, 'app.fixture'), join(corpus, file.source));
    await assert.rejects(materializeCase({ files: [file] }, join(directory, 'refused-file'), corpus), /regular file/);
    await symlink(outside, join(build, 'link'));
    await assert.rejects(writeGeneratedFile(build, 'link/escape', 'inert'), /plain directory/);
    await symlink(corpus, join(directory, 'linked-corpus'));
    await assert.rejects(loadCorpus(join(directory, 'linked-corpus')), /plain directory/);
    await rm(join(corpus, 'cases.json'));
    await symlink(join(outside, 'app.fixture'), join(corpus, 'cases.json'));
    await assert.rejects(loadCorpus(corpus), /regular file/);
    await rm(join(corpus, 'cases.json'));
    await writeFile(join(corpus, 'cases.json'), 'X'.repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(loadCorpus(corpus), /bounded/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
