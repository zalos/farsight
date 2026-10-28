export type {
  InstructionContent,
  SelectedSkill,
  ReviewInstructionsEnvelope,
  ReviewInstructionBinding,
  ReviewRequestEnvelope,
  ReviewProviderSelection,
} from './instructions.js';
// The draft Sentinel contracts. Types here are the one source; schemas/*.schema.json and
// src/schemas.generated.ts are generated from them by scripts/generate-schemas.mjs (--check detects drift).
export type * from './common.js';
export type * from './snapshot.js';
export type * from './run.js';
export type * from './work.js';
export type * from './attempt.js';
export type * from './observation.js';
export type * from './coverage.js';
export type * from './disposition.js';
export type * from './report.js';
export type * from './protocol.js';
export type * from './rules.js';
export type * from './policy.js';
export type * from './controls.js';
export type * from './review.js';
export type * from './review-providers.js';
export type * from './plan.js';
export type * from './paths.js';
export type * from './deepimport.js';
export type * from './service.js';
export type * from './import-view.js';
export type * from './decision-view.js';
export type * from './pathrequest.js';

export type * from './preparation.js';
export type * from './ownerui.js';
export type * from './pipeline.js';

import type {
  AgentMode,
  AgentRunnerId,
  BuiltinOperation,
  CostUnobservedReason,
  ExecutionSite,
  FeatureFlagName,
  PipelineStageKind,
  StageFanOut,
  StageOutputType,
} from './pipeline.js';
import type { StageKind } from './work.js';
import type { BuiltinPlanStage, ReviewPlanStage } from './plan.js';

/**
 * Every envelope: its kind, the one schema version this build reads and writes, and the generated type.
 * A draft version is never frozen; renaming to `/v1` happens only after independent contract review.
 */
