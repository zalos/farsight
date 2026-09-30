// Tests in the graph — docs/proposals/tests-surface.md Pass 1 acceptance, against the
// real examples/invoice-app fixture (test/ + e2e/ + coverage/ + farsight.config.json).
// Runs against the built packages: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ingestRepo, isTestFile, runnerOf, levelOf, classifyCall, readReport, findReports, repoContentDigest, eachTitleToRegExp, eachTitleMatches, foldRuns, importReports, changedByOf, DEFAULT_TEST_GLOBS } from '../dist/index.js';
import type { GraphNode, GraphEdge } from '@farsight/core';

const invoiceApp = resolve(import.meta.dirname, '../../../examples/invoice-app');

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-tests-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const coversOf = (edges: GraphEdge[], fromId: string) => edges.filter((e) => e.kind === 'covers' && e.from === fromId);

test('claiming: globs and runner imports decide what is a test file; defaults do not claim ordinary source', () => {
  assert.ok(DEFAULT_TEST_GLOBS.length > 5);
  assert.equal(isTestFile('src/lib/wizard-state.spec.ts'), true);
  assert.equal(isTestFile('e2e/tests/api/my-invoices.pw.spec.ts'), true);
  assert.equal(isTestFile('test/invoiceService.test.ts'), true);
  assert.equal(isTestFile('src/__tests__/helper.ts'), true);
  assert.equal(isTestFile('src/server/invoiceService.ts'), false);
  // a runner import claims a file whatever it is called
  assert.equal(isTestFile('src/server/checks.ts', "import { test } from 'node:test';\n"), true);
  assert.equal(isTestFile('src/server/checks.ts', "import { db } from './db';\n"), false);
  // config excludes un-claim what the defaults took
  assert.equal(isTestFile('test/fixtures/data.ts', '', { exclude: ['test/fixtures/**'] }), false);
  assert.equal(runnerOf('e2e/a.pw.spec.ts', "import { test } from '@playwright/test';"), 'playwright');
  assert.equal(levelOf('e2e/a.pw.spec.ts', 'playwright'), 'e2e');
  assert.equal(levelOf('src/a.integration.spec.ts', 'vitest'), 'integration');
  assert.equal(levelOf('src/a.spec.ts', 'vitest'), 'unit');
  assert.deepEqual(classifyCall(['test', 'describe']), { kind: 'suite', mods: [] });
  assert.deepEqual(classifyCall(['it', 'skip']), { kind: 'case', mods: ['skip'] });
  assert.equal(classifyCall(['test', 'beforeEach']).kind, null);
  assert.equal(classifyCall(['expect']).kind, null);
});

test('invoice-app ingest: test nodes with suite paths, and no function nodes from spec files', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const tests = f.nodes.filter((n: GraphNode) => n.kind === 'test');
  // 10 cases (3 unit + 3 in test/rates.spec.ts — an `it.each`, an `it.skip`, an `it.todo` —
  // + 2 e2e in billing + 2 in new-invoice) + the synthetic run-level node for the istanbul report
  assert.equal(tests.filter((n: GraphNode) => !n.test!.runLevel).length, 10);
  assert.equal(tests.filter((n: GraphNode) => n.test!.runLevel).length, 1);

  // Pass 1 acceptance: claimed spec files stop producing function nodes
  const strays = f.nodes.filter((n: GraphNode) => n.kind !== 'test' && /^(test|e2e)\//.test(n.loc?.path ?? ''));
  assert.deepEqual(strays.map((n: GraphNode) => n.id), []);

  const e2e = tests.find((n: GraphNode) => n.name.startsWith('the invoice list'))!;
  assert.equal(e2e.test!.level, 'e2e');
  assert.equal(e2e.test!.runner, 'playwright');
  assert.deepEqual(e2e.test!.suite, ['billing']);
  assert.equal(e2e.group, 'e2e/billing.pw.spec.ts');
  assert.ok(e2e.tags.includes('test') && e2e.tags.includes('test:e2e') && e2e.tags.includes('runner:playwright'));
  assert.ok(e2e.loc!.line > 0 && e2e.loc!.endLine! >= e2e.loc!.line);
});

test('declared edges resolve to flow / design screen / route ids, and an unmatched claim stays visible', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const tests = f.nodes.filter((n: GraphNode) => n.kind === 'test');
  const e2e = tests.find((n: GraphNode) => n.name.startsWith('the invoice list'))!;
  const declared = coversOf(f.edges, e2e.id).filter((e) => e.meta!.evidence === 'declared');
  const targets = declared.map((e) => e.to).sort();
  assert.deepEqual(targets, ['invoice-app::flow::draft-and-send', 'invoice-app::page::/invoices']);
  for (const e of declared) {
    assert.equal(e.resolution!.technique, 'annotation-scan');
    assert.equal(e.resolution!.confidence, 'HIGH');
  }
  // the deliberately unresolvable claim is kept verbatim, not dropped
  assert.deepEqual(e2e.test!.unresolved, ['CON-99']);
  assert.ok(f.meta!.tests!.blindSpots.some((s: string) => s.includes('CON-99') && s.includes('nothing in the graph matches')));

  // a unit test declaring a flow id
  const unit = tests.find((n: GraphNode) => n.name.startsWith('createInvoice computes'))!;
  assert.ok(coversOf(f.edges, unit.id).some((e) => e.to === 'invoice-app::flow::new-invoice' && e.meta!.evidence === 'declared'));
});

test('static edges: imports the case calls are HIGH; a request literal is a MEDIUM route-literal', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const tests = f.nodes.filter((n: GraphNode) => n.kind === 'test');
  const unit = tests.find((n: GraphNode) => n.name.startsWith('updateInvoice refuses'))!;
  const statics = coversOf(f.edges, unit.id).filter((e) => e.meta!.evidence === 'static');
  assert.deepEqual(statics.map((e) => e.to), ['invoice-app::src/server/invoiceService.ts::updateInvoice']);
  assert.equal(statics[0]!.resolution!.technique, 'import-resolution');
  assert.equal(statics[0]!.resolution!.confidence, 'HIGH');

  const e2e = tests.find((n: GraphNode) => n.name.startsWith('a new invoice is created'))!;
  const literal = coversOf(f.edges, e2e.id).find((e) => e.meta!.signal === 'request')!;
  assert.equal(literal.to, 'invoice-app::route::POST /invoices');
  assert.equal(literal.resolution!.technique, 'route-literal');
  assert.equal(literal.resolution!.confidence, 'MEDIUM');
});

