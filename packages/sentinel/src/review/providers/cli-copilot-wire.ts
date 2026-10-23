// Copilot receives one piped, role-tagged prompt, not native role/system APIs. Vendor hidden instructions stay unobserved.
import {canonicalJsonBytes} from '../../store/objects.js';
import type {ChatMessage,ParsedReply} from './kinds.js';
import {fail} from './errors.js';
import type {NativeReviewWire} from '../../contracts/instructions.js';
export function renderNativeCopilotWire(model:string,messages:readonly ChatMessage[],maxOutputTokens:number):NativeReviewWire{
 if(messages.length<2||messages[0]?.role!=='system'||messages.slice(1).some(m=>m.role==='system'))return fail('sentinel.provider.invalidProfile','Copilot wire requires exactly one leading Sentinel system message');
 return Object.freeze({encoding:'sentinel-copilot-chat/v1',system:messages[0].content,stdin:Buffer.from(canonicalJsonBytes({encoding:'sentinel-copilot-chat/v1',messages:messages.map(m=>({role:m.role,content:m.content})),requestedMaxOutputTokens:maxOutputTokens})).toString('utf8'),requestedModel:model});
}
const obj=(v:unknown):Record<string,any>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:undefined;
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
/** Pinned1.0.103 cli-main emits assistant.message and one result; final usage is its separately owned usage-output file. */
export class NativeCopilotDecoder {
 #pending=Buffer.alloc(0);#total=0;#frames=0;#result=false;#message:string|undefined;#session:string|undefined;
 constructor(readonly maxBytes:number,readonly requestedModel:string){}
 get bytes(){return this.#total}
 push(chunk:Uint8Array){this.#total+=chunk.byteLength;if(this.#total>this.maxBytes)fail('sentinel.provider.responseTooLarge','Copilot response bound','possible');this.#pending=Buffer.concat([this.#pending,chunk]);let i;while((i=this.#pending.indexOf(10))!==-1){const line=this.#pending.subarray(0,i);this.#pending=this.#pending.subarray(i+1);this.#line(line)}}
 #line(bytes:Uint8Array){if(bytes.byteLength===0)return;if(++this.#frames>128||this.#result)fail('sentinel.provider.malformedResponse','Copilot stream framing','possible');let e:Record<string,any>|undefined;try{e=obj(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)))}catch{fail('sentinel.provider.malformedResponse','Copilot JSON stream','possible')}if(!e||typeof e.type!=='string')return fail('sentinel.provider.malformedResponse','Copilot event shape','possible');
  if(e.type==='result'){if(e.exitCode!==0||e.outcome!==undefined||typeof e.sessionId!=='string'||e.sessionId.length>96||!this.#message||!this.#session||this.#session!==e.sessionId)fail('sentinel.provider.malformedResponse','Copilot did not complete its exact session','possible');this.#result=true;return}
  // Only harmless lifecycle/final-visible events. Tool/skill/subagent/extension/unknown events refuse before acceptance.
  if(!['session.start','user.message','assistant.turn_start','assistant.turn_end','assistant.message','assistant.reasoning','assistant.reasoning_delta','assistant.message_delta','session.info','session.warning'].includes(e.type))fail('sentinel.provider.malformedResponse','Copilot event outside no-tools profile','possible');
  const data=obj(e.data);if(!data)return fail('sentinel.provider.malformedResponse','Copilot event data missing','possible');
  if(e.type==='session.start'){if(this.#session||typeof data.sessionId!=='string'||data.sessionId.length>96||data.copilotVersion!=='1.0.103'||data.selectedModel!==undefined&&data.selectedModel!==this.requestedModel)fail('sentinel.provider.malformedResponse','Copilot session identity missing','possible');this.#session=data.sessionId}
  if(e.type==='assistant.message'){if(this.#message!==undefined||typeof data.content!=='string'||(data.toolRequests!==undefined&&(!Array.isArray(data.toolRequests)||data.toolRequests.length))||data.chunkCount!==undefined&&data.chunkCount!==1)fail('sentinel.provider.malformedResponse','Copilot final visible message unavailable','possible');this.#message=data.content}
  // Reasoning/event contents are discarded immediately, never included in the accepted return value or artifacts.
 }
 finish(usageBytes:Uint8Array):ParsedReply{
  if(this.#pending.length){const last=this.#pending;this.#pending=Buffer.alloc(0);this.#line(last)}if(!this.#result||this.#message===undefined||this.#total+usageBytes.byteLength>this.maxBytes)fail('sentinel.provider.malformedResponse','Copilot final output/usage unavailable or over bound','possible');let metrics:Record<string,any>|undefined;try{metrics=obj(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(usageBytes)))}catch{fail('sentinel.provider.malformedResponse','Copilot usage JSON','possible')}
  const models=obj(metrics?.modelMetrics),names=models?Object.keys(models):[];if(names.length!==1||names[0]!==this.requestedModel||metrics?.currentModel!==undefined&&metrics.currentModel!==this.requestedModel||metrics?.totalUserRequests!==1)fail('sentinel.provider.identityMismatch','Copilot model/one-turn usage not confirmed','possible');
  const model=obj(models![names[0]!]),requests=obj(model?.requests),u=obj(model?.usage);if(requests?.count!==1||!u||['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].some(k=>!count(u[k])))fail('sentinel.provider.malformedResponse','Copilot aggregate usage unobserved or multiple calls','possible');
  const usage=u!;/* Preserve the vendor total as reported; cache counters are not assumed disjoint. */const input=usage.inputTokens;if(!Number.isSafeInteger(input))fail('sentinel.provider.malformedResponse','Copilot usage overflow','possible');return{content:this.#message!,returnedModel:names[0]!,usage:{inputTokens:input,outputTokens:usage.outputTokens},finish:'complete'};
 }
}
