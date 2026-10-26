// One durable preparation in the genuine held OwnerService. Private journal bytes are data, never grants.
// Acceptance is short; capture/bootstrap runs in the service after the durable accepted record, independent of
// its response socket. A caller key only finds that retained outcome; it never authorizes replay or recovery.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { SentinelStore } from '../store/index.js';
import type { AdapterRegistry } from '../execution/registry.js';
import type { Coordinator } from '../execution/coordinator.js';
import type { ActionIntent } from '../contracts/policy.js';
import type { RequestedBy } from '../cli/actor.js';
import {
  admit,
  admitRequiringReceipt,
  admitOwnerUi,
  type AdmissionResult,
  type AdmissionRequest,
} from '../policy/admission.js';
import { ReceiptBook } from '../policy/receipts.js';
import { activeOwnerUiProof, assertOwnerUiProof } from '../owner-ui/authority.js';
import { OwnerUiReceiptBook } from '../owner-ui/receipts.js';
import { canonicalDigest } from '../policy/digest.js';
import { effectivePolicy } from '../policy/settings.js';
import { loadPolicyInputsReadOnly } from '../policy/adoption.js';
import { workspaceIdentity } from '../policy/adoption.js';
import { result, type CommandResult } from '../cli/outcome.js';
import { captureWithBudget } from '../snapshot/capture.js';
import { GitReadBudget } from '../snapshot/git.js';
import { OWNER, SCAN_PROFILE, printed, type Workspace } from './local.js';
import { openScratchLease, releaseScratchLease, type ScratchLease } from './scratch-lease.js';
import { planPreparedWorkspaceCanonical } from './canonical.js';
import {
  resolvePreparationInputs,
  assertPreparationInputs,
  preparationInputBytes,
  preparationResolvedBytes,
  preparationTerms,
  resolvePreparationRun,
  existingPreparationAnalysis,
  restorePreparationInputs,
  type PreparationInputs,
  type PreparationParent,
} from './preparation-inputs.js';
import { FRAMEWORK_CONTROLS_ADAPTER_ID } from './framework-adapter.js';
import { discoverPreparationProfile } from './preparation-discovery.js';
import {
  PreparationJournal,
  terminalPreparation,
  PREPARATION_TERMINAL_LIMIT,
  type PreparationRecord,
} from './preparation-journal.js';
import {
  preparationClock,
  PreparationError,
  PREPARATION_LIMIT_MS,
  type PreparationClock,
} from './preparation-clock.js';

const PREVIEW_MS = 30_000;
const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODES = new Set([
  'sentinel.preparation.expired',
  'sentinel.preparation.canceled',
  'sentinel.preparation.changed',
  'sentinel.preparation.unavailable',
  'sentinel.preparation.invalid',
  'sentinel.preparation.retentionRequired',
  'sentinel.preparation.busy',
  'sentinel.preparation.ownerRestarted',
  'sentinel.preparation.alreadyPrepared',
]);
interface Preview {
  readonly id: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly inputs: PreparationInputs;
  readonly parent: PreparationParent | null;
  readonly createdAt: number;
  readonly started: number;
  readonly channel: string;
  readonly binding: { intent: ActionIntent; stateDigest: string; policyRevision: string };
}
interface Active {
  record: PreparationRecord;
  readonly inputs: PreparationInputs;
  readonly clock: PreparationClock;
  readonly abort: AbortController;
  task: Promise<void>;
  coordinator?: Coordinator;
  stopping: boolean;
}
type PreparationDecision = {
  readonly record: AdmissionResult['record'];
  readonly receipt: { readonly digest: string } | null;
};
const uiFor = (by: RequestedBy) => (by.channel === 'owner-ui' ? activeOwnerUiProof() : null);
const requester = (by: RequestedBy) => uiFor(by)?.requestedBy ?? OWNER;
const bookFor = (directory: string, by: RequestedBy) => {
  const proof = uiFor(by);
  return proof ? new OwnerUiReceiptBook(directory, proof) : new ReceiptBook(directory);
};
function decidePreparation(
  request: AdmissionRequest,
  required = false,
  directory?: string,
  id?: string,
): PreparationDecision {
  const { receipt: _receipt, ...given } = request;
  const proof = request.requestedBy.channel === 'owner-ui' ? activeOwnerUiProof() : null;
  if (proof)
    return admitOwnerUi(
      { ...given, ...(id ? { receipt: { book: new OwnerUiReceiptBook(directory!, proof), id } } : {}) },
      proof,
      required,
    );
  return (required ? admitRequiringReceipt : admit)({
    ...request,
    ...(id ? { receipt: { book: new ReceiptBook(directory!), id } } : {}),
  });
}
const failure = (e: unknown): string =>
  CODES.has((e as { code: string })?.code) ? (e as { code: string }).code : 'sentinel.preparation.invalid';
