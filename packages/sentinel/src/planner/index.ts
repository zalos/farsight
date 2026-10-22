// Deterministic planning (PR 06). Pure functions over explicit inputs; persisting and admitting a plan belong to
// the coordinator (PR 08).
export { planBootstrap, planAnalysis, checkWorkGraph, verifyPlanRevision, languageOf, surfacesFromIndex, SURFACE_NODE_KINDS } from './planner.js';
export type { BootstrapRequest, AnalysisRequest } from './planner.js';
export { PlanError, PLAN_ERROR_CODES, PLAN_REASON_CODES } from './errors.js';
export type { PlanErrorCode, PlanReasonCode } from './errors.js';
export { PLAN_SCHEMA, CHECK_STATES, DEFAULT_PLANNER_LIMITS } from './types.js';
export type {
  PlanRevision, PlannedCheck, PlannedWork, PlanPins, RuleGap, PlanTallies, CheckState, PlanStage, PlannerRule, PlannerRuleLock,
  PlannerPolicy, PlannerSnapshot, PlannerAnalysis, PlannerProfile, PlannerLimits, PlannerLanguage, PlannerScopeKind, CapabilityEntry,
} from './types.js';
export { plannerLockFrom, plannerPolicyFrom, plannerAnalysisFrom, ruleLockDigest } from './adapters.js';
export type { RuleLockShape, PackManifestShape, RuleDefinitionShape, EffectivePolicyShape, SourceAnalysisShape } from './adapters.js';
