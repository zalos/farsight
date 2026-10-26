// Nest request controls (PR 16, ADR 32). Internal to the package until the planner and command integrate it.
export { analyzeNest } from './analyze.js';
export type {
  NestAnalysis,
  NestAnalysisInput,
  NestScopeReport,
  NestSurface,
  NestBinding,
  NestInput,
  NestStage,
  NestScope,
  NestEffect,
  ParserGraph,
} from './analyze.js';
export { NEST_PACK } from './support.js';
export { NEST_REASON_CODES, NestPackError, nestReasonWord } from './errors.js';
export type { NestReasonCode } from './errors.js';
