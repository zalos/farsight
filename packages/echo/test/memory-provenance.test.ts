import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMemoryOrigin, verifyMemoryOrigin } from '../dist/memory-provenance.js';

test('provenance uses the saving workspace and current HEAD, including unborn and non-Git workspaces', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-provenance-')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    assert.deepEqual(await captureMemoryOrigin(root), { workspace: root, commit: null });
    git('init', '--quiet');
    assert.deepEqual(await captureMemoryOrigin(root), { workspace: root, commit: null });
    git(
      '-c',
      'user.name=Echo fixture',
      '-c',
      'user.email=dev@example.com',
      'commit',
      '--allow-empty',
      '--no-verify',
      '-m',
      'test: synthetic fixture',
    );
    mkdirSync(join(root, 'nested'));
    const origin = await captureMemoryOrigin(join(root, 'nested'));
    assert.deepEqual(origin, { workspace: root, commit: git('rev-parse', 'HEAD') });
    assert.deepEqual(await verifyMemoryOrigin(origin), origin);
    assert.equal(await verifyMemoryOrigin({ ...origin, commit: '0'.repeat(40) }), undefined);
    assert.equal(await verifyMemoryOrigin({ ...origin, workspace: join(root, 'nested') }), undefined);
    assert.equal(await verifyMemoryOrigin({ ...origin, savedAt: 'yesterday' }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
