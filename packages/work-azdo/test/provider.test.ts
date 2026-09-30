// The provider end to end over the fake ADO: connect → discover → pull (full,
// feed, fallback) → hydrate → can → apply / preview, and the engine's own
// syncSource over a temp WorkCache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAzdoProvider, normalizeOrg, AZDO_CAPABILITIES, AzdoAuthNotBuilt, buildPatch, transitionTarget, typeInfo } from '../dist/index.js';
import { WorkCache, syncSource } from '@farsight/work';
import type { PullPage, Intent, SourceConfig } from '@farsight/work';
import { fakeAdo, cfg, FAKE_PAT, noSleep, rec } from './fake.ts';

async function drain(it: AsyncIterable<PullPage>): Promise<PullPage[]> {
  const out: PullPage[] = [];
  for await (const p of it) out.push(p);
  return out;
}
function setup(opts: Parameters<typeof fakeAdo>[0] = {}, c: Partial<SourceConfig> = {}) {
  const fake = fakeAdo(opts);
  const p = createAzdoProvider({ fetcher: fake.fetcher, sleep: noSleep, now: () => Date.parse('2026-09-30T23:00:00Z') });
  return { fake, p, cfg: cfg(c) as SourceConfig };
}
const intent = (action: Intent['action'], payload: Intent['payload'], baseRevision = '4', item = 'work::example-azdo::352'): Intent =>
  ({ id: 'i1', item, action, payload, requestedBy: { kind: 'human', id: 'jared' }, baseRevision });

test('provider: capabilities are declared as §4.4 says, and create is not offered', () => {
  assert.deepEqual(AZDO_CAPABILITIES, {
    comments: { read: true, write: true, format: 'markdown' }, transitions: 'graph', concurrency: 'revision',
    permissionsProbe: 'per-area', deletesVisible: true, push: 'none', dryRun: true,
    actions: ['comment', 'edit', 'assign', 'transition', 'link', 'label'],
  });
  assert.equal(normalizeOrg('https://example-org.visualstudio.com/'), 'https://dev.azure.com/example-org');
  assert.equal(normalizeOrg('https://dev.azure.com/example-org/'), 'https://dev.azure.com/example-org');
});

test('connect: session from connectionData, API version capped, credential scope by WIQL and a validateOnly dry run', async () => {
  const { fake, p, cfg: c } = setup({}, { mode: 'edit' });
  const s = await p.connect(c, FAKE_PAT);
  assert.equal(s.provider, 'azure-devops');
  assert.equal(s.endpoint, 'https://dev.azure.com/example-org');
  assert.deepEqual(s.user, { id: 'aad.MDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAy', name: 'Example Dev' });
  assert.equal(s.apiVersion, '7.1');
  assert.equal(s.commentsApiVersion, '7.2-preview.4');
  assert.equal(s.deploymentType, 'hosted');
  assert.equal(s.credentialScope!.read, true);
  assert.equal(s.credentialScope!.write, true);
  assert.match(s.credentialScope!.detail!, /dry run on \d+ was accepted/);
  const patches = fake.seen.filter((r) => r.method === 'PATCH');
  assert.ok(patches.length >= 1);
  assert.ok(patches.every((r) => r.query.get('validateOnly') === 'true'), 'connect never PATCHes without validateOnly');
  assert.ok(fake.seen.every((r) => r.auth === 'Basic ' + Buffer.from(':' + FAKE_PAT).toString('base64')));
  assert.ok(!JSON.stringify(s).includes(FAKE_PAT) && !JSON.stringify(s).includes(Buffer.from(':' + FAKE_PAT).toString('base64')), 'the session carries no credential');
});

