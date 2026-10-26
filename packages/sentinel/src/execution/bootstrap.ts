// The bootstrap operations: capture, parse and inventory, run by the coordinator in its own process over the store
// it owns, each under a recorded attempt of its plan unit and published through that attempt like any work.
//
// Authority and evidence, per stage:
// - capture: the snapshot the run names, admitted in this store by the capture module (PR 04) before the run
//   existed. The stage verifies it (manifest, materialization and ledger record agree; its sources are exactly the
//   plan's) and publishes a capture record naming it. It never captures again, and never stands in for a capture:
//   a run whose snapshot was not admitted here fails this stage.
// - parse: the real public parser over a read-only restore of that snapshot (PR 05 parseSnapshot), one source per
//   unit, with the selection and limits the profile pinned; the complete analysis, its index and its result are
//   retained through the attempt (retainSnapshotAnalysis).
// - inventory: the published parse results of exactly the plan's parse units, each verified to be the analysis of
//   its source of this snapshot, gathered into one inventory record. An analysis revision plans from it
//   (loadBootstrap), so planning reads only published evidence.
// Nothing here starts a process, reads the network or accepts a worker's claim. An operation only reads and
// prepares its records; the coordinator holds them to the unit's grant before publishPrepared writes anything.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { InstructionArtifact } from '../review/instructions.js';
import type { AttemptUsage } from '../contracts/attempt.js';
import type { ArtifactId, Id, WorkRef } from '../contracts/common.js';
import type { PlanEnvelope, PlanWork } from '../contracts/plan.js';
import type { RunEnvelope } from '../contracts/run.js';
import type { SnapshotEnvelope } from '../contracts/snapshot.js';
import { openSnapshot } from '../snapshot/materialize.js';
import {
  PARSER_INDEX_SCHEMA,
  PARSER_RESULT_SCHEMA,
  parseSnapshot,
  type ParserIndex,
  type ParserResult,
} from '../snapshot/parser.js';
import type { SentinelStore } from '../store/index.js';
import {
  MAX_ARTIFACT_BYTES,
  type ArtifactPrivacy,
  type PublicationReceipt,
  type StagedArtifact,
} from '../store/store-types.js';
import { ExecutionError } from './errors.js';
import type { ExecutionProfileRecord } from './profile.js';
import type { BootstrapOperation } from './registry.js';

export const CAPTURE_RECORD_SCHEMA = 'sentinel-bootstrap-capture/draft-1';
export const INVENTORY_RECORD_SCHEMA = 'sentinel-bootstrap-inventory/draft-1';

export interface CaptureRecord {
  schema: typeof CAPTURE_RECORD_SCHEMA;
  runId: Id;
  snapshotId: Id;
  manifest: ArtifactId;
  materialization: ArtifactId;
  inventoryDigest: string;
  /** The ledger sequence the snapshot was admitted at. */
  admittedAt: number;
  sourceIds: Id[];
}

export interface InventoryRecord {
  schema: typeof INVENTORY_RECORD_SCHEMA;
  runId: Id;
  snapshotId: Id;
  manifest: ArtifactId;
  inventoryDigest: string;
  analyses: Array<{
    sourceId: Id;
    result: ArtifactId;
    index: ArtifactId;
    artifact: ArtifactId;
    analysisFingerprint: string;
  }>;
}

export interface OperationRequest {
  store: SentinelStore;
  run: RunEnvelope;
  plan: PlanEnvelope;
  unit: PlanWork;
  profile: ExecutionProfileRecord;
  attemptId: Id;
  scratchRoot: string;
  signal?: AbortSignal;
}

const fail = (reason: string): never => {
  throw new ExecutionError('sentinel.execution.bootstrapEvidence', { reason });
};
const ref = (u: Pick<PlanWork, 'id' | 'revision'>): WorkRef => ({ id: u.id, revision: u.revision });
const now = () => new Date().toISOString();
const sorted = (xs: readonly string[]) => [...xs].sort().join('\u0000');

async function readJson<T>(store: SentinelStore, id: ArtifactId): Promise<T> {
  return JSON.parse((await store.readArtifact(id)).toString('utf8')) as T;
}

