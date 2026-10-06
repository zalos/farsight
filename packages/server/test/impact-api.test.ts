/**
 * `GET /api/impact` — the dependency-impact fold over HTTP
 * (docs/proposals/dependency-impact.md §4, chunk B5.3).
 *
 * The endpoint serves `impactOf` whole. What is under test is that it is the
 * *same* fold — every hop count, cut point and bound compared against
 * `impactOf` computed here in process, so a second implementation inside the
 * handler would show up as a mismatch that names the number — and that the
 * honesty rules survive the wire:
 *
 *  - the payload carries **no total**, at any level, because the fold carries
 *    none and a consumer must not be handed one to print;
 *  - a floor says it is a floor and why;
 *  - the boot and deferred work ride in `excluded`, never in a hop;
 *  - `behind` and `direct` are two different numbers on the same cut;
 *  - `flows` costs a journey walk per flow and is therefore **off unless asked
 *    for**, which is asserted by its absence;
 *  - a refused hop budget is a 400 with a sentence, an unknown node a 404, and
 *    neither is a 500.
 *
 * Ingests `examples/invoice-app` into a temp directory and serves that graph on
 * an ephemeral loopback port. Nothing here touches the workspace graph, the
 * fixture on disk, or ports 4477 / 4478 (the live dogfood servers).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GraphStore, buildIndex, stitchHttp, impactOf, IMPACT_MAX_HOPS, affectedReach, countedProblems, COUNT_SCOPES,
  type GraphIndex, type GraphMeta, type GraphNode, type GraphEdge, type ImpactOptions,
} from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;
const fixture = join(repoRoot, 'examples/invoice-app');

const TABLE = 'invoice-app::table::invoices';

let work: string;
let graphPath: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';
let index: GraphIndex;
let meta: GraphMeta;

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
  // realpath: macOS /tmp is a symlink and the server resolves its workspace dir
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-impact-api-')));
  graphPath = join(work, 'graph.json');

  const store = new GraphStore();
  const fragment = await ingestRepo(fixture, { repoName: 'invoice-app' });
  store.roots[fragment.repo] = fixture;
  store.addFragment(fragment);
  stitchHttp(store);
  store.save(graphPath);

  const data = JSON.parse(readFileSync(graphPath, 'utf8')) as { nodes: GraphNode[]; edges: GraphEdge[]; meta: GraphMeta };
  index = buildIndex(data.nodes, data.edges);
  meta = data.meta;

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
async function api(path: string): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await r.text();
  assert.equal(r.status, 200, `GET ${path} answered ${r.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}
async function status(path: string): Promise<{ code: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { code: r.status, body: JSON.parse(await r.text()) };
}

/** The fold the endpoint should be serving, computed from the same graph. */
const fold = (id: string, opts: ImpactOptions = {}) => impactOf(index, id, opts);

