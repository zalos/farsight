/**
 * Compare two syncs on a storyline (round 2026-10-10, proposal 7), over two real syncs: `examples/invoice-app`
 * copied into a temp workspace and ingested by the built CLI (sync 1), then edited the way a week of work edits it
 * (`e2e/fixture/second-sync.mjs`: Discard draft gets its page and its call, the DELETE operation the spec declared
 * is served, two gates arrive, `void` gains a writer, the case that saves a draft is skipped) and ingested again
 * (sync 2). Core `storylineDiff()` over the two reads, the routes that answer from history (`/graph?asof=`,
 * `/api/journey?asof=`, `/api/compare`), and the CLI's `--fail-on` exit code. Never the workspace graph, never
 * 4477 / 4478.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SnapshotDb, compareSideOf, storylineDiff, storylineDiffDocument, countedProblems, deltaText, type StorylineDiff } from '@farsight/core';
import { validate } from '../../core/test/validate.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;
const cli = join(repoRoot, 'packages/cli/dist/cli.js');
const { applySecondSync } = await import(pathToFileURL(join(repoRoot, 'e2e/fixture/second-sync.mjs')).href) as { applySecondSync: (dir: string) => void };
const SCHEMA = JSON.parse(readFileSync(join(repoRoot, 'schemas', 'farsight-diff-v1.schema.json'), 'utf8'));

let work: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';
let diff: StorylineDiff;

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const picked = await new Promise<number>((res, rej) => {
      const probe = createServer();
      probe.once('error', rej);
      probe.listen(0, '127.0.0.1', () => { const a = probe.address(); const p = typeof a === 'object' && a ? a.port : 0; probe.close(() => res(p)); });
    });
    if (picked > 1024 && picked !== 4477 && picked !== 4478) return picked;
  }
  throw new Error('no free loopback port after 20 tries');
}

function ingest(): void {
  const r = spawnSync(process.execPath, [cli, 'ingest', 'invoice-app', '--repo', 'invoice-app', '--out', join(work, 'graph.json')], { cwd: work, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function runCli(args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: work, encoding: 'utf8' });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

before(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-compare-')));
  cpSync(join(repoRoot, 'examples/invoice-app'), join(work, 'invoice-app'), { recursive: true });
  ingest();
  applySecondSync(join(work, 'invoice-app'));
  ingest();
  const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
  try { diff = storylineDiff(compareSideOf(db, 1), compareSideOf(db, 2), 'invoice')!; } finally { db.close(); }

  port = await freePort();
  const boot = `const { serveGraph } = await import(${JSON.stringify(serverDist)});\n`
    + `serveGraph(${JSON.stringify(join(work, 'graph.json'))}, ${port}, ${JSON.stringify(work)});\n`;
  child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: work, env: { ...process.env, MODELHUB_DIR: join(work, 'modelhub'), FIGMA_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { childLog += d; });
  child.stderr.on('data', (d: string) => { childLog += d; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`the server exited:\n${childLog}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/api/version`); await r.arrayBuffer(); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`the server never answered:\n${childLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (child && child.exitCode == null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: JSON.parse(await r.text()) };
}

const BILLING = 'invoice-app::flow::billing-cycle';
const NEW = 'invoice-app::flow::new-invoice';
const BRANCH = 'invoice-app::flow::draft-and-send';

test('one change of every kind, each a sentence, in a stable order, counted over the storyline', () => {
  const by = (k: string) => diff.deltas.filter((d) => d.kind === k);
  assert.deepEqual(diff.counted.deltas.breakdown!.map((p) => [p.key, p.n]), [
    ['count.part.delta.built', 1], ['count.part.delta.gate', 2], ['count.part.delta.writer', 1], ['count.part.delta.contract', 1], ['count.part.delta.verdict', 2],
  ]);
  assert.equal(diff.counted.deltas.n, diff.deltas.length);
  for (const c of Object.values(diff.counted)) assert.deepEqual(countedProblems(c), []);
  diff.deltas.forEach((d, i) => assert.equal(d.id, `d${i + 1}`));

  // built: the designed screen is identified by its design id, though its page id moved when the page arrived
  const [built] = by('built');
  assert.equal(built!.change, 'added');
  assert.equal(deltaText(built!), 'Discard draft is now built');
  assert.deepEqual(built!.journeys.sort(), [BILLING, BRANCH].sort());

  // gate: the scope check now in front of the DELETE, and the second one in front of creating an invoice
  assert.deepEqual(by('gate').map((d) => [d.change, d.subject.id, d.target!.name, d.tier]), [
    ['added', 'invoice-app::guard::requireScope(billing:admin)', 'DELETE /invoices/:id', 'business'],
    ['added', 'invoice-app::guard::requireScope(billing:create)', 'POST /invoices', 'business'],
  ]);
  assert.equal(deltaText(by('gate')[1]!), 'New invoice gained a gate: requireScope (billing:create) now guards POST /invoices');
  assert.equal(deltaText(by('gate')[1]!, { biz: true }), 'New invoice gained a check: billing:create');

  // writer: void gains its first writer, credited to the journeys whose walk runs it
  const [writer] = by('writer');
  assert.deepEqual([writer!.change, writer!.status, writer!.subject.name, writer!.target!.name], ['added', 'void', 'voidInvoice', 'invoices']);
  assert.deepEqual(writer!.journeys.sort(), [BILLING, BRANCH].sort());

  // contract: the operation the spec declared and nothing served is served now — `{id}` and `:id` read alike
  const [contract] = by('contract');
  assert.deepEqual([contract!.change, contract!.from, contract!.to, contract!.called], ['changed', 'spec-only', 'both', true]);
  assert.equal(contract!.door.api, 'invoice-app::api::openapi.yaml');

  // verdict: the skipped case moves both journeys it covers; freshness (the code moved after the run) is not a change
  assert.deepEqual(by('verdict').map((d) => d.subject.id).sort(), [BILLING, NEW].sort());
  for (const d of by('verdict')) { assert.match(d.from!, /^passed/); assert.match(d.to!, /3 skipped/); assert.doesNotMatch(d.to!, /stale/); }
});

test('the cards: one entry per journey, one chip per kind present, and the built count of the later sync', () => {
  const chips = new Map(diff.byJourney.map((j) => [j.flow, j]));
  assert.deepEqual(Object.keys(chips.get(NEW)!.kinds).sort(), ['gate', 'verdict']);
  assert.deepEqual(chips.get(BILLING)!.built, { n: 3, of: 3 });
  assert.deepEqual(chips.get(BRANCH)!.built, { n: 2, of: 2 });
  assert.equal(chips.get(BILLING)!.kinds.gate!.added, 2);
  assert.equal(diff.counted.journeys.n, 3);
});

test('the document validates as farsight-diff v1, and a sync compared with itself has nothing', () => {
  assert.deepEqual(validate(storylineDiffDocument(diff, { failOn: ['gate'] }), SCHEMA), []);
  const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
  try {
    const same = storylineDiff(compareSideOf(db, 2), compareSideOf(db, 2), 'invoice')!;
    assert.equal(same.deltas.length, 0);
  } finally { db.close(); }
});

test('GET /graph?asof=1 draws sync 1 from history; a sync it does not hold is not indexed', async () => {
  const one = await get('/graph?asof=1');
  assert.equal(one.status, 200);
  assert.equal(one.body.meta.sync, 1);
  assert.ok(one.body.meta.journeys, 'the storylines came back with the sync');
  assert.ok(one.body.nodes.some((n: any) => n.id === 'invoice-app::page::/invoices/:param/discard' && !n.loc));
  assert.ok(one.body.roots['invoice-app'], 'the served graph roots ride along, a snapshot keeps none');
  const served = await get('/graph?asof=2');
  assert.equal(served.body.meta.sync, 2);
  const none = await get('/graph?asof=99');
  assert.equal(none.status, 404);
  assert.equal(none.body.absent, 'notIndexed');
  assert.equal(none.body.word, 'not indexed');
});

test('GET /api/journey?asof=1 walks the journey as it was', async () => {
  const then = await get(`/api/journey?entry=${encodeURIComponent(BILLING)}&steps=0&asof=1`);
  const now = await get(`/api/journey?entry=${encodeURIComponent(BILLING)}&steps=0`);
  assert.equal(then.status, 200);
  assert.deepEqual(then.body.summary.user.map((u: any) => !!u.loc), [true, true, false]);
  assert.deepEqual(now.body.summary.user.map((u: any) => !!u.loc), [true, true, true]);
});

test('GET /api/compare: the sync before → the served one by default, a day, and the syncs to pick from', async () => {
  const { status, body } = await get('/api/compare?storyline=invoice');
  assert.equal(status, 200);
  assert.equal(body.from.sync, 1);
  assert.equal(body.from.how, 'previous');
  assert.equal(body.to.sync, 2);
  assert.equal(body.to.served, true);
  assert.equal(body.diff.deltas.length, diff.deltas.length);
  assert.deepEqual(body.syncs.map((s: any) => s.sync), [2, 1]);
  const withDoc = await get('/api/compare?storyline=invoice&from=1&failOn=gate');
  assert.equal(withDoc.body.document.gate.result, 'fail');
  const early = await get('/api/compare?storyline=invoice&from=1999-01-01');
  assert.equal(early.status, 404);
  assert.equal(early.body.absent, 'notIndexed');
  assert.equal((await get('/api/compare?storyline=nope&from=1')).status, 404);
  assert.equal((await get('/api/compare')).status, 400);
});

test('farsight diff --storyline: words, the frozen document, and exit 1 only when a --fail-on kind changed', () => {
  const words = runCli(['diff', '--storyline', 'invoice', '--from', '1']);
  assert.equal(words.status, 0, words.err);
  assert.match(words.out, /7 changes · over this storyline, between the two syncs — built 1 · gate 2 · writer 1 · contract 1 · verdict 2/);
  const failing = runCli(['diff', '--storyline', 'invoice', '--fail-on', 'gate,verdict']);
  assert.equal(failing.status, 1);
  assert.match(failing.out, /gate FAIL — --fail-on gate,verdict/);
  const json = runCli(['diff', '--storyline', 'invoice', '--json', '--fail-on', 'gate']);
  assert.equal(json.status, 1);
  assert.deepEqual(validate(JSON.parse(json.out), SCHEMA), []);
  const same = runCli(['diff', '--storyline', 'invoice', '--from', '2', '--to', 'now', '--fail-on', 'gate']);
  assert.notEqual(same.status, 0, 'from 2 to 2 is not a range');
  assert.match(runCli(['diff', '--storyline', 'invoice', '--fail-on', 'colour']).err, /not a delta kind/);
});
