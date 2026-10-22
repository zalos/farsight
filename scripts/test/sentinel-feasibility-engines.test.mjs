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
