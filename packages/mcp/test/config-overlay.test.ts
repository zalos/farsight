import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GraphStore, type GraphNode } from '@farsight/core';
import { createMcpServer } from '../dist/run.js';

test('MCP refresh retains local and git workspace overlays and excludes without changing sources', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'farsight-mcp-overlay-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const store = new GraphStore();
  const sources = ['local', 'git'].map((type) => {
    const root = join(ws, type);
    mkdirSync(root);
    writeFileSync(join(root, 'main.ts'), 'export function submit() { return 1; }');
    writeFileSync(join(root, 'skip.ts'), 'export function excluded() { return 2; }');
    store.roots[type] = root;
    return {
      id: type,
      name: type,
      type,
      path: type === 'git' ? 'https://example.com/repo.git' : type,
      enabled: true,
      exclude: ['skip.ts'],
      config: { glossary: { submit: { label: `${type} workspace word` } } },
    };
  });
  const graph = join(ws, 'graph.json');
  store.save(graph);
  mkdirSync(join(ws, '.farsight'), { recursive: true });
  const file = join(ws, '.farsight', 'settings.json');
  const settings = JSON.stringify({ sources, collections: [], defaultLens: 'code' });
  writeFileSync(file, settings);
  const { server } = createMcpServer(graph, { tools: 'all' });
  const client = new Client({ name: 'overlay-test', version: '1' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({ name: 'refresh_graph', arguments: {} });
  assert.ok(!result.isError, JSON.stringify(result));
  const data = JSON.parse(readFileSync(graph, 'utf8')) as {
    nodes: GraphNode[];
    meta: { config: Record<string, { files: { path: string }[] }> };
  };
  for (const type of ['local', 'git']) {
    assert.equal(
      data.nodes.find((n) => n.id.startsWith(`${type}::`) && n.name === 'submit')?.facets?.business?.label,
      `${type} workspace word`,
    );
    assert.ok(
      data.meta.config[type]!.files.some((f) => f.path === `.farsight/settings.json → sources[${type}].config`),
    );
    assert.equal(readFileSync(join(ws, type, 'main.ts'), 'utf8'), 'export function submit() { return 1; }');
  }
  assert.ok(!data.nodes.some((n) => n.name === 'excluded'));
  assert.equal(readFileSync(file, 'utf8'), settings);
});
