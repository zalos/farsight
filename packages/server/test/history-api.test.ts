/**
 * `/api/history`, `/api/diff` and `/compare/<a>...<b>` — chunk H5 of the
 * change-history lane (docs/proposals/change-history-2026-09.md §7).
 *
 * Three things are under test, and only the third is about HTTP:
 *
 * 1. **The endpoints return the same folds the CLI prints.** Every number and
 *    every sentence is compared against `SnapshotDb.commitSpine` /
 *    `spineSentences` / `spineRowNote` / `diffGraphs` computed here in-process.
 *    A second implementation on the server would show up as a mismatch that
 *    names the number and prints both values.
 * 2. **The honesty rules of §2 and §8.** *Not indexed* is a fact and not an
 *    absence; a derived number with no commit behind it is `null`, never 0;
 *    a repository with no git, a shallow clone, a detached HEAD and a rewritten
 *    history each say which absence they are; and the third row state settled in
 *    H5 tells *this sync did not walk this source* apart from *it walked it and
 *    stamped no commit*.
 * 3. **The frozen contract.** `/api/diff` is `farsight-diff v1` — validated
 *    against `schemas/farsight-diff-v1.schema.json` with and without
 *    `attribute=1`, and carrying **no** `attribution` key when it is absent.
 *    `/compare/…` 302s into the hash route so the permalinks the contract has
 *    minted since July stop 404-ing (§9).
 *
 * The fixtures are `git init` repositories and snapshot databases made inside a
 * temp directory. Nothing here touches the workspace graph, `examples/**`, any
 * real store, or ports 4477 / 4478 (the live dogfood servers).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GraphStore, SnapshotDb, diffGraphs, changeSentence, spineSentences, spineRowNote, attributeChanges,
  type CommitSpine, type SpineRow,
} from '@farsight/core';
import { gitLog, gitHeadRef, gitShallow, GIT_ABSENT_WORD, headTitle, shallowFloorSentence } from '@farsight/parsers';
import type { FileStatus } from '@farsight/core';
import { validate } from '../../core/test/validate.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;
const diffSchema = JSON.parse(readFileSync(join(repoRoot, 'schemas/farsight-diff-v1.schema.json'), 'utf8'));

let work: string;
let app: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';
const sha: Record<string, string> = {};

// ── the fixture: one repository, three syncs, commits no sync ever saw ─────

function git(dir: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/**
 * git's `--raw` status letters as the tables spell them — the same map
 * `commitInputs` applies in `cli.ts:272`, copied here because it is private to
 * the CLI. The fixture writes real statuses so a rename is stored as one.
 */
const STATUS_WORD: Record<string, FileStatus> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'unmerged', B: 'modified', X: 'unknown',
};

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Fixture']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
}

/** A commit with a fixed author *and* committer time, so "newest first" is not a race. */
function commit(dir: string, subject: string, when: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', subject], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  return git(dir, ['rev-parse', 'HEAD']);
}

