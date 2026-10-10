/**
 * History folds — the pure half of the change-history lens
 * (docs/proposals/change-history-2026-09.md §1, §2).
 *
 * A commit is **not** graph content: no `commit` node kind, no `changed` edge,
 * no field on a node, and `digestOf()` is untouched — the graph must not report
 * itself changed when only the history moved. History lives in four tables
 * beside the snapshot spine (`snapshots.ts`), and everything a consumer sees is
 * a fold over those rows plus the snapshot list.
 *
 * Two honesty rules are encoded in the types here, not left to the caller:
 *
 * 1. **Provenance is file-level.** A {@link FileChange} is about a *path* in a
 *    repository. There is deliberately no way to say "this function changed in
 *    commit X": for three quarters of a repository's commits no sync ever built
 *    a graph, so node-level claims are unknowable (§2).
 * 2. **Not indexed is a fact, not an absence.** A commit with no `commit_sync`
 *    row carries `indexed: false` and an empty `syncs` list, so a consumer
 *    renders *not indexed* instead of inferring silence.
 *
 * Pure by contract: no `git`, no `node:child_process`, no file reads. Running
 * git lives in `parsers/src/shared/git.ts`; reading and writing the rows lives
 * in `SnapshotDb`.
 */
import { counted, countKey, type Counted } from './counts.js';
import { t, type Register } from './strings.js';

/** `--name-status` / `--numstat` classification of one path in one commit. */
export type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'unmerged'
  | 'unknown';

/**
 * One commit of one repository, as Farsight can know it: repository facts only
 * (`git log`), plus whether any sync ever read the code at it.
 */
export interface CommitRow {
  repo: string;
  sha: string;
  /** Author time, ISO 8601. */
  at: string;
  author: string;
  email: string;
  subject: string;
  /** Parent shas in git's order; length > 1 is a merge. */
  parents: string[];
  merge: boolean;
  /**
   * A fact read from `commit_sync`, never inferred: some sync recorded this
   * commit as the code it parsed. `false` renders as *not indexed* — Farsight
   * can name the files this commit touched, not what it did to the graph.
   */
  indexed: boolean;
  /** The syncs that recorded this commit, ascending. Empty when not indexed. */
  syncs: number[];
}

/**
 * One file a commit touched. **File-level provenance**: this row is about a
 * path, never about a node. `oldPath` and `similarity` come from `-M`, so a
 * rename can be reported as *the same file under a new path* without anyone
 * pretending to fingerprint a function.
 */
export interface FileChange {
  repo: string;
  sha: string;
  /** Repository-root-relative, as git prints it (see {@link AttributeOptions.prefix}). */
  path: string;
  status: FileStatus;
  /** The path before a rename/copy (`-M`). */
  oldPath?: string;
  added?: number;
  deleted?: number;
  /** Rename/copy similarity score 0-100 from `-M`; 100 is byte-identical. */
  similarity?: number;
}

/**
 * What a history reader (`parsers/src/shared/git.ts`, chunk H2) hands to
 * `SnapshotDb.writeCommits()`: repository facts only. `indexed` is absent by
 * design — whether a sync recorded a commit is the store's to know, from
 * `commit_sync`, and no reader may assert it.
 */
export interface CommitInput {
  sha: string;
  /** Author time, ISO 8601. */
  at: string;
  author?: string;
  email?: string;
  subject?: string;
  parents?: string[];
  /** Defaults to `parents.length > 1`. */
  merge?: boolean;
  /** The files this commit touched — file-level provenance, see {@link FileChange}. */
  files?: readonly Omit<FileChange, 'repo' | 'sha'>[];
  /** Work-item keys the commit names, and how (core/work-graph.ts `commitKeysOf`). Absent = not read; `[]` = read, none. */
  keys?: readonly { key: string; provider: string; via: string; ref?: string }[];
  /** Key-bearing branches that carry this commit (parsers git.ts `GitCommit.branches`). */
  branches?: readonly string[];
}

/** Why a commit range can only be partial — rendered, never swallowed (§8). */
export type IncompleteReason =
  | 'no-history' // no commits recorded for this repo yet — run `farsight history`
  | 'base-missing' // the base sync recorded no commit sha
  | 'head-missing' // the head sync recorded no commit sha
  | 'base-unknown' // the base sync's commit is not in the history (rewritten, or not read)
  | 'head-unknown';

/** `base..head` over two syncs — the git narrative beside the measured diff, never merged into it. */
export interface CommitRange {
  repo: string;
  base: number;
  head: number;
  baseCommit?: string;
  headCommit?: string;
  /** The commits between the two syncs' commits, newest first. */
  commits: CommitRow[];
  /** How many of `commits` no sync ever recorded. */
  unindexed: number;
  /** Empty when both ends are commits Farsight knows. */
  incomplete: IncompleteReason[];
}

/**
 * Where a spine row's commit was read from. The distinction is the point: a
 * multi-source workspace records the **workspace root's** sha on `snapshot` and
 * each source's own on `snapshot_source`, so folding the first for every source
 * hands one repository another's commits (measured: every per-source sha in the
 * dogfood store was null for `app-a`, `app-b` and `erp-api`).
 */
export type CommitProvenance =
  /** `snapshot_source.commit_sha` — this sync recorded this commit *for this source*. */
  | 'source'
  /**
   * `snapshot.commit_sha` — the workspace root's commit, used only because this
   * repository's own history contains that sha, which makes it this
   * repository's commit as a matter of identity (a sha names one commit
   * globally). Never a borrowed sha from a repository that does not have it.
   */
  | 'workspace';

