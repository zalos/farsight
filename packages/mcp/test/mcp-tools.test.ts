/**
 * The MCP surface, driven as an agent drives it: the built server
 * (`createMcpServer` from dist/) on an in-memory transport, a real MCP client,
 * and a graph ingested by the built CLI from a *copy* of `examples/invoice-app`
 * in a temp directory — ingested twice, with one test file removed in between,
 * so the snapshot store next to the graph holds two syncs and a real change.
 *
 * What is pinned:
 * 1. **Presence** — every tool name, and that each description tells an agent
 *    when to use it. A tool that disappears or is renamed breaks every agent
 *    config that names it.
 * 2. **Key output fields** — the lines an agent reads to decide, per tool.
 * 3. **One fold, many lenses** — the numbers a tool prints are the core fold's
 *    (journeySummary counts, impactOf hop counts), computed here in process.
 * 4. **The frozen contracts** — `impact_of format:"impact-tests"`,
 *    `test_coverage matrix:"json"` and `graph_changes format:"json"` validate
 *    against their schema files.
 *
 * Nothing here touches the workspace graph or ports 4477 / 4478.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  buildIndex, impactOf, journey, journeySummary, resolveEntry, screensFor, countedLine, SnapshotDb, journeyTree, journeyTreeLines,
  type GraphEdge, type GraphIndex, type GraphNode,
} from '@farsight/core';
import { WorkCache, workDbPath } from '@farsight/work';
import { INVOICE_APP_FIXTURE } from '@farsight/work-fixture';
import { createMcpServer } from '../dist/run.js';
import { validate } from '../../core/test/validate.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/cli.js');
const schema = (name: string) => JSON.parse(readFileSync(join(repoRoot, 'schemas', name), 'utf8'));

const TOOLS = [
  'api_drift', 'api_spec', 'api_surface',
  'config_files',
  'describe_node',
  'design_drift', 'design_guide', 'design_surface',
  'gate',
  'graph_changes', 'graph_overview',
  'impact_of', 'journey', 'journeys', 'list_rules', 'model_hub_state', 'refresh_graph',
  'search_graph', 'stories', 'test_coverage', 'trace_flow',
  // work items: always registered
  'work_changes', 'work_item', 'work_items', 'work_links', 'work_sync',
];
// registered only because the test workspace's edit-mode source grants agents these actions
const WORK_WRITE = ['work_assign', 'work_comment'];
const ALL_TOOLS = [...TOOLS, ...WORK_WRITE].sort();

/**
 * The work source the test workspace declares: the recorded invoice-app tracker
 * (a copy — the fixture provider writes served.json / applied.jsonl beside it),
 * in edit mode; agents may comment (without a person confirming), people may
 * assign, and an agent may assign only a done item — so work_assign exists but
 * an agent assigning an open story is denied by the policy.
 */
const WORK_SOURCE = (mode: 'edit' | 'read-only') => ({
  id: 'invoice-jira', type: 'work', provider: 'fixture', path: 'work-fixture/invoice-app', scope: { projects: ['INV'] }, mode,
  permissions: {
    agentWrites: 'allow',
    grants: [
      { actions: ['comment'], principals: ['agent', 'human'] },
      { actions: ['assign'], principals: ['human'] },
      { actions: ['assign'], principals: ['agent'], scope: { states: ['done'] } },
    ],
  },
});
function writeWorkspace(dir: string, mode: 'edit' | 'read-only'): void {
  mkdirSync(join(dir, '.farsight'), { recursive: true });
  cpSync(INVOICE_APP_FIXTURE, join(dir, 'work-fixture/invoice-app'), { recursive: true });
  writeFileSync(join(dir, '.farsight', 'settings.json'), JSON.stringify({ defaultLens: 'hybrid', sources: [WORK_SOURCE(mode)], collections: [] }, null, 2));
}
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Ada Okafor', '-c', 'user.email=ada@invoice-app.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

const TABLE = 'invoice-app::table::invoices';
const FINALIZE = 'invoice-app::route::POST /invoices/:id/finalize';
const ADMIN = 'invoice-app::guard::requireScope(billing:admin)';

let work: string;
let graph: string;
let index: GraphIndex;
let client: Client;

