// History tests (change-history-2026-09.md §1-§2): the four tables beside the
// snapshot spine, the pure folds over them, and the two invariants the proposal
// makes non-negotiable — `digestOf()` never moves because history moved, and an
// un-ingested commit comes back as the fact `indexed: false` rather than as an
// absence a caller has to infer. The folds are tested without sqlite; the store
// methods skip on a runtime without node:sqlite, as the snapshot suite does.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GraphStore, SnapshotDb, digestOf, sqliteAvailable, spineOf, commitsInRange, attributeChanges,
  spineSentences, spineRowNote, STRINGS,
} from '../dist/index.js';
import type { CommitInput, CommitRow, FileChange, GraphNode, SpineSnapshot, SpineCommitState } from '../dist/index.js';

const available = sqliteAvailable();
const opts = { skip: available ? false : 'node:sqlite unavailable on this runtime — degraded mode has no history to test' };

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-hist-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'farsight.db');
}

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind: 'function', name: id.split('::').pop()!, tags: [], ...extra }) as GraphNode;
const mkStore = (ids: string[]): GraphStore => {
  const s = new GraphStore();
  s.addFragment({ repo: 'r', nodes: ids.map((id) => node(id)), edges: [] });
  return s;
};

const sha = (i: number) => `c${String(i).padStart(2, '0')}`;
const at = (i: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();

/** A linear chain c01 (oldest) … cN, each touching `src/f<i>.ts`. */
function chain(n: number): CommitInput[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return {
      sha: sha(i),
      at: at(i),
      author: 'Ada',
      email: 'ada@example.com',
      subject: `commit ${i}`,
      parents: i === 1 ? [] : [sha(i - 1)],
      files: [{ path: `src/f${i}.ts`, status: 'modified' as const, added: i, deleted: 0 }],
    };
  });
}

/** A CommitRow for the pure folds, without going through a store. */
const row = (i: number, extra: Partial<CommitRow> = {}): CommitRow => ({
  repo: 'r',
  sha: sha(i),
  at: at(i),
  author: 'Ada',
  email: 'ada@example.com',
  subject: `commit ${i}`,
  parents: i === 1 ? [] : [sha(i - 1)],
  merge: false,
  indexed: false,
  syncs: [],
  ...extra,
});

test('20 commits across 3 syncs: the spine says what each swept up, and the gap comes back indexed:false', opts, () => {
  const db = new SnapshotDb(tempDb());
  // three syncs recording c05, c09 and c20 — so c10…c19 is an eleven-wide blind gap
  for (const [i, commit] of [sha(5), sha(9), sha(20)].entries()) {
    db.write(mkStore([`r::v${i + 1}`]), { commit, sources: [{ name: 'r', commit }] });
  }
  const written = db.writeCommits('r', chain(20));
  assert.deepEqual(written, { commits: 20, files: 20, linked: 3 }); // three shas matched a sync, not twenty

  const spine = db.commitSpine('r');
  assert.equal(spine.commits, 20);
  assert.equal(spine.distinct, 3); // three distinct commits behind three syncs
  assert.equal(spine.unindexed, 17); // 20 known, 3 ever recorded
  assert.equal(spine.reindexed, 0);
  assert.deepEqual(spine.rows.map((r) => r.sync), [3, 2, 1]); // newest first

  const [head, mid, first] = spine.rows as [typeof spine.rows[0], typeof spine.rows[0], typeof spine.rows[0]];
  assert.deepEqual(head.commits.map((c) => c.sha), [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10].map(sha));
  assert.equal(head.unindexed, 10); // c20 is indexed, the ten behind it are not
  assert.equal(head.commitKnown, true);
  assert.equal(head.reindexed, false);
  assert.deepEqual(mid.commits.map((c) => c.sha), [9, 8, 7, 6].map(sha));
  assert.equal(mid.unindexed, 3);
  assert.deepEqual(first.commits.map((c) => c.sha), [sha(5)]); // the oldest sync records one commit
  assert.equal(first.unindexed, 0);
  // everything older than the first sync's commit is before Farsight watched the repo
  assert.deepEqual(spine.before.map((c) => c.sha), [4, 3, 2, 1].map(sha));
  assert.deepEqual(spine.after, []);

  // the gap is a fact on every row, not an absence
  const gap = db.unindexed('r');
  assert.equal(gap.length, 17);
  assert.ok(gap.every((c) => c.indexed === false && c.syncs.length === 0));
  assert.deepEqual(gap.slice(0, 11).map((c) => c.sha), [19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 8].map(sha));
  const indexedShas = head.commits.concat(mid.commits, first.commits).filter((c) => c.indexed).map((c) => c.sha);
  assert.deepEqual(indexedShas, [sha(20), sha(9), sha(5)]);
  assert.deepEqual(head.commits.find((c) => c.sha === sha(20))!.syncs, [3]);

  // and the same window as a range
  const range = db.commitsBetween('r', 2, 3);
  assert.deepEqual(range.commits.map((c) => c.sha), head.commits.map((c) => c.sha));
  assert.equal(range.unindexed, 10);
  assert.deepEqual(range.incomplete, []);
  assert.equal(range.baseCommit, sha(9));
  assert.equal(range.headCommit, sha(20));
  db.close();
});