test('observed edges hang off a run-level node, never off a case; every covers edge carries a resolution', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const covers = f.edges.filter((e: GraphEdge) => e.kind === 'covers');
  assert.ok(covers.length > 0);
  for (const e of covers) assert.ok(e.resolution, `covers edge without a resolution: ${e.id}`);

  const observed = covers.filter((e) => e.meta!.evidence === 'observed');
  assert.ok(observed.length >= 2);
  const runNode = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.test!.runLevel)!;
  // attribution honesty: istanbul coverage is run-level, never spread across the cases
  for (const e of observed) assert.equal(e.from, runNode.id);
  assert.ok(observed.some((e) => e.to === 'invoice-app::src/server/invoiceService.ts::listInvoices' && Number(e.meta!.lines) > 0));
  // a function the report shows with zero calls produces no edge
  assert.equal(observed.some((e) => e.to.endsWith('::finalizeInvoice')), false);
  for (const e of observed) assert.equal(e.resolution!.technique, 'coverage-report');
});

test('a results report joins status + duration onto the case, and the stamped reports prove the source is unchanged', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const unit = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.name.startsWith('createInvoice computes'))!;
  assert.equal(unit.test!.run!.status, 'passed');
  assert.equal(unit.test!.run!.durationMs, 12);
  // §3-C.1: only a reporter-recorded digest proves "unchanged since the run" — the fixture's
  // three reports carry one (scripts/make-coverage.mjs stamps them), so this reads `unchanged`
  assert.equal(unit.test!.run!.freshness, 'unchanged');
  assert.equal(unit.test!.run!.stale, false);
  assert.equal(unit.test!.run!.sourceDigest, f.meta!.sourceDigest);
  const skipped = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.name.startsWith('finalizeInvoice assigns'))!;
  assert.equal(skipped.test!.run!.status, 'skipped');

  const meta = f.meta!.tests!;
  assert.equal(meta.files, 4);
  assert.equal(meta.cases, 10);
  // 3 unit rows + the `.each` template (one run for its three rows) + the skip row + the todo
  // row, plus the four e2e cases under two Playwright projects each
  assert.equal(meta.runs, 14);
  assert.ok(meta.edges.declared > 0 && meta.edges.static > 0 && meta.edges.observed > 0);
  // the three report files that were read, plus the configured e2e coverage glob that matched none
  assert.equal(meta.reports.length, 4);
  assert.deepEqual(meta.reports.map((r) => r.reason).sort(), ['no-match', 'ok', 'ok', 'ok']);
  assert.deepEqual(
    meta.reports.map((r) => `${r.path ?? r.glob}:${r.freshness}`),
    [
      'coverage/vitest-results.json:unchanged',
      'coverage/coverage-final.json:unchanged',
      'e2e/results.json:unchanged',
      'e2e/coverage/coverage-final.json:unknown',
    ],
  );
  // a configured report that is not on disk is a stated blind spot, not a failure
  assert.ok(meta.blindSpots.some((s: string) => s.includes('e2e/coverage/coverage-final.json')));
  // and nothing that was read is a blind spot any more
  assert.equal(meta.blindSpots.some((s: string) => s.includes('records no source digest')), false);
});

test('the e2e report joins one run per Playwright project: a flaky verdict keeps its retries and a skipped project is not a pass', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const list = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.name.startsWith('the invoice list'))!;
  assert.deepEqual(list.test!.runs!.map((r) => [r.project, r.status]), [['desktop-1440', 'passed'], ['mobile-390', 'flaky']]);
  // the fold is the weakest project, and it drops the project name because more than one ran it
  assert.equal(list.test!.run!.status, 'flaky');
  assert.equal(list.test!.run!.retries, 1);
  assert.equal(list.test!.run!.project, undefined);

  const created = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.name.startsWith('a new invoice is created'))!;
  assert.deepEqual(created.test!.runs!.map((r) => [r.project, r.status]), [['desktop-1440', 'passed'], ['mobile-390', 'skipped']]);
  assert.equal(created.test!.run!.status, 'skipped');
});

test('the fixture\'s parametrised case joins its expanded rows, and .skip / .todo are inactive', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const each = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.test!.file === 'test/rates.spec.ts' && n.tags.includes('test:each'))!;
  assert.equal(each.name, 'the %s rate is %d');
  assert.equal(each.test!.run!.join, 'each-template');
  assert.equal(each.test!.run!.rows, 3);
  assert.equal(each.test!.inactive, undefined);
  // the template's own body is what it reaches — the rows are one run, not three edges
  assert.deepEqual(coversOf(f.edges, each.id).map((e) => e.to), ['invoice-app::src/server/taxEngine.ts::taxRateFor']);

  const skip = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.tags.includes('test:skip'))!;
  assert.equal(skip.test!.inactive, true);
  assert.deepEqual(coversOf(f.edges, skip.id).map((e) => [e.to, e.meta!.inactive]), [['invoice-app::src/server/taxEngine.ts::taxTreatment', true]]);

  const todo = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.tags.includes('test:todo'))!;
  assert.equal(todo.test!.inactive, true);
  assert.deepEqual(coversOf(f.edges, todo.id), []);
  // the vitest header counts three cases as pending/todo and three joined, so nothing is a gap
  assert.equal(f.meta!.tests!.gaps!.some((g) => g.text.includes('skipped case(s) in its header')), false);
});

test('the fixture\'s coverage report is current: its stamp is the digest of the tree it was generated from', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const report = readReport(invoiceApp, resolve(invoiceApp, 'coverage/coverage-final.json'))!;
  assert.equal(
    report.sourceDigest, f.meta!.sourceDigest,
    'examples/invoice-app changed since its reports were generated — run `node examples/invoice-app/scripts/make-coverage.mjs`',
  );
  // the declaration lines are generated from the same parse the graph uses, so a hit
  // and its node agree exactly — no line pins to drift
  const observed = f.edges.filter((e: GraphEdge) => e.kind === 'covers' && e.meta!.evidence === 'observed');
  assert.ok(observed.length > 0);
  for (const e of observed) assert.equal(e.meta!.match, 'name+line');
});

