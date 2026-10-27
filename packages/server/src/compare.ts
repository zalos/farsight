// Two syncs of one storyline set side by side (round 2026-10-10, proposal 7), and any sync the history holds served
// as a graph (`/graph?asof=`, closing the swarm's 9.1: a pinned link could only note the difference). One module, so
// the routes, the Map's compare control and the CLI read the same ends the same way: core `resolveCompareFrom()`,
// core `storylineDiff()` over two `compareSideOf()` reads, the later end the served graph when it is that sync.
//
// Read-only throughout: the history store is only read, and only when it exists. A sync it does not hold is said
// with the absence word *not indexed*, never drawn from a neighbour.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  SnapshotDb,
  buildIndex,
  setFreshnessMeta,
  storylineDiff,
  storylineDiffDocument,
  resolveCompareFrom,
  compareSideOf,
  lastGreenSync,
  parseFailOn,
  t,
  type CompareSide,
  type GraphEdge,
  type GraphIndex,
  type GraphMeta,
  type GraphNode,
} from '@farsight/core';

/** A sync's graph rebuilt from history, shaped like a graph file: what `/graph?asof=` sends and the routes index. */
export interface SyncGraph {
  /** always 0: a sync from history never changes on disk (the served graph's cache keys on its file's mtime) */
  mtimeMs: number;
  sync: number;
  roots: Record<string, string>;
  meta: GraphMeta;
  index: GraphIndex;
  edgesById: Map<string, GraphEdge>;
  /** the JSON a `/graph?asof=` answer sends, built on first ask */
  json?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  metaKept: boolean;
}

/** The two most recent syncs read, per workspace — a graph of 20k nodes is worth keeping for the next ask, not a third. */
const CACHE = new Map<string, SyncGraph>();
const CACHE_MAX = 2;

export type SyncAnswer = { g: SyncGraph } | { code: number; error: string; absent?: 'notIndexed' };

/** The history store of a workspace, or why there is none. */
function openDb(ws: string): SnapshotDb | { code: number; error: string; absent?: 'notIndexed' } {
  const path = join(ws, '.farsight', 'farsight.db');
  if (!existsSync(path))
    return {
      code: 404,
      error: 'no history in this workspace — a sync records one (farsight ingest or POST /api/sync)',
      absent: 'notIndexed',
    };
  try {
    return new SnapshotDb(path);
  } catch (err) {
    return { code: 503, error: `history unavailable: ${(err as Error).message.split('\n')[0]}` };
  }
}

/** `41`, `sync:41`, `latest` → a sync number, or null. */
export function syncParam(value: string | null): number | 'latest' | null {
  if (!value) return null;
  const v = value.trim();
  if (v === 'latest' || v === 'now') return 'latest';
  const n = Number(v.replace(/^sync:/, ''));
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * One sync's graph from history, with the served graph's roots (a snapshot carries none: they are per machine).
 * Not held → the absence word.
 */
export function syncGraph(ws: string, sync: number, roots: Record<string, string>): SyncAnswer {
  const key = `${ws}\u0000${sync}`;
  const hit = CACHE.get(key);
  if (hit) {
    CACHE.delete(key);
    CACHE.set(key, hit);
    return { g: hit };
  }
  const db = openDb(ws);
  if (!(db instanceof SnapshotDb)) return db;
  try {
    if (!db.has(sync))
      return {
        code: 404,
        error: t('compare.panel.unheld', 'professional').replace('{sync}', String(sync)),
        absent: 'notIndexed',
      };
    const r = db.read(sync);
    const { nodes, edges } = r.store.toJSON();
    const index = buildIndex(nodes, edges);
    setFreshnessMeta(index, r.store.meta);
    const g: SyncGraph = {
      mtimeMs: 0,
      sync,
      roots,
      meta: r.store.meta,
      index,
      edgesById: new Map(edges.map((e) => [e.id, e])),
      nodes,
      edges,
      metaKept: r.metaKept,
    };
    CACHE.set(key, g);
    while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value!);
    return { g };
  } finally {
    db.close();
  }
}

