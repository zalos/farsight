// Retained reporting proves bootstrap provenance without requiring the original checkout or live adapters.
import type { SentinelStore } from '../store/index.js';
import { loadPlan, type AdmittedPlan } from './plans.js';
import { INVENTORY_RECORD_SCHEMA, loadBootstrap, type BootstrapEvidence } from './bootstrap.js';
import { ExecutionError } from './errors.js';
const refuse = (reason: string): never => { throw new ExecutionError('sentinel.execution.bootstrapEvidence', { reason }); };
const isRecord = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An exact admitted ancestor already verified by the selected lineage; never a latest-plan lookup. */
export interface RetainedAncestorRevision {
  readonly runId: string;
  readonly revision: number;
  readonly planDigest: string;
}

/**
 * A selected run has no new bootstrap. Resolve only the inventory its admitted analysis explicitly reuses, through
 * exact admitted selection edges to the ancestor that actually ran the coordinator's inventory operation. Reporting
 * deliberately needs no live registry, scanner assets or checkout: these are retained invocation/publication facts.
 */
export async function retainedBootstrapForReport(store: SentinelStore, runId: string, admitted: AdmittedPlan): Promise<BootstrapEvidence & { selectedAncestors: RetainedAncestorRevision[] }> {
  const sameRef = (a: { id: string; revision: number }, b: { id: string; revision: number }) => a.id === b.id && a.revision === b.revision;
  const snapshotId = admitted.plan.pins.snapshotId;
  const candidates = admitted.plan.reused.filter(r => store.ledger.getPublication(r)?.outputs.some(o => o.schema === INVENTORY_RECORD_SCHEMA));
  if (candidates.length !== 1) return refuse('the analysis does not reuse exactly one accepted inventory');
  const inventory = candidates[0]!;
  const visited = new Set<string>();
  const revisions: AdmittedPlan[] = [];
  let id = runId, current = admitted;
  for (let depth = 0; depth < 64; depth++) {
    if (visited.has(id)) return refuse('the retained bootstrap lineage cycles');
    visited.add(id); revisions.push(current);
    const run = store.ledger.getRun(id);
    if (!run || run.envelope.snapshotId !== snapshotId || current.plan.pins.snapshotId !== snapshotId
      || !current.plan.reused.some(r => sameRef(r, inventory))) return refuse('the retained bootstrap lineage is not this snapshot and inventory');
    const first = await loadPlan(store, id, 1);
    if (first.plan.kind === 'bootstrap') {
      const units = first.plan.units.filter(u => u.stage === 'inventory');
      if (units.length !== 1 || !sameRef(units[0]!, inventory)) return refuse('the reused inventory is not the ancestor bootstrap operation');
      const unit = units[0]!;
      const row = store.ledger.getWork(inventory), publication = store.ledger.getPublication(inventory);
      const pin = first.plan.pins.operations.inventory;
      const attempt = publication && store.ledger.getAttempt(publication.attemptId);
      if (!row || row.runId !== id || row.envelope.planRevision !== first.plan.revision || row.envelope.stage.contract !== unit.contract
        || row.envelope.stage.implementationDigest !== unit.implementationDigest || row.envelope.inputFingerprint !== unit.inputFingerprint || !publication || !pin
        || pin.adapterId !== unit.adapterId || pin.digest !== unit.implementationDigest || !attempt || !sameRef(attempt.work, inventory)
        || attempt.state !== 'succeeded' || attempt.envelope.worker.kind !== 'coordinator-operation'
        || attempt.envelope.worker.adapterId !== pin.adapterId || attempt.envelope.worker.adapterDigest !== pin.digest
        || !attempt.envelope.invocation) return refuse('the inventory has no exact accepted coordinator operation');
      let invocation: any;
      try { invocation = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await store.readArtifact(attempt.envelope.invocation))); }
      catch { return refuse('the accepted inventory invocation is unavailable'); }
      if (!isRecord(invocation) || invocation.format !== 'sentinel-operation-invocation/draft-1' || invocation.store !== store.storeId
        || invocation.attemptId !== attempt.id || !invocation.work || !sameRef(invocation.work, inventory)
        || invocation.coordinatorEpoch !== attempt.epoch || invocation.operation !== 'inventory' || invocation.adapter?.id !== pin.adapterId
        || invocation.adapter?.digest !== pin.digest || invocation.plan?.runId !== id || invocation.plan?.revision !== first.plan.revision
        || invocation.plan?.digest !== first.plan.digest || invocation.snapshotId !== snapshotId || invocation.sourceId !== unit.sourceId
        || invocation.influenceManifest !== row.envelope.influenceManifest) return refuse('the accepted inventory invocation names other work or inputs');
      let evidence: BootstrapEvidence;
      try { evidence = await loadBootstrap(store, id, inventory); }
      catch { return refuse('the accepted bootstrap evidence is unavailable or unbound'); }
      if (evidence.snapshot.id !== snapshotId) return refuse('the retained bootstrap snapshot is not the analysis snapshot');
      for (const revision of revisions) for (const reused of revision.plan.reused) {
        const owner = store.ledger.getWork(reused);
        if (!owner || !visited.has(owner.runId) || !store.ledger.getPublication(reused)) return refuse('reused work is not accepted in the proven same-capture lineage');
      }
      return { ...evidence, selectedAncestors: revisions.slice(1).map(ancestor => ({ runId: ancestor.plan.runId, revision: ancestor.plan.revision, planDigest: ancestor.plan.digest })) };
    }
    const selection = current.selection;
    if (!selection || run.envelope.parentId !== selection.parent.runId || selection.parent.snapshotId !== snapshotId
      || !selection.reused.some(r => sameRef(r, inventory))) return refuse('the selected run has no exact retained parent binding');
    const parent = store.ledger.getRun(selection.parent.runId);
    if (!parent || (parent.state !== 'completed' && parent.state !== 'canceled') || parent.planRevision !== selection.parent.revision || parent.envelope.snapshotId !== snapshotId) return refuse('the selected parent is not its pinned revision and snapshot');
    const parentPlan = await loadPlan(store, parent.id, selection.parent.revision);
    if (parentPlan.plan.kind !== 'analysis' || parentPlan.plan.digest !== selection.parent.planDigest) return refuse('the selected parent plan is not its pinned digest');
    id = parent.id; current = parentPlan;
  }
  return refuse('the retained bootstrap lineage exceeds its bound');
}

