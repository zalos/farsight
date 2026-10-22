// The one place that proves a source's retained bootstrap evidence: the accepted coordinator inventory and parse
// operations that own it, and the original parser result, index and artifact they published over the exact snapshot.
// Internal. It mints nothing: execution (retained-analysis.ts) adds its ValidatedPlan and exact-unit checks around
// it, and only that caller may turn the result into retained execution evidence.
import type { ArtifactId, WorkRef } from '../contracts/common.js';
import { openSnapshot, type OpenedSnapshot } from '../snapshot/materialize.js';
import { PARSER_INDEX_SCHEMA, PARSER_RESULT_SCHEMA } from '../snapshot/parser.js';
import type { SentinelStore } from '../store/index.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { INVENTORY_RECORD_SCHEMA, type InventoryRecord } from './bootstrap.js';
import { ExecutionError } from './errors.js';
import { loadPlan, type AdmittedPlan } from './plans.js';
import type { ExecutionProfileRecord } from './profile.js';

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

/** The execution reader: the admitted plan loader over the genuine store. */
export const storePlanLoader = (store: SentinelStore) => (runId: string, revision: number) => loadPlan(store, runId, revision);
