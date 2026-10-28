// Closed /2 owner decision history. /1 remains untouched. This is not an evidence acceptance or launch journal.
import { randomUUID } from 'node:crypto';
import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceIdentity } from '../policy/adoption.js';
import { boundOwner } from '../store/owner-binding.js';
import type { SentinelStore } from '../store/index.js';
import type { Workspace } from '../service/local.js';
import type { AdmissionEnvelope, ReceiptEnvelope, ActionIntent, OwnerDecisionInput } from '../contracts/index.js';
import { validateEnvelope, compareTimestamps, isCalendarTimestamp } from '../validate.js';
import { admit } from '../policy/admission.js';
import { stamp, type ReceiptBinding } from '../policy/receipts.js';
import { currentImportPolicy, ownerContextOf, type ImportOwnerContext } from '../evidence/owner-context.js';
import { boundedAudit, forecastAdmission, verifyRetainedAudit } from '../evidence/audit.js';
import { publishOnce, readPublished, ensureDurableDir, isTemporaryName } from '../service/publish-once.js';
import { canonicalJson, digestOf } from '../store/ledger-json.js';
import { deepFreeze } from '../policy/immutable.js';
import {
  acceptedFindingOf,
  acceptedFindingDigest,
  readOwnerSupport,
  type OwnerDecisionSupport,
  type AcceptedFindingBasis,
  type AcceptedFindingRecord,
} from './decision-basis.js';
import { fail } from './decision-data.js';

/** The owner decision history's bounds: bytes per record and in all, entries, and directory entries read. */
export const OWNER_DECISION_LIMITS = Object.freeze({
  recordBytes: 1024 * 1024,
  historyBytes: 32 * 1024 * 1024,
  entries: 1024,
  directoryEntries: 2048,
});
/**
 * A prepared owner proposal: the accepted finding record it is about and its digest, the checked input, the support it
 * read and when it was made.
 */
export interface OwnerProposal {
  readonly id: string;
  readonly basis: AcceptedFindingRecord;
  readonly basisDigest: string;
  readonly input: OwnerDecisionInput;
  readonly support: readonly OwnerDecisionSupport[];
  readonly createdAt: string;
}
interface Audit {
  admission: AdmissionEnvelope;
  receipt: ReceiptEnvelope | null;
  intent: ActionIntent;
  stateDigest: string;
  policyRevision: string;
}
interface Payload {
  proposal: OwnerProposal | null;
  approval: { proposalId: string } | null;
  audit: Audit;
}
interface Entry {
  schema: 'sentinel-owner-decision-journal/2';
  storeId: string;
  workspaceDigest: string;
  sequence: number;
  previous: string | null;
  payload: Payload;
}
/**
 * A replayed owner decision history: its head and sequence, every proposal and every approval's audit. It has authority
 * only as returned by `readOwnerHistory` and checked by `ownerHistoryOf`.
 */
export interface OwnerHistory {
  lastAdmittedAt: string | null;
  head: string | null;
  sequence: number;
  bytes: number;
  proposals: Map<string, OwnerProposal>;
  approved: Map<string, Audit>;
}
const histories = new WeakMap<object, { context: ImportOwnerContext; head: string | null; state: OwnerHistory }>();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function invalid(): never {
  return fail('sentinel.decision.corruptHistory', 'owner decision history is unavailable');
}
const prepared = new WeakMap<OwnerProposal, AcceptedFindingBasis>();
const reportHistories = new WeakSet<object>();
/** Report-only immutable snapshot; final full verification is mandatory before any projection is returned. */
export function readOwnerReportHistory(context: ImportOwnerContext): OwnerHistory {
  const h = readOwnerHistory(context);
  reportHistories.add(h);
  return h;
}
/**
 * Ends a report-only history read and verifies the history has not moved since; `sentinel.decision.staleState`
 * otherwise.
 */