/** The plan's source set: one parse unit per source. */
const planSources = (plan: PlanEnvelope) => plan.units.filter((u) => u.stage === 'parse').map((u) => u.sourceId!);

/**
 * What an operation prepared: canonical records to store and publish, nothing written yet. The coordinator holds
 * them to the unit's grant (deadline, output bytes, memory) and the attempt's fence before publishPrepared writes any.
 */
export interface PreparedOutputs {
  artifacts?: readonly InstructionArtifact[];
  usage?: AttemptUsage;
  records: Array<{ value: unknown; schema: string; privacy: ArtifactPrivacy; links: ArtifactId[] }>;
  outputs: ArtifactId[];
  /** Canonical bytes the records hold, as they would be stored. */
  bytes: number;
}

function prepare(
  store: SentinelStore,
  items: Array<{ value: unknown; schema: string; privacy: ArtifactPrivacy; links?: ArtifactId[]; output?: boolean }>,
): PreparedOutputs {
  bootstrapIo.beforePrepare?.(items);
  const records: PreparedOutputs['records'] = [];
  const seen = new Set<string>();
  const outputs: ArtifactId[] = [];
  let bytes = 0;
  for (const i of items) {
    const id = store.objects.identifyCanonicalJson(i.value);
    if (id.rawSize > MAX_ARTIFACT_BYTES) fail(`${i.schema} exceeds the store's object cap`);
    if (seen.has(id.id)) continue;
    seen.add(id.id);
    records.push({ value: i.value, schema: i.schema, privacy: i.privacy, links: i.links ?? [] });
    bytes += id.rawSize;
    if (i.output) outputs.push(id.id);
  }
  return { records, outputs, bytes };
}

/** Package-internal test seam: awaited before each prepared record is written (to widen the write window). */
export const bootstrapIo: {
  beforeWrite?: (value: unknown) => Promise<void>;
  // Internal fault injection before identities are computed. Only an in-process test can set this hook;
  // no request, persisted option, driver context, worker message or public export can reach it. Production
  // defaults to no hook. Tests can publish validly hashed but semantically wrong coordinator-produced evidence
  // through the real attempt/publication path; corrupting bytes alone only exercises the hash checker.
  beforePrepare?: (
    items: Array<{ value: unknown; schema: string; privacy: ArtifactPrivacy; links?: ArtifactId[]; output?: boolean }>,
  ) => void;
} = {};

/** Stage, store and publish prepared outputs through the attempt; the ledger's fence decides acceptance. */
export async function publishPrepared(
  store: SentinelStore,
  work: WorkRef,
  attemptId: Id,
  prepared: PreparedOutputs,
  /** Called after every object is durable and immediately before the ledger accepts: it throws to refuse. */
  beforeAccept?: () => void,
): Promise<PublicationReceipt> {
  const ids = prepared.records.map((r) => store.objects.identifyCanonicalJson(r.value));
  const stageId = `stage.${attemptId}`.slice(0, 128);
  const staged: StagedArtifact[] = prepared.records.map((r, i) => ({
    id: ids[i]!.id,
    schema: r.schema,
    privacy: r.privacy,
    links: r.links,
  }));
  const raw = [...new Map((prepared.artifacts ?? []).map((a) => [a.id, a])).values()].filter(
    (a) => !ids.some((i) => i.id === a.id),
  );
  staged.push(
    ...raw.map((a) => ({ id: a.id, schema: a.schema, privacy: 'source-derived' as const, links: [...a.links] })),
  );
  store.ledger.registerStaging(stageId, staged, { work, attemptId });
  try {
    const receipts = [];
    for (let i = 0; i < ids.length; i++) {
      await bootstrapIo.beforeWrite?.(prepared.records[i]!.value);
      receipts.push(await store.objects.putCanonicalJson(prepared.records[i]!.value, { expect: ids[i]! }));
    }
    for (const a of raw) {
      receipts.push(await store.objects.put(a.bytes, { expect: { id: a.id, rawSize: a.bytes.byteLength } }));
      beforeAccept?.();
    }
    store.assertHeld();
    // No await from here to the acceptance: what beforeAccept checked still holds when the ledger commits.
    beforeAccept?.();
    return store.ledger.publish({
      work,
      attemptId,
      stageId,
      receipts,
      outputs: [...prepared.outputs, ...raw.map((a) => a.id)],
      endedAt: now(),
      ...(prepared.usage ? { usage: prepared.usage } : {}),
    });
  } catch (error) {
    try {
      store.assertHeld();
      store.ledger.abortStaging(stageId);
    } catch {
      /* recovery aborts a stage left open */
    }
    throw error;
  }
}

