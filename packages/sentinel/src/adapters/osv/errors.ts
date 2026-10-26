// The OSV adapter's reason codes (catalog: core strings-sentinel-osv.ts).
export const OSV_ERROR_CODES = [
  'sentinel.osv.targetInvalid',
  'sentinel.osv.snapshotInvalid',
  'sentinel.osv.outputInvalid',
  'sentinel.osv.acquisitionUnauthorized',
  'sentinel.osv.acquisitionRefused',
  'sentinel.osv.acquisitionFailed',
] as const;
export type OsvErrorCode = (typeof OSV_ERROR_CODES)[number];

export class OsvError extends Error {
  constructor(
    readonly code: OsvErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OsvError';
  }
}

export const osvFail = (code: OsvErrorCode, message: string): never => {
  throw new OsvError(code, message);
};
