import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageNativeCliHelper } from '../sentinel-native-helper.mjs';
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
test('native packaging requires exact source, manifest, executable bytes and architecture without executing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-native-pack-')),
    out = join(root, 'out');
  try {
    assert.equal(stageNativeCliHelper(root, out), false);
    assert.throws(() => stageNativeCliHelper(root, out, true), /requires/);
    const src = join(root, 'packages/sentinel/src/review/providers/native'),
      art = join(root, 'build/sentinel-cli-native/darwin-arm64');
    mkdirSync(src, { recursive: true });
    mkdirSync(art, { recursive: true });
    const source = Buffer.from('// synthetic source'),
      bin = Buffer.alloc(64);
    bin.writeUInt32LE(0xfeedfacf, 0);
    bin.writeUInt32LE(0x0100000c, 4);
    bin.writeUInt32LE(2, 12);
    const sourceFile = join(src, 'claude-keychain-helper.m'),
      binaryFile = join(art, 'claude-keychain-helper'),
      manifestFile = join(art, 'manifest.json');
    writeFileSync(sourceFile, source);
    writeFileSync(binaryFile, bin);
    const m = {
      schema: 'sentinel-native-cli-helper/1',
      platform: 'darwin',
      arch: 'arm64',
      protocol: 'claude-keychain-token/1',
      sourceDigest: sha(source),
      helperDigest: sha(bin),
      helperBytes: bin.length,
      noUi: true,
      compiler: 'Synthetic fixture',
    };
    const write = (v = m) => writeFileSync(manifestFile, JSON.stringify(v));
    write();
    assert.equal(stageNativeCliHelper(root, out, true), true);
    assert.deepEqual(readFileSync(join(out, 'dist/review/providers/native/claude-keychain-helper')), bin);
    write({ ...m, extra: true });
    assert.throws(() => stageNativeCliHelper(root, out, true), /manifest is invalid/);
    write();
    writeFileSync(sourceFile, 'different');
    assert.throws(() => stageNativeCliHelper(root, out, true), /does not match/);
    writeFileSync(sourceFile, source);
    bin[40] = 1;
    writeFileSync(binaryFile, bin);
    assert.throws(() => stageNativeCliHelper(root, out, true), /does not match/);
    bin.writeUInt32LE(0x01000007, 4);
    writeFileSync(binaryFile, bin);
    write({ ...m, helperDigest: sha(bin) });
    assert.throws(() => stageNativeCliHelper(root, out, true), /does not match/);
    rmSync(binaryFile);
    symlinkSync(sourceFile, binaryFile);
    assert.throws(() => stageNativeCliHelper(root, out, true), /regular file/);
    assert.equal(existsSync(join(out, 'dist/review/providers/native/manifest.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
