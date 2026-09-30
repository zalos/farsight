// The system band of the blueprint timeline — docs/proposals/journey-system-band.md §6.1.
// Rows in request order with the repo split at the HTTP seam, both ends of every call on the
// marker, fold flags, and moments: one sub-column per client-side action.
// The built fixture is examples/invoice-app's "Invoice list" journey, rebuilt here as an
// in-memory graph (core has no parser dependency) — same 40 steps, same file:line values.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, journey, journeySummary, screensFor, humanizeName } from '../dist/index.js';
import type { GraphNode, GraphEdge, OperationContract } from '../dist/index.js';

const R = 'invoice-app';
const API = `${R}::api::openapi.yaml`;

const fn = (name: string, path: string, line: number): GraphNode =>
  ({ id: `${R}::${path}::${name}`, kind: 'function', name, tags: [], loc: { repo: R, path, line } }) as GraphNode;
const comp = (name: string, path: string, line: number): GraphNode =>
  ({ id: `${R}::${path}::${name}`, kind: 'component', name, tags: [], loc: { repo: R, path, line } }) as GraphNode;
const route = (name: string, line: number, operationId: string): GraphNode =>
  ({
    id: `${R}::route::${name}`, kind: 'route', name, tags: [], loc: { repo: R, path: 'src/server/routes.ts', line },
    contract: { status: 'both', apiId: API, summary: `${operationId} summary`, spec: { operationId } } as OperationContract,
  }) as GraphNode;
const table = (name: string): GraphNode => ({ id: `${R}::table::${name}`, kind: 'table', name, tags: [] }) as GraphNode;
const edge = (kind: GraphEdge['kind'], from: string, to: string, line?: number): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(line != null ? { meta: { line } } : {}) });

