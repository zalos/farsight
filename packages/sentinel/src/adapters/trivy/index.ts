// The Trivy misconfiguration adapter (PR 13, ADR 33): Trivy 0.76.1 `config` with the pinned trivy-checks 2.3.0 bundle
// behind an original shell shim, isolated by PR 07, with coordinator-side normalization, and the separate
// owner-confirmed bundle acquisition. Internal to the package until the planner and command integrate it.
export {
  TRIVY_ADAPTER,
  TRIVY_ENGINE,
  TRIVY_CHECKS_BUNDLE,
  TRIVY_ENGINE_ARGS,
  TRIVY_IMAGE_PLATFORMS,
  TRIVY_MEASURED_ARCHITECTURES,
  TRIVY_MISCONFIG_SCANNERS,
  TRIVY_SUPPORT,
  TRIVY_WORKER_BYTES,
  TRIVY_WORKER_DIGEST,
  buildTrivyAdapter,
} from './adapter.js';
export type { TrivyAdapterBuild, TrivyConfigType } from './adapter.js';
export { buildTrivyJob, trivyKindOf, MAX_TRIVY_TARGETS, MAX_TRIVY_FILE_BYTES, MAX_TRIVY_TOTAL_BYTES } from './job.js';
export type {
  ConfigTarget,
  BundleInput,
  TrivyJob,
  TrivyJobTarget,
  TrivyUnsent,
  TrivyFileKind,
  BuiltTrivyJob,
} from './job.js';
export {
  normalizeTrivyRun,
  notRunResult,
  TRIVY_COVERAGE_REASONS,
  TRIVY_REFUSAL_REASONS,
  TRIVY_ENGINE_FAILURES,
  TRIVY_SEVERITIES,
} from './normalize.js';
export type { TrivyRunResult, TrivyFinding, TrivyCoverage, TrivyCoverageReason, TrivySeverity } from './normalize.js';
export {
  acquireChecksBundle,
  checksAcquisitionIntent,
  loadChecksBundle,
  checksManifestUrl,
  checksBlobUrl,
  CHECKS_REGISTRY,
  CHECKS_BLOB_HOST,
} from './bundle.js';
export type { ChecksBundle, ChecksTransport } from './bundle.js';
export { runTrivyAttempt } from './run.js';
export type { TrivyAttempt } from './run.js';
export { TrivyError, TRIVY_ERROR_CODES } from './errors.js';
