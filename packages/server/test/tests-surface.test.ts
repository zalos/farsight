/**
 * What `/api/tests` says about its own evidence (clarity phase B3.1).
 *
 * The Tests tab is built entirely out of this endpoint, so three things have to be
 * true of the payload before a screen can be honest about them:
 *
 * 1. **Identity** — a reader can tell which build and which graph produced these
 *    numbers, in the same block the `farsight-tests-matrix v1` document carries.
 * 2. **The evidence ledger** — every configured report with its glob, whether it
 *    matched and why it reads the way it does, plus the gaps as data. `reports: []`
 *    and no `reports` key are different facts and stay different.
 * 3. **`?flow=` resolves exactly** — the id first, then the design id, then the
 *    name, with the class it matched named in the answer; a fuzzy search would
 *    silently answer about a different flow.
 *
 * And `/api/tests/matrix` must be the contract, validated against the checked-in
 * schema, with the same metric the journey and the catalogue print — the matrix is
 * a fourth consumer of one denominator, never a fifth number.
 *
 * Nothing here touches the workspace graph, the fixture on disk, or ports 4477 and
 * 4478 (the live dogfood servers).
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
  GraphStore, buildIndex, stitchHttp, testsSurface, testsMatrixV1, testsIdentity, testsMatrixCsv, TESTS_MATRIX_COLUMNS,
  type GraphIndex, type GraphMeta, type GraphNode, type GraphEdge,
} from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';
// the zero-dependency JSON Schema validator the frozen contracts are held to
import { validate } from '../../core/test/validate.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;
const fixture = join(repoRoot, 'examples/invoice-app');
const matrixSchema = JSON.parse(readFileSync(join(repoRoot, 'schemas/farsight-tests-matrix-v1.schema.json'), 'utf8'));

let work: string;
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
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-tests-api-')));
  const graphPath = join(work, 'graph.json');

  // the same ingest `farsight ingest` runs, minus the snapshot db — so the graph records
  // no sync and no commit, which is itself one of the facts asserted below
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

/** A 200 with its JSON body, or a failure naming the status and what it said. */
async function api(path: string): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await r.text();
  assert.equal(r.status, 200, `GET ${path} answered ${r.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function raw(path: string): Promise<{ status: number; type: string; text: string }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text() };
}

// ─────────────────────────────────────────────────────────────────────────

describe('/api/tests carries its identity', () => {
  test('the identity block is the matrix contract\'s, read off the graph\'s own meta', async () => {
    const body = await api('/api/tests');
    const id = body.identity;
    assert.ok(id, '/api/tests carried no identity block');
    assert.deepStrictEqual(id.source_digest, { 'invoice-app': meta.repos!['invoice-app']!.sourceDigest },
      'identity.source_digest is not the per-repo content digest the ingest recorded');
    assert.match(id.farsight, /^farsight /, `identity.farsight does not read as a build line: ${id.farsight}`);
    assert.match(id.generated_at, /^\d{4}-\d{2}-\d{2}T/, `identity.generated_at is not an ISO instant: ${id.generated_at}`);
    // the same block the core builds from the same meta — one identity, not two
    const fold = testsIdentity(meta);
    assert.deepStrictEqual(
      { ...id, generated_at: '' }, { ...fold, generated_at: '' },
      'identity differs from testsIdentity(meta)',
    );
  });

  test('a graph that records no sync and no commit says so by omission, never with a zero', async () => {
    const id = (await api('/api/tests')).identity;
    // this fixture is ingested without the snapshot db, so there is no sync to quote
    assert.equal(meta.sync, undefined, 'the fixture graph unexpectedly recorded a sync');
    assert.ok(!('sync' in id), `identity invented a sync: ${JSON.stringify(id.sync)}`);
    assert.ok(!('source_commit' in id), `identity invented a commit: ${JSON.stringify(id.source_commit)}`);
  });
});

describe('/api/tests carries the evidence ledger', () => {
  test('every configured report is there with its glob, what it matched and why', async () => {
    const body = await api('/api/tests');
    const reports = body.reports;
    assert.ok(Array.isArray(reports), '/api/tests carried no reports ledger');
    const fold = meta.tests!['invoice-app']!.reports;
    assert.equal(reports.length, fold.length, 'the ledger is not one entry per report the ingest recorded');
    for (const [i, r] of reports.entries()) {
      assert.equal(r.repo, 'invoice-app', 'a report entry does not say which repo it came from');
      assert.deepStrictEqual({ ...r, repo: undefined }, { ...fold[i], repo: undefined },
        `reports[${i}] differs from the meta the ingest recorded`);
      assert.ok(r.glob, `reports[${i}] has no glob — a reader cannot say what was configured`);
      assert.ok(r.reason, `reports[${i}] has no reason — a reader cannot say why it reads this way`);
    }
    // the fixture's blind spot: a configured glob that matched no file at all
    const none = reports.filter((r: any) => r.matched === 0);
    assert.equal(none.length, 1, 'the zero-match glob is missing from the ledger');
    assert.equal(none[0].reason, 'no-match');
    assert.equal(none[0].path, undefined, 'a glob that matched nothing must not name a file');
  });

  test('a results report says how many rows it carried and how many reached no test', async () => {
    const reports = (await api('/api/tests')).reports.filter((r: any) => r.kind === 'results');
    assert.ok(reports.length, 'the fixture has results reports');
    for (const r of reports) {
      assert.equal(typeof r.rows, 'number', `${r.path}: no row count — "2 of 95 did not join" cannot be said`);
      assert.equal(typeof r.unjoined, 'number', `${r.path}: no unjoined count`);
      assert.ok(r.unjoined <= r.rows, `${r.path}: unjoined ${r.unjoined} exceeds rows ${r.rows}`);
    }
  });

  test('the gaps travel as ordered data, each stamped with its repo', async () => {
    const body = await api('/api/tests');
    const fold = meta.tests!['invoice-app']!.gaps!;
    assert.ok(Array.isArray(body.gaps), '/api/tests carried no gaps');
    assert.deepStrictEqual(body.gaps.map((g: any) => g.kind), fold.map((g) => g.kind),
      'the gap kinds, or their order, differ from the ingest\'s');
    for (const g of body.gaps) {
      assert.equal(g.repo, 'invoice-app');
      assert.ok(g.text, 'a gap with no sentence');
    }
    // every blind-spot sentence the fold prints comes from one of these gaps
    for (const s of body.blindSpots) {
      assert.ok(fold.some((g) => s.startsWith(g.text.slice(0, 40))), `a blind spot with no gap behind it: ${s}`);
    }
  });

  test('a scope no source answers has no ledger at all — absent is not empty', async () => {
    const body = await api('/api/tests?scope=not-a-source');
    assert.ok(!('reports' in body), 'a scope that names no repo must not carry another repo\'s reports');
    assert.ok(!('gaps' in body), 'a scope that names no repo must not carry another repo\'s gaps');
    // ... while the scope that does name the repo carries both
    const scoped = await api('/api/tests?scope=invoice-app');
    assert.ok(Array.isArray(scoped.reports) && scoped.reports.length, 'the scoped ledger is missing');
    assert.ok(Array.isArray(scoped.gaps) && scoped.gaps.length, 'the scoped gaps are missing');
  });
});

describe('?flow= resolves exactly, and says how', () => {
  test('an id answers that one row and nothing else', async () => {
    const fold = testsSurface(index, null, meta.tests);
    assert.ok(fold.journeys.length > 1, 'the fixture has several flows, so an id has to pick one');
    for (const r of fold.journeys) {
      const body = await api(`/api/tests?flow=${encodeURIComponent(r.flowId)}`);
      assert.deepStrictEqual(body.journeys.map((x: any) => x.flowId), [r.flowId]);
      assert.equal(body.resolvedFrom, 'id', `?flow=${r.flowId} did not resolve by id`);
      assert.equal(body.flow, r.flowId);
    }
  });

  test('a design id and an exact name resolve too, each naming its class', async () => {
    const fold = testsSurface(index, null, meta.tests);
    const withDesign = fold.journeys.find((r) => r.designId);
    assert.ok(withDesign, 'the fixture has a design-backed flow');
    const byDesign = await api(`/api/tests?flow=${encodeURIComponent(withDesign!.designId!)}`);
    assert.equal(byDesign.resolvedFrom, 'designId');
    assert.deepStrictEqual(byDesign.journeys.map((x: any) => x.flowId), [withDesign!.flowId]);

    const byName = await api(`/api/tests?flow=${encodeURIComponent(withDesign!.name)}`);
    assert.equal(byName.resolvedFrom, 'name');
    assert.deepStrictEqual(byName.journeys.map((x: any) => x.flowId), [withDesign!.flowId]);
  });

  test('nothing that matched is nothing answered — no row, no class, no coverage', async () => {
    const body = await api('/api/tests?flow=no-such-flow');
    assert.deepStrictEqual(body.journeys, []);
    assert.ok(!('resolvedFrom' in body), 'a flow that resolved to nothing must not claim a class');
    assert.ok(!('coverage' in body), 'a flow that resolved to nothing must not carry a coverage block');
    assert.equal(body.flow, 'no-such-flow', 'the answer must repeat what was asked');
  });

  test('a name is never matched fuzzily — a prefix of a real flow resolves to nothing', async () => {
    const fold = testsSurface(index, null, meta.tests);
    const name = fold.journeys[0]!.name;
    assert.ok(name.length > 3, 'the fixture flow names are long enough to truncate');
    const body = await api(`/api/tests?flow=${encodeURIComponent(name.slice(0, name.length - 1))}`);
    assert.deepStrictEqual(body.journeys, [], `a truncated name matched "${name}"`);
  });
});

describe('/api/tests/matrix is farsight-tests-matrix v1', () => {
  test('the document validates against the checked-in schema', async () => {
    const doc = await api('/api/tests/matrix');
    assert.equal(doc.schema, 'farsight-tests-matrix v1');
    assert.deepStrictEqual(validate(doc, matrixSchema), [], 'the matrix document does not validate against schemas/farsight-tests-matrix-v1.schema.json');
    assert.ok(doc.rows.length, 'the fixture produces matrix rows');
  });

  test('it is the same fold the CLI prints — rows, journeys and metric', async () => {
    const doc = await api('/api/tests/matrix');
    const surface = testsSurface(index, null, meta.tests);
    const fold = JSON.parse(JSON.stringify(testsMatrixV1(index, surface, testsIdentity(meta))));
    assert.deepStrictEqual(doc.rows, fold.rows, 'the endpoint\'s rows differ from testsMatrixV1()\'s');
    assert.deepStrictEqual(doc.journeys, fold.journeys, 'the endpoint\'s journey rows differ from the fold\'s');
    assert.deepStrictEqual(doc.metric, fold.metric, 'the endpoint\'s metric differs from the fold\'s');
  });

  test('?format=csv is the contract\'s CSV, one line per row, and nothing else is a format', async () => {
    const doc = await api('/api/tests/matrix');
    const csv = await raw('/api/tests/matrix?format=csv');
    assert.equal(csv.status, 200);
    assert.match(csv.type, /text\/csv/);
    const lines = csv.text.split('\n');
    assert.equal(lines[0], TESTS_MATRIX_COLUMNS.join(','), 'the CSV header is not the column order');
    assert.equal(lines.length, doc.rows.length + 1, 'the CSV is not one line per JSON row plus the header');
    assert.equal(csv.text, testsMatrixCsv(doc.rows), 'the endpoint\'s CSV differs from the core printer\'s');

    const bad = await raw('/api/tests/matrix?format=xml');
    assert.equal(bad.status, 400, 'an unknown format must be refused, not guessed');
    assert.match(JSON.parse(bad.text).error, /json or csv/);
  });

  test('a scope narrows the rows without changing what a row means', async () => {
    const all = await api('/api/tests/matrix');
    const scoped = await api('/api/tests/matrix?scope=invoice-app');
    assert.deepStrictEqual(scoped.rows, all.rows, 'the fixture has one source, so scoping it changes nothing');
    const none = await api('/api/tests/matrix?scope=not-a-source');
    assert.deepStrictEqual(none.rows, [], 'a scope with no source must produce no rows');
    assert.deepStrictEqual(validate(none, matrixSchema), [], 'an empty matrix must still be a valid v1 document');
  });

  test('"matrix" is a reserved path, not a test that happens to be missing', async () => {
    // /api/tests/<id> 404s for an unknown id; /api/tests/matrix must never fall into it
    const missing = await raw('/api/tests/not-a-test-id');
    assert.equal(missing.status, 404);
    assert.equal((await raw('/api/tests/matrix')).status, 200);
  });
});

describe('one denominator — the matrix endpoint is not a fifth number', () => {
  test('a flow\'s metric is the same in /api/tests, in ?flow=, in /api/tests/matrix and in the core fold', async () => {
    const surface = testsSurface(index, null, meta.tests);
    const doc = await api('/api/tests/matrix');
    const list = await api('/api/tests');
    for (const r of surface.journeys) {
      const core = JSON.parse(JSON.stringify(r.coverage.metric));
      const inDoc = doc.journeys.find((x: any) => x.flowId === r.flowId)?.coverage?.metric;
      const inList = list.journeys.find((x: any) => x.flowId === r.flowId)?.coverage?.metric;
      const inFlow = (await api(`/api/tests?flow=${encodeURIComponent(r.flowId)}`)).coverage?.metric;
      for (const [label, got] of [['/api/tests/matrix', inDoc], ['/api/tests', inList], ['?flow=', inFlow]] as const) {
        assert.ok(got, `${label} carried no metric for ${r.flowId}`);
        assert.equal(got.denominator, core.denominator,
          `${r.flowId}: ${label} says ${got.denominator} coverable nodes, the core fold says ${core.denominator}`);
        assert.equal(got.numerator, core.numerator, `${r.flowId}: ${label} numerator differs from the fold's`);
        assert.equal(got.bound, core.bound, `${r.flowId}: ${label} bound differs from the fold's`);
        assert.equal(got.scopeLabel, core.scopeLabel, `${r.flowId}: ${label} scope label differs from the fold's`);
      }
    }
  });
});

