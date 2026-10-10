/**
 * `GET /api/state` — the front door's state of play (round 2026-10-10, proposal 5): three columns of typed counts,
 * each with the command that prints it again, folded by core `stateOfPlay()` from the folds the other routes
 * answer with; the one history sentence; the config glossary. Ingests `examples/invoice-app` into a temp directory
 * and serves it on an ephemeral loopback port — never the workspace graph, never 4477 / 4478.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GraphStore, stitchHttp, buildIndex, designSurface, apiSurface, countedProblems, historyFact, historySentence, stateOfPlay, stateOfPlayLines } from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;
const fixture = join(repoRoot, 'examples/invoice-app');

let work: string;
let graphPath: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';

/** An OS-picked loopback port. 4477 / 4478 are live servers — never borrow them. */
async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const picked = await new Promise<number>((res, rej) => {
      const probe = createServer();
      probe.once('error', rej);
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        const p = typeof a === 'object' && a ? a.port : 0;
        probe.close(() => res(p));
      });
    });
    if (picked > 1024 && picked !== 4477 && picked !== 4478) return picked;
  }
  throw new Error('no free loopback port after 20 tries');
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = 'nothing answered';
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`the server exited with code ${child.exitCode}:\n${childLog}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/graph`);
      await r.arrayBuffer();
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (err) { last = (err as Error).message; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server never answered on port ${port} (${last}):\n${childLog}`);
}

before(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-state-api-')));
  graphPath = join(work, 'graph.json');
  const store = new GraphStore();
  const fragment = await ingestRepo(fixture, { repoName: 'invoice-app' });
  store.roots[fragment.repo] = fixture;
  store.addFragment(fragment);
  stitchHttp(store);
  store.save(graphPath);
  port = await freePort();
  const boot = `const { serveGraph } = await import(${JSON.stringify(serverDist)});\n`
    + `serveGraph(${JSON.stringify(graphPath)}, ${port}, ${JSON.stringify(work)});\n`;
  child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: work,
    env: { ...process.env, MODELHUB_DIR: join(work, 'modelhub'), FIGMA_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { childLog += d; });
  child.stderr.on('data', (d: string) => { childLog += d; });
  await waitReady();
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


const counts = (s: any): [string, any][] => [
  ...Object.entries(s.built).map(([k, c]) => [`built.${k}`, c] as [string, any]),
  ...s.validated.byVerdict.map((v: any, i: number) => [`validated.byVerdict[${i}]`, v.journeys] as [string, any]),
  ['validated.cases', s.validated.cases],
  ...['screensNotBuilt', 'operationsNotImplemented', 'blindSpots', 'drift'].map((k) => [`open.${k}`, s.open[k]] as [string, any]),
];

test('the state of play: three columns of sound typed counts, each with its re-check', async () => {
  const { status, body } = await get('/api/state');
  assert.equal(status, 200);
  assert.deepEqual(body.provenance.sources, ['invoice-app']);
  for (const [where, c] of counts(body)) {
    assert.deepEqual(countedProblems(c, where), [], where);
    assert.equal(c.scope, 'count.scope.workspace', where);
    assert.ok(c.recheck && /^farsight /.test(c.recheck.cli), `${where} names the command that prints it again`);
  }
  // the parts of the cases add up to the cases, and failed · skipped · flaky are among them
  const parts = body.validated.cases.breakdown;
  assert.equal(parts.reduce((a: number, p: any) => a + p.n, 0), body.validated.cases.n);
  assert.ok(body.validated.byVerdict.length >= 1, 'some journey has a verdict word');
  assert.ok(body.validated.lastE2e && body.validated.lastE2e.fresh && body.validated.lastE2e.fresh.key, 'the newest end-to-end run with its one freshness fact');
  // no history store in this temp workspace: said as no history, never as zero commits
  assert.equal(body.open.history, null);
  assert.deepEqual(body.glossary, []);
});

test('every number is the one the other surfaces print, not a new count', async () => {
  const { body } = await get('/api/state');
  const g = (await get('/graph')).body;
  const index = buildIndex(g.nodes, g.edges);
  const designs = designSurface(index, null);
  const apis = apiSurface(index, null);
  assert.equal(body.built.screens.n, designs.reduce((a, d) => a + d.counts.built, 0));
  assert.equal(body.built.screens.of, designs.reduce((a, d) => a + d.counts.designed, 0));
  assert.equal(body.open.screensNotBuilt.n, designs.reduce((a, d) => a + d.counts.designOnly, 0));
  assert.equal(body.open.drift.n, designs.reduce((a, d) => a + d.counts.drift, 0));
  assert.equal(body.built.operations.n, apis.reduce((a, x) => a + x.counts.implemented, 0));
  assert.equal(body.built.operations.of, apis.reduce((a, x) => a + x.counts.operations, 0));
  const tree = (await get('/api/journeys')).body.tree;
  assert.equal(body.built.storylines.n, tree.storylines.length);
  // the fixture as measured: 2 of 3 screens built, Discard draft designed and not built, 1 storyline with 1 branch
  assert.equal(body.built.screens.n, 2);
  assert.deepEqual(body.open.notBuiltNames, ['Discard draft']);
  assert.equal(body.built.branches.n, 1);
  // MCP and the CLI print the same object: a line per number, the re-check on each
  const lines = stateOfPlayLines(stateOfPlay(index, g.meta)).join('\n');
  assert.match(lines, /2 of 3 screens built\s+— re-check: farsight design list · MCP design_surface/);
});

test('the history sentence has both halves, and the halves add up', () => {
  const f = historyFact([{ commits: 282, unindexed: 242 }, { commits: 10, unindexed: 0 }]);
  assert.equal(historySentence(f), '292 commits read into history · 50 ingested by a sync · 242 not yet');
  assert.equal(f.ingested.n + f.notYet.n, f.read.n);
  assert.deepEqual(countedProblems(f.read, 'read'), []);
  assert.equal(historySentence(historyFact([{ commits: 1, unindexed: 1 }])), '1 commit read into history · 0 ingested by a sync · 1 not yet');
});

test('the glossary the config files give reaches the graph, the widest file first', async () => {
  const fragment = await ingestRepo(join(repoRoot, 'examples/nx-workspace'), { repoName: 'nx-workspace' });
  const g = fragment.meta?.config?.glossary ?? [];
  const pick = (k: string) => g.find((e) => e.key === k);
  assert.equal(pick('InvoicesPage')?.label, 'Invoices', 'the root file speaks for the source; the nested word holds under its folder only');
  assert.equal(pick('RunReport')?.label, 'Overnight run report');
  assert.equal(pick('formatMoney')?.file, 'farsight.config.json');
});
