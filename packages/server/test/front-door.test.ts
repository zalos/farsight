/**
 * The front door's numbers, twice.
 *
 * `#/journeys` and `#/portfolio` print their facts from three endpoints —
 * `/api/design`, `/api/apis`, `/api/tests` — while the same facts are computed
 * by pure folds in core (`designSurface`, `apiSurface`, `testsSurface`, and
 * `journeyCoverage` through `journeySummary`). Nothing else stops the two
 * drifting apart, and the whole clarity phase rests on a number meaning the
 * same thing wherever a reader meets it. So: ingest `examples/invoice-app` into
 * a temp directory, serve that graph on an ephemeral loopback port, and assert
 * endpoint == fold, number by number. A mismatch names the number and prints
 * both values.
 *
 * The last suite is the clarity phase's one-denominator acceptance (01-code-plan
 * §3.6): a flow's coverage sentence has to read the same in `/api/journey`, in
 * `/api/tests?flow=`, in the matrix row and in the core fold.
 *
 * Nothing here touches the workspace graph, the fixture on disk, or ports 4477
 * and 4478 (the live dogfood servers).
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
  GraphStore, buildIndex, stitchHttp, designSurface, apiSurface, testsSurface,
  flowStatusWord, journey, journeySummary, screensFor, journeyTree,
  type GraphIndex, type GraphMeta, type GraphNode, type GraphEdge,
} from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;
const fixture = join(repoRoot, 'examples/invoice-app');

let work: string;
let graphPath: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';

/** The index the server builds for every request — same JSON, same order (`loadJourneyGraph`). */
let index: GraphIndex;
let meta: GraphMeta;

// ── bringing the server up and down ───────────────────────────────────────

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

/** Wait until /graph answers, or fail with whatever the child said. */
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
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-server-')));
  graphPath = join(work, 'graph.json');

  // the same ingest `farsight ingest` runs, minus the snapshot db: read the fixture
  // in place (nothing writes to it), write the graph into the temp dir
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
    // MODELHUB_DIR: serveGraph rotates the event stream on boot — keep it in the temp dir.
    // FIGMA_TOKEN: the design payload reports whether one is set, so pin it.
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

// ── comparing an endpoint with its fold ───────────────────────────────────

