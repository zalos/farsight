// A published owner record must be inspected without waiting for another process to open a named pipe.
// Bound the child, rather than the test's event loop: the regression is a blocking synchronous open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishOnce, readPublished, UnsafeRecordError } from '../dist/service/publish-once.js';
import { withheldLocationKey } from '../dist/service/report-key.js';

const supported = { skip: process.platform === 'win32' ? 'owner-private publication requires POSIX files' : false };
const publicationModule = new URL('../dist/service/publish-once.js', import.meta.url).href;
const keyModule = new URL('../dist/service/report-key.js', import.meta.url).href;

function folder(t: { after(fn: () => void): void }) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-publication-')));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fifo(path: string) {
  const made = spawnSync('mkfifo', ['-m', '600', path], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  assert.ok(lstatSync(path).isFIFO());
}

function readInChild(kind: 'record' | 'key', dir: string, name: string) {
  const code = `
    import { readPublished } from ${JSON.stringify(publicationModule)};
    import { withheldLocationKey } from ${JSON.stringify(keyModule)};
    try {
      if (process.argv[1] === 'key') withheldLocationKey(process.argv[2], process.argv[3]);
      else readPublished(process.argv[2], process.argv[3], 32);
      process.stdout.write('read');
    } catch (e) { process.stdout.write(e.name + ':' + e.message); process.exitCode = 2; }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', code, kind, dir, name], {
    encoding: 'utf8',
    timeout: 2_000,
    killSignal: 'SIGKILL',
  });
}

test('private regular records retain exact once-only publication, bounded reads and process reopen', supported, (t) => {
  const dir = folder(t);
  const bytes = Buffer.from('inert owner record');
  assert.equal(readPublished(dir, 'record', 32), undefined);
  assert.equal(publishOnce(dir, 'record', bytes), true);
  assert.equal(publishOnce(dir, 'record', Buffer.from('different record')), false);
  assert.deepEqual(readPublished(dir, 'record', 32), bytes);
  assert.throws(() => readPublished(dir, 'record', bytes.length - 1), UnsafeRecordError);
  assert.equal(lstatSync(join(dir, 'record')).nlink, 1);
  assert.deepEqual(readdirSync(dir), ['record']);
  const read = readInChild('record', dir, 'record');
  assert.equal(read.error, undefined);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, 'read');
});

test('an actual FIFO at a published record name is refused without a writer', supported, (t) => {
  const dir = folder(t);
  const path = join(dir, 'record');
  fifo(path);
  const read = readInChild('record', dir, 'record');
  assert.equal(read.error, undefined, 'the owner read must not block waiting for a FIFO writer');
  assert.equal(read.status, 2, read.stderr);
  assert.match(read.stdout, /^UnsafeRecordError:not a regular file$/);
  assert.ok(lstatSync(path).isFIFO(), 'refusal preserves the existing name');
  assert.deepEqual(readdirSync(dir), ['record'], 'refusal creates no replacement or temporary record');
});

test('the report-key caller refuses an actual FIFO and can reopen the same restored regular key', supported, (t) => {
  const trust = folder(t);
  const storeId = 'sentinel-original-fixture-store';
  const original = withheldLocationKey(trust, storeId);
  assert.equal(original.length, 32);
  const dir = join(trust, 'report-keys');
  const names = readdirSync(dir);
  assert.equal(names.length, 1);
  const path = join(dir, names[0]!);
  unlinkSync(path);
  fifo(path);
  const read = readInChild('key', trust, storeId);
  assert.equal(read.error, undefined, 'report generation must not block waiting for a FIFO writer');
  assert.equal(read.status, 2, read.stderr);
  assert.match(read.stdout, /^ReportKeyError:the report key is unsafe: not a regular file$/);
  assert.ok(lstatSync(path).isFIFO());
  assert.deepEqual(readdirSync(dir), names, 'the unsafe key is not replaced');
  unlinkSync(path);
  writeFileSync(path, original, { mode: 0o600, flag: 'wx' });
  assert.deepEqual(withheldLocationKey(trust, storeId), original);
  const restored = readInChild('key', trust, storeId);
  assert.equal(restored.error, undefined);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.stdout, 'read');
});

// The key is deliberately outside the portable store; absent state cannot prove an older key existed.
test('losing the owner-private report key starts a new identity domain for the same store', supported, (t) => {
  const trust = folder(t);
  const storeId = 'sentinel-key-loss-fixture-store';
  const before = withheldLocationKey(trust, storeId);
  const dir = join(trust, 'report-keys');
  const names = readdirSync(dir);
  assert.equal(names.length, 1);
  unlinkSync(join(dir, names[0]!));
  const after = withheldLocationKey(trust, storeId);
  assert.equal(after.length, 32);
  assert.ok(!before.equals(after), 'missing private state cannot reproduce the old key');
  assert.deepEqual(withheldLocationKey(trust, storeId), after, 'the new private state is retained');
});
