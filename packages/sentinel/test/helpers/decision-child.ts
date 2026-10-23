import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DecisionJournal, approveForOwner } from '../../dist/findings/dispositions.js';
import { ReceiptBook } from '../../dist/policy/receipts.js';
import { policy, NOW, WORKSPACE } from './decision-fixture.ts';
const [dir, id, receiptId, mode, own] = process.argv.slice(2);
const journal = new DecisionJournal(join(dir!, 'decisions'), WORKSPACE, new ReceiptBook(join(dir!, 'receipts')));
if (mode === 'race') {
  const original = ReceiptBook.prototype.consume;
  ReceiptBook.prototype.consume = function (...args) {
    const spent = original.apply(this, args); fs.writeFileSync(join(dir!, `ready-${own}`), 'ready');
    const until = Date.now() + 10_000;
    while ((!fs.existsSync(join(dir!, 'ready-a')) || !fs.existsSync(join(dir!, 'ready-b'))) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (!fs.existsSync(join(dir!, 'ready-a')) || !fs.existsSync(join(dir!, 'ready-b'))) throw new Error('race barrier timed out');
    return spent;
  };
} else if (mode === 'before-link' || mode === 'after-link') {
  const original = fs.linkSync;
  fs.linkSync = function (a, b) {
    if (String(b).includes('/decisions/') && mode === 'before-link') process.kill(process.pid, 'SIGKILL');
    original(a, b);
    if (String(b).includes('/decisions/') && mode === 'after-link') process.kill(process.pid, 'SIGKILL');
  }; syncBuiltinESMExports();
}
try { process.stdout.write(approveForOwner(journal, id!, { policy: policy(), receiptId, now: NOW }).outcome); }
catch (e) { process.stdout.write((e as {code?:string}).code ?? 'unexpected'); process.exitCode = 2; }
