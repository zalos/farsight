import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { libraryVersion } from '../library-version.mjs';

test('paired library version changes are explicit and leave the application version untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'library-version-'));
  try {
    for (const name of ['graph', 'code-parser']) {
      mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
      writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name, version: '0.1.0' }));
    }
    const stamp = join(root, 'packages/code-parser/src/version.ts');
    writeFileSync(stamp, "export const PARSER_VERSION = '0.1.0';\n");
    const app = join(root, 'package.json');
    writeFileSync(app, '{"version":"9.0.0"}');
    assert.equal(libraryVersion(root), '0.1.0');
    assert.equal(libraryVersion(root, '0.2.0', { dryRun: true }), '0.2.0');
    assert.equal(libraryVersion(root), '0.1.0');
    assert.throws(() => libraryVersion(root, '0.0.9'), /increase/);
    assert.throws(() => libraryVersion(root, '../bad'), /version/);
    libraryVersion(root, '0.2.0');
    assert.equal(libraryVersion(root), '0.2.0');
    assert.equal(JSON.parse(readFileSync(app, 'utf8')).version, '9.0.0');
    assert.match(readFileSync(stamp, 'utf8'), /'0.2.0'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
