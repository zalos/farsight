// An append-only private owner journal. A numbered create-once file is the compare-and-swap point; concurrent
// approvals cannot overwrite or silently rebase the state the owner confirmed. Losing a race can spend a receipt,
// but cannot apply a different decision. A new confirmation is required after any state change.
import { randomUUID } from 'node:crypto';
import { closeSync, constants as FS, fsyncSync, openSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ActionIntent,
  AdmissionEnvelope,
  ApprovedDisposition,
  DecisionChannel,
  ProposedDisposition,
} from '../contracts/index.js';
import { admit } from '../policy/admission.js';
import { canonicalDigest } from '../policy/digest.js';
import { snapshot } from '../policy/immutable.js';
import { ReceiptBook, STORE, intentDigest, receiptAuthority, stamp, type ReceiptBinding } from '../policy/receipts.js';
import type { EffectivePolicy } from '../policy/settings.js';
import { createPrivateFileOnce, ensurePrivateDir, readPrivateFile } from '../policy/user-state.js';
import { compareTimestamps, validateEnvelope } from '../validate.js';
import { checkedAssertions, type DeploymentAssertion } from './assertions.js';
import {
  checkedBasis,
  fail,
  fields,
  list,
  timestamp,
  unique,
  validDigest,
  validId,
  validNode,
  type DecisionBasis,
  type DecisionProposalInput,
} from './decision-data.js';

/** A proposed disposition with the basis and deployment assertions it was proposed against, as the journal holds it. */
export interface DecisionProposal {
  readonly disposition: ProposedDisposition;
  readonly basis: DecisionBasis;
  readonly assertions: readonly DeploymentAssertion[];
}
/**
 * An approved disposition with its basis and assertions. It has authority only as read from a journal
 * (`approvedDecisionAuthority`).
 */
export interface ApprovedDecision {
  readonly disposition: ApprovedDisposition;
  readonly basis: DecisionBasis;
  readonly assertions: readonly DeploymentAssertion[];
}
interface Approval {
  proposalId: string;
  disposition: ApprovedDisposition;
  admission: AdmissionEnvelope;
  receiptId: string;
}
interface Entry {
  schema: 'sentinel-decision-journal/1';
  workspace: string;
  sequence: number;
  previous: string | null;
  proposal: DecisionProposal | null;
  approval: Approval | null;
}
interface State {
  head: string | null;
  sequence: number;
  bytes: number;
  proposals: Map<string, DecisionProposal>;
  approved: Map<string, ApprovedDecision>;
}
interface Store {
  directory: string;
  workspace: string;
  receipts: ReceiptBook;
}
const stores = new WeakMap<DecisionJournal, Store>();
const authorities = new WeakMap<
  object,
  { workspace: string; sequence: number; approvedAt: string; value: ApprovedDecision }
