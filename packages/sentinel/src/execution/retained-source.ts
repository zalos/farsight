// The one place that proves a source's retained bootstrap evidence: the accepted coordinator inventory and parse
// operations that own it, and the original parser result, index and artifact they published over the exact snapshot.
// Internal. It mints nothing: execution (retained-analysis.ts) adds its ValidatedPlan and exact-unit checks around
// it, and only that caller may turn the result into retained execution evidence.
import { createHash } from 'node:crypto';
import type { ArtifactId, WorkRef } from '../contracts/common.js';
import type { CaptureEntry } from '../contracts/snapshot.js';
import { canonicalArtifactId, influenceManifestOf } from '../planner/boundary.js';
import { deepFreeze } from '../policy/immutable.js';
import { openSnapshot, type OpenedSnapshot, type RestoreStore } from '../snapshot/materialize.js';
import { PARSER_INDEX_SCHEMA, PARSER_RESULT_SCHEMA, type AnalysisArtifact, type ParserIndex, type ParserResult } from '../snapshot/parser.js';
import type { SentinelStore } from '../store/index.js';
import { canonicalJsonBytes } from '../store/objects.js';
import type { StoreOwner } from '../store/owner.js';
import { boundOwner } from '../store/owner-binding.js';
import { MAX_ARTIFACT_BYTES } from '../store/store-types.js';
import { INVENTORY_RECORD_SCHEMA, type InventoryRecord } from './bootstrap.js';
import { ExecutionError } from './errors.js';
import { loadPlan, type AdmittedPlan } from './plans.js';
import type { ExecutionProfileRecord } from './profile.js';
import { retainedLineage } from './retained-bootstrap.js';

const same = (a: unknown, b: unknown) => canonicalJsonBytes(a ?? null).equals(canonicalJsonBytes(b ?? null));
const refSame = (a: WorkRef, b: WorkRef) => a.id === b.id && a.revision === b.revision;
const fail = (reason: string): never => { throw new ExecutionError('sentinel.execution.analysisUnavailable', { reason }); };
const json = (bytes: Buffer): any => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

/** How the verifier reads: every artifact through `read` (hash-checked by the caller's reader), and its boundary. */
export interface RetainedSourceIO {
  read(id: ArtifactId): Promise<Buffer>;
  boundary(): void;
  loadPlan(runId: string, revision: number): Promise<AdmittedPlan>;
}

/** The admitted analysis revision that reuses the inventory, and the source and parse profile it pins. */
export interface RetainedSourceAnchor {
  readonly admitted: AdmittedPlan;
  readonly inventory: WorkRef;
  readonly sourceId: string;
  readonly profile: Readonly<ExecutionProfileRecord>;
}

