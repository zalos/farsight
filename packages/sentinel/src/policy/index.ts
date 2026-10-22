// Trusted policy (PR 06, ADR 23): settings and repository intent, the effective policy and its redacted view, owner
// adoption, receipts and three-verdict admission. Receipt issuing is deliberately absent: only the owner CLI flow
// inside this package issues one, so no agent-facing surface can import a way to mint a human confirmation.
export { DEFAULT_SETTINGS, MAX_SETTINGS_BYTES, parseSettings, parseRepoConfig, effectivePolicy, isEffectivePolicy } from './settings.js';
export type { EffectivePolicy, PolicyInputs } from './settings.js';
export { SETTINGS_PATH, REPO_CONFIG_PATH, trustDirectory, workspaceIdentity, adoptionIntent, adoptSettings, loadPolicyInputs } from './adoption.js';
export type { WorkspaceIdentity } from './adoption.js';
export { ReceiptBook, intentDigest, isConsumedReceipt } from './receipts.js';
export type { ConsumedReceipt, ReceiptBinding } from './receipts.js';
export { admit, compareDecimal } from './admission.js';
export type { AdmissionRequest, AdmissionResult, CapabilityAnswer, CredentialAnswer } from './admission.js';
export { PolicyError, POLICY_ERROR_CODES, POLICY_REASON_CODES } from './errors.js';
export type { PolicyErrorCode, PolicyReasonCode } from './errors.js';
