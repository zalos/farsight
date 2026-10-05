// The folds behind every surface, on the synthetic workspace (scripts/synth-graph.mjs, the small preset CI
// runs: ≈50 NX projects, ≈20k nodes, 40 journeys in 8 manifests) — a regression guard for the perf round
// (docs/proposals/round-2026-10-05.md §4, e2e/perf/ measures the browser on the full preset). Each fold is
// held to a budget well above what it takes here and well below what the per-node scans it replaced took,
// and the answers the server keeps beside its index (folds.ts) and the lean tests answer are proven to be
// the same numbers as the full ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex, journeyTree, designSurface, projectGraph, testsSurface, journey, journeySummary, screensFor } from '@farsight/core';
import { folded, scopeKey, leanJourneyRow, leanMetric } from '../dist/folds.js';

const here = dirname(fileURLToPath(import.meta.url));
const SYN = await import(join(here, '..', '..', '..', 'scripts', 'synth-graph.mjs'));
const CM = await import(join(here, '..', 'public', 'app', 'lib', 'codemap-model.js'));
const SM = await import(join(here, '..', 'public', 'app', 'lib', 'search-model.js'));
type AnyRec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const graph = SYN.synthesize(SYN.parseArgs(['--preset', 'small']));
const { nodes, edges, meta } = graph as { nodes: AnyRec[]; edges: AnyRec[]; meta: AnyRec };
const index = buildIndex(nodes as never, edges as never);

/** Run `fn`, assert it took under `budget` ms, return its answer. */
function within<T>(name: string, budget: number, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  assert.ok(ms < budget, `${name} took ${ms.toFixed(0)} ms (budget ${budget} ms)`);
  return out;
}

test('the synthetic workspace has the shape the round asks for, scaled down', () => {
  assert.ok(nodes.length >= 15_000, `${nodes.length} nodes`);
  assert.ok(edges.length >= 25_000, `${edges.length} edges`);
  const projects = Object.values(meta.projects as Record<string, AnyRec>).reduce((n, m) => n + m.projects.length, 0);
  assert.ok(projects >= 50, `${projects} projects`);
  assert.equal(nodes.filter((n) => n.kind === 'flow').length, 40);
  assert.equal(nodes.filter((n) => n.kind === 'design').length, 8);
  // deterministic: the same flags write the same graph
  const again = SYN.synthesize(SYN.parseArgs(['--preset', 'small']));
  assert.equal(JSON.stringify(again.nodes.slice(0, 500)), JSON.stringify(nodes.slice(0, 500)));
  assert.equal(again.edges.length, edges.length);
});

test('the server folds answer within budget, and a second ask is the kept answer', () => {
  const tree = within('journeyTree', 500, () => folded(index, 'journeys', 'all', () => journeyTree(index, meta.journeys, null)));
  assert.equal(tree.counts.journeys.n, 40);
  assert.equal(folded(index, 'journeys', 'all', () => { throw new Error('folded again'); }), tree);
  within('designSurface', 500, () => designSurface(index, null));
  within('projectGraph', 1000, () => projectGraph(index, meta.projects));
  const tests = within('testsSurface', 3000, () => folded(index, 'tests', scopeKey(null) + '|all', () => testsSurface(index, null, meta.tests)));
  assert.equal(tests.journeys.length, 40);
  within('testsSurface (unit)', 3000, () => testsSurface(index, null, meta.tests, { level: 'unit' }));
  const flows = nodes.filter((n) => n.kind === 'flow').slice(0, 10);
  within('ten journey summaries', 3000, () => flows.forEach((f) => journeySummary(index, journey(index, f.id), screensFor(index, f.id))));
});

test('the lean tests answer is the full answer’s numbers without its lists', () => {
  const full = testsSurface(index, null, meta.tests);
  for (const row of full.journeys as AnyRec[]) {
    const lean = leanJourneyRow(row) as AnyRec;
    assert.equal(lean.declaredCount, (row.declared || []).length);
    assert.equal(lean.inferredCount, (row.inferred || []).length);
    assert.equal(lean.coverage.testsCount, (row.coverage.tests || []).length);
    for (const k of ['numerator', 'denominator', 'value', 'bound']) assert.deepEqual(lean.coverage.metric[k], row.coverage.metric[k], k);
    assert.deepEqual(lean.coverage.counts, row.coverage.counts);
    assert.equal(lean.coverage.chip, row.coverage.chip);
  }
  const m = leanMetric(full.metric) as AnyRec;
  assert.equal(m.evidenceCount, (full.metric as AnyRec).evidence.length);
  assert.equal(m.uncertainty?.note, (full.metric as AnyRec).uncertainty?.note);
  const size = (x: unknown) => JSON.stringify(x).length;
  const leanSize = size({ ...full, metric: m, journeys: (full.journeys as AnyRec[]).map(leanJourneyRow) });
  assert.ok(leanSize < size(full) / 2, `lean ${leanSize} vs full ${size(full)}`);
});

test('the code map index, its choices, a filter and the grouped fold, and the ⌘K index, within budget', () => {
  const cm = within('buildCodemapIndex', 1500, () => CM.buildCodemapIndex(nodes, edges, meta.projects));
  within('groupChoicesFor', 100, () => CM.groupChoicesFor(cm, null));
  const some = [...cm.projects.keys()].slice(0, 3);
  const kept = within('passFor', 300, () => CM.passFor(cm, { projects: new Set(some) }));
  assert.ok(kept && kept.size > 0);
  within('foldGroups by project', 1000, () => CM.foldGroups(nodes, 'project', cm));
  const names = { bizName: (n: AnyRec) => String(n.name), bizLabel: (n: AnyRec) => String(n.name), repoOf: (n: AnyRec) => String(n.id).split('::')[0] };
  const si = within('buildSearchIndex', 1500, () => SM.buildSearchIndex(nodes, names));
  for (const q of ['i', 'in', 'inv', 'invo', 'invoi', 'invoic', 'invoice']) within(`search "${q}"`, 50, () => SM.searchIndex(si, q, null));
});

test('the detail doors (lib/detail-links.js) are lookups: every detail of the workspace within budget', async () => {
  const D = await import(join(here, '..', 'public', 'app', 'lib', 'detail-links.js'));
  const byId: AnyRec = {};
  for (const n of nodes) byId[n.id] = n;
  const edgesOf = new Map<string, AnyRec[]>();
  for (const e of edges) for (const id of [e.from, e.to]) { const l = edgesOf.get(id); if (l) l.push(e); else edgesOf.set(id, [e]); }
  const kinds: AnyRec = { guard: 'gate', rule: 'rule', route: 'route', table: 'record', test: 'test', page: 'screen', component: 'component', function: 'call', package: 'package', external: 'external', work: 'work' };
  within('detailLinks over every detail', 500, () => { for (const n of nodes) if (kinds[n.kind]) D.detailLinks(kinds[n.kind], n, { byId, edgesOf, roots: {} }); });
});