export function finishOwnerReportHistory(value: OwnerHistory): void {
  reportHistories.delete(value);
  ownerHistoryOf(value);
}
/** Missing decision history is the unchanged report path, including older nondefault store layouts. */
export function hasOwnerHistory(store: SentinelStore, ws: Workspace): boolean {
  boundOwner(store).assertHeld();
  const path = join(
    ws.trustDir,
    'decisions-v2',
    digestOf({ workspace: workspaceIdentity(ws.path).digest, storeId: store.storeId }).slice(7),
  );
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function folder(context: ImportOwnerContext, create = false): string | undefined {
  const c = ownerContextOf(context),
    dir = join(
      c.trustDir,
      'decisions-v2',
      digestOf({ workspace: c.workspaceDigest, storeId: c.store.storeId }).slice(7),
    );
  if (create) ensureDurableDir(dir, c.trustDir);
  try {
    for (const path of [join(c.trustDir, 'decisions-v2'), dir]) {
      const st = lstatSync(path);
      if (
        !st.isDirectory() ||
        st.isSymbolicLink() ||
        (st.mode & 0o077) !== 0 ||
        (process.getuid && st.uid !== process.getuid())
      )
        invalid();
    }
    return dir;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' && !create) return undefined;
    throw e;
  }
}
/**
 * Validates a decision input against its contract and returns a frozen copy; `sentinel.decision.invalidInput` for an
 * invalid input or repeated evidence.
 */
export function checkedOwnerInput(value: unknown): OwnerDecisionInput {
  const checked = validateEnvelope('decisioninput', value);
  if (!checked.ok) return fail('sentinel.decision.invalidInput', 'invalid decision proposal');
  const i = checked.value;
  if (new Set(i.evidence).size !== i.evidence.length)
    return fail('sentinel.decision.invalidInput', 'duplicate evidence');
  return deepFreeze(structuredClone(i));
}
function priorApproved(state: OwnerHistory, findingId: string): string | null {
  const ids = [...state.approved.keys()].filter((id) => state.proposals.get(id)?.basis.findingId === findingId);
  return ids.at(-1) ?? null;
}
function binding(
  context: ImportOwnerContext,
  head: string | null,
  action: 'disposition.propose' | 'disposition.approve',
  value: unknown,
  findingId: string,
): ReceiptBinding {
  const c = ownerContextOf(context),
    policy = currentImportPolicy(context);
  return {
    intent: {
      action,
      input: digestOf(value),
      effects: ['local-artifacts'],
      budget: { maxTokens: null, maxCost: null, currency: null },
      scope: { profile: (value as OwnerProposal).basis.profileId, provider: null, targets: [findingId] },
    },
    stateDigest: digestOf({
      storeId: c.store.storeId,
      workspaceDigest: c.workspaceDigest,
      head,
      value: digestOf(value),
    }),
    policyRevision: policy.revision,
  };
}
function admission(context: ImportOwnerContext, b: ReceiptBinding, now: Date, receiptId?: string) {
  const c = ownerContextOf(context);
  return admit({
    intent: b.intent,
    stateDigest: b.stateDigest,
    policy: currentImportPolicy(context, b.policyRevision),
    now,
    requestedBy: { principal: 'human', channel: 'owner-cli' },
    capability: () => ({ available: true, detail: 'bounded local owner decision' }),
    credential: () => ({ basis: 'local-only', detail: 'no provider or target is contacted' }),
    ...(receiptId ? { receipt: { book: c.receipts, id: receiptId } } : {}),
  });
}
function checkAudit(context: ImportOwnerContext, a: Audit, b: ReceiptBinding, requiresReceipt: boolean) {
  if (!a || Object.keys(a).sort().join('|') !== 'admission|intent|policyRevision|receipt|stateDigest') invalid();
  boundedAudit(a);
  const checked = validateEnvelope('admission', a.admission);
  if (
    !checked.ok ||
    !same(a.intent, b.intent) ||
    a.stateDigest !== b.stateDigest ||
    !/^sha256:[0-9a-f]{64}$/.test(a.policyRevision) ||
    a.policyRevision !== a.admission.policyRevision ||
    a.admission.action !== b.intent.action ||
    a.admission.intentDigest !== digestOf(b.intent) ||
    a.admission.outcome !== 'admitted' ||
    a.admission.requestedBy.principal !== 'human' ||
    a.admission.requestedBy.channel !== 'owner-cli' ||
    !Object.values(a.admission.verdicts).every((v) => v.allowed && v.asked)
  )
    invalid();
  if (a.receipt) verifyRetainedAudit(context, { ...a, receipt: a.receipt, receiptDigest: digestOf(a.receipt) });
  else if (requiresReceipt || a.admission.receipt !== null) invalid();
}
/** Full bounded history only; a paged/copied collection never supplies evaluation authority. */
export function readOwnerHistory(context: ImportOwnerContext): OwnerHistory {
  const c = ownerContextOf(context),
    dir = folder(context),
    state: OwnerHistory = {
      lastAdmittedAt: null,
      head: null,
      sequence: 0,
      bytes: 0,
      proposals: new Map(),
      approved: new Map(),
    };
  if (dir) {
    const names: string[] = [],
      handle = opendirSync(dir);
    try {
      let e,
        visited = 0;
      while ((e = handle.readSync()) !== null) {
        ownerContextOf(context);
        if (++visited > OWNER_DECISION_LIMITS.directoryEntries) invalid();
        if (isTemporaryName(e.name)) continue;
        if (names.length >= OWNER_DECISION_LIMITS.entries || !/^[0-9]{12}\.json$/.test(e.name)) invalid();
        names.push(e.name);
      }
    } finally {
      handle.closeSync();
    }
    for (const name of names.sort()) {
      const n = state.sequence + 1;
      if (name !== String(n).padStart(12, '0') + '.json') invalid();
      const bytes = readPublished(dir, name, OWNER_DECISION_LIMITS.recordBytes);
      if (!bytes || state.bytes + bytes.length > OWNER_DECISION_LIMITS.historyBytes) invalid();
      let e: Entry;
      try {
        e = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as Entry;
      } catch {
        invalid();
      }
      if (!bytes.equals(Buffer.from(canonicalJson(e)))) invalid();
      if (
        !e ||
        Object.keys(e).sort().join('|') !== 'payload|previous|schema|sequence|storeId|workspaceDigest' ||
        e.schema !== 'sentinel-owner-decision-journal/2' ||
        e.storeId !== c.store.storeId ||
        e.workspaceDigest !== c.workspaceDigest ||
        e.sequence !== n ||
        e.previous !== state.head ||
        !e.payload ||
        Object.keys(e.payload).sort().join('|') !== 'approval|audit|proposal' ||
        (e.payload.proposal === null) === (e.payload.approval === null)
      )
        invalid();
      const { proposal: p, approval, audit } = e.payload;
      if (p) {
        if (
          !/^decision-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.id) ||
          Object.keys(p).sort().join('|') !== 'basis|basisDigest|createdAt|id|input|support' ||
          !p.basis ||
          p.basis.storeId !== c.store.storeId ||
          p.basis.workspaceDigest !== c.workspaceDigest ||
          digestOf(p.basis) !== p.basisDigest ||
          state.proposals.has(p.id)
        )
          invalid();
        if (!isCalendarTimestamp(p.createdAt)) invalid();
        checkedOwnerInput(p.input);
        if (p.input.expiresAt !== null && compareTimestamps(p.input.expiresAt, p.createdAt) <= 0) invalid();
        if (p.input.supersedes !== priorApproved(state, p.basis.findingId)) invalid();
        if (p.input.supersedes !== null) {
          const prior = state.proposals.get(p.input.supersedes);
          if (!prior || !state.approved.has(prior.id) || prior.basis.findingId !== p.basis.findingId) invalid();
        }
        const b = {
          ...bindingHistorical(context, state.head, 'disposition.propose', p, p.basis.findingId),
          policyRevision: audit.policyRevision,
        };
        checkAudit(context, audit, b, false);
        state.proposals.set(p.id, deepFreeze(p));
      } else {
        if (!approval || Object.keys(approval).join('|') !== 'proposalId') invalid();
        const p = state.proposals.get(approval.proposalId);
        if (!p || state.approved.has(p.id)) invalid();
        if (p.input.supersedes !== priorApproved(state, p.basis.findingId)) invalid();
        const b = {
          ...bindingHistorical(context, state.head, 'disposition.approve', p, p.basis.findingId),
          policyRevision: audit.policyRevision,
        };
        checkAudit(context, audit, b, true);
        if (
          compareTimestamps(audit.admission.decidedAt, p.createdAt) < 0 ||
          (p.input.expiresAt !== null && compareTimestamps(audit.admission.decidedAt, p.input.expiresAt) >= 0)
        )
          invalid();
        state.approved.set(p.id, deepFreeze(audit));
      }
      if (state.lastAdmittedAt === null || compareTimestamps(audit.admission.decidedAt, state.lastAdmittedAt) > 0)
        state.lastAdmittedAt = audit.admission.decidedAt;
      state.sequence = n;
      state.bytes += bytes.length;
      state.head = digestOf(e);
    }
  }
  ownerContextOf(context);
  histories.set(state, {
    context,
    head: state.head,
    state: { ...state, proposals: new Map(state.proposals), approved: new Map(state.approved) },
  });
  return state;
}
function bindingHistorical(
  context: ImportOwnerContext,
  head: string | null,
  action: 'disposition.propose' | 'disposition.approve',
  value: unknown,
  findingId: string,
): Omit<ReceiptBinding, 'policyRevision'> {
  const c = ownerContextOf(context);
  return {
    intent: {
      action,
      input: digestOf(value),
      effects: ['local-artifacts'],
      budget: { maxTokens: null, maxCost: null, currency: null },
      scope: { profile: (value as OwnerProposal).basis.profileId, provider: null, targets: [findingId] },
    },
    stateDigest: digestOf({
      storeId: c.store.storeId,
      workspaceDigest: c.workspaceDigest,
      head,
      value: digestOf(value),
    }),
  };
}
/**
 * A fresh copy of a history this module read, after checking its owner context and, unless it is a report read, that
 * the journal head has not moved. A value this module did not read, or a moved head, is `sentinel.decision.staleState`.
 */
