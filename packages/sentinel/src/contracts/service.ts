// Read-only service documents. Handles select sanitized immutable views, never store/launch authority.
import type { Count, Id, Ordinal, Timestamp, Digest, CatalogKey } from './common.js';
import type { ReportCount } from './report.js';
import type { PlanStage } from './plan.js';
import type { RunState, RunOutcome } from './run.js';
import type { WorkEnvelope } from './work.js';
import type { AttemptState, UsageCertainty } from './attempt.js';

/** @pattern ^h[0-9a-f]{32}$ */
export type ViewHandle = string;
export type InspectionCollection = 'works' | 'attempts' | 'inputs' | 'outputs';
export interface ServiceCapabilities {
  schema: 'sentinel-service-capabilities/draft-1';
  apiRevision: 1;
  storeId: Id;
  epoch: Id;
  /** @maxItems 16 */
  operations: string[];
  /** @maxItems 8 */
  schemas: string[];
  controlsSupported: false;
  /** @maxItems 64 */
  features: Array<{ id: string; library: 'available-draft' | 'unavailable'; readiness: 'not-checked'; reasonCode: CatalogKey }>;
  limits: { pageRows: Count; pageBytes: Count; viewUnits: Count; viewAttempts: Count; viewBytes: Count; viewTtlMs: Count; views: Count; viewCacheBytes: Count; inspectMs: Count; copyMs: Count; reportMs: Count; reportReads: Count; reportDecodedBytes: Count; reportEncodedBytes: Count; deliveryBytes: Count; deliveryCacheBytes: Count; deliveries: Count; deliveryTtlMs: Count; chunkDefault: Count; chunkMax: Count; cursors: Count };
  limitationKey: 'sentinel.service.readLimits';
}
export interface RunInspection {
  schema: 'sentinel-run-inspection/draft-1';
  viewId: Id;
  storeId: Id;
  epoch: Id;
  runKey: ViewHandle;
  planKey: ViewHandle;
  snapshotKey: ViewHandle | null;
  planRevision: Ordinal;
  sequence: Count;
  historical: boolean;
  status: RunState | 'awaiting-first-execution';
  outcome: RunOutcome | null;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  counts: { works: ReportCount; attempts: ReportCount; inputs: ReportCount; outputs: ReportCount };
}
export interface InspectionWork {
  kind: 'work';
  workKey: ViewHandle;
  stage: PlanStage;
  revision: Ordinal;
  /** @maxItems 1024 */
  prerequisites: Array<{ workKey: ViewHandle; revision: Ordinal; binding: 'in-view' | 'reference-only' }>;
  disposition: 'selected' | 'downstream' | 'held' | 'planned';
  recordedWork: { state: WorkEnvelope['state']; influenceKey: ViewHandle; activeAttemptKey: ViewHandle | null } | null;
  inputCount: Count;
  implementationKey: ViewHandle;
}
export interface InspectionAttempt {
  kind: 'attempt';
  workKey: ViewHandle;
  attemptKey: ViewHandle;
  ordinal: Ordinal;
  state: AttemptState;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  usageCertainty: UsageCertainty;
  invocationKey: ViewHandle | null;
  outputCount: Count | null;
  accepted: boolean;
  error?: { code: CatalogKey; retryable: boolean };
}
export interface InspectionInput { kind: 'input'; workKey: ViewHandle; sourceKey: ViewHandle; inputKey: ViewHandle; contentKey: ViewHandle }
export interface InspectionOutput {
  kind: 'output'; workKey: ViewHandle; attemptKey: ViewHandle; outputKey: ViewHandle; accepted: boolean;
  /** Fixed allowlisted schema or null, never arbitrary producer text. */
  mediaType: string | null;
  privacy: 'metadata' | 'source-derived' | 'source' | null;
  publicationKey: ViewHandle | null;
  sequence: Count | null;
  acceptedAt: Timestamp | null;
}
export type InspectionRow = InspectionWork | InspectionAttempt | InspectionInput | InspectionOutput;
export interface InspectionPage {
  schema: 'sentinel-inspection-page/draft-1';
  viewId: Id;
  sequence: Count;
  collection: InspectionCollection;
  /** @maxItems 128 */
  rows: InspectionRow[];
  nextCursor: Id | null;
}
export interface ReportDelivery {
  schema: 'sentinel-report-delivery/draft-1';
  deliveryId: Id;
  storeId: Id;
  epoch: Id;
  reportId: Id;
  current: { runId: Id; planRevision: Ordinal; snapshotId: Id; ledgerSequence: Count };
  baseline?: { runId: Id; planRevision: Ordinal; snapshotId: Id; ledgerSequence: Count };
  generationSequence: Count;
  evaluatedAt: Timestamp;
  disclosure: { profile: 'shareable'; profileDigest: Digest };
  catalogVersion: string;
  context: { binding: 'unavailable'; reasonCode: 'sentinel.place.noContext' };
  documentDigest: Digest;
  format: 'json' | 'md' | 'html' | 'sarif';
  formatDigest: Digest;
  formatBytes: Count;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}
export interface DeliveryChunk {
  schema: 'sentinel-delivery-chunk/draft-1';
  deliveryId: Id;
  offset: Count;
  /** Base64 of raw bytes; a chunk need not end at a UTF-8 character boundary. @maxLength 87384 */
  base64: string;
  nextOffset: Count | null;
  formatDigest: Digest;
  totalBytes: Count;
}
