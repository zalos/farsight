// The zizmor CI-configuration adapter (PR 13, ADR 34): zizmor 1.31.1, offline, behind an original shell shim, isolated
// by PR 07, with coordinator-side normalization. Internal to the package until the planner and command integrate it.
export { ZIZMOR_ADAPTER, ZIZMOR_ENGINE, ZIZMOR_ENGINE_ARGS, ZIZMOR_IMAGE_PLATFORMS, ZIZMOR_MEASURED_ARCHITECTURES, ZIZMOR_ONLINE_AUDITS, ZIZMOR_OFFLINE_DEGRADED_AUDITS, ZIZMOR_SUPPORT, ZIZMOR_WORKER_BYTES, ZIZMOR_WORKER_DIGEST, buildZizmorAdapter } from './adapter.js';
export type { ZizmorAdapterBuild } from './adapter.js';
export { buildZizmorJob, ciKindOf, MAX_ZIZMOR_TARGETS, MAX_ZIZMOR_FILE_BYTES, MAX_ZIZMOR_TOTAL_BYTES } from './job.js';
export type { CiTarget, CiFileKind, ZizmorJob, ZizmorJobTarget, ZizmorUnsent, BuiltZizmorJob } from './job.js';
export { normalizeZizmorRun, notRunZizmor, ZIZMOR_COVERAGE_REASONS, ZIZMOR_REFUSAL_REASONS, ZIZMOR_ENGINE_FAILURES, ZIZMOR_SEVERITIES } from './normalize.js';
export type { ZizmorRunResult, ZizmorFinding, ZizmorLocation, ZizmorCoverage, ZizmorCoverageReason, ZizmorSeverity } from './normalize.js';
export { runZizmorAttempt } from './run.js';
export type { ZizmorAttempt } from './run.js';
export { ZizmorError, ZIZMOR_ERROR_CODES } from './errors.js';
