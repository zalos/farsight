import { assertNativeClaudeReviewEnabled } from '../review/providers/selection.js';
import { ProviderError } from '../review/providers/errors.js';
// The owner's background service: one process that holds a workspace's store, answers its private local socket and
// runs plans in the background, so a run survives the command that started it. It is started by the owner (`serve`,
// or `run --detach` starting it on demand) and runs as the owner's own account, but it grants nothing to the
// connections it answers: every client, the owner's own CLI included, is an agent on a service channel (actor.ts).
//
// Authority to start, resume, pause or cancel a run reaches the service in exactly two ways:
//   - an owner receipt, issued by the owner's own CLI process after its --confirm (local.ts confirmForService),
//     bound to that action, the plan's digest and the adopted policy revision, and spent here once;
//   - the adopted grants, through admission with the connection's own requester: an agent gets what they give agents.
// Pause and cancel are writes too, decided the same way with their own actions (`run.pause`, `run.cancel`): a
// receipt for one is never a receipt for another. Status, wait and report read.
//
// A start of a plan with model stages needs the owner's composite confirmation: the start receipt (bound to the plan
// digest, its stages and each model binding with its budget) and one receipt for each model envelope the run opens,
// all issued by the owner's own CLI in one --confirm (local.ts confirmForService). The service checks every envelope
// receipt before it spends the start receipt and hands each to the run only for the exact envelope it was issued for;
// it never issues an owner receipt itself, and a start without them opens no envelope (ADR 48, as amended).
//
// One run executes at a time. A second start for the plan being run joins it (one run, never two); a start for a run
// that already finished prints its result again without executing anything. A run interrupted by the service
// stopping, however it stopped, is recovered by the coordinator when it is resumed.
import { OwnerUiOperations, ownerUiPolicy } from '../owner-ui/operations.js';
import { activeOwnerUiProof, assertOwnerUiProof } from '../owner-ui/authority.js';
import { OwnerUiReceiptBook } from '../owner-ui/receipts.js';
import { admitOwnerUi } from '../policy/admission.js';
import { unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openScratchLease, releaseScratchLease, type ScratchLease } from './scratch-lease.js';
import { Coordinator } from '../execution/coordinator.js';
import type { AdapterRegistry } from '../execution/registry.js';
import type { RunEnvelope } from '../contracts/run.js';
import type { ActionIntent } from '../contracts/policy.js';
import { admit, effectivePolicy, loadPolicyInputs, PolicyError } from '../policy/index.js';
import { readPrivateFile, writePrivateFileAtomic } from '../policy/user-state.js';
import { openStore, type SentinelStore } from '../store/index.js';
import type { RequestedBy } from '../cli/actor.js';
import { result, type CommandResult, type PrintedVerdicts } from '../cli/outcome.js';
import {
  checkAddress,
  connectOwnerSocket,
  IpcError,
  listenOwnerSocket,
  newOwnerNonce,
  runtimeAddress,
  type RuntimeAddress,
  type ServiceClient,
} from '../transport/ipc.js';
import {
  adoptedPolicy,
  isFinalRunState,
  runWriteBinding,
  printed,
  receiptBook,
  retainedFact,
  runStateIn,
  checkWorkspaceLayout,
  writeWorkspacePipeline,
  type Workspace,
} from './local.js';
import { assertSupportedRules, canonicalResult, currentPlan, rerunEnvelopeOf, type CurrentPlan } from './canonical.js';
import { loadPlan } from '../execution/plans.js';
import { publicRegistry, scannerExecution } from './scanner-profile.js';
import { ReadonlyViews, READONLY_OPERATIONS } from './readonly.js';
import { controlCapabilities } from './controls.js';
import { PreparationController } from './preparation-controller.js';
import { PreparationError } from './preparation-clock.js';
import { recordRunFailure, runFailureCode } from './run-failure.js';
import { compositeReviewRuntime, envelopeBinding, OWNER as OWNER_REQUESTER, type ModelAuthority } from './local.js';
import { bindProvider } from '../review/providers/profile.js';
import type { ReceiptBook } from '../policy/index.js';
import type { ReviewRuntime } from '../review/dispatch.js';
import { HeldSentinelService } from '../app/service.js';
import { agentPrincipal } from '../app/principal.js';

export type ServiceErrorCode =
  | 'sentinel.service.unknownOperation'
  | 'sentinel.service.requestInvalid'
  | 'sentinel.service.planUnknown'
  | 'sentinel.service.planChanged'
  | 'sentinel.service.alreadyServing'
  | 'sentinel.service.startFailed'
  | 'sentinel.service.recordUnsafe'
  | 'sentinel.service.lockChanged'
  | 'sentinel.service.packUnavailable'
  | 'sentinel.service.noRuleLock'
  | 'sentinel.service.bootstrapFailed'
  | 'sentinel.service.ruleUnsupported'
  | 'sentinel.service.runNotExecutable';

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    readonly facts: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = 'ServiceError';
  }
}

interface ActiveRun {
  readonly planId: string;
  coordinator?: Coordinator;
  pause: boolean;
  cancel: boolean;
  task: Promise<void>;
  /** Settles once the coordinator is open (the run is accepted) or could not be (nothing was accepted). */
  opened: Promise<{ error: string; reason?: string } | undefined>;
  /** Why the run could not be executed, when it could not. */
  error?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_WAIT_MS = 25_000;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const codeOf = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('sentinel.') ? code : 'sentinel.service.executionFailed';
};
const failureOf = (e: unknown): { error: string; reason?: string } => {
  const reason = (e as { detail?: { reason?: unknown } })?.detail?.reason;
  return { error: codeOf(e), ...(typeof reason === 'string' ? { reason } : {}) };
};

