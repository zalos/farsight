// The pattern adapter's reason codes (catalog: core strings-sentinel-pattern.ts).
export const PATTERN_ERROR_CODES = [
  'sentinel.pattern.ruleInvalid',
  'sentinel.pattern.targetInvalid',
  'sentinel.pattern.outputInvalid',
] as const;
export type PatternErrorCode = (typeof PATTERN_ERROR_CODES)[number];

export class PatternError extends Error {
  constructor(
    readonly code: PatternErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PatternError';
  }
}

export const patternFail = (code: PatternErrorCode, message: string): never => {
  throw new PatternError(code, message);
};
