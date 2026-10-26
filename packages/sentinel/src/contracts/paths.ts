// Bounded static call paths (PR 18). A path says one graph node can reach another through the public parser's call
// edges within stated bounds; it never says data flows along it. Sentinel has no qualified data-flow engine (E3), so
// these are structural candidates only, each tied to the exact parser analysis and bounds that produced it.
import type {
  ArtifactId,
  ByteSpan,
  CatalogKey,
  Count,
  Digest,
  Id,
  NodeId,
  RelativePath,
  ScopedReason,
  ShortText,
} from './common.js';

/** The edge kinds a path may follow. Guard, validation and test edges are never traversed: they are not calls. */
export type PathEdgeKind = 'calls' | 'http' | 'renders';

export interface PathBounds {
  /** @maxItems 3 */
  edgeKinds: PathEdgeKind[];
  /** Edges in the longest path explored. */
  maxDepth: PathDepth;
  /** Outgoing edges followed per node; beyond it the node is a frontier. */
  maxFanout: PathFanout;
  /** Nodes visited per query. */
  maxVisited: PathVisits;
}

/**
 * @asType integer
 * @minimum 1
 * @maximum 64
 */
export type PathDepth = number;
/**
 * @asType integer
 * @minimum 1
 * @maximum 4096
 */
export type PathFanout = number;
/**
 * @asType integer
 * @minimum 1
 * @maximum 1000000
 */
export type PathVisits = number;

/** A call-site citation in captured bytes, from the parser's occurrence index. */
export interface PathSite {
  relativePath: RelativePath;
  content: ArtifactId;
  span: ByteSpan;
  /** @maxLength 256 */
  occurrenceId: string;
}

export interface PathStep {
  /** @maxLength 1024 */
  edgeId: string;
  from: NodeId;
  to: NodeId;
  kind: PathEdgeKind;
  /** The parser's own resolution of this edge; unresolved edges end a search and are never steps. */
  resolution: 'resolved' | 'heuristic';
  /** The edge was made in a callback stored for later: the call may not happen on this path's request. */
  deferred: boolean;
  /**
   * Captured call sites for this edge; empty when the parser gave none with an exact span.
   * @maxItems 16
   */
  sites: PathSite[];
}

export interface CallPath {
  /** Digest of the node and edge sequence. */
  id: Digest;
  /**
   * @minItems 1
   * @maxItems 64
   */
  steps: PathStep[];
  /**
   * Nodes on the path that belong to a call cycle (a strongly connected component of more than one node, or a
   * self call).
   * @maxItems 65
   */
  cyclic: NodeId[];
}

/**
 * `reached`: a path exists within the bounds. `not-reached-complete`: the search ended with nothing left
 * unexplored and no unresolved or truncated edge on the way, which is still only a statement about the parser's
 * graph. `not-reached-bounded`: the search met a frontier, so absence is not established.
 */
export type PathOutcome = 'reached' | 'not-reached-complete' | 'not-reached-bounded';

export interface PathQueryResult {
  from: NodeId;
  to: NodeId;
  outcome: PathOutcome;
  /**
   * The shortest path found, for `reached`.
   * @maxItems 1
   */
  paths: CallPath[];
  /**
   * Why a search was bounded: the frontier kinds it met, each once.
   * @maxItems 16
   */
  frontierReasons: CatalogKey[];
  /** Nodes visited. */
  visited: Count;
}

export interface CallCycle {
  /**
   * @minItems 1
   * @maxItems 1000
   */
  members: NodeId[];
}

/**
 * sentinel-paths/draft-1 — bounded static call paths over one source's parser analysis, keyed by the analysis
 * fingerprint, a digest of the graph read and the bounds. `establishes` is fixed: a path is call reachability, never
 * data flow, taint or protection.
 */
export interface PathEvidenceEnvelope {
  schema: 'sentinel-paths/draft-1';
  snapshotId: Id;
  sourceId: Id;
  /** @maxLength 256 */
  analysisFingerprint: string;
  /** Digest of the canonical node and edge set the search read. */
  graphDigest: Digest;
  bounds: PathBounds;
  boundsDigest: Digest;
  establishes: 'call-reachability';
  /** @maxItems 10000 */
  results: PathQueryResult[];
  /**
   * Call cycles met, each as its member nodes (bounded).
   * @maxItems 1000
   */
  cycles: CallCycle[];
  /** @maxItems 64 */
  limitationKeys: CatalogKey[];
  /** @maxItems 10000 */
  frontiers: ScopedReason[];
  producer: { implementation: ShortText; digest: Digest };
}
