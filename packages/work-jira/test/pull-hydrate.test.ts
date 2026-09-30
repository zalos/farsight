import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem, PullPage } from '@farsight/work';
import { createJiraProvider, sessionFacts, decodeCursor } from '../dist/index.js';
import { load, replay, SOURCE, FAKE_TOKEN } from './replay.ts';

async function fullPull() {
  const r = replay(load('connect.json'), load('discover.json'), load('pull-full.json'), load('hydrate.json'));
  const p = createJiraProvider({ fetcher: r.fetcher, pageSize: 5, sleep: async () => {} });
  const s = await p.connect(SOURCE, FAKE_TOKEN);
  await p.discover(s);
  const pages: PullPage[] = [];
  for await (const pg of p.pull(s, null, SOURCE.scope)) { pages.push(pg); if (pg.isLast) break; }
  const items = new Map<string, WorkItem>(pages.flatMap((pg) => pg.items).map((i) => [i.key, i]));
  return { r, p, s, pages, items };
}

test('pull: bounded JQL, explicit fields, token pagination, isLast only on the last page', async () => {
  const { r, pages, items } = await fullPull();
  const searches = r.calls.filter((c) => c.path === '/rest/api/3/search/jql');
  assert.equal(searches.length, 3);
  const b0 = searches[0]!.body as { jql: string; fields: string[]; nextPageToken?: string };
  assert.equal(b0.jql, 'project in ("KAN", "SAM1") ORDER BY updated ASC');
  for (const f of ['summary', 'description', 'status', 'parent', 'issuelinks', 'customfield_10020', 'customfield_10016']) assert.ok(b0.fields.includes(f), f);
  assert.equal(b0.nextPageToken, undefined);
  assert.ok((searches[1]!.body as { nextPageToken?: string }).nextPageToken, 'page 2 sends the token');
  assert.ok((searches[2]!.body as { nextPageToken?: string }).nextPageToken, 'page 3 sends the token');
  assert.deepEqual(pages.map((pg) => pg.isLast), [false, false, true]);
  assert.equal(items.size, 14, '4 KAN + 10 SAM1');
  const c = decodeCursor(pages.at(-1)!.cursor);
  assert.ok(c && c.at === Math.max(...[...items.values()].map((i) => Date.parse(i.updated))), 'cursor = last updated seen');
});

test('pull maps every §3 row: KAN-1', async () => {
  const { items } = await fullPull();
  const k = items.get('KAN-1')!;
  assert.equal(k.id, 'work::jira-example::KAN-1');
  assert.equal(k.source, 'jira-example');
  assert.equal(k.provider, 'jira');
  assert.equal(k.url, 'https://example.atlassian.net/browse/KAN-1');
  assert.deepEqual(k.type, { name: 'Task', category: 'task' });
  assert.equal(k.title, 'Task 1');
  assert.equal(k.state.name, 'In Progress');
  assert.equal(k.state.category, 'in-progress', 'statusCategory indeterminate');
  assert.match(String(k.state.since), /Z$/);
  assert.match(String(k.assignee?.id), /^712020:/, 'Person.id = accountId');
  assert.equal(k.assignee?.name, 'Farsight Test');
  assert.deepEqual(k.labels.sort(), ['invoices', 'portal']);
  assert.equal(k.area, 'Portal', 'first component');
  assert.equal(k.iteration?.name, 'KAN Sprint 1', 'the gh-sprint field');
  assert.equal(k.parent, 'work::jira-example::KAN-4', 'fields.parent');
  assert.deepEqual(k.estimate, { value: 3, unit: 'points' });
  assert.ok(k.links.some((l) => l.kind === 'blocks' && l.target === 'work::jira-example::KAN-2' && l.native === 'Blocks'));
  assert.ok(k.links.some((l) => l.kind === 'parent' && l.target === 'work::jira-example::KAN-4'));
  const raw = k.raw as { fields: { updated: string } };
  assert.equal(k.revision, raw.fields.updated, 'revision = fields.updated verbatim');
  assert.match(k.updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'ISO 8601 UTC');
  assert.equal(Date.parse(k.updated), Date.parse(raw.fields.updated));
  assert.match(k.created, /Z$/);
  assert.equal(k.fields.estimate, 3);
  assert.ok(Array.isArray(k.fields.iteration));
  assert.deepEqual(k.comments, [], 'comments arrive by hydrate');
});

