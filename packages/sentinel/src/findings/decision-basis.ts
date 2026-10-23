// Private accepted-finding authority. Descriptive JSON is never a constructor for this capability.
import type { SentinelStore } from '../store/index.js';
import type { Workspace } from '../service/local.js';
import { assessRun } from '../service/full-report.js';
import { findingsOf } from '../reports/document.js';
import { retainedSourceForAdmission, readRetainedSourceProof, type ProofTiming, type RetainedSourceProof, type RetainedSourceAncestor } from '../execution/retained-source.js';
import { loadPlan } from '../execution/plans.js';
import { importOwnerContext, ownerContextOf, type ImportOwnerContext } from '../evidence/owner-context.js';
import { deepFreeze } from '../policy/immutable.js';
import { canonicalJson, digestOf } from '../store/ledger-json.js';
import { readAcceptedReportImport } from '../evidence/reader.js';
import { evidenceLedgerFor } from '../store/evidence-binding.js';
import { fail, validId } from './decision-data.js';

export interface AcceptedFindingRecord {
  readonly schema:'sentinel-accepted-finding-basis/2';
  readonly storeId:string; readonly workspaceDigest:string; readonly profileId:string;
  readonly ancestor:RetainedSourceAncestor;
  readonly findingId:string; readonly fingerprint:string; readonly findingSite:string; readonly familyId:string;
  readonly scope:{readonly kind:'finding-source';readonly sourceId:string;readonly findingId:string};
  readonly observationIds:readonly string[];
  readonly publications:readonly {readonly attemptId:string;readonly invocation:string;readonly work:{readonly id:string;readonly revision:number};readonly outputs:readonly string[];readonly checks:readonly {readonly id:string;readonly scopeId:string;readonly ruleRevision:number;readonly definitionDigest:string;readonly adapterDigest:string}[]}[];
  readonly citations:readonly {readonly sourceId:string;readonly content:string;readonly startByte:number;readonly endByte:number}[];
  readonly closure:readonly string[];
}
declare const brand:unique symbol;
export interface AcceptedFindingBasis {readonly [brand]:true}
interface State {context:ImportOwnerContext;proof:RetainedSourceProof;record:AcceptedFindingRecord}
const bases=new WeakMap<object,State>();
export function acceptedFindingOf(value:AcceptedFindingBasis):Readonly<State> {
  const s=bases.get(value);if(!s)return fail('sentinel.decision.unauthorized','no accepted finding authority');
  const c=ownerContextOf(s.context);
  readRetainedSourceProof(c.store,s.proof,s.record.ancestor,{signal:c.signal,deadlineAt:c.deadlineAt});
  return s;
}
/** The only input selection is an actual finding ID. No caller assessment, scope facts, graph or policy is accepted. */
export async function acceptedFindingBasisFor(store:SentinelStore,ws:Workspace,runId:string,findingId:string,timing:ProofTiming):Promise<AcceptedFindingBasis> {
  if(!validId(runId)||!/^finding\.[0-9a-f]{40}$/.test(findingId))return fail('sentinel.decision.invalidInput','invalid finding selection');
  const context=importOwnerContext(store,ws,timing),c=ownerContextOf(context);
  const assessment=await assessRun(store,runId,{trustDir:c.trustDir});ownerContextOf(context);
  const findings=await findingsOf(assessment.observations,id=>store.readArtifact(id),{withheldKey:assessment.withheldKey});ownerContextOf(context);
  const finding=findings.find(f=>f.id===findingId);
  if(!finding||finding.sourceIds.length!==1||finding.observations.length===0)return fail('sentinel.decision.notFound','no single-source accepted finding');
  const run=store.ledger.getRun(runId),revision=run?.planRevision;
  if(!run||run.state!=='completed'||revision!==assessment.planRevision)return fail('sentinel.decision.staleState','executed revision changed');
  const {plan}=await loadPlan(store,runId,revision);ownerContextOf(context);
  const ancestor={runId,revision,planDigest:plan.digest,snapshotId:assessment.snapshot.id,sourceId:finding.sourceIds[0]!};
  const proof=await retainedSourceForAdmission(store,ancestor,timing);
  const source=readRetainedSourceProof(store,proof,ancestor,timing);ownerContextOf(context);
  const publications:AcceptedFindingRecord['publications'][number][]=[],seen=new Set<string>(),closure=new Set(source.closure.map(x=>x.id));
  for(const normalized of finding.observations){
    const observation=normalized.observation,p=observation.producer;
    if(p.kind!=='scanner'||!observation.rule||observation.rule.familyId!==finding.ruleFamilyId||normalized.anchors.some(a=>a.sourceId!==ancestor.sourceId))return fail('sentinel.decision.unauthorized','finding is not an accepted source check');
    if(seen.has(p.attemptId))continue;seen.add(p.attemptId);
    const attempt=store.ledger.getAttempt(p.attemptId),pub=attempt&&store.ledger.getPublication(attempt.work);
    const unit=attempt&&plan.units.find(u=>u.id===attempt.work.id&&u.revision===attempt.work.revision);
    if(!attempt||attempt.state!=='succeeded'||!attempt.envelope.invocation||!pub||pub.attemptId!==attempt.id||!unit||unit.sourceId!==ancestor.sourceId||unit.adapterId!==p.adapterId)return fail('sentinel.decision.unauthorized','unbound accepted producer');
    const check=plan.checks.find(k=>unit.checks.includes(k.id)&&k.familyId===observation.rule!.familyId&&k.state==='planned'&&k.sourceId===ancestor.sourceId);
    const rule=check&&plan.pins.rules.find(r=>r.familyId===check.familyId&&r.revision===check.ruleRevision);
    if(!check||!rule||rule.definitionDigest!==observation.rule.revisionDigest)return fail('sentinel.decision.unauthorized','unbound rule revision');
    const ids=pub.outputs.map(o=>o.id).sort();for(const id of [...ids,attempt.envelope.invocation])closure.add(id);
    publications.push({attemptId:attempt.id,invocation:attempt.envelope.invocation,work:attempt.work,outputs:ids,checks:[{id:check.id,scopeId:check.scopeId,ruleRevision:check.ruleRevision,definitionDigest:rule.definitionDigest,adapterDigest:p.adapterDigest}]});
  }
  if(closure.size>2048)return fail('sentinel.decision.scopeExceeded','finding closure exceeds its bound');
  for(const id of closure){await store.readArtifact(id as never);ownerContextOf(context);}
  const record=deepFreeze({schema:'sentinel-accepted-finding-basis/2' as const,storeId:store.storeId,workspaceDigest:c.workspaceDigest,profileId:plan.pins.profileId,ancestor,
    findingId,fingerprint:finding.fingerprint.exact,findingSite:finding.fingerprint.probable,familyId:finding.ruleFamilyId,scope:{kind:'finding-source' as const,sourceId:ancestor.sourceId,findingId},
    observationIds:[...finding.observationIds].sort(),publications:publications.sort((a,b)=>a.attemptId.localeCompare(b.attemptId)),
    citations:finding.anchors.map(a=>({sourceId:a.sourceId,content:a.content,startByte:a.span.startByte,endByte:a.span.endByte})),
    closure:[...closure].sort()});
  const token=Object.freeze({}) as AcceptedFindingBasis;bases.set(token,{context,proof,record});acceptedFindingOf(token);return token;
}
/** Retained JSON only selects what must be independently rederived; matching bytes alone are never authority. */
export async function revalidateFindingRecord(store:SentinelStore,ws:Workspace,record:AcceptedFindingRecord,timing:ProofTiming):Promise<AcceptedFindingBasis>{
  const fresh=await acceptedFindingBasisFor(store,ws,record.ancestor.runId,record.findingId,timing);
  if(canonicalJson(acceptedFindingOf(fresh).record)!==canonicalJson(record))return fail('sentinel.decision.staleState','accepted finding identity changed');
  return fresh;
}
export const acceptedFindingDigest=(basis:AcceptedFindingBasis)=>digestOf(acceptedFindingOf(basis).record);

