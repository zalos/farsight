// A promotion step killed by SIGKILL at one publication boundary, for the rule-lock crash tests. It files lock B
// and links it after lock A (already current), sending itself SIGKILL when `boundary` is reached during `phase`.
//
//   node --experimental-strip-types lock-publish-child.ts <trustDir> <phase: store|select> <boundary>
import { RuleLockBook } from '../../dist/service/rule-locks.js';
import { emptyLock, lockDigest } from '../../dist/rules/index.js';

const [trust, phase, boundary] = process.argv.slice(2) as [string, 'store' | 'select', string];
const a = emptyLock(new Date('2026-10-22T00:00:00Z'));
const b = emptyLock(new Date('2026-10-22T00:00:01Z'));
let current: 'store' | 'select' = 'store';
const book = new RuleLockBook(trust, { hooks: { at: at => { if (current === phase && at === boundary) process.kill(process.pid, 'SIGKILL'); } } });
const db = book.store(b);
current = 'select';
book.select(db, lockDigest(a));
process.stdout.write('done\n');
