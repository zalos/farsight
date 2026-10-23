// PR 20 Stage A: Set-Cookie lines and HTTP heads as a report recorded them. The whole cookie is checked before any
// attribute is believed; commas are never split; every ambiguity is an unknown with its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSetCookie, requestCookieNames } from '../dist/imports/set-cookie.js';
import { originOf, parseHead, parseRequestLine, parseStatusLine } from '../dist/imports/http.js';
import { ImportBudget } from '../dist/imports/types.js';

const ok = (line: string): any => { const r: any = parseSetCookie(line); assert.equal(r.ok, true, `${line} parses`); return r; };
const reason = (line: string) => (parseSetCookie(line) as any).reason;

test('a complete cookie line yields its three attributes; the value is never kept', () => {
  const c = ok('sid=synthetic-value; Path=/; Secure; HttpOnly; SameSite=Lax');
  assert.deepEqual([c.name, c.valueBytes, c.path, c.lifetime], ['sid', 15, '/', 'session']);
  assert.deepEqual([c.secure, c.httpOnly, c.sameSite], [{ outcome: 'present' }, { outcome: 'present' }, { outcome: 'present', value: 'lax' }]);
  assert.doesNotMatch(JSON.stringify(c), /synthetic-value/);
  const bare = ok('theme=dark');
  assert.deepEqual([bare.secure, bare.httpOnly, bare.sameSite], [{ outcome: 'absent' }, { outcome: 'absent' }, { outcome: 'absent' }]);
  assert.equal(ok('q="quoted-v1"; secure; httponly; samesite=STRICT').sameSite.value, 'strict', 'attribute names and SameSite values are case-insensitive');
  assert.equal(ok('q="quoted-v1"').quoted, true);
  assert.equal(ok('e=; Secure').valueBytes, 0);
});

test('the cookie pair is validated before attributes: an unterminated quote or a folded pair proves nothing', () => {
  assert.equal(reason('sid="x; Secure; HttpOnly'), 'sentinel.import.cookieMalformed');
  assert.equal(reason('sid=x, other=y; Secure'), 'sentinel.import.commaAmbiguous');
  assert.equal(reason('sid=a b; Secure'), 'sentinel.import.cookieMalformed');
  assert.equal(reason('=x; Secure'), 'sentinel.import.cookieMalformed');
  assert.equal(reason('s(d=x; Secure'), 'sentinel.import.cookieMalformed');
  assert.equal(reason('sid=x;; Secure'), 'sentinel.import.cookieMalformed');
  assert.equal(reason('sid=x; Secure;'), 'sentinel.import.cookieMalformed');
  assert.equal(reason('sid=x;\tSecure'), 'sentinel.import.cookieMalformed');
  assert.equal(reason('sid=café; Secure'), 'sentinel.import.cookieMalformed');
  assert.equal(reason(''), 'sentinel.import.cookieMalformed');
});

test('a comma is accepted only inside a well-formed Expires date', () => {
  const c = ok('acct=v1; Secure; SameSite=Strict; Expires=Fri, 22 Oct 2027 10:00:00 GMT');
  assert.deepEqual([c.lifetime, c.secure.outcome, c.sameSite.value], ['expires-stated', 'present', 'strict']);
  assert.equal(reason('acct=v1; Expires=Fri, 22 Oct 2027 10:00:00 GMT, b=2; Secure'), 'sentinel.import.commaAmbiguous');
  assert.equal(reason('acct=v1; Expires=Friday, 22-Oct-27 10:00:00 GMT; Secure'), 'sentinel.import.commaAmbiguous');
  assert.equal(reason('acct=v1; Path=/a,b; Secure'), 'sentinel.import.commaAmbiguous');
  assert.equal(reason('acct=v1; Secure, other=2'), 'sentinel.import.commaAmbiguous');
  assert.equal(ok('acct=v1; Expires=tomorrow; Secure').lifetime, 'unknown', 'an unreadable date leaves the lifetime unknown, not the flags');
});

