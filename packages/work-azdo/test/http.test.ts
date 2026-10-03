import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoHttp, AzdoHttpError, basicPat } from '../dist/index.js';

const base = 'https://dev.azure.com/org';
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('http: the Authorization header is built per call from the closure and api-version is always sent', async () => {
  let n = 0;
  const seen: { url: string; auth: string }[] = [];
  const http = createAzdoHttp({ base: base + '/', authorization: () => `Basic tok${++n}`, fetcher: async (url, init) => {
    seen.push({ url, auth: new Headers(init.headers as HeadersInit).get('authorization')! });
    return res(200, { ok: 1 });
  } });
  await http.request({ path: '/_apis/x', apiVersion: '7.1', query: { a: 1, b: undefined } });
  await http.request({ path: '/_apis/y', apiVersion: '7.2-preview.4' });
  assert.deepEqual(seen.map((s) => s.auth), ['Basic tok1', 'Basic tok2']);
  assert.equal(seen[0]!.url, `${base}/_apis/x?a=1&api-version=7.1`);
  assert.match(seen[1]!.url, /api-version=7\.2-preview\.4$/);
  assert.ok(!('authorization' in http), 'the client object carries no credential');
  assert.equal(basicPat('abc'), 'Basic ' + Buffer.from(':abc').toString('base64'));
});

test('http: 429 is retried after Retry-After (with jitter), 503 after X-RateLimit-Reset, then succeeds', async () => {
  const waits: number[] = [];
  const answers = [res(429, { message: 'TF400733' }, { 'retry-after': '3' }), res(503, {}, { 'x-ratelimit-reset': '105' }), res(200, { v: 1 }, { 'x-ratelimit-cost': '0.5' })];
  const http = createAzdoHttp({ base, authorization: () => 'Basic x', fetcher: async () => answers.shift()!, sleep: async (ms) => { waits.push(ms); }, random: () => 0, now: () => 100_000 });
  const r = await http.request({ path: '/p', apiVersion: '7.1' });
  assert.equal(r.status, 200);
  assert.equal(r.cost, 0.5);
  assert.deepEqual(waits, [3000, 5000]);
});

test('http: a Retry-After on a 200 holds the next call', async () => {
  const waits: number[] = [];
  let t = 0;
  const http = createAzdoHttp({ base, authorization: () => 'Basic x', now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; },
    fetcher: async () => res(200, {}, waits.length ? {} : { 'retry-after': '2' }) });
  await http.request({ path: '/a', apiVersion: '7.1' });
  await http.request({ path: '/b', apiVersion: '7.1' });
  assert.deepEqual(waits, [2000]);
});

test('http: gives up after the attempts and throws AzdoHttpError without headers, body or credential', async () => {
  let calls = 0;
  const http = createAzdoHttp({ base, authorization: () => 'Basic SECRETSECRET', attempts: 3, sleep: async () => {},
    fetcher: async () => { calls++; return res(429, { message: 'slow down' }, { 'retry-after': '1', 'x-secret-header': 'hdr' }); } });
  await assert.rejects(http.request({ path: '/a', apiVersion: '7.1' }), (err: unknown) => {
    assert.ok(err instanceof AzdoHttpError);
    assert.equal(err.status, 429);
    assert.equal(err.reason, 'rate limited');
    assert.doesNotMatch(err.message, /SECRET|hdr|slow down/);
    return true;
  });
  assert.equal(calls, 3);
});

test('http: a failed test /rev is a 412 conflict with the server message kept apart; 401 names no credential', async () => {
  const body = { message: 'VS403351: Test Operation for path /rev failed, value 4 was not equal to test value 3.', typeKey: 'TestPatchOperationFailedException' };
  const http = createAzdoHttp({ base, authorization: () => 'Basic SECRET', fetcher: async () => res(412, body) });
  const err = await http.request({ method: 'PATCH', path: '/w', apiVersion: '7.1', body: [] }).catch((e) => e);
  assert.equal(err.status, 412);
  assert.equal(err.typeKey, 'TestPatchOperationFailedException');
  assert.match(err.reason, /conflict/);
  assert.match(err.serverMessage, /VS403351/);
  assert.doesNotMatch(err.message, /VS403351|SECRET/);
  const h401 = createAzdoHttp({ base, authorization: () => 'Basic SECRET', fetcher: async () => new Response('<html>sign in</html>', { status: 401 }) });
  const e2 = await h401.request({ path: '/w', apiVersion: '7.1' }).catch((e) => e);
  assert.equal(e2.status, 401);
  assert.equal(e2.serverMessage, undefined);
  assert.doesNotMatch(e2.message, /SECRET|html/);
});

test('http: a timeout is AzdoHttpError(0, timeout); a network failure is retried then unreachable', async () => {
  const t = createAzdoHttp({ base, authorization: () => 'x', fetcher: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } });
  const e = await t.request({ path: '/a', apiVersion: '7.1' }).catch((x) => x);
  assert.equal(e.reason, 'timeout');
  let n = 0;
  const u = createAzdoHttp({ base, authorization: () => 'x', attempts: 2, sleep: async () => {}, fetcher: async () => { n++; throw new TypeError('fetch failed'); } });
  const e2 = await u.request({ path: '/a', apiVersion: '7.1' }).catch((x) => x);
  assert.equal(e2.reason, 'unreachable');
  assert.equal(n, 2);
});

test('http: a write is never replayed after a dropped connection or a 503 (a comment would post twice); a 429 is', async () => {
  for (const fail of [() => { throw new TypeError('fetch failed'); }, () => res(503)]) {
    let calls = 0;
    const http = createAzdoHttp({ base, authorization: () => 'Basic x', sleep: async () => {}, random: () => 0, fetcher: async () => { calls++; return calls === 1 ? fail() : res(200, { id: 1 }); } });
    await assert.rejects(http.request({ method: 'POST', path: '/p/_apis/wit/workItems/1/comments', apiVersion: '7.1', body: { text: 'x' } }), AzdoHttpError);
    assert.equal(calls, 1);
    calls = 0;
    const read = await http.request({ method: 'POST', idempotent: true, path: '/p/_apis/wit/wiql', apiVersion: '7.1', body: {} });
    assert.equal(read.status, 200);
    assert.equal(calls, 2, 'a read that POSTs is retried');
  }
  const answers = [res(429, {}, { 'retry-after': '1' }), res(200, { id: 1 })];
  const http = createAzdoHttp({ base, authorization: () => 'Basic x', sleep: async () => {}, random: () => 0, fetcher: async () => answers.shift()! });
  assert.equal((await http.request({ method: 'PATCH', path: '/_apis/wit/workitems/1', apiVersion: '7.1', body: [] })).status, 200);
});
