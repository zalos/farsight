import { buildInfo } from './version.js';
import type { BuildInfo } from './version.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { GraphFragment, GraphNode, GraphEdge, TestsMeta, StoriesMeta, StoresMeta, PackagesMeta, ProjectsMeta, ConfigMeta, JourneysMeta } from './graph.js';

/** Freshness signals persisted with the snapshot — lets consumers (MCP agents
 * especially) detect a stale graph instead of getting confidently old answers. */
export interface GraphMeta {
  generatedAt?: string; // ISO timestamp of the last save
  files?: number; // source files parsed across all fragments
  sourceHash?: string; // hash over file paths+mtimes; changes when the code does
  /** hash over the file *contents* (parsers/shared/files.ts contentDigest) — what a test report must stamp to prove "unchanged since the run" */
  sourceDigest?: string;
  /** per-repo freshness, kept so `repoMeta()` still answers after a save → load round trip */
  repos?: Record<string, { files: number; sourceHash: string; sourceDigest?: string }>;
  /** ordinal snapshot id (SnapshotDb) — "SYNC 41". Absent when no snapshot store recorded this graph. */
  sync?: number;
  /** content digest over sorted node ids + edge keys + resolution tiers (snapshots.digestOf) */
  digest?: string;
  /** git commit sha of the workspace at snapshot time, when known */
  commit?: string;
  /** IANA timezone the snapshot timestamp was taken in — always shown next to times (G12) */
  tz?: string;
  /** workspace this graph belongs to (directory basename) — "which graph am I looking at" across HUD and MCP */
  workspace?: string;
  /** absolute path of the graph file, stamped at save */
  graphPath?: string;
  /** the Farsight build that wrote this graph (version · built · commit) — consumers compare it with the running build */
  farsight?: BuildInfo;
  /** per-repo tests freshness: what reports were read, and one sentence per blind spot (docs/proposals/tests-surface.md §3.1) */
  tests?: Record<string, TestsMeta>;
  /** per-repo stories: the Storybooks the repo carries and what the stories pass read (ADR 9) */
  stories?: Record<string, StoriesMeta>;
  /** per-repo store pass: the SQL drivers read, how many tables each rule named, and why a rule named nothing (data-stores.md) */
  stores?: Record<string, StoresMeta>;
  /** per-repo import pass: the Node built-ins set aside, alias misses, undeclared packages (dependencies-and-nx.md §2.1) */
  packages?: Record<string, PackagesMeta>;
  /** per-repo projects pass: the tool (nx · workspaces · none), its projects and tags, the tag dimensions, project → project imports */
  projects?: Record<string, ProjectsMeta>;
  /** per-repo config files: every farsight.config.json the source holds, the fields each gave, conflicts and notes (§5.3) */
  config?: Record<string, ConfigMeta>;
  /** per-repo journey organisation: declared personas and groups in order, the config's placements, notes (journey-organisation-and-config-files.md §4.3) */
  journeys?: Record<string, JourneysMeta>;
}

/**
 * In-memory graph store with JSON snapshot persistence. Phase-1 only:
 * moves behind the same interface to a Rust engine + SQLite/fragment
 * storage in Phase 2 (see docs/ARCHITECTURE.md "Scale posture").
 */
export class GraphStore {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  /** repo name → absolute local checkout path; powers IDE deep links. Per-machine, not portable. */
  roots: Record<string, string> = {};
  meta: GraphMeta = {};
  private perRepoMeta = new Map<string, { files: number; hash: string; digest?: string }>();

