// The engine and the gate, driven by the recorded fixture (they live here and
// not in packages/work because work cannot depend on its own plugin).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureProvider, INVOICE_APP_FIXTURE } from '../dist/index.js';
import { WorkCache, workDbPath, syncSource, freshness, connectSource, applyIntent, evaluatePolicy } from '@farsight/work';
import type { SourceConfig, Permissions, Intent, WorkProvider } from '@farsight/work';

function setup(permissions?: Permissions, mode: 'read-only' | 'edit' = 'edit') {
  const root = mkdtempSync(join(tmpdir(), 'work-engine-'));
  const dir = join(root, 'invoice-app');
  cpSync(INVOICE_APP_FIXTURE, dir, { recursive: true });
  let t = Date.UTC(2026, 8, 30, 12, 0, 0);
  const now = () => new Date((t += 1000));
  const cfg: SourceConfig = { id: 'invoice-jira', type: 'work', provider: 'fixture', path: dir, scope: { projects: ['INV'] }, mode, ...(permissions ? { permissions } : {}) };
  return { root, dir, cfg, now, provider: createFixtureProvider({ now }), cache: new WorkCache(workDbPath(root)) };
}
const id = (k: string) => `work::invoice-jira::${k}`;
const ask = (item: string, o: Partial<Intent> = {}): Intent => ({
  id: `i-${Math.random().toString(36).slice(2)}`, item, action: 'comment', payload: { body: 'on it' }, requestedBy: { kind: 'human', id: 'u1' }, ...o,
});

test('engine: full → incremental → delete → quiet, with SCD2 and freshness', async () => {
  const { cfg, provider, cache, now } = setup();
  assert.equal(freshness(cache.getSource(cfg.id)).state, 'never');
  const r1 = await syncSource(cfg, provider, cache, { now });
  assert.equal(r1.error, undefined);
  assert.deepEqual([r1.pulled, r1.changed, r1.deleted], [8, 8, 0]);
  assert.equal(cache.getSource(cfg.id)!.schema!.projects[0]!.key, 'INV');
  const r2 = await syncSource(cfg, provider, cache, { now });
  assert.deepEqual([r2.pulled, r2.changed, r2.deleted], [3, 3, 0]);
  assert.equal(cache.getItem(id('INV-6'))!.state.category, 'done');
  assert.equal(cache.itemAt(id('INV-6'), r1.syncNo)!.state.category, 'in-progress');
  const r3 = await syncSource(cfg, provider, cache, { now });
  assert.deepEqual([r3.pulled, r3.changed, r3.deleted], [0, 0, 1]);
  assert.equal(cache.getItem(id('INV-7')), null);
  const r4 = await syncSource(cfg, provider, cache, { now });
  assert.deepEqual([r4.pulled, r4.changed, r4.deleted], [0, 0, 0]);
  assert.equal(r4.cursor, r3.cursor);
  assert.equal(cache.listItems().length, 8);
  const f = freshness(cache.getSource(cfg.id), new Date(Date.UTC(2026, 8, 30, 12, 5, 0)));
  assert.equal(f.state, 'synced');
  assert.ok(f.ago! > 0);
});

test('engine: an unreadable credential is credential-expired, keeps the cursor and the cache', async () => {
  const { cfg, provider, cache, now } = setup();
  await syncSource(cfg, provider, cache, { now });
  const cursor = cache.getSource(cfg.id)!.cursor;
  const bad = { ...cfg, auth: { kind: 'api-token' as const, secret: 'env:WORK_TEST_NOT_SET' } };
  const r = await syncSource(bad, provider, cache, { now, secrets: { env: {} } });
  assert.equal(r.errorKind, 'credential');
  assert.match(r.error!, /env:WORK_TEST_NOT_SET/);
  const row = cache.getSource(cfg.id)!;
  assert.equal(row.cursor, cursor);
  const f = freshness(row);
  assert.equal(f.state, 'credential-expired');
  assert.ok(f.lastOkAt);
  assert.equal(cache.listItems().length, 8, 'the cache is still shown');
});

test('engine: an unreachable tracker reads unreachable since the first failure', async () => {
  const { cfg, provider, cache, now } = setup();
  await syncSource(cfg, provider, cache, { now });
  const down: WorkProvider = { ...provider, connect: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } };
  const a = await syncSource(cfg, down, cache, { now });
  await syncSource(cfg, down, cache, { now });
  const f = freshness(cache.getSource(cfg.id));
  assert.equal(f.state, 'unreachable');
  assert.ok(f.since! <= new Date(Date.UTC(2026, 8, 30, 12, 1)).toISOString());
  assert.equal(a.errorKind, 'unreachable');
});

const GRANTS: Permissions = {
  default: 'deny',
  grants: [
    { actions: ['comment'], principals: ['human', 'agent'] },
    { actions: ['edit'], fields: ['labels', 'estimate'], principals: ['human'] },
    { actions: ['transition'], to: ['in-progress', 'done'], scope: { projects: ['INV'] }, principals: ['human'] },
  ],
};

test('gate: allowed — three yeses, applied, re-read, replaced, audited', async () => {
  const { cfg, provider, cache, now } = setup(GRANTS);
  await syncSource(cfg, provider, cache, { now });
  const session = await connectSource(cfg, provider);
  const before = cache.getItem(id('INV-5'))!;
  const out = await applyIntent(ask(id('INV-5')), { cfg, provider, session, cache, now });
  assert.equal(out.state, 'confirmed');
  assert.ok(out.verdicts!.policy.allowed && out.verdicts!.tracker.allowed && out.verdicts!.credential.allowed);
  const after = cache.getItem(id('INV-5'))!;
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.comments.at(-1)!.body.text, 'on it');
  const audit = cache.listAudit({ item: id('INV-5') });
  assert.equal(audit.at(-1)!.outcome, 'confirmed');
  assert.ok(audit.at(-1)!.verdicts!.credential.allowed);
});

