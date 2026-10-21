import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('pack without compiled packages explains the build prerequisite before changing build artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'farsight-pack-test-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(resolve('scripts/pack.mjs'), join(root, 'scripts/pack.mjs'));
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.0.0', type: 'module' }));
    mkdirSync(join(root, 'build'));
    writeFileSync(join(root, 'build', 'keep.txt'), 'prior artifact');
    const run = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /pnpm build && node scripts\/pack\.mjs/);
    assert.doesNotMatch(run.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.equal(existsSync(join(root, 'build', 'keep.txt')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