async function api(path: string): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await r.text();
  assert.equal(r.status, 200, `GET ${path} answered ${r.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

/** The fold's value as the wire carries it: JSON is the transport, not the fact. */
function wire<T>(v: T): any { return JSON.parse(JSON.stringify(v)); }

/** One named fact. The message says which number disagreed and what both sides say. */
function same(label: string, got: unknown, want: unknown): void {
  assert.deepStrictEqual(got, want,
    `${label}: the endpoint says ${JSON.stringify(got)}, the core fold computes ${JSON.stringify(want)}`);
}

/** Every key of a counts object, named one at a time. */
function sameCounts(label: string, got: Record<string, unknown>, want: Record<string, unknown>): void {
  same(`${label} — the set of numbers`, Object.keys(got).sort(), Object.keys(want).sort());
  for (const k of Object.keys(want)) same(`${label}.${k}`, got[k], want[k]);
}

/** The metric facts a coverage sentence is made of. */
function sameMetric(label: string, got: any, want: any): void {
  same(`${label}.denominator`, got?.denominator, want?.denominator);
  same(`${label}.numerator`, got?.numerator, want?.numerator);
  same(`${label}.value`, got?.value, want?.value);
  same(`${label}.bound`, got?.bound, want?.bound);
  same(`${label}.scopeLabel`, got?.scopeLabel, want?.scopeLabel);
}

// ─────────────────────────────────────────────────────────────────────────

describe('/api/journeys is journeyTree()', () => {
  test('the tree — personas, groups, journeys in order, every count — is the fold\'s, whole and scoped', async () => {
    const body = await api('/api/journeys');
    same('scope', body.scope, 'all');
    same('tree', body.tree, wire(journeyTree(index, meta.journeys, null)));
    const scoped = await api('/api/journeys?scope=invoice-app');
    same('scoped tree', scoped.tree, wire(journeyTree(index, meta.journeys, new Set(['invoice-app']))));
    const other = await api('/api/journeys?scope=nothing-here');
    same('a scope with no source', other.tree.counts.journeys.n, 0);
  });

  test('the example manifest\'s organisation reaches the wire: declared order, the config placement, one flow under two personas', async () => {
    const { tree } = await api('/api/journeys');
    same('personas in declared order', tree.personas.map((p: any) => p.name), ['Billing', 'Operations']);
    same('billing groups', tree.personas[0].groups.map((g: any) => `${g.name}: ${g.journeys.map((j: any) => j.id).join(', ')}`),
      ['Invoices: billing-cycle, new-invoice', 'Review and send: draft-and-send']);
    same('journeys counted once', tree.counts.journeys.n, 3);
    same('the placement says who moved it', tree.personas[1].groups[0].journeys[0].placedBy, 'farsight.config.json');
    // every flow the design surface lists is in the tree, and nothing else is
    const flows = designSurface(index, null).flatMap((d) => d.flows.map((f) => f.nodeId)).sort();
    same('the tree holds the design surface\'s flows', [...new Set(tree.personas.flatMap((p: any) => p.groups.flatMap((g: any) => g.journeys.map((j: any) => j.nodeId))))].sort(), flows);
  });

  test('/api/journey (singular) still answers a walk — the two routes share a prefix', async () => {
    const r = await api('/api/journey?entry=invoice-app::flow::new-invoice');
    assert.ok(Array.isArray(r.steps), 'the journey walk');
  });
});

describe('/api/design is designSurface()', () => {
  test('the screen and flow counts on the card are the fold\'s counts', async () => {
    const body = await api('/api/design');
    const fold = wire(designSurface(index, null));
    same('design sources', body.designs.map((d: any) => d.id), fold.map((d: any) => d.id));
    for (const [i, d] of fold.entries()) sameCounts(`designs[${d.id}].counts`, body.designs[i].counts, d.counts);
  });

  test('every flow row\'s built / total / status is the fold\'s, and the status word follows from those numbers', async () => {
    const body = await api('/api/design');
    const fold = wire(designSurface(index, null));
    for (const [i, d] of fold.entries()) {
      const rows = body.designs[i].flows;
      same(`designs[${d.id}].flows`, rows.map((f: any) => f.id), d.flows.map((f: any) => f.id));
      for (const [j, f] of d.flows.entries()) {
        const row = rows[j];
        same(`flow ${f.id}.built`, row.built, f.built);
        same(`flow ${f.id}.total`, row.total, f.total);
        same(`flow ${f.id}.status`, row.status, f.status);
        same(`flow ${f.id}.screens`, row.screens, f.screens);
        // the row's own numbers must agree: n of m screens built, m screens listed
        same(`flow ${f.id} — total vs the screens it lists`, row.total, row.screens.length);
        assert.ok(row.built <= row.total, `flow ${f.id}: built ${row.built} exceeds total ${row.total}`);
        // ... and the status word the front door prints is the one those numbers make
        const word = flowStatusWord(row.built, row.total);
        same(`flow ${f.id} — the word for ${row.built} of ${row.total}`,
          word.key === 'journey.status.built', row.status === 'both');
      }
      same(`designs[${d.id}].counts.flows`, body.designs[i].counts.flows, rows.length);
    }
  });

  test('the detail endpoint enriches the rows without changing them', async () => {
    const list = await api('/api/design');
    for (const d of list.designs) {
      const detail = await api(`/api/design/${encodeURIComponent(d.id)}`);
      const plain = detail.screens.map(({ node, ...row }: any) => row);
      assert.deepStrictEqual(plain, d.screens, `/api/design/${d.id}: the screen rows differ from the list's`);
      for (const s of detail.screens) assert.ok(s.node?.id === s.nodeId, `${d.id}: a screen row lost its node`);
    }
  });
});

