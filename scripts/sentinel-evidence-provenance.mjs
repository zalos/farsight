// Private installed-consumer harness only. Rebuilding must reproduce every package byte; the
// packer's wall-clock build time is restored only after all non-time identity fields match.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { npmPackEnv } from './pack-preflight.mjs';

const STAMP_BYTES = 8192;
function stamp(bytes, version) {
  assert.ok(bytes.length > 0 && bytes.length <= STAMP_BYTES, 'bounded build stamp required');
  const value = JSON.parse(bytes.toString('utf8'));
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'build stamp object required');
  assert.ok(
    Object.keys(value).every((k) => ['name', 'version', 'built', 'commit', 'codeCommit', 'dirty'].includes(k)),
    'unknown build stamp field',
  );
  assert.equal(value.name, 'farsight-sentinel');
  assert.equal(value.version, version);
  assert.ok(
    typeof value.built === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.built) &&
      new Date(value.built).toISOString() === value.built,
    'canonical build time required',
  );
  for (const k of ['commit', 'codeCommit']) if (Object.hasOwn(value, k)) assert.match(value[k], /^[a-f0-9]{7,40}$/);
  if (Object.hasOwn(value, 'dirty')) assert.equal(typeof value.dirty, 'boolean');
  const { built, ...identity } = value;
  return identity;
}
function readStamp(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= STAMP_BYTES, 'bounded regular build stamp required');
    const bytes = readFileSync(fd);
    assert.ok(bytes.length <= STAMP_BYTES);
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function repackAtOriginalBuildTime({ snapshot, packageDir, version, options }) {
  // Read one fixed member without extracting an archive into the filesystem. Duplicate members,
  // malformed JSON and oversized output fail closed. The caller already bounded/snapshotted the tgz.
  const original = execFileSync('tar', ['-xOf', snapshot, 'package/dist/build-stamp.json'], {
    ...options,
    maxBuffer: STAMP_BYTES,
  });
  const path = join(packageDir, 'dist/build-stamp.json'),
    rebuilt = readStamp(path);
  assert.deepEqual(stamp(rebuilt, version), stamp(original, version), 'private build/input non-time identity mismatch');
  writeFileSync(path, original);
  execFileSync('npm', ['pack', '--pack-destination', '..'], { ...options, cwd: packageDir, env: npmPackEnv() });
  // The caller still compares the complete resulting tgz SHA-256, then installs the original snapshot.
}
