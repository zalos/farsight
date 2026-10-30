import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GraphStore } from '@farsight/core';
import { createMcpServer } from '../dist/run.js';

test('config_files and graph_overview read candidates without config files and print the registration command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-openapi-'));
  const graph = join(dir, 'graph.json');
  const store = new GraphStore();
  store.addFragment({
    repo: 'vendor',
    nodes: [],
    edges: [],
    meta: {
      files: 0,
      sourceHash: '',
      openapi: {
        applied: [{ path: 'openapi.yaml', title: 'Billing', version: '1', operations: 3, origin: 'settings' }],
        candidates: [{ path: 'docs/vendor-api.json', title: 'Vendor', version: '2', operations: 1, origin: 'file' }],
      },
    },
  });
  store.save(graph);
  const { server } = createMcpServer(graph, { tools: 'all' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'openapi-candidates-test', version: '0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return (r.content as { text: string }[]).map((c) => c.text).join('\n');
  };
  try {
    const config = await call('config_files');
    assert.match(config, /docs\/vendor-api.json · Vendor 2 · 1 operation/);
    assert.match(config, /registered in workspace/);
    assert.match(config, /farsight api register 'vendor' 'docs\/vendor-api.json'/);
    const json = JSON.parse(await call('config_files', { json: true }));
    assert.equal(json.vendor.openapiCounts.candidates.n, 1);
    assert.equal(json.vendor.openapiCounts.operations['docs/vendor-api.json'].scope, 'count.scope.document');
    assert.equal(json.vendor.openapi.candidates[0].path, 'docs/vendor-api.json');
    assert.deepEqual(JSON.parse(await call('config_files', { repo: 'missing', json: true })), {});
    assert.match(
      await call('graph_overview'),
      /vendor — 1 candidate document looks like an OpenAPI spec and is not registered: docs\/vendor-api.json/,
    );
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