test('a reporter-recorded digest is what proves freshness — the content digest first, the legacy sourceHash second', async () => {
  const src = "export function ping() { return 'pong'; }\n";
  const spec = "import { test } from 'node:test';\ntest('ping answers', () => { ping(); });\n";
  const dir = tempRepo({
    'src/ping.ts': src,
    'test/ping.test.ts': `import { ping } from '../src/ping';\n${spec}`,
    'farsight.config.json': JSON.stringify({ tests: { unit: { runner: 'vitest', results: 'coverage/results.json' } } }),
  });
  const write = (digest: string) => writeFileSync(join(dir, 'coverage/results.json'), JSON.stringify({
    sourceDigest: digest, startTime: 1757462400000,
    testResults: [{ name: join(dir, 'test/ping.test.ts'), assertionResults: [{ ancestorTitles: [], title: 'ping answers', fullName: 'ping answers', status: 'passed', duration: 1 }] }],
  }));
  mkdirSync(join(dir, 'coverage'), { recursive: true });

  const runOf = (f: { nodes: GraphNode[] }) => f.nodes.find((n: GraphNode) => n.kind === 'test')!.test!.run!;

  write('deadbeefdead');
  const stale = await ingestRepo(dir, { repoName: 'ping' });
  assert.equal(runOf(stale).freshness, 'changed');
  assert.equal(runOf(stale).stale, true);
  // the digest the fragment was ingested at is recorded on the tests meta too — what a stamp must equal
  assert.equal(stale.meta!.tests!.sourceDigest, stale.meta!.sourceDigest);
  assert.equal(stale.meta!.sourceDigest!.length, 12);

  // stamped with the content digest: unchanged
  write(stale.meta!.sourceDigest!);
  const byDigest = await ingestRepo(dir, { repoName: 'ping' });
  assert.equal(runOf(byDigest).freshness, 'unchanged');
  assert.equal(runOf(byDigest).stale, false);

  // stamped with the older mtime hash: still read as unchanged, so pre-digest artefacts keep working
  write(stale.meta!.sourceHash);
  const byLegacyHash = await ingestRepo(dir, { repoName: 'ping' });
  assert.equal(runOf(byLegacyHash).freshness, 'unchanged');
  assert.equal(runOf(byLegacyHash).stale, false);
});

