// Why the Next pack refused its inputs. Every limitation of the supported subset is a frontier or an unknown fact,
// never an error; these two codes are for inputs that are inconsistent or bytes that are not what was captured.
// Each is a catalog key in packages/core/src/strings-sentinel-next.ts.
import { sentinelNextWord } from '@farsight/core/dist/strings-sentinel-next.js';

export const NEXT_ERROR_CODES = Object.freeze(['sentinel.next.invalidInput', 'sentinel.next.integrity'] as const);
export type NextErrorCode = typeof NEXT_ERROR_CODES[number];

export class NextPackError extends Error {
  readonly code: NextErrorCode;
  constructor(code: NextErrorCode, detail = '') {
    super(sentinelNextWord(code, { detail }));
    this.name = 'NextPackError';
    this.code = code;
  }
}