export function ownerHistoryOf(value: OwnerHistory): Readonly<OwnerHistory> {
  const h = histories.get(value);
  if (h) ownerContextOf(h.context);
  if (!h || (!reportHistories.has(value) && readOwnerHistory(h.context).head !== h.head))
    return fail('sentinel.decision.staleState', 'history changed');
  return { ...h.state, proposals: new Map(h.state.proposals), approved: new Map(h.state.approved) };
}
function append(context: ImportOwnerContext, state: OwnerHistory, payload: Payload) {
  const c = ownerContextOf(context);
  if (state.sequence >= OWNER_DECISION_LIMITS.entries) fail('sentinel.decision.scopeExceeded', 'history limit');
  ownerHistoryOf(state);
  const e: Entry = {
    schema: 'sentinel-owner-decision-journal/2',
    storeId: c.store.storeId,
    workspaceDigest: c.workspaceDigest,
    sequence: state.sequence + 1,
    previous: state.head,
    payload,
  };
  const bytes = Buffer.from(canonicalJson(e));
  if (
    bytes.length > OWNER_DECISION_LIMITS.recordBytes ||
    state.bytes + bytes.length > OWNER_DECISION_LIMITS.historyBytes
  )
    fail('sentinel.decision.scopeExceeded', 'history byte limit');
  const dir = folder(context, true)!;
  ownerContextOf(context);
  if (!publishOnce(dir, String(e.sequence).padStart(12, '0') + '.json', bytes))
    fail('sentinel.decision.staleState', 'history changed');
  ownerContextOf(context);
}
/**
 * Prepares a proposal over an accepted finding without appending it: checks the input, refuses an expiry that is not in
 * the future (`sentinel.decision.invalidInput`), reads the support, and remembers the basis it was prepared for, the
 * only one `appendOwnerDecision` accepts it with.
 */
