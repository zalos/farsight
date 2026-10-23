// Privacy-only accepted names from the exact same-capture selected lineage. These records never enter child counts,
// observations, coverage or comparison. Shared binding checks match the full report's accepted-secret reader.
import { canonicalJson } from '@farsight/graph';
import { verifyWorkEnvelope, capturedInputsOf } from '../planner/boundary.js';
import { inputFingerprintOf } from '../execution/supervisor.js';
import type { ArtifactId, ObservationEnvelope } from '../contracts/index.js';
import type { SentinelStore } from '../store/index.js';
import { loadPlan, type AdmittedPlan } from '../execution/plans.js';
import { retainedBootstrapForReport } from '../execution/retained-bootstrap.js';
import { ExecutionError } from '../execution/errors.js';
import { validateEnvelope } from '../validate.js';
import { secretObservation } from './accepted-secrets.js';

const refuse = (reason: string): never => { throw new ExecutionError('sentinel.execution.bootstrapEvidence', { reason }); };
export async function selectedSecretPrivacy(store: SentinelStore, runId: string, admitted: AdmittedPlan, includeCurrent = false): Promise<{ names: string[]; hasMatches: boolean }> {
  if (!admitted.selection && !admitted.pathRequest && !includeCurrent) return { names: [], hasMatches: false };
  const evidence = await retainedBootstrapForReport(store, runId, admitted);
  const names = new Set<string>();
  let hasMatches = false;
  const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
  const readJson = async (id: ArtifactId): Promise<any> => {
    try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await store.readArtifact(id))); }
    catch { return refuse('accepted selected privacy records are unavailable or invalid'); }
  };
  const pins=[...(includeCurrent?[{runId,revision:admitted.plan.revision,planDigest:admitted.plan.digest}]:[]),...evidence.selectedAncestors];
  for (const pin of pins) {
    const id = pin.runId;
    const ancestor = await loadPlan(store, id, pin.revision), plan = ancestor.plan;
    if (plan.digest !== pin.planDigest) return refuse('selected privacy plan is not its proven ancestor revision');
    if (plan.pins.snapshotId !== evidence.snapshot.id) return refuse('selected privacy evidence is another capture');
    for (const unit of plan.units.filter(u => u.adapterId === 'secrets-gitleaks')) {
      const row = store.ledger.getWork(unit);
      const publication = store.ledger.getPublication({ id: unit.id, revision: unit.revision });
      if (!publication) {
        if (row?.state === 'published') return refuse('selected privacy work lost its accepted publication');
        continue;
      }
      // Cancellation ends the run, not an already succeeded publication. Authenticate its actual owner and
      // invocation independently of run completion, before either reporting surface consumes privacy knowledge.
      const attempt = store.ledger.getAttempt(publication.attemptId);
      const adapterDigest = ancestor.profile.adapters.find(a => a.adapterId === unit.adapterId)?.digest;
      if (!row || row.runId !== id || row.envelope.planRevision !== plan.revision || row.state !== 'published'
        || !same(publication.work, { id: unit.id, revision: unit.revision }) || !attempt || attempt.state !== 'succeeded'
        || !same(attempt.work, publication.work) || !attempt.envelope.invocation || !adapterDigest
        || unit.implementationDigest !== adapterDigest || row.envelope.stage.implementationDigest !== adapterDigest
        || attempt.envelope.worker?.kind !== 'owned-container'
        || !same(attempt.envelope.worker.ownershipLabels, { store: store.storeId, attempt: attempt.id, epoch: attempt.epoch })) {
        return refuse('selected privacy publication has no exact succeeded owner attempt');
      }
      try { verifyWorkEnvelope(plan, row.envelope); capturedInputsOf(plan, unit, evidence.snapshot); }
      catch { return refuse('selected privacy work is not its exact admitted captured unit'); }
      const invocation = await readJson(attempt.envelope.invocation);
      if (invocation?.format !== 'sentinel-invocation/draft-1' || invocation.store !== store.storeId
        || invocation.attemptId !== attempt.id || !same(invocation.work, publication.work) || invocation.coordinatorEpoch !== attempt.epoch
        || invocation.adapter?.id !== unit.adapterId || invocation.adapter?.digest !== adapterDigest || invocation.isolation !== 'container'
        || !Array.isArray(invocation.assignment?.checks) || !Array.isArray(invocation.assignment?.scopes)
        || !Array.isArray(invocation.inputs) || invocation.inputs.some((input: unknown) => typeof input !== 'string')
        || invocation.inputFingerprint !== inputFingerprintOf(invocation.inputs)
        || unit.inputs.some(input => !invocation.inputs.includes(input.content))
        || !same([...(invocation.assignment?.checks ?? [])].sort(), [...unit.checks].sort())
        || !same([...(invocation.assignment?.scopes ?? [])].sort(), [...unit.scopes].sort())) {
        return refuse('selected privacy invocation differs from its admitted unit or attempt');
      }
      const pinOf = (familyId: string, revision: number) => plan.pins.rules.find(p => p.familyId === familyId && p.revision === revision);
      const assignedCheck = (checkId: string) => {
        const check = plan.checks.find(c => c.id === checkId), pin = check && pinOf(check.familyId, check.ruleRevision);
        if (!check || !pin || check.state !== 'planned' || !unit.checks.includes(check.id) || check.unit?.id !== unit.id
          || check.unit.revision !== unit.revision || check.sourceId !== unit.sourceId || pin.adapterId !== unit.adapterId
          || !unit.scopes.includes(check.scopeId)) return refuse('selected privacy evidence has no exact assigned check');
        return { check, pin };
      };
      if (!unit.checks.length) return refuse('selected privacy unit has no assigned checks');
      for (const checkId of unit.checks) assignedCheck(checkId);
      let findings = 0; const summaries: number[] = [];
      for (const output of publication.outputs) {
        if (!['sentinel-driver-finding/draft-1', 'sentinel-driver-report/draft-1'].includes(output.schema)) continue;
        const value = await readJson(output.id as ArtifactId);
        if (output.schema === 'sentinel-driver-report/draft-1') {
          if (value?.adapter !== unit.adapterId || value.runId !== id || value.work?.id !== unit.id || value.work?.revision !== unit.revision
            || value.attemptId !== publication.attemptId || !Number.isSafeInteger(value.findings) || value.findings < 0) return refuse('selected privacy summary is unbound');
          summaries.push(value.findings); continue;
        }
        findings++;
        if (value?.kind !== 'secret') return refuse('selected privacy finding has another kind');
        const secret = await secretObservation(value, { unit, runId: id, attemptId: publication.attemptId, snapshot: evidence.snapshot,
          adapterDigest, assignedCheck,
          bytesOf: content => store.readArtifact(content as ArtifactId), severityOf: new Map(), refuse, tokensOf: () => [],
          observation: (v: ObservationEnvelope) => { const checked = validateEnvelope('observation', v); if (!checked.ok) return refuse('selected privacy observation is invalid'); return checked.value as ObservationEnvelope; },
        });
        for (const scoped of secret.names) {
          const prefix = `${unit.sourceId}:`; if (!scoped.startsWith(prefix)) return refuse('selected privacy name has another source');
          const path = scoped.slice(prefix.length); names.add(path); const base = path.split('/').pop()!; if (base.length >= 8) names.add(base);
        }
      }
      if (summaries.length !== 1 || summaries[0] !== findings) return refuse('selected privacy publication does not attest its exact finding count');
      hasMatches ||= findings > 0;
    }
  }
  return { names: [...names].sort((a, b) => b.length - a.length), hasMatches };
}

export async function selectedSecretNames(store: SentinelStore, runId: string, admitted: AdmittedPlan): Promise<string[]> {
  return (await selectedSecretPrivacy(store, runId, admitted)).names;
}
