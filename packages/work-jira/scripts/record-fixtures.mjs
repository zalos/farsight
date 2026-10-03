// Re-record test/fixtures/*.json from the live Jira test site through the real
// provider. Only responses are recorded (method, path, request body, status,
// rate-limit headers, response body) — never a request header — and every file
// is checked in-process for the token before it is written.
//
//   node packages/work-jira/scripts/record-fixtures.mjs   (after pnpm build)
//
// Writes to the test site: one comment and one label on KAN-2 (the incremental
// scenario needs a change). The defaults are placeholders — point it at your own
// test site with FARSIGHT_JIRA_SITE (site URL), FARSIGHT_JIRA_USER (account email)
// and FARSIGHT_JIRA_KEYCHAIN (the token's secret reference, keychain:service/account).
// A re-recording carries that site's names, ids and emails: replace them with the
// example values (example.atlassian.net, dev@example.com, 712020:0…01, and the
// project / issue-type `entityId` UUIDs → 00000000-0000-4000-8000-0000000001xx)
// before committing, then run `gitleaks dir .` (CI does).
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolveSecret } from '@farsight/work';
import { createJiraProvider } from '../dist/index.js';

const SITE = process.env.FARSIGHT_JIRA_SITE ?? 'https://example.atlassian.net';
const USER = process.env.FARSIGHT_JIRA_USER ?? 'dev@example.com';
const REF = process.env.FARSIGHT_JIRA_KEYCHAIN ?? 'keychain:farsight/jira-example';
const OUT = new URL('../test/fixtures/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const secret = await resolveSecret(REF);
let tape = [];
const recording = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  const u = new URL(url);
  const headers = {};
  for (const [k, v] of res.headers) if (/^(retry-after|x-ratelimit-|ratelimit)/i.test(k)) headers[k] = v;
  tape.push({
    method: init.method ?? 'GET',
    path: u.pathname + u.search,
    ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    status: res.status,
    headers,
    response: text ? JSON.parse(text) : null,
  });
  return new Response([101, 204, 205, 304].includes(res.status) ? null : text, { status: res.status, headers: res.headers });
};
const save = (name) => {
  // Jira's XSRF token (atl_token, in operations links) is session-bound, not a credential,
  // but it is the recording session's own value: it never goes into a public fixture
  const json = JSON.stringify(tape, null, 1).replace(/atl_token=[0-9a-f]{40}/g, `atl_token=${'0'.repeat(40)}`);
  const enc = Buffer.from(`${USER}:${secret}`).toString('base64');
  if (json.includes(secret) || json.includes(enc)) throw new Error(`refusing to write ${name}: it would contain the credential`);
  writeFileSync(new URL(name, OUT), json + '\n');
  console.log(`${name}: ${tape.length} calls`);
  tape = [];
};

const cfg = { id: 'jira-example', type: 'work', provider: 'jira', site: SITE, scope: { projects: ['KAN', 'SAM1'] }, auth: { kind: 'api-token', user: USER, secret: REF } };
const provider = createJiraProvider({ fetcher: recording, pageSize: 5 });

const session = await provider.connect(cfg, secret);
save('connect.json');
await provider.discover(session);
save('discover.json');
let cursor = null;
const full = [];
for await (const page of provider.pull(session, null, cfg.scope)) { full.push(...page.items); cursor = page.cursor; if (page.isLast) break; }
save('pull-full.json');
await provider.hydrate(session, full.filter((i) => i.key.startsWith('KAN-')).map((i) => i.id));
save('hydrate.json');
const kan1 = full.find((i) => i.key === 'KAN-1');
for (const action of ['comment', 'edit', 'assign', 'transition', 'link', 'label']) await provider.can(session, kan1, action);
save('can.json');
const kan2 = full.find((i) => i.key === 'KAN-2');
const who = { kind: 'human', id: session.user.id };
const c = await provider.apply(session, { id: 'rec-1', item: kan2.id, action: 'comment', payload: { body: 'Recorded by **record-fixtures**: see `finalizeInvoice`.' }, requestedBy: who, baseRevision: kan2.revision });
save('apply-comment.json');
await provider.apply(session, { id: 'rec-2', item: kan2.id, action: 'label', payload: { add: ['recorded'], remove: [] }, requestedBy: who, baseRevision: c.revision });
save('apply-label.json');
await new Promise((r) => setTimeout(r, 3000));
for await (const page of provider.pull(session, cursor, cfg.scope)) { if (page.isLast) break; }
save('pull-incremental.json');
for await (const page of provider.pull(session, cursor, { ...cfg.scope, reconcile: { known: full.map((i) => i.id).concat('work::jira-example::KAN-999') } })) { if (page.isLast) break; }
save('pull-reconcile.json');
console.log(`cursor after full pull: ${cursor}`);
