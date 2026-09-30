import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Intent, WorkItem } from '@farsight/work';
import { createJiraProvider, adfToMarkdown } from '../dist/index.js';
import { load, replay, SOURCE, FAKE_TOKEN, type Recorded } from './replay.ts';

const ME = { kind: 'human' as const, id: 'me' };
const item = (key: string): WorkItem => ({
  id: `work::jira-example::${key}`, source: 'jira-example', provider: 'jira', key, url: '', type: { name: 'Task', category: 'task' },
  title: '', state: { name: 'To Do', category: 'todo' }, labels: [], links: [], created: '', updated: '', revision: 'r0',
  comments: [], history: [], fields: {}, raw: null,
});
const intent = (key: string, action: Intent['action'], payload: Intent['payload'], baseRevision?: string): Intent => ({
  id: `i-${action}`, item: `work::jira-example::${key}`, action, payload, requestedBy: ME, ...(baseRevision ? { baseRevision } : {}),
});
const rec = (method: string, path: string, status: number, response: unknown, body?: unknown): Recorded => ({ method, path, status, response, ...(body !== undefined ? { body } : {}) });
const perms = (key: string, have: Record<string, boolean>) => rec('GET',
  `/rest/api/3/mypermissions?permissions=BROWSE_PROJECTS%2CEDIT_ISSUES%2CADD_COMMENTS%2CASSIGN_ISSUES%2CTRANSITION_ISSUES%2CLINK_ISSUES&issueKey=${key}`, 200,
  { permissions: Object.fromEntries(Object.entries(have).map(([k, v]) => [k, { havePermission: v }])) });
const ALL = { BROWSE_PROJECTS: true, EDIT_ISSUES: true, ADD_COMMENTS: true, ASSIGN_ISSUES: true, TRANSITION_ISSUES: true, LINK_ISSUES: true };
const PRE = (key: string, updated: string, extra: Record<string, unknown> = {}) =>
  rec('GET', `/rest/api/3/issue/${key}?fields=updated%2Clabels%2Cstatus`, 200, { id: '1', key, fields: { updated, labels: [], status: { name: 'To Do' }, ...extra } });
const REREAD = (key: string, updated: string, extra: Record<string, unknown> = {}) => ({
  method: 'GET', status: 200, response: { id: '10099', key, fields: { updated, summary: 's', status: { name: 'To Do', statusCategory: { key: 'new' } }, ...extra } },
});

async function connected(...tapes: Recorded[][]) {
  const r = replay(load('connect.json'), load('discover.json'), ...tapes);
  const p = createJiraProvider({ fetcher: r.fetcher, sleep: async () => {} });
  const s = await p.connect(SOURCE, FAKE_TOKEN);
  await p.discover(s);
  return { r, p, s };
}
// the re-read asks for the full field list; match it by prefix
function withReread(tape: Recorded[], key: string, updated: string, extra: Record<string, unknown> = {}): Recorded[] {
  const full = load('apply-comment.json')[2]!.path.replace('KAN-2', key);
  return [...tape, { ...REREAD(key, updated, extra), path: full }];
}

test('can(): Jira says yes for every built action on the recorded site', async () => {
  const { p, s } = await connected(load('can.json'));
  for (const action of ['comment', 'edit', 'assign', 'transition', 'link', 'label'] as const) {
    assert.deepEqual(await p.can(s, item('KAN-1'), action), { allowed: true, reason: 'Jira says: yes' }, action);
  }
  assert.deepEqual(await p.can(s, item('KAN-1'), 'create'), { allowed: false, reason: 'this source cannot create yet' });
});