test('digestOf does not move when only the history moves', opts, () => {
  const path = tempDb();
  const db = new SnapshotDb(path);
  const store = mkStore(['r::a', 'r::b']);
  const ref = db.write(store, { commit: sha(3), sources: [{ name: 'r', commit: sha(3) }] });
  const before = digestOf(store);
  const nodesBefore = JSON.stringify(db.read(1).store.toJSON().nodes);

  db.writeCommits('r', chain(5));

  // the graph did not move, so neither may its identity — byte-identical digest
  assert.equal(digestOf(store), before);
  assert.equal(digestOf(db.read(1).store), before);
  assert.equal(db.list()[0]!.digest, ref.digest);
  assert.equal(before, ref.digest);
  // and no node gained a field on the way through — nothing about a commit reaches graph content
  const nodesAfter = JSON.stringify(db.read(1).store.toJSON().nodes);
  assert.equal(nodesAfter, nodesBefore);
  assert.ok(!/commit|sha|author/.test(nodesAfter));
  // history is visible, the snapshot counts are untouched
  assert.equal(db.commitSpine('r').commits, 5);
  assert.deepEqual(db.list().map((s) => [s.sync, s.nodes, s.edges]), [[1, 2, 0]]);
  db.close();
});

test('an existing database gains the history tables and keeps every row it had', opts, async () => {
  const path = tempDb();
  const first = new SnapshotDb(path);
  first.write(mkStore(['r::kept', 'r::also']), { commit: sha(2), sources: [{ name: 'r', commit: sha(2) }] });
  const digest = first.list()[0]!.digest;
  first.close();

  // emulate a database written before H1: the history tables simply are not there
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path);
  for (const t of ['commit', 'release']) raw.exec(`DROP TABLE "${t}"`);
  // a pre-H1 database has no H8 table either — the emulation has to be honest about its age
  for (const t of ['commit_file', 'commit_sync', 'sync_shot']) raw.exec(`DROP TABLE ${t}`);
  // nor the work-items tables (2026-09-30), which it gains the same additive way
  for (const t of ['commit_key', 'commit_branch', 'commit_node', 'commit_node_done', 'spine_read']) raw.exec(`DROP TABLE ${t}`);
  const tables = () =>
    (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name);
  assert.deepEqual(tables(), ['blind_spot', 'edge', 'node', 'snapshot', 'snapshot_source']);
  raw.close();

  // reopening migrates additively
  const db = new SnapshotDb(path);
  const back = db.read(1);
  assert.deepEqual(back.store.toJSON().nodes.map((n) => n.id).sort(), ['r::also', 'r::kept']);
  assert.equal(back.ref.digest, digest);
  assert.equal(db.list().length, 1);

  const written = db.writeCommits('r', chain(2));
  assert.deepEqual(written, { commits: 2, files: 2, linked: 1 });
  const spine = db.commitSpine('r');
  assert.equal(spine.commits, 2);
  assert.deepEqual(spine.rows[0]!.commits.map((c) => c.sha), [sha(2)]);
  assert.equal(spine.rows[0]!.commitKnown, true);
  db.close();

  const after = new DatabaseSync(path);
  assert.deepEqual(
    (after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name),
    ['blind_spot', 'commit', 'commit_branch', 'commit_file', 'commit_key', 'commit_node', 'commit_node_done', 'commit_sync', 'edge', 'node', 'release', 'snapshot', 'snapshot_source', 'spine_read', 'sync_shot'],
  );
  after.close();
});

test('writeCommits is idempotent, and a sync recorded after the history reads unindexed until it is linked', opts, () => {
  const db = new SnapshotDb(tempDb());
  db.write(mkStore(['r::a']), { commit: sha(1), sources: [{ name: 'r', commit: sha(1) }] });
  assert.deepEqual(db.writeCommits('r', chain(3)), { commits: 3, files: 3, linked: 1 });
  // re-reading the same history rewrites rows in place: no duplicate files, no new links
  assert.deepEqual(db.writeCommits('r', chain(3)), { commits: 3, files: 3, linked: 0 });
  assert.equal(db.historyRows('r').files.length, 3);

  // a sync recorded after the history run is not linked by write() — it links on the next
  // history run, or explicitly. Until then the commit honestly reads "not indexed".
  db.write(mkStore(['r::a', 'r::b']), { commit: sha(3), sources: [{ name: 'r', commit: sha(3) }] });
  assert.equal(db.commitSpine('r').unindexed, 2);
  assert.equal(db.linkCommitSyncs('r'), 1);
  assert.equal(db.linkCommitSyncs('r'), 0); // idempotent
  const spine = db.commitSpine('r');
  assert.equal(spine.unindexed, 1); // only c02 was never recorded
  assert.deepEqual(spine.rows.map((r) => r.commits.map((c) => c.sha)), [[sha(3), sha(2)], [sha(1)]]);
  db.close();
});