/**
 * The snapshot facts `spineOf()` needs, **already resolved to one repository**:
 * `commit` is that repository's commit at the sync and `commitFrom` says where
 * it was read from. `SnapshotDb.commitSpine()` resolves both per source;
 * `SnapshotListing` also satisfies the shape, but it carries the workspace
 * root's sha, so passing one is right only for the workspace root's own source.
 */
export interface SpineSnapshot {
  sync: number;
  at: string;
  /** Absent means *this sync recorded no commit for this repository*. */
  commit?: string;
  commitFrom?: CommitProvenance;
  /**
   * The workspace root's sha this sync recorded, when it can be **neither**
   * folded as this repository's commit **nor** ruled out — because no history
   * has been read for this repository, so the containment test that decides it
   * (see {@link CommitProvenance}) has nothing to run against.
   *
   * It is deliberately not `commit`: folding it would borrow another
   * repository's sha on faith, which is exactly what the per-source spine
   * exists to prevent. It is deliberately not absent either: reporting *this
   * sync recorded no commit* would be a finding about the sync, when the only
   * fact available is about the store. Offered only where the sync did not
   * demonstrably exclude this source.
   */
  commitUnverified?: string;
  /**
   * Whether this repository took part in the sync at all — the third row state
   * (chunk H5). A sync records one `snapshot_source` row per source it walked,
   * so `true` means a row named this repository, `false` means the sync
   * recorded source rows and **none** of them did (the source was disabled, or
   * had not been added yet), and **absent** means the sync recorded no source
   * rows at all, which makes the question unanswerable rather than negative.
   *
   * It exists because *not in this sync* and *in this sync, no commit recorded*
   * are different facts that both arrive as an absent `commit`, and only one of
   * them is a gap in what Farsight stamped.
   */
  inSync?: boolean;
  /** this repository's content digest at the sync, when the sync recorded one per source */
  sourceDigest?: string;
}

/**
 * What is known about the commit a sync recorded for one repository. One word,
 * so a consumer switches on it instead of inferring from three absent fields —
 * and so the two reasons a commit cannot be placed can never be drawn as one.
 */
export type SpineCommitState =
  /** A commit for this repository, and this repository's history contains it. */
  | 'recorded'
  /**
   * The history **was** read and does not contain the sha this sync recorded:
   * rewritten, pruned, or a branch nothing here can see (§8). A finding about
   * the repository, and only sayable once there is a history to miss it from.
   */
  | 'not-in-history'
  /**
   * Read, not contained, and the sync predates the oldest commit read — so the
   * miss is the **read window**, not the repository. `--max` / `--since` bounded
   * the walk, or the clone is shallow and cannot go further back.
   */
  | 'below-floor'
  /**
   * No commit rows exist for this repository at all, so containment cannot be
   * asked. Every number derived from placing this row is absent, not zero.
   */
  | 'history-unread'
  /** The sync walked this source and recorded no commit for it — a real gap in what was stamped. */
  | 'none'
  /** The sync did not walk this source, so it never had a commit to stamp. */
  | 'not-in-sync';

/** One sync on the spine, with the commits it swept up since the previous sync. */
export interface SpineRow {
  sync: number;
  at: string;
  /**
   * The commit this sync recorded **for this repository**, when it recorded one.
   * Absent reads *this sync recorded no commit for this repo* — an absence, not
   * a zero, and never another repository's sha.
   */
  commit?: string;
  /** Where `commit` came from; absent exactly when `commit` is. */
  commitFrom?: CommitProvenance;
  /** See {@link SpineSnapshot.inSync}: did this repository take part in the sync. */
  inSync?: boolean;
  /** See {@link SpineSnapshot.commitUnverified}. Present only in the `history-unread` state. */
  commitUnverified?: string;
  /** What is known about this row's commit, in one word — the field to switch on. */
  commitState: SpineCommitState;
  /**
   * Is this sync's commit one this repository's history contains? `false` is a
   * finding about the repository (rewritten, pruned, or on no branch read);
   * **`null` means the question could not be asked** — no history has been read
   * for this repository, so an empty commit table would make every containment
   * check fail and the failure would be reported as a missing commit. Absent
   * and empty are different facts, and this is where they part.
   */
  commitKnown: boolean | null;
  /**
   * This sync's commit equals the previous (older) sync's: *re-indexed on a
   * newer build — no new commits*. 33 of the reference app's 48 syncs.
   */
  reindexed: boolean;
  /**
   * A re-index whose files differ: the same commit as the previous sync, and
   * both recorded this repository's content digest, and the two differ — the
   * working tree differed from HEAD, and uncommitted edits were read. Absent
   * where either sync recorded no digest (every sync before per-source digests),
   * because a re-index and an edit then look the same.
   */
  treeChanged?: true;
  /**
   * `previous..this` in git terms — the commits this sync swept up, newest
   * first, including its own. Empty on a re-index.
   */
  commits: CommitRow[];
  /** How many of `commits` no sync ever recorded. */
  unindexed: number;
}

