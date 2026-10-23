// The only /2 report hook. Both report profiles still pass through the existing whole-document privacy projection.
import { STRINGS } from '@farsight/core/dist/strings.js';
import type { ReportEnvelope } from '../contracts/index.js';
import type { SentinelStore } from '../store/index.js';
import type { Workspace } from '../service/local.js';
import { importOwnerContext, ownerContextOf } from '../evidence/owner-context.js';
import { hasOwnerHistory, readOwnerHistory, ownerHistoryOf } from './owner-journal.js';
import { acceptedFindingBasisFor, acceptedFindingOf } from './decision-basis.js';
import { decisionProjection } from './owner-evaluation.js';
import type { Finding } from './correlate.js';

export async function withOwnerDecisions(document:ReportEnvelope,store:SentinelStore,ws:Workspace,findings:readonly Finding[],now:Date,baselineRunId?:string):Promise<ReportEnvelope>{
  if(store.ledger.getRun(document.run.id)?.state!=='completed'||!hasOwnerHistory(store,ws))return document;
  const timing={signal:new AbortController().signal,deadlineAt:performance.now()+120000};
  const context=importOwnerContext(store,ws,timing),history=readOwnerHistory(context),actual=ownerHistoryOf(history);
  const decisions:ReportEnvelope['decisions']=[],words=new Set(['sentinel.decision.reportHeading','sentinel.decision.sourceOnly']);
  const bases=new Map<string,Awaited<ReturnType<typeof acceptedFindingBasisFor>>>();
  for(const p of actual.proposals.values()){
    if(!actual.approved.has(p.id))continue;
    const candidates=findings.filter(f=>f.sourceIds.length===1&&f.sourceIds[0]===p.basis.ancestor.sourceId&&f.ruleFamilyId===p.basis.familyId&&f.fingerprint.probable===p.basis.findingSite);
    const finding=candidates.find(f=>f.id===p.basis.findingId)??(candidates.length===1?candidates[0]:undefined);
    if(!finding)continue; // No absence claim: an old decision is never imported as a current finding.
    let basis=bases.get(finding.id);if(!basis){basis=await acceptedFindingBasisFor(store,ws,document.run.id,finding.id,timing);bases.set(finding.id,basis);}
    const view=await decisionProjection(history,basis,ws,p.id,now,baselineRunId);acceptedFindingOf(basis);ownerHistoryOf(history);ownerContextOf(context);
    const d=view.decision;if(d.validity==='none')continue;
    decisions.push({dispositionId:d.id,findingId:d.findingId,evaluator:view.evaluator,state:d.state,reasonCode:d.reasonCode,basisDigest:d.basisDigest,journalHead:view.journalHead!,validity:d.validity,expiresAt:d.expiresAt,
      rationale:document.disclosure.profile==='shareable'?null:d.rationale});words.add(d.reasonCode);
  }
  if(!decisions.length)return document;
  const definitions=[...(document.definitions??[])];
  for(const key of words){const entry=STRINGS[key];if(!entry)throw Error('decision words unavailable');if(!definitions.some(d=>d.key===key))definitions.push({key,text:{business:entry.professional,code:entry.hud},define:entry.define!});}
  ownerHistoryOf(history);for(const basis of bases.values())acceptedFindingOf(basis);ownerContextOf(context);
  return{...document,decisions,definitions:definitions.sort((a,b)=>a.key.localeCompare(b.key))};
}
