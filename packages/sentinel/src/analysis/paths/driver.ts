// Coordinator-only driver for one genuinely admitted retained structural request. The fixed child searches data;
// normalization binds its sole output to the prepared job, exact original source and accepted attempt. A completed
// query grants no security coverage or findings. Unrelated required units remain held by the execution plan.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId } from '../../contracts/common.js';
import type { DriverContext, VerifiedAttempt, CheckDriver, PreparedJob, NormalizedOutcome } from '../../execution/check-drivers.js';
import { retainedAuxiliary } from '../../execution/check-drivers.js';
import { createAdapterRegistry, type AdapterLimits, type BuiltInAdapterDefinition } from '../../execution/registry.js';
import { canonicalJsonBytes } from '../../store/objects.js';
import { deepFreeze } from '../../policy/immutable.js';
import { DriverError, sha256 } from '../../adapters/drivers/common.js';
import { writeBuiltinClosureEntry } from '../../frameworks/controls/closure.js';
import { canonicalArtifactId, influenceManifestOf } from '../../planner/boundary.js';
import { inputFingerprintOf } from '../../execution/supervisor.js';
import { validateEnvelope } from '../../validate.js';
import { pathRequestOf, PATHS_ADAPTER_ID } from './request.js';
import { pathUnitsFor } from './admission.js';
import { assertPathEvidence } from './paths.js';
import { PathExecutionBudget, PATH_EXECUTION_LIMITS } from './budget.js';
import { PATHS_JOB_SCHEMA, PATHS_OUTPUT_SCHEMA, PATHS_OUTPUT_MEDIA, PATHS_TASK_REPORT_SCHEMA, PATHS_SUPPORTED_RULES } from './definitions.js';
import type { PathsJob, PathsOutput } from './protocol.js';
const same=(a:unknown,b:unknown)=>canonicalJsonBytes(a??null).equals(canonicalJsonBytes(b??null));
const sameBytes=(a:Uint8Array|undefined,b:Uint8Array)=>Boolean(a&&Buffer.from(a).equals(Buffer.from(b)));
const invalid=(reason:string):never=>{throw new DriverError('sentinel.drivers.contextInvalid',reason)};
function sourceOf(ctx:DriverContext){
  ctx.signal.throwIfAborted();
  if(!ctx.pathRequest||!ctx.analysis) return invalid('a path task requires its admitted request and coordinator-produced original source');
  const request=pathRequestOf(ctx.pathRequest),a=ctx.analysis;
  if(!pathUnitsFor(ctx.plan,request).has(ctx.unit.id)||ctx.unit.adapterId!==PATHS_ADAPTER_ID||a.sourceId!==ctx.unit.sourceId||a.snapshotId!==ctx.plan.pins.snapshotId||request.value.sourceId!==a.sourceId)return invalid('the request and retained source are not this exact active unit');
  for(const c of ctx.checks){
    const pin=ctx.plan.pins.rules.find(r=>r.familyId===c.familyId&&r.revision===c.ruleRevision),resolved=ctx.rules.find(r=>r.rule.familyId===c.familyId)?.rule;
    if(!pin||!PATHS_SUPPORTED_RULES.some(r=>r.familyId===c.familyId&&r.revision===c.ruleRevision&&r.definitionDigest===pin.definitionDigest)||pin.adapterId!==PATHS_ADAPTER_ID||!resolved||resolved.definitionDigest!==pin.definitionDigest)return invalid('the structural unit is not the exact promoted shipped rule');
  }
  return {request,a};
}
function expectedJob(ctx:DriverContext):PathsJob{
  const {request,a}=sourceOf(ctx);
  return {schema:PATHS_JOB_SCHEMA,request:request.id,snapshot:a.manifest,analysis:{artifact:a.artifact.id,result:a.result.id,index:a.index.id}};
}
/** Pure closed-output checks reused by accepted readback; these data checks create no authority. */
export function pathOutputOf(doc:any,job:PathsJob,jobId:string,request:ReturnType<typeof pathRequestOf>,analysisFingerprint:string,sealed:ReadonlySet<string>):PathsOutput{
  const fields=['schema','job','request','ancestor','snapshotId','sourceId','evidence','actualReadSet','usage'];
  if(!doc||typeof doc!=='object'||Object.keys(doc).length!==fields.length||fields.some(k=>!Object.hasOwn(doc,k))||doc.schema!==PATHS_OUTPUT_SCHEMA||doc.job!==jobId||doc.request!==request.id||!same(doc.ancestor,request.value.ancestor)||doc.snapshotId!==request.value.snapshotId||doc.sourceId!==request.value.sourceId)return invalid('the structural output is not its exact sealed request');
  const checked=validateEnvelope('paths',doc.evidence);
  if(!checked.ok||doc.evidence.snapshotId!==doc.snapshotId||doc.evidence.sourceId!==doc.sourceId||doc.evidence.analysisFingerprint!==analysisFingerprint||!same(doc.evidence.bounds,request.value.bounds)||doc.evidence.results.length!==request.value.queries.length||doc.evidence.results.some((r:any,i:number)=>r.from!==request.value.queries[i]!.from||r.to!==request.value.queries[i]!.to))return invalid('the structural evidence has other queries, bounds or parser identity');
  const mandatory=[jobId,request.id,job.snapshot,...Object.values(job.analysis)];
  if(!Array.isArray(doc.actualReadSet)||!same(doc.actualReadSet,[...new Set(doc.actualReadSet)].sort())||doc.actualReadSet.some((id:any)=>typeof id!=='string'||!sealed.has(id))||mandatory.some(id=>!doc.actualReadSet.includes(id)))return invalid('the structural read set is not its sealed input closure');
  const usage=doc.usage;
  if(!usage||Object.keys(usage).sort().join()!=='cacheBytes,decodedBytes,elapsedMs,reads,resultBytes,steps,visited'||Object.entries(usage).some(([key,value])=>typeof value!=='number'||!Number.isFinite(value)||value<0||(key!=='elapsedMs'&&!Number.isSafeInteger(value)))||usage.elapsedMs>120000||usage.resultBytes>PATH_EXECUTION_LIMITS.outputBytes||['reads','decodedBytes','cacheBytes','visited','steps'].some(k=>usage[k]>PATH_EXECUTION_LIMITS[k as keyof typeof PATH_EXECUTION_LIMITS]))return invalid('the structural accounting is outside its fixed bounds');
  return doc;
}
export function boundedPathsAdapter(options:{entryDir:string;limits?:Partial<AdapterLimits>}){
  const entry=writeBuiltinClosureEntry(options.entryDir,PATHS_ADAPTER_ID);
  const definition:BuiltInAdapterDefinition=Object.freeze({id:PATHS_ADAPTER_ID,version:'0.1.0',kind:'built-in',isolation:'child',module:entry.module,coverage:'aggregate',...(options.limits?{limits:{...options.limits}}:{})});
  const digest=createAdapterRegistry([definition]).get(PATHS_ADAPTER_ID).digest;
  const driver:CheckDriver=Object.freeze({adapterId:PATHS_ADAPTER_ID,implementationDigest:digest,reads:Object.freeze({analysis:true as const}),supportedRules:()=>PATHS_SUPPORTED_RULES,
    async prepare(ctx:DriverContext):Promise<PreparedJob>{
      const job=expectedJob(ctx),request=pathRequestOf(ctx.pathRequest);
      const requestPath=join(ctx.workDir,'sentinel-path-request.json');
      writeFileSync(requestPath,canonicalJsonBytes(request.value),{flag:'wx',mode:0o600});ctx.signal.throwIfAborted();
      return deepFreeze({job,auxiliary:[...retainedAuxiliary(ctx),{role:'path-request',path:requestPath}]});
    },
    async normalize(ctx:DriverContext,verified:VerifiedAttempt):Promise<NormalizedOutcome>{
      const {request,a}=sourceOf(ctx),job=expectedJob(ctx),jobBytes=canonicalJsonBytes(job),jobId=sha256(jobBytes),binding=verified.binding,inv=verified.outcome.invocation.record;
      if(!same(verified.job,job)||!Object.isFrozen(verified.outcome)||verified.outcome.result!==verified.result||verified.outcome.worker?.kind!=='owned-child'||verified.outcome.adapter.id!==PATHS_ADAPTER_ID||verified.outcome.adapter.digest!==digest||inv.adapter.id!==PATHS_ADAPTER_ID||inv.adapter.digest!==digest||inv.job!==jobId||binding?.derived?.job!==jobId||!same(binding.plan,{runId:ctx.plan.runId,revision:ctx.plan.revision,digest:ctx.plan.digest})||!same(binding.work,{id:ctx.unit.id,revision:ctx.unit.revision})||binding.inputFingerprint!==ctx.unit.inputFingerprint||binding.adapter.id!==PATHS_ADAPTER_ID||binding.adapter.digest!==digest||!same(inv.work,binding.work)||verified.result.attemptId!==inv.attemptId||verified.outcome.attemptId!==inv.attemptId||verified.result.coordinatorEpoch!==inv.coordinatorEpoch||!same(inv.assignment?.checks,ctx.unit.checks)||!same(inv.assignment?.scopes,ctx.unit.scopes))return invalid('the output is not the exact coordinator-prepared accepted attempt');
      const ids=[...new Set([...ctx.inputs.map(i=>i.id),jobId,request.id,a.manifest,a.result.id,a.index.id,a.artifact.id])].sort();
      if(!same(binding.inputs,ids)||!same([...inv.inputs].sort(),ids)||!same(binding.sourceInputs,[...new Set(ctx.inputs.map(i=>i.id))].sort())||!sameBytes(verified.sealed(jobId),jobBytes)||!sameBytes(verified.sealed(request.id),canonicalJsonBytes(request.value)))return invalid('the invocation job or complete sealed source set differs');
      const auxiliary=[{id:a.result.id,role:'analysis-result'},{id:a.index.id,role:'analysis-index'},{id:a.artifact.id,role:'analysis-artifact'},{id:a.manifest,role:'snapshot-manifest'},{id:request.id,role:'path-request'}];
      if(!same(binding.derived?.auxiliary,auxiliary)||!same(binding.derived?.analysis,{inventory:a.inventory,result:a.result.id,index:a.index.id,artifact:a.artifact.id,manifest:a.manifest})||binding.influenceManifest!==canonicalArtifactId(influenceManifestOf(ctx.plan as any,ctx.unit))||binding.protocolFingerprint!==inputFingerprintOf(ids as ArtifactId[])||inv.inputFingerprint!==binding.protocolFingerprint||!same(inv.assignment?.inputScopes,ctx.inputScopes))return invalid('the prepared binding differs from original retained authority');
      if(verified.outputs.length!==1||verified.outputs[0]!.mediaType!==PATHS_OUTPUT_MEDIA||verified.result.coveredChecks.length||verified.result.observations.length||verified.result.scannedSet.length||verified.result.skipped.length||verified.result.actualReadSet.length||verified.result.unresolvedFrontiers.length)return invalid('a structural child cannot supply security coverage or additional outputs');
      const bytes=verified.output(verified.outputs[0]!.id);if(sha256(bytes)!==verified.outputs[0]!.id)return invalid('the output hash differs');
      let raw:any;try{raw=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes))}catch{return invalid('invalid structural output bytes')}
      const doc=pathOutputOf(raw,job,jobId,request,a.analysisFingerprint,new Set(ids));
      // A separate bounded validation pass checks original graph identities without a second query traversal or
      // source read. The coordinator's original signal/deadline still fences normalization and durable acceptance.
      const validation=new PathExecutionBudget({signal:ctx.signal});
      assertPathEvidence(doc.evidence,{sourceId:a.sourceId,artifact:a.artifact.value,index:a.index.value},validation);ctx.signal.throwIfAborted();
      const report={kind:'structural-call-reachability',assessment:'none',adapter:PATHS_ADAPTER_ID,runId:ctx.plan.runId,snapshotId:a.snapshotId,sourceId:a.sourceId,work:{id:ctx.unit.id,revision:ctx.unit.revision},attemptId:inv.attemptId,job:jobId,request:request.id,analysis:{result:a.result.id,index:a.index.id,artifact:a.artifact.id,manifest:a.manifest},evidence:doc.evidence,usage:doc.usage,validationUsage:validation.usage(),findings:0};
      return {coverage:{granularity:'aggregate',coveredChecks:[],scannedSet:[],actualReadSet:[],skipped:ctx.checks.map(c=>({scopeId:c.scopeId,reasonCode:'sentinel.paths.notDataFlow'})),unresolvedFrontiers:[]},records:[{value:report,schema:PATHS_TASK_REPORT_SCHEMA,privacy:'source-derived'},{value:doc.evidence,schema:'sentinel-paths/draft-1',privacy:'source-derived'}]};
    },
  });
  return Object.freeze({definition,driver,closureDigest:entry.closureDigest});
}
