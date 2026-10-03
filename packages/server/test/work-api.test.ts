/**
 * `/api/work*` — work items joined to the code (docs/proposals/work-items-sync.md
 * §9, §10), against a temp workspace: one `git init` code source and the
 * recorded fixture tracker (a copy, since the fixture tracker records writes).
 *
 * One `POST /api/sync` does it all, as the viewer's SYNC button does: ingest,
 * the commit spine with the keys each commit names, the work source through
 * the engine, and the join into `work` nodes and `tracks` edges. Then every
 * route answers the contract shape.
 *
 * Nothing here touches the workspace graph, `examples/**`, any real store, or
 * ports 4477/4478.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GraphStore, countedProblems } from '@farsight/core';
import { INVOICE_APP_FIXTURE } from '@farsight/work-fixture';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;

let work: string;
let app: string;
let fixture: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';
let syncBody: any;
const sha: Record<string, string> = {};
const SRC = 'invoice-jira';
const id = (key: string) => `work::${SRC}::${key}`;

function git(dir: string, args: string[], at?: string) {
  const env = { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) };
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}
function write(rel: string, body: string) {
  mkdirSync(dirname(join(app, rel)), { recursive: true });
  writeFileSync(join(app, rel), body);
}
function commit(message: string, at: string) {
  git(app, ['add', '-A']);
  git(app, ['commit', '-q', '-m', message], at);
  return git(app, ['rev-parse', 'HEAD']);
}

const INVOICES_V1 = `/** List invoices. */
export function listInvoices(rows: number[]) {
  return rows.slice();
}

/**
 * Start a new invoice.
 * @work INV-2
 */
export function createInvoice() {
  return { lines: [] };
}

/** Throw away a draft. */
export function discardDraft(id: string) {
  return id;
}
`;

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const picked = await new Promise<number>((res, rej) => {
      const probe = createServer();
      probe.once('error', rej);
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        const p = typeof a === 'object' && a ? a.port : 0;
        probe.close(() => res(p));
      });
    });
    if (picked > 1024 && ![4477, 4478].includes(picked)) return picked;
  }
  throw new Error('no free loopback port after 20 tries');
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = 'nothing answered';
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`the server exited with code ${child.exitCode}:\n${childLog}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/graph`);
      await r.arrayBuffer();
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (err) { last = (err as Error).message; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server never answered on port ${port} (${last}):\n${childLog}`);
}

const get = async (path: string) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: await r.json() as any };
};
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};

