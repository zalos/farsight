// The OSV adapter's reason codes (catalog: core strings-sentinel-osv.ts).
import { SentinelError } from '../../kernel/errors.js';
/** Why the OSV adapter refused: each is a catalog key in core strings-sentinel-osv.ts. */
export const OSV_ERROR_CODES = [
  'sentinel.osv.targetInvalid',
  'sentinel.osv.snapshotInvalid',
  'sentinel.osv.outputInvalid',
  'sentinel.osv.acquisitionUnauthorized',
  'sentinel.osv.acquisitionRefused',
  'sentinel.osv.acquisitionFailed',
] as const;
/** One of {@link OSV_ERROR_CODES}. */
export type OsvErrorCode = (typeof OSV_ERROR_CODES)[number];

/** A refusal by the OSV adapter: `code` is one of OSV_ERROR_CODES, each a catalog key. */
export class OsvError extends SentinelError<OsvErrorCode> {
  constructor(code: OsvErrorCode, message: string) {
    super(code, message);
    this.name = 'OsvError';
  }
}

/** Throws a OsvError with this code and message; it never returns. */
export const osvFail = (code: OsvErrorCode, message: string): never => {
  throw new OsvError(code, message);
};
