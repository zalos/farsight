// Where a transaction starts and stops — swarm 2026-09-23, blocker 8.
//
// The parser stamps `meta.tx` on a call written inside a transaction callback
// (`withOps` · `withTenant` · `withTx` · `transaction` · `$transaction`) and
// `journey()` carries it onto the step. Until this fold, **no surface drew it**:
// the one action in the reference app whose own source says the outbox rows are enqueued
// *after* the transaction ("DEVIATION (documented in the increment-3 brief)",
// `submissions.ts:1103`) was drawn as one flat list under a title quoting the
// spec's "the ADR 0006 single transaction".
//
// The fixture is that action's shape: a run written inside the callback, two
// calls written after it, a second flagged run after those, and a hook
// registered inside the transaction that runs later.
//
// In-memory fixtures (core has no parser dependency). Runs against the built
// package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, journey, journeySummary, journeyTransactions, screensFor } from '../dist/index.js';
import type { GraphNode, GraphEdge, SegmentMarker } from '../dist/index.js';

const R = 'app';
const F = 'submissions.ts';
const node = (id: string, kind: GraphNode['kind'], name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, name, tags: [], ...extra }) as GraphNode;
const fn = (name: string, line: number, path = F): GraphNode =>
  node(`${R}::${path}::${name}`, 'function', name, { loc: { repo: R, path, line } });
const id = (name: string, path = F) => `${R}::${path}::${name}`;
/** a call written at `line`; `tx` = written inside a transaction callback, as the parser stamps it */
const call = (from: string, to: string, line: number, meta: Record<string, unknown> = {}): GraphEdge =>
  ({ id: `calls|${from}|${to}|${line}`, kind: 'calls', from, to, meta: { line, ...meta } }) as GraphEdge;
const writes = (from: string, to: string, line: number, meta: Record<string, unknown> = {}): GraphEdge =>
  ({ id: `writes|${from}|${to}|${line}`, kind: 'writes', from, to, meta: { line, ...meta } }) as GraphEdge;

const ROUTE = `${R}::route::POST /submit`;
const SUBMIT = id('submitDraftInvoice');

/**
 * The reference app's submit, in miniature. `submitDraftInvoice` opens a transaction and
 * writes the domain rows inside it; the outbox row and the drain are written
 * after it (the documented deviation); a second transaction then writes the
 * sync status and sends the notification. A hook registered inside the first
 * transaction runs later, on its own.
 */
function submitAction(opts: { tx: boolean } = { tx: true }): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const TX = opts.tx ? { tx: true } : {};
  const nodes: GraphNode[] = [
    node(ROUTE, 'route', 'POST /submit', { loc: { repo: R, path: 'routes.ts', line: 3 } }),
    fn('submitDraftInvoice', 952),
    fn('loadDraft', 400), fn('replaceLines', 20, 'pg.ts'), fn('auditEvent', 10, 'audit.ts'),
    fn('enqueue', 41, 'outbox.ts'), fn('drainSubmission', 1174),
    fn('setBcSync', 60, 'pg.ts'), fn('send', 80, 'notifier.ts'),
    fn('invoiceCreated', 173, 'worker.ts'),
    node(`${R}::table::invoices`, 'table', 'invoices', { loc: { repo: R, path: 'schema.sql', line: 2 } }),
    node(`${R}::table::bc_outbox`, 'table', 'bc_outbox', { loc: { repo: R, path: 'schema.sql', line: 40 } }),
  ];
  const edges: GraphEdge[] = [
    call(ROUTE, SUBMIT, 3),
    // written inside the transaction callback (lines 958–1074 of the real file)
    call(SUBMIT, id('loadDraft'), 958, TX),
    call(SUBMIT, id('replaceLines', 'pg.ts'), 1000, TX),
    call(SUBMIT, id('auditEvent', 'audit.ts'), 1074, TX),
    // registered inside it, runs afterwards on its own — never a side
    call(SUBMIT, id('invoiceCreated', 'worker.ts'), 1080, { ...TX, deferred: true }),
    // the documented deviation: written after the transaction closed
    call(SUBMIT, id('enqueue', 'outbox.ts'), 1109),
    call(SUBMIT, id('drainSubmission'), 1112),
    // a second transaction — a different one, which the flag cannot say
    call(SUBMIT, id('setBcSync', 'pg.ts'), 1121, TX),
    call(SUBMIT, id('send', 'notifier.ts'), 1127, TX),
    // what the parts touch: the table is reached from inside, the outbox from after
    writes(id('replaceLines', 'pg.ts'), `${R}::table::invoices`, 22),
    writes(id('enqueue', 'outbox.ts'), `${R}::table::bc_outbox`, 44),
  ];
  return { nodes, edges };
}

