// Actual SDK/CLI -> production socket -> genuine held owner/admission. No fabricated successful publications.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {createHash}from'node:crypto';import{join}from'node:path';import{readFileSync,writeFileSync,rmSync,readdirSync}from'node:fs';import{fileURLToPath}from'node:url';import{execFile}from'node:child_process';import{promisify}from'node:util';
import{Client}from'@modelcontextprotocol/sdk/client/index.js';import{StdioClientTransport}from'@modelcontextprotocol/sdk/client/stdio.js';
import{adoptWorkspaceSettings}from'../dist/service/local.js';
import{OwnerService,ServiceError,connectService}from'../dist/service/owner-service.js';import{listenOwnerSocket,runtimeAddress,newOwnerNonce}from'../dist/transport/ipc.js';
import{writePrivateFileAtomic}from'../dist/policy/user-state.js';import{validateEnvelope}from'../dist/validate.js';
import{configurationPreview,preparationCapabilities,preparationOutcome,checkPreparationArguments}from'../dist/service/preparation-projection.js';
import{loadPlan}from'../dist/execution/plans.js';
import{preparationFixture}from'./helpers/preparation-fixture.ts';import{needsStore}from'./snapshot-helpers.ts';
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url)),exec=promisify(execFile),key='public_preparation_request_0001',wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function fixture(t:any,agent:boolean|'confirm'=false){
 const f=await preparationFixture(t);if(agent){const path=join(f.ws.path,'.farsight/sentinel/settings.json'),settings=JSON.parse(readFileSync(path,'utf8'));settings.agentActions=agent==='confirm'?'confirm':'allow';settings.grants.push({actions:['capture.source'],principals:['agent'],scope:{profiles:['static']}});writeFileSync(path,JSON.stringify(settings));assert.equal(adoptWorkspaceSettings(f.ws,{confirm:true,now:new Date()}).outcome,'prepared');}
 let service=new OwnerService(f.store,f.ws,{registry:f.registry});const nonce=newOwnerNonce(),address=runtimeAddress({storePath:f.store.storePath,ownerNonce:nonce,sources:[f.ws.path]});
 let after:((op:string,value:any)=>Promise<unknown>)|undefined,legacy=false;const requests:string[]=[],clients:Client[]=[],resumeSignals:AbortSignal[]=[];
 const socket=await listenOwnerSocket(address,{storeId:f.store.storeId,ownerNonce:nonce},async(op,body,by,ctx)=>{
  if(legacy&&op==='service.preparation-capabilities')throw new ServiceError('sentinel.service.unknownOperation');requests.push(op);if(op==='prepare.resume'&&ctx?.signal)resumeSignals.push(ctx.signal);const v=await service.handle(op,body,by,ctx);const changed=await after?.(op,v);return changed===undefined?v:changed;
 });
 writePrivateFileAtomic(join(f.ws.trustDir,'services'),createHash('sha256').update(f.ws.storePath).digest('hex').slice(0,32)+'.json',Buffer.from(JSON.stringify({schema:'sentinel-service/draft-1',storePath:f.ws.storePath,storeId:f.store.storeId,ownerNonce:nonce,address,pid:process.pid,startedAt:new Date().toISOString()})),'sentinel.receipt.storeUnsafe');
 t.after(async()=>{for(const c of clients)await c.close().catch(()=>{});await service.stop();await socket.close();});
 const env={...process.env,XDG_STATE_HOME:join(f.dir,'owner')};
 const owner=async(...args:string[])=>{try{return JSON.parse((await exec(process.execPath,[cli,...args,'--workspace',f.ws.path,'--json'],{env,timeout:30000})).stdout);}catch(e:any){if(e.stdout)return JSON.parse(e.stdout);throw e;}};
 const connect=async()=>{const c=new Client({name:'preparation-public-test',version:'1'},{capabilities:{}});clients.push(c);await c.connect(new StdioClientTransport({command:process.execPath,args:[cli,'mcp','--workspace',f.ws.path],cwd:f.ws.path,env,stderr:'pipe'}));return c;};
 const call=async(c:Client,name:string,args:Record<string,unknown>)=>(await c.callTool({name,arguments:args})).structuredContent as any;
 const final=async(requestKey?:string)=>{for(let i=0;i<600;i++){const v=await owner('prepare','status',...(requestKey?['--request-key',requestKey]:[]));if(['prepared','failed','interrupted','canceled'].includes(v.facts.phase))return v;await wait(20);}assert.fail('preparation did not settle');};
 return{...f,get service(){return service;},setService:(value:OwnerService)=>{service=value;},resumeSignals,requests,owner,connect,call,final,setAfter:(v:typeof after)=>after=v,setLegacy:(v:boolean)=>legacy=v};
}