/** Reads one request body: an object with exactly the named fields, each an id (or a bounded integer). */
function fields(
  body: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, string | number> {
  if (!isRecord(body)) throw new ServiceError('sentinel.service.requestInvalid');
  const allowed = new Set([...required, ...optional]);
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) throw new ServiceError('sentinel.service.requestInvalid');
    if (typeof v === 'string' ? !ID.test(v) : !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))
      throw new ServiceError('sentinel.service.requestInvalid');
    out[k] = v as string | number;
  }
  for (const k of required) if (typeof out[k] !== 'string') throw new ServiceError('sentinel.service.requestInvalid');
  return out;
}

const RECEIPT_VERDICTS: PrintedVerdicts = Object.freeze({
  policy: Object.freeze({ allowed: true, asked: true, reasonCode: 'sentinel.service.ownerReceipt' }),
  capability: Object.freeze({ allowed: true, asked: true, reasonCode: 'sentinel.admission.capabilityAvailable' }),
  credential: Object.freeze({ allowed: true, asked: true, reasonCode: 'sentinel.admission.credentialLocalOnly' }),
});

export interface OwnerServiceOptions {
  /** Internal test seam: explicit trusted drivers for a supplied synthetic registry, never request data. */
  readonly drivers?: import('../execution/check-drivers.js').CheckDriverRegistry;
  /** The trusted registry runs execute under; the shipped one by default. A test passes its own. */
  readonly registry?: AdapterRegistry;
  /** A run the ledger does not hold yet, recorded by its first execution (test seam; `plan` records production runs). */
  readonly runEnvelope?: (runId: string) => RunEnvelope | undefined;
  readonly now?: () => Date;
}

/** The service's operations over a store this process holds. The socket and the process around it are serveWorkspace's. */
export class OwnerService {
  readonly #ownerUi: OwnerUiOperations;
  readonly #store: SentinelStore;
  readonly #ws: Workspace;
  readonly #registry: AdapterRegistry;
  readonly #drivers?: import('../execution/check-drivers.js').CheckDriverRegistry;
  readonly #runEnvelope: (runId: string) => RunEnvelope | undefined;
  readonly #now: () => Date;
  readonly #active = new Map<string, ActiveRun>();
  /** The last error each run met in this service, kept after its task ended (until a later launch succeeds). */
  readonly #lastError = new Map<string, string>();
  /** Runs whose scratch lease was retained because a consumer was not proven stopped (scratch-lease.ts). */
  readonly #scratchRetained = new Map<string, ReturnType<typeof retainedFact>>();
  readonly #reads: ReadonlyViews;
  readonly #preparations: PreparationController;
  #idleSince = Date.now();
  #stopping = false;
  /** A plan this service is capturing and bootstrapping now: one at a time, never beside a run. */
  #planning = false;
  /** The facade over the store this service holds, for its connections (app/service.ts). */
  readonly #facade: HeldSentinelService;

