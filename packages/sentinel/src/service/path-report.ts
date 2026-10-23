// Read-only accepted structural task projection. Genuine ledger publication/attempt/invocation and exact canonical
// binding are authority; parsed documents alone are not. Outcomes are reported by the pinned bounded query, not a
// second independently executed absence proof. No worker assets, closure entry or native parser are loaded here.
import type {ArtifactId,PlanWork,ReportStructuralPaths} from '../contracts/index.js';
import type {SentinelStore} from '../store/index.js';
import type {AdmittedPlan} from '../execution/plans.js';
import {verifyWorkEnvelope,canonicalArtifactId,influenceManifestOf} from '../planner/boundary.js';
import {bindingId,EXECUTION_BINDING_SCHEMA,capturedInputScopes,type ExecutionBinding} from '../execution/plan.js';
import {coverageRecords,scopeIndex} from '../execution/coverage.js';
import {inputFingerprintOf} from '../execution/supervisor.js';
import {retainedSourceForAdmission,readRetainedSourceProof,assertRetainedSourceProof,RetainedBudget} from '../execution/retained-source.js';
import {pathRequestOf} from '../analysis/paths/request.js';
import {pathUnitsFor} from '../analysis/paths/admission.js';
import {pathOutputOf} from '../analysis/paths/output.js';
import {assertPathEvidence} from '../analysis/paths/paths.js';
import {PathExecutionBudget} from '../analysis/paths/budget.js';
import {PATHS_SUPPORTED_RULES,PATHS_JOB_SCHEMA,PATHS_OUTPUT_MEDIA,PATHS_TASK_REPORT_SCHEMA} from '../analysis/paths/definitions.js';
import {validateEnvelope} from '../validate.js';
import {canonicalJsonBytes} from '../store/objects.js';
const same=(a:unknown,b:unknown)=>canonicalJsonBytes(a??null).equals(canonicalJsonBytes(b??null));
export async function acceptedPaths(store:SentinelStore,admitted:AdmittedPlan,unit:PlanWork,refuse:(reason:string)=>never):Promise<ReportStructuralPaths>{
 const plan=admitted.plan,request=pathRequestOf(admitted.pathRequest);
 if(!pathUnitsFor(plan,request).has(unit.id))return refuse('structural unit differs from its exact admitted request');
 const pub=store.ledger.getPublication(unit),row=store.ledger.getWork(unit),attempt=pub&&store.ledger.getAttempt(pub.attemptId),digest=admitted.profile.adapters.find(a=>a.adapterId==='bounded-paths')?.digest;
 if(!pub||!row||row.runId!==plan.runId||row.state!=='published'||row.envelope.planRevision!==plan.revision||!same(pub.work,{id:unit.id,revision:unit.revision})||!attempt||attempt.state!=='succeeded'||!same(attempt.work,pub.work)||attempt.envelope.worker?.kind!=='owned-child'||!attempt.envelope.invocation||!digest||unit.implementationDigest!==digest||row.envelope.stage.implementationDigest!==digest)return refuse('structural query has no exact succeeded accepted owner attempt');
 try{verifyWorkEnvelope(plan,row.envelope)}catch{return refuse('structural work differs from its admitted unit')}
 const checks=plan.checks.filter(c=>unit.checks.includes(c.id));
 if(checks.length!==unit.checks.length||checks.some(c=>{const pin=plan.pins.rules.find(p=>p.familyId===c.familyId&&p.revision===c.ruleRevision);return !pin||pin.adapterId!==unit.adapterId||!PATHS_SUPPORTED_RULES.some(r=>r.familyId===pin.familyId&&r.revision===pin.revision&&r.definitionDigest===pin.definitionDigest)}))return refuse('structural query has another exact rule assignment');
 const timing={signal:new AbortController().signal,deadlineAt:performance.now()+120000},anchor={runId:plan.runId,revision:plan.revision,planDigest:plan.digest,snapshotId:request.value.snapshotId,sourceId:request.value.sourceId};
 const proof=await retainedSourceForAdmission(store,anchor,timing),source=readRetainedSourceProof(store,proof,anchor,timing);
 const boundary=()=>assertRetainedSourceProof(store,proof,anchor,timing);
 const metadata=new RetainedBudget(store,{signals:[timing.signal],deadlineAt:timing.deadlineAt,stillWithin:[boundary]}),cache=new Map<ArtifactId,Promise<Buffer>>();
 const bytes=(id:ArtifactId)=>{let b=cache.get(id);if(!b)cache.set(id,b=metadata.read(id,'metadata'));return b};
 const read=async(id:ArtifactId)=>{const b=await bytes(id);try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(b))}catch{return refuse('accepted structural bytes are malformed')}};
 const inv=await read(attempt.envelope.invocation),job={schema:PATHS_JOB_SCHEMA as typeof PATHS_JOB_SCHEMA,request:request.id,snapshot:source.manifest,analysis:{artifact:source.artifact.id,result:source.result.id,index:source.index.id}},jobId=canonicalArtifactId(job);
 const sourceInputs=[...new Set(unit.inputs.map(i=>i.content))].sort(),auxiliary=[{id:source.result.id,role:'analysis-result'},{id:source.index.id,role:'analysis-index'},{id:source.artifact.id,role:'analysis-artifact'},{id:source.manifest,role:'snapshot-manifest'},{id:request.id,role:'path-request'}];
 const sealed=[...new Set([...sourceInputs,jobId,...auxiliary.map(a=>a.id)])].sort();
 const inputScopes=capturedInputScopes(unit,checks,[...new Set(unit.inputs.map(i=>i.content))].map(id=>({id})));
 if(inv?.format!=='sentinel-invocation/draft-1'||inv.store!==store.storeId||inv.attemptId!==attempt.id||!same(inv.work,pub.work)||inv.coordinatorEpoch!==attempt.epoch||inv.adapter?.id!==unit.adapterId||inv.adapter?.digest!==digest||inv.isolation!=='child'||!Object.hasOwn(inv,'job')||inv.job!==jobId||!Array.isArray(inv.inputs)||!same([...inv.inputs].sort(),sealed)||inv.inputFingerprint!==inputFingerprintOf(sealed)||!same(inv.assignment?.checks,unit.checks)||!same(inv.assignment?.scopes,unit.scopes)||!same(inv.assignment?.inputScopes,inputScopes))return refuse('structural invocation differs from its exact accepted job and assignment');
 if(!same(await read(jobId),job)||!canonicalJsonBytes(job).equals(await bytes(jobId))||!canonicalJsonBytes(request.value).equals(await bytes(request.id)))return refuse('structural sealed job/request differs from its canonical admission');
 const influence=canonicalArtifactId(influenceManifestOf(plan,unit));if(row.envelope.influenceManifest!==influence)return refuse('structural influence manifest differs');
 const expected:ExecutionBinding={schema:EXECUTION_BINDING_SCHEMA,plan:{runId:plan.runId,revision:plan.revision,digest:plan.digest},work:{id:unit.id,revision:unit.revision},influenceManifest:influence,adapter:{id:unit.adapterId!,digest},inputs:sealed,sourceInputs,protocolFingerprint:inv.inputFingerprint,inputFingerprint:unit.inputFingerprint,derived:{job:jobId,auxiliary,analysis:{inventory:unit.dependencies[0]!,result:source.result.id,index:source.index.id,artifact:source.artifact.id,manifest:source.manifest}}};
 if(!same(await read(bindingId(expected)),expected))return refuse('structural query has no exact accepted execution binding');
 const only=(schema:string)=>{const found=pub.outputs.filter(o=>o.schema===schema);if(found.length!==1)return refuse('structural publication has missing or duplicate required output');return found[0]!};
 if(pub.outputs.some(o=>o.schema==='sentinel-driver-finding/draft-1'||o.schema==='sentinel-driver-report/draft-1'))return refuse('structural results cannot be security observations or findings');
 const output=only(PATHS_OUTPUT_MEDIA),raw=await read(output.id),doc=pathOutputOf(raw,job,jobId,request,source.analysisFingerprint,new Set(sealed));
 const validation=new PathExecutionBudget({signal:timing.signal,deadlineAt:timing.deadlineAt});assertPathEvidence(doc.evidence,{sourceId:source.sourceId,artifact:source.artifact.value,index:source.index.value},validation);
 const result=await read(only('sentinel-worker/draft-1#result').id);
 if(!validateEnvelope('protocol',result).ok||result.type!=='result'||result.attemptId!==attempt.id||result.coordinatorEpoch!==attempt.epoch||!same(result.work,pub.work)||result.inputFingerprint!==inv.inputFingerprint||result.granularity!=='aggregate'||!same(result.artifacts,[{id:output.id,mediaType:PATHS_OUTPUT_MEDIA,bytes:(await bytes(output.id)).length}])||['observations','coveredChecks','scannedSet','skipped','actualReadSet','unresolvedFrontiers','diagnostics'].some(k=>!same(result[k],[])))return refuse('structural accepted worker result differs from its exact raw output');
 const report=await read(only(PATHS_TASK_REPORT_SCHEMA).id),accounting=report?.validationUsage;
 if(!accounting||Object.keys(accounting).sort().join()!=='cacheBytes,decodedBytes,elapsedMs,reads,resultBytes,steps,visited'||Object.entries(accounting).some(([key,value])=>typeof value!=='number'||!Number.isFinite(value)||value<0||(key!=='elapsedMs'&&!Number.isSafeInteger(value)))||accounting.elapsedMs>120000||accounting.steps>4000000||['reads','decodedBytes','cacheBytes','visited','resultBytes'].some(k=>accounting[k]!==0))return refuse('structural normalization accounting is malformed');
 const expectedReport={kind:'structural-call-reachability',assessment:'none',adapter:'bounded-paths',runId:plan.runId,snapshotId:source.snapshotId,sourceId:source.sourceId,work:pub.work,attemptId:attempt.id,job:jobId,request:request.id,analysis:{result:source.result.id,index:source.index.id,artifact:source.artifact.id,manifest:source.manifest},evidence:doc.evidence,usage:doc.usage,validationUsage:accounting,findings:0};
 if(!same(report,expectedReport)||!same(await read(only('sentinel-paths/draft-1').id),doc.evidence))return refuse('structural normalized records differ from the pinned query output');
 const coverage=await Promise.all(pub.outputs.filter(o=>o.schema==='sentinel-coverage/draft-1').map(o=>read(o.id)));
 if(coverage.length!==checks.length||new Set(coverage.map(c=>c.checkId)).size!==checks.length)return refuse('structural task has missing or duplicate coverage');
 const normalized={granularity:'aggregate',coveredChecks:[],scannedSet:[],actualReadSet:[],skipped:checks.map(c=>({scopeId:c.scopeId,reasonCode:'sentinel.paths.notDataFlow'})),unresolvedFrontiers:[]};
 for(const actual of coverage){
  if(!validateEnvelope('coverage',actual).ok)return refuse('structural task coverage is malformed');
  const expected=coverageRecords({runId:plan.runId,attemptId:attempt.id,work:pub.work,checks,adapterGranularity:'aggregate',result:normalized as any,recordedAt:actual.recordedAt,scopes:scopeIndex(plan)});
  if(!same(actual,expected.envelopes.find(c=>c.checkId===actual.checkId)))return refuse('structural completion cannot donate security coverage');
  for(const record of expected.records.filter(r=>r.schema!=='sentinel-coverage/draft-1'))if((record.value as any).checkId===actual.checkId){
   const id=actual[record.schema==='sentinel-coverage-scope/draft-1'?'assessedScopeArtifact':'limitationsArtifact'];
   if(!same(await read(id),record.value))return refuse('structural coverage provenance differs from its fixed unassessed result');
  }
 }
 boundary();
 return {artifact:only(PATHS_TASK_REPORT_SCHEMA).id,attemptId:attempt.id,request:request.id,job:jobId,sourceId:source.sourceId,work:pub.work,ancestor:{...request.value.ancestor},evidence:doc.evidence,limitationKey:'sentinel.paths.notDataFlow',statementKey:'sentinel.paths.report.pinnedQuery'};
}