test('public preparation schemas preserve original timing and reject altered authority/overbounds',()=>{
 const load=(kind:string)=>JSON.parse(readFileSync(new URL(`./contracts/valid/${kind}.json`,import.meta.url),'utf8'));
 const preview=load('configurationpreview'),status=load('preparationstatus'),outcome=load('preparationoutcome');
 for(const [kind,value]of[['configurationpreview',preview],['preparationstatus',status],['preparationoutcome',outcome]]as const)assert.equal(validateEnvelope(kind,value).ok,true);
 for(const timestamp of ['2026-13-23T12:00:00Z','2026-02-30T12:00:00Z','2026-10-23T25:00:00Z']){assert.doesNotThrow(()=>validateEnvelope('configurationpreview',{...preview,expiresAt:timestamp}));assert.equal(validateEnvelope('configurationpreview',{...preview,expiresAt:timestamp}).ok,false);}
 assert.equal(validateEnvelope('configurationpreview',{...preview,expiresAt:'2026-10-23T12:00:30.001Z'}).ok,false);
 assert.equal(validateEnvelope('preparationstatus',{...status,runDeadlineAt:'2026-10-23T12:10:00.001Z'}).ok,false);
 assert.equal(validateEnvelope('preparationstatus',{...status,preparedRevision:null}).ok,false);
 assert.equal(validateEnvelope('configurationpreview',{...preview,expiresAt:'2026-10-23T12:00:30.000000001Z'}).ok,false);
 assert.equal(validateEnvelope('preparationoutcome',{...outcome,status:{...status,deadlineAt:'2026-10-23T12:10:00.000000001Z',runDeadlineAt:'2026-10-23T12:10:00.000000001Z'}}).ok,false);
 assert.equal(validateEnvelope('preparationoutcome',{...outcome,outcome:'submitted',status:null}).ok,false);
 assert.throws(()=>configurationPreview({...preview,actor:'human'}));assert.throws(()=>configurationPreview({...preview,counts:{...preview.counts,selectedRules:{...preview.counts.selectedRules,source:'private-source-path'}}}));
 for(const op of ['configuration.preview','prepare.accept','prepare.status','prepare.resume','prepare.cancel'])for(const extra of [{actor:'human'},{confirm:true},{receiptId:'receipt-forged'},{path:'/private'},{clock:0}])assert.throws(()=>checkPreparationArguments(op,{requestKey:key,...(op==='prepare.accept'?{previewId:preview.id}:{}),...extra}));
});

