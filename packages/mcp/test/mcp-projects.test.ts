/**
 * Projects on the MCP surface (docs/proposals/dependencies-and-nx.md §2.3): `describe_node` prints the
 * node's project with its tags by dimension, and `graph_overview` one projects line — the tool,
 * projects by type, dependencies, and projects per tag value. The graph is `examples/nx-workspace`,
 * ingested by the built CLI into a temp directory; nothing here touches the workspace graph.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { GraphNode } from '@farsight/core';
import { createMcpServer } from '../dist/run.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/cli.js');

let work: string;
let graph: string;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await client.callTool({ name, arguments: args });
  return (r.content as { text: string }[]).map((c) => c.text).join('\n');
}

before(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-mcp-projects-')));
  process.env.MODELHUB_DIR = join(work, 'modelhub');
  graph = join(work, 'graph.json');
  const r = spawnSync(process.execPath, [cli, 'ingest', join(repoRoot, 'examples/nx-workspace'), '--repo', 'nx-workspace', '--out', graph], { cwd: work, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { server } = createMcpServer(graph);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'mcp-projects-test', version: '0' });
  await client.connect(clientSide);
});

after(async () => {
  try { await client?.close(); } catch { /* already closed */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
});

test('graph_overview carries one projects line: the tool, projects by type, dependencies, and the dimensions', async () => {
  const out = await call('graph_overview');
  const line = out.split('\n').find((l) => l.startsWith('projects: '));
  assert.ok(line, out);
  assert.match(line!, /^projects: nx · 8 projects \(2 applications · 5 libraries · 1 e2e\) · 10 project dependencies/);
  assert.match(line!, /Domain: Billing 5 · Shared 2 · Operations 1/);
  assert.match(line!, /Type: Application 2 · UI 2 · Data access 1 · Feature 1 · Utility 1 · no tag 1/);
});

test('describe_node prints the project, its type and root, and its tags in words by dimension', async () => {
  const nodes = (JSON.parse(readFileSync(graph, 'utf8')) as { nodes: GraphNode[] }).nodes;
  const id = nodes.find((n) => n.name === 'InvoiceList')!.id;
  const out = await call('describe_node', { node_id: id, context: false });
  assert.match(out, /\n {2}project: billing-feature-invoices · library · libs\/billing\/feature-invoices · Domain Billing · Type Feature\n/);
});
