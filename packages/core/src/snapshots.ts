import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { GraphStore } from './store.js';
import type { GraphNode, GraphEdge } from './graph.js';
import { spineOf, commitsInRange } from './history.js';
import type {
  CommitInput, CommitRange, CommitRow, CommitSpine, FileChange, FileStatus, HistoryRows, IncompleteReason,
  SpineSnapshot,
} from './history.js';

/**
 * SQLite-backed snapshot history (ADR 7). Snapshots are stored as SCD2
 * validity intervals, not copies: a node/edge row is written once with
 * `first_sync`, and closed (`last_sync`) when its content changes or it
 * disappears. "What did sync N look like" is an interval query; the diff
 * (`changedBetween`) is a query over intervals, not an object-graph walk;
 * retention is a DELETE.
 *
 * Driver: built-in `node:sqlite` — no native module in the install path.
 * Stable on Node >= 24 (experimental-but-working on 22.5+). If the module is
 * missing we degrade honestly: the constructor throws `SnapshotUnavailable`
 * and consumers fall back to the single-snapshot graph.json path (no history,
 * no --as-of, no diff — and they say so).
 */

// ── node:sqlite loading (feature detection + warning hygiene) ─────────────

/**
 * On Node < 24, requiring `node:sqlite` emits an ExperimentalWarning on every
 * process — noise on every CLI run and in test output. Replace the default
 * warning printer with one that swallows only that warning and forwards
 * everything else to the original listeners. Installed once, immediately
 * before the require that triggers the warning.
 */
let warningsFiltered = false;
function muteSqliteExperimentalWarning(): void {
  if (warningsFiltered) return;
  warningsFiltered = true;
  const original = process.listeners('warning');
  if (!original.length) return; // no default printer to wrap — nothing to mute
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
    for (const listener of original) listener.call(process, warning);
  });
}

export type SqliteModule = typeof import('node:sqlite');
let sqliteModule: SqliteModule | null | undefined;

/** The `node:sqlite` module, or null when this runtime has none (feature-detected once, warning muted). */
export function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    muteSqliteExperimentalWarning();
    const require = createRequire(import.meta.url);
    sqliteModule = require('node:sqlite') as SqliteModule;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/** True when `node:sqlite` can be loaded on this runtime. */
export function sqliteAvailable(): boolean {
  return loadSqlite() !== null;
}

/**
 * The honest degraded state: this Node runtime has no `node:sqlite`, so there
 * is no snapshot history. graph.json (latest sync only) still works; history,
 * `--as-of` and `farsight diff` do not. Consumers render `message`, they never
 * pretend.
 */
export class SnapshotUnavailable extends Error {
  readonly code = 'SNAPSHOT_UNAVAILABLE';
  constructor(detail?: string) {
    super(
      detail ??
        `snapshot history unavailable: node:sqlite is missing on this runtime (Node ${process.version}; ` +
          'needs >= 22.5, stable on >= 24). The latest graph.json still works — history, --as-of and diff do not.',
    );
    this.name = 'SnapshotUnavailable';
  }
}

// ── public shapes ──────────────────────────────────────────────────────────

export interface SnapshotRef {
  sync: number;
  at: string; // ISO timestamp
  tz: string; // IANA timezone the timestamp was taken in
  commit?: string;
  digest: string;
}

/** One `farsight snapshots` row — a SnapshotRef plus the display counts. */
export interface SnapshotListing extends SnapshotRef {
  files: number;
  nodes: number;
  edges: number;
  pinned: boolean;
}

/** Per-source stats recorded with a snapshot (name + optional commit/files/status). */
export interface SourceStat {
  name: string;
  commit?: string;
  files?: number;
  status?: string;
  /** the source's content digest at this sync; `write()` reads it off `store.meta.repos` when absent */
  digest?: string;
}

/** One changed row from `changedBetween()` — the diff's raw material. */
export interface RowChange {
  /** node id, or edge key `kind|from|to` */
  key: string;
  change: 'added' | 'removed' | 'changed';
  before?: unknown; // parsed row JSON at base (removed/changed)
  after?: unknown; // parsed row JSON at head (added/changed)
}

/**
 * One design image retained at one sync — the row `writeShots` stores and
 * `shotAt` returns (change-history-2026-09.md §5).
 *
 * `digest` names the bytes, not the screen: it is the content address of the
 * file under `.farsight/cache/shots/`, so an unchanged image across twenty
 * syncs is one file and twenty rows. `source` is where the bytes were read from
 * (a repo-relative path, or the Figma render cache), kept so a reader can be
 * told what they are looking at rather than only that a picture exists.
 */
export interface ShotInput {
  /** the screen's node id — one shot per node per sync */
  node: string;
  repo: string;
  /** content address of the bytes: `<digest>.<ext>` under the shots cache */
  digest: string;
  /** lower-case, no dot — `png`, `svg`, … */
  ext: string;
  /** how the manifest pointed at the image (`DesignRef.image.kind`) */
  kind: 'file' | 'figma';
  /** where the bytes came from, for the reader: a repo-relative path, or the cached Figma render */
  source: string;
  bytes: number;
}

/** A {@link ShotInput} as stored, carrying the sync it belongs to. */
export interface ShotRow extends ShotInput {
  sync: number;
}

/**
 * Content digest of a graph: sha1 over sorted node ids + edge keys + edge
 * resolution tiers (so a confidence change alone changes the digest once
 * adapters stamp resolutions in P4). 12 hex chars, same idiom as sourceHash.
 */
export function digestOf(store: GraphStore): string {
  const g = store.toJSON();
  const nodeIds = g.nodes.map((n: GraphNode) => n.id).sort();
  const edgeKeys = g.edges
    .map((e: GraphEdge) => `${e.kind}|${e.from}|${e.to}|${e.resolution?.confidence ?? ''}`)
    .sort();
  return createHash('sha1')
    .update(nodeIds.join('\n'))
    .update('\u0000')
    .update(edgeKeys.join('\n'))
    .digest('hex')
    .slice(0, 12);
}

// ── schema ─────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshot (
  sync INTEGER PRIMARY KEY, at TEXT, tz TEXT, commit_sha TEXT,
  digest TEXT, files INTEGER, nodes INTEGER, edges INTEGER, pinned INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS snapshot_source (sync INTEGER, name TEXT, commit_sha TEXT, files INTEGER, status TEXT);