test('actual SDK preparation negotiation and permission denial are pure; legacy omission keeps existing eleven tools', {...needsStore,timeout:60000},async t=>{
 const f=await fixture(t),c=await f.connect(),tools=(await c.listTools()).tools;assert.equal(tools.length,16);
 for(const name of ['accept','resume','cancel']){const tool=tools.find(x=>x.name==='sentinel_prepare_'+name)!;assert.equal(tool.annotations?.readOnlyHint,false);assert.equal(tool.annotations?.idempotentHint,false);}
 const seq=f.store.ledger.currentSequence(),preview=await f.call(c,'sentinel_configuration_preview',{requestKey:key});assert.equal('confirmation'in preview,false);assert.equal(preview.sourceCaptured,false);assert.ok(validateEnvelope('configurationpreview',preview).ok);
 const denied=await f.call(c,'sentinel_prepare_accept',{requestKey:key,previewId:preview.id});assert.equal(denied.outcome,'configuration-failure');assert.equal(denied.reasonCode,'sentinel.admission.noGrant');assert.ok(validateEnvelope('preparationoutcome',denied).ok);
 for(const extra of [{actor:'human'},{confirm:true},{receiptId:'receipt-forged'}])assert.equal((await f.call(c,'sentinel_prepare_accept',{requestKey:key,previewId:preview.id,...extra})).error.code,'sentinel.service.requestInvalid');
 assert.equal(f.store.ledger.currentSequence(),seq);assert.equal(readdirSync(f.store.storePath).includes('preparation'),false);
 await c.close();f.setLegacy(true);const old=await f.connect();assert.equal((await old.listTools()).tools.length,11);assert.equal((await f.call(old,'sentinel_prepare_status',{requestKey:key})).error.code,'sentinel.service.operationUnavailable');
});

test('actual owner CLI confirmation prepares through existing owner; SDK reconnect inspects source-gone input before separate start',{...needsStore,timeout:90000},async t=>{
 const f=await fixture(t);const before=f.store.ledger.currentSequence(),preview=await f.owner('prepare','preview','--request-key',key);assert.equal(preview.outcome,'answered');assert.equal(preview.facts.preview.sourceCaptured,false);assert.equal('confirmation'in preview.facts.preview,false);
 const awaiting=await f.owner('prepare','--request-key',key);assert.equal(awaiting.outcome,'awaiting-confirmation');assert.equal(f.store.ledger.currentSequence(),before);
 const accepted=await f.owner('prepare','--confirm','--request-key',key);assert.equal(accepted.outcome,'submitted',JSON.stringify(accepted));assert.equal(accepted.facts.requestKeySaved,true);assert.equal('confirmation'in accepted.facts,false);
 const ended=await f.final();assert.equal(ended.facts.phase,'prepared',JSON.stringify(ended));assert.equal(ended.facts.preparedRevision,2);assert.equal(ended.facts.checksStartedByPreparation,false);
 const runId=ended.facts.runId;rmSync(join(f.ws.path,'src'),{recursive:true});let c=await f.connect();
 const status=await f.call(c,'sentinel_prepare_status',{requestKey:key});assert.equal(status.status.preparationId,accepted.facts.preparationId);assert.equal('confirmation'in status.status,false);assert.equal(status.status.runDeadlineAt,accepted.facts.runDeadlineAt);
 const view=await f.call(c,'sentinel_run_inspect',{runId});assert.ok(view.viewId);assert.ok(view.counts.inputs.n>0);const planned=(await loadPlan(f.store,runId,2)).plan;assert.ok(planned.units.some(u=>u.stage==='check'));assert.equal(planned.units.filter(u=>u.stage==='check').reduce((n,u)=>n+f.store.ledger.listAttempts({id:u.id,revision:u.revision}).length,0),0,'bootstrap completed but no check was started');
 await c.close();c=await f.connect();assert.equal((await f.call(c,'sentinel_prepare_status',{requestKey:key})).status.runId,runId);
 const started=await f.owner('run',runId,'--detach','--confirm');assert.equal(started.outcome,'submitted');
 for(let i=0;i<400&&f.store.ledger.getRun(runId)!.state!=='completed';i++)await wait(25);assert.equal(f.store.ledger.getRun(runId)!.state,'completed');
 assert.equal(f.requests.filter(op=>op==='prepare.accept').length,1);assert.equal(f.requests.filter(op=>op==='run.start').length,1);
});