test('contentDigest is the same across runs, moves with content, and ignores mtimes', async () => {
  const dir = tempRepo({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
  const digest = () => repoContentDigest(dir, { repoName: 'd' });
  const first = digest();
  assert.equal(first.length, 12);
  assert.equal(first, digest());

  // touching a file moves the mtime hash but not the content digest
  const then = new Date(Date.now() + 60_000);
  utimesSync(join(dir, 'src/a.ts'), then, then);
  const touched = await ingestRepo(dir, { repoName: 'd' });
  assert.equal(touched.meta!.sourceDigest, first);
  assert.notEqual(touched.meta!.sourceHash, first);

  // an actual edit moves it
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
  assert.notEqual(digest(), first);
});

test('options.tests:false is the pre-tests behaviour: spec files are ordinary source again', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app', tests: false });
  assert.equal(f.nodes.filter((n: GraphNode) => n.kind === 'test').length, 0);
  assert.equal(f.edges.filter((e: GraphEdge) => e.kind === 'covers').length, 0);
  assert.equal(f.meta!.tests, undefined);
});

test('the file header block can never swallow the rest of the file, and @covers never splits a route on its space', async () => {
  // regression: a header that sits AFTER the imports, with more doc blocks and code
  // between it and the first test, once captured the whole file as one @covers value
  const dir = tempRepo({
    'src/orders.ts': 'export function placeOrder() { return 1; }\n',
    'e2e/order.pw.spec.ts': [
      "import { test, expect } from '@playwright/test';",
      "import { placeOrder } from '../src/orders';",
      '',
      '/**',
      ' * The order journey against the mock server.',
      ' *',
      ' * @covers POST /orders',
      ' * @covers ORD-01',
      ' */',
      '',
      "const HEADERS = { 'content-type': 'application/json' };",
      '',
      '/** A helper with its own doc block. */',
      'async function signIn(request) { return request.post(\'/session\', { headers: HEADERS }); }',
      '',
      "test.describe('orders', () => {",
      "  test('places an order', async ({ request }) => { await signIn(request); placeOrder(); });",
      '});',
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'shop' });
  const t = f.nodes.find((n: GraphNode) => n.kind === 'test')!;
  // exactly the two targets as written — `POST /orders` is ONE route, not two values,
  // and nothing after the closing `*/` leaked in
  assert.deepEqual(t.test!.declares, ['POST /orders', 'ORD-01']);
  // nothing after the closing `*/` leaked in — no code, no helper, no `const HEADERS`
  assert.equal((t.test!.declares ?? []).some((d: string) => /HEADERS|[(){};=]/.test(d)), false);
  // and every unresolved value is one the author actually wrote
  assert.ok((t.test!.unresolved ?? []).every((u: string) => t.test!.declares!.includes(u)));
  // the static side still works from the same file: the imported function it calls
  assert.ok(f.edges.some((e: GraphEdge) => e.kind === 'covers' && e.to === 'shop::src/orders.ts::placeOrder' && e.meta!.evidence === 'static'));
});

test('a @covers naming one numbered step of a screen resolves to that screen and keeps which step it was about', async () => {
  const dir = tempRepo({
    'package.json': '{"name":"shop"}',
    'src/app/orders/page.tsx': 'export default function OrdersPage() { return null; }',
    'docs/design/screens.json': JSON.stringify({
      name: 'Shop',
      screens: [{
        id: 'ORD-01', name: 'Orders', route: '/orders',
        steps: [{ id: 'ORD-01.1', name: 'Pick a customer' }, { id: 'ORD-01.2', name: 'Confirm the order' }],
      }],
    }),
    'e2e/orders.pw.spec.ts': [
      '/**',
      ' * @covers ORD-01.2',
      ' */',
      "import { test } from '@playwright/test';",
      "test('confirms', async () => {});",
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'shop' });
  const t = f.nodes.find((n: GraphNode) => n.kind === 'test')!;
  assert.deepEqual(t.test!.declares, ['ORD-01.2']);
  assert.deepEqual(t.test!.unresolved ?? [], [], 'a numbered step is not an unresolved id');
  const edge = f.edges.find((e: GraphEdge) => e.kind === 'covers' && e.from === t.id)!;
  const screen = f.nodes.find((n: GraphNode) => n.design?.id === 'ORD-01')!;
  assert.equal(edge.to, screen.id, 'the claim lands on the screen the step belongs to');
  assert.equal(edge.meta!.step, 'ORD-01.2', 'and says which step it was about');
  assert.match(String(edge.resolution!.note), /step ORD-01\.2 of this screen/);
});

test('report readers: playwright json, junit xml and istanbul are sniffed from content, not filename', () => {
  const dir = tempRepo({
    'reports/pw.json': JSON.stringify({
      config: { version: '1.62' },
      stats: { startTime: '2026-09-08T20:00:00.000Z' },
      suites: [{ title: 'a.pw.spec.ts', file: 'a.pw.spec.ts', specs: [{ title: 'signs in', file: 'a.pw.spec.ts', tests: [{ projectName: 'desktop-1440', status: 'expected', results: [{ status: 'passed', duration: 900 }] }] }], suites: [] }],
    }),
    'reports/junit.xml': '<testsuites><testsuite name="s" timestamp="2026-09-08T20:00:00"><testcase classname="pack.Cls" name="does a thing" time="0.25"/><testcase classname="pack.Cls" name="fails" time="0.1"><failure/></testcase></testsuite></testsuites>',
    'reports/nonsense.json': '{"hello":"world"}',
  });
  const pw = readReport(dir, join(dir, 'reports/pw.json'))!;
  assert.equal(pw.kind, 'results');
  assert.equal(pw.cases.length, 1);
  assert.equal(pw.cases[0]!.status, 'passed');
  assert.equal(pw.cases[0]!.project, 'desktop-1440');
  assert.equal(pw.at, '2026-09-08T20:00:00.000Z');

  const junit = readReport(dir, join(dir, 'reports/junit.xml'))!;
  assert.equal(junit.cases.length, 2);
  // the case's own name, not the one inside `classname="…"`
  assert.deepEqual(junit.cases.map((c) => c.title), ['does a thing', 'fails']);
  assert.deepEqual(junit.cases[0]!.suite, ['pack', 'Cls']);
  assert.deepEqual(junit.cases.map((c) => c.status), ['passed', 'failed']);
  assert.equal(junit.cases[0]!.durationMs, 250);

  assert.equal(readReport(dir, join(dir, 'reports/nonsense.json')), null);
  assert.deepEqual(findReports(dir, 'reports/*.json').map((p) => p.split('/').pop()), ['nonsense.json', 'pw.json']);
});

test('a test that imports the emitted dist barrel is evidence for the src file that defines the symbol', async () => {
  // Farsight's own suites import ../dist/index.js so they run against the build; the graph
  // holds src/, so the import must land on src/query-ish files through the barrel
  const dir = tempRepo({
    'packages/core/src/index.ts': "export * from './query';\nexport { fmt } from './fmt';\n",
    'packages/core/src/query.ts': 'export function journey() { return 1; }\n',
    'packages/core/src/fmt.ts': 'export function fmt() { return 2; }\n',
    'packages/core/test/journey.test.ts': [
      "import { test } from 'node:test';",
      "import { journey, fmt } from '../dist/index.js';",
      "test('walks', () => { journey(); fmt(); });",
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'self' });
  const covers = f.edges.filter((e: GraphEdge) => e.kind === 'covers').map((e: GraphEdge) => e.to).sort();
  assert.deepEqual(covers, ['self::packages/core/src/fmt.ts::fmt', 'self::packages/core/src/query.ts::journey'], 'dist → src twin, then the barrel followed to the defining file');
});

test('report readers: a playwright case under two projects is two rows; flaky keeps its retries and a skipped row is kept', () => {
  // the json reporter writes one `tests[]` entry per project, so the reader never
  // has to invent projects — it carries the one the reporter named (03 §3.1)
  const dir = tempRepo({
    'reports/pw.json': JSON.stringify({
      config: { version: '1.62' },
      stats: { startTime: '2026-09-20T09:00:00.000Z' },
      suites: [{
        title: 'checkout.pw.spec.ts', file: 'checkout.pw.spec.ts', specs: [], suites: [{
          title: 'checkout', file: 'checkout.pw.spec.ts',
          specs: [
            {
              title: 'pays', file: 'checkout.pw.spec.ts', tests: [
                { projectName: 'desktop-1440', status: 'expected', results: [{ status: 'passed', duration: 900 }] },
                { projectId: 'mobile-390', status: 'flaky', results: [{ status: 'failed', duration: 800 }, { status: 'passed', duration: 700 }] },
              ],
            },
            { title: 'refunds', file: 'checkout.pw.spec.ts', tests: [{ projectName: 'desktop-1440', status: 'skipped', results: [{ status: 'skipped' }] }] },
          ],
          suites: [],
        }],
      }],
    }),
  });
  const pw = readReport(dir, join(dir, 'reports/pw.json'))!;
  assert.equal(pw.cases.length, 3);
  assert.deepEqual(pw.cases.map((c) => c.project), ['desktop-1440', 'mobile-390', 'desktop-1440']);
  assert.deepEqual(pw.cases.map((c) => c.fullName), ['checkout pays', 'checkout pays', 'checkout refunds']);
  // a retried case that ended green is `flaky`, never `passed`
  assert.deepEqual(pw.cases.map((c) => c.status), ['passed', 'flaky', 'skipped']);
  assert.equal(pw.cases[1]!.retries, 1);
  assert.equal(pw.cases[0]!.retries, undefined);
  // and the skipped row survives the read — a case that ran nowhere is a fact, not a silence
  assert.equal(pw.cases[2]!.status, 'skipped');
});

test('report readers: vitest keeps skipped rows, names a project when the reporter does, and carries the header pending count', () => {
  const dir = tempRepo({ 'src/rates.spec.ts': '' });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, 'reports/vitest.json'), JSON.stringify({
    startTime: 1757462400000,
    numPendingTests: 1,
    numTodoTests: 1,
    testResults: [{
      name: join(dir, 'src/rates.spec.ts'), projectName: 'web',
      assertionResults: [
        { ancestorTitles: ['rates'], title: 'adds tax', fullName: 'rates adds tax', status: 'passed', duration: 3 },
        { ancestorTitles: ['rates'], title: 'rounds', fullName: 'rates rounds', status: 'pending' },
      ],
    }],
  }));
  const report = readReport(dir, join(dir, 'reports/vitest.json'))!;
  assert.equal(report.cases.length, 2);
  assert.deepEqual(report.cases.map((c) => c.file), ['src/rates.spec.ts', 'src/rates.spec.ts']);
  assert.deepEqual(report.cases.map((c) => c.status), ['passed', 'skipped']);
  assert.deepEqual(report.cases.map((c) => c.project), ['web', 'web']);
  // the header's own count of what did not run — the join compares it with the rows it attached
  assert.equal(report.reportedSkipped, 2);
});

test('the .each title template becomes an anchored pattern: printf, ${…} and $name rows join, an unrelated title does not', () => {
  const re = eachTitleToRegExp('rate %s applies %d');
  const rows = ['rate standard applies 20', 'rate reduced applies 5', 'rate zero applies 0', 'rate flat applies 12', 'rate eu applies 21'];
  for (const row of rows) assert.ok(re.test(row), row);
  // anchored at both ends, so an unrelated title in the same file is never joined
  assert.equal(re.test('the rate standard applies 20'), false);
  assert.equal(re.test('shipping standard applies 20'), false);
  assert.equal(re.test('applies 20'), false);
  assert.equal(re.test('rate applies'), false);
  // a value token stands for a whole row value, so a template ending in one still
  // matches a longer tail — rows are only ever looked for in the template's own file
  assert.ok(re.test('rate standard applies 20 to the total'));

  // the other token families
  assert.ok(eachTitleMatches('adds ${a} and ${b}', 'adds 1 and 2'));
  assert.ok(eachTitleMatches('$currency converts at $rate.value', 'EUR converts at 1.09'));
  assert.ok(eachTitleMatches('case %# of %i', 'case 3 of 7'));
  // %% is a literal per cent, not a row value
  const pct = eachTitleToRegExp('100%% of %s');
  assert.ok(pct.test('100% of lines'));
  assert.equal(pct.test('100 of lines'), false);
  // a template with no tokens is its own exact name
  assert.ok(eachTitleToRegExp('plain title (v2)').test('plain title (v2)'));
  assert.equal(eachTitleToRegExp('plain title (v2)').test('plain title (v3)'), false);
});

test('.each is tagged, and .skip / .todo — including everything under a skipped describe — is inactive', async () => {
  const dir = tempRepo({
    'src/rates.ts': 'export function rate() { return 1; }\n',
    'test/rates.spec.ts': [
      "import { describe, it } from 'vitest';",
      "import { rate } from '../src/rates';",
      '',
      "describe.skip('archived', () => {",
      "  it('is not run', () => { rate(); });",
      '});',
      '',
      "describe('rates', () => {",
      "  it.each([['standard', 20], ['reduced', 5]])('rate %s applies %d', () => { rate(); });",
      "  it.skip('later', () => { rate(); });",
      "  it.todo('one day');",
      "  it('now', () => { rate(); });",
      '});',
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'rates' });
  const byName = (name: string) => f.nodes.find((n: GraphNode) => n.kind === 'test' && n.name === name)!;

  const each = byName('rate %s applies %d');
  assert.ok(each.tags.includes('test:each'));
  // the title is a shape, not a reported name — the join needs the template, so it is marked
  assert.ok(each.tags.includes('test:title-heuristic'));
  assert.equal(each.test!.inactive, undefined);

  assert.equal(byName('later').test!.inactive, true);
  assert.equal(byName('one day').test!.inactive, true);
  // a describe.skip makes its descendants inactive too, though they carry no modifier of their own
  assert.equal(byName('is not run').test!.inactive, true);
  assert.deepEqual(byName('is not run').test!.suite, ['archived']);
  assert.equal(byName('now').test!.inactive, undefined);
});

test('a case run under two projects joins one run per project, and `run` is the weakest verdict', async () => {
  const dir = tempRepo({
    'src/checkout.ts': 'export function pay() { return 1; }\n',
    'e2e/checkout.pw.spec.ts': [
      "import { test } from '@playwright/test';",
      "test.describe('checkout', () => {",
      "  test('pays', async () => {});",
      '});',
    ].join('\n'),
    'farsight.config.json': JSON.stringify({ tests: { e2e: { runner: 'playwright', results: 'e2e/results.json' } } }),
    'e2e/results.json': JSON.stringify({
      config: { version: '1.62' },
      stats: { startTime: '2026-09-20T09:00:00.000Z' },
      suites: [{
        title: 'e2e/checkout.pw.spec.ts', file: 'e2e/checkout.pw.spec.ts', specs: [], suites: [{
          title: 'checkout', file: 'e2e/checkout.pw.spec.ts',
          specs: [{
            title: 'pays', file: 'e2e/checkout.pw.spec.ts', tests: [
              { projectName: 'desktop-1440', status: 'expected', results: [{ status: 'passed', duration: 900 }] },
              { projectName: 'mobile-390', status: 'unexpected', results: [{ status: 'failed', duration: 1200 }] },
            ],
          }],
          suites: [],
        }],
      }],
    }),
  });
  const f = await ingestRepo(dir, { repoName: 'shop' });
  const node = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.name === 'pays')!;
  const runs = node.test!.runs!;
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.project), ['desktop-1440', 'mobile-390']);
  assert.deepEqual(runs.map((r) => r.status), ['passed', 'failed']);
  for (const r of runs) assert.equal(r.join, 'exact');
  // the fold a consumer reading `run` alone gets: never greener than the worst project,
  // and with no project, because more than one ran it
  assert.equal(node.test!.run!.status, 'failed');
  assert.equal(node.test!.run!.project, undefined);
  assert.equal(node.test!.run!.at, '2026-09-20T09:00:00.000Z');
  // both rows are counted as joined runs, on the meta and on the report entry itself
  assert.equal(f.meta!.tests!.runs, 2);
  const entry = f.meta!.tests!.reports.find((r) => r.path === 'e2e/results.json')!;
  assert.equal(entry.joined, 2);
  assert.equal(entry.matched, 1);
  assert.equal(entry.reason, 'no-digest');
  assert.equal(entry.eachJoined, 0);
});

