import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  notAnalyzedCheck,
  inventory,
  loadCorpus,
  reconcileInputs,
  runParserProbe,
  sha256,
  CORPUS_LIMITS,
} from '../sentinel-feasibility/parser.mjs';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function scratch(t) {
  const root = await fs.mkdtemp(resolve(tmpdir(), 'sentinel-parser-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('independent inventory never follows symbolic links and hashes hidden files', async (t) => {
  const root = await scratch(t);
  await fs.writeFile(resolve(root, '.hidden'), 'inert');
  await fs.symlink('../outside', resolve(root, 'link'));
  const rows = await inventory(root);
  assert.equal(rows.find((row) => row.path === '.hidden').digest, sha256('inert'));
  assert.equal(rows.find((row) => row.path === 'link').kind, 'symlink');
  assert.equal(rows.length, 3);
});
test('input-kind reconciliation rejects digest and kind confusion', () => {
  const rows = [
    { path: 'a.ts', kind: 'file', digest: sha256('bytes') },
    { path: 'dir', kind: 'directory', digest: sha256('[]') },
    { path: 'link', kind: 'symlink' },
  ];
  const inputs = [
    { path: 'a.ts', kind: 'content', digest: sha256('bytes') },
    { path: 'a.ts', kind: 'metadata', digest: sha256('file') },
    { path: 'dir', kind: 'directory', digest: sha256('[]') },
    { path: 'absent', kind: 'missing', digest: sha256('unavailable') },
    { path: 'link', kind: 'missing', digest: sha256('unavailable') },
  ];
  assert.ok(reconcileInputs(rows, { inputs }).every((row) => row.matched));
  assert.equal(
    reconcileInputs(rows, { inputs: [{ path: 'a.ts', kind: 'missing', digest: sha256('unavailable') }] })[0].matched,
    false,
  );
  assert.equal(
    reconcileInputs(rows, { inputs: [{ path: 'a.ts', kind: 'content', digest: '0'.repeat(64) }] })[0].matched,
    false,
  );
});
test('corpus tampering and source symlinks are refused before materialization', async (t) => {
  const root = await scratch(t);
  await fs.writeFile(resolve(root, 'input.fixture'), 'bytes');
  const value = {
    schemaVersion: 'sentinel-feasibility-corpus-v1',
    cases: [{ id: 'one', gates: ['E1'], files: [{ path: 'a.ts', source: 'input.fixture', sha256: sha256('bytes') }] }],
  };
  const path = resolve(root, 'cases.json');
  await fs.writeFile(path, JSON.stringify(value));
  await loadCorpus(root);
  await fs.writeFile(resolve(root, 'input.fixture'), 'tampered');
  await assert.rejects(loadCorpus(root), /digest mismatch/);
  await fs.unlink(resolve(root, 'input.fixture'));
  await fs.symlink('other', resolve(root, 'input.fixture'));
  await assert.rejects(loadCorpus(root), /symlink/);
  value.cases[0].files[0].path = '../escape';
  await fs.writeFile(path, JSON.stringify(value));
  await assert.rejects(loadCorpus(root), /safe relative/);
});
test('actual public TS and Java probe retains independent inventories and negative controls', async (t) => {
  const root = await scratch(t),
    result = await runParserProbe({
      fixtureRoot: resolve(REPO, 'packages/sentinel/test/fixtures/feasibility'),
      workDir: resolve(root, 'work'),
      artifactDir: resolve(root, 'artifacts'),
    });
  assert.equal(result.status, 'measured');
  assert.equal(result.experiment, 'E1');
  assert.equal(result.metrics.parserVersion, '0.3.1');
  for (const id of [
    'ignored-complete-trap',
    'gitignore-change',
    'symlink-refused',
    'oversize-not-clean',
    'missing-recorded',
  ])
    assert.equal(result.checks.find((row) => row.id === id)?.passed, true, id);
  assert.ok(result.metrics.cases.some((row) => row.id === 'java-injection-pair'));
  assert.ok(result.metrics.cases.some((row) => row.complete && row.omittedFiles.length));
  const silent = result.checks.find(
    (row) =>
      row.id.includes(':not-analyzed:') &&
      row.evidence.reporting === 'not-reported' &&
      row.evidence.diagnosticPresence === 'absent',
  );
  assert.ok(silent, 'real ignored/config omitted file has no diagnostic');
  assert.equal(silent.evidence.coverageDisposition, 'unknown-gap');
  assert.equal(silent.evidence.securityCoverage, 'not-established');
  const retained = JSON.parse(await fs.readFile(resolve(root, 'artifacts', silent.id.split(':')[0] + '.json')));
  assert.ok(retained.selection.some((row) => row.path === silent.evidence.path && row.parser === null));
  assert.equal(
    retained.artifact.analysis.diagnostics.some((row) => row.path === silent.evidence.path),
    false,
  );

  for (const row of result.artifacts) {
    const bytes = await fs.readFile(resolve(root, 'artifacts', row.path));
    assert.equal(sha256(bytes), row.sha256);
    assert.equal(bytes.length, row.bytes);
  }
  assert.ok(result.checks.filter((row) => row.id.endsWith(':source-unchanged')).every((row) => row.passed));
  assert.ok(result.checks.filter((row) => row.id.endsWith(':input-digests')).every((row) => row.passed));
});

test('corpus and inventory refuse a symlinked root before reading outside it', async (t) => {
  const root = await scratch(t),
    outside = resolve(root, 'outside'),
    alias = resolve(root, 'alias');
  await fs.mkdir(outside);
  await fs.writeFile(resolve(outside, 'cases.json'), 'not a corpus');
  await fs.symlink(outside, alias);
  await assert.rejects(loadCorpus(alias), /directory symlink refused/);
  await assert.rejects(inventory(alias), /directory symlink refused/);
});
test('corpus refuses a symlinked index before parsing its target', async (t) => {
  const root = await scratch(t),
    fixtures = resolve(root, 'fixtures');
  await fs.mkdir(fixtures);
  const outside = resolve(root, 'external.json');
  await fs.writeFile(outside, 'not a corpus');
  await fs.symlink(outside, resolve(fixtures, 'cases.json'));
  await assert.rejects(loadCorpus(fixtures), /index symlink refused/);
});

test('materialization verifies the exact reread bytes before writing or parsing them', async (t) => {
  const root = await scratch(t),
    fixtures = resolve(root, 'fixtures');
  await fs.mkdir(fixtures);
  const source = resolve(fixtures, 'input.fixture'),
    original = Buffer.from('export const safe = true;\n');
  await fs.writeFile(source, original);
  await fs.writeFile(
    resolve(fixtures, 'cases.json'),
    JSON.stringify({
      schemaVersion: 'sentinel-feasibility-corpus-v1',
      cases: [
        { id: 'one', gates: ['E1'], files: [{ path: 'a.ts', source: 'input.fixture', sha256: sha256(original) }] },
      ],
    }),
  );
  const readFile = fs.readFile;
  let reads = 0;
  t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (path === source && ++reads === 2) return Buffer.from('export const swapped = true;\n');
    return readFile.call(fs, path, ...args);
  });
  await assert.rejects(
    runParserProbe({ fixtureRoot: fixtures, workDir: resolve(root, 'work'), artifactDir: resolve(root, 'artifacts') }),
    /Materialized fixture digest mismatch/,
  );
  assert.equal(reads, 2);
  await assert.rejects(fs.access(resolve(root, 'work/one/a.ts')), /ENOENT/);
  assert.deepEqual(await fs.readdir(resolve(root, 'artifacts')), []);
});

