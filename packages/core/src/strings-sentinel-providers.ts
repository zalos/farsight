import type { StringEntry } from './strings.js';

// Sentinel's model providers (PR 21): why a model call was refused before it was sent, or failed after, and the
// states of a budget reservation. Each key is the stable code a ProviderError or a reservation carries. Both
// registers carry the same words until the PR 09 vocabulary freeze, as in strings-sentinel-parser.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_PROVIDER_STRINGS: Record<string, StringEntry> = {
  // ---- refused before anything is sent ----
  'sentinel.provider.invalidProfile': same('the model profile is not valid: {detail}', 'A model profile names one trusted provider, the model to ask for, its limits and how it is priced. One that is incomplete or out of bounds is refused before any provider is contacted.'),
  'sentinel.provider.notTrusted': same('the adopted settings do not define this provider: {detail}', 'Only a provider in the settings the owner adopted can be used, with the kind, address and disclosure written there. A repository or a request cannot name another one.'),
  'sentinel.provider.originRefused': same('this provider address is not allowed: {detail}', 'A provider that keeps source on this machine must be a loopback address. One that sends context elsewhere must use an encrypted connection. Anything else is refused before it is contacted.'),
  'sentinel.provider.termsRequired': same('a hosted provider needs its recorded terms: {detail}', 'Sending context off this machine needs the provider\'s retention and training terms, where they were read and when, recorded by the owner. Without them nothing is sent.'),
  'sentinel.provider.unpriced': same('this provider has no trusted price, so its spend cannot be bounded: {detail}', 'A budget in money can only be enforced with a rate schedule the owner trusts. A provider without one is unavailable, unless it runs on this machine and charges no fee.'),
  'sentinel.provider.capabilityUntested': same('this provider has not been tested for the model asked for: {detail}', 'Compatibility is checked for each address and model: a recorded check that this address offers this model. Without one that matches, no call is made.'),
  'sentinel.provider.capabilityMissing': same('the provider does not offer the model asked for: {detail}', 'The capability check asked the provider which models it offers, and this one was not listed.'),
  'sentinel.provider.featureDisabled': same('hosted model review is paused: {detail}', 'The owner setting for hosted model review is off or absent. A public scan sends no hosted model request in this state. Its configured choice remains recorded; no other provider or local model is substituted.'),
  'sentinel.provider.notAdmitted': same('the model call was not admitted: {detail}', 'Every model budget is decided by the policy, the provider\'s capability and its credential authority together. A denied request, or one still waiting for the owner, sends nothing.'),
  'sentinel.provider.receiptRequired': same('this model use needs the owner\'s confirmation: {detail}', 'Paying for inference or sending context off this machine needs a confirmation the owner gave for this exact provider, address, credential, disclosure and budget.'),
  'sentinel.provider.bindingChanged': same('the provider changed since its budget was approved: {detail}', 'The approval names the provider\'s exact address, credential, disclosure, model, limits and price. Any change needs a new approval.'),
  'sentinel.provider.budgetExhausted': same('this call would go past the approved budget: {detail}', 'Each call reserves its worst case before it is sent: the most input it could be counted as, the most output it may return, and their price. A call that does not fit is not sent. Going further needs the owner to approve a new budget.'),
  'sentinel.provider.envelopeOverdrawn': same('the approved budget was overrun, so no more calls are made: {detail}', 'A provider reported more than was reserved for a call. The overrun is recorded in full, never hidden, and the budget takes no further calls until the owner approves a new one.'),
  'sentinel.provider.contextExceeded': same('the request is larger than the model\'s context: {detail}', 'The worst-case input plus the output allowance does not fit the context the profile gives this model, so the provider could cut the input silently. It is not sent.'),
  'sentinel.provider.requestTooLarge': same('the request is larger than the profile allows: {detail}', 'The serialized request, every message included, is over the profile\'s byte limit. It is not sent.'),
  // ---- failed after the request may have reached the provider ----
  'sentinel.provider.responseTooLarge': same('the provider\'s answer was larger than the profile allows: {detail}', 'Reading stopped at the byte limit and the answer was discarded. The provider may have done and charged for the work, so the reservation stays held until its usage is reconciled.'),
  'sentinel.provider.redirectRefused': same('the provider tried to send the request somewhere else: {detail}', 'A redirect is never followed: the request goes only to the approved address. Nothing is sent to the new one.'),
  'sentinel.provider.httpStatus': same('the provider answered with an error status: {detail}', 'The provider refused or failed the request. Its own error text is not kept, because it can echo what was sent.'),
  'sentinel.provider.malformedResponse': same('the provider\'s answer is not in the expected form: {detail}', 'The answer could not be read as this provider kind\'s reply. Nothing in it is used.'),
  'sentinel.provider.identityMalformed': same('the provider did not say which model answered: {detail}', 'Each answer must name the model that produced it. One that names none, or not as text, is not used.'),
  'sentinel.provider.identityMismatch': same('another model answered than the one asked for: {detail}', 'The provider named a different model from the one approved. The answer is not used; its usage is still recorded.'),
  'sentinel.provider.timeout': same('the provider did not answer in time: {detail}', 'The call was abandoned at its deadline. Stopping waiting does not prove the provider stopped working or billing, so the reservation stays held until its usage is reconciled.'),
  'sentinel.provider.canceled': same('the call was canceled: {detail}', 'The call was stopped on request. If it had already been sent, its reservation stays held until its usage is reconciled.'),
  'sentinel.provider.unreachable': same('the provider could not be reached: {detail}', 'No connection was made, so nothing was sent and the reservation is released.'),
  'sentinel.provider.credentialUnavailable': same('the provider\'s credential could not be read: {detail}', 'The credential is read from the system keychain, in this process, only for the address it was approved for. It is never printed. Without it nothing is sent.'),
  // ---- the budget ledger ----
  'sentinel.provider.operationConflict': same('this operation already reserved a different amount: {detail}', 'An operation reserves once. Asking again with the same id and the same amount returns the first reservation; another amount is refused.'),
  'sentinel.provider.reservationState': same('the reservation cannot move that way: {detail}', 'A reservation is held, then sent, then settled with its usage. A sent reservation is never released; one whose usage is unknown stays held until the owner reconciles it.'),
  'sentinel.provider.ledgerInvalid': same('the budget ledger cannot be used: {detail}', 'The ledger keeps every reservation durably, so concurrent calls share one budget across processes and a restart cannot forget a call that may have been charged.'),
  'sentinel.provider.epochFenced': same('this work belongs to a newer coordinator now: {detail}', 'After a restart, recovery fences the earlier coordinator\'s epoch: a process still running under it cannot reserve budget, send a call or save a review checkpoint, so two owners never spend or write for one session.'),
  // ---- reservation states ----
  'sentinel.reservation.held': same('reserved, not sent', 'The worst case of a call is set aside in the budget; nothing has been sent.'),
  'sentinel.reservation.dispatched': same('sent, usage not yet known', 'The request may have reached the provider. The reservation stays set aside until its usage is known.'),
  'sentinel.reservation.settled': same('settled', 'The provider reported the usage, and the call is charged at what it used.'),
  'sentinel.reservation.uncertain': same('usage unknown, still reserved', 'The call may have been charged, but its usage was not reported. Its whole reservation stays charged against the budget until the owner reconciles it.'),
  'sentinel.reservation.released': same('released, never sent', 'The call was not sent, so its reservation was returned to the budget.'),
};

export function sentinelProviderWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_PROVIDER_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
