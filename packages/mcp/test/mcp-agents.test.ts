/**
 * What an agent gets (round 2026-10-10, proposal 9): the tool tiers, budgeted answers with `## left out` and
 * `expand`, and the session-start context — pure functions first, then the built server on an in-memory
 * transport over a graph ingested from a copy of `examples/invoice-app`, with a settings file that holds a
 * keychain reference beside the lessons (the context must never carry it).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/run.js';
import { cutToBudget, estimateTokens, idsIn, budgetFor, isJson, DEFAULT_BUDGET, MIN_BUDGET } from '../dist/budget.js';
import { resolveTier, inTier, tierOf, CORE_TOOLS, tierLine } from '../dist/tiers.js';
import { readAgentSettings, lessonsOf, sinceOf } from '../dist/context.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/cli.js');

describe('tiers', () => {
  test('settings win over the environment; core is the default; a word that is not a tier is ignored and kept', () => {
    assert.deepEqual(resolveTier(undefined, undefined), { tier: 'core', from: 'default' });
    assert.deepEqual(resolveTier(undefined, 'all'), { tier: 'all', from: 'env' });
    assert.deepEqual(resolveTier('core', 'all'), { tier: 'core', from: 'settings' });
    assert.deepEqual(resolveTier('everything', undefined), { tier: 'core', from: 'default', ignored: 'everything' });
  });
  test('the core tier is the nine plus affected, ask and roles; tools and expand are in both', () => {
    assert.deepEqual([...CORE_TOOLS].sort(), ['affected', 'ask', 'describe_node', 'gate', 'graph_overview', 'impact_of', 'journey', 'journeys', 'roles', 'search_graph', 'test_coverage', 'trace_flow']);
    for (const n of ['tools', 'expand']) { assert.ok(inTier(n, 'core')); assert.equal(tierOf(n), 'core'); }
    assert.ok(!inTier('refresh_graph', 'core'));
    assert.ok(inTier('refresh_graph', 'all'));
    assert.match(tierLine({ tier: 'core', from: 'default', on: 11, registered: 28 }), /core tier is on \(11 of 28 tools, from the default\).*FARSIGHT_TOOLS=all/);
  });
});

describe('budget', () => {
  const answer = [
    '# a list — 3 sections',
    'head line',
    '## first',
    ...Array.from({ length: 20 }, (_, i) => `row ${i} \`app::first::n${i}\``),
    '## second',
    '### segment 1 `app::page::/one`',
    ...Array.from({ length: 30 }, (_, i) => `  step ${i} ${'x'.repeat(40)}`),
    '### segment 2 `app::page::/two`',
    ...Array.from({ length: 30 }, (_, i) => `  step ${i} ${'y'.repeat(40)}`),
  ].join('\n');

  test('an answer that fits, and a JSON document, are returned whole', () => {
    assert.equal(cutToBudget(answer, 100_000).cut, false);
    const doc = JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ id: i })) });
    assert.ok(isJson(doc));
    assert.equal(cutToBudget(doc, MIN_BUDGET).text, doc);
  });

  test('over budget: a clean prefix, ## left out with the ids, the handle and the call; the whole stays under budget', () => {
    const r = cutToBudget(answer, 900, { tool: 'journey', args: { entry: 'x' } }, 'cut:7');
    assert.ok(r.cut);
    assert.ok(estimateTokens(r.text) <= 900, `${estimateTokens(r.text)} tokens`);
    assert.ok(r.text.startsWith('# a list — 3 sections\nhead line'));
    assert.match(r.text, /\n## left out\ncut to stay under the budget of 900 tokens \(a rough count: characters ÷ 4/);
    assert.match(r.text, /expand \{"ids":\["cut:7"\]\}/);
    assert.match(r.text, /or the whole answer: journey \{"entry":"x","budget":\d+\}/);
    // a deeper part is kept or left whole: segment 2 never appears half printed
    const kept = r.text.split('\n## left out')[0]!;
    if (kept.includes('### segment 2')) assert.ok(kept.includes('step 29 yyyy'));
    // every id the left-out parts held is named, and the JSON line carries them
    for (const id of r.excluded) assert.ok(r.text.includes(id));
    const json = JSON.parse(r.text.trim().split('\n').pop()!);
    assert.deepEqual(json.expand, { tool: 'expand', args: { ids: ['cut:7'] } });
    assert.ok(json.excluded_by_budget.includes('app::page::/two'));
    // nothing is lost: kept + left out is the answer
    const back = [kept.trimEnd(), ...r.leftOut.map((p) => p.text)].join('\n');
    for (const line of answer.split('\n')) assert.ok(back.includes(line), line);
  });

  test('the helpers: ids in backticks once each, the budget a call runs under', () => {
    assert.deepEqual(idsIn('a `x::y` b `x::y` c `nope` `p::q`'), ['x::y', 'p::q']);
    assert.equal(budgetFor(undefined, undefined), DEFAULT_BUDGET);
    assert.equal(budgetFor(undefined, 3000), 3000);
    assert.equal(budgetFor(2000, 3000), 2000);
    assert.equal(budgetFor(10, undefined), MIN_BUDGET);
  });
});

describe('context — settings read', () => {
  test('only mcp.tools, mcp.budget and the lessons are read; a source and its auth never are', () => {
    const dir = mkdtempSync(join(tmpdir(), 'farsight-ctx-'));
    try {
      mkdirSync(join(dir, '.farsight'));
      writeFileSync(join(dir, '.farsight', 'settings.json'), JSON.stringify({
        sources: [{ id: 'j', type: 'work', auth: { secret: 'keychain:farsight/jira-example', user: 'dev@example.com' } }],
        mcp: { tools: 'all', budget: 4000 },
        lessons: [{ text: 'pinned one', pinned: true, date: '2026-10-10T08:00:00Z' }, { text: '  ' }, { text: 'loose' }, 'junk'],
      }));
      const a = readAgentSettings(dir);
      assert.deepEqual(Object.keys(a).sort(), ['budget', 'lessons', 'tools']);
      assert.ok(!JSON.stringify(a).includes('keychain'));
      assert.deepEqual(a.lessons, [{ text: 'pinned one', pinned: true, date: '2026-10-10' }, { text: 'loose' }]);
      assert.deepEqual(readAgentSettings(join(dir, 'nowhere')), { lessons: [] });
      assert.equal(lessonsOf([{ text: 'z'.repeat(900) }])[0]!.text.length, 400);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('since: an ISO time the agent passes, else the last 24 hours', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    assert.deepEqual(sinceOf('2026-10-09', now), { at: '2026-10-09T00:00:00.000Z', given: true });
    assert.deepEqual(sinceOf(undefined, now), { at: '2026-10-09T12:00:00.000Z', given: false });
    assert.deepEqual(sinceOf('not a date', now), { at: '2026-10-09T12:00:00.000Z', given: false });
  });
});

describe('the server: the core tier by default, the context, expand', () => {
  let work: string;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as { text: string }[]).map((c) => c.text).join('\n'), isError: !!r.isError };
  };

  before(async () => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-mcp-agents-')));
    process.env.MODELHUB_DIR = join(work, 'modelhub');
    cpSync(join(repoRoot, 'examples/invoice-app'), join(work, 'invoice-app'), { recursive: true });
    const r = spawnSync(process.execPath, [cli, 'ingest', join(work, 'invoice-app'), '--repo', 'invoice-app', '--out', join(work, 'graph.json')], { cwd: work, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(work, '.farsight', 'settings.json'), JSON.stringify({
      defaultLens: 'hybrid', collections: [],
      sources: [{ id: 'jira-example', name: 'Jira', type: 'work', provider: 'jira', path: '', enabled: false, auth: { kind: 'api-token', user: 'dev@example.com', secret: 'keychain:farsight/jira-example' } }],
      lessons: [{ text: 'The e2e card is Playwright; the unit card is node:test.', pinned: true, date: '2026-10-10' }, { text: 'an unpinned note', pinned: false }],
    }));
    delete process.env.FARSIGHT_TOOLS;
    const { server, tier } = createMcpServer(join(work, 'graph.json'));
    assert.equal(tier, 'core');
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    client = new Client({ name: 'mcp-agents-test', version: '0' });
    await client.connect(c);
  });
  after(async () => {
    try { await client?.close(); } catch { /* closed */ }
    rmSync(work, { recursive: true, force: true });
  });

  test('tools/list is the core tier: nine, ask and roles (no code-host source, so no affected) plus tools and expand', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['ask', 'describe_node', 'expand', 'gate', 'graph_overview', 'impact_of', 'journey', 'journeys', 'roles', 'search_graph', 'test_coverage', 'tools', 'trace_flow']);
    for (const t of tools) assert.ok(Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).includes('budget'), `${t.name} takes budget`);
    assert.ok((await call('refresh_graph')).isError, 'a tool outside the tier is off');
  });

  test('graph_overview ends with the tier line; the tools tool lists every tool with its tier', async () => {
    const out = (await call('graph_overview')).text;
    assert.match(out.trim().split('\n').pop()!, /^tools: the core tier is on \(12 of \d+ tools, from the default\)/);
    const menu = (await call('tools')).text;
    assert.match(menu, /● journey · core — /);
    assert.match(menu, /○ refresh_graph · all · off in this session — /);
    assert.match(menu, /affected \(core\) is not registered/);
  });

  test('the context: the resource and graph_overview brief are one block, with the pinned lesson and never the secret', async () => {
    const res = await client.readResource({ uri: 'farsight://context' });
    const text = (res.contents[0] as { text: string }).text;
    assert.match(text, /^<farsight-context sync=\d+ commit=\S+ build=\S+>\nbuilt: /);
    assert.match(text, /\nvalidated: /);
    assert.match(text, /\nopen: /);
    assert.match(text, /since your last session \(since .*the last 24 hours/);
    assert.match(text, /lessons pinned by the owner \(1 of 2\): "The e2e card is Playwright; the unit card is node:test\." \(2026-10-10\)/);
    assert.ok(!text.includes('unpinned'));
    assert.match(text, /\n<\/farsight-context>$/);
    for (const leak of ['keychain:', 'dev@example.com', 'jira-example', 'api-token', 'session_']) assert.ok(!text.includes(leak), `the context carries ${leak}`);
    const brief = (await call('graph_overview', { brief: true, since: '2026-01-01' })).text;
    assert.match(brief, /since your last session \(since 2026-01-01 00:00\): /);
    assert.ok(estimateTokens(brief) < 2000);
  });

  test('a small budget cuts journey at a clean boundary, and expand returns what was left out', async () => {
    const whole = (await call('journey', { entry: 'billing-cycle', budget: 100_000 })).text;
    assert.ok(!whole.includes('## left out'));
    const cut = (await call('journey', { entry: 'billing-cycle', budget: 800 })).text;
    assert.ok(estimateTokens(cut) <= 800);
    const section = cut.slice(cut.indexOf('## left out'));
    const json = JSON.parse(section.trim().split('\n').pop()!);
    assert.equal(json.expand.tool, 'expand');
    const handle = json.expand.args.ids[0] as string;
    assert.match(handle, /^cut:\d+$/);
    const back = (await call('expand', { ids: [handle], budget: 100_000 })).text;
    assert.match(back, new RegExp(`^## ${handle} — every part left out of that journey answer`));
    // every line of the whole answer is in the cut or in its expansion
    const both = cut + '\n' + back;
    for (const line of whole.split('\n').filter((l) => l.trim())) assert.ok(both.includes(line), line);
    // an id expand never saw is described instead
    const one = (await call('expand', { ids: ['invoice-app::guard::requireScope(billing:write)'] })).text;
    assert.match(one, /no answer this session left it out — what it is:\n\[guard\] /);
  });
});
