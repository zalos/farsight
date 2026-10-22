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
// One run executes at a time. A second start for the plan being run joins it (one run, never two); a start for a run
// that already finished prints its result again without executing anything. A run interrupted by the service
// stopping, however it stopped, is recovered by the coordinator when it is resumed.
import { mkdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Coordinator } from '../execution/coordinator.js';
import type { PlanBoundary } from '../execution/coordinator.js';
import type { AdapterRegistry } from '../execution/registry.js';
import { admit, PolicyError } from '../policy/index.js';
import { readPrivateFile, writePrivateFileAtomic } from '../policy/user-state.js';
import { openStore, type SentinelStore } from '../store/index.js';
import type { RequestedBy } from '../cli/actor.js';
import { result, type CommandResult, type PrintedVerdicts } from '../cli/outcome.js';
import {
  checkAddress, connectOwnerSocket, IpcError, listenOwnerSocket, newOwnerNonce, runtimeAddress,
  type RuntimeAddress, type ServiceClient,
} from '../transport/ipc.js';
import {
  adoptedPolicy, intentOf, isFinalRunState, printed, readPlanRecord, receiptBook, removeScratch, reportIn,
  runResultIn, runStateIn, scratchUnder, statusIn, type Workspace,
} from './local.js';
import { PREVIEW_ADAPTERS, previewPlan } from './preview-plan.js';

export type ServiceErrorCode =
  | 'sentinel.service.unknownOperation' | 'sentinel.service.requestInvalid' | 'sentinel.service.planUnknown'
  | 'sentinel.service.planChanged' | 'sentinel.service.alreadyServing' | 'sentinel.service.startFailed'
  | 'sentinel.service.recordUnsafe';

export class ServiceError extends Error {
  constructor(readonly code: ServiceErrorCode) { super(code); this.name = 'ServiceError'; }
}

/** The plans the service can run: a plan's identity, and the plan rebuilt for execution. PR 06's planner replaces it. */
export interface ServicePlans {
  record(planId: string): { readonly planId: string; readonly planDigest: string; readonly policyRevision: string } | undefined;
  /** Rebuilds the plan into `workDir` (a new private folder) and checks it against its record. */
  prepare(store: SentinelStore, planId: string, workDir: string, now: Date): Promise<{ boundary: PlanBoundary; registry: AdapterRegistry }>;
}

/** The foundation-preview plans this workspace prepared. */
export function previewPlans(ws: Workspace): ServicePlans {
  return Object.freeze({
    record: (planId: string) => readPlanRecord(ws, planId),
    async prepare(store: SentinelStore, planId: string, workDir: string, now: Date) {
      const record = readPlanRecord(ws, planId);
      if (!record) throw new ServiceError('sentinel.service.planUnknown');
      const plan = await previewPlan(store, { snapshotId: record.snapshotId, policyRevision: record.policyRevision, workDir, now: now.toISOString() });
      if (plan.disclosure.planDigest !== record.planDigest || plan.disclosure.planId !== record.planId) throw new ServiceError('sentinel.service.planChanged');
      return { boundary: plan.boundary, registry: PREVIEW_ADAPTERS };
    },
  });
}

interface ActiveRun {
  readonly planId: string;
  coordinator?: Coordinator;
  pause: boolean;
  cancel: boolean;
  task: Promise<void>;
  /** Why the run could not be executed, when it could not. */
  error?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_WAIT_MS = 25_000;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const codeOf = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('sentinel.') ? code : 'sentinel.service.executionFailed';
};

/** Reads one request body: an object with exactly the named fields, each an id (or a bounded integer). */
function fields(body: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, string | number> {
  if (!isRecord(body)) throw new ServiceError('sentinel.service.requestInvalid');
  const allowed = new Set([...required, ...optional]);
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) throw new ServiceError('sentinel.service.requestInvalid');
    if (typeof v === 'string' ? !ID.test(v) : !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) throw new ServiceError('sentinel.service.requestInvalid');
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
  readonly plans?: ServicePlans;
  readonly now?: () => Date;
}

/** The service's operations over a store this process holds. The socket and the process around it are serveWorkspace's. */
export class OwnerService {
  readonly #store: SentinelStore;
  readonly #ws: Workspace;
  readonly #plans: ServicePlans;
  readonly #now: () => Date;
  readonly #active = new Map<string, ActiveRun>();
  #idleSince = Date.now();
  #stopping = false;

  constructor(store: SentinelStore, ws: Workspace, options: OwnerServiceOptions = {}) {
    this.#store = store;
    this.#ws = ws;
    this.#plans = options.plans ?? previewPlans(ws);
    this.#now = options.now ?? (() => new Date());
  }

