import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { repackAtOriginalBuildTime } from '../sentinel-evidence-provenance.mjs';
import { npmPackEnv } from '../pack-preflight.mjs';
const version = '0.0.0-test',
  options = { timeout: 30000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-provenance-test-')),
    packageDir = join(root, 'package');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(dirname(join(packageDir, file)), { recursive: true });
    writeFileSync(join(packageDir, file), text);
  };
  const identity = {
    name: 'farsight-sentinel',
    version,
    built: '2026-10-23T00:00:00.000Z',
    commit: '12345678',
    codeCommit: '12345678',
    dirty: false,
  };
  write('package.json', JSON.stringify({ name: 'farsight-sentinel', version, type: 'module', files: ['dist'] }));
  for (const file of ['dist/runtime.mjs', 'dist/execution/launch-gate.mjs', 'dist/index.d.ts'])
    write(file, 'original ' + file + '\n');
  write('dist/build-stamp.json', JSON.stringify(identity, null, 2) + '\n');
  execFileSync('npm', ['pack', '--pack-destination', '..'], { ...options, cwd: packageDir, env: npmPackEnv() });
  const rebuilt = join(root, 'farsight-sentinel-' + version + '.tgz'),
    snapshot = join(root, 'input.tgz');
  copyFileSync(rebuilt, snapshot);
  const later = { ...identity, built: '2026-10-23T00:01:00.000Z' };
  write('dist/build-stamp.json', JSON.stringify(later, null, 2) + '\n');
  const verify = () => {
    repackAtOriginalBuildTime({ snapshot, packageDir, version, options });
    assert.equal(hash(rebuilt), hash(snapshot), 'complete artifact identity required');
  };
  return { write, later, verify, rebuilt, snapshot };
}
test('independent npm rebuild matches every tgz byte after restoring only original build time', (t) => {
  const f = fixture(t);
  f.verify();
});
for (const file of ['dist/runtime.mjs', 'dist/execution/launch-gate.mjs', 'dist/index.d.ts'])
  test('complete artifact gate refuses drift in ' + file, (t) => {
    const f = fixture(t);
    f.write(file, 'changed\n');
    assert.throws(f.verify, /complete artifact identity required/);
  });
test('non-time identity changes refuse before stamp restoration', (t) => {
  const f = fixture(t);
  for (const changed of [{ commit: 'abcdef12' }, { dirty: true }, { version: '0.0.1' }, { unexpected: 'field' }]) {
    const bytes = JSON.stringify({ ...f.later, ...changed });
    f.write('dist/build-stamp.json', bytes);
    assert.throws(f.verify);
    assert.equal(readFileSync(join(dirname(f.rebuilt), 'package/dist/build-stamp.json'), 'utf8'), bytes);
  }
});
test('malformed and oversized original stamps refuse before restoration', (t) => {
  const f = fixture(t);
  // These are deliberately malformed input artifacts, not normal producer output.
  for (const text of ['{"name":"farsight-sentinel","built":"invalid"}', 'x'.repeat(8193)]) {
    f.write('dist/build-stamp.json', text);
    execFileSync('npm', ['pack', '--pack-destination', '..'], {
      ...options,
      cwd: join(dirname(f.rebuilt), 'package'),
      env: npmPackEnv(),
    });
    copyFileSync(f.rebuilt, f.snapshot);
    f.write('dist/build-stamp.json', JSON.stringify(f.later));
    assert.throws(f.verify);
  }
});
