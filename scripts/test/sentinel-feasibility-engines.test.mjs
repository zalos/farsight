import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, preview, scanCommand } from '../sentinel-feasibility-engines.mjs';
import { CANDIDATES, containerArgs } from '../sentinel-feasibility-scanners.mjs';
import { loadCorpus, validateIndex, readPlain, within } from '../sentinel-feasibility/engine-matrix/corpus.mjs';
import { assess, controls, proposals } from '../sentinel-feasibility/engine-matrix/assess.mjs';

const root = resolve('packages/sentinel/test/fixtures/engine-feasibility');
const corpus = await loadCorpus(root);
const scanned = corpus.index.files.filter(f => f.stage === 'valid').map(f => `/input/${f.path}`);
const result = (findings = [], paths = scanned, errors = []) => ({ execution: { exitCode: 0, stdout: JSON.stringify({ results: findings, errors, paths: { scanned: paths, skipped: [] } }) } });
const finding = (id, mode = 'taint') => {
  const label = corpus.index.labels.find(l => l.id === id);
  return { check_id: `rules.sentinel-engine-${mode}-${label.language === 'java' ? 'java' : 'tsjs'}`, path: `/input/${label.path}`, start: { line: label.startLine + 1 }, end: { line: label.startLine + 1 } };
};
const assessed = (record, mode = 'taint', stage = 'valid') => assess(record, { index: corpus.index, mode, stage });

