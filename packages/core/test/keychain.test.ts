import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeychainReadError, readKeychain } from '../dist/keychain.js';

test('keychain transport selects the OS command with literal argument boundaries', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner = async (command: string, args: string[]) => {
    calls.push({ command, args });
    return 'synthetic-value';
  };
  const entry = { service: 'service with spaces', account: 'account; literal' };
  assert.equal(await readKeychain(entry, { platform: 'darwin', runner }), 'synthetic-value');
  assert.equal(await readKeychain(entry, { platform: 'linux', runner }), 'synthetic-value');
  assert.deepEqual(calls, [
    { command: 'security', args: ['find-generic-password', '-s', entry.service, '-a', entry.account, '-w'] },
    { command: 'secret-tool', args: ['lookup', 'service', entry.service, 'account', entry.account] },
  ]);
});

test('transport failures expose codes, never raw command errors or secret values', async () => {
  const sentinel = 'synthetic-private-output';
  const entry = { service: sentinel, account: sentinel };
  for (const [rawCode, expected] of [
    ['ENOENT', 'missing-tool'],
    ['EACCES', 'refused'],
    [44, 'refused'],
  ] as const) {
    await assert.rejects(
      readKeychain(entry, {
        platform: 'darwin',
        runner: async () => {
          throw Object.assign(new Error(sentinel), { code: rawCode, stdout: sentinel, stderr: sentinel });
        },
      }),
      (error: Error) => {
        assert.ok(error instanceof KeychainReadError);
        assert.equal(error.code, expected);
        assert.equal(error.command, 'security');
        assert.ok(!String(error).includes(sentinel));
        assert.ok(!JSON.stringify(error).includes(sentinel));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
  await assert.rejects(
    readKeychain(entry, { platform: 'linux', runner: async () => '' }),
    (error: Error) => error instanceof KeychainReadError && error.code === 'empty',
  );
});

test('unsupported keychains never invoke the command runner', async () => {
  for (const platform of ['win32', 'aix'] as const) {
    await assert.rejects(
      readKeychain(
        { service: 'test', account: 'test' },
        {
          platform,
          runner: async () => {
            assert.fail('must not run');
          },
        },
      ),
      (error: Error) =>
        error instanceof KeychainReadError && error.code === 'unsupported' && error.platform === platform,
    );
  }
});

test('default keychain runner removes only one trailing newline and bounds time and output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'keychain-transport-'));
  const priorPath = process.env.PATH;
  const command = join(root, 'security');
  const script = (source: string) => writeFileSync(command, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  const entry = { service: 'synthetic-service', account: 'synthetic-account' };
  // A private fixture executable stands in for security; the real keychain is never read.
  process.env.PATH = root;
  try {
    script('process.stdout.write("first\\nsecond\\r\\n");');
    assert.equal(await readKeychain(entry, { platform: 'darwin' }), 'first\nsecond');
    script('process.stdout.write("x".repeat(80 * 1024));');
    await assert.rejects(
      readKeychain(entry, { platform: 'darwin' }),
      (error: Error) => error instanceof KeychainReadError && error.code === 'refused',
    );
    script('setTimeout(() => {}, 5000);');
    await assert.rejects(
      readKeychain(entry, { platform: 'darwin', timeoutMs: 50 }),
      (error: Error) => error instanceof KeychainReadError && error.code === 'refused',
    );
    script('process.stderr.write("synthetic-private-output"); process.exit(44);');
    await assert.rejects(
      readKeychain(entry, { platform: 'darwin' }),
      (error: Error) =>
        error instanceof KeychainReadError &&
        error.code === 'refused' &&
        !JSON.stringify(error).includes('synthetic-private-output'),
    );
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  }
});