/** The graph-file JSON of a sync read from history: nodes, edges, the served roots, and its own meta. */
export function syncGraphJson(g: SyncGraph): string {
  if (!g.json)
    g.json = JSON.stringify({
      nodes: g.nodes,
      edges: g.edges,
      roots: g.roots,
      meta: { ...g.meta, asOf: { sync: g.sync, metaKept: g.metaKept } },
    });
  return g.json;
}

/** What `/api/compare` answers with: the diff, the two ends, how the earlier one was named, and the syncs to pick from. */
export function compareAnswer(
  ws: string,
  current: { index: GraphIndex; meta: GraphMeta; roots: Record<string, string> },
  q: URLSearchParams,
): { code: number; body: unknown } {
  const storyline = (q.get('storyline') ?? '').trim();
  if (!storyline) return { code: 400, body: { error: 'missing ?storyline=<id>' } };
  const repo = q.get('repo') || undefined;
  const db = openDb(ws);
  if (!(db instanceof SnapshotDb))
    return {
      code: db.code,
      body: {
        error: db.error,
        ...(db.absent ? { absent: db.absent, word: t('journey.absent.notIndexed', 'professional') } : {}),
      },
    };
  try {
    const servedSync = current.meta.sync ?? null;
    const toParam = syncParam(q.get('to'));
    const toSync = toParam === null || toParam === 'latest' ? servedSync : toParam;
    let b: CompareSide;
    if (toSync != null && toSync === servedSync) {
      b = {
        index: current.index,
        meta: current.meta,
        end: {
          sync: servedSync,
          ...(current.meta.generatedAt ? { at: current.meta.generatedAt } : {}),
          ...(current.meta.commit ? { commit: current.meta.commit } : {}),
          metaKept: true,
        },
      };
    } else if (toSync != null) {
      if (!db.has(toSync))
        return {
          code: 404,
          body: {
            error: t('compare.panel.unheld', 'professional').replace('{sync}', String(toSync)),
            absent: 'notIndexed',
            word: t('journey.absent.notIndexed', 'professional'),
          },
        };
      b = compareSideOf(db, toSync);
    } else {
      return {
        code: 404,
        body: {
          error: 'the served graph has no sync number — a sync records one',
          absent: 'notIndexed',
          word: t('journey.absent.notIndexed', 'professional'),
        },
      };
    }
    const head = b.end.sync!;
    const ref = resolveCompareFrom(db, q.get('from') ?? 'previous', {
      head,
      storyline,
      ...(repo ? { repo } : {}),
      declaredBy: b,
      lastGreen: () => lastGreenSync(db, storyline, head, { ...(repo ? { repo } : {}), declaredBy: b }),
    });
    const syncs = db.list(40).map((s) => ({ sync: s.sync, at: s.at, ...(s.commit ? { commit: s.commit } : {}) }));
    // no green run is an answer, not a missing resource: the absence word and the sentence, never a 404 (swarm round 3)
    if ('error' in ref && ref.noGreen)
      return {
        code: 200,
        body: {
          absent: 'notIndexed',
          word: t('journey.absent.notIndexed', 'professional'),
          sentence: ref.error,
          noGreen: true,
          syncs,
        },
      };
    if ('error' in ref)
      return {
        code: 404,
        body: {
          error: ref.error,
          ...(ref.absent ? { absent: ref.absent, word: t('journey.absent.notIndexed', 'professional') } : {}),
          syncs,
        },
      };
    if (ref.sync >= head)
      return {
        code: 400,
        body: { error: `the earlier end (sync ${ref.sync}) must come before the later one (sync ${head})`, syncs },
      };
    const a = compareSideOf(db, ref.sync);
    const diff = storylineDiff(a, b, storyline, repo ? { repo } : {});
    if (!diff)
      return { code: 404, body: { error: `no storyline ${storyline} at sync ${ref.sync} or sync ${head}`, syncs } };
    const failOn = q.get('failOn') ? parseFailOn(q.get('failOn')!).kinds : undefined;
    const withDoc = q.get('format') === 'diff' || !!failOn;
    return {
      code: 200,
      body: {
        from: { ...diff.from, how: ref.how, ...(ref.label ? { label: ref.label } : {}) },
        to: { ...diff.to, served: head === servedSync },
        diff,
        ...(withDoc ? { document: storylineDiffDocument(diff, failOn ? { failOn } : {}) } : {}),
        syncs,
      },
    };
  } finally {
    db.close();
  }
}