test('commitsBetween says why a range is partial instead of returning a silent zero', opts, () => {
  const db = new SnapshotDb(tempDb());
  db.write(mkStore(['r::a'])); // a sync with no commit at all (no git, or a dirty tree)
  db.write(mkStore(['r::a']), { commit: 'deadbeef', sources: [{ name: 'r', commit: 'deadbeef' }] }); // rewritten away
  db.write(mkStore(['r::a']), { commit: sha(4), sources: [{ name: 'r', commit: sha(4) }] });

  // before any history is read, every range says so — and says *only* that: naming
  // the head sha "not in this repository's history" would be a claim about the
  // repository drawn from an empty table (chunk H5's honesty fix)
  const dry = db.commitsBetween('r', 1, 3);
  assert.deepEqual(dry.incomplete, ['no-history', 'base-missing']);
  assert.ok(!dry.incomplete.includes('head-unknown'), 'nothing can be missing from a history nobody has read');
  assert.deepEqual(dry.commits, []);

  db.writeCommits('r', chain(4));
  assert.deepEqual(db.commitsBetween('r', 1, 3).incomplete, ['base-missing']);
  assert.deepEqual(db.commitsBetween('r', 2, 3).incomplete, ['base-unknown']); // sha no longer in the repository
  assert.deepEqual(db.commitsBetween('r', 3, 3).incomplete, []);
  assert.deepEqual(db.commitsBetween('r', 3, 3).commits, []); // base..base is empty
  // an unknown base end over-reaches to everything up to head — labelled, never silent
  assert.deepEqual(db.commitsBetween('r', 2, 3).commits.map((c) => c.sha), [4, 3, 2, 1].map(sha));
  // the spine is honest about the sync whose commit the repository no longer has
  assert.deepEqual(db.commitSpine('r').rows.map((r) => r.commitKnown), [true, false, false]);
  // a pruned or unknown sync still explains itself, as changedBetween does
  assert.throws(() => db.commitsBetween('r', 1, 99), /does not exist — latest is sync:3/);
  db.close();
});

test('spineOf: re-indexed syncs sweep nothing, side branches and later commits are not swallowed', () => {
  // c01…c04 linear, plus c05 on a side branch off c02, plus a merge c06 of c04 and c05
  const commits: CommitRow[] = [
    row(1),
    row(2, { indexed: true, syncs: [1] }),
    row(3),
    row(4, { indexed: true, syncs: [2, 3] }),
    row(5, { parents: [sha(2)] }),
    row(6, { parents: [sha(4), sha(5)], merge: true }),
  ];
  const spine = spineOf(
    [
      { sync: 1, at: at(10), commit: sha(2) },
      { sync: 2, at: at(11), commit: sha(4) },
      { sync: 3, at: at(12), commit: sha(4) }, // re-indexed on a newer build
    ],
    commits,
  );
  assert.deepEqual(spine.rows.map((r) => [r.sync, r.reindexed, r.commits.map((c) => c.sha)]), [
    [3, true, []], // nothing new to sweep
    [2, false, [sha(4), sha(3)]],
    [1, false, [sha(2)]],
  ]);
  assert.deepEqual(spine.before.map((c) => c.sha), [sha(1)]);
  // the merge and the side branch are not reachable from sync 3's commit — "committed since", not lost
  assert.deepEqual(spine.after.map((c) => c.sha), [sha(6), sha(5)]);
  assert.equal(spine.distinct, 2);
  assert.equal(spine.reindexed, 1);
  assert.equal(spine.unindexed, 4);

  // an unknown sync commit is stated, not treated as "no commits"
  const missing = spineOf([{ sync: 1, at: at(10), commit: 'nope' }, { sync: 2, at: at(11) }], commits);
  assert.deepEqual(missing.rows.map((r) => [r.sync, r.commitKnown, r.commits.length]), [[2, false, 0], [1, false, 0]]);

  // commitsInRange walks ancestry, not timestamps: the merge brings both parents' histories in
  assert.deepEqual(commitsInRange(commits, sha(2), sha(6)).map((c) => c.sha), [6, 5, 4, 3].map(sha));
  assert.deepEqual(commitsInRange(commits, sha(6), sha(6)), []);
  assert.deepEqual(commitsInRange(commits, undefined, sha(2)).map((c) => c.sha), [sha(2), sha(1)]);
  assert.deepEqual(commitsInRange(commits, sha(1), undefined), []);
});

test('attributeChanges: file-level, prefixed for a monorepo, absent when there is no history to claim from', () => {
  const commits: CommitRow[] = [row(1, { indexed: true, syncs: [1] }), row(2), row(3)];
  const files: FileChange[] = [
    { repo: 'r', sha: sha(1), path: 'apps/web/src/old.ts', status: 'added' },
    { repo: 'r', sha: sha(2), path: 'apps/web/src/a.ts', status: 'renamed', oldPath: 'apps/web/src/old.ts', similarity: 100 },
    { repo: 'r', sha: sha(3), path: 'apps/web/src/a.ts', status: 'modified', added: 4, deleted: 1 },
    { repo: 'r', sha: sha(3), path: 'apps/web/src/untouched-by-nobody.ts', status: 'modified' },
  ];
  const rows = { commits, files };
  const diff = {
    schema: 'farsight-diff v1',
    changes: [
      { id: 'c1', loc: { repo: 'r', path: 'src/a.ts', line: 3 } },
      { id: 'c2', loc: { repo: 'r', path: 'src/never.ts', line: 1 } },
      { id: 'c3', loc: { repo: 'other', path: 'src/a.ts', line: 1 } },
      { id: 'c4' },
    ],
  };
  const out = attributeChanges(diff, rows, { prefix: { r: 'apps/web' } });

  const byId = new Map(out.changes.map((c) => [c.id, c.attribution]));
  // newest first; the renaming commit attributes to both its paths, and the chain stops there —
  // c01 touched old.ts before the rename, and a path can be reused, so that claim is not made
  assert.deepEqual(byId.get('c1'), { commits: [sha(3), sha(2)], level: 'file', unindexed: 2 });
  // the repository has history and nothing in it touched that file — an earned empty list
  assert.deepEqual(byId.get('c2'), { commits: [], level: 'file', unindexed: 0 });
  // no history for that repository, so no claim at all (an empty list would read as the earned one)
  assert.equal(byId.get('c3'), undefined);
  assert.equal(byId.get('c4'), undefined); // nothing to join on without a file

  // the fold copies: the diff it was handed is untouched, which is why diff.ts never reads git
  assert.equal(out.schema, 'farsight-diff v1');
  assert.ok(!('attribution' in diff.changes[0]!));
  assert.notEqual(out.changes, diff.changes);

  // §8's trap: without the source's prefix the monorepo join silently finds nothing
  assert.deepEqual(attributeChanges(diff, rows).changes[0]!.attribution, { commits: [], level: 'file', unindexed: 0 });
  // one prefix for every repo is the single-source case
  assert.deepEqual(attributeChanges(diff, rows, { prefix: 'apps/web/' }).changes[0]!.attribution?.commits, [
    sha(3), sha(2),
  ]);
});