/** One sync of `app`, recorded exactly as ingest records it: the source's own HEAD stamped. */
function sync(db: SnapshotDb, nodes: string[]): void {
  const store = new GraphStore();
  store.addFragment({
    repo: 'app',
    // routes, because `farsight-diff v1` reports route_added and not function_added:
    // the fixture has to produce changes for the contract to be tested on
    nodes: nodes.map((n) => ({ id: `app::src/${n}.ts::GET /${n}`, kind: 'route' as const, name: `GET /${n}`, tags: [], loc: { repo: 'app', path: `src/${n}.ts`, line: 1 } })),
    edges: [],
  });
  db.write(store, { commit: git(app, ['rev-parse', 'HEAD']), sources: [{ name: 'app', commit: git(app, ['rev-parse', 'HEAD']), files: 1 }] });
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const picked = await new Promise<number>((res, rej) => {
      const probe = createServer();
      probe.once('error', rej);
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        const p = typeof a === 'object' && a ? a.port : 0;
        probe.close(() => res(p));
      });
    });
    if (picked > 1024 && picked !== 4477 && picked !== 4478) return picked;
  }
  throw new Error('no free loopback port after 20 tries');
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = 'nothing answered';
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`the server exited with code ${child.exitCode}:\n${childLog}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/graph`);
      await r.arrayBuffer();
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (err) { last = (err as Error).message; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server never answered on port ${port} (${last}):\n${childLog}`);
}

before(async () => {
  // realpath: macOS /tmp is a symlink and the server resolves its workspace dir
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-history-')));
  app = join(work, 'app');
  initRepo(app);
  mkdirSync(join(app, 'src'), { recursive: true });

  // c1 …………………………………… before the first sync: outside every sync's reach
  writeFileSync(join(app, 'src', 'one.ts'), 'export const one = 1;\n');
  sha.c1 = commit(app, 'one', '2026-01-01T00:00:00Z');
  // c2 …………………………………… sync 1
  writeFileSync(join(app, 'src', 'two.ts'), 'export const two = 2;\n');
  sha.c2 = commit(app, 'two', '2026-01-02T00:00:00Z');
  // c3, c4 ………………………… never ingested by any sync — "not indexed"
  writeFileSync(join(app, 'src', 'three.ts'), 'export const three = 3;\n');
  sha.c3 = commit(app, 'three', '2026-01-03T00:00:00Z');
  writeFileSync(join(app, 'src', 'four.ts'), 'export const four = 4;\n');
  sha.c4 = commit(app, 'four', '2026-01-04T00:00:00Z');
  // c5 …………………………………… sync 2, and sync 3 re-indexes it on a newer build.
  // It also **moves** a file no graph node lives in, so the rename fold has a real
  // R100 to report (§6's second question) without touching what attributes to what.
  writeFileSync(join(app, 'src', 'five.ts'), 'export const five = 5;\n');
  git(app, ['mv', 'src/three.ts', 'src/trois.ts']);
  sha.c5 = commit(app, 'five', '2026-01-05T00:00:00Z');

  // a workspace whose one local source is `app`, so the endpoints can find its checkout
  mkdirSync(join(work, '.farsight'), { recursive: true });
  writeFileSync(join(work, '.farsight', 'settings.json'), JSON.stringify({
    theme: 'dark', defaultLens: 'hybrid', collections: [],
    sources: [{ id: 'app', name: 'app', type: 'local', path: 'app', enabled: true }],
  }, null, 2) + '\n');

  const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
  git(app, ['checkout', '-q', sha.c2!]);
  sync(db, ['one', 'two']);
  git(app, ['checkout', '-q', sha.c5!]);
  sync(db, ['one', 'two', 'five']);
  sync(db, ['one', 'two', 'five', 'six']); // same commit: a re-index on a newer build
  git(app, ['checkout', '-q', 'main']);
  // the history the endpoints read — written by the reader, exactly as `farsight history` does
  const log = gitLog(app, {});
  assert.ok(log.available, 'the fixture repository must have a readable log');
  db.writeCommits('app', log.commits.map((c) => ({
    sha: c.sha, at: new Date(c.at * 1000).toISOString(), author: c.author, email: c.email,
    subject: c.subject, parents: c.parents, merge: c.merge,
    // git's own letters through the same map `commitInputs` uses (cli.ts:272) — so a
    // rename in this repository arrives as a rename and not as a modification
    files: c.files.map((f) => ({
      path: f.path,
      status: STATUS_WORD[f.status] ?? ('unknown' as const),
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      ...(f.similarity === undefined ? {} : { similarity: f.similarity }),
    })),
  })));
  db.close();

  // a graph on disk, so /graph answers and roots[app] names the checkout
  const store = new GraphStore();
  store.roots.app = app;
  // one part, so the Map's /api/history/touching has something to find commits for
  store.addFragment({ repo: 'app', nodes: [{ id: 'app::src/two.ts::GET /two', kind: 'route', name: 'GET /two', tags: [], loc: { repo: 'app', path: 'src/two.ts', line: 1 } }], edges: [] });
  store.save(join(work, 'graph.json'));

  port = await freePort();
  const boot = `const { serveGraph } = await import(${JSON.stringify(serverDist)});\n`
    + `serveGraph(${JSON.stringify(join(work, 'graph.json'))}, ${port}, ${JSON.stringify(work)});\n`;
  child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: work,
    env: { ...process.env, MODELHUB_DIR: join(work, 'modelhub'), FIGMA_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { childLog += d; });
  child.stderr.on('data', (d: string) => { childLog += d; });
  await waitReady();
});

after(async () => {
  if (child && child.exitCode == null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
});

// ── helpers ───────────────────────────────────────────────────────────────

async function get(path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
}

async function api(path: string): Promise<any> {
  const r = await get(path);
  const body = await r.text();
  assert.equal(r.status, 200, `GET ${path} answered ${r.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

/** One named fact. The message says which number disagreed and what both sides say. */
function same(label: string, got: unknown, want: unknown): void {
  assert.deepStrictEqual(got, want,
    `${label}: the endpoint says ${JSON.stringify(got)}, the core fold computes ${JSON.stringify(want)}`);
}

/** The spine as the core folds it, read in this process from the same database. */
function fold<T>(f: (db: SnapshotDb) => T): T {
  const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
  try { return f(db); } finally { db.close(); }
}

// ─────────────────────────────────────────────────────────────────────────

describe('/api/history is commitSpine() + spineSentences()', () => {
  test('every whole-spine number is the fold\'s', async () => {
    const body = await api('/api/history?repo=app');
    const spine: CommitSpine = fold((db) => db.commitSpine('app'));
    same('repo', body.repo, 'app');
    same('commits', body.commits, spine.commits);
    same('unindexed', body.unindexed, spine.unindexed);
    same('syncs', body.syncs, spine.rows.length);
    same('distinct', body.distinct, spine.distinct);
    same('reindexed', body.reindexed, spine.reindexed);
    same('withoutCommit', body.withoutCommit, spine.withoutCommit);
    same('notInSync', body.notInSync, spine.notInSync);
    same('before', body.before, spine.before.length);
    same('after', body.after, spine.after.length);
    // the fixture, stated so a change to it fails loudly rather than silently
    same('the fixture has five commits', body.commits, 5);
    // c1, c3 and c4: three of five. c1 sits before the first sync, which is a
    // different thing from being indexed by it — the two facts are separate
    same('three of them no sync ever ingested', body.unindexed, 3);
    same('three syncs, two distinct commits', [body.syncs, body.distinct], [3, 2]);
    same('one of them re-indexed the same commit', body.reindexed, 1);
    same('c1 lies before the oldest sync\'s commit', body.before, 1);
  });

  test('every row is the fold\'s row, and its note is the shared sentence', async () => {
    const body = await api('/api/history?repo=app');
    const rows: SpineRow[] = fold((db) => db.commitSpine('app').rows);
    same('the syncs, newest first', body.spine.map((r: any) => r.sync), rows.map((r) => r.sync));
    for (const [i, row] of rows.entries()) {
      const got = body.spine[i];
      const note = spineRowNote(row);
      same(`sync:${row.sync}.commit`, got.commit, row.commit);
      same(`sync:${row.sync}.commitFrom`, got.commitFrom, row.commitFrom);
      same(`sync:${row.sync}.inSync`, got.inSync, row.inSync);
      same(`sync:${row.sync}.commitKnown`, got.commitKnown, row.commitKnown);
      same(`sync:${row.sync}.reindexed`, got.reindexed, row.reindexed);
      same(`sync:${row.sync}.note`, got.note, note.kind);
      same(`sync:${row.sync}.noteText`, got.noteText, note.text);
      same(`sync:${row.sync}.commits`, got.commits, row.commits.map((c) => c.sha));
      // a derived number with no commit behind it is null, never 0
      same(`sync:${row.sync}.swept`, got.swept, row.commitKnown ? row.commits.length : null);
      same(`sync:${row.sync}.unindexed`, got.unindexed, row.commitKnown ? row.unindexed : null);
    }
    const bySync = new Map(body.spine.map((r: any) => [r.sync, r]));
    same('sync 3 re-indexed the commit sync 2 already had', bySync.get(3).note, 'reindexed');
    same('and swept nothing new', bySync.get(3).swept, 0);
    same('sync 2 swept c3, c4 and c5', new Set(bySync.get(2).commits), new Set([sha.c3, sha.c4, sha.c5]));
    same('two of those three no sync ingested', bySync.get(2).unindexed, 2);
    same('every row stamped this source\'s own commit', body.spine.map((r: any) => r.commitFrom), ['source', 'source', 'source']);
    same('and every sync walked it', body.spine.map((r: any) => r.inSync), [true, true, true]);
  });

  test('the notes are the shared sentences, unindexed first', async () => {
    const body = await api('/api/history?repo=app');
    const said = spineSentences(fold((db) => db.commitSpine('app')));
    const texts = body.notes.map((n: any) => n.text);
    assert.equal(texts[0], said.unindexed!.text, 'the unindexed count is stated before any row can be read as complete');
    assert.match(texts[0], /5 commits read into history · 2 ingested by a sync · 3 not yet — the 3 not yet ingested are not indexed/);
    for (const key of ['syncs', 'outsideReach'] as const) {
      assert.ok(texts.includes(said[key]!.text), `the ${key} sentence must be the fold's: ${said[key]!.text}`);
    }
    // the words, not a number the reader has to interpret
    assert.ok(texts.some((t: string) => /outside every sync's reach: 1 before the oldest sync's commit/.test(t)));
  });

  test('HEAD, its title and the shallow flag are read from the checkout, never guessed', async () => {
    const body = await api('/api/history?repo=app');
    const head = gitHeadRef(app);
    assert.ok(head.available);
    same('root', body.root, app);
    same('head.sha', body.head.sha, head.sha);
    same('head.ref', body.head.ref, 'main');
    same('head.detached', body.head.detached, false);
    same('title', body.title, headTitle(head));
    const sh = gitShallow(app);
    same('shallow', body.shallow, sh.available ? sh.shallow : null);
    same('this fixture is a full clone', body.shallow, false);
  });

  test('?from=&to= adds the range, and says how much of it is not indexed', async () => {
    const body = await api('/api/history?repo=app&from=sync:1&to=sync:2');
    const range = fold((db) => db.commitsBetween('app', 1, 2));
    same('range.base', body.range.base, 1);
    same('range.head', body.range.head, 2);
    same('range.baseCommit', body.range.baseCommit, sha.c2);
    same('range.headCommit', body.range.headCommit, sha.c5);
    same('range.commits', body.range.commits.map((c: any) => c.sha), range.commits.map((c) => c.sha));
    same('range.unindexed', body.range.unindexed, range.unindexed);
    same('c3 and c4 are in the range and were never ingested', body.range.unindexed, 2);
    same('nothing about this range is unknowable', body.range.incomplete, []);
    // every commit carries whether a sync ever read it — a fact, not an absence
    const c3 = body.range.commits.find((c: any) => c.sha === sha.c3);
    same('c3.indexed', c3.indexed, false);
    same('c3.syncs', c3.syncs, []);
    const c5 = body.range.commits.find((c: any) => c.sha === sha.c5);
    same('c5.indexed', c5.indexed, true);
    same('c5 was recorded by syncs 2 and 3', c5.syncs, [2, 3]);
  });

  test('the range says what it did to files, so a rename is not read as a deletion', async () => {
    const body = await api('/api/history?repo=app&from=sync:1&to=sync:2');
    const want = fold((db) => {
      const shas = db.commitsBetween('app', 1, 2).commits.map((c) => c.sha);
      const { files } = db.historyRows('app', { shas });
      const paths = new Set(files.map((f) => f.path));
      const renamed = files.filter((f) => f.status === 'renamed');
      return { touched: paths.size, renamed: renamed.length, identical: renamed.filter((f) => f.similarity === 100).length };
    });
    same('range.files', body.range.files, want);
    // the fixture moved src/three.ts to src/trois.ts inside c5 without editing it:
    // node ids carry the path, so the measured diff would report a removal and an
    // addition, and this is the number that says nothing was deleted
    same('the move is reported as a rename', body.range.files.renamed, 1);
    same('and as one git scored byte-identical', body.range.files.identical, 1);
    assert.ok(body.range.files.touched >= 3, `three commits touched at least three files, got ${body.range.files.touched}`);
  });

  test('to= alone defaults from to the sync before it, the way farsight diff does', async () => {
    const body = await api('/api/history?repo=app&to=sync:2');
    same('the default base is sync 1', body.range.base, 1);
    same('and the head is what was asked for', body.range.head, 2);
  });

  test('a pruned or unknown sync explains itself', async () => {
    const r = await get('/api/history?repo=app&from=sync:1&to=sync:99');
    same('status', r.status, 404);
    assert.match((await r.json()).error, /sync:99 does not exist — latest is sync:3/);
  });

  test('no ?repo= names the repositories it could have answered for', async () => {
    const r = await get('/api/history');
    same('status', r.status, 400);
    const { error } = await r.json();
    assert.match(error, /missing \?repo=<source name>/);
    assert.match(error, /this workspace knows: app/);
  });

  test('a repository with no checkout still gets its spine, and says what it cannot read', async () => {
    const body = await api('/api/history?repo=ghost');
    same('root', body.root, null);
    same('head', body.head, null);
    // null, never false: a shallow check that could not run has not said "not shallow"
    same('shallow', body.shallow, null);
    same('no history has been read for it', body.commits, 0);
    // the unread-history sentence governs every number, so it comes first; the
    // checkout it cannot find is the next thing said
    assert.match(body.notes[0].text, /no history has been read for this repository/);
    assert.match(body.notes[1].text, /no checkout recorded for ghost/);
    same('both are warnings, not facts', [body.notes[0].level, body.notes[1].level], ['warn', 'warn']);
    // `commits: 0` must not be read as "this repository has no commits" — nobody looked
    same('bound', body.bound, 'floor');
    same('historyRead', body.historyRead, false);
    // three syncs exist, and none of them walked this source — the third row state
    same('syncs', body.syncs, 3);
    same('withoutCommit', body.withoutCommit, 3);
    same('notInSync', body.notInSync, 3);
    same('every row says it was not in the sync', body.spine.map((r: any) => r.note), ['not-in-sync', 'not-in-sync', 'not-in-sync']);
    same('and every derived number is absent, not zero', body.spine.map((r: any) => r.swept), [null, null, null]);
  });
});

describe('/api/history — which absence it is (§8)', () => {
  test('a checkout that is not a repository says that, and still serves the spine', async () => {
    const plain = join(work, 'plain');
    mkdirSync(plain, { recursive: true });
    const settings = JSON.parse(readFileSync(join(work, '.farsight', 'settings.json'), 'utf8'));
    settings.sources.push({ id: 'plain', name: 'plain', type: 'local', path: 'plain', enabled: true });
    writeFileSync(join(work, '.farsight', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
    const body = await api('/api/history?repo=plain');
    same('root', body.root, plain);
    same('head.available', body.head.available, false);
    same('reason', body.head.reason, 'not-a-repo');
    same('the word is the one every surface prints', body.head.word, GIT_ABSENT_WORD['not-a-repo']);
    same('title', body.title, null);
    assert.ok(body.notes.some((n: any) => n.text.startsWith(GIT_ABSENT_WORD['not-a-repo'])),
      `the not-a-repo word must be printed: ${JSON.stringify(body.notes)}`);
    assert.ok(body.notes.some((n: any) => /the snapshot spine below is unchanged; every commit it cannot name reads "not indexed"/.test(n.text)));
    same('the spine is still three syncs long', body.syncs, 3);
  });

  test('a shallow clone makes "first seen in" a floor, and says so', async () => {
    const shallowDir = join(work, 'shallowsrc');
    spawnSync('git', ['clone', '-q', '--depth', '1', `file://${app}`, shallowDir], { encoding: 'utf8' });
    const settings = JSON.parse(readFileSync(join(work, '.farsight', 'settings.json'), 'utf8'));
    settings.sources.push({ id: 'shallowsrc', name: 'shallowsrc', type: 'local', path: 'shallowsrc', enabled: true });
    writeFileSync(join(work, '.farsight', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
    const body = await api('/api/history?repo=shallowsrc');
    same('shallow', body.shallow, true);
    const floor = body.notes.find((n: any) => /shallow clone/.test(n.text));
    assert.ok(floor, `a shallow clone must say so: ${JSON.stringify(body.notes)}`);
    // no history has been read for this source, so the floor has no commit to name —
    // and it is still a floor
    same('the sentence is the shared one', floor.text, shallowFloorSentence(undefined));
    same('and it is a warning', floor.level, 'warn');
  });

  test('a detached HEAD is titled as the one ancestry it is', async () => {
    const detached = join(work, 'detached');
    initRepo(detached);
    writeFileSync(join(detached, 'a.ts'), 'export const a = 1;\n');
    const first = commit(detached, 'first', '2026-02-01T00:00:00Z');
    writeFileSync(join(detached, 'b.ts'), 'export const b = 2;\n');
    commit(detached, 'second', '2026-02-02T00:00:00Z');
    git(detached, ['checkout', '-q', first]);
    const settings = JSON.parse(readFileSync(join(work, '.farsight', 'settings.json'), 'utf8'));
    settings.sources.push({ id: 'detached', name: 'detached', type: 'local', path: 'detached', enabled: true });
    writeFileSync(join(work, '.farsight', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
    const body = await api('/api/history?repo=detached');
    same('head.detached', body.head.detached, true);
    same('head.ref is absent — there is no branch', body.head.ref, undefined);
    same('title', body.title, `ancestry of ${first.slice(0, 7)} (detached HEAD)`);
  });

  test('a sync whose commit this history does not contain keeps its row and says why', async () => {
    // the rewritten-history case: a snapshot stamped a sha, the repository no longer has it
    const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
    const store = new GraphStore();
    store.addFragment({ repo: 'rewritten', nodes: [], edges: [] });
    db.write(store, { commit: 'deadbee'.padEnd(40, '0'), sources: [{ name: 'rewritten', commit: 'deadbee'.padEnd(40, '0'), files: 1 }] });
    db.writeCommits('rewritten', [{ sha: 'cafe'.padEnd(40, '1'), at: '2026-04-01T00:00:00Z', subject: 'the history that survived', parents: [] }]);
    db.close();
    const body = await api('/api/history?repo=rewritten');
    const row = body.spine[0];
    same('the row keeps the sha it recorded', row.commit, 'deadbee'.padEnd(40, '0'));
    same('commitKnown', row.commitKnown, false);
    same('note', row.note, 'commit-unknown');
    assert.match(row.noteText, /commit not in this repository's history — rewritten, pruned, or a history not read this far back/);
    // and nothing derived from an unplaceable commit is invented
    same('swept', row.swept, null);
    same('unindexed', row.unindexed, null);
    assert.ok(body.notes.some((n: any) => /no sync on this spine names a commit this repository's history contains/.test(n.text)));
  });
});

describe('/api/diff is the frozen farsight-diff v1', () => {
  test('the document is diffGraphs() and the schema accepts it', async () => {
    const body = await api('/api/diff?from=sync:1&to=sync:2');
    const want = fold((db) => {
      const base = db.read(1); const head = db.read(2);
      return diffGraphs(base.store, head.store, { changes: db.changedBetween(1, 2) });
    });
    same('the whole document', body, JSON.parse(JSON.stringify(want)));
    assert.deepEqual(validate(body, diffSchema), [], 'the frozen schema must accept it');
    same('schema', body.schema, 'farsight-diff v1');
    // sync 2 added `five`; the fixture's changes carry a loc, so they are attributable
    assert.ok(body.changes.length > 0, 'the fixture must produce at least one change');
  });

  test('without attribute=1 there is no attribution key at all — absent is not empty', async () => {
    const body = await api('/api/diff?from=sync:1&to=sync:2');
    for (const c of body.changes) {
      assert.ok(!('attribution' in c), `change ${c.id} carries an attribution field nobody asked for`);
    }
    assert.equal((await get('/api/diff?from=sync:1&to=sync:2')).headers.get('x-farsight-attribution'), null,
      'the caveat header rides only with the field it is about');
  });

  test('attribute=1 adds the optional field, file-level, and still validates', async () => {
    const r = await get('/api/diff?from=sync:1&to=sync:2&attribute=1');
    const body = JSON.parse(await r.text());
    assert.deepEqual(validate(body, diffSchema), [], 'the frozen schema permits the optional field');
    const want = fold((db) => {
      const base = db.read(1); const head = db.read(2);
      const diff = diffGraphs(base.store, head.store, { changes: db.changedBetween(1, 2) });
      const rows = db.historyRows('app', { shas: db.commitsBetween('app', 1, 2).commits.map((c) => c.sha) });
      return attributeChanges(diff, { commits: rows.commits, files: rows.files }, { prefix: {} });
    });
    same('the whole attributed document', body, JSON.parse(JSON.stringify(want)));
    const attributed = body.changes.filter((c: any) => c.attribution);
    assert.ok(attributed.length > 0, 'the fixture must attribute at least one change');
    for (const c of attributed) {
      same(`${c.id}.attribution.level`, c.attribution.level, 'file');
      assert.ok(Array.isArray(c.attribution.commits));
      assert.equal(typeof c.attribution.unindexed, 'number');
    }
    // the caveats cannot ride inside a frozen additionalProperties:false document,
    // so they ride as headers pointing at the surface whose job is the narrative
    assert.match(r.headers.get('x-farsight-attribution') ?? '', /level=file; .*not proof of cause/);
    assert.match(r.headers.get('x-farsight-attribution-words') ?? '', /^\/api\/history\?repo=<name>&from=sync:1&to=sync:2$/);
  });

  test('a change with no file gets no attribution, even with the flag', async () => {
    const body = await api('/api/diff?from=sync:1&to=sync:2&attribute=1');
    for (const c of body.changes) {
      if (!c.loc) assert.ok(!('attribution' in c), `change ${c.id} has no file, so it cannot have a file's history`);
    }
  });

  test('the defaults are farsight diff\'s: to=latest, from=the sync before it', async () => {
    // computed, not assumed: a suite above this one records a snapshot of its own,
    // so "latest" is whatever the store says when the request is made
    const [latest, previous] = fold((db) => {
      const rows = db.list(5);
      return [rows[0]!.sync, db.previous(rows[0]!.sync)!];
    });
    const body = await api('/api/diff');
    assert.ok(body.base.startsWith(`sync:${previous}`), `base reads ${body.base}, expected sync:${previous}`);
    assert.ok(body.head.startsWith(`sync:${latest}`), `head reads ${body.head}, expected sync:${latest}`);
  });

  test('a pruned or unknown sync explains itself, and nonsense is a usage error', async () => {
    const unknown = await get('/api/diff?from=sync:1&to=sync:99');
    same('status', unknown.status, 404);
    assert.match((await unknown.json()).error, /sync:99 does not exist/);
    const nonsense = await get('/api/diff?to=lots');
    same('status', nonsense.status, 400);
    assert.match((await nonsense.json()).error, /to expects sync:<N> or latest \(got "lots"\)/);
    const badFormat = await get('/api/diff?format=xml');
    same('status', badFormat.status, 400);
    assert.match((await badFormat.json()).error, /unknown format "xml" \(json\|sarif\|md\)/);
  });
});

describe('/api/changes — the frozen document nested, with the words beside it', () => {
  // The Changes surface needs two things the frozen document cannot carry: one
  // sentence per change, and the caveats that keep file-level attribution from
  // being read as cause. `farsight-diff v1` is additionalProperties:false, so
  // neither may ride inside it — the document is nested under `diff` instead, and
  // these tests are what hold that line.
  test('diff is byte-for-byte the document /api/diff serves', async () => {
    const body = await api('/api/changes?from=sync:1&to=sync:2');
    const contract = await api('/api/diff?from=sync:1&to=sync:2&attribute=1');
    same('the nested document', body.diff, contract);
    assert.deepEqual(validate(body.diff, diffSchema), [], 'the frozen schema must accept the nested document');
    same('schema', body.diff.schema, 'farsight-diff v1');
    same('baseSync', body.baseSync, 1);
    same('headSync', body.headSync, 2);
  });

  test('every sentence is the core\'s changeSentence, one per change', async () => {
    const body = await api('/api/changes?from=sync:1&to=sync:2');
    const want = fold((db) => {
      const diff = diffGraphs(db.read(1).store, db.read(2).store, { changes: db.changedBetween(1, 2) });
      return Object.fromEntries(diff.changes.map((c) => [c.id, changeSentence(c)]));
    });
    same('the sentences', body.sentences, want);
    same('one per change', Object.keys(body.sentences).length, body.diff.changes.length);
    for (const c of body.diff.changes) {
      assert.ok(body.sentences[c.id], `change ${c.id} (${c.kind}) has no sentence, so a register with no kind words could not draw it`);
    }
  });

  test('the attribution caveats travel as data, and say they are file-level', async () => {
    const body = await api('/api/changes?from=sync:1&to=sync:2');
    same('level', body.attribution.level, 'file');
    assert.match(body.attribution.header, /file-level/);
    assert.match(body.attribution.header, /not proof that any of those commits changed/);
    assert.ok(body.attribution.notes.length > 0, 'a repository with a history must say how much of the range was never ingested');
    assert.ok(body.attribution.notes.some((n: any) => /no sync ever ingested/.test(n.text)),
      'the fixture range holds two commits no sync read; the notes must say so');
  });

  test('the defaults are farsight diff\'s, and a bad end is a usage error', async () => {
    const [latest, previous] = fold((db) => {
      const rows = db.list(5);
      return [rows[0]!.sync, db.previous(rows[0]!.sync)!];
    });
    const body = await api('/api/changes');
    same('headSync', body.headSync, latest);
    same('baseSync', body.baseSync, previous);
    const unknown = await get('/api/changes?from=sync:1&to=sync:99');
    same('status', unknown.status, 404);
    assert.match((await unknown.json()).error, /sync:99 does not exist/);
    const nonsense = await get('/api/changes?to=lots');
    same('status', nonsense.status, 400);
    assert.match((await nonsense.json()).error, /to expects sync:<N> or latest \(got "lots"\)/);
  });
});

describe('/compare/<a>...<b> — the frozen permalink (§9)', () => {
  test('a permalink the contract minted redirects into the hash route instead of 404ing', async () => {
    // the shape diff.ts:364 has minted since July
    const r = await get('/compare/1...2');
    same('status', r.status, 302);
    same('location', r.headers.get('location'), '/#/changes/1...2');
  });

  test('every permalink in a real document resolves', async () => {
    const body = await api('/api/diff?from=sync:1&to=sync:2');
    assert.ok(body.changes.length > 0);
    for (const c of body.changes.slice(0, 5)) {
      // the fragment is never sent to a server, so only the range can be followed
      const r = await get(c.permalink.split('#')[0]);
      same(`${c.permalink} status`, r.status, 302);
      same(`${c.permalink} location`, r.headers.get('location'), '/#/changes/1...2');
    }
  });

  test('a path that is not a comparison link says so rather than redirecting somewhere', async () => {
    const r = await get('/compare/nonsense');
    same('status', r.status, 404);
    assert.match((await r.json()).error, /expected \/compare\/<baseSync>\.\.\.<headSync>/);
  });
});

describe('/api/history — a history nobody has read (absent is not empty)', () => {
  // The defect this pins was found on live data. With **zero** commit rows for a
  // repository every containment check fails, and the endpoint reported that
  // failure as a finding about the repository: sixteen of the reference app's spine rows read
  // `commit-unknown` ("commit not in this repository's history") and nineteen read
  // `no-commit`, before anyone had run `farsight history`. All thirty-five claims
  // were false — and both live servers' databases are in exactly that state today.
  //
  // A fixture with a history always present cannot see it, so this source has none
  // until the second half of the test writes one.
  const repo = 'unread';
  let syncs: number[];

  before(() => {
    const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
    const head = git(app, ['rev-parse', 'HEAD']);
    const store = new GraphStore();
    store.addFragment({ repo, nodes: [], edges: [] });
    // one sync stamping this source's own sha, then two stamping only the workspace
    // root's — the shape 19 of the reference app's 53 rows are in
    const a = db.write(store, { commit: head, sources: [{ name: repo, commit: head }] }).sync;
    const b = db.write(store, { commit: head, sources: [{ name: repo, files: 1 }] }).sync;
    const c = db.write(store, { commit: head, sources: [{ name: repo, files: 1 }] }).sync;
    syncs = [c, b, a]; // newest first, as the spine returns them
    db.close();
  });

  test('no row claims a commit is missing, and no count is presented as a measurement', async () => {
    const body = await api(`/api/history?repo=${repo}`);
    same('historyRead', body.historyRead, false);
    same('bound', body.bound, 'floor');
    same('commits', body.commits, 0);
    const mine = body.spine.filter((r: any) => syncs.includes(r.sync));
    same('the three syncs, newest first', mine.map((r: any) => r.sync), syncs);
    // the two words the defect used, now impossible on an unread history
    same('every one of them says the history is unread', mine.map((r: any) => r.note),
      ['history-unread', 'history-unread', 'history-unread']);
    assert.ok(!body.spine.some((r: any) => r.note === 'commit-unknown'),
      'nothing can be missing from a history nobody has read');
    same('none of them claims the sync recorded no commit', mine.filter((r: any) => r.note === 'no-commit').length, 0);
    // null, not false: the question could not be asked
    same('commitKnown', mine.map((r: any) => r.commitKnown), [null, null, null]);
    same('swept', mine.map((r: any) => r.swept), [null, null, null]);
    same('unindexed', mine.map((r: any) => r.unindexed), [null, null, null]);
    // the unverifiable workspace sha is carried as itself, neither folded nor denied
    same('two rows carry only the workspace root\'s sha', mine.filter((r: any) => r.commitUnverified).length, 2);
    same('and none of them pretends it is this repository\'s commit', mine.filter((r: any) => r.commit).length, 1);
    // the unread case has its own number, so H7 cannot draw it as a missing stamp.
    // withoutCommit counts only absences that are facts about a sync — here, the
    // earlier syncs that never walked this source at all.
    same('withoutCommit is exactly the rows whose absence a sync caused',
      body.withoutCommit, body.spine.filter((r: any) => r.note === 'no-commit' || r.note === 'not-in-sync').length);
    assert.ok(body.notInSync > 0, 'the fixture must contain syncs that did not walk this source, or the count is trivial');
    same('and not one of the three unplaceable rows is in it',
      mine.filter((r: any) => r.note === 'no-commit' || r.note === 'not-in-sync').length, 0);
    same('withoutHistory', body.withoutHistory, 3);
    same('unverified', body.unverified, 2);
    // and it is said, first, before any number
    same('the first note is the unread warning', body.notes[0].level, 'warn');
    assert.match(body.notes[0].text, /no history has been read for this repository — run `farsight history` for it/);
    assert.match(body.notes[0].text, /every count below is a floor/);
  });

  test('a range over an unread history carries no file facts at all', async () => {
    // `touched: 0` would assert that nothing in the range touched a file, which is
    // the one claim an unread history cannot make — the rule attribution follows.
    const body = await api(`/api/history?repo=${repo}&from=sync:${syncs[1]}&to=sync:${syncs[0]}`);
    assert.ok(!('files' in body.range), 'an unread history must offer no file counts, not zeroes');
    // three reasons, not one: no history to place anything in, and neither of these
    // two syncs stamped a commit for this source to place
    assert.deepEqual(body.range.incomplete, ['no-history', 'base-missing', 'head-missing']);
    assert.match(body.range.notes[0].text, /no history has been read for this repository/);
  });

  test('and once the history is read, every one of those rows resolves', async () => {
    const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
    const log = gitLog(app, {});
    assert.ok(log.available);
    db.writeCommits(repo, log.commits.map((c) => ({
      sha: c.sha, at: new Date(c.at * 1000).toISOString(), author: c.author, email: c.email,
      subject: c.subject, parents: c.parents, merge: c.merge,
    })));
    db.close();

    const body = await api(`/api/history?repo=${repo}`);
    same('historyRead', body.historyRead, true);
    same('bound', body.bound, 'exact');
    same('commits', body.commits, 5);
    const mine = body.spine.filter((r: any) => syncs.includes(r.sync));
    same('not one row still says the history is unread', mine.filter((r: any) => r.note === 'history-unread').length, 0);
    same('the notes they resolve to', mine.map((r: any) => r.note), ['reindexed', 'reindexed', 'subject']);
    same('commitKnown', mine.map((r: any) => r.commitKnown), [true, true, true]);
    same('withoutHistory', body.withoutHistory, 0);
    same('unverified', body.unverified, 0);
    // the workspace shas are now this repository's commits by identity, and said to be
    same('provenance', mine.map((r: any) => r.commitFrom), ['workspace', 'workspace', 'source']);
    assert.ok(!body.notes.some((n: any) => /no history has been read/.test(n.text)),
      'the unread warning must go away once a history is there');
    // the unindexed count is now sayable, and says a real number
    assert.ok(body.notes.some((n: any) => / not yet — the \d+ not yet ingested are not indexed/.test(n.text)));
  });
});

describe('/api/history/touching — the Map\'s Changes tab', () => {
  test('the commits that changed a part, newest first, with a typed count and how each was matched', async () => {
    const body = await api('/api/history/touching?repo=app&nodes=' + encodeURIComponent('app::src/two.ts::GET /two'));
    same('commits read for the repository', body.read, 5);
    same('the one commit that touched src/two.ts', body.commits.map((c: { sha: string }) => c.sha), [sha.c2]);
    same('its subject', body.commits[0].subject, 'two');
    same('matched by its file', body.commits[0].parts, [{ node: 'app::src/two.ts::GET /two', how: 'file' }]);
    same('the typed count', [body.counted.commits.n, body.counted.commits.unit, body.counted.commits.scope], [1, 'map.prop.changes.countCommits', 'journey.scopeHere']);
    same('its split adds up', body.counted.commits.breakdown.map((p: { n: number }) => p.n), [0, 1]);
  });
  test('a part no commit touched is none touched, not never read; without the query it is a 400', async () => {
    const none = await api('/api/history/touching?repo=app&nodes=app::nowhere');
    same('read', none.read, 5);
    same('commits', none.commits, []);
    assert.equal((await get('/api/history/touching?repo=app')).status, 400);
  });
});

describe('/api/history/commit — a commit and the parts it touched (the Map\'s Affected mode)', () => {
  test('a short sha finds the commit; its parts are the graph parts in the files it changed', async () => {
    const body = await api('/api/history/commit?sha=' + sha.c2!.slice(0, 7));
    same('the full sha', body.sha, sha.c2);
    same('its repository', body.repo, 'app');
    same('its subject', body.subject, 'two');
    same('matched by its file', body.parts, [{ node: 'app::src/two.ts::GET /two', how: 'file' }]);
  });
  test('an unknown sha is a 404, a missing one a 400, never a 500', async () => {
    assert.equal((await get('/api/history/commit?sha=ffffffff')).status, 404);
    assert.equal((await get('/api/history/commit')).status, 400);
    assert.equal((await get('/api/history/commit?sha=not-a-sha')).status, 404);
  });
});
