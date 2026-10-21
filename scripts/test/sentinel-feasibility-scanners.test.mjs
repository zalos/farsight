import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, stat, cp, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CANDIDATES, parseArgs, preview, containerArgs, verifyBinary, execute,
  runContainer, cleanupOwned, materialize, scanCommand, assessScan, runProbe, scenarioControl, evaluateControls, scriptProvenance } from '../sentinel-feasibility-scanners.mjs';

const script = resolve('scripts/sentinel-feasibility-scanners.mjs');
const corpus = resolve('packages/sentinel/test/fixtures/feasibility');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ok = stdout => ({ exitCode: 0, stdout, stderr: '', timedOut: false, cancelled: false, outputExceeded: false, spawnError: null });
const spec = () => ({ candidate: CANDIDATES[0], scenario: 'paired-baseline', source: '/synthetic/input', rules: '/synthetic/rules', binary: '/synthetic/tool', command: scanCommand('paired-baseline') });

test('preview launches no external program and does not require a container or binary', () => {
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: '/does-not-exist' } });
  const plan = JSON.parse(output);
  assert.equal(plan.mode, 'preview');
  assert.deepEqual(plan.effects.programs, []);
  assert.equal(plan.effects.acquisition, false);
  assert.equal(plan.effects.hostScannerExecution, false);
  assert.equal(preview().effects.localWrites, 'none');
  assert.equal(parseArgs([]).run, false);
  assert.throws(() => parseArgs(['--run']), /requires/);
  assert.throws(() => parseArgs(['--out']), /Missing value/);
  assert.throws(() => parseArgs(['--pull']), /Unknown option/);
});

test('fixed Docker arguments forbid acquisition and bind only explicit synthetic paths', () => {
  for (const candidate of CANDIDATES) {
    const args = containerArgs({ ...spec(), candidate, name: 'owned-name', owner: 'owner-token' });
    const value = flag => args[args.indexOf(flag) + 1];
    assert.equal(args[0], 'create');
    assert.equal(value('--pull'), 'never');
    assert.equal(value('--network'), 'none');
    assert.equal(value('--user'), '65534:65534');
    assert.equal(value('--cap-drop'), 'ALL');
    assert.equal(value('--security-opt'), 'no-new-privileges:true');
    assert.equal(value('--memory'), '2g'); assert.equal(value('--cpus'), '2'); assert.equal(value('--pids-limit'), '128');
    assert.ok(args.includes('--read-only'));
    assert.equal(value('--tmpfs'), '/tmp:rw,exec,nosuid,size=256m,mode=1777');
    assert.equal(value('--entrypoint'), candidate.entrypoint);
    assert.ok(args.includes(candidate.image));
    const mounts = args.filter((_, index) => args[index - 1] === '--mount');
    assert.equal(mounts.length, candidate.id === 'opengrep' ? 3 : 2);
    assert.ok(mounts.every(mount => mount.endsWith(',readonly')));
    assert.ok(mounts.every(mount => !/socket|docker.sock|home|credentials/.test(mount)));
    assert.ok(!args.includes('--privileged'));
    assert.ok(args.includes('SEMGREP_APP_TOKEN='));
  }
});

