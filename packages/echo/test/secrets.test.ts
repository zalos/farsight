import { test } from 'node:test';
import assert from 'node:assert/strict';
import { echoConfigWord } from '@farsight/core/dist/strings-echo-config.js';
import { resolveSecret } from '../dist/secrets.js';
import { pinCredentialOrigin } from '../dist/trust.js';

test('shared keychain transport cannot bypass Echo reference restrictions or origin authorization', async () => {
  const ref = 'keychain:farsight-echo/transport-test';
  const origin = 'https://models.example.com';
  await pinCredentialOrigin(ref, origin);
  let calls = 0;
  const runner = async () => {
    calls++;
    return 'synthetic-value';
  };
  for (const forbidden of [
    'env:ECHO_SYNTHETIC_SECRET',
    'keychain:farsight/work-account',
    'keychain:farsight-echo/provider/account',
    'literal-private-value',
  ]) {
    await assert.rejects(
      resolveSecret(forbidden, { platform: 'darwin', runner, origin }),
      (error: Error) => !error.message.includes(forbidden),
    );
  }
  await assert.rejects(resolveSecret(ref, { platform: 'darwin', runner }));
  await assert.rejects(resolveSecret(ref, { platform: 'darwin', runner, origin: 'https://other.example.com' }));
  assert.equal(calls, 0);
  assert.equal(await resolveSecret(undefined, { platform: 'darwin', runner, origin }), '');
  assert.equal(calls, 0);
  assert.equal(await resolveSecret(ref, { platform: 'darwin', runner, origin }), 'synthetic-value');
  assert.equal(calls, 1);
});

test('Echo masks transport details and refuses empty or multiline values', async () => {
  const ref = 'keychain:farsight-echo/transport-value-test';
  const origin = 'https://models.example.com';
  await pinCredentialOrigin(ref, origin);
  for (const value of ['', 'line one\nline two', 'line one\rline two']) {
    await assert.rejects(
      resolveSecret(ref, { platform: 'linux', origin, runner: async () => value }),
      (error: Error) => error.message === echoConfigWord('echo.secret.unavailable'),
    );
  }
  await assert.rejects(
    resolveSecret(ref, {
      platform: 'linux',
      origin,
      runner: async () => {
        throw Object.assign(new Error('synthetic-private-output'), {
          code: 'ENOENT',
          stdout: 'synthetic-private-output',
        });
      },
    }),
    (error: Error) =>
      error.message === echoConfigWord('echo.secret.unavailable') &&
      !JSON.stringify(error).includes('synthetic-private-output'),
  );
});
