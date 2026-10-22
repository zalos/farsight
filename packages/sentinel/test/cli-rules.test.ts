// The owner's rule lock through the command line: `rules promote` validates a pack folder with E's validatePack,
// waits for the owner, and with --confirm promotes it with E's promote under a receipt for exactly that candidate
// against exactly the current lock revision. Revisions are filed once under their digests in the owner's private
// state; the current pointer moves only from the revision it was read at. Synthetic pack, no scanner, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleLockBook } from '../dist/service/rule-locks.js';
import { emptyLock } from '../dist/rules/index.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const rule = (familyId: string) => ({
  familyId, revision: 1, titleKey: 'sentinel.rule.fixture',
  applicability: { languages: ['typescript', 'javascript'], scopeKind: 'source-file' },
  requires: ['source-bytes', 'pattern-match'], implementation: { adapterId: 'sentinel-pattern', rulePath: `detectors/${familyId}.yml` },
  meaning: 'candidate', severity: 'high', evidenceRequired: ['source-span'], limitationKeys: [], mappings: { cwe: ['CWE-95'] },
  fixtures: { positive: [`fixtures/${familyId}-bad.ts`], negative: [`fixtures/${familyId}-good.ts`] },
});

function writePack(dir: string, version: string, families: string[]) {
  const rules = families.map(rule);
  const files: Record<string, string> = {
    'sentinel-pack.json': JSON.stringify({ schema: 'sentinel-rulepack/draft-1', packId: 'fixture-pack', version, rights: { spdx: 'MIT', origin: 'sentinel-original' }, rules }),
  };
  for (const r of rules) {
    files[r.implementation.rulePath] = `rule: ${r.familyId}\n`;
    for (const f of [...r.fixtures.positive, ...r.fixtures.negative]) files[f] = `// ${f}\n`;
  }
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

test('rules promote: the owner confirms one candidate against one lock revision; revisions are kept, the pointer moves once', t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-rules-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const env = { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  mkdirSync(env.HOME);
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: ws, env, encoding: 'utf8', timeout: 60_000 });
    let body: any;
    try { body = JSON.parse(r.stdout); } catch { body = r.stdout; }
    return { status: r.status, body, stderr: r.stderr };
  };
  const pack = join(dir, 'pack');
  writePack(pack, '0.1.0', ['sentinel.ts.eval']);

  run('init');
  assert.equal(run('rules', 'promote', pack).body.reasonCode, 'sentinel.service.settingsNotAdopted', 'nothing is promoted under settings nobody adopted');
  run('settings', 'adopt', '--confirm');
  assert.deepEqual(run('rules', 'show').body.facts, { lock: null, packs: [] });

  const preview = run('rules', 'promote', pack);
  assert.deepEqual([preview.status, preview.body.outcome], [4, 'awaiting-confirmation'], preview.stderr);
  assert.deepEqual(preview.body.facts.rules, ['sentinel.ts.eval']);
  assert.match(preview.body.facts.candidate, /^sha256:/);
  assert.equal(preview.body.facts.previousRevision, 1);
  assert.deepEqual(run('rules', 'show').body.facts.lock, null, 'waiting changed nothing');

  const first = run('rules', 'promote', pack, '--confirm');
  assert.deepEqual([first.status, first.body.outcome, first.body.facts.revision], [0, 'prepared', 2], first.stderr);
  assert.equal(first.body.facts.candidate, preview.body.facts.candidate, 'the same bytes are the same candidate');
  assert.match(first.body.facts.receipt, /^sha256:/, 'spent by the owner\'s receipt');
  const shown = run('rules', 'show').body.facts;
  assert.deepEqual([shown.lock, shown.revision, shown.packs], [first.body.facts.lock, 2, [{ packId: 'fixture-pack', version: '0.1.0', rules: ['sentinel.ts.eval'] }]]);

  // A second promotion builds on the first: its candidate is confirmed against revision 2, and both are kept.
  writePack(pack, '0.2.0', ['sentinel.ts.eval', 'sentinel.ts.dangerous-call']);
  const second = run('rules', 'promote', pack, '--confirm');
  assert.deepEqual([second.status, second.body.facts.previousLock, second.body.facts.revision], [0, first.body.facts.lock, 3]);
  const trust = join(env.XDG_STATE_HOME, 'farsight', 'sentinel', 'trust', 'rules');
  const revisions = readdirSync(join(trust, 'locks')).sort();
  assert.equal(revisions.length, 3, 'the empty lock, revision 2 and revision 3 are each filed once');
  for (const f of revisions) assert.equal(statSync(join(trust, 'locks', f)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(trust, 'current.json'), 'utf8')).digest, second.body.facts.lock);

  // A revision whose bytes no longer match its digest is refused, never used.
  const name = `${String(second.body.facts.lock).slice(7)}.json`;
  const original = readFileSync(join(trust, 'locks', name), 'utf8');
  writeFileSync(join(trust, 'locks', name), original.replace('0.2.0', '9.9.9'));
  assert.equal(run('rules', 'show').body.reasonCode, 'sentinel.rules.lockInvalid');
  writeFileSync(join(trust, 'locks', name), original);
  assert.equal(run('rules', 'show').body.facts.revision, 3);

  // A pack the validator refuses never reaches the owner's confirmation.
  writeFileSync(join(pack, 'sentinel-pack.json'), '{ not json');
  assert.match(run('rules', 'promote', pack, '--confirm').body.reasonCode, /^sentinel\.rules\./);
  assert.equal(run('rules', 'show').body.facts.revision, 3);
  assert.equal(run('rules', 'promote').status, 3, 'promote names a pack folder');
});

test('the current pointer moves only from the revision it was read at', t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-lockbook-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const book = new RuleLockBook(join(dir, 'trust'));
  const a = emptyLock(new Date('2026-10-22T00:00:00Z'));
  const b = emptyLock(new Date('2026-10-22T00:00:01Z'));
  const da = book.store(a);
  const db = book.store(b);
  assert.equal(book.store(a), da, 'storing a revision again is the same file');
  book.select(da, null);
  assert.throws(() => book.select(db, null), (e: any) => e.code === 'sentinel.service.lockChanged', 'a stale expectation is refused');
  book.select(db, da);
  assert.equal(book.current()?.digest, db);
  assert.throws(() => book.select(`sha256:${'0'.repeat(64)}`, db), (e: any) => e.code === 'sentinel.service.recordUnsafe', 'only a filed revision can be selected');
});