test('missing or tampered binary is refused before Docker or output creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-scanner-test-'));
  try {
    let calls = 0;
    const runner = async () => { calls++; throw new Error('must not run'); };
    await assert.rejects(runProbe({ binary: join(root, 'missing'), out: join(root, 'out') }, { runner }), /ENOENT/);
    const bad = join(root, 'bad'); await writeFile(bad, 'synthetic-not-a-binary');
    await assert.rejects(verifyBinary(bad), /checksum/);
    const link = join(root, 'link'); await symlink(bad, link);
    await assert.rejects(verifyBinary(link), /symbolic link/);
    assert.equal(calls, 0);
    await assert.rejects(stat(join(root, 'out')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function fakeDocker({ mismatch = false, timeout = false, corruptInspect = false, containerExit = 0, clientExit = 0, running = false } = {}) {
  const calls = [], id = 'a'.repeat(64);
  let owner, removed = false;
  const runner = async (program, args) => {
    calls.push({ program, args });
    assert.equal(program, 'docker');
    if (args[0] === 'create') {
      owner = args.find(a => a.startsWith('org.farsight.sentinel-feasibility.owner=')).split('=')[1];
      return ok(id);
    }
    if (args[0] === 'inspect' && removed) return { ...ok(''), exitCode: 1, stderr: 'Error: No such object: ' + id };
    if (args[0] === 'inspect') return ok(corruptInspect ? '{}' : JSON.stringify([{ Id: id, Image: 'sha256:pinned-image',
      Config: { Image: CANDIDATES[0].image, Labels: { 'org.farsight.sentinel-feasibility.owner': mismatch ? 'someone-else' : owner }, User: '65534:65534' },
      HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true }, State: { ExitCode: containerExit, Running: running, Status: running ? 'running' : 'exited', Dead: false, OOMKilled: false }, Mounts: [] }]));
    if (args[0] === 'start') return timeout ? { ...ok(''), exitCode: null, timedOut: true } : { ...ok('{"results":[],"paths":{"scanned":[]}}'), exitCode: clientExit };
    if (args[0] === 'rm') { removed = true; return ok(id); }
    throw new Error('unexpected Docker command');
  };
  return { calls, runner, id };
}

test('timeout cleans only the exact container with the matching owner label', async () => {
  const fake = fakeDocker({ timeout: true });
  const result = await runContainer(spec(), fake.runner);
  assert.equal(result.state, 'failed');
  assert.equal(result.execution.timedOut, true);
  assert.equal(result.cleanup.state, 'removed-owned-container');
  assert.deepEqual(fake.calls.find(c => c.args[0] === 'rm').args, ['rm', '--force', fake.id]);
  assert.equal(fake.calls.filter(c => c.args[0] === 'inspect').length, 4);
  assert.equal(result.isolation.networkMode, 'none');
});

test('ownership mismatch refuses both start and cleanup without broad fallback', async () => {
  const fake = fakeDocker({ mismatch: true });
  const result = await runContainer(spec(), fake.runner);
  assert.equal(result.state, 'failed');
  assert.equal(result.cleanup.state, 'refused');
  assert.ok(!fake.calls.some(c => c.args[0] === 'start' || c.args[0] === 'rm'));
  assert.match(result.reason, /ownership mismatch/);
});

test('unavailable inspect never authorizes removal', async () => {
  const calls = [];
  const result = await cleanupOwned(async (program, args) => { calls.push({ program, args }); return { ...ok(''), exitCode: 1 }; }, 'owned-name', 'owner');
  assert.equal(result.state, 'cleanup-failed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'inspect');
});

test('cleanup distinguishes explicit absence from daemon failure, timeout and permission denial', async () => {
  for (const [inspection, expected] of [
    [{ ...ok(''), exitCode: 1, stderr: 'Error: No such object: owned-name' }, 'not-found'],
    [{ ...ok(''), exitCode: 1, stderr: 'Cannot connect to the Docker daemon' }, 'cleanup-failed'],
    [{ ...ok(''), exitCode: 1, timedOut: true, stderr: 'Error: No such object: owned-name' }, 'cleanup-failed'],
    [{ ...ok(''), exitCode: 1, stderr: 'permission denied on daemon socket' }, 'cleanup-failed'],
  ]) {
    const calls = [];
    const result = await cleanupOwned(async (program, args) => { calls.push({ program, args }); return inspection; }, 'owned-name', 'owner');
    assert.equal(result.state, expected);
    assert.equal(calls.length, 1);
  }
});

test('container exit and stopped state are authoritative over a successful Docker client', async () => {
  for (const options of [{ containerExit: 2 }, { running: true }]) {
    const fake = fakeDocker(options), result = await runContainer(spec(), fake.runner);
    assert.equal(result.state, 'failed');
    assert.equal(result.containerExitMatchesClient, false);
    assert.equal(result.cleanup.state, 'removed-owned-container');
  }
  const fake = fakeDocker({ clientExit: 7, containerExit: 7 });
  const result = await runContainer({ ...spec(), scenario: 'missing-rules' }, fake.runner);
  assert.equal(result.state, 'failed');
  assert.equal(result.containerCompleted, true);
  assert.equal(result.containerExitMatchesClient, true);
  assert.equal(result.containerExit, 7);
});

test('materialization preserves exact original bytes and identifies all narrow-rule pairs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-materialize-test-'));
  try {
    const before = await readFile(join(corpus, 'cases.json'));
    const materialized = await materialize(root);
    assert.equal(materialized.indexHash, sha(before));
    assert.equal(materialized.inputs.length, 5); // TS, JS, Java, two rules.
    assert.equal(materialized.expectations.reduce((n, r) => n + r.matches.length, 0), 3);
    assert.equal(materialized.expectations.reduce((n, r) => n + r.noMatches.length, 0), 3);
    for (const input of materialized.inputs) {
      const file = input.path.startsWith('rules/') ? join(root, input.path) : join(materialized.source, input.path);
      assert.equal(sha(await readFile(file)), input.sha256);
      assert.equal((await stat(file)).mode & 0o777, 0o644);
    }
    assert.ok(materialized.oversize.bytes > 4096);
    assert.equal(sha(await readFile(join(materialized.oversizeSource, 'oversized.ts'))), materialized.oversize.sha256);
    assert.equal(sha(await readFile(join(corpus, 'cases.json'))), sha(before));
    await assert.rejects(materialize(root), /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing-rule control stays explicit and no registry configuration is used', () => {
  const missing = scanCommand('missing-rules');
  assert.equal(missing[missing.indexOf('--config') + 1], '/rules/not-present.yaml');
  for (const scenario of ['paired-baseline', 'oversized', 'missing-rules']) {
    const args = scanCommand(scenario);
    assert.ok(args.includes('--metrics=off'));
    assert.ok(!scanCommand(scenario, CANDIDATES[1]).includes('--metrics=off'));
    assert.ok(args.includes('--disable-version-check'));
    assert.ok(!args.some(a => /^https?:|^p\/|^r\//.test(a)));
    assert.equal(args[args.indexOf('--max-target-bytes') + 1], '4096');
  }
});

test('exit zero does not imply coverage; safe sibling and duplicate locations are checked independently', () => {
  const rule = { id: 'original-rule', matches: [{ case: 'pair', path: 'a.ts', symbol: 'unsafe' }], noMatches: [{ case: 'pair', path: 'a.ts', symbol: 'safe' }] };
  const finding = { check_id: rule.id, path: '/input/pair/a.ts', start: { line: 2 } };
  const record = { state: 'measured', execution: { exitCode: 0, stdout: JSON.stringify({ results: [finding, finding], errors: [], paths: { scanned: ['pair/a.ts'] } }) } };
  const result = assessScan(record, [rule], { 'pair/a.ts': 'export function unsafe() {\n db.query(prefix + input);\n}\nexport function safe() {\n db.query(sql, [input]);\n}\n' });
  assert.equal(result.positiveSymbols[0].matched, true);
  assert.equal(result.positiveSymbols[0].rawLocations, 2);
  assert.equal(result.negativeSymbols[0].matched, false);
  assert.ok(result.gaps.includes('skipped-file-reasons-unavailable'));
  const skipped = assessScan({ ...record, execution: { exitCode: 0, stdout: '{"results":[],"paths":{"scanned":[],"skipped":[{"path":"a.ts","reason":"too_big"}]}}' } }, [], {});
  assert.deepEqual(skipped.coverage.scanned, []);
  assert.equal(skipped.coverage.skipped[0].reason, 'too_big');
});

test('subprocess bounds and literal arguments do not use a shell', async () => {
  const literal = '$(echo should-not-execute);`echo neither`';
  const result = await execute(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(result.stdout, literal);
  assert.equal(result.exitCode, 0);
  const tooMuch = await execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000)); setTimeout(()=>{},10000)'], { maxOutput: 64 });
  assert.equal(tooMuch.outputExceeded, true);
  assert.ok(Buffer.byteLength(tooMuch.stdout) <= 64);
  const timeout = await execute(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 50 });
  assert.equal(timeout.timedOut, true);
});

function passingTrial(scenario, candidate = CANDIDATES[0]) {
  const trial = { candidate: candidate.id, scenario, expectedImage: candidate.image,
    isolation: { id: 'a'.repeat(64), image: candidate.image, networkMode: 'none' }, cleanup: { state: 'removed-owned-container' },
    execution: ok(''), containerCompleted: true, containerExitMatchesClient: true, containerExit: 0,
    versionMatches: true, denialObserved: true, socketAttempt: { connected: false },
    assessment: { parseableJson: true, errors: [], positiveSymbols: Array.from({ length: 3 }, () => ({ matched: true })),
      negativeSymbols: Array.from({ length: 3 }, () => ({ matched: false })), coverage: { scanned: [] }, oversizedNotScanned: true } };
  if (scenario === 'missing-rules') { trial.execution.exitCode = 7; trial.containerExit = 7; trial.assessment.missingRuleDiagnostic = true; }
  return trial;
}

test('baseline control requires execution, valid JSON, every positive and every safe sibling', () => {
  assert.equal(scenarioControl(passingTrial('paired-baseline')).passed, true);
  for (const mutate of [
    t => { t.execution.exitCode = 1; }, t => { t.execution.timedOut = true; },
    t => { t.assessment.parseableJson = false; }, t => { t.assessment.positiveSymbols[0].matched = false; },
    t => { t.assessment.positiveSymbols.pop(); }, t => { t.assessment.negativeSymbols[0].matched = true; },
    t => { t.assessment.negativeSymbols.pop(); }, t => { t.assessment.errors.push({ type: 'ParseError' }); },
  ]) {
    const trial = passingTrial('paired-baseline'); mutate(trial);
    assert.equal(scenarioControl(trial).passed, false);
  }
});

test('malformed engine JSON shapes retain a failed assessment instead of discarding raw trial evidence', () => {
  for (const stdout of ['null', '[]', '{"results":{}}', '{"errors":{}}']) {
    const trial = passingTrial('paired-baseline');
    trial.execution.stdout = stdout;
    trial.assessment = assessScan(trial, [], {});
    assert.ok(trial.assessment.gaps.includes('invalid-engine-output-shape'));
    assert.equal(scenarioControl(trial).passed, false);
    assert.equal(trial.execution.stdout, stdout);
  }
});

test('oversize control cannot pass on failed execution or unavailable omission evidence', () => {
  assert.equal(scenarioControl(passingTrial('oversized')).passed, true);
  for (const mutate of [
    t => { t.execution.exitCode = 1; }, t => { t.assessment.parseableJson = false; },
    t => { t.assessment.coverage.scanned = null; }, t => { t.assessment.oversizedNotScanned = false; },
  ]) {
    const trial = passingTrial('oversized'); mutate(trial);
    assert.equal(scenarioControl(trial).passed, false);
  }
});

test('missing rule control requires an actual nonzero completion, not a timeout or launch failure', () => {
  assert.equal(scenarioControl(passingTrial('missing-rules')).passed, true);
  for (const mutate of [
    t => { t.execution.exitCode = 0; }, t => { t.execution.exitCode = null; },
    t => { t.execution.timedOut = true; }, t => { t.execution.cancelled = true; },
    t => { t.execution.spawnError = 'ENOENT'; }, t => { t.execution.outputExceeded = true; },
    t => { t.execution.exitSignal = 'SIGKILL'; },
    t => { t.containerExitMatchesClient = false; }, t => { t.containerCompleted = false; },
  ]) {
    const trial = passingTrial('missing-rules'); mutate(trial);
    assert.equal(scenarioControl(trial).passed, false);
  }
});

test('unknown scanner option never satisfies the missing-rule negative control', () => {
  for (const [stdout, stderr] of [
    ['', "unknown option '--metrics'"],
    ['{"errors":[{"message":"unknown option --metrics"}]}', ''],
    ['{"errors":[{"message":"unknown config argument /rules/not-present.yaml"}]}', ''],
  ]) {
    const trial = passingTrial('missing-rules');
    trial.execution = { ...ok(stdout), exitCode: 2, stderr }; trial.containerExit = 2;
    trial.assessment = assessScan(trial, [], {});
    assert.equal(scenarioControl(trial).passed, false);
  }
  const trial = passingTrial('missing-rules');
  trial.execution.stdout = JSON.stringify({ errors: [{ message: 'WARNING: unable to find a config; path `/rules/not-present.yaml` does not exist' }] });
  trial.assessment = assessScan(trial, [], {});
  assert.equal(scenarioControl(trial).passed, true);
});

test('overall control verdict includes all scenarios, versions, network, cleanup and immutable input identity', () => {
  const fresh = () => ({ trials: [...CANDIDATES.flatMap(c => ['version', 'paired-baseline', 'oversized', 'missing-rules'].map(s => passingTrial(s, c))), passingTrial('network-denial')],
    inputIntegrity: Array.from({ length: 7 }, () => ({ unchanged: true })), inputManifestHash: 'b'.repeat(64),
    provenance: { sha256: 'c'.repeat(64), revision: 'd'.repeat(40), dirty: false } });
  assert.equal(evaluateControls(fresh()).passed, true);
  for (const mutate of [
    r => { r.trials.pop(); }, r => { r.trials[0].versionMatches = false; },
    r => { r.trials[1].cleanup.state = 'refused'; }, r => { r.trials[8].denialObserved = false; },
    r => { r.trials[8].isolation.networkMode = 'bridge'; }, r => { r.trials[8].socketAttempt.connected = true; },
    r => { r.trials[0].isolation.image = 'other-image'; }, r => { r.inputIntegrity[0].unchanged = false; },
    r => { r.inputIntegrity = []; }, r => { r.provenance.dirty = null; }, r => { r.provenance.sha256 = null; },
  ]) {
    const result = fresh(); mutate(result);
    assert.equal(evaluateControls(result).passed, false);
  }
});

test('provenance records current script bytes, revision and scoped dirty state without Docker', async () => {
  const calls = [];
  const result = await scriptProvenance(async (program, args) => {
    calls.push({ program, args });
    return ok(args.includes('rev-parse') ? 'e'.repeat(40) + '\n' : ' M scripts/sentinel-feasibility-scanners.mjs\n');
  });
  assert.equal(result.sha256, sha(await readFile(script)));
  assert.equal(result.revision, 'e'.repeat(40));
  assert.equal(result.dirty, true);
  assert.ok(calls.every(c => c.program === 'git'));
});

test('materialization refuses symbolic output root, corpus root, index, source and source parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-no-links-test-'));
  try {
    const actualRoot = join(root, 'actual-root'); await mkdir(actualRoot);
    const outputLink = join(root, 'output-link'); await symlink(actualRoot, outputLink);
    await assert.rejects(materialize(outputLink), /symbolic link/);
    const corpusLink = join(root, 'corpus-link'); await symlink(corpus, corpusLink);
    await assert.rejects(materialize(actualRoot, corpusLink), /symbolic link/);
    for (const kind of ['index', 'source', 'parent']) {
      const fixture = join(root, `fixture-${kind}`); await cp(corpus, fixture, { recursive: true });
      const output = join(root, `out-${kind}`); await mkdir(output);
      const index = JSON.parse(await readFile(join(fixture, 'cases.json')));
      const source = index.cases.find(c => c.id === 'ts-injection-pair').files[0].source;
      const target = kind === 'index' ? join(fixture, 'cases.json') : kind === 'source' ? join(fixture, source) : join(fixture, 'sources');
      await rename(target, `${target}.original`); await symlink(`${target}.original`, target);
      await assert.rejects(materialize(output, fixture), /symbolic link/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
