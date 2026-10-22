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
// Nothing here starts a process, reads the network or accepts a worker's claim.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId, Id, WorkRef } from '../contracts/common.js';
import type { PlanEnvelope, PlanWork } from '../contracts/plan.js';
import type { RunEnvelope } from '../contracts/run.js';
import type { SnapshotEnvelope } from '../contracts/snapshot.js';
import { openSnapshot } from '../snapshot/materialize.js';
import { PARSER_INDEX_SCHEMA, PARSER_RESULT_SCHEMA, parseSnapshot, retainSnapshotAnalysis, type ParserIndex, type ParserResult } from '../snapshot/parser.js';
import type { SentinelStore } from '../store/index.js';
import type { PublicationReceipt, StagedArtifact } from '../store/store-types.js';
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
  analyses: Array<{ sourceId: Id; result: ArtifactId; index: ArtifactId; artifact: ArtifactId; analysisFingerprint: string }>;
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

const fail = (reason: string): never => { throw new ExecutionError('sentinel.execution.bootstrapEvidence', { reason }); };
const ref = (u: Pick<PlanWork, 'id' | 'revision'>): WorkRef => ({ id: u.id, revision: u.revision });
const now = () => new Date().toISOString();
const sorted = (xs: readonly string[]) => [...xs].sort().join('\u0000');

async function readJson<T>(store: SentinelStore, id: ArtifactId): Promise<T> {
  return JSON.parse((await store.readArtifact(id)).toString('utf8')) as T;
}

/** The plan's source set: one parse unit per source. */
const planSources = (plan: PlanEnvelope) => plan.units.filter(u => u.stage === 'parse').map(u => u.sourceId!);

/** Publish one canonical record (linking accepted artifacts) as the attempt's single output. */
async function publishRecord(store: SentinelStore, work: WorkRef, attemptId: Id, value: unknown, schema: string, links: ArtifactId[]): Promise<PublicationReceipt> {
  const id = store.objects.identifyCanonicalJson(value);
  const stageId = `stage.${attemptId}`.slice(0, 128);
  const staged: StagedArtifact[] = [{ id: id.id, schema, privacy: 'metadata', links }];
  store.ledger.registerStaging(stageId, staged, { work, attemptId });
  try {
    const receipt = await store.objects.putCanonicalJson(value, { expect: id });
    return store.ledger.publish({ work, attemptId, stageId, receipts: [receipt], outputs: [id.id], endedAt: now() });
  } catch (error) {
    try { store.assertHeld(); store.ledger.abortStaging(stageId); } catch { /* recovery aborts a stage left open */ }
    throw error;
  }
}

async function capture(r: OperationRequest): Promise<PublicationReceipt> {
  let opened;
  try { opened = await openSnapshot(r.store, r.run.snapshotId); } catch (cause) {
    throw new ExecutionError('sentinel.execution.bootstrapEvidence', { reason: 'the run\'s snapshot is not admitted in this store' }, { cause });
  }
  const sources = opened.snapshot.sources.map(s => s.sourceId);
  if (sorted(sources) !== sorted(planSources(r.plan))) fail('the snapshot holds other sources than the plan parses');
  if (sorted(sources) !== sorted(r.run.requestedScope.sourceIds)) fail('the snapshot holds other sources than the run requested');
  const record: CaptureRecord = {
    schema: CAPTURE_RECORD_SCHEMA, runId: r.run.id, snapshotId: opened.record.snapshotId, manifest: opened.record.manifest,
    materialization: opened.record.materialization, inventoryDigest: opened.record.inventoryDigest, admittedAt: opened.record.sequence, sourceIds: [...sources].sort(),
  };
  return publishRecord(r.store, ref(r.unit), r.attemptId, record, CAPTURE_RECORD_SCHEMA, [record.manifest, record.materialization]);
}

