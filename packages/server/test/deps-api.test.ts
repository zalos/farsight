/**
 * `GET /api/deps` and `GET /api/deps/where` — the dependency folds over HTTP
 * (docs/proposals/dependencies-and-nx.md §2.1, §2.3).
 *
 * The endpoints serve `packagesOf` / `importersOf` whole: every row compared against the fold
 * computed here in process. A bad `kind` or `hops`, a missing or unknown package and a name two
 * sources share are 400s with a sentence; a graph written before packages were read says so.
 *
 * Ingests `examples/invoice-app` into a temp directory and serves that graph on an ephemeral
 * loopback port. Nothing here touches the workspace graph, the fixture on disk, or ports 4477 / 4478.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GraphStore, buildIndex, stitchHttp, packagesOf, importersOf, type GraphIndex, type GraphNode, type GraphEdge } from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;
const fixture = join(repoRoot, 'examples/invoice-app');

let work: string;
let graphPath: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';
let index: GraphIndex;

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
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-deps-api-')));
  graphPath = join(work, 'graph.json');
  const store = new GraphStore();
  const fragment = await ingestRepo(fixture, { repoName: 'invoice-app' });
  store.roots[fragment.repo] = fixture;
  store.addFragment(fragment);
  stitchHttp(store);
  store.save(graphPath);
  const data = JSON.parse(readFileSync(graphPath, 'utf8')) as { nodes: GraphNode[]; edges: GraphEdge[] };
  index = buildIndex(data.nodes, data.edges);
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

test('GET /api/deps serves packagesOf whole: rows, the packages count and the built-ins set aside', async () => {
  const { status, body } = await get('/api/deps');
  assert.equal(status, 200);
  const fold = packagesOf(index);
  assert.deepEqual(body.rows, JSON.parse(JSON.stringify(fold.rows)));
  assert.deepEqual(body.packages, fold.packages);
  assert.equal(body.packages.n, 8);
  assert.deepEqual(body.meta['invoice-app'].builtins.map((b: any) => b.spec), ['node:fs', 'node:path', 'node:url']);
  const react = body.rows.find((r: any) => r.name === 'react');
  assert.equal(react.version, '^18.3.1');
  assert.equal(react.journeys.n, 4, 'react reaches the four journeys through the screens that use it');
  assert.equal(body.note, undefined);
});

test('GET /api/deps filters by kind, repo and scope; a bad kind or hops is a 400', async () => {
  const ws = await get('/api/deps?kind=workspace');
  assert.deepEqual(ws.body.rows.map((r: any) => r.name), ['@invoice/plumbing']);
  assert.deepEqual(ws.body.packages.breakdown.map((p: any) => p.n), [0, 1]);
  assert.equal((await get('/api/deps?kind=third-party')).body.rows.length, 7);
  assert.equal((await get('/api/deps?repo=nope')).body.rows.length, 0);
  const scoped = await get('/api/deps?scope=other');
  assert.equal(scoped.body.rows.length, 0);
  assert.equal(scoped.body.packages.n, 0, 'the count follows the scope');
  const badKind = await get('/api/deps?kind=npm');
  assert.equal(badKind.status, 400);
  assert.match(badKind.body.error, /third-party or workspace/);
  assert.equal((await get('/api/deps?hops=0')).status, 400);
  assert.equal((await get('/api/deps?hops=9')).status, 400);
});

test('GET /api/deps/where serves importersOf: grouped importers with line, specifier and users', async () => {
  const { status, body } = await get('/api/deps/where?package=react');
  assert.equal(status, 200);
  assert.deepEqual({ ...body, generatedAt: undefined }, { ...JSON.parse(JSON.stringify(importersOf(index, 'invoice-app::package::react'))), generatedAt: undefined });
  assert.equal(body.importers.n, 4);
  const byId = await get(`/api/deps/where?package=${encodeURIComponent('invoice-app::package::@invoice/plumbing')}`);
  assert.equal(byId.body.groups[0].importers[0].path, 'src/server/approvals.ts');
  assert.deepEqual(byId.body.groups[0].importers[0].users.map((u: any) => u.name), ['receiptFor']);
});

test('GET /api/deps/where: a missing or unknown package is a 400 with a sentence, never a 500', async () => {
  const missing = await get('/api/deps/where');
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /missing \?package=/);
  const unknown = await get('/api/deps/where?package=left-pad');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'no package left-pad in this graph');
});

test('a graph written before packages were read says so instead of reading as "no dependencies"', async () => {
  const data = JSON.parse(readFileSync(graphPath, 'utf8'));
  data.nodes = data.nodes.filter((n: GraphNode) => n.kind !== 'package' && n.kind !== 'module');
  data.edges = data.edges.filter((e: GraphEdge) => e.kind !== 'imports');
  writeFileSync(graphPath, JSON.stringify(data));
  const { status, body } = await get('/api/deps');
  assert.equal(status, 200);
  assert.deepEqual(body.rows, []);
  assert.match(body.note, /re-sync/);
  const where = await get('/api/deps/where?package=react');
  assert.equal(where.status, 400);
  assert.match(where.body.note, /re-sync/);
});