/** The whole spine: syncs newest first, plus the commits no sync bracketed. */
export interface CommitSpine {
  rows: SpineRow[];
  /**
   * Commits older than the oldest sync's commit — before Farsight watched this
   * repository at all. Newest first. 10 on the reference app.
   */
  before: CommitRow[];
  /**
   * Commits not reachable from the newest sync's commit: committed since it, or
   * on a branch no sync recorded. Newest first.
   */
  after: CommitRow[];
  /** Commits known to Farsight for this repository. */
  commits: number;
  /** Of those, how many have no `commit_sync` row at all. 51 on the reference app. */
  unindexed: number;
  /** How many distinct commits the syncs recorded. 15 across the reference app's 48 syncs. */
  distinct: number;
  /** Syncs whose commit equals their predecessor's. 33 on the reference app. */
  reindexed: number;
  /**
   * Syncs that recorded no commit for this repository — a count of absent rows,
   * which is not the same as a repository with no commits. Every per-row number
   * derived from such a row (what it swept, how much of that was unindexed) is
   * absent too, not zero.
   *
   * It counts only rows where the absence is a **fact about the sync**: states
   * `none` and `not-in-sync`. A row whose commit is unplaceable because no
   * history has been read is counted by {@link withoutHistory} instead, so no
   * consumer can draw one as the other.
   */
  withoutCommit: number;
  /**
   * Has any commit been read for this repository? When false, every containment
   * question is unanswerable and every count here is a **floor**
   * ({@link bound}) — run `farsight history` for this source.
   */
  historyRead: boolean;
  /**
   * Rows in the `history-unread` state: their commit cannot be placed for want
   * of a history read, not because a sync failed to record one. Its own number,
   * never folded into {@link withoutCommit}.
   */
  withoutHistory: number;
  /**
   * Of those, how many carry only the workspace root's sha — a commit that may
   * or may not be this repository's, and cannot be checked until a history is
   * read ({@link SpineSnapshot.commitUnverified}).
   */
  unverified: number;
  /**
   * `exact` when every number here rests on a history that was read; `floor`
   * when it does not, in the same sense `computeMetric` means it — the real
   * figures are at least these. Reading the history is what turns it exact.
   */
  bound: 'floor' | 'exact';
  /**
   * Of the syncs with no commit for this repository, how many did not include
   * it at all (`inSync === false`). The remainder either included it and
   * stamped no commit, or predate per-source stamping entirely — an absence
   * with a reason rather than one number standing for three situations.
   */
  notInSync: number;
}

/** Index commits by sha for ancestry walks. */
function bySha(commits: readonly CommitRow[]): Map<string, CommitRow> {
  const map = new Map<string, CommitRow>();
  for (const c of commits) map.set(c.sha, c);
  return map;
}

/** Newest first by author time, sha as the tiebreak (same-second commits are normal). */
function newestFirst(commits: readonly CommitRow[]): CommitRow[] {
  return [...commits].sort((a, b) => (a.at === b.at ? a.sha.localeCompare(b.sha) : a.at < b.at ? 1 : -1));
}

/** Every commit reachable from `sha` through `parents`, including itself. */
function ancestors(map: Map<string, CommitRow>, sha: string | undefined): Set<string> {
  const seen = new Set<string>();
  if (!sha) return seen;
  const stack = [sha];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    const row = map.get(s);
    if (row) for (const p of row.parents) if (!seen.has(p)) stack.push(p);
  }
  return seen;
}

/**
 * `base..head` — every commit reachable from `head` and not from `base`, newest
 * first. Ancestry, not a timestamp window: consecutive commits share a second
 * often enough (the reference app has three in one) that ordering by `at` alone would
 * misattribute them. An unknown `base` yields everything reachable from `head`;
 * an unknown `head` yields nothing.
 */
export function commitsInRange(
  commits: readonly CommitRow[],
  base: string | undefined,
  head: string | undefined,
): CommitRow[] {
  const map = bySha(commits);
  const stop = ancestors(map, base);
  const reach = ancestors(map, head);
  const out: CommitRow[] = [];
  for (const sha of reach) {
    if (stop.has(sha)) continue;
    const row = map.get(sha);
    if (row) out.push(row); // an unknown parent sha contributes no row, never a placeholder
  }
  return newestFirst(out);
}

/**
 * Fold the snapshot list and one repository's commits into the Changes spine
 * (§4-A): syncs newest first, each carrying the commits it swept up, plus the
 * commits no sync bracketed on either end. Pure — both inputs are already-read
 * rows.
 *
 * `snapshots` may arrive in any order; the fold sorts by sync. Commits are the
 * repository's, filtered by the caller.
 */
