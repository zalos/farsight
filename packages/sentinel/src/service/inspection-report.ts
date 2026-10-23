// A read-only projection of the exact accepted inspection attempt, never a caller-supplied controls document.
// Recompute the fact fold from its sealed job/raw output, original retained ids and admitted source extent. The
// public projection excludes raw source text; all remaining source identities still pass through report privacy.
import { canonicalJson } from '@farsight/graph';
import { STRINGS } from '@farsight/core/dist/strings.js';
import type { ArtifactId, ReportControlInspection, PlanWork } from '../contracts/index.js';
import type { SentinelStore } from '../store/index.js';
import type { AdmittedPlan } from '../execution/plans.js';
import { verifyWorkEnvelope, capturedInputsOf } from '../planner/boundary.js';
import { coverageRecords, scopeIndex } from '../execution/coverage.js';
import { bindingId, EXECUTION_BINDING_SCHEMA, type ExecutionBinding } from '../execution/plan.js';
import { inputFingerprintOf } from '../execution/supervisor.js';
import { surfacesFromIndex } from '../planner/planner.js';
import { retainedBootstrapForReport } from '../execution/retained-bootstrap.js';
import { validateEnvelope } from '../validate.js';
import { CONTROLS_MODELED_VERSIONS, CONTROLS_SUPPORTED_RULES, CONTROLS_JOB_SCHEMA, CONTROLS_OUTPUT_MEDIA, CONTROLS_OUTPUT_SCHEMA } from '../frameworks/controls/definitions.js';
import { FRAMEWORKS, CONTROL_FAMILIES, INSPECTED_PROPERTIES, inspect, inspectionReport, libraryPresent, type LibraryOutcome } from '../frameworks/controls/facts.js';

