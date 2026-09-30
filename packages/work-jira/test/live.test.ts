// The live acceptance: the real engine (syncSource), the real cache (WorkCache
// in a temp dir) and the real gate (applyIntent) against the Jira test site.
// Skips, with the reason printed, when the keychain entry is absent or the site
// is unreachable — CI without credentials stays green. The token is read from
// the keychain in this process and goes only into the provider's closure.
//
// Writes to the test site (allowed there): one label on KAN-3, one comment on KAN-1.
//
//   FARSIGHT_LIVE=1          turn the test on (it skips otherwise)
//   FARSIGHT_JIRA_SITE       site URL          (default https://example.atlassian.net)
//   FARSIGHT_JIRA_USER       account email     (default dev@example.com)
//   FARSIGHT_JIRA_KEYCHAIN   token reference   (default keychain:farsight/jira-example)
//
// The defaults are placeholders; point the env at your own Jira test site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSecret, WorkCache, syncSource, connectSource, applyIntent, workItemId,
  type SourceConfig, type Intent,
} from '@farsight/work';
import { createJiraProvider, createJiraClient, sessionFacts } from '../dist/index.js';

const SITE = process.env.FARSIGHT_JIRA_SITE ?? 'https://example.atlassian.net';
const USER = process.env.FARSIGHT_JIRA_USER ?? 'dev@example.com';
const REF = process.env.FARSIGHT_JIRA_KEYCHAIN ?? 'keychain:farsight/jira-example';
const SRC = 'jira-example';

