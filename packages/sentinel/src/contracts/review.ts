// Model review contracts (PR 22, ADR 39): the general review's partition plan, a session's checkpoint and its record.
// A review record is model-review inspection, never coverage of a formal check; its claims are observations.
import type {
  ArtifactId,
  CatalogKey,
  Count,
  Digest,
  Id,
  RelativePath,
  ScopedReason,
  SourceEvidence,
  Timestamp,
} from './common.js';
import type { ReviewInstructionsEnvelope, ReviewInstructionBinding, ReviewRequestEnvelope } from './instructions.js';
import type { CweId, ModelIdentity } from './observation.js';
import type { StageCost } from './pipeline.js';

/**
 * @asType integer
 * @minimum 1
 * @maximum 1000
 */
export type PartitionFiles = number;

/**
 * @asType integer
 * @minimum 1
 * @maximum 16777216
 */
export type PartitionBytes = number;

/**
 * A 1-based source line.
 * @asType integer
 * @minimum 1
 * @maximum 100000000
 */
export type LineNumber = number;

/**
 * A served evidence id: what a reply cites.
 * @pattern ^ev-[0-9a-f]{16}$
 */
export type EvidenceId = string;

/**
 * A review session id.
 * @pattern ^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$
 */
export type ReviewSessionId = string;

export interface ReviewPartitionMember {
  relativePath: RelativePath;
  content: ArtifactId;
  bytes: Count;
}

export interface ReviewPartition {
  /** `part-` and 24 hex characters of the digest of the source and its members' paths and contents. */
  id: Id;
  /**
   * @minItems 1
   * @maxItems 1000
   */
  members: ReviewPartitionMember[];
  bytes: Count;
}

/**
 * sentinel-review-partitions/draft-1 — the general review's scope over one source, decided from the captured inventory
 * and the bounds alone, never from findings. Entries no partition covers are gaps with their reasons.
 */
export interface ReviewPartitionsEnvelope {
  schema: 'sentinel-review-partitions/draft-1';
  snapshotId: Id;
  sourceId: Id;
  bounds: { maxFiles: PartitionFiles; maxBytes: PartitionBytes };
  /** @maxItems 20000 */
  partitions: ReviewPartition[];
  /** @maxItems 20000 */
  gaps: ScopedReason[];
  /** Canonical digest of every other field. */
  digest: Digest;
}

export type ReviewVerdict = 'finding' | 'no-finding' | 'inconclusive';

export interface ReviewClaim {
  /**
   * @minLength 1
   * @maxLength 2000
   */
  statement: string;
  /**
   * @minItems 1
   * @maxItems 16
   */
  citations: EvidenceId[];
  cwe?: CweId;
}

export interface ReviewAssessment {
  verdict: ReviewVerdict;
  /** @maxItems 16 */
  claims: ReviewClaim[];
  /** @maxItems 1000 */
  inspected: RelativePath[];
}

export interface ReviewMessage {
  role: 'system' | 'user' | 'assistant';
  /** @maxLength 4194304 */
  content: string;
}

/** A slice served to the model, without its text: a resumed session re-reads and re-verifies the bytes. */
export interface ServedCitation {
  id: EvidenceId;
  startLine: LineNumber;
  endLine: LineNumber;
  citation: SourceEvidence;
}

export interface ReviewOperation {
  /** Exact retained request for instruction-bound sessions only. */
  request?: ArtifactId;
  /** Reported identity of this reply, never inferred from instruction text. */
  identity?: ModelIdentity;
  operationId: Id;
  /** `settled`: the call answered and was recorded; `unsettled`: it failed and may have been charged. */
  state: 'settled' | 'unsettled';
  inputBytes: Count;
  usage?: { inputTokens: Count; outputTokens: Count };
  /** What the reply was taken as: a tool request, a final assessment, a rejection code, or a failed call. */
  outcome: 'tool' | 'final' | 'failed' | CatalogKey;
}

/** sentinel-review-checkpoint/draft-1 — what a session needs to resume after its last settled operation. */
export interface ReviewCheckpointEnvelope {
  schema: 'sentinel-review-checkpoint/draft-1';
  sessionId: ReviewSessionId;
  /** The digest of the session's scope, prompt, limits, budget and tools; another spec cannot resume it. */
  specDigest: Digest;
  instructions?: ReviewInstructionsEnvelope;
  /**
   * Includes at most one prepared request whose caller outcome remains unknown.
   * @maxItems 256
   */
  requests?: ReviewRequestEnvelope[];
  startedAt: Timestamp;
  /**
   * @minItems 2
   * @maxItems 1024
   */
  messages: ReviewMessage[];
  /** @maxItems 1000 */
  served: ServedCitation[];
  toolCalls: Count;
  invalid: Count;
  inputBytes: Count;
  /** @maxItems 256 */
  operations: ReviewOperation[];
  identity: ModelIdentity | null;
  final: ReviewAssessment | null;
  stopped: CatalogKey | null;
}

export interface ReviewInspection {
  relativePath: RelativePath;
  content: ArtifactId;
  /**
   * Served line ranges, sorted.
   * @minItems 1
   * @maxItems 1000
   */
  ranges: [LineNumber, LineNumber][];
}

/**
 * sentinel-review-record/draft-1 — what one review session inspected and concluded. The inspection ledger is what was
 * served, never what the model said; `deterministicCoverage` is always false.
 */
export interface ReviewRecordEnvelope {
  schema: 'sentinel-review-record/draft-1';
  sessionId: ReviewSessionId;
  kind: 'guided' | 'general';
  runId: Id;
  attemptId: Id;
  snapshotId: Id;
  sourceId: Id;
  specDigest: Digest;
  promptDigest: Digest;
  instructions?: ReviewInstructionBinding;
  model: ModelIdentity | null;
  /** `mock` replies can never qualify anything. */
  callerKind: 'mock' | 'provider';
  outcome: 'completed' | 'unfinished';
  verdict: ReviewVerdict | null;
  /** @maxItems 1000 */
  inspected: ReviewInspection[];
  /** @maxItems 1000 */
  notInspected: RelativePath[];
  /** @maxItems 2100 */
  frontiers: ScopedReason[];
  /** @maxItems 256 */
  operations: ReviewOperation[];
  totals: {
    steps: Count;
    toolCalls: Count;
    inputBytes: Count;
    inputTokens: Count;
    outputTokens: Count;
    usage: 'confirmed' | 'unknown';
  };
  /** The cost basis of a brokered CLI review. Subscription usage never implies a zero price. */
  cost?: StageCost;
  refusals: Count;
  rejectedReplies: Count;
  /** @maxItems 16 */
  observations: Id[];
  establishes: 'model-review-inspection';
  deterministicCoverage: false;
  digest: Digest;
}