export function spineOf(snapshots: readonly SpineSnapshot[], commits: readonly CommitRow[]): CommitSpine {
  const map = bySha(commits);
  const ascending = [...snapshots].sort((a, b) => a.sync - b.sync);
  const rows: SpineRow[] = [];
  let reindexed = 0;
  // Nothing read means nothing can be asked. An empty commit table makes every
  // containment check fail, and reporting that failure as *this commit is not in
  // the repository* would be a finding about the repository drawn from a fact
  // about the store — the defect this branch exists to prevent.
  const historyRead = commits.length > 0;
  // the oldest commit the read actually reached: below it, a miss is the read
  // window (`--max` / `--since` / a shallow clone), not the repository
  const floorAt = commits.reduce<string | undefined>((m, c) => (m === undefined || c.at < m ? c.at : m), undefined);

  for (const [i, snap] of ascending.entries()) {
    const prev = i > 0 ? ascending[i - 1]! : undefined;
    // the sha this sync recorded for this spine, verified or not: whether two
    // syncs recorded the same sha is a fact about the snapshot table, so it does
    // not change when a history is read — only its *meaning* does, which is what
    // `commitState` carries
    const raw = snap.commit ?? snap.commitUnverified;
    const prevRaw = prev ? prev.commit ?? prev.commitUnverified : undefined;
    const isReindex = !!raw && !!prevRaw && raw === prevRaw;
    if (isReindex) reindexed += 1;
    const contained = !!snap.commit && map.has(snap.commit);
    const commitState: SpineCommitState =
      // a sha exists and there is no history to check it against: unaskable
      !historyRead && (snap.commit || snap.commitUnverified) ? 'history-unread'
      : contained ? 'recorded'
      : snap.commit
        // read, and this sha is not in it: the repository's doing, unless the sync
        // is older than anything the read reached, in which case it is the window's
        ? (floorAt !== undefined && snap.at < floorAt ? 'below-floor' : 'not-in-history')
      : snap.inSync === false ? 'not-in-sync'
      : 'none';
    // `null` only where a sha exists and cannot be checked. A row with no commit at
    // all answers `false` in every state, read or not: there is nothing to place, and
    // the value must not change just because a history was read elsewhere.
    const known = commitState === 'history-unread' ? null : contained;
    let swept: CommitRow[];
    if (isReindex || known !== true) swept = [];
    else if (!prev) {
      // the oldest sync records exactly one commit; everything before it is `before`
      swept = map.get(snap.commit!) ? [map.get(snap.commit!)!] : [];
    } else swept = commitsInRange(commits, prev.commit, snap.commit);
    const treeChanged = isReindex && !!snap.sourceDigest && !!prev?.sourceDigest && snap.sourceDigest !== prev.sourceDigest;
    rows.push({
      sync: snap.sync,
      at: snap.at,
      ...(treeChanged ? { treeChanged: true as const } : {}),
      ...(snap.commit ? { commit: snap.commit, ...(snap.commitFrom ? { commitFrom: snap.commitFrom } : {}) } : {}),
      ...(snap.commitUnverified ? { commitUnverified: snap.commitUnverified } : {}),
      // absent stays absent: a store that cannot answer must not answer `false`
      ...(snap.inSync === undefined ? {} : { inSync: snap.inSync }),
      commitState,
      commitKnown: known,
      reindexed: isReindex,
      commits: swept,
      unindexed: swept.filter((c) => !c.indexed).length,
    });
  }

  const oldest = ascending.find((s) => s.commit);
  const newest = [...ascending].reverse().find((s) => s.commit);
  const before = newestFirst(
    [...ancestors(map, oldest?.commit)].filter((s) => s !== oldest?.commit).flatMap((s) => map.get(s) ?? []),
  );
  const reached = ancestors(map, newest?.commit);
  const after = newestFirst(commits.filter((c) => !reached.has(c.sha)));

  const ordered = rows.reverse();
  return {
    rows: ordered,
    before,
    after,
    commits: commits.length,
    unindexed: commits.filter((c) => !c.indexed).length,
    // the commits this spine can *name* for this repository. Unverified workspace
    // shas are not counted: attributing them here would hand one repository
    // another's commits, which is the whole point of the per-source spine. With no
    // history read this is therefore a floor, and `bound` says so.
    distinct: new Set(ascending.map((s) => s.commit).filter((s): s is string => !!s)).size,
    reindexed,
    // only absences that are facts about the sync — `none` and `not-in-sync`
    withoutCommit: ordered.filter((r) => r.commitState === 'none' || r.commitState === 'not-in-sync').length,
    notInSync: ordered.filter((r) => r.commitState === 'not-in-sync').length,
    historyRead,
    withoutHistory: ordered.filter((r) => r.commitState === 'history-unread').length,
    unverified: ordered.filter((r) => r.commitUnverified).length,
    bound: historyRead ? 'exact' : 'floor',
  };
}

/**
 * The attribution the diff may carry (§2): *the commits in this range that
 * touched the file this change's subject lives in* — **file-level, not proof of
 * cause**. `level` is a literal so no consumer can read it as node-level, and
 * `unindexed` says how many of those commits no sync ever ingested.
 */
export interface FileAttribution {
  /** Attributing commit shas, newest first. */
  commits: string[];
  /** Always `'file'`. The granularity is the type, not a convention. */
  level: 'file';
  /** How many of `commits` are not indexed by any sync. */
  unindexed: number;
}

/** The minimum a change must expose to be attributable: an id and a file it lives in. */
export interface AttributableChange {
  id: string;
  loc?: { repo: string; path: string };
}

/** A change with the optional attribution field the frozen `farsight-diff v1` permits. */
export type Attributed<C> = C & { attribution?: FileAttribution };

/** The rows `attributeChanges()` folds over — read from `commit` and `commit_file`. */
export interface HistoryRows {
  commits: readonly CommitRow[];
  files: readonly FileChange[];
}

export interface AttributeOptions {
  /**
   * Monorepo normalisation (§8): `commit_file.path` is repository-root-relative
   * while a node's `loc.path` is source-root-relative, so a source mounted at
   * `apps/web` needs that prefix or the join silently returns nothing. Either
   * one prefix for every repo, or per repo by name.
   */
  prefix?: string | Record<string, string>;
}

function joinPrefix(prefix: string | undefined, path: string): string {
  if (!prefix) return path;
  const p = prefix.replace(/^\.?\/+|\/+$/g, '');
  return p ? `${p}/${path}` : path;
}

