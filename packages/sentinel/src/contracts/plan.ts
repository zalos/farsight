// Plan revisions (PR 06). A plan revision is what the deterministic planner decided for one run at one revision:
// the exact inputs it pinned, every check the policy's locked rules imply with its state and reason, and the
// physical work units that cover exactly the planned checks. A revision is immutable and carries a digest of its
// content; a change is a new revision, never an edit. A check that is not planned is kept with its reason and is
// never covered by any work unit.
import type { ArtifactId, CatalogKey, Count, Digest, Id, Ordinal, RelativePath, ScopeId, WorkRef } from './common.js';
import type { RuleFamilyId, RuleScopeKind } from './rules.js';

/** A check's planning state. Only `planned` is assigned to work; every other state carries its reason. */
export type PlanCheckState = 'planned' | 'unsupported' | 'applicability-unknown' | 'scope-unavailable' | 'scope-unknown';

/** What a work unit does: the bootstrap stages, or running checks. */
export type PlanStage = 'capture' | 'parse' | 'inventory' | 'check';

/** One check: (scope, rule revision, environment, mode). Its id is a digest of exactly those. */
export interface PlanCheck {
  id: Id;
  familyId: RuleFamilyId;
  ruleRevision: Ordinal;
  scopeKind: RuleScopeKind;
  scopeId: ScopeId;
  sourceId: Id;
  environment: Digest;
  mode: 'deterministic';
  /** Counts against required coverage: a mandatory rule, complete-coverage policy or a required capability. */
  required: boolean;
  state: PlanCheckState;
  /** Required for every state but `planned`. */
  reasonCode?: CatalogKey;
  /** Only for `planned`: the work unit that covers it. */
  unit?: WorkRef;
}

/** A captured file a work unit reads, by the exact content artifact the plan pinned. */
export interface PlanInput {
  sourceId: Id;
  relativePath: RelativePath;
  content: ArtifactId;
}

/** One physical work unit. It covers exactly `checks`, however many rules or scopes it batches. */
export interface PlanWork {
  id: Id;
  revision: Ordinal;
  stage: PlanStage;
  /** @maxLength 128 */
  contract: string;
  implementationDigest: Digest;
  sourceId: Id | null;
  adapterId: Id | null;
  /** @maxItems 1024 */
  dependencies: WorkRef[];
  /** Digest of every input that determines its output (inventory, analysis, rule pins, tool, scopes). */
  inputFingerprint: Digest;
  /** @maxItems 2048 */
  checks: Id[];
  /** @maxItems 256 */
  scopes: ScopeId[];
  /** @maxItems 20000 */
  inputs: PlanInput[];
  /** Digest of exactly `inputs`: the captured bytes this unit may read, bound apart from its wider fingerprint. */
  inputSetDigest: Digest;
}

export interface PlanPinnedRule {
  familyId: RuleFamilyId;
  revision: Ordinal;
  definitionDigest: Digest;
  packDigest: Digest;
  /** The registered adapter the rule's definition names: the only adapter its checks may run under. */
  adapterId: Id;
}

export interface PlanPins {
  /** Optional canonical structural-path request; source-derived data, never authority. Absent on old and bootstrap plans. */
  pathRequest?: ArtifactId;
  /** Null on a bootstrap revision: there is no snapshot yet. */
  snapshotId: Id | null;
  inventoryDigest: Digest | null;
  environment: Digest | null;
  ruleLockDigest: Digest | null;
  policyDigest: Digest | null;
  profileId: Id;
  /** @maxItems 2048 */
  rules: PlanPinnedRule[];
  /** @maxItems 256 */
  tools: { adapterId: Id; artifactDigest: Digest }[];
  /** @maxItems 256 */
  databases: { databaseId: Id; snapshotDigest: Digest }[];
  /** @maxItems 64 */
  analyses: {
    sourceId: Id;
    /**
     * The public parser's analysis fingerprint.
     * @maxLength 128
     */
    analysisFingerprint: string;
  }[];
  /** The registered adapters bound to the bootstrap stages; null when none is bound yet (the work is blocked). */
  operations: { capture: PlanAdapterPin | null; parse: PlanAdapterPin | null; inventory: PlanAdapterPin | null };
  /**
   * Every registered adapter this revision's units run, by its registry digest.
   * @maxItems 256
   */
  adapters: PlanAdapterPin[];
  /**
   * The capability facts this revision relied on: which registered adapter establishes which capability.
   * @maxItems 256
   */
  capabilities: { capability: string; adapterId: Id; adapterDigest: Digest }[];
}

export interface PlanAdapterPin {
  adapterId: Id;
  digest: Digest;
}

/** A rule the policy selects that could not be scheduled at all. */
export interface PlanRuleGap {
  familyId: RuleFamilyId;
  required: boolean;
  reasonCode: CatalogKey;
}

export interface PlanTallies {
  checks: {
    'planned': Count;
    'unsupported': Count;
    'applicability-unknown': Count;
    'scope-unavailable': Count;
    'scope-unknown': Count;
  };
  required: Count;
  /** Required checks in any state but `planned`, plus required rule gaps. */
  requiredNotPlanned: Count;
  units: Count;
}

/**
 * sentinel-plan/draft-1 — one immutable plan revision.
 */
export interface PlanEnvelope {
  schema: 'sentinel-plan/draft-1';
  runId: Id;
  revision: Ordinal;
  kind: 'bootstrap' | 'analysis';
  /** The digest of the revision this one follows in the same run; null exactly for a run's first revision. */
  previous: Digest | null;
  pins: PlanPins;
  /**
   * Work published by an earlier plan (this run or a parent run) that this revision depends on without redoing.
   * @maxItems 1024
   */
  reused: WorkRef[];
  /** @maxItems 10000 */
  units: PlanWork[];
  /** @maxItems 200000 */
  checks: PlanCheck[];
  /** @maxItems 2048 */
  ruleGaps: PlanRuleGap[];
  tallies: PlanTallies;
  /** True only when every required check is planned. */
  requiredCoverageAchievable: boolean;
  /** The canonical digest of every other field. */
  digest: Digest;
}
