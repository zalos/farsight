// /2 is source-only owner adjudication. It has NO qualified cookie basis consumer and cannot say mitigated.
import type { DecisionViewEnvelope, OwnerDecisionProjection } from '../contracts/index.js';
import { compareTimestamps, validateEnvelope } from '../validate.js';
import { deepFreeze } from '../policy/immutable.js';
import { stamp } from '../policy/receipts.js';
import { ownerContextOf } from '../evidence/owner-context.js';
import { selectedSecretPrivacy } from '../reports/selected-privacy.js';
import { loadPlan } from '../execution/plans.js';
import { digestOf, canonicalJson } from '../store/ledger-json.js';
import type { Workspace } from '../service/local.js';
import { acceptedFindingOf, acceptedFindingDigest, readOwnerSupport, revalidateFindingRecord, type AcceptedFindingBasis } from './decision-basis.js';
import { ownerHistoryOf, type OwnerHistory, type OwnerProposal } from './owner-journal.js';
import { fail } from './decision-data.js';

export async function decisionProjection(history:OwnerHistory,basis:AcceptedFindingBasis,ws:Workspace,id:string,now:Date,baselineRunId?:string):Promise<DecisionViewEnvelope>{
  const actual=ownerHistoryOf(history),s=acceptedFindingOf(basis),c=ownerContextOf(s.context),p=actual.proposals.get(id);
  if(!p)return fail('sentinel.decision.notFound','decision not found');
  // Historical proposal basis is independently replayed, never authorized by its JSON schema label.
  const historical=await revalidateFindingRecord(c.store,ws,p.basis,{signal:c.signal,deadlineAt:c.deadlineAt});acceptedFindingOf(basis);ownerHistoryOf(history);
  const at=stamp(now);if(compareTimestamps(at,p.createdAt)<0)return fail('sentinel.decision.invalidInput','evaluation predates the proposal');
  const support=await readOwnerSupport(historical,ws,p.input.evidence,baselineRunId);if(canonicalJson(support)!==canonicalJson(p.support))return fail('sentinel.decision.unauthorized','support identity changed');acceptedFindingOf(basis);ownerHistoryOf(history);
  const approval=actual.approved.get(id),sameSource=dependency(p)===dependencyOf(s.record);
  const expired=p.input.expiresAt!==null&&compareTimestamps(p.input.expiresAt,at)<=0;
  const superseded=[...actual.proposals.values()].some(x=>x.input.supersedes===p.id&&actual.approved.has(x.id)&&compareTimestamps(actual.approved.get(x.id)!.admission.decidedAt,at)<=0);
  const effective=!!approval&&compareTimestamps(approval.admission.decidedAt,at)<=0&&!superseded;
  let reason='proposed',state:OwnerDecisionProjection['state']='open',validity:OwnerDecisionProjection['validity']='none';
  if(effective){
    validity=expired?'expired':sameSource?'valid':'invalidated';reason=expired?'expired':!sameSource?'sourceChanged':p.input.decision==='mitigated'?'assertionUnverified':p.input.decision;
    if(validity==='valid'&&p.input.decision==='accepted-risk')state='accepted-risk';
    if(validity==='valid'&&p.input.decision==='false-positive')state='false-positive';
    if(p.input.decision==='mitigated'&&validity==='valid')validity='invalidated';
  }else if(superseded){reason='superseded';validity='invalidated';}
  const privacy=await privacyFor(basis,baselineRunId)||(canonicalJson(p.basis.ancestor)!==canonicalJson(s.record.ancestor)&&await privacyFor(historical,baselineRunId));acceptedFindingOf(basis);acceptedFindingOf(historical);ownerHistoryOf(history);
  const projection:OwnerDecisionProjection={id:p.id,findingId:s.record.findingId,basisDigest:privacy?null:acceptedFindingDigest(basis),decision:p.input.decision,
    scope:{kind:'finding-source',findingId:s.record.findingId},approval:approval&&compareTimestamps(approval.admission.decidedAt,at)<=0?'approved':'proposed',state,validity,
    reasonCode:'sentinel.decision.reason.'+reason.replace(/-([a-z])/g,(_,x:string)=>x.toUpperCase()),expiresAt:p.input.expiresAt,rationale:privacy?null:p.input.rationale};
  const view:DecisionViewEnvelope={schema:'sentinel-decision-view/draft-1',evaluator:'sentinel-decision-evaluation/2',authority:'owner-adjudication-of-accepted-source',disclosure:'owner-local',
    evaluatedAt:at,journalHead:actual.head,withheld:privacy,limitationKey:'sentinel.decision.sourceOnly',decision:projection};
  if(!validateEnvelope('decisionview',view).ok)fail('sentinel.decision.invalidInput','invalid decision projection');
  return deepFreeze(view);
}
function dependency(p:OwnerProposal){return dependencyOf(p.basis)}
function dependencyOf(r:ReturnType<typeof acceptedFindingOf>['record']){
  return digestOf({sourceId:r.ancestor.sourceId,findingId:r.findingId,fingerprint:r.fingerprint,familyId:r.familyId,citations:r.citations,checks:r.publications.flatMap(p=>p.checks)});
}
async function privacyFor(basis:AcceptedFindingBasis,baselineRunId?:string):Promise<boolean>{
  const s=acceptedFindingOf(basis),c=ownerContextOf(s.context);
  let withheld=false;
  const ids=new Set([s.record.ancestor.runId,...(baselineRunId?[baselineRunId]:[])]);
  const run=c.store.ledger.getRun(s.record.ancestor.runId);
  if(run?.envelope.baselineId)ids.add(run.envelope.baselineId);
  for(const id of ids){
    const r=c.store.ledger.getRun(id);if(!r)return fail('sentinel.decision.unauthorized','privacy ancestor unavailable');
    if(r.state==='canceled'){withheld=true;continue;}
    const admitted=await loadPlan(c.store,id,r.planRevision);acceptedFindingOf(basis);
    const privacy=await selectedSecretPrivacy(c.store,id,admitted);acceptedFindingOf(basis);
    withheld ||= privacy.hasMatches;
  }
  return withheld;
}
