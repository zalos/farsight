// Only the coordinator creates retained evidence, from its exact admitted plan and the ledger's accepted
// bootstrap. Artifact JSON, a caller's ids or a copied context cannot grant access to retained auxiliary bytes.
import { createHash } from 'node:crypto';
import type { ArtifactId, WorkRef } from '../contracts/common.js';
import type { PlanWork } from '../contracts/plan.js';
import { deepFreeze } from '../policy/immutable.js';
import { openSnapshot } from '../snapshot/materialize.js';
import { PARSER_INDEX_SCHEMA, PARSER_RESULT_SCHEMA, type AnalysisArtifact, type ParserIndex, type ParserResult } from '../snapshot/parser.js';
import type { SentinelStore } from '../store/index.js';
import { MAX_ARTIFACT_BYTES } from '../store/store-types.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { INVENTORY_RECORD_SCHEMA, type InventoryRecord } from './bootstrap.js';
import type { RetainedAnalysis } from './check-drivers.js';
import { ExecutionError } from './errors.js';
import { isValidatedPlan, type ValidatedPlan } from './plan.js';
import { loadPlan } from './plans.js';
import type { ExecutionProfileRecord } from './profile.js';

export type AnalysisRole = 'analysis-result' | 'analysis-index' | 'analysis-artifact' | 'snapshot-manifest';
const retained = new WeakMap<object, Readonly<Record<AnalysisRole, Buffer>>>();
const same = (a: unknown, b: unknown) => canonicalJsonBytes(a ?? null).equals(canonicalJsonBytes(b ?? null));
const refSame = (a: WorkRef, b: WorkRef) => a.id === b.id && a.revision === b.revision;
const fail = (reason: string): never => { throw new ExecutionError('sentinel.execution.analysisUnavailable', { reason }); };

/** Copy on read: drivers cannot change the original retained bytes or mint this capability structurally. */
export function retainedBytesOf(value: RetainedAnalysis | null): Readonly<Record<AnalysisRole, Buffer>> {
  const bytes = value && retained.get(value);
  if (!bytes) return fail('not coordinator-produced retained evidence');
  return Object.fromEntries(Object.entries(bytes).map(([role, buffer]) => [role, Buffer.from(buffer)])) as Record<AnalysisRole, Buffer>;
}

/** The exact mapping the coordinator checks after prepare and records with the attempt's invocation. */
export function retainedBinding(value: RetainedAnalysis) {
  if (!retained.has(value)) return fail('not coordinator-produced retained evidence');
  return { inventory: value.inventory, result: value.result.id, index: value.index.id, artifact: value.artifact.id, manifest: value.manifest };
}

export function verifyRetainedAuxiliary(value: RetainedAnalysis | null, auxiliary: readonly { id: ArtifactId; role: string }[]): void {
  const roles: Record<AnalysisRole, ArtifactId> | null = value ? {
    'analysis-result': value.result.id, 'analysis-index': value.index.id,
    'analysis-artifact': value.artifact.id, 'snapshot-manifest': value.manifest,
  } : null;
  if (value) retainedBytesOf(value);
  if (roles && auxiliary.some(a => Object.values(roles).includes(a.id) && !Object.hasOwn(roles, a.role))) throw new ExecutionError('sentinel.execution.inputMismatch', { reason: 'retained bytes have a foreign auxiliary role' });
  for (const role of ['analysis-result', 'analysis-index', 'analysis-artifact', 'snapshot-manifest'] as const) {
    const found = auxiliary.filter(a => a.role === role);
    if (roles ? found.length !== 1 || found[0]!.id !== roles[role] : found.length !== 0) {
      throw new ExecutionError('sentinel.execution.inputMismatch', { reason: 'retained analysis auxiliary roles differ from the exact admitted evidence' });
    }
  }
}

