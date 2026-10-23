// Real SDK stdio -> real owner socket/admission -> genuine captured/bootstrap plan and shipped preview driver.
// The response gate below delays only transport delivery after actual admission; it fabricates no capability/output.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openStore} from '../dist/store/index.js';
import {initWorkspace} from '../dist/cli/init.js';
import {workspaceOf,adoptedPolicy,adoptWorkspaceSettings,promoteRulePack} from '../dist/service/local.js';
import {planWorkspaceCanonical} from '../dist/service/canonical.js';
import {loadPlan} from '../dist/execution/plans.js';
import {OwnerService,ServiceError} from '../dist/service/owner-service.js';
import {controlOutcome} from '../dist/service/controls.js';
import {listenOwnerSocket,runtimeAddress,newOwnerNonce} from '../dist/transport/ipc.js';
import {writePrivateFileAtomic} from '../dist/policy/user-state.js';
import {builtinPackDir} from '../dist/service/package-paths.js';
import {SETTINGS_PATH} from '../dist/policy/index.js';
import {validateEnvelope,schemaOf} from '../dist/validate.js';
import {OUTCOME_EXIT_CODES,result} from '../dist/cli/outcome.js';
import {scratchUnder,removeScratch} from './lease-helpers.ts';
import {scratch,removeScratch as removeRoot} from './execution-helpers.ts';
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url)),exec=promisify(execFile),wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const actions=['run.start','run.pause','run.cancel'];
async function fixture(t:any,mode:'deny'|'confirm'|'allow'='deny'){
 const s=scratch('mcp-controls'),path=join(s.root,'workspace');mkdirSync(join(path,'src'),{recursive:true});
 for(let i=0;i<8;i++)writeFileSync(join(path,'src',`private-source-${i}.ts`),'export const lookup = (id) => db.query("SELECT * FROM invoice WHERE id = " + id);\n');
 const env={...process.env,XDG_STATE_HOME:join(s.root,'state')},ws=workspaceOf(path,env);initWorkspace({workspace:path});
 const settings=join(path,SETTINGS_PATH),config=JSON.parse(readFileSync(settings,'utf8'));
 if(mode!=='deny'){config.agentActions=mode==='allow'?'allow':'confirm';config.grants.push({actions,principals:['agent'],scope:{profiles:['static']}});writeFileSync(settings,JSON.stringify(config));}
 assert.equal(adoptWorkspaceSettings(ws,{confirm:true,now:new Date()}).outcome,'prepared');
 assert.equal(promoteRulePack(ws,{packDir:realpathSync.native(builtinPackDir('foundation-preview')!),confirm:true,now:new Date()}).outcome,'prepared');
 const adopted=adoptedPolicy(ws);assert.ok('policy'in adopted);const store=await openStore(ws.storePath),work=scratchUnder(store);
 const planned=await planWorkspaceCanonical(store,{workspace:path,trustDir:ws.trustDir,policy:adopted.policy,scratchRoot:work,now:new Date()}),runId=planned.disclosure.runId;
 const {plan}=await loadPlan(store,runId,planned.disclosure.revision);
 const attemptCount=()=>plan.units.reduce((n,u)=>n+store.ledger.listAttempts({id:u.id,revision:u.revision}).length,0);
 const service=new OwnerService(store,ws),ownerNonce=newOwnerNonce(),address=runtimeAddress({storePath:store.storePath,ownerNonce,sources:[path]});
 const requests:string[]=[],clients:Client[]=[];let legacy=false,foreign=false,afterControl:((op:string,value:any)=>Promise<unknown>)|undefined;
 const socket=await listenOwnerSocket(address,{storeId:store.storeId,ownerNonce},async(op,body,by,ctx)=>{
  if(legacy&&['service.control-capabilities','service.preparation-capabilities'].includes(op))throw new ServiceError('sentinel.service.unknownOperation');
  requests.push(op);const value=await service.handle(op,body,by,ctx);if(foreign&&op==='service.control-capabilities')return {...value as any,storeId:'store-foreign'};if(actions.includes(op)){const changed=await afterControl?.(op,value);if(changed!==undefined)return changed;}return value;
 });
 // Same production private descriptor layout, naming this actually held store and genuine listening socket.
 writePrivateFileAtomic(join(ws.trustDir,'services'),createHash('sha256').update(ws.storePath).digest('hex').slice(0,32)+'.json',Buffer.from(JSON.stringify({schema:'sentinel-service/draft-1',storePath:ws.storePath,storeId:store.storeId,ownerNonce,address,pid:process.pid,startedAt:new Date().toISOString()})),'sentinel.receipt.storeUnsafe');
 t.after(async()=>{for(const c of clients)await c.close().catch(()=>{});await service.stop();await socket.close();if(store.held)removeScratch(work);store.close();removeRoot(s.root);});
 const connect=async()=>{const c=new Client({name:'genuine-control-test',version:'1'},{capabilities:{}});clients.push(c);await c.connect(new StdioClientTransport({command:process.execPath,args:[cli,'mcp','--workspace',path],cwd:path,env,stderr:'pipe'}));return c;};
 const call=async(c:Client,name:string,args:Record<string,unknown>)=>{const v=await c.callTool({name,arguments:args});return v.structuredContent as any;};
 const state=async(c:Client,expected:string)=>{for(let i=0;i<200;i++){const v=await call(c,'sentinel_run_wait',{runId,timeoutMs:50});if(v.state===expected)return v;await wait(10);}assert.fail('run did not reach '+expected);};
 const owner=async(...args:string[])=>{try{const v=await exec(process.execPath,[cli,...args,'--workspace',path,'--json'],{env,timeout:30000});return JSON.parse(v.stdout);}catch(e:any){if(e.stdout)return JSON.parse(e.stdout);throw e;}};
 return {store,runId,service,requests,connect,call,state,owner,attemptCount,setLegacy:(v:boolean)=>legacy=v,setForeign:(v:boolean)=>foreign=v,setGate:(v:typeof afterControl)=>afterControl=v};
}

