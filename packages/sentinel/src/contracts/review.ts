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
  ShortText,
  SourceEvidence,
  Timestamp,
} from './common.js';
import type { ReviewInstructionsEnvelope, ReviewInstructionBinding, ReviewRequestEnvelope } from './instructions.js';
import type { CweId, ModelIdentity } from './observation.js';
import type { AgentMode, AgentRunnerId, PackRef, StageCost, StageId } from './pipeline.js';
import type { ModelName } from './policy.js';

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
    /**
     * What the provider calls cost, as a stage's provenance states it: the rates price of the confirmed usage, or
     * unobserved with its reason (a subscription CLI, an unsettled call, a provider with no rates); never a zero amount.
     * Absent for a mock caller and on records written before it was recorded.
     */
    cost?: StageCost;
  };
  refusals: Count;
  rejectedReplies: Count;
  /** @maxItems 16 */
  observations: Id[];
  establishes: 'model-review-inspection';
  deterministicCoverage: false;
  digest: Digest;
}

// ---- a refused agent attempt's private record ----

/**
 * sentinel-attempt-retained/draft-1 — what an agent attempt keeps when it is refused and publishes nothing: a native
 * run its monitor stopped, one over its budget, one another model answered, or one whose answer fails its schema. The
 * record is the owner's alone, `privacy: 'source'` here and on every artifact it links, and the accepted-secret
 * withholding fold runs over it and its links before any read. Its bytes (the CLI's stream, its session export, the
 * instructions as delivered) are linked by handle, never by path; the store keeps them with the attempt's end.
 */
export interface AttemptRetainedEnvelope {
  schema: 'sentinel-attempt-retained/draft-1';
  privacy: 'source';
  disclosure: 'private-only';
  withholding: 'accepted-secret-fold-before-read';
  stage: StageId;
  /** The refusal's catalog key: the code the attempt ended with. */
  failure: CatalogKey;
  /** Whether the run completed and settled (confirmed usage) before it was refused, or stopped before that. */
  completed: boolean;
  /**
   * The CLI's final answer as it printed it; null when it gave none.
   * @maxLength 262144
   */
  finalAnswer: string | null;
  /**
   * Scratch-relative paths the read tools opened, in first-read order.
   * @maxItems 1024
   */
  filesRead: RelativePath[];
  /**
   * Every tool call the monitor saw, in order.
   * @maxItems 4096
   */
  tools: RetainedToolCall[];
  /**
   * The task piped to the CLI.
   * @maxLength 524288
   */
  task: string;
  /** A text or list above was cut to these bounds; the linked transcript holds the whole stream. */
  truncated: boolean;
  provenance: RetainedAgentProvenance;
  instructionRecord: RetainedInstructionRecord;
  /**
   * The transcript and the instructions always, the session export when the CLI wrote one; each role once.
   * @minItems 2
   * @maxItems 3
   */
  links: RetainedLink[];
}

/** One tool call: the tool and the path it named, if any. */
export interface RetainedToolCall {
  tool: ShortText;
  /** @maxLength 4096 */
  path: string | null;
}

/** A retained artifact by its handle (the content digest the store accepts), never by a path. */
export interface RetainedLink {
  /** `transcript`: the CLI's event stream as the monitor captured it; `share`: its own session export. */
  role: 'transcript' | 'share' | 'instructions';
  handle: ArtifactId;
  /** What the bytes are, as the store records it (`application/x-ndjson`, `text/markdown`). */
  schema: ShortText;
  bytes: Count;
  privacy: 'source';
}

/**
 * The runner's provenance of the refused run, as the owner's record keeps it: the installation's exact executable
 * path included. Anything that leaves the record redacts that path (`publicProvenance`).
 */
export interface RetainedAgentProvenance {
  mode: AgentMode;
  runner: AgentRunnerId;
  runnerVersion: ShortText | null;
  profileId: Id;
  executableDigest: Digest | null;
  /** The installation that ran: its category and its exact resolved executable path. */
  installation: RetainedInstallation | null;
  model: { requested: ModelName; reported: ModelName | null; identitySource: 'host-reported' };
  promptDigest: Digest | null;
  /** @maxItems 16 */
  skillDigests: Digest[];
  turns: Count;
  tokens: { input: Count | null; output: Count | null; certainty: 'confirmed' | 'uncertain' };
  cost: StageCost;
  deadline: { grantedMs: Count; usedMs: Count | null };
  where: 'sandboxed-cli';
}

/** Where the refused run's CLI came from: its installation category and its exact resolved executable path. */
export interface RetainedInstallation {
  source: ShortText;
  /** @maxLength 4096 */
  executablePath: string;
}

/**
 * The instructions the run was sent, as sealed before its broker call, by digest: the instructions file (whose bytes
 * are the `instructions` link), each input as first received, the task, every promoted skill file and the packs.
 */
export interface RetainedInstructionRecord {
  stage: StageId;
  instructions: { ref: PackRef | null; digest: Digest };
  /** @maxItems 1024 */
  inputs: { relativePath: RelativePath; digest: Digest }[];
  task: { digest: Digest };
  /** @maxItems 16 */
  skills: {
    ref: PackRef;
    digest: Digest;
    /** @maxItems 256 */
    files: { path: RelativePath; digest: Digest }[];
  }[];
  /** @maxItems 64 */
  packs: { ref: PackRef; digest: Digest }[];
}
