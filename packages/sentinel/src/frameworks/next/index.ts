// The Next middleware applicability pack (PR 14): `@farsight/sentinel/frameworks/next`.
export { analyzeNext, CONTROL_PROPERTIES, NEXT_REASON_CODES, MAX_CONFIG_BYTES } from './analyze.js';
export type {
  Applicability,
  NextPackInput,
  NextPackResult,
  NextProject,
  NextReasonCode,
  SurfaceApplicability,
} from './analyze.js';
export { NEXT_SUPPORT, NEXT_PACK_DIGEST, NEXT_PACK_ID, NEXT_PACK_REVISION, NEXT_ANALYSIS_SCHEMA } from './support.js';
export { NextPackError, NEXT_ERROR_CODES } from './errors.js';
export type { NextErrorCode } from './errors.js';
export { parseMatcherSource, routeLanguage, decide, decideCaseStable, MAX_SOURCE_LENGTH } from './pattern.js';
export type {
  SegmentItem,
  SegmentLanguage,
  Coverage,
  Decision,
  RouteLanguage,
  ParsedMatcherSource,
} from './pattern.js';
export { readMiddleware, readNextConfig } from './config.js';
export type { MiddlewareRead, MiddlewareConfig, MatcherEntry, NextConfigRead, ByteRange } from './config.js';
export { resolveVersions, PACKAGES, MAX_LOCKFILE_BYTES } from './version.js';
export type { ResolvedVersion, VersionReason, PackageName } from './version.js';
