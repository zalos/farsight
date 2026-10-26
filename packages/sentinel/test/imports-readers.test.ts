// PR 20 Stage A: the bounded file reader and the strict JSON parser under imported reports. Local scratch files only;
// nothing is fetched, decompressed or run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readImportFile } from '../dist/imports/bounded-file.js';
import { parseStrictJson } from '../dist/imports/strict-json.js';
import { IMPORT_CEILINGS, ImportBudget, ImportRefusal } from '../dist/imports/types.js';

const scratch = (t: any) => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-imports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const refusedWith = (code: string) => (e: unknown) => e instanceof ImportRefusal && e.code === code;
const json = (s: string | Uint8Array, limits = {}) =>
  parseStrictJson(typeof s === 'string' ? Buffer.from(s) : s, new ImportBudget(limits));

test('a regular file within the limit is read whole', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'r.json'), '{"a":1}');
  assert.equal(readImportFile(join(dir, 'r.json'), 64, new ImportBudget()).toString(), '{"a":1}');
});

test('the reader refuses links, hard links, FIFOs, folders, relative paths, oversize and archives before parsing', (t) => {
  const dir = scratch(t);
  const file = join(dir, 'r.json');
  writeFileSync(file, '{"a":1}');
  symlinkSync(file, join(dir, 'link.json'));
  assert.throws(
    () => readImportFile(join(dir, 'link.json'), 64, new ImportBudget()),
    refusedWith('sentinel.import.linkRefused'),
  );
  linkSync(file, join(dir, 'hard.json'));
  assert.throws(() => readImportFile(file, 64, new ImportBudget()), refusedWith('sentinel.import.hardLinkRefused'));
  rmSync(join(dir, 'hard.json'));
  execFileSync('mkfifo', [join(dir, 'pipe')]);
  assert.throws(
    () => readImportFile(join(dir, 'pipe'), 64, new ImportBudget()),
    refusedWith('sentinel.import.notRegularFile'),
  );
  mkdirSync(join(dir, 'folder'));
  assert.throws(
    () => readImportFile(join(dir, 'folder'), 64, new ImportBudget()),
    refusedWith('sentinel.import.notRegularFile'),
  );
  assert.throws(() => readImportFile('r.json', 64, new ImportBudget()), refusedWith('sentinel.import.fileUnreadable'));
  assert.throws(
    () => readImportFile(join(dir, 'missing.json'), 64, new ImportBudget()),
    refusedWith('sentinel.import.fileUnreadable'),
  );
  assert.throws(() => readImportFile(file, 6, new ImportBudget()), refusedWith('sentinel.import.tooLarge'));
  assert.equal(readImportFile(file, 7, new ImportBudget()).length, 7, 'exactly at the limit is read');
  writeFileSync(join(dir, 'r.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
  assert.throws(
    () => readImportFile(join(dir, 'r.gz'), 64, new ImportBudget()),
    refusedWith('sentinel.import.archiveUnsupported'),
  );
  writeFileSync(join(dir, 'r.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]));
  assert.throws(
    () => readImportFile(join(dir, 'r.zip'), 64, new ImportBudget()),
    refusedWith('sentinel.import.archiveUnsupported'),
  );
});

test('a folder link in the path is resolved once to its canonical folder, then every folder is checked', (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'real'));
  writeFileSync(join(dir, 'real', 'r.json'), '{}');
  symlinkSync(join(dir, 'real'), join(dir, 'alias'));
  assert.equal(readImportFile(join(dir, 'alias', 'r.json'), 64, new ImportBudget()).toString(), '{}');
});

test('a file that grows while it is read is refused, never returned short', (t) => {
  const dir = scratch(t);
  const file = join(dir, 'grow.json');
  writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 0x20));
  let calls = 0;
  const clock = () => {
    if (++calls === 4) appendFileSync(file, ' ');
    return 0n;
  };
  assert.throws(
    () => readImportFile(file, 8 * 1024 * 1024, new ImportBudget({}, clock)),
    refusedWith('sentinel.import.fileChanged'),
  );
});

test('the shared deadline refuses a read that overruns it', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'r.json'), Buffer.alloc(3 * 1024 * 1024, 0x20));
  let now = 0n;
  const clock = () => (now += 4_000_000_000n);
  assert.throws(
    () => readImportFile(join(dir, 'r.json'), 8 * 1024 * 1024, new ImportBudget({}, clock)),
    refusedWith('sentinel.import.deadlineExceeded'),
  );
});