>();
const histories = new WeakMap<object, { store: Store; head: string | null }>();
const FILE = /^[0-9]{12}\.json$/;
const MAX_RECORD = 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const nameOf = (n: number) => `${String(n).padStart(12, '0')}.json`;
const corrupt = (detail: string): never => fail('sentinel.decision.corruptHistory', detail);
function syncDirectory(path: string): void {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function valueOf(value: ApprovedDecision, workspace: string, sequence: number, approvedAt: string): ApprovedDecision {
  const out = snapshot(value);
  authorities.set(out, Object.freeze({ workspace, sequence, approvedAt, value: out }));
  return out;
}
/** Structural JSON, a spread, clone or proxy has no approval authority. */
export function approvedDecisionAuthority(value: unknown):
  | {
      readonly workspace: string;
      readonly sequence: number;
      readonly approvedAt: string;
      readonly value: ApprovedDecision;
    }
  | undefined {
  return value && typeof value === 'object' ? authorities.get(value) : undefined;
}
/** A complete current journal read, not a caller-selected subset of genuine but possibly superseded approvals. */
export function decisionHistoryAuthority(
  value: unknown,
): { readonly workspace: string; readonly head: string | null } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const history = histories.get(value);
  if (!history) return undefined;
  if (read(history.store).head !== history.head)
    return fail('sentinel.decision.staleState', 'the decision history changed; read it again before evaluating');
  return Object.freeze({ workspace: history.store.workspace, head: history.head });
}
function checkedProposal(value: unknown): DecisionProposal {
  fields(value, ['disposition', 'basis', 'assertions']);
  const checked = validateEnvelope('disposition', value.disposition);
  if (!checked.ok || checked.value.state !== 'proposed') return corrupt('a proposal does not validate');
  const basis = checkedBasis(value.basis),
    assertions = checkedAssertions(value.assertions),
    d = checked.value;
  if (
    d.findingGroupId !== basis.findingId ||
    d.scope.environmentDigest !== basis.environmentDigest ||
    d.scope.surfaceIds.length === 0 ||
    !unique(d.scope.surfaceIds) ||
    d.scope.surfaceIds.some((id) => !basis.paths.some((p) => p.surfaceId === id)) ||
    canonicalDigest(d.assertions) !==
      canonicalDigest(
        assertions.map((a) => ({
          id: a.id,
          trust: a.trust,
          environmentDigest: a.environmentDigest,
          evidence: a.evidence,
          lastVerifiedAt: a.lastVerifiedAt,
          expiresAt: a.expiresAt,
        })),
      )
  )
    return corrupt('a proposal does not bind its basis and assertions');
  if (
    assertions.some(
      (a) =>
        a.surfaceIds.some((id) => !d.scope.surfaceIds.includes(id)) ||
        a.environmentDigest !== basis.environmentDigest ||
        a.deploymentDigest !== basis.deploymentDigest ||
        a.evidence.some((e) => !d.evidence.includes(e)),
    )
  )
    return corrupt('an assertion exceeds the approved input');
  return snapshot({ disposition: d, basis, assertions });
}
function binding(s: Store, state: State, p: DecisionProposal, policyRevision: string): ReceiptBinding {
  if (!validDigest(policyRevision)) fail('sentinel.decision.invalidInput', 'a policy revision is a content digest');
  const intent: ActionIntent = {
    action: 'disposition.approve',
    input: canonicalDigest(p),
    effects: ['local-artifacts'],
    budget: { maxTokens: null, maxCost: null, currency: null },
    scope: { profile: 'static', provider: null, targets: [...p.disposition.scope.surfaceIds] },
  };
  return snapshot({
    intent,
    stateDigest: canonicalDigest({ workspace: s.workspace, head: state.head, proposal: canonicalDigest(p) }),
    policyRevision,
  });
}
function checkReceipt(s: Store, a: Approval, expected: ReceiptBinding): void {
  if (!validId(a.receiptId)) return corrupt('an approval has no issued receipt identity');
  const bytes = readPrivateFile(join(s.receipts.directory, `${a.receiptId}.json`), 16 * 1024, STORE);
  const spent = readPrivateFile(join(s.receipts.directory, `${a.receiptId}.spent`), 128, STORE);
  if (!bytes || !spent) return corrupt('an approval has no issued and spent owner receipt');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return corrupt('an approval receipt is malformed');
  }
  const checked = validateEnvelope('receipt', raw);
  const at = spent.toString('utf8');
  if (!checked.ok || !timestamp(at)) return corrupt('an approval receipt does not validate');
  const r = checked.value;
  if (
    r.id !== a.receiptId ||
    r.action !== 'disposition.approve' ||
    r.intentDigest !== intentDigest(expected.intent) ||
    r.stateDigest !== expected.stateDigest ||
    r.policyRevision !== expected.policyRevision ||
    canonicalDigest(r) !== a.disposition.actor.confirmationReceipt ||
    r.actor.principal !== a.disposition.actor.principal ||
    compareTimestamps(at, r.issuedAt) < 0 ||
    compareTimestamps(at, r.expiresAt) >= 0 ||
    at !== a.admission.decidedAt ||
    compareTimestamps(at, a.disposition.createdAt) < 0 ||
    (a.disposition.expiresAt !== null && compareTimestamps(at, a.disposition.expiresAt) >= 0)
  )
    return corrupt('an approval receipt is bound to different state, input or time');
}
function read(s: Store): State {
  ensurePrivateDir(s.directory, STORE);
  // Retry these syncs on every open/read, including after a prior failed publication acknowledgement.
  syncDirectory(dirname(s.directory));
  syncDirectory(s.directory);
  const names = readdirSync(s.directory)
    .filter((n) => !/^\.[0-9]{12}\.json\.[0-9a-f]{16}\.tmp$/.test(n))
    .sort();
  if (names.length > MAX_ENTRIES || names.some((n) => !FILE.test(n))) return corrupt('unexpected journal entries');
  const state: State = { head: null, sequence: 0, bytes: 0, proposals: new Map(), approved: new Map() };
  for (const name of names) {
    if (name !== nameOf(state.sequence + 1)) return corrupt('a journal sequence is missing');
    const bytes = readPrivateFile(join(s.directory, name), MAX_RECORD, STORE);
    if (!bytes || state.bytes + bytes.length > MAX_HISTORY_BYTES)
      return corrupt('the journal history is missing or exceeds its byte bound');
    state.bytes += bytes.length;
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return corrupt('a journal entry is malformed');
    }
    fields(raw, ['schema', 'workspace', 'sequence', 'previous', 'proposal', 'approval']);
    if (
      raw.schema !== 'sentinel-decision-journal/1' ||
      raw.workspace !== s.workspace ||
      raw.sequence !== state.sequence + 1 ||
      raw.previous !== state.head ||
      (raw.proposal === null) === (raw.approval === null)
    )
      return corrupt('a journal entry has a foreign or broken chain');
    const e = raw as unknown as Entry;
    if (e.proposal !== null) {
      const p = checkedProposal(e.proposal),
        id = p.disposition.id;
      if (
        state.proposals.has(id) ||
        (p.disposition.supersedes !== null && !state.approved.has(p.disposition.supersedes))
      )
        return corrupt('a proposal has duplicate or unavailable history');
      if (
        p.disposition.supersedes !== null &&
        state.approved.get(p.disposition.supersedes)!.basis.findingId !== p.basis.findingId
      )
        return corrupt('supersession names a different finding');
      state.proposals.set(id, p);
    } else {
      const a = e.approval!;
      fields(a, ['proposalId', 'disposition', 'admission', 'receiptId']);
      const p = state.proposals.get(a.proposalId);
      if (!p || state.approved.has(a.proposalId)) return corrupt('an approval has no unique proposal');
      const d = validateEnvelope('disposition', a.disposition),
        admission = validateEnvelope('admission', a.admission);
      if (
        !d.ok ||
        d.value.state !== 'approved' ||
        !admission.ok ||
        admission.value.outcome !== 'admitted' ||
        admission.value.requestedBy.channel !== 'owner-cli' ||
        admission.value.requestedBy.principal !== 'human' ||
        !Object.values(admission.value.verdicts).every((v) => v.allowed && v.asked) ||
        canonicalDigest({ ...d.value, state: 'proposed', actor: p.disposition.actor }) !==
          canonicalDigest(p.disposition)
      )
        return corrupt('an approval changes its proposal or lacks admission');
      const b = binding(s, state, p, admission.value.policyRevision);
      if (
        admission.value.action !== b.intent.action ||
        admission.value.intentDigest !== intentDigest(b.intent) ||
        admission.value.receipt !== d.value.actor.confirmationReceipt
      )
        return corrupt('an admission does not bind this decision');
      checkReceipt(s, a, b);
      state.approved.set(
        a.proposalId,
        valueOf(
          { disposition: d.value, basis: p.basis, assertions: p.assertions },
          s.workspace,
          e.sequence,
          admission.value.decidedAt,
        ),
      );
    }
    state.sequence++;
    state.head = canonicalDigest(e);
  }
  return state;
}
function append(s: Store, state: State, payload: Pick<Entry, 'proposal' | 'approval'>): void {
  if (state.sequence >= MAX_ENTRIES) fail('sentinel.decision.scopeExceeded', 'the decision journal reached its bound');
  const e: Entry = {
    schema: 'sentinel-decision-journal/1',
    workspace: s.workspace,
    sequence: state.sequence + 1,
    previous: state.head,
    ...payload,
  };
  const bytes = Buffer.from(JSON.stringify(e));
  if (bytes.length > MAX_RECORD || state.bytes + bytes.length > MAX_HISTORY_BYTES)
    fail('sentinel.decision.scopeExceeded', 'the decision record reached its bound');
  if (!createPrivateFileOnce(s.directory, nameOf(e.sequence), bytes, STORE))
    fail('sentinel.decision.staleState', 'the journal changed; review and confirm the new state');
}
/**
 * The append-only private owner journal of one workspace's decisions. Each entry is a numbered create-once file chained
 * to the digest of the one before; every read replays the whole chain and checks each approval against its spent owner
 * receipt, and any break is `sentinel.decision.corruptHistory`. Transports only propose; approval is `approveForOwner`.
 */
