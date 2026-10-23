// Pure bounded output checks shared by driver and retained report reader. No assets, native parser or file work.
import type { PathsJob, PathsOutput } from './protocol.js';
import { pathRequestOf } from './request.js';
import { PATHS_OUTPUT_SCHEMA } from './definitions.js';
import { PATH_EXECUTION_LIMITS } from './budget.js';
import { canonicalJsonBytes } from '../../store/objects.js';
import { validateEnvelope } from '../../validate.js';
import { DriverError } from '../../adapters/drivers/common.js';
const same=(a:unknown,b:unknown)=>canonicalJsonBytes(a??null).equals(canonicalJsonBytes(b??null));
const invalid=(reason:string):never=>{throw new DriverError('sentinel.drivers.contextInvalid',reason)};
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
