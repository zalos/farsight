import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraProvider, sessionFacts, JIRA_CAPABILITIES } from '../dist/index.js';
import { load, replay, SOURCE, FAKE_TOKEN } from './replay.ts';

test('connect: the account, the cloud id, and what the credential may do per project', async () => {
  const r = replay(load('connect.json'));
  const p = createJiraProvider({ fetcher: r.fetcher });
  const s = await p.connect(SOURCE, FAKE_TOKEN);
  assert.equal(s.provider, 'jira');
  assert.equal(s.endpoint, 'https://example.atlassian.net');
  assert.equal(s.user?.name, 'Farsight Test');
  assert.match(String(s.user?.id), /^712020:/, 'Person.id is the accountId');
  assert.equal(s.cloudId, '00000000-0000-4000-8000-000000000100');
  assert.deepEqual({ read: s.credentialScope?.read, write: s.credentialScope?.write }, { read: true, write: true });
  assert.match(String(s.credentialScope?.detail), /KAN: browse, edit issues, add comments, assign issues, transition issues, link issues/);
  const tenant = r.calls.find((c) => c.path === '/_edge/tenant_info');
  assert.equal(tenant?.auth, false, 'tenant_info is asked without the credential');
  assert.ok(r.calls.filter((c) => c.path !== '/_edge/tenant_info').every((c) => c.auth));
  assert.equal(JSON.stringify(s).includes(FAKE_TOKEN), false, 'the session never carries the token');
  assert.deepEqual(r.unused(), []);
});

test('capabilities are the §4.4 Jira row', () => {
  assert.deepEqual(JIRA_CAPABILITIES.comments, { read: true, write: true, format: 'adf' });
  assert.equal(JIRA_CAPABILITIES.transitions, 'per-item');
  assert.equal(JIRA_CAPABILITIES.concurrency, 'compare-updated');
  assert.equal(JIRA_CAPABILITIES.permissionsProbe, 'per-item');
  assert.equal(JIRA_CAPABILITIES.deletesVisible, false);
  assert.equal(JIRA_CAPABILITIES.push, 'none');
  assert.equal(JIRA_CAPABILITIES.dryRun, false);
  assert.equal(JIRA_CAPABILITIES.actions?.includes('create'), false, 'create is not built');
});

test('discover: types by hierarchy, states by status category, Sprint and estimate found on the site', async () => {
  const r = replay(load('connect.json'), load('discover.json'));
  const p = createJiraProvider({ fetcher: r.fetcher });
  const s = await p.connect(SOURCE, FAKE_TOKEN);
  const schema = await p.discover(s);
  assert.deepEqual(schema.projects.map((x) => x.key), ['KAN', 'SAM1']);
  const cat = Object.fromEntries(schema.types.map((x) => [x.name, x.category]));
  assert.deepEqual(cat, { Epic: 'epic', Subtask: 'task', Task: 'task', Story: 'story' });
  const st = Object.fromEntries(schema.states.map((x) => [x.name, x.category]));
  assert.deepEqual(st, { 'To Do': 'todo', 'In Progress': 'in-progress', 'In Review': 'in-progress', Done: 'done' });
  assert.equal(schema.types.find((x) => x.name === 'Story')?.states?.length, 4);
  const byCanon = Object.fromEntries(schema.fields.map((f) => [f.canonical, f]));
  assert.deepEqual(byCanon.iteration, { id: 'customfield_10020', name: 'Sprint', canonical: 'iteration', origin: 'found' });
  assert.deepEqual(byCanon.estimate, { id: 'customfield_10016', name: 'Story point estimate', canonical: 'estimate', origin: 'found' });
  assert.ok(r.calls.some((c) => c.path === '/rest/agile/1.0/board/2/configuration'), 'the estimate came from the board');
  const lk = Object.fromEntries(schema.linkTypes.map((l) => [l.native, l.kind]));
  assert.deepEqual(lk, { Blocks: 'blocks', Cloners: 'other', Duplicate: 'duplicates', Relates: 'relates' });
  assert.equal(schema.bodyFormat, 'adf');
  assert.deepEqual(r.unused(), []);
});

test('discover: a field pinned in settings is declared by you and wins', async () => {
  const r = replay(load('connect.json'), load('discover.json'));
  const p = createJiraProvider({ fetcher: r.fetcher });
  const s = await p.connect({ ...SOURCE, fields: { estimate: 'customfield_10016', team: 'customfield_10001' } }, FAKE_TOKEN);
  const schema = await p.discover(s);
  const byCanon = Object.fromEntries(schema.fields.map((f) => [f.canonical, f]));
  assert.equal(byCanon.estimate?.origin, 'declared');
  assert.equal(byCanon.iteration?.origin, 'found');
  assert.deepEqual(byCanon.team, { id: 'customfield_10001', name: 'Team', canonical: 'team', origin: 'declared' });
  assert.equal(sessionFacts(s).fieldOrigin.estimate, 'declared');
});