describe('/api/apis is apiSurface()', () => {
  test('the operations counts on the card are the fold\'s counts', async () => {
    const body = await api('/api/apis');
    const fold = wire(apiSurface(index, null));
    same('api surfaces', body.apis.map((a: any) => a.id), fold.map((a: any) => a.id));
    for (const [i, a] of fold.entries()) {
      sameCounts(`apis[${a.id}].counts`, body.apis[i].counts, a.counts);
      same(`apis[${a.id}].operations listed`, body.apis[i].operations.length, a.counts.operations);
    }
  });

  test('"n of m operations implemented" adds up on both sides', async () => {
    const body = await api('/api/apis');
    for (const a of body.apis) {
      const c = a.counts;
      same(`apis[${a.id}]: implemented vs operations − notImplemented`, c.implemented, c.operations - c.notImplemented);
      same(`apis[${a.id}]: declared + undocumented vs operations`, c.declared + c.undocumented, c.operations);
      same(`apis[${a.id}]: drift vs the drift on its operations`,
        c.drift, a.operations.reduce((s: number, o: any) => s + o.drift.length, 0));
    }
  });

  test('the detail endpoint\'s operations are the fold\'s operations', async () => {
    const fold = wire(apiSurface(index, null));
    for (const a of fold) {
      const detail = await api(`/api/apis/${encodeURIComponent(a.id)}`);
      same(`/api/apis/${a.id} operations`, detail.operations.map((o: any) => o.routeId), a.operations.map((o: any) => o.routeId));
      for (const [i, o] of a.operations.entries()) {
        same(`${a.id} ${o.name}.status`, detail.operations[i].status, o.status);
        same(`${a.id} ${o.name}.drift`, detail.operations[i].drift, o.drift);
        same(`${a.id} ${o.name}.gates`, detail.operations[i].gates, o.gates);
      }
    }
  });
});

describe('/api/tests is testsSurface()', () => {
  test('the catalogue counts, the metric and the blind spots are the fold\'s', async () => {
    const body = await api('/api/tests');
    const fold = wire(testsSurface(index, null, meta.tests));
    sameCounts('tests.counts', body.counts, fold.counts);
    sameMetric('tests.metric', body.metric, fold.metric);
    same('tests.blindSpots', body.blindSpots, fold.blindSpots);
    // nothing else in the payload drifted either
    assert.deepStrictEqual(body.sources, fold.sources, '/api/tests: the source cards differ from the fold\'s');
    assert.deepStrictEqual(body.orphans, fold.orphans, '/api/tests: the orphans differ from the fold\'s');
  });

  test('every matrix row\'s denominator, bound and evidence word are the fold\'s', async () => {
    const body = await api('/api/tests');
    const fold = wire(testsSurface(index, null, meta.tests));
    same('tests.journeys', body.journeys.map((r: any) => r.flowId), fold.journeys.map((r: any) => r.flowId));
    for (const [i, r] of fold.journeys.entries()) {
      const row = body.journeys[i];
      same(`row ${r.flowId}.screens`, row.screens, r.screens);
      same(`row ${r.flowId}.built`, row.built, r.built);
      same(`row ${r.flowId}.e2e`, row.e2e, r.e2e);
      same(`row ${r.flowId}.coverage.chip`, row.coverage.chip, r.coverage.chip);
      same(`row ${r.flowId}.coverage.counts.nodes`, row.coverage.counts.nodes, r.coverage.counts.nodes);
      same(`row ${r.flowId}.coverage.counts.covered`, row.coverage.counts.covered, r.coverage.counts.covered);
      sameMetric(`row ${r.flowId}.coverage.metric`, row.coverage.metric, r.coverage.metric);
      same(`row ${r.flowId}.gap`, row.gap, r.gap);
    }
    assert.deepStrictEqual(body.journeys, fold.journeys, '/api/tests: a matrix row differs from the fold\'s');
  });

  test('a scoped catalogue is the scoped fold, not the whole graph\'s numbers', async () => {
    const body = await api('/api/tests?scope=invoice-app');
    const fold = wire(testsSurface(index, new Set(['invoice-app']), meta.tests));
    sameCounts('tests?scope=invoice-app counts', body.counts, fold.counts);
    sameMetric('tests?scope=invoice-app metric', body.metric, fold.metric);
    const none = await api('/api/tests?scope=not-a-source');
    same('tests?scope=not-a-source counts.cases', none.counts.cases, 0);
  });

  test('?flow= answers with that row\'s own coverage, not a second computation', async () => {
    const fold = wire(testsSurface(index, null, meta.tests));
    for (const r of fold.journeys) {
      const body = await api(`/api/tests?flow=${encodeURIComponent(r.flowId)}`);
      same(`?flow=${r.flowId} rows`, body.journeys.map((x: any) => x.flowId), [r.flowId]);
      assert.deepStrictEqual(body.coverage, r.coverage, `?flow=${r.flowId}: the coverage differs from the matrix row's`);
    }
  });
});

