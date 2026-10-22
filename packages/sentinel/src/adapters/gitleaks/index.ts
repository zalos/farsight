// The Gitleaks secret-scanning adapter (PR 11). Internal: not in the package's exports or the production registry
// until the PR 08 scheduler and PR 09 command integrate it; its worker ships as a package asset.
export * from './adapter.js';
export * from './job.js';
export * from './normalize.js';
export * from './rules.js';
export * from './run.js';
export { GITLEAKS_WORKER_SOURCE } from './worker-source.js';