before(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-work-api-')));
  app = join(work, 'app');
  fixture = join(work, 'tracker');
  cpSync(INVOICE_APP_FIXTURE, fixture, { recursive: true });
  mkdirSync(app, { recursive: true });
  git(app, ['init', '-q', '-b', 'main']);
  git(app, ['config', 'user.name', 'Fixture']);
  git(app, ['config', 'user.email', 'f@example.com']);
  write('package.json', '{"name":"app"}\n');
  write('src/invoices.ts', INVOICES_V1);
  // the design manifest: a flow declared for INV-1 (and a key no source reads), a screen for
  // INV-3, and a screen for INV-4 that nobody has built — INV-4 is done in the tracker
  write('docs/screens.json', JSON.stringify({
    name: 'Invoice app',
    screens: [
      { id: 'INV-01', name: 'Invoice list', route: '/invoices', work: ['INV-3'] },
      { id: 'INV-02', name: 'Discard a draft', route: '/invoices/:id/discard', work: ['INV-4'] },
    ],
    flows: [{ id: 'invoicing', name: 'Invoicing', screens: ['INV-01', 'INV-02'], work: ['INV-1', 'NOPE-9'] }],
  }, null, 2));
  sha.root = commit('initial', '2026-01-01T00:00:00Z');
  // INV-3 in the subject, changing listInvoices' body (lines 2-4)
  write('src/invoices.ts', INVOICES_V1.replace('return rows.slice();', 'return rows.slice().sort((a, b) => b - a);'));
  sha.inv3 = commit('INV-3: list newest first', '2026-01-02T00:00:00Z');
  // negatives: a hash name and a design screen name are not work items
  write('src/util.ts', 'export const algo = "sha-256";\n');
  sha.neg = commit('use SHA-256 for screen INV-01 ids, fix #12', '2026-01-03T00:00:00Z');
  // INV-5 is to do in the tracker, and a commit names it
  write('src/util.ts', 'export const algo = "sha-256";\nexport const v = 2;\n');
  sha.inv5 = commit('prep\n\nGroundwork for https://invoice-app.atlassian.net/browse/INV-5', '2026-01-04T00:00:00Z');
  // an unmerged branch for INV-6: only its name carries the key. It changes discardDraft, which
  // the indexed checkout (main) has too — a branch that only adds new code links to nothing the
  // graph holds, because the graph is the checkout that was read
  git(app, ['checkout', '-q', '-b', 'feature/inv-6-send']);
  write('src/invoices.ts', INVOICES_V1.replace('return rows.slice();', 'return rows.slice().sort((a, b) => b - a);').replace('  return id;\n}', '  return id.trim();\n}'));
  sha.inv6 = commit('tidy the draft id', '2026-01-05T00:00:00Z');
  git(app, ['checkout', '-q', 'main']);

  mkdirSync(join(work, '.farsight'), { recursive: true });
  writeFileSync(join(work, '.farsight', 'settings.json'), JSON.stringify({
    theme: 'dark', defaultLens: 'hybrid', collections: [],
    sources: [
      { id: 'app', name: 'app', type: 'local', path: 'app', enabled: true },
      {
        id: SRC, name: 'Invoice tracker', type: 'work', provider: 'fixture', path: 'tracker', enabled: true,
        scope: { projects: ['INV'] }, mode: 'edit',
        permissions: {
          default: 'deny',
          grants: [
            { actions: ['comment', 'label'], principals: ['human', 'agent'] },
            { actions: ['assign'], principals: ['human'] },
          ],
          agentWrites: 'confirm',
        },
      },
    ],
  }, null, 2) + '\n');
  const store = new GraphStore();
  store.save(join(work, 'graph.json'));

  port = await freePort();
  const boot = `const { serveGraph } = await import(${JSON.stringify(serverDist)});\n`
    + `serveGraph(${JSON.stringify(join(work, 'graph.json'))}, ${port}, ${JSON.stringify(work)});\n`;
  child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: work,
    env: { ...process.env, MODELHUB_DIR: join(work, 'modelhub'), FIGMA_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { childLog += d; });
  child.stderr.on('data', (d: string) => { childLog += d; });
  await waitReady();
  const s = await post('/api/sync');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  syncBody = s.body;
});

after(async () => {
  if (child && child.exitCode == null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
});

const noProblems = (c: any, where: string) => assert.deepEqual(countedProblems(c, where), [], where);

test('POST /api/sync: the code, its history with keys, the tracker and the join — each on its status line', () => {
  assert.match(syncBody.results.app, /^ok: /);
  assert.match(syncBody.results.app, /history \d+ commits read/);
  assert.match(syncBody.results[SRC], /^ok: 8 items .* links? to the graph/);
  assert.ok(syncBody.work.nodes >= 8);
  assert.ok(syncBody.work.edges >= 4);
  // a declared key no configured source reads is unmatched with a reason, never linked
  const nope = syncBody.work.unmatched.find((u: any) => u.key === 'NOPE-9');
  assert.equal(nope.reason, 'no work source reads project NOPE');
  assert.ok(!syncBody.work.unmatched.some((u: any) => u.key === 'INV-01'), 'a screen id is not a declared key');
  // the graph carries work nodes and tracks edges
  const g = JSON.parse(readFileSync(join(work, 'graph.json'), 'utf8'));
  const n = g.nodes.find((x: any) => x.id === id('INV-3'));
  assert.equal(n.kind, 'work');
  assert.equal(n.facets.business.label, 'List invoices newest first');
  assert.ok(g.edges.some((e: any) => e.kind === 'tracks' && e.from === id('INV-3') && e.to === 'app::src/invoices.ts::listInvoices' && e.resolution.technique === 'work-key'));
  assert.ok(g.edges.some((e: any) => e.kind === 'tracks' && e.from === id('INV-2') && e.to === 'app::src/invoices.ts::createInvoice' && e.resolution.technique === 'annotation-scan'));
});

test('GET /api/work: source cards with freshness and Counteds, items with link and commit counts, filters', async () => {
  const { status, body } = await get('/api/work');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['counts', 'generatedAt', 'items', 'sources', 'sync']);
  const card = body.sources[0];
  assert.equal(card.id, SRC);
  assert.equal(card.provider, 'fixture');
  assert.equal(card.mode, 'edit');
  assert.equal(card.freshness.state, 'synced');
  assert.equal(typeof card.freshness.syncNo, 'number');
  assert.ok(card.capabilities);
  // who the tracker knows us as, on the list answer too — before any item of the source was opened
  assert.deepEqual(card.user, { id: 'fixture-user', name: 'Fixture user' });
  noProblems(card.counts.items, 'source card items');
  noProblems(body.counts.items, 'items');
  noProblems(body.counts.sources, 'sources');
  assert.equal(body.items.length, 8, 'a first sync reads the full pages; the incremental ones arrive on later syncs');
  const inv3 = body.items.find((i: any) => i.key === 'INV-3');
  for (const k of ['id', 'key', 'url', 'source', 'provider', 'type', 'title', 'state', 'labels', 'updated', 'links', 'commits']) assert.ok(k in inv3, k);
  noProblems(inv3.links, 'links');
  assert.equal(inv3.commits.n, 1);
  assert.ok(inv3.links.n >= 2, 'declared on its screen and named in a commit');

  assert.deepEqual((await get('/api/work?state=todo')).body.items.map((i: any) => i.key), ['INV-5', 'INV-7']);
  assert.deepEqual((await get('/api/work?q=newest')).body.items.map((i: any) => i.key), ['INV-3']);
  assert.deepEqual((await get(`/api/work?node=${encodeURIComponent('app::src/invoices.ts::createInvoice')}`)).body.items.map((i: any) => i.key), ['INV-2']);
});