test('can(): no transition, a missing permission, a field off the edit screen, an invisible item — in words', async () => {
  const issue = (key: string, transitions: unknown[], editmeta: Record<string, unknown>) =>
    rec('GET', `/rest/api/3/issue/${key}?fields=status%2Clabels&expand=editmeta%2Ctransitions%2Coperations`, 200,
      { id: '1', key, fields: { status: { name: 'To Do' } }, transitions, editmeta: { fields: editmeta } });
  const { p, s } = await connected([
    issue('KAN-1', [], { summary: {} }), perms('KAN-1', ALL),
    issue('KAN-1', [], { summary: {} }), perms('KAN-1', { ...ALL, ADD_COMMENTS: false }),
    issue('KAN-1', [], { summary: {} }), perms('KAN-1', ALL),
    rec('GET', '/rest/api/3/issue/KAN-9?fields=status%2Clabels&expand=editmeta%2Ctransitions%2Coperations', 404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] }),
  ]);
  assert.deepEqual(await p.can(s, item('KAN-1'), 'transition'), { allowed: false, reason: 'Jira says: no transition from To Do' });
  assert.deepEqual(await p.can(s, item('KAN-1'), 'comment'), { allowed: false, reason: 'Jira says: no — this account may not add comments on KAN-1' });
  assert.deepEqual(await p.can(s, item('KAN-1'), 'label'), { allowed: false, reason: 'Jira says: labels is not editable on KAN-1' });
  assert.deepEqual(await p.can(s, item('KAN-9'), 'comment'), { allowed: false, reason: 'Jira says: KAN-9 is not visible to this account' });
});

