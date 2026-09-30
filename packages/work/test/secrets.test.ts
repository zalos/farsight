import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSecret, resolveMaybeSecret, parseKeychainRef, SecretUnavailable } from '../dist/index.js';

const SENTINEL = 'tok-3f9a-SENTINEL';

test('env: resolves in process', async () => {
  assert.equal(await resolveSecret('env:WORK_T', { env: { WORK_T: SENTINEL } }), SENTINEL);
});

test('env: missing names the ref, not a value', async () => {
  await assert.rejects(resolveSecret('env:WORK_MISSING', { env: {} }), (e: Error) =>
    e instanceof SecretUnavailable && e.message.includes('env:WORK_MISSING'));
});

test('keychain: parses service/account on the last slash', () => {
  assert.deepEqual(parseKeychainRef('keychain:farsight/jira-example'), { service: 'farsight', account: 'jira-example' });
  assert.equal(parseKeychainRef('keychain:nothing'), null);
});

test('keychain: macOS and Linux call the right tool; the value is returned, never in an error', async () => {
  const calls: string[][] = [];
  const runner = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return SENTINEL; };
  assert.equal(await resolveSecret('keychain:farsight/x', { platform: 'darwin', runner }), SENTINEL);
  assert.equal(await resolveSecret('keychain:farsight/x', { platform: 'linux', runner }), SENTINEL);
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-s', 'farsight', '-a', 'x', '-w']);
  assert.deepEqual(calls[1], ['secret-tool', 'lookup', 'service', 'farsight', 'account', 'x']);
  const failing = async () => { throw Object.assign(new Error(`boom ${SENTINEL}`), { code: 44 }); };
  await assert.rejects(resolveSecret('keychain:farsight/x', { platform: 'darwin', runner: failing }), (e: Error) =>
    e.message.includes('keychain:farsight/x') && !e.message.includes(SENTINEL));
});

test('keychain: Windows is a typed not-built error', async () => {
  await assert.rejects(resolveSecret('keychain:farsight/x', { platform: 'win32' }), (e: Error) =>
    e instanceof SecretUnavailable && /DPAPI/.test(e.message));
});

test('a literal is not a reference', async () => {
  await assert.rejects(resolveSecret('hunter2'), (e: Error) => !e.message.includes('hunter2'));
  assert.equal(await resolveMaybeSecret('dev@example.com'), 'dev@example.com');
});
