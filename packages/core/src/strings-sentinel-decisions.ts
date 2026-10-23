import type { StringEntry } from './strings.js';

const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_DECISION_STRINGS: Record<string, StringEntry> = {
  'sentinel.decision.invalidInput': same('decision input is invalid', 'The proposed decision or its scope is malformed or outside supported bounds; nothing is applied.'),
  'sentinel.decision.corruptHistory': same('decision history could not be verified', 'The saved decision chain or its original owner confirmation does not validate. No approval is inferred from an incomplete history.'),
  'sentinel.decision.staleState': same('review the changed decision history', 'The saved decision history changed after confirmation, or the proposal is no longer current. Read and confirm the current state again.'),
  'sentinel.decision.notFound': same('decision was not found', 'The named proposal or earlier approved decision does not exist in this workspace history.'),
  'sentinel.decision.scopeExceeded': same('decision scope exceeds its limit', 'The proposal or saved history exceeds a supported bound. It is refused rather than partly applied.'),
  'sentinel.decision.unauthorized': same('owner approval could not be established', 'Approval needs a genuine consumed owner confirmation and a complete current decision history; copied fields grant no authority.'),
  'sentinel.decision.outcome.proposed': same('proposed', 'A decision has been suggested and saved, but has no owner approval.'),
  'sentinel.decision.outcome.denied': same('denied', 'Policy, capability or authority refused approval. Nothing was applied.'),
  'sentinel.decision.outcome.awaitingConfirmation': same('waiting for owner confirmation', 'Approval can proceed only after the owner confirms this exact decision, evidence and current state.'),
  'sentinel.decision.outcome.applied': same('applied', 'The owner confirmed this exact scoped decision and it was durably appended. Accepted risk remains visible and a claimed mitigation still needs verified evidence.'),
};