test('foldRuns: the weakest status wins, the latest timestamp is kept, and one project stays named', () => {
  const base = { id: 'r', freshness: 'unknown' as const, stale: false };
  const one = foldRuns([{ ...base, at: '2026-09-01T00:00:00.000Z', status: 'passed', project: 'desktop' }])!;
  assert.equal(one.status, 'passed');
  assert.equal(one.project, 'desktop');
  const many = foldRuns([
    { ...base, at: '2026-09-01T00:00:00.000Z', status: 'flaky', project: 'desktop', retries: 1 },
    { ...base, at: '2026-09-02T00:00:00.000Z', status: 'passed', project: 'mobile' },
  ])!;
  // flaky is weaker than passed and is never folded away into it
  assert.equal(many.status, 'flaky');
  assert.equal(many.at, '2026-09-02T00:00:00.000Z');
  assert.equal(many.project, undefined);
  assert.equal(foldRuns([]), undefined);
});

test('.each: five expanded rows join the one template node as a single run, and an unclaimed row joins nothing', async () => {
  const dir = tempRepo({
    'src/rates.ts': 'export function rate(kind: string) { return kind.length; }\n',
    'test/rates.spec.ts': [
      "import { describe, it } from 'vitest';",
      "import { rate } from '../src/rates';",
      '',
      "describe('rates', () => {",
      "  it.each([['standard', 20], ['reduced', 5], ['zero', 0], ['flat', 12], ['eu', 21]])('rate %s applies %d', (kind) => { rate(kind); });",
      '});',
    ].join('\n'),
    'farsight.config.json': JSON.stringify({ tests: { unit: { runner: 'vitest', results: 'coverage/results.json' } } }),
  });
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  const row = (title: string, status: string, duration: number) => ({
    ancestorTitles: ['rates'], title, fullName: `rates ${title}`, status, duration,
  });
  writeFileSync(join(dir, 'coverage/results.json'), JSON.stringify({
    startTime: 1757462400000,
    testResults: [{
      name: join(dir, 'test/rates.spec.ts'),
      assertionResults: [
        row('rate standard applies 20', 'passed', 1),
        row('rate reduced applies 5', 'passed', 2),
        row('rate zero applies 0', 'failed', 3),
        row('rate flat applies 12', 'passed', 4),
        row('rate eu applies 21', 'passed', 5),
        // a row from a case this file no longer has: joined to nothing, never guessed onto the template
        row('totals add up', 'passed', 6),
      ],
    }],
  }));

  const f = await ingestRepo(dir, { repoName: 'rates' });
  const each = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.name === 'rate %s applies %d')!;
  const runs = each.test!.runs!;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.join, 'each-template');
  assert.equal(runs[0]!.rows, 5);
  // the template is only as green as its worst row
  assert.equal(each.test!.run!.status, 'failed');
  assert.equal(each.test!.run!.durationMs, 15);
  // one template, one run — and the unmatched row attached to nothing
  assert.equal(f.meta!.tests!.runs, 1);
  assert.equal(f.nodes.filter((n: GraphNode) => n.kind === 'test' && n.test!.run).length, 1);
  // six rows in, five of them one template's, one that claimed nothing — counted, not dropped
  const entry = f.meta!.tests!.reports.find((r) => r.kind === 'results')!;
  assert.equal(entry.rows, 6);
  assert.equal(entry.joined, 1, 'five rows of one template are one run');
  assert.equal(entry.unjoined, 1);
});