const invalid = (): never => {
  throw new PreparationError('sentinel.preparation.invalid');
};
function requestKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY.test(key)) return invalid();
  return canonicalDigest({ requestKey: key });
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (![...required, ...optional].includes(k) || typeof v !== 'string' || v.length > 128) return invalid();
    out[k] = v;
  }
  if (required.some((k) => typeof out[k] !== 'string')) return invalid();
  return out;
}

export class PreparationController {
  readonly #store: SentinelStore;
  readonly #ws: Workspace;
  readonly #registry: AdapterRegistry;
  readonly #journal: PreparationJournal;
  readonly #runBusy: () => boolean;
  readonly #finished: () => void;
  readonly #previews = new Map<string, Preview>();
  readonly #settled = new Set<string>();
  #active: Active | undefined;
  #stopping = false;
  #disabled = false;
  constructor(
    store: SentinelStore,
    ws: Workspace,
    registry: AdapterRegistry,
    runBusy: () => boolean,
    finished: () => void,
  ) {
    store.assertHeld();
    this.#store = store;
    this.#ws = ws;
    this.#registry = registry;
    this.#runBusy = runBusy;
    this.#finished = finished;
    this.#journal = new PreparationJournal(store);
    try {
      this.#journal.recoverPublications();
      this.#reconcile();
    } catch {
      this.#disabled = true;
    }
  }
  #available(): void {
    this.#store.assertHeld();
    if (this.#disabled) throw new PreparationError('sentinel.preparation.unavailable');
  }
  // Only a newly held epoch or this controller's genuinely settled task can justify data interruption.
  // This does not cancel a run, release a lease, prove a worker stopped, or authorize execution/recovery.
  #reconcile(): void {
    this.#store.assertHeld();
    if (this.busy || this.#runBusy()) return;
    for (const record of this.#journal.list())
      if (
        !terminalPreparation(record) &&
        (record.ownerEpoch !== this.#store.epoch || this.#settled.has(record.prepId))
      ) {
        this.#write(record, { phase: 'interrupted', errorCode: 'sentinel.preparation.ownerRestarted' });
        this.#settled.delete(record.prepId);
      }
  }
  get busy(): boolean {
    return this.#active !== undefined;
  }
  capabilities() {
    this.#available();
    return Object.freeze({
      schema: 'sentinel-preparation-capabilities/draft-1',
      apiRevision: 1,
      storeId: this.#store.storeId,
      epoch: this.#store.epoch,
      operations: ['configuration.preview', 'prepare.accept', 'prepare.status', 'prepare.resume', 'prepare.cancel'],
      preparationMs: PREPARATION_LIMIT_MS,
      previewMs: PREVIEW_MS,
      terminalLimit: PREPARATION_TERMINAL_LIMIT,
      source: 'configured-workspace',
      prerequisites: ['capture', 'parse', 'inventory'],
      checksStartSeparately: true,
      automaticResume: false,
      limitationKey: 'sentinel.preparation.limits',
    });
  }
  preview(body: unknown, by: RequestedBy): unknown {
    this.#available();
    if (this.#stopping) return invalid();
    const f = fields(body, ['requestKey'], ['parentId']),
      keyDigest = requestKey(f.requestKey);
    const createdAt = Date.now(),
      started = performance.now(),
      stillWithin = () => {
        this.#store.assertHeld();
        if (Date.now() < createdAt || Date.now() >= createdAt + PREVIEW_MS || performance.now() - started >= PREVIEW_MS)
          throw new PreparationError('sentinel.preparation.changed');
      };
    const inputs = resolvePreparationInputs(
      this.#store,
      { workspace: this.#ws.path, trustDir: this.#ws.trustDir, registry: this.#registry },
      stillWithin,
    );
    const terms = preparationTerms(this.#store, inputs, stillWithin);
    let parent: PreparationParent | null = null;
    if (f.parentId !== undefined) {
      if (!ID.test(f.parentId)) return invalid();
      const run = this.#store.ledger.getRun(f.parentId);
      if (!run || !['completed', 'canceled'].includes(run.state))
        throw new PreparationError('sentinel.preparation.unavailable');
      const plan = this.#store.ledger.getPlan(f.parentId, run.planRevision);
      if (!plan) throw new PreparationError('sentinel.preparation.unavailable');
      parent = Object.freeze({
        runId: f.parentId,
        revision: run.planRevision,
        planDigest: plan.digest,
        snapshotId: run.envelope.snapshotId,
      });
    }
    const intended = JSON.parse(preparationInputBytes(this.#store, inputs).toString('utf8'));
    const requestDigest = canonicalDigest({
      schema: 'sentinel-preparation-request/1',
      keyDigest,
      storeId: this.#store.storeId,
      workspace: workspaceIdentity(this.#ws.path),
      mode: parent ? 'retry' : 'workspace',
      parent,
      input: inputs.digest,
    });
    const effects: ActionIntent['effects'] = intended.recipe.requestedAdapters.some(
      (id: string) => id !== FRAMEWORK_CONTROLS_ADAPTER_ID,
    )
      ? ['local-artifacts', 'tool-execution']
      : ['local-artifacts'];
    const binding = {
      intent: {
        action: 'capture.source' as const,
        input: requestDigest,
        effects,
        budget: { maxTokens: null, maxCost: null, currency: null },
        scope: { profile: SCAN_PROFILE, provider: null, targets: [inputs.digest] },
      },
      stateDigest: requestDigest,
      policyRevision: terms.policy.revision,
    };
    stillWithin();
    const now = createdAt,
      preview: Preview = Object.freeze({
        id: `prepare-preview-${randomBytes(16).toString('hex')}`,
        keyDigest,
        requestDigest,
        inputs,
        parent,
        createdAt: now,
        started,
        channel: by.channel,
        binding,
      });
    // At most one immutable preview per fixed service channel; a new preview replaces only that channel's preview.
    this.#previews.set(by.channel, preview);
    return {
      schema: 'sentinel-configuration-preview/draft-1',
      id: preview.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PREVIEW_MS).toISOString(),
      mode: parent ? 'retry' : 'workspace',
      effects,
      stages: [
        { stage: 'capture', required: true },
        { stage: 'parse', required: true },
        { stage: 'inventory', required: true },
        { stage: 'check', required: false },
      ],
      counts: {
        selectedRules: {
          n: terms.policy.rules.length,
          unit: 'sentinel.preparation.count.selectedRules',
          bizUnit: 'sentinel.preparation.count.selectedRules',
          scope: 'sentinel.preparation.scope.configuration',
          source: 'PreparationController.preview.effectivePolicy.rules',
        },
        mandatoryRules: {
          n: new Set(terms.policy.settings.mandatoryRules).size,
          unit: 'sentinel.preparation.count.mandatoryRules',
          bizUnit: 'sentinel.preparation.count.mandatoryRules',
          scope: 'sentinel.preparation.scope.configuration',
          source: 'PreparationController.preview.adoptedSettings.mandatoryRules',
        },
      },
      capabilitiesChecked: false,
      sourceCaptured: false,
      ...(by.channel === 'local-service' ? { confirmation: binding } : {}),
    };
  }
  /** Private paired UI only. No confirmation data is added to the legacy public preview/status shapes. */
  ownerUiConfirmation(kind: 'accept' | 'resume' | 'cancel', body: unknown, by: RequestedBy) {
    this.#available();
    const proof = uiFor(by);
    if (!proof) return invalid();
    const action = kind === 'cancel' ? 'run.cancel' : 'capture.source';
    assertOwnerUiProof(proof, action);
    const f = fields(body, ['requestKey'], kind === 'accept' ? ['previewId'] : []),
      key = requestKey(f.requestKey);
    if (kind === 'accept') {
      const cached = this.#previews.get(by.channel);
      if (
        !cached ||
        cached.id !== f.previewId ||
        cached.keyDigest !== key ||
        Date.now() < cached.createdAt ||
        Date.now() >= cached.createdAt + PREVIEW_MS
      )
        throw new PreparationError('sentinel.preparation.changed');
      return cached.binding;
    }
    const record = this.#journal.read(key);
    if (!record) throw new PreparationError('sentinel.preparation.unavailable');
    return this.#control(record, action, by).binding;
  }
  status(body: unknown, by: RequestedBy): CommandResult {
    this.#available();
    const f = fields(body, ['requestKey']),
      record = this.#journal.read(requestKey(f.requestKey));
    const facts = record ? this.#projection(record) : { schema: 'sentinel-preparation-status/draft-1', found: false };
    if (record && by.channel === 'local-service') {
      try {
        (facts as Record<string, unknown>).confirmation = {
          cancel: this.#control(record, 'run.cancel', by).binding,
          ...(record.checkpoint !== 'none' && this.#projection(record).phase === 'interrupted'
            ? { resume: this.#control(record, 'capture.source', by).binding }
            : {}),
        };
      } catch {
        /* status remains readable when current policy cannot confirm a control */
      }
    }
    return result('prepare', 'answered', { facts });
  }
  #projection(record: PreparationRecord): Record<string, unknown> {
    const live = this.#active?.record.prepId === record.prepId;
    const phase = !terminalPreparation(record) && !live ? 'interrupted' : record.phase;
    let availability: unknown[] = [];
    if (record.resolvedDigest) {
      const data = JSON.parse(this.#journal.readBundle(record, 'resolved').toString('utf8'));
      if (!Array.isArray(data.availability) || data.availability.length > 32) return invalid();
      availability = data.availability.map((a: any) => ({
        adapterId: a.adapterId,
        available: a.available,
        reasonCode: a.reasonCode,
      }));
    }
    const recordedRun = record.runId === null ? null : this.#store.ledger.getRun(record.runId);
    return {
      schema: 'sentinel-preparation-status/draft-1',
      found: true,
      availability,
      preparationId: record.prepId,
      phase,
      acceptedAt: record.acceptedAt,
      deadlineAt: record.deadlineAt,
      runDeadlineAt: record.runDeadlineAt,
      captured: record.checkpoint !== 'none',
      runId: recordedRun ? record.runId : null,
      preparedRevision: record.planRevision,
      checksStartedByPreparation: false,
      ...(record.errorCode && CODES.has(record.errorCode) ? { reasonCode: record.errorCode } : {}),
      ...(phase === 'interrupted'
        ? {
            resumeAvailable: record.checkpoint !== 'none' && Date.now() < Date.parse(record.runDeadlineAt),
            freshRequestRequired: record.checkpoint === 'none',
          }
        : {}),
    };
  }
  #update(active: Active, patch: Partial<PreparationRecord>): PreparationRecord {
    const old = active.record,
      next = {
        ...old,
        ...patch,
        ownerEpoch: this.#store.epoch,
        updatedAt: new Date().toISOString(),
        recordRevision: old.recordRevision + 1,
      };
    active.record = this.#journal.update(next, old.recordRevision);
    return active.record;
  }
  #request(
    preview: Preview,
    by: RequestedBy,
    receiptId: string | undefined,
    stillWithin: () => void,
  ): AdmissionRequest {
    const terms = preparationTerms(this.#store, preview.inputs, stillWithin);
    return {
      intent: preview.binding.intent,
      stateDigest: preview.binding.stateDigest,
      policy: terms.policy,
      requestedBy: receiptId ? requester(by) : by,
      now: new Date(),
      capability: () => ({
        available: true,
        detail: 'fixed local preparation recipe; optional scanner readiness is resolved after admission',
      }),
      credential: () => ({ basis: 'local-only', detail: 'no provider or acquisition is used' }),
    };
  }
  accept(body: unknown, by: RequestedBy): CommandResult {
    this.#available();
    if (this.#stopping) return invalid();
    this.#reconcile();
    const f = fields(body, ['previewId', 'requestKey'], ['receiptId']),
      keyDigest = requestKey(f.requestKey);
    if (f.receiptId !== undefined && ((by.channel !== 'local-service' && !uiFor(by)) || !ID.test(f.receiptId)))
      return invalid();
    const previous = this.#journal.read(keyDigest),
      cached = this.#previews.get(by.channel);
    if (previous) {
      if (cached && cached.id === f.previewId && cached.requestDigest !== previous.requestDigest)
        throw new PreparationError('sentinel.preparation.changed');
      // A read of an existing acceptance only: no receipt spending, capture, recovery or automatic replay.
      return result('prepare', 'kept', { facts: { ...this.#projection(previous), joined: true } });
    }
    if (
      !cached ||
      cached.id !== f.previewId ||
      cached.keyDigest !== keyDigest ||
      Date.now() >= cached.createdAt + PREVIEW_MS
    )
      throw new PreparationError('sentinel.preparation.changed');
    if (this.busy || this.#runBusy()) throw new PreparationError('sentinel.preparation.busy');
    const previewWithin = () => {
      this.#store.assertHeld();
      if (
        Date.now() < cached.createdAt ||
        Date.now() >= cached.createdAt + PREVIEW_MS ||
        performance.now() - cached.started >= PREVIEW_MS
      )
        throw new PreparationError('sentinel.preparation.changed');
    };
    assertPreparationInputs(this.#store, cached.inputs, previewWithin);
    if (cached.parent) {
      const actual = this.#store.ledger.getRun(cached.parent.runId),
        plan = this.#store.ledger.getPlan(cached.parent.runId, cached.parent.revision);
      if (
        !actual ||
        !['completed', 'canceled'].includes(actual.state) ||
        actual.planRevision !== cached.parent.revision ||
        actual.envelope.snapshotId !== cached.parent.snapshotId ||
        plan?.digest !== cached.parent.planDigest
      )
        throw new PreparationError('sentinel.preparation.changed');
    }
    const request = this.#request(cached, by, f.receiptId, previewWithin),
      preflight = decidePreparation(request);
    if (preflight.record.outcome === 'denied')
      return result('prepare', 'configuration-failure', {
        verdicts: printed(preflight.record),
        reasonCode: preflight.record.verdicts.policy.allowed
          ? preflight.record.verdicts.capability.reasonCode
          : preflight.record.verdicts.policy.reasonCode,
      });
    if (preflight.record.outcome === 'awaiting-confirmation' && !f.receiptId)
      return result('prepare', 'awaiting-confirmation', { verdicts: printed(preflight.record) });
    const book = bookFor(join(this.#ws.trustDir, 'receipts'), by);
    if (f.receiptId) book.check(f.receiptId, cached.binding, request.now);
    const all = this.#journal.list();
    if (all.filter(terminalPreparation).length >= PREPARATION_TERMINAL_LIMIT)
      throw new PreparationError('sentinel.preparation.retentionRequired');
    if (all.some((r) => !terminalPreparation(r))) throw new PreparationError('sentinel.preparation.busy');
    previewWithin();
    const acceptedAt = new Date().toISOString(),
      deadlineAt = new Date(Date.parse(acceptedAt) + PREPARATION_LIMIT_MS).toISOString(),
      abort = new AbortController();
    const clock = preparationClock(this.#store, { acceptedAt, deadlineAt }, abort.signal);
    let decision: PreparationDecision = preflight;
    const given: PreparationRecord = {
      schema: 'sentinel-preparation/1',
      prepId: `prep-${randomBytes(16).toString('hex')}`,
      requestKeyDigest: keyDigest,
      requestDigest: cached.requestDigest,
      storeId: this.#store.storeId,
      workspaceIdentity: canonicalDigest(workspaceIdentity(this.#ws.path)),
      createdEpoch: this.#store.epoch,
      ownerEpoch: this.#store.epoch,
      recordRevision: 1,
      phase: f.receiptId ? 'admitting' : 'accepted',
      checkpoint: 'none',
      mode: cached.parent ? 'retry' : 'workspace',
      parentId: cached.parent?.runId ?? null,
      parentRevision: cached.parent?.revision ?? null,
      parentPlanDigest: cached.parent?.planDigest ?? null,
      parentSnapshotId: cached.parent?.snapshotId ?? null,
      acceptedAt,
      deadlineAt,
      updatedAt: acceptedAt,
      runDeadlineAt: deadlineAt,
      configDigest: cached.inputs.digest,
      resolvedDigest: null,
      admissionDigest: f.receiptId ? null : canonicalDigest(preflight.record),
      resumeAdmissionDigest: null,
      snapshotId: null,
      runId: null,
      planRevision: null,
      planDigest: null,
      errorCode: null,
    };
    const active: Active = {
      record: this.#journal.create(given, preparationInputBytes(this.#store, cached.inputs)),
      inputs: cached.inputs,
      clock,
      abort,
      task: Promise.resolve(),
      stopping: false,
    };
    try {
      clock.stillWithin();
      assertPreparationInputs(this.#store, cached.inputs, () => clock.stillWithin());
      if (f.receiptId) {
        decision = decidePreparation(
          { ...request, now: new Date() },
          true,
          join(this.#ws.trustDir, 'receipts'),
          f.receiptId,
        );
        if (decision.record.outcome !== 'admitted' || !decision.receipt)
          throw new PreparationError('sentinel.preparation.invalid');
        clock.stillWithin();
        this.#update(active, { phase: 'accepted', admissionDigest: canonicalDigest(decision.record) });
      }
      this.#active = active;
      active.task = this.#run(active);
      return result('prepare', 'submitted', {
        verdicts: printed(decision.record),
        facts: this.#projection(active.record),
      });
    } catch (error) {
      this.#settled.add(active.record.prepId);
      try {
        this.#update(active, { phase: 'interrupted', errorCode: failure(error) });
      } catch {
        /* retain uncertain data; never repair or replay */
      }
      throw error;
    }
  }
  #control(record: PreparationRecord, action: 'capture.source' | 'run.cancel', by: RequestedBy, receiptId?: string) {
    const inputs = loadPolicyInputsReadOnly({ workspace: this.#ws.path, trustDir: this.#ws.trustDir });
    if (inputs.trust !== 'adopted') throw new PreparationError('sentinel.preparation.unavailable');
    const policy = effectivePolicy(inputs),
      stateDigest = canonicalDigest({
        store: this.#store.storeId,
        workspace: workspaceIdentity(this.#ws.path),
        record,
      });
    const recipe =
      action === 'capture.source'
        ? JSON.parse(this.#journal.readBundle(record, 'config').toString('utf8')).recipe
        : null;
    const effects: ActionIntent['effects'] = recipe?.requestedAdapters?.some(
      (id: string) => id !== FRAMEWORK_CONTROLS_ADAPTER_ID,
    )
      ? ['local-artifacts', 'tool-execution']
      : ['local-artifacts'];
    const intent: ActionIntent = {
      action,
      input: canonicalDigest({ schema: 'sentinel-preparation-control/1', action, stateDigest }),
      effects,
      budget: { maxTokens: null, maxCost: null, currency: null },
      scope: { profile: SCAN_PROFILE, provider: null, targets: [stateDigest] },
    };
    const binding = { intent, stateDigest, policyRevision: policy.revision };
    const request: AdmissionRequest = {
      intent,
      stateDigest,
      policy,
      requestedBy: receiptId ? requester(by) : by,
      now: new Date(),
      capability: () => ({ available: true, detail: 'control the exact retained preparation; never recapture it' }),
      credential: () => ({ basis: 'local-only', detail: 'no provider is used' }),
    };
    return { request, binding };
  }
  #controlPreflight(
    record: PreparationRecord,
    action: 'capture.source' | 'run.cancel',
    by: RequestedBy,
    receiptId?: string,
  ) {
    if (receiptId !== undefined && ((by.channel !== 'local-service' && !uiFor(by)) || !ID.test(receiptId)))
      return invalid();
    const { request, binding } = this.#control(record, action, by, receiptId),
      decision = decidePreparation(request);
    if (decision.record.outcome === 'denied')
      return {
        refusal: result('prepare', 'configuration-failure', {
          verdicts: printed(decision.record),
          reasonCode: decision.record.verdicts.policy.allowed
            ? decision.record.verdicts.capability.reasonCode
            : decision.record.verdicts.policy.reasonCode,
        }),
      };
    if (decision.record.outcome === 'awaiting-confirmation' && !receiptId)
      return { refusal: result('prepare', 'awaiting-confirmation', { verdicts: printed(decision.record) }) };
    const book = bookFor(join(this.#ws.trustDir, 'receipts'), by);
    if (receiptId) book.check(receiptId, binding, request.now);
    return { request, decision, book };
  }
  #write(record: PreparationRecord, patch: Partial<PreparationRecord>): PreparationRecord {
    return this.#journal.update(
      {
        ...record,
        ...patch,
        ownerEpoch: this.#store.epoch,
        updatedAt: new Date().toISOString(),
        recordRevision: record.recordRevision + 1,
      },
      record.recordRevision,
    );
  }
  cancel(body: unknown, by: RequestedBy): CommandResult {
    this.#available();
    if (this.#stopping) return invalid();
    this.#reconcile();
    const f = fields(body, ['requestKey'], ['receiptId']),
      record = this.#journal.read(requestKey(f.requestKey));
    if (!record) throw new PreparationError('sentinel.preparation.unavailable');
    if (terminalPreparation(record)) return result('prepare', 'kept', { facts: this.#projection(record) });
    const preflight = this.#controlPreflight(record, 'run.cancel', by, f.receiptId);
    if (preflight.refusal) return preflight.refusal;
    const decision = f.receiptId
      ? decidePreparation(
          { ...preflight.request!, now: new Date() },
          true,
          join(this.#ws.trustDir, 'receipts'),
          f.receiptId,
        )
      : preflight.decision!;
    if (decision.record.outcome !== 'admitted') throw new PreparationError('sentinel.preparation.invalid');
    const active = this.#active;
    if (active?.record.prepId === record.prepId) {
      active.abort.abort(new PreparationError('sentinel.preparation.canceled'));
      active.coordinator?.cancel();
    } else {
      if (record.ownerEpoch === this.#store.epoch) throw new PreparationError('sentinel.preparation.busy');
      this.#write(record, { phase: 'interrupted', errorCode: 'sentinel.preparation.canceled' });
    }
    return result('prepare', 'requested', {
      verdicts: printed(decision.record),
      facts: this.#projection(this.#journal.read(record.requestKeyDigest)!),
    });
  }
  async resume(body: unknown, by: RequestedBy, signal?: AbortSignal): Promise<CommandResult> {
    this.#available();
    if (this.#stopping) return invalid();
    this.#reconcile();
    const f = fields(body, ['requestKey'], ['receiptId']);
    let record = this.#journal.read(requestKey(f.requestKey));
    if (!record || record.checkpoint === 'none') throw new PreparationError('sentinel.preparation.unavailable');
    if (this.#active?.record.prepId === record.prepId)
      return result('prepare', 'kept', { facts: { ...this.#projection(record), joined: true } });
    if (this.busy || this.#runBusy()) throw new PreparationError('sentinel.preparation.busy');
    if (record.phase !== 'interrupted' && (terminalPreparation(record) || record.ownerEpoch === this.#store.epoch))
      throw new PreparationError('sentinel.preparation.unavailable');
    const abort = new AbortController(),
      cancel = () => abort.abort(new PreparationError('sentinel.preparation.canceled'));
    if (signal?.aborted) cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const clock = preparationClock(this.#store, record, abort.signal);
      const inputs = restorePreparationInputs(
        this.#store,
        { workspace: this.#ws.path, trustDir: this.#ws.trustDir, registry: this.#registry },
        this.#journal.readBundle(record, 'config'),
        this.#journal.readBundle(record, 'resolved'),
        clock,
      );
      const parent =
        record.parentId === null
          ? null
          : {
              runId: record.parentId,
              revision: record.parentRevision!,
              planDigest: record.parentPlanDigest!,
              snapshotId: record.parentSnapshotId!,
            };
      // Source/run closure proof is read-only before journal mutation. A later admission alone is never current.
      const identity = await resolvePreparationRun(this.#store, inputs, record.snapshotId!, clock, parent);
      clock.stillWithin();
      if (identity.snapshotId !== record.snapshotId && record.mode !== 'workspace')
        throw new PreparationError('sentinel.preparation.changed');
      if (
        this.busy ||
        this.#runBusy() ||
        this.#journal.read(record.requestKeyDigest)?.recordRevision !== record.recordRevision
      )
        throw new PreparationError('sentinel.preparation.changed');
      const preflight = this.#controlPreflight(record, 'capture.source', by, f.receiptId);
      if (preflight.refusal) return preflight.refusal;
      if (record.phase !== 'interrupted')
        record = this.#write(record, { phase: 'interrupted', errorCode: 'sentinel.preparation.canceled' });
      let pending = record;
      try {
        if (f.receiptId) pending = this.#write(record, { phase: 'resuming', resumeAdmissionDigest: null });
        clock.stillWithin();
        assertPreparationInputs(this.#store, inputs, () => clock.stillWithin());
        const decision = f.receiptId
          ? decidePreparation(
              { ...preflight.request!, now: new Date() },
              true,
              join(this.#ws.trustDir, 'receipts'),
              f.receiptId,
            )
          : preflight.decision!;
        if (decision.record.outcome !== 'admitted') throw new PreparationError('sentinel.preparation.invalid');
        clock.stillWithin();
        record = this.#write(pending, {
          phase: 'captured',
          resumeAdmissionDigest: canonicalDigest(decision.record),
          errorCode: null,
        });
        clock.stillWithin();
        // Acceptance is durable. Later socket cancellation/ACK loss cannot cancel the accepted owner task.
        signal?.removeEventListener('abort', cancel);
        const active: Active = { record, inputs, clock, abort, task: Promise.resolve(), stopping: false };
        this.#active = active;
        active.task = this.#run(active);
        return result('prepare', 'submitted', {
          verdicts: printed(decision.record),
          facts: this.#projection(active.record),
        });
      } catch (error) {
        this.#settled.add(record.prepId);
        try {
          const actual = this.#journal.read(record.requestKeyDigest);
          if (
            actual?.prepId === record.prepId &&
            actual.ownerEpoch === this.#store.epoch &&
            ['resuming', 'captured'].includes(actual.phase)
          )
            this.#write(actual, { phase: 'interrupted', errorCode: failure(error) });
        } catch {
          /* retain uncertainty */
        }
        throw error;
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  async #run(active: Active): Promise<void> {
    let lease: ScratchLease | undefined;
    const cancel = () => active.coordinator?.cancel();
    active.abort.signal.addEventListener('abort', cancel);
    const timer = setTimeout(
      () => active.abort.abort(new PreparationError('sentinel.preparation.expired')),
      Math.max(1, Date.parse(active.clock.runDeadlineAt) - Date.now()),
    );
    try {
      await yieldToLoop();
      active.clock.stillWithin();
      const resuming = active.record.phase === 'captured';
      if (!resuming) this.#update(active, { phase: 'discovering' });
      lease = openScratchLease(this.#store);
      active.clock.stillWithin();
      const resolved = await discoverPreparationProfile(
        this.#store,
        active.inputs,
        active.clock,
        lease,
        active.abort.signal,
      );
      active.clock.stillWithin();
      const resolvedDigest = resuming
        ? active.record.resolvedDigest!
        : this.#journal.writeResolved(active.record, preparationResolvedBytes(this.#store, resolved));
      // Write-once readiness is associated before any source capture. All original configuration remains equal.
      const parent =
        active.record.parentId === null
          ? null
          : {
              runId: active.record.parentId,
              revision: active.record.parentRevision!,
              planDigest: active.record.parentPlanDigest!,
              snapshotId: active.record.parentSnapshotId!,
            };
      let snapshotId: string;
      if (resuming) snapshotId = active.record.snapshotId!;
      else if (parent) {
        this.#update(active, {
          phase: 'captured',
          checkpoint: 'captured',
          snapshotId: parent.snapshotId,
          resolvedDigest,
        });
        snapshotId = parent.snapshotId;
      } else {
        this.#update(active, { phase: 'capturing', resolvedDigest });
        assertPreparationInputs(this.#store, resolved, () => active.clock.stillWithin());
        const captured = await captureWithBudget(
          this.#store,
          {
            mode: 'working-copy',
            sources: [{ sourceId: 'workspace', repositoryId: 'local-workspace', root: this.#ws.path }],
          },
          new GitReadBudget(),
          () => active.clock.stillWithin(),
          () => assertPreparationInputs(this.#store, resolved, () => active.clock.stillWithin()),
        );
        active.clock.stillWithin();
        snapshotId = captured.snapshot.id;
        this.#update(active, { phase: 'captured', snapshotId, checkpoint: 'captured' });
      }
      const identity = await resolvePreparationRun(this.#store, resolved, snapshotId, active.clock, parent);
      active.clock.stillWithin();
      const existing = existingPreparationAnalysis(this.#store, identity);
      if (existing) {
        // Preserve journal moves while disclosing already admitted state; no coordinator or plan write runs.
        this.#update(active, {
          phase: 'bootstrapping',
          checkpoint: 'bootstrapping',
          runId: identity.runId,
          runDeadlineAt: existing.runDeadlineAt,
        });
        existingPreparationAnalysis(this.#store, identity);
        this.#update(active, {
          phase: 'prepared',
          runId: identity.runId,
          planRevision: existing.revision,
          planDigest: existing.digest,
          runDeadlineAt: existing.runDeadlineAt,
          errorCode: 'sentinel.preparation.alreadyPrepared',
        });
        return;
      }
      // Same inventory may name an existing run. Its original snapshot/deadline stay authoritative; this
      // preparation retains its newly admitted capture as unused evidence and never relabels either snapshot.
      const reused = identity.snapshotId !== active.record.snapshotId;
      this.#update(active, {
        phase: 'bootstrapping',
        checkpoint: 'bootstrapping',
        runId: identity.runId,
        runDeadlineAt: active.clock.runDeadlineAt,
      });
      const prepared = await planPreparedWorkspaceCanonical(this.#store, identity, {
        scratchRoot: lease.path,
        wrapRunner: lease.wrapRunner,
        onCoordinator: (coordinator) => {
          active.coordinator = coordinator;
          if (active.abort.signal.aborted) coordinator.cancel();
        },
      });
      active.clock.stillWithin();
      this.#update(active, {
        phase: 'prepared',
        runId: prepared.disclosure.runId,
        planRevision: prepared.disclosure.revision,
        planDigest: prepared.disclosure.planDigest,
        runDeadlineAt: active.clock.runDeadlineAt,
        errorCode: reused ? 'sentinel.preparation.alreadyPrepared' : null,
      });
    } catch (error) {
      const phase = active.stopping
        ? 'interrupted'
        : active.abort.signal.aborted && active.abort.signal.reason?.code !== 'sentinel.preparation.expired'
          ? 'canceled'
          : 'failed';
      try {
        this.#update(active, { phase, errorCode: failure(error) });
      } catch {
        /* no unsafe repair/deletion if ownership or journal publication is uncertain */
      }
    } finally {
      clearTimeout(timer);
      active.abort.signal.removeEventListener('abort', cancel);
      if (lease) {
        try {
          releaseScratchLease(this.#store, lease);
        } catch {
          /* retain unknown/live consumers */
        }
      }
      this.#settled.add(active.record.prepId);
      if (this.#active === active) this.#active = undefined;
      this.#finished();
    }
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    const active = this.#active;
    if (!active) return;
    active.stopping = true;
    active.abort.abort();
    active.coordinator?.cancel();
    await active.task;
  }
}
