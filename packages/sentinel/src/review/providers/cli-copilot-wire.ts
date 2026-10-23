// Copilot receives one piped, role-tagged prompt, not native role/system APIs. Vendor hidden instructions stay unobserved.
import {canonicalJsonBytes} from '../../store/objects.js';
import type {ChatMessage,ParsedReply} from './kinds.js';
import {fail,NativeCopilotError,type NativeCopilotDiagnostic,type ProviderErrorCode} from './errors.js';
import type {NativeReviewWire} from '../../contracts/instructions.js';
export function renderNativeCopilotWire(model:string,messages:readonly ChatMessage[],maxOutputTokens:number):NativeReviewWire{
 if(messages.length<2||messages[0]?.role!=='system'||messages.slice(1).some(m=>m.role==='system'))return fail('sentinel.provider.invalidProfile','Copilot wire requires exactly one leading Sentinel system message');
 return Object.freeze({encoding:'sentinel-copilot-chat/v1',system:messages[0].content,stdin:Buffer.from(canonicalJsonBytes({encoding:'sentinel-copilot-chat/v1',messages:messages.map(m=>({role:m.role,content:m.content})),requestedMaxOutputTokens:maxOutputTokens})).toString('utf8'),requestedModel:model});
}
const obj=(v:unknown):Record<string,any>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:undefined;
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
/** Pinned1.0.103 cli-main emits assistant.message and one result; final usage is its separately owned usage-output file. */
export class NativeCopilotDecoder {
 #pending=Buffer.alloc(0);#total=0;#frames=0;#result=false;#message:string|undefined;#session:string|undefined;#eventClass:NativeCopilotDiagnostic['eventClass']='none';
 constructor(readonly maxBytes:number,readonly requestedModel:string){}
 get bytes(){return this.#total}
 observation(){return Object.freeze({bytes:this.#total,frames:this.#frames,eventClass:this.#eventClass})}
 #bad(reason:NativeCopilotDiagnostic['reason'],code:ProviderErrorCode='sentinel.provider.malformedResponse'):never {throw new NativeCopilotError(code,'possible',{schema:'sentinel-copilot-failure/1',phase:reason.startsWith('usage-')?'usage':'stream',reason,exitCode:null,signal:null,eventClass:this.#eventClass,frames:this.#frames,stdoutBytes:this.#total,stderrBytes:0,connections:0,upstreamBytes:0,downstreamBytes:0,proxyEnded:'open'})}
 push(chunk:Uint8Array){this.#total+=chunk.byteLength;if(this.#total>this.maxBytes)this.#bad('response-bound','sentinel.provider.responseTooLarge');this.#pending=Buffer.concat([this.#pending,chunk]);let i;while((i=this.#pending.indexOf(10))!==-1){const line=this.#pending.subarray(0,i);this.#pending=this.#pending.subarray(i+1);this.#line(line)}}
 #line(bytes:Uint8Array){if(bytes.byteLength===0)return;if(++this.#frames>128||this.#result)this.#bad('invalid-event','sentinel.provider.malformedResponse');let e:Record<string,any>|undefined;try{e=obj(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)))}catch{this.#bad('invalid-json','sentinel.provider.malformedResponse')}this.#eventClass=e?.type==='session.start'?'session-start':e?.type==='assistant.message'?'visible':e?.type==='result'?'result':['user.message','assistant.turn_start','assistant.turn_end','assistant.reasoning','assistant.reasoning_delta','assistant.message_delta','session.info','session.warning'].includes(e?.type)?'lifecycle':'unknown';if(!e||typeof e.type!=='string')return this.#bad('invalid-event','sentinel.provider.malformedResponse');
  if(e.type==='result'){if(e.exitCode!==0||e.outcome!==undefined||typeof e.sessionId!=='string'||e.sessionId.length>96||!this.#message||!this.#session||this.#session!==e.sessionId)this.#bad('result','sentinel.provider.malformedResponse');this.#result=true;return}
  // Only harmless lifecycle/final-visible events. Tool/skill/subagent/extension/unknown events refuse before acceptance.
  if(!['session.start','user.message','assistant.turn_start','assistant.turn_end','assistant.message','assistant.reasoning','assistant.reasoning_delta','assistant.message_delta','session.info','session.warning'].includes(e.type))this.#bad('disallowed-event','sentinel.provider.malformedResponse');
  const data=obj(e.data);if(!data)return this.#bad('invalid-event','sentinel.provider.malformedResponse');
  if(e.type==='session.start'){if(this.#session||typeof data.sessionId!=='string'||data.sessionId.length>96||data.copilotVersion!=='1.0.103'||data.selectedModel!==undefined&&data.selectedModel!==this.requestedModel)this.#bad('session-identity','sentinel.provider.malformedResponse');this.#session=data.sessionId}
  if(e.type==='assistant.message'){if(this.#message!==undefined||typeof data.content!=='string'||(data.toolRequests!==undefined&&(!Array.isArray(data.toolRequests)||data.toolRequests.length))||data.chunkCount!==undefined&&data.chunkCount!==1)this.#bad('visible-message','sentinel.provider.malformedResponse');this.#message=data.content}
  // Reasoning/event contents are discarded immediately, never included in the accepted return value or artifacts.
 }
 finish(usageBytes:Uint8Array):ParsedReply{
  if(this.#pending.length){const last=this.#pending;this.#pending=Buffer.alloc(0);this.#line(last)}if(!this.#result||this.#message===undefined||this.#total+usageBytes.byteLength>this.maxBytes)this.#bad('usage-shape','sentinel.provider.malformedResponse');let metrics:Record<string,any>|undefined;try{metrics=obj(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(usageBytes)))}catch{this.#bad('usage-shape','sentinel.provider.malformedResponse')}
  const models=obj(metrics?.modelMetrics),names=models?Object.keys(models):[];if(names.length!==1||names[0]!==this.requestedModel||metrics?.currentModel!==undefined&&metrics.currentModel!==this.requestedModel||metrics?.totalUserRequests!==1)this.#bad('usage-model','sentinel.provider.identityMismatch');
  const model=obj(models![names[0]!]),requests=obj(model?.requests),u=obj(model?.usage);if(requests?.count!==1||!u||['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].some(k=>!count(u[k])))this.#bad('usage-count','sentinel.provider.malformedResponse');
  const usage=u!;/* Preserve the vendor total as reported; cache counters are not assumed disjoint. */const input=usage.inputTokens;if(!Number.isSafeInteger(input))this.#bad('usage-tokens','sentinel.provider.malformedResponse');return{content:this.#message!,returnedModel:names[0]!,usage:{inputTokens:input,outputTokens:usage.outputTokens},finish:'complete'};
 }
}

// Exact fixed pinned1.0.103 startup template. Compare streaming bytes; never collect or retain native stderr.
const noAuthTemplate=Buffer.from("Error: No authentication information found.\n\nCopilot can be authenticated with GitHub using an OAuth Token or a Fine-Grained Personal Access Token.\n\nTo authenticate, you can use any of the following methods:\n  • Start 'copilot' and run the '/login' command\n  • Set the COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN environment variable\n  • Run 'gh auth login' to authenticate with the GitHub CLI\n",'utf8');
export class NativeCopilotStderrClassifier {
 #at=0;#equal=true;
 push(bytes:Uint8Array):void{for(const byte of bytes){if(this.#at>=noAuthTemplate.length||byte!==noAuthTemplate[this.#at])this.#equal=false;this.#at=Math.min(4097,this.#at+1)}}
 get noAuthenticationInformation():boolean{return this.#equal&&this.#at===noAuthTemplate.length}
}