test('the range narrows the files, not the history: historyRows({ shas }) is what makes attribution "in this range"', opts, () => {
  // How `farsight diff --attribute` actually asks the question (chunk H4): the
  // file rows are cut to the commits between the two syncs, while the commit
  // list stays whole — it is what says which repositories have a history at all,
  // and which of the attributing commits no sync ever ingested.
  const db = new SnapshotDb(tempDb());
  const commits: CommitInput[] = Array.from({ length: 5 }, (_, k) => ({
    sha: sha(k + 1),
    at: at(k + 1),
    author: 'Ada',
    email: 'ada@example.com',
    subject: `edit ${k + 1}`,
    parents: k === 0 ? [] : [sha(k)],
    // one file, five times over — and the source is mounted at apps/web (§8)
    files: [{ path: 'apps/web/src/a.ts', status: 'modified' as const }],
  }));
  db.write(mkStore(['r::a']), { commit: sha(4), sources: [{ name: 'r', commit: sha(4) }] });
  db.writeCommits('r', commits);
  const diff = { changes: [{ id: 'c1', loc: { repo: 'r', path: 'src/a.ts', line: 1 } }] };

  const rows = db.historyRows('r', { shas: [sha(4), sha(5)] });
  assert.equal(rows.commits.length, 5, 'the whole history: who has one, and what of it was never ingested');
  assert.deepEqual([...new Set(rows.files.map((f) => f.sha))].sort(), [sha(4), sha(5)]);
  assert.deepEqual(
    attributeChanges(diff, rows, { prefix: { r: 'apps/web' } }).changes[0]!.attribution,
    // newest first; c04 is the one sync 1 recorded, so exactly one of the two is unindexed
    { commits: [sha(5), sha(4)], level: 'file', unindexed: 1 },
  );

  // an empty range over a history that exists is the earned empty list, not an absence
  assert.deepEqual(
    attributeChanges(diff, db.historyRows('r', { shas: [] }), { prefix: 'apps/web/' }).changes[0]!.attribution,
    { commits: [], level: 'file', unindexed: 0 },
  );
  // §8's trap on real rows: without the prefix the monorepo join finds nothing
  assert.deepEqual(attributeChanges(diff, rows).changes[0]!.attribution, { commits: [], level: 'file', unindexed: 0 });
  // a repository the history knows nothing about is never claimed about at all
  assert.equal(attributeChanges(diff, db.historyRows('other')).changes[0]!.attribution, undefined);
  db.close();
});

// ── the spine is per source, not per workspace ─────────────────────────────
// A snapshot carries two shas: the workspace root's on `snapshot`, and each
// source's own on `snapshot_source`. Folding the first for every source is the
// bug these three tests pin: in the dogfood store every `app-a`, `app-b`
// and `erp-api` row has a null per-source sha while the workspace column names
// *farsight*'s commits, so a spine built from the workspace column handed each
// of those repositories another repository's history.

/** A second repository's chain, so a borrowed sha is visibly not this repo's. */
const bsha = (i: number) => `b${String(i).padStart(2, '0')}`;
function bchain(n: number): CommitInput[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return {
      sha: bsha(i),
      at: at(20 + i),
      author: 'Grace',
      email: 'grace@example.com',
      subject: `api commit ${i}`,
      parents: i === 1 ? [] : [bsha(i - 1)],
      files: [{ path: `api/g${i}.ts`, status: 'modified' as const, added: 1, deleted: 0 }],
    };
  });
}