test('control schema vocabulary pins supported outcomes and rejects altered exit codes/facts',()=>{
 const supported=[
  'satisfied','finding-policy-failed','required-coverage-incomplete','configuration-failure','awaiting-confirmation',
  'submitted','requested','unavailable','prepared','kept','answered','refused',
 ] as const;
 const defs=(schemaOf('controloutcome') as any).definitions;
 assert.deepEqual([...defs.ControlCommandOutcome.enum].sort(),[...supported].sort());
 for(const outcome of supported){
  const projected=controlOutcome(result('run',outcome,{facts:{state:'completed',joined:true,path:'private-source',digest:'private-digest',receipt:'private-receipt'}}));
  assert.equal(projected.exitCode,OUTCOME_EXIT_CODES[outcome]);assert.ok(validateEnvelope('controloutcome',projected).ok);
  assert.doesNotMatch(JSON.stringify(projected),/private-/);assert.equal(validateEnvelope('controloutcome',{...projected,exitCode:(projected.exitCode+1)%5}).ok,false);
  assert.equal(validateEnvelope('controloutcome',{...projected,facts:{}}).ok,false);
 }
 // Import command additions do not expand the closed run-control contract.
 const control=controlOutcome(result('run','submitted',{facts:{state:'completed',joined:true}}));
 assert.ok(validateEnvelope('controloutcome',control).ok,'the negative controls start from a valid control result');
 for(const outcome of ['accepted','abandoned','read','delivery-failed'] as const){
  assert.equal(validateEnvelope('controloutcome',{...control,outcome,exitCode:OUTCOME_EXIT_CODES[outcome]}).ok,false);
 }
});

test('SDK negotiates additive controls while original read capabilities and denied default permissions remain intact',{timeout:60000},async t=>{
 const f=await fixture(t),c=await f.connect(),listed=(await c.listTools()).tools;
 assert.equal(listed.length,16);for(const name of ['start','pause','cancel']){const tool=listed.find(x=>x.name==='sentinel_run_'+name)!;assert.equal(tool.annotations?.readOnlyHint,false);assert.equal(tool.annotations?.idempotentHint,false);}
 assert.equal((await f.call(c,'sentinel_service_info',{})).controlsSupported,false);
 const cap:any=await f.service.handle('service.control-capabilities',{}, {principal:'agent',channel:'mcp'});assert.ok(validateEnvelope('controlcapabilities',cap).ok);
 const before=f.store.ledger.currentSequence();
 for(const op of ['start','pause','cancel']){const v=await f.call(c,'sentinel_run_'+op,{[op==='start'?'planId':'runId']:f.runId});assert.equal(v.outcome,'configuration-failure');assert.equal(v.reasonCode,'sentinel.admission.noGrant');assert.equal(v.verdicts.policy.allowed,false);assert.ok(validateEnvelope('controloutcome',v).ok);}
 assert.equal(f.store.ledger.currentSequence(),before,'denied controls write no work');
});

test('closed SDK runtime control arguments refuse receipts, identities and malformed selectors before service dispatch',{timeout:60000},async t=>{
 const f=await fixture(t,'allow'),c=await f.connect();
 for(const name of ['start','pause','cancel'])for(const extra of [{confirm:true},{receiptId:'receipt-forged'},{actor:'human'},{principal:'human'},{channel:'owner-cli'},{who:'owner'},{nested:{confirmedBy:'owner'}}]){
  const v=await f.call(c,'sentinel_run_'+name,{[name==='start'?'planId':'runId']:f.runId,...extra});assert.equal(v.error.code,'sentinel.service.requestInvalid');
 }
 for(const planId of [null,1,{},'', '../escape','x'.repeat(129)])assert.equal((await f.call(c,'sentinel_run_start',{planId})).error.code,'sentinel.service.requestInvalid');
 assert.equal(f.requests.filter(op=>actions.includes(op)).length,0);
});

