// Sentinel's analysis evidence (PR 18, ADR 36): bounded static call paths over the public parser's graph, and the
// validated import of customer-attested deep-analysis results. No deep engine is bundled, selected or run.
export {
  boundedCallPaths,
  DEFAULT_PATH_BOUNDS,
  PATH_REASON_CODES,
  PATHS_IMPLEMENTATION,
  PathError,
} from './paths/paths.js';
export type { PathAnalysis, PathQuery, PathReason, PathRequest } from './paths/paths.js';
export { importDeepAnalysis, deepImportIntent, DEEP_ANALYSIS_SUPPORT, DEEP_REASON_CODES } from './deep/import.js';
export type { DeepImportRequest, DeepImportResult, DeepReason } from './deep/import.js';
