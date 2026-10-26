// The Trivy adapter's reason codes (catalog: core strings-sentinel-trivy.ts).
export const TRIVY_ERROR_CODES = [
  'sentinel.trivy.targetInvalid',
  'sentinel.trivy.bundleInvalid',
  'sentinel.trivy.outputInvalid',
  'sentinel.trivy.acquisitionUnauthorized',
  'sentinel.trivy.acquisitionRefused',
  'sentinel.trivy.acquisitionFailed',
] as const;
export type TrivyErrorCode = (typeof TRIVY_ERROR_CODES)[number];

export class TrivyError extends Error {
  constructor(
    readonly code: TrivyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TrivyError';
  }
}

export const trivyFail = (code: TrivyErrorCode, message: string): never => {
  throw new TrivyError(code, message);
};