test('two sources, each recording its own sha: every spine returns its own repository\'s commits', opts, () => {
  const db = new SnapshotDb(tempDb());
  // three syncs of a two-source workspace whose root is `app`; `api` is a repository
  // of its own, so its commits share nothing with the workspace column
  for (const [i, pair] of ([[sha(2), bsha(1)], [sha(4), bsha(3)], [sha(5), bsha(3)]] as const).entries()) {
    const [app, api] = pair;
    db.write(mkStore([`r::v${i + 1}`]), {
      commit: app, // the workspace root's — `app`'s
      sources: [{ name: 'app', commit: app }, { name: 'api', commit: api }],
    });
  }
  db.writeCommits('app', chain(5));
  db.writeCommits('api', bchain(3));

  const app = db.commitSpine('app');
  const api = db.commitSpine('api');
  assert.deepEqual(app.rows.map((r) => r.commit), [sha(5), sha(4), sha(2)]);
  assert.deepEqual(api.rows.map((r) => r.commit), [bsha(3), bsha(3), bsha(1)]);
  assert.ok(app.rows.every((r) => r.commitFrom === 'source' && r.commitKnown));
  assert.ok(api.rows.every((r) => r.commitFrom === 'source' && r.commitKnown));
  assert.equal(app.withoutCommit, 0);
  assert.equal(api.withoutCommit, 0);

  // each spine sweeps its own ancestry: `api` never sees an `app` sha and vice versa
  assert.deepEqual(app.rows.map((r) => r.commits.map((c) => c.sha)), [[sha(5)], [sha(4), sha(3)], [sha(2)]]);
  assert.deepEqual(api.rows.map((r) => r.commits.map((c) => c.sha)), [[], [bsha(3), bsha(2)], [bsha(1)]]);
  assert.equal(api.reindexed, 1); // sync 3 re-indexed `api` at the same commit — a fact about `api`
  assert.equal(app.reindexed, 0); // …while `app` moved on, which the workspace column alone could not say
  assert.deepEqual(app.before.map((c) => c.sha), [sha(1)]);
  assert.deepEqual(api.before, []);
  assert.equal(api.distinct, 2);
  assert.equal(api.unindexed, 1); // b02 sits in the gap between sync 1 and sync 2

  // and a range over the same syncs names each repository's own ends
  const range = db.commitsBetween('api', 1, 2);
  assert.equal(range.baseCommit, bsha(1));
  assert.equal(range.headCommit, bsha(3));
  assert.deepEqual(range.commits.map((c) => c.sha), [bsha(3), bsha(2)]);
  assert.deepEqual(range.incomplete, []);
  // `unindexed` agrees with the spine: the same commit, counted once, from the same join
  assert.deepEqual(db.unindexed('api').map((c) => c.sha), [bsha(2)]);
  assert.deepEqual(db.unindexed('app').map((c) => c.sha), [sha(3), sha(1)]);
  db.close();
});

test('a null per-source sha reads as absent — the workspace sha is never borrowed for another repository', opts, () => {
  const db = new SnapshotDb(tempDb());
  // the shape of every row written before the writers stamped a per-source sha:
  // the workspace column names `app`'s commits, `api`'s own column is null
  for (const commit of [sha(2), sha(4), sha(5)]) {
    db.write(mkStore(['r::a']), {
      commit,
      sources: [{ name: 'app', files: 3, status: 'ok' }, { name: 'api', files: 2, status: 'ok' }],
    });
  }
  db.writeCommits('api', bchain(3));

  const api = db.commitSpine('api');
  assert.deepEqual(api.rows.map((r) => r.sync), [3, 2, 1]);
  assert.ok(api.rows.every((r) => r.commit === undefined), 'no row may carry a sha this repository never recorded');
  assert.ok(api.rows.every((r) => r.commitFrom === undefined && r.commitKnown === false));
  assert.equal(api.withoutCommit, 3); // an absence with a count…
  assert.equal(api.distinct, 0);
  // …and every number derived from such a row is absent too: nothing was swept, because
  // nothing is known to have been swept (the CLI prints these as "—", never 0)
  assert.ok(api.rows.every((r) => r.commits.length === 0 && r.unindexed === 0));
  assert.deepEqual(api.before, []);
  assert.deepEqual(api.after.map((c) => c.sha), [bsha(3), bsha(2), bsha(1)]);
  assert.equal(api.unindexed, 3, 'no sync recorded any of them, and that is what `indexed` says');

  // a range says which end is missing rather than over-reaching into another history
  const range = db.commitsBetween('api', 1, 3);
  assert.equal(range.baseCommit, undefined);
  assert.equal(range.headCommit, undefined);
  assert.deepEqual(range.incomplete, ['base-missing', 'head-missing']);
  assert.deepEqual(range.commits, []);

  // the workspace root's own source is the one case the workspace sha may be folded — and
  // only once this repository's history proves the sha is its own. Before it is read, absent:
  assert.ok(db.commitSpine('app').rows.every((r) => r.commit === undefined));
  db.writeCommits('app', chain(5));
  const app = db.commitSpine('app');
  assert.deepEqual(app.rows.map((r) => [r.commit, r.commitFrom, r.commitKnown]), [
    [sha(5), 'workspace', true],
    [sha(4), 'workspace', true],
    [sha(2), 'workspace', true],
  ]);
  assert.equal(app.withoutCommit, 0);
  assert.deepEqual(app.rows.map((r) => r.commits.map((c) => c.sha)), [[sha(5)], [sha(4), sha(3)], [sha(2)]]);
  db.close();
});