/** examples/invoice-app: the Invoice list page, its three components, the client, the five routes, the service. */
function invoiceApp(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const CLIENT = 'src/api/client.ts', SVC = 'src/server/invoiceService.ts', TAX = 'src/server/taxEngine.ts';
  const DRAWER = 'src/ui/EditInvoiceDrawer.tsx';
  const nodes: GraphNode[] = [
    { id: `${R}::page::/invoices`, kind: 'page', name: '/invoices', tags: [], loc: { repo: R, path: 'src/ui/router.tsx', line: 8 } } as GraphNode,
    { id: API, kind: 'api', name: 'Billing API', tags: [] } as GraphNode,
    comp('InvoiceListPage', 'src/ui/InvoiceListPage.tsx', 7),
    comp('CreateInvoiceForm', 'src/ui/CreateInvoiceForm.tsx', 10),
    comp('EditInvoiceDrawer', DRAWER, 9),
    fn('listInvoices', CLIENT, 4), fn('getInvoice', CLIENT, 13), fn('createInvoice', CLIENT, 18),
    fn('updateInvoice', CLIENT, 23), fn('finalizeInvoice', CLIENT, 28), fn('onSave', DRAWER, 16),
    route('GET /invoices', 8, 'listInvoices'), route('GET /invoices/:id', 12, 'getInvoice'),
    route('POST /invoices', 16, 'createInvoice'), route('PATCH /invoices/:id', 21, 'updateInvoice'),
    route('POST /invoices/:id/finalize', 26, 'finalizeInvoice'),
    fn('listInvoices', SVC, 6), fn('getInvoice', SVC, 15), fn('createInvoice', SVC, 24),
    fn('updateInvoice', SVC, 35), fn('finalizeInvoice', SVC, 58), fn('nextInvoiceNumber', SVC, 80),
    fn('computeTax', TAX, 9),
    table('invoices'), table('customers'), table('ledger_entries'),
    { id: `${R}::queue::invoice.finalized`, kind: 'queue', name: 'invoice.finalized', tags: [] } as GraphNode,
  ];
  const c = (name: string) => `${R}::${CLIENT}::${name}`, s = (name: string) => `${R}::${SVC}::${name}`;
  const rt = (name: string) => `${R}::route::${name}`, tb = (name: string) => `${R}::table::${name}`;
  const edges: GraphEdge[] = [
    edge('renders', `${R}::page::/invoices`, `${R}::src/ui/InvoiceListPage.tsx::InvoiceListPage`, 8),
    edge('calls', `${R}::src/ui/InvoiceListPage.tsx::InvoiceListPage`, c('listInvoices'), 13),
    edge('renders', `${R}::src/ui/InvoiceListPage.tsx::InvoiceListPage`, `${R}::src/ui/CreateInvoiceForm.tsx::CreateInvoiceForm`, 26),
    edge('renders', `${R}::src/ui/InvoiceListPage.tsx::InvoiceListPage`, `${R}::${DRAWER}::EditInvoiceDrawer`, 27),
    edge('calls', `${R}::src/ui/CreateInvoiceForm.tsx::CreateInvoiceForm`, c('createInvoice'), 23),
    edge('calls', `${R}::${DRAWER}::EditInvoiceDrawer`, c('getInvoice'), 13),
    edge('calls', `${R}::${DRAWER}::EditInvoiceDrawer`, c('updateInvoice'), 20),
    edge('calls', `${R}::${DRAWER}::EditInvoiceDrawer`, c('finalizeInvoice'), 27),
    edge('calls', `${R}::${DRAWER}::EditInvoiceDrawer`, `${R}::${DRAWER}::onSave`, 35),
    edge('calls', `${R}::${DRAWER}::onSave`, c('updateInvoice'), 20),
    edge('http', c('listInvoices'), rt('GET /invoices'), 5),
    edge('http', c('createInvoice'), rt('POST /invoices'), 19),
    edge('http', c('getInvoice'), rt('GET /invoices/:id'), 14),
    edge('http', c('updateInvoice'), rt('PATCH /invoices/:id'), 24),
    edge('http', c('finalizeInvoice'), rt('POST /invoices/:id/finalize'), 29),
    edge('calls', rt('GET /invoices'), s('listInvoices'), 9),
    edge('calls', rt('POST /invoices'), s('createInvoice'), 18),
    edge('calls', rt('GET /invoices/:id'), s('getInvoice'), 13),
    edge('calls', rt('PATCH /invoices/:id'), s('updateInvoice'), 23),
    edge('calls', rt('POST /invoices/:id/finalize'), s('finalizeInvoice'), 27),
    edge('reads', s('listInvoices'), tb('invoices'), 7),
    edge('calls', s('createInvoice'), `${R}::${TAX}::computeTax`, 26),
    edge('writes', s('createInvoice'), tb('invoices'), 27),
    edge('reads', `${R}::${TAX}::computeTax`, tb('customers'), 10),
    edge('reads', s('getInvoice'), tb('invoices'), 16),
    edge('reads', s('updateInvoice'), tb('invoices'), 36),
    edge('calls', s('updateInvoice'), `${R}::${TAX}::computeTax`, 42),
    edge('writes', s('updateInvoice'), tb('invoices'), 43),
    edge('reads', s('finalizeInvoice'), tb('invoices'), 59),
    edge('calls', s('finalizeInvoice'), s('nextInvoiceNumber'), 65),
    edge('writes', s('finalizeInvoice'), tb('invoices'), 66),
    edge('writes', s('finalizeInvoice'), tb('ledger_entries'), 67),
    edge('publishes', s('finalizeInvoice'), `${R}::queue::invoice.finalized`, 68),
    edge('reads', s('nextInvoiceNumber'), tb('invoices'), 81),
  ];
  return { nodes, edges };
}

const listJourney = () => {
  const { nodes, edges } = invoiceApp();
  const index = buildIndex(nodes, edges);
  const entry = `${R}::page::/invoices`;
  return { index, sum: journeySummary(index, journey(index, entry), screensFor(index, entry)) };
};

test('humanizeName: an identifier or a route reads as words', () => {
  assert.equal(humanizeName('listInvoices'), 'List invoices');
  assert.equal(humanizeName('GET /invoices/:param'), 'View invoices');
  assert.equal(humanizeName('next_invoice_number'), 'Next invoice number');
});

