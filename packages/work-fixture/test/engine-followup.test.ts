// The follow-up gaps the Jira and ADO lanes measured: reconcile every Nth sync,
// the cached schema reaching the provider, a 4xx under a cached schema, the dry
// run beside the three verdicts, ApplyResult.item, provider auth errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureProvider, INVOICE_APP_FIXTURE } from '../dist/index.js';
import { WorkCache, workDbPath, syncSource, connectSource, applyIntent, classifyError, parseDuration, freshness } from '@farsight/work';
import type { SourceConfig, WorkProvider, Session, Scope, Permissions } from '@farsight/work';

function setup(extra: Partial<SourceConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'work-followup-'));
  const dir = join(root, 'invoice-app');
  cpSync(INVOICE_APP_FIXTURE, dir, { recursive: true });
  let t = Date.UTC(2026, 8, 30, 12, 0, 0);
  const now = () => new Date((t += 1000));
  const cfg: SourceConfig = { id: 'invoice-jira', type: 'work', provider: 'fixture', path: dir, scope: { projects: ['INV'] }, ...extra };
  return { dir, cfg, now, provider: createFixtureProvider({ now }), cache: new WorkCache(workDbPath(root)) };
}
const id = (k: string) => `work::invoice-jira::${k}`;

test('reconcile: every Nth sync passes the known ids and drops what the tracker no longer has', async () => {
  const { cfg, provider, cache, now } = setup({ reconcileEvery: 3 });
  const scopes: Scope[] = [];
  const spy: WorkProvider = { ...provider, pull: (s, c, scope) => { scopes.push(scope); return provider.pull(s, c, scope); } };
  await syncSource(cfg, spy, cache, { now }); // 1: full, never a reconcile
  // an item the tracker never sends a delete for
  cache.replaceItem(cfg.id, { ...cache.getItem(id('INV-1'))!, id: id('INV-404'), key: 'INV-404' }, 1);
  const r2 = await syncSource(cfg, spy, cache, { now });
  assert.equal(scopes[1]!.reconcile, undefined);
  assert.ok(cache.getItem(id('INV-404')));
  const r3 = await syncSource(cfg, spy, cache, { now });
  assert.ok(scopes[2]!.reconcile!.known.includes(id('INV-404')));
  assert.equal(cache.getItem(id('INV-404')), null);
  assert.ok(r3.deleted >= 1, `r3 ${JSON.stringify(r3)} r2 ${r2.deleted}`);
});

test('schema: the cached discover() reaches the provider; discover runs again only when stale', async () => {
  const { cfg, provider, cache, now } = setup({ rediscoverAfter: '1h' });
  let discovers = 0;
  const seen: (unknown)[] = [];
  const spy: WorkProvider = {
    ...provider,
    discover: async (s) => { discovers++; return provider.discover(s); },
    connect: async (c, sec, ctx) => { seen.push(ctx?.schema); return provider.connect(c, sec, ctx); },
  };
  await syncSource(cfg, spy, cache, { now });
  await syncSource(cfg, spy, cache, { now });
  assert.equal(discovers, 1);
  assert.equal(seen[0], undefined);
  assert.equal((seen[1] as { projects: { key: string }[] }).projects[0]!.key, 'INV');
  // two hours later the cache is stale
  const later = () => new Date(Date.UTC(2026, 8, 30, 15, 0, 0));
  await syncSource(cfg, spy, cache, { now: later });
  assert.equal(discovers, 2);
  assert.equal(parseDuration('1d', 0), 86400_000);
  assert.equal(parseDuration('30m', 0), 1800_000);
  assert.equal(parseDuration('soon', 7), 7);
});

test('schema: a 4xx under a cached schema re-discovers once and retries', async () => {
  const { cfg, provider, cache, now } = setup();
  await syncSource(cfg, provider, cache, { now });
  let discovers = 0;
  let failed = false;
  const flaky: WorkProvider = {
    ...provider,
    discover: async (s) => { discovers++; return provider.discover(s); },
    pull: (s: Session, c, scope) => {
      if (!failed) { failed = true; return (async function* () { throw Object.assign(new Error('field gone'), { status: 400 }); })(); }
      return provider.pull(s, c, scope);
    },
  };
  const r = await syncSource(cfg, flaky, cache, { now });
  assert.equal(r.error, undefined);
  assert.equal(discovers, 1);
  assert.equal(r.pulled, 3);
});

test('credential: provider auth errors classify as credential', () => {
  class AzdoAuthUnavailable extends Error { constructor() { super('Azure DevOps credential (pat) unavailable'); this.name = 'AzdoAuthUnavailable'; } }
  assert.equal(classifyError(new AzdoAuthUnavailable()), 'credential');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'auth' })), 'credential');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'credential' })), 'credential');
  assert.equal(classifyError(new Error('boom')), 'other');
});

test('credential: an AzdoAuthUnavailable at connect reads credential expired', async () => {
  const { cfg, provider, cache, now } = setup();
  const bad: WorkProvider = { ...provider, connect: async () => { const e = new Error('no token'); e.name = 'AzdoAuthUnavailable'; throw e; } };
  await syncSource(cfg, bad, cache, { now });
  assert.equal(freshness(cache.getSource(cfg.id)).state, 'credential-expired');
});

const GRANT: Permissions = { grants: [{ actions: ['comment', 'label'], principals: ['human'] }] };

test('dry run: recorded beside the three verdicts; a refusal stops the write', async () => {
  const { cfg, provider, cache, now, dir } = setup({ mode: 'edit', permissions: GRANT });
  writeFileSync(join(dir, 'permissions.json'), JSON.stringify({ credential: { read: true, write: true }, dryRunRefuses: { 'INV-3': { label: 'the label field is read-only on this screen' } } }));
  await syncSource(cfg, provider, cache, { now });
  const session = await connectSource(cfg, provider);
  let hydrates = 0;
  const spy: WorkProvider = { ...provider, hydrate: async (s, ids) => { hydrates++; return provider.hydrate(s, ids); } };
  const ok = await applyIntent({ id: 'a', item: id('INV-5'), action: 'comment', payload: { body: 'hi' }, requestedBy: { kind: 'human', id: 'u' } }, { cfg, provider: spy, session, cache, now });
  assert.equal(ok.state, 'confirmed');
  assert.deepEqual(ok.preview, { ok: true, reason: 'ok' });
  assert.equal(hydrates, 2, 'the freshness check, then the full re-read — a provider\'s ApplyResult.item carries fields only (Jira returns no comments there), so the cache is filled from hydrate');
  assert.equal(cache.getItem(id('INV-5'))!.comments.at(-1)!.body.text, 'hi');
  assert.deepEqual(cache.listAudit().at(-1)!.preview, { ok: true, reason: 'ok' });
  assert.equal(Object.keys(cache.listAudit().at(-1)!.verdicts!).length, 3);
  const no = await applyIntent({ id: 'b', item: id('INV-3'), action: 'label', payload: { add: ['x'] }, requestedBy: { kind: 'human', id: 'u' } }, { cfg, provider, session, cache, now });
  assert.equal(no.state, 'denied');
  assert.equal(no.preview!.ok, false);
  assert.match(no.preview!.reason, /read-only on this screen/);
  assert.equal(cache.listAudit().at(-1)!.outcome, 'dry-run-refused');
  assert.deepEqual(cache.getItem(id('INV-3'))!.labels, [], 'nothing written');
});