test('GET /api/work/item/<id>: the record, links with provenance, commits with their files and nodes, touched, findings', async () => {
  const { status, body } = await get(`/api/work/item/${encodeURIComponent(id('INV-3'))}`);
  assert.equal(status, 200);
  assert.equal(body.item.key, 'INV-3');
  assert.ok(Array.isArray(body.item.comments) && Array.isArray(body.item.history));
  const code = body.links.find((l: any) => l.nodeId === 'app::src/invoices.ts::listInvoices');
  assert.equal(code.via, 'commit');
  assert.equal(code.tier, 'MEDIUM');
  assert.equal(code.kind, 'function');
  assert.equal(code.sha, sha.inv3);
  assert.ok(body.links.some((l: any) => l.via === 'declared' && l.tier === 'HIGH' && l.kind === 'page'));
  assert.equal(body.commits.length, 1);
  const c = body.commits[0];
  assert.equal(c.sha, sha.inv3);
  assert.equal(c.via, 'subject');
  assert.deepEqual(c.files, [{ path: 'src/invoices.ts', status: 'modified' }]);
  assert.deepEqual(c.nodes, ['app::src/invoices.ts::listInvoices'], 'the function the hunk sits in, not every function in the file');
  noProblems(body.touched, 'touched');
  assert.equal(body.touched.n, 1);
  assert.equal(body.freshness.state, 'synced');
  assert.equal(body.mode, 'edit');
  assert.deepEqual(Object.keys(body.allowed).sort(), ['assign', 'comment', 'edit', 'label', 'link', 'transition']);
  assert.equal(body.capabilities.concurrency, 'revision');
  assert.equal(body.previewable, true, 'the fixture declares a dry run');
  assert.deepEqual(body.user, { id: 'fixture-user', name: 'Fixture user' });
  assert.equal(body.allowed.comment.policy, true);
  assert.equal(body.allowed.transition.policy, false);
  assert.match(body.allowed.transition.reason, /no grant/);

  // the two §9 findings, each with both provenances
  const inv4 = (await get(`/api/work/item/${encodeURIComponent(id('INV-4'))}`)).body;
  const done = inv4.findings.find((f: any) => f.kind === 'done-not-built');
  assert.equal(done.text, 'INV-4 is done; its screen Discard a draft is not built');
  assert.deepEqual(done.provenances.map((p: any) => p.source), ['tracker', 'code']);
  const inv5 = (await get(`/api/work/item/${encodeURIComponent(id('INV-5'))}`)).body;
  assert.equal(inv5.findings[0].kind, 'todo-but-committed');
  assert.equal(inv5.findings[0].text, 'INV-5 is to do; 1 commit names it');
  assert.equal(inv5.commits[0].via, 'url');

  // a branch-only key: the unmerged branch's commit, named by its branch
  const inv6 = (await get(`/api/work/item/${encodeURIComponent(id('INV-6'))}`)).body;
  assert.equal(inv6.commits[0].sha, sha.inv6);
  assert.equal(inv6.commits[0].via, 'branch');
  assert.equal(inv6.commits[0].branch, 'feature/inv-6-send');
  assert.ok(inv6.links.some((l: any) => l.via === 'branch' && l.nodeId === 'app::src/invoices.ts::discardDraft'), JSON.stringify(inv6.links));

  assert.equal((await get(`/api/work/item/${encodeURIComponent(id('INV-404'))}`)).status, 404);
});