function ingest(): void {
  const r = spawnSync(process.execPath, [cli, 'ingest', join(work, 'invoice-app'), '--repo', 'invoice-app', '--out', graph], { cwd: work, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text: string }[];
  return content.map((c) => c.text).join('\n');
}

before(async () => {
  // realpath: macOS /tmp is a symlink, and the CLI compares resolved paths
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-mcp-')));
  // the runtime overlay reads a directory, never this machine's own
  process.env.MODELHUB_DIR = join(work, 'modelhub');
  graph = join(work, 'graph.json');
  cpSync(join(repoRoot, 'examples/invoice-app'), join(work, 'invoice-app'), { recursive: true });
  // a history whose last commit names INV-5 (to do on the tracker) and changes finalizeInvoice's first line
  const app = join(work, 'invoice-app');
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'chore: the invoice app');
  const svc = join(app, 'src/server/invoiceService.ts');
  writeFileSync(svc, readFileSync(svc, 'utf8').replace('export async function finalizeInvoice(id: string) {', 'export async function finalizeInvoice(id: string) { // approval comes first'));
  git(app, 'commit', '-q', '-am', 'INV-5: an invoice is approved before it is finalized');
  // the work source is configured before ingest, so ingest reads the keys each commit names
  writeWorkspace(work, 'edit');
  ingest();
  // sync 2 drops a unit test file, so the diff between the two carries test_removed
  rmSync(join(work, 'invoice-app/test/rates.spec.ts'));
  ingest();
  const data = JSON.parse(readFileSync(graph, 'utf8')) as { nodes: GraphNode[]; edges: GraphEdge[] };
  index = buildIndex(data.nodes, data.edges);

  const { server } = createMcpServer(graph);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'mcp-tools-test', version: '0' });
  await client.connect(clientSide);
  // the work cache is filled the way an agent fills it
  const synced = await call('work_sync');
  assert.match(synced, /invoice-jira · sync 1/, synced);
});

after(async () => {
  try { await client?.close(); } catch { /* closing a closed transport is not a failure */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
});

describe('presence', () => {
  test('every tool is registered under its name', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);
  });

  test('every description is long enough to say when to use the tool', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      assert.ok((t.description ?? '').length >= 150, `${t.name} has a thin description`);
      assert.match(t.description ?? '', /\buse\b/i, `${t.name} does not say when to use it`);
    }
  });

  test('input shapes the e2e lane and existing agents rely on are still accepted', async () => {
    const { tools } = await client.listTools();
    const props = (name: string) => Object.keys((tools.find((t) => t.name === name)!.inputSchema as { properties?: object }).properties ?? {});
    assert.ok(props('search_graph').includes('query'));
    assert.ok(props('describe_node').includes('node_id'));
    assert.ok(props('impact_of').includes('node_id'));
    assert.ok(props('list_rules').includes('query'));
    for (const k of ['flow', 'node', 'test', 'gaps', 'raw', 'matrix']) assert.ok(props('test_coverage').includes(k), `test_coverage.${k}`);
    assert.ok(props('journey').includes('view'));
  });
});