test('system rows come out in request order and the repo splits at the seam', () => {
  const { sum } = listJourney();
  assert.deepEqual(sum.systems.map((r) => [r.key, r.kind, r.side ?? null, r.label]), [
    [`repo:${R}:ux`, 'repo', 'ux', R],
    [`api:${API}`, 'api', null, 'Billing API'],
    [`repo:${R}:server`, 'repo', 'server', R],
    ['records', 'records', null, 'records'],
    ['messages', 'messages', null, 'messages'],
  ], 'ux → api → server → records → messages, not first-seen');
  // the same function name on both sides of the seam is no longer ambiguous: the row says which
  const byName = (name: string) => sum.segments[0]!.markers.filter((m) => m.name === name).map((m) => m.system);
  assert.deepEqual(byName('listInvoices'), [`repo:${R}:ux`, `repo:${R}:server`]);
});

test('a call marker carries both ends of the seam: the fetch line in the browser, the handler in the API', () => {
  const { sum } = listJourney();
  const call = sum.segments[0]!.markers.find((m) => m.kind === 'call')!;
  assert.equal(call.name, 'GET /invoices');
  assert.deepEqual([call.caller!.path, call.caller!.line], ['src/api/client.ts', 5], 'the fetch line, from the step call site');
  assert.equal(call.caller!.name, 'listInvoices');
  assert.deepEqual([call.handler!.path, call.handler!.line], ['src/server/routes.ts', 9], 'where the route calls into the service');
  assert.equal(call.handler!.repo, R);
  // every call on this journey is built at both ends
  const calls = sum.segments[0]!.markers.filter((m) => m.kind === 'call');
  assert.equal(calls.length, 6);
  assert.ok(calls.every((m) => m.caller && m.handler), 'a built journey has both ends of every seam');
});

test('moments: one sub-column per client-side action, the drawer spanning the four it stays open for', () => {
  const { sum } = listJourney();
  const seg = sum.segments[0]!;
  assert.equal(seg.moments.length, 6);
  // the summary the API's authors wrote for the operation now beats the humanized client
  // identifier (R6): these routes carry `<operationId> summary`, so that is the headline
  assert.deepEqual(seg.moments.map((m) => m.label),
    ['listInvoices summary', 'createInvoice summary', 'getInvoice summary', 'updateInvoice summary', 'finalizeInvoice summary', 'updateInvoice summary']);
  // the last moment runs one step longer than it used to: computeTax is past its re-visit budget and is
  // now a visible `repeat` step with a cut point, instead of vanishing from the walk
  assert.deepEqual(seg.moments.map((m) => [m.from, m.to]), [[0, 5], [6, 12], [13, 17], [18, 24], [25, 33], [34, 40]]);
  assert.deepEqual(seg.moments.map((m) => m.component?.name),
    ['InvoiceListPage', 'CreateInvoiceForm', 'EditInvoiceDrawer', 'EditInvoiceDrawer', 'EditInvoiceDrawer', 'EditInvoiceDrawer']);
  // the drawer opens in moment 2 and stays open: its step order is before the later moments start
  const drawer = seg.moments.map((m) => m.component!.stepOrder);
  assert.deepEqual(drawer, [1, 6, 13, 13, 13, 13]);
  assert.deepEqual(seg.moments.slice(3).map((m) => m.component!.stepOrder < m.from), [true, true, true], 'still open');
  // the last moment repeats a call already made
  assert.deepEqual(seg.moments.map((m) => m.repeat), [false, false, false, false, false, true]);
  // nextInvoiceNumber reads a table, so it is a step, not plumbing — nothing folds in this moment
  assert.deepEqual(seg.moments[4]!.counts, { markers: 9, calls: 1, planned: 0, records: 4, messages: 1, helpers: 0 }, 'helpers are counted per moment now');
  // markers stay flat and ordered for compatibility; each says its moment
  assert.deepEqual(seg.markers.map((m) => m.stepOrder), seg.markers.map((m) => m.stepOrder).slice().sort((a, b) => a - b));
  for (const m of seg.markers) {
    const mo = seg.moments[m.moment]!;
    assert.ok(m.stepOrder >= mo.from && m.stepOrder <= mo.to, `#${m.stepOrder} inside moment ${m.moment}`);
  }
});

