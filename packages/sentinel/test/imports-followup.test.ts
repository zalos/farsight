// Stage A review followups: exact reported request syntax and bounded options, without execution or owner authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeImport, importFromFiles } from '../dist/imports/normalize.js';
import { ImportBudget, ImportRefusal } from '../dist/imports/types.js';
import { originOf, parseRequestLine } from '../dist/imports/http.js';
const load = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/imports/${name}`, import.meta.url), 'utf8'));
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
const normalize = (r: unknown, m: unknown, options: any = {}): any => normalizeImport(bytes(r), bytes(m), options);
const good = (r: unknown, m: unknown) => { const result = normalize(r, m); assert.equal(result.status, 'normalized'); return result.document; };
const facts = (d: any) => d.cookies.filter((c: any) => c.exchangeId === d.exchanges[0].id).flatMap((c: any) => c.observations);
const zap = (uri: string, target: string, extras = '') => {
  const r = load('zap-plus.json'); const inst = r.site[0].alerts[0].instances[0];
  inst.uri = uri; inst['request-header'] = `POST ${target} HTTP/1.1\r\nHost: app.example.test\r\n${extras}\r\n`;
  return good(r, load('zap-plus.manifest.json'));
};

test('raw ZAP path and query match without WHATWG dot or backslash rewriting', () => {
  for (const [uri, target] of [
    ['https://app.example.test/a/../login', '/login'],
    ['https://app.example.test/a/%2e%2e/login', '/login'],
    ['https://app.example.test/a\\b', '/a/b'],
    ['https://app.example.test\\elsewhere.test/login', '/elsewhere.test/login'],
    ['https://app.example.test/login?', '/login'],
    ['https://app.example.test/login?x=%2f', '/login?x=/'],
    ['https://app.example.test/login?x=%2f', '/login?x=%2F'],
    ['https://app.example.test/login?x=+', '/login?x=%20'],
  ]) {
    assert.ok(facts(zap(uri!, target!)).every((o: any) => o.scope === 'unbound'));
  }
});

test('ZAP preserves an empty query and exact percent escapes while normalizing only ordinary authority differences', () => {
  for (const [uri, target] of [
    ['https://app.example.test/login?', '/login?'],
    ['https://app.example.test?', '/?'],
    ['https://app.example.test/log%69n?x=%2f', '/log%69n?x=%2f'],
    ["https://app.example.test/login?x='+", "/login?x='+"],
    ['HTTPS://APP.EXAMPLE.TEST:443/login', '/login'],
    ['https://app.example.test/login', 'HTTPS://APP.EXAMPLE.TEST:443/login'],
  ]) assert.ok(facts(zap(uri!, target!)).every((o: any) => o.scope === 'stated'));
  assert.ok(facts(zap('https://app.example.test/log%69n', '/login')).every((o: any) => o.scope === 'unbound'));
});

test('absolute request origins reject rewritten path/query, backslash, controls and fragments', () => {
  for (const target of [
    'https://app.example.test/a/../login', 'https://app.example.test/a/%2e%2e/login',
    'https://app.example.test\\elsewhere.test/login', 'https://app.example.test/a\\b',
    'https://app.example.test/a\tb', 'https://app.example.test/a\u0000b',
    'https://app.example.test/login#fragment',
    'https://user:password@app.example.test/login', 'https://@app.example.test/login',
  ]) {
    assert.equal(originOf(target), undefined);
    const r = load('sarif-cookies.sarif.json'); r.runs[0].results[0].webRequest.target = target;
    const d = good(r, load('sarif.manifest.json'));
    assert.ok(facts(d).every((o: any) => o.scope === 'unbound'));
  }
  for (const target of ['HTTPS://APP.EXAMPLE.TEST:443/login?', 'https://app.example.test/log%69n?x=%2f']) {
    assert.equal(originOf(target), 'https://app.example.test');
  }
});

test('unsupported HTTP2 request versions are classified separately from malformed request syntax', () => {
  assert.equal(parseRequestLine('GET /login HTTP/2'), 'sentinel.import.versionUnsupported');
  assert.equal(parseRequestLine('GET /login HTTP/2.0'), 'sentinel.import.versionUnsupported');
  assert.equal(parseRequestLine('GET /login HTTP/two'), 'sentinel.import.requestMalformed');
  assert.equal(parseRequestLine('GET /login HTTP/1.1.1'), 'sentinel.import.requestMalformed');
  assert.deepEqual(parseRequestLine('GET /login HTTP/1.1'), { method: 'GET', target: '/login', version: '1.1' });
});

test('duplicate Cookie request fields are unknown in both formats, with single fields retained', () => {
  const z = zap('https://app.example.test/login', '/login', 'Cookie: pref=x\r\nCookie: other=y\r\n');
  assert.equal(z.exchanges[0].inboundCookieNames, null);
  assert.ok(z.exchanges[0].reasons.includes('sentinel.import.headerAmbiguous'));
  assert.ok(facts(z).every((o: any) => o.scope === 'unbound'));
  const single = zap('https://app.example.test/login', '/login', 'Cookie: pref=x\r\n');
  assert.deepEqual(single.exchanges[0].inboundCookieNames, ['pref']);
  assert.ok(facts(single).every((o: any) => o.scope === 'stated'));
  const r = load('sarif-cookies.sarif.json'); r.runs[0].results[0].webRequest.headers = { Cookie: 'pref=x', cookie: 'other=y' };
  const s = good(r, load('sarif.manifest.json'));
  assert.equal(s.exchanges[0].inboundCookieNames, null);
  assert.ok(s.exchanges[0].reasons.includes('sentinel.import.headerAmbiguous'));
  assert.ok(facts(s).every((o: any) => o.scope === 'unbound'));
});

test('malformed limit containers and explicit undefined values return a bounded typed refusal', () => {
  const r = bytes(load('sarif-cookies.sarif.json')), m = bytes(load('sarif.manifest.json'));
  for (const limits of [null, [], 1, 'invalid', false, { rawBytes: undefined }, { rawBytes: null }, { deadlineMs: NaN }, { rawBytes: Infinity }]) {
    assert.throws(() => new ImportBudget(limits as any), (e: any) => e instanceof ImportRefusal && e.code === 'sentinel.import.budgetExhausted');
    const result = normalizeImport(r, m, { limits } as any);
    assert.deepEqual(result, { status: 'refused', code: 'sentinel.import.budgetExhausted', pointer: null });
    // Invalid options refuse before either file is opened; the names themselves are never exposed in diagnostics.
    assert.deepEqual(importFromFiles('/unused-report', '/unused-manifest', { limits } as any), result);
  }
  assert.equal(normalizeImport(r, m, { limits: undefined }).status, 'normalized', 'omitted optional limits remain supported');
  assert.equal(new ImportBudget({ rawBytes: 1 }).limits.rawBytes, 1);
});
