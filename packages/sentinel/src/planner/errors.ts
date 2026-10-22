// Planner reason codes. Every code is a catalog key in packages/core/src/strings-sentinel-plan.ts; a test pins
// these lists against the catalog.
import { sentinelPlanWord } from '@farsight/core/dist/strings-sentinel-plan.js';

/** Why a check is not planned, or a rule could not be scheduled. Recorded in the plan, never thrown. */
export const PLAN_REASON_CODES = Object.freeze([
  'sentinel.plan.capabilityUnavailable', 'sentinel.plan.capabilityNotPermitted', 'sentinel.plan.adapterNotLocked', 'sentinel.plan.adapterNotRegistered',
  'sentinel.plan.repositoryTooLarge', 'sentinel.plan.operationUnbound', 'sentinel.plan.parseRequired',
  'sentinel.plan.frameworkUnresolved', 'sentinel.plan.frameworkNotDetected', 'sentinel.plan.unknownDescendants', 'sentinel.plan.inputNotCaptured',
  'sentinel.plan.coverageMissing', 'sentinel.plan.coverageNotComplete', 'sentinel.plan.coverageWrongUnit', 'sentinel.plan.coverageImported',
  'sentinel.plan.coverageReuseUnproven', 'sentinel.plan.coverageConflict', 'sentinel.plan.ruleNotLocked',
] as const);
export type PlanReasonCode = typeof PLAN_REASON_CODES[number];

/** Why a whole plan was refused. */
export const PLAN_ERROR_CODES = Object.freeze([
  'sentinel.plan.invalidInput', 'sentinel.plan.cycle', 'sentinel.plan.unknownDependency', 'sentinel.plan.tooManyChecks',
  'sentinel.plan.tooMuchWork', 'sentinel.plan.pinMismatch',
] as const);
export type PlanErrorCode = typeof PLAN_ERROR_CODES[number];

export class PlanError extends Error {
  readonly code: PlanErrorCode;
  constructor(code: PlanErrorCode, detail = '') {
    super(sentinelPlanWord(code, { detail }));
    this.name = 'PlanError';
    this.code = code;
  }
}