export const ENVELOPES = {
  snapshot: { schema: 'sentinel-snapshot/draft-1', type: 'SnapshotEnvelope' },
  run: { schema: 'sentinel-run/draft-1', type: 'RunEnvelope' },
  work: { schema: 'sentinel-work/draft-1', type: 'WorkEnvelope' },
  attempt: { schema: 'sentinel-attempt/draft-1', type: 'AttemptEnvelope' },
  observation: { schema: 'sentinel-observation/draft-1', type: 'ObservationEnvelope' },
  coverage: { schema: 'sentinel-coverage/draft-1', type: 'CoverageEnvelope' },
  disposition: { schema: 'sentinel-disposition/draft-1', type: 'DispositionEnvelope' },
  report: { schema: 'sentinel-report/draft-1', type: 'ReportEnvelope' },
  protocol: { schema: 'sentinel-worker/draft-1', type: 'ProtocolMessage' },
  rulepack: { schema: 'sentinel-rulepack/draft-1', type: 'RulePackManifest' },
  rulelock: { schema: 'sentinel-rulelock/draft-1', type: 'RuleLockEnvelope' },
  settings: { schema: 'sentinel-settings/draft-1', type: 'SettingsEnvelope' },
  repoconfig: { schema: 'sentinel-repoconfig/draft-1', type: 'RepoConfigEnvelope' },
  policy: { schema: 'sentinel-policy/draft-1', type: 'EffectivePolicyEnvelope' },
  adoption: { schema: 'sentinel-adoption/draft-1', type: 'AdoptionEnvelope' },
  owneruireceipt: { schema: 'sentinel-owneruireceipt/draft-1', type: 'OwnerUiReceiptEnvelope' },
  owneruicapabilities: { schema: 'sentinel-owneruicapabilities/draft-1', type: 'OwnerUiCapabilities' },
  receipt: { schema: 'sentinel-receipt/draft-1', type: 'ReceiptEnvelope' },
  admission: { schema: 'sentinel-admission/draft-1', type: 'AdmissionEnvelope' },
  controls: { schema: 'sentinel-controls/draft-1', type: 'ControlFactsEnvelope' },
  plan: { schema: 'sentinel-plan/draft-1', type: 'PlanEnvelope' },
  paths: { schema: 'sentinel-paths/draft-1', type: 'PathEvidenceEnvelope' },
  decisioninput: { schema: 'sentinel-decision-input/draft-1', type: 'OwnerDecisionInput' },
  decisionview: { schema: 'sentinel-decision-view/draft-1', type: 'DecisionViewEnvelope' },
  decisionpage: { schema: 'sentinel-decision-page/draft-1', type: 'DecisionPageEnvelope' },
  importview: { schema: 'sentinel-import-view/draft-1', type: 'ImportViewEnvelope' },
  importpage: { schema: 'sentinel-import-page/draft-1', type: 'ImportPageEnvelope' },
  pathrequest: { schema: 'sentinel-path-request/draft-1', type: 'PathRequestEnvelope' },
  deepimport: { schema: 'sentinel-deep-import/draft-1', type: 'DeepImportEnvelope' },
  servicecapabilities: { schema: 'sentinel-service-capabilities/draft-1', type: 'ServiceCapabilities' },
  runinspection: { schema: 'sentinel-run-inspection/draft-1', type: 'RunInspection' },
  inspectionpage: { schema: 'sentinel-inspection-page/draft-1', type: 'InspectionPage' },
  reportdelivery: { schema: 'sentinel-report-delivery/draft-1', type: 'ReportDelivery' },
  deliverychunk: { schema: 'sentinel-delivery-chunk/draft-1', type: 'DeliveryChunk' },
  controlcapabilities: { schema: 'sentinel-control-capabilities/draft-1', type: 'ControlCapabilities' },
  controloutcome: { schema: 'sentinel-control-outcome/draft-1', type: 'ControlOutcome' },
  preparationcapabilities: { schema: 'sentinel-preparation-capabilities/draft-1', type: 'PreparationCapabilities' },
  configurationpreview: { schema: 'sentinel-configuration-preview/draft-1', type: 'ConfigurationPreview' },
  preparationstatus: { schema: 'sentinel-preparation-status/draft-1', type: 'PreparationStatus' },
  preparationoutcome: { schema: 'sentinel-preparation-outcome/draft-1', type: 'PreparationOutcome' },
  partitions: { schema: 'sentinel-review-partitions/draft-1', type: 'ReviewPartitionsEnvelope' },
  checkpoint: { schema: 'sentinel-review-checkpoint/draft-1', type: 'ReviewCheckpointEnvelope' },
  instructions: { schema: 'sentinel-review-instructions/draft-1', type: 'ReviewInstructionsEnvelope' },
  reviewrequest: { schema: 'sentinel-review-request/draft-1', type: 'ReviewRequestEnvelope' },
  review: { schema: 'sentinel-review-record/draft-1', type: 'ReviewRecordEnvelope' },
  attemptretained: { schema: 'sentinel-attempt-retained/draft-1', type: 'AttemptRetainedEnvelope' },
  pipeline: { schema: 'sentinel-pipeline/draft-1', type: 'PipelineDefinition' },
  pipelineadoption: { schema: 'sentinel-pipeline-adoption/draft-1', type: 'PipelineAdoptionEnvelope' },
} as const;

export type EnvelopeKind = keyof typeof ENVELOPES;
export const ENVELOPE_KINDS = Object.keys(ENVELOPES) as EnvelopeKind[];

