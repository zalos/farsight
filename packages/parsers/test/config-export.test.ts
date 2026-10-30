import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FarsightConfig, GraphNode } from '@farsight/core';
import {
  loadWorkspaceConfig,
  exportWorkspaceConfig,
  applyWorkspaceConfig,
  applyStores,
  ingestRepo,
} from '../dist/index.js';

test('export retains the effective words, matchers and store assignments while nested files stay scoped', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'farsight-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'nested'));
  const repository: FarsightConfig = {
    glossary: { submit: { label: 'Repository submission' } },
    tags: { billing: ['submit'] },
    entrypoints: { Billing: ['submit'] },
    stores: [{ name: 'Ledger', kind: 'sql', tables: ['Alpha'] }],
    openapi: [{ path: 'api.yaml', name: 'Repository API' }],
  };
  const overlay: FarsightConfig = {
    glossary: { submit: { label: 'Workspace submission' }, approve: { label: 'Approve payment' } },
    tags: { billing: ['approve'] },
    entrypoints: { Billing: ['approve'] },
    stores: [{ name: 'Ledger', kind: 'sql', tables: ['Beta'] }],
  };
  writeFileSync(join(root, 'farsight.config.json'), JSON.stringify(repository));
  writeFileSync(
    join(root, 'nested/farsight.config.json'),
    JSON.stringify({ glossary: { submit: { label: 'Nested submission' } } }),
  );
  const ws = loadWorkspaceConfig(root, { configOverlay: { from: 'workspace', config: overlay } });
  const snapshot = structuredClone(ws);
  const exported = exportWorkspaceConfig(ws, [{ path: 'api.yaml', name: 'Duplicate' }, { path: 'next.yaml' }]);
  assert.deepEqual(ws, snapshot, 'export does not mutate the configuration used by ingest');
  assert.equal(exported.glossary?.submit?.label, 'Repository submission');
  assert.deepEqual(exported.openapi, [{ path: 'api.yaml', name: 'Repository API' }, { path: 'next.yaml' }]);
  writeFileSync(join(root, 'farsight.config.json'), JSON.stringify(exported));
  const after = loadWorkspaceConfig(root);
  const nodes = [
    { id: 'app::submit', kind: 'function', name: 'submit', loc: { path: 'app.ts', line: 1 } },
    { id: 'app::approve', kind: 'function', name: 'approve', loc: { path: 'app.ts', line: 2 } },
    { id: 'app::nested', kind: 'function', name: 'submit', loc: { path: 'nested/app.ts', line: 1 } },
    { id: 'app::Alpha', kind: 'table', name: 'Alpha' },
    { id: 'app::Beta', kind: 'table', name: 'Beta' },
  ].map((node) => ({ ...node, repo: 'app', tags: [], facets: {} })) as GraphNode[];
  const apply = (workspace: typeof ws) => {
    const fragment = { nodes: structuredClone(nodes), edges: [] };
    applyWorkspaceConfig(fragment.nodes, fragment.edges, workspace);
    applyStores(fragment, root, {}, workspace.stores, []);
    return fragment.nodes;
  };
  const beforeNodes = apply(ws);
  const afterNodes = apply(after);
  assert.equal(beforeNodes.find((node) => node.name === 'Beta')?.store?.name, 'Ledger');
  assert.deepEqual(afterNodes, beforeNodes);
  assert.equal(afterNodes.find((node) => node.id === 'app::nested')?.facets.business?.label, 'Nested submission');
});

test('ingest produces the same nodes and edges after moving the overlay into the root export', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'farsight-export-ingest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.ts'), 'export function submit() {}\nexport function approve() { submit(); }');
  writeFileSync(
    join(root, 'farsight.config.json'),
    JSON.stringify({ glossary: { submit: { label: 'Root submission' } }, tags: { billing: ['submit'] } }),
  );
  const configOverlay = {
    from: 'workspace',
    config: {
      glossary: { submit: { label: 'Workspace submission' }, approve: { label: 'Approve payment' } },
      tags: { billing: ['approve'] },
      entrypoints: { Billing: ['approve'] },
    },
  };
  const before = await ingestRepo(root, { repoName: 'app', configOverlay });
  const exported = exportWorkspaceConfig(loadWorkspaceConfig(root, { configOverlay }));
  writeFileSync(join(root, 'farsight.config.json'), JSON.stringify(exported));
  const after = await ingestRepo(root, { repoName: 'app' });
  assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(after.edges, before.edges);
});