test('connect: read-only mode does not probe writes; a 403 dry run means reads only; on-prem 7.0 caps the version', async () => {
  const ro = setup();
  const s = await ro.p.connect(ro.cfg, FAKE_PAT);
  assert.deepEqual([s.credentialScope!.read, s.credentialScope!.write], [true, false]);
  assert.match(s.credentialScope!.detail!, /not checked/);
  assert.ok(!ro.fake.seen.some((r) => r.method === 'PATCH'));
  const denied = setup({ handlers: [(r) => (r.method === 'PATCH' ? { status: 403, body: { message: 'TF401289: no' } } : undefined)] }, { mode: 'edit' });
  const s2 = await denied.p.connect(denied.cfg, FAKE_PAT);
  assert.equal(s2.credentialScope!.write, false);
  assert.match(s2.credentialScope!.detail!, /reads only/);
  const onprem = setup({ handlers: [(r) => {
    if (r.path !== '/_apis/connectionData') return undefined;
    if (r.query.get('api-version') === '7.1-preview.1') return { status: 400, body: { message: 'VssVersionOutOfRangeException' } };
    return { body: { ...rec('connectionData'), deploymentType: 'onPremises' } };
  }] });
  const s3 = await onprem.p.connect(onprem.cfg, FAKE_PAT);
  assert.equal(s3.apiVersion, '7.0');
  assert.equal(s3.commentsApiVersion, '7.0-preview.3');
});

test('connect: entra-device-code is a typed not-built error naming MSAL; a missing org is refused', async () => {
  const { p, cfg: c } = setup();
  await assert.rejects(p.connect({ ...c, auth: { kind: 'entra-device-code' } }, undefined), (e: unknown) => e instanceof AzdoAuthNotBuilt && /MSAL/.test((e as Error).message));
  await assert.rejects(p.connect({ ...c, org: undefined }, FAKE_PAT), /org URL/);
});

test('connect: az-cli gets an Entra token in process and sends it as Bearer', async () => {
  const fake = fakeAdo();
  const p = createAzdoProvider({ fetcher: fake.fetcher, sleep: noSleep, azRunner: async (cmd, args) => {
    assert.equal(cmd, 'az');
    assert.deepEqual(args.slice(0, 4), ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798']);
    return JSON.stringify({ accessToken: 'entra-fake', expires_on: 4102444800 });
  } });
  await p.connect({ ...(cfg() as SourceConfig), auth: { kind: 'az-cli' } }, undefined);
  assert.ok(fake.seen.every((r) => r.auth === 'Bearer entra-fake'));
});

test('discover: types with state categories and transitions, found fields, iterations, link types', async () => {
  const { p, cfg: c } = setup({}, { fields: { estimate: 'Microsoft.VSTS.Scheduling.Effort' } });
  const s = await p.connect(c, FAKE_PAT);
  const sc = await p.discover(s);
  assert.deepEqual(sc.projects, [{ key: 'ExampleProject', name: 'ExampleProject', id: '00000000-0000-4000-8000-000000000006' }]);
  const pbi = sc.types.find((t) => t.name === 'Product Backlog Item')!;
  assert.equal(pbi.category, 'story');
  assert.deepEqual(pbi.states, [{ name: 'New', category: 'todo' }, { name: 'Approved', category: 'todo' }, { name: 'Committed', category: 'in-progress' }, { name: 'Done', category: 'done' }, { name: 'Removed', category: 'removed' }]);
  assert.deepEqual(pbi.transitions!['Removed'], ['Removed', 'New']);
  assert.ok(sc.fields.some((f) => f.canonical === 'estimate' && f.id === 'Microsoft.VSTS.Scheduling.Effort' && f.origin === 'declared'));
  assert.ok(sc.fields.some((f) => f.canonical === 'remaining' && f.origin === 'found'));
  assert.ok(sc.linkTypes.some((l) => l.native === 'System.LinkTypes.Hierarchy-Reverse' && l.kind === 'parent'));
  assert.equal(sc.linkTypes.length, 21);
  assert.equal(sc.bodyFormat, 'html');
});

test('pull: first pull drains the feed for a watermark, then WIQL → workitemsbatch in 200s', async () => {
  const items = new Map<number, any>();
  const tpl = rec('batch').value[3];
  for (let id = 1000; id < 1450; id++) items.set(id, { ...structuredClone(tpl), id });
  const { fake, p, cfg: c } = setup({ items });
  const s = await p.connect(c, FAKE_PAT);
  fake.seen.length = 0;
  const pages = await drain(p.pull(s, null, c.scope));
  assert.deepEqual(pages.map((x) => x.items.length), [200, 200, 50]);
  assert.deepEqual(pages.map((x) => x.isLast), [false, false, true]);
  assert.deepEqual(pages.map((x) => x.cursor === null), [true, true, false]);
  const cur = JSON.parse(pages.at(-1)!.cursor!);
  assert.deepEqual(cur, { v: 1, p: { ExampleProject: { t: '1009;351;15;Discussion', since: '2026-09-30T22:31:39.617Z' } } });
  const order = fake.seen.map((r) => r.path).filter((x) => /reporting|wiql|workitemsbatch/.test(x));
  assert.equal(order[0], '/ExampleProject/_apis/wit/reporting/workitemrevisions', 'the watermark is taken before the ids');
  const batches = fake.seen.filter((r) => r.path === '/_apis/wit/workitemsbatch');
  assert.deepEqual(batches.map((b) => b.body.ids.length), [200, 200, 50]);
  assert.ok(batches.every((b) => b.body.$expand === 'relations'));
});

test('pull: WIQL pages past 19,000 ids by id, never trusting one truncated answer', async () => {
  const handlers = [(r: any) => {
    if (r.path !== '/ExampleProject/_apis/wit/wiql' || !/\[System\.Id\] >/.test(r.body.query)) return undefined;
    const after = Number(/\[System\.Id\] > (\d+)/.exec(r.body.query)![1]);
    const ids = after === 0 ? Array.from({ length: 19000 }, (_, n) => n + 1) : after === 19000 ? [19001, 19002] : [];
    return { body: { asOf: '2026-09-30T00:00:00Z', workItems: ids.map((id) => ({ id })) } };
  }];
  const { fake, p, cfg: c } = setup({ handlers, items: new Map() });
  const s = await p.connect(c, FAKE_PAT);
  const pages = await drain(p.pull(s, null, c.scope));
  const wiql = fake.seen.filter((r) => r.path === '/ExampleProject/_apis/wit/wiql' && /Id\] >/.test(r.body.query));
  assert.deepEqual(wiql.map((r) => /\[System\.Id\] > (\d+)/.exec(r.body.query)![1]), ['0', '19000']);
  assert.equal(pages.at(-1)!.deleted!.length, 19002, 'ids the batch no longer returns are gone');
});