export class DecisionJournal {
  /** Owner-private user state, outside captured checkouts. The workspace identity is a digest of its real identity. */
  constructor(directory: string, workspace: string, receipts: ReceiptBook) {
    if (!validDigest(workspace)) fail('sentinel.decision.invalidInput', 'the workspace identity is a digest');
    const s = { directory, workspace, receipts };
    read(s);
    stores.set(this, s);
  }
  /**
   * Appends a proposal, never an approval. Refuses `sentinel.decision.invalidInput` for malformed input,
   * `sentinel.decision.notFound` for a supersession that names no approved decision of this finding,
   * `sentinel.decision.scopeExceeded` at the journal's bounds and `sentinel.decision.staleState` when another writer
   * appended first.
   */
  propose(
    given: DecisionProposalInput,
    basisInput: DecisionBasis,
    actor: { channel: DecisionChannel; principal: string },
    now: Date,
    assertionInputs: readonly DeploymentAssertion[] = [],
  ): DecisionProposal {
    const s = stores.get(this)!,
      state = read(s),
      basis = checkedBasis(basisInput),
      input = snapshot(given),
      assertions = checkedAssertions(assertionInputs);
    fields(input, ['decision', 'rationale', 'surfaceIds', 'evidence', 'expiresAt', 'supersedes']);
    list(input.surfaceIds, 256, validNode);
    list(input.evidence, 256, validDigest);
    if (!unique(input.evidence)) fail('sentinel.decision.invalidInput', 'evidence is unique');
    const p = checkedProposal({
      basis,
      assertions,
      disposition: {
        schema: 'sentinel-disposition/draft-1',
        id: `decision-${randomUUID()}`,
        findingGroupId: basis.findingId,
        scope: { surfaceIds: input.surfaceIds, environmentDigest: basis.environmentDigest },
        decision: input.decision,
        rationale: input.rationale,
        evidence: input.evidence,
        assertions: assertions.map((a) => ({
          id: a.id,
          trust: a.trust,
          environmentDigest: a.environmentDigest,
          evidence: a.evidence,
          lastVerifiedAt: a.lastVerifiedAt,
          expiresAt: a.expiresAt,
        })),
        createdAt: stamp(now),
        expiresAt: input.expiresAt,
        supersedes: input.supersedes,
        state: 'proposed',
        actor: snapshot(actor),
      },
    });
    if (p.disposition.supersedes !== null) {
      const prior = state.approved.get(p.disposition.supersedes);
      if (!prior || prior.basis.findingId !== basis.findingId)
        fail('sentinel.decision.notFound', 'supersession names an approved decision for this finding');
    }
    append(s, state, { proposal: p, approval: null });
    return p;
  }
  /** Every proposal in the journal, as read now. */
  proposals(): readonly DecisionProposal[] {
    return Object.freeze([...read(stores.get(this)!).proposals.values()]);
  }
  /** Every approved decision, as one complete current read: the only collection `evaluateDecisions` accepts. */
  approved(): readonly ApprovedDecision[] {
    const store = stores.get(this)!,
      state = read(store),
      out = Object.freeze([...state.approved.values()]);
    histories.set(out, { store, head: state.head });
    return out;
  }
  /**
   * The receipt binding an owner must confirm to approve proposal `id` in the journal's current state:
   * `sentinel.decision.notFound` for an unknown proposal, `sentinel.decision.staleState` for one already approved.
   */
  approvalBinding(id: string, policyRevision: string): ReceiptBinding {
    const s = stores.get(this)!,
      state = read(s),
      p = state.proposals.get(id);
    if (!p) return fail('sentinel.decision.notFound', 'no proposal with this identity');
    if (state.approved.has(id)) fail('sentinel.decision.staleState', 'the proposal is already approved');
    return binding(s, state, p, policyRevision);
  }
}
/** What an approval attempt did: denied, awaiting the owner's confirmation, or applied with the approved decision. */
export type DecisionApprovalOutcome =
  | { readonly outcome: 'denied' | 'awaiting-confirmation'; readonly admission: AdmissionEnvelope }
  | { readonly outcome: 'applied'; readonly admission: AdmissionEnvelope; readonly decision: ApprovedDecision };
