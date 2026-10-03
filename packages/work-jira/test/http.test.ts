import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraClient, JiraHttpError, retryDelay } from '../dist/index.js';

const SECRET = 'tok-SECRET-value-123';
const USER = 'someone@example.com';
const ENC = Buffer.from(`${USER}:${SECRET}`).toString('base64');

function scripted(responses: (() => Response)[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return r();
  };
  return { fetcher, seen };
}

test('a 429 is retried after Retry-After, with jitter, then succeeds', async () => {
  const waits: number[] = [];
  const { fetcher, seen } = scripted([
    () => new Response('{}', { status: 429, headers: { 'Retry-After': '2', 'RateLimit-Reason': 'jira-burst-based' } }),
    () => new Response('{"ok":true}', { status: 200, headers: { 'X-RateLimit-Limit': '350', 'X-RateLimit-Remaining': '349' } }),
  ]);
  const c = createJiraClient({ site: 'https://x.atlassian.net/', user: USER, secret: SECRET, fetcher, sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 });
  const body = await c.post<{ ok: boolean }>('/rest/api/3/issue/KAN-1/comment', { body: 1 });
  assert.deepEqual(body, { ok: true });
  assert.equal(seen.length, 2, 'a 429 is retried even for a write: Jira did not process it');
  assert.deepEqual(waits, [2125]);
  assert.deepEqual(c.rateLimit(), { limit: 350, remaining: 349 });
  assert.equal(seen[0]!.url, 'https://x.atlassian.net/rest/api/3/issue/KAN-1/comment');
  const h = seen[0]!.init.headers as Record<string, string>;
  assert.equal(h.Authorization, `Basic ${ENC}`);
  assert.equal(h.Accept, 'application/json');
  assert.ok(seen[0]!.init.signal, 'every call has a timeout signal');
});

test('X-RateLimit-Reset is honoured when Retry-After is absent; backoff otherwise; capped', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(retryDelay(new Headers({ 'X-RateLimit-Reset': '2026-09-30T12:00:05Z' }), 0, now, () => 0), 5000);
  assert.equal(retryDelay(new Headers(), 0, now, () => 0), 500);
  assert.equal(retryDelay(new Headers(), 3, now, () => 0), 4000);
  assert.equal(retryDelay(new Headers({ 'Retry-After': '9999' }), 0, now, () => 0), 60_000);
});

test('a 503 is retried for reads, not for writes; retries stop at maxRetries', async () => {
  const s1 = scripted([() => new Response('', { status: 503 }), () => new Response('[]', { status: 200 })]);
  const c1 = createJiraClient({ site: 'https://x', user: USER, secret: SECRET, fetcher: s1.fetcher, sleep: async () => {} });
  assert.deepEqual(await c1.get('/rest/api/3/field'), []);
  assert.equal(s1.seen.length, 2);

  const s2 = scripted([() => new Response('', { status: 503 })]);
  const c2 = createJiraClient({ site: 'https://x', user: USER, secret: SECRET, fetcher: s2.fetcher, sleep: async () => {} });
  await assert.rejects(c2.put('/rest/api/3/issue/KAN-1', {}), (e: JiraHttpError) => e.status === 503);
  assert.equal(s2.seen.length, 1);

  const s3 = scripted([() => new Response('', { status: 429 })]);
  const c3 = createJiraClient({ site: 'https://x', user: USER, secret: SECRET, fetcher: s3.fetcher, sleep: async () => {}, maxRetries: 2 });
  await assert.rejects(c3.get('/x'), (e: JiraHttpError) => e.status === 429 && e.reason === 'rate limited');
  assert.equal(s3.seen.length, 3);
});

