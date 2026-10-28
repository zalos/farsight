// Why the Next pack refused its inputs. Every limitation of the supported subset is a frontier or an unknown fact,
// never an error; these two codes are for inputs that are inconsistent or bytes that are not what was captured.
// Each is a catalog key in packages/core/src/strings-sentinel-next.ts.
import { sentinelNextWord } from '@farsight/core/dist/strings-sentinel-next.js';
import { SentinelError } from '../../kernel/errors.js';

/** Why the Next pack refused its inputs: each is a catalog key in core strings-sentinel-next.ts. */
export const NEXT_ERROR_CODES = Object.freeze(['sentinel.next.invalidInput', 'sentinel.next.integrity'] as const);
/** One of {@link NEXT_ERROR_CODES}. */
export type NextErrorCode = (typeof NEXT_ERROR_CODES)[number];

/** The Next pack refused inconsistent inputs or bytes that are not what was captured; the message is the catalog's. */
export class NextPackError extends SentinelError<NextErrorCode> {
  constructor(code: NextErrorCode, detail = '') {
    super(code, sentinelNextWord(code, { detail }));
    this.name = 'NextPackError';
  }
}