test('preview is effect-free and run requires explicit paths, never host fallback', () => {
  assert.deepEqual(parseArgs([]), { run: false });
  assert.equal(preview().effects.containerExecution, false);
  assert.throws(() => parseArgs(['--run']), /requires/);
  assert.throws(() => parseArgs(['--host-fallback']), /Unknown/);
  assert.throws(() => parseArgs(['--out', '/tmp/a,b']), /comma/);
  for (const candidate of CANDIDATES) {
    const command = scanCommand('taint', candidate);
    assert.ok(command.includes('--dataflow-traces'));
    assert.equal(command.includes('--metrics=off'), candidate.id === 'semgrep');
    const args = containerArgs({ candidate, name: 'owned', owner: 'test', scenario: 'valid-taint', source: '/input', rules: '/rules', binary: '/binary', command });
    for (const flag of ['--read-only', '--network', '--cap-drop', '--security-opt', '--memory', '--pids-limit']) assert.ok(args.includes(flag));
    assert.equal(args.includes('/tmp:rw,exec,nosuid,size=256m,mode=1777'), candidate.id === 'opengrep');
  }
});
test('frozen independent corpus has all meaningful pairs and verifiable byte identities', () => {
  assert.equal(corpus.inputs.length, 14);
  assert.equal(corpus.index.labels.length, 18);
  assert.equal(corpus.index.files.filter(f => f.stage === 'valid').length, 9);
  assert.equal(corpus.index.files.filter(f => f.stage === 'out-of-rule-language').length, 1);
  assert.ok(corpus.texts['typescript/Main.ts'].includes('database.query(sql, name)'));
  assert.ok(corpus.texts['java/Main.java'].includes('database.query(sql, name)'));
  const broken = structuredClone(corpus.index);
  broken.labels[0].endLine = 100;
  assert.throws(() => validateIndex(broken, corpus.texts), /span/);
  broken.labels[0].endLine = broken.labels[1].endLine;
  assert.throws(() => validateIndex(broken, corpus.texts), /Overlapping/);
});
test('bounded source reader refuses symlinks, escapes and altered hashes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'sentinel-engines-test-'));
  try {
    await writeFile(join(temp, 'plain'), 'inert');
    await symlink(join(temp, 'plain'), join(temp, 'link'));
    assert.throws(() => within(temp, '../escape'), /Unsafe/);
    await assert.rejects(readPlain(temp, 'link'), /regular/);
    await assert.rejects(readPlain(temp, 'plain', 3), /bounded/);
    await cp(root, join(temp, 'corpus'), { recursive: true });
    const index = structuredClone(corpus.index);
    index.files[0].sha256 = '0'.repeat(64);
    await writeFile(join(temp, 'corpus/index.json'), JSON.stringify(index));
    await assert.rejects(loadCorpus(join(temp, 'corpus')), /hash or byte count mismatch/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('exit zero retains omitted file denominator and separate diagnostics', () => {
  const observation = assessed(result([], scanned.slice(1), [{ type: 'PartialParsing', message: 'synthetic unit-test diagnostic' }]));
  assert.equal(observation.requested, 9);
  assert.equal(observation.scannedCount, 8);
  assert.deepEqual(observation.omitted, [scanned[0].slice('/input/'.length)]);
  assert.ok(observation.gaps.includes('requested-inputs-omitted'));
  assert.ok(observation.gaps.includes('engine-reported-diagnostics'));
  assert.equal(observation.labels.length, 18);
});
test('span and rule identity prevent attribution outside independent labels', () => {
  const f = finding('typescript-direct-positive');
  const good = assessed(result([f]));
  assert.equal(good.scores.direct.positiveHits, 1);
  const wrongRule = assessed(result([{ ...f, check_id: 'other-rule' }]));
  assert.equal(wrongRule.unattributedFindings, 1);
  assert.equal(wrongRule.unknownRuleFindings, 1);
  const outside = assessed(result([{ ...f, start: { line: 500 }, end: { line: 500 } }]));
  assert.equal(outside.unattributedFindings, 1);
  const duplicate = assessed(result([f, f]));
  assert.equal(duplicate.scores.direct.positiveHits, 1);
  assert.equal(duplicate.labels.find(l => l.id === 'typescript-direct-positive').locations, 2);
});
test('sink-only matches never satisfy cross-file qualification; trace must name both reviewed locations', () => {
  const f = finding('typescript-cross-file-positive');
  assert.equal(assessed(result([f])).scores['cross-file'].tracedPositiveHits, 0);
  f.extra = { dataflow_trace: { taint_sink: { path: f.path, start: f.start } } };
  assert.equal(assessed(result([f])).scores['cross-file'].tracedPositiveHits, 0);
  f.extra.dataflow_trace.taint_source = { path: '/input/typescript/CrossEntry.ts', start: { line: 3 } };
  assert.equal(assessed(result([f])).scores['cross-file'].tracedPositiveHits, 1);
  f.extra.dataflow_trace.taint_source.start.line = 6;
  assert.equal(assessed(result([f])).scores['cross-file'].tracedPositiveHits, 0);
});
test('safe sibling hit rejects proposed criteria and pattern detection earns no flow credit', () => {
  const positive = corpus.index.labels.filter(l => l.label === 'positive' && l.capability !== 'cross-file').map(l => finding(l.id));
  const taint = { candidate: 'semgrep', scenario: 'valid-taint', controls: { passed: true }, assessment: assessed(result(positive)) };
  const pattern = { candidate: 'semgrep', scenario: 'valid-pattern', controls: { passed: true }, assessment: assessed(result(positive.filter(f => f.start.line < 6).map(f => ({ ...f, check_id: f.check_id.replace('-taint-', '-pattern-') }))), 'pattern') };
  let score = proposals([taint, pattern]).semgrep;
  assert.equal(score.localTaintCriteriaMet, true);
  assert.equal(score.crossFileCriteriaMet, false);
  taint.assessment = assessed(result([...positive, finding('java-local-safe')]));
  score = proposals([taint, pattern]).semgrep;
  assert.equal(score.localTaintCriteriaMet, false);
});
test('out of rule language zero findings remain scoped omission, never clean coverage', () => {
  const observation = assessed(result([], []), 'pattern', 'out-of-rule-language');
  assert.equal(observation.requested, 1);
  assert.equal(observation.omittedCount, 1);
  assert.equal(observation.labels.length, 0);
  assert.ok(observation.gaps.includes('out-of-rule-language-input-is-not-a-clean-check'));
  assert.ok(!controls({ scenario: 'valid-pattern', assessment: observation }).passed);
});

test('missing rule retains all nine requested files as unscanned instead of shrinking denominator', () => {
  const observation = assessed(result([], [], [{ type: 'SemgrepError', message: 'not-present.yaml unavailable' }]), 'pattern', 'missing-rules');
  assert.equal(observation.requested, 9);
  assert.equal(observation.scannedCount, 0);
  assert.equal(observation.omittedCount, 9);
  assert.equal(observation.labels.length, 0);
});
test('invalid output never turns missing evidence into zero omissions or successful capability', () => {
  for (const stdout of ['not-json', JSON.stringify({ results: 'bad', errors: [] })]) {
    const observation = assessed({ execution: { stdout } });
    assert.equal(observation.scanned, null);
    assert.equal(observation.omitted, null);
    assert.equal(observation.requested, 9);
    assert.equal(observation.scores, undefined);
    assert.ok(observation.gaps.length > 0);
  }
});

function controlledRecord(scenario = 'valid-pattern', candidate = CANDIDATES[0]) {
  const record = result();
  return { ...record, scenario, candidate: candidate.id, expectedImage: candidate.image,
    containerCompleted: true, containerExitMatchesClient: true, cleanup: { state: 'removed-owned-container' },
    isolation: { image: candidate.image, networkMode: 'none', readOnlyRootfs: true, user: '65534:65534',
      capDrop: ['ALL'], securityOpt: ['no-new-privileges:true'], tmpfs: { '/tmp': candidate.tmpfs.slice(5) },
      memory: 2147483648, memorySwap: 2147483648, nanoCpus: 2000000000, pidsLimit: 128,
      mounts: ['/input', '/rules', ...(candidate.id === 'opengrep' ? ['/tool/opengrep'] : [])].map(destination => ({ destination, type: 'bind', readWrite: false })) },
    assessment: assessed(record) };
}
const missingDiagnostic = () => ({ level: 'error', type: 'SemgrepError', message: 'unable to find a config; path `/rules/not-present.yaml` does not exist' });
test('missing-rule control requires exit seven and a matching error diagnostic, never result prose or unrelated failures', () => {
  const record = controlledRecord('missing-rules');
  record.execution.exitCode = 7;
  record.assessment.diagnostics = [missingDiagnostic()];
  assert.equal(controls(record).passed, true);
  for (const change of [
    value => value.execution.exitCode = 2,
    value => value.execution.timedOut = true,
    value => value.execution.cancelled = true,
    value => value.execution.outputExceeded = true,
    value => value.execution.spawnError = 'ENOENT',
    value => value.assessment.diagnostics = [],
    value => value.assessment.diagnostics = [{ ...missingDiagnostic(), level: 'warn' }],
    value => value.assessment.diagnostics = [{ ...missingDiagnostic(), message: 'unable to find a config /rules/other.yaml' }],
    value => value.assessment.diagnostics = [{ ...missingDiagnostic(), message: 'unable to find a config /other/rules/not-present.yaml' }],
    value => value.assessment.diagnostics = [{ ...missingDiagnostic(), message: 'unable to find a config /rules/not-present.yaml.backup' }],
    value => value.assessment.diagnostics = [{ ...missingDiagnostic(), message: 'analysis failed for /rules/not-present.yaml for an unrelated reason' }],
    value => { value.assessment.diagnostics = []; value.execution.stdout = JSON.stringify({ results: [{ extra: { message: missingDiagnostic().message } }], errors: [] }); },
  ]) {
    const invalid = structuredClone(record); change(invalid);
    assert.equal(controls(invalid).passed, false);
  }
});
test('valid-file controls require usable skip inventory and reject files reported both scanned and skipped', () => {
  const record = controlledRecord();
  assert.equal(controls(record).passed, true);
  for (const skips of [null, [{ path: '/input/typescript/Main.ts', reason: 'analysis_failed_parser_or_internal_error' }], [{ reason: 'unknown_path' }], [{ path: '/input/other.ts' }], [null]]) {
    const invalid = structuredClone(record); invalid.assessment.skipped = skips;
    assert.equal(controls(invalid).passed, false);
  }
  const partial = controlledRecord('partial');
  partial.assessment = assessed(result([], ['/input/controls/partial.ts'], [partialDiagnostic()]), 'pattern', 'partial');
  partial.assessment.skipped = [{ path: '/input/controls/partial.ts', reason: 'analysis_failed_parser_or_internal_error' }];
  assert.equal(controls(partial).passed, true);
});
test('inspected isolation must match exact tmpfs, swap, mounts and privilege policy for each pinned candidate', () => {
  for (const candidate of CANDIDATES) {
    const record = controlledRecord('valid-pattern', candidate);
    assert.equal(controls(record).passed, true);
    for (const change of [
      value => value.isolation.memorySwap = undefined,
      value => value.isolation.memorySwap = 4294967296,
      value => value.isolation.tmpfs['/tmp'] = value.isolation.tmpfs['/tmp'].replace('size=256m', 'size=2g'),
      value => value.isolation.tmpfs['/tmp'] += ',dev',
      value => value.isolation.tmpfs['/tmp'] += ',exec',
      value => value.isolation.tmpfs['/another'] = 'rw,noexec,size=1m',
      value => value.isolation.securityOpt = ['no-new-privileges:false'],
      value => value.isolation.securityOpt = ['no-new-privileges-other:true'],
      value => value.isolation.securityOpt.push('seccomp=unconfined'),
      value => value.isolation.mounts.push({ destination: '/other', type: 'bind', readWrite: false }),
    ]) {
      const invalid = structuredClone(record); change(invalid);
      assert.equal(controls(invalid).passed, false);
    }
  }
});


function partialDiagnostic() {
  return { level: 'warn', code: 3, path: '/input/controls/partial.ts',
    type: ['PartialParsing', [{ path: '/input/controls/partial.ts', start: { line: 4 }, end: { line: 4 } }]],
    message: 'Syntax error at line /input/controls/partial.ts:4' };
}
function inputControlRecord(scenario, candidate = CANDIDATES[0]) {
  const paths = { partial: 'controls/partial.ts', oversize: 'controls/oversized.ts', 'out-of-rule-language': 'controls/unsupported.rs' };
  const record = controlledRecord(scenario, candidate);
  record.assessment = assessed(result([], scenario === 'partial' ? ['/input/' + paths[scenario]] : [], scenario === 'partial' ? [partialDiagnostic()] : []), 'pattern', scenario);
  record.assessment.skipped = scenario === 'partial' ? [{ path: '/input/' + paths[scenario], reason: 'analysis_failed_parser_or_internal_error' }]
    : scenario === 'oversize' ? [{ path: '/input/' + paths[scenario], reason: 'exceeded_size_limit' }] : [];
  return record;
}
test('all six cross-file labels cite their own caller; safe traces cannot borrow the positive caller span', () => {
  for (const language of ['typescript', 'javascript', 'java']) {
    for (const kind of ['positive', 'safe']) {
      const label = corpus.index.labels.find(l => l.id === `${language}-cross-file-${kind}`);
      const line = kind === 'positive' ? 3 : 6;
      assert.equal(label.sourceStartLine, line);
      assert.equal(label.sourceEndLine, line);
      const sourceLine = corpus.texts[label.sourcePath].split('\n')[line - 1];
      assert.ok(sourceLine.includes(kind === 'positive' ? "request.value() +" : '\"SELECT id FROM customer WHERE name = ?\", request.value()'));
      const f = finding(label.id);
      f.extra = { dataflow_trace: { source: { path: '/input/' + label.sourcePath, start: { line } }, sink: { path: f.path, start: f.start } } };
      assert.equal(assessed(result([f])).labels.find(l => l.id === label.id).crossFileTrace, true);
      f.extra.dataflow_trace.source.start.line = kind === 'positive' ? 6 : 3;
      assert.equal(assessed(result([f])).labels.find(l => l.id === label.id).crossFileTrace, false);
    }
  }
});
test('input controls pass their intended zero-exit observations while preserving explicit gaps outside capability scores', () => {
  for (const candidate of CANDIDATES) for (const scenario of ['partial', 'oversize', 'out-of-rule-language']) {
    const record = inputControlRecord(scenario, candidate);
    assert.equal(controls(record).passed, true);
    assert.ok(record.assessment.gaps.includes(`${scenario}-input-is-not-a-clean-check`));
    assert.equal(record.assessment.scores, undefined);
    assert.equal(record.assessment.requested, 1);
  }
  const partialOmission = inputControlRecord('partial');
  partialOmission.assessment.scanned = []; partialOmission.assessment.scannedCount = 0;
  partialOmission.assessment.omitted = ['controls/partial.ts']; partialOmission.assessment.omittedCount = 1;
  assert.equal(controls(partialOmission).passed, true);
});
test('every input control rejects unrelated configuration failure and unavailable or unreconciled inventories', () => {
  for (const scenario of ['partial', 'oversize', 'out-of-rule-language']) {
    const record = inputControlRecord(scenario);
    for (const change of [
      value => { value.execution.exitCode = 7; value.assessment.diagnostics = [missingDiagnostic()]; },
      value => value.execution.exitCode = 7,
      value => value.execution.timedOut = true,
      value => value.execution.cancelled = true,
      value => value.execution.outputExceeded = true,
      value => value.assessment.scanned = null,
      value => value.assessment.skipped = null,
      value => value.assessment.skipped = [{ reason: 'missing_path' }],
      value => value.assessment.scannedCount = 8,
      value => value.assessment.omittedCount = 8,
      value => value.assessment.requestedFiles = ['controls/unrelated.ts'],
      value => value.assessment.unexpectedScanned = ['unrelated.ts'],
      value => value.assessment.skipped = [{ path: '/input/unrelated.ts', reason: 'exceeded_size_limit' }],
      value => value.assessment.findings = [{ path: 'unrelated.ts' }],
    ]) {
      const invalid = structuredClone(record); change(invalid);
      assert.equal(controls(invalid).passed, false, scenario);
    }
  }
});
test('partial control requires intended malformed-line diagnostic and skip without unrelated errors', () => {
  const record = inputControlRecord('partial');
  for (const change of [
    value => value.assessment.diagnostics = [],
    value => value.assessment.diagnostics = [missingDiagnostic()],
    value => value.assessment.diagnostics.push(missingDiagnostic()),
    value => value.assessment.diagnostics[0].path = '/input/unrelated.ts',
    value => value.assessment.diagnostics[0].type[0] = 'SemgrepError',
    value => value.assessment.diagnostics[0].type[1][0].path = '/input/unrelated.ts',
    value => value.assessment.diagnostics[0].type[1][0].start.line = 1,
    value => value.assessment.skipped = [],
    value => value.assessment.skipped[0].reason = 'exceeded_size_limit',
  ]) {
    const invalid = structuredClone(record); change(invalid);
    assert.equal(controls(invalid).passed, false);
  }
});
test('oversize and rule-language controls require the sole requested omission and zero findings', () => {
  for (const scenario of ['oversize', 'out-of-rule-language']) {
    const record = inputControlRecord(scenario);
    for (const change of [
      value => value.assessment.findings = [{ path: value.assessment.requestedFiles[0] }],
      value => value.assessment.diagnostics = [missingDiagnostic()],
      value => { value.assessment.scanned = [...value.assessment.requestedFiles]; value.assessment.scannedCount = 1; value.assessment.omitted = []; value.assessment.omittedCount = 0; },
    ]) {
      const invalid = structuredClone(record); change(invalid);
      assert.equal(controls(invalid).passed, false);
    }
  }
  for (const change of [value => value.assessment.skipped = [], value => value.assessment.skipped[0].reason = 'analysis_failed_parser_or_internal_error']) {
    const invalid = inputControlRecord('oversize'); change(invalid);
    assert.equal(controls(invalid).passed, false);
  }
});
