/**
 * `farsight history` driven the way a consumer drives it: the built `dist/cli.js`
 * against temporary repositories and temporary snapshot databases.
 *
 * Nothing here touches the workspace graph, `examples/**`, or any real store — the
 * command writes to a `.farsight/farsight.db` inside a temp directory, and every
 * repository it reads is one `git init` made here.
 *
 * What the suite is really guarding is the honesty rules of
 * docs/proposals/change-history-2026-09.md: an absence says *which* absence it is,
 * a commit no sync ingested says *not indexed* before the spine is drawn, a number
 * the data does not carry is never printed, and the command touches no node or edge
 * row of the database it writes history into.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/cli.js');

let work: string;
let app: string;
/** sha by the commit's file marker, filled as the fixture is built. */
const sha: Record<string, string> = {};

function run(args: string[], cwd = work) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function git(dir: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/** A repository whose author dates are fixed, so "newest first" is not a race. */
function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Fixture']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
}

/** Commit whatever is staged with a fixed author *and* committer time. */
function commit(dir: string, subject: string, when: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', subject], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  return git(dir, ['rev-parse', 'HEAD']);
}

function db(path: string) {
  return new DatabaseSync(path, { readOnly: true });
}

/** Row counts of one database, so "history wrote only history" is a measurement. */
function counts(path: string): Record<string, number> {
  const d = db(path);
  const out: Record<string, number> = {};
  for (const t of ['node', 'edge', 'snapshot', 'snapshot_source', 'blind_spot', 'commit', 'commit_file', 'commit_sync', 'release']) {
    try {
      out[t] = (d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    } catch {
      out[t] = -1; // the table does not exist yet — distinct from "exists and is empty"
    }
  }
  d.close();
  return out;
}

function historyJson(args: string[], cwd = work) {
  const r = run(['history', ...args, '--json'], cwd);
  assert.equal(r.status, 0, r.err);
  return JSON.parse(r.out) as { generatedAt: string; max: number; repos: Record<string, any>[] };
}

before(() => {
  // realpath: macOS /tmp is a symlink and the CLI compares resolved paths
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-history-')));
  app = join(work, 'app');
  initRepo(app);
  mkdirSync(join(app, 'src'), { recursive: true });

  writeFileSync(join(app, 'src/a.ts'), 'export function alpha() { return 1; }\n');
  sha.c1 = commit(app, 'first: alpha', '2026-01-01T00:00:00Z');

  writeFileSync(join(app, 'src/a.ts'), 'export function alpha() { return 2; }\n');
  writeFileSync(join(app, 'src/b.ts'), 'export function beta() { return alpha(); }\n');
  sha.c2 = commit(app, 'second: beta beside alpha', '2026-01-02T00:00:00Z');

  // sync 1 records c2 — everything before it is outside the spine, everything after
  // it until the next ingest is a commit no sync ever read
  assert.equal(run(['ingest', app, '--repo', 'app', '--out', 'graph.json']).status, 0);

  git(app, ['mv', 'src/a.ts', 'src/c.ts']);
  // c3 and c4 deliberately share an author time: `at` is not unique, so the range
  // walk has to follow `parents` rather than order by timestamp
  sha.c3 = commit(app, 'third: alpha moves to c.ts', '2026-01-03T00:00:00Z');
  rmSync(join(app, 'src/b.ts'));
  sha.c4 = commit(app, 'fourth: beta deleted', '2026-01-03T00:00:00Z');

  writeFileSync(join(app, 'src/d.ts'), 'export function delta() { return 4; }\n');
  sha.c5 = commit(app, 'fifth: delta', '2026-01-05T00:00:00Z');

  // sync 2 records c5, so c3 and c4 are in its range but were never indexed
  assert.equal(run(['ingest', app, '--repo', 'app', '--out', 'graph.json']).status, 0);
  // sync 3 records c5 again — the re-index the spine has to name
  assert.equal(run(['ingest', app, '--repo', 'app', '--out', 'graph.json']).status, 0);
});

after(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ } });

