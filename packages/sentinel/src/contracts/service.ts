// Service read documents and separately negotiated control projections. Handles never grant store/launch authority.
import type { Count, Id, Ordinal, Timestamp, Digest, CatalogKey } from './common.js';
import type { ReportCount } from './report.js';
import type { PlanWork } from './plan.js';
import type { RunState, RunOutcome } from './run.js';
import type { ResourcePolicy, WorkEnvelope } from './work.js';
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
  /** Current recorded run state; historical describes the selected plan rows, not a historical status fold. */
  status: RunState | 'awaiting-first-execution';
  outcome: RunOutcome | null;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  counts: { works: ReportCount; attempts: ReportCount; inputs: ReportCount; outputs: ReportCount };
}
export interface InspectionWork {
  kind: 'work';
  workKey: ViewHandle;
  stage: PlanWork['stage'];
  revision: Ordinal;
  /** @maxItems 1024 */
  prerequisites: Array<{ workKey: ViewHandle; revision: Ordinal; binding: 'in-view' | 'reference-only' }>;
  disposition: 'selected' | 'downstream' | 'held' | 'planned';
  recordedWork: { state: WorkEnvelope['state']; influenceKey: ViewHandle; activeAttemptKey: ViewHandle | null } | null;
  inputCount: Count;
  implementationKey: ViewHandle;
  /** Actual recorded grant, absent before the work was created. Adapter enforcement may tighten it. */
  resources?: ResourcePolicy;
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

/** Additive control negotiation; the original read-only capabilities document remains unchanged. */
export interface ControlCapabilities {
  schema: 'sentinel-control-capabilities/draft-1';
  apiRevision: 1;
  storeId: Id;
  epoch: Id;
  operations: ['run.start', 'run.pause', 'run.cancel'];
  resultSchema: 'sentinel-control-outcome/draft-1';
  authorization: 'adopted-agent-grant-or-owner-cli-receipt';
  ownerConfirmation: 'owner-cli';
  limitationKey: 'sentinel.service.controlLimits';
}

/** The canonical command vocabulary; tests pin it to cli/outcome.ts without another verdict fold. */
export type ControlCommandOutcome =
  | 'satisfied' | 'finding-policy-failed' | 'required-coverage-incomplete' | 'configuration-failure' | 'awaiting-confirmation'
  | 'submitted' | 'requested' | 'unavailable' | 'prepared' | 'kept' | 'answered' | 'refused';
export interface ControlAdmissionVerdict { allowed: boolean; asked: boolean; reasonCode: CatalogKey }
/** Sanitized projection of the existing CommandResult; no producer facts or authority tokens. */
export interface ControlOutcome {
  schema: 'sentinel-control-outcome/draft-1';
  outcome: ControlCommandOutcome;
  /** @asType integer @minimum 0 @maximum 4 */
  exitCode: number;
  verdicts: { policy: ControlAdmissionVerdict; capability: ControlAdmissionVerdict; credential: ControlAdmissionVerdict };
  reasonCode?: CatalogKey;
  state: RunState | 'interrupted' | 'awaiting-first-execution' | null;
  joined?: boolean;
}