test('GET /api/work/item/<id>/diff?sha=: the patch per file and the nodes in its hunks — only a commit that names the item', async () => {
  const path = `/api/work/item/${encodeURIComponent(id('INV-3'))}/diff`;
  const { status, body } = await get(`${path}?sha=${sha.inv3}`);
  assert.equal(status, 200);
  assert.equal(body.sha, sha.inv3);
  assert.equal(body.subject, 'INV-3: list newest first');
  assert.equal(body.files.length, 1);
  assert.match(body.files[0].patch, /^\+\s+return rows\.slice\(\)\.sort/m);
  assert.deepEqual(body.files[0].nodes, ['app::src/invoices.ts::listInvoices']);
  // path confinement: a commit that does not name the item is refused, and so is anything that is not a sha
  assert.match((await get(`${path}?sha=${sha.neg}`)).body.error, /does not name this work item/);
  assert.match((await get(`${path}?sha=../../etc/passwd`)).body.error, /must be a commit id/);
});

test('GET /api/work/links?node= and /api/work/flow/<id>', async () => {
  const links = (await get(`/api/work/links?node=${encodeURIComponent('app::src/invoices.ts::listInvoices')}`)).body;
  assert.deepEqual(links.items.map((i: any) => i.key), ['INV-3']);
  noProblems(links.counts.items, 'links items');
  const flowId = JSON.parse(readFileSync(join(work, 'graph.json'), 'utf8')).nodes.find((n: any) => n.kind === 'flow').id;
  const flow = (await get(`/api/work/flow/${encodeURIComponent(flowId)}`)).body;
  assert.equal(flow.flow, flowId);
  assert.deepEqual(flow.items.map((i: any) => i.key).sort(), ['INV-1', 'INV-3', 'INV-4']);
  noProblems(flow.counts.items, 'flow items');
  noProblems(flow.counts.byState, 'flow byState');
  assert.ok(flow.findings.some((f: any) => f.kind === 'done-not-built'));
  assert.equal((await get('/api/work/flow/nope')).status, 404);
});