const walk = (opts: { tx: boolean } = { tx: true }) => {
  const { nodes, edges } = submitAction(opts);
  const index = buildIndex(nodes, edges);
  const j = journey(index, ROUTE);
  return { index, j, sum: journeySummary(index, j, screensFor(index, ROUTE)) };
};
const markerOf = (sum: ReturnType<typeof journeySummary>, name: string): SegmentMarker => {
  const m = sum.segments.flatMap((sg) => sg.markers).find((x) => x.name === name);
  assert.ok(m, `no marker for ${name}`);
  return m;
};

test('the calls written inside the transaction are inside it; the deviation reads as after it', () => {
  const { index, j, sum } = walk();
  const { known, sideOf } = journeyTransactions(index, j);
  assert.equal(known, true);
  // the three written inside the callback
  for (const n of ['loadDraft', 'replaceLines', 'auditEvent']) assert.equal(markerOf(sum, n).tx, 'inside', n);
  // and the two the source's own comment places after it
  for (const n of ['enqueue', 'drainSubmission']) assert.equal(markerOf(sum, n).tx, 'after', n);
  // the fold and the marker are one decision: every side the fold found is on a marker
  const onMarkers = new Map(sum.segments.flatMap((sg) => sg.markers).map((m) => [m.stepOrder, m.tx]));
  for (const [order, side] of sideOf) assert.equal(onMarkers.get(order), side, `step ${order}`);
});

test('a later flagged run is inside a transaction again — and nothing counts them', () => {
  const { sum } = walk();
  assert.equal(markerOf(sum, 'setBcSync').tx, 'inside');
  assert.equal(markerOf(sum, 'send').tx, 'inside');
  // the flag is per call site: no fold may publish a number of transactions, because two
  // neighbouring `inside` steps can sit in different ones (here they do: two callbacks)
  assert.equal(Object.keys(sum.counts).some((k) => /tx|transaction/i.test(k)), false);
});

test('work registered inside a transaction but run later takes no side', () => {
  const { sum } = walk();
  assert.equal(markerOf(sum, 'invoiceCreated').tx, undefined);
  // and it does not break the sequence: what follows it is still read as after the transaction
  assert.equal(markerOf(sum, 'enqueue').tx, 'after');
});

test('a table reached from an inside call takes no side of its own', () => {
  const { sum } = walk();
  assert.equal(markerOf(sum, 'invoices').tx, undefined);
  assert.equal(markerOf(sum, 'bc_outbox').tx, undefined);
});

test('a graph with no transaction flag says so — it does not guess a side', () => {
  const { index, j, sum } = walk({ tx: false });
  const { known, sideOf } = journeyTransactions(index, j);
  assert.equal(known, false);
  assert.equal(sideOf.size, 0);
  assert.equal(sum.txKnown, false);
  // absent is not "everything is outside" and not "everything is inside"
  assert.equal(sum.segments.flatMap((sg) => sg.markers).some((m) => m.tx), false);
});

test('a graph that records boundaries elsewhere is known, even where this walk meets none', () => {
  const { nodes, edges } = submitAction({ tx: false });
  // one transactional call somewhere else in the same graph
  const other = fn('archive', 10, 'jobs.ts');
  const index = buildIndex([...nodes, other], [...edges, call(id('archive', 'jobs.ts'), id('replaceLines', 'pg.ts'), 12, { tx: true })]);
  const j = journey(index, ROUTE);
  const sum = journeySummary(index, j, screensFor(index, ROUTE));
  assert.equal(journeyTransactions(index, j).known, true);
  assert.equal(sum.txKnown, true);
  // known, and still no claim on this walk's own steps
  assert.equal(sum.segments.flatMap((sg) => sg.markers).some((m) => m.tx), false);
});
