import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, linkSync, rmSync } from 'node:fs';
import { companionWorkspaceDigest, companionFilename, readCompanion } from '@farsight/core/dist/sentinel-companion.js';
import { publishOwnerCompanion } from '../dist/owner-ui/descriptor.js';
import { scratch, needsStore } from './snapshot-helpers.ts';
function fixture(t: any) {
  const root = scratch(t),
    workspace = join(root, 'workspace'),
    directory = join(root, 'private', 'companions');
  mkdirSync(workspace, { mode: 0o700 });
  const value = {
    schema: 'farsight-sentinel-companion/1' as const,
    workspaceDigest: companionWorkspaceDigest(workspace),
    ownerOrigin: 'http://127.0.0.1:4501',
    farsightOrigin: 'http://127.0.0.1:4500',
    hostInstance: 'host-' + 'a'.repeat(32),
    processNonce: 'b'.repeat(64),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  return { directory, value, path: join(directory, companionFilename(value.workspaceDigest, value.farsightOrigin)) };
}
test(
  'explicit fixed descriptor publication replaces only its paired record and old exit cannot remove a new nonce',
  needsStore,
  async (t) => {
    const f = fixture(t),
      old = await publishOwnerCompanion(f.directory, f.value);
    old.assertCurrent();
    assert.deepEqual(readCompanion(f.directory, f.value), f.value);
    const next = await publishOwnerCompanion(f.directory, {
      ...f.value,
      processNonce: 'c'.repeat(64),
      ownerOrigin: 'http://127.0.0.1:4502',
    });
    assert.throws(() => old.assertCurrent());
    await old.close();
    next.assertCurrent();
    await next.close();
    assert.equal(existsSync(f.path), false);
    assert.ok(
      readdirSync(f.directory).some((n) => n.endsWith('.mutex.sqlite')),
      'private mutex persists without PID unlink',
    );
  },
);
test('unsafe/foreign descriptor is never replaced or repaired', needsStore, async (t) => {
  const f = fixture(t),
    owner = await publishOwnerCompanion(f.directory, f.value);
  linkSync(f.path, f.path + '.alias');
  const before = readFileSync(f.path);
  await assert.rejects(publishOwnerCompanion(f.directory, f.value));
  assert.ok(readFileSync(f.path).equals(before));
  assert.equal(existsSync(f.path + '.alias'), true);
  rmSync(f.path + '.alias');
  await owner.close();
  writeFileSync(f.path, JSON.stringify({ ...f.value, workspaceDigest: 'sha256:' + 'd'.repeat(64) }), { mode: 0o600 });
  await assert.rejects(publishOwnerCompanion(f.directory, f.value));
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).workspaceDigest, 'sha256:' + 'd'.repeat(64));
});