CREATE TABLE IF NOT EXISTS node (id TEXT, first_sync INTEGER, last_sync INTEGER, hash TEXT, json TEXT);
CREATE TABLE IF NOT EXISTS edge (key TEXT, first_sync INTEGER, last_sync INTEGER, hash TEXT, json TEXT);
CREATE TABLE IF NOT EXISTS blind_spot (sync INTEGER, kind TEXT, note TEXT, metric TEXT, affects TEXT);
CREATE INDEX IF NOT EXISTS node_alive ON node(id, first_sync, last_sync);
CREATE INDEX IF NOT EXISTS edge_alive ON edge(key, first_sync, last_sync);

-- history (change-history-2026-09.md §1): four tables beside the spine, never graph content.
-- Additive by IF NOT EXISTS, so an older database gains them on open and keeps every row it had.
-- "commit" and "release" are SQLite keywords, so they are quoted at every use site.
CREATE TABLE IF NOT EXISTS "commit" (
  repo TEXT, sha TEXT, at TEXT, author TEXT, email TEXT, subject TEXT, parents TEXT, merge INTEGER DEFAULT 0,
  PRIMARY KEY (repo, sha));
CREATE TABLE IF NOT EXISTS commit_file (
  repo TEXT, sha TEXT, path TEXT, status TEXT, old_path TEXT, added INTEGER, deleted INTEGER, similarity INTEGER);
CREATE TABLE IF NOT EXISTS commit_sync (repo TEXT, sha TEXT, sync INTEGER, PRIMARY KEY (repo, sha, sync));
CREATE TABLE IF NOT EXISTS "release" (repo TEXT, name TEXT, sha TEXT, at TEXT, declared_by TEXT, PRIMARY KEY (repo, name));
CREATE INDEX IF NOT EXISTS commit_file_path ON commit_file(repo, path);
CREATE INDEX IF NOT EXISTS commit_file_sha ON commit_file(repo, sha);

-- work items on the spine (work-items-sync.md §9): the keys a commit names and how, the
-- key-bearing branches that carry it, and the graph nodes its hunks changed (computed once
-- per sha against the graph of the sync that read it; recomputed when the graph moves).
CREATE TABLE IF NOT EXISTS commit_key (
  repo TEXT, sha TEXT, key TEXT, provider TEXT, via TEXT, ref TEXT,
  PRIMARY KEY (repo, sha, key, provider, via));
CREATE INDEX IF NOT EXISTS commit_key_key ON commit_key(key, provider);
CREATE TABLE IF NOT EXISTS commit_branch (repo TEXT, sha TEXT, ref TEXT, PRIMARY KEY (repo, sha, ref));
CREATE TABLE IF NOT EXISTS commit_node (
  repo TEXT, sha TEXT, node TEXT, path TEXT, file_only INTEGER DEFAULT 0, graph TEXT,
  PRIMARY KEY (repo, sha, node));
CREATE TABLE IF NOT EXISTS commit_node_done (repo TEXT, sha TEXT, graph TEXT, PRIMARY KEY (repo, sha));
-- which key rules the last spine read of a repository applied: a sync reads incrementally only
-- while they have not changed (a newly configured project re-reads the window for its keys)
CREATE TABLE IF NOT EXISTS spine_read (repo TEXT PRIMARY KEY, keysig TEXT, at TEXT);

-- design shots (change-history-2026-09.md §5): what a screen's *design* image looked like at a
-- sync. Not the running app and not the HUD — §9 rules a browser out of the install path, and
-- nothing here can render one. A row says only: at sync N, this screen's design image had this
-- content digest, and the bytes are at .farsight/cache/shots/<digest>.<ext>.
--
-- One row per (sync, node). Content addressing does the deduplication: twenty syncs of an
-- unchanged screen are twenty rows (~70 bytes each) pointing at one file on disk.
--
-- No row for a sync means **no shot was taken** at that sync, which is the only thing the data
-- knows. It never means "unchanged": the reader must not be shown today's picture under a past
-- sync's name, so shotAt matches the sync exactly and absence stays absence.
CREATE TABLE IF NOT EXISTS sync_shot (
  sync INTEGER, node TEXT, repo TEXT, digest TEXT, ext TEXT, kind TEXT, source TEXT, bytes INTEGER,
  PRIMARY KEY (sync, node));
