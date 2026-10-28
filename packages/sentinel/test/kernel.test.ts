// The kernel's other parts (docs/proposals/sentinel-v2 K-1): the id and digest patterns, deep freezing, the error
// base and digest sealing. canonicalJson and the SHA-256 helpers are proved in kernel-digest.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIGEST_PATTERN, HEX64_PATTERN, hexOfDigest, ID_PATTERN, isDigest, isHex64, isId } from '../dist/kernel/ids.js';
import { deepFreeze, frozenCopy } from '../dist/kernel/freeze.js';
import { isSentinelError, SentinelError } from '../dist/kernel/errors.js';
import { sealDigest, verifySealedDigest } from '../dist/kernel/seal.js';
import { digestOf } from '../dist/kernel/digest.js';

const HEX = 'ab'.repeat(32);

test('an id is a letter or digit, then letters, digits and . _ : -, at most 128 characters', () => {
  for (const id of ['a', 'run-1', 'Z9', 'work-capture-0123', 'a.b_c:d-e', 'x'.repeat(128)]) assert.ok(isId(id), id);
  for (const id of ['', '-a', '.a', 'a b', 'a/b', 'a\nb', 'é', 'x'.repeat(129), 'a\u0000']) assert.ok(!isId(id), id);
  for (const value of [1, null, undefined, {}, ['a']]) assert.ok(!isId(value));
});

test('a digest is sha256: and 64 lower-case hex characters, and its hex is read back', () => {
  assert.ok(isDigest(`sha256:${HEX}`));
  for (const d of [HEX, `sha256:${HEX.toUpperCase()}`, `sha256:${HEX}0`, `sha256:${HEX.slice(1)}`, `sha512:${HEX}`])
    assert.ok(!isDigest(d), d);
  assert.ok(isHex64(HEX));
  assert.ok(!isHex64(`sha256:${HEX}`));
  assert.equal(hexOfDigest(`sha256:${HEX}`), HEX);
  assert.equal(hexOfDigest(HEX), undefined);
  assert.equal(hexOfDigest(42), undefined);
});

test('the patterns are frozen: no module can recompile one and change what every other module accepts', () => {
  for (const pattern of [ID_PATTERN, DIGEST_PATTERN, HEX64_PATTERN]) {
    assert.ok(Object.isFrozen(pattern));
    assert.equal(pattern.global || pattern.sticky, false, 'a stateless pattern');
    assert.throws(() => (pattern as RegExp & { compile(s: string): void }).compile('.*'), TypeError);
  }
  assert.ok(isId('run-1'), 'still the original pattern');
  assert.ok(ID_PATTERN.test('run-1') && ID_PATTERN.test('run-1'), 'a frozen pattern tests the same twice');
});

test('deepFreeze freezes everything reachable, outermost first, and survives a cycle', () => {
  const v: Record<string, unknown> = { a: { b: [1, { c: 2 }] }, d: 'x' };
  v.self = v;
  assert.equal(deepFreeze(v), v, 'returns the value itself');
  assert.ok(Object.isFrozen(v));
  assert.ok(Object.isFrozen(v.a));
  assert.ok(Object.isFrozen((v.a as { b: unknown[] }).b));
  assert.ok(Object.isFrozen((v.a as { b: unknown[] }).b[1]));
  assert.equal(deepFreeze(7), 7);
  assert.equal(deepFreeze(null), null);
  // What it leaves alone, as documented: what is under an already-frozen object, and a Map's entries.
  const inner = { mutable: true };
  const outer = Object.freeze({ inner });
  deepFreeze(outer);
  assert.ok(!Object.isFrozen(inner));
  const map = new Map([['k', { v: 1 }]]);
  deepFreeze({ map });
  assert.ok(Object.isFrozen(map));
  assert.ok(!Object.isFrozen(map.get('k')));
  assert.throws(() => deepFreeze({ bytes: new Uint8Array([1]) }), TypeError);
});

test('frozenCopy is private: the copy is deep-frozen and shares no object with the original', () => {
  const original = { a: { b: [1, 2] } };
  const copy = frozenCopy(original);
  assert.deepEqual(copy, original);
  assert.notEqual(copy.a, original.a);
  assert.ok(Object.isFrozen(copy.a.b));
  original.a.b.push(3);
  assert.deepEqual(copy.a.b, [1, 2]);
  assert.throws(() => frozenCopy({ f() {} }));
});

test('SentinelError carries a stable code and a frozen copy of its detail', () => {
  const detail = { path: 'a/b', count: 2 };
  const cause = new Error('underneath');
  const e = new SentinelError('sentinel.example.refused', 'the example was refused', { detail, cause });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'SentinelError');
  assert.equal(e.code, 'sentinel.example.refused');
  assert.equal(e.message, 'the example was refused');
  assert.equal(e.cause, cause);
  assert.deepEqual(e.detail, detail);
  assert.ok(Object.isFrozen(e.detail));
  detail.count = 3;
  assert.equal(e.detail.count, 2, 'a later change to the caller object does not reach the error');
  const bare = new SentinelError('sentinel.example.bare', 'bare');
  assert.deepEqual(bare.detail, {});
  assert.ok(!('cause' in bare));
  assert.ok(isSentinelError(e));
  assert.ok(isSentinelError(e, 'sentinel.example.refused'));
  assert.ok(!isSentinelError(e, 'sentinel.example.other'));
  assert.ok(!isSentinelError(new Error('plain')));
});

test('a module error class extends the base and keeps its own name and code type', () => {
  class ExampleError extends SentinelError<'sentinel.example.a' | 'sentinel.example.b'> {
    constructor(code: 'sentinel.example.a' | 'sentinel.example.b', message: string) {
      super(code, message);
      this.name = 'ExampleError';
    }
  }
  const e = new ExampleError('sentinel.example.b', 'b');
  assert.ok(e instanceof SentinelError && e instanceof ExampleError);
  assert.equal(e.name, 'ExampleError');
  assert.equal(e.code, 'sentinel.example.b');
  assert.ok(isSentinelError(e, 'sentinel.example.b'));
});

test('a sealed record carries the digest of everything else; any edit after sealing is detected', () => {
  const body = { schema: 'sentinel-example/draft-1', items: [1, 2], name: 'x' };
  const sealed = sealDigest(body);
  assert.equal(sealed.digest, digestOf(body));
  assert.ok(!('digest' in body), 'the body is not changed');
  assert.ok(verifySealedDigest(sealed));
  assert.ok(!verifySealedDigest({ ...sealed, name: 'y' }));
  assert.ok(!verifySealedDigest({ ...sealed, extra: true }));
  assert.ok(!verifySealedDigest({ ...sealed, digest: digestOf({}) }));
  assert.ok(!verifySealedDigest({ ...body }), 'no digest');
  assert.ok(!verifySealedDigest({ digest: 7 }));
  assert.ok(!verifySealedDigest({ digest: sealed.digest, when: new Date(0) }), 'no canonical form is not sealed');
  assert.throws(() => sealDigest(sealed), TypeError, 'a body that already has a digest');
  assert.throws(() => sealDigest({ n: NaN }), TypeError);
});