test('pull: incremental reads the revisions feed from the watermark — changes, deletions, the new watermark', async () => {
  const handlers = [(r: any) => {
    if (r.path !== '/ExampleProject/_apis/wit/reporting/workitemrevisions') return undefined;
    assert.equal(r.query.get('continuationToken'), 'W1');
    assert.equal(r.query.get('includeDeleted'), 'true');
    assert.equal(r.query.get('includeLatestOnly'), 'true');
    return { body: { values: [
      { id: 350, rev: 10, fields: { 'System.Id': 350, 'System.IsDeleted': false } },
      { id: 777, rev: 3, fields: { 'System.Id': 777, 'System.IsDeleted': true } },
    ], continuationToken: 'W2', isLastBatch: true } };
  }];
  const { fake, p, cfg: c } = setup({ handlers });
  const s = await p.connect(c, FAKE_PAT);
  const pages = await drain(p.pull(s, JSON.stringify({ v: 1, p: { ExampleProject: { t: 'W1', since: '2026-09-01T00:00:00Z' } } }), c.scope));
  assert.deepEqual(pages.flatMap((x) => x.items.map((i) => i.key)), ['350']);
  assert.deepEqual(pages.at(-1)!.deleted, ['work::example-azdo::777']);
  assert.equal(JSON.parse(pages.at(-1)!.cursor!).p.ExampleProject.t, 'W2');
});

