import type { ArtifactId, CatalogKey, Id, Ordinal, ScopedReason, Timestamp, WorkRef } from './common.js';

/** Coverage is separate from findings: "complete" says the check ran over its scope, not that nothing was found. */
export type CoverageStatus = 'complete' | 'partial' | 'unsupported' | 'not-run' | 'error';

/** The finest scope an engine can establish. An aggregate scan cannot populate per-file/per-rule cells. */
export type CoverageGranularity = 'per-file-per-rule' | 'per-file' | 'aggregate';

/** @discriminator kind */
export type CoverageBasis =
  | { kind: 'executed'; attemptId: Id }
  // A publication is keyed by its work revision, never by a bare work ID or an attempt alone.
  | { kind: 'reused'; publication: WorkRef; derivationArtifact: ArtifactId }
  | { kind: 'imported'; provenanceArtifact: ArtifactId }
  | { kind: 'unavailable'; reasonCode: CatalogKey };

/** sentinel-coverage/draft-1 — what one check actually covered, with its scope and limitations. */
export interface CoverageEnvelope {
  schema: 'sentinel-coverage/draft-1';
  id: Id;
  runId: Id;
  checkId: Id;
  workId: Id;
  workRevision: Ordinal;
  status: CoverageStatus;
  granularity: CoverageGranularity;
  assessedScopeArtifact: ArtifactId;
  limitationsArtifact: ArtifactId;
  basis: CoverageBasis;
  /**
   * Scopes the producer reported skipping (a timeout, a size limit): these stay gaps even on exit zero.
   * @maxItems 10000
   */
  skipped: ScopedReason[];
  recordedAt: Timestamp;
}