test('fold flags: repeats come from the walk, and nothing that touches the outside folds', () => {
  const { sum } = listJourney();
  const seg = sum.segments[0]!;
  // every function on this journey either makes a call or touches a table, so none of them is
  // plumbing — the fold itself is exercised in journey-honest.test.ts
  assert.deepEqual(seg.markers.filter((m) => m.helper).map((m) => [m.name, m.stepOrder]), [],
    'computeTax reads customers, nextInvoiceNumber reads invoices, updateInvoice makes the PATCH');
  // every marker now hangs under its part (the drill tree): computeTax under whatever called it, with a tier that says how deep
  const computeTax = seg.markers.find((m) => m.stepOrder === 10)!;
  assert.ok(computeTax.under != null && computeTax.under < 10, 'a step hangs under the nearest non-helper marker above it');
  assert.ok(computeTax.tier != null, 'and says how deep inside its cell it sits');
  assert.equal(seg.markers.find((m) => m.stepOrder === 11)!.under, 10, 'the table computeTax read hangs off computeTax itself');
  // one more repeat marker than before: computeTax past its re-visit budget is now visible instead of dropped
  assert.equal(seg.markers.filter((m) => m.repeat).length, 15);
  assert.ok(seg.markers.find((m) => m.stepOrder === 36)!.repeat, 'the PATCH made again on save');
  // a re-visit hides nothing (its subtree was drawn earlier), so it is counted apart from cut points
  assert.equal(sum.counts.cutPoints, 0);
  assert.equal(sum.counts.repeats, 1);
  assert.equal(seg.markers.find((m) => m.stepOrder === 39)!.cut, undefined, 'a re-visit never draws "not followed"');
});

test('a route-entry journey has no browser row — the walk starts behind the seam', () => {
  const { nodes, edges } = invoiceApp();
  const index = buildIndex(nodes, edges);
  const entry = `${R}::route::GET /invoices`;
  const sum = journeySummary(index, journey(index, entry), screensFor(index, entry));
  assert.deepEqual(sum.systems.map((r) => r.key), [`api:${API}`, `repo:${R}:server`, 'records']);
  assert.ok(!sum.systems.some((r) => r.side === 'ux'));
  assert.equal(sum.segments[0]!.screen, null);
  // no call crosses the seam from a browser action, so the segment is one moment named by its entry
  assert.equal(sum.segments[0]!.moments.length, 1);
  assert.equal(sum.segments[0]!.moments[0]!.label, 'GET /invoices');
});

test('a route with no spec still lands on an API row, so every call gets a seam card', () => {
  const { nodes, edges } = invoiceApp();
  const bare = nodes.map((n) => (n.id === `${R}::route::GET /invoices` ? { ...n, contract: undefined } : n));
  const index = buildIndex(bare, edges);
  const entry = `${R}::page::/invoices`;
  const sum = journeySummary(index, journey(index, entry), screensFor(index, entry));
  const keys = sum.systems.filter((r) => r.kind === 'api').map((r) => [r.key, r.label]);
  assert.deepEqual(keys, [[`api:repo:${R}`, `${R} · routes`], [`api:${API}`, 'Billing API']]);
});

