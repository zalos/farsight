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

test('the NX example: each app declares its persona and an Access group, the root manifest its groups — one organisation for the source', async () => {
  const g = await ingestRepo(join(EXAMPLES, 'nx-workspace'), { repoName: 'nx-workspace', ...only });
  const m = g.meta!.journeys!;
  assert.deepEqual(m.personas.map((p) => `${p.id}=${p.name}@${p.from}`), [
    'billing=Billing@apps/billing-web/docs/design/screens.json',
    'ops=Operations@apps/ops-admin/docs/design/screens.json',
  ]);
  assert.deepEqual(m.groups.map((x) => `${x.id}${x.persona ? `(${x.persona})` : ''}@${x.from}`), [
    'access@apps/billing-web/docs/design/screens.json',
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

test('a manifest as a source of its own carries its organisation too', async () => {
  const dir = repo({ 'screens.json': JSON.stringify({ personas: [{ id: 'p', name: 'People' }], screens: [{ id: 'S-1', route: '/a' }], flows: [{ id: 'f', name: 'F', screens: ['S-1'], persona: 'p' }] }) });
  const g = await ingestDesign(join(dir, 'screens.json'), { repoName: 'd' });
  assert.deepEqual(g.meta?.journeys?.personas.map((p) => p.name), ['People']);
});