test('pull: when the feed cannot answer, WIQL on ChangedDate with timePrecision is the fallback', async () => {
  const handlers = [(r: any) => (r.path === '/ExampleProject/_apis/wit/reporting/workitemrevisions' ? { status: 404, body: { message: 'gone' } } : undefined)];
  const { fake, p, cfg: c } = setup({ handlers });
  const s = await p.connect(c, FAKE_PAT);
  const pages = await drain(p.pull(s, JSON.stringify({ v: 1, p: { ExampleProject: { t: 'W1', since: '2026-05-10T00:00:00.000Z' } } }), { projects: ['ExampleProject'], areas: ['ExampleProject'] }));
  const q = fake.seen.filter((r) => r.path === '/ExampleProject/_apis/wit/wiql').at(-1)!;
  assert.equal(q.query.get('timePrecision'), 'true');
  assert.match(q.body.query, /\[System\.AreaPath\] UNDER 'ExampleProject'/);
  assert.match(q.body.query, /\[System\.ChangedDate\] > '2026-05-10T00:00:00\.000Z'/);
  assert.equal(pages.flatMap((x) => x.items).length, 4);
  assert.deepEqual(JSON.parse(pages.at(-1)!.cursor!).p.ExampleProject, { since: '2026-09-30T22:31:39.617Z' });
  await assert.rejects(drain(p.pull(s, 'not-a-cursor', c.scope)), /not one this provider wrote/);
});

test('hydrate: history from updates and comments from the 7.2-preview comments API', async () => {
  const { p, cfg: c } = setup();
  const s = await p.connect(c, FAKE_PAT);
  const [a, b] = await p.hydrate(s, ['work::example-azdo::350', 'work::example-azdo::351']);
  assert.equal(a!.comments.length, 1);
  assert.equal(a!.comments[0]!.body.text, 'Need to have a way to check duplicates');
  assert.ok(a!.history.length > 0);
  assert.equal(b!.comments.length, 1);
});

test('can: yes / not on this area / state undefined / no move / existing tags only / could not ask', async () => {
  const { p, cfg: c } = setup();
  const s = await p.connect(c, FAKE_PAT);
  const [i349, , , i352] = (await drain(p.pull(s, null, c.scope))).flatMap((x) => x.items);
  assert.deepEqual(await p.can(s, i352!, 'comment'), { allowed: true, reason: 'Azure DevOps says: yes' });
  assert.deepEqual(await p.can(s, i352!, 'label'), { allowed: true, reason: 'Azure DevOps says: yes, with tags that already exist' });
  assert.equal((await p.can(s, i352!, 'create')).allowed, false);
  const bad = await p.can(s, i349!, 'edit');
  assert.equal(bad.allowed, false);
  assert.match(bad.reason, /Epic items have no state To Do/);
  const removed = { ...i352!, state: { name: 'Removed', category: 'removed' as const } };
  assert.equal((await p.can(s, removed, 'transition')).allowed, true, 'Removed → New is on the map');
  const stuck = setup({ handlers: [(r) => (r.path === '/ExampleProject/_apis/wit/workitemtypes' ? { body: { value: rec('workitemtypes').value.map((t: any) => t.name === 'Product Backlog Item' ? { ...t, transitions: { New: [{ to: 'New' }] } } : t) } } : undefined)] });
  const s2 = await stuck.p.connect(stuck.cfg, FAKE_PAT);
  assert.match((await stuck.p.can(s2, i352!, 'transition')).reason, /Product Backlog Item items cannot move from New/);
  const deny = setup({ handlers: [(r) => (r.path === '/_apis/security/permissionevaluationbatch' ? { body: { evaluations: r.body.evaluations.map((e: any) => ({ ...e, value: false })) } } : undefined)] });
  const s3 = await deny.p.connect(deny.cfg, FAKE_PAT);
  assert.deepEqual(await deny.p.can(s3, i352!, 'edit'), { allowed: false, reason: 'Azure DevOps says: not on this area (ExampleProject)' });
  const err = setup({ handlers: [(r) => (r.path === '/_apis/security/permissionevaluationbatch' ? { status: 401, body: {} } : undefined)] });
  const s4 = await err.p.connect(err.cfg, FAKE_PAT);
  const v = await err.p.can(s4, i352!, 'edit');
  assert.equal(v.allowed, true);
  assert.match(v.reason, /could not be asked/);
});