test('lost owner acceptance ACK retains saved key and no automatic replay; malformed post-dispatch response is outcome-unknown',{...needsStore,timeout:90000},async t=>{
 const f=await fixture(t);f.setAfter(async(op,v)=>op==='prepare.accept'?{...v,outcome:'private-bad-outcome',facts:{privateDiagnostic:'PRIVATE-RESPONSE'}}:undefined);
 const accepted=await f.owner('prepare','--confirm');assert.equal(accepted.reasonCode,'sentinel.preparation.outcomeUnknown');assert.doesNotMatch(JSON.stringify(accepted),/PRIVATE-RESPONSE/);
 f.setAfter(undefined);const ended=await f.final();assert.equal(ended.facts.phase,'prepared',JSON.stringify(ended));assert.equal(f.requests.filter(op=>op==='prepare.accept').length,1);
 assert.equal(ended.facts.checksStartedByPreparation,false);const plan=(await loadPlan(f.store,ended.facts.runId,2)).plan;assert.equal(plan.units.filter(u=>u.stage==='check').reduce((n,u)=>n+f.store.ledger.listAttempts({id:u.id,revision:u.revision}).length,0),0);
});


test('genuine adopted agent grant survives SDK accepted-response loss with no receipt spend or automatic replay',{...needsStore,timeout:60000},async t=>{
 const f=await fixture(t,true),c=await f.connect(),preview=await f.call(c,'sentinel_configuration_preview',{requestKey:key});
 let accepted!:()=>void,release!:()=>void;const observed=new Promise<void>(r=>accepted=r),held=new Promise<void>(r=>release=r);
 const receipts=join(f.ws.trustDir,'receipts'),before=readdirSync(receipts,{recursive:true}).sort();
 f.setAfter(async(op,v)=>{if(op==='prepare.accept'){assert.equal(v.outcome,'submitted');accepted();await held;}});
 const pending=c.callTool({name:'sentinel_prepare_accept',arguments:{requestKey:key,previewId:preview.id}});void pending.catch(()=>{});const early=await Promise.race([observed.then(()=>null),pending]);assert.equal(early,null,JSON.stringify(early));await c.close();release();await assert.rejects(pending);f.setAfter(undefined);
 const next=await f.connect(),final=await f.final(key);assert.equal(final.facts.phase,'prepared',JSON.stringify(final));const status=await f.call(next,'sentinel_prepare_status',{requestKey:key});assert.equal(status.status.runId,final.facts.runId);assert.equal(f.requests.filter(op=>op==='prepare.accept').length,1);
 assert.deepEqual(readdirSync(receipts,{recursive:true}).sort(),before,'ordinary agent grant spends no owner receipt');
});