// Pinned enum sets. test/contracts.test.ts asserts each against an explicit literal list *and* the generated
// schema, so a member added to a type without updating these (or the reverse) fails.
export const RUN_STATES = ['planned', 'running', 'pausing', 'paused', 'canceling', 'canceled', 'completed'] as const;
export const RUN_OUTCOMES = ['complete-coverage', 'partial-coverage', 'execution-failure'] as const;
export const POLICY_RESULTS = [
  'satisfied',
  'finding-policy-failed',
  'required-coverage-incomplete',
  'configuration-failure',
  'awaiting-confirmation',
] as const;
export const WORK_STATES = [
  'pending',
  'ready',
  'published',
  'failed',
  'running',
  'leased',
  'blocked',
  'disabled-by-policy',
  'satisfied-by-reuse',
] as const;
export const STAGE_KINDS = ['coded', 'agentic', 'external-tool', 'script'] as const;
/** The unit stage ids every plan carried before declared pipelines; a declared stage id may be any other `StageId`. */
export const BUILTIN_PLAN_STAGES = ['capture', 'parse', 'inventory', 'check'] as const;
export const REVIEW_PLAN_STAGES = ['review-guided', 'review-general'] as const;
export const PIPELINE_STAGE_KINDS = ['builtin', 'tool', 'script', 'agent'] as const;
/** A declared stage's kind as the work contract records it. */
export const WORK_STAGE_KIND_OF: Readonly<Record<PipelineStageKind, StageKind>> = Object.freeze({
  builtin: 'coded',
  tool: 'external-tool',
  script: 'script',
  agent: 'agentic',
});
export const BUILTIN_OPERATIONS = [
  'capture',
  'parse',
  'inventory',
  'walkthrough',
  'framework-controls',
  'report',
] as const;
export const STAGE_OUTPUT_TYPES = [
  'source',
  'parse',
  'inventory',
  'findings',
  'coverage',
  'observations',
  'walkthrough-md',
  'report',
] as const;
export const STAGE_FAN_OUTS = ['per-run', 'per-source', 'per-entry', 'per-check'] as const;
export const AGENT_RUNNERS = ['claude-cli', 'copilot-cli', 'hosted-api', 'ollama'] as const;
export const AGENT_MODES = ['brokered', 'native'] as const;
export const EXECUTION_SITES = ['in-process', 'child', 'container', 'host', 'sandboxed-cli'] as const;
export const COST_UNOBSERVED_REASONS = ['subscription', 'usage-unknown', 'no-rates'] as const;
/** The gated features, by registry name (policy/features.ts holds their settings keys and defaults). */
export const FEATURE_FLAG_NAMES = [
  'stage.host-scripts',
  'runner.claude-cli',
  'runner.copilot-cli',
  'review.hosted-api',
] as const;
export const ATTEMPT_STATES = [
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'canceled',
  'canceled-after-spend',
] as const;
export const USAGE_CERTAINTIES = ['confirmed', 'unknown', 'not-applicable'] as const;
export const IDENTITY_SOURCES = [
  'provider-response',
  'local-weight-digest',
  'host-reported',
  'self-reported',
  'unknown',
] as const;
export const CAPTURE_MODES = ['committed-tree', 'working-copy-stability-checked'] as const;
export const COVERAGE_STATUSES = ['complete', 'partial', 'unsupported', 'not-run', 'error'] as const;
export const COVERAGE_GRANULARITIES = ['per-file-per-rule', 'per-file', 'aggregate'] as const;
export const COVERAGE_BASES = ['executed', 'reused', 'imported', 'unavailable'] as const;
export const DISPOSITION_DECISIONS = ['accepted-risk', 'false-positive', 'mitigated', 'deferred'] as const;
export const DECISION_CHANNELS = ['owner-cli', 'mcp', 'http-bridge', 'model', 'local-service', 'owner-ui'] as const;
export const ASSERTION_TRUSTS = ['asserted', 'imported-config', 'runtime-observed'] as const;
export const COMPARISON_LABELS = [
  'new',
  'persistent',
  'changed-evidence',
  'changed-detection',
  'reopened',
  'reopened-disposition-expired',
  'resolved-by-comparable-check',
  'removed-surface',
  'unassessed-in-current-scope',
  'incomparable-conditions',
] as const;
export const PROTOCOL_MESSAGE_TYPES = [
  'hello',
  'welcome',
  'refuse',
  'start',
  'cancel',
  'progress',
  'checkpoint',
  'heartbeat',
  'diagnostic',
  'cancel-ack',
  'result',
] as const;