test('linkCommitSyncs still counts both columns: a workspace sha links only where that repository has the commit', opts, () => {
  const db = new SnapshotDb(tempDb());
  // sync 1 records only the workspace sha; sync 2 records `api`'s own beside it
  db.write(mkStore(['r::a']), { commit: sha(2), sources: [{ name: 'app' }, { name: 'api' }] });
  db.write(mkStore(['r::b']), { commit: sha(4), sources: [{ name: 'app' }, { name: 'api', commit: bsha(2) }] });

  // the workspace column links for the repository that *has* those commits…
  assert.deepEqual(db.writeCommits('app', chain(5)), { commits: 5, files: 5, linked: 2 });
  // …and for the other repository only its own column matches: `app`'s shas are not in its history
  assert.deepEqual(db.writeCommits('api', bchain(3)), { commits: 3, files: 3, linked: 1 });
  assert.equal(db.linkCommitSyncs('app'), 0); // idempotent, as before
  assert.equal(db.linkCommitSyncs('api'), 0);

  const indexed = (repo: string) =>
    db.historyRows(repo).commits.filter((c) => c.indexed).map((c) => [c.sha, c.syncs] as const);
  assert.deepEqual(indexed('app'), [[sha(4), [2]], [sha(2), [1]]]);
  assert.deepEqual(indexed('api'), [[bsha(2), [2]]]);
  // and what the join says is indexed, the spine can name — the two use the same identity test
  const app = db.commitSpine('app');
  assert.deepEqual(app.rows.map((r) => r.commit), [sha(4), sha(2)]);
  assert.deepEqual(db.commitSpine('api').rows.map((r) => r.commit), [bsha(2), undefined]);
  assert.deepEqual(db.unindexed('api').map((c) => c.sha), [bsha(3), bsha(1)]);
  db.close();
});

// ── the third row state: not in this sync vs in it and no commit (chunk H5) ──
//
// H3b left this open: a source that was *not part of a sync* and one that was and
// recorded no commit both arrive as an absent `commit`, and the store can tell them
// apart. It matters because only one of them is a gap in what Farsight stamped —
// the other is a source nobody asked the sync to walk, and telling it to "re-sync to
// record it from now on" is advice for the other case. Measured on the dogfood store,
// 11 of one source's 34 spine rows are the first kind and 23 the second.

test('a sync that did not walk a source says so, and a sync that walked it and stamped nothing says that', opts, () => {
  const db = new SnapshotDb(tempDb());
  // sync 1: both sources walked, only `app` stamped a commit
  db.write(mkStore(['r::a']), { commit: sha(2), sources: [{ name: 'app', commit: sha(2) }, { name: 'api', files: 2 }] });
  // sync 2: `api` was not part of it at all
  db.write(mkStore(['r::a', 'r::b']), { commit: sha(4), sources: [{ name: 'app', commit: sha(4) }] });
  // sync 3: no source rows whatsoever — the question has no answer for either source
  db.write(mkStore(['r::a', 'r::b', 'r::c']), { commit: sha(5) });
  db.writeCommits('api', bchain(2));

  const api = db.commitSpine('api');
  assert.deepEqual(api.rows.map((r) => r.sync), [3, 2, 1]);
  assert.deepEqual(api.rows.map((r) => r.inSync), [undefined, false, true],
    'absent when unanswerable, false when the sync walked other sources and not this one, true when it walked this one');
  assert.ok(api.rows.every((r) => r.commit === undefined), 'none of these rows may borrow the workspace sha');
  assert.equal(api.withoutCommit, 3);
  assert.equal(api.notInSync, 1, 'exactly one of the three absences is "this sync did not include it"');
  assert.deepEqual(api.rows.map((r) => spineRowNote(r).kind), ['no-commit', 'not-in-sync', 'no-commit'],
    'an unanswerable row does not get the negative word');

  // and the whole-spine sentence carries the split rather than one number for three situations
  assert.match(spineSentences(api).syncs!.text, /3 recorded no commit for this repository \(1 did not include it at all\)/);
  // every sync here stamped `app`'s commit, so its rows are answered and none of them is absent
  const app = db.commitSpine('app');
  assert.deepEqual(app.rows.map((r) => r.inSync), [undefined, true, true]);
  assert.equal(app.notInSync, 0);
  db.close();
});

test('a source no sync ever walked is told that it was never walked, not that a stamp is missing', opts, () => {
  const db = new SnapshotDb(tempDb());
  for (const commit of [sha(2), sha(3)]) db.write(mkStore(['r::a']), { commit, sources: [{ name: 'app', commit }] });
  db.writeCommits('api', bchain(2));
  const api = db.commitSpine('api');
  assert.equal(api.notInSync, 2);
  const said = spineSentences(api);
  assert.match(said.noneRecorded!.text, /not one of the 2 syncs included this repository/);
  assert.doesNotMatch(said.noneRecorded!.text, /cannot be backfilled/,
    'nothing failed to be stamped here, so nothing needs backfilling');
  // the other case keeps the backfill sentence: the syncs walked it and stamped nothing
  const db2 = new SnapshotDb(tempDb());
  for (const commit of [sha(2), sha(3)]) db2.write(mkStore(['r::a']), { commit, sources: [{ name: 'app', commit }, { name: 'api' }] });
  db2.writeCommits('api', bchain(2));
  const walked = db2.commitSpine('api');
  assert.equal(walked.notInSync, 0);
  assert.match(spineSentences(walked).noneRecorded!.text, /an existing row cannot be backfilled/);
  db.close();
  db2.close();
});

// ── absent vs empty: a history nobody has read (chunk H5's honesty fix) ──────
//
// The defect this pins was found on live data: with **zero** commit rows for a
// repository, every containment check fails, and reporting that failure as
// "this commit is not in the repository's history" turns a fact about the store
// into a finding about the repository. Sixteen of the reference app's spine rows read
// `commit-unknown` and nineteen read `no-commit` before anyone had run
// `farsight history`; all thirty-five of those claims were false. A fixture with
// a history always present cannot see it, so these tests have none.

