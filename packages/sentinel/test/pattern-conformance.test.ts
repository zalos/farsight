// The pinned engine itself, through PR 07's isolated execution service only (no host fallback, no pull). Runs with
// SENTINEL_ISOLATION=1, like the isolation canaries; there a missing runtime or a missing pinned image fails. All
// inputs are original synthetic fixtures; no user code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createExecutionService } from '../dist/execution/service.js';
import { PATTERN_ADAPTER, ENGINE_ARGS, buildPatternAdapter, buildPatternJob, patternRuleOf, runPatternAttempt } from '../dist/adapters/pattern/index.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';

const enabled = process.env.SENTINEL_ISOLATION === '1';
/** The opt-in platform qualification job sets this (linux/amd64) to measure a listed, unmeasured platform. */
const QUALIFY = process.env.SENTINEL_PATTERN_QUALIFY ? process.env.SENTINEL_PATTERN_QUALIFY.replace(/^linux\//, '') : undefined;
const skip = !enabled && 'real pinned engine: set SENTINEL_ISOLATION=1 with a qualified local Docker and the pinned Semgrep image installed';
const PACK = fileURLToPath(new URL('../rules/pattern/', import.meta.url));
const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const manifest = JSON.parse(readFileSync(`${PACK}sentinel-pack.json`, 'utf8'));
const RULES = manifest.rules.map((r: any) => patternRuleOf(r.familyId, r.revision, readFileSync(`${PACK}${r.implementation.rulePath}`)));

/** A test variant with a one-second per-rule engine timeout (the engine's smallest): its own shim and adapter digest. */
/** A variant whose engine invocation fails with an adversarial value the engine echoes back in its error. */
const SECRET = 'ghp_FAKEtoken0123456789abcdefSECRET';
/** A plain lowercase word, the shape no word filter can tell from prose: it must never survive either. */
const LOWER = 'hunterpassword';
const LEAKY = buildPatternAdapter({ id: 'pattern-semgrep-leaky-error', engineArgs: ENGINE_ARGS.map((a, i) => (ENGINE_ARGS[i - 1] === '--max-target-bytes' ? `${LOWER} ${SECRET} MixedCase9Token const password = 'Hunter2-src' \x60db.query(x)\x60` : a)) });
const RULE_TIMEOUT = buildPatternAdapter({ id: 'pattern-semgrep-rule-timeout', engineArgs: ENGINE_ARGS.map((a, i) => (ENGINE_ARGS[i - 1] === '--timeout' ? '1' : a)) });
let root: { root: string; work: string };
let store: any;
let service: any;
let n = 0;
before(async () => {
  if (!enabled) return;
  root = scratch('pattern');
  store = await storeIn(root.root);
  const deadline = { ...PATTERN_ADAPTER, id: 'pattern-semgrep-deadline', limits: { timeoutMs: 1500, helloTimeoutMs: 1500, cancelGraceMs: 500 } };
  service = await createExecutionService(store, { scratchRoot: root.work, registry: createAdapterRegistry([PATTERN_ADAPTER, deadline, RULE_TIMEOUT.definition, LEAKY.definition]), containers: true });
});
after(async () => { if (enabled) { await store.close(); removeScratch(root.root); } });

function targets(extra: Record<string, string | Buffer> = {}) {
  const out: { relativePath: string; path: string; artifact: string }[] = [];
  for (const lang of ['typescript', 'javascript', 'java']) for (const f of readdirSync(`${PACK}fixtures/${lang}`).sort()) {
    const path = `${PACK}fixtures/${lang}/${f}`;
    out.push({ relativePath: `${lang}/${f.replace(/\.fixture$/, '')}`, path, artifact: sha(readFileSync(path)) });
  }
  const dir = join(root.root, `extra-${n++}`);
  mkdirSync(dir, { mode: 0o700 });
  for (const [rel, text] of Object.entries(extra)) {
    const path = join(dir, rel.replaceAll('/', '__'));
    writeFileSync(path, text);
    out.push({ relativePath: rel, path, artifact: sha(readFileSync(path)) });
  }
  return out;
}
const attempt = (t: ReturnType<typeof targets>, adapterId?: string, adapter?: typeof RULE_TIMEOUT) => runPatternAttempt(service, {
  attemptId: `att-pattern-${n++}`, work: { id: 'work-pattern', revision: 1 }, rules: RULES, targets: t, scratch: root.root,
  ...(adapterId ? { adapterId } : {}), ...(adapter ? { adapter } : {}), ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}),
});
const POSITIVE = 'export function f(db, id) {\n  return db.query("SELECT * FROM t WHERE id = " + id);\n}\n';