async function why(): Promise<string | null> {
  // opt-in: the live test writes a comment and a label to the test site on every run
  if (process.env.FARSIGHT_LIVE !== '1') return 'FARSIGHT_LIVE is not 1 (the live test is opt-in)';
  try {
    await resolveSecret(REF);
  } catch (err) {
    return `no credential: ${(err as Error).message}`;
  }
  try {
    const r = await fetch(`${SITE}/_edge/tenant_info`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return `${SITE} answered ${r.status}`;
  } catch {
    return `${SITE} is unreachable`;
  }
  return null;
}

const skip = await why();
if (skip) console.log(`# live Jira test skipped — ${skip}`);

const cfg: SourceConfig = {
  id: SRC, type: 'work', provider: 'jira', site: SITE, mode: 'edit',
  scope: { projects: ['KAN', 'SAM1'] },
  auth: { kind: 'api-token', user: USER, secret: REF },
  permissions: { default: 'deny', grants: [{ actions: ['comment', 'label'], principals: ['human'], confirm: 'never' }] },
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('live: sync → incremental → hydrate → comment through the gate → conflict', { skip: skip ?? false, timeout: 180_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-jira-live-'));
  const cache = new WorkCache(join(dir, 'work.db'));
  const provider = createJiraProvider();
  try {
    // 1 · full sync through the engine (connect → discover → pull → hydrate)
    const first = await syncSource(cfg, provider, cache);
    assert.equal(first.error, undefined, first.error);
    const all = cache.listItems({ source: SRC });
    const kan = all.filter((i) => i.key.startsWith('KAN-'));
    const sam = all.filter((i) => i.key.startsWith('SAM1-'));
    assert.ok(kan.length >= 4 && sam.length >= 10, `KAN ${kan.length} · SAM1 ${sam.length}`);
    const schema = cache.getSource(SRC)?.schema;
    assert.ok(schema?.fields.some((f) => f.canonical === 'iteration' && f.origin === 'found'), 'Sprint found on the site');
    const k1 = cache.getItem(workItemId(SRC, 'KAN-1'))!;
    assert.equal(k1.parent, workItemId(SRC, 'KAN-4'));
    assert.equal(k1.iteration?.name, 'KAN Sprint 1');
    assert.equal(k1.area, 'Portal');
    assert.ok(k1.history.length > 0, 'hydrated history');
    assert.ok(k1.comments.length >= 2, 'hydrated comments');
    const changes = all.reduce((n, i) => n + i.history.length, 0);
    const comments = all.reduce((n, i) => n + i.comments.length, 0);
    t.diagnostic(`full sync ${first.syncNo}: pulled ${first.pulled} (KAN ${kan.length}, SAM1 ${sam.length}), ${changes} changelog entries, ${comments} comments, ${first.durationMs} ms`);

    // 2 · edit an issue on the site, then an incremental sync sees only what moved
    const secret = await resolveSecret(REF);
    const raw = createJiraClient({ site: SITE, user: USER, secret });
    const label = `live-${Date.now()}`;
    await raw.put('/rest/api/3/issue/KAN-3', { update: { labels: [{ add: label }] } });
    let second = await syncSource(cfg, provider, cache);
    for (let i = 0; i < 6 && !cache.getItem(workItemId(SRC, 'KAN-3'))?.labels.includes(label); i++) {
      await pause(3000); // search is eventually consistent
      second = await syncSource(cfg, provider, cache);
    }
    assert.equal(second.error, undefined, second.error);
    const k3 = cache.getItem(workItemId(SRC, 'KAN-3'))!;
    assert.ok(k3.labels.includes(label), 'the incremental sync saw the edit');
    assert.ok(second.pulled < first.pulled, `incremental pulled ${second.pulled} of ${first.pulled}`);
    assert.ok(k3.history.some((h) => h.field === 'labels' && String(h.to).includes(label)), 'the edit is in the hydrated history');
    t.diagnostic(`incremental sync ${second.syncNo}: pulled ${second.pulled}, changed ${second.changed}; KAN-3 now labelled ${label}`);

    // 3 · a comment through the gate: policy × Jira × credential, freshness, apply, re-read
    const session = await connectSource(cfg, provider);
    const before = cache.getItem(workItemId(SRC, 'KAN-1'))!;
    const intent: Intent = {
      id: `live-comment-${Date.now()}`, item: before.id, action: 'comment',
      payload: { body: `Live acceptance of the Jira provider — **${label}**, see \`finalizeInvoice\`.` },
      requestedBy: { kind: 'human', id: String(session.user?.id) },
    };
    const out = await applyIntent(intent, { cfg, provider, session, cache, confirmed: true });
    assert.equal(out.state, 'confirmed', `${out.state}: ${out.reason ?? ''} ${JSON.stringify(out.verdicts)}`);
    assert.equal(out.verdicts?.tracker.reason, 'Jira says: yes');
    const after = cache.getItem(before.id)!;
    const mine = after.comments.find((c) => c.body.text.includes(label));
    assert.ok(mine, 'the comment is on the re-read item');
    assert.equal(mine.body.text, `Live acceptance of the Jira provider — **${label}**, see \`finalizeInvoice\`.`, 'markdown → ADF → markdown on the real site');
    assert.notEqual(after.revision, before.revision);
    t.diagnostic(`comment ${mine.id} landed on KAN-1; revision ${before.revision} → ${after.revision}; changelog via ${sessionFacts(session).changelogVia ?? 'n/a'}`);

    // 4 · conflict: the site moves between the read and the write
    const stale = cache.getItem(before.id)!;
    await raw.put('/rest/api/3/issue/KAN-1', { update: { labels: [{ add: label }] } });
    const conflict = await applyIntent({ ...intent, id: `live-conflict-${Date.now()}`, payload: { body: 'must not land' }, baseRevision: stale.revision }, { cfg, provider, session, cache, confirmed: true });
    assert.equal(conflict.state, 'conflict', `engine freshness check: ${conflict.reason}`);
    // and the provider's own compare-before-write, without the engine
    const direct = await provider.apply(session, { ...intent, id: 'live-direct', payload: { body: 'must not land' }, baseRevision: stale.revision });
    assert.equal(direct.conflict, true);
    assert.equal(direct.error, 'KAN-1 changed on Jira since it was read');
    const recheck = (await provider.hydrate(session, [before.id]))[0]!;
    assert.equal(recheck.comments.some((c) => c.body.text === 'must not land'), false, 'nothing was written on conflict');
    // tidy: the label added for the conflict comes off again
    await raw.put('/rest/api/3/issue/KAN-1', { update: { labels: [{ remove: label }] } });
    t.diagnostic(`conflict detected by the engine and by the provider (cached ${stale.revision}, site ${direct.revision})`);
  } finally {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