async function parse(r: OperationRequest): Promise<PublicationReceipt> {
  const sourceId = r.unit.sourceId;
  if (!sourceId) return fail('a parse unit names its source');
  const work = mkdtempSync(join(r.scratchRoot, 'parse-'));
  try {
    const analysis = await parseSnapshot(r.store, { snapshotId: r.run.snapshotId, workDir: work, sources: [sourceId],
      selection: r.profile.parse.selection, limits: r.profile.parse.limits, ...(r.signal ? { signal: r.signal } : {}) });
    if (analysis.snapshotId !== r.run.snapshotId || analysis.sources.length !== 1 || analysis.sources[0]!.sourceId !== sourceId) {
      fail('the parser analysed another snapshot or source');
    }
    const { receipt } = await retainSnapshotAnalysis(r.store, { work: ref(r.unit), attemptId: r.attemptId, stageId: `stage.${r.attemptId}`.slice(0, 128), endedAt: now() }, analysis);
    return receipt;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** The retained parser result of one published parse unit, checked to be its source's analysis of this snapshot. */
async function parseEvidence(store: SentinelStore, unit: WorkRef, sourceId: Id, snapshotId: Id) {
  const pub = store.ledger.getPublication(unit);
  if (!pub) return fail(`parse unit ${unit.id} has not published`);
  const outs = pub.outputs.filter(o => o.schema === PARSER_RESULT_SCHEMA);
  if (outs.length !== 1) return fail(`parse unit ${unit.id} did not publish exactly one parser result`);
  const result = await readJson<ParserResult & { artifact: ArtifactId; index: ArtifactId }>(store, outs[0]!.id);
  if (result.snapshotId !== snapshotId || result.sourceId !== sourceId) fail(`parse unit ${unit.id} analysed another snapshot or source`);
  return { sourceId, result: outs[0]!.id, index: result.index, artifact: result.artifact, analysisFingerprint: result.analysisFingerprint };
}

async function inventory(r: OperationRequest): Promise<PublicationReceipt> {
  const opened = await openSnapshot(r.store, r.run.snapshotId);
  const parses = r.plan.units.filter(u => u.stage === 'parse');
  const deps = new Set(r.unit.dependencies.map(d => `${d.id}@${d.revision}`));
  if (parses.length !== deps.size || parses.some(p => !deps.has(`${p.id}@${p.revision}`))) fail('the inventory depends on other units than the plan\'s parses');
  const analyses = [];
  for (const p of [...parses].sort((a, b) => (a.sourceId! < b.sourceId! ? -1 : 1))) analyses.push(await parseEvidence(r.store, ref(p), p.sourceId!, r.run.snapshotId));
  const record: InventoryRecord = { schema: INVENTORY_RECORD_SCHEMA, runId: r.run.id, snapshotId: opened.record.snapshotId, manifest: opened.record.manifest,
    inventoryDigest: opened.record.inventoryDigest, analyses };
  return publishRecord(r.store, ref(r.unit), r.attemptId, record, INVENTORY_RECORD_SCHEMA, [record.manifest, ...analyses.map(a => a.result)]);
}

const OPERATIONS: Readonly<Record<BootstrapOperation, (r: OperationRequest) => Promise<PublicationReceipt>>> = Object.freeze({ capture, parse, inventory });

/** Run one bootstrap unit's operation under its recorded attempt; it publishes through that attempt. */
export function runOperation(operation: BootstrapOperation, request: OperationRequest): Promise<PublicationReceipt> {
  if (request.unit.stage !== operation) return Promise.reject(new ExecutionError('sentinel.execution.planInvalid', { reason: `unit ${request.unit.id} is a ${request.unit.stage} stage, not ${operation}` }));
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
export async function loadBootstrap(store: SentinelStore, runId: Id, inventoryUnit: WorkRef): Promise<BootstrapEvidence> {
  const row = store.ledger.getWork(inventoryUnit);
  if (!row || row.runId !== runId) return fail('the inventory unit is not work of this run');
  const pub = store.ledger.getPublication(inventoryUnit);
  const out = pub?.outputs.filter(o => o.schema === INVENTORY_RECORD_SCHEMA) ?? [];
  if (out.length !== 1) return fail('the inventory unit has not published one inventory record');
  const record = await readJson<InventoryRecord>(store, out[0]!.id);
  if (record.schema !== INVENTORY_RECORD_SCHEMA || record.runId !== runId) fail('the inventory record names another run');
  const opened = await openSnapshot(store, record.snapshotId);
  if (opened.record.manifest !== record.manifest || opened.record.inventoryDigest !== record.inventoryDigest) fail('the inventory names another snapshot');
  const analyses = [];
  for (const a of record.analyses) {
    const result = await readJson<ParserResult & { artifact: ArtifactId; index: ArtifactId }>(store, a.result);
    const index = await readJson<ParserIndex>(store, a.index);
    if (result.sourceId !== a.sourceId || result.snapshotId !== record.snapshotId || result.index !== a.index || (index as { schema?: string }).schema !== PARSER_INDEX_SCHEMA) {
      fail(`the retained analysis of ${a.sourceId} is not this snapshot's`);
    }
    analyses.push({ sourceId: a.sourceId, result, index });
  }
  return { snapshot: opened.snapshot, analyses, record };
}
