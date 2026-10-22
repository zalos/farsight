// The pinned engine itself, through PR 07's isolated execution service only (no host fallback, no pull). Runs with
// SENTINEL_ISOLATION=1, like the isolation canaries; there a missing runtime or a missing pinned image fails. All
// inputs are original synthetic fixtures; no user code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createExecutionService } from '../dist/execution/service.js';
import { PATTERN_ADAPTER, patternRuleOf, runPatternAttempt } from '../dist/adapters/pattern/index.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';

const enabled = process.env.SENTINEL_ISOLATION === '1';
const skip = !enabled && 'real pinned engine: set SENTINEL_ISOLATION=1 with a qualified local Docker and the pinned Semgrep image installed';
const PACK = fileURLToPath(new URL('../rules/pattern/', import.meta.url));
const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const manifest = JSON.parse(readFileSync(`${PACK}sentinel-pack.json`, 'utf8'));
const RULES = manifest.rules.map((r: any) => patternRuleOf(r.familyId, r.revision, readFileSync(`${PACK}${r.implementation.rulePath}`)));

let root: { root: string; work: string };
let store: any;
let service: any;
let n = 0;
before(async () => {
  if (!enabled) return;
  root = scratch('pattern');
  store = await storeIn(root.root);
  const deadline = { ...PATTERN_ADAPTER, id: 'pattern-semgrep-deadline', limits: { timeoutMs: 1500, helloTimeoutMs: 1500, cancelGraceMs: 500 } };
  service = await createExecutionService(store, { scratchRoot: root.work, registry: createAdapterRegistry([PATTERN_ADAPTER, deadline]), containers: true });
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
const attempt = (t: ReturnType<typeof targets>, adapterId?: string) => runPatternAttempt(service, {
  attemptId: `att-pattern-${n++}`, work: { id: 'work-pattern', revision: 1 }, rules: RULES, targets: t, scratch: root.root, ...(adapterId ? { adapterId } : {}),
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
  const status = Object.fromEntries(r.coverage.map(c => [c.relativePath, `${c.status}:${c.reasonCode.split('.').pop()}`]));
  assert.equal(status['controls/unsupported.rs'], 'not-applicable:noRuleLanguage');
  assert.equal(status['controls/broken.ts'], 'partial:partialParse');
  assert.equal(status['controls/big.ts'], 'skipped:tooLarge');
  for (const p of Object.keys(status).filter(p => !p.startsWith('controls/'))) assert.equal(status[p], 'complete:complete', p);
  assert.deepEqual(r.refused, []);
  console.log(`# conformance: ${r.findings.length} findings, ${r.coverage.length} files, ${wall} ms`);
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
  const status = Object.fromEntries(r.coverage.map(c => [c.relativePath, c.status]));
  assert.equal(status['.semgrepignore'], 'excluded');
  assert.equal(status['controls/.gitignore'], 'excluded');
  assert.equal(status['node_modules/pkg/index.ts'], 'complete');
});

test('a captured file shaped like a job cannot replace the job: the worker refuses and nothing counts as checked', { skip }, async () => {
  const fake = JSON.stringify({ schema: 'sentinel-pattern-job/draft-1', rules: sha('x'), targets: [] });
  const r = await attempt(targets({ 'config/job.json': fake }));
  assert.equal(r.attempt, 'failed');
  assert.equal(r.findings.length, 0);
  assert.ok(r.coverage.every(c => c.status === 'error' || c.status === 'not-applicable'));
});

test('cross-file flow is not claimed: a request value passed to a sink in another file earns no taint finding', { skip }, async () => {
  const r = await attempt(targets({
    'cross/entry.ts': 'import { run } from "./sink";\nexport function handle(req, db) {\n  const v = req.value();\n  return run(db, v);\n}\n',
    'cross/sink.ts': 'export function run(db, sql) {\n  return db.query(sql);\n}\n',
  }));
  assert.equal(r.findings.filter(f => f.relativePath.startsWith('cross/')).length, 0);
  assert.equal(r.coverage.find(c => c.relativePath === 'cross/sink.ts')!.status, 'complete', 'scanned, and still no claim');
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
