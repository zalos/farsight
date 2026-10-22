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
  patternRulesFromResolved, PATTERN_UNSUPPORTED_REASONS, buildPatternAdapter, MAX_PATTERN_TARGETS,
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
  for (const flag of ['--metrics=off', '--disable-version-check', '--disable-nosem', '--no-git-ignore', '--no-rewrite-rule-ids', '--oss-only', '--json', '--dataflow-traces', '--time']) {
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
  assert.equal(PATTERN_SUPPORT.granularity, 'per-file-per-rule');
  // A variant (a test's lowered timeout, say) gets its own shim digest and adapter digest: it cannot pass for this one.
  const variant = buildPatternAdapter({ id: 'pattern-variant', engineArgs: [...ENGINE_ARGS, '--max-memory', '1'] });
  assert.notEqual(variant.workerDigest, PATTERN_WORKER_DIGEST);
  assert.notEqual(createAdapterRegistry([variant.definition]).get('pattern-variant').digest, adapter.digest);
  assert.equal(MAX_PATTERN_TARGETS, 2000);
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
/** Every scanned path timed for every rule, unless the test says otherwise. */
function timing(scanned: string[], zero: Record<string, string[]> = {}) {
  const ids = RULES.map((r: any) => r.familyId);
  return { rules: ids, targets: scanned.map(p => ({ path: p, match_times: ids.map((id: string) => ((zero[p] ?? []).includes(id) ? 0 : 0.001)) })) };
}
function run(t: { after(fn: () => void): void }, engine: Record<string, unknown>, record: Record<string, unknown> = {}, state = 'succeeded') {
  const targets = packTargets();
  const built = buildPatternJob(RULES, targets, scratch(t));
  const scanned = ((engine.paths as any)?.scanned ?? []) as string[];
  const engineBytes = Buffer.from(JSON.stringify({ version: '1.181.0', engine_requested: 'OSS', results: [], errors: [], paths: { scanned: [], skipped: [] }, time: timing(scanned), ...engine }));
  const { __arch: _arch, __targets: _targets, __qualify: _qualify, ...recordFields } = record as any;
  const recordBytes = Buffer.from(JSON.stringify({ schema: 'sentinel-pattern-run/draft-1', job: built.jobDigest, exitCode: 0, timedOut: false, stdoutTruncated: false, excluded: [], engineOutput: sha(engineBytes), ...recordFields }));
  const bytes = new Map([[sha(engineBytes), engineBytes], [sha(recordBytes), recordBytes]]);
  const outcome: any = {
    state, adapter: { id: 'pattern-semgrep', digest: sha('x') }, container: { id: 'c', image: { architecture: (record as any).__arch ?? 'arm64' } },
    outputs: [
      { id: sha(engineBytes), mediaType: 'application/vnd.semgrep.result+json', bytes: engineBytes.length, path: '' },
      { id: sha(recordBytes), mediaType: 'application/vnd.sentinel.pattern-run+json', bytes: recordBytes.length, path: '' },
    ],
  };
  const byArtifact = new Map(targets.map(x => [x.artifact, readFileSync(x.path)]));
  const override = (record as any).__targets as ((a: string, b: Buffer | undefined) => Buffer | undefined) | undefined;
  const qualify = (record as any).__qualify as string | undefined;
  return normalizePatternRun({ job: built.job, jobDigest: built.jobDigest, rules: RULES, outcome, outputBytes: id => bytes.get(id)!, targetBytes: a => (override ? override(a, byArtifact.get(a)) : byArtifact.get(a)), ...(qualify ? { qualifyingArchitecture: qualify } : {}) });
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

const cov = (r: any, path: string, rule?: string) => r.coverage.filter((c: any) => c.relativePath === path && (rule === undefined || c.familyId === rule)).map((c: any) => `${c.status}:${c.reasonCode.split('.').pop()}`);
const CONCAT = 'sentinel.sql.concatenated-query-tsjs';
const TAINT = 'sentinel.sql.request-to-query-tsjs';

test('a requested file the engine neither scanned nor skipped is an omission for each of its rules, even on exit zero', t => {
  const r = run(t, { paths: { scanned: all.filter(p => !p.endsWith('typescript/direct.ts')), skipped: [] } });
  assert.deepEqual(cov(r, 'typescript/direct.ts'), ['omitted:omitted', 'omitted:omitted']);
  assert.deepEqual(r.coverage.filter((c: any) => c.relativePath === 'typescript/direct.ts').map((c: any) => c.familyId), [CONCAT, TAINT]);
  assert.equal(r.engineExit, 0);
  assert.ok(r.coverage.filter((c: any) => c.relativePath !== 'typescript/direct.ts').every((c: any) => c.status === 'complete'));
});

test('a rule counts as run on a file only with a reported match time; without timing nothing is established', t => {
  const zero = timing(all, { [TREE + 'typescript/direct.ts']: [TAINT] });
  const r = run(t, { paths: { scanned: all, skipped: [] }, time: zero });
  assert.deepEqual(cov(r, 'typescript/direct.ts', CONCAT), ['complete:complete']);
  assert.deepEqual(cov(r, 'typescript/direct.ts', TAINT), ['not-run:ruleNotRun'], 'a prefiltered rule is not counted as checked');
  const none = run(t, { paths: { scanned: all, skipped: [] }, time: { rules: [], targets: [] } });
  assert.ok(none.coverage.every((c: any) => c.status === 'not-established'), 'timing that does not name the job rules establishes nothing');
  const missing = run(t, { paths: { scanned: all, skipped: [] }, time: timing(all.filter(p => !p.endsWith('java/Local.java'))) });
  assert.deepEqual(cov(missing, 'java/Local.java'), ['not-established:ruleRunUnreported', 'not-established:ruleRunUnreported']);
});

test('skips, parse errors and per-rule timeouts are gaps; engine, attempt and output failures leave nothing checked', t => {
  const r = run(t, {
    paths: { scanned: all.filter(p => !p.endsWith('direct.js')), skipped: [{ path: TREE + 'javascript/direct.js', reason: 'exceeded_size_limit' }, { path: TREE + 'java/Local.java', reason: 'analysis_failed_parser_or_internal_error' }] },
    errors: [
      { code: 3, level: 'warn', type: ['PartialParsing', []], path: TREE + 'typescript/local.ts' },
      { code: 2, level: 'warn', type: 'Timeout', path: TREE + 'typescript/direct-safe.ts', rule_id: TAINT },
      { code: 2, level: 'warn', type: 'Timeout', path: TREE + 'java/Direct.java' },
    ],
  });
  assert.deepEqual(cov(r, 'javascript/direct.js'), ['skipped:tooLarge', 'skipped:tooLarge']);
  assert.deepEqual(cov(r, 'java/Local.java'), ['partial:partialParse', 'partial:partialParse']);
  assert.deepEqual(cov(r, 'typescript/local.ts'), ['partial:partialParse', 'partial:partialParse']);
  assert.deepEqual(cov(r, 'typescript/direct-safe.ts', TAINT), ['partial:ruleTimeout'], 'a timeout names its rule');
  assert.deepEqual(cov(r, 'typescript/direct-safe.ts', CONCAT), ['complete:complete'], 'the other rule on that file still ran');
  assert.deepEqual(cov(r, 'java/Direct.java'), ['partial:partialParse', 'partial:partialParse'], 'a timeout without a rule leaves every rule short');
  for (const [record, reason] of [[{ timedOut: true }, 'engineTimedOut'], [{ stdoutTruncated: true }, 'outputTruncated'], [{ exitCode: 2 }, 'engineFailed']] as const) {
    const x = run(t, { paths: { scanned: all, skipped: [] } }, record);
    assert.ok(x.coverage.every((c: any) => c.status === 'error' && c.reasonCode.endsWith(reason)), reason);
  }
  for (const [state, reason] of [['timed-out', 'attemptTimedOut'], ['failed', 'attemptFailed'], ['canceled', 'attemptCanceled']] as const) {
    const x = run(t, {}, {}, state);
    assert.ok(x.coverage.every((c: any) => c.status === 'error' && c.reasonCode.endsWith(reason)) && x.findings.length === 0, state);
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

test('a scanned copy that differs from the pinned artifact, or is missing, earns no coverage and keeps no result', t => {
  const good = hit('sentinel.sql.concatenated-query-tsjs', 'typescript/direct.ts', QUERY, directTs);
  const directArtifact = sha(directTs);
  // Same length, different bytes: the span would still "fit", which is exactly why the whole file is re-hashed.
  const changed = Buffer.from(directTs.toString('utf8').replace('invoices', 'invoicez'));
  assert.equal(changed.length, directTs.length);
  const r = run(t, { paths: { scanned: all, skipped: [] }, results: [good] }, { __targets: (a: string, b: Buffer | undefined) => (a === directArtifact ? changed : b) });
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.refused.map((x: any) => x.reasonCode), ['sentinel.pattern.refused.inputMismatch']);
  assert.deepEqual(cov(r, 'typescript/direct.ts'), ['error:inputMismatch', 'error:inputMismatch']);
  const missing = run(t, { paths: { scanned: all, skipped: [] }, results: [good] }, { __targets: (a: string, b: Buffer | undefined) => (a === directArtifact ? undefined : b) });
  assert.equal(missing.findings.length, 0);
  assert.deepEqual(cov(missing, 'typescript/direct.ts'), ['error:inputMismatch', 'error:inputMismatch']);
  assert.ok(missing.coverage.filter((c: any) => c.relativePath === 'typescript/local.ts').every((c: any) => c.status === 'complete'), 'other files are unaffected');
});

test('results from an image platform conformance has not measured are not trusted', t => {
  const good = hit('sentinel.sql.concatenated-query-tsjs', 'typescript/direct.ts', QUERY, directTs);
  const r = run(t, { paths: { scanned: all, skipped: [] }, results: [good] }, { __arch: 'amd64' });
  assert.equal(r.findings.length, 0);
  assert.ok(r.coverage.every((c: any) => c.status === 'error' && c.reasonCode === 'sentinel.pattern.coverage.platformUnmeasured'));
  assert.deepEqual(PATTERN_SUPPORT.platforms.map((p: any) => `${p.platform}:${p.state}`), ['linux/arm64:measured', 'linux/amd64:unmeasured']);
  assert.deepEqual(r.platform, { architecture: 'amd64', state: 'refused' });
  // Only a qualification run that names the listed, unmeasured platform gets results, and they are marked candidate.
  const q = run(t, { paths: { scanned: all, skipped: [] }, results: [good] }, { __arch: 'amd64', __qualify: 'amd64' });
  assert.deepEqual(q.platform, { architecture: 'amd64', state: 'candidate' });
  assert.equal(q.findings.length, 1);
  const unlisted = run(t, { paths: { scanned: all, skipped: [] }, results: [good] }, { __arch: 'riscv64', __qualify: 'riscv64' });
  assert.equal(unlisted.platform.state, 'refused', 'a platform the pinned index does not list cannot be qualified this way');
  assert.deepEqual(run(t, { paths: { scanned: all, skipped: [] } }).platform, { architecture: 'arm64', state: 'measured' });
});

test('output that names another job, another engine output or another engine version is refused', t => {
  assert.equal(code(() => run(t, {}, { job: sha('another job') })), 'sentinel.pattern.outputInvalid');
  assert.equal(code(() => run(t, {}, { engineOutput: sha('other bytes') })), 'sentinel.pattern.outputInvalid');
  assert.equal(code(() => run(t, { version: '1.180.0' })), 'sentinel.pattern.outputInvalid');
  assert.equal(code(() => run(t, { engine_requested: 'PRO' })), 'sentinel.pattern.outputInvalid');
  assert.equal(code(() => run(t, { results: undefined })), 'sentinel.pattern.outputInvalid');
});

test('resolved rules become adapter rules only when this adapter can run them, with their detector bytes pinned', () => {
  const files = manifest.rules.map((r: any) => ({ path: r.implementation.rulePath, digest: sha(readFileSync(`${PACK}${r.implementation.rulePath}`)) }));
  const bytesOf = (digest: string) => readFileSync(`${PACK}${files.find((f: any) => f.digest === digest)!.path}`);
  const resolved = (r: any, over: any = {}) => ({ familyId: r.familyId, revision: r.revision, definitionDigest: sha('def'), packDigest: sha('pack'), lockDigest: sha('lock'), definition: { ...r, ...over } });
  const out = patternRulesFromResolved(manifest.rules.map((r: any) => resolved(r)), files, bytesOf);
  assert.deepEqual(out.rules.map(r => r.familyId), manifest.rules.map((r: any) => r.familyId));
  assert.equal(out.rules[0]!.pins!.lockDigest, sha('lock'));
  assert.equal(out.rules[0]!.pins!.detectorDigest, files[0]!.digest);
  assert.deepEqual(out.unsupported, []);
  const r0 = manifest.rules[0];
  const gaps = patternRulesFromResolved([
    resolved(r0, { implementation: { adapterId: 'secrets-gitleaks', rulePath: r0.implementation.rulePath } }),
    resolved(r0, { applicability: { ...r0.applicability, scopeKind: 'surface' } }),
    resolved(r0, { applicability: { ...r0.applicability, frameworks: ['express'] } }),
    resolved(r0, { requires: [...r0.requires, 'interprocedural-flow'] }),
    resolved(r0, { applicability: { ...r0.applicability, languages: ['python'] } }),
  ], files, bytesOf).unsupported.map(u => u.reasonCode.split('.').pop());
  assert.deepEqual(gaps, ['otherAdapter', 'scope', 'framework', 'capability', 'language']);
  // A broken pin is an error, never a quiet gap.
  assert.equal(code(() => patternRulesFromResolved([resolved(r0)], [{ path: r0.implementation.rulePath, digest: sha('other') }], () => readFileSync(`${PACK}${r0.implementation.rulePath}`))), 'sentinel.pattern.ruleInvalid');
  assert.equal(code(() => patternRulesFromResolved([resolved(r0)], [], bytesOf)), 'sentinel.pattern.ruleInvalid');
  assert.equal(code(() => patternRulesFromResolved([resolved(r0, { applicability: { ...r0.applicability, languages: ['java'] } })], files, bytesOf)), 'sentinel.pattern.ruleInvalid', 'definition and engine rule languages must agree');
});

test('every pattern reason code is a catalog entry with both registers and a definition', async () => {
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  const shimCodes = [...PATTERN_WORKER_BYTES.toString('utf8').matchAll(/'(sentinel\.pattern\.[A-Za-z.]+)'/g)].map(m => m[1]!);
  const keys = [...PATTERN_ERROR_CODES, ...PATTERN_COVERAGE_REASONS, ...PATTERN_REFUSAL_REASONS, ...PATTERN_UNSUPPORTED_REASONS, ...PATTERN_SUPPORT.limitations,
    ...manifest.rules.map((r: any) => r.titleKey), ...manifest.rules.flatMap((r: any) => r.limitationKeys), ...shimCodes];
  assert.ok(shimCodes.length >= 4);
  for (const key of keys) {
    const e = STRINGS[key];
    assert.ok(e && e.hud && e.professional && e.define, key);
  }
});