test('apply comment (recorded): compare-before-write, ADF body, re-read, revision after', async () => {
  const tape = load('apply-comment.json');
  const before = (tape[0]!.response as { fields: { updated: string } }).fields.updated;
  const after = (tape[2]!.response as { fields: { updated: string } }).fields.updated;
  const { r, p, s } = await connected(tape);
  const res = await p.apply(s, intent('KAN-2', 'comment', { body: 'Recorded by **record-fixtures**: see `finalizeInvoice`.' }, before));
  assert.equal(res.ok, true);
  assert.equal(res.revision, after);
  assert.notEqual(after, before);
  const post = r.calls.find((c) => c.method === 'POST')!;
  assert.equal(post.path, '/rest/api/3/issue/KAN-2/comment');
  const body = (post.body as { body: unknown }).body;
  assert.equal(adfToMarkdown(body), 'Recorded by **record-fixtures**: see `finalizeInvoice`.');
  assert.equal(res.item!.key, 'KAN-2', 'the re-read item rides on ApplyResult.item');
  assert.deepEqual(r.calls.map((c) => c.method), ['GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'POST', 'GET']);
});

test('apply label (recorded): update verbs, never a replacing fields.labels', async () => {
  const tape = load('apply-label.json');
  const before = (tape[0]!.response as { fields: { updated: string } }).fields.updated;
  const { r, p, s } = await connected(tape);
  const res = await p.apply(s, intent('KAN-2', 'label', { add: ['recorded'], remove: [] }, before));
  assert.equal(res.ok, true);
  assert.deepEqual(r.calls.find((c) => c.method === 'PUT')!.body, { update: { labels: [{ add: 'recorded' }] } });
});

test('a stale revision is a conflict and nothing is written', async () => {
  const { r, p, s } = await connected([PRE('KAN-1', '2026-09-30T18:45:00.000-0400')]);
  const res = await p.apply(s, intent('KAN-1', 'comment', { body: 'hi' }, '2026-09-30T18:32:46.656-0400'));
  assert.deepEqual(res, { ok: false, conflict: true, revision: '2026-09-30T18:45:00.000-0400', error: 'KAN-1 changed on Jira since it was read' });
  assert.equal(r.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('Jira\'s own 409 is a conflict; a 400 is a failure in Jira\'s words', async () => {
  const U = '2026-09-30T18:00:00.000-0400';
  const { p, s } = await connected([
    PRE('KAN-1', U), rec('POST', '/rest/api/3/issue/KAN-1/comment', 409, { errorMessages: ['the issue could not be updated due to a conflicting update'] }),
    PRE('KAN-1', U), rec('PUT', '/rest/api/3/issue/KAN-1/assignee', 400, { errorMessages: [], errors: { accountId: 'User not found' } }),
  ]);
  const a = await p.apply(s, intent('KAN-1', 'comment', { body: 'x' }, U));
  assert.equal(a.conflict, true);
  assert.equal(a.ok, false);
  assert.match(String(a.error), /conflicting update/);
  const b = await p.apply(s, intent('KAN-1', 'assign', { assignee: 'nobody' }, U));
  assert.deepEqual(b, { ok: false, error: 'Jira refused the write (400): accountId: User not found' });
});

test('assign by accountId, and null unassigns', async () => {
  const U = '2026-09-30T18:00:00.000-0400';
  const { r, p, s } = await connected(withReread([PRE('KAN-1', U), rec('PUT', '/rest/api/3/issue/KAN-1/assignee', 204, null)], 'KAN-1', U),
    withReread([PRE('KAN-1', U), rec('PUT', '/rest/api/3/issue/KAN-1/assignee', 204, null)], 'KAN-1', U));
  assert.equal((await p.apply(s, intent('KAN-1', 'assign', { assignee: '712020:abc' }, U))).ok, true);
  assert.equal((await p.apply(s, intent('KAN-1', 'assign', { assignee: null }, U))).ok, true);
  const puts = r.calls.filter((c) => c.method === 'PUT').map((c) => c.body);
  assert.deepEqual(puts, [{ accountId: '712020:abc' }, { accountId: null }]);
});

test('transition: the one whose target category matches, only screen fields, required ones checked', async () => {
  const U = '2026-09-30T18:00:00.000-0400';
  const transitions = {
    transitions: [
      { id: '11', name: 'To Do', to: { name: 'To Do', statusCategory: { key: 'new' } } },
      { id: '21', name: 'In Progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
      { id: '31', name: 'In Review', to: { name: 'In Review', statusCategory: { key: 'indeterminate' } } },
      { id: '41', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } }, fields: { resolution: { required: true, hasDefaultValue: false, name: 'Resolution' } } },
    ],
  };
  const TR = rec('GET', '/rest/api/3/issue/KAN-1/transitions?expand=transitions.fields', 200, transitions);
  const { r, p, s } = await connected(
    withReread([PRE('KAN-1', U), TR, rec('POST', '/rest/api/3/issue/KAN-1/transitions', 204, null)], 'KAN-1', U),
    withReread([PRE('KAN-1', U), TR, rec('POST', '/rest/api/3/issue/KAN-1/transitions', 204, null)], 'KAN-1', U),
    [PRE('KAN-1', U), TR],
    withReread([PRE('KAN-1', U), TR, rec('POST', '/rest/api/3/issue/KAN-1/transitions', 204, null)], 'KAN-1', U),
    [PRE('KAN-1', U, { status: { name: 'Done' } }), { ...TR, response: { transitions: [] } }],
  );
  assert.equal((await p.apply(s, intent('KAN-1', 'transition', { to: 'in-progress' }, U))).ok, true);
  assert.equal((await p.apply(s, intent('KAN-1', 'transition', { to: 'in-progress', toName: 'In Review' }, U))).ok, true);
  const needs = await p.apply(s, intent('KAN-1', 'transition', { to: 'done' }, U));
  assert.deepEqual(needs, { ok: false, error: 'the status change needs Resolution, which the request does not give' });
  assert.equal((await p.apply(s, intent('KAN-1', 'transition', { to: 'done', fields: { resolution: { name: 'Done' }, notOnScreen: 1 } }, U))).ok, true);
  const none = await p.apply(s, intent('KAN-1', 'transition', { to: 'todo' }, U));
  assert.deepEqual(none, { ok: false, error: 'Jira says: no transition from Done to todo' });
  const posts = r.calls.filter((c) => c.method === 'POST').map((c) => c.body);
  assert.deepEqual(posts, [{ transition: { id: '21' } }, { transition: { id: '31' } }, { transition: { id: '41' }, fields: { resolution: { name: 'Done' } } }]);
});

test('edit: title → summary, description → ADF, labels → add/remove verbs against what Jira has, estimate → the board field', async () => {
  const U = '2026-09-30T18:00:00.000-0400';
  const { r, p, s } = await connected(withReread([PRE('KAN-1', U, { labels: ['keep', 'drop'] }), rec('PUT', '/rest/api/3/issue/KAN-1', 204, null)], 'KAN-1', U));
  const res = await p.apply(s, intent('KAN-1', 'edit', { fields: { title: 'New title', description: '# Head\n\n- a\n- b', labels: ['keep', 'new'], estimate: 8 } }, U));
  assert.equal(res.ok, true);
  const put = r.calls.find((c) => c.method === 'PUT')!.body as { fields: Record<string, unknown>; update: Record<string, unknown> };
  assert.equal(put.fields.summary, 'New title');
  assert.equal(put.fields.customfield_10016, 8);
  assert.equal(adfToMarkdown(put.fields.description), '# Head\n\n- a\n- b');
  assert.deepEqual(put.update, { labels: [{ add: 'new' }, { remove: 'drop' }] });
  assert.equal('labels' in put.fields, false);
  const { p: p2, s: s2 } = await connected([PRE('KAN-1', U)]);
  assert.deepEqual(await p2.apply(s2, intent('KAN-1', 'edit', { fields: { colour: 'red' } }, U)), { ok: false, error: 'cannot edit colour: it is not mapped to a Jira field' });
});

test('link: direction by kind (measured: inwardIssue is the one that blocks)', async () => {
  const U = '2026-09-30T18:00:00.000-0400';
  const L = () => rec('POST', '/rest/api/3/issueLink', 201, null);
  const { r, p, s } = await connected(
    withReread([PRE('KAN-1', U), L()], 'KAN-1', U), withReread([PRE('KAN-1', U), L()], 'KAN-1', U), withReread([PRE('KAN-1', U), L()], 'KAN-1', U),
  );
  await p.apply(s, intent('KAN-1', 'link', { kind: 'blocks', target: 'work::jira-example::KAN-2' }, U));
  await p.apply(s, intent('KAN-1', 'link', { kind: 'blocked-by', target: 'KAN-3' }, U));
  await p.apply(s, intent('KAN-1', 'link', { kind: 'relates', target: 'SAM1-1' }, U));
  assert.deepEqual(r.calls.filter((c) => c.method === 'POST').map((c) => c.body), [
    { type: { name: 'Blocks' }, inwardIssue: { key: 'KAN-1' }, outwardIssue: { key: 'KAN-2' } },
    { type: { name: 'Blocks' }, inwardIssue: { key: 'KAN-3' }, outwardIssue: { key: 'KAN-1' } },
    { type: { name: 'Relates' }, inwardIssue: { key: 'KAN-1' }, outwardIssue: { key: 'SAM1-1' } },
  ]);
});

test('writes to one issue are serialised; a write sends reconcileIssues on the next search', async () => {
  const U = '2026-09-30T18:00:00.000-0400';
  const order: string[] = [];
  const tape = [
    ...withReread([PRE('KAN-1', U), rec('POST', '/rest/api/3/issue/KAN-1/comment', 201, {})], 'KAN-1', U),
    ...withReread([PRE('KAN-1', U), rec('POST', '/rest/api/3/issue/KAN-1/comment', 201, {})], 'KAN-1', U),
  ];
  const r = replay(load('connect.json'), load('discover.json'), tape, load('pull-incremental.json'));
  const slowFetch = async (url: string, init: RequestInit) => {
    order.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);
    await new Promise((res) => setTimeout(res, 5));
    return r.fetcher(url, init);
  };
  const p = createJiraProvider({ fetcher: slowFetch, sleep: async () => {}, pageSize: 5 });
  const s = await p.connect(SOURCE, FAKE_TOKEN);
  await p.discover(s);
  order.length = 0;
  const [a, b] = await Promise.all([
    p.apply(s, intent('KAN-1', 'comment', { body: 'one' }, U)),
    p.apply(s, intent('KAN-1', 'comment', { body: 'two' }, U)),
  ]);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(order.map((x) => x.split(' ')[0]), ['GET', 'POST', 'GET', 'GET', 'POST', 'GET'], 'the second write waits for the first');
  for await (const pg of p.pull(s, JSON.stringify({ v: 1, at: 1790808027978, seen: [] }), SOURCE.scope)) { if (pg.isLast) break; }
  const search = r.calls.find((c) => c.path === '/rest/api/3/search/jql')!.body as { reconcileIssues?: number[] };
  assert.deepEqual(search.reconcileIssues, [10099]);
});
