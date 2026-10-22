// Admission: three verdicts, ANDed, for one exact intent.
//   1. policy — the effective policy's grants through core's shared matcher (`decideGrants`, ADR 20), plus the
//      owner-action rule and the budget/provider bounds of the intent;
//   2. capability — the adapter's own answer that it can perform this action now;
//   3. credential authority — how authority is established: a keychain scope the adapter checked, or an explicit
//      local-only reason when no remote credential is needed. An unknown scope denies.
// Nothing after the policy is asked when the policy denies, so a denied action contacts no provider. An allowed
// action that needs confirmation waits for the owner unless a receipt for exactly this intent is spent here.
import { decideGrants } from '@farsight/core/dist/grants.js';
import type {
  ActionIntent, AdmissionEnvelope, AdmissionVerdict, CredentialVerdict, DecisionChannel, Principal, SentinelGrant,
} from '../contracts/index.js';
import { OWNER_ACTIONS } from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import type { PolicyReasonCode } from './errors.js';
import { intentDigest, type ReceiptBook, type ConsumedReceipt } from './receipts.js';
import type { EffectivePolicy } from './settings.js';

/** The adapter's answer for verdict 2. */
export interface CapabilityAnswer { available: boolean; detail: string }

/** The adapter's answer for verdict 3. */
export type CredentialAnswer =
  | { basis: 'local-only'; detail: string }
  | { basis: 'keychain-scope'; allowed: boolean; detail: string }
  | { basis: 'unknown'; detail: string };

export interface AdmissionRequest {
  intent: ActionIntent;
  /** Set by the transport the request arrived on, never by the request body. */
  requestedBy: { principal: Principal; channel: DecisionChannel };
  policy: EffectivePolicy;
  /** Asked only after the policy allows. */
  capability: () => CapabilityAnswer;
  /** Asked only after the policy allows. */
  credential: () => CredentialAnswer;
  /** The state the intent was decided against (a plan revision, a candidate digest); a receipt binds to it. */
  stateDigest: string;
  /** A receipt the owner issued for this intent, spent here only when all three verdicts allow. */
  receipt?: { book: ReceiptBook; id: string };
  now: Date;
}

export interface AdmissionResult {
  readonly record: AdmissionEnvelope;
  /** The spent receipt when one admitted the action. */
  readonly receipt: ConsumedReceipt | null;
}

const OWNER: ReadonlySet<string> = new Set(OWNER_ACTIONS);
const stamp = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
const verdict = (allowed: boolean, reasonCode: PolicyReasonCode, detail: string): AdmissionVerdict =>
  ({ allowed, asked: true, reasonCode, detail: detail.slice(0, 4000) });
const NOT_ASKED: AdmissionVerdict = { allowed: false, asked: false, reasonCode: 'sentinel.admission.notAsked', detail: 'not asked: the policy denied first' };

/** Compares two decimal amounts exactly, as strings: never through binary floats. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const [ai = '', af = ''] = a.split('.');
  const [bi = '', bf = ''] = b.split('.');
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const x = ai + af.padEnd(width, '0');
  const y = bi + bf.padEnd(width, '0');
  return x === y ? 0 : x < y ? -1 : 1;
}

/** Why the intent exceeds what a grant or the trusted provider permits, or null. */
function boundsMiss(intent: ActionIntent, policy: EffectivePolicy): [PolicyReasonCode, string] | null {
  const providerId = intent.scope.provider;
  const provider = providerId === null ? undefined : policy.settings.providers.find(p => p.id === providerId);
  if (providerId !== null && !provider) return ['sentinel.admission.providerNotTrusted', 'the adopted settings define no such provider'];
  const paid = intent.effects.includes('paid-inference');
  const discloses = intent.effects.includes('source-disclosure');
  if ((paid || discloses) && !provider) return ['sentinel.admission.providerNotTrusted', 'a paid or disclosing action names a trusted provider'];
  if (paid && provider) {
    const b = intent.budget;
    if (b.maxTokens === null || b.maxCost === null || b.currency === null) return ['sentinel.admission.budgetRequired', 'a paid action states its token and cost bounds'];
    const cap = provider.budget;
    if (cap.maxTokens === null || cap.maxCost === null || cap.currency === null) return ['sentinel.admission.budgetExceeded', 'the provider has no budget in the adopted settings'];
    if (b.currency !== cap.currency || b.maxTokens > cap.maxTokens || compareDecimal(b.maxCost, cap.maxCost) > 0) {
      return ['sentinel.admission.budgetExceeded', 'the intent reserves more than the provider’s budget allows'];
    }
  }
  return null;
}