test('errors carry status and Jira\'s words, never the token, the header or other body parts', async () => {
  const echo = JSON.stringify({ errorMessages: [`bad token ${SECRET}`], errors: { auth: `Basic ${ENC}` }, secretField: 'not copied' });
  const { fetcher } = scripted([() => new Response(echo, { status: 400 })]);
  const c = createJiraClient({ site: 'https://x', user: USER, secret: SECRET, fetcher, sleep: async () => {} });
  const err = await c.get('/rest/api/3/issue/KAN-1?fields=x').catch((e) => e as JiraHttpError);
  assert.ok(err instanceof JiraHttpError);
  assert.equal(err.status, 400);
  assert.equal(err.path, '/rest/api/3/issue/KAN-1', 'the query string is not in the error');
  for (const s of [err.message, err.reason, JSON.stringify(err), String(err.stack)]) {
    assert.equal(s.includes(SECRET), false);
    assert.equal(s.includes(ENC), false);
    assert.equal(s.includes('not copied'), false);
  }
  assert.match(err.reason, /bad token \[redacted\]/);
});

test('401 and 403 say what happened in words; a timeout and a refused connection are status 0', async () => {
  const c401 = createJiraClient({ site: 'https://x', user: USER, secret: SECRET, fetcher: async () => new Response('<html>', { status: 401 }) });
  await assert.rejects(c401.get('/rest/api/3/myself'), (e: JiraHttpError) => e.status === 401 && e.reason === 'the credential was refused');
  const slow = createJiraClient({
    site: 'https://x', user: USER, secret: SECRET, timeoutMs: 20,
    fetcher: (_u, init) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))),
  });
  await assert.rejects(slow.get('/x'), (e: JiraHttpError) => e.status === 0 && e.reason === 'timeout');
  const refused = createJiraClient({
    site: 'https://x', user: USER, secret: SECRET, sleep: async () => {}, maxRetries: 1,
    fetcher: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); },
  });
  await assert.rejects(refused.get('/x'), (e: JiraHttpError & { code?: string }) => e.status === 0 && e.code === 'ECONNREFUSED');
});

test('the client object holds no secret', () => {
  const c = createJiraClient({ site: 'https://x', user: USER, secret: SECRET, fetcher: async () => new Response('{}') });
  const dump = JSON.stringify(c) + Object.values(c).map(String).join('');
  assert.equal(dump.includes(SECRET), false);
  assert.deepEqual(Object.keys(c).sort(), ['get', 'post', 'put', 'rateLimit', 'request', 'site']);
});

test('anonymous calls send no Authorization header', async () => {
  const { fetcher, seen } = scripted([() => new Response('{"cloudId":"c"}')]);
  const c = createJiraClient({ site: 'https://x', user: USER, secret: SECRET, fetcher });
  await c.get('/_edge/tenant_info', { anonymous: true });
  assert.equal((seen[0]!.init.headers as Record<string, string>).Authorization, undefined);
});

test('a gateway error (502, 504) is retried for reads, not for writes; a negative Retry-After waits nothing', async () => {
  for (const status of [502, 504]) {
    const r = scripted([() => new Response('', { status }), () => new Response('{"ok":true}', { status: 200 })]);
    const c = createJiraClient({ site: 'https://x.atlassian.net', user: USER, secret: SECRET, fetcher: r.fetcher, sleep: async () => {}, random: () => 0 });
    assert.deepEqual(await c.get('/rest/api/3/myself'), { ok: true });
    assert.equal(r.seen.length, 2, `${status} on a read is retried`);
    const w = scripted([() => new Response('', { status }), () => new Response('{"ok":true}', { status: 200 })]);
    const cw = createJiraClient({ site: 'https://x.atlassian.net', user: USER, secret: SECRET, fetcher: w.fetcher, sleep: async () => {}, random: () => 0 });
    await assert.rejects(cw.post('/rest/api/3/issue/KAN-1/comment', {}));
    assert.equal(w.seen.length, 1, `${status} on a write is not replayed`);
  }
  assert.equal(retryDelay(new Headers({ 'Retry-After': '-5' }), 0, 0, () => 0), 0);
});