describe('orient and find', () => {
  test('graph_overview leads with the state of play, then counts, names the history, and ends with currency', async () => {
    const out = await call('graph_overview');
    // the front door's three columns first (round 2026-10-10), each number with the command that prints it again
    assert.match(out, /^## state of play\nState of play — /);
    assert.match(out, /Built and walkable:\n- .*— re-check: farsight /);
    assert.match(out, /Validated by a run:/);
    assert.match(out, /Still open:/);
    assert.match(out, new RegExp(`^Farsight semantic graph: ${index.byId.size} nodes`, 'm'));
    assert.match(out, /history: 2 snapshot\(s\), sync 1–2/);
    assert.match(out, /## keeping current/);
    assert.match(out, /tests: \d+ case\(s\)/);
  });

  test('search_graph returns ids another tool can take', async () => {
    const out = await call('search_graph', { query: 'finalize' });
    assert.ok(out.includes(`\`${FINALIZE}\``) || out.includes('finalize'), out);
  });
});

describe('gate — one gate answered (swarm-fixes 2026-10-05, finding 4)', () => {
  test('the calls it guards with file:line, the tests that reach it, and describe_node prints the same section', async () => {
    const id = 'invoice-app::guard::requireScope(billing:write)';
    const out = await call('gate', { node_id: id });
    assert.match(out, /## gate — gate \(guard\)/);
    assert.match(out, /calls it guards: 2 of \d+ calls for this gate/);
    assert.match(out, /POST \/invoices — guarded directly · src\/server\/[\w./-]+:\d+/);
    assert.match(out, /tests that reach it: /);
    const node = await call('describe_node', { node_id: id, context: false });
    assert.match(node, /## gate — gate \(guard\)/);
    assert.match(await call('gate', { node_id: 'nope::x' }), /unknown gate/);
  });
});

describe('describe_node — what to know before changing it', () => {
  test('a route: gates in force, consumers, journeys, and dependents per hop', async () => {
    const out = await call('describe_node', { node_id: FINALIZE });
    assert.match(out, /## before you change it/);
    const report = impactOf(index, FINALIZE, { hops: 3, direction: 'upstream', perHopCap: 200 });
    assert.match(out, new RegExp(`used by: ${report.hops[0]!.found} use it directly`));
    assert.match(out, /⇢ \[route\] POST \/invoices\/:id\/finalize · this node — 🔒 requireScope: billing:admin/);
    assert.match(out, /API: contract \S+ · \d+ consumer\(s\)/);
    assert.match(out, /journeys: in \d+ — /);
    // never a sum: the three hop counts are not added anywhere
    const total = report.hops.reduce((a, h) => a + h.found, 0);
    if (report.hops.length > 1) assert.ok(!new RegExp(`\\b${total} (thing|node|dependent)`).test(out));
  });

  test('a guard says what it applies to', async () => {
    const out = await call('describe_node', { node_id: ADMIN });
    assert.match(out, /applies to 2: /);
  });

  test('context:false keeps the old shape', async () => {
    const out = await call('describe_node', { node_id: FINALIZE, context: false });
    assert.ok(!out.includes('## before you change it'));
    assert.match(out, /← guards by requireScope/);
  });
});

describe('dependencies — packages as nodes', () => {
  test('describe_node on a package: scope · range · declared in · importers · journeys reached', async () => {
    const out = await call('describe_node', { node_id: 'invoice-app::package::react' });
    assert.match(out, /^\[package\] react — \(no source loc\)/);
    assert.match(out, /package: third-party · declared \^18\.3\.1 in package\.json/);
    assert.match(out, /4 files import it for this package · 3 journeys reach it for this package — /);
    assert.match(out, /farsight deps where react/);
    const ws = await call('describe_node', { node_id: 'invoice-app::package::@invoice/plumbing' });
    assert.match(ws, /package: workspace · project @invoice\/plumbing · src\/server\/plumbing · resolved by alias or workspace name/);
    const sdk = await call('describe_node', { node_id: 'invoice-app::package::@azure-rest/ai-document-intelligence' });
    assert.match(sdk, /the SDK of Azure Document Intelligence/);
  });

  test('search_graph matches package names and filters by kind; graph_overview counts the dependencies', async () => {
    const out = await call('search_graph', { query: 'date-fns' });
    assert.match(out.split('\n')[0]!, /^\[package\] date-fns/);
    const pk = await call('search_graph', { query: 'react', kind: 'package' });
    assert.ok(pk.split('\n').every((l) => l.startsWith('[package]')), pk);
    const overview = await call('graph_overview');
    assert.match(overview, /dependencies: 8 packages \(7 third-party · 1 from this workspace\)/);
  });
});

describe('stories — read from the story files, drawn by a Storybook nobody here starts', () => {
  const FORM = 'invoice-app::src/ui/CreateInvoiceForm.tsx::CreateInvoiceForm';
  // the fixture's config names http://127.0.0.1:4539; nothing in this suite listens there, and the
  // e2e lane's fake Storybook may — so the line is matched for either state, never assumed
  const BOOK = /Storybook Invoice app UI at http:\/\/127\.0\.0\.1:4539: (not reached \(\w+\) — start it with `npm run storybook`; Farsight never starts it|running — )/;

  test('describe_node lists a component\'s stories by id and name, and the Storybook\'s state', async () => {
    const out = await call('describe_node', { node_id: FORM, context: false });
    assert.match(out, /## stories \(3\)/);
    assert.match(out, BOOK);
    assert.match(out, /story With line items `invoices-createinvoiceform--with-line-items` \(Invoices\/CreateInvoiceForm\) — src\/ui\/CreateInvoiceForm\.stories\.tsx:\d+/);
    assert.match(out, /A customer picked and one line item filled in, ready to save\./);
  });

  test('a node outside any story says nothing about stories', async () => {
    const out = await call('describe_node', { node_id: FINALIZE, context: false });
    assert.ok(!out.includes('## stories'));
  });

  test('the stories tool: counts from the files, the Storybook line, and the components that carry stories', async () => {
    const out = await call('stories', {});
    assert.match(out, /invoice-app: 3 stories over 1 components from 1 story file\(s\)/);
    assert.match(out, BOOK);
    assert.match(out, new RegExp(`Invoices/CreateInvoiceForm — 3 stories.*\`${FORM.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\``));
    const one = await call('stories', { node: FORM });
    assert.match(one, /## stories \(3\)/);
  });

  test('graph_overview carries one stories line per repo', async () => {
    const out = await call('graph_overview');
    assert.match(out, /stories: invoice-app — 3 stories over 1 components from 1 story file\(s\) · Storybook http:\/\/127\.0\.0\.1:4539/);
  });
});

describe('list_rules — gates and rules as separate lists', () => {
  test('guards, validation, config schemas and planned gates are split, with the scope named', async () => {
    const out = await call('list_rules', { query: 'invoice' });
    assert.match(out, /^scope: the \d+ node\(s\) within 3 hop\(s\) of the seed\(s\), both directions/m);
    assert.match(out, /## gates — guards \(\d+\)/);
    assert.match(out, /## gates — validation rules \(\d+\)/);
    assert.match(out, /applies to \d+: /);
  });

  test('an env schema is listed apart and never as a gate', async () => {
    const out = await call('list_rules', { query: 'loadEnv' });
    assert.match(out, /## config & env schemas \(1\)[\s\S]*appEnvSchema/);
    const gates = out.split('## config & env schemas')[0]!;
    assert.ok(!gates.includes('appEnvSchema'));
  });

  test('a spec-only route carries its security as a planned gate', async () => {
    const out = await call('list_rules', { query: 'DELETE /invoices' });
    assert.match(out, /## planned — the spec requires it on a route that is not built \(1\)\n🔒 billingAuth/);
  });
});

describe('journey', () => {
  test('the header counts are journeySummary\'s', async () => {
    const seed = resolveEntry(index, 'new-invoice')!;
    const sum = journeySummary(index, journey(index, seed.id), screensFor(index, seed.id));
    const k = sum.counts;
    const out = await call('journey', { entry: 'new-invoice' });
    // the typed counts, grouped by the scope they count over (docs/COUNTS.md) — the same
    // numbers, under the same words, the HUD prints; nothing counted twice or recounted here
    const q = sum.counted!;
    const line = countedLine([q.screens, q.built, q.gates, q.checks, q.decisions, q.notInWords, q.actions, q.again, q.declaredNotCalled, q.actionStops], { lens: 'code' });
    assert.ok(out.includes(`${line} · ${k.records} record(s) · ${k.messages} message(s)`), out.split('\n').slice(0, 4).join('\n'));
    assert.match(line, /^across this journey: /, 'the scope is printed, once, before the numbers it scopes');
    if (k.gates) assert.ok(line.includes(`${k.gates} gate`), 'the gates number is summary.counts.gates');
    assert.match(out, /## what the system does/);
  });

  test('view:business is the storyboard — screens, actions, gates — with no code paths', async () => {
    const out = await call('journey', { entry: 'draft-and-send', view: 'business' });
    assert.match(out, /^## 1 · /m);
    assert.match(out, /^• /m);
    assert.ok(!/\.tsx?:\d+/.test(out), 'the business view printed a code location');
  });
});

describe('journeys', () => {
  /** the tree the tool prints, from the graph file the server loaded */
  const fold = () => {
    const data = JSON.parse(readFileSync(graph, 'utf8'));
    return journeyTree(buildIndex(data.nodes, data.edges), data.meta.journeys, null);
  };

  test('text: persona, then group, then one line per journey — the core fold, line for line', async () => {
    const out = await call('journeys');
    assert.equal(out, journeyTreeLines(fold(), { openHint: '(open with journey)' }).join('\n'));
    assert.match(out, /^3 journeys · 1 storyline · 2 personas · 3 groups across every source in scope$/m);
    assert.match(out, /^## Storylines — 1 storyline$/m);
    assert.match(out, /^1\. Start a new invoice — .*`invoice-app::flow::new-invoice` \(open with journey\)$/m);
    assert.ok(out.indexOf('## Storylines') < out.indexOf('## Billing'), 'the storylines come before the personas');
    assert.match(out, /^## Billing — 3 journeys/m);
    assert.match(out, /^### Invoices — 2 journeys/m);
    assert.match(out, /^- Billing cycle — partly built · 2 of 3 · start here · `invoice-app::flow::billing-cycle` \(open with journey\)$/m);
    // the fixture's config moves draft-and-send into Review and send; it is under both personas
    assert.match(out, /^- Draft and send an invoice — .* · also under Operations · placed by farsight\.config\.json · /m);
    assert.ok(out.indexOf('## Billing') < out.indexOf('## Operations'), 'declared order, not alphabetical');
  });

  test('persona and group filters, and json is the JourneyTree', async () => {
    const ops = await call('journeys', { persona: 'operations' });
    assert.match(ops, /^1 journey · 1 storyline · 1 persona · 1 group /m);
    assert.ok(!ops.includes('## Billing'));
    const none = await call('journeys', { group: 'nope' });
    assert.match(none, /no journey under group "nope"/);
    const json = JSON.parse(await call('journeys', { json: true }));
    assert.deepEqual(json, JSON.parse(JSON.stringify(fold())));
    assert.deepEqual(json.personas.map((p: { id: string }) => p.id), ['billing', 'ops']);
  });

  test('design_guide says how to organise them: personas, groups, persona lists, order, the config block, nested configs', async () => {
    const guide = await call('design_guide');
    for (const words of ['personas[] { id, name, description? }', 'groups[] { id, name, description?, persona? }', 'flows[].persona', 'flows[].group', 'flows[].order',
      'flows[].owner', 'flows[].work', 'surfaces[]', '{ "journeys": {', 'storylines[] { id, name, description?, journeys }', '"storylines"', '{ id, branchOf,\n  when, rejoins? }', 'below the source root applies to its', '"projects" and "tooling" are read from the root file only']) {
      assert.ok(guide.includes(words), `design_guide does not say ${words}`);
    }
  });

  test('graph_overview has the journeys line and journey names where a flow sits', async () => {
    const overview = await call('graph_overview');
    assert.match(overview, /^journeys: 3 journeys · 1 storyline · 2 personas · 3 groups across every source in scope — first: Billing › Invoices · Operations › Review and send — the journeys tool lists them by storyline, then persona and group/m);
    const j = await call('journey', { entry: 'draft-and-send' });
    assert.match(j, /^shown under: Billing › Review and send · Operations › Review and send \(start here\)$/m);
    // the fixture declares this journey a branch: what it leaves from, when, and where it comes back
    assert.match(j, /^in storyline: An invoice, end to end · branch of Start a new invoice \(`invoice-app::flow::new-invoice`\) · when Operations reviews the draft before it is sent · back to Billing cycle \(`invoice-app::flow::billing-cycle`\)$/m);
    const step = await call('journey', { entry: 'billing-cycle' });
    assert.match(step, /^in storyline: An invoice, end to end · step 2 of 2 · before: `invoice-app::flow::new-invoice`$/m);
  });

  test('storyline: one storyline\'s steps and only its journeys; an unknown one says so', async () => {
    const out = await call('journeys', { storyline: 'invoice' });
    assert.match(out, /^3 journeys · 1 storyline · /m);
    assert.match(out, /^### An invoice, end to end \(`invoice`\) — 3 journeys \(2 on the main path · 1 branch\) · /m);
    assert.match(out, /^2\. Billing cycle — /m);
    // the branch, indented under the step it leaves from, with its condition and its way back
    assert.match(out, /^1\. Start a new invoice — .*\n   ↳ Draft and send an invoice · branch of Start a new invoice · when Operations reviews the draft before it is sent · back to Billing cycle — .*`invoice-app::flow::draft-and-send`/m);
    assert.equal(await call('journeys', { storyline: 'nope' }), 'No storyline called “nope” is declared here. Storylines declared here: invoice (An invoice, end to end)');
    const json = JSON.parse(await call('journeys', { storyline: 'invoice', json: true }));
    assert.deepEqual(json.storylines[0].journeys.map((j: { id: string }) => j.id), ['new-invoice', 'billing-cycle']);
    assert.deepEqual(json.storylines[0].branches.map((b: any) => [b.id, b.branchOf, b.when, b.rejoins]),
      [['draft-and-send', 'invoice-app::flow::new-invoice', 'Operations reviews the draft before it is sent', 'invoice-app::flow::billing-cycle']]);
    assert.ok(json.personas.every((p: any) => p.groups.every((g: any) => g.journeys.every((j: any) => j.storylines.includes('invoice')))));
  });
});

describe('impact_of', () => {
  test('text: every hop count is the fold\'s, and the checkout currency is said', async () => {
    const report = impactOf(index, TABLE, { hops: 2 });
    const out = await call('impact_of', { node_id: TABLE });
    assert.match(out, new RegExp(`${report.hops[0]!.found} thing\\(s\\) use it directly`));
    for (const h of report.hops) assert.match(out, new RegExp(`## hop ${h.hop} — [^(]+\\(${h.found} · `));
    assert.match(out, /checkout (still matches|no longer matches)|whether the checkout still matches/);
    assert.match(out, /tests reaching hop 1/);
  });

  test('format:"impact-tests" is farsight-impact-tests v1', async () => {
    const doc = JSON.parse(await call('impact_of', { node_id: TABLE, format: 'impact-tests' }));
    assert.equal(doc.schema, 'farsight-impact-tests v1');
    assert.deepEqual(validate(doc, schema('farsight-impact-tests-v1.schema.json')), []);
  });

  test('changed: a file range resolves to the nodes defined in it', async () => {
    const fn = [...index.byId.values()].find((n) => n.kind === 'function' && n.loc?.path === 'src/server/invoiceService.ts')!;
    const doc = JSON.parse(await call('impact_of', { changed: [`src/server/invoiceService.ts:${fn.loc!.line}`], format: 'impact-tests' }));
    assert.ok(doc.seeds.some((s: { id: string; from: string }) => s.id === fn.id && s.from === 'hunk'), JSON.stringify(doc.seeds));
    const none = await call('impact_of', { changed: ['no/such/file.ts:1-2'] });
    assert.match(none, /no node in the graph is defined in no\/such\/file\.ts:1-2/);
  });

  test('format:"json" is the bare report', async () => {
    const r = JSON.parse(await call('impact_of', { node_id: TABLE, format: 'json' }));
    assert.equal(r.seed.id, TABLE);
    assert.ok(Array.isArray(r.hops));
    assert.ok(!('total' in r));
  });
});

describe('test_coverage — unit and e2e', () => {
  test('the catalogue names its identity, its files with last run, and the matrix', async () => {
    const out = await call('test_coverage');
    assert.match(out, /^as of sync 2/m);
    assert.match(out, /## files \(\d+\) — failing, flaky and stale first/);
    assert.match(out, /## journeys × tests/);
    assert.match(out, /· e2e · /);
    assert.match(out, /· unit · /);
  });

  test('node: prints the step fold beside the covering tests', async () => {
    const covered = [...index.byId.values()].find((n) => n.kind === 'function' && (index.in.get(n.id) ?? []).some((e) => e.kind === 'covers'))!;
    const out = await call('test_coverage', { node: covered.id });
    assert.match(out, /verified by \d+ test\(s\) — e2e \d+ · unit\/integration \d+/);
  });

  test('matrix:"json" is farsight-tests-matrix v1; raw carries the identity', async () => {
    const doc = JSON.parse(await call('test_coverage', { matrix: 'json' }));
    assert.equal(doc.schema, 'farsight-tests-matrix v1');
    assert.deepEqual(validate(doc, schema('farsight-tests-matrix-v1.schema.json')), []);
    const csv = await call('test_coverage', { matrix: 'csv' });
    assert.ok(csv.split('\n')[0]!.includes(','));
    const raw = JSON.parse(await call('test_coverage', { raw: true }));
    assert.equal(raw.identity.sync, 2);
  });
});

describe('graph_changes — change history', () => {
  test('list:true names the two syncs', async () => {
    const out = await call('graph_changes', { list: true });
    assert.match(out, /^sync:2 · /m);
    assert.match(out, /^sync:1 · /m);
  });

  test('the default compares the latest with the one before, and names the removed test', async () => {
    const out = await call('graph_changes');
    assert.match(out, /^# changes sync:1 .*→ sync:2/m);
    assert.match(out, /test_removed \d+/);
  });

  test('format:"json" is farsight-diff v1', async () => {
    const doc = JSON.parse(await call('graph_changes', { format: 'json' }));
    assert.equal(doc.schema, 'farsight-diff v1');
    assert.deepEqual(validate(doc, schema('farsight-diff-v1.schema.json')), []);
    assert.ok(doc.counts.test_removed >= 1);
  });

  test('a bad ref is a sentence', async () => {
    assert.match(await call('graph_changes', { to: 'yesterday' }), /to expects sync:<N>/);
  });
});

describe('the rest of the surface answers', () => {
  test('trace_flow, api_surface, api_spec, api_drift', async () => {
    assert.match(await call('trace_flow', { query: FINALIZE }), /^# flow: /);
    assert.match(await call('api_surface'), /API surfaces/);
    assert.match(await call('api_spec', { repo: 'invoice-app' }), /"openapi"/);
    assert.match(await call('api_drift'), /drift/);
  });

  test('design_surface, design_drift, design_guide', async () => {
    assert.match(await call('design_surface'), /Design sources/);
    assert.match(await call('design_drift'), /drift/);
    assert.ok((await call('design_guide')).length > 500);
  });

  test('model_hub_state answers without a Model Hub', async () => {
    assert.match(await call('model_hub_state'), /Model Hub/);
  });

  test('refresh_graph re-ingests the recorded root in place', async () => {
    assert.match(await call('refresh_graph'), /re-ingested 1 source root\(s\)/);
  });
});

describe('work items — read from the local copy, written only where granted', () => {
  const INV5 = 'work::invoice-jira::INV-5';
  const spineKnowsKeys = typeof (SnapshotDb.prototype as unknown as { commitsForKey?: unknown }).commitsForKey === 'function';

  test('graph_overview names the source, its freshness, the items by state, and the granted write tools', async () => {
    const out = await call('graph_overview');
    assert.match(out, /## work items/);
    assert.match(out, /invoice-jira · fixture · .* · synced/i);
    assert.match(out, /8 work items/);
    assert.match(out, /agent writes: work_assign, work_comment/);
  });

  test('work_items: freshness first, one row per item with the tracker status beside its category', async () => {
    const out = await call('work_items');
    const first = out.split('\n')[0]!;
    assert.match(first, /^invoice-jira · fixture/);
    assert.match(out, /- INV-5 · Story · To Do · .* Approve an invoice before it is sent/);
    assert.match(out, /links? to the graph/);
    const todo = await call('work_items', { state: 'todo' });
    assert.ok(!todo.includes('- INV-2 '), todo);
    assert.match(await call('work_items', { q: 'rounds' }), /INV-6/);
  });

  test('work_items format:"json" is the frozen farsight-work v1 list document', async () => {
    const doc = JSON.parse(await call('work_items', { format: 'json' }));
    assert.equal(doc.schema, 'farsight-work v1');
    assert.equal(doc.items.length, 8);
    assert.deepEqual(validate(doc, schema('farsight-work-v1.schema.json')), []);
  });

  test('work_item prints the description, comments with authors and times, and the history', async () => {
    const out = await call('work_item', { key: 'INV-8' });
    assert.match(out, /^invoice-jira · fixture/);
    assert.match(out, /# INV-8 · Bug · Done/);
    assert.match(out, /## history — on this item: 2 field changes/);
    assert.match(out, /- \d{4}-\d\d-\d\d \d\d:\d\d · .* · status: /);
    const commented = await call('work_item', { key: 'INV-1' });
    assert.match(commented, /## comments — on this item: \d+ comments?/);
    assert.match(await call('work_item', { key: 'NOPE-1' }), /no work item NOPE-1/);
  });

  test('work_links answers from a node, with the scope named', async () => {
    const out = await call('work_links', { node_id: FINALIZE });
    assert.match(out, /for this part alone: \d+ work items?/);
  });

  test('work_comment applies, prefixed as the agent, and the audit row names the agent', async () => {
    const out = await call('work_comment', { key: 'INV-5', body: 'the approval step is built' });
    assert.match(out, /policy: yes/);
    assert.match(out, /tracker: yes/);
    assert.match(out, /credential: yes/);
    assert.match(out, /outcome: applied/);
    assert.match(out, /last comment: .*via Farsight \(agent\): the approval step is built/);
    const cache = new WorkCache(workDbPath(work));
    try {
      const rows = cache.listAudit({ item: INV5 });
      const row = rows.find((r) => r.outcome === 'confirmed' && r.action === 'comment');
      assert.ok(row, JSON.stringify(rows));
      assert.equal(row!.requestedBy!.kind, 'agent');
      assert.equal(row!.requestedBy!.tool, 'work_comment');
    } finally {
      cache.close();
    }
  });

  test('work_assign on an open story is denied for an agent, with three verdicts', async () => {
    const out = await call('work_assign', { key: 'INV-5', assignee: '5b10ac8d82e05b22cc7d4ef5' });
    assert.match(out, /policy: no — /);
    assert.match(out, /tracker: no — not asked/);
    assert.match(out, /credential: no — not asked/);
    assert.match(out, /outcome: denied — nothing was written/);
  });

  test('work_changes: the commits that name a to-do story, what they touched, and the impact per hop', { skip: spineKnowsKeys ? false : 'the commit spine in this build records no work keys (Lane D, feat/work-graph, not merged)' }, async (t) => {
    const out = await call('work_changes', { key: 'INV-5' });
    if (/history not indexed/.test(out)) { t.skip(`CLI ingest wrote no commit keys in this build: ${out.split('\n').at(-1)}`); return; }
    assert.match(out, /INV-5: an invoice is approved before it is finalized/);
    assert.match(out, /touched: .*function/);
    assert.match(out, /hop 1: \d+/);
    const sha = /## ([0-9a-f]{10}) /.exec(out)![1]!;
    const diff = await call('work_changes', { sha });
    assert.match(diff, /approval comes first/);
    assert.match(await call('work_item', { key: 'INV-5' }), /todo-but-committed/);
  });

  test('work_changes without the spine says so, and a sha is still readable', async () => {
    const out = await call('work_changes', { key: 'INV-2' });
    assert.ok(/history not indexed|no commit on the history spine names INV-2/.test(out), out);
    assert.match(await call('work_changes', { sha: 'zz' }), /7–40 hex/);
  });

  test('a read-only source registers no write tool, and the overview says so', async () => {
    const ro = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-mcp-ro-')));
    try {
      cpSync(graph, join(ro, 'graph.json'));
      writeWorkspace(ro, 'read-only');
      const { server } = createMcpServer(join(ro, 'graph.json'));
      const [c, s] = InMemoryTransport.createLinkedPair();
      await server.connect(s);
      const other = new Client({ name: 'mcp-tools-test-ro', version: '0' });
      await other.connect(c);
      try {
        const { tools } = await other.listTools();
        assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
        const r = await other.callTool({ name: 'graph_overview', arguments: {} });
        const out = (r.content as { text: string }[]).map((x) => x.text).join('\n');
        assert.match(out, /agent writes: none/);
        assert.match(out, /work source invoice-jira: .*call work_sync/);
      } finally {
        await other.close();
      }
    } finally {
      rmSync(ro, { recursive: true, force: true });
    }
  });
});
