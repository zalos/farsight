// The MCP agent surface end to end: the real `farsight mcp` over stdio, driven by
// the MCP SDK client — the same path Claude Code and Codex take through .mcp.json.
// Then the data has to *move*: a function added to the fixture's source must show
// up through refresh_graph, and through the viewer server's POST /api/sync + /graph.
//
// Serial and self-contained: this file owns its own temp workspace and its own
// server on port 4511 (checked free first — a negative result may be someone
// else's server), and stops that server by its pid, never by a command pattern.
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CLI, makeWorkspace } from '../fixture/workspace.mjs';

const SYNC_PORT = Number(process.env['FARSIGHT_E2E_SYNC_PORT'] || 4511);
const REPO = 'invoice-app';
const PROBE = 'e2eProbeSurcharge';
const PROBE_ID = `${REPO}::src/server/taxEngine.ts::${PROBE}`;

test.describe.configure({ mode: 'serial' });

type Ws = { dir: string; graph: string; repoDir: string; cleanup: () => void };
let ws: Ws;
let client: Client;
let server: ChildProcess | undefined;

/** One MCP tool call → its text content. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content ?? []) as { type: string; text?: string }[];
  expect(res.isError ?? false, `${name} returned an error: ${content.map((c) => c.text).join('\n')}`).toBe(false);
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

const base = `http://127.0.0.1:${SYNC_PORT}`;

test.beforeAll(async () => {
  ws = makeWorkspace('mcp') as Ws;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--graph', ws.graph],
    cwd: ws.dir,
    stderr: 'ignore',
  });
  client = new Client({ name: 'farsight-e2e', version: '0.0.0' });
  await client.connect(transport);
});

test.afterAll(async () => {
  await client?.close();
  if (server?.pid) server.kill('SIGTERM');
  ws?.cleanup();
});

test.describe('MCP data flow', () => {
  /** @covers packages/mcp/src/run.ts::runMcpServer */
  test('the server lists the tools agents depend on', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const t of ['graph_overview', 'search_graph', 'describe_node', 'test_coverage', 'refresh_graph', 'journey', 'impact_of']) {
      expect(names).toContain(t);
    }
  });

  /** @covers packages/mcp/src/run.ts::runMcpServer */
  test('graph_overview describes the fixture graph and its freshness', async () => {
    const out = await call('graph_overview');
    expect(out).toContain('Farsight semantic graph: 107 nodes'); // 87 parts + 8 packages + 12 module nodes
    expect(out).toContain(`repos: ${REPO}`);
    expect(out).toContain('sync:1');
  });

  /** @covers packages/mcp/src/run.ts::runMcpServer */
  test('search_graph and describe_node agree on a node the viewer also draws', async () => {
    const found = await call('search_graph', { query: 'computeTax' });
    expect(found).toContain(`\`${REPO}::src/server/taxEngine.ts::computeTax\``);
    const detail = await call('describe_node', { node_id: `${REPO}::src/server/taxEngine.ts::computeTax` });
    expect(detail).toContain('Tax is charged by the customer');
    expect(detail).toContain('src/server/taxEngine.ts:9');
  });

  /** @covers packages/mcp/src/run.ts::runMcpServer */
  test('test_coverage carries the fixture\'s observed e2e run for a flow', async () => {
    const catalogue = await call('test_coverage', { level: 'e2e' });
    expect(catalogue).toContain('billing.pw.spec.ts');
    const raw = JSON.parse(await call('test_coverage', { flow: 'billing-cycle', raw: true }));
    expect(JSON.stringify(raw)).toContain('billing-cycle');
  });

  /**
   * @covers packages/mcp/src/run.ts::runMcpServer
   * @covers packages/server/src/index.ts::serveGraph
   * @covers POST /api/sync
   * @covers GET /graph
   */
  test('a function added to the source appears through refresh_graph and through the server\'s /api/sync', async ({ request }) => {
    expect(await portInUse(SYNC_PORT), `port ${SYNC_PORT} is taken — this spec will not test someone else's server`).toBe(false);
    server = spawn(process.execPath, [CLI, 'serve', ws.graph, '--port', String(SYNC_PORT)], { cwd: ws.dir, stdio: 'ignore' });
    await expect.poll(async () => (await request.get(`${base}/api/version`).catch(() => null))?.ok() ?? false, { timeout: 15_000 }).toBe(true);

    const nodeIds = async () => ((await (await request.get(`${base}/graph`)).json()).nodes as { id: string }[]).map((n) => n.id);
    expect(await nodeIds()).not.toContain(PROBE_ID);
    expect(await call('search_graph', { query: PROBE })).not.toContain(PROBE_ID);

    // the change: one new exported function in the fixture copy
    appendFileSync(join(ws.repoDir, 'src/server/taxEngine.ts'), [
      '',
      '/**',
      ' * Added by the MCP e2e spec to prove a source change reaches every surface.',
      ' * @business A flat surcharge the e2e suite adds and then looks for.',
      ' */',
      `export function ${PROBE}(amount: number): number {`,
      '  return amount + 1;',
      '}',
      '',
    ].join('\n'));

    // MCP: refresh_graph re-ingests the recorded root in place and saves graph.json
    const refreshed = await call('refresh_graph');
    expect(refreshed).toMatch(/re-ingested 1 source root\(s\): 108 nodes, \d+ edges \(was 107\//);
    expect(await call('search_graph', { query: PROBE })).toContain(PROBE_ID);
    expect(await call('describe_node', { node_id: PROBE_ID })).toContain('A flat surcharge the e2e suite adds');
    const onDisk = JSON.parse(readFileSync(ws.graph, 'utf8')) as { nodes: { id: string }[] };
    expect(onDisk.nodes.map((n) => n.id)).toContain(PROBE_ID);

    // viewer server: POST /api/sync re-ingests the workspace sources; /graph then serves the node
    const sync = await request.post(`${base}/api/sync`);
    expect(sync.ok(), await sync.text()).toBe(true);
    expect(await nodeIds()).toContain(PROBE_ID);
    const version = await (await request.get(`${base}/api/version`)).json();
    expect(version.currency.ok).toBe(true);
  });
});
