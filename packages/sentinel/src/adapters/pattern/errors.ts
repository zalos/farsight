// The pattern adapter's reason codes (catalog: core strings-sentinel-pattern.ts).
import { SentinelError } from '../../kernel/errors.js';
/** Why the pattern adapter refused: each is a catalog key in core strings-sentinel-pattern.ts. */
export const PATTERN_ERROR_CODES = [
  'sentinel.pattern.ruleInvalid',
  'sentinel.pattern.targetInvalid',
  'sentinel.pattern.outputInvalid',
] as const;
/** One of {@link PATTERN_ERROR_CODES}. */
export type PatternErrorCode = (typeof PATTERN_ERROR_CODES)[number];

/** A refusal by the pattern adapter: `code` is one of PATTERN_ERROR_CODES, each a catalog key. */
export class PatternError extends SentinelError<PatternErrorCode> {
  constructor(code: PatternErrorCode, message: string) {
    super(code, message);
    this.name = 'PatternError';
  }
}

/** Throws a PatternError with this code and message; it never returns. */
export const patternFail = (code: PatternErrorCode, message: string): never => {
  throw new PatternError(code, message);
};