test('server-observed disconnect during genuine pinned resume proof aborts before receipt spend or journal acceptance',{...needsStore,timeout:60000},async t=>{
 const f=await fixture(t),{ObjectStore}=await import('../dist/store/objects.js'),{ReceiptBook}=await import('../dist/policy/receipts.js'),{issueReceipt}=await import('../dist/policy/owner-receipts.js'),{OWNER}=await import('../dist/service/local.js');
 const original=ObjectStore.prototype.read;
 function holdManifest(){let saw!:()=>void,release!:()=>void,seen=false;const observed=new Promise<void>(r=>saw=r),held=new Promise<void>(r=>release=r);const mock=t.mock.method(ObjectStore.prototype,'read',async function(this:any,...args:any[]){const bytes=await(original as any).apply(this,args);if(!seen&&bytes.toString('utf8').includes('sentinel-snapshot/draft-1')){seen=true;saw();await held;}return bytes;});return{observed,release,restore:()=>mock.mock.restore()};}
 const capture=holdManifest();try{const accepted=await f.owner('prepare','--confirm','--request-key',key);assert.equal(accepted.outcome,'submitted');await capture.observed;const stopping=f.service.stop();capture.release();await stopping;}finally{capture.release();capture.restore();}
 f.setService(new OwnerService(f.store,f.ws,{registry:f.registry}));const cliActor={principal:'agent' as const,channel:'local-service' as const},status:any=await f.service.handle('prepare.status',{requestKey:key},cliActor);assert.equal(status.facts.resumeAvailable,true);
 const binding=status.facts.confirmation.resume,book=new ReceiptBook(join(f.ws.trustDir,'receipts')),receipt=issueReceipt(book,OWNER,binding,{now:new Date(),ttlMs:600000});
 const records=join(f.store.storePath,'preparation','records'),before=readdirSync(records).sort().map(name=>[name,readFileSync(join(records,name)).toString('hex')]);const seq=f.store.ledger.currentSequence();
 const proof=holdManifest(),client=await connectService(f.ws,'cli');assert.ok(client);const pending=client.request('prepare.resume',{requestKey:key,receiptId:receipt.id});void pending.catch(()=>{});
 try{await proof.observed;const signal=f.resumeSignals.at(-1);assert.ok(signal);assert.equal(signal.aborted,false);const aborted=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server did not observe socket abort')),2000);signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});client.close();await aborted;assert.equal(signal.aborted,true);proof.release();await assert.rejects(pending);await wait(30);
 assert.equal(book.check(receipt.id,binding,new Date()),undefined,'read-only proof cancellation spent no receipt');assert.deepEqual(readdirSync(records).sort().map(name=>[name,readFileSync(join(records,name)).toString('hex')]),before);assert.equal(f.store.ledger.currentSequence(),seq);
 const other=await connectService(f.ws,'mcp');assert.ok(other);try{const retained:any=await other.request('prepare.status',{requestKey:key});assert.equal(retained.facts.phase,'interrupted');assert.equal(retained.facts.resumeAvailable,true);}finally{other.close();}
 }finally{proof.release();proof.restore();client.close();}
});


test('MCP awaiting-confirmation is answered by actual owner CLI for the same saved request key, without MCP human authority',{...needsStore,timeout:60000},async t=>{
 const f=await fixture(t,'confirm'),c=await f.connect(),preview=await f.call(c,'sentinel_configuration_preview',{requestKey:key});
 const awaiting=await f.call(c,'sentinel_prepare_accept',{requestKey:key,previewId:preview.id});assert.equal(awaiting.outcome,'awaiting-confirmation');assert.equal(readdirSync(f.store.storePath).includes('preparation'),false);
 const owner=await f.owner('prepare','--request-key',key,'--confirm');assert.equal(owner.outcome,'submitted');const ended=await f.final(key);assert.equal(ended.facts.phase,'prepared',JSON.stringify(ended));
 const found=await f.call(c,'sentinel_prepare_status',{requestKey:key});assert.equal(found.status.preparationId,owner.facts.preparationId);assert.equal(found.status.runId,ended.facts.runId);assert.equal('confirmation'in found.status,false);
});

test('lost accepted ACK cannot let a second owner CLI overwrite the saved resumable request key',{...needsStore,timeout:60000},async t=>{
 const f=await fixture(t),{ObjectStore}=await import('../dist/store/objects.js'),read=ObjectStore.prototype.read;let saw!:()=>void,release!:()=>void,gated=false;
 const observed=new Promise<void>(r=>saw=r),held=new Promise<void>(r=>release=r);const mock=t.mock.method(ObjectStore.prototype,'read',async function(this:any,...args:any[]){const bytes=await(read as any).apply(this,args);if(!gated&&bytes.toString('utf8').includes('sentinel-snapshot/draft-1')){gated=true;saw();await held;}return bytes;});
 try{f.setAfter(async(op,v)=>op==='prepare.accept'?{...v,outcome:'lost-ack'}:undefined);const first=await f.owner('prepare','--confirm','--request-key',key);assert.equal(first.reasonCode,'sentinel.preparation.outcomeUnknown');await observed;f.setAfter(undefined);
 const path=join(f.ws.trustDir,readdirSync(f.ws.trustDir).find(n=>/^preparation-client-.*\.json$/.test(n))!),before=readFileSync(path);
 const second=await f.owner('prepare','--confirm','--request-key','public_second_request_0002');assert.notEqual(second.outcome,'submitted');assert.ok(readFileSync(path).equals(before),'saved original key must survive busy/unknown second acceptance');assert.equal(f.requests.filter(x=>x==='prepare.accept').length,1);
 }finally{release();mock.mock.restore();}
});