/**
 * Attach file-level attribution to a diff's changes, returning a **copy** — the
 * frozen `farsight-diff v1` contract permits gaining optional fields, and
 * `diff.ts` never reads git, so the golden fixture keeps passing.
 *
 * A change is attributed when its `loc` names a file **and** the rows contain
 * history for that repository. When the repository has history and nothing in
 * it touched the file, the field is present with `commits: []` — an honest "we
 * looked, nothing did". When the repository has no history rows at all the
 * field is absent, because an empty list would read as that same claim without
 * the evidence for it.
 *
 * A rename counts for the commit that performed it: it attributes to both the
 * old and the new path, which is how *the same file under a new path* gets said
 * (§6 question 2). The chain stops there — commits under the older name are not
 * folded in, because a path can be reused by a different file and these rows
 * cannot tell those apart.
 */
export function attributeChanges<C extends AttributableChange, D extends { changes: C[] }>(
  diff: D,
  rows: HistoryRows,
  opts: AttributeOptions = {},
): D & { changes: Attributed<C>[] } {
  const repos = new Set(rows.commits.map((c) => c.repo));
  const indexed = new Map(rows.commits.map((c) => [c.sha, c.indexed] as const));
  const order = new Map(newestFirst(rows.commits).map((c, i) => [c.sha, i] as const));

  // (repo, path) → the shas that touched it, on either side of a rename.
  // NUL joins the pair: a path may contain any character but that one.
  const touched = new Map<string, Set<string>>();
  const add = (repo: string, path: string, sha: string) => {
    const key = `${repo}\u0000${path}`;
    let set = touched.get(key);
    if (!set) touched.set(key, (set = new Set()));
    set.add(sha);
  };
  for (const f of rows.files) {
    add(f.repo, f.path, f.sha);
    if (f.oldPath) add(f.repo, f.oldPath, f.sha);
  }

  const prefixFor = (repo: string): string | undefined =>
    typeof opts.prefix === 'string' ? opts.prefix : opts.prefix?.[repo];

  const changes = diff.changes.map((change): Attributed<C> => {
    const loc = change.loc;
    if (!loc || !repos.has(loc.repo)) return change; // nothing to join on, or no history for this repo
    const path = joinPrefix(prefixFor(loc.repo), loc.path);
    const shas = [...(touched.get(`${loc.repo}\u0000${path}`) ?? [])].sort(
      (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
    );
    return {
      ...change,
      attribution: {
        commits: shas,
        level: 'file',
        unindexed: shas.filter((s) => indexed.get(s) === false).length,
      },
    };
  });

  return { ...diff, changes };
}

// ── the words, once (chunk H5) ──────────────────────────────────────────────
//
// `farsight history`, `farsight diff --attribute` and the server's
// `/api/history` · `/api/diff` all describe the same absences. Each sentence
// therefore lives here exactly once: a second copy is a second chance for two
// surfaces to say different things about one fact, which is the failure this
// phase exists to stop. The CLI prints them; the endpoints return them as data
// so the HUD can print the register's words beside them (H6/H7).

/**
 * One sentence per reason a commit range is only partly knowable. A range that
 * cannot be bracketed still attributes — over everything reachable from its
 * head — so the sentence is what stops that over-reach from reading as a
 * measured answer.
 */
export const INCOMPLETE_SENTENCE: Record<IncompleteReason, string> = {
  'no-history': 'no history has been read for this repository',
  'base-missing': 'the base sync recorded no commit for this repository',
  'head-missing': 'the head sync recorded no commit for this repository',
  'base-unknown': "the base sync's commit is not in this repository's history — rewritten, pruned, or a history not read this far back",
  'head-unknown': "the head sync's commit is not in this repository's history — rewritten, pruned, or a history not read this far back",
};

/** What a spine row has to say for itself, as a word a consumer can switch on. */
export type SpineNoteKind =
  /** no history has been read for this repository, so nothing can be said about this row's commit */
  | 'history-unread'
  /** this sync's commit equals its predecessor's — no new code was read */
  | 'reindexed'
  /** this sync's commit equals its predecessor's and its files differ: the working tree differs from HEAD */
  | 'tree-changed'
  /** the sync recorded no source row for this repository: it did not take part */
  | 'not-in-sync'
  /** the sync included this repository but stamped no commit for it */
  | 'no-commit'
  /** older than the oldest commit read: the read window did not reach it, so it is not "missing" */
  | 'commit-below-floor'
  /** a commit this repository's read history genuinely does not contain (rewritten, pruned) */
  | 'commit-unknown'
  /** the ordinary case: the subject of the newest commit the sync swept up */
  | 'subject';

const SPINE_NOTE: Record<Exclude<SpineNoteKind, 'subject'>, string> = {
  'history-unread': "no history read for this repository — run `farsight history` for it; until then whether this sync's commit is in this history cannot be asked",
  reindexed: 're-indexed on a newer build — no new commits',
  'tree-changed': 'same commit — the working tree differs from HEAD, so uncommitted edits were read',
  'not-in-sync': 'this sync did not include this repository',
  'no-commit': 'this sync recorded no commit for this repository',
  'commit-below-floor': 'commit older than the oldest commit read — read further back (`--since`, a higher `--max`) before calling it missing; a shallow clone cannot go further',
  'commit-unknown': "commit not in this repository's history — rewritten, pruned, or a history not read this far back",
};

/**
 * The one fold behind a spine row's note column (CLI) and its `note` field
 * (`/api/history`). Order matters and is the honesty: *did not take part* is
 * checked before *recorded no commit*, because a sync that never walked a
 * source has not failed to stamp anything — H5's third row state (see
 * {@link SpineSnapshot.inSync}). `subject` carries the text untruncated; a
 * column that needs to fit slices it itself.
 */
export function spineRowNote(row: SpineRow): { kind: SpineNoteKind; text: string } {
  // `history-unread` outranks `reindexed`: two syncs may have recorded the same
  // sha, but *no new commits* is a claim about this repository's code, and until a
  // history is read the sha may not even be this repository's
  // ({@link SpineSnapshot.commitUnverified}).
  if (row.commitState === 'history-unread') return { kind: 'history-unread', text: SPINE_NOTE['history-unread'] };
  if (row.treeChanged) return { kind: 'tree-changed', text: SPINE_NOTE['tree-changed'] };
  if (row.reindexed) return { kind: 'reindexed', text: SPINE_NOTE.reindexed };
  if (row.commitState === 'not-in-sync') return { kind: 'not-in-sync', text: SPINE_NOTE['not-in-sync'] };
  if (row.commitState === 'none') return { kind: 'no-commit', text: SPINE_NOTE['no-commit'] };
  if (row.commitState === 'below-floor') return { kind: 'commit-below-floor', text: SPINE_NOTE['commit-below-floor'] };
  if (row.commitState === 'not-in-history') return { kind: 'commit-unknown', text: SPINE_NOTE['commit-unknown'] };
  return { kind: 'subject', text: row.commits[0]?.subject ?? '' };
}

/** `"sync:41"` | `"41"` | `"latest"` → a snapshot ref; `null` for anything else. */
export function parseSyncRef(value: string): number | 'latest' | null {
  if (value === 'latest') return 'latest';
  const n = Number(value.replace(/^sync:/, ''));
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// ── attribution, folded once for both callers (chunk H4 + H5) ───────────────

/** Thousands separators, so 1690 and 16900 cannot be misread at a glance. */
function num(n: number): string {
  return n.toLocaleString('en-US');
}

/** A sentence with its weight: `warn` is an over-reach or a silent-failure risk. */
export interface AttributionNote {
  level: 'note' | 'warn';
  /** The repository the sentence is about. */
  repo: string;
  text: string;
}

/**
 * Where a source sits inside its repository — the join §8 warns about, resolved
 * by the caller because reading it means running git (`gitPrefix`), which core
 * does not do. Three outcomes, three sentences: a prefix (possibly `''`, the
 * source *is* the repository root), a checkout that git could not answer for,
 * or no checkout at all.
 */
export type CheckoutFact =
  | { kind: 'prefix'; prefix: string }
  | { kind: 'unreadable'; root: string; reason: string }
  | { kind: 'missing'; root?: string };

export interface AttributeDiffOptions {
  base: number;
  head: number;
  /** Default: every repository named by a change's `loc`, sorted. */
  repos?: readonly string[];
  /** Resolve where a source sits in its repository; omitted = paths are joined bare. */
  checkout?: (repo: string) => CheckoutFact;
}

/**
 * The rows `attributeDiffOver()` reads. `SnapshotDb` satisfies it structurally,
 * which is how this module stays free of a database import and of `node:sqlite`.
 */
export interface HistorySource {
  commitsBetween(repo: string, base: number, head: number): CommitRange;
  historyRows(repo: string, opts?: { shas?: readonly string[] }): HistoryRows;
}

/**
 * `farsight diff --attribute` and `GET /api/diff?attribute=1`, folded once.
 *
 * Returns a **copy** of the diff with the optional field the frozen
 * `farsight-diff v1` permits, plus the sentences that keep it from being
 * misread. Three things it is careful about, all of them §2's honesty:
 *
 * 1. **File-level.** These are the commits that touched the *file* a change's
 *    subject lives in. The header says so, because the one thing a reader must
 *    never take away is "commit X changed this function".
 * 2. **The range, not the whole history.** File rows are narrowed to the
 *    commits between the two syncs — the question the diff asked. The commit
 *    list stays whole: it is what says which repositories have a history at
 *    all, and which attributing commits no sync ever ingested.
 * 3. **The monorepo prefix (§8).** `commit_file.path` is repository-root-
 *    relative, `loc.path` source-root-relative. When the prefix cannot be read
 *    the notes say the paths were joined without one, because the silent
 *    failure mode is an empty commit list that reads as *nothing touched this*.
 */
export function attributeDiffOver<C extends AttributableChange, D extends { changes: C[] }>(
  diff: D,
  source: HistorySource,
  opts: AttributeDiffOptions,
): { diff: D & { changes: Attributed<C>[] }; header: string; notes: AttributionNote[]; ranges: CommitRange[] } {
  const { base, head } = opts;
  const repos = opts.repos ?? [...new Set(diff.changes.flatMap((c) => (c.loc ? [c.loc.repo] : [])))].sort();
  const commits: CommitRow[] = [];
  const files: FileChange[] = [];
  const prefix: Record<string, string> = {};
  const notes: AttributionNote[] = [];
  const ranges: CommitRange[] = [];

  for (const repo of repos) {
    const range = source.commitsBetween(repo, base, head);
    ranges.push(range);
    const rows = source.historyRows(repo, { shas: range.commits.map((c) => c.sha) });
    commits.push(...rows.commits);
    files.push(...rows.files);

    if (!rows.commits.length) {
      notes.push({ level: 'note', repo, text: `${repo}: no history read for this repository — nothing is claimed, not even an empty list (\`farsight history --repo ${repo}\`)` });
      continue;
    }
    const checkout = opts.checkout?.(repo) ?? { kind: 'missing' as const };
    if (checkout.kind === 'prefix') {
      if (checkout.prefix) prefix[repo] = checkout.prefix;
    } else if (checkout.kind === 'unreadable') {
      notes.push({ level: 'warn', repo, text: `${repo}: cannot read where ${checkout.root} sits inside its repository (${checkout.reason}) — paths are joined without a prefix, so a source below its repository root attributes nothing` });
    } else {
      notes.push({ level: 'warn', repo, text: `${repo}: no checkout recorded${checkout.root ? ` (${checkout.root} is not there)` : ''} — paths are joined without a repository prefix, so a source below its repository root attributes nothing` });
    }

    const where = prefix[repo] ? `the source sits under ${prefix[repo]} in its repository` : 'the source is at its repository root';
    notes.push({
      level: 'note',
      repo,
      text:
        `${repo}: ${num(range.commits.length)} commit${range.commits.length === 1 ? '' : 's'} in sync:${base}…sync:${head}` +
        (range.unindexed
          ? ` · ${num(range.unindexed)} of them no sync ever ingested, so what follows is a floor, not a fact`
          : ' · every one of them was ingested by some sync') +
        ` · ${where}`,
    });
    for (const why of range.incomplete) notes.push({ level: 'warn', repo, text: `${repo}: ${INCOMPLETE_SENTENCE[why]}` });
  }

  return {
    diff: attributeChanges(diff, { commits, files }, { prefix }),
    header:
      `attribution: file-level — for each change, the commits between sync:${base} and sync:${head} that touched ` +
      "the file its subject lives in. That is the file's history, not proof that any of those commits changed " +
      'this route, table or function; a change with no file gets no attribution at all.',
    notes,
    ranges,
  };
}

/** A sentence about a whole spine, with its weight. `warn` marks a gap a reader must not read past. */
export interface SpineSentence {
  level: 'note' | 'warn';
  text: string;
}

/**
 * Everything a spine has to say about itself, as sentences rather than numbers a
 * caller re-words. Keyed rather than listed so `farsight history` can interleave
 * the git facts it also reads (truncated walk, shallow clone) at the points it
 * always has, while `/api/history` returns them in one fixed order — the same
 * words either way.
 *
 * `unindexed` comes first wherever they are rendered: a history containing
 * commits no sync ingested has to say so **before** any row is drawn, or a row
 * is read as a complete account of what happened.
 */
export interface SpineSentences {
  /**
   * No history has been read for this repository, so every containment question
   * is unanswerable and every count is a floor. Rendered **first**, before any
   * number, so none of them is read as measured.
   */
  historyUnread?: SpineSentence;
  /** How much of this history no sync ever ingested — *not indexed*, never a zero. */
  unindexed?: SpineSentence;
  /** Syncs · distinct commits · syncs that recorded none · re-indexes. */
  syncs?: SpineSentence;
  /** Not one sync recorded a commit for this repository, and why that cannot be backfilled. */
  noneRecorded?: SpineSentence;
  /** No sync names a commit this history contains, so rows can be named but not placed. */
  unanchored?: SpineSentence;
  /** Commits before the oldest sync's commit, or unreachable from the newest. */
  outsideReach?: SpineSentence;
  /** There are no snapshots at all — the spine has nothing to hang commits on. */
  noSnapshots?: SpineSentence;
  /** Rows whose commit is the workspace root's sha, which this repository's history contains. */
  borrowed?: SpineSentence;
  /** Syncs whose commit predates the oldest commit read — the read window, not the repository. */
  belowFloor?: SpineSentence;
}

export function spineSentences(spine: CommitSpine): SpineSentences {
  const out: SpineSentences = {};
  const rows = spine.rows.length;
  if (!spine.historyRead && rows) {
    out.historyUnread = {
      level: 'warn',
      text:
        'no history has been read for this repository — run `farsight history` for it. Until then no commit can be placed in this history, so what each sync swept up, how much of it was never indexed, and how many distinct commits were recorded are unanswerable rather than zero, and every count below is a floor' +
        (spine.unverified
          ? `. ${num(spine.unverified)} of these syncs recorded only the workspace root's commit, which may or may not be this repository's and cannot be checked until a history is read`
          : ''),
    };
  }
  // the one history sentence (round 2026-10-10, finding 2.1): both halves, the same words Settings and the
  // front door print — read into history · ingested by a sync · not yet
  if (spine.commits && spine.unindexed) {
    out.unindexed = { level: 'warn', text: `${historySentence(historyFact([spine]))} — the ${num(spine.unindexed)} not yet ingested are not indexed: Farsight can name the files they touched, not what they did to the graph` };
  } else if (spine.commits) {
    out.unindexed = { level: 'note', text: `${historySentence(historyFact([spine]))} — every commit in this history was ingested by some sync` };
  }
  // a sync that never walked this source has not failed to stamp a commit — the
  // third row state (H5), said here so the count is never read as one situation
  const missing = spine.withoutCommit
    ? ` · ${num(spine.withoutCommit)} recorded no commit for this repository${spine.notInSync ? ` (${num(spine.notInSync)} did not include it at all)` : ''}`
    : '';
  const treeRows = spine.rows.filter((r) => r.treeChanged).length;
  if (rows) {
    out.syncs = { level: 'note', text: `${num(rows)} sync${rows === 1 ? '' : 's'} · ${num(spine.distinct)} distinct commit${spine.distinct === 1 ? '' : 's'} recorded for this repository${missing} · ${num(spine.reindexed)} re-indexed on a newer build — no new commits${treeRows ? ` (${treeRows} of them read a working tree that differs from HEAD)` : ''}` };
  }
  // strictly `true`: an unaskable row anchors nothing
  const anchored = spine.rows.some((r) => r.commitKnown === true);
  if (rows && spine.withoutCommit === rows && spine.commits) {
    // the two situations an all-absent commit column can be in, told apart rather
    // than sharing one sentence: a source no snapshot ever walked has not failed
    // to stamp anything, and telling it to re-sync to "record it from now on" is
    // advice for the other case
    out.noneRecorded = spine.notInSync === rows
      ? { level: 'warn', text: `not one of the ${num(rows)} syncs included this repository — each snapshot records the sources it walked and none of them named this one, so these commits have no sync to be placed against. Add it as a source and re-sync; until then every commit here is not indexed by construction` }
      : { level: 'warn', text: `not one of the ${num(rows)} syncs recorded a commit for this repository — a snapshot stamps the workspace root's commit and a per-source commit only when the ingest that wrote it stamped one, and an existing row cannot be backfilled: the commit that sync saw is not recoverable. Re-sync to record it from now on; until then this spine can name syncs but not what they swept up` };
  } else if (rows && !anchored && spine.commits) {
    out.unanchored = { level: 'warn', text: "no sync on this spine names a commit this repository's history contains — rewritten, pruned, or a history never read this far back — so the rows below can be named but not placed" };
  }
  // with no syncs, or no sync commit this history knows, there is no "outside a
  // sync's reach" to compute: the anchor would be a sha nothing here can place
  if (rows && anchored && (spine.before.length || spine.after.length)) {
    const bits: string[] = [];
    if (spine.before.length) bits.push(`${num(spine.before.length)} before the oldest sync's commit`);
    if (spine.after.length) bits.push(`${num(spine.after.length)} not reachable from the newest sync's commit`);
    out.outsideReach = { level: 'note', text: `outside every sync's reach: ${bits.join(' · ')}` };
  }
  const belowFloor = spine.rows.filter((r) => r.commitState === 'below-floor').length;
  if (belowFloor) {
    out.belowFloor = {
      level: 'warn',
      text: `${num(belowFloor)} sync${belowFloor === 1 ? '' : 's'} recorded a commit older than the oldest commit read here — the walk did not reach that far back (\`--since\`, \`--max\`, or a shallow clone), so those commits are unread, not missing`,
    };
  }
  if (!rows) {
    out.noSnapshots = { level: 'note', text: 'no snapshots yet in this database — run `farsight ingest`, then this spine has syncs to hang commits on' };
  } else {
    // provenance, said once rather than per row: a workspace-sha row is this
    // repository's commit only because this repository's history contains that sha
    const borrowed = spine.rows.filter((r) => r.commitFrom === 'workspace').length;
    if (borrowed) {
      out.borrowed = { level: 'note', text: `${num(borrowed)} of these rows take the workspace root's sha, which this repository's own history contains — the rest recorded a commit for this source directly` };
    }
  }
  return out;
}

// ── the history fact: one sentence with both halves (round 2026-10-10, finding 2.1) ──────────────────────
// Settings printed *history 282 commits indexed* (the commits read from git) and Changes *242 of 282 never
// ingested* (the same commits, the other half): two facts read as one contradiction by seven reviewers. One
// fold, one sentence, printed by Settings (the sync status line), Changes (the spine's first note) and the
// front door's state of play: *n commits read into history · k ingested by a sync · m not yet*.

/** The three numbers, each a `Counted`: read = ingested + not yet. */
export interface HistoryFact {
  read: Counted;
  ingested: Counted;
  notYet: Counted;
  /** some repository has had its history read — when false every number is 0 because nothing was read, not because nothing exists */
  historyRead: boolean;
}

/** The history fact over one or more repositories' spines (the workspace sums them; a commit belongs to one repository). */
export function historyFact(spines: readonly Pick<CommitSpine, 'commits' | 'unindexed'>[]): HistoryFact {
  const read = spines.reduce((s, x) => s + x.commits, 0);
  const notYet = spines.reduce((s, x) => s + Math.min(x.unindexed, x.commits), 0);
  const ingested = read - notYet;
  const SRC = 'core history.ts historyFact ← commitSpine().commits / .unindexed';
  const recheck = { cli: 'farsight history --repo <name>', mcp: 'graph_overview' };
  return {
    read: counted(read, 'history.fact.read', 'count.scope.workspace', SRC, {
      bizUnit: 'history.fact.read', recheck,
      breakdown: [{ key: 'history.fact.ingested', n: ingested }, { key: 'history.fact.notYet', n: notYet }],
    }),
    ingested: counted(ingested, 'history.fact.ingested', 'count.scope.workspace', SRC, { bizUnit: 'history.fact.ingested', of: read, recheck }),
    notYet: counted(notYet, 'history.fact.notYet', 'count.scope.workspace', SRC, { bizUnit: 'history.fact.notYet', of: read, recheck }),
    historyRead: read > 0,
  };
}

/** The sentence: *282 commits read into history · 40 ingested by a sync · 242 not yet* — one wording everywhere. */
export function historySentence(f: HistoryFact, register: Register = 'professional'): string {
  const w = (c: Counted) => t(countKey(c.unit, c.n), register).replace('{n}', String(c.n));
  return [w(f.read), w(f.ingested), w(f.notYet)].join(' · ');
}
