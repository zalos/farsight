// Receipt crash and race helpers for receipts-publish.test.ts.
//   issue-killed <dir>: issues a receipt and sends itself SIGKILL right after the final name is linked, before the
//                       temporary name is removed (what a crash in that window leaves).
//   spend <dir> <id>:   spends the receipt and prints `spent` or the refusal code.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { ReceiptBook } from '../../dist/policy/index.js';
import { issueReceipt } from '../../dist/policy/owner-receipts.js';
import { binding, NOW } from './receipt-fixture.ts';

const [mode, dir, id] = process.argv.slice(2) as [string, string, string?];
if (mode === 'issue-killed') {
  const original = fs.linkSync;
  (fs as any).linkSync = function (...args: unknown[]) { (original as any).apply(this, args); process.kill(process.pid, 'SIGKILL'); };
  syncBuiltinESMExports();
  issueReceipt(new ReceiptBook(dir), { channel: 'owner-cli', principal: 'owner' }, binding, { now: NOW, ttlMs: 600_000 });
} else {
  try { new ReceiptBook(dir).consume(id!, binding, NOW); process.stdout.write('spent'); } catch (e: any) { process.stdout.write(String(e.code)); }
}