test('pull: the other side of a link, epics, categories, bodies', async () => {
  const { items } = await fullPull();
  const k2 = items.get('KAN-2')!;
  assert.ok(k2.links.some((l) => l.kind === 'blocked-by' && l.target === 'work::jira-example::KAN-1'));
  assert.deepEqual(k2.type, { name: 'Story', category: 'story' });
  const epic = items.get('KAN-4')!;
  assert.deepEqual(epic.type, { name: 'Epic', category: 'epic' });
  assert.equal(epic.body?.format, 'adf');
  for (const s of ['## Invoice submission', '**portal**', '[the spec](https://example.com/spec)', '@Farsight Test', '- call `finalizeInvoice`', '1. draft', '```ts', '| step | owner |']) {
    assert.ok(epic.body!.text.includes(s), `body has ${s}`);
  }
  assert.equal((epic.body!.raw as { type: string }).type, 'doc', 'raw ADF kept verbatim');
  assert.deepEqual(items.get('KAN-3')!.type, { name: 'Subtask', category: 'task' });
  assert.equal(items.get('SAM1-5')!.state.category, 'done');
  assert.equal(items.get('SAM1-1')!.state.category, 'todo');
  assert.equal(items.get('SAM1-10')!.state.name, 'In Review');
  assert.equal(items.get('SAM1-10')!.state.category, 'in-progress');
  assert.equal(items.get('SAM1-6')!.parent, 'work::jira-example::SAM1-1');
  assert.equal(items.get('SAM1-6')!.iteration, undefined);
  assert.equal(items.get('SAM1-6')!.priority, undefined, 'team-managed projects answer priority: null');
});

test('hydrate: bulk issues, bulk changelog newest last, paged comments', async () => {
  const { r, p, s, items } = await fullPull();
  const ids = [...items.values()].filter((i) => i.key.startsWith('KAN-')).map((i) => i.id);
  const full = await p.hydrate(s, ids);
  assert.deepEqual(full.map((i) => i.id), ids, 'in the order asked');
  assert.equal(sessionFacts(s).changelogVia, 'bulkfetch');
  const k1 = full.find((i) => i.key === 'KAN-1')!;
  assert.ok(k1.history.length >= 6);
  const ats = k1.history.map((h) => h.at);
  assert.deepEqual(ats, [...ats].sort(), 'newest last');
  assert.ok(ats.every((a) => /Z$/.test(a)), 'bulkfetch epoch ms became ISO UTC');
  const st = k1.history.filter((h) => h.field === 'status').at(-1)!;
  assert.equal(st.to, 'In Progress');
  assert.equal(st.from, 'To Do');
  assert.match(String(st.by?.id), /^712020:/);
  assert.ok(k1.comments.length >= 2);
  assert.equal(k1.comments[0]!.body.format, 'adf');
  assert.equal(k1.comments[0]!.body.text, 'First comment: totals must match `invoice.total`');
  assert.equal(k1.comments[0]!.author.name, 'Farsight Test');
  const k2 = full.find((i) => i.key === 'KAN-2')!;
  assert.ok(k2.comments.some((c) => c.body.text.includes('**record-fixtures**')), 'the recorded write is in the comments');
  assert.deepEqual(r.unused(), []);
});