export const RULE_LANGUAGES = ['typescript', 'javascript', 'java'] as const;
export const RULE_SCOPE_KINDS = [
  'source-file',
  'surface',
  'dependency-manifest',
  'ci-config',
  'infrastructure-config',
  'repository',
] as const;
export const RULE_CAPABILITIES = [
  'source-bytes',
  'pattern-match',
  'source-span',
  'call-occurrence',
  'resolved-receiver-type',
  'framework-order',
  'interprocedural-flow',
  'runtime-observation',
  'dependency-manifest',
  'advisory-database',
] as const;
export const RULE_MEANINGS = ['candidate', 'finding'] as const;
/** Ordered from least to most severe; a lower failing threshold is stricter. */
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export const RULE_EVIDENCE = [
  'source-span',
  'matched-pattern',
  'control-fact',
  'dependency-version',
  'advisory-id',
  'call-path',
] as const;
export const FRAMEWORK_IDS = ['next', 'express', 'nest', 'spring'] as const;
export const RULE_ORIGINS = ['sentinel-original', 'third-party'] as const;
export const SENTINEL_ACTIONS = [
  'run.start',
  'capture.source',
  'disposition.propose',
  'disposition.approve',
  'rule.promote',
  'tool.acquire',
  'paid.admit',
  'disclosure.send',
  'settings.adopt',
  'run.pause',
  'run.cancel',
  'context.pin',
  'evidence.import',
  'evidence.abandon',
] as const;
/** Owner actions: an agent can never be granted them, and a person always confirms them with a receipt. */
export const OWNER_ACTIONS = [
  'disposition.approve',
  'rule.promote',
  'tool.acquire',
  'settings.adopt',
  'context.pin',
  'evidence.import',
  'evidence.abandon',
] as const;
export const ACTION_EFFECTS = [
  'local-artifacts',
  'source-disclosure',
  'paid-inference',
  'network',
  'tool-execution',
] as const;
export const SETTINGS_TRUST = ['adopted', 'not-adopted', 'changed', 'missing', 'invalid'] as const;
export const ADMISSION_OUTCOMES = ['admitted', 'denied', 'awaiting-confirmation'] as const;
export const CREDENTIAL_BASES = ['local-only', 'keychain-scope', 'unknown', 'not-asked'] as const;
export const CONTROL_PROPERTIES = [
  'authentication',
  'authorization',
  'csrf',
  'input-validation',
  'rate-limit',
  'security-headers',
  'cors',
] as const;
export const CONTROL_VERDICTS = ['applies', 'does-not-apply', 'unknown'] as const;
export const REVIEW_VERDICTS = ['finding', 'no-finding', 'inconclusive'] as const;
export const REVIEW_KINDS = ['guided', 'general'] as const;
export const REVIEW_OUTCOMES = ['completed', 'unfinished'] as const;
export const MODEL_PRICING_KINDS = ['rates', 'no-fee'] as const;

/** Largest serialized envelope or worker message accepted, in UTF-8 bytes (PR 01's proposed 4 MiB output ceiling). */
export const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;

// Compile-time proof that each pinned list above names exactly its type's members: adding a member to one and not
// the other fails the build, before the tests pin the list against the generated schema.
type Exact<List extends readonly string[], T extends string> = [T] extends [List[number]]
  ? [List[number]] extends [T]
    ? true
    : never
  : never;
const _exact: [
  Exact<typeof STAGE_KINDS, StageKind>,
  Exact<typeof BUILTIN_PLAN_STAGES, BuiltinPlanStage>,
  Exact<typeof REVIEW_PLAN_STAGES, ReviewPlanStage>,
  Exact<typeof PIPELINE_STAGE_KINDS, PipelineStageKind>,
  Exact<typeof BUILTIN_OPERATIONS, BuiltinOperation>,
  Exact<typeof STAGE_OUTPUT_TYPES, StageOutputType>,
  Exact<typeof STAGE_FAN_OUTS, StageFanOut>,
  Exact<typeof AGENT_RUNNERS, AgentRunnerId>,
  Exact<typeof AGENT_MODES, AgentMode>,
  Exact<typeof EXECUTION_SITES, ExecutionSite>,
  Exact<typeof COST_UNOBSERVED_REASONS, CostUnobservedReason>,
  Exact<typeof FEATURE_FLAG_NAMES, FeatureFlagName>,
] = [true, true, true, true, true, true, true, true, true, true, true, true];
void _exact;