test('limits may be lowered but never raised past the ceilings', () => {
  const b = new ImportBudget({ rawBytes: 10 * IMPORT_CEILINGS.rawBytes, claims: 3 });
  assert.equal(b.limits.rawBytes, IMPORT_CEILINGS.rawBytes);
  assert.equal(b.limits.claims, 3);
  assert.throws(() => new ImportBudget({ rawBytes: -1 }), ImportRefusal);
  assert.throws(() => new ImportBudget({ unknownKnob: 1 } as any), ImportRefusal);
});

test('strict JSON refuses what JSON.parse would quietly accept or guess', () => {
  assert.throws(() => json('{"a":1,"a":2}'), refusedWith('sentinel.import.jsonDuplicateKey'));
  assert.throws(
    () => json('{"a":{"b":1,"b":1}}'),
    (e: any) => e.code === 'sentinel.import.jsonDuplicateKey' && e.pointer === '/0/1',
  );
  assert.throws(() => json('{"a":1} x'), refusedWith('sentinel.import.jsonMalformed'));
  assert.throws(() => json('"\\ud800"'), refusedWith('sentinel.import.jsonMalformed'));
  assert.throws(() => json('"\\udc00\\ud800"'), refusedWith('sentinel.import.jsonMalformed'));
  assert.throws(() => json('"a\u0001b"'), refusedWith('sentinel.import.jsonMalformed'));
  assert.throws(() => json('1e400'), refusedWith('sentinel.import.jsonMalformed'));
  assert.throws(() => json('01'), refusedWith('sentinel.import.jsonMalformed'));
  assert.throws(() => json('[1,]'), refusedWith('sentinel.import.jsonMalformed'));
  assert.throws(() => json(Buffer.from([0x22, 0xff, 0x22])), refusedWith('sentinel.import.invalidUtf8'));
  assert.throws(() => json('['.repeat(66) + ']'.repeat(66)), refusedWith('sentinel.import.jsonTooDeep'));
  assert.equal(json('['.repeat(64) + ']'.repeat(64)).byteOrderMark, false, 'depth 64 is read');
});

test('one leading byte-order mark is removed and recorded; a second is ordinary invalid JSON', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const r = json(Buffer.concat([bom, Buffer.from('{"a":"\\u00e9"}')]));
  assert.equal(r.byteOrderMark, true);
  assert.deepEqual({ ...(r.value as object) }, { a: 'é' });
  assert.throws(() => json(Buffer.concat([bom, bom, Buffer.from('{}')])), refusedWith('sentinel.import.jsonMalformed'));
  assert.throws(
    () => json(Buffer.concat([Buffer.from('{"a":'), bom, Buffer.from('1}')])),
    refusedWith('sentinel.import.jsonMalformed'),
  );
});

test('__proto__ is an ordinary member and pairs decode', () => {
  const v: any = json('{"__proto__":{"x":1},"s":"\\ud83d\\ude00"}').value;
  assert.equal(Object.getPrototypeOf(v), null);
  assert.equal(v.__proto__.x, 1);
  assert.equal(v.s, '😀');
});

test('global JSON budgets refuse many small values, wide objects and long strings', () => {
  assert.throws(
    () => json(`[${'0,'.repeat(99)}0]`, { jsonValues: 100 }),
    refusedWith('sentinel.import.budgetExhausted'),
  );
  assert.equal((json(`[${'0,'.repeat(98)}0]`, { jsonValues: 100 }).value as unknown[]).length, 99);
  const wide = `{${Array.from({ length: 11 }, (_, i) => `"k${i}":0`).join(',')}}`;
  assert.throws(() => json(wide, { objectMembers: 10 }), refusedWith('sentinel.import.budgetExhausted'));
  assert.throws(
    () => json(`"${'x'.repeat(1001)}"`, { stringBytes: 1000 }),
    refusedWith('sentinel.import.budgetExhausted'),
  );
  assert.throws(
    () => json(`["${'x'.repeat(600)}","${'x'.repeat(600)}"]`, { decodedStringBytes: 1000 }),
    refusedWith('sentinel.import.budgetExhausted'),
  );
  assert.throws(() => json(`[${'1,'.repeat(5000)}1]`, { work: 1000 }), refusedWith('sentinel.import.budgetExhausted'));
});

test('the deadline is read inside a long string scan, not only between values', () => {
  let n = 0n;
  const clock = () => (n += 1_000_000_000n);
  assert.throws(
    () => parseStrictJson(Buffer.from(`"${'x'.repeat(4 * 1024 * 1024)}"`), new ImportBudget({}, clock)),
    refusedWith('sentinel.import.deadlineExceeded'),
  );
});
