import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, preview, runHasFailures } from '../sentinel-feasibility-frameworks.mjs';
import {
  BASE_IMAGES,
  OWNER_LABEL,
  RUN_UID,
  loadCorpus,
  materializeCase,
  parseProbeOutput,
  evaluateCaseOutcome,
  CORPUS,
} from '../sentinel-feasibility/frameworks/runtime.mjs';
import * as expressFramework from '../sentinel-feasibility/frameworks/express.mjs';
import * as nestFramework from '../sentinel-feasibility/frameworks/nest.mjs';
import * as nextFramework from '../sentinel-feasibility/frameworks/next.mjs';
import * as springFramework from '../sentinel-feasibility/frameworks/spring.mjs';

const script = resolve('scripts/sentinel-feasibility-frameworks.mjs');
const FRAMEWORKS = {
  'express-order': expressFramework,
  'nest-validation': nestFramework,
  'next-matcher': nextFramework,
  'spring-chains': springFramework,
};

test('preview launches no external program and never runs docker', () => {
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: '/does-not-exist' } });
  const plan = JSON.parse(output);
  assert.equal(plan.mode, 'preview');
  assert.equal(plan.effects.acquisition, false);
  assert.equal(plan.effects.execution, false);
  assert.equal(plan.effects.providerCalls, false);
  assert.equal(plan.effects.localWrites, 'none');
  assert.deepEqual(plan.cases.sort(), Object.keys(FRAMEWORKS).sort());
});

test('parseArgs separates acquire from run and requires their own directories', () => {
  assert.equal(parseArgs([]).mode, 'preview');
  assert.throws(() => parseArgs(['--acquire']), /requires a fresh --out/);
  assert.throws(() => parseArgs(['--run']), /requires --acquired/);
  assert.throws(() => parseArgs(['--run', '--out', '/tmp/x']), /requires --acquired/);
  assert.throws(() => parseArgs(['--run', '--acquired', '/tmp/a']), /requires --acquired .* and a fresh --out/);
  assert.throws(() => parseArgs(['--acquire', '--run']), /Only one of --acquire, --run or --dispose/);
  assert.throws(() => parseArgs(['--out', '/tmp/x']), /require --acquire, --run or --dispose/);
  assert.throws(() => parseArgs(['--case', 'not-a-real-framework']), /Unknown or duplicate/);
  assert.throws(() => parseArgs(['--case', 'express-order,express-order']), /Unknown or duplicate/);
  assert.throws(() => parseArgs(['--pull']), /Unknown option/);
  const acquire = parseArgs(['--acquire', '--out', '/tmp/a', '--case', 'express-order,nest-validation']);
  assert.equal(acquire.mode, 'acquire');
  assert.deepEqual(acquire.cases, ['express-order', 'nest-validation']);
  const run = parseArgs(['--run', '--acquired', '/tmp/a', '--out', '/tmp/r']);
  assert.equal(run.mode, 'run');
  assert.equal(run.acquired, resolve('/tmp/a'));
});

test('parseArgs requires --acquired for --dispose and refuses an --out alongside it', () => {
  assert.throws(() => parseArgs(['--dispose']), /requires --acquired/);
  assert.throws(() => parseArgs(['--dispose', '--acquired', '/tmp/a', '--out', '/tmp/o']), /does not take --out/);
  const dispose = parseArgs(['--dispose', '--acquired', '/tmp/a']);
  assert.equal(dispose.mode, 'dispose');
  assert.equal(dispose.acquired, resolve('/tmp/a'));
});

test('base images are pinned by exact digest, not a mutable tag', () => {
  for (const ref of Object.values(BASE_IMAGES)) assert.match(ref, /^[a-z0-9.-]+@sha256:[a-f0-9]{64}$/);
});

test('every probe container runs as the unprivileged run UID, never root', () => {
  assert.equal(RUN_UID, 65534);
  assert.ok(OWNER_LABEL.length > 0 && !OWNER_LABEL.includes(' '));
});