test('two actual owner CLIs contend immediately; killing the mutex holder releases it without losing its key',{...needsStore,timeout:60000},async t=>{
 const f=await fixture(t);let saw!:()=>void,release!:()=>void;const observed=new Promise<void>(r=>saw=r),held=new Promise<void>(r=>release=r);
 f.setAfter(async(op,v)=>{if(op==='prepare.accept'){assert.equal(v.outcome,'submitted');saw();await held;}});
 const child=execFile(process.execPath,[cli,'prepare','--confirm','--request-key',key,'--workspace',f.ws.path,'--json'],{env:{...process.env,XDG_STATE_HOME:join(f.dir,'owner')},timeout:30000});
 const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));child.on('error',()=>{});
 try{await observed;const path=join(f.ws.trustDir,readdirSync(f.ws.trustDir).find(n=>/^preparation-client-.*\.json$/.test(n))!),before=readFileSync(path);
 const start=performance.now(),second=await f.owner('prepare','--confirm','--request-key','public_concurrent_request_0002');assert.equal(second.reasonCode,'sentinel.preparation.busy');assert.ok(performance.now()-start<5000);assert.equal(f.requests.filter(x=>x==='prepare.accept').length,1);assert.ok(readFileSync(path).equals(before));
 child.kill('SIGKILL');await exited;release();f.setAfter(undefined);await f.final();const retained=await f.owner('prepare','--confirm','--request-key','public_concurrent_request_0003');assert.equal(retained.outcome,'submitted');assert.equal(retained.facts.found,true);assert.equal(readFileSync(path).equals(before),false,'terminal prepared lookup can be replaced by explicit fresh capture');assert.equal((await f.final()).facts.phase,'prepared');
 }finally{release();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
});

test('ambiguous saved-key status cannot be replaced and reconnect to an older service removes preparation tools',{...needsStore,timeout:60000},async t=>{
 const f=await fixture(t);assert.equal((await f.owner('prepare','--confirm','--request-key',key)).outcome,'submitted');await f.final();const path=join(f.ws.trustDir,readdirSync(f.ws.trustDir).find(n=>/^preparation-client-.*\.json$/.test(n))!),before=readFileSync(path),client=await f.connect();
 f.setAfter(async(op)=>op==='prepare.status'?{command:'prepare',outcome:'answered',exitCode:0,verdicts:null,facts:{schema:'sentinel-preparation-status/draft-1',found:false}}:undefined);
 const refused=await f.owner('prepare','--confirm','--request-key','public_unknown_request_0002');assert.notEqual(refused.outcome,'submitted');assert.ok(readFileSync(path).equals(before));f.setAfter(undefined);f.setLegacy(true);
 assert.equal((await f.call(client,'sentinel_prepare_status',{requestKey:key})).error.code,'sentinel.service.operationUnavailable');assert.equal(f.requests.filter(x=>x==='prepare.accept').length,1);
});

