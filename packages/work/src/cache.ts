// The local work-item cache (docs/proposals/work-items-sync.md §5, ADR 10):
// a replica with a cursor and an outbox, never a merge. A pull REPLACES an
// item with what the tracker said; an intent is a request, not a local edit.
//
// `.farsight/work.db`, built-in `node:sqlite` beside farsight.db (ADR 7),
// opened the way core's snapshots.ts opens it; when the module is missing we
// degrade honestly with WorkCacheUnavailable. Retention: keep everything
// (decided 2026-09-30); `audit` is never pruned.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadSqlite, type SqliteModule } from '@farsight/core';
import type {
  WorkItem, WorkType, StateCategory, Person, Intent, IntentState, Verdicts, ApplyResult, WorkAction, RequestedBy,
} from './contract.js';
import type { Cursor, Schema, SourceConfig } from './provider.js';

export class WorkCacheUnavailable extends Error {
  constructor() {
    super(
      `work-item cache unavailable: node:sqlite is missing on this runtime (Node ${process.version}; ` +
        `Farsight needs Node >= 24). Sources read live, slower.`,
    );
    this.name = 'WorkCacheUnavailable';
  }
}

/** The cache's conventional path in a workspace. */
export function workDbPath(workspace: string): string {
  return join(workspace, '.farsight', 'work.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  scope TEXT NOT NULL,            -- JSON Scope
  mode TEXT NOT NULL,
  cursor TEXT,                    -- opaque, provider-owned
  schema TEXT,                    -- JSON discover() result
  schema_at TEXT,
  last_attempt_at TEXT,
  last_ok_at TEXT,
  last_sync INTEGER,              -- sync number of the last successful sync
  last_error TEXT,                -- words, never a secret
  last_error_kind TEXT,           -- 'unreachable' | 'credential' | 'other'
  failing_since TEXT              -- first failed attempt after the last good sync; NULL when healthy
);
CREATE TABLE IF NOT EXISTS sync (
  no INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pull', -- 'pull' | 'write' (the re-read after a write-back)
  at TEXT NOT NULL,
  pulled INTEGER, changed INTEGER, deleted INTEGER,
  cursor TEXT, duration_ms INTEGER, error TEXT
);
CREATE TABLE IF NOT EXISTS item (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  assignee TEXT,
  updated TEXT NOT NULL,
  parent TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  sync INTEGER NOT NULL,          -- the sync that last wrote this row
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS item_key ON item(key);
CREATE INDEX IF NOT EXISTS item_source ON item(source, state);
CREATE INDEX IF NOT EXISTS item_assignee ON item(assignee);
CREATE INDEX IF NOT EXISTS item_parent ON item(parent);
CREATE TABLE IF NOT EXISTS item_rev (
  id TEXT NOT NULL,
  first_sync INTEGER NOT NULL,
  last_sync INTEGER,              -- NULL = still current
  hash TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (id, first_sync)
);
CREATE INDEX IF NOT EXISTS item_rev_open ON item_rev(id, last_sync);
CREATE TABLE IF NOT EXISTS comment (
  item TEXT NOT NULL, id TEXT NOT NULL, author TEXT, created TEXT, updated TEXT, json TEXT NOT NULL,
  PRIMARY KEY (item, id)
);
CREATE TABLE IF NOT EXISTS change (
  item TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, by TEXT, field TEXT NOT NULL, from_value TEXT, to_value TEXT,
  PRIMARY KEY (item, seq)
);
CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS link (
  work TEXT NOT NULL, node TEXT NOT NULL, kind TEXT NOT NULL,
  provenance TEXT NOT NULL,       -- 'declared' | 'commit' | 'branch' | 'name-match' | …
  tier TEXT NOT NULL,             -- 'HIGH' | 'MEDIUM' | 'LOW'
  detail TEXT, at TEXT NOT NULL,
  PRIMARY KEY (work, node, kind, provenance)
);
CREATE INDEX IF NOT EXISTS link_node ON link(node);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, item TEXT NOT NULL, action TEXT NOT NULL,
  payload TEXT NOT NULL, requested_by TEXT NOT NULL, base_revision TEXT,
  state TEXT NOT NULL, verdicts TEXT, result TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL,
  intent TEXT, item TEXT, action TEXT, requested_by TEXT, verdicts TEXT,
  outcome TEXT NOT NULL, detail TEXT,
  preview TEXT                    -- JSON { ok, reason }: the tracker's dry-run answer, beside the three verdicts
);
`;

export interface SourceRow {
  id: string;
  provider: string;
  scope: SourceConfig['scope'];
  mode: 'read-only' | 'edit';
  cursor: Cursor | null;
  schema: Schema | null;
  schemaAt: string | null;
  lastAttemptAt: string | null;
  lastOkAt: string | null;
  lastSync: number | null;
  lastError: string | null;
  lastErrorKind: 'unreachable' | 'credential' | 'other' | null;
  failingSince: string | null;
}

export interface ItemFilter {
  source?: string;
  state?: StateCategory;
  type?: WorkType;
  /** Person.id, or a name matched case-insensitively */
  assignee?: string;
  parent?: string;
  includeDeleted?: boolean;
}

export interface WorkLink {
  work: string;
  node: string;
  kind: string;
  provenance: string;
  tier: 'HIGH' | 'MEDIUM' | 'LOW';
  detail?: string;
  at: string;
}

export interface OutboxRow {
  intent: Intent;
  source: string;
  state: IntentState;
  verdicts?: Verdicts;
  result?: ApplyResult;
  created: string;
  updated: string;
}

export interface AuditRow {
  seq?: number;
  at: string;
  source: string;
  intent?: string;
  item?: string;
  action?: WorkAction;
  requestedBy?: RequestedBy;
  verdicts?: Verdicts;
  /** 'allowed' | 'denied' | 'confirm-pending' | 'confirmed' | 'conflict' | 'failed' | 'dry-run-refused' | … */
  outcome: string;
  detail?: unknown;
  /** the tracker's dry-run answer, when the provider has preview() — a fact beside the three verdicts, not a fourth */
  preview?: PreviewFact;
}

export interface PreviewFact { ok: boolean; reason: string }

type Db = InstanceType<SqliteModule['DatabaseSync']>;
const hash = (json: string) => createHash('sha1').update(json).digest('hex');
const parse = <T>(s: unknown): T | null => (typeof s === 'string' ? (JSON.parse(s) as T) : null);

export class WorkCache {
  private db: Db;

  /** Opens (creating directories) and migrates. Throws WorkCacheUnavailable when node:sqlite is missing. */
  constructor(readonly dbPath: string) {
    const sqlite = loadSqlite();
    if (!sqlite) throw new WorkCacheUnavailable();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new sqlite.DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    // additive: a work.db written before the dry-run fact gains the column and keeps every row
    const cols = this.db.prepare('PRAGMA table_info(audit)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'preview')) this.db.exec('ALTER TABLE audit ADD COLUMN preview TEXT');
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` in one transaction. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── sources and syncs ────────────────────────────────────────────────────

  upsertSource(cfg: Pick<SourceConfig, 'id' | 'provider' | 'scope' | 'mode'>): void {
    this.db
      .prepare(
        `INSERT INTO source (id, provider, scope, mode) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, scope = excluded.scope, mode = excluded.mode`,
      )
      .run(cfg.id, cfg.provider, JSON.stringify(cfg.scope ?? { projects: [] }), cfg.mode ?? 'read-only');
  }

  getSource(id: string): SourceRow | null {
    const r = this.db.prepare('SELECT * FROM source WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      provider: r.provider as string,
      scope: parse(r.scope) ?? { projects: [] },
      mode: r.mode as SourceRow['mode'],
      cursor: (r.cursor as string | null) ?? null,
      schema: parse<Schema>(r.schema),
      schemaAt: (r.schema_at as string | null) ?? null,
      lastAttemptAt: (r.last_attempt_at as string | null) ?? null,
      lastOkAt: (r.last_ok_at as string | null) ?? null,
      lastSync: (r.last_sync as number | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      lastErrorKind: (r.last_error_kind as SourceRow['lastErrorKind']) ?? null,
      failingSince: (r.failing_since as string | null) ?? null,
    };
  }

  listSources(): SourceRow[] {
    return (this.db.prepare('SELECT id FROM source ORDER BY id').all() as { id: string }[]).map((r) => this.getSource(r.id)!);
  }

  setSchema(id: string, schema: Schema, at: string): void {
    this.db.prepare('UPDATE source SET schema = ?, schema_at = ? WHERE id = ?').run(JSON.stringify(schema), at, id);
  }

  /** Open a sync: returns its number (global, monotonic, like farsight.db's sync). */
  beginSync(sourceId: string, at: string): number {
    this.db.prepare('UPDATE source SET last_attempt_at = ? WHERE id = ?').run(at, sourceId);
    const r = this.db.prepare('INSERT INTO sync (source, at) VALUES (?,?)').run(sourceId, at);
    return Number(r.lastInsertRowid);
  }

  /** Close a sync with its outcome, and record it on the source row. */
  finishSync(
    sourceId: string,
    no: number,
    o: { at: string; pulled: number; changed: number; deleted: number; cursor: Cursor | null; durationMs: number; error?: string; errorKind?: SourceRow['lastErrorKind'] },
  ): void {
    this.db
      .prepare('UPDATE sync SET pulled = ?, changed = ?, deleted = ?, cursor = ?, duration_ms = ?, error = ? WHERE no = ?')
      .run(o.pulled, o.changed, o.deleted, o.cursor, o.durationMs, o.error ?? null, no);
    if (o.error) {
      this.db
        .prepare('UPDATE source SET last_error = ?, last_error_kind = ?, failing_since = COALESCE(failing_since, ?) WHERE id = ?')
        .run(o.error, o.errorKind ?? 'other', o.at, sourceId);
    } else {
      this.db
        .prepare('UPDATE source SET cursor = ?, last_ok_at = ?, last_sync = ?, last_error = NULL, last_error_kind = NULL, failing_since = NULL WHERE id = ?')
        .run(o.cursor, o.at, no, sourceId);
    }
  }

  /**
   * A sync number for the re-read after a write-back: the item's new version gets
   * its own interval, and the source's cursor and freshness are left alone (one
   * item re-read is not the whole source agreeing with the tracker).
   */
  writeSync(sourceId: string, at: string): number {
    const r = this.db.prepare("INSERT INTO sync (source, kind, at, pulled, changed, deleted) VALUES (?, 'write', ?, 1, 1, 0)").run(sourceId, at);
    return Number(r.lastInsertRowid);
  }

  /** How many syncs of this kind the source has had, the open one included. */
  countSyncs(sourceId: string, kind: 'pull' | 'write' = 'pull'): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sync WHERE source = ? AND kind = ?').get(sourceId, kind) as { n: number }).n;
  }

  /** Recent syncs of a source, newest first. */
  listSyncs(sourceId: string, limit = 20): { no: number; kind: string; at: string; pulled: number | null; changed: number | null; deleted: number | null; error: string | null }[] {
    return this.db.prepare('SELECT no, kind, at, pulled, changed, deleted, error FROM sync WHERE source = ? ORDER BY no DESC LIMIT ?').all(sourceId, limit) as never;
  }

  // ── items ────────────────────────────────────────────────────────────────

  /**
   * Replace an item with what the tracker said, as of sync `syncNo` — never a merge.
   * Returns true when the record changed (a new item_rev interval opened).
   */
  replaceItem(sourceId: string, item: WorkItem, syncNo: number): boolean {
    const json = JSON.stringify(item);
    const h = hash(json);
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO item (id, source, key, type, state, assignee, updated, parent, deleted, sync, json) VALUES (?,?,?,?,?,?,?,?,0,?,?)
           ON CONFLICT(id) DO UPDATE SET source = excluded.source, key = excluded.key, type = excluded.type, state = excluded.state,
             assignee = excluded.assignee, updated = excluded.updated, parent = excluded.parent, deleted = 0, sync = excluded.sync, json = excluded.json`,
        )
        .run(item.id, sourceId, item.key, item.type.category, item.state.category, item.assignee?.id ?? null, item.updated, item.parent ?? null, syncNo, json);

      const open = this.db.prepare('SELECT first_sync, hash FROM item_rev WHERE id = ? AND last_sync IS NULL').get(item.id) as
        | { first_sync: number; hash: string }
        | undefined;
      let changed = false;
      if (!open || open.hash !== h) {
        changed = true;
        if (open) {
          // a second write in the same sync replaces that sync's version rather than making an empty interval
          if (open.first_sync === syncNo) this.db.prepare('DELETE FROM item_rev WHERE id = ? AND first_sync = ?').run(item.id, syncNo);
          else this.db.prepare('UPDATE item_rev SET last_sync = ? WHERE id = ? AND last_sync IS NULL').run(syncNo - 1, item.id);
        }
        this.db.prepare('INSERT INTO item_rev (id, first_sync, last_sync, hash, json) VALUES (?,?,NULL,?,?)').run(item.id, syncNo, h, json);
      }

      this.db.prepare('DELETE FROM comment WHERE item = ?').run(item.id);
      const cst = this.db.prepare('INSERT OR REPLACE INTO comment (item, id, author, created, updated, json) VALUES (?,?,?,?,?,?)');
      for (const c of item.comments) cst.run(item.id, c.id, c.author.id, c.created, c.updated ?? null, JSON.stringify(c));
      this.db.prepare('DELETE FROM change WHERE item = ?').run(item.id);
      const hst = this.db.prepare('INSERT INTO change (item, seq, at, by, field, from_value, to_value) VALUES (?,?,?,?,?,?,?)');
      item.history.forEach((c, i) => hst.run(item.id, i, c.at, c.by?.id ?? null, c.field, c.from ?? null, c.to ?? null));

      const seen = [item.assignee, item.reporter, ...item.comments.map((c) => c.author), ...item.history.map((c) => c.by)];
      for (const p of seen) if (p) this.putPerson(p, item.updated);
      return changed;
    });
  }

  private putPerson(p: Person, at: string): void {
    this.db
      .prepare(
        `INSERT INTO person (id, name, email, last_seen) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = COALESCE(excluded.email, person.email), last_seen = excluded.last_seen
         WHERE excluded.last_seen >= person.last_seen`,
      )
      .run(p.id, p.name, p.email ?? null, at);
  }

  /** People last seen with this exact name (case-insensitive) — display names are not unique. */
  findPeople(name: string): Person[] {
    return (this.db.prepare('SELECT id, name, email FROM person WHERE lower(name) = lower(?) ORDER BY id').all(name) as { id: string; name: string; email: string | null }[])
      .map((r) => ({ id: r.id, name: r.name, ...(r.email ? { email: r.email } : {}) }));
  }

  getPerson(id: string): Person | null {
    const r = this.db.prepare('SELECT id, name, email FROM person WHERE id = ?').get(id) as { id: string; name: string; email: string | null } | undefined;
    return r ? { id: r.id, name: r.name, ...(r.email ? { email: r.email } : {}) } : null;
  }

  /** The tracker says it is gone, as of sync `syncNo`: the row stays (history), flagged; its interval closes at syncNo − 1. */
  markDeleted(id: string, syncNo: number): boolean {
    return this.tx(() => {
      const r = this.db.prepare('UPDATE item SET deleted = 1, sync = ? WHERE id = ? AND deleted = 0').run(syncNo, id);
      this.db.prepare('UPDATE item_rev SET last_sync = ? WHERE id = ? AND last_sync IS NULL').run(syncNo - 1, id);
      return Number(r.changes) > 0;
    });
  }

  getItem(id: string, opts: { includeDeleted?: boolean } = {}): WorkItem | null {
    const r = this.db.prepare(`SELECT json FROM item WHERE id = ?${opts.includeDeleted ? '' : ' AND deleted = 0'}`).get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as WorkItem) : null;
  }

  /** Items whose key is `key` (a key is unique per source, not across sources). */
  findByKey(key: string, source?: string): WorkItem[] {
    const rows = (source
      ? this.db.prepare('SELECT json FROM item WHERE key = ? AND source = ? AND deleted = 0').all(key, source)
      : this.db.prepare('SELECT json FROM item WHERE key = ? AND deleted = 0 ORDER BY source').all(key)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as WorkItem);
  }

  listItems(filter: ItemFilter = {}): WorkItem[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (!filter.includeDeleted) where.push('deleted = 0');
    if (filter.source) { where.push('source = ?'); args.push(filter.source); }
    if (filter.state) { where.push('state = ?'); args.push(filter.state); }
    if (filter.type) { where.push('type = ?'); args.push(filter.type); }
    if (filter.parent) { where.push('parent = ?'); args.push(filter.parent); }
    const sql = `SELECT json FROM item${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY source, key`;
    let items = (this.db.prepare(sql).all(...args) as { json: string }[]).map((r) => JSON.parse(r.json) as WorkItem);
    if (filter.assignee) {
      const a = filter.assignee.toLowerCase();
      items = items.filter((i) => i.assignee && (i.assignee.id === filter.assignee || i.assignee.name.toLowerCase().includes(a)));
    }
    // natural key order: INV-2 before INV-10
    return items.sort((x, y) => x.source.localeCompare(y.source) || x.key.localeCompare(y.key, undefined, { numeric: true }));
  }

  /** The item as it was at sync `syncNo` (interval read), or null when it did not exist then. */
  itemAt(id: string, syncNo: number): WorkItem | null {
    const r = this.db
      .prepare('SELECT json FROM item_rev WHERE id = ? AND first_sync <= ? AND (last_sync IS NULL OR last_sync >= ?) ORDER BY first_sync DESC LIMIT 1')
      .get(id, syncNo, syncNo) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as WorkItem) : null;
  }

  /** Every version of an item: `{ firstSync, lastSync|null, item }`, oldest first. */
  revisions(id: string): { firstSync: number; lastSync: number | null; item: WorkItem }[] {
    return (this.db.prepare('SELECT first_sync, last_sync, json FROM item_rev WHERE id = ? ORDER BY first_sync').all(id) as {
      first_sync: number; last_sync: number | null; json: string;
    }[]).map((r) => ({ firstSync: r.first_sync, lastSync: r.last_sync, item: JSON.parse(r.json) as WorkItem }));
  }

  // ── links (§9) ───────────────────────────────────────────────────────────

  putLink(l: WorkLink): void {
    this.db
      .prepare('INSERT OR REPLACE INTO link (work, node, kind, provenance, tier, detail, at) VALUES (?,?,?,?,?,?,?)')
      .run(l.work, l.node, l.kind, l.provenance, l.tier, l.detail ?? null, l.at);
  }

  /** Links touching `id`, whether it is the work item or the graph node. */
  linksFor(id: string): WorkLink[] {
    return (this.db.prepare('SELECT * FROM link WHERE work = ? OR node = ? ORDER BY work, node').all(id, id) as Record<string, string>[]).map((r) => ({
      work: r.work!, node: r.node!, kind: r.kind!, provenance: r.provenance!, tier: r.tier as WorkLink['tier'],
      ...(r.detail ? { detail: r.detail } : {}), at: r.at!,
    }));
  }

  // ── outbox and audit (§5, §7, §8) ────────────────────────────────────────

  enqueueIntent(source: string, intent: Intent, at: string): void {
    this.db
      .prepare('INSERT INTO outbox (id, source, item, action, payload, requested_by, base_revision, state, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(intent.id, source, intent.item, intent.action, JSON.stringify(intent.payload), JSON.stringify(intent.requestedBy), intent.baseRevision ?? null, 'queued', at, at);
  }

  updateIntent(id: string, patch: { state: IntentState; verdicts?: Verdicts; result?: ApplyResult; at: string }): void {
    this.db
      .prepare('UPDATE outbox SET state = ?, verdicts = COALESCE(?, verdicts), result = COALESCE(?, result), updated = ? WHERE id = ?')
      .run(patch.state, patch.verdicts ? JSON.stringify(patch.verdicts) : null, patch.result ? JSON.stringify(patch.result) : null, patch.at, id);
  }

  getIntent(id: string): OutboxRow | null {
    return this.listOutbox({ id })[0] ?? null;
  }

  listOutbox(filter: { source?: string; state?: IntentState; item?: string; id?: string } = {}): OutboxRow[] {
    const where: string[] = [];
    const args: string[] = [];
    for (const [col, v] of [['source', filter.source], ['state', filter.state], ['item', filter.item], ['id', filter.id]] as const) {
      if (v) { where.push(`${col} = ?`); args.push(v); }
    }
    const rows = this.db.prepare(`SELECT * FROM outbox${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created, id`).all(...args) as Record<string, string | null>[];
    return rows.map((r) => ({
      intent: {
        id: r.id!, item: r.item!, action: r.action as WorkAction, payload: JSON.parse(r.payload!), requestedBy: JSON.parse(r.requested_by!),
        ...(r.base_revision ? { baseRevision: r.base_revision } : {}),
      },
      source: r.source!, state: r.state as IntentState,
      ...(r.verdicts ? { verdicts: JSON.parse(r.verdicts) } : {}),
      ...(r.result ? { result: JSON.parse(r.result) } : {}),
      created: r.created!, updated: r.updated!,
    }));
  }

  audit(row: AuditRow): number {
    const r = this.db
      .prepare('INSERT INTO audit (at, source, intent, item, action, requested_by, verdicts, outcome, detail, preview) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(row.at, row.source, row.intent ?? null, row.item ?? null, row.action ?? null,
        row.requestedBy ? JSON.stringify(row.requestedBy) : null, row.verdicts ? JSON.stringify(row.verdicts) : null,
        row.outcome, row.detail === undefined ? null : JSON.stringify(row.detail), row.preview ? JSON.stringify(row.preview) : null);
    return Number(r.lastInsertRowid);
  }

  listAudit(filter: { source?: string; item?: string; intent?: string } = {}): AuditRow[] {
    const where: string[] = [];
    const args: string[] = [];
    for (const [col, v] of [['source', filter.source], ['item', filter.item], ['intent', filter.intent]] as const) {
      if (v) { where.push(`${col} = ?`); args.push(v); }
    }
    const rows = this.db.prepare(`SELECT * FROM audit${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq`).all(...args) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      seq: r.seq as number, at: r.at as string, source: r.source as string,
      ...(r.intent ? { intent: r.intent as string } : {}),
      ...(r.item ? { item: r.item as string } : {}),
      ...(r.action ? { action: r.action as WorkAction } : {}),
      ...(r.requested_by ? { requestedBy: JSON.parse(r.requested_by as string) } : {}),
      ...(r.verdicts ? { verdicts: JSON.parse(r.verdicts as string) } : {}),
      outcome: r.outcome as string,
      ...(r.detail ? { detail: JSON.parse(r.detail as string) } : {}),
      ...(r.preview ? { preview: JSON.parse(r.preview as string) } : {}),
    }));
  }
}