describe('the front door\'s cells cannot overclaim (swarm 2026-09-23)', () => {
  test('the operations cell counts only operations code calls, and says the rest are declared', async () => {
    // `7 called` for seven operations no code implements: the cell counted every
    // action, and an action exists for a declared operation whether or not code
    // performs it (blocker 1). Recomputed here from the payload the cell reads,
    // independently of the fold, so the two have to agree.
    const design = await api('/api/design');
    const flows = (design.designs || []).flatMap((d: any) => d.flows || []);
    assert.ok(flows.length, '/api/design named no flows — the fixture has three');
    for (const f of flows) {
      const jn = await api(`/api/journey?entry=${encodeURIComponent(f.nodeId)}`);
      const sum = jn.summary;
      const via = new Map<number, string>();
      const nodeOf = new Map<number, string>();
      for (const st of jn.steps || []) { via.set(st.order, st.via); nodeOf.set(st.order, st.nodeId); }
      const segs = sum.segments || [];
      const actions = segs.flatMap((sg: any) => (sg.moments || []).filter((mo: any) => mo.callStep != null));
      const real = actions.filter((mo: any) => via.get(mo.callStep) !== 'planned');
      // The identity is the operation, not the occurrence: since 2026-09-24 an
      // operation two screens call is one operation, because counting occurrences
      // is how one flow read `19 called` for ten operations and `31 things the
      // user can do` above nine cards captioned *actions 1–9 again*.
      const called = new Set(real.map((mo: any) => nodeOf.get(mo.callStep)));
      const declared = new Set(
        actions.filter((mo: any) => via.get(mo.callStep) === 'planned').map((mo: any) => nodeOf.get(mo.callStep))
          .concat(segs.flatMap((sg: any) => (sg.declaredOnly || []).map((d: any) => d.routeId ?? d.op)))
          .filter((id: string) => !called.has(id)),
      );
      same(`${f.nodeId}: counts.called`, sum.counts.called, called.size);
      same(`${f.nodeId}: counts.declaredNotCalled`, sum.counts.declaredNotCalled, declared.size);
      same(`${f.nodeId}: counts.again`, sum.counts.again, real.filter((mo: any) => mo.repeat).length);
      // the occurrences are not lost: an operation called once and repeated twice
      // is one operation and two more runs of it, and the two numbers say so
      assert.ok(sum.counts.called + sum.counts.again >= real.length,
        `${f.nodeId}: the operations and the repeats lose a call between them`);
      // no operation is counted on both sides of the split
      assert.equal([...called].some((id) => declared.has(id as string)), false,
        `${f.nodeId}: an operation is counted as called and as declared`);
      // and the cell's absence word is earned: nothing called means nothing built called it
      if (!sum.counts.called) {
        assert.equal(actions.every((mo: any) => via.get(mo.callStep) === 'planned'), true,
          `${f.nodeId}: counts.called is 0 while an action's call step is real code`);
      }
    }
  });

  test('a flow with nothing built carries sharedEvidence, and one that built something does not', async () => {
    // A green *verified by a run* ring beside `designed, not built · 0 of 2`
    // (blocker 2). The qualifier is the fold's, so the HUD cell and MCP read one
    // decision instead of each guessing.
    const design = await api('/api/design');
    const flows = (design.designs || []).flatMap((d: any) => d.flows || []);
    for (const f of flows) {
      const cov = (await api(`/api/tests?flow=${encodeURIComponent(f.nodeId)}`)).coverage;
      const nothingBuilt = (f.total || 0) > 0 && !(f.built || 0);
      if (cov.chip === 'none') { same(`${f.nodeId}: no chip, no qualifier`, cov.sharedEvidence, undefined); continue; }
      same(`${f.nodeId}: sharedEvidence present`, !!cov.sharedEvidence, nothingBuilt);
      if (cov.sharedEvidence) same(`${f.nodeId}: sharedEvidence.screens`, cov.sharedEvidence.screens, f.total);
    }
  });

  test('verified means a run saw it: the boolean never rides on a route literal', async () => {
    // `verifiedEndToEnd` promoted `reached` — a Playwright body carrying a route
    // literal, stamped route-literal LOW — to the word *verified* (blocker 6).
    const body = await api('/api/tests');
    for (const r of body.journeys) {
      same(`row ${r.flowId}: verifiedEndToEnd is the observed rung and nothing weaker`,
        r.verifiedEndToEnd, r.e2e === 'observed');
      same(`row ${r.flowId}: the row's boolean is the coverage fold's`,
        r.verifiedEndToEnd, r.coverage.verifiedEndToEnd);
      if (r.e2e === 'reached') assert.equal(r.verifiedEndToEnd, false, `row ${r.flowId}: static evidence is not a verification`);
    }
  });

  test('the coverage sentence and the count line never print two different unit totals', async () => {
    // `270 unit` three lines under `252 unit` — the prose folded integration cases
    // and run-level coverage reports into the phrase "unit tests" (blocker 5).
    const body = await api('/api/tests');
    for (const r of body.journeys) {
      const c = r.coverage.counts.tests;
      const folded = [c.unit + c.integration, c.unit + c.runLevel, c.unit + c.integration + c.runLevel]
        .filter((n) => n !== c.unit);
      for (const n of folded) {
        assert.equal(r.coverage.note.includes(`${n} unit`), false,
          `row ${r.flowId}: the sentence says "${n} unit" while the count line says ${c.unit} unit`);
      }
      if (c.unit) assert.ok(r.coverage.note.includes(`${c.unit} unit test`), `row ${r.flowId}: the sentence drops the unit count`);
      if (c.integration) assert.ok(r.coverage.note.includes(`${c.integration} integration test`), `row ${r.flowId}: the sentence hides ${c.integration} integration case(s)`);
      if (c.runLevel) assert.ok(r.coverage.note.includes(`${c.runLevel} run-level coverage report`), `row ${r.flowId}: the sentence counts a report as a test`);
    }
  });

  test('the journey header counts what the items under it say, and can be pasted', async () => {
    // `19 things the user can do` sat four inches above nine cards captioned
    // *actions 1–9 again*, and `31` on the POC flow where the flow status table
    // said `15` (visual swarm 2026-09-24). Since the counts ledger (docs/COUNTS.md)
    // the header prints the core's typed counts: `actions` is the fold's `called`,
    // and the numbers about the same calls — again, declared-not-called and the
    // rail's stops — ride in its tip, named, never summed into it (pass swarm
    // 2026-09-25: *"a run-on of 14 counts"*). The header has no runner of its own,
    // so the guard is at the source.
    const read = (f: string): string => readFileSync(join(repoRoot, 'packages/server/public/app/surfaces', f), 'utf8');
    const header = read('journeys.js').split('function jrnHeaderHtml(')[1]?.split('\nfunction ')[0] ?? '';
    assert.ok(header, 'jrnHeaderHtml is gone — this guard needs rewriting, not deleting');
    assert.match(header, /C\('actions'\)/, 'the header must print the typed count of actions (the fold\'s `called`), not the moments');
    assert.match(header, /cnt\.called/, 'and fall back to the fold\'s `called` on a server with no typed counts');
    for (const rel of ['again', 'declaredNotCalled', 'actionStops']) {
      assert.match(header, new RegExp(`C\\('${rel}'\\)`), `the actions tip must name \`${rel}\` beside the actions, from the same fold`);
    }
    assert.match(header, /C\('notInWords'\)/, 'one concept, one number: the conditions not in plain language are the typed whole in every lens');
    // the separators are text, not only CSS: pasted into a ticket this line read
    // `19 actions3 DECLARED ONLYVERIFIED BY A RUNE2E REACHED`
    assert.match(header, /<span class="jrn-hsep"> · <\/span>/, 'the groups are joined by a separator that is real text');
    assert.match(header, /join\(' · '\)/, 'and the items inside a group too');
  });

  test('both surfaces read the flow\'s evidence word off the same field', async () => {
    // The flow status table said *verified by a run* and the journey header said
    // *reached by tests* for one flow at one sync: two rungs of one ladder, because
    // one surface printed the chip and the other derived a word from `e2e`
    // (blocker 7). The payload guarantee is asserted in the one-denominator suite;
    // this is the viewer half, and the viewer has no runner of its own — so it is
    // checked at the source, on the two functions that print the word.
    const read = (f: string): string => readFileSync(join(repoRoot, 'packages/server/public/app/surfaces', f), 'utf8');
    const header = read('journeys.js').split('function jrnHeaderHtml(')[1]?.split('\nfunction ')[0] ?? '';
    assert.ok(header, 'jrnHeaderHtml is gone — this guard needs rewriting, not deleting');
    // Since the visual swarm of 2026-09-24 the word itself comes from the fold
    // (`coverage.evidenceWord`), because printing the chip was not enough: two of
    // the four printers did not know that an observed class carried only by
    // coverage reports says *seen by a coverage run*, so eight of ten flows read
    // one word on the front door and another on the Tests tab.
    assert.match(header, /evidenceWord\(cov\)/, 'the journey header must take its evidence word from the fold');
    assert.doesNotMatch(header, /journey\.evidence\.' \+ /,
      'the journey header is assembling the ladder word itself again: two surfaces, two rungs, one flow');
    const cell = read('portfolio.js').split('function testedCell(')[1]?.split('\nfunction ')[0] ?? '';
    assert.ok(cell, 'testedCell is gone — this guard needs rewriting, not deleting');
    assert.match(cell, /evidenceWord\(c\)/, 'the flow status table must take its evidence word from the fold');
    assert.doesNotMatch(cell, /journey\.evidence\.' \+ /, 'the flow status table is assembling the word itself again');
    assert.match(cell, /sharedEvidence/, 'and it must respect the fold\'s shared-evidence qualifier');
    const tab = read('tests.js').split('function evidenceCellHtml(')[1]?.split('\nfunction ')[0] ?? '';
    assert.ok(tab, 'evidenceCellHtml is gone — this guard needs rewriting, not deleting');
    assert.match(tab, /evidenceWord\(c\)/, 'the Tests tab must take its evidence word from the same fold');
  });
});

describe('one denominator (clarity phase §3.6)', () => {
  test('a flow\'s coverage sentence is the same number and the same label in the journey, in the matrix and in the core fold', async () => {
    const fold = wire(testsSurface(index, null, meta.tests));
    for (const r of fold.journeys) {
      const id = r.flowId;
      // the fold the server runs for /api/journey
      const jr = journey(index, id);
      const core = wire(journeySummary(index, jr, screensFor(index, id)).coverage?.journey);
      assert.ok(core, `journeySummary(${id}) carried no coverage — the fixture has test nodes`);
      const jn = await api(`/api/journey?entry=${encodeURIComponent(id)}`);
      const viaJourney = jn.summary?.coverage?.journey;
      assert.ok(viaJourney, `/api/journey?entry=${id} carried no coverage`);
      const viaTests = (await api(`/api/tests?flow=${encodeURIComponent(id)}`)).coverage;

      sameMetric(`${id}: /api/journey vs the core fold`, viaJourney.metric, core.metric);
      sameMetric(`${id}: /api/tests?flow= vs the core fold`, viaTests.metric, core.metric);
      sameMetric(`${id}: the matrix row vs the core fold`, r.coverage.metric, core.metric);
      same(`${id}: the evidence word in the journey vs the matrix`, viaJourney.e2e, r.e2e);
      same(`${id}: the chip in the journey vs the matrix`, viaJourney.chip, r.coverage.chip);
      // the whole fold, not just the sentence's inputs
      assert.deepStrictEqual(viaJourney, core, `/api/journey?entry=${id}: coverage differs from journeySummary()'s`);
    }
  });
});
