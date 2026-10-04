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
  assert.match(line!, /^projects: nx · 8 projects \(2 applications · 5 libraries · 1 e2e\) · 11 project dependencies · nx graph: 11 dependencies read/);
  assert.match(line!, /Domain: Billing 5 · Shared 2 · Operations 1/);
  assert.match(line!, /Type: Application 2 · UI 2 · Data access 1 · Feature 1 · Utility 1 · no tag 1/);
});

test('describe_node prints the project, its type and root, and its tags in words by dimension', async () => {
  const nodes = (JSON.parse(readFileSync(graph, 'utf8')) as { nodes: GraphNode[] }).nodes;
  const id = nodes.find((n) => n.name === 'InvoiceList')!.id;
  const out = await call('describe_node', { node_id: id, context: false });
  assert.match(out, /\n {2}project: billing-feature-invoices · library · libs\/billing\/feature-invoices · Domain Billing · Type Feature\n/);
});

// ── config files (docs/proposals/journey-organisation-and-config-files.md §5.4): the example holds a root
// farsight.config.json and one in each app folder, with one glossary word given twice and a root-only field ──

test('graph_overview says how many config files a source holds when there is more than the root one', async () => {
  const out = await call('graph_overview');
  const line = out.split('\n').find((l) => l.startsWith('config: '));
  assert.equal(line, 'config: nx-workspace — 3 config files (1 for the whole source · 2 for one folder) · 1 conflict · 1 note(s) — config_files lists them');
});

test('config_files prints one line per file, then the conflicts and the notes', async () => {
  const out = await call('config_files');
  const lines = out.split('\n');
  assert.equal(lines[0], '## nx-workspace — 3 config files in this source (1 for the whole source · 2 for one folder) · 1 conflict');
  assert.equal(lines[1], 'farsight.config.json — root — the whole source · projects, glossary, journeys');
  assert.equal(lines[2], 'apps/billing-web/farsight.config.json — scoped to apps/billing-web/ · glossary, plumbing');
  assert.equal(lines[3], 'apps/ops-admin/farsight.config.json — scoped to apps/ops-admin/ · design, glossary · ignored: tooling');
  assert.match(out, /conflicts:\n {2}glossary "InvoicesPage": farsight\.config\.json, apps\/billing-web\/farsight\.config\.json — apps\/billing-web\/farsight\.config\.json's word stands under its folder/);
  assert.match(out, /notes:\n {2}tooling is root-only; apps\/ops-admin\/farsight\.config\.json's was ignored\./);
  assert.match(await call('config_files', { repo: 'nope' }), /No config files recorded for nope/);
});

test('config_files json: true returns the ConfigMeta per source', async () => {
  const doc = JSON.parse(await call('config_files', { json: true })) as Record<string, { files: { path: string; dir: string; root: boolean }[]; conflicts: unknown[]; notes: string[] }>;
  assert.deepEqual(Object.keys(doc), ['nx-workspace']);
  assert.deepEqual(doc['nx-workspace']!.files.map((f) => [f.path, f.dir, f.root]), [
    ['farsight.config.json', '.', true],
    ['apps/billing-web/farsight.config.json', 'apps/billing-web', false],
    ['apps/ops-admin/farsight.config.json', 'apps/ops-admin', false],
  ]);
  assert.equal(doc['nx-workspace']!.conflicts.length, 1);
});

test('farsight config list prints the same lines, and --json the same document', () => {
  const text = spawnSync(process.execPath, [cli, 'config', 'list', '--graph', graph], { cwd: work, encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^## nx-workspace — 3 config files in this source/);
  assert.match(text.stdout, /apps\/ops-admin\/farsight\.config\.json — scoped to apps\/ops-admin\/ · design, glossary · ignored: tooling/);
  const json = spawnSync(process.execPath, [cli, 'config', 'list', '--graph', graph, '--repo', 'nx-workspace', '--json'], { cwd: work, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.equal((JSON.parse(json.stdout) as Record<string, { files: unknown[] }>)['nx-workspace']!.files.length, 3);
});