// ── A2.4: named report gaps, the per-project join, inactive edges, idempotent import ──

const istanbulReport = (file: string, fns: { name: string; line: number; endLine?: number }[], digest?: string) => JSON.stringify({
  ...(digest ? { sourceDigest: digest } : {}),
  [file]: {
    path: file,
    fnMap: Object.fromEntries(fns.map((fn, i) => [String(i), {
      name: fn.name,
      decl: { start: { line: fn.line }, end: { line: fn.line } },
      loc: { start: { line: fn.line }, end: { line: fn.endLine ?? fn.line } },
    }])),
    f: Object.fromEntries(fns.map((_, i) => [String(i), 2])),
    statementMap: Object.fromEntries(fns.map((fn, i) => [String(i), { start: { line: fn.line } }])),
    s: Object.fromEntries(fns.map((_, i) => [String(i), 2])),
  },
});

const vitestReport = (file: string, rows: { title: string; status: string; duration?: number; suite?: string[] }[]) => JSON.stringify({
  startTime: 1757462400000,
  testResults: [{
    name: file,
    assertionResults: rows.map((r) => ({
      ancestorTitles: r.suite ?? [], title: r.title, fullName: [...(r.suite ?? []), r.title].join(' '),
      status: r.status, ...(r.duration != null ? { duration: r.duration } : {}),
    })),
  }],
});

test('a configured glob that matched nothing is its own report entry and the first named gap', async () => {
  // the invoice-app fixture configures an e2e *coverage* report that is deliberately absent
  // (Playwright emits none here): the missing-artefact fixture, now that e2e/results.json exists
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const meta = f.meta!.tests!;
  const missing = meta.reports.find((r) => r.reason === 'no-match')!;
  assert.equal(missing.glob, 'e2e/coverage/coverage-final.json');
  assert.equal(missing.matched, 0);
  assert.equal(missing.level, 'e2e');
  assert.equal(missing.kind, 'coverage');
  assert.equal(missing.path, undefined, 'a glob that matched no file names no path');

  // gaps are ordered: what is missing comes before what was read but proves nothing
  const gaps = meta.gaps!;
  assert.equal(gaps[0]!.kind, 'missing-artefact');
  assert.equal(gaps[0]!.glob, 'e2e/coverage/coverage-final.json');
  assert.equal(gaps[0]!.text, '`e2e/coverage/coverage-final.json` matched 0 files under invoice-app — no e2e coverage report; declared and static evidence only');
  assert.deepEqual(gaps.map((g) => g.kind), ['missing-artefact', 'unresolved-claim']);
  // every sentence in blindSpots comes from a gap — nothing is written twice
  assert.ok(meta.blindSpots.includes(gaps[0]!.text));
});

test('blind spots fold: three reports of the same kind and level become one sentence with ×n and the first three paths', async () => {
  const dir = tempRepo({
    'src/rates.ts': 'export function rate(kind: string) { return kind.length; }\n',
    'test/rates.spec.ts': [
      "import { describe, it } from 'vitest';",
      "import { rate } from '../src/rates';",
      "describe('rates', () => { it('adds tax', () => { rate('standard'); }); });",
    ].join('\n'),
    'farsight.config.json': JSON.stringify({ tests: { unit: { runner: 'vitest', results: 'reports/*.json' } } }),
  });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  for (const name of ['a', 'b', 'c']) {
    writeFileSync(join(dir, `reports/${name}.json`), vitestReport(join(dir, 'test/rates.spec.ts'), [{ title: 'adds tax', status: 'passed', duration: 1, suite: ['rates'] }]));
  }
  const f = await ingestRepo(dir, { repoName: 'rates' });
  const meta = f.meta!.tests!;
  assert.equal(meta.reports.length, 3);
  const digestGaps = meta.gaps!.filter((g) => g.kind === 'no-digest');
  assert.equal(digestGaps.length, 3, 'every report keeps its own gap in the structured list');
  const folded = meta.blindSpots.filter((s) => s.includes('records no source digest'));
  assert.equal(folded.length, 1, 'three gaps of the same kind and level are one sentence');
  assert.ok(folded[0]!.includes('×3'));
  for (const name of ['a', 'b', 'c']) assert.ok(folded[0]!.includes(`\`reports/${name}.json\``), name);
});

