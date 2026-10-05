// meta.journeys at ingest (docs/proposals/journey-organisation-and-config-files.md §4.3): every
// manifest's personas and groups and the root config's `journeys` block, folded once into the
// fragment and kept per source by GraphStore — the NX example with one manifest per app plus the
// root one, the invoice app with a config placement, a config naming a flow nobody declares, and
// a source with no manifest. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestRepo, ingestDesign } from '../dist/index.js';
import { buildIndex, journeyTree, GraphStore } from '@farsight/core';
import type { GraphFragment } from '@farsight/core';

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples');
const temps: string[] = [];
process.on('exit', () => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-journeys-'));
  temps.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const only = { openapi: false, tests: false, stories: false, projects: false } as const;

test('the NX example: each app declares its persona and an Access group, the root manifest its groups, the root config the persona order', async () => {
  const g = await ingestRepo(join(EXAMPLES, 'nx-workspace'), { repoName: 'nx-workspace', ...only });
  const m = g.meta!.journeys!;
  // apps/ops-admin's manifest is declared by its own config, so it is read first; the root
  // config's journeys.personas puts Billing first anyway, and the names come from the manifests
  assert.deepEqual(m.personas.map((p) => `${p.id}=${p.name}@${p.from}`), [
    'billing=Billing@farsight.config.json',
    'ops=Operations@farsight.config.json',
  ]);
  assert.equal(m.personas[1]!.description, 'The team that runs the overnight collection.');
  assert.deepEqual(m.groups.map((x) => `${x.id}${x.persona ? `(${x.persona})` : ''}@${x.from}`), [
    'access@apps/ops-admin/docs/design/screens.json',
    'invoices(billing)@docs/design/screens.json',
    'runs(ops)@docs/design/screens.json',
  ]);
  assert.deepEqual(m.flows, {});
  assert.deepEqual(m.notes, []);
  const store = new GraphStore();
  store.addFragment(g as GraphFragment);
  const { nodes, edges } = store.toJSON();
  assert.deepEqual(Object.keys(store.meta.journeys ?? {}), ['nx-workspace'], 'kept per source');
  const tree = journeyTree(buildIndex(nodes, edges), store.meta.journeys);
  assert.deepEqual(tree.personas.map((p) => `${p.name}: ${p.groups.map((x) => `${x.name}[${x.journeys.map((j) => j.id).join(',')}]`).join(' ')}`), [
    'Billing: Access[billing-sign-in] Invoices[review-open-invoices]',
    'Operations: Access[ops-sign-in] Overnight runs[check-report-runs]',
  ]);
  assert.ok(tree.personas.every((p) => p.groups.every((x) => x.journeys.every((j) => j.status === 'both'))), 'every journey of the example is built');
});

test('the invoice app: the config moves one flow, and the manifest order survives designSurface\'s sort', async () => {
  const g = await ingestRepo(join(EXAMPLES, 'invoice-app'), { repoName: 'invoice-app', ...only });
  const m = g.meta!.journeys!;
  assert.deepEqual(m.personas.map((p) => p.id), ['billing', 'ops']);
  assert.deepEqual(m.flows, { 'draft-and-send': { group: 'review', from: 'farsight.config.json', index: 0 } });
  const flow = g.nodes.find((n) => n.id === 'invoice-app::flow::draft-and-send')!;
  assert.deepEqual(flow.design?.persona, ['billing', 'ops']);
  assert.equal(flow.design?.group, 'invoices', 'the node keeps what the manifest says; the tree applies the config');
  assert.equal(g.nodes.find((n) => n.id === 'invoice-app::flow::billing-cycle')!.design?.position, 0);
});

test('a config flow id no manifest declares is a note; a source with no manifest carries no organisation', async () => {
  const screens = JSON.stringify({ screens: [{ id: 'S-1', route: '/a' }], flows: [{ id: 'f', name: 'F', screens: ['S-1'], persona: 'Someone' }] });
  const dir = repo({
    'docs/design/screens.json': screens,
    'farsight.config.json': JSON.stringify({ journeys: { flows: [{ id: 'ghost', group: 'x' }, { id: 'F', order: 2 }], personas: 'not a list' } }),
  });
  const g = await ingestRepo(dir, { repoName: 'r', ...only });
  assert.deepEqual(g.meta!.journeys!.notes, ['flow "ghost" is named by farsight.config.json but no manifest declares it']);
  assert.deepEqual(g.meta!.journeys!.flows, { f: { order: 2, from: 'farsight.config.json', index: 1 } }, 'ids match case-insensitively and key by the manifest\'s spelling');
  assert.deepEqual(g.meta!.journeys!.personas, [], 'a persona nobody declares is the tree\'s to place, not the meta\'s');
  const bare = await ingestRepo(repo({ 'src/a.ts': 'export const a = 1;\n', 'farsight.config.json': JSON.stringify({ journeys: { flows: [{ id: 'x' }] } }) }), { repoName: 'b', ...only });
  assert.equal(bare.meta?.journeys, undefined);
});

test('a nested farsight.config.json places only the flows of the manifests under its folder, and the nearer word stands', async () => {
  const screens = (id: string, flows: object[]) => JSON.stringify({ screens: [{ id, route: `/${id}` }], flows });
  const dir = repo({
    'apps/a/docs/design/screens.json': screens('A-1', [{ id: 'a-flow', name: 'A', screens: ['A-1'], persona: 'p', group: 'g1' }]),
    'apps/b/docs/design/screens.json': screens('B-1', [{ id: 'b-flow', name: 'B', screens: ['B-1'], persona: 'p', group: 'g1' }]),
    'farsight.config.json': JSON.stringify({ journeys: { groups: [{ id: 'g2', name: 'Root words' }], flows: [{ id: 'a-flow', order: 5, group: 'g2' }] } }),
    'apps/a/farsight.config.json': JSON.stringify({ journeys: { groups: [{ id: 'g2', name: 'Nearer words' }], flows: [{ id: 'a-flow', group: 'g1' }, { id: 'b-flow', order: 1 }] } }),
  });
  const g = await ingestRepo(dir, { repoName: 'r', ...only });
  const m = g.meta!.journeys!;
  assert.deepEqual(m.flows, { 'a-flow': { order: 5, group: 'g1', from: 'apps/a/farsight.config.json', index: 0 } }, 'the nearer group wins, the root order stays');
  assert.equal(m.groups.find((x) => x.id === 'g2')?.name, 'Nearer words');
  assert.deepEqual(m.notes, ['flow "b-flow" is named by apps/a/farsight.config.json but no manifest under apps/a/ declares it']);
});

test('a manifest as a source of its own carries its organisation too', async () => {
  const dir = repo({ 'screens.json': JSON.stringify({ personas: [{ id: 'p', name: 'People' }], screens: [{ id: 'S-1', route: '/a' }], flows: [{ id: 'f', name: 'F', screens: ['S-1'], persona: 'p' }] }) });
  const g = await ingestDesign(join(dir, 'screens.json'), { repoName: 'd' });
  assert.deepEqual(g.meta?.journeys?.personas.map((p) => p.name), ['People']);
});

test('storylines at ingest: the NX root manifest chains flows of every app\'s manifest, the invoice app one storyline, a nested config\'s storyline reaches only its folder', async () => {
  const nx = await ingestRepo(join(EXAMPLES, 'nx-workspace'), { repoName: 'nx-workspace', ...only });
  assert.deepEqual(nx.meta!.journeys!.storylines, [{
    id: 'billing-day', name: 'A billing day',
    description: 'Billing signs in and reads what is owed; Operations signs in and checks what the overnight run collected.',
    journeys: ['billing-sign-in', 'review-open-invoices', 'ops-sign-in', 'check-report-runs'],
    declared: true, from: 'docs/design/screens.json',
  }], 'a storyline in one manifest may chain the flows the apps\' own manifests declare');
  const inv = await ingestRepo(join(EXAMPLES, 'invoice-app'), { repoName: 'invoice-app', ...only });
  assert.deepEqual(inv.meta!.journeys!.storylines!.map((s) => `${s.id}: ${s.journeys.join(' → ')}`), ['invoice: new-invoice → draft-and-send → billing-cycle']);

  const app = (id: string) => JSON.stringify({ screens: [{ id: `${id}-1`, route: `/${id}` }], flows: [{ id, name: id, screens: [`${id}-1`] }] });
  const dir = repo({
    'apps/a/docs/design/screens.json': app('a-flow'),
    'apps/b/docs/design/screens.json': app('b-flow'),
    'apps/a/farsight.config.json': JSON.stringify({ journeys: { storylines: [{ id: 'mine', name: 'Mine', journeys: ['a-flow', 'b-flow'] }] } }),
    'farsight.config.json': JSON.stringify({ journeys: { storylines: [{ id: 'both', name: 'Both', journeys: ['b-flow', 'a-flow'] }, { id: 'bad', journeys: 'not a list' }] } }),
  });
  const g = await ingestRepo(dir, { repoName: 'r', ...only });
  const m = g.meta!.journeys!;
  assert.deepEqual(m.storylines!.map((s) => `${s.id}@${s.from}: ${s.journeys.join(',')}`), [
    'both@farsight.config.json: b-flow,a-flow',
    'bad@farsight.config.json: ',
    'mine@apps/a/farsight.config.json: a-flow',
  ]);
  assert.ok(m.notes.some((n) => n.includes('"b-flow"') && n.includes('under apps/a/')), m.notes.join('\n'));
});