async function capture(r: OperationRequest): Promise<PreparedOutputs> {
  let opened;
  try {
    opened = await openSnapshot(r.store, r.run.snapshotId);
  } catch (cause) {
    throw new ExecutionError(
      'sentinel.execution.bootstrapEvidence',
      { reason: "the run's snapshot is not admitted in this store" },
      { cause },
    );
  }
  const sources = opened.snapshot.sources.map((s) => s.sourceId);
  if (sorted(sources) !== sorted(planSources(r.plan))) fail('the snapshot holds other sources than the plan parses');
  if (sorted(sources) !== sorted(r.run.requestedScope.sourceIds))
    fail('the snapshot holds other sources than the run requested');
  const record: CaptureRecord = {
    schema: CAPTURE_RECORD_SCHEMA,
    runId: r.run.id,
    snapshotId: opened.record.snapshotId,
    manifest: opened.record.manifest,
    materialization: opened.record.materialization,
    inventoryDigest: opened.record.inventoryDigest,
    admittedAt: opened.record.sequence,
    sourceIds: [...sources].sort(),
  };
  return prepare(r.store, [
    {
      value: record,
      schema: CAPTURE_RECORD_SCHEMA,
      privacy: 'metadata',
      links: [record.manifest, record.materialization],
      output: true,
    },
  ]);
}

