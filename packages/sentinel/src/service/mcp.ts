// Loaded only by `mcp`. Real SDK stdio; a client of the existing owner socket, never a store owner or run launcher.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { STRINGS } from '@farsight/core/dist/strings.js';
import { sentinelServiceWord } from '@farsight/core/dist/strings-sentinel-service.js';
import { connectService } from './owner-service.js';
import type { Workspace } from './local.js';
import type { ServiceClient } from '../transport/ipc.js';
import { validateEnvelope } from '../validate.js';
import { OUTCOME_EXIT_CODES } from '../cli/outcome.js';
import { RUN_STATES } from '../contracts/index.js';
const id={type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'};
const integer=(minimum:number,maximum:number)=>({type:'integer',minimum,maximum});
const tools=[
  ['sentinel_service_info','service.capabilities',{},[],'servicecapabilities'],
  ['sentinel_run_describe','run.describe',{runId:id},['runId'],null],
  ['sentinel_run_status','run.status',{runId:id},['runId'],null],
  ['sentinel_run_wait','run.wait',{runId:id,timeoutMs:integer(0,25000)},['runId'],null],
  ['sentinel_run_inspect','run.inspect',{runId:id,planRevision:integer(1,2147483647)},['runId'],'runinspection'],
  ['sentinel_view_page','view.page',{viewId:id,collection:{enum:['works','attempts','inputs','outputs']},workKey:id,attemptKey:id,cursor:id,limit:integer(1,128)},['viewId','collection'],'inspectionpage'],
  ['sentinel_report_open','report.open',{runId:id,baselineRunId:id,format:{enum:['json','md','html','sarif']}},['runId','format'],'reportdelivery'],
  ['sentinel_delivery_read','delivery.read',{deliveryId:id,offset:integer(0,32*1024*1024),maxBytes:integer(1,65536)},['deliveryId','offset'],'deliverychunk'],
] as const;
const fail=(code:string)=>Object.assign(new Error(code),{code});
const knownCode=(v:unknown)=>v==='sentinel.service.unknownOperation'?'sentinel.service.operationUnavailable':typeof v==='string'&&Object.hasOwn(STRINGS,v)?v:'sentinel.service.operationUnavailable';
/** No raw legacy events/facts/digests/diagnostics cross this new MCP metadata boundary. */
function legacyProjection(op:string,value:any):unknown{
  if(op==='run.describe')return value&&['analysis','bootstrap'].includes(value.kind)&&Number.isSafeInteger(value.revision)?{kind:value.kind,revision:value.revision}:null;
  if(!value||!Object.hasOwn(OUTCOME_EXIT_CODES,value.outcome))throw fail('sentinel.service.operationUnavailable');
  const state=value.facts?.state;
  return {outcome:value.outcome,exitCode:OUTCOME_EXIT_CODES[value.outcome as keyof typeof OUTCOME_EXIT_CODES],
    ...(value.reasonCode?{reasonCode:knownCode(value.reasonCode)}:{}),
    state:typeof state==='string'&&[...RUN_STATES,'interrupted','awaiting-first-execution'].includes(state as any)?state:null};
}
export async function runMcp(ws:Workspace):Promise<number>{
  let client:ServiceClient|undefined;
  const connection=async()=>{
    if(!client||client.closed){client=await connectService(ws,'mcp');if(!client)throw fail('sentinel.service.operationUnavailable');}
    return client;
  };
  const capabilities=async()=>{
    try{const value=await(await connection()).request('service.capabilities',{});const checked=validateEnvelope('servicecapabilities',value);if(!checked.ok)throw fail('sentinel.service.operationUnavailable');return checked.value;}
    catch{throw fail('sentinel.service.operationUnavailable');}
  };
  let initial:Awaited<ReturnType<typeof capabilities>>;
  try{initial=await capabilities();}catch{client?.close();throw fail('sentinel.service.operationUnavailable');}
  const available=tools.filter(t=>initial.operations.includes(t[1]));
  const server=new Server({name:'farsight-sentinel',version:'0.0.0-draft.1'},{capabilities:{tools:{}},instructions:sentinelServiceWord('sentinel.service.mcpInstructions')});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:available.map(([name,op,properties,required])=>({name,
    description:sentinelServiceWord(`sentinel.service.tool.${name}`),inputSchema:{type:'object' as const,properties,required:[...required],additionalProperties:false},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:!['run.inspect','report.open'].includes(op),openWorldHint:false}}))}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    const tool=available.find(t=>t[0]===request.params.name);
    try{
      if(!tool)throw fail('sentinel.service.operationUnavailable');
      const args=request.params.arguments??{};
      // This tool deliberately returns status only; the legacy CLI retains its separate event pagination.
      if(tool[1]==='run.status'&&Object.keys(args).some(k=>k!=='runId'))throw fail('sentinel.service.requestInvalid');
      const value=await(await connection()).request(tool[1],args,{signal:extra.signal,timeoutMs:30000});
      let safe:unknown;
      if(tool[4]){const checked=validateEnvelope(tool[4],value);if(!checked.ok)throw fail('sentinel.service.operationUnavailable');safe=checked.value;}
      else safe=legacyProjection(tool[1],value);
      return {content:[{type:'text' as const,text:JSON.stringify(safe)}],...(safe&&typeof safe==='object'?{structuredContent:safe as Record<string,unknown>}: {})};
    }catch(error){const code=knownCode((error as any)?.code),retryable=['sentinel.service.viewChanged','sentinel.report.viewChanged','sentinel.service.deliveryBusy','sentinel.service.inspectBusy'].includes(code);
      const safe={error:{code,retryable}};return {isError:true,content:[{type:'text' as const,text:sentinelServiceWord(code)}],structuredContent:safe};}
  });
  const ended=new Promise<void>(resolve=>{server.onclose=()=>{client?.close();resolve();};});
  const onEnd=()=>{void server.close();};process.stdin.once('end',onEnd);
  try{await server.connect(new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:1024*1024}));await ended;return 0;}finally{process.stdin.removeListener('end',onEnd);client?.close();}
}
