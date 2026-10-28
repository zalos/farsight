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
  ActionIntent,
  AdmissionEnvelope,
  AdmissionVerdict,
  CredentialVerdict,
  DecisionChannel,
  Principal,
  SentinelGrant,
} from '../contracts/index.js';
import { OWNER_ACTIONS } from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import { policyFail, type PolicyReasonCode } from './errors.js';
import { snapshot } from './immutable.js';
import { intentDigest, type ReceiptBook, type ConsumedReceipt } from './receipts.js';
import { assertOwnerUiProof, type OwnerUiProof } from '../owner-ui/authority.js';
import type { OwnerUiReceiptBook } from '../owner-ui/receipts.js';
import type { OwnerUiReceiptEnvelope } from '../contracts/ownerui.js';
import { isEffectivePolicy, type EffectivePolicy } from './settings.js';

/** The adapter's answer for verdict 2. */
export interface CapabilityAnswer {
  available: boolean;
  detail: string;
}

/** The adapter's answer for verdict 3. */
export type CredentialAnswer =
  | { basis: 'local-only'; detail: string }
  | { basis: 'keychain-scope'; allowed: boolean; detail: string }
  | { basis: 'unknown'; detail: string };

/** One action to admit: its intent, who asked on which channel, the effective policy and the two lazy checks. */
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

/** An admission decision: the recorded envelope with its three verdicts, and the receipt it spent, if any. */
export interface AdmissionResult {
  readonly record: AdmissionEnvelope;
  /** The spent receipt when one admitted the action. */
  readonly receipt: ConsumedReceipt | null;
}

const OWNER: ReadonlySet<string> = new Set(OWNER_ACTIONS);
const stamp = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
const verdict = (allowed: boolean, reasonCode: PolicyReasonCode, detail: string): AdmissionVerdict => ({
  allowed,
  asked: true,
  reasonCode,
  detail: detail.slice(0, 4000),
});
const NOT_ASKED: AdmissionVerdict = {
  allowed: false,
  asked: false,
  reasonCode: 'sentinel.admission.notAsked',
  detail: 'not asked: the policy denied first',
};

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
  const provider = providerId === null ? undefined : policy.settings.providers.find((p) => p.id === providerId);
  if (providerId !== null && !provider)
    return ['sentinel.admission.providerNotTrusted', 'the adopted settings define no such provider'];
  const paid = intent.effects.includes('paid-inference');
  const discloses = intent.effects.includes('source-disclosure');
  if ((paid || discloses) && !provider)
    return ['sentinel.admission.providerNotTrusted', 'a paid or disclosing action names a trusted provider'];
  if (paid && provider) {
    const b = intent.budget;
    const cap = provider.budget;
    // Only the explicitly adopted closed CLI subscription profile accounts in tokens with money unobserved.
    // A monetary or unconfigured provider cannot use null money to bypass its bound.
    if (
      ((provider.kind === 'claude-cli' && provider.nativeProfile) ||
        (provider.kind === 'copilot-cli' && provider.copilotProfile)) &&
      provider.models?.length &&
      provider.models.every(
        (m) => m.pricing.kind === 'subscription-quota' && m.pricing.basis === 'owner-subscription',
      ) &&
      cap.maxTokens !== null &&
      cap.maxCost === null &&
      cap.currency === null
    ) {
      if (b.maxTokens === null || b.maxCost !== null || b.currency !== null)
        return [
          'sentinel.admission.budgetRequired',
          'a subscription action states its token quota with monetary consumption unobserved',
        ];
      return b.maxTokens > cap.maxTokens
        ? ['sentinel.admission.budgetExceeded', 'the intent exceeds the adopted token quota']
        : null;
    }
    if (b.maxTokens === null || b.maxCost === null || b.currency === null)
      return ['sentinel.admission.budgetRequired', 'a paid action states its token and cost bounds'];
    if (cap.maxTokens === null || cap.maxCost === null || cap.currency === null)
      return ['sentinel.admission.budgetExceeded', 'the provider has no budget in the adopted settings'];
    if (b.currency !== cap.currency || b.maxTokens > cap.maxTokens || compareDecimal(b.maxCost, cap.maxCost) > 0) {
      return ['sentinel.admission.budgetExceeded', 'the intent reserves more than the provider’s budget allows'];
    }
  }
  return null;
}

function grantMiss(g: SentinelGrant, intent: ActionIntent): string | null {
  const s = g.scope;
  if (!s) return null;
  if (s.profiles && (intent.scope.profile === null || !s.profiles.includes(intent.scope.profile)))
    return 'the grant does not cover this profile';
  if (s.providers && (intent.scope.provider === null || !s.providers.includes(intent.scope.provider)))
    return 'the grant does not cover this provider';
  if (s.effects && intent.effects.some((e) => !s.effects!.includes(e)))
    return 'the grant does not permit every effect of this action';
  return null;
}