function grantMiss(g: SentinelGrant, intent: ActionIntent): string | null {
  const s = g.scope;
  if (!s) return null;
  if (s.profiles && (intent.scope.profile === null || !s.profiles.includes(intent.scope.profile))) return 'the grant does not cover this profile';
  if (s.providers && (intent.scope.provider === null || !s.providers.includes(intent.scope.provider))) return 'the grant does not cover this provider';
  if (s.effects && intent.effects.some(e => !s.effects!.includes(e))) return 'the grant does not permit every effect of this action';
  return null;
}

export function admit(req: AdmissionRequest): AdmissionResult {
  const { intent, requestedBy, policy } = req;
  const digest = intentDigest(intent);
  let policyVerdict: AdmissionVerdict;
  let requiresConfirmation = false;
  const owner = OWNER.has(intent.action);
  if (owner && (requestedBy.principal !== 'human' || requestedBy.channel !== 'owner-cli')) {
    policyVerdict = verdict(false, 'sentinel.admission.ownerOnly', 'only the owner, through the local CLI, may take this action');
  } else {
    const bounds = boundsMiss(intent, policy);
    if (bounds) {
      policyVerdict = verdict(false, bounds[0], bounds[1]);
    } else {
      const d = decideGrants(policy.settings.grants, intent.action, requestedBy.principal, {
        agentWrites: policy.settings.agentActions === 'allow' ? 'allow' : 'confirm',
        miss: g => grantMiss(g, intent),
      });
      policyVerdict = verdict(d.verdict.allowed, d.verdict.allowed ? 'sentinel.admission.granted' : 'sentinel.admission.noGrant', d.verdict.reason);
      requiresConfirmation = d.requiresConfirmation || owner;
    }
  }

  let capability = NOT_ASKED;
  let credential: CredentialVerdict = { ...NOT_ASKED, basis: 'not-asked' };
  if (policyVerdict.allowed) {
    const c = req.capability();
    capability = verdict(c.available, c.available ? 'sentinel.admission.capabilityAvailable' : 'sentinel.admission.capabilityMissing', c.detail);
    const k = req.credential();
    credential = k.basis === 'local-only'
      ? { ...verdict(true, 'sentinel.admission.credentialLocalOnly', k.detail), basis: 'local-only' }
      : k.basis === 'keychain-scope'
        ? { ...verdict(k.allowed, k.allowed ? 'sentinel.admission.credentialScoped' : 'sentinel.admission.credentialDenied', k.detail), basis: 'keychain-scope' }
        : { ...verdict(false, 'sentinel.admission.credentialUnknown', k.detail), basis: 'unknown' };
  }

  const allowed = policyVerdict.allowed && capability.allowed && credential.allowed;
  let spent: ConsumedReceipt | null = null;
  let outcome: AdmissionEnvelope['outcome'] = allowed ? 'admitted' : 'denied';
  if (allowed && requiresConfirmation) {
    if (req.receipt) {
      spent = req.receipt.book.consume(req.receipt.id, { intent, stateDigest: req.stateDigest, policyRevision: policy.revision }, req.now);
    } else {
      outcome = 'awaiting-confirmation';
    }
  }
  const record: AdmissionEnvelope = {
    schema: 'sentinel-admission/draft-1',
    action: intent.action,
    intentDigest: digest,
    requestedBy: { ...requestedBy },
    policyRevision: policy.revision,
    verdicts: { policy: policyVerdict, capability, credential },
    outcome,
    receipt: spent ? spent.digest : null,
    decidedAt: stamp(req.now),
  };
  const checked = validateEnvelope('admission', record);
  if (!checked.ok) throw new Error(`sentinel.contract.invariant: ${checked.errors[0]?.path} ${checked.errors[0]?.message}`);
  return Object.freeze({ record: Object.freeze(record), receipt: spent });
}