test('incremental: since the cursor minus the overlap, dedupe what was seen, reconcileIssues after a write', async () => {
  const { pages } = await fullPull();
  const cursor = pages.at(-1)!.cursor;
  // no discover: pull resolves the field map itself — the cached schema may be a day old
  const r2 = replay(load('connect.json'), load('discover.json').filter((c) => !c.path.includes('/project/') && !c.path.includes('issueLinkType')), load('pull-incremental.json'));
  const p2 = createJiraProvider({ fetcher: r2.fetcher, pageSize: 5, sleep: async () => {} });
  const s2 = await p2.connect(SOURCE, FAKE_TOKEN);
  const got: WorkItem[] = [];
  for await (const pg of p2.pull(s2, cursor, SOURCE.scope)) { got.push(...pg.items); if (pg.isLast) break; }
  const body = r2.calls.find((c) => c.path === '/rest/api/3/search/jql')!.body as { jql: string };
  const at = decodeCursor(cursor)!.at;
  assert.equal(body.jql, `project in ("KAN", "SAM1") AND updated >= ${at - 180_000} ORDER BY updated ASC`);
  assert.deepEqual(got.map((i) => i.key), ['KAN-2'], 'only what moved; the overlap re-reads are deduped');
  assert.ok(got[0]!.labels.includes('recorded'));
});

test('reconcile: a key-only scan reports known ids that are gone', async () => {
  const { pages, items } = await fullPull();
  const cursor = pages.at(-1)!.cursor;
  const r = replay(load('connect.json'), load('discover.json'), load('pull-reconcile.json'));
  const p = createJiraProvider({ fetcher: r.fetcher, pageSize: 5, sleep: async () => {} });
  const s = await p.connect(SOURCE, FAKE_TOKEN);
  await p.discover(s);
  const known = [...items.values()].map((i) => i.id).concat('work::jira-example::KAN-999');
  const out: PullPage[] = [];
  for await (const pg of p.pull(s, cursor, { ...SOURCE.scope, reconcile: { known } } as never)) { out.push(pg); if (pg.isLast) break; }
  assert.deepEqual(out.at(-1)!.deleted, ['work::jira-example::KAN-999']);
  assert.equal(out.at(-1)!.isLast, true);
  assert.equal(out.filter((pg) => pg.isLast).length, 1);
  const scan = r.calls.at(-1)!.body as { jql: string; fields: string[] };
  assert.deepEqual(scan.fields, ['key']);
  assert.equal(scan.jql, 'project in ("KAN", "SAM1") ORDER BY key ASC');
});

test('dedupe: an issue seen at the same updated inside the overlap is not yielded again; a newer one is', async () => {
  const U1 = '2026-09-30T18:32:46.656-0400';
  const U2 = '2026-09-30T18:33:10.000-0400';
  const issue = (id: string, key: string, updated: string) => ({ id, key, fields: { updated, summary: key, status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Task', hierarchyLevel: 0 } } });
  const fields = load('pull-full.json')[0]!.body as { fields: string[] };
  const at = Date.parse(U1);
  const r = replay(load('connect.json'), load('discover.json'), [{
    method: 'POST', path: '/rest/api/3/search/jql', status: 200,
    body: { jql: `project in ("KAN", "SAM1") AND updated >= ${at - 180_000} ORDER BY updated ASC`, fields: fields.fields, maxResults: 100 },
    response: { issues: [issue('10010', 'KAN-1', U1), issue('10011', 'KAN-2', U2)], isLast: true },
  }]);
  const p = createJiraProvider({ fetcher: r.fetcher, sleep: async () => {} });
  const s = await p.connect(SOURCE, FAKE_TOKEN);
  await p.discover(s);
  const out: PullPage[] = [];
  for await (const pg of p.pull(s, JSON.stringify({ v: 1, at, seen: [`10010@${at}`] }), SOURCE.scope)) { out.push(pg); if (pg.isLast) break; }
  assert.deepEqual(out.flatMap((pg) => pg.items.map((i) => i.key)), ['KAN-2']);
  const c = decodeCursor(out.at(-1)!.cursor)!;
  assert.equal(c.at, Date.parse(U2));
  assert.deepEqual(c.seen.sort(), [`10010@${at}`, `10011@${Date.parse(U2)}`], 'both stay inside the new overlap window');
});