describe('GET /api/impact — the endpoint is the fold', () => {
  test('hop by hop, cut by cut, the same numbers', async () => {
    const doc = await api(`/api/impact?node=${encodeURIComponent(TABLE)}&hops=3`);
    const want = fold(TABLE, { hops: 3 });
    assert.deepEqual(
      doc.hops.map((h: { hop: number; found: number; nodes: unknown[] }) => [h.hop, h.found, h.nodes.length]),
      want.hops.map((h) => [h.hop, h.found, h.nodes.length]),
    );
    assert.deepEqual(
      doc.cutPoints.map((c: { reason: string; behind: number; direct: number }) => [c.reason, c.behind, c.direct]).sort(),
      want.cutPoints.map((c) => [c.reason, c.behind, c.direct]).sort(),
    );
    assert.equal(doc.bound, want.bound);
    assert.equal(doc.uncertainty.note, want.uncertainty!.note);
    assert.equal(doc.direction, 'upstream');
  });

  test('no total, anywhere: the payload cannot hand a consumer the number the design forbids', async () => {
    const doc = await api(`/api/impact?node=${encodeURIComponent(TABLE)}&hops=3`);
    assert.equal('total' in doc, false);
    assert.equal('count' in doc, false);
    assert.equal('nodes' in doc, false);
    for (const h of doc.hops) assert.equal('total' in h, false);
  });

  test('a cut carries both numbers, and they are not the same number', async () => {
    const SHARED = 'invoice-app::src/ui/fields.tsx::MoneyField';
    const doc = await api(`/api/impact?node=${encodeURIComponent(SHARED)}&hops=3`);
    const shared = doc.cutPoints.filter((c: { reason: string }) => c.reason === 'shared');
    assert.ok(shared.length, 'the fixture must have a shared stop for this to mean anything');
    for (const c of shared) {
      assert.equal(typeof c.direct, 'number');
      assert.equal(typeof c.behind, 'number');
      assert.ok(c.behind >= c.direct, 'the closure is never smaller than its first ring');
    }
    assert.ok(shared.some((c: { behind: number; direct: number }) => c.behind !== c.direct), 'the two must be distinguishable in the fixture');
  });

  test('the boot and deferred work ride apart from the hops', async () => {
    const doc = await api(`/api/impact?node=${encodeURIComponent(TABLE)}&hops=3`);
    const want = fold(TABLE, { hops: 3 });
    assert.deepEqual(doc.excluded.setup.map((n: { name: string }) => n.name), want.excluded.setup.map((n) => n.name));
    assert.deepEqual(doc.excluded.deferred.map((n: { name: string }) => n.name), want.excluded.deferred.map((n) => n.name));
    assert.ok(want.excluded.setup.length && want.excluded.deferred.length, 'the fixture must carry both kinds of aside');
    const listed = new Set(doc.hops.flatMap((h: { nodes: { nodeId: string }[] }) => h.nodes.map((n) => n.nodeId)));
    for (const n of [...doc.excluded.setup, ...doc.excluded.deferred]) assert.equal(listed.has(n.nodeId), false);
  });

  test('the answer says which graph it is of', async () => {
    const doc = await api(`/api/impact?node=${encodeURIComponent(TABLE)}`);
    assert.equal(doc.asOf.sync, meta.sync);
    assert.match(doc.asOf.farsight, /^farsight /);
    // whether the checkout still matches is not knowable per request, so it is left unsaid
    assert.equal('digestMatches' in doc.asOf, false);
    assert.equal(doc.generatedAt, meta.generatedAt);
  });
});

describe('GET /api/impact — options', () => {
  test('hops defaults to 2', async () => {
    const doc = await api(`/api/impact?node=${encodeURIComponent(TABLE)}`);
    assert.equal(doc.hops.at(-1).hop, 2);
  });

  test('tests are attached only when asked for', async () => {
    const plain = await api(`/api/impact?node=${encodeURIComponent(TABLE)}&hops=1`);
    assert.ok(plain.hops[0].nodes.every((n: { tests?: unknown }) => n.tests === undefined));
    const withTests = await api(`/api/impact?node=${encodeURIComponent(TABLE)}&hops=1&tests=1`);
    assert.ok(withTests.hops[0].nodes.some((n: { tests?: unknown[] }) => (n.tests?.length ?? 0) > 0), 'the fixture has covering tests');
  });

  test('flows cost a journey walk per flow, so nothing gets them by accident', async () => {
    const plain = await api(`/api/impact?node=${encodeURIComponent(TABLE)}&hops=1`);
    assert.ok(plain.hops[0].nodes.every((n: { flows?: unknown }) => n.flows === undefined));
    const withFlows = await api(`/api/impact?node=${encodeURIComponent(TABLE)}&hops=1&flows=1`);
    assert.ok(withFlows.hops[0].nodes.some((n: { flows?: unknown[] }) => (n.flows?.length ?? 0) > 0), 'the fixture has flows reaching these nodes');
  });

  test('downstream answers the other question, and says which it answered', async () => {
    const doc = await api(`/api/impact?node=${encodeURIComponent('invoice-app::route::POST /invoices')}&hops=1&direction=downstream`);
    assert.equal(doc.direction, 'downstream');
    assert.deepEqual(
      doc.hops.map((h: { found: number }) => h.found),
      fold('invoice-app::route::POST /invoices', { hops: 1, direction: 'downstream' }).hops.map((h) => h.found),
    );
  });

  test('a name resolves to a node and the payload says what it landed on', async () => {
    const doc = await api('/api/impact?node=invoices&hops=1');
    assert.equal(doc.resolvedFrom, 'invoices');
    assert.equal(doc.seed.id, TABLE);
    assert.equal(doc.seedNode.kind, 'table');
  });
});