async function parse(r: OperationRequest): Promise<PreparedOutputs> {
  const sourceId = r.unit.sourceId;
  if (!sourceId) return fail('a parse unit names its source');
  const work = mkdtempSync(join(r.scratchRoot, 'parse-'));
  try {
    const analysis = await parseSnapshot(r.store, {
      snapshotId: r.run.snapshotId,
      workDir: work,
      sources: [sourceId],
      selection: r.profile.parse.selection,
      limits: r.profile.parse.limits,
      ...(r.signal ? { signal: r.signal } : {}),
    });
    if (
      analysis.snapshotId !== r.run.snapshotId ||
      analysis.sources.length !== 1 ||
      analysis.sources[0]!.sourceId !== sourceId
    ) {
      fail('the parser analysed another snapshot or source');
    }
    // The records retainSnapshotAnalysis keeps: the complete analysis, its index, and its result naming both.
    const src = analysis.sources[0]!;
    const artifact = r.store.objects.identifyCanonicalJson(src.artifact).id;
    const index = r.store.objects.identifyCanonicalJson(src.index).id;
    return prepare(r.store, [
      { value: src.artifact, schema: 'farsight-analysis', privacy: 'source' },
      { value: src.index, schema: PARSER_INDEX_SCHEMA, privacy: 'source-derived' },
      {
        value: { ...src.result, artifact, index },
        schema: PARSER_RESULT_SCHEMA,
        privacy: 'source-derived',
        links: [artifact, index],
        output: true,
      },
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The retained parser result of one published parse unit, checked to be its source's analysis of this snapshot. */
async function parseEvidence(store: SentinelStore, unit: WorkRef, sourceId: Id, snapshotId: Id) {
  const pub = store.ledger.getPublication(unit);
  if (!pub) return fail(`parse unit ${unit.id} has not published`);
  const outs = pub.outputs.filter((o) => o.schema === PARSER_RESULT_SCHEMA);
  if (outs.length !== 1) return fail(`parse unit ${unit.id} did not publish exactly one parser result`);
  const result = await readJson<ParserResult & { artifact: ArtifactId; index: ArtifactId }>(store, outs[0]!.id);
  if (result.snapshotId !== snapshotId || result.sourceId !== sourceId)
    fail(`parse unit ${unit.id} analysed another snapshot or source`);
  return {
    sourceId,
    result: outs[0]!.id,
    index: result.index,
    artifact: result.artifact,
    analysisFingerprint: result.analysisFingerprint,
  };
}

async function inventory(r: OperationRequest): Promise<PreparedOutputs> {
  const opened = await openSnapshot(r.store, r.run.snapshotId);
  const parses = r.plan.units.filter((u) => u.stage === 'parse');
  const deps = new Set(r.unit.dependencies.map((d) => `${d.id}@${d.revision}`));
  if (parses.length !== deps.size || parses.some((p) => !deps.has(`${p.id}@${p.revision}`)))
    fail("the inventory depends on other units than the plan's parses");
  const analyses = [];
  for (const p of [...parses].sort((a, b) => (a.sourceId! < b.sourceId! ? -1 : 1)))
    analyses.push(await parseEvidence(r.store, ref(p), p.sourceId!, r.run.snapshotId));
  const record: InventoryRecord = {
    schema: INVENTORY_RECORD_SCHEMA,
    runId: r.run.id,
    snapshotId: opened.record.snapshotId,
    manifest: opened.record.manifest,
    inventoryDigest: opened.record.inventoryDigest,
    analyses,
  };
  return prepare(r.store, [
    {
      value: record,
      schema: INVENTORY_RECORD_SCHEMA,
      privacy: 'metadata',
      links: [record.manifest, ...analyses.map((a) => a.result)],
      output: true,
    },
  ]);
}

const OPERATIONS: Readonly<Record<BootstrapOperation, (r: OperationRequest) => Promise<PreparedOutputs>>> =
  Object.freeze({ capture, parse, inventory });

/** Run one bootstrap unit's operation: it reads and prepares, and writes nothing (publishPrepared does, if granted). */
export function runOperation(operation: BootstrapOperation, request: OperationRequest): Promise<PreparedOutputs> {
  if (request.unit.stage !== operation)
    return Promise.reject(
      new ExecutionError('sentinel.execution.planInvalid', {
        reason: `unit ${request.unit.id} is a ${request.unit.stage} stage, not ${operation}`,
      }),
    );
  return OPERATIONS[operation](request);
}

export interface BootstrapEvidence {
  snapshot: SnapshotEnvelope;
  /** Each source's retained parser result and index, as plannerAnalysisFrom takes them. */
  analyses: Array<{ sourceId: Id; result: ParserResult; index: ParserIndex }>;
  record: InventoryRecord;
}

/**
 * What an analysis revision plans from: a published inventory unit of this run, its snapshot and every source's
 * retained parser result and index, each read back from the store and checked against the others.
 */
export async function loadBootstrap(
  store: SentinelStore,
  runId: Id,
  inventoryUnit: WorkRef,
): Promise<BootstrapEvidence> {
  const row = store.ledger.getWork(inventoryUnit);
  if (!row || row.runId !== runId) return fail('the inventory unit is not work of this run');
  const pub = store.ledger.getPublication(inventoryUnit);
  const out = pub?.outputs.filter((o) => o.schema === INVENTORY_RECORD_SCHEMA) ?? [];
  if (out.length !== 1) return fail('the inventory unit has not published one inventory record');
  const record = await readJson<InventoryRecord>(store, out[0]!.id);
  if (record.schema !== INVENTORY_RECORD_SCHEMA || record.runId !== runId)
    fail('the inventory record names another run');
  const opened = await openSnapshot(store, record.snapshotId);
  if (opened.record.manifest !== record.manifest || opened.record.inventoryDigest !== record.inventoryDigest)
    fail('the inventory names another snapshot');
  const analyses = [];
  for (const a of record.analyses) {
    const result = await readJson<ParserResult & { artifact: ArtifactId; index: ArtifactId }>(store, a.result);
    const index = await readJson<ParserIndex>(store, a.index);
    if (
      result.sourceId !== a.sourceId ||
      result.snapshotId !== record.snapshotId ||
      result.index !== a.index ||
      (index as { schema?: string }).schema !== PARSER_INDEX_SCHEMA
    ) {
      fail(`the retained analysis of ${a.sourceId} is not this snapshot's`);
    }
    analyses.push({ sourceId: a.sourceId, result, index });
  }
  return { snapshot: opened.snapshot, analyses, record };
}

/** The file this implementation runs from (moved by the packer into a bundle chunk): its bytes are the operation adapter's digest. */
export const INVENTORY_IMPLEMENTATION_URL: string = import.meta.url;
