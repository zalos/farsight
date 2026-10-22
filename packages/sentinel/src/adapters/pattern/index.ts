// The pattern adapter (PR 10): Semgrep 1.181.0 behind an original protocol shim, isolated by PR 07, with
// coordinator-side normalization. Internal to the package until the planner and command integrate it.
export { buildPatternAdapter, PATTERN_IMAGE_PLATFORMS, MEASURED_ARCHITECTURES, PATTERN_ADAPTER, PATTERN_ENGINE, PATTERN_SUPPORT, ENGINE_ARGS, MAX_TARGET_BYTES, PATTERN_WORKER_DIGEST } from './adapter.js';
export { buildPatternJob, patternRuleOf, languageOf, MAX_PATTERN_TARGETS } from './job.js';
export type { PatternAdapterBuild } from './adapter.js';
export type { PatternRule, PatternTarget, PatternJob, PatternLanguage, PatternEvidenceKind, BuiltPatternJob } from './job.js';
export { normalizePatternRun, PATTERN_COVERAGE_REASONS, PATTERN_REFUSAL_REASONS } from './normalize.js';
export type { PatternRunResult, PatternFinding, PatternCoverage, PatternEvidence, PatternRefusal, CoverageStatus } from './normalize.js';
export { runPatternAttempt } from './run.js';
export { patternRulesFromResolved, PATTERN_UNSUPPORTED_REASONS, PATTERN_PROVIDES } from './resolved.js';
export type { ResolvedRuleInput, PackFileInput, ResolvedPatternRules, PatternUnsupportedReason } from './resolved.js';
export type { PatternAttempt } from './run.js';
export { PatternError, PATTERN_ERROR_CODES } from './errors.js';
