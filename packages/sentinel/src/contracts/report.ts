import type { PathEvidenceEnvelope } from './paths.js';
import type {
  ArtifactId, BoundedText, CatalogKey, Count, Digest, Id, NodeId, Ordinal, RegisterText, RelativePath, SharedCatalogKey, ShortText,
  Timestamp, WorkRef,
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

/** A genuine accepted bounded structural query result. The pinned worker reports these outcomes; readback
 * authenticates their producer/closure and graph identities, never independently proves absence or security. */
export interface ReportStructuralPaths {
  artifact: ArtifactId;
  attemptId: Id;
  request: ArtifactId;
  job: ArtifactId;
  sourceId: Id;
  work: WorkRef;
  ancestor: { runId: Id; revision: Ordinal; planDigest: Digest };
  evidence: PathEvidenceEnvelope;
  limitationKey: 'sentinel.paths.notDataFlow';
  statementKey: 'sentinel.paths.report.pinnedQuery';
  /** A coarse secret match removes sites/spans and replaces all source-controlled identifiers. */
  detailLoss?: 'sentinel.report.withheld.secretRun';
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

/** How a finding paired with the baseline. Probable and ambiguous pairings never resolve or silently continue an issue. */
export interface FindingMatch {
  kind: 'exact' | 'probable' | 'ambiguous';
  /**
   * @minItems 1
   * @maxItems 64
   */
  baselineFindingIds: Id[];
}

/** Sentinel's versioned issue fingerprint: exact (rule family and anchor set) and probable (rule family and symbols). */
export interface FindingFingerprint {
  version: ShortText;
  exact: Digest;
  probable: Digest;
}

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
  /** Why the comparison label was given. */
  comparisonReason?: CatalogKey;
  match?: FindingMatch;
  fingerprint?: FindingFingerprint;
  /** @maxItems 64 */
  evidence: ReportEvidence[];
}

/**
 * A baseline finding the current findings do not continue, with why: resolved by a comparable check, a removed
 * surface, unassessed in the current scope, changed detection, incomparable conditions, or an ambiguous pairing that
 * stays open. It is never dropped, and only `resolved-by-comparable-check` says the issue is gone.
 */
export interface ReportHistoricalFinding {
  baselineFindingId: Id;
  /** @maxLength 128 */
  ruleFamilyId: string;
  severity: ReportFinding['severity'];
  title: RegisterText;
  label: 'resolved-by-comparable-check' | 'removed-surface' | 'unassessed-in-current-scope' | 'changed-detection' | 'incomparable-conditions' | 'changed-evidence';
  reasonCode: CatalogKey;
  match?: FindingMatch;
  place: FindingPlace;
}

/** Where evidence sits in the captured source. Absent for evidence whose location is itself withheld (secrets). */
export interface EvidenceLocation {
  relativePath: RelativePath;
  startByte: Count;
  endByte: Count;
  startLine: Ordinal;
  endLine: Ordinal;
}

/** A word the report uses, with its definition, so a recipient never needs the catalog or the product. */
export interface ReportDefinition {
  /** @maxLength 128 */
  key: string;
  text: RegisterText;
  define: BoundedText;
}

/**
 * Permitted evidence is embedded; omitted evidence keeps its identity and the reason it was withheld.
 * @discriminator state
 */
export type ReportEvidence =
  | { id: Id; state: 'embedded'; excerpt: BoundedText; content: ArtifactId; location?: EvidenceLocation }
  | { id: Id; state: 'withheld'; reasonCode: CatalogKey; content: ArtifactId; location?: EvidenceLocation };

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

/** Accepted framework inspection answers. Applying or not applying a control is never an issue or an assessment. */
export interface ReportControlInspection {
  sourceId: Id;
  artifact: ArtifactId;
  attemptId: Id;
  work: WorkRef;
  analysis: { result: ArtifactId; index: ArtifactId; artifact: ArtifactId; manifest: ArtifactId };
  assessment: 'none';
  recognised: boolean;
  extent: Count;
  /** @maxItems 4 */
  libraries: Array<{
    framework: 'next' | 'express' | 'nest' | 'spring';
    packDigest: Digest | null;
    ran: boolean;
    reasonCode?: CatalogKey;
    /** @maxItems 10000 */
    versions: Array<ShortText | null>;
    envelopes: Count;
    supportedScope: { versions: { [key: string]: ShortText }; /** @maxItems 7 */
      properties: ShortText[] };
  }>;
  /** @maxItems 300000 */
  rows: Array<{
    surfaceId: NodeId;
    property: 'authentication' | 'authorization' | 'input-validation';
    state: 'established' | 'partial' | 'not-run';
    verdict: 'applies' | 'does-not-apply' | null;
    reasonCode: CatalogKey | null;
    /** @maxItems 10000 */
    claims: Array<{ framework: 'next' | 'express' | 'nest' | 'spring'; verdict: 'applies' | 'does-not-apply' | 'unknown'; factId: Id }>;
  }>;
  /** @maxItems 3 */
  checks: Array<{ checkId: Id; familyId: ShortText; state: 'complete' | 'partial' | 'not-run'; /** @maxItems 10000 */
    reasons: CatalogKey[] }>;
  /** @maxItems 40000 */
  frontiers: Array<{ scopeId: NodeId; reasonCode: CatalogKey }>;
  limitationKey: 'sentinel.controls.limitation.inspectionOnly';
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
    /** Baseline findings the current findings do not continue, by comparison label. */
    historical?: ReportCount;
    /** Surface/property answers established, partial or not run; never added to findings. */
    controlAnswers?: ReportCount;
    /** Structural query outcomes, counted separately from findings and security coverage. */
    pathQueries?: ReportCount;
  };
  /** @maxItems 25000 */
  findings: ReportFinding[];
  /** @maxItems 10000 */
  inspections?: ReportControlInspection[];
  /** @maxItems 10000 */
  structuralPaths?: ReportStructuralPaths[];
  /** @maxItems 25000 */
  gaps: ReportGap[];
  /** @maxItems 25000 */
  decisions: ReportDecision[];
  /** @maxItems 25000 */
  historical?: ReportHistoricalFinding[];
  /** @maxItems 2048 */
  definitions?: ReportDefinition[];
  /** @maxItems 4096 */
  artifactClosure: ArtifactId[];
}
