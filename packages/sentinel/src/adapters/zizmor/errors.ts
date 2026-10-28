// The zizmor adapter's reason codes (catalog: core strings-sentinel-zizmor.ts).
import { SentinelError } from '../../kernel/errors.js';
/** Why the zizmor adapter refused: each is a catalog key in core strings-sentinel-zizmor.ts. */
export const ZIZMOR_ERROR_CODES = ['sentinel.zizmor.targetInvalid', 'sentinel.zizmor.outputInvalid'] as const;
/** One of {@link ZIZMOR_ERROR_CODES}. */
export type ZizmorErrorCode = (typeof ZIZMOR_ERROR_CODES)[number];

/** A refusal by the zizmor adapter: `code` is one of ZIZMOR_ERROR_CODES, each a catalog key. */
export class ZizmorError extends SentinelError<ZizmorErrorCode> {
  constructor(code: ZizmorErrorCode, message: string) {
    super(code, message);
    this.name = 'ZizmorError';
  }
}

/** Throws a ZizmorError with this code and message; it never returns. */
export const zizmorFail = (code: ZizmorErrorCode, message: string): never => {
  throw new ZizmorError(code, message);
};
