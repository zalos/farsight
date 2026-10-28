// Deterministic planning (PR 06). Pure functions over explicit inputs; persisting and admitting a plan belong to
// the coordinator (PR 08).
export {
  planBootstrap,
  planAnalysis,
  planPipelineBootstrap,
  planPipelineAnalysis,
  checkWorkGraph,
  verifyPlanRevision,
  languageOf,
  surfacesFromIndex,
  SURFACE_NODE_KINDS,
} from './planner.js';
export type { BootstrapRequest, AnalysisRequest } from './planner.js';
export { PlanError, PLAN_ERROR_CODES, PLAN_REASON_CODES } from './errors.js';
export type { PlanErrorCode, PlanReasonCode } from './errors.js';
export { PLAN_SCHEMA, CHECK_STATES, DEFAULT_PLANNER_LIMITS } from './types.js';
export type {
  PlanRevision,
  PlannedCheck,
  PlannedWork,
  PlanPins,
  RuleGap,
  PlanTallies,
  CheckState,
  PlanStage,
  PlannerRule,
  PlannerRuleLock,
  PlannerPolicy,
  PlannerSnapshot,
  PlannerAnalysis,
  PlannerProfile,
  PlannerLimits,
  PlannerLanguage,
  PlannerScopeKind,
} from './types.js';
export { plannerLockFrom, plannerPolicyFrom, plannerSnapshotFrom, plannerAnalysisFrom } from './adapters.js';
export {
  workEnvelopesFor,
  influenceManifestOf,
  canonicalArtifactId,
  checksCoveredBy,
  adapterOf,
  capturedInputsOf,
  planBoundaryFor,
  verifyWorkEnvelope,
  verifyInputSet,
} from './boundary.js';
export type {
  ExecutionProfile,
  WorkConversion,
  InfluenceManifest,
  ConvertedWork,
  BoundaryInput,
  PlanBoundaryParts,
  BoundaryRequest,
} from './boundary.js';
export { evaluateRequiredCoverage } from './coverage.js';
export type { RequiredCoverage, CheckCoverage } from './coverage.js';
export { createCapabilityTable, isCapabilityTable, capabilityOf } from './capabilities.js';
export type { CapabilityFact, CapabilityTable, CapabilityAnswer } from './capabilities.js';
export {
  PIPELINE_SCHEMA,
  BOOTSTRAP_OPERATIONS,
  BUILTIN_CHECK_OPERATIONS,
  TOOL_ADAPTERS,
  DEFAULT_CHECK_STAGES,
  stageModel,
  requireBootstrap,
  declaredAnalysis,
  agentSeedsOf,
  stagesOfUnits,
  selectStages,
  defaultPipelineOf,
  planShapeOf,
  PLAN_SHAPE_KEYS,
  SCRIPT_CONTRACT,
  scriptFingerprintOf,
  scriptOutputOf,
  planNoticesOf,
} from './pipeline.js';
export type {
  StageModel,
  StageRole,
  AgentUnitSeed,
  DeclaredAnalysis,
  StageSelection,
  DefaultReview,
  ScriptPins,
} from './pipeline.js';
