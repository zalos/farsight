// The Trivy adapter's reason codes (catalog: core strings-sentinel-trivy.ts).
import { SentinelError } from '../../kernel/errors.js';
/** Why the Trivy adapter refused: each is a catalog key in core strings-sentinel-trivy.ts. */
export const TRIVY_ERROR_CODES = [
  'sentinel.trivy.targetInvalid',
  'sentinel.trivy.bundleInvalid',
  'sentinel.trivy.outputInvalid',
  'sentinel.trivy.acquisitionUnauthorized',
  'sentinel.trivy.acquisitionRefused',
  'sentinel.trivy.acquisitionFailed',
] as const;
/** One of {@link TRIVY_ERROR_CODES}. */
export type TrivyErrorCode = (typeof TRIVY_ERROR_CODES)[number];

/** A refusal by the Trivy adapter: `code` is one of TRIVY_ERROR_CODES, each a catalog key. */
export class TrivyError extends SentinelError<TrivyErrorCode> {
  constructor(code: TrivyErrorCode, message: string) {
    super(code, message);
    this.name = 'TrivyError';
  }
}

/** Throws a TrivyError with this code and message; it never returns. */
export const trivyFail = (code: TrivyErrorCode, message: string): never => {
  throw new TrivyError(code, message);
};
