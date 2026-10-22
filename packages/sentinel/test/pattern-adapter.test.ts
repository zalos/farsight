// The pattern adapter without a container: pins, rule checks, job building and normalization over synthetic engine
// output shaped like Semgrep 1.181.0's (the real engine runs in pattern-conformance.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import {
  PATTERN_ADAPTER, PATTERN_ENGINE, PATTERN_SUPPORT, ENGINE_ARGS, PATTERN_WORKER_DIGEST, buildPatternJob, patternRuleOf,
  normalizePatternRun, languageOf, PatternError, PATTERN_COVERAGE_REASONS, PATTERN_REFUSAL_REASONS, PATTERN_ERROR_CODES,
} from '../dist/adapters/pattern/index.js';
import { PATTERN_WORKER_BYTES } from '../dist/adapters/pattern/adapter.js';

const PACK = fileURLToPath(new URL('../rules/pattern/', import.meta.url));
const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const manifest = JSON.parse(readFileSync(`${PACK}sentinel-pack.json`, 'utf8'));
const RULES = manifest.rules.map((r: any) => patternRuleOf(r.familyId, r.revision, readFileSync(`${PACK}${r.implementation.rulePath}`)));
const code = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof PatternError, String(e)); return (e as PatternError).code; } return assert.fail('expected a PatternError'); };

function scratch(t: { after(fn: () => void): void }) {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'sentinel-pattern-'));
  chmodSync(d, 0o700);
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
function packTargets() {
  const out: { relativePath: string; path: string; artifact: string }[] = [];
  for (const lang of ['typescript', 'javascript', 'java']) for (const f of readdirSync(`${PACK}fixtures/${lang}`).sort()) {
    const path = `${PACK}fixtures/${lang}/${f}`;
    out.push({ relativePath: `${lang}/${f.replace(/\.fixture$/, '')}`, path, artifact: sha(readFileSync(path)) });
  }
  return out;
}

