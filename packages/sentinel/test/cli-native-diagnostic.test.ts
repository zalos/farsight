// Closed nonsecret error metadata only. No keychain/process/model access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeAuthDiagnostic, NativeCredentialError } from '../dist/review/providers/errors.js';
import { ModelCallError } from '../dist/review/providers/broker.js';
import { parseNativeClaudeToken } from '../dist/review/providers/cli-native-auth.js';
const record = {
  schema: 'sentinel-native-auth-refusal/1',
  phase: 'lookup',
  reason: 'interaction-required',
  osStatus: -25308,
} as const;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
test('native refusal keeps only closed phase/reason and numeric nonsecret OSStatus', () => {
  const value = parseNativeAuthDiagnostic(bytes(record));
  assert.deepEqual(value, record);
  assert.ok(Object.isFrozen(value));
  assert.deepEqual(Object.keys(value!).sort(), ['osStatus', 'phase', 'reason', 'schema']);
  for (const reason of [
    'unavailable',
    'interaction-required',
    'authorization-failed',
    'missing',
    'expired',
    'unsupported',
  ])
    assert.ok(parseNativeAuthDiagnostic(bytes({ ...record, reason })));
});
test('unbounded, malformed or extra-field native stderr is discarded rather than retained or interpreted', () => {
  for (const value of [
    Buffer.from('raw untrusted failure text'),
    Buffer.alloc(257),
    Buffer.from([255]),
    bytes({ ...record, account: 'not-allowed' }),
    bytes({ ...record, token: 'not-allowed' }),
    bytes({ ...record, phase: 'unreviewed' }),
    bytes({ ...record, reason: 'signed-in' }),
    bytes({ ...record, osStatus: '-25308' }),
    bytes({ ...record, osStatus: 0.5 }),
    bytes({ ...record, osStatus: 2147483648 }),
    Buffer.from('{"schema":"sentinel-native-auth-refusal/1","phase":"lookup","reason":"missing","osStatus":1e999}'),
  ])
    assert.equal(parseNativeAuthDiagnostic(value), undefined);
});
test('broker error retains the validated diagnostic without changing credentialUnavailable or proven unsent classification', () => {
  const cause = new NativeCredentialError(record),
    error = new ModelCallError(cause, null);
  assert.equal(error.code, 'sentinel.provider.credentialUnavailable');
  assert.equal(error.spend, 'none');
  assert.equal(error.reservation, null);
  assert.deepEqual(error.nativeAuth, record);
  assert.ok(!JSON.stringify(error).includes('accessToken'));
  assert.ok(!JSON.stringify(error).includes('expiresAt'));
});
test('expiry inside original unit plus skew is reported expired without retaining token/expiry/scope values', () => {
  const at = Date.now() + 1000;
  const raw = (over: Record<string, unknown>) =>
    bytes({
      claudeAiOauth: { accessToken: 'synthetic-nonsecret', expiresAt: at + 5000, scopes: ['user:inference'], ...over },
    });
  assert.throws(
    () => parseNativeClaudeToken(raw({}), at),
    (e: any) =>
      e.code === 'sentinel.provider.credentialUnavailable' &&
      e.nativeAuth.reason === 'expired' &&
      e.nativeAuth.osStatus === null &&
      !JSON.stringify(e).includes('synthetic-nonsecret'),
  );
  assert.throws(
    () => parseNativeClaudeToken(raw({ expiresAt: at + 10000, scopes: ['not-qualified'] }), at),
    (e: any) => e.nativeAuth.reason === 'unsupported' && !JSON.stringify(e).includes('not-qualified'),
  );
});