test('a jsdom component test reaches the component it renders, and the JSX tag is what names it', async () => {
  const dir = tempRepo({
    'src/ui/InvoiceRow.tsx': "export function InvoiceRow({ id }: { id: string }) { return <tr>{id}</tr>; }\n",
    'src/ui/Total.tsx': "export function Total({ n }: { n: number }) { return <b>{n}</b>; }\n",
    'test/InvoiceRow.test.tsx': [
      "import { describe, it, expect } from 'vitest';",
      "import { render, screen } from '@testing-library/react';",
      "import { InvoiceRow } from '../src/ui/InvoiceRow';",
      "import { Total } from '../src/ui/Total';",
      '',
      "describe('InvoiceRow', () => {",
      "  it('prints the invoice id', () => {",
      '    render(<InvoiceRow id="inv-1" />);',
      "    expect(screen.getByText('inv-1')).toBeTruthy();",
      '  });',
      '});',
      '',
      '// Total is imported but never rendered or called — an unused import is not evidence',
      'void Total;',
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'ui' });
  const test = f.nodes.find((n: GraphNode) => n.kind === 'test')!;
  const rendered = coversOf(f.edges, test.id).filter((e) => e.meta!.signal === 'render');
  assert.deepEqual(rendered.map((e) => e.to), ['ui::src/ui/InvoiceRow.tsx::InvoiceRow']);
  assert.equal(rendered[0]!.resolution!.technique, 'import-resolution');
  assert.equal(rendered[0]!.resolution!.confidence, 'HIGH');
  assert.equal(rendered[0]!.resolution!.note, 'rendered by the test');
});

test('a JUnit row that names no file joins only a unique full name; an ambiguous one is a named gap', async () => {
  const spec = (title: string) => [
    "import { describe, it } from 'vitest';",
    "import { addItem } from '../src/cart';",
    `describe('cart', () => { it('${title}', () => { addItem(); }); });`,
  ].join('\n');
  const dir = tempRepo({
    'src/cart.ts': 'export function addItem() { return 1; }\n',
    // the same full name in two spec files — the row has no file to choose with
    'test/cart-web.spec.ts': spec('adds an item'),
    'test/cart-api.spec.ts': `${spec('adds an item')}\n`,
    'test/checkout.spec.ts': [
      "import { describe, it } from 'vitest';",
      "import { addItem } from '../src/cart';",
      "describe('cart', () => { it('pays once', () => { addItem(); }); });",
    ].join('\n'),
    'farsight.config.json': JSON.stringify({ tests: { unit: { runner: 'junit', results: 'reports/junit.xml' } } }),
    'reports/junit.xml': [
      '<testsuites><testsuite name="cart" timestamp="2026-09-20T09:00:00">',
      '<testcase classname="cart" name="adds an item" time="0.25"/>',
      '<testcase classname="cart" name="pays once" time="0.10"/>',
      '</testsuite></testsuites>',
    ].join(''),
  });
  const f = await ingestRepo(dir, { repoName: 'shop' });
  const ambiguous = f.nodes.filter((n: GraphNode) => n.kind === 'test' && n.name === 'adds an item');
  assert.equal(ambiguous.length, 2);
  for (const n of ambiguous) assert.equal(n.test!.run, undefined, 'never attached to every hit');
  // the unique name still joins — the rule narrows, it does not switch the join off
  const unique = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.name === 'pays once')!;
  assert.equal(unique.test!.run!.status, 'passed');
  assert.equal(f.meta!.tests!.runs, 1);

  const gap = f.meta!.tests!.gaps!.find((g) => g.text.includes('without a file'))!;
  assert.equal(gap.kind, 'unreadable');
  assert.equal(gap.level, 'unit');
  assert.ok(gap.text.startsWith('`reports/junit.xml`: 1 row(s) without a file could not be joined'));
  assert.ok(f.meta!.tests!.blindSpots.some((s: string) => s.includes('1 row(s) without a file could not be joined')));
});

test('a .skip / .todo case still says what it would reach, and every static edge it emits is marked inactive', async () => {
  const dir = tempRepo({
    'src/rates.ts': 'export function rate() { return 1; }\n',
    'test/rates.spec.ts': [
      "import { describe, it } from 'vitest';",
      "import { rate } from '../src/rates';",
      "describe('rates', () => {",
      "  it.skip('later', () => { rate(); });",
      "  it('now', () => { rate(); });",
      '});',
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'rates' });
  const byName = (name: string) => f.nodes.find((n: GraphNode) => n.kind === 'test' && n.name === name)!;
  const skipped = coversOf(f.edges, byName('later').id);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.to, 'rates::src/rates.ts::rate');
  assert.equal(skipped[0]!.meta!.inactive, true, 'the edge says the case ran nowhere');
  const active = coversOf(f.edges, byName('now').id);
  assert.equal(active.length, 1);
  assert.equal(active[0]!.meta!.inactive, undefined);
});

test('observed edges record how they matched: name+line, name, or line ±1 — and freshness alone never raises confidence', async () => {
  const src = [
    'export function alpha() { return 1; }',
    '',
    'export function beta() { return 2; }',
    '',
    '',
    '',
    '',
    '',
    'export function gamma() { return 3; }',
  ].join('\n');
  const dir = tempRepo({
    'src/math.ts': `${src}\n`,
    'test/math.spec.ts': [
      "import { describe, it } from 'vitest';",
      "import { alpha } from '../src/math';",
      "describe('math', () => { it('adds', () => { alpha(); }); });",
    ].join('\n'),
    'farsight.config.json': JSON.stringify({ tests: { unit: { runner: 'vitest', coverage: 'coverage/coverage-final.json' } } }),
  });
  const hits = [
    { name: 'alpha', line: 1 },              // name and line agree
    { name: 'beta', line: 402 },             // the name is there, the line moved
    { name: 'renamedGamma', line: 10 },      // neither name matches; gamma sits at 9
  ];
  const write = (digest?: string) => writeFileSync(join(dir, 'coverage/coverage-final.json'), istanbulReport(join(dir, 'src/math.ts'), hits, digest));
  mkdirSync(join(dir, 'coverage'), { recursive: true });

  write();
  const unknown = await ingestRepo(dir, { repoName: 'math' });
  const edgeTo = (f: { edges: GraphEdge[] }, name: string) => f.edges.find((e: GraphEdge) => e.kind === 'covers' && e.meta!.evidence === 'observed' && e.to.endsWith(`::${name}`))!;
  // without a digest even a perfect match is MEDIUM — the code may have moved since
  assert.equal(edgeTo(unknown, 'alpha').meta!.match, 'name+line');
  assert.equal(edgeTo(unknown, 'alpha').resolution!.confidence, 'MEDIUM');

  write(unknown.meta!.sourceDigest!);
  const fresh = await ingestRepo(dir, { repoName: 'math' });
  assert.equal(fresh.nodes.find((n: GraphNode) => n.id === 'math::src/math.ts::gamma')!.loc!.line, 9);
  assert.equal(edgeTo(fresh, 'alpha').resolution!.confidence, 'HIGH');
  assert.equal(edgeTo(fresh, 'beta').meta!.match, 'name');
  assert.equal(edgeTo(fresh, 'beta').resolution!.confidence, 'MEDIUM', 'a drifted line is never HIGH, however fresh the run');
  const byLine = edgeTo(fresh, 'gamma');
  assert.equal(byLine.meta!.match, 'line±1');
  assert.equal(byLine.resolution!.confidence, 'LOW');
  assert.equal(byLine.resolution!.note, 'matched by line ±1 — the name differs');
});