CREATE INDEX IF NOT EXISTS sync_shot_node ON sync_shot(node, sync);
CREATE INDEX IF NOT EXISTS sync_shot_digest ON sync_shot(digest);
`;

function rowHash(json: string): string {
  return createHash('sha1').update(json).digest('hex');
}

interface AliveRow {
  key: string;
  first_sync: number;
  last_sync: number | null;
  hash: string;
  json: string;
}

// ── the store ──────────────────────────────────────────────────────────────

export class SnapshotDb {
  // typed loosely because node:sqlite types are still experimental across Node versions
  private db: InstanceType<SqliteModule['DatabaseSync']>;

  /** Opens (creating directories) and migrates. Throws SnapshotUnavailable when node:sqlite is missing. */
  constructor(readonly dbPath: string) {
    const sqlite = loadSqlite();
    if (!sqlite) throw new SnapshotUnavailable();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new sqlite.DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    // additive: a store written before per-source content digests gains the column
    // and keeps every row; old rows read null (the spine cannot tell a working-tree
    // change from a re-index there, and says nothing rather than guess)
    const cols = this.db.prepare('PRAGMA table_info(snapshot_source)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'source_digest')) this.db.exec('ALTER TABLE snapshot_source ADD COLUMN source_digest TEXT');
  }

  close(): void {
    this.db.close();
  }

  /**
   * Record the store as the next sync, in one transaction: close rows that
   * changed or disappeared (last_sync = N-1), open rows for new/changed
   * content (first_sync = N), leave unchanged rows open. Also stamps
   * `store.meta` (sync/digest/commit/tz) so graph.json carries the same
   * identity as the history.
   */
  write(store: GraphStore, ctx: { commit?: string; sources?: SourceStat[] } = {}): SnapshotRef {
    const at = new Date().toISOString();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const digest = digestOf(store);
    const g = store.toJSON();

    this.db.exec('BEGIN');
    try {
      const maxRow = this.db.prepare('SELECT MAX(sync) AS max FROM snapshot').get() as { max: number | null };
      const sync = (maxRow.max ?? 0) + 1;

      this.writeInterval('node', 'id', sync, g.nodes.map((n: GraphNode) => [n.id, JSON.stringify(n)]));
      this.writeInterval('edge', 'key', sync, g.edges.map((e: GraphEdge) => [e.id, JSON.stringify(e)]));

      this.db
        .prepare('INSERT INTO snapshot (sync, at, tz, commit_sha, digest, files, nodes, edges, pinned) VALUES (?,?,?,?,?,?,?,?,0)')
        .run(sync, at, tz, ctx.commit ?? null, digest, store.meta.files ?? 0, g.nodes.length, g.edges.length);
      const srcStmt = this.db.prepare(
        'INSERT INTO snapshot_source (sync, name, commit_sha, files, status, source_digest) VALUES (?,?,?,?,?,?)',
      );
      for (const s of ctx.sources ?? []) {
        const digest = s.digest ?? store.meta.repos?.[s.name]?.sourceDigest ?? null;
        srcStmt.run(sync, s.name, s.commit ?? null, s.files ?? null, s.status ?? null, digest);
      }
      this.db.exec('COMMIT');

      store.meta.sync = sync;
      store.meta.digest = digest;
      store.meta.tz = tz;
      if (ctx.commit) store.meta.commit = ctx.commit;
      return { sync, at, tz, ...(ctx.commit ? { commit: ctx.commit } : {}), digest };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** SCD2 bookkeeping for one interval table. `rows` = [key, json] of the current graph. */
  private writeInterval(table: 'node' | 'edge', keyCol: 'id' | 'key', sync: number, rows: [string, string][]): void {
    const open = new Map<string, string>(); // key → hash of the currently-open row
    for (const r of this.db
      .prepare(`SELECT ${keyCol} AS key, hash FROM ${table} WHERE last_sync IS NULL`)
      .all() as { key: string; hash: string }[]) {
      open.set(r.key, r.hash);
    }
    const closeStmt = this.db.prepare(`UPDATE ${table} SET last_sync = ? WHERE ${keyCol} = ? AND last_sync IS NULL`);
    const insertStmt = this.db.prepare(`INSERT INTO ${table} (${keyCol}, first_sync, last_sync, hash, json) VALUES (?,?,NULL,?,?)`);

    const seen = new Set<string>();
    for (const [key, json] of rows) {
      if (seen.has(key)) continue; // defensive: keys are unique upstream
      seen.add(key);
      const hash = rowHash(json);
      const openHash = open.get(key);
      if (openHash === hash) continue; // unchanged — row stays open
      if (openHash !== undefined) closeStmt.run(sync - 1, key); // changed — close the old version
      insertStmt.run(key, sync, hash, json);
    }
    // disappeared — close rows whose key is absent from the current graph
    for (const key of open.keys()) {
      if (!seen.has(key)) closeStmt.run(sync - 1, key);
    }
  }

  /**
   * Rebuild the graph as it was at one sync (interval read:
   * `first_sync <= N AND (last_sync IS NULL OR last_sync >= N)`).
   * A pruned sync throws with an explanatory message — never a silent miss.
   * Note: `roots` (per-machine checkout paths) are not persisted in history;
   * the returned store has none.
   */
  read(ref: 'latest' | number): { store: GraphStore; ref: SnapshotRef } {
    const snap = this.snapshotRow(ref);
    const nodes = (
      this.db
        .prepare('SELECT json FROM node WHERE first_sync <= ? AND (last_sync IS NULL OR last_sync >= ?)')
        .all(snap.sync, snap.sync) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as GraphNode);
    const edges = (
      this.db
        .prepare('SELECT json FROM edge WHERE first_sync <= ? AND (last_sync IS NULL OR last_sync >= ?)')
        .all(snap.sync, snap.sync) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as GraphEdge);

    const store = new GraphStore();
    store.addFragment({ repo: '', nodes, edges });
    store.meta = {
      generatedAt: snap.at,
      files: snap.files,
      sync: snap.sync,
      digest: snap.digest,
      tz: snap.tz,
      ...(snap.commit ? { commit: snap.commit } : {}),
    };
    const ref2: SnapshotRef = {
      sync: snap.sync,
      at: snap.at,
      tz: snap.tz,
      ...(snap.commit ? { commit: snap.commit } : {}),
      digest: snap.digest,
    };
    return { store, ref: ref2 };
  }

  /** Newest first. */
  list(limit = 20): SnapshotListing[] {
    const rows = this.db
      .prepare('SELECT sync, at, tz, commit_sha, digest, files, nodes, edges, pinned FROM snapshot ORDER BY sync DESC LIMIT ?')
      .all(limit) as {
      sync: number; at: string; tz: string; commit_sha: string | null;
      digest: string; files: number; nodes: number; edges: number; pinned: number;
    }[];
    return rows.map((r) => ({
      sync: r.sync,
      at: r.at,
      tz: r.tz,
      ...(r.commit_sha ? { commit: r.commit_sha } : {}),
      digest: r.digest,
      files: r.files,
      nodes: r.nodes,
      edges: r.edges,
      pinned: r.pinned === 1,
    }));
  }

  /**
   * The newest sync before `sync`, or `undefined` when there is none — the one
   * rule behind `farsight diff`'s and `/api/diff`'s default base, so the two
   * can never disagree about which snapshot "the previous one" is. Reads the
   * table rather than a page of {@link list}, so a long history has no cliff.
   */
  previous(sync: number): number | undefined {
    const row = this.db.prepare('SELECT MAX(sync) AS prev FROM snapshot WHERE sync < ?').get(sync) as { prev: number | null };
    return row?.prev ?? undefined;
  }

  /** Mark a sync as pinned — retention keeps it (set when a pinned link is generated). */
  pin(sync: number): void {
    const result = this.db.prepare('UPDATE snapshot SET pinned = 1 WHERE sync = ?').run(sync);
    if (result.changes === 0) throw new Error(`cannot pin sync:${sync} — no such snapshot (see \`farsight snapshots\`)`);
  }

  /**
   * Retention: keep the newest `keep` snapshots (plus pinned ones when
   * `keepPinned`); delete the rest, then drop interval rows no remaining
   * snapshot can read. Returns the number of snapshots pruned.
   */
  prune(policy: { keep: number; keepPinned: boolean }): number {
    const all = (this.db.prepare('SELECT sync, pinned FROM snapshot ORDER BY sync DESC').all() as { sync: number; pinned: number }[]);
    const kept = new Set<number>();
    for (const [i, row] of all.entries()) {
      if (i < policy.keep || (policy.keepPinned && row.pinned === 1)) kept.add(row.sync);
    }
    const victims = all.map((r) => r.sync).filter((s) => !kept.has(s));
    if (!victims.length) return 0;

    this.db.exec('BEGIN');
    try {
      const del = (sql: string) => {
        const stmt = this.db.prepare(sql);
        for (const s of victims) stmt.run(s);
      };
      del('DELETE FROM snapshot WHERE sync = ?');
      del('DELETE FROM snapshot_source WHERE sync = ?');
      del('DELETE FROM blind_spot WHERE sync = ?');
      // a closed interval row survives iff some remaining snapshot falls inside it; open rows always survive
      for (const table of ['node', 'edge'] as const) {
        this.db.exec(
          `DELETE FROM ${table} WHERE last_sync IS NOT NULL AND NOT EXISTS ` +
            `(SELECT 1 FROM snapshot s WHERE s.sync BETWEEN ${table}.first_sync AND ${table}.last_sync)`,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return victims.length;
  }

  /**
   * Raw material for `diffGraphs()`: rows added/removed/changed between two
   * syncs — one interval query per table, hash comparison instead of a deep
   * diff.
   */
  changedBetween(base: number, head: number): { nodes: RowChange[]; edges: RowChange[] } {
    this.snapshotRow(base); // validate both ends exist (throws pruned/unknown otherwise)
    this.snapshotRow(head);
    return {
      nodes: this.changedRows('node', 'id', base, head),
      edges: this.changedRows('edge', 'key', base, head),
    };
  }

  // ── history: git as a lens on the spine (change-history-2026-09.md §1) ────

  /**
   * Record one repository's commits and the files they touched, then refresh
   * the `commit_sync` join. Idempotent: each commit is replaced in place and
   * its file rows rewritten, so re-reading a history costs only what moved.
   *
   * History is deliberately not written by `ingest` or `POST /api/sync` (§8) —
   * a slow history must never be able to slow a sync.
   */
  writeCommits(repo: string, commits: readonly CommitInput[]): { commits: number; files: number; linked: number } {
    this.db.exec('BEGIN');
    let files = 0;
    try {
      const commitStmt = this.db.prepare(
        'INSERT OR REPLACE INTO "commit" (repo, sha, at, author, email, subject, parents, merge) VALUES (?,?,?,?,?,?,?,?)',
      );
      const clearStmt = this.db.prepare('DELETE FROM commit_file WHERE repo = ? AND sha = ?');
      const fileStmt = this.db.prepare(
        'INSERT INTO commit_file (repo, sha, path, status, old_path, added, deleted, similarity) VALUES (?,?,?,?,?,?,?,?)',
      );
      const clearKeys = this.db.prepare('DELETE FROM commit_key WHERE repo = ? AND sha = ?');
      const keyStmt = this.db.prepare('INSERT OR REPLACE INTO commit_key (repo, sha, key, provider, via, ref) VALUES (?,?,?,?,?,?)');
      const clearBranches = this.db.prepare('DELETE FROM commit_branch WHERE repo = ? AND sha = ?');
      const branchStmt = this.db.prepare('INSERT OR IGNORE INTO commit_branch (repo, sha, ref) VALUES (?,?,?)');
      for (const c of commits) {
        const parents = c.parents ?? [];
        const merge = c.merge ?? parents.length > 1;
        commitStmt.run(repo, c.sha, c.at, c.author ?? '', c.email ?? '', c.subject ?? '', parents.join(' '), merge ? 1 : 0);
        clearStmt.run(repo, c.sha);
        // keys and branches are rewritten only when the reader read them: absent is "not read", never "none"
        if (c.keys) {
          clearKeys.run(repo, c.sha);
          for (const k of c.keys) keyStmt.run(repo, c.sha, k.key, k.provider, k.via, k.ref ?? null);
        }
        if (c.branches) {
          clearBranches.run(repo, c.sha);
          for (const b of c.branches) branchStmt.run(repo, c.sha, b);
        }
        for (const f of c.files ?? []) {
          fileStmt.run(
            repo, c.sha, f.path, f.status, f.oldPath ?? null,
            f.added ?? null, f.deleted ?? null, f.similarity ?? null,
          );
          files += 1;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { commits: commits.length, files, linked: this.linkCommitSyncs(repo) };
  }

  // ── work items on the spine (work-items-sync.md §9) ─────────────────────

  /** The newest commit recorded for a repository — where an incremental read starts. */
  newestCommit(repo: string): { sha: string; at: string } | undefined {
    const r = this.db.prepare('SELECT sha, at FROM "commit" WHERE repo = ? ORDER BY at DESC, sha LIMIT 1').get(repo) as { sha: string; at: string } | undefined;
    return r ?? undefined;
  }

  /** How many commits a repository has recorded. */
  commitCount(repo: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM "commit" WHERE repo = ?').get(repo) as { n: number }).n;
  }

  /** Commits naming a work-item key (any repository unless `repo`), newest first, one row per (commit, via). */
  commitsForKey(key: string, opts: { repo?: string; provider?: string } = {}): CommitKeyRow[] {
    const where = ['k.key = ?'];
    const args: string[] = [key];
    if (opts.repo) { where.push('k.repo = ?'); args.push(opts.repo); }
    if (opts.provider) { where.push('k.provider = ?'); args.push(opts.provider); }
    return this.db.prepare(
      `SELECT k.repo, k.sha, k.key, k.provider, k.via, k.ref, c.at, c.author, c.email, c.subject, c.merge
         FROM commit_key k JOIN "commit" c ON c.repo = k.repo AND c.sha = k.sha
        WHERE ${where.join(' AND ')} ORDER BY c.at DESC, k.sha, k.via`,
    ).all(...args).map((r) => {
      const row = r as Record<string, string | number | null>;
      return {
        repo: row.repo as string, sha: row.sha as string, key: row.key as string, provider: row.provider as string,
        via: row.via as string, ...(row.ref ? { ref: row.ref as string } : {}),
        at: row.at as string, author: row.author as string, email: row.email as string, subject: row.subject as string, merge: row.merge === 1,
      };
    });
  }

  /**
   * Every key → how many distinct commits name it, in one pass (the list surface's commit counts).
   * Distinct by sha alone: sources that read one checkout (a repository and an example folder inside
   * it) each record the same commit under their own repo name, and it is still one commit.
   */
  keyCommitCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.db.prepare('SELECT provider, key, COUNT(DISTINCT sha) AS n FROM commit_key GROUP BY provider, key').all() as { provider: string; key: string; n: number }[]) {
      out.set(`${r.provider}|${r.key}`, r.n);
    }
    return out;
  }

  /** The keys one commit names. */
  keysForCommit(repo: string, sha: string): { key: string; provider: string; via: string; ref?: string }[] {
    return (this.db.prepare('SELECT key, provider, via, ref FROM commit_key WHERE repo = ? AND sha = ? ORDER BY key, via').all(repo, sha) as {
      key: string; provider: string; via: string; ref: string | null;
    }[]).map((r) => ({ key: r.key, provider: r.provider, via: r.via, ...(r.ref ? { ref: r.ref } : {}) }));
  }

  /** The key-bearing branches recorded for one commit. */
  branchesForCommit(repo: string, sha: string): string[] {
    return (this.db.prepare('SELECT ref FROM commit_branch WHERE repo = ? AND sha = ? ORDER BY ref').all(repo, sha) as { ref: string }[]).map((r) => r.ref);
  }

  /** One commit's row, or undefined. */
  commitRow(repo: string, sha: string): { sha: string; at: string; author: string; email: string; subject: string; parents: string[]; merge: boolean } | undefined {
    const r = this.db.prepare('SELECT sha, at, author, email, subject, parents, merge FROM "commit" WHERE repo = ? AND sha = ?').get(repo, sha) as {
      sha: string; at: string; author: string; email: string; subject: string; parents: string; merge: number;
    } | undefined;
    return r ? { sha: r.sha, at: r.at, author: r.author, email: r.email, subject: r.subject, parents: r.parents ? r.parents.split(' ') : [], merge: r.merge === 1 } : undefined;
  }

  /** The files one commit touched, as recorded. */
  filesForCommit(repo: string, sha: string): { path: string; status: string; oldPath?: string; added?: number; deleted?: number }[] {
    return (this.db.prepare('SELECT path, status, old_path, added, deleted FROM commit_file WHERE repo = ? AND sha = ? ORDER BY path').all(repo, sha) as {
      path: string; status: string; old_path: string | null; added: number | null; deleted: number | null;
    }[]).map((r) => ({
      path: r.path, status: r.status, ...(r.old_path ? { oldPath: r.old_path } : {}),
      ...(r.added == null ? {} : { added: r.added }), ...(r.deleted == null ? {} : { deleted: r.deleted }),
    }));
  }

  /**
   * Record the nodes one commit's hunks changed, against the graph identified by
   * `graph` (a digest). Replaces what the commit had, so a recomputation after
   * the graph moved leaves no stale node behind.
   */
  writeCommitNodes(repo: string, sha: string, graph: string, rows: readonly { node: string; path: string; fileOnly: boolean }[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM commit_node WHERE repo = ? AND sha = ?').run(repo, sha);
      const st = this.db.prepare('INSERT OR REPLACE INTO commit_node (repo, sha, node, path, file_only, graph) VALUES (?,?,?,?,?,?)');
      for (const r of rows) st.run(repo, sha, r.node, r.path, r.fileOnly ? 1 : 0, graph);
      this.db.prepare('INSERT OR REPLACE INTO commit_node_done (repo, sha, graph) VALUES (?,?,?)').run(repo, sha, graph);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The nodes a commit changed, or `null` when they were never computed against `graph` (then compute, never assume none). */
  commitNodes(repo: string, sha: string, graph?: string): { node: string; path: string; fileOnly: boolean }[] | null {
    const done = this.db.prepare('SELECT graph FROM commit_node_done WHERE repo = ? AND sha = ?').get(repo, sha) as { graph: string } | undefined;
    if (!done || (graph && done.graph !== graph)) return null;
    return (this.db.prepare('SELECT node, path, file_only FROM commit_node WHERE repo = ? AND sha = ? ORDER BY path, node').all(repo, sha) as {
      node: string; path: string; file_only: number;
    }[]).map((r) => ({ node: r.node, path: r.path, fileOnly: r.file_only === 1 }));
  }

  /**
   * The commits that changed any of `parts` — the Map's Changes tab (map-pass-2026-10-03 §3 lane N).
   * A part is `{ node, path }`, its path relative to the **source** root; recorded file paths are
   * relative to the **repository** root, so a file matches when it is the path or ends in `/path`.
   * A part is credited `lines` when the commit's hunks were resolved to it (`commit_node`, done for
   * keyed commits), else `file`. Newest first; each commit once, every part it touched listed.
   */
  commitsTouching(repo: string, parts: readonly { node: string; path?: string }[]): {
    sha: string; at: string; author: string; subject: string; parts: { node: string; how: 'lines' | 'file' }[];
  }[] {
    const by = new Map<string, Map<string, 'lines' | 'file'>>();
    const credit = (sha: string, node: string, how: 'lines' | 'file') => {
      const m = by.get(sha) ?? new Map<string, 'lines' | 'file'>();
      if (m.get(node) !== 'lines') m.set(node, how);
      by.set(sha, m);
    };
    const nodeQ = this.db.prepare('SELECT sha, file_only FROM commit_node WHERE repo = ? AND node = ?');
    const fileQ = this.db.prepare('SELECT DISTINCT sha FROM commit_file WHERE repo = ? AND (path = ? OR substr(path, ?) = ?)');
    for (const p of parts) {
      for (const r of nodeQ.all(repo, p.node) as { sha: string; file_only: number }[]) credit(r.sha, p.node, r.file_only === 1 ? 'file' : 'lines');
      if (!p.path) continue;
      const tail = '/' + p.path;
      for (const r of fileQ.all(repo, p.path, -tail.length, tail) as { sha: string }[]) credit(r.sha, p.node, 'file');
    }
    if (!by.size) return [];
    const rowQ = this.db.prepare('SELECT sha, at, author, subject FROM "commit" WHERE repo = ? AND sha = ?');
    const out: { sha: string; at: string; author: string; subject: string; parts: { node: string; how: 'lines' | 'file' }[] }[] = [];
    for (const [sha, m] of by) {
      const r = rowQ.get(repo, sha) as { sha: string; at: string; author: string; subject: string } | undefined;
      if (!r) continue;
      out.push({ sha: r.sha, at: r.at, author: r.author, subject: r.subject, parts: [...m].map(([node, how]) => ({ node, how })) });
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.sha.localeCompare(b.sha)));
  }

  /** The key rules the last spine read of `repo` applied, or undefined when none was recorded. */
  spineReadSig(repo: string): string | undefined {
    const r = this.db.prepare('SELECT keysig FROM spine_read WHERE repo = ?').get(repo) as { keysig: string } | undefined;
    return r?.keysig;
  }

  markSpineRead(repo: string, keysig: string, at: string): void {
    this.db.prepare('INSERT OR REPLACE INTO spine_read (repo, keysig, at) VALUES (?,?,?)').run(repo, keysig, at);
  }

  /**
   * Forget what the spine says about commits git no longer has (a rewritten or re-cloned history):
   * their keys, branches and touched nodes, so no work item lists a commit nobody can show. The
   * commit row itself stays, as the history lens's record of what a past sync read.
   */
  forgetCommitKeys(repo: string, shas: readonly string[]): number {
    if (!shas.length) return 0;
    this.db.exec('BEGIN');
    try {
      let n = 0;
      for (const sha of shas) {
        n += Number(this.db.prepare('DELETE FROM commit_key WHERE repo = ? AND sha = ?').run(repo, sha).changes) > 0 ? 1 : 0;
        for (const t of ['commit_branch', 'commit_node', 'commit_node_done']) this.db.prepare(`DELETE FROM ${t} WHERE repo = ? AND sha = ?`).run(repo, sha);
      }
      this.db.exec('COMMIT');
      return n;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Every commit carrying at least one key, per repository — the set a work join walks. */
  keyedCommits(): { repo: string; sha: string }[] {
    return this.db.prepare('SELECT DISTINCT repo, sha FROM commit_key ORDER BY repo, sha').all() as { repo: string; sha: string }[];
  }

  /**
   * Retain what a screen's design image looked like at one sync
   * (change-history-2026-09.md §5). One row per (sync, node); re-running a
   * sync's capture replaces its rows rather than doubling them.
   *
   * The store records the **address** of the bytes, never the bytes: writing
   * `.farsight/cache/shots/<digest>.<ext>` is the caller's job, because reading
   * a repository's files is the server's business and not core's — the same
   * line `design.ts` holds when it keeps images out of the graph.
   *
   * Like `writeCommits`, nothing here is called by `ingest`: a shot pass is opt
   * in behind a workspace flag, so a workspace that has not asked for it writes
   * no rows and no bytes at all.
   */
  writeShots(sync: number, shots: readonly ShotInput[]): number {
    this.db.exec('BEGIN');
    try {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO sync_shot (sync, node, repo, digest, ext, kind, source, bytes) VALUES (?,?,?,?,?,?,?,?)',
      );
      for (const sh of shots) stmt.run(sync, sh.node, sh.repo, sh.digest, sh.ext, sh.kind, sh.source, sh.bytes);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return shots.length;
  }

  /**
   * The shot retained for this node **at this sync** — or `undefined`, which
   * means no shot was taken then.
   *
   * The sync is matched exactly and the nearest earlier shot is deliberately
   * *not* returned. A reader asking what a screen looked like at sync 41 must
   * not be handed sync 38's picture wearing sync 41's label: the tool knows
   * only what it captured, and every sync a capture ran gets its own row even
   * when the bytes are unchanged (they cost one shared file).
   */
  shotAt(node: string, sync: number): ShotRow | undefined {
    const row = this.db
      .prepare('SELECT sync, node, repo, digest, ext, kind, source, bytes FROM sync_shot WHERE node = ? AND sync = ?')
      .get(node, sync) as ShotRow | undefined;
    return row ?? undefined;
  }

  /** Every shot retained for one node, newest sync first — the point-in-time strip. */
  shotsOf(node: string): ShotRow[] {
    return this.db
      .prepare('SELECT sync, node, repo, digest, ext, kind, source, bytes FROM sync_shot WHERE node = ? ORDER BY sync DESC')
      .all(node) as unknown as ShotRow[];
  }

  /**
   * What one sync retained, and what it cost. `files` is the number of distinct
   * content addresses — the only number that says anything about disk, since
   * rows sharing a digest share one file.
   */
  shotsAt(sync: number): { rows: ShotRow[]; files: number } {
    const rows = this.db
      .prepare('SELECT sync, node, repo, digest, ext, kind, source, bytes FROM sync_shot WHERE sync = ? ORDER BY node')
      .all(sync) as unknown as ShotRow[];
    return { rows, files: new Set(rows.map((r) => r.digest)).size };
  }

  /**
   * Fill `commit_sync` — the join that says "this commit is what a sync
   * recorded" — by matching the shas snapshots already stored against commits
   * now in the history. A sha identifies a commit globally, so both the
   * workspace sha on `snapshot` and the per-source sha on `snapshot_source`
   * count; the `commit` side is scoped to `repo`. Returns rows added, and is
   * safe to re-run. It never invents a link: a sync whose sha is not in the
   * history stays unlinked and its commit reads *not indexed*.
   */
  linkCommitSyncs(repo: string): number {
    const count = () =>
      (this.db.prepare('SELECT COUNT(*) AS n FROM commit_sync WHERE repo = ?').get(repo) as { n: number }).n;
    const before = count();
    for (const from of ['snapshot s ON c.sha = s.commit_sha', 'snapshot_source s ON c.sha = s.commit_sha']) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO commit_sync (repo, sha, sync) SELECT c.repo, c.sha, s.sync FROM "commit" c JOIN ${from} WHERE c.repo = ?`,
        )
        .run(repo);
    }
    return count() - before;
  }

  /**
   * One repository's commits, newest first, each carrying whether a sync ever
   * recorded it. `limit` is a display budget (`farsight history --max`): a
   * truncated list makes the ancestry walks partial, so pass none when folding
   * a spine.
   */
  private commitRows(repo: string, limit?: number): CommitRow[] {
    const rows = this.db
      .prepare('SELECT sha, at, author, email, subject, parents, merge FROM "commit" WHERE repo = ? ORDER BY at DESC, sha LIMIT ?')
      .all(repo, limit ?? Number.MAX_SAFE_INTEGER) as {
      sha: string; at: string; author: string; email: string; subject: string; parents: string; merge: number;
    }[];
    const syncs = new Map<string, number[]>();
    for (const r of this.db
      .prepare('SELECT sha, sync FROM commit_sync WHERE repo = ? ORDER BY sync')
      .all(repo) as { sha: string; sync: number }[]) {
      const list = syncs.get(r.sha);
      if (list) list.push(r.sync);
      else syncs.set(r.sha, [r.sync]);
    }
    return rows.map((r) => {
      const mine = syncs.get(r.sha) ?? [];
      return {
        repo,
        sha: r.sha,
        at: r.at,
        author: r.author,
        email: r.email,
        subject: r.subject,
        parents: r.parents ? r.parents.split(' ').filter(Boolean) : [],
        merge: r.merge === 1,
        indexed: mine.length > 0,
        syncs: mine,
      };
    });
  }

  /**
   * What each sync recorded as **this repository's** commit, oldest first — the
   * spine's left-hand input, and the one place the per-source/workspace
   * distinction is decided.
   *
   * A snapshot carries two shas: `snapshot.commit_sha`, stamped from the
   * *workspace root* (`gitHead(process.cwd())` in ingest, the workspace dir in
   * `/api/sync`), and `snapshot_source.commit_sha`, the source's own. Folding
   * the first for every source is a measurable lie in any multi-source
   * workspace — the dogfood store has `app-a`, `app-b` and `erp-api` rows
   * whose per-source sha is null while the workspace column names the *farsight*
   * repository's commits. So, per sync:
   *
   * 1. this source's own recorded sha wins (`commitFrom: 'source'`);
   * 2. otherwise the workspace sha, **only when this repository's own history
   *    contains it** (`commitFrom: 'workspace'`) — which is the case exactly
   *    when the source is the workspace root or lives inside it, since a sha
   *    names one commit globally. This is the same identity argument
   *    {@link linkCommitSyncs} already relies on, so the two agree by
   *    construction;
   * 3. otherwise **no commit**: the row reads *this sync recorded no commit for
   *    this repo*. Rows written before the writers stamped a per-source sha
   *    cannot be backfilled — the commit that sync saw is not recoverable — and
   *    they must read absent rather than borrow one.
   *
   * Case 3 covers two different situations, so the row carries `inSync` to tell
   * them apart (H3b's open question, settled in H5): a sync that walked this
   * source and stamped nothing, versus a sync this source was not part of at
   * all. The store knows, because `write()` inserts one `snapshot_source` row
   * per source the sync walked. A sync with **no** source rows whatsoever
   * cannot answer the question, and `inSync` is then absent rather than false.
   */
  private sourceSpine(repo: string): SpineSnapshot[] {
    const rows = this.db
      .prepare(
        'SELECT s.sync AS sync, s.at AS at, s.commit_sha AS workspace, ' +
          // a scalar subquery, not a JOIN: two sources may share a name, and a row per
          // duplicate would put the same sync on the spine twice
          '(SELECT x.commit_sha FROM snapshot_source x WHERE x.sync = s.sync AND x.name = ? ' +
          'AND x.commit_sha IS NOT NULL LIMIT 1) AS own, ' +
          // did this source take part at all, and did the sync record any source
          // rows at all — the pair that separates "not in this sync" from
          // "in this sync, no commit stamped" from "unanswerable"
          '(SELECT COUNT(*) FROM snapshot_source x WHERE x.sync = s.sync AND x.name = ?) AS mine, ' +
          // the source's content digest at this sync — what tells a working-tree
          // change on one commit from a re-index on a newer build
          '(SELECT x.source_digest FROM snapshot_source x WHERE x.sync = s.sync AND x.name = ? ' +
          'AND x.source_digest IS NOT NULL LIMIT 1) AS digest, ' +
          '(SELECT COUNT(*) FROM snapshot_source x WHERE x.sync = s.sync) AS anySource ' +
          'FROM snapshot s ORDER BY s.sync',
      )
      .all(repo, repo, repo) as { sync: number; at: string; workspace: string | null; own: string | null; mine: number; digest: string | null; anySource: number }[];
    // Does a history exist for this repository at all? Without one, the containment
    // test below has nothing to run against: every workspace sha would be ruled out
    // and the row would read *this sync recorded no commit*, which is a finding
    // about the sync drawn from a fact about the store. So an unread history yields
    // `commitUnverified` — neither folded nor denied (history.ts `SpineCommitState`).
    const anyHistory = this.db.prepare('SELECT 1 AS hit FROM "commit" WHERE repo = ? LIMIT 1').get(repo) !== undefined;
    const lookup = this.db.prepare('SELECT 1 AS hit FROM "commit" WHERE repo = ? AND sha = ?');
    const decided = new Map<string, boolean>(); // a workspace sha repeats across syncs (33 of the reference app's 48)
    const oursByIdentity = (sha: string): boolean => {
      let hit = decided.get(sha);
      if (hit === undefined) decided.set(sha, (hit = lookup.get(repo, sha) !== undefined));
      return hit;
    };
    return rows.map(({ sync, at, workspace, own, mine, digest, anySource }) => {
      // absent, not false, when the sync recorded no source rows at all
      const took = { ...(anySource ? { inSync: mine > 0 } : {}), ...(digest ? { sourceDigest: digest } : {}) };
      if (own) return { sync, at, commit: own, commitFrom: 'source', ...took };
      if (workspace && anyHistory && oursByIdentity(workspace)) return { sync, at, commit: workspace, commitFrom: 'workspace', ...took };
      // unreadable rather than absent — but only where the sync did not demonstrably
      // exclude this source: a sync that never walked it cannot have recorded its commit
      if (workspace && !anyHistory && took.inSync !== false) return { sync, at, commitUnverified: workspace, ...took };
      return { sync, at, ...took };
    });
  }

  /**
   * The Changes spine (§4-A): every sync newest first with the commits it swept
   * up **for this repository**, the commits older than the first sync, and the
   * commits made since the last one. The fold itself is pure (`spineOf` in
   * `history.ts`); this reads its two inputs — the per-source commits
   * ({@link sourceSpine}) and this repository's commit rows.
   */
  commitSpine(repo: string, opts: { limit?: number } = {}): CommitSpine {
    return spineOf(this.sourceSpine(repo), this.commitRows(repo, opts.limit));
  }

  /**
   * The git narrative for a sync range — drawn beside the measured diff, never
   * merged into it (§2). Both ends are validated as snapshots first, so a
   * pruned sync explains itself. When an end records no commit **for this
   * repository**, or records one the history does not contain (rewritten
   * history, §8), `incomplete` says so and the commits returned are everything
   * reachable from `head` — a labelled over-reach rather than a silent zero.
   */
  commitsBetween(repo: string, base: number, head: number): CommitRange {
    this.snapshotRow(base); // validate both ends exist (throws pruned/unknown otherwise)
    this.snapshotRow(head);
    // per source, exactly as the spine resolves it — never the workspace root's sha
    // for another repository, so the two ends of a range and the rows they bracket
    // can never disagree about which commit a sync recorded
    const spine = new Map(this.sourceSpine(repo).map((s) => [s.sync, s]));
    const b = { commit: spine.get(base)?.commit ?? null };
    const h = { commit: spine.get(head)?.commit ?? null };
    const commits = this.commitRows(repo);
    const known = new Set(commits.map((c) => c.sha));
    const incomplete: IncompleteReason[] = [];
    // with no history read, `no-history` is the whole story: adding base-unknown /
    // head-unknown would assert that those shas are not in a history nobody has read
    if (!commits.length) incomplete.push('no-history');
    if (!b.commit) incomplete.push('base-missing');
    else if (commits.length && !known.has(b.commit)) incomplete.push('base-unknown');
    if (!h.commit) incomplete.push('head-missing');
    else if (commits.length && !known.has(h.commit)) incomplete.push('head-unknown');
    const range = commitsInRange(commits, b.commit ?? undefined, h.commit ?? undefined);
    return {
      repo,
      base,
      head,
      ...(b.commit ? { baseCommit: b.commit } : {}),
      ...(h.commit ? { headCommit: h.commit } : {}),
      commits: range,
      unindexed: range.filter((c) => !c.indexed).length,
      incomplete,
    };
  }

  /**
   * The commits no sync ever recorded, newest first — 51 of the reference app's 66. Each
   * carries `indexed: false`, so the surface renders *not indexed* rather than
   * inferring it from an absence.
   *
   * Reads `commit_sync`, whose workspace-sha join only ever links a sha this
   * repository's own history contains — the same condition {@link sourceSpine}
   * requires before it folds a workspace sha. So a commit this says is indexed
   * is one the spine can also name, and the two never disagree.
   */
  unindexed(repo: string): CommitRow[] {
    return this.commitRows(repo).filter((c) => !c.indexed);
  }

  /**
   * The rows `attributeChanges()` folds over: one repository's commits and the
   * files they touched. `shas` narrows the file rows to a range (a whole
   * history's `commit_file` is the growth term — one reference-app commit alone is 308
   * rows); omit it for everything.
   */
  historyRows(repo: string, opts: { shas?: readonly string[] } = {}): HistoryRows {
    const commits = this.commitRows(repo);
    const files: FileChange[] = [];
    const read = (sql: string, params: unknown[]) => {
      for (const r of this.db.prepare(sql).all(...(params as never[])) as {
        sha: string; path: string; status: string; old_path: string | null;
        added: number | null; deleted: number | null; similarity: number | null;
      }[]) {
        files.push({
          repo,
          sha: r.sha,
          path: r.path,
          status: r.status as FileStatus,
          ...(r.old_path ? { oldPath: r.old_path } : {}),
          ...(r.added === null ? {} : { added: r.added }),
          ...(r.deleted === null ? {} : { deleted: r.deleted }),
          ...(r.similarity === null ? {} : { similarity: r.similarity }),
        });
      }
    };
    const cols = 'SELECT sha, path, status, old_path, added, deleted, similarity FROM commit_file WHERE repo = ?';
    if (!opts.shas) read(cols, [repo]);
    else {
      // chunked: SQLite caps bound parameters (999 by default)
      for (let i = 0; i < opts.shas.length; i += 400) {
        const chunk = opts.shas.slice(i, i + 400);
        read(`${cols} AND sha IN (${chunk.map(() => '?').join(',')})`, [repo, ...chunk]);
      }
    }
    return { commits, files };
  }

  private changedRows(table: 'node' | 'edge', keyCol: 'id' | 'key', base: number, head: number): RowChange[] {
    // every interval overlapping [base, head] — at most one row per key is alive at each end
    const rows = this.db
      .prepare(
        `SELECT ${keyCol} AS key, first_sync, last_sync, hash, json FROM ${table} ` +
          'WHERE first_sync <= ? AND (last_sync IS NULL OR last_sync >= ?)',
      )
      .all(head, base) as unknown as AliveRow[];
    const aliveAt = (r: AliveRow, sync: number) => r.first_sync <= sync && (r.last_sync === null || r.last_sync >= sync);
    const atBase = new Map<string, AliveRow>();
    const atHead = new Map<string, AliveRow>();
    for (const r of rows) {
      if (aliveAt(r, base)) atBase.set(r.key, r);
      if (aliveAt(r, head)) atHead.set(r.key, r);
    }
    const changes: RowChange[] = [];
    for (const [key, b] of atBase) {
      const h = atHead.get(key);
      if (!h) changes.push({ key, change: 'removed', before: JSON.parse(b.json) });
      else if (h.hash !== b.hash) changes.push({ key, change: 'changed', before: JSON.parse(b.json), after: JSON.parse(h.json) });
    }
    for (const [key, h] of atHead) {
      if (!atBase.has(key)) changes.push({ key, change: 'added', after: JSON.parse(h.json) });
    }
    changes.sort((a, b) => a.key.localeCompare(b.key));
    return changes;
  }

  /** Resolve a sync ref to its snapshot row, distinguishing "pruned" from "not yet". */
  private snapshotRow(ref: 'latest' | number): {
    sync: number; at: string; tz: string; commit: string | null; digest: string; files: number;
  } {
    if (ref === 'latest') {
      const row = this.db
        .prepare('SELECT sync, at, tz, commit_sha AS "commit", digest, files FROM snapshot ORDER BY sync DESC LIMIT 1')
        .get() as { sync: number; at: string; tz: string; commit: string | null; digest: string; files: number } | undefined;
      if (!row) throw new Error(`no snapshots recorded yet in ${this.dbPath} — run \`farsight ingest\` first`);
      return row;
    }
    const row = this.db
      .prepare('SELECT sync, at, tz, commit_sha AS "commit", digest, files FROM snapshot WHERE sync = ?')
      .get(ref) as { sync: number; at: string; tz: string; commit: string | null; digest: string; files: number } | undefined;
    if (row) return row;
    const bounds = this.db.prepare('SELECT MIN(sync) AS min, MAX(sync) AS max FROM snapshot').get() as {
      min: number | null;
      max: number | null;
    };
    // syncs are monotonic, so any missing sync <= max was pruned, not mistyped
    if (bounds.max !== null && ref >= 1 && ref <= bounds.max) {
      throw new Error(
        `sync:${ref} was pruned by the retention policy — history now starts at sync:${bounds.min} ` +
          '(pin snapshots you need to keep: `farsight snapshots --pin sync:N`)',
      );
    }
    throw new Error(
      bounds.max === null
        ? `no snapshots recorded yet in ${this.dbPath} — run \`farsight ingest\` first`
        : `sync:${ref} does not exist — latest is sync:${bounds.max}`,
    );
  }
}

/** One commit naming one work-item key, and how (a `commit_key` row joined to its commit). */
export interface CommitKeyRow {
  repo: string;
  sha: string;
  key: string;
  provider: string;
  via: string;
  ref?: string;
  at: string;
  author: string;
  email: string;
  subject: string;
  merge: boolean;
}