test('a planned journey: one moment per declared operation, named by the contract, with no built end', () => {
  const decl = (name: string, summary: string, operationId: string): GraphNode =>
    ({ id: `p::route::${name}`, kind: 'route', name, tags: [], contract: { status: 'spec-only', apiId: 'p::api::openapi.yaml', summary, spec: { operationId } } as OperationContract }) as GraphNode;
  const nodes: GraphNode[] = [
    { id: 'p::api::openapi.yaml', kind: 'api', name: 'Acme API', tags: [] } as GraphNode,
    {
      id: 'p::page::/submit', kind: 'page', name: '/submit', tags: [],
      design: { id: 'SUB-01', status: 'design-only', source: 'docs/design/screens.json', operations: ['createSubmission', 'submitInvoice'] },
    } as GraphNode,
    decl('POST /submissions', 'Start a draft submission.', 'createSubmission'),
    decl('POST /submissions/{id}/submit', 'Submit the invoice.', 'submitInvoice'),
  ];
  const index = buildIndex(nodes, []);
  const sum = journeySummary(index, journey(index, 'p::page::/submit'), screensFor(index, 'p::page::/submit'));
  assert.deepEqual(sum.systems.map((r) => [r.key, r.planned]), [['api:p::api::openapi.yaml', true]], 'declared, not built');
  const seg = sum.segments[0]!;
  assert.deepEqual(seg.moments.map((m) => m.label), ['Start a draft submission.', 'Submit the invoice.'], 'the design\'s operation order, labelled by the contract');
  const calls = seg.markers.filter((m) => m.kind === 'call');
  assert.deepEqual(calls.map((m) => [m.planned ?? false, !!m.caller, !!m.handler]), [[true, false, false], [true, false, false]],
    'a planned call has neither end of the seam built yet');
  assert.deepEqual(calls.map((m) => m.moment), [0, 1]);
});

// ── keeping current: the update recipe every consumer prints ──
import { currencyAdvice, installState } from '../dist/version.js';

test('currencyAdvice: everything agrees → ok, with the four steps still printed', () => {
  const b = { version: '0.1.0', built: '2026-09-06T18:40:35.106Z', commit: 'abc1234', source: 'packed' as const };
  const a = currencyAdvice({ role: 'mcp', running: b, install: { startedAt: b.built, newerInstalled: false }, graph: { farsight: b, generatedAt: b.built, sync: 3 } });
  assert.equal(a.ok, true);
  assert.equal(a.findings.length, 0);
  assert.equal(a.steps.length, 4);
  assert.match(a.steps[0]!, /farsight status/);
  assert.match(a.steps[2]!, /reconnect this MCP/);
});

test('currencyAdvice: a newer install than the running process, and a graph from another build, are both findings', () => {
  const old = { version: '0.1.0', built: '2026-09-06T03:24:18.041Z', commit: '52b3f78', source: 'packed' as const };
  const a = currencyAdvice({ role: 'server', running: old, install: { file: '/x/cli.js', installedAt: '2026-09-06T18:40:35.106Z', startedAt: '2026-09-06T03:30:00.000Z', newerInstalled: true }, graph: { farsight: { version: '0.1.0', built: '2026-09-06T18:36:47.559Z', commit: '5f5590f' } } });
  assert.equal(a.ok, false);
  assert.equal(a.findings.length, 2);
  assert.match(a.findings[0]!, /newer build is installed .* restart it/);
  assert.match(a.findings[1]!, /graph was written by .* re-ingest/);
  assert.match(a.steps[2]!, /stop the `farsight serve` process/);
});

test('currencyAdvice (cli): an unreachable server and a server on an older build are reported; a graph matching the server is not a finding', () => {
  const b = { version: '0.1.0', built: '2026-09-06T18:40:35.106Z', commit: 'abc1234', source: 'packed' as const };
  const oldS = { version: '0.1.0', built: '2026-09-06T03:24:18.041Z', commit: '52b3f78', source: 'packed' as const };
  const down = currencyAdvice({ role: 'cli', running: b, server: { port: 4477, reachable: false } });
  assert.match(down.findings[0]!, /no HUD server answered on port 4477/);
  const stale = currencyAdvice({ role: 'cli', running: b, server: { port: 4477, reachable: true, farsight: oldS }, graph: { farsight: oldS } });
  assert.equal(stale.findings.length, 1, 'the graph matches the server that wrote it — only the server is out of date');
  assert.match(stale.findings[0]!, /restart the server/);
});

test('installState: reads this process and its file without throwing; a just-built file is not "newer"', () => {
  const s = installState();
  assert.ok(s.startedAt);
  assert.ok(s.file && s.installedAt, 'a workspace build knows its dist file');
  assert.equal(typeof s.newerInstalled, 'boolean');
});