test('corpus and inventory enforce file limits before reading oversized source or index bytes', async (t) => {
  const root = await scratch(t),
    source = resolve(root, 'input.fixture');
  const huge = Buffer.alloc(CORPUS_LIMITS.fileBytes + 1, 'x');
  await fs.writeFile(source, huge);
  const value = {
    schemaVersion: 'sentinel-feasibility-corpus-v1',
    cases: [{ id: 'one', gates: ['E1'], files: [{ path: 'a.ts', source: 'input.fixture', sha256: sha256(huge) }] }],
  };
  await fs.writeFile(resolve(root, 'cases.json'), JSON.stringify(value));
  const readFile = fs.readFile;
  let sourceReads = 0;
  t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (path === source) sourceReads++;
    return readFile.call(fs, path, ...args);
  });
  await assert.rejects(loadCorpus(root), /file byte limit/);
  await assert.rejects(inventory(root), /file byte limit/);
  assert.equal(sourceReads, 0);
  await fs.writeFile(resolve(root, 'cases.json'), huge);
  await assert.rejects(loadCorpus(root), /file byte limit/);
});
test('corpus rejects excessive case/descriptor counts and aggregate source bytes', async (t) => {
  const root = await scratch(t),
    source = resolve(root, 'input.fixture'),
    body = Buffer.alloc(CORPUS_LIMITS.fileBytes, 'x');
  await fs.writeFile(source, body);
  const one = { id: 'one', gates: ['E1'], files: [{ path: 'a.ts', source: 'input.fixture', sha256: sha256(body) }] };
  const path = resolve(root, 'cases.json');
  await fs.writeFile(
    path,
    JSON.stringify({
      schemaVersion: 'sentinel-feasibility-corpus-v1',
      cases: Array.from({ length: CORPUS_LIMITS.cases + 1 }, (_, i) => ({ ...one, id: `case${i}` })),
    }),
  );
  await assert.rejects(loadCorpus(root), /case limit/);
  await fs.writeFile(
    path,
    JSON.stringify({
      schemaVersion: 'sentinel-feasibility-corpus-v1',
      cases: [
        {
          ...one,
          files: Array.from({ length: CORPUS_LIMITS.entries + 1 }, (_, i) => ({
            ...one.files[0],
            path: `file${i}.ts`,
          })),
        },
      ],
    }),
  );
  await assert.rejects(loadCorpus(root), /descriptor entry limit/);
  await fs.writeFile(
    path,
    JSON.stringify({
      schemaVersion: 'sentinel-feasibility-corpus-v1',
      cases: Array.from({ length: 9 }, (_, i) => ({ ...one, id: `case${i}` })),
    }),
  );
  await assert.rejects(loadCorpus(root), /aggregate byte limit/);
});
test('independent inventory rejects an excessive real directory entry count', async (t) => {
  const root = await scratch(t);
  for (let i = 0; i < CORPUS_LIMITS.entries + 1; i += 128)
    await Promise.all(
      Array.from({ length: Math.min(128, CORPUS_LIMITS.entries + 1 - i) }, (_, j) =>
        fs.writeFile(resolve(root, `entry${i + j}`), ''),
      ),
    );
  await assert.rejects(inventory(root), /inventory entry limit/);
});

test('not-analyzed observes omissions and diagnostics without claiming scan coverage', () => {
  const analysis = {
    files: [
      { path: 'ok.ts', status: 'analyzed' },
      { path: 'bad.ts', status: 'failed' },
    ],
    diagnostics: [{ path: 'bad.ts', code: 'parse-error' }],
  };
  const omitted = notAnalyzedCheck('case', 'silent.ts', analysis);
  assert.equal(omitted.passed, true);
  assert.equal(omitted.evidence.reporting, 'not-reported');
  assert.equal(omitted.evidence.diagnosticPresence, 'absent');
  assert.deepEqual(omitted.evidence.diagnostics, []);
  assert.equal(omitted.evidence.securityCoverage, 'not-established');
  assert.equal(omitted.evidence.coverageDisposition, 'unknown-gap');
  assert.equal(notAnalyzedCheck('case', 'ok.ts', analysis).passed, false);
  const failed = notAnalyzedCheck('case', 'bad.ts', analysis);
  assert.equal(failed.evidence.reporting, 'reported-not-analyzed');
  assert.equal(failed.evidence.diagnosticPresence, 'present');
});