test('repeated or malformed attributes leave exactly what they touch unknown', () => {
  assert.deepEqual(ok('a=1; SameSite=Lax; SameSite=None').sameSite, { outcome: 'unknown', reason: 'sentinel.import.attributeDuplicate' });
  assert.deepEqual(ok('a=1; Secure; Secure').secure, { outcome: 'unknown', reason: 'sentinel.import.attributeDuplicate' });
  assert.deepEqual(ok('a=1; Secure=1; HttpOnly').secure, { outcome: 'unknown', reason: 'sentinel.import.attributeMalformed' });
  assert.deepEqual(ok('a=1; Secure=1; HttpOnly').httpOnly, { outcome: 'present' });
  assert.deepEqual(ok('a=1; SameSite').sameSite, { outcome: 'unknown', reason: 'sentinel.import.attributeMalformed' });
  assert.deepEqual(ok('a=1; SameSite=Bogus').sameSite, { outcome: 'unknown', reason: 'sentinel.import.sameSiteUnrecognized' });
  assert.equal(reason('a=1; Domain=example.test; Domain=other.test; Secure'), 'sentinel.import.selectorAmbiguous');
  assert.equal(reason('a=1; Path=/; Path=/x; Secure'), 'sentinel.import.selectorAmbiguous');
  assert.deepEqual(ok('a=1; Secure; Foo=bar; Partitioned').extensions, ['foo']);
});

test('a deletion yields no attribute fact; an Expires date alone does not decide issuance', () => {
  const del = ok('sid=; Max-Age=0; Secure; HttpOnly');
  assert.equal(del.lifetime, 'deletion');
  for (const k of ['secure', 'httpOnly', 'sameSite']) assert.deepEqual(del[k], { outcome: 'unknown', reason: 'sentinel.import.deletionCookie' });
  assert.equal(ok('sid=x; Max-Age=-1').lifetime, 'deletion');
  assert.equal(ok('sid=x; Max-Age=3600; Expires=Fri, 22 Oct 2027 10:00:00 GMT').lifetime, 'max-age');
  assert.equal(ok('sid=x; Max-Age=1; Max-Age=2').lifetime, 'unknown');
  assert.equal(ok('sid=x; Max-Age=soon').lifetime, 'unknown');
});

test('a request Cookie header gives names only', () => {
  assert.deepEqual(requestCookieNames('a=1; b="2"'), ['a', 'b']);
  assert.equal(requestCookieNames('a=1;b=2'), undefined);
  assert.equal(requestCookieNames('a=1, b=2'), undefined);
});

test('a recorded head is read only when complete and unfolded', () => {
  const b = new ImportBudget();
  const good: any = parseHead('HTTP/1.1 200\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n', parseStatusLine, b);
  assert.equal(good.ok, true);
  assert.deepEqual(good.headers.map((h: any) => h.value), ['a=1', 'b=2'], 'separate Set-Cookie lines stay separate');
  const code = (t: string, f: any = parseStatusLine) => (parseHead(t, f, b) as any).code;
  assert.equal(code('HTTP/1.1 200\r\nSet-Cookie: a=1\r\n'), 'sentinel.import.headerTruncated');
  assert.equal(code('HTTP/1.1 200\r\nSet-Cookie: a=1\r\n Secure\r\n\r\n'), 'sentinel.import.headerFolded');
  assert.equal(code('HTTP/1.1 200\nSet-Cookie: a=1\r\n\r\n'), 'sentinel.import.headerMalformed');
  assert.equal(code('HTTP/1.1 200\r\nSet-Cookie: a=1\u0000\r\n\r\n'), 'sentinel.import.headerMalformed');
  assert.equal(code('HTTP/1.1 200\r\nBad Name: x\r\n\r\n'), 'sentinel.import.headerMalformed');
  assert.equal(code('HTTP/2 200\r\n\r\n'), 'sentinel.import.versionUnsupported');
  assert.equal(code('HTTP/1.0 0\r\n\r\n'), 'sentinel.import.statusMalformed');
  assert.equal(code('GET /x HTTP/1.1\r\n\r\n', parseRequestLine) === undefined, true);
  assert.equal(code('GET /x y HTTP/1.1\r\n\r\n', parseRequestLine), 'sentinel.import.requestMalformed');
  assert.deepEqual(parseStatusLine('HTTP/1.1 302 Found'), { version: '1.1', status: 302 });
});

test('an origin comes only from an absolute http(s) target, compared as text and never fetched', () => {
  assert.equal(originOf('https://app.example.test/login?x=1'), 'https://app.example.test');
  assert.equal(originOf('HTTPS://APP.example.test:443/'), 'https://app.example.test');
  assert.equal(originOf('/login'), undefined);
  assert.equal(originOf('https://user:pw@app.example.test/'), undefined);
  assert.equal(originOf('ftp://app.example.test/'), undefined);
});