test('the adapter is pinned: image digest, telemetry off, suppression and ignore controls, shim by digest', () => {
  assert.equal(PATTERN_ENGINE.version, '1.181.0');
  assert.equal(PATTERN_ADAPTER.image, 'semgrep/semgrep@sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b');
  assert.equal(sha(PATTERN_WORKER_BYTES), PATTERN_WORKER_DIGEST);
  assert.deepEqual([...PATTERN_ADAPTER.command], ['/usr/bin/python3', '-I', '-S', '-B', `/input/${PATTERN_WORKER_DIGEST.slice(7)}`]);
  for (const flag of ['--metrics=off', '--disable-version-check', '--disable-nosem', '--no-git-ignore', '--no-rewrite-rule-ids', '--oss-only', '--json', '--dataflow-traces']) {
    assert.ok(ENGINE_ARGS.includes(flag), flag);
  }
  const shim = PATTERN_WORKER_BYTES.toString('utf8');
  assert.match(shim, /SEMGREP_SEND_METRICS': 'off'/);
  assert.match(shim, /SEMGREP_ENABLE_VERSION_CHECK': '0'/);
  assert.doesNotMatch(shim, /APP_TOKEN|urllib|socket|http/, 'the shim has no network or token path');
  assert.match(shim, new RegExp(JSON.stringify(ENGINE_ARGS).replace(/[[\]]/g, '\\$&')));
  const adapter = createAdapterRegistry([PATTERN_ADAPTER]).get('pattern-semgrep');
  assert.equal(adapter.kind, 'external');
  assert.equal(adapter.isolation, 'container');
  assert.equal(PATTERN_SUPPORT.capabilities['cross-file-taint'], 'unsupported');
  assert.equal(PATTERN_SUPPORT.granularity, 'per-file');
});

test('the original pack: every rule has its detector, both fixture kinds and a matching engine id', () => {
  assert.equal(manifest.rights.origin, 'sentinel-original');
  for (const r of manifest.rules) {
    const rule = RULES.find((x: any) => x.familyId === r.familyId);
    assert.equal(rule.kind, r.familyId.includes('request-to-query') ? 'local-taint' : 'structural-locator');
    assert.ok(r.fixtures.positive.length && r.fixtures.negative.length);
    for (const f of [...r.fixtures.positive, ...r.fixtures.negative]) assert.ok(readFileSync(`${PACK}${f}`).length > 0, f);
    assert.equal(r.meaning, 'candidate', 'no rule claims more than a candidate');
  }
});

test('engine rules this adapter cannot run faithfully are refused', () => {
  const ok = { id: 'sentinel.x.rule-one', languages: ['typescript'], severity: 'WARNING', message: 'm', pattern: '$X' };
  const det = (r: unknown) => Buffer.from(JSON.stringify({ rules: [r] }));
  assert.equal(patternRuleOf('sentinel.x.rule-one', 1, det(ok)).kind, 'structural-locator');
  assert.equal(code(() => patternRuleOf('sentinel.x.other', 1, det(ok))), 'sentinel.pattern.ruleInvalid', 'id must be the family');
  for (const extra of [{ paths: { exclude: ['src'] } }, { options: { interfile: true } }, { fix: 'x' }, { mode: 'join' }, { languages: ['python'] }]) {
    assert.equal(code(() => patternRuleOf('sentinel.x.rule-one', 1, det({ ...ok, ...extra }))), 'sentinel.pattern.ruleInvalid', JSON.stringify(extra));
  }
  assert.equal(code(() => patternRuleOf('sentinel.x.rule-one', 1, Buffer.from(JSON.stringify({ rules: [ok, ok] })))), 'sentinel.pattern.ruleInvalid');
});

test('a job writes the worker first, then the job, rules and each target once, and refuses unsafe or mismatched targets', t => {
  const dir = scratch(t);
  const targets = packTargets();
  const built = buildPatternJob(RULES, targets, dir);
  assert.equal(built.inputs[0]!.id, PATTERN_WORKER_DIGEST);
  assert.equal(built.inputs[1]!.id, built.jobDigest);
  assert.equal(built.inputs[2]!.id, built.rulesDigest);
  assert.equal(built.inputs.length, 3 + targets.length);
  assert.deepEqual(built.job.ruleIds, RULES.map((r: any) => r.familyId).sort());
  assert.equal(code(() => buildPatternJob(RULES, [{ ...targets[0]!, relativePath: '../escape.ts' }], scratch(t))), 'sentinel.pattern.targetInvalid');
  assert.equal(code(() => buildPatternJob(RULES, [targets[0]!, targets[0]!], scratch(t))), 'sentinel.pattern.targetInvalid');
  assert.equal(code(() => buildPatternJob(RULES, [{ ...targets[0]!, artifact: sha('other') }], scratch(t))), 'sentinel.pattern.targetInvalid');
  assert.equal(languageOf('a/b.tsx'), 'typescript');
  assert.equal(languageOf('A.java'), 'java');
  assert.equal(languageOf('x.rs'), undefined);
});

// ---- normalization over synthetic engine output --------------------------------------------------------------------

const TREE = '/tmp/sentinel-pattern/tree/';
function run(t: { after(fn: () => void): void }, engine: Record<string, unknown>, record: Record<string, unknown> = {}, state = 'succeeded') {
  const targets = packTargets();
  const built = buildPatternJob(RULES, targets, scratch(t));
  const engineBytes = Buffer.from(JSON.stringify({ version: '1.181.0', engine_requested: 'OSS', results: [], errors: [], paths: { scanned: [], skipped: [] }, ...engine }));
  const recordBytes = Buffer.from(JSON.stringify({ schema: 'sentinel-pattern-run/draft-1', job: built.jobDigest, exitCode: 0, timedOut: false, stdoutTruncated: false, excluded: [], engineOutput: sha(engineBytes), ...record }));
  const bytes = new Map([[sha(engineBytes), engineBytes], [sha(recordBytes), recordBytes]]);
  const outcome: any = {
    state, adapter: { id: 'pattern-semgrep', digest: sha('x') },
    outputs: [
      { id: sha(engineBytes), mediaType: 'application/vnd.semgrep.result+json', bytes: engineBytes.length, path: '' },
      { id: sha(recordBytes), mediaType: 'application/vnd.sentinel.pattern-run+json', bytes: recordBytes.length, path: '' },
    ],
  };
  const paths = new Map(targets.map(x => [x.relativePath, x.path]));
  return normalizePatternRun({ job: built.job, jobDigest: built.jobDigest, rules: RULES, outcome, outputBytes: id => bytes.get(id)!, targetBytes: r => readFileSync(paths.get(r)!) });
}
const all = packTargets().map(x => TREE + x.relativePath);
const directTs = readFileSync(`${PACK}fixtures/typescript/direct.ts.fixture`);
const at = (bytes: Buffer, needle: string) => {
  const s = bytes.indexOf(needle), e = s + Buffer.byteLength(needle);
  const pos = (o: number) => { const before = bytes.subarray(0, o); const line = before.toString('latin1').split('\n').length; return { line, col: o - (before.lastIndexOf(0x0a) + 1) + 1, offset: o }; };
  return { start: pos(s), end: pos(e) };
};
const hit = (rule: string, path: string, needle: string, bytes: Buffer, extra: object = {}) => ({ check_id: rule, path: TREE + path, ...at(bytes, needle), extra: { fingerprint: 'requires login', lines: 'requires login', ...extra } });
const QUERY = 'db.query("SELECT * FROM invoices WHERE id = " + id)';

test('a requested file the engine neither scanned nor skipped is an omission, even on exit zero', t => {
  const r = run(t, { paths: { scanned: all.filter(p => !p.endsWith('typescript/direct.ts')), skipped: [] } });
  const row = r.coverage.find(c => c.relativePath === 'typescript/direct.ts')!;
  assert.equal(row.status, 'omitted');
  assert.equal(row.reasonCode, 'sentinel.pattern.coverage.omitted');
  assert.deepEqual(row.rules, ['sentinel.sql.concatenated-query-tsjs', 'sentinel.sql.request-to-query-tsjs'], 'per-file status stands for every applicable rule');
  assert.equal(r.engineExit, 0);
  assert.ok(r.coverage.filter(c => c.relativePath !== 'typescript/direct.ts').every(c => c.status === 'complete'));
});

test('skips, parse errors and rule timeouts are gaps; engine, attempt and output failures leave nothing checked', t => {
  const r = run(t, {
    paths: { scanned: all.filter(p => !p.endsWith('direct.js')), skipped: [{ path: TREE + 'javascript/direct.js', reason: 'exceeded_size_limit' }, { path: TREE + 'java/Local.java', reason: 'analysis_failed_parser_or_internal_error' }] },
    errors: [{ code: 3, level: 'warn', type: ['PartialParsing', []], path: TREE + 'typescript/local.ts' }, { code: 2, level: 'warn', type: 'Timeout', path: TREE + 'java/Direct.java' }],
  });
  const status = (p: string) => { const c = r.coverage.find(x => x.relativePath === p)!; return `${c.status}:${c.reasonCode.split('.').pop()}`; };
  assert.equal(status('javascript/direct.js'), 'skipped:tooLarge');
  assert.equal(status('java/Local.java'), 'partial:partialParse');
  assert.equal(status('typescript/local.ts'), 'partial:partialParse');
  assert.equal(status('java/Direct.java'), 'partial:ruleTimeout');
  for (const [record, reason] of [[{ timedOut: true }, 'engineTimedOut'], [{ stdoutTruncated: true }, 'outputTruncated'], [{ exitCode: 2 }, 'engineFailed']] as const) {
    const x = run(t, { paths: { scanned: all, skipped: [] } }, record);
    assert.ok(x.coverage.every(c => c.status === 'error' && c.reasonCode.endsWith(reason)), reason);
  }
  for (const [state, reason] of [['timed-out', 'attemptTimedOut'], ['failed', 'attemptFailed'], ['canceled', 'attemptCanceled']] as const) {
    const x = run(t, {}, {}, state);
    assert.ok(x.coverage.every(c => c.status === 'error' && c.reasonCode.endsWith(reason)) && x.findings.length === 0, state);
  }
});

test('results are kept only for job rules, job targets, declared languages and spans that match the captured bytes', t => {
  const good = hit('sentinel.sql.concatenated-query-tsjs', 'typescript/direct.ts', QUERY, directTs);
  const shifted = { ...good, start: { ...good.start, col: good.start.col + 1 } };
  const r = run(t, {
    paths: { scanned: all, skipped: [] },
    results: [
      good,
      { ...good, check_id: 'vendor.injected.rule' },
      { ...good, path: TREE + 'elsewhere/x.ts' },
      { ...good, check_id: 'sentinel.sql.concatenated-query-java' },
      shifted,
      { ...good, end: { ...good.end, offset: directTs.length + 5 } },
    ],
  });
  assert.equal(r.findings.length, 1);
  const f = r.findings[0]!;
  assert.deepEqual(f.evidence, { kind: 'structural-locator' });
  assert.equal(f.span.quoteDigest, sha(Buffer.from(QUERY)));
  assert.deepEqual(r.refused.map(x => x.reasonCode.split('.').pop()), ['unknownRule', 'unknownTarget', 'ruleLanguage', 'spanInvalid', 'spanInvalid']);
  assert.doesNotMatch(JSON.stringify(r), /SELECT|invoices|requires login/, 'no source text and nothing of the engine’s extra fields is kept');
  // Identity is Sentinel's, not the engine's fingerprint.
  const again = run(t, { paths: { scanned: all, skipped: [] }, results: [{ ...good, extra: { fingerprint: 'something-else' } }] });
  assert.equal(again.findings[0]!.id, f.id);
});

test('taint evidence stays local: a same-file trace names its source, a missing trace says so, a cross-file trace is refused', t => {
  const bytes = readFileSync(`${PACK}fixtures/typescript/local.ts.fixture`);
  const sink = at(bytes, 'sql)');
  const sinkHit = { check_id: 'sentinel.sql.request-to-query-tsjs', path: TREE + 'typescript/local.ts', start: sink.start, end: { ...sink.end, col: sink.end.col - 1, offset: sink.end.offset - 1 } };
  const source = at(bytes, 'req.value()');
  const loc = (path: string) => ['CliLoc', [{ path, start: source.start, end: source.end }, 'req.value()']];
  const none = run(t, { paths: { scanned: all, skipped: [] }, results: [sinkHit] });
  assert.deepEqual({ ...none.findings[0]!.evidence, sink: undefined }, { kind: 'local-taint', sink: undefined, source: null, trace: 'not-reported' });
  const same = run(t, { paths: { scanned: all, skipped: [] }, results: [{ ...sinkHit, extra: { dataflow_trace: { taint_source: loc(TREE + 'typescript/local.ts') } } }] });
  const ev = same.findings[0]!.evidence as any;
  assert.equal(ev.trace, 'same-file');
  assert.equal(ev.source.quoteDigest, sha(Buffer.from('req.value()')));
  const cross = run(t, { paths: { scanned: all, skipped: [] }, results: [{ ...sinkHit, extra: { dataflow_trace: { taint_source: loc(TREE + 'typescript/direct.ts') } } }] });
  assert.equal(cross.findings.length, 0);
  assert.equal(cross.refused[0]!.reasonCode, 'sentinel.pattern.refused.crossFile');
});

test('output that names another job, another engine output or another engine version is refused', t => {
  assert.equal(code(() => run(t, {}, { job: sha('another job') })), 'sentinel.pattern.outputInvalid');
  assert.equal(code(() => run(t, {}, { engineOutput: sha('other bytes') })), 'sentinel.pattern.outputInvalid');
  assert.equal(code(() => run(t, { version: '1.180.0' })), 'sentinel.pattern.outputInvalid');
  assert.equal(code(() => run(t, { engine_requested: 'PRO' })), 'sentinel.pattern.outputInvalid');
  assert.equal(code(() => run(t, { results: undefined })), 'sentinel.pattern.outputInvalid');
});

test('every pattern reason code is a catalog entry with both registers and a definition', async () => {
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  const shimCodes = [...PATTERN_WORKER_BYTES.toString('utf8').matchAll(/'(sentinel\.pattern\.[A-Za-z.]+)'/g)].map(m => m[1]!);
  const keys = [...PATTERN_ERROR_CODES, ...PATTERN_COVERAGE_REASONS, ...PATTERN_REFUSAL_REASONS, ...PATTERN_SUPPORT.limitations,
    ...manifest.rules.map((r: any) => r.titleKey), ...manifest.rules.flatMap((r: any) => r.limitationKeys), ...shimCodes];
  assert.ok(shimCodes.length >= 4);
  for (const key of keys) {
    const e = STRINGS[key];
    assert.ok(e && e.hud && e.professional && e.define, key);
  }
});