  constructor(store: SentinelStore, ws: Workspace, options: OwnerServiceOptions = {}) {
    this.#store = store;
    this.#ws = ws;
    this.#registry = options.registry ?? publicRegistry(ws.trustDir);
    this.#drivers = options.drivers;
    this.#runEnvelope = options.runEnvelope ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
    this.#reads = new ReadonlyViews(store, ws, this.#now);
    this.#ownerUi = new OwnerUiOperations(
      store,
      ws,
      (op, body, by, context) => this.handle(op, body, by, context),
      (kind, body, by) => this.#preparations.ownerUiConfirmation(kind, body, by),
    );
    this.#facade = new HeldSentinelService(store, ws, {
      executing: (runId) => this.#active.has(runId),
      registry: () => this.#registry,
    });
    this.#preparations = new PreparationController(
      store,
      ws,
      this.#registry,
      () => this.#active.size > 0 || this.#planning,
      () => {
        this.#idleSince = Date.now();
      },
    );
  }

  /** True while a run executes. */
  get busy(): boolean {
    return this.#active.size > 0 || this.#preparations.busy || this.#planning;
  }
  /** Bounded unexpired buffers keep a detached owner alive, without renewing their absolute TTLs. */
  get retainingReads(): boolean {
    return this.#reads.retaining || this.#ownerUi.retaining;
  }
  /** When the last run ended (or the service started), for the idle stop. */
  get idleSince(): number {
    return this.#idleSince;
  }

  /** One request, from a connection whose requester the transport fixed. Returns a typed command result. */
  async handle(
    op: string,
    body: unknown,
    by: RequestedBy,
    context: { readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    // The owner's channel never arrives here: every connection is a service client (transport/ipc.ts).
    if (by.channel === 'owner-cli') throw new ServiceError('sentinel.service.requestInvalid');
    if (op === 'service.review-capabilities')
      return this.#ownerUi.handle('owner-ui.review-capabilities', body, by, context);
    if (op === 'service.owner-ui-capabilities') {
      fields(body, []);
      return this.#ownerUi.capabilities();
    }
    if (op.startsWith('owner-ui.')) {
      if (this.#stopping) throw new ServiceError('sentinel.service.requestInvalid');
      return this.#ownerUi.handle(op, body, by, context);
    }
    if ((READONLY_OPERATIONS as readonly string[]).includes(op)) {
      if (this.#stopping) throw new ServiceError('sentinel.service.requestInvalid');
      switch (op) {
        case 'service.capabilities':
          fields(body, []);
          return this.#reads.capabilities();
        case 'run.inspect':
          return this.#reads.inspect(body, by.channel, context.signal);
        case 'view.page':
          return this.#reads.page(body, by.channel);
        case 'report.open':
          return this.#reads.report(body, by.channel, context.signal);
        case 'delivery.read':
          return this.#reads.read(body, by.channel);
      }
    }
    switch (op) {
      case 'service.preparation-capabilities':
        fields(body, []);
        return this.#preparations.capabilities();
      case 'configuration.preview':
        return this.#preparations.preview(body, by);
      case 'prepare.status':
        return this.#preparations.status(body, by);
      case 'prepare.cancel':
        return this.#preparations.cancel(body, by);
      case 'prepare.resume': {
        if (context.signal?.aborted) throw new PreparationError('sentinel.preparation.canceled');
        return this.#preparations.resume(body, by, context.signal);
      }
      case 'prepare.accept': {
        if (context.signal?.aborted) throw new PreparationError('sentinel.preparation.canceled');
        return this.#preparations.accept(body, by);
      }
      case 'service.control-capabilities': {
        fields(body, []);
        return controlCapabilities(this.#store.storeId, this.#store.epoch);
      }
      case 'service.info': {
        fields(body, []);
        return {
          storeId: this.#store.storeId,
          epoch: this.#store.epoch,
          pid: process.pid,
          active: [...this.#active.keys()],
          ...(this.#scratchRetained.size ? { scratchRetained: Object.fromEntries(this.#scratchRetained) } : {}),
        };
      }
      case 'run.start': {
        // `envelopeReceipts`: the owner's receipts for the model envelopes, beside the start's own (at most 32 ids).
        const { envelopeReceipts, ...rest } = isRecord(body) ? body : ({} as Record<string, unknown>);
        if (
          envelopeReceipts !== undefined &&
          !(
            Array.isArray(envelopeReceipts) &&
            envelopeReceipts.length >= 1 &&
            envelopeReceipts.length <= 32 &&
            envelopeReceipts.every((x) => typeof x === 'string' && ID.test(x)) &&
            new Set(envelopeReceipts).size === envelopeReceipts.length
          )
        )
          throw new ServiceError('sentinel.service.requestInvalid');
        const f = fields(isRecord(body) ? rest : body, ['planId'], ['receiptId']);
        return this.#start(
          f.planId as string,
          f.receiptId as string | undefined,
          by,
          envelopeReceipts as readonly string[] | undefined,
        );
      }
      case 'run.status': {
        // Without a run id: the newest scan's (app/service.ts).
        const f = fields(body, [], ['runId', 'after', 'limit']);
        return this.#facade.status(agentPrincipal(by), {
          ...(f.runId === undefined ? {} : { runId: f.runId as string }),
          ...(f.after === undefined ? {} : { after: f.after as number }),
          ...(f.limit === undefined ? {} : { limit: f.limit as number }),
        });
      }
      case 'scans': {
        const f = fields(body, [], ['limit']);
        return this.#facade.scans(agentPrincipal(by), f.limit === undefined ? {} : { limit: f.limit as number });
      }
      case 'stage.read': {
        const f = fields(body, ['stageId'], ['runId']);
        return this.#facade.stage(agentPrincipal(by), {
          stageId: f.stageId as string,
          ...(f.runId === undefined ? {} : { runId: f.runId as string }),
        });
      }
      case 'start.preview': {
        // The composite a start of the run confirms (U-3's preview): read only, nothing issued or spent.
        const f = fields(body, [], ['runId']);
        return this.#facade.startPreview(agentPrincipal(by), {
          ...(f.runId === undefined ? {} : { runId: f.runId as string }),
          now: this.#now(),
        });
      }
      case 'scan': {
        // What a scan would run, for a connection to read; a connection never confirms one (`confirm` is refused
        // as owner-only, with nothing captured, admitted or opened).
        if (
          !isRecord(body) ||
          Object.keys(body).some((k) => k !== 'confirm') ||
          !(body.confirm === undefined || typeof body.confirm === 'boolean')
        )
          throw new ServiceError('sentinel.service.requestInvalid');
        return this.#facade.scan(agentPrincipal(by), { confirm: body.confirm === true, now: this.#now() });
      }
      case 'plan': {
        // Capture and plan in the store this service holds, on the owner's receipt for exactly that capture here
        // (local.ts confirmPlanForService), spent once; never beside a run, a preparation or another plan.
        if (this.#stopping) throw new ServiceError('sentinel.service.requestInvalid');
        const f = fields(body, [], ['receiptId']);
        if (this.#planning || this.#active.size > 0 || this.#preparations.busy)
          return result('plan', 'configuration-failure', { reasonCode: 'sentinel.service.anotherRunActive' });
        this.#planning = true;
        try {
          return await this.#facade.plan(agentPrincipal(by), {
            confirm: false,
            ...(f.receiptId === undefined ? {} : { receiptId: f.receiptId as string }),
            now: this.#now(),
          });
        } finally {
          this.#planning = false;
          this.#idleSince = Date.now();
        }
      }
      case 'run.wait': {
        const f = fields(body, ['runId'], ['timeoutMs']);
        return this.#wait(
          f.runId as string,
          Math.min(typeof f.timeoutMs === 'number' ? f.timeoutMs : MAX_WAIT_MS, MAX_WAIT_MS),
        );
      }
      case 'run.pause': {
        const f = fields(body, ['runId'], ['receiptId']);
        return this.#pause(f.runId as string, f.receiptId as string | undefined, by);
      }
      case 'run.cancel': {
        const f = fields(body, ['runId'], ['receiptId']);
        return this.#cancel(f.runId as string, f.receiptId as string | undefined, by);
      }
      case 'run.describe': {
        // The run's current admitted revision, which the owner's CLI confirms a write against. Reads only.
        const f = fields(body, ['runId']);
        return (await currentPlan(this.#store, f.runId as string)) ?? null;
      }
      case 'report': {
        const f = fields(body, [], ['runId']);
        return this.#facade.report(agentPrincipal(by), {
          ...(f.runId === undefined ? {} : { runId: f.runId as string }),
          now: this.#now(),
        });
      }
      case 'pipeline.write': {
        // Validate, preview and, with the owner's receipt for exactly these bytes, write the workspace's pipeline file;
        // never adopt, never run. Writing is the owner action `settings.adopt`: without a receipt, admission decides,
        // and no grant gives an owner action to an agent, so a service client alone is refused.
        if (this.#stopping) throw new ServiceError('sentinel.service.requestInvalid');
        if (
          !isRecord(body) ||
          Object.keys(body).some((k) => k !== 'pipeline' && k !== 'expectDigest' && k !== 'receiptId') ||
          !isRecord(body.pipeline) ||
          !(body.expectDigest === null || (typeof body.expectDigest === 'string' && DIGEST.test(body.expectDigest))) ||
          !(body.receiptId === undefined || (typeof body.receiptId === 'string' && ID.test(body.receiptId)))
        )
          throw new ServiceError('sentinel.service.requestInvalid');
        const receiptId = body.receiptId as string | undefined;
        return writeWorkspacePipeline(this.#ws, body.pipeline, body.expectDigest as string | null, (binding) =>
          this.#authorizeOwnerWrite('pipeline.write', binding, receiptId, by),
        );
      }
      default:
        throw new ServiceError('sentinel.service.unknownOperation');
    }
  }

  /**
   * Decides one owner-action write that is not on a run (a pipeline file): the owner's receipt for exactly this
   * binding under the current policy, spent once; otherwise admission with the connection's own requester, which no
   * grant passes for an owner action. Being connected grants nothing. The owner's receipt is the CLI's, or, on the
   * paired browser's live proof, its own `settings.adopt` receipt for exactly these bytes (U-3): writing only; the
   * file is adopted by the CLI owner alone.
   */
  #authorizeOwnerWrite(
    command: string,
    binding: { intent: ActionIntent; stateDigest: string },
    receiptId: string | undefined,
    by: RequestedBy,
  ): { refusal: CommandResult } | { facts: Record<string, unknown> } {
    const adopted = adoptedPolicy(this.#ws);
    const policy =
      'policy' in adopted
        ? adopted.policy
        : effectivePolicy(loadPolicyInputs({ workspace: this.#ws.path, trustDir: this.#ws.trustDir }));
    const now = this.#now();
    const uiProof = by.channel === 'owner-ui' ? activeOwnerUiProof() : null;
    if (receiptId !== undefined && uiProof) {
      // The paired browser's receipt, checked by its own book under the live proof: the same shape the composite
      // start's owner-UI envelope receipts use. An unknown, spent, mismatched or uncovered one refuses.
      try {
        const spent = new OwnerUiReceiptBook(join(this.#ws.trustDir, 'receipts'), uiProof).consume(
          receiptId,
          { ...binding, policyRevision: policy.revision },
          now,
        );
        return { facts: { receipt: spent.digest, receiptIssuer: 'owner-ui' } };
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        return {
          refusal: result(command, 'configuration-failure', {
            reasonCode: typeof code === 'string' && code.startsWith('sentinel.') ? code : 'sentinel.receipt.mismatch',
          }),
        };
      }
    }
    if (receiptId !== undefined) {
      try {
        const spent = receiptBook(this.#ws).consume(receiptId, { ...binding, policyRevision: policy.revision }, now);
        return { facts: { receipt: spent.digest } };
      } catch (e) {
        if (!(e instanceof PolicyError)) throw e;
        return { refusal: result(command, 'configuration-failure', { reasonCode: e.code }) };
      }
    }
    const decision = admit({
      ...binding,
      requestedBy: by,
      policy,
      now,
      capability: () => ({ available: true, detail: 'writes one file in this workspace; runs nothing' }),
      credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
    }).record;
    if (decision.outcome === 'admitted') return { facts: {} };
    return {
      refusal: result(
        command,
        decision.outcome === 'awaiting-confirmation' ? 'awaiting-confirmation' : 'configuration-failure',
        {
          verdicts: printed(decision),
          reasonCode: decision.verdicts.policy.reasonCode,
          facts: { intentDigest: decision.intentDigest },
        },
      ),
    };
  }

  /**
   * Decides one write on a plan's run: the owner's receipt for exactly this action, plan digest and policy revision,
   * spent once, or else admission with the connection's own requester under the adopted grants. Being connected
   * grants nothing; there is no service bypass.
   */
  async #authorize(
    command: string,
    action: 'run.start' | 'run.pause' | 'run.cancel',
    planId: string,
    receiptId: string | undefined,
    by: RequestedBy,
    envelopeReceipts?: readonly string[],
  ): Promise<
    { verdicts: PrintedVerdicts; facts: Record<string, unknown>; models?: ModelAuthority } | { refusal: CommandResult }
  > {
    const facts: Record<string, unknown> = { planId };
    // The run's current admitted analysis revision, read back from the ledger and verified: what the write acts on.
    const record = await currentPlan(this.#store, planId);
    if (!record || record.kind !== 'analysis')
      return {
        refusal: result(command, 'configuration-failure', { reasonCode: 'sentinel.service.planUnknown', facts }),
      };
    const uiProof = by.channel === 'owner-ui' ? activeOwnerUiProof() : null;
    const adopted = uiProof ? ownerUiPolicy(this.#ws) : adoptedPolicy(this.#ws);
    if ('refusal' in adopted) return { refusal: adopted.refusal };
    const { policy } = adopted;
    if (policy.revision !== record.policyRevision)
      return {
        refusal: result(command, 'configuration-failure', { reasonCode: 'sentinel.service.policyChanged', facts }),
      };
    if (action === 'run.start') {
      const admitted = await loadPlan(this.#store, planId, record.revision);
      try {
        for (const unit of admitted.plan.units)
          if (unit.review) assertNativeClaudeReviewEnabled(policy, unit.review.selection.providerId);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        return { refusal: result(command, 'configuration-failure', { reasonCode: error.code, facts }) };
      }
    }
    const now = this.#now();
    // A start that calls models: only with the owner's composite confirmation, every envelope receipt checked here
    // before the start receipt is spent. Without it nothing is spent and no envelope can open.
    let models: ModelAuthority | undefined;
    if (
      action === 'run.start' &&
      record.effects.includes('paid-inference') &&
      !['completed', 'canceled'].includes(this.#store.ledger.getRun(planId)?.state ?? '')
    ) {
      if (receiptId === undefined || !envelopeReceipts?.length)
        return {
          refusal: result(command, 'configuration-failure', {
            reasonCode: 'sentinel.review.foregroundRequired',
            facts,
          }),
        };
      const checked = this.#modelAuthority(record, policy, envelopeReceipts, uiProof, now);
      if ('refusal' in checked)
        return { refusal: result(command, 'configuration-failure', { reasonCode: checked.refusal, facts }) };
      models = checked.models;
    }
    // The write is on this workspace's store and this run: a receipt confirmed for another instance does not match.
    const { intent, stateDigest } = runWriteBinding(this.#ws, action, record, {
      storeId: this.#store.storeId,
      runId: planId,
    });
    facts.effects = intent.effects;
    if (receiptId !== undefined && uiProof) {
      assertOwnerUiProof(uiProof, action);
      const decision = admitOwnerUi(
        {
          intent,
          stateDigest,
          policy,
          requestedBy: uiProof.requestedBy,
          now,
          capability: () => ({
            available: true,
            detail: 'implemented deterministic service control; excludes model authority',
          }),
          credential: () => ({ basis: 'local-only', detail: 'no provider/model admission is included' }),
          receipt: { book: new OwnerUiReceiptBook(join(this.#ws.trustDir, 'receipts'), uiProof), id: receiptId },
        },
        uiProof,
        true,
      );
      if (decision.record.outcome !== 'admitted')
        return {
          refusal: result(command, 'configuration-failure', {
            verdicts: printed(decision.record),
            reasonCode: decision.record.verdicts.policy.reasonCode,
          }),
        };
      return {
        verdicts: printed(decision.record),
        facts: { ...facts, receipt: decision.receipt?.digest },
        ...(models ? { models } : {}),
      };
    }
    if (receiptId !== undefined) {
      // The owner's receipt: checked against exactly this action, plan digest and policy revision, and spent once.
      // What the connection said about itself plays no part; an unknown, spent, expired or mismatched one refuses.
      try {
        const spent = receiptBook(this.#ws).consume(
          receiptId,
          { intent, stateDigest, policyRevision: policy.revision },
          now,
        );
        return {
          verdicts: RECEIPT_VERDICTS,
          facts: { ...facts, receipt: spent.digest },
          ...(models ? { models } : {}),
        };
      } catch (e) {
        if (!(e instanceof PolicyError)) throw e;
        return { refusal: result(command, 'configuration-failure', { reasonCode: e.code, facts }) };
      }
    }
    const decision = admit({
      intent,
      requestedBy: by,
      policy,
      stateDigest,
      now,
      capability: () => ({ available: true, detail: 'built into this installation; runs locally' }),
      credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
    }).record;
    const verdicts = printed(decision);
    if (decision.outcome === 'awaiting-confirmation')
      return { refusal: result(command, 'awaiting-confirmation', { verdicts, facts }) };
    if (decision.outcome !== 'admitted') {
      const v = decision.verdicts;
      return {
        refusal: result(command, 'configuration-failure', {
          verdicts,
          facts,
          reasonCode: v.policy.allowed
            ? v.capability.allowed
              ? v.credential.reasonCode
              : v.capability.reasonCode
            : v.policy.reasonCode,
        }),
      };
    }
    return { verdicts, facts };
  }

  /**
   * The model envelopes of a start, matched to the owner's receipts: the run's one binding is resolved again under the
   * current policy and must be the admitted one; each envelope then needs exactly one receipt that the book checks
   * against exactly that envelope (`book.check`, nothing spent), and every receipt given must fit an envelope.
   */
  #modelAuthority(
    record: CurrentPlan,
    policy: import('../policy/index.js').EffectivePolicy,
    envelopeReceipts: readonly string[],
    uiProof: ReturnType<typeof activeOwnerUiProof>,
    now: Date,
  ): { models: ModelAuthority } | { refusal: string } {
    if (record.modelConflict || !record.model?.modelId) return { refusal: 'sentinel.provider.bindingChanged' };
    let binding;
    try {
      binding = bindProvider(policy, record.model.providerId, record.model.modelId);
    } catch {
      return { refusal: 'sentinel.provider.bindingChanged' };
    }
    if (binding.digest !== record.model.bindingDigest) return { refusal: 'sentinel.provider.bindingChanged' };
    const envelope = envelopeBinding(binding, record, this.#store.storeId, policy.revision, record.model.budget);
    // The owner's own CLI receipts, or (U-3) the paired browser's under its live proof; the requester is the issuer's.
    const book: { check: ReceiptBook['check'] } = uiProof
      ? new OwnerUiReceiptBook(join(this.#ws.trustDir, 'receipts'), uiProof)
      : receiptBook(this.#ws);
    // A receipt the book cannot check for this envelope (unknown, spent, expired, another binding, or an owner-UI proof
    // that does not cover the action) fits nothing: refused below, never an error that leaves the start half-decided.
    const fits = envelopeReceipts.filter((id) => {
      try {
        book.check(id, envelope, now);
        return true;
      } catch {
        return false;
      }
    });
    if (fits.length !== 1 || envelopeReceipts.length !== 1) return { refusal: 'sentinel.receipt.mismatch' };
    return {
      models: Object.freeze({
        book,
        receipts: new Map([[envelope.stateDigest, fits[0]!]]),
        requestedBy: uiProof ? uiProof.requestedBy : OWNER_REQUESTER,
      }),
    };
  }

  async #start(
    planId: string,
    receiptId: string | undefined,
    by: RequestedBy,
    envelopeReceipts?: readonly string[],
  ): Promise<CommandResult> {
    const decided = await this.#authorize('run', 'run.start', planId, receiptId, by, envelopeReceipts);
    if ('refusal' in decided) return decided.refusal;
    const { verdicts, facts } = decided;
    // One run per plan: a second start joins the run already executing, once it is accepted.
    const active = this.#active.get(planId);
    if (active) {
      const failed = await active.opened;
      if (failed) return this.#notAccepted('run', planId, failed, verdicts, facts);
      return result('run', 'submitted', {
        verdicts,
        facts: { ...facts, runId: planId, joined: true, state: runStateIn(this.#store, planId) },
      });
    }
    if (this.#stopping || this.#active.size > 0 || this.#preparations.busy || this.#planning)
      return result('run', 'configuration-failure', {
        verdicts,
        facts,
        reasonCode: 'sentinel.service.anotherRunActive',
      });
    if (isFinalRunState(runStateIn(this.#store, planId)))
      return canonicalResult(this.#store, 'run', planId, {
        executing: false,
        verdicts,
        facts,
        registry: this.#registry,
        trustDir: this.#ws.trustDir,
      });
    // Accepted only once the coordinator has opened the admitted revision under this installation's registry: a plan
    // this installation cannot execute is refused here, with why, never answered `submitted` and left looking queued.
    const failed = await this.#launch(planId, { pause: false, cancel: false }, decided.models).opened;
    if (failed) return this.#notAccepted('run', planId, failed, verdicts, facts);
    return result('run', 'submitted', {
      verdicts,
      facts: { ...facts, runId: planId, joined: false, state: runStateIn(this.#store, planId) },
    });
  }

  #notAccepted(
    command: string,
    runId: string,
    failed: { error: string; reason?: string },
    verdicts: PrintedVerdicts,
    facts: Record<string, unknown>,
  ): CommandResult {
    return result(command, 'configuration-failure', {
      verdicts,
      reasonCode: 'sentinel.service.runNotExecutable',
      facts: { ...facts, runId, ...failed, state: runStateIn(this.#store, runId) },
    });
  }

  #launch(planId: string, flags: { pause: boolean; cancel: boolean }, models?: ModelAuthority): ActiveRun {
    let settle!: (v: { error: string; reason?: string } | undefined) => void;
    const run: ActiveRun = {
      planId,
      ...flags,
      task: Promise.resolve(),
      opened: new Promise((r) => {
        settle = r;
      }),
    };
    this.#active.set(planId, run);
    run.task = (async () => {
      let lease: ScratchLease | undefined;
      let review: (ReviewRuntime & { close(): void }) | undefined;
      try {
        lease = openScratchLease(this.#store);
        const scratch = lease.path;
        // The coordinator executes the run's current admitted revision, under this service's trusted registry.
        const first = this.#store.ledger.getRun(planId)
          ? undefined
          : (this.#runEnvelope(planId) ?? (await rerunEnvelopeOf(this.#store, planId)));
        const admitted = await currentPlan(this.#store, planId);
        if (admitted) assertSupportedRules((await loadPlan(this.#store, planId, admitted.revision)).plan);
        const assets = this.#drivers
          ? { drivers: this.#drivers }
          : await scannerExecution(this.#store, planId, this.#ws.trustDir, scratch, this.#registry, lease.wrapRunner);
        // The model runtime exists only for a start the owner confirmed as a composite: each envelope opens on the
        // receipt issued for exactly it, checked again before it is handed over; no receipt is issued here.
        if (models) review = await compositeReviewRuntime(this.#store, this.#ws, models);
        const coordinator = await Coordinator.open({
          ...assets,
          store: this.#store,
          runId: planId,
          scratchRoot: scratch,
          registry: this.#registry,
          backendOptions: { wrapRunner: lease.wrapRunner },
          ...(first ? { run: first } : {}),
          ...(review ? { review } : {}),
        });
        run.coordinator = coordinator;
        settle(undefined);
        if (run.cancel) coordinator.cancel();
        else if (run.pause) coordinator.pause();
        await coordinator.run();
      } catch (e) {
        run.error = codeOf(e);
        if (run.coordinator) {
          run.error = runFailureCode(e);
          // The coordinator accepted the run. Keep its fatal runtime code after this process exits, even if the
          // failed operation (for example finalization) could not update the ledger. Never retain raw error text.
          try {
            run.error = recordRunFailure(this.#store, planId, e, this.#now()).code;
          } catch {
            /* the store itself may no longer be writable; retain the in-memory error */
          }
        }
        // Before the coordinator opened, nothing was accepted: the start (and any joiner) is refused with this.
        settle(failureOf(e));
      } finally {
        try {
          review?.close();
        } catch {
          /* the run's own outcome is what is reported */
        }
        // Removed only when every consumer is proven stopped; otherwise retained, and the service says so.
        try {
          const released = lease ? releaseScratchLease(this.#store, lease) : { removed: true as const };
          if (released.removed) this.#scratchRetained.delete(planId);
          else this.#scratchRetained.set(planId, retainedFact(released));
        } catch {
          /* left in place for recovery; nothing outside the lease is touched */
        }
        this.#active.delete(planId);
        if (run.error) this.#lastError.set(planId, run.error);
        else this.#lastError.delete(planId);
        if (this.#active.size === 0) this.#idleSince = Date.now();
      }
    })();
    return run;
  }

  async #wait(runId: string, timeoutMs: number): Promise<CommandResult> {
    const run = this.#active.get(runId);
    if (run) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        run.task,
        new Promise<void>((r) => {
          timer = setTimeout(r, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    }
    const executing = this.#active.has(runId);
    // An error this service met executing it is a fact for its lifetime; what the store and this installation say
    // (canonicalResult, including whether this installation can execute it at all) holds after any restart too.
    const error = run?.error ?? this.#lastError.get(runId);
    const r = await canonicalResult(this.#store, 'wait', runId, {
      executing,
      registry: this.#registry,
      trustDir: this.#ws.trustDir,
      ...(error ? { facts: { error } } : {}),
    });
    return executing ? result('wait', 'submitted', { facts: r.facts, reasonCode: 'sentinel.service.waitTimedOut' }) : r;
  }

  async #pause(runId: string, receiptId: string | undefined, by: RequestedBy): Promise<CommandResult> {
    const decided = await this.#authorize('pause', 'run.pause', runId, receiptId, by);
    if ('refusal' in decided) return decided.refusal;
    const { verdicts, facts } = decided;
    const run = this.#active.get(runId);
    if (!run)
      return result('pause', 'refused', {
        verdicts,
        reasonCode: 'sentinel.service.runNotActive',
        facts: { ...facts, runId, state: runStateIn(this.#store, runId) },
      });
    run.pause = true;
    run.coordinator?.pause();
    return result('pause', 'requested', {
      verdicts,
      facts: { ...facts, runId, state: runStateIn(this.#store, runId) },
    });
  }

  async #cancel(runId: string, receiptId: string | undefined, by: RequestedBy): Promise<CommandResult> {
    const decided = await this.#authorize('cancel', 'run.cancel', runId, receiptId, by);
    if ('refusal' in decided) return decided.refusal;
    const { verdicts } = decided;
    const state = runStateIn(this.#store, runId);
    if (state === null)
      return result('cancel', 'configuration-failure', {
        verdicts,
        reasonCode: 'sentinel.service.runUnknown',
        facts: { runId },
      });
    if (isFinalRunState(state))
      return result('cancel', 'refused', {
        verdicts,
        reasonCode: 'sentinel.service.runNotActive',
        facts: { runId, state },
      });
    const run = this.#active.get(runId);
    if (run) {
      run.cancel = true;
      run.coordinator?.cancel();
    } else {
      // A paused or interrupted run: canceled through a coordinator so its ledger fences any late publication.
      if (this.#stopping || this.#active.size > 0)
        return result('cancel', 'configuration-failure', {
          verdicts,
          reasonCode: 'sentinel.service.anotherRunActive',
          facts: { runId },
        });
      const failed = await this.#launch(runId, { pause: false, cancel: true }).opened;
      if (failed) return this.#notAccepted('cancel', runId, failed, verdicts, decided.facts);
    }
    return result('cancel', 'requested', {
      verdicts,
      facts: { ...decided.facts, runId, state: runStateIn(this.#store, runId) },
    });
  }

  /** Pauses every executing run and waits for its work in flight to end. Starts nothing afterwards. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#ownerUi.close();
    this.#reads.close();
    const preparation = this.#preparations.stop();
    for (const run of this.#active.values()) {
      run.pause = true;
      run.coordinator?.pause();
    }
    await Promise.all([preparation, ...[...this.#active.values()].map((r) => r.task)]);
  }
}

// ---- the service process and its descriptor ----

/**
 * Where the running service is recorded: the owner's private user state (never the checkout, which a repository
 * could ship a descriptor in), one file per store, 0600. Clients read the address and the identity the service's
 * welcome must repeat; the folder and socket checks of transport/ipc.ts apply before anything connects.
 */
export interface ServiceDescriptor {
  readonly schema: 'sentinel-service/draft-1';
  readonly storePath: string;
  readonly storeId: string;
  readonly ownerNonce: string;
  readonly address: RuntimeAddress;
  readonly pid: number;
  readonly startedAt: string;
}

const MAX_DESCRIPTOR_BYTES = 8 * 1024;
const servicesDir = (ws: Workspace) => join(ws.trustDir, 'services');
const descriptorName = (ws: Workspace) =>
  `${createHash('sha256').update(ws.storePath).digest('hex').slice(0, 32)}.json`;

/** The owner-private files below: any unsafe one (a link, another account's, open to others) is this one error. */
function recordSafely<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PolicyError) throw new ServiceError('sentinel.service.recordUnsafe');
    throw e;
  }
}

export function readServiceDescriptor(ws: Workspace): ServiceDescriptor | undefined {
  const bytes = recordSafely(() =>
    readPrivateFile(join(servicesDir(ws), descriptorName(ws)), MAX_DESCRIPTOR_BYTES, 'sentinel.receipt.storeUnsafe'),
  );
  if (!bytes) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(v) || v.schema !== 'sentinel-service/draft-1' || v.storePath !== ws.storePath) return undefined;
  const a = v.address;
  if (
    typeof v.storeId !== 'string' ||
    typeof v.ownerNonce !== 'string' ||
    !Number.isSafeInteger(v.pid) ||
    !isRecord(a) ||
    typeof a.dir !== 'string' ||
    typeof a.socket !== 'string'
  )
    return undefined;
  return v as unknown as ServiceDescriptor;
}

function removeServiceDescriptor(ws: Workspace, ownerNonce: string): void {
  // Only our own record, by this process and this acquisition's nonce: a later service may already have replaced it.
  const d = readServiceDescriptor(ws);
  if (d?.ownerNonce !== ownerNonce || d.pid !== process.pid) return;
  try {
    unlinkSync(join(servicesDir(ws), descriptorName(ws)));
  } catch {
    /* already gone */
  }
}

/** A connection to the workspace's running service, or undefined when none answers at its recorded address. */
export async function connectService(
  ws: Workspace,
  kind: import('../transport/ipc.js').ClientKind = 'cli',
): Promise<ServiceClient | undefined> {
  const d = readServiceDescriptor(ws);
  if (!d) return undefined;
  try {
    checkAddress(d.address);
    return await connectOwnerSocket(d.address, { storeId: d.storeId, ownerNonce: d.ownerNonce }, kind);
  } catch (e) {
    // Nothing listening, or something else answering: no service for this workspace. An unsafe folder or socket is
    // not a missing service and refuses.
    if (
      e instanceof IpcError &&
      (e.code === 'sentinel.ipc.notListening' || e.code === 'sentinel.ipc.handshakeMismatch')
    )
      return undefined;
    throw e;
  }
}

export interface ServeOptions {
  /** Stop after this long with no run, request or unexpired read buffer; 0 never stops on its own. */
  readonly idleMs: number;
  /** Stops the service: the CLI wires SIGINT and SIGTERM to it. */
  readonly signal?: AbortSignal;
  readonly service?: OwnerServiceOptions;
  /** Called once the socket listens and the descriptor is written. */
  readonly onListening?: (descriptor: ServiceDescriptor) => void;
}

/** Runs the service for one workspace until it is stopped or idle. Resolves after the store is released. */
export async function serveWorkspace(ws: Workspace, options: ServeOptions): Promise<void> {
  // Before the store, the framework entry or the socket: trust state and the runtime folder stay out of the source.
  checkWorkspaceLayout(ws);
  let store: SentinelStore;
  try {
    store = await openStore(ws.storePath);
  } catch (e) {
    if ((e as { code?: unknown }).code === 'sentinel.store.ownedElsewhere')
      throw new ServiceError('sentinel.service.alreadyServing');
    throw e;
  }
  const service = new OwnerService(store, ws, options.service ?? {});
  const ownerNonce = newOwnerNonce();
  let inflight = 0;
  let lastRequest = Date.now();
  try {
    const address = runtimeAddress({ storePath: store.storePath, ownerNonce, sources: [ws.path] });
    const socket = await listenOwnerSocket(
      address,
      { storeId: store.storeId, ownerNonce },
      async (op, body, by, context) => {
        inflight++;
        try {
          return await service.handle(op, body, by, context);
        } finally {
          inflight--;
          lastRequest = Date.now();
        }
      },
    );
    try {
      const descriptor: ServiceDescriptor = Object.freeze({
        schema: 'sentinel-service/draft-1',
        storePath: ws.storePath,
        storeId: store.storeId,
        ownerNonce,
        address,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      recordSafely(() =>
        writePrivateFileAtomic(
          servicesDir(ws),
          descriptorName(ws),
          Buffer.from(JSON.stringify(descriptor)),
          'sentinel.receipt.storeUnsafe',
        ),
      );
      options.onListening?.(descriptor);
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        const timer = setInterval(() => {
          const quiet = Date.now() - Math.max(lastRequest, service.idleSince);
          if (
            options.idleMs > 0 &&
            inflight === 0 &&
            !service.busy &&
            !service.retainingReads &&
            quiet >= options.idleMs
          )
            done();
        }, 100);
        const done = () => {
          clearInterval(timer);
          options.signal?.removeEventListener('abort', done);
          resolve();
        };
        options.signal?.addEventListener('abort', done, { once: true });
      });
      await service.stop();
    } finally {
      removeServiceDescriptor(ws, ownerNonce);
      await socket.close();
    }
  } finally {
    store.close();
  }
}
