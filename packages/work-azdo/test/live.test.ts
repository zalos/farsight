// Live acceptance against a real Azure DevOps org — READ ONLY, opt-in.
//
//   FARSIGHT_LIVE=1            turn the test on (it skips otherwise)
//   FARSIGHT_ADO_ORG           org URL        (default https://dev.azure.com/example-org)
//   FARSIGHT_ADO_PROJECT       project name   (default ExampleProject)
//   FARSIGHT_ADO_KEYCHAIN      PAT reference  (default keychain:farsight/ado-example)
//
// The defaults are placeholders; point the env at your own org to run it.
// Nothing here creates, edits, comments, assigns, transitions or deletes. The
// only write-shaped calls are validateOnly=true dry runs (connect's credential
// probe and one preview), which Azure DevOps checks without saving; every
// item's rev is compared before and after. The PAT is read from the keychain
// by the engine in process and never printed. Skips, with the reason, when the
// keychain entry is absent or the org is unreachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAzdoProvider } from '../dist/index.js';
import { WorkCache, syncSource, connectSource } from '@farsight/work';
import type { SourceConfig, Intent } from '@farsight/work';

const ORG = (process.env.FARSIGHT_ADO_ORG ?? 'https://dev.azure.com/example-org').replace(/\/+$/, '');
const PROJECT = process.env.FARSIGHT_ADO_PROJECT ?? 'ExampleProject';
const SECRET = process.env.FARSIGHT_ADO_KEYCHAIN ?? 'keychain:farsight/ado-example';
const [KC_SERVICE, KC_ACCOUNT] = SECRET.replace(/^keychain:/, '').split('/');

const SOURCE: SourceConfig = {
  id: 'example-azdo', type: 'work', provider: 'azure-devops', org: ORG,
  scope: { projects: [PROJECT] }, mode: 'edit',
  auth: { kind: 'pat', secret: SECRET },
};

async function skipReason(): Promise<string | null> {
  // opt-in: the live test reads a real org and runs dry-run patches there
  if (process.env.FARSIGHT_LIVE !== '1') return 'FARSIGHT_LIVE is not 1 (the live test is opt-in)';
  if (process.platform !== 'darwin') return 'the live test reads the macOS keychain';
  try {
    // attributes only (no -w): says whether the entry exists without reading its value
    execFileSync('security', ['find-generic-password', '-s', KC_SERVICE!, '-a', KC_ACCOUNT!], { stdio: 'ignore' });
  } catch { return `no keychain entry ${KC_SERVICE}/${KC_ACCOUNT}`; }
  try {
    await fetch(`${ORG}/_apis/connectionData`, { signal: AbortSignal.timeout(8000) });
  } catch { return 'dev.azure.com is unreachable'; }
  return null;
}

const reason = await skipReason();
if (reason) console.log(`# live Azure DevOps test skipped: ${reason}`);

test('live: an Azure DevOps project — connect, discover, full pull, hydrate, a validateOnly dry run that changes nothing', { skip: reason ?? false, timeout: 180_000 }, async (t) => {
  const provider = createAzdoProvider();
  const cache = new WorkCache(join(mkdtempSync(join(tmpdir(), 'work-azdo-live-')), 'work.db'));
  try {
    // 1 · the engine's real path: connect → discover → pull (WIQL → batch) → hydrate → cache
    const r1 = await syncSource(SOURCE, provider, cache, { rediscover: true });
    assert.equal(r1.error, undefined, r1.error);
    const items = cache.listItems({});
    assert.equal(items.length, 4, `${PROJECT} holds four work items (the recording's shape)`);
    const revs = new Map(items.map((i) => [i.key, i.revision]));
    const comments = items.reduce((n, i) => n + i.comments.length, 0);
    const history = items.reduce((n, i) => n + i.history.length, 0);
    const revisions = items.reduce((n, i) => n + Number(i.revision), 0);
    t.diagnostic(`items ${items.length} · keys ${[...revs].map(([k, r]) => `${k}@${r}`).join(' ')} · revisions ${revisions} · comments ${comments} · history changes ${history}`);
    assert.ok(items.every((i) => i.provider === 'azure-devops' && i.url.startsWith(ORG + '/')));
    assert.ok(items.some((i) => i.type.category === 'story') && items.some((i) => i.type.category === 'epic'));
    const schema = cache.getSource(SOURCE.id)!.schema!;
    t.diagnostic(`types ${schema.types.length} · states ${schema.states.length} · link types ${schema.linkTypes.length} · estimate field ${schema.fields.filter((f) => f.canonical === 'estimate').map((f) => f.id).join(',')}`);

    // 2 · a session to ask with: API versions, credential scope (its write probe was a validateOnly dry run)
    const s = await connectSource(SOURCE, provider);
    t.diagnostic(`session: ${s.user?.name} · api ${s.apiVersion} · comments ${s.commentsApiVersion} · ${s.deploymentType} · credential read=${s.credentialScope?.read} write=${s.credentialScope?.write} (${s.credentialScope?.detail})`);
    assert.equal(s.credentialScope?.read, true);

    // 3 · the tracker's answer, then a dry-run edit that must not save
    const i352 = cache.getItem('work::example-azdo::352')!;
    const verdict = await provider.can(s, i352, 'edit');
    t.diagnostic(`can edit 352: ${verdict.allowed} — ${verdict.reason}`);
    const i349 = cache.getItem('work::example-azdo::349')!;
    t.diagnostic(`can edit 349: ${(await provider.can(s, i349, 'edit')).reason}`);
    const intent: Intent = { id: 'live-dry', item: i352.id, action: 'edit', payload: { fields: { title: i352.title } },
      requestedBy: { kind: 'human', id: 'live-test' }, baseRevision: i352.revision };
    const dry = await provider.preview(s, intent);
    t.diagnostic(`validateOnly dry run on 352: ok=${dry.ok}${dry.error ? ' · ' + dry.error : ''}`);
    assert.equal(dry.ok, true);
    const stale = await provider.preview(s, { ...intent, baseRevision: String(Number(i352.revision) - 1) });
    assert.equal(stale.conflict, true, 'a stale base revision is a conflict');

    // 4 · the incremental path (the revisions feed) sees nothing new, and no rev moved
    const r2 = await syncSource(SOURCE, provider, cache);
    assert.equal(r2.error, undefined, r2.error);
    t.diagnostic(`second sync: pulled ${r2.pulled} · changed ${r2.changed} · deleted ${r2.deleted} · watermark ${JSON.parse(r2.cursor!).p[PROJECT].t ? 'feed' : 'wiql'}`);
    assert.equal(r2.changed, 0);
    const fresh = await provider.hydrate(s, items.map((i) => i.id));
    assert.deepEqual(new Map(fresh.map((i) => [i.key, i.revision])), revs, 'every rev is unchanged');
  } finally {
    cache.close();
  }
});
