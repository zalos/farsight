import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GraphStore } from '@farsight/core';
import { ingestRepo, patternsTestText } from '@farsight/parsers';
import { createMcpServer } from '../dist/run.js';
import { tierOf } from '../dist/tiers.js';

test('patterns_test is read-only in all tier, shares CLI text and config/overview reports', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'patterns-mcp-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const root = join(ws, 'source');
  mkdirSync(root);
  mkdirSync(join(ws, '.farsight'));
  writeFileSync(
    join(root, 'app.ts'),
    `export function handle() {}\nportal.get('/known', handle);\nportal.post('/missing', missing);`,
  );
  const config = {
    patterns: [
      {
        id: 'route',
        files: ['*.ts'],
        match: { call: 'portal.$METHOD', args: { path: 0, handler: -1 } },
        emit: { kind: 'route' as const, method: '$METHOD', path: '$path', handler: '$handler' },
      },
    ],
  };
  const from = '.farsight/settings.json → sources[source-id].config';
  const store = new GraphStore();
  store.addFragment(await ingestRepo(root, { repoName: 'app', configOverlay: { config, from } }));
  store.roots.app = root;
  const graph = join(ws, 'graph.json');
  store.save(graph);
  writeFileSync(
    join(ws, '.farsight/settings.json'),
    JSON.stringify({ sources: [{ id: 'source-id', name: 'app', type: 'local', path: 'source', config }] }),
  );
  const before = readFileSync(graph, 'utf8');
  const { server } = createMcpServer(graph, { tools: 'all' });
  const client = new Client({ name: 'patterns', version: '1' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  assert.equal(tierOf('patterns_test'), 'all');
  const tools = await client.listTools();
  assert.equal(tools.tools.find((tool) => tool.name === 'patterns_test')?.annotations?.readOnlyHint, true);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, JSON.stringify(response));
    return (response.content as { text: string }[]).map((c) => c.text).join('\n');
  };
  const result = JSON.parse(await call('patterns_test', { repo: 'app', json: true }))[0];
  assert.equal(result.matches[0].name, 'POST /missing');
  assert.match(result.report.rules[0].file, /sources\[source-id\]/);
  assert.equal(await call('patterns_test', { repo: 'app' }), patternsTestText(result));
  const files = JSON.parse(await call('config_files', { repo: 'app', json: true }));
  assert.equal(files.app.patterns.rules[0].matched, 2);
  assert.equal(files.app.patternCounts[0].matched.n, 2);
  assert.match(await call('graph_overview'), /Pattern rules/);
  assert.equal(readFileSync(graph, 'utf8'), before);
});