describe('GET /api/impact — refusals', () => {
  test(`a budget past ${IMPACT_MAX_HOPS} hops is a 400 with a sentence, not a 500`, async () => {
    const r = await status(`/api/impact?node=${encodeURIComponent(TABLE)}&hops=9`);
    assert.equal(r.code, 400);
    assert.match(r.body.error, /describes the application rather than a dependency/);
  });

  test('a node the graph does not hold is a 404 that says so', async () => {
    const r = await status('/api/impact?node=zzz-nothing-here-zzz');
    assert.equal(r.code, 404);
    assert.match(r.body.error, /nothing in the graph matches/);
  });

  test('no node named at all is a 400 that says what to pass', async () => {
    const r = await status('/api/impact');
    assert.equal(r.code, 400);
    assert.match(r.body.error, /missing \?node=/);
  });

  test('a direction that is neither is a 400, never a silent default', async () => {
    const r = await status(`/api/impact?node=${encodeURIComponent(TABLE)}&direction=sideways`);
    assert.equal(r.code, 400);
    assert.match(r.body.error, /upstream or downstream/);
  });
});

describe('?reach=1 — the impact answer placed on the journeys (the Map\'s Affected mode)', () => {
  const ROUTE = 'invoice-app::route::POST /invoices';
  const ZOD = 'invoice-app::package::zod';
  const reachOf = (id: string, hops = 2) => affectedReach(index, impactOf(index, id, { hops, tests: true }));

  test('absent unless asked for, and over the wire the same fold as in process', async () => {
    assert.equal((await api('/api/impact?node=' + encodeURIComponent(TABLE))).reach, undefined);
    const body = await api('/api/impact?node=' + encodeURIComponent(TABLE) + '&hops=3&tests=1&reach=1');
    const here = reachOf(TABLE, 3);
    assert.deepEqual(body.reach.counted, here.counted);
    assert.deepEqual(body.reach.screens, here.screens);
    assert.equal(body.reach.hops, 3);
  });

  test('a route: the screens whose own path calls it meet it themselves (hop 0); a screen that does not is not reached', () => {
    const r = reachOf(ROUTE);
    const billing = r.screens.filter((s) => s.flowId === 'invoice-app::flow::billing-cycle').map((s) => [s.name, s.hop]);
    assert.deepEqual(billing, [['New invoice', 0], ['Invoice list', 0]]);
    assert.ok(!r.screens.some((s) => s.name === 'Discard draft'), 'the discard screen never calls it');
    assert.deepEqual(r.calls.map((c) => [c.nodeId, c.hop]), [[ROUTE, 0]]);
    assert.ok(r.journeys.every((j) => j.hop === 0 && j.by === ROUTE));
  });

  test('a package reaches its journeys through what imports it (hop 1), the journeys deps counts', () => {
    const r = reachOf(ZOD);
    assert.equal(r.journeys.length, 3);
    assert.ok(r.journeys.every((j) => j.hop === 1));
    assert.deepEqual(r.counted.journeys.breakdown, [{ key: 'count.part.reachDirect', n: 3 }]);
  });

  test('a screen several journeys share is counted once — by the page it shows — and listed once per journey', () => {
    const r = reachOf(ZOD);
    const pages = new Set(r.screens.map((s) => s.screenId));
    assert.equal(r.counted.screens.n, pages.size);
    assert.ok(r.screens.length >= pages.size);
    assert.equal(r.counted.screens.unit, 'count.unit.affectedScreens');
  });

  test('every count is a sound Counted over count.scope.affected whose parts are a partition by distance', () => {
    assert.ok(COUNT_SCOPES.includes('count.scope.affected'));
    for (const id of [TABLE, ROUTE, ZOD]) {
      const r = reachOf(id, 3);
      for (const [k, c] of Object.entries(r.counted)) {
        assert.deepEqual(countedProblems(c, k), [], `${id} ${k}`);
        assert.equal(c.scope, 'count.scope.affected');
        assert.equal((c.breakdown ?? []).reduce((a, p) => a + p.n, 0), c.n, `${id} ${k} parts add up`);
      }
      // the tests are the impact panel's union for hops 1..budget, never a sum of per-hop counts
      const report = impactOf(index, id, { hops: 3, tests: true });
      const union = new Set(report.hops.flatMap((h) => h.nodes.flatMap((n) => (n.tests ?? []).map((t) => t.id))));
      assert.equal(r.counted.tests.n, union.size);
      assert.equal(r.counted.calls.bizUnit, undefined, 'the business lens prints no count of calls');
    }
  });
});