test('with no commits read, no row claims a commit is missing and no count is a measurement', () => {
  const snaps: SpineSnapshot[] = [
    // a sync that stamped this source's own sha
    { sync: 1, at: at(10), commit: sha(2), commitFrom: 'source', inSync: true },
    // a sync that stamped only the workspace root's, which cannot be checked yet
    { sync: 2, at: at(20), commitUnverified: 'w0rkspace', inSync: true },
    // …and one that did not walk this source at all: its absence is not about history
    { sync: 3, at: at(30), inSync: false },
  ];
  const dry = spineOf(snaps, []);
  assert.equal(dry.historyRead, false);
  assert.equal(dry.bound, 'floor', 'every count over an unread history is a floor');
  assert.deepEqual(dry.rows.map((r) => r.commitState), ['not-in-sync', 'history-unread', 'history-unread']);
  assert.deepEqual(dry.rows.map((r) => spineRowNote(r).kind), ['not-in-sync', 'history-unread', 'history-unread']);
  // the two claims the defect made, now impossible
  assert.ok(!dry.rows.some((r) => spineRowNote(r).kind === 'commit-unknown'),
    'nothing can be missing from a history nobody has read');
  assert.ok(!dry.rows.some((r) => spineRowNote(r).kind === 'no-commit'),
    'a sync that stamped a sha did not fail to record one');
  // null where a sha exists and cannot be checked; false where there is no sha to
  // place at all — and that `false` does not change when a history is read, because
  // nothing about the row changed
  assert.deepEqual(dry.rows.map((r) => r.commitKnown), [false, null, null]);
  assert.equal(dry.withoutCommit, 1, 'only the sync that did not walk this source');
  assert.equal(dry.withoutHistory, 2, 'and the unplaceable rows are their own number');
  assert.equal(dry.unverified, 1);
  assert.match(spineSentences(dry).historyUnread!.text, /no history has been read for this repository/);
  assert.match(spineSentences(dry).historyUnread!.text, /every count below is a floor/);
  assert.match(spineSentences(dry).historyUnread!.text, /1 of these syncs recorded only the workspace root's commit/);

  // …and once the history is read, the same rows resolve. Provenance is re-decided by
  // `SnapshotDb.sourceSpine`, which promotes an unverifiable workspace sha to this
  // repository's commit exactly when the history now contains it — so the read-side
  // input carries `commit`/`commitFrom` where the dry one carried `commitUnverified`.
  // The store test below proves that promotion against a real database.
  const readSnaps: SpineSnapshot[] = [
    snaps[0]!,
    { sync: 2, at: at(20), commit: 'w0rkspace', commitFrom: 'workspace', inSync: true },
    snaps[2]!,
  ];
  const read = spineOf(readSnaps, [
    row(1, { indexed: false }),
    row(2, { indexed: true, syncs: [1] }),
    { repo: 'r', sha: 'w0rkspace', at: at(3), author: 'a', email: 'e', subject: 'the workspace commit', parents: [sha(2)], merge: false, indexed: true, syncs: [2] },
  ]);
  assert.equal(read.historyRead, true);
  assert.equal(read.bound, 'exact');
  assert.deepEqual(read.rows.map((r) => r.commitState), ['not-in-sync', 'recorded', 'recorded']);
  assert.deepEqual(read.rows.map((r) => spineRowNote(r).kind), ['not-in-sync', 'subject', 'subject']);
  assert.deepEqual(read.rows.map((r) => r.commitKnown), [false, true, true]);
  assert.equal(read.withoutHistory, 0);
  assert.equal(read.unverified, 0);
  assert.equal(spineSentences(read).historyUnread, undefined);
  // the reindex count is the same either way: whether two syncs recorded the same sha
  // is a fact about the snapshot table, and reading a history must not change it
  assert.equal(dry.reindexed, read.reindexed);
});

test('the store: an unread history says so, and reading it resolves every row — the reference app\'s exact shape', opts, () => {
  const db = new SnapshotDb(tempDb());
  // sync 1 stamps this source's own sha; syncs 2 and 3 stamp only the workspace
  // root's (the shape every row written before per-source stamping is in, and the
  // shape 19 of the reference app's 53 rows are in)
  db.write(mkStore(['r::a']), { commit: sha(2), sources: [{ name: 'app', commit: sha(2) }] });
  db.write(mkStore(['r::a', 'r::b']), { commit: sha(4), sources: [{ name: 'app', files: 2 }] });
  db.write(mkStore(['r::a', 'r::b', 'r::c']), { commit: sha(4), sources: [{ name: 'app', files: 2 }] });

  const dry = db.commitSpine('app');
  assert.equal(dry.historyRead, false, 'no commit rows have been written for this repository');
  assert.equal(dry.bound, 'floor');
  assert.deepEqual(dry.rows.map((r) => r.commitState), ['history-unread', 'history-unread', 'history-unread']);
  // `history-unread` outranks `reindexed`: syncs 2 and 3 recorded the same sha, but
  // "no new commits" is a claim about this repository's code and the sha may not even
  // be this repository's until a history says so
  assert.deepEqual(dry.rows.map((r) => spineRowNote(r).kind), ['history-unread', 'history-unread', 'history-unread']);
  assert.equal(dry.withoutCommit, 0, 'not one of these syncs failed to record a commit');
  assert.equal(dry.withoutHistory, 3);
  assert.equal(dry.unverified, 2, 'the two workspace-sha rows');
  assert.deepEqual(dry.rows.map((r) => r.swept ?? null), [null, null, null]);
  assert.deepEqual(dry.rows.map((r) => r.commitKnown), [null, null, null]);

  // now read the history — the two workspace-sha rows are this repository's commits
  // by identity, and every row can be placed
  db.writeCommits('app', chain(4));
  const read = db.commitSpine('app');
  assert.equal(read.historyRead, true);
  assert.equal(read.bound, 'exact');
  assert.deepEqual(read.rows.map((r) => r.commitFrom), ['workspace', 'workspace', 'source']);
  assert.deepEqual(read.rows.map((r) => r.commitState), ['recorded', 'recorded', 'recorded']);
  assert.deepEqual(read.rows.map((r) => spineRowNote(r).kind), ['reindexed', 'subject', 'subject']);
  assert.equal(read.withoutCommit, 0);
  assert.equal(read.withoutHistory, 0);
  assert.equal(read.unverified, 0);
  assert.deepEqual(read.rows.map((r) => r.commitKnown), [true, true, true]);
  // the numbers that were unanswerable are now answered, and the one that was
  // always knowable did not move
  assert.equal(read.reindexed, dry.reindexed, 'sha equality is a snapshot-table fact either way');
  assert.equal(read.commits, 4);
  assert.equal(read.unindexed, 2); // c01 and c03: never recorded by any sync
  db.close();
});

test('a sync older than the oldest commit read is below the floor, not missing', () => {
  // the history was read, but bounded (`--max` / `--since` / a shallow clone): the
  // sync's commit is older than anything the walk reached, so it is unread, not gone
  const commits = [row(3, { indexed: true, syncs: [2] }), row(4, { indexed: false })];
  const spine = spineOf([
    { sync: 1, at: at(0), commit: 'ancient', commitFrom: 'source', inSync: true },
    { sync: 2, at: at(30), commit: sha(3), commitFrom: 'source', inSync: true },
  ], commits);
  const old = spine.rows.find((r) => r.sync === 1)!;
  assert.equal(old.commitState, 'below-floor');
  assert.equal(spineRowNote(old).kind, 'commit-below-floor');
  assert.match(spineRowNote(old).text, /read further back/);
  assert.ok(!/rewritten/.test(spineRowNote(old).text), 'the read window is not the repository rewriting itself');
  assert.match(spineSentences(spine).belowFloor!.text, /those commits are unread, not missing/);
  // a sync *within* the read window whose sha is genuinely absent keeps §8's finding
  const rewritten = spineOf([{ sync: 9, at: at(40), commit: 'gone', commitFrom: 'source', inSync: true }], commits);
  assert.equal(rewritten.rows[0]!.commitState, 'not-in-history');
  assert.equal(spineRowNote(rewritten.rows[0]!).kind, 'commit-unknown');
});

// ── the changes words (chunk H6) ────────────────────────────────────────────
// The catalog is the vocabulary the Changes surface draws with, so these assert
// the two things that can rot silently: a word per value the core switches on
// (add a seventh row state and this fails, which is the point), and the rules the
// phase fixed — the six absence words stay closed, history gets no evidence chip,
// and every changes word carries the `define` the grammar book renders.

test('every state the spine can be in has a word, and every word defines itself', () => {
  const states: SpineCommitState[] = ['recorded', 'not-in-history', 'below-floor', 'history-unread', 'none', 'not-in-sync'];
  const forState: Record<SpineCommitState, string> = {
    recorded: 'changes.state.recorded',
    'not-in-history': 'changes.state.notInHistory',
    'below-floor': 'changes.state.belowFloor',
    'history-unread': 'changes.state.historyUnread',
    none: 'changes.state.noCommit',
    'not-in-sync': 'changes.state.notInSync',
  };
  const words = new Set<string>();
  for (const s of states) {
    const entry = STRINGS[forState[s]];
    assert.ok(entry, `no word for the ${s} state — a reader cannot tell it from the other five`);
    assert.ok(entry!.define, `${forState[s]} has no define; the grammar book would render a blank`);
    words.add(entry!.professional);
  }
  assert.equal(words.size, states.length, 'two states share a word — five of six reasons would be invisible');
  // the seventh note kind is not a state: a re-index is a relation between two rows
  assert.ok(STRINGS['changes.reindexed']?.define);
});

test('the changes words keep the phase rules: six absence words, no evidence chip, always defined', () => {
  const keys = Object.keys(STRINGS).filter((k) => k.startsWith('changes.'));
  assert.ok(keys.length > 20, 'the block is missing');
  for (const k of keys) assert.ok(STRINGS[k]!.define, `${k} ships without a define`);
  // the six absence words are closed — history takes `not indexed`, not a seventh
  const absence = Object.keys(STRINGS).filter((k) => /^journey\.absent\.[a-zA-Z]+$/.test(k));
  assert.equal(absence.length, 6, 'the absence words are closed at six');
  assert.match(STRINGS['journey.absent.notIndexed']!.define!, /commit no sync ever ingested/);
  assert.ok(!keys.some((k) => /absent|evidence/i.test(k)), 'history mints neither an absence word nor an evidence chip');
  // `action · beat · step` belong to the journey; a history has no beats
  for (const k of keys) {
    for (const register of ['hud', 'professional'] as const) {
      assert.ok(!/\b(beats?|moments?|seams?)\b/i.test(STRINGS[k]![register]), `${k} borrows a journey unit`);
    }
  }
  // the placeholders this block retires are gone, so no surface can print them
  assert.deepEqual(Object.keys(STRINGS).filter((k) => k.startsWith('ph.changes')), []);
});
