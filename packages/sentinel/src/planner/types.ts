// Deterministic planning (PR 06): what the planner reads and the plan revisions it writes.
//
// The inputs are planner-owned structural types. They name exactly the fields planning uses from the rule lock
// (PR 06 rules), the effective policy (PR 06 policy), the captured snapshot (PR 04), the parser evidence (PR 05)
// and the profile's capability table, so the planner stays pure and does not depend on how those modules evolve
// internally. Adapters from their published types build these inputs; nothing here reads a file, the ledger, a
// clock or the network.
import type { CaptureEntry, FrameworkVersion } from '../contracts/snapshot.js';
import type { CatalogKey, Digest, Id, Ordinal, WorkRef } from '../contracts/common.js';

export type PlannerLanguage = 'typescript' | 'javascript' | 'java';
export type PlannerScopeKind = 'source-file' | 'surface' | 'dependency-manifest' | 'ci-config' | 'repository';

/** One locked rule with the parts of its verified definition planning needs. */
export interface PlannerRule {
  readonly familyId: string;
  readonly revision: Ordinal;
  /** The lock's digest over the definition and the files it names: the rule's pin. */
  readonly definitionDigest: Digest;
  readonly packDigest: Digest;
  readonly languages: readonly PlannerLanguage[];
  readonly scopeKind: PlannerScopeKind;
  /** When present, the rule applies only where one of these frameworks resolved; unresolved is unknown. */
  readonly frameworks?: readonly string[];
  /** Capabilities a stage must establish before the rule can be checked. */
  readonly requires: readonly string[];
  /** The registered adapter that runs the rule. */
  readonly adapterId: Id;
}

/** The exact rule lock a plan pins: rules with verified definitions, tools and databases, by digest. */
export interface PlannerRuleLock {
  readonly digest: Digest;
  readonly rules: readonly PlannerRule[];
  readonly tools: readonly { readonly adapterId: Id; readonly version: string; readonly artifactDigest: Digest }[];
  readonly databases: readonly { readonly databaseId: Id; readonly snapshotDigest: Digest }[];
}

/** The effective policy's planning view. */
export interface PlannerPolicy {
  readonly digest: Digest;
  readonly rules: readonly { readonly familyId: string; readonly source: 'mandatory' | 'requested' | 'both' }[];
  /** Every planned check is required when true; otherwise only mandatory rules' checks are. */
  readonly requireCompleteCoverage: boolean;
  /** A check needing one of these capabilities is required, whatever its rule's source. */
  readonly requiredCapabilities: readonly string[];
}

/** The captured snapshot's planning view (the snapshot envelope's fields). */
export interface PlannerSnapshot {
  readonly id: Id;
  readonly inventoryDigest: Digest;
  readonly environmentProfileDigest: Digest;
  readonly sources: readonly { readonly sourceId: Id }[];
  readonly entries: readonly CaptureEntry[];
  readonly frameworkVersions: readonly FrameworkVersion[];
}

/** One source's parser evidence, as planning needs it. */
export interface PlannerAnalysis {
  readonly sourceId: Id;
  readonly analysisFingerprint: string;
  /** The parser's class for each captured path (`parsed`, `parse-failed`, …). */
  readonly files: readonly { readonly path: string; readonly class: string }[];
  /** Route, handler and page surfaces: canonical graph identities with the file that declares them. */
  readonly surfaces: readonly { readonly nodeId: string; readonly path: string; readonly kind: string }[];
}

/** One stage that establishes a capability on this profile, or why none does. */
export interface CapabilityEntry {
  readonly capability: string;
  readonly available: boolean;
  /** Required when unavailable: why. */
  readonly reasonCode?: CatalogKey;
  /** Capabilities that need parser evidence per file: a file that did not parse cannot have them. */
  readonly perFileParse?: boolean;
}

/** What one profile can run: its capabilities, built-in adapters and the bootstrap stages' identities. */
export interface PlannerProfile {
  readonly id: Id;
  readonly capabilities: readonly CapabilityEntry[];
  /** Coded adapters that ship with Sentinel and need no locked tool. */
  readonly builtInAdapters: readonly { readonly adapterId: Id; readonly implementationDigest: Digest }[];
  readonly stages: {
    readonly capture: Digest;
    readonly parse: Digest;
    readonly inventory: Digest;
  };
}

export interface PlannerLimits {
  /** Checks one revision may hold, every state counted. */
  readonly maxChecks: number;
  /** Distinct scopes one physical work unit may cover. */
  readonly maxScopesPerWork: number;
  /** Checks one physical work unit may cover. */
  readonly maxChecksPerWork: number;
  /** Work units one revision may hold. */
  readonly maxWork: number;
}