test('patch: the bodies apply builds, each opening with test /rev', () => {
  const pbi = typeInfo(rec('workitemtypes').value.find((t: any) => t.name === 'Product Backlog Item'));
  const cur = { id: '352', rev: 4, fields: { 'System.State': 'New', 'System.Title': 'Landing page', 'System.Tags': 'a; b' }, multilineFieldsFormat: { 'System.Description': 'html' } };
  const ctx = { org: 'https://dev.azure.com/example-org', type: pbi, fieldRef: (c: string) => (c === 'estimate' ? 'Microsoft.VSTS.Scheduling.Effort' : undefined) };
  const T = { op: 'test', path: '/rev', value: 4 };
  assert.deepEqual(buildPatch(intent('edit', { fields: { title: 'X', description: '**b**', labels: ['p', 'q'], estimate: 3 } }), cur, ctx), { ops: [T,
    { op: 'replace', path: '/fields/System.Title', value: 'X' },
    { op: 'add', path: '/fields/System.Description', value: '<p><strong>b</strong></p>' },
    { op: 'replace', path: '/fields/System.Tags', value: 'p; q' },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: 3 }] });
  assert.deepEqual(buildPatch(intent('assign', { assignee: 'aad.XYZ' }), cur, ctx), { ops: [T, { op: 'add', path: '/fields/System.AssignedTo', value: { descriptor: 'aad.XYZ' } }] });
  assert.deepEqual(buildPatch(intent('assign', { assignee: 'john@x.test' }), cur, ctx), { ops: [T, { op: 'add', path: '/fields/System.AssignedTo', value: 'john@x.test' }] });
  assert.deepEqual(buildPatch(intent('assign', { assignee: null }), { ...cur, fields: { ...cur.fields, 'System.AssignedTo': {} } }, ctx), { ops: [T, { op: 'remove', path: '/fields/System.AssignedTo' }] });
  assert.deepEqual(buildPatch(intent('transition', { to: 'in-progress' }), cur, ctx), { ops: [T, { op: 'replace', path: '/fields/System.State', value: 'Committed' }] });
  assert.deepEqual(buildPatch(intent('transition', { to: 'todo' }), cur, ctx), { ops: [T, { op: 'replace', path: '/fields/System.State', value: 'Approved' }] }, 'the one other todo state reachable from New');
  assert.match((buildPatch(intent('transition', { to: 'todo' }), { ...cur, fields: { ...cur.fields, 'System.State': 'Committed' } }, ctx) as any).error, /more than one todo state .*New, Approved|Approved, New/);
  assert.deepEqual(buildPatch(intent('transition', { toName: 'Approved' }), cur, ctx), { ops: [T, { op: 'replace', path: '/fields/System.State', value: 'Approved' }] });
  assert.match((buildPatch(intent('transition', { toName: 'Resolved' }), cur, ctx) as any).error, /Product Backlog Item items have no state Resolved/);
  assert.deepEqual(buildPatch(intent('label', { add: ['c', 'A'], remove: ['b'] }), cur, ctx), { ops: [T, { op: 'replace', path: '/fields/System.Tags', value: 'a; c' }] });
  assert.deepEqual(buildPatch(intent('link', { kind: 'parent', target: 'work::example-azdo::349' }), cur, ctx), { ops: [T,
    { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/example-org/_apis/wit/workItems/349' } }] });
  assert.match((buildPatch(intent('edit', { fields: { nope: 1 } }), cur, ctx) as any).error, /not a field this project has/);
  assert.match((buildPatch(intent('edit', { fields: { state: 'Done' } }), cur, ctx) as any).error, /its own action/);
  assert.deepEqual(transitionTarget(pbi, 'Removed', 'todo'), { state: 'New' });
});

test('apply: one PATCH per intent, never bypassRules or suppressNotifications; re-read after; a stale rev is a conflict', async () => {
  const { fake, p, cfg: c } = setup({}, { mode: 'edit' });
  const s = await p.connect(c, FAKE_PAT);
  fake.seen.length = 0;
  const ok = await p.apply(s, intent('edit', { fields: { title: 'New title' } }));
  assert.deepEqual([ok.ok, ok.revision], [true, '5']);
  const patch = fake.seen.filter((r) => r.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.equal(patch[0]!.query.get('validateOnly'), null);
  assert.ok(fake.seen.every((r) => !r.query.has('bypassRules') && !r.query.has('suppressNotifications')));
  assert.deepEqual(patch[0]!.body[0], { op: 'test', path: '/rev', value: 4 });
  assert.equal(fake.seen.at(-1)!.method, 'GET', 're-read after the write');
  // the cache said rev 4, the tracker now says 5: a conflict before any PATCH
  const stale = await p.apply(s, intent('edit', { fields: { title: 'again' } }, '4'));
  assert.deepEqual([stale.ok, stale.conflict, stale.revision], [false, true, '5']);
  assert.match(stale.error!, /version 4, now 5/);
  // a race the pre-read cannot see: the tracker's 412 is the answer
  const race = setup({ handlers: [(r) => (r.method === 'PATCH' ? { status: 412, body: { message: 'VS403351: Test Operation for path /rev failed, value 5 was not equal to test value 4.', typeKey: 'TestPatchOperationFailedException' } } : undefined)] }, { mode: 'read-only' });
  const rs = await race.p.connect(race.cfg, FAKE_PAT);
  const r = await race.p.apply(rs, intent('edit', { fields: { title: 'x' } }));
  assert.deepEqual([r.ok, r.conflict], [false, true]);
  assert.match(r.error!, /VS403351/);
  // a rule violation is the tracker's final word, not a conflict
  const rule = setup({ handlers: [(r) => (r.method === 'PATCH' ? { status: 400, body: rec('dry-badstate-352') } : undefined)] });
  const s5 = await rule.p.connect(rule.cfg, FAKE_PAT);
  const rv = await rule.p.apply(s5, intent('edit', { fields: { title: 'y' } }));
  assert.equal(rv.conflict, undefined);
  assert.match(rv.error!, /rule violation.*not in the list of supported values/);
});

test('apply: comment posts markdown on 7.2-preview.4; preview never saves and says what it could not check', async () => {
  const { fake, p, cfg: c } = setup();
  const s = await p.connect(c, FAKE_PAT);
  fake.seen.length = 0;
  const pv = await p.preview(s, intent('edit', { fields: { title: 'dry' } }));
  assert.equal(pv.ok, true);
  assert.equal(pv.revision, '4');
  assert.equal(fake.items.get(352).rev, 4, 'nothing saved');
  assert.ok(fake.seen.filter((r) => r.method === 'PATCH').every((r) => r.query.get('validateOnly') === 'true'));
  const pc = await p.preview(s, intent('comment', { body: 'hi' }));
  assert.equal(pc.ok, true);
  assert.match((pc.raw as any).note, /cannot check a comment/);
  assert.ok(!fake.seen.some((r) => r.method === 'POST' && /comments/.test(r.path)));
  const cm = await p.apply(s, intent('comment', { body: 'hello **there**' }));
  assert.equal(cm.ok, true);
  const post = fake.seen.find((r) => r.method === 'POST' && /comments$/.test(r.path))!;
  assert.equal(post.query.get('format'), 'markdown');
  assert.equal(post.query.get('api-version'), '7.2-preview.4');
  assert.deepEqual(post.body, { text: 'hello **there**' });
  assert.equal(cm.revision, '5');
  const cr = await p.apply(s, intent('create', { title: 'x' }));
  assert.equal(cr.ok, false);
});

test('engine: syncSource over a temp WorkCache pulls the four ExampleProject items, hydrates them, and a second sync reads the feed', async () => {
  const { p, cfg: c } = setup();
  const cache = new WorkCache(join(mkdtempSync(join(tmpdir(), 'work-azdo-')), 'work.db'));
  // an env: reference, so the unit test never touches the keychain
  const cEnv = { ...c, auth: { kind: 'pat' as const, secret: 'env:ADO' } };
  const r = await syncSource(cEnv, p, cache, { secrets: { env: { ADO: FAKE_PAT } } });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.pulled, 4);
  assert.equal(cache.getItem('work::example-azdo::350')!.comments.length, 1);
  assert.ok(cache.getItem('work::example-azdo::351')!.history.length > 0);
  const r2 = await syncSource(cEnv, p, cache, { secrets: { env: { ADO: FAKE_PAT } } });
  assert.equal(r2.error, undefined);
  assert.equal(r2.changed, 0);
  assert.equal(JSON.parse(r2.cursor!).p.ExampleProject.t, '1009;351;15;Discussion');
  cache.close();
});
