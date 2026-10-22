// The compatibility preview is a trusted driver too. The extra sealed job is never mistaken for a source file.
import type { AdapterRegistry } from '../execution/registry.js';
import type { CheckDriver } from '../execution/check-drivers.js';
import { ExecutionError } from '../execution/errors.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { PREVIEW_DETECTOR_ID, PREVIEW_FINDINGS_SCHEMA, PREVIEW_RULE, detect } from '../adapters/preview-detector.js';
import { supportedRules } from './trusted-profile.js';
const same = (a: unknown, b: unknown) => canonicalJsonBytes(a).equals(canonicalJsonBytes(b));
export function previewDriver(registry: AdapterRegistry): CheckDriver {
 return {adapterId: PREVIEW_DETECTOR_ID, implementationDigest:registry.get(PREVIEW_DETECTOR_ID).digest,
  supportedRules:()=>supportedRules().filter(r=>r.adapterId===PREVIEW_DETECTOR_ID),
  async prepare(ctx){return{job:{schema:'sentinel-preview-job/draft-1',snapshot:ctx.plan.pins.snapshotId,unit:ctx.unit.id,checks:ctx.checks.map(c=>c.id),inputs:ctx.unit.inputs},auxiliary:[]};},
  async normalize(ctx,v){
   const bad=():never=>{throw new ExecutionError('sentinel.execution.resultMismatch',{reason:'the preview output does not match its assigned captured source'});};
   const outputs=v.outputs.filter(o=>o.mediaType==='application/json');if(outputs.length!==1)bad();
   let doc:any;try{doc=JSON.parse(Buffer.from(v.output(outputs[0]!.id)).toString('utf8'));}catch{return bad();}
   if(doc?.schema!==PREVIEW_FINDINGS_SCHEMA||doc.detector!==PREVIEW_DETECTOR_ID||doc.rule!==PREVIEW_RULE||!same(doc.checks,[...ctx.unit.checks].sort())||!same(doc.scopes,[...ctx.unit.scopes].sort()))bad();
   const input=ctx.unit.inputs[0];if(ctx.unit.inputs.length!==1||ctx.unit.scopes.length!==1||!input)bad();
   const bytes=v.sealed(input!.content);if(!bytes)bad();
   if(doc.scanned.length){let text:string;try{text=new TextDecoder('utf8',{fatal:true}).decode(bytes);}catch{return bad();}
    if(!same(doc.scanned,ctx.unit.scopes)||!same(doc.findings,detect(input!.relativePath,text,input!.content)))bad();}
   else if(!Array.isArray(doc.findings)||doc.findings.length||!Array.isArray(doc.skipped)||!doc.skipped.length)bad();
   if(!same(doc.scanned,v.result.scannedSet)||!same(doc.skipped,v.result.skipped))bad();
   return{coverage:{coveredChecks:v.result.coveredChecks,scannedSet:v.result.scannedSet,actualReadSet:v.result.actualReadSet,skipped:v.result.skipped,unresolvedFrontiers:v.result.unresolvedFrontiers,granularity:'per-file-per-rule'},records:[]};
  }};
}