export async function prepareOwnerProposal(
  basis: AcceptedFindingBasis,
  ws: Workspace,
  input: OwnerDecisionInput,
  now: Date,
): Promise<OwnerProposal> {
  const s = acceptedFindingOf(basis),
    i = checkedOwnerInput(input);
  if (i.expiresAt !== null && compareTimestamps(i.expiresAt, stamp(now)) <= 0)
    fail('sentinel.decision.invalidInput', 'expiry must be future');
  const support = await readOwnerSupport(basis, ws, i.evidence);
  acceptedFindingOf(basis);
  const p = deepFreeze({
    id: 'decision-' + randomUUID(),
    basis: s.record,
    basisDigest: acceptedFindingDigest(basis),
    input: i,
    support,
    createdAt: stamp(now),
  });
  prepared.set(p, basis);
  return p;
}
type EffectPhase = 'not-established' | 'consumption-attempted' | 'spent' | 'publication-attempted' | 'retained';
const effectFailures = new WeakMap<object, EffectPhase>();
/** Only errors observed inside the genuine append path carry effect metadata. */
export function ownerDecisionFailurePhase(error: unknown): EffectPhase {
  return error !== null && typeof error === 'object'
    ? (effectFailures.get(error) ?? 'not-established')
    : 'not-established';
}
/** Admission/receipt is genuine and shared; the caller cannot choose its actor or pass a confirmation boolean. */
export async function appendOwnerDecision(
  context: ImportOwnerContext,
  basis: AcceptedFindingBasis,
  ws: Workspace,
  proposal: OwnerProposal,
  action: 'disposition.propose' | 'disposition.approve',
  now: Date,
  receiptId?: string,
) {
  let phase: EffectPhase = 'not-established';
  try {
    const s = acceptedFindingOf(basis);
    if (s.context !== context || !same(s.record, proposal.basis))
      fail('sentinel.decision.unauthorized', 'foreign basis');
    const support = await readOwnerSupport(basis, ws, proposal.input.evidence);
    acceptedFindingOf(basis);
    // Source/support reads may outlast a receipt. The argument is an action-start sample, never a clock that can
    // backdate a later spend. Public input cannot choose either sample.
    now = new Date();
    if (!same(support, proposal.support)) fail('sentinel.decision.unauthorized', 'support identity changed');
    if (!isCalendarTimestamp(stamp(now)) || compareTimestamps(stamp(now), proposal.createdAt) < 0)
      fail('sentinel.decision.invalidInput', 'approval predates proposal');
    const state = readOwnerHistory(context);
    if (action === 'disposition.propose' && prepared.get(proposal) !== basis)
      fail('sentinel.decision.unauthorized', 'proposal was not prepared for this accepted basis');
    if (action === 'disposition.approve') {
      const old = state.proposals.get(proposal.id);
      if (!old || !same(old, proposal)) fail('sentinel.decision.staleState', 'proposal changed');
      if (state.approved.has(proposal.id)) {
        // A lost acknowledgement is a retained read, never a fresh receipt spend. Current policy must still permit
        // this command; historical approval remains independently readable after a grant is withdrawn.
        const b = binding(context, state.head, action, proposal, proposal.basis.findingId),
          check = admission(context, b, now);
        if (check.record.outcome === 'denied')
          return { status: check.record.outcome, binding: b, admission: check.record };
        return { status: 'applied' as const, reused: true, proposal };
      }
      if (proposal.input.expiresAt !== null && compareTimestamps(proposal.input.expiresAt, stamp(now)) <= 0)
        fail('sentinel.decision.staleState', 'proposal expired');
    }
    if (proposal.input.supersedes !== priorApproved(state, proposal.basis.findingId))
      fail('sentinel.decision.staleState', 'the current approved decision must be superseded explicitly');
    if (action === 'disposition.propose' && proposal.input.supersedes !== null) {
      const old = state.proposals.get(proposal.input.supersedes);
      if (!old || !state.approved.has(old.id) || old.basis.findingId !== proposal.basis.findingId)
        fail('sentinel.decision.invalidInput', 'invalid supersession');
    }
    // Leave a fixed 32 KiB audit/entry allowance before admission can spend any receipt. The complete final bytes
    // are still checked before publication; this conservative bound cannot turn overflow into partial history.
    const forecast = Buffer.byteLength(canonicalJson(proposal)) + 32768;
    if (
      state.sequence >= OWNER_DECISION_LIMITS.entries ||
      forecast > OWNER_DECISION_LIMITS.recordBytes ||
      state.bytes + forecast > OWNER_DECISION_LIMITS.historyBytes
    )
      fail('sentinel.decision.scopeExceeded', 'history capacity unavailable');
    const b = binding(context, state.head, action, proposal, proposal.basis.findingId);
    const receiptForecast = receiptId === undefined ? null : forecastAdmission(context, b, receiptId, new Date());
    acceptedFindingOf(basis);
    ownerHistoryOf(state);
    currentImportPolicy(context, b.policyRevision);
    now = new Date();
    if (state.lastAdmittedAt !== null && compareTimestamps(stamp(now), state.lastAdmittedAt) < 0)
      fail('sentinel.decision.staleState', 'wall clock precedes saved authority');
    if (proposal.input.expiresAt !== null && compareTimestamps(proposal.input.expiresAt, stamp(now)) <= 0)
      fail('sentinel.decision.staleState', 'proposal expired');
    const predicted = receiptForecast
      ? {
          ...admission(context, b, now).record,
          outcome: 'admitted' as const,
          receipt: digestOf(receiptForecast.receipt),
        }
      : null;
    if (predicted)
      boundedAudit({
        admission: predicted,
        receipt: receiptForecast!.receipt,
        intent: b.intent,
        stateDigest: b.stateDigest,
        policyRevision: b.policyRevision,
      });
    if (receiptId !== undefined) phase = 'consumption-attempted';
    const decided = admission(context, b, now, receiptId);
    if (!decided.receipt) phase = 'not-established';
    if (decided.receipt) phase = 'spent';
    if (
      receiptForecast &&
      (!decided.receipt || !same(decided.receipt.receipt, receiptForecast.receipt) || !same(decided.record, predicted))
    )
      fail('sentinel.decision.unauthorized', 'consumed authority differs from its bounded forecast');
    if (decided.record.outcome !== 'admitted')
      return { status: decided.record.outcome, binding: b, admission: decided.record };
    // Receipt spending and publication are separate durable effects; failure after spend must never claim rollback.
    acceptedFindingOf(basis);
    currentImportPolicy(context, b.policyRevision);
    ownerHistoryOf(state);
    const audit: Audit = {
      admission: decided.record,
      receipt: decided.receipt?.receipt ?? null,
      intent: b.intent,
      stateDigest: b.stateDigest,
      policyRevision: b.policyRevision,
    };
    if (action === 'disposition.approve' && !decided.receipt)
      fail('sentinel.decision.unauthorized', 'owner receipt missing');
    checkAudit(context, audit, b, action === 'disposition.approve');
    phase = 'publication-attempted';
    append(context, state, {
      proposal: action === 'disposition.propose' ? proposal : null,
      approval: action === 'disposition.approve' ? { proposalId: proposal.id } : null,
      audit,
    });
    phase = 'retained';
    const verified = readOwnerHistory(context);
    if (
      !verified.proposals.has(proposal.id) ||
      (action === 'disposition.approve' && !verified.approved.has(proposal.id))
    )
      invalid();
    return {
      status: action === 'disposition.propose' ? ('proposed' as const) : ('applied' as const),
      reused: false,
      proposal,
    };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (
      phase === 'consumption-attempted' &&
      typeof code === 'string' &&
      [
        'sentinel.receipt.expired',
        'sentinel.receipt.mismatch',
        'sentinel.receipt.unknown',
        'sentinel.receipt.alreadyUsed',
      ].includes(code)
    )
      phase = 'not-established';
    if (error !== null && typeof error === 'object') effectFailures.set(error, phase);
    throw error;
  }
}