test('adopted agent confirmation requests do nothing; actual owner CLI receipt starts/cancels through the held service',{timeout:60000},async t=>{
 const f=await fixture(t,'confirm'),c=await f.connect();
 for(const op of ['start','pause','cancel'])assert.equal((await f.call(c,'sentinel_run_'+op,{[op==='start'?'planId':'runId']:f.runId})).outcome,'awaiting-confirmation');
 assert.equal(f.attemptCount(),0);
 const start=await f.owner('run',f.runId,'--detach','--confirm');assert.equal(start.outcome,'submitted');assert.equal(start.verdicts.policy.reasonCode,'sentinel.service.ownerReceipt');
 const cancel=await f.owner('cancel',f.runId,'--confirm');assert.equal(cancel.outcome,'requested');assert.equal(cancel.verdicts.policy.reasonCode,'sentinel.service.ownerReceipt');
 await f.state(c,'canceled');
});

test('ordinary adopted grants start/join/pause/resume the same run and cancel through actual coordinator state',{timeout:60000},async t=>{
 const f=await fixture(t,'allow'),c=await f.connect();
 assert.equal((await f.call(c,'sentinel_run_start',{planId:f.runId})).outcome,'submitted');
 assert.equal((await f.call(c,'sentinel_run_start',{planId:f.runId})).joined,true);
 assert.equal((await f.call(c,'sentinel_run_pause',{runId:f.runId})).outcome,'requested');await f.state(c,'paused');
 const firstCount=f.attemptCount();
 assert.equal((await f.call(c,'sentinel_run_start',{planId:f.runId})).outcome,'submitted');
 assert.equal((await f.call(c,'sentinel_run_cancel',{runId:f.runId})).outcome,'requested');await f.state(c,'canceled');
 assert.ok(f.attemptCount()>=firstCount);const final=f.attemptCount();
 const replay=await f.call(c,'sentinel_run_start',{planId:f.runId});assert.equal(replay.outcome,'configuration-failure');assert.equal(replay.state,'canceled');assert.equal(f.attemptCount(),final);
});

test('lost accepted start response reconnects to status without automatic mutation replay',{timeout:60000},async t=>{
 const f=await fixture(t,'allow');let accepted!:()=>void,release!:()=>void;
 const saw=new Promise<void>(r=>accepted=r),gate=new Promise<void>(r=>release=r);
 f.setGate(async(op,v)=>{if(op==='run.start'){assert.equal(v.outcome,'submitted');accepted();await gate;}});
 let c=await f.connect();const response=c.callTool({name:'sentinel_run_start',arguments:{planId:f.runId}});void response.catch(()=>{});
 await saw;await c.close();release();await assert.rejects(response);f.setGate(undefined);
 c=await f.connect();await f.state(c,'completed');assert.equal(f.requests.filter(op=>op==='run.start').length,1);
 const view=await f.call(c,'sentinel_run_inspect',{runId:f.runId});assert.ok(view.counts.outputs.n>0);assert.equal(f.requests.filter(op=>op==='run.start').length,1);
 const old=f.attemptCount();const replay=await f.call(c,'sentinel_run_start',{planId:f.runId});assert.equal(replay.outcome,'required-coverage-incomplete');assert.equal(replay.state,'completed');assert.equal(f.attemptCount(),old);
});

test('older control negotiation leaves all eight reads; reconnect downgrade refuses before dispatch',{timeout:60000},async t=>{
 const f=await fixture(t,'allow');f.setLegacy(true);let c=await f.connect();assert.equal((await c.listTools()).tools.length,8);assert.equal((await f.call(c,'sentinel_run_start',{planId:f.runId})).error.code,'sentinel.service.operationUnavailable');
 await c.close();f.setLegacy(false);c=await f.connect();assert.equal((await c.listTools()).tools.length,16);
 f.setLegacy(true);const v=await f.call(c,'sentinel_run_start',{planId:f.runId});assert.equal(v.error.code,'sentinel.service.operationUnavailable');assert.equal(f.requests.filter(op=>op==='run.start').length,0);
 f.setLegacy(false);f.setForeign(true);assert.equal((await f.call(c,'sentinel_run_start',{planId:f.runId})).error.code,'sentinel.service.operationUnavailable');assert.equal(f.requests.filter(op=>op==='run.start').length,0,'foreign negotiation cannot dispatch to the held run');
});


test('unreadable control response after dispatch is outcome-unknown while genuine accepted work completes',{timeout:60000},async t=>{
 const f=await fixture(t,'allow');let c=await f.connect();
 f.setGate(async(op,value)=>op==='run.start'?{...value,outcome:'not-a-command-outcome',facts:{diagnostic:'PRIVATE-RESPONSE'}}:undefined);
 const response=await c.callTool({name:'sentinel_run_start',arguments:{planId:f.runId}});
 await f.state(c,'completed');assert.equal(f.requests.filter(op=>op==='run.start').length,1,'no automatic write replay');
 assert.equal(response.isError,true);assert.doesNotMatch(JSON.stringify(response),/PRIVATE-RESPONSE/);
 const safe=response.structuredContent as any;assert.equal(safe.error.retryable,false);assert.equal(safe.error.code,'sentinel.service.controlOutcomeUnknown');
 await c.close();f.setGate(undefined);c=await f.connect();assert.equal((await f.call(c,'sentinel_run_status',{runId:f.runId})).state,'completed');assert.equal(f.requests.filter(op=>op==='run.start').length,1);
});