export const DEFAULT_PLANNER_LIMITS: PlannerLimits = Object.freeze({
  maxChecks: 200_000, maxScopesPerWork: 256, maxChecksPerWork: 2048, maxWork: 10_000,
});

// ---- the plan revision (sentinel-plan/draft-1) ----

export const PLAN_SCHEMA = 'sentinel-plan/draft-1' as const;

/**
 * A check's planning state. Only `planned` is assigned to work; every other state is kept with its reason, so a
 * check the profile cannot run is never silently dropped and never counted as covered.
 */
export type CheckState =
  | 'planned'
  /** A required capability or the rule's adapter is not available on this profile. */
  | 'unsupported'
  /** The rule is framework-gated and the framework's version is unresolved for this source. */
  | 'applicability-unknown'
  /** The scope exists but is unusable: not captured, or not parsed where the rule needs parser evidence. */
  | 'scope-unavailable'
  /** A folder whose descendants capture did not enumerate: how many scopes it holds is unknown. */
  | 'scope-unknown';

export const CHECK_STATES: readonly CheckState[] = Object.freeze(['planned', 'unsupported', 'applicability-unknown', 'scope-unavailable', 'scope-unknown']);

/** One check: (scope, rule revision, environment, mode). Its id is a digest of exactly those. */
export interface PlannedCheck {
  readonly id: Id;
  readonly familyId: string;
  readonly ruleRevision: Ordinal;
  readonly scopeKind: PlannerScopeKind;
  readonly scopeId: string;
  readonly sourceId: Id;
  readonly environment: Digest;
  readonly mode: 'deterministic';
  readonly required: boolean;
  readonly state: CheckState;
  readonly reasonCode?: CatalogKey;
  /** The work unit that covers it; only for `planned`. */
  readonly workId?: Id;
}

export type PlanStage = 'capture' | 'parse' | 'inventory' | 'check';

/** One physical work unit. It covers exactly `checks` and nothing else, however many rules or scopes it batches. */
export interface PlannedWork {
  readonly id: Id;
  readonly revision: Ordinal;
  readonly stage: PlanStage;
  readonly contract: string;
  readonly implementationDigest: Digest;
  readonly sourceId: Id | null;
  readonly adapterId: Id | null;
  readonly dependencies: readonly WorkRef[];
  /** Digest of every input that determines its output (inventory, analysis, rule pins, tool, scopes). */
  readonly inputFingerprint: Digest;
  readonly checks: readonly Id[];
  readonly scopes: readonly string[];
}

export interface PlanPins {
  readonly snapshotId: Id | null;
  readonly inventoryDigest: Digest | null;
  readonly environment: Digest | null;
  readonly ruleLockDigest: Digest | null;
  readonly policyDigest: Digest | null;
  readonly profileId: Id;
  readonly rules: readonly { readonly familyId: string; readonly revision: Ordinal; readonly definitionDigest: Digest; readonly packDigest: Digest }[];
  readonly tools: readonly { readonly adapterId: Id; readonly artifactDigest: Digest }[];
  readonly databases: readonly { readonly databaseId: Id; readonly snapshotDigest: Digest }[];
  readonly analyses: readonly { readonly sourceId: Id; readonly analysisFingerprint: string }[];
  readonly stages: PlannerProfile['stages'];
}

/** A rule the policy selects that the plan could not schedule at all. */
export interface RuleGap {
  readonly familyId: string;
  readonly required: boolean;
  readonly reasonCode: CatalogKey;
}

export interface PlanTallies {
  readonly checks: Readonly<Record<CheckState, number>>;
  readonly required: number;
  /** Required checks in any state but `planned`, plus required rule gaps. */
  readonly requiredNotPlanned: number;
  readonly work: number;
}

/** sentinel-plan/draft-1 — one immutable plan revision. A change is a new revision; a revision never changes. */
export interface PlanRevision {
  readonly schema: typeof PLAN_SCHEMA;
  readonly runId: Id;
  readonly revision: Ordinal;
  readonly kind: 'bootstrap' | 'analysis';
  /** The digest of the revision this one follows in the same run, or null. */
  readonly previous: Digest | null;
  readonly pins: PlanPins;
  /** Work published by an earlier plan (this or a parent run) that this revision depends on without redoing. */
  readonly reused: readonly WorkRef[];
  readonly work: readonly PlannedWork[];
  readonly checks: readonly PlannedCheck[];
  readonly ruleGaps: readonly RuleGap[];
  readonly tallies: PlanTallies;
  /** True only when every required check is planned: otherwise the run cannot report complete required coverage. */
  readonly requiredCoverageAchievable: boolean;
  /** Digest of every other field. */
  readonly digest: Digest;
}