export async function retainedAnalysisFor(store: SentinelStore, plan: ValidatedPlan, unit: Readonly<PlanWork>,
  profile: Readonly<ExecutionProfileRecord>, signal: AbortSignal, stillWithin: () => void = () => {}): Promise<RetainedAnalysis> {
  const boundary = () => {
    store.assertHeld();
    if (signal.aborted) throw new ExecutionError('sentinel.execution.canceled');
    stillWithin();
  };
  const read = async (id: ArtifactId) => {
    boundary();
    const bytes = await store.readArtifact(id);
    boundary();
    if (bytes.length > MAX_ARTIFACT_BYTES || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== id) return fail('retained bytes differ from their identity');
    return Buffer.from(bytes);
  };
  const json = (bytes: Buffer): any => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  try {
    boundary();
    if (!isValidatedPlan(store, plan) || unit.stage !== 'check' || !unit.sourceId || plan.unitOf(unit).unit !== unit) return fail('not an exact validated check unit');
    const checks = plan.unitOf(unit).checks;
    if (unit.scopes.length !== 1 || unit.scopes[0] !== unit.sourceId || !checks.length || checks.length !== unit.checks.length
      || checks.some(c => c.state !== 'planned' || c.scopeKind !== 'repository' || c.scopeId !== unit.sourceId || c.sourceId !== unit.sourceId)) return fail('retained whole-source analysis requires repository-scoped checks');
    const admitted = await loadPlan(store, plan.run.id, plan.admitted.plan.revision);
    boundary();
    if (!same(admitted.record, plan.admitted.record) || !same(admitted.plan, plan.admitted.plan) || !same(profile, admitted.profile)) return fail('not the admitted plan and parse profile');
    if (unit.dependencies.length !== 1) return fail('a retained-analysis check depends on exactly one bootstrap inventory');
    const inventory = unit.dependencies[0]!;
    if (!plan.reusedProven(inventory) || !admitted.plan.reused.some(r => refSame(r, inventory))) return fail('the dependency is not a proven reused bootstrap');

    // Verify actual accepted operation ownership, not merely a schema-valid JSON document naming this source.
    const operation = async (ref: WorkRef, stage: 'inventory' | 'parse', sourceId: string | null, expectedRun?: string) => {
      boundary();
      const row = store.ledger.getWork(ref), publication = store.ledger.getPublication(ref);
      if (!row || !publication || !refSame(publication.work, ref) || (expectedRun && row.runId !== expectedRun)) return fail('bootstrap publication belongs to other work or run');
      const boot = await loadPlan(store, row.runId, row.envelope.planRevision);
      boundary();
      const u = boot.plan.units.find(x => refSame(x, ref));
      const pin = boot.profile.operations[stage];
      if (boot.plan.kind !== 'bootstrap' || !u || u.stage !== stage || u.sourceId !== sourceId || !pin
        || u.adapterId !== pin.adapterId || u.implementationDigest !== pin.digest || !same(row.envelope.stage, { contract: u.contract, contractVersion: 'draft-1', kind: 'coded', implementationDigest: u.implementationDigest })
        || !same(row.envelope.dependencies, u.dependencies)) return fail('the publication is not its admitted bootstrap operation');
      const attempt = store.ledger.getAttempt(publication.attemptId);
      const worker = attempt?.envelope.worker;
      if (!attempt || attempt.state !== 'succeeded' || !refSame(attempt.work, ref) || worker?.kind !== 'coordinator-operation'
        || worker.adapterId !== pin.adapterId || worker.adapterDigest !== pin.digest || !attempt.envelope.invocation) return fail('no accepted coordinator operation owns this publication');
      const invocation = json(await read(attempt.envelope.invocation));
      if (invocation.format !== 'sentinel-operation-invocation/draft-1' || invocation.store !== store.storeId || invocation.attemptId !== attempt.id
        || !refSame(invocation.work, ref) || invocation.coordinatorEpoch !== attempt.epoch || invocation.operation !== stage
        || invocation.adapter?.id !== pin.adapterId || invocation.adapter?.digest !== pin.digest
        || !same(invocation.plan, { runId: row.runId, revision: boot.plan.revision, digest: boot.plan.digest })
        || invocation.influenceManifest !== row.envelope.influenceManifest || invocation.snapshotId !== admitted.plan.pins.snapshotId || invocation.sourceId !== sourceId
        || (stage === 'parse' && (!same(invocation.parse, profile.parse) || !same(boot.profile.parse, profile.parse)))) return fail('bootstrap invocation differs from the pinned execution');
      return { row, publication, unit: u, boot };
    };
    const owned = await operation(inventory, 'inventory', null);
    const outputs = owned.publication.outputs;
    if (outputs.length !== 1 || outputs[0]!.schema !== INVENTORY_RECORD_SCHEMA) return fail('not exactly one published inventory record');
    const record = json(await read(outputs[0]!.id)) as InventoryRecord;
    if (record.schema !== INVENTORY_RECORD_SCHEMA || record.runId !== owned.row.runId || record.snapshotId !== admitted.plan.pins.snapshotId
      || record.inventoryDigest !== admitted.plan.pins.inventoryDigest || !Array.isArray(record.analyses) || record.analyses.length > 64) return fail('inventory differs from the pinned snapshot');
    const analyses = record.analyses.filter(a => a.sourceId === unit.sourceId), pins = admitted.plan.pins.analyses.filter(a => a.sourceId === unit.sourceId);
    if (analyses.length !== 1 || pins.length !== 1 || analyses[0]!.analysisFingerprint !== pins[0]!.analysisFingerprint) return fail('not exactly one pinned source analysis');
    const source = analyses[0]!;
    // The referenced result must also be the real parser publication that the inventory depends on.
    if (owned.unit.dependencies.length > 64) return fail('inventory dependency bound exceeded');
    for (const ref of owned.unit.dependencies) {
      const row = store.ledger.getWork(ref);
      if (row?.runId !== owned.row.runId || row.envelope.planRevision !== owned.row.envelope.planRevision) return fail('inventory depends on foreign bootstrap work');
    }
    const parses = owned.boot.plan.units.filter(u => u.stage === 'parse' && u.sourceId === unit.sourceId
      && owned.unit.dependencies.some(ref => refSame(ref, u)));
    if (parses.length !== 1) return fail('inventory does not depend on exactly one parse of this source');
    const parsed = await operation(parses[0]!, 'parse', unit.sourceId, owned.row.runId);
    if (parsed.publication.outputs.length !== 1 || parsed.publication.outputs[0]!.schema !== PARSER_RESULT_SCHEMA || parsed.publication.outputs[0]!.id !== source.result) return fail('inventory names another parser publication');
    const resultBytes = await read(source.result), indexBytes = await read(source.index), artifactBytes = await read(source.artifact);
    const result = json(resultBytes), index = json(indexBytes), artifact = json(artifactBytes);
    if (result.schema !== PARSER_RESULT_SCHEMA || result.snapshotId !== record.snapshotId || result.sourceId !== unit.sourceId
      || result.analysisFingerprint !== source.analysisFingerprint || result.index !== source.index || result.artifact !== source.artifact
      || !same(result.parser, artifact.analysis?.parser) || !same(result.adapters, artifact.analysis?.adapters) || result.parserComplete !== artifact.analysis?.complete
      || !same(result.selection, profile.parse.selection) || !same(result.limits, profile.parse.limits)) return fail('parser result differs from the pinned source, artifacts or parse options');
    if (index.schema !== PARSER_INDEX_SCHEMA || index.snapshotId !== record.snapshotId || index.sourceId !== unit.sourceId || index.analysisFingerprint !== source.analysisFingerprint
      || artifact.format !== 'farsight-analysis' || artifact.schemaVersion !== 1 || artifact.graph?.repo !== unit.sourceId
      || artifact.analysis?.fingerprint !== source.analysisFingerprint || !Array.isArray(artifact.graph.nodes) || !Array.isArray(artifact.graph.edges)) return fail('retained index or artifact differs from the pinned source');
    const opened = await openSnapshot({ ledger: store.ledger, readArtifact: read }, record.snapshotId);
    boundary();
    if (opened.record.manifest !== record.manifest || opened.record.inventoryDigest !== record.inventoryDigest) return fail('inventory names another snapshot manifest');
    const expectedInputs = opened.snapshot.entries.filter(e => e.sourceId === unit.sourceId && e.kind === 'file' && e.disposition === 'included').map(e => ({ sourceId: e.sourceId, relativePath: e.relativePath, content: e.kind === 'file' && e.disposition === 'included' ? e.content : '' })).sort((a,b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
    if (!same([...unit.inputs].sort((a,b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0), expectedInputs)) return fail('whole-source retained evidence requires every included captured source file');
    const manifestBytes = await read(record.manifest);
    const value: RetainedAnalysis = deepFreeze({ sourceId: unit.sourceId, snapshotId: record.snapshotId, analysisFingerprint: source.analysisFingerprint,
      inventory: { ...inventory }, result: { id: source.result, value: result as ParserResult }, index: { id: source.index, value: index as ParserIndex },
      artifact: { id: source.artifact, value: artifact as AnalysisArtifact }, manifest: record.manifest,
      entries: opened.snapshot.entries.filter(e => e.sourceId === unit.sourceId) });
    retained.set(value, { 'analysis-result': resultBytes, 'analysis-index': indexBytes, 'analysis-artifact': artifactBytes, 'snapshot-manifest': manifestBytes });
    return value;
  } catch (error) {
    boundary();
    if (error instanceof ExecutionError && ['sentinel.execution.canceled', 'sentinel.execution.deadlineExceeded', 'sentinel.execution.runDeadline', 'sentinel.execution.analysisUnavailable'].includes(error.code)) throw error;
    throw new ExecutionError('sentinel.execution.analysisUnavailable', { reason: 'retained bootstrap evidence is missing, malformed or mismatched' }, { cause: error });
  }
}
