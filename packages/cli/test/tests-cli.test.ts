/**
 * The `farsight` binary's tests surface, driven as a consumer drives it: the built
 * `dist/cli.js` against a *copy* of `examples/invoice-app` in a temp directory.
 * Nothing here touches the workspace graph, and the fixture is never written to in
 * place — `tests import --stamp` rewrites the reports it reads.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TESTS_MATRIX_COLUMNS } from '@farsight/core';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/cli.js');

let work: string;
let repo: string;
let graph: string;

function run(args: string[], cwd = repo) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** What the graph says about this import — the numbers two runs must agree on. */
function state() {
  const g = JSON.parse(readFileSync(graph, 'utf8'));
  const t = g.meta.tests['invoice-app'];
  return {
    nodes: g.nodes.length,
    covers: g.edges.filter((e: { kind: string }) => e.kind === 'covers').length,
    edges: t.edges, runs: t.runs, cases: t.cases,
    reports: t.reports.map((r: { path?: string; glob?: string; reason?: string }) => `${r.path ?? r.glob}:${r.reason}`),
  };
}

const unitArgs = ['tests', 'import', '--repo', 'invoice-app', '--level', 'unit',
  '--results', 'coverage/vitest-results.json', '--coverage', 'coverage/coverage-final.json'];

before(() => {
  // realpath: macOS /tmp is a symlink, and the CLI compares resolved paths
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-cli-')));
  repo = join(work, 'invoice-app');
  graph = join(work, 'graph.json');
  cpSync(join(repoRoot, 'examples/invoice-app'), repo, { recursive: true });
  const ingest = run(['ingest', repo, '--repo', 'invoice-app', '--out', graph], work);
  assert.equal(ingest.status, 0, ingest.err);
});

after(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ } });

describe('farsight digest', () => {
  test('prints the content digest ingest recorded for that repo', () => {
    const r = run(['digest', '--repo', 'invoice-app', '--graph', graph]);
    assert.equal(r.status, 0, r.err);
    const digest = r.out.trim();
    assert.match(digest, /^[0-9a-f]{12}$/);
    const meta = JSON.parse(readFileSync(graph, 'utf8')).meta;
    assert.equal(digest, meta.repos['invoice-app'].sourceDigest);
    // --json carries the same digest plus where it was computed
    const j = JSON.parse(run(['digest', '--repo', 'invoice-app', '--graph', graph, '--json']).out);
    assert.equal(j.sourceDigest, digest);
    assert.equal(j.repo, 'invoice-app');
  });

  test('a repo the graph and the workspace know nothing about is an error, not a guess', () => {
    const r = run(['digest', '--repo', 'not-a-repo', '--graph', graph]);
    assert.equal(r.status, 1);
    assert.match(r.err, /no checkout recorded/);
  });
});

describe('farsight tests import', () => {
  test('twice over the same reports leaves the same graph', () => {
    const first = run([...unitArgs, '--graph', graph]);
    assert.equal(first.status, 0, first.err);
    const a = state();
    const second = run([...unitArgs, '--graph', graph]);
    assert.equal(second.status, 0, second.err);
    assert.deepEqual(state(), a);
    // the counts are read back off the fragment, not copied from what was there:
    // 6 unit rows this import joined + the 8 Playwright rows ingest had already joined
    assert.equal(a.edges.observed, 2);
    assert.equal(a.runs, 14);
    assert.equal(a.cases, 10);
  });

  test('a --stamp that is not this checkout is refused, and nothing is written', () => {
    const before = readFileSync(join(repo, 'coverage/coverage-final.json'), 'utf8');
    const r = run([...unitArgs, '--graph', graph, '--stamp', 'deadbeef1234']);
    assert.equal(r.status, 2);
    assert.match(r.err, /is not the content digest/);
    assert.equal(readFileSync(join(repo, 'coverage/coverage-final.json'), 'utf8'), before);
  });

  test('the right --stamp writes the digest into each JSON report, once', () => {
    // the fixture ships stamped (examples/invoice-app/scripts/make-coverage.mjs), so strip the
    // stamps to put this copy back where CI is: a run has happened, nothing recorded the tree
    for (const rel of ['coverage/vitest-results.json', 'coverage/coverage-final.json']) {
      const doc = JSON.parse(readFileSync(join(repo, rel), 'utf8')) as Record<string, unknown>;
      delete doc['farsight'];
      writeFileSync(join(repo, rel), JSON.stringify(doc, null, 2));
    }
    const digest = run(['digest', '--repo', 'invoice-app', '--graph', graph]).out.trim();
    const first = run([...unitArgs, '--graph', graph, '--stamp', digest]);
    assert.equal(first.status, 0, first.err);
    assert.match(first.out, /stamped coverage\/vitest-results\.json/);
    const stamped = JSON.parse(readFileSync(join(repo, 'coverage/coverage-final.json'), 'utf8'));
    assert.equal(stamped.farsight.sourceDigest, digest);
    assert.equal(stamped.farsight.repo, 'invoice-app');
    // read back: the reports now prove "unchanged since the run", and are not stamped again
    const second = run([...unitArgs, '--graph', graph, '--stamp', digest]);
    assert.equal(second.status, 0, second.err);
    assert.doesNotMatch(second.out, /stamped /);
    assert.match(second.out, /digest matches/);
    assert.deepEqual(state().reports.filter((r) => r.startsWith('coverage/')), [
      'coverage/vitest-results.json:ok', 'coverage/coverage-final.json:ok',
    ]);
  });

  test('--strict fails on a glob that matched nothing, and the blind spot survives the import', () => {
    // the fixture's declared-but-absent artefact: Playwright writes no istanbul coverage here
    const r = run(['tests', 'import', '--repo', 'invoice-app', '--level', 'e2e', '--runner', 'playwright',
      '--coverage', 'e2e/coverage/coverage-final.json', '--strict', '--graph', graph]);
    assert.equal(r.status, 1);
    assert.match(r.err, /matched 0 files/);
    // the unit reports this run did not read keep their entries
    assert.ok(state().reports.some((x) => x.startsWith('coverage/coverage-final.json')));
  });
});

describe('farsight tests matrix', () => {
  test('the CSV is the JSON document\'s rows, column for column', () => {
    const doc = JSON.parse(run(['tests', 'matrix', '--graph', graph, '--format', 'json']).out);
    assert.equal(doc.schema, 'farsight-tests-matrix v1');
    assert.equal(doc.identity.source_digest['invoice-app'], JSON.parse(readFileSync(graph, 'utf8')).meta.repos['invoice-app'].sourceDigest);
    const csv = run(['tests', 'matrix', '--graph', graph, '--format', 'csv']).out.trim().split('\n');
    assert.equal(csv[0], TESTS_MATRIX_COLUMNS.join(','));
    assert.equal(csv.length - 1, doc.rows.length);
    assert.ok(doc.rows.length > 0);
  });

  test('the table prints the end-to-end word, never a tick', () => {
    const r = run(['tests', 'matrix', '--graph', graph]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /E2E/);
    assert.ok(!r.out.includes('✓') && !r.out.includes('✗'), 'a tick says nothing about which evidence earned it');
    assert.match(r.out, /\b(observed|reached|declared|none)\b/);
  });
});
