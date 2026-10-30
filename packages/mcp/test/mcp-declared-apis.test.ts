import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GraphStore, applyConfig, type GraphNode, type GraphEdge } from '@farsight/core';
import { createMcpServer } from '../dist/run.js';

test('api_surface separates found and declared operations and does not call an implied surface code evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-declared-apis-'));
  const graph = join(dir, 'graph.json');
  const store = new GraphStore();
  const nodes: GraphNode[] = [
    {
      id: 'app::route::GET /found',
      kind: 'route',
      name: 'GET /found',
      tags: [],
      loc: { repo: 'app', path: 'routes.ts', line: 1 },
    },
  ];
  const edges: GraphEdge[] = [];
  applyConfig(
    nodes,
    {
      nodes: [
        { kind: 'route', name: 'GET /manual' },
        { kind: 'route', name: 'POST /manual' },
      ],
    },
    edges,
    { repo: 'app' },
  );
  store.addFragment({ repo: 'app', nodes, edges });
  store.save(graph);
  const { server } = createMcpServer(graph, { tools: 'all' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'declared-apis-test', version: '0' });
  await client.connect(clientSide);
  try {
    const call = async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: 'api_surface', arguments: args });
      return (r.content as { text: string }[]).map((c) => c.text).join('\n');
    };
    const list = await call({});
    assert.match(list, /supplied 3 \(1 found in code · 2 declared by a person\)/);
    assert.match(list, /\(no spec on file\)/);
    assert.doesNotMatch(list, /implied from code|implemented 3/);
    const detail = await call({ api: 'app::api::implemented' });
    assert.match(detail, /\(no spec on file\)/);
    assert.doesNotMatch(detail, /implied from code/);
    assert.match(detail, /GET \/manual.*no source: declared only/);
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