export async function acceptedInspection(store: SentinelStore, admitted: AdmittedPlan, unit: PlanWork,
  evidence: Awaited<ReturnType<typeof retainedBootstrapForReport>>, refuse: (reason: string) => never): Promise<ReportControlInspection> {
  const plan = admitted.plan, runId = plan.runId;
  const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
  const byteCache=new Map<ArtifactId,Promise<Buffer>>();
  const bytesOf=(id:ArtifactId)=>{let p=byteCache.get(id);if(!p)byteCache.set(id,p=store.readArtifact(id));return p};
  const read = async (id: ArtifactId): Promise<any> => {
    try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await bytesOf(id))); }
    catch { return refuse('accepted inspection bytes are unavailable or invalid'); }
  };
  const pub = store.ledger.getPublication(unit), row = store.ledger.getWork(unit);
  const attempt = pub && store.ledger.getAttempt(pub.attemptId);
  const digest = admitted.profile.adapters.find(a => a.adapterId === 'framework-controls')?.digest;
  if (!pub || !row || row.runId !== runId || row.state !== 'published' || row.envelope.planRevision !== plan.revision
    || !same(pub.work, { id: unit.id, revision: unit.revision }) || !attempt || attempt.state !== 'succeeded'
    || !same(attempt.work, pub.work) || attempt.envelope.worker.kind !== 'owned-child' || !attempt.envelope.invocation
    || !digest || unit.implementationDigest !== digest || row.envelope.stage.implementationDigest !== digest) return refuse('inspection has no exact accepted owner attempt');
  try { verifyWorkEnvelope(plan, row.envelope); capturedInputsOf(plan, unit, evidence.snapshot); }
  catch { return refuse('inspection work differs from its admitted captured unit'); }
  const checks = plan.checks.filter(c => unit.checks.includes(c.id));
  if (!unit.sourceId || !checks.length || checks.length !== unit.checks.length || checks.some(c => {
    const pin = plan.pins.rules.find(p => p.familyId === c.familyId && p.revision === c.ruleRevision);
    return c.state !== 'planned' || c.sourceId !== unit.sourceId || c.scopeKind !== 'repository' || c.scopeId !== unit.sourceId
      || c.unit?.id !== unit.id || c.unit.revision !== unit.revision || !pin || pin.adapterId !== unit.adapterId
      || !CONTROLS_SUPPORTED_RULES.some(r => r.familyId === c.familyId && r.revision === c.ruleRevision && r.definitionDigest === pin.definitionDigest);
  })) return refuse('inspection checks differ from the exact repository rule assignment');
  const allInputs = evidence.snapshot.entries.filter(e => e.sourceId === unit.sourceId && e.kind === 'file' && e.disposition === 'included');
  if (allInputs.length !== unit.inputs.length || allInputs.some(e => !unit.inputs.some(i => e.kind === 'file' && e.disposition === 'included' && i.sourceId === e.sourceId && i.relativePath === e.relativePath && i.content === e.content))) return refuse('inspection does not bind its entire captured source');
  const a = evidence.record.analyses.find(a => a.sourceId === unit.sourceId), index = evidence.analyses.find(a => a.sourceId === unit.sourceId)?.index;
  if (!a || !index) return refuse('inspection retained source is absent');
  const invocation = await read(attempt.envelope.invocation);
  const expectedAnalysis = { result: a.result, index: a.index, artifact: a.artifact, manifest: evidence.record.manifest };
  if (invocation?.format !== 'sentinel-invocation/draft-1' || invocation.store !== store.storeId || invocation.attemptId !== attempt.id
    || !same(invocation.work, pub.work) || invocation.coordinatorEpoch !== attempt.epoch || invocation.adapter?.id !== unit.adapterId
    || invocation.adapter?.digest !== digest || invocation.isolation !== 'child' || !Array.isArray(invocation.inputs) || invocation.inputs.some((id:unknown)=>typeof id!=='string')
    || invocation.inputFingerprint !== inputFingerprintOf(invocation.inputs) || unit.inputs.some(i => !invocation.inputs.includes(i.content))
    || Object.values(expectedAnalysis).some(id => !invocation.inputs.includes(id))
    || !same([...(invocation.assignment?.checks ?? [])].sort(), [...unit.checks].sort())
    || !same([...(invocation.assignment?.scopes ?? [])].sort(), [...unit.scopes].sort())) return refuse('inspection invocation is not this accepted assignment');
  const only = (schema: string) => { const outputs = pub.outputs.filter(o => o.schema === schema); if (outputs.length !== 1) return refuse('inspection needs exactly one accepted report and raw output'); return outputs[0]!; };
  if (pub.outputs.some(o => o.schema === 'sentinel-driver-finding/draft-1')) return refuse('inspection facts cannot be findings');
  const output = await read(only(CONTROLS_OUTPUT_MEDIA).id);
  if (output?.schema !== CONTROLS_OUTPUT_SCHEMA || !invocation.inputs.includes(output.job)) return refuse('inspection output names an unsealed job');
  if (Object.hasOwn(invocation, 'job')) {
    if (typeof invocation.job !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(invocation.job)
      || !invocation.inputs.includes(invocation.job) || output.job !== invocation.job || unit.dependencies.length !== 1) return refuse('inspection invocation has an invalid job role');
    const sourceInputs = [...new Set(unit.inputs.map(i => i.content))].sort();
    const auxiliary = [
      { role: 'analysis-result', id: a.result }, { role: 'analysis-index', id: a.index },
      { role: 'analysis-artifact', id: a.artifact }, { role: 'snapshot-manifest', id: evidence.record.manifest },
    ];
    const sealedInputs = [...new Set([...sourceInputs, invocation.job, ...auxiliary.map(a => a.id)])].sort();
    if (!same([...invocation.inputs].sort(), sealedInputs)) return refuse('inspection job role differs from its exact sealed input set');
    const expected: ExecutionBinding = {
      schema: EXECUTION_BINDING_SCHEMA, plan: { runId, revision: plan.revision, digest: plan.digest }, work: { id: unit.id, revision: unit.revision },
      influenceManifest: row.envelope.influenceManifest, adapter: { id: unit.adapterId!, digest },
      inputs: sealedInputs, protocolFingerprint: invocation.inputFingerprint, inputFingerprint: row.envelope.inputFingerprint,
      sourceInputs,
      derived: { job: invocation.job, auxiliary,
        analysis: { inventory: unit.dependencies[0]!, ...expectedAnalysis } },
    };
    const accepted = await read(bindingId(expected));
    if (!same(accepted, expected) || accepted.derived?.job !== invocation.job) return refuse('inspection has no exact accepted execution binding');
  }
  const job = await read(output.job);
  const binding = { plan: plan.digest, snapshot: plan.pins.snapshotId, unit: { id: unit.id, revision: unit.revision, inputFingerprint: unit.inputFingerprint }, checks: checks.map(c => ({ id: c.id, familyId: c.familyId, revision: c.ruleRevision, scope: c.scopeId })) };
  if (job?.schema !== CONTROLS_JOB_SCHEMA || job.snapshotId !== plan.pins.snapshotId || job.sourceId !== unit.sourceId
    || job.snapshot !== expectedAnalysis.manifest || !same(job.analysis, { artifact: a.artifact, result: a.result, index: a.index })
    || !same(job.binding, binding) || !same(job.properties, INSPECTED_PROPERTIES) || !same(job.environment, { activeProfiles: null })) return refuse('inspection job differs from its admitted source and original retained evidence');
  const libraries: LibraryOutcome[] = output.libraries;
  if (!Array.isArray(libraries) || libraries.length !== FRAMEWORKS.length || libraries.some((l, i) => l?.framework !== FRAMEWORKS[i] || !Array.isArray(l.envelopes)
    || (l.refused !== undefined && (l.refused !== 'sentinel.controls.libraryRefused' || l.envelopes.length)))) return refuse('inspection library outcomes are malformed');
  const nodes = new Set(index.nodes.map(n => n.nodeId));
  for (const l of libraries) {
    for (const e of l.envelopes) {
      if (!validateEnvelope('controls', e).ok || e.snapshotId !== evidence.snapshot.id || e.framework.id !== l.framework || l.packDigest !== e.packDigest) return refuse('inspection facts are not this library and snapshot');
      for (const f of e.facts) {
        if (!nodes.has(f.surfaceId) || (f.reasonCode && !STRINGS[f.reasonCode])) return refuse('inspection fact is outside the retained source extent');
        for (const citation of f.evidence) {
          const input = unit.inputs.find(i => i.sourceId === citation.sourceId && i.relativePath === citation.relativePath && i.content === citation.content);
          if (!input || citation.snapshotId !== evidence.snapshot.id) return refuse('inspection cites foreign captured bytes');
          const bytes = await bytesOf(citation.content);
          if (!Number.isSafeInteger(citation.span.startByte) || !Number.isSafeInteger(citation.span.endByte) || citation.span.startByte < 0 || citation.span.endByte < citation.span.startByte || citation.span.endByte > bytes.length) return refuse('inspection cites an invalid captured span');
        }
      }
    }
    if (l.frontiers !== undefined && (!Array.isArray(l.frontiers) || l.frontiers.some(f => typeof f.scopeId !== 'string' || !STRINGS[f.reasonCode]))) return refuse('inspection frontier is invalid');
    for (const e of l.envelopes) if (e.frontiers.some(f => !STRINGS[f.reasonCode])) return refuse('inspection frontier reason is invalid');
  }
  const declared = pub.outputs.filter(o => o.schema === 'sentinel-controls/draft-1');
  const expected = libraries.flatMap(l => l.envelopes);
  const actual = await Promise.all(declared.map(o => read(o.id)));
  if (!same(actual.map(canonicalJson).sort(), expected.map(canonicalJson).sort())) return refuse('inspection envelopes differ from its accepted raw output');
  const surfaces = surfacesFromIndex(index).map(s => s.nodeId), r = inspect(checks, libraries, surfaces, '');
  const recognised = libraries.some(libraryPresent);
  const states = r.checks.map(c => !recognised && c.state === 'complete' ? { ...c, state: 'partial', reasons: ['sentinel.controls.frameworkNotRecognized'] } : c);
  const scope = Object.fromEntries(FRAMEWORKS.map(f => [f, { versions: CONTROLS_MODELED_VERSIONS[f], properties: [...new Set(libraries.find(l => l.framework === f)!.envelopes.flatMap(e => e.facts.map(f => f.property)))].sort() }])) as any;
  const summary = only('sentinel-driver-report/draft-1'), report = await read(summary.id);
  const reconstructed = { ...inspectionReport({ adapter: unit.adapterId, runId, snapshotId: plan.pins.snapshotId, work: pub.work, attemptId: attempt.id, sourceId: unit.sourceId,
    analysis: expectedAnalysis, extent: surfaces.length, recognised }, libraries, r.rows, states as any, scope), findings: 0 };
  if (!same(report, reconstructed)) return refuse('inspection report differs from its accepted facts and source extent');
  // The report's partial facts must not be paired with a more optimistic coverage publication.
  const skipped = new Map(r.coverage.skipped.map(x => [`${x.scopeId}\u0000${x.reasonCode}`, x]));
  if (!recognised) for (const c of checks) if(r.coverage.coveredChecks.some(x=>x.checkId===c.id))skipped.set(`${c.scopeId}\u0000sentinel.controls.frameworkNotRecognized`, {scopeId:c.scopeId,reasonCode:'sentinel.controls.frameworkNotRecognized'});
  const normalized = { ...r.coverage, coveredChecks:r.coverage.coveredChecks.map(c=>({...c,coverage:summary.id})), skipped:[...skipped.values()].sort((a,b)=>`${a.scopeId}\u0000${a.reasonCode}` < `${b.scopeId}\u0000${b.reasonCode}` ? -1 : `${a.scopeId}\u0000${a.reasonCode}` > `${b.scopeId}\u0000${b.reasonCode}` ? 1 : 0) };
  const coverage = await Promise.all(pub.outputs.filter(o=>o.schema==='sentinel-coverage/draft-1').map(o=>read(o.id)));
  if(coverage.length!==checks.length || new Set(coverage.map(c=>c.checkId)).size!==checks.length)return refuse('inspection has missing or duplicate coverage');
  for(const actual of coverage){
    if(!validateEnvelope('coverage',actual).ok)return refuse('inspection coverage is malformed');
    const expected=coverageRecords({runId,attemptId:attempt.id,work:pub.work,checks,adapterGranularity:'aggregate',result:normalized as any,recordedAt:actual.recordedAt,scopes:scopeIndex(plan)});
    if(!same(actual,expected.envelopes.find(c=>c.checkId===actual.checkId)))return refuse('inspection coverage differs from its accepted facts');
    for(const record of expected.records.filter(r=>r.schema!=='sentinel-coverage/draft-1')){
      const id=actual[record.schema==='sentinel-coverage-scope/draft-1'?'assessedScopeArtifact':'limitationsArtifact'];
      if((record.value as any).checkId===actual.checkId && !same(await read(id),record.value))return refuse('inspection coverage provenance differs from its facts');
    }
  }
  const frontiers = libraries.flatMap(l => [...(l.frontiers ?? []), ...l.envelopes.flatMap(e => e.frontiers)]);
  return { sourceId: unit.sourceId, artifact: summary.id, attemptId: attempt.id, work: pub.work, analysis: expectedAnalysis, assessment: 'none', recognised, extent: surfaces.length,
    libraries: structuredClone(report.libraries), rows: r.rows.map(r => ({ ...r, claims: r.claims.map(c => ({ ...c })) })), checks: structuredClone(states) as ReportControlInspection['checks'], frontiers: structuredClone(frontiers), limitationKey: 'sentinel.controls.limitation.inspectionOnly' };
}
