// Model review reason codes (PR 22). Every code is a catalog key in packages/core/src/strings-sentinel-review.ts.
// Refusals and frontiers are recorded, never thrown at the model; ReviewError is for inputs the caller got wrong.
import { sentinelReviewWord } from '@farsight/core/dist/strings-sentinel-review.js';

/** Why a tool request from the model was refused. The refusal is returned to the model as data and recorded. */
export const TOOL_REFUSAL_CODES = Object.freeze([
  'sentinel.review.tool.outOfScope',
  'sentinel.review.tool.unknown',
  'sentinel.review.tool.budget',
  'sentinel.review.tool.withheld',
  'sentinel.review.tool.invalidArgs',
] as const);

/** Why a reply was not accepted. */
export const REPLY_REJECTION_CODES = Object.freeze([
  'sentinel.review.reply.notJson',
  'sentinel.review.reply.shape',
  'sentinel.review.reply.unknownCitation',
  'sentinel.review.reply.citationChanged',
  'sentinel.review.reply.missingCitation',
  'sentinel.review.reply.inspectedUnread',
  'sentinel.review.reply.truncated',
] as const);

/** Why part of a review's scope was left unfinished or unreviewed. */
export const COPILOT_LOGIN_FRONTIER = 'sentinel.review.frontier.copilotLogin' as const;
export const REVIEW_FRONTIER_CODES = Object.freeze([
  'sentinel.review.frontier.budget',
  'sentinel.review.frontier.steps',
  'sentinel.review.frontier.deadline',
  'sentinel.review.frontier.invalidReplies',
  'sentinel.review.frontier.modelError',
  COPILOT_LOGIN_FRONTIER,
  'sentinel.review.frontier.uncertainUsage',
  'sentinel.review.frontier.notCaptured',
  'sentinel.review.frontier.tooLarge',
  'sentinel.review.frontier.withheld',
  'sentinel.review.frontier.unsupportedLanguage',
  'sentinel.review.frontier.unknownScope',
  'sentinel.review.frontier.notInspected',
  'sentinel.review.frontier.canceled',
  'sentinel.review.frontier.fenced',
] as const);

export const REVIEW_LIMITATION_CODES = Object.freeze(['sentinel.review.limitation.modelClaim'] as const);

export const REVIEW_ERROR_CODES = Object.freeze([
  'sentinel.review.invalidInput',
  'sentinel.review.integrity',
  'sentinel.review.checkpoint',
  'sentinel.review.planLimit',
  'sentinel.review.secretCoverageRequired',
  'sentinel.review.foregroundRequired',
  'sentinel.review.outputSchema',
  'sentinel.review.nativeBudget',
  'sentinel.review.packInvalid',
  'sentinel.review.packChanged',
  'sentinel.review.packUnapproved',
  'sentinel.review.instructionsUnsealed',
] as const);

/** E5/E8 gate states and reasons. */
export const EVALUATION_CODES = Object.freeze([
  'sentinel.review.eval.mockOnly',
  'sentinel.review.eval.modelsMissing',
  'sentinel.review.eval.casesMissing',
  'sentinel.review.eval.labelsUnreviewed',
  'sentinel.review.eval.thresholdsMissing',
  'sentinel.review.eval.incomplete',
  'sentinel.review.eval.estimate',
] as const);

export type ToolRefusalCode = (typeof TOOL_REFUSAL_CODES)[number];
export type ReplyRejectionCode = (typeof REPLY_REJECTION_CODES)[number];
export type ReviewFrontierCode = (typeof REVIEW_FRONTIER_CODES)[number];
export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];
export type EvaluationCode = (typeof EVALUATION_CODES)[number];

export class ReviewError extends Error {
  readonly code: ReviewErrorCode;
  constructor(code: ReviewErrorCode, detail = '') {
    super(sentinelReviewWord(code, { detail }));
    this.name = 'ReviewError';
    this.code = code;
  }
}

export const reviewFail = (code: ReviewErrorCode, detail = ''): never => {
  throw new ReviewError(code, detail);
};
