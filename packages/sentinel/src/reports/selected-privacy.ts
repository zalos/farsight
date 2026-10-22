// Privacy-only accepted names from the exact same-capture selected lineage. These records never enter child counts,
// observations, coverage or comparison. Shared binding checks match the full report's accepted-secret reader.
import type { ArtifactId, ObservationEnvelope } from '../contracts/index.js';
import type { SentinelStore } from '../store/index.js';
import { loadPlan, type AdmittedPlan } from '../execution/plans.js';
import { retainedBootstrapForReport } from '../execution/retained-bootstrap.js';
import { ExecutionError } from '../execution/errors.js';
import { validateEnvelope } from '../validate.js';
import { secretObservation } from './accepted-secrets.js';

const refuse = (reason: string): never => { throw new ExecutionError('sentinel.execution.bootstrapEvidence', { reason }); };
export async function selectedSecretNames(store: SentinelStore, runId: string, admitted: AdmittedPlan): Promise<string[]> {
  if (!admitted.selection) return [];
  const evidence = await retainedBootstrapForReport(store, runId, admitted);
  const names = new Set<string>();
  for (const pin of evidence.selectedAncestors) {
    const id = pin.runId;
    const ancestor = await loadPlan(store, id, pin.revision), plan = ancestor.plan;
    if (plan.digest !== pin.planDigest) return refuse('selected privacy plan is not its proven ancestor revision');
    if (plan.pins.snapshotId !== evidence.snapshot.id) return refuse('selected privacy evidence is another capture');
    for (const unit of plan.units.filter(u => u.adapterId === 'secrets-gitleaks')) {
      const publication = store.ledger.getPublication({ id: unit.id, revision: unit.revision });
      if (!publication) continue;
      const pinOf = (familyId: string, revision: number) => plan.pins.rules.find(p => p.familyId === familyId && p.revision === revision);
      const assignedCheck = (checkId: string) => {
        const check = plan.checks.find(c => c.id === checkId), pin = check && pinOf(check.familyId, check.ruleRevision);
        if (!check || !pin || check.state !== 'planned' || !unit.checks.includes(check.id) || check.unit?.id !== unit.id
          || check.unit.revision !== unit.revision || check.sourceId !== unit.sourceId || pin.adapterId !== unit.adapterId
          || !unit.scopes.includes(check.scopeId)) return refuse('selected privacy evidence has no exact assigned check');
        return { check, pin };
      };
      let findings = 0; const summaries: number[] = [];
      for (const output of publication.outputs) {
        if (!['sentinel-driver-finding/draft-1', 'sentinel-driver-report/draft-1'].includes(output.schema)) continue;
        let value: any;
        try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await store.readArtifact(output.id as ArtifactId))); }
        catch { return refuse('accepted selected privacy records are unavailable or invalid'); }
        if (output.schema === 'sentinel-driver-report/draft-1') {
          if (value?.runId !== id || value.work?.id !== unit.id || value.work?.revision !== unit.revision
            || value.attemptId !== publication.attemptId || !Number.isSafeInteger(value.findings) || value.findings < 0) return refuse('selected privacy summary is unbound');
          summaries.push(value.findings); continue;
        }
        findings++;
        if (value?.kind !== 'secret') return refuse('selected privacy finding has another kind');
        const secret = await secretObservation(value, { unit, runId: id, attemptId: publication.attemptId, snapshot: evidence.snapshot,
          adapterDigest: ancestor.profile.adapters.find(a => a.adapterId === unit.adapterId)?.digest, assignedCheck,
          bytesOf: content => store.readArtifact(content as ArtifactId), severityOf: new Map(), refuse, tokensOf: () => [],
          observation: (v: ObservationEnvelope) => { const checked = validateEnvelope('observation', v); if (!checked.ok) return refuse('selected privacy observation is invalid'); return checked.value as ObservationEnvelope; },
        });
        for (const scoped of secret.names) {
          const prefix = `${unit.sourceId}:`; if (!scoped.startsWith(prefix)) return refuse('selected privacy name has another source');
          const path = scoped.slice(prefix.length); names.add(path); const base = path.split('/').pop()!; if (base.length >= 8) names.add(base);
        }
      }
      if (summaries.length !== 1 || summaries[0] !== findings) return refuse('selected privacy publication does not attest its exact finding count');
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
}
