// An owner-requested structural path query over one retained source (ADR 45). This is source-derived task data,
// never a grant, a receipt, an analyzer result or proof of data flow. Its canonical artifact is pinned by the plan.
import type { Digest, Id, NodeId, Ordinal } from './common.js';
import type { PathBounds } from './paths.js';

export const MAX_PATH_REQUEST_BYTES = 1024 * 1024;
export const MAX_PATH_REQUEST_QUERIES = 10_000;

export interface PathRequestPair {
  from: NodeId;
  to: NodeId;
}

export interface PathRequestEnvelope {
  schema: 'sentinel-path-request/draft-1';
  /** The recorded ancestor revision, never the latest merely admitted revision. */
  ancestor: { runId: Id; revision: Ordinal; planDigest: Digest };
  snapshotId: Id;
  sourceId: Id;
  /**
   * Sorted by exact from/to tuple, without duplicates or same-node queries.
   * @minItems 1
   * @maxItems 10000
   */
  queries: PathRequestPair[];
  /** Explicit, library-bounded; edge kinds are sorted without duplicates. */
  bounds: PathBounds;
}