export interface OwnerDecisionSupport {readonly id:string;readonly kind:'finding-artifact'|'accepted-import';readonly root:string}
/** Supporting imports retain their original authority. These bytes cannot establish a control or mint a finding. */
export async function readOwnerSupport(basis:AcceptedFindingBasis,ws:Workspace,evidence:readonly string[],baselineRunId?:string):Promise<readonly OwnerDecisionSupport[]>{
  const s=acceptedFindingOf(basis),c=ownerContextOf(s.context),out:OwnerDecisionSupport[]=[];
  for(const id of evidence){
    if(s.record.closure.includes(id)){
      await c.store.readArtifact(id);acceptedFindingOf(basis);out.push({id,kind:'finding-artifact',root:id});continue;
    }
    const record=evidenceLedgerFor(c.store).acceptance(id);
    if(!record||canonicalJson(record.identity.ancestor)!==canonicalJson(s.record.ancestor))return fail('sentinel.decision.unauthorized','support is not accepted for this exact source ancestor');
    const view=await readAcceptedReportImport(c.store,ws,id,{timing:{signal:c.signal,deadlineAt:c.deadlineAt},...(baselineRunId?{baselineRunId}:{})});acceptedFindingOf(basis);
    if(view.root!==record.root)return fail('sentinel.decision.unauthorized','support changed');
    out.push({id,kind:'accepted-import',root:view.root});
  }
  acceptedFindingOf(basis);return deepFreeze(out);
}
