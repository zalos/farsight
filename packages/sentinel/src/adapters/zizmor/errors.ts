// The zizmor adapter's reason codes (catalog: core strings-sentinel-zizmor.ts).
export const ZIZMOR_ERROR_CODES = ['sentinel.zizmor.targetInvalid', 'sentinel.zizmor.outputInvalid'] as const;
export type ZizmorErrorCode = typeof ZIZMOR_ERROR_CODES[number];

export class ZizmorError extends Error {
  constructor(readonly code: ZizmorErrorCode, message: string) {
    super(message);
    this.name = 'ZizmorError';
  }
}

export const zizmorFail = (code: ZizmorErrorCode, message: string): never => { throw new ZizmorError(code, message); };