describe('every chip the Tests tab can draw is explained by the payload (B3.3)', () => {
  test('observed evidence always says who observed it: cases and run reports are separate counts', async () => {
    const list = await api('/api/tests');
    for (const row of list.journeys) {
      const tests = row.coverage?.counts?.tests;
      assert.ok(tests, `${row.flowId} carries no per-level test counts — the tab cannot attribute its chip`);
      for (const k of ['unit', 'integration', 'e2e', 'observed', 'runLevel']) {
        assert.equal(typeof tests[k], 'number', `${row.flowId}: counts.tests.${k} is missing`);
      }
      if (row.coverage.chip === 'observed' || row.coverage.chip === 'observed-stale') {
        // the page prints "verified by a run" only for a case a results report
        // named, and the run's own word when the evidence is a coverage report
        // with no per-case attribution — one of the two must be available
        assert.ok(tests.observed > 0 || tests.runLevel > 0,
          `${row.flowId}: an observed chip with neither an observed case nor a run report behind it`);
      }
    }
  });

  test('a floor never travels alone: every metric carries its bound and its scope label', async () => {
    const list = await api('/api/tests');
    const metrics = [list.metric, ...list.journeys.map((r: any) => r.coverage.metric)];
    for (const m of metrics) {
      assert.ok(m.scopeLabel, 'a metric arrived with no scope label — a percentage without a scope is a lie waiting to happen');
      assert.ok(m.bound === 'floor' || m.bound === 'exact', `unknown bound ${m.bound}`);
      assert.equal(m.value == null, m.denominator === 0, 'a zero denominator must read as nothing to measure, never as 0%');
      if (m.bound === 'floor' && m.value != null && m.uncertainty) {
        assert.ok(m.uncertainty.note, 'a floor with an uncertainty block must say what made it a floor');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────

/**
 * `/api/tests/<id>` is one test's page (B3.4, board 06). The page draws three
 * evidence groups and a runs panel, so the payload has to keep two things apart
 * that every review found blended: the **class** of a covers edge and the
 * **verdict** of a run. A confidence tier belongs to the edge, never to the
 * class; a case a runner skipped observed nothing, whatever a coverage report
 * saw of the same code.
 */
describe('?level= reaches the header and the tiles, not only the rows (docs/COUNTS.md)', () => {
  test('under a level every count is that level\'s, the typed counts say so, and the whole scope rides beside', async () => {
    // With E2E selected the Tests header read `5825 · 0 unit · 0 integration · 368 e2e`
    // above `431 spec files` — the cards filtered, the header did not (pass swarm 2026-09-25).
    const all = await api('/api/tests');
    for (const level of ['unit', 'e2e']) {
      const one = await api(`/api/tests?level=${level}`);
      const cards = one.sources.reduce((a: number, c: { cases: number }) => a + c.cases, 0);
      assert.equal(one.counts.cases, cards, `${level}: the header is the sum of the cards under it`);
      assert.ok(one.sources.every((c: { level: string }) => c.level === level));
      assert.deepEqual(one.countsAll, all.counts, `${level}: the unfiltered counts ride beside, unchanged`);
      assert.equal(one.counted.cases.n, one.counts.cases);
      assert.equal(one.counted.cases.scope, 'count.scope.selection');
    }
    assert.equal(all.countsAll, undefined, 'no filter, no second set of counts');
    assert.equal(all.counted.cases.scope, 'count.scope.workspace');
    // and each card says whether its cases passed, summing to its cases
    for (const c of all.sources) {
      const r = c.runs;
      assert.equal(r.passed + r.failed + r.skipped + r.flaky + r.unknown + r.noRun, c.cases, `${c.repo} ${c.level}: the verdicts do not sum to the cases`);
    }
  });
});

describe('/api/tests/<id> is one test’s page (B3.4)', () => {
  const idOf = (file: string, title: string) => `invoice-app::test::${file}::${title}`;
  const LIST = idOf('e2e/billing.pw.spec.ts', 'billing › the invoice list shows every invoice newest first');
  const CREATE = idOf('e2e/billing.pw.spec.ts', 'billing › a new invoice is created and appears in the list');
  const FINALIZE = idOf('test/invoiceService.test.ts', 'finalizeInvoice assigns a number and records a ledger entry');
  const EACH = idOf('test/rates.spec.ts', 'tax rates › the %s rate is %d');
  const TODO = idOf('test/rates.spec.ts', 'tax rates › the table reloads when the tax service publishes a change');
  const RUN = 'invoice-app::test::run:unit:invoice-app';

  test('a claim on the page is as of a named sync, in the catalogue’s own identity block', async () => {
    const d = await api(`/api/tests/${encodeURIComponent(LIST)}`);
    const list = await api('/api/tests');
    // generated_at is when this response was written, not a fact about the graph, and two
    // requests are never written in the same millisecond. What must not differ is the graph
    // both answers describe: the sync, the commit, the per-repo digest and the build.
    const graphOf = ({ generated_at: _when, ...rest }: Record<string, unknown>) => rest;
    assert.deepEqual(graphOf(d.identity), graphOf(list.identity), 'the detail and the catalogue must not describe different graphs');
    assert.ok(d.identity.generated_at, 'the detail says when it was written');
    assert.ok(d.identity.farsight, 'the build that produced it');
    assert.ok(d.identity.source_digest['invoice-app'], 'the content digest of the code it describes');
  });

  test('a browser spec carries one run per project, and the case takes the weakest of them', async () => {
    const d = await api(`/api/tests/${encodeURIComponent(LIST)}`);
    const runs = d.test.runs as { project: string; status: string; retries?: number }[];
    assert.deepEqual(runs.map((r) => r.project).sort(), ['desktop-1440', 'mobile-390']);
    assert.deepEqual(runs.map((r) => r.status).sort(), ['flaky', 'passed']);
    // flaky is its own status and is never folded into passed
    assert.equal(runs.find((r) => r.project === 'mobile-390')!.retries, 1);
    assert.equal(d.test.run.status, 'flaky', 'the fold is the weakest project, never the majority');
    // a skipped project weakens the case the same way
    const created = await api(`/api/tests/${encodeURIComponent(CREATE)}`);
    assert.deepEqual((created.test.runs as { status: string }[]).map((r) => r.status).sort(), ['passed', 'skipped']);
    assert.equal(created.test.run.status, 'skipped');
  });

  test('a skipped or inactive case shows no observed edge, and says which silence it is', async () => {
    // (a) a case the runner skipped: it has a row in the report and no result
    const skipped = await api(`/api/tests/${encodeURIComponent(FINALIZE)}`);
    assert.equal(skipped.test.run.status, 'skipped');
    assert.equal(skipped.covers.some((c: any) => c.evidence === 'observed'), false);
    // ...and the coverage report that saw the same file is listed as the run's,
    // never as this case's
    assert.ok(!skipped.alsoObserved || skipped.alsoObserved.every((o: any) => o.id !== skipped.id));

    // (b) a `.todo` case: the case exists, its edges are marked, it lifts nothing
    const todo = await api(`/api/tests/${encodeURIComponent(TODO)}`);
    assert.equal(todo.test.inactive, true);
    assert.equal(todo.covers.some((c: any) => c.evidence === 'observed'), false);
    assert.ok(todo.covers.every((c: any) => c.inactive === true), 'an inactive case marks every edge it emitted');

    // (c) the observed evidence for this fixture lives on the run-level node
    const run = await api(`/api/tests/${encodeURIComponent(RUN)}`);
    assert.equal(run.test.runLevel, true);
    assert.ok(run.covers.length > 0);
    assert.ok(run.covers.every((c: any) => c.evidence === 'observed'), 'a report carries only what it saw');
    assert.equal(run.alsoObserved, undefined, 'a report does not point at itself');
  });

  test('every edge carries its own technique and confidence — a class is not a tier', async () => {
    const d = await api(`/api/tests/${encodeURIComponent(LIST)}`);
    assert.ok(d.covers.length > 0);
    for (const c of d.covers) {
      assert.ok(['declared', 'static', 'observed'].includes(c.evidence), `unknown evidence class ${c.evidence}`);
      if (c.confidence) assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(c.confidence), `unknown tier ${c.confidence}`);
      // a tier never arrives without the technique that earned it
      assert.equal(!!c.confidence, !!c.technique, `${c.nodeId}: a confidence with no technique, or the reverse`);
    }
    const run = await api(`/api/tests/${encodeURIComponent(RUN)}`);
    // an observed edge says how the coverage row met the node; that is not its freshness
    assert.ok(run.covers.every((c: any) => c.technique === 'coverage-report'));
    assert.ok(run.covers.some((c: any) => typeof c.match === 'string'), 'an observed edge records its match quality');
  });

  test('the page and the catalogue agree about orphans, runs and parametrised rows', async () => {
    const list = await api('/api/tests');
    const d = await api(`/api/tests/${encodeURIComponent(LIST)}`);
    assert.equal(d.orphan.reason, 'unresolved-claim');
    assert.deepEqual(d.orphan.declares, d.test.unresolved);
    const row = list.orphans.find((o: any) => o.testId === LIST && o.reason === 'unresolved-claim');
    assert.ok(row, 'an orphan on the page is an orphan in the catalogue');

    // a test that lands on nothing reads the other reason, and only that one
    const todo = await api(`/api/tests/${encodeURIComponent(TODO)}`);
    assert.equal(todo.covers.length, 0);
    assert.equal(todo.orphan.reason, 'covers-nothing');

    // an it.each template keeps how many rows it joined, so the page never
    // prints one run where the report had three
    const each = await api(`/api/tests/${encodeURIComponent(EACH)}`);
    const r = each.test.runs[0];
    assert.equal(r.join, 'each-template');
    assert.equal(r.rows, 3);
  });

  test('an id nothing answers to is a 404 with the id in it, never an empty page', async () => {
    const miss = await raw(`/api/tests/${encodeURIComponent('invoice-app::test::nope.spec.ts::nothing')}`);
    assert.equal(miss.status, 404);
    assert.match(miss.text, /nope\.spec\.ts/);
  });
});

/**
 * A table is never reached by a test directly — a test calls the function that
 * reads or writes it. Left as it was, a table step in a journey printed *no
 * test reaches this step*, which reads as untested and is not what the graph
 * says (B4.2, tests plan §4.3). The journey step now carries what reaches its
 * accessors, capped, with the total beside it so the cap is visible.
 */
describe('/api/journey — a table says what reaches its accessors', () => {
  test('a table step carries accessor-borne evidence; a table nothing reads carries none', async () => {
    const j = await api(`/api/journey?entry=${encodeURIComponent('invoice-app::flow::draft-and-send')}`);
    const tables = j.steps.filter((s: any) => s.node && s.node.kind === 'table');
    assert.ok(tables.length > 0, 'the flow reaches at least one table');

    // no test covers a table node itself, so the direct fold stays empty
    assert.ok(tables.every((s: any) => !s.coverage), 'a table is never covered directly');

    const invoices = tables.find((s: any) => s.node.id === 'invoice-app::table::invoices');
    assert.ok(invoices, 'the flow writes invoices');
    assert.ok(invoices.coverageVia.length > 0, 'the accessors of invoices are reached by tests');
    assert.equal(invoices.coverageViaCount, invoices.coverageVia.length, 'nothing was capped away here');
    // every ref names the accessor it came through, and keeps its own class
    for (const ref of invoices.coverageVia) {
      assert.equal(ref.reaches.nodeId, 'invoice-app::table::invoices');
      assert.ok(ref.via && ref.via !== ref.reaches.nodeId, `${ref.name} names no accessor`);
      assert.ok(['declared', 'static', 'observed'].includes(ref.evidence));
    }
    // and a run report stays a report: it is in the list, and it is not a case
    assert.ok(invoices.coverageVia.some((r: any) => r.runLevel === true));

    const customers = tables.find((s: any) => s.node.id === 'invoice-app::table::customers');
    if (customers) assert.equal(customers.coverageVia, undefined, 'an empty list and no list are different facts');
  });
});