test('terminal prepared lookup permits real edited-source fresh capture and unchanged inventory returns the existing run',{...needsStore,timeout:90000},async t=>{
 const f=await fixture(t);assert.equal((await f.owner('prepare','--confirm','--request-key',key)).outcome,'submitted');const first=await f.final(),original=f.store.ledger.getRun(first.facts.runId)!;
 writeFileSync(join(f.ws.path,'src/one.ts'),'export const changedSource = 2;\n');const nextKey='edited_source_preparation_0002';assert.equal((await f.owner('prepare','--confirm','--request-key',nextKey)).outcome,'submitted');const second=await f.final();assert.equal(second.facts.phase,'prepared');assert.notEqual(second.facts.runId,first.facts.runId);const retained=f.store.ledger.getRun(second.facts.runId)!;
 const sameKey='same_inventory_preparation_0003';assert.equal((await f.owner('prepare','--confirm','--request-key',sameKey)).outcome,'submitted');const third=await f.final();assert.equal(third.facts.phase,'prepared',JSON.stringify(third));assert.equal(third.facts.runId,second.facts.runId);assert.equal(third.facts.reasonCode,'sentinel.preparation.alreadyPrepared');assert.equal(f.store.ledger.getRun(second.facts.runId)!.envelope.snapshotId,retained.envelope.snapshotId);assert.equal(f.store.ledger.getRun(second.facts.runId)!.envelope.createdAt,retained.envelope.createdAt);assert.equal(f.store.ledger.getRun(first.facts.runId)!.envelope.snapshotId,original.envelope.snapshotId);
});

// Advance only the test process clock; real receipts, capture, plan admission and publication run unchanged.
function historicalClock(t:any){const NativeDate=Date,offset=-601000;class HistoricalDate extends NativeDate{constructor(...args:any[]){if(args.length===0)super(NativeDate.now()+offset);else super(...args as [any]);}static now(){return NativeDate.now()+offset;}}globalThis.Date=HistoricalDate as any;const restore=()=>{globalThis.Date=NativeDate;};t.after(restore);return restore;}
async function directConfirmed(f:any,requestKey:string){const{ReceiptBook}=await import('../dist/policy/receipts.js'),{issueReceipt}=await import('../dist/policy/owner-receipts.js'),{OWNER}=await import('../dist/service/local.js');const by={principal:'agent' as const,channel:'local-service' as const},preview:any=await f.service.handle('configuration.preview',{requestKey},by),receipt=issueReceipt(new ReceiptBook(join(f.ws.trustDir,'receipts')),OWNER,preview.confirmation,{now:new Date(),ttlMs:600000});return await f.service.handle('prepare.accept',{requestKey,previewId:preview.id,receiptId:receipt.id},by)as any;}
async function settleDirect(f:any){for(let i=0;i<600&&f.service.busy;i++)await wait(10);assert.equal(f.service.busy,false);}
test('fresh unchanged inventory after an existing analysis deadline returns existing prepared run without renewing it',{...needsStore,timeout:90000},async t=>{
 const f=await fixture(t),restore=historicalClock(t);let first:any;try{assert.equal((await directConfirmed(f,key)).outcome,'submitted');await settleDirect(f);first=(await f.service.handle('prepare.status',{requestKey:key},{principal:'agent',channel:'mcp'})as any).facts;assert.equal(first.phase,'prepared');}finally{restore();}
 const old=f.store.ledger.getRun(first.runId)!,events=f.store.ledger.currentSequence();assert.ok(Date.parse(first.runDeadlineAt)<Date.now());const next='expired_same_inventory_0002';assert.equal((await f.owner('prepare','--confirm','--request-key',next)).outcome,'submitted');const ended=await f.final();assert.equal(ended.facts.phase,'prepared',JSON.stringify(ended));assert.equal(ended.facts.reasonCode,'sentinel.preparation.alreadyPrepared');assert.equal(ended.facts.runId,first.runId);assert.equal(ended.facts.runDeadlineAt,first.runDeadlineAt);assert.deepEqual(f.store.ledger.getRun(first.runId),old);
 assert.equal(f.store.ledger.readEvents({after:events,limit:500}).events.some(e=>['plan-admitted','run-plan-advanced','attempt-started'].includes(e.kind)),false);
});
test('expired captured interrupted saved lookup permits an independent fresh request while retaining the old record',{...needsStore,timeout:90000},async t=>{
 const f=await fixture(t),restore=historicalClock(t),{ObjectStore}=await import('../dist/store/objects.js'),read=ObjectStore.prototype.read;let saw!:()=>void,release!:()=>void,seen=false;const observed=new Promise<void>(r=>saw=r),held=new Promise<void>(r=>release=r);
 const mock=t.mock.method(ObjectStore.prototype,'read',async function(this:any,...args:any[]){const bytes=await(read as any).apply(this,args);if(!seen&&bytes.toString('utf8').includes('sentinel-snapshot/draft-1')){seen=true;saw();await held;}return bytes;});
 try{assert.equal((await directConfirmed(f,key)).outcome,'submitted');await observed;const stopping=f.service.stop();release();await stopping;}finally{release();mock.mock.restore();restore();}
 f.setService(new OwnerService(f.store,f.ws,{registry:f.registry}));assert.equal((await f.owner('prepare','--confirm','--request-key',key)).outcome,'kept');const before=await f.owner('prepare','status');assert.equal(before.facts.captured,true);assert.equal(before.facts.phase,'interrupted');assert.equal(before.facts.resumeAvailable,false);writeFileSync(join(f.ws.path,'src/one.ts'),'export const independentFresh = 3;\n');
 const next='dead_captured_fresh_request_0002',accepted=await f.owner('prepare','--confirm','--request-key',next);assert.equal(accepted.outcome,'submitted',JSON.stringify(accepted));assert.equal((await f.final()).facts.phase,'prepared');const old=await f.owner('prepare','status','--request-key',key);assert.deepEqual(old.facts,before.facts);
});