export async function verifyRetainedSource(store: SentinelStore, io: RetainedSourceIO, anchor: RetainedSourceAnchor) {
  const { admitted, inventory, sourceId, profile } = anchor;
  // Verify actual accepted operation ownership, not merely a schema-valid JSON document naming this source.
  const operation = async (ref: WorkRef, stage: 'inventory' | 'parse', opSource: string | null, expectedRun?: string) => {
    io.boundary();
    const row = store.ledger.getWork(ref), publication = store.ledger.getPublication(ref);
    if (!row || !publication || !refSame(publication.work, ref) || (expectedRun && row.runId !== expectedRun)) return fail('bootstrap publication belongs to other work or run');
    const boot = await io.loadPlan(row.runId, row.envelope.planRevision);
    io.boundary();
    const u = boot.plan.units.find(x => refSame(x, ref));
    const pin = boot.profile.operations[stage];
    if (boot.plan.kind !== 'bootstrap' || !u || u.stage !== stage || u.sourceId !== opSource || !pin
      || u.adapterId !== pin.adapterId || u.implementationDigest !== pin.digest || !same(row.envelope.stage, { contract: u.contract, contractVersion: 'draft-1', kind: 'coded', implementationDigest: u.implementationDigest })
      || !same(row.envelope.dependencies, u.dependencies)) return fail('the publication is not its admitted bootstrap operation');
    const attempt = store.ledger.getAttempt(publication.attemptId);
    const worker = attempt?.envelope.worker;
    if (!attempt || attempt.state !== 'succeeded' || !refSame(attempt.work, ref) || worker?.kind !== 'coordinator-operation'
      || worker.adapterId !== pin.adapterId || worker.adapterDigest !== pin.digest || !attempt.envelope.invocation) return fail('no accepted coordinator operation owns this publication');
    const invocation = json(await io.read(attempt.envelope.invocation));
    if (invocation.format !== 'sentinel-operation-invocation/draft-1' || invocation.store !== store.storeId || invocation.attemptId !== attempt.id
      || !refSame(invocation.work, ref) || invocation.coordinatorEpoch !== attempt.epoch || invocation.operation !== stage
      || invocation.adapter?.id !== pin.adapterId || invocation.adapter?.digest !== pin.digest
      || !same(invocation.plan, { runId: row.runId, revision: boot.plan.revision, digest: boot.plan.digest })
      || invocation.influenceManifest !== row.envelope.influenceManifest || invocation.snapshotId !== admitted.plan.pins.snapshotId || invocation.sourceId !== opSource
      || (stage === 'parse' && (!same(invocation.parse, profile.parse) || !same(boot.profile.parse, profile.parse)))) return fail('bootstrap invocation differs from the pinned execution');
    return { row, publication, attempt, unit: u, boot };
  };
  const owned = await operation(inventory, 'inventory', null);
  const outputs = owned.publication.outputs;
  if (outputs.length !== 1 || outputs[0]!.schema !== INVENTORY_RECORD_SCHEMA) return fail('not exactly one published inventory record');
  const record = json(await io.read(outputs[0]!.id)) as InventoryRecord;
  if (record.schema !== INVENTORY_RECORD_SCHEMA || record.runId !== owned.row.runId || record.snapshotId !== admitted.plan.pins.snapshotId
    || record.inventoryDigest !== admitted.plan.pins.inventoryDigest || !Array.isArray(record.analyses) || record.analyses.length > 64) return fail('inventory differs from the pinned snapshot');
  const analyses = record.analyses.filter(a => a.sourceId === sourceId), pins = admitted.plan.pins.analyses.filter(a => a.sourceId === sourceId);
  if (analyses.length !== 1 || pins.length !== 1 || analyses[0]!.analysisFingerprint !== pins[0]!.analysisFingerprint) return fail('not exactly one pinned source analysis');
  const source = analyses[0]!;
  // The referenced result must also be the real parser publication that the inventory depends on.
  if (owned.unit.dependencies.length > 64) return fail('inventory dependency bound exceeded');
  for (const ref of owned.unit.dependencies) {
    const row = store.ledger.getWork(ref);
    if (row?.runId !== owned.row.runId || row.envelope.planRevision !== owned.row.envelope.planRevision) return fail('inventory depends on foreign bootstrap work');
  }
  const parses = owned.boot.plan.units.filter(u => u.stage === 'parse' && u.sourceId === sourceId
    && owned.unit.dependencies.some(ref => refSame(ref, u)));
  if (parses.length !== 1) return fail('inventory does not depend on exactly one parse of this source');
  const parsed = await operation(parses[0]!, 'parse', sourceId, owned.row.runId);
  if (parsed.publication.outputs.length !== 1 || parsed.publication.outputs[0]!.schema !== PARSER_RESULT_SCHEMA || parsed.publication.outputs[0]!.id !== source.result) return fail('inventory names another parser publication');
  const resultBytes = await io.read(source.result), indexBytes = await io.read(source.index), artifactBytes = await io.read(source.artifact);
  const result = json(resultBytes), index = json(indexBytes), artifact = json(artifactBytes);
  if (result.schema !== PARSER_RESULT_SCHEMA || result.snapshotId !== record.snapshotId || result.sourceId !== sourceId
    || result.analysisFingerprint !== source.analysisFingerprint || result.index !== source.index || result.artifact !== source.artifact
    || !same(result.parser, artifact.analysis?.parser) || !same(result.adapters, artifact.analysis?.adapters) || result.parserComplete !== artifact.analysis?.complete
    || !same(result.selection, profile.parse.selection) || !same(result.limits, profile.parse.limits)) return fail('parser result differs from the pinned source, artifacts or parse options');
  if (index.schema !== PARSER_INDEX_SCHEMA || index.snapshotId !== record.snapshotId || index.sourceId !== sourceId || index.analysisFingerprint !== source.analysisFingerprint
    || artifact.format !== 'farsight-analysis' || artifact.schemaVersion !== 1 || artifact.graph?.repo !== sourceId
    || artifact.analysis?.fingerprint !== source.analysisFingerprint || !Array.isArray(artifact.graph.nodes) || !Array.isArray(artifact.graph.edges)) return fail('retained index or artifact differs from the pinned source');
  const opened: OpenedSnapshot = await openSnapshot({ ledger: store.ledger, readArtifact: io.read }, record.snapshotId);
  io.boundary();
  if (opened.record.manifest !== record.manifest || opened.record.inventoryDigest !== record.inventoryDigest) return fail('inventory names another snapshot manifest');
  return { owned, parsed, record, source, opened, result, index, artifact, bytes: { result: resultBytes, index: indexBytes, artifact: artifactBytes } };
}

