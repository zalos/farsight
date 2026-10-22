// Injected Docker/Git protocol fixtures only. No build, image pull, application or network execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runAcquire, runRun, runDispose, validateDisposalIdentity, exactImageAbsent, gitProvenance, runtimePlatform, harnessFileHashes, validateAcquisitionManifest, validateAcquiredEvidence, readBoundedPlain, validateMavenVersions, expectedVersions, runHasFailures } from '../sentinel-feasibility-frameworks.mjs';
import { loadCorpus, CORPUS } from '../sentinel-feasibility/frameworks/runtime.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const corpus = await loadCorpus(CORPUS);
const imageId = 'sha256:' + '1'.repeat(64);
const nativeHost = { os: 'darwin', arch: 'arm64' };
const dockerVersion = { Client: { Version: '29.2.1', Os: 'darwin', Arch: 'arm64' }, Server: { Version: '29.2.1', Os: 'linux', Arch: 'arm64' } };
const response = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode, exitSignal: null, timedOut: false, cancelled: false, spawnError: null, outputExceeded: false, stdoutSha256: hash(Buffer.from(stdout)), stderrSha256: hash(Buffer.from(stderr)), outputEncoding: 'utf8-scrubbed' });
function lock(caseId) {
  return JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(corpus.index.candidates.filter(c => c.case === caseId).map(c => [`node_modules/${c.id}`, { version: c.version }])) });
}
function fakeRunner(settings = {}) {
  const commands = [], containers = new Map(); let counter = 0;
  const runner = async (program, args, options = {}) => {
    commands.push({ program, args, options });
    if (settings.hook) {
      const value = await settings.hook(program, args, options);
      if (value) return value;
    }
    if (program === 'git') return args.includes('rev-parse') ? response('a'.repeat(40) + '\n') : response('');
    assert.equal(program, 'docker', 'only injected git/docker calls permitted');
    if (args[0] === 'version') return response(JSON.stringify(settings.dockerVersion ?? dockerVersion));
    if (args[0] === 'build') return settings.buildFailure ? response('synthetic build failure', 1) : response('synthetic build complete');
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (args.includes('--format')) return response(`${imageId}|linux|arm64\n`);
      return response(JSON.stringify([{ Id: args[2], Os: 'linux', Architecture: settings.imageArch ?? 'arm64' }]));
    }
    if (args[0] === 'create') {
      const id = (++counter).toString(16).padStart(64, '0'), value = flag => args[args.indexOf(flag) + 1];
      const labels = Object.fromEntries(args.flatMap((entry, i) => entry === '--label' ? [args[i + 1].split('=')] : []));
      const index = args.indexOf(imageId);
      const container = { Id: id, Image: imageId, Platform: 'linux', Config: { Image: imageId, User: value('--user'), Labels: labels },
        HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: null, Privileged: false, SecurityOpt: ['no-new-privileges:true'], Memory: 1073741824, MemorySwap: 1073741824, NanoCpus: 1e9, PidsLimit: 256, Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=128m,mode=1777' } }, Mounts: [],
        State: { Status: 'created', Running: false, OOMKilled: false, Dead: false, ExitCode: 0 },
        evidence: args.includes('--entrypoint') ? args[index + 1] : null };
      containers.set(id, container); return response(id + '\n');
    }
    if (args[0] === 'inspect') {
      const container = containers.get(args.at(-1));
      if (!container) return response('[]\n', 1, `Error response from daemon: No such container: ${args.at(-1)}\n`);
      return response(JSON.stringify([container]));
    }
    if (args[0] === 'start') {
      const container = containers.get(args.at(-1)); assert.ok(container);
      container.State = { Status: 'exited', Running: false, OOMKilled: false, Dead: false, ExitCode: 0 };
      const caseId = container.Config.Labels['org.farsight.sentinel-feasibility-frameworks.case'];
      if (container.evidence === 'package-lock.json') return response((settings.lock ?? lock)(caseId));
      assert.equal(container.evidence, null, 'these protocol tests execute no Maven acquisition');
      const observations = Object.fromEntries(corpus.index.cases.find(c => c.id === caseId).scenarios.map(s => [s.id, s.expectedRuntime]));
      return response('SENTINEL_FIXTURE_PROBE_RESULT=' + JSON.stringify({ status: 'ok', observations }) + '\n');
    }
    if (args[0] === 'rm') { containers.delete(args.at(-1)); return response(args.at(-1) + '\n'); }
    throw new Error('Unexpected injected command: ' + args.join(' '));
  };
  return { runner, commands, containers };
}
async function fixture(t, settings = {}, selected = ['express-order']) {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-fw-acquisition-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = fakeRunner(settings), acquired = join(directory, 'acquired');
  const manifest = await runAcquire({ out: acquired, cases: selected }, { runner: fake.runner, host: nativeHost });
  return { directory, acquired, manifest, fake };
}