test('the pinned engine finds the original positives, none of the negatives, and reports each file’s coverage', { skip }, async () => {
  const t0 = Date.now();
  const r = await attempt(targets({
    'controls/unsupported.rs': 'fn main() { let q = format!("SELECT {}", x); }\n',
    'controls/broken.ts': POSITIVE + 'const = = ;\n',
    'controls/big.ts': `export const pad = "${'a'.repeat(1_000_100)}";\n${POSITIVE}`,
    'controls/multibyte.ts': `// é ü 東京\n${POSITIVE}`,
  }));
  const wall = Date.now() - t0;
  assert.equal(r.attempt, 'succeeded');
  assert.equal(r.engineExit, 0);
  assert.equal(r.platform.state, QUALIFY ? 'candidate' : 'measured', `platform ${r.platform.architecture}`);
  assert.deepEqual(r.findings.map(f => `${f.familyId} ${f.relativePath} ${f.evidence.kind}`).sort(), [
    'sentinel.sql.concatenated-query-java java/Direct.java structural-locator',
    'sentinel.sql.concatenated-query-tsjs controls/broken.ts structural-locator',
    'sentinel.sql.concatenated-query-tsjs controls/multibyte.ts structural-locator',
    'sentinel.sql.concatenated-query-tsjs javascript/direct.js structural-locator',
    'sentinel.sql.concatenated-query-tsjs typescript/direct.ts structural-locator',
    'sentinel.sql.request-to-query-java java/Local.java local-taint',
    'sentinel.sql.request-to-query-tsjs javascript/local.js local-taint',
    'sentinel.sql.request-to-query-tsjs typescript/local.ts local-taint',
  ]);
  for (const f of r.findings.filter(x => x.evidence.kind === 'local-taint')) assert.equal((f.evidence as any).trace, 'not-reported', 'this engine build reports no trace');
  // The multibyte file's span is in bytes: 17 bytes of comment line before the query line.
  const mb = r.findings.find(f => f.relativePath === 'controls/multibyte.ts')!;
  assert.equal(mb.span.quoteDigest, sha('db.query("SELECT * FROM t WHERE id = " + id)'));
  const status = (path: string) => r.coverage.filter(c => c.relativePath === path).map(c => `${c.familyId?.split('.').pop() ?? '-'}=${c.status}:${c.reasonCode.split('.').pop()}`);
  assert.deepEqual(status('controls/unsupported.rs'), ['-=not-applicable:noRuleLanguage']);
  assert.deepEqual(status('controls/broken.ts'), ['concatenated-query-tsjs=partial:partialParse', 'request-to-query-tsjs=partial:partialParse']);
  assert.deepEqual(status('controls/big.ts'), ['concatenated-query-tsjs=skipped:tooLarge', 'request-to-query-tsjs=skipped:tooLarge']);
  // Each pack file: every rule complete, except a taint rule on a file without the source call, which the engine's
  // prefilter did not run: reported as not run, never as checked.
  for (const c of r.coverage.filter(x => !x.relativePath.startsWith('controls/'))) {
    const hasSource = /\.value\(\)/.test(readFileSync(targets().find(x => x.relativePath === c.relativePath)!.path, 'utf8'));
    const expected = c.familyId!.includes('request-to-query') && !hasSource ? 'not-run' : 'complete';
    assert.equal(c.status, expected, `${c.relativePath} ${c.familyId}`);
  }
  assert.deepEqual(r.refused, []);
  console.log(`# conformance: ${r.findings.length} findings, ${r.coverage.length} coverage rows, ${wall} ms`);
});