test('runHasFailures rejects missing, empty, failed or mismatched cases', () => {
  assert.equal(runHasFailures({ cases: [{ state: 'measured' }] }), false);
  assert.equal(runHasFailures({ cases: [{ state: 'measured' }, { state: 'failed' }] }), true);
  assert.equal(runHasFailures({ cases: [{ state: 'measured-with-mismatch' }] }), true);
  assert.equal(runHasFailures({}), true);
  assert.equal(runHasFailures({ cases: [] }), true);
});

test('the corpus index loads, and every case file hash matches its fixture bytes', async () => {
  const { index, indexSha256 } = await loadCorpus(CORPUS);
  assert.equal(index.schemaVersion, 'sentinel-framework-feasibility-corpus-v1');
  assert.match(indexSha256, /^[a-f0-9]{64}$/);
  assert.equal(index.cases.length, 4);
  for (const caseId of Object.keys(FRAMEWORKS))
    assert.ok(
      index.cases.some((c) => c.id === caseId),
      `corpus is missing case ${caseId}`,
    );
});

test('materializeCase refuses a tampered fixture before writing anything usable', async () => {
  const { index } = await loadCorpus(CORPUS);
  const caseEntry = index.cases.find((c) => c.id === 'express-order');
  const tampered = { ...caseEntry, files: [{ ...caseEntry.files[0], sha256: '0'.repeat(64) }] };
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-fw-materialize-'));
  try {
    await assert.rejects(materializeCase(tampered, dir, CORPUS), /hash mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('materializeCase copies every declared file to its declared relative path', async () => {
  const { index } = await loadCorpus(CORPUS);
  const caseEntry = index.cases.find((c) => c.id === 'next-matcher');
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-fw-materialize-'));
  try {
    const materialized = await materializeCase(caseEntry, dir, CORPUS);
    assert.equal(materialized.length, caseEntry.files.length);
    for (const file of caseEntry.files) assert.ok((await readFile(join(dir, file.path))).length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseProbeOutput requires exactly one well-formed marker line with a status field', () => {
  const noMarker = parseProbeOutput({ stdout: 'listening on 3000\n' });
  assert.equal(noMarker.ok, false);
  assert.equal(noMarker.reason, 'no-result-marker');

  const badJson = parseProbeOutput({ stdout: 'SENTINEL_FIXTURE_PROBE_RESULT={not json}\n' });
  assert.equal(badJson.ok, false);
  assert.equal(badJson.reason, 'invalid-result-json');

  const missingStatus = parseProbeOutput({ stdout: 'SENTINEL_FIXTURE_PROBE_RESULT={"observations":{}}\n' });
  assert.equal(missingStatus.ok, false);

  const healthTimeout = parseProbeOutput({ stdout: 'SENTINEL_FIXTURE_PROBE_RESULT={"status":"health-timeout"}\n' });
  assert.equal(healthTimeout.ok, true);
  assert.equal(healthTimeout.payload.status, 'health-timeout');

  const good = parseProbeOutput({
    stdout: 'booting\nSENTINEL_FIXTURE_PROBE_RESULT={"status":"ok","observations":{"a":{"withoutToken":401}}}\n',
  });
  assert.equal(good.ok, true);
  assert.equal(good.payload.status, 'ok');
  assert.deepEqual(good.payload.observations, { a: { withoutToken: 401 } });
});

// This is the regression for the real bug a source review found: a wrapped/garbled probe payload
// that leaves every scenario's `observed` null must never be read as a pass. An empty, all-null
// assessment array must fail outright, not vacuously satisfy `.every(...)` on nothing.
test('evaluateCaseOutcome fails on any missing observation, and never passes an empty/all-null assessment', () => {
  assert.deepEqual(evaluateCaseOutcome([]), { state: 'failed', reason: 'no-scenarios-assessed' });
  assert.deepEqual(evaluateCaseOutcome(null), { state: 'failed', reason: 'no-scenarios-assessed' });

  const allNull = [
    { scenario: 'a', observed: null, matchesExpected: null },
    { scenario: 'b', observed: null, matchesExpected: null },
  ];
  const allNullOutcome = evaluateCaseOutcome(allNull);
  assert.equal(allNullOutcome.state, 'failed');
  assert.match(allNullOutcome.reason, /missing observation/);

  const oneMissing = [
    { scenario: 'a', expectedRuntime: { status: 200 }, observed: { status: 200 }, matchesExpected: true },
    { scenario: 'b', observed: null, matchesExpected: null },
  ];
  assert.equal(evaluateCaseOutcome(oneMissing).state, 'failed');

  const allPresentOneMismatch = [
    { scenario: 'a', expectedRuntime: { status: 200 }, observed: { status: 200 }, matchesExpected: true },
    { scenario: 'b', expectedRuntime: { status: 200 }, observed: { status: 403 }, matchesExpected: false },
  ];
  assert.equal(evaluateCaseOutcome(allPresentOneMismatch).state, 'measured-with-mismatch');

  // An observed response without a fixed, reviewed expectation cannot count as a passed case.
  const noExpectationButObserved = [
    { scenario: 'a', expectedRuntime: { status: 200 }, observed: { status: 200 }, matchesExpected: true },
    { scenario: 'b', observed: { status: 200 }, matchesExpected: null },
  ];
  assert.equal(evaluateCaseOutcome(noExpectationButObserved).state, 'failed');
});

test('express assess agrees when runtime matches the static expectation, and flags a real mismatch', async () => {
  const { index } = await loadCorpus(CORPUS);
  const caseEntry = index.cases.find((c) => c.id === 'express-order');
  const matching = {
    'auth-before-route': { withoutToken: 401, withToken: 200 },
    'auth-after-route': { withoutToken: 200, withToken: 200 },
    'unknown-custom-middleware': { anyRequest: 403 },
  };
  const agreeing = expressFramework.assess(caseEntry, matching);
  assert.ok(agreeing.every((a) => a.matchesExpected === true));
  assert.equal(evaluateCaseOutcome(agreeing).state, 'measured');

  const brokenLateGate = { ...matching, 'auth-after-route': { withoutToken: 401, withToken: 200 } };
  const mismatched = expressFramework.assess(caseEntry, brokenLateGate);
  assert.equal(mismatched.find((a) => a.scenario === 'auth-after-route').matchesExpected, false);
  assert.equal(evaluateCaseOutcome(mismatched).state, 'measured-with-mismatch');

  const missing = expressFramework.assess(caseEntry, null);
  assert.ok(missing.every((a) => a.observed === null && a.matchesExpected === null));
  assert.equal(evaluateCaseOutcome(missing).state, 'failed');
});

test('nest assess distinguishes the piped route from the unpiped route', async () => {
  const { index } = await loadCorpus(CORPUS);
  const caseEntry = index.cases.find((c) => c.id === 'nest-validation');
  const observed = { 'validator-with-pipe': { invalidBody: 400 }, 'validator-without-pipe': { invalidBody: 201 } };
  const result = nestFramework.assess(caseEntry, observed);
  assert.equal(result.find((a) => a.scenario === 'validator-with-pipe').matchesExpected, true);
  assert.equal(result.find((a) => a.scenario === 'validator-without-pipe').matchesExpected, true);
  assert.equal(evaluateCaseOutcome(result).state, 'measured');
});

test('next assess treats matcher inclusion as necessary but not sufficient', async () => {
  const { index } = await loadCorpus(CORPUS);
  const caseEntry = index.cases.find((c) => c.id === 'next-matcher');
  const observed = {
    'matched-and-blocked': { status: 403 },
    'matched-but-exempted': { status: 200 },
    'excluded-by-matcher': { status: 200 },
  };
  const result = nextFramework.assess(caseEntry, observed);
  assert.ok(result.every((a) => a.matchesExpected === true));
  assert.equal(evaluateCaseOutcome(result).state, 'measured');
});

test('spring assess checks the unmatched-chain scenario against its own frozen expectation, not an exploratory null', async () => {
  const { index } = await loadCorpus(CORPUS);
  const caseEntry = index.cases.find((c) => c.id === 'spring-chains');
  const unmatchedScenario = caseEntry.scenarios.find((s) => s.id === 'unmatched-no-chain-applies');
  assert.equal(unmatchedScenario.staticLabel, 'unknown-enforcement');
  assert.equal(unmatchedScenario.expectedRuntime.withoutCredentials, 200);

  const observed = {
    'overlapping-open-chain': { withoutCredentials: 200 },
    'later-authenticated-chain': { withoutCredentials: 401, withCredentials: 200 },
    'unmatched-no-chain-applies': { withoutCredentials: 200 },
  };
  const result = springFramework.assess(caseEntry, observed);
  assert.equal(result.find((a) => a.scenario === 'overlapping-open-chain').matchesExpected, true);
  assert.equal(result.find((a) => a.scenario === 'later-authenticated-chain').matchesExpected, true);
  const unmatched = result.find((a) => a.scenario === 'unmatched-no-chain-applies');
  assert.equal(unmatched.matchesExpected, true);
  assert.equal(unmatched.observed.withoutCredentials, 200);
  assert.equal(evaluateCaseOutcome(result).state, 'measured');

  // A different real-world outcome for this scenario is a genuine mismatch, not a reason to relabel
  // the scenario as exploratory after the fact.
  const unexpectedlyBlocked = { ...observed, 'unmatched-no-chain-applies': { withoutCredentials: 401 } };
  const mismatched = springFramework.assess(caseEntry, unexpectedlyBlocked);
  assert.equal(mismatched.find((a) => a.scenario === 'unmatched-no-chain-applies').matchesExpected, false);
  assert.equal(evaluateCaseOutcome(mismatched).state, 'measured-with-mismatch');

  const droppedObservation = { ...observed, 'unmatched-no-chain-applies': undefined };
  const incomplete = springFramework.assess(caseEntry, droppedObservation);
  assert.equal(evaluateCaseOutcome(incomplete).state, 'failed');
});

test('every framework module emits a Dockerfile that drops to the unprivileged run UID and never pipes a remote script into a shell', () => {
  for (const [id, framework] of Object.entries(FRAMEWORKS)) {
    const text = framework.dockerfile();
    assert.match(text, /^FROM /, `${id} Dockerfile must start with FROM`);
    assert.ok(
      text.includes(BASE_IMAGES.node) || text.includes(BASE_IMAGES.maven),
      `${id} Dockerfile must use a pinned base image`,
    );
    assert.match(text, /ENTRYPOINT \["\/app\/probe\.sh"\]/, `${id} Dockerfile must run the generated probe script`);
    assert.match(
      text,
      /chown -R 65534:65534 \/app/,
      `${id} Dockerfile must hand ownership to the unprivileged run UID before it starts`,
    );
    assert.ok(!/curl[^\n]*\|\s*sh/.test(text), `${id} Dockerfile must not pipe a remote script into a shell`);
  }
});

test('every probe script prints exactly one result marker line and never execs a shell remote-download pattern', () => {
  for (const [id, framework] of Object.entries(FRAMEWORKS)) {
    const text = framework.probeScript();
    const markers = text.match(/SENTINEL_FIXTURE_PROBE_RESULT=/g) ?? [];
    assert.ok(markers.length >= 1, `${id} probe script must print the result marker`);
    assert.ok(!/curl[^\n]*\|\s*sh/.test(text), `${id} probe script must not pipe a remote script into a shell`);
  }
});
