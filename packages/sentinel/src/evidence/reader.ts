// A retained acceptance authenticates owner-associated imported claims only. It never rehydrates a live receipt,
// worker, qualified producer or mitigation capability. The opaque read handle has no mutation/launch consumer.
import type { NormalizedImport } from '../imports/normalize.js';
import { normalizeImport } from '../imports/normalize.js';
import { IMPORT_ADAPTER } from '../imports/types.js';
import { retainedSourceForAdmission, readRetainedSourceProof, type ProofTiming, type RetainedSourceProof } from '../execution/retained-source.js';
import { loadPlan } from '../execution/plans.js';
import { selectedSecretPrivacy } from '../reports/selected-privacy.js';
import { assessRun } from '../service/full-report.js';
import type { Workspace } from '../service/local.js';
import type { SentinelStore } from '../store/index.js';
import { evidenceLedgerFor, type EvidenceAcceptance } from '../store/evidence-binding.js';
import { canonicalJson, digestOf } from '../store/ledger-json.js';
import { compareTimestamps, isCalendarTimestamp } from '../validate.js';
import { deepFreeze } from '../policy/immutable.js';
import { auditUnavailable, verifyRetainedAudit } from './audit.js';
import { admissionOf, rootOf, EVIDENCE_LIMITS, checkEvidenceBounds } from './import-operation.js';
import { importOwnerContext, ownerContextOf, type ImportOwnerContext } from './owner-context.js';

declare const brand:unique symbol;
export interface AcceptedImportedReport {readonly [brand]:true}
interface ReadState {context:ImportOwnerContext;record:EvidenceAcceptance;proof:RetainedSourceProof;document:NormalizedImport}
const accepted=new WeakMap<object,ReadState>();
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const sortedEdges=(v:readonly {parent:string;child:string}[])=>[...v].sort((a,b)=>a.parent<b.parent?-1:a.parent>b.parent?1:a.child<b.child?-1:a.child>b.child?1:0);
const json=(b:Buffer):any=>JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(b));