test('synthetic acquisition/run retains clean provenance, exact image dependency binding and explicit subset selection', async t => {
  const f = await fixture(t, {}, ['express-order', 'nest-validation']);
  assert.equal(f.manifest.state, 'acquired', JSON.stringify(f.manifest));
  assert.equal(f.manifest.harness.length, 7); assert.ok(f.manifest.harness.some(h => h.path === 'scripts/sentinel-feasibility-scanners.mjs'));
  assert.equal(f.manifest.cases[0].dependencyEvidence[0].bytes, Buffer.byteLength(lock('express-order')));
  const offset = f.fake.commands.length;
  const result = await runRun({ acquired: f.acquired, out: join(f.directory, 'run'), cases: ['express-order'] }, { runner: f.fake.runner, host: nativeHost });
  assert.equal(result.state, 'measured', JSON.stringify(result));
  assert.deepEqual(result.selectedCases, ['express-order']); assert.deepEqual(result.acquisition.selectedCases, ['express-order', 'nest-validation']);
  assert.equal(result.cases.length, 1); assert.equal(result.cases[0].dependencyVerification.length, 1);
  assert.ok(f.fake.commands.slice(offset).every(c => !['build', 'pull'].includes(c.args[0])));
  assert.ok(f.fake.commands.slice(offset).filter(c => c.args[0] === 'create').every(c => c.args.includes('org.farsight.sentinel-feasibility-frameworks.case=express-order')));
  assert.equal(f.fake.containers.size, 0);
});
test('manifest rejects changed corpus/harness, missing imported helper and incomplete or dirty provenance', async t => {
  const f = await fixture(t); assert.equal(f.manifest.state, 'acquired');
  const current = { indexSha256: corpus.indexSha256, harness: await harnessFileHashes() };
  assert.deepEqual(validateAcquisitionManifest(f.manifest, current, ['express-order']), ['express-order']);
  for (const change of [
    m => m.corpus.indexSha256 = '0'.repeat(64), m => m.harness[0].sha256 = '0'.repeat(64), m => m.harness[0].bytes++,
    m => m.harness.pop(), m => m.harness.push(m.harness[0]), m => m.provenance.dirty = true,
    m => delete m.provenance.revisionEvidence, m => m.provenance.statusEvidence.outputExceeded = true,
    m => m.provenance.revisionEvidence.stdout = 'wrong', m => m.state = 'running', m => delete m.endedAt,
    m => delete m.platform.host, m => m.platform.dockerVersion.timedOut = true, m => m.runtime.arch = 'x64',
  ]) { const broken = structuredClone(f.manifest); change(broken); assert.throws(() => validateAcquisitionManifest(broken, current, ['express-order'])); }
});
test('manifest and requested selections reject duplicate, missing, unknown and extra cases without shrinking the request', async t => {
  const f = await fixture(t), current = { indexSha256: corpus.indexSha256, harness: await harnessFileHashes() };
  for (const change of [
    m => m.cases.push(m.cases[0]), m => m.cases = [], m => m.cases[0].caseId = 'unknown',
    m => m.selectedCases.push('nest-validation'), m => m.selectedCases.push('express-order'), m => delete m.selectedCases,
    m => m.cases[0].state = 'failed',
  ]) { const broken = structuredClone(f.manifest); change(broken); assert.throws(() => validateAcquisitionManifest(broken, current, ['express-order'])); }
  for (const selection of [['express-order', 'express-order'], ['nest-validation'], ['unknown']]) assert.throws(() => validateAcquisitionManifest(f.manifest, current, selection));
});
test('retained dependency evidence is read and revalidated instead of trusting acquired state or versionCheck', async t => {
  const f = await fixture(t); const entry = f.manifest.cases[0];
  assert.equal((await validateAcquiredEvidence(entry, f.acquired, corpus)).versionCheck.valid, true);
  const path = join(f.acquired, entry.dependencyEvidence[0].path), original = await readFile(path);
  await writeFile(path, Buffer.concat([original, Buffer.from('\n')]));
  await assert.rejects(validateAcquiredEvidence(entry, f.acquired, corpus), /DEPENDENCY_EVIDENCE_IDENTITY_MISMATCH/);
  await writeFile(path, original);
  const rebound = structuredClone(entry); rebound.dependencyEvidence[0].imageId = 'sha256:' + '2'.repeat(64);
  await assert.rejects(validateAcquiredEvidence(rebound, f.acquired, corpus), /IMAGE_MISMATCH/);
  const wrong = JSON.stringify({ packages: { 'node_modules/express': { version: '4.99.0' } } });
  const fabricated = structuredClone(entry), proof = fabricated.dependencyEvidence[0];
  await writeFile(path, wrong); proof.bytes = Buffer.byteLength(wrong); proof.sha256 = hash(Buffer.from(wrong));
  proof.extraction.execution = response(wrong); fabricated.versionCheck = { valid: true };
  await assert.rejects(validateAcquiredEvidence(fabricated, f.acquired, corpus), /RESOLVED_DEPENDENCY_VERSION_MISMATCH/);
});
test('retained build-context tamper fails before any run container is created', async t => {
  const f = await fixture(t); await writeFile(join(f.acquired, 'express-order/build/server.js'), 'changed source');
  const offset = f.fake.commands.length;
  const result = await runRun({ acquired: f.acquired, out: join(f.directory, 'run'), cases: ['express-order'] }, { runner: f.fake.runner, host: nativeHost });
  assert.equal(result.state, 'failed'); assert.match(result.reason, /RETAINED_BUILD_INPUT_CHANGED/);
  assert.ok(f.fake.commands.slice(offset).every(c => c.args[0] !== 'create'));
});
test('acquisition context edits during build cannot survive the post-build identity check', async t => {
  const f = await fixture(t, { hook: async (_program, args) => {
    if (args[0] === 'build') { await writeFile(join(args.at(-1), 'server.js'), 'altered context'); return response('synthetic build with changed context'); }
    return null;
  } });
  assert.equal(f.manifest.state, 'failed'); assert.match(f.manifest.reason, /RETAINED_BUILD_INPUT_CHANGED/);
  assert.ok(f.fake.commands.every(command => command.args[0] !== 'create'));
});
test('current image lock bytes must match acquisition evidence even if versions still match', async t => {
  const f = await fixture(t); const changed = fakeRunner({ lock: id => lock(id) + '\n' });
  const result = await runRun({ acquired: f.acquired, out: join(f.directory, 'run'), cases: ['express-order'] }, { runner: changed.runner, host: nativeHost });
  assert.equal(result.state, 'failed'); assert.match(result.reason, /CURRENT_IMAGE_DEPENDENCY_EVIDENCE_CHANGED/);
  assert.equal(changed.commands.filter(c => c.args[0] === 'create').length, 1);
  assert.ok(changed.commands.find(c => c.args[0] === 'create').args.includes('--entrypoint'));
});
test('bounded plain readers reject oversized, symbolic and nonregular manifests/evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-fw-reader-unit-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'plain'), '12345'); await symlink(join(dir, 'plain'), join(dir, 'link'));
  await assert.rejects(readBoundedPlain(dir, 'plain', 4), /BOUNDED/);
  await assert.rejects(readBoundedPlain(dir, 'link')); await assert.rejects(readBoundedPlain(dir, '.'));
  await assert.rejects(readBoundedPlain(dir, '../outside'), /UNSAFE/);
});
test('scoped bounded git provenance rejects dirty, interrupted and incomplete evidence', async () => {
  for (const broken of [response(' M scripts/sentinel-feasibility-frameworks.mjs\n'), { ...response(), timedOut: true }, { ...response(), outputExceeded: true }, { ...response(), cancelled: true }]) {
    const fake = fakeRunner({ hook: (program, args) => program === 'git' && args.includes('status') ? broken : null });
    await assert.rejects(gitProvenance(fake.runner), /PROVENANCE_REQUIRED/);
    const status = fake.commands.find(c => c.args.includes('status')); assert.ok(status.args.includes('--'));
    assert.ok(status.args.includes('scripts/sentinel-feasibility-scanners.mjs')); assert.ok(status.options.timeout <= 30000 && status.options.maxOutput <= 1024 ** 2);
  }
  const incomplete = fakeRunner({ hook: (program, args) => program === 'git' && args.includes('rev-parse') ? response('unavailable') : null });
  await assert.rejects(gitProvenance(incomplete.runner), /PROVENANCE_REQUIRED/);
});
test('native host, Docker server and actual image architecture must all be ARM64', async t => {
  const fake = fakeRunner(); await assert.rejects(runtimePlatform(fake.runner, undefined, { os: 'darwin', arch: 'x64' }), /arm64/); assert.equal(fake.commands.length, 0);
  const wrongServer = fakeRunner({ dockerVersion: { ...dockerVersion, Server: { ...dockerVersion.Server, Arch: 'amd64' } } });
  await assert.rejects(runtimePlatform(wrongServer.runner, undefined, nativeHost), /arm64/);
  const f = await fixture(t, { imageArch: 'amd64' }); assert.equal(f.manifest.state, 'failed');
  assert.ok(f.fake.commands.every(c => c.args[0] !== 'create'));
});
test('already-aborted operations launch nothing; failed and cancelled operations persist nonpassing complete selections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-fw-aborted-unit-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const stopped = new AbortController(); stopped.abort(); const fake = fakeRunner();
  await assert.rejects(runAcquire({ out: join(dir, 'never'), cases: ['express-order'] }, { runner: fake.runner, signal: stopped.signal }), /CANCELLED/);
  await assert.rejects(runRun({ out: join(dir, 'never-run'), acquired: dir, cases: ['express-order'] }, { runner: fake.runner, signal: stopped.signal }), /CANCELLED/); assert.equal(fake.commands.length, 0);
  const failed = await fixture(t, { buildFailure: true }, ['express-order', 'nest-validation']);
  const retained = JSON.parse(await readFile(join(failed.acquired, 'acquisition.json'), 'utf8'));
  assert.equal(retained.state, 'failed'); assert.equal(retained.cases.length, 2); assert.equal(retained.cases[1].state, 'not-run');
  const controller = new AbortController(), cancelling = fakeRunner({ hook: (_p, args) => { if (args[0] === 'build') { controller.abort(); return { ...response(), cancelled: true }; } return null; } });
  const result = await runAcquire({ out: join(dir, 'cancelled'), cases: ['express-order', 'nest-validation'] }, { runner: cancelling.runner, signal: controller.signal, host: nativeHost });
  assert.equal(result.state, 'failed'); assert.match(result.reason, /CANCELLED/); assert.equal(result.cases.length, 2);
  assert.equal(runHasFailures({}), true); assert.equal(runHasFailures({ state: 'failed', cases: [] }), true);
});
test('Spring validates exact managed Security and retained parent POM versions, never a declared successful check', () => {
  const expected = { 'org.springframework.boot:spring-boot-starter-parent': '3.4.3', 'org.springframework.security:spring-security-core': '6.4.3' };
  const pom = '<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.4.3</version></parent></project>';
  assert.equal(validateMavenVersions('org.springframework.security:spring-security-core:jar:6.4.3:compile', expected, pom).valid, true);
  assert.equal(validateMavenVersions('org.springframework.security:spring-security-core:jar:6.4.2:compile', expected, pom).valid, false);
  assert.equal(validateMavenVersions('org.springframework.security:spring-security-core:jar:6.4.3:compile', expected, pom.replace('3.4.3', '3.4.2')).valid, false);
  assert.throws(() => expectedVersions({ candidates: [{ id: 'security', case: 'spring-chains', version: 'resolved-by-boot' }] }, 'spring-chains'), /EXACT/);
});
function disposalRunner(tag, { shared = true, firstInspection, tagVerification, imageVerification, removal } = {}) {
  const commands = []; let removed = false;
  const sharedTag = 'separate-acquisition:latest';
  const absent = identity => response('[]\n', 1, `Error response from daemon: No such image: ${identity}\n`);
  const runner = async (program, args, options) => {
    commands.push({ program, args, options }); assert.equal(program, 'docker');
    if (args[0] === 'rmi') { removed = true; return removal ?? response(`Untagged: ${tag}\n`); }
    assert.deepEqual(args.slice(0, 2), ['image', 'inspect']);
    if (args[2] === tag) {
      if (!removed) return firstInspection ?? response(JSON.stringify([{ Id: imageId, RepoTags: [tag, ...(shared ? [sharedTag] : [])] }]));
      return tagVerification ?? absent(tag);
    }
    assert.equal(args[2], imageId);
    return imageVerification ?? (shared ? response(JSON.stringify([{ Id: imageId, RepoTags: [sharedTag] }])) : absent(imageId));
  };
  return { runner, commands, sharedTag };
}
test('disposal removes only the acquisition tag without force and explicitly preserves a shared cached image', async t => {
  const f = await fixture(t), tag = validateDisposalIdentity(f.manifest.cases[0]), disposal = disposalRunner(tag);
  const result = await runDispose({ acquired: f.acquired, cases: ['express-order'] }, disposal.runner);
  const entry = result.cases[0]; assert.equal(entry.state, 'removed-acquisition-tag');
  assert.equal(entry.imageState, 'image-retained/shared'); assert.equal(entry.tagRemoved, true);
  assert.deepEqual(entry.otherTagsBefore, [disposal.sharedTag]); assert.deepEqual(entry.otherTagsAfter, [disposal.sharedTag]);
  assert.deepEqual(disposal.commands.find(c => c.args[0] === 'rmi').args, ['rmi', tag]);
  assert.ok(disposal.commands.every(c => !c.args.includes('--force')));
  assert.ok(entry.inspect && entry.removal && entry.verification && entry.imageVerification);
  const exclusive = disposalRunner(tag, { shared: false });
  const lastTag = await runDispose({ acquired: f.acquired, cases: ['express-order'] }, exclusive.runner);
  assert.equal(lastTag.cases[0].imageState, 'confirmed-absent-by-id');
});
test('disposal never substitutes interrupted or unrelated absence diagnostics for exact tag absence', async t => {
  const f = await fixture(t), tag = validateDisposalIdentity(f.manifest.cases[0]);
  const exact = response('[]\n', 1, `Error response from daemon: No such image: ${tag}\n`);
  assert.equal(exactImageAbsent(exact, tag), true);
  for (const changed of [{ exitCode: 0 }, { exitCode: null }, { timedOut: true }, { cancelled: true }, { outputExceeded: true }, { spawnError: 'ENOENT' }, { exitSignal: 'SIGKILL' }, { stderr: 'Error response from daemon: No such image: unrelated:latest\n' }]) {
    const observation = { ...exact, ...changed }; assert.equal(exactImageAbsent(observation, tag), false);
    const before = disposalRunner(tag, { firstInspection: observation });
    const failedBefore = await runDispose({ acquired: f.acquired, cases: ['express-order'] }, before.runner);
    assert.equal(failedBefore.cases[0].state, 'dispose-failed'); assert.equal(failedBefore.cases[0].imageState, 'unknown');
    assert.ok(before.commands.every(c => c.args[0] !== 'rmi'));
    const after = disposalRunner(tag, { tagVerification: observation });
    const failedAfter = await runDispose({ acquired: f.acquired, cases: ['express-order'] }, after.runner);
    assert.equal(failedAfter.cases[0].state, 'dispose-failed'); assert.ok(failedAfter.cases[0].verification);
  }
  const absentAlready = disposalRunner(tag, { firstInspection: exact });
  const result = await runDispose({ acquired: f.acquired, cases: ['express-order'] }, absentAlready.runner);
  assert.equal(result.cases[0].state, 'acquisition-tag-already-absent'); assert.equal(result.cases[0].imageState, 'not-checked');
  assert.ok(absentAlready.commands.every(c => c.args[0] !== 'rmi'));
});
test('disposal validates exact unique new-manifest targets before mutation and rejects malformed identity or tag', async t => {
  const f = await fixture(t), tag = validateDisposalIdentity(f.manifest.cases[0]);
  for (const change of [m => m.cases.push(m.cases[0]), m => m.cases[0].imageId = 'not-a-content-addressed-id',
    m => m.cases[0].tag = 'unrelated:latest', m => m.cases[0].tag += ':alternate', m => m.cases[0].build.imageId = 'sha256:' + '2'.repeat(64),
    m => m.cases[0].build.inspection.timedOut = true, m => delete m.selectedCases]) {
    const malformed = structuredClone(f.manifest); change(malformed);
    await writeFile(join(f.acquired, 'acquisition.json'), JSON.stringify(malformed));
    const fake = disposalRunner(tag); await assert.rejects(runDispose({ acquired: f.acquired, cases: ['express-order'] }, fake.runner));
    assert.equal(fake.commands.length, 0);
  }
});
test('tag cleanup cannot claim shared image retention or ID absence without its own completed inspection', async t => {
  const f = await fixture(t), tag = validateDisposalIdentity(f.manifest.cases[0]);
  for (const imageVerification of [{ ...response(''), timedOut: true }, response('[]', 1, 'No such image: unrelated:latest'),
    response(JSON.stringify([{ Id: imageId, RepoTags: [] }])), response('[]', 1, `No such image: ${imageId}`)]) {
    const fake = disposalRunner(tag, { imageVerification });
    const result = await runDispose({ acquired: f.acquired, cases: ['express-order'] }, fake.runner);
    assert.equal(result.cases[0].state, 'dispose-failed'); assert.equal(result.cases[0].imageState, 'unknown');
    assert.equal(result.cases[0].tagRemoved, true); assert.ok(result.cases[0].imageVerification);
  }
});
