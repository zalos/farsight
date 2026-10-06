// Design manifests: discovery by name, the ingestRepo post-pass against the
// real examples/invoice-app fixture, a manifest as a source of its own, and
// fail-soft Figma freshness. Runs against the built packages: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ingestRepo, ingestDesign, discoverManifests, parseManifestText, figmaToken, figmaLastModified } from '../dist/index.js';
import { buildIndex, designSurface, journey } from '@farsight/core';

const invoiceApp = resolve(import.meta.dirname, '../../../examples/invoice-app');

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-design-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test('parseManifestText rejects non-manifests with a readable reason; figmaToken/figmaLastModified are fail-soft without a token', async () => {
  assert.throws(() => parseManifestText('{"a":1}', 'x.json'), /not a design manifest/);
  assert.throws(() => parseManifestText('{nope', 'x.json'), /not valid JSON/);
  const saved = process.env.FIGMA_TOKEN;
  delete process.env.FIGMA_TOKEN;
  try {
    assert.equal(figmaToken({ screens: [{ id: 'A' }] }), undefined);
    assert.equal(figmaToken({ figma: { token: 'env:NOPE_NOT_SET' }, screens: [{ id: 'A' }] }), undefined);
    assert.equal(await figmaLastModified({ figma: { file: 'https://www.figma.com/design/KEY/x' }, screens: [{ id: 'A' }] }), undefined);
  } finally {
    if (saved !== undefined) process.env.FIGMA_TOKEN = saved;
  }
});

test('discoverManifests: examples/invoice-app/docs/design/screens.json is found by name with manifest freshness', async () => {
  const { manifests, errors } = await discoverManifests(invoiceApp, {});
  assert.deepEqual(errors, []);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0]!.path, 'docs/design/screens.json');
  assert.equal(manifests[0]!.origin, 'file');
  assert.equal(manifests[0]!.manifest.screens.length, 3);
  assert.equal(manifests[0]!.freshness, 'manifest');
  assert.ok(manifests[0]!.lastModified);
});

test('ingestRepo post-pass on invoice-app: two screens built, one designed-only page added, the edit page undesigned; journeys run from the unbuilt screen', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const index = buildIndex(f.nodes, f.edges);
  const [d] = designSurface(index);
  assert.equal(d!.id, 'invoice-app::design::docs/design/screens.json');
  assert.deepEqual(d!.counts, { screens: 4, designed: 3, built: 2, designOnly: 1, codeOnly: 1, drift: 3, flows: 4 });
  assert.deepEqual(d!.flows.map((x) => [x.id, x.built, x.total, x.screens]), [
    ['billing-cycle', 2, 3, ['INV-02', 'INV-01', 'INV-03']], ['correct-draft', 1, 1, ['INV-02']], ['draft-and-send', 1, 2, ['INV-01', 'INV-03']], ['new-invoice', 1, 1, ['INV-02']],
  ]);
  const byId = Object.fromEntries(d!.screens.map((s) => [s.designId ?? s.route, s]));
  assert.deepEqual(byId['INV-01']!.drift, [], 'the list page reaches exactly the four operations its design lists');
  assert.equal(byId['INV-01']!.status, 'both');
  assert.equal(byId['INV-01']!.hasImage, true);
  assert.deepEqual(byId['INV-02']!.drift.map((x) => x.kind), ['operation-unreached'], 'the new-invoice page never calls getInvoice');
  assert.equal(byId['INV-03']!.status, 'design-only');
  assert.equal(byId['/invoices/:id/edit']!.status, 'code-only');
  const j = journey(index, byId['INV-03']!.nodeId);
  assert.deepEqual(j.steps.map((s) => [s.via, s.planned?.kind]), [['entry', undefined], ['planned', 'calls'], ['planned', 'step']]);
  assert.equal(j.steps[1]!.nodeId, 'invoice-app::route::DELETE /invoices/{id}');
  // opting out leaves the graph untouched
  const plain = await ingestRepo(invoiceApp, { repoName: 'invoice-app', design: false });
  assert.equal(plain.nodes.filter((n) => n.kind === 'design' || n.design).length, 0);
});

test('ingestDesign: a manifest alone is a design-only source; declared config manifests win over discovery for the same path', async () => {
  const dir = tempRepo({
    'farsight.config.json': JSON.stringify({ design: [{ manifest: 'design/screens.json', name: 'Declared' }] }),
    'design/screens.json': JSON.stringify({ screens: [{ id: 'S-1', name: 'One', route: '/one' }, { id: 'S-2', name: 'Two', route: '/two' }] }),
    'src/page.tsx': 'export function One() { return <div/>; }',
  });
  const f = await ingestRepo(dir, { repoName: 'app' });
  const design = f.nodes.find((n) => n.kind === 'design')!;
  assert.equal(design.name, 'Declared');
  assert.equal(f.nodes.filter((n) => n.kind === 'page' && n.design?.status === 'design-only').length, 2);
  assert.equal(f.nodes.filter((n) => n.kind === 'design').length, 1, 'declared + discovered at the same path is one source');

  const alone = await ingestDesign(join(dir, 'design/screens.json'), { repoName: 'design-only' });
  assert.equal(alone.repo, 'design-only');
  assert.equal(alone.nodes.filter((n) => n.kind === 'page').length, 2);
  assert.equal(alone.meta?.files, 1);
});
