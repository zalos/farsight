import type {
  ArtifactId, BoundedText, CatalogKey, Count, Digest, Id, NodeId, Ordinal, RegisterText, SharedCatalogKey, ShortText,
  Timestamp,
} from './common.js';
import type { CoverageStatus } from './coverage.js';

/** One part of a count's partition: core's `CountPart`. Parts sum to the count they explain. */
export interface ReportCountPart {
  /** A catalog key printed with `{n}`. */
  key: SharedCatalogKey;
  n: Count;
  /** A name out of the pinned context, when the part is one thing rather than a kind. */
  label?: BoundedText;
}

/**
 * A scoped number with exactly core's `Counted` shape: what it counts (`unit`, and `bizUnit` when the business
 * register prints it), over which scope, from which fold, its partition and the command that re-checks it.
 * Unit, scope and part keys are shared-catalog keys; the tests run core's own `countedProblems` over them.
 */
export interface ReportCount {
  n: Count;
  of?: Count;
  unit: SharedCatalogKey;
  bizUnit?: SharedCatalogKey;
  scope: SharedCatalogKey;
  /**
   * @minLength 1
   * @maxLength 256
   */
  source: string;
  /** @maxItems 64 */
  breakdown?: ReportCountPart[];
  recheck?: {
    /** @maxLength 1024 */
    cli: string;
    /** @maxLength 1024 */
    mcp?: string;
  };
}

/** A readable label captured from pinned context, so a recipient never looks one up in today's graph. */
export interface PlaceLabel extends RegisterText {}

/** @maxItems 512 */
export type ScreenIds = NodeId[];

/** Report-side application placement. Reachability is navigation evidence, never proof of exploitation. */
export interface FindingPlace {
  binding: 'matched' | 'mismatched' | 'unavailable';
  context?: { artifact: ArtifactId; sourceBindingReceipt: ArtifactId; projectionVersion: ShortText };
  /**
   * Canonical graph node IDs, the same identities `SourceEvidence.nodeId` carries.
   * @maxItems 256
   */
  nodeIds: NodeId[];
  /** @maxItems 512 */
  screens: Array<{ id: NodeId; label: PlaceLabel; via: 'direct-use' | 'potential-impact'; evidenceArtifact: ArtifactId }>;
  /** @maxItems 512 */
  journeys: Array<{ id: NodeId; label: PlaceLabel; screenIds: ScreenIds }>;
  /** @maxItems 64 */
  personas: Array<{ id: NodeId; label: PlaceLabel; screenIds: ScreenIds; declared: boolean; evidenceArtifact: ArtifactId }>;
  counts: { screens: ReportCount; journeys: ReportCount; personas: ReportCount };
  /** @maxItems 32 */
  limitationKeys: CatalogKey[];
}

/** Why a finding pairs or does not pair with the baseline. Absence alone never resolves an issue. */
export type ComparisonLabel =
  | 'new'
  | 'persistent'
  | 'changed-evidence'
  | 'changed-detection'
  | 'reopened'
  | 'reopened-disposition-expired'
  | 'resolved-by-comparable-check'
  | 'removed-surface'
  | 'unassessed-in-current-scope'
  | 'incomparable-conditions';

export interface ReportFinding {
  id: Id;
  /**
   * @minItems 1
   * @maxItems 256
   */
  observationIds: Id[];
  /** @maxLength 128 */
  ruleFamilyId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: RegisterText;
  explanation: RegisterText;
  place: FindingPlace;
  comparison?: ComparisonLabel;
  /** @maxItems 64 */
  evidence: ReportEvidence[];
}

/**
 * Permitted evidence is embedded; omitted evidence keeps its identity and the reason it was withheld.
 * @discriminator state
 */
export type ReportEvidence =
  | { id: Id; state: 'embedded'; excerpt: BoundedText; content: ArtifactId }
  | { id: Id; state: 'withheld'; reasonCode: CatalogKey; content: ArtifactId };

export interface ReportGap {
  checkId: Id;
  status: Exclude<CoverageStatus, 'complete'>;
  reasonCode: CatalogKey;
  explanation: RegisterText;
  place: FindingPlace;
}

export interface ReportDecision {
  dispositionId: Id;
  findingId: Id;
  /** Validity as of the report's evaluation time; opening an old report never recalculates it. */
  validity: 'valid' | 'expired' | 'invalidated';
  expiresAt: Timestamp | null;
}

/** sentinel-report/draft-1 — one deterministic projection at a pinned ledger sequence and evaluation time. */
export interface ReportEnvelope {
  schema: 'sentinel-report/draft-1';
  id: Id;
  run: { id: Id; snapshotId: Id; planRevision: Ordinal };
  ledgerSequence: Count;
  evaluatedAt: Timestamp;
  /** @maxLength 64 */
  catalogVersion: string;
  disclosure: { profile: 'private' | 'shareable'; profileDigest: Digest };
  completeness: 'complete' | 'partial';
  baseline: { reportId: Id } | null;
  counts: {
    findings: ReportCount;
    observations: ReportCount;
    coverageGaps: ReportCount;
    plannedChecks: ReportCount;
    /**
     * The exact number of included inventory entries no completed stage covered. Always printed, including zero.
     */
    seenByNoStage: ReportCount;
    /**
     * Inventory boundaries whose descendants were never enumerated: unknown scope, counted apart, never folded
     * into the exact number above and never read as zero files.
     */
    unknownScopeBoundaries: ReportCount;
  };
  /** @maxItems 25000 */
  findings: ReportFinding[];
  /** @maxItems 25000 */
  gaps: ReportGap[];
  /** @maxItems 25000 */
  decisions: ReportDecision[];
  /** @maxItems 4096 */
  artifactClosure: ArtifactId[];
}