/**
 * Decides one action: the policy verdict first, then, only when it allows, the capability and credential checks.
 * The record says `admitted` when all three allow and, if the action needs confirmation, the given receipt is spent;
 * `awaiting-confirmation` when all three allow and it needs a receipt none was given for; `denied` otherwise. It
 * carries every verdict and its reason.
 *
 * Throws a PolicyError:
 * - `sentinel.policy.settingsInvalid`: the policy is not one effectivePolicy produced;
 * - while spending a receipt, `sentinel.receipt.unknown` (no valid receipt with this id in the book),
 *   `sentinel.receipt.expired`, `sentinel.receipt.mismatch` (another action or intent, another state or policy
 *   revision, or issued in the future), `sentinel.receipt.alreadyUsed` or `sentinel.receipt.storeUnsafe` (the receipt
 *   folder is not private).
 *
 * An intent that is not canonical JSON throws the object store's `sentinel.object.notCanonical`, and whatever
 * `capability` or `credential` throws passes through unchanged.
 */
export function admit(req: AdmissionRequest): AdmissionResult {
  return decideAdmission(req, false);
}

/** Package-internal stricter path for a service acting on an owner's real receipt. It only adds a requirement;
 * ordinary admit and its public facade remain unchanged. No request JSON can set this internal choice. */
export function admitRequiringReceipt(req: AdmissionRequest): AdmissionResult {
  return decideAdmission(req, true);
}

type DecisionRequest<R> = Omit<AdmissionRequest, 'receipt'> & {
  receipt?: {
    book: {
      consume(id: string, binding: { intent: ActionIntent; stateDigest: string; policyRevision: string }, now: Date): R;
    };
    id: string;
  };
};
/** Only the closed private UI receipt/proof may choose this provenance; no public JSON flag exists. */
export function admitOwnerUi(
  req: Omit<AdmissionRequest, 'receipt'> & { receipt?: { book: OwnerUiReceiptBook; id: string } },
  proof: OwnerUiProof,
  required: boolean,
) {
  assertOwnerUiProof(proof, req.intent.action);
  if (req.requestedBy.channel !== 'owner-ui' || req.requestedBy.principal !== 'human')
    policyFail('sentinel.receipt.ownerOnly', 'not a genuine browser owner confirmation');
  return decideAdmission<ConsumedReceipt<OwnerUiReceiptEnvelope>>(req, required);
}
function decideAdmission<R extends { readonly digest: string } = ConsumedReceipt>(
  req: DecisionRequest<R>,
  requireReceipt: boolean,
): { readonly record: AdmissionEnvelope; readonly receipt: R | null } {
  const { policy } = req;
  if (!isEffectivePolicy(policy))
    policyFail('sentinel.policy.settingsInvalid', 'admission decides only under effectivePolicy’s own result');
  // The exact request decided on: a private frozen copy, so the caller cannot change it between verdicts.
  const intent = snapshot(req.intent);
  const requestedBy = snapshot(req.requestedBy);
  const stateDigest = req.stateDigest;
  const digest = intentDigest(intent);
  let policyVerdict: AdmissionVerdict;
  let requiresConfirmation = requireReceipt;
  const owner = OWNER.has(intent.action);
  if (owner && (requestedBy.principal !== 'human' || requestedBy.channel !== 'owner-cli')) {
    policyVerdict = verdict(
      false,
      'sentinel.admission.ownerOnly',
      'only the owner, through the local CLI, may take this action',
    );
  } else {
    const bounds = boundsMiss(intent, policy);
    if (bounds) {
      policyVerdict = verdict(false, bounds[0], bounds[1]);
    } else {
      const d = decideGrants(policy.settings.grants, intent.action, requestedBy.principal, {
        agentWrites: policy.settings.agentActions === 'allow' ? 'allow' : 'confirm',
        miss: (g) => grantMiss(g, intent),
      });
      policyVerdict = verdict(
        d.verdict.allowed,
        d.verdict.allowed ? 'sentinel.admission.granted' : 'sentinel.admission.noGrant',
        d.verdict.reason,
      );
      requiresConfirmation = requireReceipt || d.requiresConfirmation || owner;
    }
  }

  let capability = NOT_ASKED;
  let credential: CredentialVerdict = { ...NOT_ASKED, basis: 'not-asked' };
  if (policyVerdict.allowed) {
    const c = req.capability();
    capability = verdict(
      c.available,
      c.available ? 'sentinel.admission.capabilityAvailable' : 'sentinel.admission.capabilityMissing',
      c.detail,
    );
    const k = req.credential();
    credential =
      k.basis === 'local-only'
        ? { ...verdict(true, 'sentinel.admission.credentialLocalOnly', k.detail), basis: 'local-only' }
        : k.basis === 'keychain-scope'
          ? {
              ...verdict(
                k.allowed,
                k.allowed ? 'sentinel.admission.credentialScoped' : 'sentinel.admission.credentialDenied',
                k.detail,
              ),
              basis: 'keychain-scope',
            }
          : { ...verdict(false, 'sentinel.admission.credentialUnknown', k.detail), basis: 'unknown' };
  }

  const allowed = policyVerdict.allowed && capability.allowed && credential.allowed;
  let spent: R | null = null;
  let outcome: AdmissionEnvelope['outcome'] = allowed ? 'admitted' : 'denied';
  if (allowed && requiresConfirmation) {
    if (req.receipt) {
      spent = req.receipt.book.consume(
        req.receipt.id,
        { intent, stateDigest, policyRevision: policy.revision },
        req.now,
      );
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
  if (!checked.ok)
    throw new Error(`sentinel.contract.invariant: ${checked.errors[0]?.path} ${checked.errors[0]?.message}`);
  return Object.freeze({ record: snapshot(record), receipt: spent });
}
