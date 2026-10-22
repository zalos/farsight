// Why a model call was refused or failed. Each code is a catalog key in packages/core/src/strings-sentinel-providers.ts.
// `spend` says whether the request may have reached the provider: `possible` keeps its reservation held as
// uncertain, never released, because a failed or abandoned call does not prove a provider stopped computing or billing.
import { sentinelProviderWord } from '@farsight/core/dist/strings-sentinel-providers.js';

export const PROVIDER_ERROR_CODES = Object.freeze([
  'sentinel.provider.invalidProfile', 'sentinel.provider.notTrusted', 'sentinel.provider.originRefused',
  'sentinel.provider.termsRequired', 'sentinel.provider.unpriced', 'sentinel.provider.capabilityUntested',
  'sentinel.provider.capabilityMissing', 'sentinel.provider.notAdmitted', 'sentinel.provider.receiptRequired',
  'sentinel.provider.bindingChanged', 'sentinel.provider.budgetExhausted', 'sentinel.provider.envelopeOverdrawn',
  'sentinel.provider.contextExceeded', 'sentinel.provider.requestTooLarge', 'sentinel.provider.responseTooLarge',
  'sentinel.provider.redirectRefused', 'sentinel.provider.httpStatus', 'sentinel.provider.malformedResponse',
  'sentinel.provider.identityMalformed', 'sentinel.provider.identityMismatch', 'sentinel.provider.timeout',
  'sentinel.provider.canceled', 'sentinel.provider.unreachable', 'sentinel.provider.credentialUnavailable',
  'sentinel.provider.operationConflict', 'sentinel.provider.reservationState', 'sentinel.provider.ledgerInvalid',
] as const);
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number];

export type Spend = 'none' | 'possible';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly spend: Spend;
  /** `detail` must never hold a credential, a request or response body, or a provider's own error text. */
  constructor(code: ProviderErrorCode, detail = '', spend: Spend = 'none') {
    super(sentinelProviderWord(code, { detail }));
    this.name = 'ProviderError';
    this.code = code;
    this.spend = spend;
  }
}

export const fail = (code: ProviderErrorCode, detail = '', spend: Spend = 'none'): never => { throw new ProviderError(code, detail, spend); };
