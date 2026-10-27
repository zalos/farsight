// Owner receipts are published whole or not at all (policy/user-state.ts createPrivateFileOnce): a failure while
// writing leaves no receipt; a crash right after the final name is linked leaves a complete receipt that can still be
// spent (its writer's temporary alias is removed on read, and only that); spending stays exactly once across racing
// processes; and any other second name is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReceiptBook } from '../dist/policy/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { binding, NOW } from './helpers/receipt-fixture.ts';

const CHILD = fileURLToPath(new URL('./helpers/receipt-child.ts', import.meta.url));
const child = (...args: string[]) =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CHILD, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
const owner = { channel: 'owner-cli', principal: 'owner' };

function book(t: { after(fn: () => void): void }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-receipts-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'receipts');
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

test('a failure while writing a receipt leaves no receipt and no temporary name', (t) => {
  const dir = book(t);
  const original = fs.writeSync;
  (fs as any).writeSync = function () {
    throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => issueReceipt(new ReceiptBook(dir), owner, binding, { now: NOW, ttlMs: 600_000 }));
  } finally {
    (fs as any).writeSync = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(dir), [], 'nothing at a final name, nothing left behind');
  // The owner confirms again and it works.
  const r = issueReceipt(new ReceiptBook(dir), owner, binding, { now: NOW, ttlMs: 600_000 });
  assert.ok(new ReceiptBook(dir).consume(r.id, binding, NOW));
});

test('a process killed right after linking a receipt leaves it whole and spendable, once', (t) => {
  const dir = book(t);
  const killed = child('issue-killed', dir);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const names = readdirSync(dir);
  const receipt = names.find((n) => /^receipt-.*\.json$/.test(n))!;
  assert.ok(receipt, `the receipt was linked: ${names}`);
  assert.ok(
    names.some((n) => n.startsWith('.') && n.endsWith('.tmp')),
    'its temporary alias survived the crash',
  );
  const id = receipt.slice(0, -'.json'.length);
  assert.equal(child('spend', dir, id).stdout, 'spent', 'the alias is removed on read and the receipt spent');
  assert.equal(child('spend', dir, id).stdout, 'sentinel.receipt.alreadyUsed');
  assert.ok(!readdirSync(dir).some((n) => n.startsWith('.') && n.includes('.json.') && n.endsWith('.tmp')));
});

test('racing spends of one receipt: exactly one succeeds', async (t) => {
  const dir = book(t);
  const r = issueReceipt(new ReceiptBook(dir), owner, binding, { now: NOW, ttlMs: 600_000 });
  const outcomes = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<string>((resolve) => {
          const c = spawn(process.execPath, [
            '--disable-warning=ExperimentalWarning',
            '--experimental-strip-types',
            CHILD,
            'spend',
            dir,
            r.id,
          ]);
          let out = '';
          c.stdout.on('data', (d) => {
            out += d;
          });
          c.on('close', () => resolve(out));
        }),
    ),
  );
  assert.equal(outcomes.filter((o) => o === 'spent').length, 1, JSON.stringify(outcomes));
  assert.ok(
    outcomes.filter((o) => o !== 'spent').every((o) => o === 'sentinel.receipt.alreadyUsed'),
    JSON.stringify(outcomes),
  );
});

test('a receipt with any other second name is refused, never followed or cleaned', (t) => {
  const dir = book(t);
  const r = issueReceipt(new ReceiptBook(dir), owner, binding, { now: NOW, ttlMs: 600_000 });
  linkSync(join(dir, `${r.id}.json`), join(dir, 'elsewhere.json'));
  assert.throws(
    () => new ReceiptBook(dir).consume(r.id, binding, NOW),
    (e: any) => e.code === 'sentinel.receipt.storeUnsafe',
  );
  assert.ok(readdirSync(dir).includes('elsewhere.json'));
});
