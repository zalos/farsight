// The code map's projects and packages model (docs/proposals/dependencies-and-nx.md §2.3), held
// against the NX example and the invoice app ingested together in process — the module is the one
// the viewer imports (`public/app/lib/codemap-model.js`), so this suite tests the shipped code.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { GraphStore, appClosure, projectGraph, buildIndex, type GraphNode, type GraphEdge, type GraphMeta } from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const M = await import(join(here, '..', 'public', 'app', 'lib', 'codemap-model.js'));
const { layoutDistricts } = await import(join(here, '..', 'public', 'app', 'lib', 'map-model.js'));

let nodes: GraphNode[];
let edges: GraphEdge[];
let meta: GraphMeta;
type AnyRec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

before(async () => {
  const work = mkdtempSync(join(tmpdir(), 'farsight-codemap-model-'));
  const store = new GraphStore();
  for (const [name, dir] of [['nx-workspace', 'examples/nx-workspace'], ['invoice-app', 'examples/invoice-app']] as const) {
    store.addFragment(await ingestRepo(join(repoRoot, dir), { repoName: name }));
  }
  store.save(join(work, 'graph.json'));
  const data = JSON.parse(readFileSync(join(work, 'graph.json'), 'utf8'));
  ({ nodes, edges, meta } = data);
  rmSync(work, { recursive: true, force: true });
});

const nx = () => nodes.filter((n) => n.id.startsWith('nx-workspace::'));
const byName = (name: string) => nodes.find((n) => n.name === name && n.id.startsWith('nx-workspace::'))!;

test('the GROUP choices: none, project, and only the dimensions some project has a value in', () => {
  assert.deepEqual(M.groupChoices(nodes, meta.projects).map((c: AnyRec) => c.key), ['none', 'project', 'domain', 'type']);
  // the invoice app alone: one project with no tags — project, and no dimension at all
  const inv = nodes.filter((n) => n.id.startsWith('invoice-app::'));
  assert.deepEqual(M.groupChoices(inv, meta.projects).map((c: AnyRec) => c.key), ['none', 'project']);
  assert.deepEqual(M.groupChoices([], meta.projects).map((c: AnyRec) => c.key), ['none']);
});

test('a card falls in its project, its tag value, no tag, no project, or the third-party box', () => {
  const g = (n: AnyRec, by: string) => M.groupOf(n, by, meta.projects);
  assert.equal(g(byName('InvoiceList'), 'project').word, 'billing-feature-invoices');
  assert.equal(g(byName('InvoiceList'), 'domain').word, 'Billing');
  assert.equal(g(byName('InvoiceList'), 'type').word, 'Feature');
  assert.equal(g(byName('RunReport'), 'domain').word, 'Operations', "the config's word for a value");
  assert.equal(g(byName('formatMoney'), 'type').word, 'Utility');
  // a workspace package stands in the project it resolves to; a third-party one in a box of its own
  assert.equal(g(nodes.find((n) => n.id === 'nx-workspace::package::@nxw/shared/util')!, 'project').word, 'shared-util');
  assert.equal(g(nodes.find((n) => n.id === 'nx-workspace::package::date-fns')!, 'project').kind, 'thirdParty');
  // an e2e project tagged with a scope but no type
  assert.equal(g(nodes.find((n) => n.kind === 'test' && n.id.startsWith('nx-workspace::'))!, 'type').kind, 'noTag');
  // a journey sits under no project folder
  assert.equal(g(nodes.find((n) => n.kind === 'flow' && n.id.startsWith('nx-workspace::'))!, 'project').kind, 'noProject');
});

test('folded groups partition their cards, kinds add up, the catch-alls come last', () => {
  const items = nx().filter((n) => n.kind !== 'module');
  const groups = M.foldGroups(items, 'domain', meta.projects);
  assert.deepEqual(groups.map((g: AnyRec) => g.word ?? g.kind), ['Billing', 'Operations', 'Shared', 'noProject', 'thirdParty']);
  assert.equal(groups.reduce((s: number, g: AnyRec) => s + g.members.length, 0), items.length, 'every card in exactly one box');
  for (const g of groups) assert.equal(Object.values(g.byKind as Record<string, number>).reduce((a, b) => a + b, 0), g.parts);
});

test('depends on a package keeps its importers and the package', () => {
  const ids = M.dependsOnIds(edges, 'invoice-app::package::zod');
  assert.ok(ids.has('invoice-app::package::zod'));
  assert.ok(ids.has('invoice-app::module::src/server/schemas.ts'));
  assert.ok(ids.has('invoice-app::src/server/schemas.ts::draftInvoiceSchema'));
  assert.ok(![...ids].some((id) => id.startsWith('nx-workspace::')), 'the other source keeps its own zod-free code');
});

test('App and its related: every dependency arrow points right, the application first', () => {
  const pg = projectGraph(buildIndex(nodes, edges), meta.projects);
  const closure = appClosure(pg, 'billing-web')!;
  const col = M.closureColumns(closure.projects, closure.dependencies);
  assert.equal(col.get('billing-web'), 0);
  for (const d of closure.dependencies) assert.ok(col.get(d.to) > col.get(d.from), `${d.from} → ${d.to} points right`);
  // a cycle cannot push a column past the closure's size
  const cyc = M.closureColumns(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }]);
  assert.ok([...cyc.values()].every((v: number) => v <= 2));
});

test('the version a group declares: its own manifest, else the one nearest the root', () => {
  const vs = [{ where: 'billing-ui', range: '^2', declaredIn: 'libs/billing/ui/package.json' }, { where: 'repo', range: '^1', declaredIn: 'package.json' }];
  assert.equal(M.versionFor(vs, 'billing-ui').range, '^2');
  assert.equal(M.versionFor(vs, 'ops-admin').range, '^1');
  assert.equal(M.versionFor([], 'x'), null);
});

test('a journey takes the domain of its screens’ pages; the invoice app’s have none', () => {
  const d = (id: string, screens: string[], repo: string) => M.journeyDomain({ id, screens, repo }, nodes, meta.projects);
  assert.deepEqual(d('nx-workspace::flow::review-open-invoices', ['BIL-01'], 'nx-workspace'), { key: 'billing', word: 'Billing' });
  assert.deepEqual(d('nx-workspace::flow::check-report-runs', ['OPS-01'], 'nx-workspace'), { key: 'ops', word: 'Operations' });
  assert.deepEqual(d('invoice-app::flow::new-invoice', ['INV-02'], 'invoice-app'), { key: '', word: '' });
  assert.equal(M.canBandByDomain([{ id: 'nx-workspace::flow::review-open-invoices', screens: ['BIL-01'], repo: 'nx-workspace' }], nodes, meta.projects), true);
  assert.equal(M.canBandByDomain([{ id: 'invoice-app::flow::new-invoice', screens: ['INV-02'], repo: 'invoice-app' }], nodes, meta.projects), false);
});

test('layoutDistricts bands by the key a function gives', () => {
  const items = [{ id: 'a', repo: 'r1', w: 100, h: 50, d: 'x' }, { id: 'b', repo: 'r1', w: 100, h: 50, d: 'y' }, { id: 'c', repo: 'r2', w: 100, h: 50, d: 'x' }];
  assert.deepEqual(layoutDistricts(items).bands.map((b: AnyRec) => b.repo), ['r1', 'r2']);
  assert.deepEqual(layoutDistricts(items, { bandKey: (it: AnyRec) => it.d }).bands.map((b: AnyRec) => b.repo), ['x', 'y']);
});