test('intents: applied, pending then confirmed, denied with three verdicts, conflict as a 200, drop and rebase', async () => {
  const human = { kind: 'human', id: 'jared' };
  const preview = (await post('/api/work/intent', { item: id('INV-3'), action: 'comment', payload: { body: 'dry' }, requestedBy: human, dryRun: true })).body;
  assert.equal(preview.status, 'previewed', JSON.stringify(preview));
  assert.deepEqual(preview.preview, { ok: true, reason: 'ok' });
  assert.deepEqual(Object.keys(preview.verdicts).sort(), ['credential', 'policy', 'tracker']);
  assert.ok(!(await get(`/api/work/item/${encodeURIComponent(id('INV-3'))}`)).body.item.comments.some((c: any) => c.body.text === 'dry'), 'a dry run writes nothing');

  const applied = (await post('/api/work/intent', { item: id('INV-3'), action: 'comment', payload: { body: 'looks right' }, requestedBy: human })).body;
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  assert.deepEqual(applied.preview, { ok: true, reason: 'ok' }, 'the dry run is printed beside the verdicts');
  const mine = applied.item.comments.find((c: any) => c.body.text === 'looks right');
  assert.deepEqual(mine.requestedBy, human, 'a comment Farsight wrote says who asked');
  assert.ok((await get(`/api/work/item/${encodeURIComponent(id('INV-3'))}`)).body.item.comments.some((c: any) => c.requestedBy?.id === 'jared'));

  // the revision the person was shown is the one the write is checked against
  const stale = (await post('/api/work/intent', { item: id('INV-3'), action: 'comment', payload: { body: 'late' }, requestedBy: human, baseRevision: 'what-i-saw-yesterday' })).body;
  assert.equal(stale.status, 'conflict', JSON.stringify(stale));

  const denied = (await post('/api/work/intent', { item: id('INV-8'), action: 'transition', payload: { to: 'todo' }, requestedBy: human })).body;
  assert.equal(denied.status, 'denied');
  assert.deepEqual(Object.keys(denied.verdicts).sort(), ['credential', 'policy', 'tracker']);
  for (const v of Object.values(denied.verdicts) as any[]) assert.equal(typeof v.reason, 'string');
  assert.equal(denied.verdicts.policy.allowed, false);

  const pending = (await post('/api/work/intent', { item: id('INV-2'), action: 'label', payload: { add: ['billing'] }, requestedBy: { kind: 'agent', id: 'mcp-1' } })).body;
  assert.equal(pending.status, 'pending', JSON.stringify(pending));
  const confirmed = (await post(`/api/work/intent/${pending.intent.id}/confirm`)).body;
  assert.equal(confirmed.status, 'applied', JSON.stringify(confirmed));
  assert.ok(confirmed.item.labels.includes('billing'));

  // someone else writes INV-6 on the tracker; our intent was made against the cached revision
  appendFileSync(join(fixture, 'applied.jsonl'), JSON.stringify({
    at: '2026-09-29T00:00:00.000Z', revision: 'elsewhere-1',
    intent: { id: 'x', item: id('INV-6'), action: 'comment', payload: { body: 'from the tracker' }, requestedBy: { kind: 'human', id: 'other' } },
  }) + '\n');
  const conflict = await post('/api/work/intent', { item: id('INV-6'), action: 'comment', payload: { body: 'mine' }, requestedBy: human });
  assert.equal(conflict.status, 200, 'a conflict is a 200 with status conflict');
  assert.equal(conflict.body.status, 'conflict', JSON.stringify(conflict.body));
  assert.equal(conflict.body.item.revision, 'elsewhere-1');
  const rebased = (await post(`/api/work/intent/${conflict.body.intent.id}/rebase`)).body;
  assert.equal(rebased.status, 'applied', JSON.stringify(rebased));

  const again = (await post('/api/work/intent', { item: id('INV-1'), action: 'comment', payload: { body: 'x' }, requestedBy: { kind: 'agent', id: 'mcp-1' } })).body;
  assert.equal(again.status, 'pending');
  const dropped = (await post(`/api/work/intent/${again.intent.id}/drop`)).body;
  assert.equal(dropped.status, 'failed');
  assert.match(dropped.error, /dropped/);
  // the outbox's state machine: a dropped request is not confirmed later, an applied one is not applied twice
  const late = await post(`/api/work/intent/${again.intent.id}/confirm`);
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.match(late.body.error, /is dropped/);
  const twice = await post(`/api/work/intent/${pending.intent.id}/confirm`);
  assert.equal(twice.status, 409, JSON.stringify(twice.body));
  assert.equal((await post(`/api/work/intent/${pending.intent.id}/rebase`)).status, 409);
  const writes = (await get(`/api/work/audit?item=${encodeURIComponent(id('INV-2'))}`)).body.rows.filter((r: any) => r.intent === pending.intent.id && r.outcome === 'confirmed');
  assert.equal(writes.length, 1, 'written once');

  const outbox = (await get('/api/work/outbox')).body;
  assert.ok(outbox.intents.length >= 5);
  const c = outbox.intents.find((i: any) => i.state === 'conflict');
  assert.ok(c.theirs && c.theirs.revision, 'a conflict carries what the tracker says now');
  assert.ok(outbox.intents.every((i: any) => i.key && i.state));
  const audit = (await get(`/api/work/audit?item=${encodeURIComponent(id('INV-8'))}`)).body;
  assert.equal(audit.rows[0].outcome, 'denied');
  assert.deepEqual(Object.keys(audit.rows[0].verdicts).sort(), ['credential', 'policy', 'tracker']);
  assert.equal((await post('/api/work/intent/nope/confirm')).status, 404);
});

test('people, states and a work-only sync', async () => {
  const people = (await get(`/api/work/people?source=${SRC}`)).body.people;
  assert.ok(people.length >= 1 && people.every((p: any) => p.id && p.name));
  const states = (await get(`/api/work/states?source=${SRC}`)).body.states;
  assert.deepEqual(states.map((s: any) => s.category), ['todo', 'in-progress', 'done']);
  const r = (await post('/api/work/sync', { source: SRC })).body;
  assert.equal(r.reports.length, 1);
  assert.equal(r.reports[0].sourceId, SRC);
  assert.equal(r.reports[0].error, undefined);
  assert.equal((await post('/api/work/sync', { source: 'nope' })).status, 404);
});

test('settings carry references, never secrets: GET /api/settings serves the work source as written', async () => {
  const s = (await get('/api/settings')).body;
  const w = s.sources.find((x: any) => x.type === 'work');
  assert.equal(w.provider, 'fixture');
  assert.match(w.status, /^ok: /, 'the sync wrote its status line back');
  assert.ok(!JSON.stringify(s).match(/"secret"\s*:\s*"(?!keychain:|env:)/), 'no secret value in settings');
});
