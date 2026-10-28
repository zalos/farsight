// The stable reason codes of rule packs, locks, trusted policy, adoption, receipts and admission. Each is a catalog
// key (core strings-sentinel-policy.ts); the message is safe context, never a settings value or a secret.
import { SentinelError } from '../kernel/errors.js';

/**
 * Why policy, a rule pack, a receipt or admission refused: each is a catalog key in core strings-sentinel-policy.ts.
 */
export const POLICY_ERROR_CODES = [
  'sentinel.rules.packUnreadable',
  'sentinel.rules.packUnsafe',
  'sentinel.rules.packChanged',
  'sentinel.rules.packTooLarge',
  'sentinel.rules.manifestInvalid',
  'sentinel.rules.fileMissing',
  'sentinel.rules.executableRule',
  'sentinel.rules.promotionUnauthorized',
  'sentinel.rules.lockInvalid',
  'sentinel.rules.familyConflict',
  'sentinel.rules.candidateInvalid',
  'sentinel.rules.packMissing',
  'sentinel.rules.packMismatch',
  'sentinel.rules.ruleNotLocked',
  'sentinel.policy.settingsUnreadable',
  'sentinel.policy.settingsInvalid',
  'sentinel.policy.credentialValue',
  'sentinel.policy.workspaceNotCanonical',
  'sentinel.policy.trustDirInsideWorkspace',
  'sentinel.policy.trustDirUnsafe',
  'sentinel.policy.adoptionUnauthorized',
  'sentinel.receipt.ownerOnly',
  'sentinel.receipt.unknown',
  'sentinel.receipt.expired',
  'sentinel.receipt.mismatch',
  'sentinel.receipt.alreadyUsed',
  'sentinel.receipt.ttlInvalid',
  'sentinel.receipt.storeUnsafe',
] as const;
/** One of {@link POLICY_ERROR_CODES}. */
export type PolicyErrorCode = (typeof POLICY_ERROR_CODES)[number];

/** Reason codes recorded on refused repository requests and on admission verdicts. */
export const POLICY_REASON_CODES = [
  'sentinel.policy.mandatoryRuleKept',
  'sentinel.policy.thresholdNotWeakened',
  'sentinel.policy.suppressionNotApproved',
  'sentinel.policy.providerNotTrusted',
  'sentinel.admission.granted',
  'sentinel.admission.noGrant',
  'sentinel.admission.ownerOnly',
  'sentinel.admission.budgetRequired',
  'sentinel.admission.budgetExceeded',
  'sentinel.admission.providerNotTrusted',
  'sentinel.admission.notAsked',
  'sentinel.admission.capabilityAvailable',
  'sentinel.admission.capabilityMissing',
  'sentinel.admission.credentialLocalOnly',
  'sentinel.admission.credentialScoped',
  'sentinel.admission.credentialDenied',
  'sentinel.admission.credentialUnknown',
] as const;
/** One of {@link POLICY_REASON_CODES}. */
export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

/** A refusal by policy, rules or admission: `code` is one of POLICY_ERROR_CODES, each a catalog key. */
export class PolicyError extends SentinelError<PolicyErrorCode> {
  constructor(code: PolicyErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, message, { cause: options?.cause });
    this.name = 'PolicyError';
  }
}

/** Throws a PolicyError with this code, message and cause; it never returns. */
export const policyFail = (code: PolicyErrorCode, message: string, cause?: unknown): never => {
  throw new PolicyError(code, message, cause === undefined ? undefined : { cause });
};
