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
  receipt: { schema: 'sentinel-receipt/draft-1', type: 'ReceiptEnvelope' },
  admission: { schema: 'sentinel-admission/draft-1', type: 'AdmissionEnvelope' },
  controls: { schema: 'sentinel-controls/draft-1', type: 'ControlFactsEnvelope' },
} as const;

export type EnvelopeKind = keyof typeof ENVELOPES;
export const ENVELOPE_KINDS = Object.keys(ENVELOPES) as EnvelopeKind[];

// Pinned enum sets. test/contracts.test.ts asserts each against an explicit literal list *and* the generated
// schema, so a member added to a type without updating these (or the reverse) fails.
export const RUN_STATES = ['planned', 'running', 'pausing', 'paused', 'canceling', 'canceled', 'completed'] as const;
export const RUN_OUTCOMES = ['complete-coverage', 'partial-coverage', 'execution-failure'] as const;
export const POLICY_RESULTS = [
  'satisfied', 'finding-policy-failed', 'required-coverage-incomplete', 'configuration-failure', 'awaiting-confirmation',
] as const;
export const WORK_STATES = [
  'pending', 'ready', 'published', 'failed', 'running', 'leased', 'blocked', 'disabled-by-policy', 'satisfied-by-reuse',
] as const;
export const STAGE_KINDS = ['coded', 'agentic', 'external-tool'] as const;
export const ATTEMPT_STATES = ['running', 'succeeded', 'failed', 'interrupted', 'canceled', 'canceled-after-spend'] as const;
export const USAGE_CERTAINTIES = ['confirmed', 'unknown', 'not-applicable'] as const;
export const IDENTITY_SOURCES = ['provider-response', 'local-weight-digest', 'host-reported', 'self-reported', 'unknown'] as const;
export const CAPTURE_MODES = ['committed-tree', 'working-copy-stability-checked'] as const;
export const COVERAGE_STATUSES = ['complete', 'partial', 'unsupported', 'not-run', 'error'] as const;
export const COVERAGE_GRANULARITIES = ['per-file-per-rule', 'per-file', 'aggregate'] as const;
export const COVERAGE_BASES = ['executed', 'reused', 'imported', 'unavailable'] as const;
export const DISPOSITION_DECISIONS = ['accepted-risk', 'false-positive', 'mitigated', 'deferred'] as const;
export const DECISION_CHANNELS = ['owner-cli', 'mcp', 'http-bridge', 'model'] as const;
export const ASSERTION_TRUSTS = ['asserted', 'imported-config', 'runtime-observed'] as const;
export const COMPARISON_LABELS = [
  'new', 'persistent', 'changed-evidence', 'changed-detection', 'reopened', 'reopened-disposition-expired',
  'resolved-by-comparable-check', 'removed-surface', 'unassessed-in-current-scope', 'incomparable-conditions',
] as const;
export const PROTOCOL_MESSAGE_TYPES = [
  'hello', 'welcome', 'refuse', 'start', 'cancel', 'progress', 'checkpoint', 'heartbeat', 'diagnostic', 'cancel-ack', 'result',
] as const;

export const RULE_LANGUAGES = ['typescript', 'javascript', 'java'] as const;
export const RULE_SCOPE_KINDS = ['source-file', 'surface', 'dependency-manifest', 'ci-config', 'repository'] as const;
export const RULE_CAPABILITIES = [
  'source-bytes', 'pattern-match', 'source-span', 'call-occurrence', 'resolved-receiver-type',
  'framework-order', 'interprocedural-flow', 'runtime-observation', 'dependency-manifest', 'advisory-database',
] as const;
export const RULE_MEANINGS = ['candidate', 'finding'] as const;
/** Ordered from least to most severe; a lower failing threshold is stricter. */
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export const RULE_EVIDENCE = ['source-span', 'matched-pattern', 'control-fact', 'dependency-version', 'advisory-id'] as const;
export const FRAMEWORK_IDS = ['next', 'express', 'nest', 'spring'] as const;
export const RULE_ORIGINS = ['sentinel-original', 'third-party'] as const;
export const SENTINEL_ACTIONS = [
  'run.start', 'capture.source', 'disposition.propose', 'disposition.approve', 'rule.promote',
  'tool.acquire', 'paid.admit', 'disclosure.send', 'settings.adopt',
] as const;
/** Owner actions: an agent can never be granted them, and a person always confirms them with a receipt. */
export const OWNER_ACTIONS = ['disposition.approve', 'rule.promote', 'tool.acquire', 'settings.adopt'] as const;
export const ACTION_EFFECTS = ['local-artifacts', 'source-disclosure', 'paid-inference', 'network', 'tool-execution'] as const;
export const SETTINGS_TRUST = ['adopted', 'not-adopted', 'changed', 'missing', 'invalid'] as const;
export const ADMISSION_OUTCOMES = ['admitted', 'denied', 'awaiting-confirmation'] as const;
export const CREDENTIAL_BASES = ['local-only', 'keychain-scope', 'unknown', 'not-asked'] as const;
export const CONTROL_PROPERTIES = [
  'authentication', 'authorization', 'csrf', 'input-validation', 'rate-limit', 'security-headers', 'cors',
] as const;
export const CONTROL_VERDICTS = ['applies', 'does-not-apply', 'unknown'] as const;

/** Largest serialized envelope or worker message accepted, in UTF-8 bytes (PR 01's proposed 4 MiB output ceiling). */
export const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
