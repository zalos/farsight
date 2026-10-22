// The OSV advisory adapter (PR 12): OSV-Scanner 2.7.0 in full offline mode behind an original shell shim, isolated by
// PR 07, with coordinator-side normalization, and the separate owner-confirmed database acquisition. Internal to the
// package until the planner and command integrate it.
export { OSV_ADAPTER, OSV_ENGINE, OSV_ENGINE_ARGS, OSV_IMAGE_PLATFORMS, OSV_MEASURED_ARCHITECTURES, OSV_SUPPORT, OSV_WORKER_DIGEST, buildOsvAdapter } from './adapter.js';
export type { OsvAdapterBuild } from './adapter.js';
export { buildOsvJob, dependencyKindOf, CONTAINER_BASENAME, KIND_ECOSYSTEMS, MAX_OSV_TARGETS } from './job.js';
export type { DependencyTarget, SnapshotInput, OsvJob, OsvJobTarget, DependencyFileKind, Ecosystem, BuiltOsvJob } from './job.js';
export { normalizeOsvRun, explainAdvisoryChanges, pomDeclarations, OSV_CERTAINTIES, OSV_COVERAGE_REASONS, OSV_REFUSAL_REASONS, OSV_ENGINE_FAILURES } from './normalize.js';
export type { OsvRunResult, OsvFinding, OsvComponent, OsvCoverage, VersionCertainty, AdvisoryChange, OsvEngineFailure } from './normalize.js';
export { acquireAdvisorySnapshots, acquisitionIntent, loadAdvisorySnapshot, advisoryUrl, ADVISORY_ORIGIN, ADVISORY_ECOSYSTEMS, MAX_ACQUISITION_BYTES } from './acquire.js';
export type { AdvisorySnapshot, AcquisitionRequest, Transport } from './acquire.js';
export { runOsvAttempt } from './run.js';
export type { OsvAttempt } from './run.js';
export { OsvError, OSV_ERROR_CODES } from './errors.js';