  /** True while a run executes. */
  get busy(): boolean { return this.#active.size > 0; }
  /** When the last run ended (or the service started), for the idle stop. */
  get idleSince(): number { return this.#idleSince; }

  /** One request, from a connection whose requester the transport fixed. Returns a typed command result. */
  async handle(op: string, body: unknown, by: RequestedBy): Promise<unknown> {
    // The owner's channel never arrives here: every connection is a service client (transport/ipc.ts).
    if (by.channel === 'owner-cli') throw new ServiceError('sentinel.service.requestInvalid');
    switch (op) {
      case 'service.info': {
        fields(body, []);
        return { storeId: this.#store.storeId, epoch: this.#store.epoch, pid: process.pid, active: [...this.#active.keys()] };
      }
      case 'run.start': {
        const f = fields(body, ['planId'], ['receiptId']);
        return this.#start(f.planId as string, f.receiptId as string | undefined, by);
      }
      case 'run.status': {
        const f = fields(body, ['runId'], ['after', 'limit']);
        return statusIn(this.#store, { runId: f.runId as string, ...(f.after === undefined ? {} : { after: f.after as number }), ...(f.limit === undefined ? {} : { limit: f.limit as number }) });
      }
      case 'run.wait': {
        const f = fields(body, ['runId'], ['timeoutMs']);
        return this.#wait(f.runId as string, Math.min(typeof f.timeoutMs === 'number' ? f.timeoutMs : MAX_WAIT_MS, MAX_WAIT_MS));
      }
      case 'run.pause': {
        const f = fields(body, ['runId'], ['receiptId']);
        return this.#pause(f.runId as string, f.receiptId as string | undefined, by);
      }
      case 'run.cancel': {
        const f = fields(body, ['runId'], ['receiptId']);
        return this.#cancel(f.runId as string, f.receiptId as string | undefined, by);
      }
      case 'report': return reportIn(this.#store, this.#ws, { runId: fields(body, ['runId']).runId as string, now: this.#now() });
      default: throw new ServiceError('sentinel.service.unknownOperation');
    }
  }

  /**
   * Decides one write on a plan's run: the owner's receipt for exactly this action, plan digest and policy revision,
   * spent once, or else admission with the connection's own requester under the adopted grants. Being connected
   * grants nothing; there is no service bypass.
   */
  #authorize(command: string, action: 'run.start' | 'run.pause' | 'run.cancel', planId: string, receiptId: string | undefined, by: RequestedBy):
    { verdicts: PrintedVerdicts; facts: Record<string, unknown> } | { refusal: CommandResult } {
    const facts: Record<string, unknown> = { planId };
    const record = this.#plans.record(planId);
    if (!record) return { refusal: result(command, 'configuration-failure', { reasonCode: 'sentinel.service.planUnknown', facts }) };
    const adopted = adoptedPolicy(this.#ws);
    if ('refusal' in adopted) return { refusal: adopted.refusal };
    const { policy } = adopted;
    if (policy.revision !== record.policyRevision) return { refusal: result(command, 'configuration-failure', { reasonCode: 'sentinel.service.policyChanged', facts }) };
    const intent = intentOf(action, record.planDigest, ['local-artifacts']);
    const now = this.#now();
    if (receiptId !== undefined) {
      // The owner's receipt: checked against exactly this action, plan digest and policy revision, and spent once.
      // What the connection said about itself plays no part; an unknown, spent, expired or mismatched one refuses.
      try {
        const spent = receiptBook(this.#ws).consume(receiptId, { intent, stateDigest: record.planDigest, policyRevision: policy.revision }, now);
        return { verdicts: RECEIPT_VERDICTS, facts: { ...facts, receipt: spent.digest } };
      } catch (e) {
        if (!(e instanceof PolicyError)) throw e;
        return { refusal: result(command, 'configuration-failure', { reasonCode: e.code, facts }) };
      }
    }
    const decision = admit({
      intent, requestedBy: by, policy, stateDigest: record.planDigest, now,
      capability: () => ({ available: true, detail: 'built into this installation; runs locally' }),
      credential: () => ({ basis: 'local-only' as const, detail: 'no provider is contacted' }),
    }).record;
    const verdicts = printed(decision);
    if (decision.outcome === 'awaiting-confirmation') return { refusal: result(command, 'awaiting-confirmation', { verdicts, facts }) };
    if (decision.outcome !== 'admitted') {
      const v = decision.verdicts;
      return { refusal: result(command, 'configuration-failure', { verdicts, facts, reasonCode: v.policy.allowed ? (v.capability.allowed ? v.credential.reasonCode : v.capability.reasonCode) : v.policy.reasonCode }) };
    }
    return { verdicts, facts };
  }

  async #start(planId: string, receiptId: string | undefined, by: RequestedBy): Promise<CommandResult> {
    const decided = this.#authorize('run', 'run.start', planId, receiptId, by);
    if ('refusal' in decided) return decided.refusal;
    const { verdicts, facts } = decided;
    // One run per plan: a second start joins the run already executing.
    if (this.#active.has(planId)) return result('run', 'submitted', { verdicts, facts: { ...facts, runId: planId, joined: true, state: runStateIn(this.#store, planId) } });
    if (this.#stopping || this.#active.size > 0) return result('run', 'configuration-failure', { verdicts, facts, reasonCode: 'sentinel.service.anotherRunActive' });
    if (isFinalRunState(runStateIn(this.#store, planId))) return runResultIn(this.#store, 'run', planId, { executing: false, verdicts, facts });
    this.#launch(planId, { pause: false, cancel: false });
    return result('run', 'submitted', { verdicts, facts: { ...facts, runId: planId, joined: false, state: runStateIn(this.#store, planId) } });
  }

  #launch(planId: string, flags: { pause: boolean; cancel: boolean }): ActiveRun {
    const run: ActiveRun = { planId, ...flags, task: Promise.resolve() };
    this.#active.set(planId, run);
    run.task = (async () => {
      const work = scratchUnder(this.#ws);
      try {
        const prepared = await this.#plans.prepare(this.#store, planId, join(work, 'plan'), this.#now());
        const scratch = join(work, 'attempts');
        mkdirSync(scratch, { mode: 0o700 });
        const coordinator = await Coordinator.open({ store: this.#store, plan: prepared.boundary, scratchRoot: scratch, registry: prepared.registry });
        run.coordinator = coordinator;
        if (run.cancel) coordinator.cancel();
        else if (run.pause) coordinator.pause();
        await coordinator.run();
      } catch (e) {
        run.error = codeOf(e);
      } finally {
        try { removeScratch(work); } catch { /* left for an explicit cleanup */ }
        this.#active.delete(planId);
        if (this.#active.size === 0) this.#idleSince = Date.now();
      }
    })();
    return run;
  }

  async #wait(runId: string, timeoutMs: number): Promise<CommandResult> {
    const run = this.#active.get(runId);
    if (run) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([run.task, new Promise<void>(r => { timer = setTimeout(r, timeoutMs); })]);
      clearTimeout(timer);
    }
    const executing = this.#active.has(runId);
    const r = await runResultIn(this.#store, 'wait', runId, { executing, ...(run?.error ? { facts: { error: run.error } } : {}) });
    return executing ? result('wait', 'submitted', { facts: r.facts, reasonCode: 'sentinel.service.waitTimedOut' }) : r;
  }

  #pause(runId: string, receiptId: string | undefined, by: RequestedBy): CommandResult {
    const decided = this.#authorize('pause', 'run.pause', runId, receiptId, by);
    if ('refusal' in decided) return decided.refusal;
    const { verdicts, facts } = decided;
    const run = this.#active.get(runId);
    if (!run) return result('pause', 'refused', { verdicts, reasonCode: 'sentinel.service.runNotActive', facts: { ...facts, runId, state: runStateIn(this.#store, runId) } });
    run.pause = true;
    run.coordinator?.pause();
    return result('pause', 'requested', { verdicts, facts: { ...facts, runId, state: runStateIn(this.#store, runId) } });
  }

  #cancel(runId: string, receiptId: string | undefined, by: RequestedBy): CommandResult {
    const decided = this.#authorize('cancel', 'run.cancel', runId, receiptId, by);
    if ('refusal' in decided) return decided.refusal;
    const { verdicts } = decided;
    const state = runStateIn(this.#store, runId);
    if (state === null) return result('cancel', 'configuration-failure', { verdicts, reasonCode: 'sentinel.service.runUnknown', facts: { runId } });
    if (isFinalRunState(state)) return result('cancel', 'refused', { verdicts, reasonCode: 'sentinel.service.runNotActive', facts: { runId, state } });
    const run = this.#active.get(runId);
    if (run) {
      run.cancel = true;
      run.coordinator?.cancel();
    } else {
      // A paused or interrupted run: canceled through a coordinator so its ledger fences any late publication.
      if (this.#stopping || this.#active.size > 0) return result('cancel', 'configuration-failure', { verdicts, reasonCode: 'sentinel.service.anotherRunActive', facts: { runId } });
      this.#launch(runId, { pause: false, cancel: true });
    }
    return result('cancel', 'requested', { verdicts, facts: { ...decided.facts, runId, state: runStateIn(this.#store, runId) } });
  }

  /** Pauses every executing run and waits for its work in flight to end. Starts nothing afterwards. */
  async stop(): Promise<void> {
    this.#stopping = true;
    for (const run of this.#active.values()) { run.pause = true; run.coordinator?.pause(); }
    await Promise.all([...this.#active.values()].map(r => r.task));
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
const descriptorName = (ws: Workspace) => `${createHash('sha256').update(ws.storePath).digest('hex').slice(0, 32)}.json`;

/** The owner-private files below: any unsafe one (a link, another account's, open to others) is this one error. */
function recordSafely<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof PolicyError) throw new ServiceError('sentinel.service.recordUnsafe');
    throw e;
  }
}

export function readServiceDescriptor(ws: Workspace): ServiceDescriptor | undefined {
  const bytes = recordSafely(() => readPrivateFile(join(servicesDir(ws), descriptorName(ws)), MAX_DESCRIPTOR_BYTES, 'sentinel.receipt.storeUnsafe'));
  if (!bytes) return undefined;
  let v: unknown;
  try { v = JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
  if (!isRecord(v) || v.schema !== 'sentinel-service/draft-1' || v.storePath !== ws.storePath) return undefined;
  const a = v.address;
  if (typeof v.storeId !== 'string' || typeof v.ownerNonce !== 'string' || !Number.isSafeInteger(v.pid)
    || !isRecord(a) || typeof a.dir !== 'string' || typeof a.socket !== 'string') return undefined;
  return v as unknown as ServiceDescriptor;
}

function removeServiceDescriptor(ws: Workspace, ownerNonce: string): void {
  // Only our own record, by this process and this acquisition's nonce: a later service may already have replaced it.
  const d = readServiceDescriptor(ws);
  if (d?.ownerNonce !== ownerNonce || d.pid !== process.pid) return;
  try { unlinkSync(join(servicesDir(ws), descriptorName(ws))); } catch { /* already gone */ }
}

/** A connection to the workspace's running service, or undefined when none answers at its recorded address. */
export async function connectService(ws: Workspace): Promise<ServiceClient | undefined> {
  const d = readServiceDescriptor(ws);
  if (!d) return undefined;
  try {
    checkAddress(d.address);
    return await connectOwnerSocket(d.address, { storeId: d.storeId, ownerNonce: d.ownerNonce }, 'cli');
  } catch (e) {
    // Nothing listening, or something else answering: no service for this workspace. An unsafe folder or socket is
    // not a missing service and refuses.
    if (e instanceof IpcError && (e.code === 'sentinel.ipc.notListening' || e.code === 'sentinel.ipc.handshakeMismatch')) return undefined;
    throw e;
  }
}

export interface ServeOptions {
  /** Stop after this long with no run and no request; 0 never stops on its own. */
  readonly idleMs: number;
  /** Stops the service: the CLI wires SIGINT and SIGTERM to it. */
  readonly signal?: AbortSignal;
  readonly service?: OwnerServiceOptions;
  /** Called once the socket listens and the descriptor is written. */
  readonly onListening?: (descriptor: ServiceDescriptor) => void;
}

/** Runs the service for one workspace until it is stopped or idle. Resolves after the store is released. */
export async function serveWorkspace(ws: Workspace, options: ServeOptions): Promise<void> {
  let store: SentinelStore;
  try { store = await openStore(ws.storePath); } catch (e) {
    if ((e as { code?: unknown }).code === 'sentinel.store.ownedElsewhere') throw new ServiceError('sentinel.service.alreadyServing');
    throw e;
  }
  const service = new OwnerService(store, ws, options.service ?? {});
  const ownerNonce = newOwnerNonce();
  let inflight = 0;
  let lastRequest = Date.now();
  try {
    const address = runtimeAddress({ storePath: store.storePath, ownerNonce });
    const socket = await listenOwnerSocket(address, { storeId: store.storeId, ownerNonce }, async (op, body, by) => {
      inflight++;
      try { return await service.handle(op, body, by); } finally { inflight--; lastRequest = Date.now(); }
    });
    try {
      const descriptor: ServiceDescriptor = Object.freeze({
        schema: 'sentinel-service/draft-1', storePath: ws.storePath, storeId: store.storeId, ownerNonce, address,
        pid: process.pid, startedAt: new Date().toISOString(),
      });
      recordSafely(() => writePrivateFileAtomic(servicesDir(ws), descriptorName(ws), Buffer.from(JSON.stringify(descriptor)), 'sentinel.receipt.storeUnsafe'));
      options.onListening?.(descriptor);
      await new Promise<void>(resolve => {
        if (options.signal?.aborted) { resolve(); return; }
        const timer = setInterval(() => {
          const quiet = Date.now() - Math.max(lastRequest, service.idleSince);
          if (options.idleMs > 0 && inflight === 0 && !service.busy && quiet >= options.idleMs) done();
        }, 100);
        const done = () => { clearInterval(timer); options.signal?.removeEventListener('abort', done); resolve(); };
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