describe('farsight history — the spine', () => {
  test('every sync carries what it swept up, and the commits nobody ingested are counted first', () => {
    const r = run(['history', '--repo', 'app']);
    assert.equal(r.status, 0, r.err);
    // the unindexed sentence precedes the table: no row below may read as a complete account
    const lines = r.out.split('\n');
    const warn = lines.findIndex((l) => l.includes('never ingested by any sync'));
    const header = lines.findIndex((l) => l.includes('SYNC  WHEN'));
    assert.ok(warn >= 0, 'the unindexed count must be stated');
    assert.ok(header > warn, 'the spine table must come after it');
    assert.match(r.out, /3 of 5 commits were never ingested by any sync/);
    assert.match(r.out, /not indexed/);
    assert.match(r.out, /3 syncs · 2 distinct commits recorded for this repository · 1 re-indexed on a newer build/);
    assert.match(r.out, /outside every sync's reach: 1 before the oldest sync's commit/);
    // the re-indexed row is named, not left looking like a sync that saw nothing
    assert.match(r.out, /re-indexed on a newer build — no new commits/);
  });

  test('the JSON carries the same facts, and swept is null where the data carries no number', () => {
    const doc = historyJson(['--repo', 'app']);
    assert.equal(doc.repos.length, 1);
    const d = doc.repos[0]!;
    assert.equal(d.repo, 'app');
    assert.deepEqual(d.git, { available: true, read: 5, truncated: false, max: 2000 });
    assert.equal(d.shallow, false);
    assert.equal(d.head.ref, 'main');
    assert.equal(d.head.detached, false);
    assert.equal(d.commits, 5);
    assert.equal(d.unindexed, 3);
    assert.equal(d.syncs, 3);
    assert.equal(d.distinct, 2);
    assert.equal(d.reindexed, 1);
    assert.equal(d.before, 1);
    assert.equal(d.after, 0);
    assert.equal(d.withoutCommit, 0, 'every sync stamped this source\'s own commit');
    assert.deepEqual(d.releases, [], 'nothing is declared, so nothing is a release');

    const spine = d.spine as { sync: number; commit?: string; commitFrom?: string; commitKnown: boolean; reindexed: boolean; swept: number | null; unindexed: number | null; commits: string[] }[];
    assert.deepEqual(spine.map((s) => s.sync), [3, 2, 1], 'newest sync first');
    // ingest recorded this source's own sha, so the spine reads it rather than the
    // workspace root's column — `commitFrom` is which of the two a row used
    assert.ok(spine.every((x) => x.commitFrom === 'source'));
    const [three, two, one] = spine as [typeof spine[0], typeof spine[0], typeof spine[0]];
    // the re-index sweeps nothing — 0 here is a measured zero, not a missing number
    assert.equal(three.reindexed, true);
    assert.deepEqual(three.commits, []);
    assert.equal(three.swept, 0);
    // sync 2's range is c5 (its own) plus the two commits nobody read; ancestry, not
    // timestamps — c3 and c4 share an author time
    assert.equal(two.commit, sha.c5);
    assert.deepEqual([...two.commits].sort(), [sha.c3, sha.c4, sha.c5].sort());
    assert.equal(two.swept, 3);
    assert.equal(two.unindexed, 2);
    // the oldest sync records exactly its own commit; c1 is `before`, not swept
    assert.deepEqual(one.commits, [sha.c2]);
    assert.equal(one.unindexed, 0);
  });

  test('a rename is stored as one file under two paths, so "the same file under a new path" is sayable', () => {
    run(['history', '--repo', 'app']);
    const d = db(join(work, '.farsight/farsight.db'));
    const rows = d.prepare('SELECT path, status, old_path, similarity FROM commit_file WHERE repo = ? AND sha = ? ORDER BY path')
      .all('app', sha.c3) as { path: string; status: string; old_path: string | null; similarity: number | null }[];
    d.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.path, 'src/c.ts');
    assert.equal(rows[0]!.status, 'renamed');
    assert.equal(rows[0]!.old_path, 'src/a.ts');
    assert.equal(rows[0]!.similarity, 100, 'a byte-identical move scores R100');
  });

  test('it writes history and nothing else, and a second run changes no row', () => {
    const path = join(work, '.farsight/farsight.db');
    const before = counts(path);
    const first = run(['history', '--repo', 'app']);
    assert.equal(first.status, 0, first.err);
    const after1 = counts(path);
    const second = run(['history', '--repo', 'app']);
    assert.equal(second.status, 0, second.err);
    assert.deepEqual(counts(path), after1, 'a re-read of the same history is idempotent');
    // the graph is untouched: history is a table beside the spine, never graph content
    assert.ok(after1.node! > 0, 'the fixture has graph rows for history to leave alone');
    for (const t of ['node', 'edge', 'snapshot', 'snapshot_source', 'blind_spot']) {
      assert.equal(after1[t], before[t], `${t} rows must not move when history is read`);
    }
    assert.equal(after1.snapshot, 3);
    assert.equal(after1.commit, 5);
    assert.equal(after1.commit_sync, 3, 'one row per sync — two of them naming the same commit');
    assert.equal(after1.release, 0, 'a release is declared; reading git never writes one');
    // and the second run reports the join as adding nothing
    assert.equal(historyJson(['--repo', 'app']).repos[0]!.written.linked, 0);
  });

  test('with no --repo it does every source the graph and the workspace know', () => {
    const doc = historyJson([]);
    assert.deepEqual(doc.repos.map((r) => r.repo), ['app']);
  });

  test('--max bounds the walk and says the ancestry below it is partial', () => {
    const r = run(['history', '--repo', 'app', '--max', '2']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /--max 2 bounded the walk — older commits exist in the repository and were not read/);
    const d = historyJson(['--repo', 'app', '--max', '2']).repos[0]!;
    assert.equal(d.git.truncated, true);
    assert.equal(d.git.read, 2);
    assert.equal(d.git.max, 2);
  });

  test('--since is honoured and recorded in the document', () => {
    // an explicit instant, not a bare `2026-01-04`: `--since` is handed to git verbatim
    // and git's approxidate reading of a bare date is its own business, not ours to guess at
    const d = historyJson(['--repo', 'app', '--since', '2026-01-04T00:00:00Z']).repos[0]!;
    assert.equal(d.git.read, 1, 'only c5 is on or after that instant');
    assert.equal(d.git.since, '2026-01-04T00:00:00Z');
    // a bounded read does not shrink the history already recorded
    assert.equal(d.commits, 5);
  });

  test('--max nonsense is a usage error, not a silent default', () => {
    const r = run(['history', '--repo', 'app', '--max', 'lots']);
    assert.equal(r.status, 1);
    assert.match(r.err, /--max expects how many commits to walk/);
  });

  test('a source no sync recorded a commit for reads absent — never the workspace root\'s sha', () => {
    // the shape every row written before the writers stamped a per-source sha is in: the
    // snapshot column names the workspace root's commits, this source's own column is null.
    // The spine must say *no commit recorded* rather than fold a sha from another repository.
    // This fixture is also the sharper case chunk H5 separated out: no sync ever *walked*
    // this source, which is a different fact from a sync that walked it and stamped nothing
    // — so the words say "did not include", and the backfill advice is not given here.
    const other = join(work, 'other');
    initRepo(other);
    writeFileSync(join(other, 'other.ts'), 'export const other = 1;\n');
    commit(other, 'unrelated history', '2026-03-01T00:00:00Z');
    const args = [other, '--repo', 'other', '--graph', join(work, 'graph.json')];
    const r = run(['history', ...args]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /not one of the 3 syncs included this repository/);
    assert.doesNotMatch(r.out, /an existing row cannot be backfilled/, 'nothing failed to be stamped, so nothing needs backfilling');
    assert.match(r.out, /0 distinct commits recorded for this repository · 3 recorded no commit for this repository \(3 did not include it at all\)/);
    assert.match(r.out, /this sync did not include this repository/);
    // and no before/after split is derived from an anchor nothing here can place
    assert.doesNotMatch(r.out, /outside every sync's reach/);
    const d = historyJson(args).repos[0]!;
    assert.equal(d.commits, 1);
    assert.equal(d.unindexed, 1);
    assert.equal(d.withoutCommit, 3);
    assert.equal(d.distinct, 0);
    assert.equal(d.notInSync, 3, 'all three absences are "the sync did not walk this source"');
    const spine = d.spine as { commit?: string; commitFrom?: string; commitKnown: boolean; swept: number | null; inSync?: boolean }[];
    // the bug this pins: these rows used to carry `app`'s shas
    assert.ok(spine.every((x) => x.commit === undefined && x.commitFrom === undefined));
    assert.ok(spine.every((x) => !x.commitKnown));
    assert.ok(spine.every((x) => x.swept === null));
    // H5's third row state: the store can tell "not in this sync" from "in it, no commit"
    assert.ok(spine.every((x) => x.inSync === false), 'every sync walked `app`, none walked `other`');
  });

  test('a repo nothing knows about is an error that names the fix', () => {
    const r = run(['history', '--repo', 'ghost']);
    assert.equal(r.status, 1);
    assert.match(r.err, /no checkout recorded for "ghost"/);
    assert.match(r.err, /farsight history --repo ghost <path>/);
  });
});

