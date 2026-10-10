/**
 * `farsight affected --from --to` and `farsight readiness` — the built `dist/cli.js` against a copy of
 * `examples/invoice-app` made a git repository with two commits (the second edits the function that
 * finalizes an invoice). `--json` is the frozen `farsight-affected v1`, validated against its schema;
 * `--post` without a pull request is refused; readiness prints one CSV line per storyline row.
 * Nothing here touches the network, the workspace graph or ports 4477 / 4478.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../core/test/validate.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/cli.js');
const SCHEMA = () => JSON.parse(readFileSync(join(repoRoot, 'schemas/farsight-affected-v1.schema.json'), 'utf8'));

let work: string;
let repo: string;
let graph: string;
let base: string;
let head: string;

const git = (args: string[]) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [cli, ...args, '--graph', graph], { cwd: work, encoding: 'utf8' });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
};

before(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-affected-')));
  repo = join(work, 'invoice-app');
  graph = join(work, 'graph.json');
  cpSync(join(repoRoot, 'examples/invoice-app'), repo, { recursive: true });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base', '--no-verify']);
  base = git(['rev-parse', 'HEAD']);
  const f = join(repo, 'src/server/invoiceService.ts');
  writeFileSync(f, readFileSync(f, 'utf8').replace('  const invoice = await db.invoices.findOne({ id });\n  /* @business An invoice must', '  const invoice = await db.invoices.findOne({ id });\n  // a changed line inside finalizeInvoice\n  /* @business An invoice must'));
  git(['commit', '-q', '-am', 'fix: finalize', '--no-verify']);
  head = git(['rev-parse', 'HEAD']);
  const ingest = spawnSync(process.execPath, [cli, 'ingest', repo, '--repo', 'invoice-app', '--out', graph], { cwd: work, encoding: 'utf8' });
  assert.equal(ingest.status, 0, ingest.stderr);
});

after(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ } });

test('a commit range prints farsight-affected v1, valid against its schema, landing on finalizeInvoice', () => {
  const r = run(['affected', '--from', base, '--to', head, '--json']);
  assert.equal(r.status, 0, r.err);
  const doc = JSON.parse(r.out);
  assert.deepEqual(validate(doc, SCHEMA()), []);
  assert.equal(doc.range.kind, 'commits');
  assert.equal(doc.commits.length, 1);
  assert.ok(doc.changed.some((c: { name: string }) => c.name === 'finalizeInvoice'));
  assert.ok(doc.journeys.some((j: { name: string; hop: number }) => j.name === 'Billing cycle' && j.hop === 0));
  assert.ok(doc.tests.length > 0);
});

test('the words name the journeys, the changed path and the tests', () => {
  const r = run(['affected', '--from', base, '--to', head]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /JOURNEYS TOUCHED/);
  assert.match(r.out, /Billing cycle · runs the change · step 2 of 2 · An invoice, end to end/);
  assert.match(r.out, /status → open via finalizeInvoice/);
  assert.match(r.out, /test\/invoiceService\.test\.ts:21/);
});

test('--post on a commit range is refused: there is no pull request to post on', () => {
  const r = run(['affected', '--from', base, '--to', head, '--post']);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /--post needs --pr/);
});

test('readiness prints one CSV line per row of the storyline', () => {
  const r = run(['readiness', '--storyline', 'invoice', '--csv']);
  assert.equal(r.status, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 1 + 3, 'a header and the two steps and the branch');
  assert.match(lines[0]!, /^step,journey,kind/);
  const unknown = run(['readiness', '--storyline', 'nope']);
  assert.notEqual(unknown.status, 0);
});
