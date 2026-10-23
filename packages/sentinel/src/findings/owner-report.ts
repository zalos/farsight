// The only /2 report hook. Optional owner adjudication never weakens canonical report authority or privacy.
import { STRINGS } from '@farsight/core/dist/strings.js';
import type { ReportEnvelope } from '../contracts/index.js';
import type { SentinelStore } from '../store/index.js';
import type { Workspace } from '../service/local.js';
import { importOwnerContext, ownerContextOf } from '../evidence/owner-context.js';
import { readBudgetCheckpoint } from '../store/read-budget.js';
import { boundOwner } from '../store/owner-binding.js';
import { hasOwnerHistory, readOwnerReportHistory, finishOwnerReportHistory, ownerHistoryOf, type OwnerHistory } from './owner-journal.js';
import { acceptedFindingBasisFor, acceptedFindingOf, findingReadSessionFor, finishFindingReadSession, type FindingReadSession } from './decision-basis.js';
import { decisionProjection } from './owner-evaluation.js';
import type { Finding } from './correlate.js';
export const OWNER_REPORT_LIMITS=Object.freeze({evaluations:50});
const hardBoundary=(store:SentinelStore)=>{boundOwner(store).assertHeld();readBudgetCheckpoint(store)};
/** Only decision-domain unavailability is optional. Shared latched limits/cancellation and owner failure still throw. */
function optionalFailure(store:SentinelStore,error:unknown):void{
  hardBoundary(store);
  const code=(error as {code?:unknown})?.code;
  const unavailable=new Set(['sentinel.decision.invalidInput','sentinel.decision.corruptHistory','sentinel.decision.staleState','sentinel.decision.notFound','sentinel.decision.scopeExceeded','sentinel.decision.unauthorized',
    'sentinel.execution.analysisUnavailable','sentinel.store.invalidInput','sentinel.store.corruptRecord','sentinel.store.notFound',
    'sentinel.object.missing','sentinel.object.corrupt','sentinel.object.digestMismatch','sentinel.object.unsafePath','sentinel.object.io',
    'sentinel.report.evidenceUnbound','sentinel.report.runNotReportable','ENOENT','EACCES','EPERM','ENOTDIR','ELOOP','EIO']);
  if(typeof code!=='string'||!unavailable.has(code))throw error;
}
function projected(document:ReportEnvelope,decisions:ReportEnvelope['decisions'],status:'complete'|'partial'|'unavailable',reason:'complete'|'partial'|'unavailable'|'limit'):ReportEnvelope{
  const reasonCode=('sentinel.decision.section.'+reason) as NonNullable<ReportEnvelope['decisionEvaluation']>['reasonCode'],words=new Set(['sentinel.decision.reportHeading','sentinel.decision.sourceOnly',reasonCode,...decisions.flatMap(d=>d.reasonCode?[d.reasonCode]:[])]),definitions=[...(document.definitions??[])];
  for(const key of words){const e=STRINGS[key];if(!e)throw Error('decision words unavailable');if(!definitions.some(d=>d.key===key))definitions.push({key,text:{business:e.professional,code:e.hud},define:e.define!});}
  return{...document,decisions:[...document.decisions,...decisions],decisionEvaluation:{status,reasonCode},definitions:definitions.sort((a,b)=>a.key.localeCompare(b.key))};
}
export async function withOwnerDecisions(document:ReportEnvelope,store:SentinelStore,ws:Workspace,findings:readonly Finding[],now:Date,baselineRunId?:string):Promise<ReportEnvelope>{
  hardBoundary(store);if(store.ledger.getRun(document.run.id)?.state!=='completed')return document;
  let present:boolean;try{present=hasOwnerHistory(store,ws)}catch(error){optionalFailure(store,error);return projected(document,[],'unavailable','unavailable')}
  if(!present)return document;
  const timing={signal:new AbortController().signal,deadlineAt:performance.now()+120000};
  let history:OwnerHistory,session:FindingReadSession,context:ReturnType<typeof importOwnerContext>;
  try{context=importOwnerContext(store,ws,timing);history=readOwnerReportHistory(context);session=findingReadSessionFor(store,ws,timing)}catch(error){optionalFailure(store,error);return projected(document,[],'unavailable','unavailable')}
  const actual=ownerHistoryOf(history),decisions:ReportEnvelope['decisions']=[],bases=new Map<string,Awaited<ReturnType<typeof acceptedFindingBasisFor>>>(),privacy=new Map<string,Promise<boolean>>();
  let attempted=0,partial=false,limited=false;
  for(const p of actual.proposals.values()){
    if(!actual.approved.has(p.id))continue;
    const candidates=findings.filter(f=>f.sourceIds.length===1&&f.sourceIds[0]===p.basis.ancestor.sourceId&&f.ruleFamilyId===p.basis.familyId&&f.fingerprint.probable===p.basis.findingSite);
    const finding=candidates.find(f=>f.id===p.basis.findingId)??(candidates.length===1?candidates[0]:undefined);
    if(!finding)continue;
    if(attempted++>=OWNER_REPORT_LIMITS.evaluations){partial=true;limited=true;break}
    let derivingCurrent=true;
    try{
      let basis=bases.get(finding.id);if(!basis){basis=await acceptedFindingBasisFor(store,ws,document.run.id,finding.id,timing,session);bases.set(finding.id,basis)}
      derivingCurrent=false;
      const view=await decisionProjection(history,basis,ws,p.id,now,baselineRunId,session,privacy);acceptedFindingOf(basis);ownerContextOf(context);hardBoundary(store);
      const d=view.decision;if(d.validity==='none')continue;
      decisions.push({dispositionId:d.id,findingId:d.findingId,evaluator:view.evaluator,state:d.state,reasonCode:d.reasonCode,basisDigest:d.basisDigest,journalHead:view.journalHead!,validity:d.validity,expiresAt:d.expiresAt,rationale:document.disclosure.profile==='shareable'?null:d.rationale});
    }catch(error){if(derivingCurrent&&typeof(error as {code?:unknown})?.code==='string'&&String((error as {code:string}).code).startsWith('sentinel.report.'))throw error;optionalFailure(store,error);partial=true}
  }
  try{await finishFindingReadSession(session);finishOwnerReportHistory(history);ownerContextOf(context);hardBoundary(store)}catch(error){optionalFailure(store,error);return projected(document,[],'unavailable','unavailable')}
  return projected(document,decisions,partial?'partial':'complete',limited?'limit':partial?'partial':'complete');
}