describe('farsight history — --releases proposes, never declares', () => {
  test('a repository with no tags says so, and proposes nothing', () => {
    const r = run(['history', '--repo', 'app', '--releases']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /no releases declared in \.farsight\/settings\.json/);
    assert.match(r.out, /no tags in this repository/);
    const d = historyJson(['--repo', 'app', '--releases']).repos[0]!;
    assert.equal(d.tags.found, 0);
    assert.deepEqual(d.tags.proposed, []);
    assert.deepEqual(d.releases, []);
  });

  test('tags are proposed with the scheme they were spelled in, and no release row is written', () => {
    // both schemes one real repository carries, on one repository
    git(app, ['tag', '-a', 'v1.1.0', '-m', 'one one', sha.c2!]);
    git(app, ['tag', '1.2.0', sha.c5!]);
    const path = join(work, '.farsight/farsight.db');
    const before = counts(path).release;
    const r = run(['history', '--repo', 'app', '--releases']);
    assert.equal(r.status, 0, r.err);
    // git sorts refs by name, so the bare-semver tag leads — the counts are what matter
    assert.match(r.out, /2 tags found in 2 naming schemes \(bare-semver 1 · v-prefixed 1\) — proposed, not releases/);
    assert.match(r.out, /a release is declared, never discovered/);
    assert.match(r.out, /"releases": \[\{ "name": "1\.2\.0", "tag": "1\.2\.0", "repo": "app" \}\]/);
    assert.equal(counts(path).release, before, 'proposing a tag must never write a release');

    const d = historyJson(['--repo', 'app', '--releases']).repos[0]!;
    assert.equal(d.tags.found, 2);
    assert.deepEqual(d.tags.schemes, { 'bare-semver': 1, 'v-prefixed': 1 });
    const byName = Object.fromEntries((d.tags.proposed as { name: string }[]).map((t) => [t.name, t]));
    assert.equal((byName['v1.1.0'] as any).sha, sha.c2, 'an annotated tag is dereferenced to its commit');
    assert.equal((byName['v1.1.0'] as any).annotated, true);
    assert.equal((byName['1.2.0'] as any).annotated, false);
    assert.equal((byName['1.2.0'] as any).scheme, 'bare-semver');
    assert.deepEqual(d.releases, [], 'a proposal is not a declaration');
    git(app, ['tag', '-d', 'v1.1.0']);
    git(app, ['tag', '-d', '1.2.0']);
  });

  test('a release declared in .farsight/settings.json is reported as declared', () => {
    const settings = join(work, '.farsight/settings.json');
    writeFileSync(settings, JSON.stringify({
      theme: 'dark', defaultLens: 'hybrid', sources: [], collections: [],
      releases: [{ name: '1.0.0', commit: sha.c2, repo: 'app' }, { name: 'other', commit: sha.c5, repo: 'elsewhere' }],
    }, null, 2));
    const r = run(['history', '--repo', 'app', '--releases']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /1 release declared in \.farsight\/settings\.json: 1\.0\.0/);
    const d = historyJson(['--repo', 'app', '--releases']).repos[0]!;
    assert.deepEqual((d.releases as { name: string }[]).map((x) => x.name), ['1.0.0'], 'another repo\'s declaration is not this one\'s');
    rmSync(settings);
  });
});