test('importing the same reports twice is idempotent: identical nodes, edges and counts', async () => {
  const testsConfig = { unit: { runner: 'vitest', results: 'coverage/results.json', coverage: 'coverage/coverage-final.json' } };
  const dir = tempRepo({
    'src/rates.ts': 'export function rate(kind: string) { return kind.length; }\n',
    'test/rates.spec.ts': [
      "import { describe, it } from 'vitest';",
      "import { rate } from '../src/rates';",
      "describe('rates', () => { it('adds tax', () => { rate('standard'); }); });",
    ].join('\n'),
    'farsight.config.json': JSON.stringify({ tests: testsConfig }),
  });
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  writeFileSync(join(dir, 'coverage/results.json'), vitestReport(join(dir, 'test/rates.spec.ts'), [{ title: 'adds tax', status: 'passed', duration: 7, suite: ['rates'] }]));
  writeFileSync(join(dir, 'coverage/coverage-final.json'), istanbulReport(join(dir, 'src/rates.ts'), [{ name: 'rate', line: 1 }]));

  const f = await ingestRepo(dir, { repoName: 'rates' });
  const shape = () => ({
    nodes: f.nodes.length,
    edges: f.edges.length,
    observed: f.edges.filter((e: GraphEdge) => e.kind === 'covers' && e.meta!.evidence === 'observed').length,
    runNodes: f.nodes.filter((n: GraphNode) => n.kind === 'test' && n.test!.runLevel).length,
    runs: f.nodes.filter((n: GraphNode) => n.kind === 'test' && n.test!.runs?.length).flatMap((n: GraphNode) => n.test!.runs!).length,
  });
  const ingested = shape();
  assert.ok(ingested.observed > 0 && ingested.runNodes === 1 && ingested.runs === 1);

  const first = importReports(f, dir, testsConfig);
  const afterFirst = shape();
  const second = importReports(f, dir, testsConfig);
  const afterSecond = shape();

  assert.deepEqual(afterFirst, ingested, 'a re-import replaces what the same reports wrote; it never adds to it');
  assert.deepEqual(afterSecond, afterFirst);
  assert.deepEqual(
    { edges: second.edges, runs: second.runs, reports: second.reports.length, gaps: second.gaps.length },
    { edges: first.edges, runs: first.runs, reports: first.reports.length, gaps: first.gaps.length },
  );
  // the join counts a consumer prints come back on the report entries themselves
  const results = second.reports.find((r) => r.kind === 'results')!;
  assert.equal(results.joined, 1);
  assert.equal(second.reports.find((r) => r.kind === 'coverage')!.edges, first.edges);
});

test('an istanbul report records every file it looked at, hit or not — that is what the exactness rule reads', () => {
  const dir = tempRepo({
    'coverage/coverage-final.json': JSON.stringify({
      'src/a.ts': {
        statementMap: { '0': { start: { line: 2 } } }, s: { '0': 3 },
        fnMap: { '0': { name: 'alpha', decl: { start: { line: 1 } }, loc: { start: { line: 1 }, end: { line: 4 } } } }, f: { '0': 1 },
      },
      // measured and never entered: it still proves the report looked
      'src/b.ts': {
        statementMap: { '0': { start: { line: 1 } } }, s: { '0': 0 },
        fnMap: { '0': { name: 'beta', decl: { start: { line: 1 } }, loc: { start: { line: 1 }, end: { line: 2 } } } }, f: { '0': 0 },
      },
      // the stamp block is not a file
      farsight: { sourceDigest: 'deadbeef', stampedAt: '2026-09-21T00:00:00.000Z' },
    }),
  });
  const report = readReport(dir, join(dir, 'coverage/coverage-final.json'))!;
  assert.equal(report.kind, 'coverage');
  assert.deepEqual(report.files, ['src/a.ts', 'src/b.ts'], 'both files, and never the farsight stamp block');
  assert.deepEqual(report.hits.map((h) => h.name), ['alpha'], 'only what actually ran is a hit');
  assert.equal(report.sourceDigest, 'deadbeef');
});

test('the run-level node carries the report’s file set', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const runNode = f.nodes.find((n: GraphNode) => n.kind === 'test' && n.test!.runLevel)!;
  assert.ok(runNode.test!.files!.length > 0, 'the run says which files it measured');
  assert.ok(runNode.test!.files!.every((p: string) => !p.startsWith('/') && !p.startsWith('..')), 'repo-relative');
  assert.ok(runNode.test!.files!.includes('src/server/invoiceService.ts'));
});

// ── B3.1: a report row that reached no test node is a number, not a silence ──

test('a results report records the rows it carried and the rows that reached no test', async () => {
  const dir = tempRepo({
    'src/total.ts': 'export function total(n: number) { return n * 2; }\n',
    'test/total.spec.ts': [
      "import { describe, it } from 'vitest';",
      "import { total } from '../src/total';",
      '',
      "describe('total', () => {",
      "  it('doubles', () => { total(2); });",
      "  it('handles zero', () => { total(0); });",
      '});',
    ].join('\n'),
    'farsight.config.json': JSON.stringify({ tests: { unit: { runner: 'vitest', results: 'coverage/results.json' } } }),
  });
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  const row = (title: string) => ({ ancestorTitles: ['total'], title, fullName: `total ${title}`, status: 'passed', duration: 1 });
  writeFileSync(join(dir, 'coverage/results.json'), JSON.stringify({
    startTime: 1757462400000,
    testResults: [{
      name: join(dir, 'test/total.spec.ts'),
      assertionResults: [
        row('doubles'),
        row('handles zero'),
        // the run saw a case this checkout no longer has: it joins nothing, and the
        // count says so — `rows - joined` could not, because one row may join several
        // nodes and the rows of an `.each` template fold into a single run
        row('rounds up'),
      ],
    }],
  }));

  const f = await ingestRepo(dir, { repoName: 'total' });
  const entry = f.meta!.tests!.reports.find((r) => r.kind === 'results')!;
  assert.equal(entry.rows, 3, 'the report carried three rows');
  assert.equal(entry.joined, 2);
  assert.equal(entry.unjoined, 1, 'the row nothing claimed is counted, never dropped in silence');
  // and it is not turned into evidence anywhere: only the two real cases carry a run
  assert.equal(f.nodes.filter((n: GraphNode) => n.kind === 'test' && n.test!.run).length, 2);
});

test('a changed report: the stamp\'s commit, or HEAD\'s commit time, says whether a commit moved or only the working tree', () => {
  const dir = tempRepo({
    'reports/pw.json': JSON.stringify({
      config: { version: '1.62' },
      stats: { startTime: '2026-09-22T06:27:10.000Z' },
      suites: [],
      farsight: { sourceDigest: 'aaa111', stampedAt: '2026-09-22T06:27:10.000Z', repo: 'r', commit: 'c0ffee' },
    }),
  });
  const pw = readReport(dir, join(dir, 'reports/pw.json'))!;
  assert.equal(pw.sourceDigest, 'aaa111');
  assert.equal(pw.sourceCommit, 'c0ffee');
  // the stamp recorded a commit: it decides
  assert.equal(changedByOf(pw, { sha: 'c0ffee', at: '2026-09-30T00:00:00Z' }), 'working-tree');
  assert.equal(changedByOf(pw, { sha: 'beef00', at: '2026-09-01T00:00:00Z' }), 'commit');
  // no commit in the stamp: a HEAD committed before the run was already checked out when it ran
  const old = { ...pw, sourceCommit: undefined };
  assert.equal(changedByOf(old, { sha: 'beef00', at: '2026-09-20T18:00:00+02:00' }), 'working-tree');
  assert.equal(changedByOf(old, { sha: 'beef00', at: '2026-09-25T00:00:00Z' }), 'commit');
  // git could not be asked: nothing is claimed
  assert.equal(changedByOf(old, undefined), undefined);
  assert.equal(changedByOf(old, { sha: 'beef00' }), undefined);
});
