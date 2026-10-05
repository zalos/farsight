/**
 * `GET /api/source?node=<id>` — one part's own lines (round 2026-10-05 §3.2: a gate expands to its
 * code). Only a node the graph names, only inside its source's root; a part with a line and no span
 * reads a short window from that line. Ingests `examples/invoice-app` into a temp directory and
 * serves it on an ephemeral loopback port — never the workspace graph, never 4477 / 4478.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GraphStore, stitchHttp } from '@farsight/core';
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
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-source-api-')));
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

test('a rule with a span answers its own lines, numbered from its line', async () => {
  const { status, body } = await get('/api/source?node=' + encodeURIComponent('invoice-app::src/server/schemas.ts::draftInvoiceSchema'));
  assert.equal(status, 200);
  assert.equal(body.path, 'src/server/schemas.ts');
  assert.equal(typeof body.line, 'number');
  const file = readFileSync(join(fixture, body.path), 'utf8').split('\n');
  assert.equal(body.code.split('\n')[0], file[body.line - 1], 'the first line is the line the part starts on');
  assert.equal(body.code.split('\n').length, body.endLine - body.line + 1);
});

test('a guard named at a line with no span reads a short window from that line', async () => {
  const { status, body } = await get('/api/source?node=' + encodeURIComponent('invoice-app::guard::requireScope(billing:read)'));
  assert.equal(status, 200);
  assert.ok(body.code && body.code.split('\n').length <= 12 && body.code.split('\n').length > 1);
});

test('no node, an unknown node: a 400 and a 404 with a sentence', async () => {
  assert.equal((await get('/api/source')).status, 400);
  const miss = await get('/api/source?node=nope::x');
  assert.equal(miss.status, 404);
  assert.match(miss.body.error, /no node/);
});
