// Deterministic planning (PR 06): what the planner reads and the plan revisions it writes.
//
// The inputs are planner-owned structural types. They name exactly the fields planning uses from the rule lock
// (PR 06 rules), the effective policy (PR 06 policy), the captured snapshot (PR 04), the parser evidence (PR 05)
// and the profile's capability table, so the planner stays pure and does not depend on how those modules evolve
// internally. Adapters from their published types build these inputs; nothing here reads a file, the ledger, a
// clock or the network.
import type { CaptureEntry, FrameworkVersion } from '../contracts/snapshot.js';
import type { CatalogKey, Digest, Id, Ordinal } from '../contracts/common.js';
import type {
  PlanCheck, PlanCheckState, PlanEnvelope, PlanInput, PlanPins, PlanRuleGap, PlanStage, PlanTallies, PlanWork,
} from '../contracts/plan.js';

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

// ---- the plan revision: the canonical sentinel-plan/draft-1 contract (contracts/plan.ts) ----

export const PLAN_SCHEMA = 'sentinel-plan/draft-1' as const;
export type PlanRevision = PlanEnvelope;
export type PlannedCheck = PlanCheck;
export type PlannedWork = PlanWork;
export type CheckState = PlanCheckState;
export type RuleGap = PlanRuleGap;
export type { PlanPins, PlanTallies, PlanStage, PlanInput };

export const CHECK_STATES: readonly CheckState[] = Object.freeze(['planned', 'unsupported', 'applicability-unknown', 'scope-unavailable', 'scope-unknown']);
