#!/usr/bin/env node
// Golden-fixture generator for the farsight-diff v1 contract tests.
//
// Produces, next to this script:
//   invoice-base.json   examples/invoice-app ingested by the real TS/JS adapter,
//                       meta pinned to sync:39 · 76f7674 · UTC
//   invoice-head.json   the same graph after the scripted mutation below — a
//                       stand-in for a second commit — meta pinned to sync:41 · 4677268
//   expected-diff.json  diffGraphs(base, head): the frozen expected contract output
//
// The mutation (each line exists to exercise one ChangeKind):
//   1. remove the guards edge on POST /invoices/:id/finalize        → guard_removed
//   2. add route DELETE /invoices/:id                               → route_added
//   3. rename ui submit → submitDraft in place (same file:line)     → node_renamed
//   4. give table `customers` a column signature                    → record_columns_changed
//   5. remove rule updateInvoiceSchema (+ its validates edges)      → rule_removed
//   6. add queue invoice.reminder                                   → message_added
//   7. drop the calls edge finalizeInvoice → nextInvoiceNumber      → journey_changed (finalize route)
//   8. restamp an http edge HIGH → MEDIUM resolution                → edge_confidence_changed
//
// Regenerating is a contract event (see docs/contracts/farsight-diff-v1.md):
// if expected-diff.json changes, either the parser changed (update fixtures,
// say so in the commit) or the contract broke (stop).
//
// Run from the repo root AFTER `pnpm build`:
//   node packages/core/test/fixtures/make-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

const { GraphStore, digestOf, diffGraphs, loadConfig, applyConfig } = await import(
  join(repoRoot, 'packages/core/dist/index.js')
);
const { ingestRepo } = await import(join(repoRoot, 'packages/parsers/dist/index.js'));

// ── ingest the real example with the real adapter ──────────────────────────
const appDir = join(repoRoot, 'examples', 'invoice-app');
const fragment = await ingestRepo(appDir, { repoName: 'invoice-app' });
const config = loadConfig(join(appDir, 'farsight.config.json'));
if (config) applyConfig(fragment.nodes, config, fragment.edges);

// determinism: sourceHash depends on file mtimes — pin everything time-shaped
const baseMeta = { generatedAt: '2026-07-28T12:00:00.000Z', files: fragment.meta?.files ?? 0, sourceHash: 'fixture' };

const mkStore = (nodes, edges, meta) => {
  const store = new GraphStore();
  store.addFragment({ repo: 'invoice-app', nodes, edges });
  store.meta = { ...meta };
  store.meta.digest = digestOf(store);
  return store;
};

// ── base (sync:39) ──────────────────────────────────────────────────────────
const baseNodes = structuredClone(fragment.nodes);
const baseEdges = structuredClone(fragment.edges);
// (8) pre-stamp one http edge so head can change its tier
const httpEdge = baseEdges.filter((e) => e.kind === 'http').sort((a, b) => a.id.localeCompare(b.id))[0];
if (!httpEdge) throw new Error('fixture expectation broken: invoice-app has no http edge');
httpEdge.resolution = { status: 'resolved', technique: 'fetch→route', confidence: 'HIGH' };

const base = mkStore(baseNodes, baseEdges, { ...baseMeta, sync: 39, commit: '76f76740000000000000000000000000000000ba', tz: 'UTC' });

// ── head (sync:41) — the scripted mutation ──────────────────────────────────
const nodes = structuredClone(baseNodes);
const edges = structuredClone(baseEdges);
const dropEdge = (kind, from, to) => {
  const i = edges.findIndex((e) => e.kind === kind && e.from === from && e.to === to);
  if (i < 0) throw new Error(`fixture expectation broken: no edge ${kind}|${from}|${to}`);
  edges.splice(i, 1);
};
const nodeOf = (id) => {
  const n = nodes.find((n) => n.id === id);
  if (!n) throw new Error(`fixture expectation broken: no node ${id}`);
  return n;
};

// 1 · guard_removed
dropEdge('guards', 'invoice-app::guard::requireScope(billing:admin)', 'invoice-app::route::POST /invoices/:id/finalize');
// 2 · route_added
nodes.push({
  id: 'invoice-app::route::DELETE /invoices/:id',
  kind: 'route',
  name: 'DELETE /invoices/:id',
  loc: { repo: 'invoice-app', path: 'src/server/routes.ts', line: 61 },
  tags: ['http'],
});
// 3 · node_renamed (in place: same kind, same file:line, new name+id)
const submit = nodeOf('invoice-app::src/ui/CreateInvoiceForm.tsx::submit');
const renamedId = 'invoice-app::src/ui/CreateInvoiceForm.tsx::submitDraft';
submit.name = 'submitDraft';
for (const e of edges) {
  if (e.from === submit.id) e.from = renamedId;
  if (e.to === submit.id) e.to = renamedId;
  if (e.from === renamedId || e.to === renamedId) e.id = `${e.kind}|${e.from}|${e.to}`;
}
submit.id = renamedId;
// 4 · record_columns_changed
nodeOf('invoice-app::table::customers').signature = 'columns: id, name, email, vat_number';
// 5 · rule_removed
const ruleId = 'invoice-app::src/server/schemas.ts::updateInvoiceSchema';
nodeOf(ruleId); // assert it exists
nodes.splice(nodes.findIndex((n) => n.id === ruleId), 1);
for (let i = edges.length - 1; i >= 0; i--) if (edges[i].from === ruleId || edges[i].to === ruleId) edges.splice(i, 1);
// 6 · message_added
nodes.push({ id: 'invoice-app::queue::invoice.reminder', kind: 'queue', name: 'invoice.reminder', tags: [] });
// 7 · journey_changed
dropEdge('calls', 'invoice-app::src/server/invoiceService.ts::finalizeInvoice', 'invoice-app::src/server/invoiceService.ts::nextInvoiceNumber');
// 8 · edge_confidence_changed
const headHttp = edges.find((e) => e.id === httpEdge.id);
if (!headHttp) throw new Error('fixture expectation broken: stamped http edge vanished from head');
headHttp.resolution = { status: 'heuristic', technique: 'name-match', confidence: 'MEDIUM', note: 'fixture: demoted to exercise edge_confidence_changed' };

const head = mkStore(nodes, edges, { ...baseMeta, sync: 41, commit: '46772680000000000000000000000000000000ba', tz: 'UTC' });

// ── write ───────────────────────────────────────────────────────────────────
writeFileSync(join(here, 'invoice-base.json'), JSON.stringify(base.toJSON(), null, 1) + '\n');
writeFileSync(join(here, 'invoice-head.json'), JSON.stringify(head.toJSON(), null, 1) + '\n');
const diff = diffGraphs(base, head);
writeFileSync(join(here, 'expected-diff.json'), JSON.stringify(diff, null, 1) + '\n');
console.log('fixtures written:', Object.entries(diff.counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join('  '));
