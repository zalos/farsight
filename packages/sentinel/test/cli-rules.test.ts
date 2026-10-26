// The owner's rule lock through the command line: `rules promote` validates a pack folder with E's validatePack,
// waits for the owner, and with --confirm promotes it with E's promote under a receipt for exactly that candidate
// against exactly the current lock revision. Revisions are filed once under their digests in the owner's private
// state; the current pointer moves only from the revision it was read at. Synthetic pack, no scanner, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleLockBook } from '../dist/service/rule-locks.js';
import { emptyLock } from '../dist/rules/index.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const rule = (familyId: string) => ({
  familyId,
  revision: 1,
  titleKey: 'sentinel.rule.fixture',
  applicability: { languages: ['typescript', 'javascript'], scopeKind: 'source-file' },
  requires: ['source-bytes', 'pattern-match'],
  implementation: { adapterId: 'sentinel-pattern', rulePath: `detectors/${familyId}.yml` },
  meaning: 'candidate',
  severity: 'high',
  evidenceRequired: ['source-span'],
  limitationKeys: [],
  mappings: { cwe: ['CWE-95'] },
  fixtures: { positive: [`fixtures/${familyId}-bad.ts`], negative: [`fixtures/${familyId}-good.ts`] },
});

function writePack(dir: string, version: string, families: string[]) {
  const rules = families.map(rule);
  const files: Record<string, string> = {
    'sentinel-pack.json': JSON.stringify({
      schema: 'sentinel-rulepack/draft-1',
      packId: 'fixture-pack',
      version,
      rights: { spdx: 'MIT', origin: 'sentinel-original' },
      rules,
    }),
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

test('rules promote: the owner confirms one candidate against one lock revision; revisions are kept, the pointer moves once', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-rules-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const env = { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  mkdirSync(env.HOME);
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--json'], {
      cwd: ws,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    let body: any;
    try {
      body = JSON.parse(r.stdout);
    } catch {
      body = r.stdout;
    }
    return { status: r.status, body, stderr: r.stderr };
  };
  const pack = join(dir, 'pack');
  writePack(pack, '0.1.0', ['sentinel.ts.eval']);

  run('init');
  assert.equal(
    run('rules', 'promote', pack).body.reasonCode,
    'sentinel.service.settingsNotAdopted',
    'nothing is promoted under settings nobody adopted',
  );
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
  assert.match(first.body.facts.receipt, /^sha256:/, "spent by the owner's receipt");
  const shown = run('rules', 'show').body.facts;
  assert.deepEqual(
    [shown.lock, shown.revision, shown.packs],
    [first.body.facts.lock, 2, [{ packId: 'fixture-pack', version: '0.1.0', rules: ['sentinel.ts.eval'] }]],
  );

  // A second promotion builds on the first: its candidate is confirmed against revision 2, and both are kept.
  writePack(pack, '0.2.0', ['sentinel.ts.eval', 'sentinel.ts.dangerous-call']);
  const second = run('rules', 'promote', pack, '--confirm');
  assert.deepEqual(
    [second.status, second.body.facts.previousLock, second.body.facts.revision],
    [0, first.body.facts.lock, 3],
  );
  const trust = join(env.XDG_STATE_HOME, 'farsight', 'sentinel', 'trust', 'rules');
  const revisions = readdirSync(join(trust, 'locks')).sort();
  assert.equal(revisions.length, 3, 'the empty lock, revision 2 and revision 3 are each filed once');
  for (const f of revisions) assert.equal(statSync(join(trust, 'locks', f)).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(readFileSync(join(trust, 'first'), 'utf8')).digest,
    first.body.facts.previousLock,
    'the chain starts at the empty lock',
  );
  assert.equal(
    JSON.parse(readFileSync(join(trust, 'next', `${String(first.body.facts.lock).slice(7)}.json`), 'utf8')).digest,
    second.body.facts.lock,
  );

  // Promoting what the current revision already locks is kept: no receipt, no new revision, no new file.
  writePack(pack, '0.2.0', ['sentinel.ts.eval', 'sentinel.ts.dangerous-call']);
  const again = run('rules', 'promote', pack, '--confirm');
  assert.deepEqual(
    [again.status, again.body.outcome, again.body.facts.lock, again.body.facts.revision],
    [0, 'kept', second.body.facts.lock, 3],
  );
  assert.equal(readdirSync(join(trust, 'locks')).length, 3);

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

test('the current pointer moves only from the revision it was read at', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-lockbook-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const book = new RuleLockBook(join(dir, 'trust'));
  const a = emptyLock(new Date('2026-10-22T00:00:00Z'));
  const b = emptyLock(new Date('2026-10-22T00:00:01Z'));
  const c = emptyLock(new Date('2026-10-22T00:00:02Z'));
  const da = book.store(a);
  const db = book.store(b);
  const dc = book.store(c);
  assert.equal(book.store(a), da, 'storing a revision again is the same file');
  book.select(da, null);
  assert.throws(
    () => book.select(db, null),
    (e: any) => e.code === 'sentinel.service.lockChanged',
    'a stale expectation is refused',
  );
  book.select(db, da);
  assert.equal(book.current()?.digest, db);
  assert.throws(
    () => book.select(dc, da),
    (e: any) => e.code === 'sentinel.service.lockChanged',
    'a revision already succeeded cannot be succeeded again',
  );
  book.select(dc, db);
  assert.equal(book.current()?.digest, dc);
  assert.throws(
    () => book.select(`sha256:${'0'.repeat(64)}`, db),
    (e: any) => e.code === 'sentinel.service.recordUnsafe',
    'only a filed revision can be selected',
  );
});

test('the built-in foundation-preview pack validates, its detector flags exactly its positive fixtures, and the owner promotes it', async (t) => {
  const { builtinPackDir } = await import('../dist/service/package-paths.js');
  const { readPackDirectory, validatePack } = await import('../dist/rules/index.js');
  const { detect, PREVIEW_RULE } = await import('../dist/adapters/preview-detector.js');
  const packDir = realpathSync.native(builtinPackDir('foundation-preview')!);
  assert.equal(builtinPackDir('anything-else'), undefined);
  const files = readPackDirectory(packDir);
  const pack = validatePack(files);
  assert.equal(pack.entry.packId, 'sentinel-foundation-preview');
  const [definition] = JSON.parse(files.get('sentinel-pack.json')!.toString('utf8')).rules;
  assert.equal(definition.familyId, PREVIEW_RULE, 'the detector implements the rule the pack declares');
  assert.equal(definition.implementation.adapterId, 'sentinel.preview.detector');
  for (const f of definition.fixtures.positive) {
    const text = files.get(f)!.toString('utf8');
    const hits = detect(f, text, 'sha256:x');
    assert.ok(hits.length > 0 && hits.every((h) => h.rule === PREVIEW_RULE), `${f} is flagged`);
    assert.equal(
      hits.length,
      text.split('\n').filter((l) => /SELECT|DELETE/.test(l)).length,
      `${f}: every positive line`,
    );
  }
  for (const f of definition.fixtures.negative)
    assert.deepEqual(detect(f, files.get(f)!.toString('utf8'), 'sha256:x'), [], `${f} is not flagged`);

  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-builtin-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const env = { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  mkdirSync(env.HOME);
  const run = (...args: string[]) =>
    JSON.parse(
      spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: ws, env, encoding: 'utf8', timeout: 60_000 }).stdout,
    );
  run('init');
  run('settings', 'adopt', '--confirm');
  assert.equal(run('rules', 'promote', 'builtin:unknown').reasonCode, 'sentinel.args.unexpectedArgument');
  const promoted = run('rules', 'promote', 'builtin:foundation-preview', '--confirm');
  assert.deepEqual([promoted.outcome, promoted.facts.rules], ['prepared', [PREVIEW_RULE]]);
  assert.deepEqual(run('rules', 'show').facts.packs, [
    { packId: 'sentinel-foundation-preview', version: '0.1.0', rules: [PREVIEW_RULE] },
  ]);
});

test('promotions racing from one revision: exactly one succeeds each revision, the rest are refused, nothing is lost', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-race-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const env = { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  mkdirSync(env.HOME);
  const sync = (...args: string[]) =>
    JSON.parse(
      spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: ws, env, encoding: 'utf8', timeout: 60_000 }).stdout,
    );
  sync('init');
  sync('settings', 'adopt', '--confirm');
  const N = 6;
  const packs = Array.from({ length: N }, (_, i) => {
    const p = join(dir, `pack-${i}`);
    writePack(p, `0.${i + 1}.0`, ['sentinel.ts.eval']);
    return p;
  });
  return new Promise<void>((resolve, reject) => {
    let left = N;
    const bodies: any[] = [];
    for (const p of packs) {
      const child = spawn(process.execPath, [CLI, 'rules', 'promote', p, '--confirm', '--json'], { cwd: ws, env });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.on('close', () => {
        try {
          bodies.push(JSON.parse(out));
        } catch (e) {
          reject(e);
          return;
        }
        if (--left > 0) return;
        try {
          const won = bodies.filter((b) => b.outcome === 'prepared');
          const lost = bodies.filter((b) => b.outcome !== 'prepared');
          assert.ok(won.length >= 1);
          for (const b of lost) assert.equal(b.reasonCode, 'sentinel.service.lockChanged', JSON.stringify(b));
          // Every success is one link of a single chain: distinct predecessors, revisions 2.., the last one current.
          assert.equal(
            new Set(won.map((b) => b.facts.previousLock)).size,
            won.length,
            'no two promotions succeeded the same revision',
          );
          const shown = sync('rules', 'show').facts;
          assert.equal(shown.revision, 1 + won.length, 'no promotion was lost');
          assert.ok(won.some((b) => b.facts.lock === shown.lock));
          const book = new RuleLockBook(join(env.XDG_STATE_HOME, 'farsight', 'sentinel', 'trust'));
          let digest = book.current()!.digest;
          const chain = [digest];
          for (let lock = book.read(digest); lock.previous; lock = book.read(lock.previous)) chain.push(lock.previous);
          assert.equal(
            chain.length,
            1 + won.length,
            'the current revision reaches the empty lock through every success',
          );
          for (const b of won) assert.ok(chain.includes(b.facts.lock));
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }
  });
});

// ---- publication boundaries: a reader, a failure or a crash never meets a partial record ----

const PUBLISH_CHILD = fileURLToPath(new URL('./helpers/lock-publish-child.ts', import.meta.url));
const lockA = () => emptyLock(new Date('2026-10-22T00:00:00Z'));
const lockB = () => emptyLock(new Date('2026-10-22T00:00:01Z'));

function trustWithA(t: { after(fn: () => void): void }) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-publish-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trust = join(dir, 'trust');
  const book = new RuleLockBook(trust);
  const da = book.store(lockA());
  book.select(da, null);
  return { trust, da };
}

test('while a link is being published, readers see the previous revision whole; the record appears only complete', (t) => {
  const { trust, da } = trustWithA(t);
  const reader = new RuleLockBook(trust);
  const seen: string[] = [];
  const book = new RuleLockBook(trust, {
    hooks: {
      at: (at, name) => {
        if (name.endsWith('.json') && name !== `${da.slice(7)}.json`) return; // only the link after A
        if (at === 'temp-opened' || at === 'temp-written')
          seen.push(`${at}:${reader.current()!.digest === da ? 'A' : 'other'}`);
        if (at === 'linked') seen.push(`${at}:${reader.current()!.digest === da ? 'A' : 'B'}`);
      },
    },
  });
  const db = book.store(lockB());
  book.select(db, da);
  assert.deepEqual(
    seen,
    ['temp-opened:A', 'temp-written:A', 'linked:B'],
    'before the link the chain ends at A; from it, at B',
  );
  assert.deepEqual(
    readdirSync(join(trust, 'rules', 'next')).filter((n) => n.startsWith('.')),
    [],
    'no temporary name is left',
  );
});

test('a failure while writing a record leaves nothing at its name, and the chain stays usable', (t) => {
  const { trust, da } = trustWithA(t);
  const eio = Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
  for (const boundary of ['temp-opened', 'temp-written'] as const) {
    const failing = new RuleLockBook(trust, {
      hooks: {
        at: (at, name) => {
          if (at === boundary && name === `${da.slice(7)}.json`) throw eio;
        },
      },
    });
    const db = failing.store(lockB());
    assert.throws(() => failing.select(db, da), /EIO/);
    const reader = new RuleLockBook(trust);
    assert.equal(reader.current()!.digest, da, `${boundary}: the chain still ends at A`);
    assert.equal(
      existsSync(join(trust, 'rules', 'next', `${da.slice(7)}.json`)),
      false,
      `${boundary}: no record at the final name`,
    );
    assert.deepEqual(
      readdirSync(join(trust, 'rules', 'next')).filter((n) => n.startsWith('.')),
      [],
      `${boundary}: the temporary name was removed`,
    );
  }
  const book = new RuleLockBook(trust);
  book.select(book.store(lockB()), da);
  assert.notEqual(book.current()!.digest, da, 'the same promotion succeeds afterwards');
});

for (const phase of ['store', 'select'] as const) {
  for (const boundary of ['temp-opened', 'temp-written', 'linked', 'temp-removed'] as const) {
    test(`SIGKILL during ${phase} at ${boundary}: the chain is whole and the promotion can still complete`, (t) => {
      const { trust, da } = trustWithA(t);
      const r = spawnSync(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', PUBLISH_CHILD, trust, phase, boundary],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(r.signal, 'SIGKILL', r.stderr);
      const book = new RuleLockBook(trust);
      const current = book.current()!.digest;
      const db = book.store(lockB()); // the revision, whole: filed now or already, never half
      const linkedB = phase === 'select' && (boundary === 'linked' || boundary === 'temp-removed');
      assert.equal(current, linkedB ? db : da, 'the chain ends at a complete record');
      if (!linkedB) book.select(db, da);
      else
        assert.throws(
          () => book.select(db, da),
          (e: any) => e.code === 'sentinel.service.lockChanged',
        );
      assert.equal(new RuleLockBook(trust).current()!.digest, db);
    });
  }
}

test('readers running beside racing promotions never meet a partial record', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-readers-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const env = { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  mkdirSync(env.HOME);
  const sync = (...args: string[]) =>
    JSON.parse(
      spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: ws, env, encoding: 'utf8', timeout: 60_000 }).stdout,
    );
  sync('init');
  sync('settings', 'adopt', '--confirm');
  const packs = Array.from({ length: 6 }, (_, i) => {
    const p = join(dir, `pack-${i}`);
    writePack(p, `0.${i + 1}.0`, ['sentinel.ts.eval']);
    return p;
  });
  const trust = join(env.XDG_STATE_HOME, 'farsight', 'sentinel', 'trust');
  return new Promise<void>((resolve, reject) => {
    let left = packs.length;
    let reads = 0;
    const failures: string[] = [];
    const reader = new RuleLockBook(trust);
    const poll = setInterval(() => {
      try {
        reader.current();
        reads++;
      } catch (e: any) {
        failures.push(e.code ?? String(e));
      }
    }, 1);
    for (const p of packs) {
      const child = spawn(process.execPath, [CLI, 'rules', 'promote', p, '--confirm', '--json'], { cwd: ws, env });
      child.stdout.resume();
      child.on('close', () => {
        if (--left > 0) return;
        clearInterval(poll);
        try {
          assert.deepEqual(failures, [], 'no read met a partial or missing record');
          assert.ok(reads > 10, `the reader actually ran (${reads} reads)`);
          assert.equal(reader.current()!.lock.revision, sync('rules', 'show').facts.revision);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }
  });
});

test("only the writer's own temporary alias of the same record is removed; any other second name is refused", async (t) => {
  const { linkSync, writeFileSync: write } = await import('node:fs');
  const { trust, da } = trustWithA(t);
  const revisions = join(trust, 'rules', 'locks');
  const record = join(revisions, `${da.slice(7)}.json`);
  // A temporary-pattern name for a different file is left alone.
  const decoy = join(revisions, `.${da.slice(7)}.json.${'0'.repeat(16)}.tmp`);
  write(decoy, 'unrelated', { mode: 0o600 });
  // A second, foreign name for the record itself is refused, never removed.
  linkSync(record, join(revisions, 'elsewhere.json'));
  assert.throws(
    () => new RuleLockBook(trust).current(),
    (e: any) => e.code === 'sentinel.service.recordUnsafe',
  );
  assert.ok(existsSync(join(revisions, 'elsewhere.json')) && existsSync(decoy));
  rmSync(join(revisions, 'elsewhere.json'));
  // The writer's own alias (as a crash between link and unlink leaves it) is removed and the record read.
  linkSync(record, join(revisions, `.${da.slice(7)}.json.${'a'.repeat(16)}.tmp`));
  assert.equal(new RuleLockBook(trust).current()!.digest, da);
  assert.equal(existsSync(join(revisions, `.${da.slice(7)}.json.${'a'.repeat(16)}.tmp`)), false);
  assert.ok(existsSync(decoy), 'the unrelated file is untouched');
});

test('every folder a record is published into is synced into its parent when created, and every record before its link', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-durable-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originals = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync };
  const paths = new Map<number, string>();
  const synced: string[] = [];
  (fs as any).openSync = function (p: unknown, ...rest: unknown[]) {
    const fd = (originals.open as any).call(this, p, ...rest);
    paths.set(fd, String(p));
    return fd;
  };
  (fs as any).closeSync = function (fd: number) {
    paths.delete(fd);
    return originals.close.call(this, fd);
  };
  (fs as any).fsyncSync = function (fd: number) {
    synced.push(paths.get(fd)!);
    return originals.sync.call(this, fd);
  };
  syncBuiltinESMExports();
  try {
    const trust = join(root, 'trust');
    const book = new RuleLockBook(trust);
    const da = book.store(lockA());
    book.select(da, null);
    book.select(book.store(lockB()), da);
    for (const dir of [
      root,
      trust,
      join(trust, 'rules'),
      join(trust, 'rules', 'locks'),
      join(trust, 'rules', 'next'),
    ]) {
      assert.ok(synced.includes(dir), `${dir} was synced`);
    }
    assert.ok(
      synced.some((p) => /\/locks\/\.[0-9a-f]{64}\.json\.[0-9a-f]{16}\.tmp$/.test(p)),
      'a revision is synced under its temporary name',
    );
    assert.ok(
      synced.some((p) => /\/next\/\.[0-9a-f]{64}\.json\.[0-9a-f]{16}\.tmp$/.test(p)),
      'a link is synced under its temporary name',
    );
  } finally {
    Object.assign(fs, { openSync: originals.open, closeSync: originals.close, fsyncSync: originals.sync });
    syncBuiltinESMExports();
  }
});

test('a parent sync that failed after a folder was created is repeated by the next promotion, never skipped', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-resync-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trust = join(root, 'trust');
  mkdirSync(trust, { mode: 0o700 });
  const originals = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync };
  const paths = new Map<number, string>();
  const synced: string[] = [];
  let failOnce = true;
  (fs as any).openSync = function (p: unknown, ...rest: unknown[]) {
    const fd = (originals.open as any).call(this, p, ...rest);
    paths.set(fd, String(p));
    return fd;
  };
  (fs as any).closeSync = function (fd: number) {
    paths.delete(fd);
    return originals.close.call(this, fd);
  };
  (fs as any).fsyncSync = function (fd: number) {
    const p = paths.get(fd)!;
    // The sync that makes the new `rules` folder's entry durable fails once, after the folder was created.
    if (p === trust && failOnce) {
      failOnce = false;
      throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    }
    synced.push(p);
    return originals.sync.call(this, fd);
  };
  syncBuiltinESMExports();
  try {
    const book = new RuleLockBook(trust);
    assert.throws(() => book.store(lockA()), /EIO/);
    assert.ok(existsSync(join(trust, 'rules')), 'the folder was created before its parent sync failed');
    assert.ok(!synced.includes(trust));
    const da = book.store(lockA());
    assert.ok(synced.includes(trust), 'the retry synced the parent the failure left unsynced');
    book.select(da, null);
    assert.equal(new RuleLockBook(trust).current()!.digest, da);
  } finally {
    Object.assign(fs, { openSync: originals.open, closeSync: originals.close, fsyncSync: originals.sync });
    syncBuiltinESMExports();
  }
});