test('gate: denied by policy — read-only mode, an ungranted field, a transition out of scope', async () => {
  const ro = setup(GRANTS, 'read-only');
  await syncSource(ro.cfg, ro.provider, ro.cache, { now: ro.now });
  const s = await connectSource(ro.cfg, ro.provider);
  const out = await applyIntent(ask(id('INV-5')), { ...ro, session: s });
  assert.equal(out.state, 'denied');
  assert.equal(out.verdicts!.policy.reason, 'this source is read-only');
  assert.match(out.verdicts!.tracker.reason, /^not asked/);

  const { cfg, provider, cache, now } = setup(GRANTS);
  await syncSource(cfg, provider, cache, { now });
  const session = await connectSource(cfg, provider);
  const edit = await applyIntent(ask(id('INV-5'), { action: 'edit', payload: { fields: { title: 'x' } } }), { cfg, provider, session, cache, now });
  assert.equal(edit.state, 'denied');
  assert.match(edit.verdicts!.policy.reason, /title/);
  const assign = await applyIntent(ask(id('INV-5'), { action: 'assign', payload: { assignee: 'u1' } }), { cfg, provider, session, cache, now });
  assert.equal(assign.verdicts!.policy.reason, 'no grant allows assign');
  const move = await applyIntent(ask(id('INV-5'), { action: 'transition', payload: { to: 'removed' } }), { cfg, provider, session, cache, now });
  assert.match(move.verdicts!.policy.reason, /removed/);
  assert.equal(cache.listOutbox({ state: 'denied' }).length, 3);
  assert.equal(cache.listAudit().filter((a) => a.outcome === 'denied').length, 3);
});

test('gate: denied by the tracker, and by a read-only credential', async () => {
  const { cfg, provider, cache, now, dir } = setup(GRANTS);
  await syncSource(cfg, provider, cache, { now });
  const session = await connectSource(cfg, provider);
  const out = await applyIntent(ask(id('INV-8'), { action: 'transition', payload: { to: 'in-progress' } }), { cfg, provider, session, cache, now });
  assert.equal(out.state, 'denied');
  assert.ok(out.verdicts!.policy.allowed);
  assert.equal(out.verdicts!.tracker.allowed, false);
  assert.match(out.verdicts!.tracker.reason, /no transition out of Done/);

  writeFileSync(join(dir, 'permissions.json'), JSON.stringify({ credential: { read: true, write: false, detail: 'read:jira-work' } }));
  const roSession = await connectSource(cfg, provider);
  const c = await applyIntent(ask(id('INV-5')), { cfg, provider, session: roSession, cache, now });
  assert.equal(c.state, 'denied');
  assert.equal(c.verdicts!.credential.allowed, false);
  assert.match(c.verdicts!.credential.reason, /read:jira-work/);
});

test('gate: a stale revision is a conflict, never applied; the cache takes the tracker’s record', async () => {
  const { cfg, provider, cache, now } = setup(GRANTS);
  await syncSource(cfg, provider, cache, { now });
  const session = await connectSource(cfg, provider);
  const cached = cache.getItem(id('INV-5'))!;
  // someone else writes on the tracker after we read it
  await provider.apply(session, { id: 'other', item: cached.id, action: 'label', payload: { add: ['urgent'] }, requestedBy: { kind: 'human', id: 'u2' } });
  const out = await applyIntent(ask(id('INV-5'), { baseRevision: cached.revision }), { cfg, provider, session, cache, now });
  assert.equal(out.state, 'conflict');
  assert.ok(out.item!.labels.includes('urgent'));
  assert.ok(cache.getItem(id('INV-5'))!.labels.includes('urgent'));
  assert.equal(cache.getItem(id('INV-5'))!.comments.length, cached.comments.length, 'the comment was not applied');
  assert.equal(cache.listAudit().at(-1)!.outcome, 'conflict');
});

test('gate: an agent write waits for a person, then applies with attribution', async () => {
  const { cfg, provider, cache, now } = setup(GRANTS);
  await syncSource(cfg, provider, cache, { now });
  const session = await connectSource(cfg, provider);
  const intent = ask(id('INV-5'), { requestedBy: { kind: 'agent', id: 'mcp-7', tool: 'work_comment' } });
  const out = await applyIntent(intent, { cfg, provider, session, cache, now });
  assert.equal(out.state, 'queued');
  assert.equal(out.pending, true);
  assert.equal(cache.getItem(id('INV-5'))!.comments.length, 0, 'nothing written yet');
  assert.equal(cache.listAudit().at(-1)!.outcome, 'confirm-pending');
  const done = await applyIntent(intent, { cfg, provider, session, cache, now, confirmed: true });
  assert.equal(done.state, 'confirmed');
  assert.equal(cache.getItem(id('INV-5'))!.comments.at(-1)!.body.text, 'via Farsight (agent): on it');
  assert.equal(cache.listOutbox({ state: 'confirmed' }).length, 1);
});

test('policy: an agent needs a grant that names agents', () => {
  const item = { key: 'INV-5', fields: {}, type: { name: 'Story', category: 'story' }, state: { name: 'To Do', category: 'todo' } } as never;
  const d = evaluatePolicy({ grants: [{ actions: ['edit'], fields: ['labels'] }] }, ask('x', { action: 'edit', payload: { fields: { labels: [] } }, requestedBy: { kind: 'agent', id: 'm' } }), item, { mode: 'edit' });
  assert.equal(d.verdict.allowed, false);
  assert.equal(d.verdict.reason, 'no grant allows edit for an agent');
});
