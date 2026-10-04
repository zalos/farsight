/**
 * `GET /api/projects` and `GET /api/projects/<name>` — the project graph over HTTP
 * (docs/proposals/dependencies-and-nx.md §2.2–§2.3).
 *
 * The list is `projectGraph` whole (compared against the fold computed here in process, so a
 * second implementation inside the handler would show as a mismatch); one project adds its
 * dependencies, dependents, closure and node ids by kind; an unknown name is a 404, a name two
 * sources share without `?repo=` a 409. Ingests `examples/nx-workspace` and `examples/invoice-app`
 * into a temp directory and serves that graph on an ephemeral loopback port — never 4477 / 4478.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GraphStore, buildIndex, projectGraph, type GraphMeta, type GraphNode, type GraphEdge, type GraphIndex } from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;

let work: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';
let index: GraphIndex;
let meta: GraphMeta;

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

before(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-projects-api-')));
  const graphPath = join(work, 'graph.json');
  const store = new GraphStore();
  for (const [name, dir] of [['nx-workspace', 'examples/nx-workspace'], ['invoice-app', 'examples/invoice-app']] as const) {
    const fragment = await ingestRepo(join(repoRoot, dir), { repoName: name });
    store.roots[name] = join(repoRoot, dir);
    store.addFragment(fragment);
  }
  store.save(graphPath);
  const data = JSON.parse(readFileSync(graphPath, 'utf8')) as { nodes: GraphNode[]; edges: GraphEdge[]; meta: GraphMeta };
  index = buildIndex(data.nodes, data.edges);
  meta = data.meta;
  port = await freePort();
  const boot = `const { serveGraph } = await import(${JSON.stringify(serverDist)});\n`
    + `serveGraph(${JSON.stringify(graphPath)}, ${port}, ${JSON.stringify(work)});\n`;
  child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: work, env: { ...process.env, MODELHUB_DIR: join(work, 'modelhub'), FIGMA_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { childLog += d; });
  child.stderr.on('data', (d: string) => { childLog += d; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`the server exited with code ${child.exitCode}:\n${childLog}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/graph`); await r.arrayBuffer(); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server never answered on port ${port}:\n${childLog}`);
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
async function get(path: string): Promise<{ code: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { code: r.status, body: JSON.parse(await r.text()) };
}

test('GET /api/projects serves the projectGraph fold whole, every source together', async () => {
  const { code, body } = await get('/api/projects');
  assert.equal(code, 200);
  const fold = projectGraph(index, meta.projects);
  assert.deepEqual(body.projects, JSON.parse(JSON.stringify(fold.projects)));
  assert.deepEqual(body.dependencies, JSON.parse(JSON.stringify(fold.dependencies)));
  assert.deepEqual(body.counts, JSON.parse(JSON.stringify(fold.counts)));
  assert.deepEqual(body.repos.map((r: any) => `${r.repo}:${r.tool}`), ['invoice-app:none', 'nx-workspace:nx']);
  // every project's tree rides on its row, the same as /api/projects/<name> answers it
  const web = body.projects.find((p: any) => p.name === 'billing-web');
  assert.deepEqual(web.closure, ['billing-web', '@nxw/shared-ui', 'billing-feature-invoices', 'shared-util', 'billing-data-access', 'billing-ui']);
  assert.deepEqual(body.repos.find((r: any) => r.repo === 'nx-workspace').graphFile, { path: 'nx-project-graph.json', projects: 8, dependencies: 11 });
});

test('GET /api/projects?repo= narrows to one source', async () => {
  const { body } = await get('/api/projects?repo=nx-workspace');
  assert.equal(body.repo, 'nx-workspace');
  assert.equal(body.projects.length, 8);
  assert.equal(body.counts.projects.n, 8);
  assert.equal(body.counts.projects.scope, 'count.scope.workspace');
});

test('GET /api/projects/<name> — dependencies, dependents, closure and node ids by kind', async () => {
  const { code, body } = await get('/api/projects/billing-web');
  assert.equal(code, 200);
  assert.equal(body.project.name, 'billing-web');
  assert.deepEqual(body.dependencies.map((d: any) => d.to), ['@nxw/shared-ui', 'billing-feature-invoices', 'shared-util']);
  assert.deepEqual(body.dependents.map((d: any) => `${d.from}${d.implicit ? ' (implicit)' : ''}`), ['billing-web-e2e (implicit)']);
  assert.deepEqual(body.closure.projects, ['billing-web', '@nxw/shared-ui', 'billing-feature-invoices', 'shared-util', 'billing-data-access', 'billing-ui']);
  assert.deepEqual(Object.keys(body.nodeIds).sort(), ['component', 'page']);
  assert.equal(body.tagDimensions[0].key, 'domain');
  // a scoped package name travels percent-encoded
  const scoped = await get(`/api/projects/${encodeURIComponent('@nxw/shared-ui')}`);
  assert.equal(scoped.code, 200);
  assert.deepEqual(scoped.body.dependents.map((d: any) => d.from), ['billing-web', 'ops-admin']);
});

test('an unknown project is a 404 with a sentence', async () => {
  const { code, body } = await get('/api/projects/nope');
  assert.equal(code, 404);
  assert.match(body.error, /no project named nope/);
});