/** Internal retained read, used for lost acknowledgements before a fresh spend. */
export async function validateAcceptedImport(context:ImportOwnerContext,candidateDigest:string):Promise<AcceptedImportedReport> {
  const c=ownerContextOf(context),store=c.store,ops=evidenceLedgerFor(store),record=ops.acceptance(candidateDigest);
  if(!record) auditUnavailable();
  const i=record.identity,p=i.publication;
  if(!p||i.schema!=='sentinel-report-import-operation/1'||i.storeId!==store.storeId||i.id!==record.operationId||i.epoch!==record.epoch
    ||i.candidateDigest!==record.candidateDigest||i.bindingDigest!==record.bindingDigest||i.priorHead!==record.previous||p.root!==record.root
    ||p.workspaceDigest!==c.workspaceDigest||!same(p.adapter,IMPORT_ADAPTER)||record.event.kind!=='evidence-accepted'||record.event.epoch!==i.epoch
    ||!same(record.event.payload,{operationId:i.id,candidateDigest:i.candidateDigest,root:p.root,bindingDigest:i.bindingDigest,previous:i.priorHead})
    ||!isCalendarTimestamp(record.acceptedAt)||compareTimestamps(record.acceptedAt,p.admission.decidedAt)<0) auditUnavailable();
  const roleKeys=['raw','manifest','normalized','candidate','admission'];
  if(!p.roles||Object.keys(p.roles).sort().join('|')!==roleKeys.sort().join('|')||new Set([...Object.values(p.roles),p.root]).size!==6
    ||Object.values(p.roles).some(id=>typeof id!=='string'||!/^sha256:[0-9a-f]{64}$/.test(id))||p.roles.candidate!==candidateDigest) auditUnavailable();
  const proof=await retainedSourceForAdmission(store,i.ancestor,{signal:c.signal,deadlineAt:c.deadlineAt});ownerContextOf(context);
  const source=readRetainedSourceProof(store,proof,i.ancestor,{signal:c.signal,deadlineAt:c.deadlineAt});
  const closure=[...new Set(source.closure.map(v=>v.id))].sort();
  if(!same(closure,i.closure)||i.bindingDigest!==digestOf({domain:'report-import',storeId:store.storeId,ancestor:i.ancestor})) auditUnavailable();
  const ids=[p.roles.raw,p.roles.manifest,p.roles.normalized,p.roles.candidate,p.roles.admission,p.root];
  const bytes=new Map<string,Buffer>();let size=0;
  for(const id of ids) {
    ownerContextOf(context);const refs=store.ledger.objectsOf(id);
    if(!refs.length) auditUnavailable();
    const declared=Math.max(...refs.map(r=>r.rawSize));
    if(!Number.isSafeInteger(declared)||declared<0||declared>16*1024*1024||size+declared>EVIDENCE_LIMITS.bytes) auditUnavailable();
    const data=await store.readArtifact(id);ownerContextOf(context);
    if(data.length!==declared) auditUnavailable();size+=data.length;bytes.set(id,data);
  }
  const root=json(bytes.get(p.root)!),audit=json(bytes.get(p.roles.admission)!),candidate=json(bytes.get(p.roles.candidate)!);
  if(!same(root,rootOf(i))||!bytes.get(p.root)!.equals(Buffer.from(canonicalJson(root)))||!same(audit,admissionOf(i))
    ||!bytes.get(p.roles.admission)!.equals(Buffer.from(canonicalJson(audit)))||!bytes.get(p.roles.candidate)!.equals(Buffer.from(canonicalJson(candidate)))) auditUnavailable();
  verifyRetainedAudit(context,{receipt:i.receipt,receiptDigest:i.receiptDigest,admission:p.admission,intent:i.intent,stateDigest:i.stateDigest,policyRevision:i.policyRevision});
  const run=store.ledger.getRun(i.ancestor.runId);if(!run) auditUnavailable();
  const expectedIntent={action:'evidence.import',input:i.candidateDigest,effects:['local-artifacts'],budget:{maxTokens:null,maxCost:null,currency:null},
    scope:{profile:run.envelope.requestedScope.profile,provider:null,targets:['report-import',i.ancestor.runId,`revision:${i.ancestor.revision}`,i.ancestor.sourceId]}};
  if(!same(i.intent,expectedIntent)||i.stateDigest!==digestOf({storeId:store.storeId,bindingDigest:i.bindingDigest,candidateDigest:i.candidateDigest,priorHead:i.priorHead,workspaceDigest:c.workspaceDigest,epoch:i.epoch})) auditUnavailable();
  const normalized=normalizeImport(bytes.get(p.roles.raw)!,bytes.get(p.roles.manifest)!);
  if(normalized.status!=='normalized'||normalized.digest!==p.roles.normalized||!bytes.get(p.roles.normalized)!.equals(Buffer.from(normalized.canonical))) auditUnavailable();
  const expectedCandidate={schema:'sentinel-report-import-candidate/1',domain:'report-import',storeId:store.storeId,ancestor:i.ancestor,workspaceDigest:c.workspaceDigest,
    sourceClosure:closure,adapter:normalized.document.adapter,raw:normalized.document.input.rawDigest,manifest:normalized.document.input.manifestDigest,normalized:normalized.digest,
    authority:'owner-associated-imported-claims'};
  if(!same(candidate,expectedCandidate)||digestOf(candidate)!==i.candidateDigest) auditUnavailable();
  const expectedArtifacts=[
    {id:p.roles.raw,schema:'application/octet-stream',privacy:'source-derived',links:[]},
    {id:p.roles.manifest,schema:'sentinel-import-manifest/draft-1',privacy:'source-derived',links:[]},
    {id:p.roles.normalized,schema:'sentinel-import-normalized/draft-1',privacy:'source-derived',links:[]},
    {id:p.roles.candidate,schema:'sentinel-report-import-candidate/1',privacy:'source-derived',links:[...new Set([p.roles.raw,p.roles.manifest,p.roles.normalized,...closure])].filter(id=>id!==p.roles.candidate)},
    {id:p.roles.admission,schema:'sentinel-evidence-admission/1',privacy:'source-derived',links:[]},
    {id:p.root,schema:'sentinel-accepted-evidence/1',privacy:'source-derived',links:[p.roles.candidate,p.roles.admission]},
  ];
  if(!same(i.artifacts,expectedArtifacts)) auditUnavailable();
  const expectedLinks=expectedArtifacts.flatMap(a=>a.links.map(child=>({parent:a.id,child})));
  if(!same(sortedEdges(expectedLinks),sortedEdges(record.links))) auditUnavailable();
  const floors=new Map(record.floors.map(v=>[v.id,v.privacy]));
  for(const id of ids) if(!['source','source-derived'].includes(floors.get(id)??'')) auditUnavailable();
  for(const entry of source.closure) if(entry.role==='source-content'&&floors.get(entry.id)!=='source') auditUnavailable();
  checkEvidenceBounds(ids.length,size,closure.length,expectedLinks.length);
  if(record.previous) {
    const previous=ops.acceptance(record.previous);
    if(!previous||previous.bindingDigest!==record.bindingDigest||previous.sequence>=record.sequence) auditUnavailable();
  }
  const unchanged=ops.acceptance(candidateDigest);
  if(!unchanged||!same(unchanged,record)) auditUnavailable();
  ownerContextOf(context);
  const token=Object.freeze({}) as AcceptedImportedReport;accepted.set(token,{context,record,proof,document:normalized.document});return token;
}
/** Existing report privacy readers authenticate all scanner/selected-ancestor records. No imported tag counts. */
async function privacy(context:ImportOwnerContext,runId:string):Promise<'clean'|'secret'|'unassessed'> {
  const c=ownerContextOf(context),run=c.store.ledger.getRun(runId);if(!run) auditUnavailable();
  if(run.state==='canceled') return 'unassessed'; // No claim of a clean canceled run; withhold all imported text.
  if(run.state!=='completed') auditUnavailable();
  const a=await assessRun(c.store,runId,{trustDir:c.trustDir});ownerContextOf(context);
  if(a.observations.some(o=>o.producer.kind==='scanner'&&o.producer.adapterId==='secrets-gitleaks')) return 'secret';
  const plan=await loadPlan(c.store,runId,a.planRevision);ownerContextOf(context);
  const inherited=await selectedSecretPrivacy(c.store,runId,plan);ownerContextOf(context);return inherited.hasMatches?'secret':'clean';
}
/** This is a data projection, never a producer/finding/mitigation authority constructor. No source-closure body is exported. */
export async function reportImportView(value:AcceptedImportedReport,options:{baselineRunId?:string}={}) {
  const s=accepted.get(value);if(!s) auditUnavailable();const c=ownerContextOf(s.context),i=s.record.identity;
  readRetainedSourceProof(c.store,s.proof,i.ancestor,{signal:c.signal,deadlineAt:c.deadlineAt});
  const run=c.store.ledger.getRun(i.ancestor.runId);if(!run) auditUnavailable();
  const runIds=new Set([i.ancestor.runId,...(run.envelope.baselineId?[run.envelope.baselineId]:[]),...(options.baselineRunId?[options.baselineRunId]:[])]);
  if(runIds.size>3) auditUnavailable();let reason:'accepted-secret-match'|'privacy-unassessed-canceled-run'|null=null;
  for(const id of runIds) {const state=await privacy(s.context,id);if(state==='secret') reason='accepted-secret-match';else if(state==='unassessed'&&reason===null) reason='privacy-unassessed-canceled-run';}
  ownerContextOf(s.context);
  return deepFreeze({schema:'sentinel-import-view/1',kind:'imported-report',authority:'owner-associated-imported-claims',candidateDigest:s.record.candidateDigest,root:s.record.root,
    withheld:reason!==null,limitation:reason,counts:{claims:s.document.claims.length,exchanges:s.document.exchanges.length,cookies:s.document.cookies.length},
    // No heuristic substitutes source strings. Any match (current/baseline/selected ancestor) removes the entire
    // caller-controlled payload in both disclosure profiles. Counts and structural digests remain useful.
    document:reason===null?structuredClone(s.document):null});
}
export async function readAcceptedReportImport(store:SentinelStore,ws:Workspace,candidateDigest:string,options:{timing:ProofTiming;baselineRunId?:string}) {
  const context=importOwnerContext(store,ws,options.timing),value=await validateAcceptedImport(context,candidateDigest);
  return reportImportView(value,{...(options.baselineRunId?{baselineRunId:options.baselineRunId}:{})});
}