describe('farsight history — which absence it is', () => {
  test('a directory that is not a repository says that, and exits cleanly', () => {
    const plain = join(work, 'plain');
    mkdirSync(plain, { recursive: true });
    const r = run(['history', plain, '--repo', 'plain', '--db', join(work, 'plain.db')]);
    assert.equal(r.status, 0, 'no history is not a failure');
    assert.match(r.out, /not a git repository — the code is here, its history is not/);
    assert.match(r.out, /git said: fatal: not a git repository/);
    assert.equal(historyJson([plain, '--repo', 'plain', '--db', join(work, 'plain.db')]).repos[0]!.git.reason, 'not-a-repo');
  });

  test('an initialized repository with no commits says that, not "no commits touched this"', () => {
    const fresh = join(work, 'fresh');
    initRepo(fresh);
    const r = run(['history', fresh, '--repo', 'fresh', '--db', join(work, 'fresh.db')]);
    assert.equal(r.status, 0);
    assert.match(r.out, /a git repository with no commits yet — git itself has nothing to walk/);
    const d = historyJson([fresh, '--repo', 'fresh', '--db', join(work, 'fresh.db')]).repos[0]!;
    assert.equal(d.git.reason, 'no-commits');
    assert.equal(d.written, null, 'nothing was read, so nothing was written');
  });

  test('a shallow clone makes "first seen in" a floor, and says so', () => {
    const shallow = join(work, 'shallow');
    const r0 = spawnSync('git', ['clone', '--depth', '1', '-q', `file://${app}`, shallow], { encoding: 'utf8' });
    assert.equal(r0.status, 0, r0.stderr);
    const r = run(['history', shallow, '--repo', 'shallow', '--db', join(work, 'shallow.db')]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /shallow clone — the oldest commit read is a graft boundary, so "first seen in" is a floor: at or before/);
    const d = historyJson([shallow, '--repo', 'shallow', '--db', join(work, 'shallow.db')]).repos[0]!;
    assert.equal(d.shallow, true);
    assert.equal(d.git.read, 1, 'a depth-1 clone has one commit to walk — a boundary, not a history');
  });

  test('a detached HEAD is titled as the one ancestry it is', () => {
    const detached = join(work, 'detached');
    const r0 = spawnSync('git', ['clone', '-q', `file://${app}`, detached], { encoding: 'utf8' });
    assert.equal(r0.status, 0, r0.stderr);
    git(detached, ['checkout', '-q', '--detach', sha.c4!]);
    const r = run(['history', detached, '--repo', 'detached', '--db', join(work, 'detached.db')]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, new RegExp(`ancestry of ${sha.c4!.slice(0, 7)} \\(detached HEAD\\)`));
    const d = historyJson([detached, '--repo', 'detached', '--db', join(work, 'detached.db')]).repos[0]!;
    assert.equal(d.head.detached, true);
    assert.equal(d.head.ref, undefined);
    assert.equal(d.git.read, 4, 'c5 is not an ancestor of c4');
  });

  test('a sync whose commit is no longer in the repository keeps its row and says why', () => {
    // a rewritten history: the commit a sync recorded is unreachable afterwards
    const rw = join(work, 'rewritten');
    const rwDb = join(work, 'rewritten.db');
    initRepo(rw);
    writeFileSync(join(rw, 'one.ts'), 'export const one = 1;\n');
    commit(rw, 'one', '2026-02-01T00:00:00Z');
    writeFileSync(join(rw, 'two.ts'), 'export const two = 2;\n');
    const doomed = commit(rw, 'two — about to be rewritten away', '2026-02-02T00:00:00Z');
    assert.equal(run(['ingest', rw, '--repo', 'rewritten', '--out', join(work, 'rw.json'), '--db', rwDb]).status, 0);
    git(rw, ['reset', '-q', '--hard', 'HEAD~1']);
    writeFileSync(join(rw, 'two.ts'), 'export const two = 22;\n');
    commit(rw, 'two, again', '2026-02-03T00:00:00Z');

    const r = run(['history', rw, '--repo', 'rewritten', '--db', rwDb, '--graph', join(work, 'rw.json')]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /commit not in this repository's history — rewritten, pruned, or a history not read this far back/);
    // the row is kept, and the columns that would have to invent a number say so
    assert.match(r.out, /—\s+—\s+commit not in this repository's history/);
    const d = historyJson([rw, '--repo', 'rewritten', '--db', rwDb, '--graph', join(work, 'rw.json')]).repos[0]!;
    const row = (d.spine as { sync: number; commit: string; commitKnown: boolean; swept: number | null; unindexed: number | null }[])[0]!;
    assert.equal(row.commit, doomed);
    assert.equal(row.commitKnown, false);
    assert.equal(row.swept, null, 'an unknown commit swept an unknown number of commits, not zero');
    assert.equal(row.unindexed, null);
  });
});

describe('what a sync records per source', () => {
  test('a sync stamps every git source\'s own HEAD, so each spine is its own repository\'s', async () => {
    // `POST /api/sync` (the workspace server's path, `syncSources`) used to record only the
    // workspace root's sha, which is why the dogfood store has 22 `app-a` rows and 24
    // `app-b` rows with a null per-source commit. It now stamps each source's own head.
    const ws = join(work, 'two-source-ws');
    mkdirSync(ws, { recursive: true });
    const api = join(ws, 'api');
    const web = join(ws, 'web');
    for (const [dir, file, body, when] of [
      [api, 'api.ts', 'export function handler() { return 1; }\n', '2026-04-01T00:00:00Z'],
      [web, 'web.ts', 'export function page() { return 2; }\n', '2026-04-02T00:00:00Z'],
    ] as const) {
      initRepo(dir);
      writeFileSync(join(dir, file), body);
      commit(dir, `first commit of ${file}`, when);
    }
    // a second commit in `api` only, so the two repositories are visibly at different shas
    writeFileSync(join(api, 'more.ts'), 'export const more = 3;\n');
    const apiHead = commit(api, 'api moves on', '2026-04-03T00:00:00Z');
    const webHead = git(web, ['rev-parse', 'HEAD']);
    assert.notEqual(apiHead, webHead);

    const { syncSources } = await import('@farsight/server');
    const settings = {
      theme: 'dark', defaultLens: 'hybrid', collections: [],
      sources: [
        { id: 'api', name: 'api', type: 'local', path: api, enabled: true },
        { id: 'web', name: 'web', type: 'local', path: web, enabled: true },
      ],
    };
    const result = await syncSources(ws, settings as never, join(ws, 'graph.json'));
    assert.match(result.snapshot!, /^sync:1 · digest /, result.snapshot);

    const path = join(ws, '.farsight/farsight.db');
    const d = db(path);
    const rows = d.prepare('SELECT name, commit_sha FROM snapshot_source ORDER BY name')
      .all() as { name: string; commit_sha: string | null }[];
    const workspace = (d.prepare('SELECT commit_sha FROM snapshot WHERE sync = 1').get() as { commit_sha: string | null }).commit_sha;
    d.close();
    assert.deepEqual(rows.map((r) => [r.name, r.commit_sha]), [['api', apiHead], ['web', webHead]]);
    // the workspace directory is not a repository here, so the column that used to be the
    // only one recorded is empty — and the spine is complete all the same
    assert.equal(workspace, null);

    for (const [repo, head] of [['api', apiHead], ['web', webHead]] as const) {
      const doc = historyJson(['--repo', repo], ws).repos[0]!;
      assert.equal(doc.withoutCommit, 0, `${repo}: the sync recorded a commit for it`);
      const spine = doc.spine as { sync: number; commit: string; commitFrom: string; commitKnown: boolean; commits: string[] }[];
      assert.deepEqual(spine.map((x) => [x.sync, x.commit, x.commitFrom, x.commitKnown]), [[1, head, 'source', true]]);
      assert.deepEqual(spine[0]!.commits, [head], 'the oldest sync records exactly its own commit');
    }
    // neither repository's spine names the other's commit
    assert.equal(historyJson(['--repo', 'web'], ws).repos[0]!.spine[0].commit, webHead);
  });
});

/**
 * `farsight diff --attribute` (chunk H4): the frozen contract gains one optional
 * field, joined on **from outside** `diffGraphs`. What this block guards is that
 * the flag is what adds it (without it the document is the one the contract has
 * emitted since July), that the join survives the monorepo prefix §8 warns about,
 * and that a repository whose history nobody has read is left unclaimed rather
 * than handed an empty list.
 */
describe('farsight diff --attribute', () => {
  let ws: string;
  let mono: string;
  const at: Record<string, string> = {};

  before(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-attr-')));
    mono = join(ws, 'mono');
    initRepo(mono);
    // the trap: the source is `apps/web`, git's paths are `apps/web/...`
    mkdirSync(join(mono, 'apps/web/src'), { recursive: true });
    writeFileSync(join(mono, 'apps/web/package.json'), '{"name":"web","version":"0.0.0"}\n');
    writeFileSync(join(mono, 'apps/web/src/routes.ts'),
      "import express from 'express';\nconst app = express();\napp.get('/alpha', (req, res) => res.json({ ok: true }));\n");
    at.first = commit(mono, 'first: the alpha route', '2026-02-01T00:00:00Z');

    const web = join(mono, 'apps/web');
    assert.equal(run(['ingest', web, '--repo', 'web', '--out', 'graph.json'], ws).status, 0); // sync 1

    writeFileSync(join(mono, 'apps/web/src/routes.ts'),
      "import express from 'express';\nconst app = express();\napp.get('/alpha', (req, res) => res.json({ ok: true }));\napp.get('/beta', (req, res) => res.json({ ok: true }));\n");
    at.second = commit(mono, 'second: the beta route', '2026-02-02T00:00:00Z');
    assert.equal(run(['ingest', web, '--repo', 'web', '--out', 'graph.json'], ws).status, 0); // sync 2
  });

  after(() => { try { rmSync(ws, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ } });

  test('a repository whose history nobody has read is left unclaimed — not handed an empty list', () => {
    const r = run(['diff', '--from', 'sync:1', '--to', 'sync:2', '--attribute'], ws);
    assert.equal(r.status, 0, r.err);
    const doc = JSON.parse(r.out) as { changes: Record<string, unknown>[] };
    assert.ok(doc.changes.length >= 1, 'the second commit added a route');
    assert.ok(doc.changes.every((c) => !('attribution' in c)), 'no history read, so nothing is claimed');
    assert.match(r.err, /no history read for this repository/);
    assert.match(r.err, /farsight history --repo web/);
  });

  test('with the history read it names the commits that touched the file — file-level, and it says so', () => {
    assert.equal(run(['history', join(mono, 'apps/web'), '--repo', 'web'], ws).status, 0);
    const r = run(['diff', '--from', 'sync:1', '--to', 'sync:2', '--attribute'], ws);
    assert.equal(r.status, 0, r.err);

    // the words are part of the field: a reader must not be able to conclude
    // "this commit changed this route" from what the command printed
    assert.match(r.err, /attribution: file-level/);
    assert.match(r.err, /not proof that any of those commits changed/);
    assert.match(r.err, /the source sits under apps\/web\/ in its repository/);

    const doc = JSON.parse(r.out) as { changes: { id: string; loc?: { path: string }; attribution?: { commits: string[]; level: string; unindexed: number } }[] };
    const added = doc.changes.find((c) => c.loc?.path === 'src/routes.ts')!;
    assert.ok(added, 'the route the second commit added carries a file');
    // §8: without the `apps/web/` prefix this list would be empty, which would read
    // as "no commit touched this file" — a claim with no evidence behind it
    assert.deepEqual(added.attribution, { commits: [at.second], level: 'file', unindexed: 0 });
  });

  test('the flag is what adds the field: without it the document is the contract as it was', () => {
    const attributed = JSON.parse(run(['diff', '--from', 'sync:1', '--to', 'sync:2', '--attribute'], ws).out) as Record<string, unknown>;
    const r = run(['diff', '--from', 'sync:1', '--to', 'sync:2'], ws);
    assert.equal(r.status, 0, r.err);
    assert.doesNotMatch(r.out, /attribution/);
    assert.equal(r.err, '', 'no attribution header without the flag');
    const stripped = attributed as { changes: Record<string, unknown>[] };
    for (const c of stripped.changes) delete c.attribution;
    // byte for byte, field order included: the field is the only thing --attribute adds
    assert.equal(r.out.trim(), JSON.stringify(stripped, null, 2));
  });
});