/** INTERNAL owner CLI seam, deliberately absent from the public findings exports. Transports only propose.
 * The channel/principal are fixed here, never accepted from request JSON or a confirmation boolean. */
export function approveForOwner(
  journal: DecisionJournal,
  id: string,
  options: { policy: EffectivePolicy; receiptId?: string; now: Date },
): DecisionApprovalOutcome {
  const s = stores.get(journal)!,
    state = read(s),
    p = state.proposals.get(id);
  if (!p) return fail('sentinel.decision.notFound', 'no proposal with this identity');
  if (state.approved.has(id)) fail('sentinel.decision.staleState', 'the proposal is already approved');
  if (
    compareTimestamps(p.disposition.createdAt, stamp(options.now)) > 0 ||
    (p.disposition.expiresAt !== null && compareTimestamps(p.disposition.expiresAt, stamp(options.now)) <= 0)
  )
    fail('sentinel.decision.staleState', 'the proposal is not current; propose and confirm again');
  if (p.disposition.decision === 'mitigated' && p.disposition.evidence.length === 0)
    return fail('sentinel.decision.invalidInput', 'a mitigation must name its evidence before confirmation');
  const b = binding(s, state, p, options.policy.revision);
  const result = admit({
    ...b,
    requestedBy: { principal: 'human', channel: 'owner-cli' },
    policy: options.policy,
    capability: () => ({ available: true, detail: 'append a scoped owner decision to private user state' }),
    credential: () => ({ basis: 'local-only', detail: 'no remote authority is used' }),
    now: options.now,
    ...(options.receiptId ? { receipt: { book: s.receipts, id: options.receiptId } } : {}),
  });
  if (result.record.outcome !== 'admitted')
    return snapshot({ outcome: result.record.outcome, admission: result.record });
  const authority = receiptAuthority(result.receipt);
  if (!authority || authority.action !== 'disposition.approve' || authority.intentDigest !== intentDigest(b.intent))
    return fail('sentinel.decision.unauthorized', 'a genuine spent owner receipt is required');
  const disposition: ApprovedDisposition = {
    ...p.disposition,
    state: 'approved',
    actor: {
      channel: 'owner-cli',
      principal: result.receipt!.receipt.actor.principal,
      confirmationReceipt: authority.digest,
    },
  };
  const checked = validateEnvelope('disposition', disposition);
  if (!checked.ok)
    return fail('sentinel.decision.invalidInput', 'the proposed decision cannot become an approved disposition');
  append(s, state, {
    proposal: null,
    approval: { proposalId: id, disposition, admission: result.record, receiptId: result.receipt!.receipt.id },
  });
  const decision = read(s).approved.get(id)!;
  return Object.freeze({ outcome: 'applied', admission: result.record, decision });
}