// ---------------------------------------------------------------------------------------------------------------
// Bounded reading. Every artifact read is counted: its recorded size before it is read, its actual bytes after, and
// the call's absolute deadline is checked before and after every await. Timing is cooperative: a read already in
// flight completes, then the next boundary refuses; no success is returned and no read starts after the deadline.
// Counted decoded bytes are bounded; the process's memory as a whole is not claimed bounded.

/** Ceiling proposals: a source over them is refused, never partially proven. Changing them is an owner decision. */
export const RETAINED_PROOF_LIMITS = Object.freeze({
  reads: 202_048,
  sourceBytes: 512 * 1024 * 1024,
  metadataBytes: 384 * 1024 * 1024,
  retainedBytes: 64 * 1024 * 1024,
  depth: 64,
  deadlineMs: 120_000,
});
export type RetainedProofLimits = typeof RETAINED_PROOF_LIMITS;
const KEPT = new Set(['sentinel.execution.canceled', 'sentinel.execution.deadlineExceeded', 'sentinel.execution.runDeadline', 'sentinel.execution.analysisUnavailable']);
// Internal callers may tighten these ceilings; caller-owned objects never become live budget state.
function copiedLimits(limits: RetainedProofLimits): RetainedProofLimits {
  if (!limits || typeof limits !== 'object') return fail('invalid retained proof limits');
  const entries = Object.entries(RETAINED_PROOF_LIMITS).map(([key, ceiling]) => {
    const value = limits[key as keyof RetainedProofLimits];
    if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) return fail('invalid retained proof limits');
    return [key, value] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as RetainedProofLimits;
}

// +Infinity is an absent extra caller constraint. It cannot relax the finite internal deadline.
function callerDeadline(value: number | undefined): number {
  if (value === undefined || value === Infinity) return Infinity;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fail('invalid retained proof deadline');
  return value;
}

type BudgetReason = 'budget-reads' | 'budget-source-bytes' | 'budget-metadata-bytes' | 'budget-retained' | 'budget-depth';

/** What one bounded call spent; for measurement and tests, never authority. */
export interface RetainedProofUsage { reads: number; sourceBytes: number; metadataBytes: number; retainedBytes: number; elapsedMs: number }

export class RetainedBudget {
  readonly #store: SentinelStore;
  readonly #owner: StoreOwner;
  readonly #epoch: string;
  readonly #signals: readonly AbortSignal[];
  readonly #stillWithin: readonly (() => void)[];
  readonly #limits: RetainedProofLimits;
  readonly started = performance.now();
  readonly deadlineAt: number;
  reads = 0; sourceBytes = 0; metadataBytes = 0; retainedBytes = 0;
  /**
   * The first refusal this budget raised: cancellation, deadline, owner change or a bound. Callers rethrow it, so a
   * reader wrapped by another module's catch (the lineage walk, the snapshot reader) never re-labels it.
   */
  failure: unknown;

  constructor(store: SentinelStore, options: { signals: readonly AbortSignal[]; deadlineAt?: number; stillWithin?: readonly (() => void)[];
    owner?: StoreOwner; epoch?: string; limits?: RetainedProofLimits }) {
    this.#store = store;
    this.#limits = copiedLimits(options.limits === undefined ? RETAINED_PROOF_LIMITS : options.limits);
    // The deadline starts before the first read; a caller's own absolute deadline can only make it earlier.
    this.deadlineAt = Math.min(this.started + this.#limits.deadlineMs, callerDeadline(options.deadlineAt));
    this.#owner = options.owner ?? boundOwner(store);
    this.#epoch = options.epoch ?? store.epoch;
    this.#signals = Object.freeze([...options.signals]);
    this.#stillWithin = Object.freeze([...(options.stillWithin ?? [])]);
  }

  get owner(): StoreOwner { return this.#owner; }
  get epoch(): string { return this.#epoch; }
  get limits(): RetainedProofLimits { return this.#limits; }

  usage(): RetainedProofUsage {
    return { reads: this.reads, sourceBytes: this.sourceBytes, metadataBytes: this.metadataBytes, retainedBytes: this.retainedBytes, elapsedMs: performance.now() - this.started };
  }

  refuse(reason: BudgetReason): never { return this.#record(() => fail(reason)); }

  #record<T>(f: () => T): T {
    try { return f(); } catch (error) {
      // Cancellation, deadlines and budget/ownership refusals keep their own identity; anything else a caller's
      // callback throws stays an evidence failure, as before.
      if (this.failure === undefined && (this.#storeLost || (error instanceof ExecutionError && KEPT.has(error.code)))) this.failure = error;
      this.#storeLost = false;
      throw error;
    }
  }

  /** The genuine store, its owner and epoch, cancellation, the absolute deadline, then the caller's tighter check. */
  boundary(): void { this.#record(() => this.#boundary()); }

  #storeLost = false;

  #boundary(): void {
    try { this.#store.assertHeld(); } catch (error) { this.#storeLost = true; throw error; }
    if (boundOwner(this.#store) !== this.#owner || this.#store.epoch !== this.#epoch) fail('the store owner or epoch changed');
    if (this.#signals.some(s => s.aborted)) throw new ExecutionError('sentinel.execution.canceled');
    if (performance.now() >= this.deadlineAt) throw new ExecutionError('sentinel.execution.deadlineExceeded', { deadlineMs: this.#limits.deadlineMs });
    for (const check of this.#stillWithin) check();
  }

  /** One counted, hash-checked artifact read through the store's accepted reader. */
  async read(id: ArtifactId, kind: 'source' | 'metadata'): Promise<Buffer> {
    this.boundary();
    if (this.reads + 1 > this.#limits.reads) this.refuse('budget-reads');
    let recorded: number | undefined;
    try { recorded = this.#store.ledger.objectsOf(id)[0]?.rawSize; } catch { recorded = undefined; }
    // An unrecorded or mismatched object is evidence failure, not a budget refusal: it is not recorded as `failure`.
    if (recorded === undefined || !Number.isSafeInteger(recorded) || recorded < 0 || recorded > MAX_ARTIFACT_BYTES) return fail('a retained object is not recorded');
    if (kind === 'source' ? this.sourceBytes + recorded > this.#limits.sourceBytes : this.metadataBytes + recorded > this.#limits.metadataBytes) {
      this.refuse(kind === 'source' ? 'budget-source-bytes' : 'budget-metadata-bytes');
    }
    this.reads++;
    const bytes = await this.#store.readArtifact(id);
    this.boundary();
    if (kind === 'source') this.sourceBytes += bytes.length; else this.metadataBytes += bytes.length;
    if (bytes.length !== recorded || bytes.length > MAX_ARTIFACT_BYTES || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== id) return fail('retained bytes differ from their identity');
    return Buffer.from(bytes);
  }

  /** Bytes held for a returned view or value; nothing else is cached. */
  retain(bytes: number): void {
    if (this.retainedBytes + bytes > this.#limits.retainedBytes) this.refuse('budget-retained');
    this.retainedBytes += bytes;
  }

  /** Reads only: a plan/snapshot reader over the budget. Never an owner, a store or an authority. */
  readView(): RestoreStore {
    return Object.freeze({ ledger: this.#store.ledger, readArtifact: (id: ArtifactId) => this.read(id, 'metadata') }) as RestoreStore;
  }

  /** Admitted plans loaded through the counted reader; each loaded record is remembered for the retention closure. */
  planLoader(onLoaded?: (record: AdmittedPlan) => void) {
    const view = this.readView();
    return async (runId: string, revision: number): Promise<AdmittedPlan> => {
      this.boundary();
      const admitted = await loadPlan(view as unknown as SentinelStore, runId, revision);
      this.boundary();
      onLoaded?.(admitted);
      return admitted;
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The readonly admission proof. It writes nothing and grants nothing: it is not retained execution evidence, cannot
// populate a driver context and cannot authorize a launch. A request admission reads it to stage links.

export interface RetainedSourceAncestor { readonly runId: string; readonly revision: number; readonly planDigest: string; readonly snapshotId: string; readonly sourceId: string }
export interface ProofTiming {
  readonly signal: AbortSignal;
  /** Trusted absolute monotonic deadline (performance.now() milliseconds) from the caller's own grant. */
  readonly deadlineAt?: number;
  /** An additional, tighter caller check; never the only bound. */
  readonly stillWithin?: () => void;
}
declare const proofBrand: unique symbol;
export interface RetainedSourceProof { readonly [proofBrand]: true }

export type ClosureRole = 'plan' | 'profile' | 'rule-lock' | 'policy' | 'selection' | 'path-request' | 'influence' | 'invocation' | 'output'
  | 'analysis-result' | 'analysis-index' | 'analysis-artifact' | 'snapshot-manifest' | 'snapshot-materialization' | 'source-content';
export interface ClosureEntry { readonly id: ArtifactId; readonly role: ClosureRole }

export interface ReadonlyRetainedSource {
  readonly ancestor: RetainedSourceAncestor;
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly analysisFingerprint: string;
  readonly parse: Readonly<ExecutionProfileRecord['parse']>;
  /** Values are deep-frozen copies; `bytes` are fresh copies of the original bytes on every read. */
  readonly result: { readonly id: ArtifactId; readonly value: ParserResult; readonly bytes: Buffer };
  readonly index: { readonly id: ArtifactId; readonly value: ParserIndex; readonly bytes: Buffer };
  readonly artifact: { readonly id: ArtifactId; readonly value: AnalysisArtifact; readonly bytes: Buffer };
  /** The whole snapshot manifest's id: identity only. Its bytes name every source and stay private. */
  readonly manifest: ArtifactId;
  /** This source's snapshot entries only. */
  readonly entries: readonly CaptureEntry[];
  /** Every artifact read to prove this source, by role, sorted. */
  readonly closure: readonly ClosureEntry[];
}

interface ProofState {
  readonly store: SentinelStore;
  readonly owner: StoreOwner;
  readonly epoch: string;
  readonly storeId: string;
  readonly ancestor: RetainedSourceAncestor;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly view: StoredView;
  readonly bytes: Readonly<Record<'result' | 'index' | 'artifact' | 'manifest', Buffer>>;
  readonly usage: RetainedProofUsage;
}
type StoredView = Omit<ReadonlyRetainedSource, 'result' | 'index' | 'artifact'> & {
  readonly result: { readonly id: ArtifactId; readonly value: ParserResult };
  readonly index: { readonly id: ArtifactId; readonly value: ParserIndex };
  readonly artifact: { readonly id: ArtifactId; readonly value: AnalysisArtifact };
};
const proofs = new WeakMap<object, ProofState>();
const ANCESTOR_KEYS = ['runId', 'revision', 'planDigest', 'snapshotId', 'sourceId'] as const;
const ID = /^sha256:[0-9a-f]{64}$/;

function exactAncestor(value: RetainedSourceAncestor): RetainedSourceAncestor {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== ANCESTOR_KEYS.length || ANCESTOR_KEYS.some(k => !Object.hasOwn(value, k))
    || typeof value.runId !== 'string' || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.planDigest !== 'string'
    || typeof value.snapshotId !== 'string' || typeof value.sourceId !== 'string' || !value.sourceId) return fail('not an exact recorded ancestor');
  return Object.freeze({ runId: value.runId, revision: value.revision, planDigest: value.planDigest, snapshotId: value.snapshotId, sourceId: value.sourceId });
}

/** The recorded executed revision of a terminal run; never the latest admission. Ledger only. */
function assertRecordedAncestor(store: SentinelStore, a: RetainedSourceAncestor): void {
  const run = store.ledger.getRun(a.runId);
  const record = store.ledger.getPlan(a.runId, a.revision);
  if (!run || (run.state !== 'completed' && run.state !== 'canceled') || run.planRevision !== a.revision
    || run.envelope.snapshotId !== a.snapshotId || !record || record.digest !== a.planDigest || record.kind !== 'analysis'
    || record.snapshotId !== a.snapshotId) fail('not the recorded terminal ancestor revision');
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Prove a recorded terminal ancestor's retained source without writing anything: its exact admitted plan, selection
 * lineage, the accepted bootstrap inventory and parse operations, their original parser bytes, the snapshot manifest
 * and materialization, and every included body of this source, each read through the counted hash-checking reader.
 */
export async function retainedSourceForAdmission(store: SentinelStore, ancestorIn: RetainedSourceAncestor, timing: ProofTiming,
  limits: RetainedProofLimits = RETAINED_PROOF_LIMITS): Promise<RetainedSourceProof> {
  const owner = boundOwner(store);
  store.assertHeld();
  const epoch = store.epoch, storeId = store.storeId;
  const { signal, deadlineAt, stillWithin } = timing;
  const budget = new RetainedBudget(store, { signals: [signal], ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    ...(stillWithin ? { stillWithin: [stillWithin] } : {}), owner, epoch, limits });
  try {
    budget.boundary();
    const ancestor = exactAncestor(ancestorIn);
    assertRecordedAncestor(store, ancestor);
    const closure = new Map<string, ClosureEntry>();
    const add = (id: ArtifactId | null | undefined, role: ClosureRole) => {
      if (id == null) return;
      if (!ID.test(id)) fail('a retained reference is not an artifact id');
      closure.set(`${role}\u0000${id}`, Object.freeze({ id, role }));
    };
    const planRecord = (a: AdmittedPlan) => {
      add(a.record.plan, 'plan'); add(a.record.profile, 'profile'); add(a.record.ruleLock, 'rule-lock');
      add(a.record.policy, 'policy'); add(a.record.selection, 'selection'); add(a.plan.pins.pathRequest, 'path-request');
    };
    const load = budget.planLoader(planRecord);
    const admitted = await load(ancestor.runId, ancestor.revision);
    if (admitted.plan.kind !== 'analysis' || admitted.plan.digest !== ancestor.planDigest || admitted.record.digest !== ancestor.planDigest
      || admitted.plan.pins.snapshotId !== ancestor.snapshotId
      || admitted.plan.pins.analyses.filter(a => a.sourceId === ancestor.sourceId).length !== 1) fail('the ancestor plan is not its recorded analysis of this source');
    const lineageRuns = new Set<string>();
    const lineage = await retainedLineage(store, ancestor.runId, admitted, {
      loadPlan: async (runId, revision) => {
        // The existing lineage bound counts actual runs (including this ancestor), not repeated plan loads.
        if (!lineageRuns.has(runId)) {
          if (lineageRuns.size >= budget.limits.depth) budget.refuse('budget-depth');
          lineageRuns.add(runId);
        }
        return load(runId, revision);
      },
      invocation: async id => json(await budget.read(id, 'metadata')),
    });
    const io: RetainedSourceIO = { read: id => budget.read(id, 'metadata'), boundary: () => budget.boundary(), loadPlan: load };
    const v = await verifyRetainedSource(store, io, { admitted, inventory: lineage.inventory, sourceId: ancestor.sourceId, profile: admitted.profile });
    if (lineage.inventoryAttempt.envelope.invocation !== v.owned.attempt.envelope.invocation) fail('the lineage and the verified inventory disagree');
    // The accepted operations' own records: influence manifests recomputed from their admitted plan, invocations, outputs.
    for (const op of [v.owned, v.parsed]) {
      const canonical = canonicalArtifactId(influenceManifestOf(op.boot.plan, op.unit));
      if (op.row.envelope.influenceManifest !== canonical) fail('an operation influence manifest is not its canonical one');
      await budget.read(canonical, 'metadata');
      add(canonical, 'influence'); add(op.attempt.envelope.invocation!, 'invocation');
      for (const o of op.publication.outputs) add(o.id, 'output');
    }
    add(v.source.result, 'analysis-result'); add(v.source.index, 'analysis-index'); add(v.source.artifact, 'analysis-artifact');
    add(v.opened.record.manifest, 'snapshot-manifest'); add(v.opened.record.materialization, 'snapshot-materialization');
    // Every unique included body of this source, read and hashed, then dropped: one body buffer at a time.
    const bodies = [...new Set(v.opened.snapshot.entries.flatMap(e => e.sourceId === ancestor.sourceId && e.kind === 'file' && e.disposition === 'included' ? [e.content] : []))].sort(cmp);
    for (const id of bodies) { await budget.read(id as ArtifactId, 'source'); add(id as ArtifactId, 'source-content'); }
    const manifestBytes = await budget.read(v.opened.record.manifest, 'metadata');
    budget.retain(v.bytes.result.length + v.bytes.index.length + v.bytes.artifact.length + manifestBytes.length);
    const view: StoredView = deepFreeze({
      ancestor, sourceId: ancestor.sourceId, snapshotId: v.record.snapshotId, analysisFingerprint: v.source.analysisFingerprint,
      parse: structuredClone(admitted.profile.parse),
      result: { id: v.source.result, value: structuredClone(v.result) as ParserResult },
      index: { id: v.source.index, value: structuredClone(v.index) as ParserIndex },
      artifact: { id: v.source.artifact, value: structuredClone(v.artifact) as AnalysisArtifact },
      manifest: v.opened.record.manifest,
      entries: structuredClone(v.opened.snapshot.entries.filter(e => e.sourceId === ancestor.sourceId)),
      closure: [...closure.values()].sort((a, b) => cmp(a.role, b.role) || cmp(a.id, b.id)),
    });
    const handle = Object.freeze(Object.create(null)) as RetainedSourceProof;
    const state: ProofState = Object.freeze({ store, owner, epoch, storeId, ancestor, deadlineAt: budget.deadlineAt, signal, view,
      bytes: Object.freeze({ result: Buffer.from(v.bytes.result), index: Buffer.from(v.bytes.index), artifact: Buffer.from(v.bytes.artifact), manifest: Buffer.from(manifestBytes) }),
      usage: Object.freeze(budget.usage()) });
    // After every copy and state allocation: check, then immediately mint with the prepared state.
    budget.boundary();
    if (store.storeId !== storeId) fail('the store changed');
    assertRecordedAncestor(store, ancestor);
    proofs.set(handle, state);
    return handle;
  } catch (error) {
    if (budget.failure !== undefined) throw budget.failure;
    if (error instanceof ExecutionError && ['sentinel.execution.canceled', 'sentinel.execution.deadlineExceeded', 'sentinel.execution.analysisUnavailable'].includes(error.code)) throw error;
    throw new ExecutionError('sentinel.execution.analysisUnavailable', { reason: 'retained source evidence is missing, malformed or mismatched' }, { cause: error });
  }
}

/** A fresh copy: frozen values, and new Buffers (which cannot be frozen) over the original bytes. */
function copyView(state: ProofState): ReadonlyRetainedSource {
  const v = deepFreeze(structuredClone(state.view)) as StoredView;
  const role = <T extends { id: ArtifactId }>(r: T, bytes: Buffer) => Object.freeze({ ...r, bytes: Buffer.from(bytes) });
  return Object.freeze({ ...v, result: role(v.result, state.bytes.result), index: role(v.index, state.bytes.index), artifact: role(v.artifact, state.bytes.artifact) });
}

/**
 * Access an existing proof for exactly this genuine store, owner, epoch and recorded ancestor. The
 * original deadline and cancellation stay in force: a later call can only tighten them, never reset or extend them.
 */
function accessRetainedSourceProof(store: SentinelStore, proof: RetainedSourceProof, ancestorIn: RetainedSourceAncestor, timing: ProofTiming) {
  const state = (proof !== null && typeof proof === 'object') ? proofs.get(proof) : undefined;
  if (!state || store !== state.store) return fail('not a retained-source proof for this store');
  const { signal, deadlineAt, stillWithin } = timing;
  const budget = new RetainedBudget(store, { signals: [state.signal, signal], deadlineAt: Math.min(state.deadlineAt, callerDeadline(deadlineAt)),
    ...(stillWithin ? { stillWithin: [stillWithin] } : {}), owner: state.owner, epoch: state.epoch });
  const check = () => {
    budget.boundary();
    if (store.storeId !== state.storeId || boundOwner(store) !== state.owner) fail('the store owner or epoch changed');
    assertRecordedAncestor(store, state.ancestor);
  };
  check();
  const ancestor = exactAncestor(ancestorIn);
  if (!same(ancestor, state.ancestor)) fail('the proof is for another ancestor');
  return {state,check};
}

/** Checks an existing genuine proof without cloning its source view. This mints or exposes no authority. */
export function assertRetainedSourceProof(store: SentinelStore, proof: RetainedSourceProof, ancestor: RetainedSourceAncestor, timing: ProofTiming): void {
  accessRetainedSourceProof(store,proof,ancestor,timing);
}

/** Return independent source-view copies, with the original fences checked again after copying. */
export function readRetainedSourceProof(store: SentinelStore, proof: RetainedSourceProof, ancestor: RetainedSourceAncestor, timing: ProofTiming): ReadonlyRetainedSource {
  const {state,check}=accessRetainedSourceProof(store,proof,ancestor,timing);
  const view=copyView(state);
  check();
  return view;
}

/** Spent resources of a minted proof, for measurement. Not authority. */
export function retainedSourceProofUsage(proof: RetainedSourceProof): RetainedProofUsage | undefined {
  const state = (proof !== null && typeof proof === 'object') ? proofs.get(proof) : undefined;
  return state ? { ...state.usage } : undefined;
}