test('explicit pinned resume to an already recorded expired analysis discloses it without renewing or starting it',{...needsStore,timeout:90000},async t=>{
 const f=await fixture(t),restore=historicalClock(t);let first:any;try{await directConfirmed(f,key);await settleDirect(f);first=(await f.service.handle('prepare.status',{requestKey:key},{principal:'agent',channel:'mcp'})as any).facts;assert.equal(first.phase,'prepared');}finally{restore();}
 const old=f.store.ledger.getRun(first.runId)!,{ObjectStore}=await import('../dist/store/objects.js'),read=ObjectStore.prototype.read;let saw!:()=>void,release!:()=>void,seen=false;const observed=new Promise<void>(r=>saw=r),held=new Promise<void>(r=>release=r);
 const mock=t.mock.method(ObjectStore.prototype,'read',async function(this:any,...args:any[]){const bytes=await(read as any).apply(this,args);if(!seen&&bytes.toString('utf8').includes('sentinel-snapshot/draft-1')){seen=true;saw();await held;}return bytes;});
 const next='resume_expired_analysis_0002';try{assert.equal((await f.owner('prepare','--confirm','--request-key',next)).outcome,'submitted');await observed;const stopping=f.service.stop();release();await stopping;}finally{release();mock.mock.restore();}
 f.setService(new OwnerService(f.store,f.ws,{registry:f.registry}));const interrupted=await f.owner('prepare','status');assert.equal(interrupted.facts.resumeAvailable,true);rmSync(join(f.ws.path,'src'),{recursive:true});const seq=f.store.ledger.currentSequence();assert.equal((await f.owner('prepare','resume','--confirm')).outcome,'submitted');const ended=await f.final();assert.equal(ended.facts.phase,'prepared',JSON.stringify(ended));assert.equal(ended.facts.reasonCode,'sentinel.preparation.alreadyPrepared');assert.equal(ended.facts.runId,first.runId);assert.equal(ended.facts.runDeadlineAt,first.runDeadlineAt);assert.deepEqual(f.store.ledger.getRun(first.runId),old);assert.equal(f.store.ledger.currentSequence(),seq,'readonly disclosure adds no plan, run, snapshot or attempt events');
});