  addFragment(fragment: GraphFragment): void {
    for (const n of fragment.nodes) this.nodes.set(n.id, n);
    for (const e of fragment.edges) {
      // re-key edges so fragments can't collide
      const key = `${e.kind}|${e.from}|${e.to}`;
      this.edges.set(key, { ...e, id: key });
    }
    if (fragment.meta?.tests) {
      this.meta.tests = { ...this.meta.tests, [fragment.repo]: fragment.meta.tests };
    }
    if (fragment.meta?.stories) {
      this.meta.stories = { ...this.meta.stories, [fragment.repo]: fragment.meta.stories };
    }
    if (fragment.meta?.stores) {
      this.meta.stores = { ...this.meta.stores, [fragment.repo]: fragment.meta.stores };
    }
    if (fragment.meta?.packages) {
      this.meta.packages = { ...this.meta.packages, [fragment.repo]: fragment.meta.packages };
    }
    if (fragment.meta?.projects) {
      this.meta.projects = { ...this.meta.projects, [fragment.repo]: fragment.meta.projects };
    }
    if (fragment.meta?.config) {
      this.meta.config = { ...this.meta.config, [fragment.repo]: fragment.meta.config };
    }
    if (fragment.meta?.journeys) {
      this.meta.journeys = { ...this.meta.journeys, [fragment.repo]: fragment.meta.journeys };
    }
    if (fragment.meta) {
      // a fragment with no content digest but the same sourceHash as the row already
      // recorded keeps that row's digest: the file set and its mtimes have not moved, so
      // the digest computed against them still holds (`farsight tests import` re-adds a
      // loaded graph as one meta-thin fragment and would otherwise drop it).
      const prior = this.repoMeta(fragment.repo);
      const digest = fragment.meta.sourceDigest
        ?? (prior?.sourceHash === fragment.meta.sourceHash ? prior?.sourceDigest : undefined);
      this.perRepoMeta.set(fragment.repo, {
        files: fragment.meta.files,
        hash: fragment.meta.sourceHash,
        ...(digest ? { digest } : {}),
      });
      const entries = [...this.perRepoMeta].sort((a, b) => a[0].localeCompare(b[0]));
      this.meta.files = entries.reduce((sum, [, m]) => sum + m.files, 0);
      this.meta.sourceHash = entries.length === 1
        ? entries[0]![1].hash
        : createHash('sha1').update(entries.map(([r, m]) => `${r}:${m.hash}`).join('\n')).digest('hex').slice(0, 12);
      // the same fold for the content digest; no repo carrying one means the graph has
      // none to state, and the key goes away rather than standing for a checkout nothing
      // was measured against
      const digests = entries.filter(([, m]) => m.digest);
      if (!digests.length) delete this.meta.sourceDigest;
      else if (entries.length === 1) this.meta.sourceDigest = digests[0]![1].digest;
      else this.meta.sourceDigest = createHash('sha1').update(digests.map(([r, m]) => `${r}:${m.digest}`).join('\n')).digest('hex').slice(0, 12);
      // merged, never replaced: a store that re-adds one repo keeps the other repos' rows
      this.meta.repos = { ...this.meta.repos, ...Object.fromEntries(entries.map(([r, m]) => [r, {
        files: m.files, sourceHash: m.hash, ...(m.digest ? { sourceDigest: m.digest } : {}),
      }])) };
    }
  }

  /**
   * Freshness for one repo — the numbers `sourceHash`/`sourceDigest` fold across all of
   * them. Undefined for a repo this store never ingested (a snapshot read keeps no
   * per-repo meta, so it answers undefined there too rather than guessing).
   */
  repoMeta(repo: string): { files: number; sourceHash: string; sourceDigest?: string } | undefined {
    const m = this.perRepoMeta.get(repo);
    if (m) return { files: m.files, sourceHash: m.hash, ...(m.digest ? { sourceDigest: m.digest } : {}) };
    return this.meta.repos?.[repo];
  }

  /** Live views for merge-time passes (core/stitch.ts). Mutations go through the methods below. */
  nodeById(id: string): GraphNode | undefined { return this.nodes.get(id); }
  allNodes(): GraphNode[] { return [...this.nodes.values()]; }
  allEdges(): GraphEdge[] { return [...this.edges.values()]; }
  removeNode(id: string): void { this.nodes.delete(id); }
  /** Replace an edge (keyed by kind|from|to) with a re-targeted one; the old key is dropped. */
  replaceEdge(oldKey: string, edge: GraphEdge): void {
    this.edges.delete(oldKey);
    const key = `${edge.kind}|${edge.from}|${edge.to}`;
    this.edges.set(key, { ...edge, id: key });
  }

  stats() {
    const byKind: Record<string, number> = {};
    for (const n of this.nodes.values()) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    return { nodes: this.nodes.size, edges: this.edges.size, byKind };
  }

  toJSON() {
    return { meta: this.meta, roots: this.roots, nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }

  save(path: string): void {
    this.meta.generatedAt = new Date().toISOString();
    this.meta.farsight = buildInfo();
    this.meta.graphPath = resolve(path);
    if (!this.meta.workspace) this.meta.workspace = basename(dirname(resolve(path)));
    writeFileSync(path, JSON.stringify(this.toJSON(), null, 1));
  }

  static load(path: string): GraphStore {
    const store = new GraphStore();
    const data = JSON.parse(readFileSync(path, 'utf8'));
    store.roots = data.roots ?? {};
    store.addFragment({ repo: '', nodes: data.nodes, edges: data.edges });
    store.meta = data.meta ?? {};
    // addFragment above had no per-repo meta (the saved graph is one flat node list),
    // so rehydrate it from what save() stamped — older graphs simply have none.
    for (const [repo, m] of Object.entries(store.meta.repos ?? {})) {
      store.perRepoMeta.set(repo, { files: m.files, hash: m.sourceHash, ...(m.sourceDigest ? { digest: m.sourceDigest } : {}) });
    }
    return store;
  }
}