test('repository content cannot hide a target or a result: ignore files, suppression comments and default-ignored folders', { skip }, async () => {
  const r = await attempt(targets({
    '.semgrepignore': 'typescript/\njavascript/\njava/\n',
    'controls/.semgrepignore': '*\n',
    'controls/.gitignore': '*\n',
    'controls/suppressed.ts': POSITIVE.replace(');\n', '); // nosemgrep\n'),
    'node_modules/pkg/index.ts': POSITIVE,
    'tests/fixture.ts': POSITIVE,
    'dist/out.js': POSITIVE,
  }));
  const found = new Set(r.findings.map(f => f.relativePath));
  for (const p of ['typescript/direct.ts', 'controls/suppressed.ts', 'node_modules/pkg/index.ts', 'tests/fixture.ts', 'dist/out.js']) assert.ok(found.has(p), p);
  const status = (p: string) => r.coverage.filter(c => c.relativePath === p).map(c => c.status);
  assert.deepEqual(status('.semgrepignore'), ['excluded']);
  assert.deepEqual(status('controls/.gitignore'), ['excluded']);
  assert.deepEqual(status('node_modules/pkg/index.ts'), ['complete', 'not-run']);
});

test('a captured file shaped like a job cannot replace the job: the worker refuses and nothing counts as checked', { skip }, async () => {
  const fake = JSON.stringify({ schema: 'sentinel-pattern-job/draft-1', rules: sha('x'), targets: [] });
  const r = await attempt(targets({ 'config/job.json': fake }));
  assert.equal(r.attempt, 'failed');
  assert.equal(r.findings.length, 0);
  assert.ok(r.coverage.every(c => c.status === 'error' || c.status === 'not-applicable'));
});

test('an engine-reported rule timeout marks exactly that rule on that file, and the run still counts the rest', { skip }, async () => {
  // Measured on darwin-arm64: a 40,000-term concatenation exceeds a one-second rule limit for both TS rules. The engine
  // cannot guarantee that on faster hardware, so this pins the reporting path, not a performance threshold.
  const chain = `export function f(req, db) {\n  const v = req.value();\n  const sql = ${Array.from({ length: 40_000 }, () => 'v').join(' + ')};\n  return db.query(sql);\n}\n`;
  const r = await attempt(targets({ 'heavy/chain.ts': chain }), undefined, RULE_TIMEOUT);
  assert.equal(r.attempt, 'succeeded');
  const rows = r.coverage.filter(c => c.relativePath === 'heavy/chain.ts').map(c => `${c.familyId}=${c.status}:${c.reasonCode.split('.').pop()}`);
  assert.deepEqual(rows, ['sentinel.sql.concatenated-query-tsjs=partial:ruleTimeout', 'sentinel.sql.request-to-query-tsjs=partial:ruleTimeout']);
  assert.ok(r.coverage.filter(c => c.relativePath === 'typescript/local.ts').every(c => c.status === 'complete'), 'other files still count');
  assert.equal(r.findings.filter(f => f.relativePath === 'heavy/chain.ts').length, 0);
});

test('cross-file flow is not claimed: a request value passed to a sink in another file earns no taint finding', { skip }, async () => {
  const r = await attempt(targets({
    'cross/entry.ts': 'import { run } from "./sink";\nexport function handle(req, db) {\n  const v = req.value();\n  return run(db, v);\n}\n',
    'cross/sink.ts': 'export function run(db, sql) {\n  return db.query(sql);\n}\n',
  }));
  assert.equal(r.findings.filter(f => f.relativePath.startsWith('cross/')).length, 0);
  assert.equal(r.coverage.find(c => c.relativePath === 'cross/sink.ts')!.status, 'complete', 'scanned, and still no claim');
});

test('changing or deleting the caller’s files after the worker copied them changes nothing: results describe the captured bytes', { skip }, async () => {
  const t = targets({ 'live/mutated.ts': POSITIVE, 'live/deleted.ts': POSITIVE.replace('f(', 'g(') });
  const mutated = t.find(x => x.relativePath === 'live/mutated.ts')!;
  const deleted = t.find(x => x.relativePath === 'live/deleted.ts')!;
  const captured = readFileSync(mutated.path);
  // runPatternAttempt copies and hashes every input before its first await; then the originals change under it.
  const pending = attempt(t);
  writeFileSync(mutated.path, POSITIVE.replace('SELECT', 'DELETE'));
  assert.equal(readFileSync(mutated.path).length, captured.length, 'same length, different bytes');
  rmSync(deleted.path);
  const r = await pending;
  const f = r.findings.find(x => x.relativePath === 'live/mutated.ts')!;
  assert.equal(f.artifact, mutated.artifact);
  const query = 'db.query("SELECT * FROM t WHERE id = " + id)';
  assert.equal(f.span.quoteDigest, sha(query), 'the span quotes the captured bytes, not the changed file');
  assert.equal(captured.subarray(f.span.startByte, f.span.endByte).toString('utf8'), query);
  assert.ok(r.findings.some(x => x.relativePath === 'live/deleted.ts'), 'a deleted original was already captured');
  assert.ok(r.coverage.filter(c => c.relativePath.startsWith('live/')).every(c => c.status === 'complete' || c.status === 'not-run'));
});

test('an engine failure reaches diagnostics as a fixed category and exit code only, never engine text', { skip }, async () => {
  // The secret sits in the file's contents and in the engine argument; target paths are the owner's names and stay.
  const t = targets({ 'leak/values.ts': `export const token = "${SECRET}";\nexport const ${LOWER} = 'Hunter2-src';\n${POSITIVE}` });
  const dir = join(root.root, `leaky-job-${n++}`);
  mkdirSync(dir, { mode: 0o700 });
  const built = buildPatternJob(RULES, t, dir, LEAKY);
  const outcome = await service.run({ adapterId: LEAKY.definition.id, attemptId: `att-leaky-${n++}`, work: { id: 'work-pattern', revision: 1 }, inputs: built.inputs });
  assert.equal(outcome.diagnostics.text, 'sentinel.pattern.engine.invalidArgument exit 2\n', 'nothing but the fixed category and exit code');
  for (const leaked of [LOWER, SECRET, 'MixedCase9Token', 'Hunter2', 'password', 'db.query', '/tmp/sentinel-pattern', 'leak/']) {
    assert.ok(!outcome.diagnostics.text.includes(leaked), `diagnostics leaked ${leaked}`);
  }
  const r = await runPatternAttempt(service, { attemptId: `att-leaky-${n++}`, work: { id: 'work-pattern', revision: 1 }, rules: RULES, targets: t, scratch: root.root, adapter: LEAKY, ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}) });
  assert.equal(r.engineFailure, 'sentinel.pattern.engine.invalidArgument');
  assert.equal(r.engineExit, 2);
  assert.ok(r.coverage.every(c => c.status === 'error' || c.status === 'not-applicable'));
  assert.ok(!JSON.stringify(r).includes(LOWER) && !JSON.stringify(r).includes(SECRET), 'nor in the normalized result');
});

test('the attempt deadline stops the engine and leaves every applicable file in error', { skip }, async () => {
  // 600 small synthetic files keep the engine busy well past the lowered 1.5 s deadline.
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`load/f${i}.ts`, POSITIVE.replace('f(', `f${i}(`)]));
  const t0 = Date.now();
  const r = await attempt(targets(many), 'pattern-semgrep-deadline');
  console.log(`# deadline: ${r.attempt} after ${Date.now() - t0} ms`);
  assert.equal(r.attempt, 'timed-out');
  assert.equal(r.findings.length, 0);
  assert.ok(r.coverage.every(c => c.status === 'error' && c.reasonCode === 'sentinel.pattern.coverage.attemptTimedOut'));
});
