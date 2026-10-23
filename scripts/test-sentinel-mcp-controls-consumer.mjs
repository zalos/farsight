#!/usr/bin/env node
// Real SDK and public CLI from an npm-only installation; no checkout runtime/private installed imports.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {npmConsumer} from './npm-consumer.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),version=JSON.parse(readFileSync(join(root,'packages/sentinel/package.json'))).version;
const artifact=resolve(process.argv[2]??join(root,'build/sentinel',`farsight-sentinel-${version}.tgz`));
const c=await npmConsumer('sentinel-mcp-controls-',[artifact]),clients=new Set(),services=new Set(),wait=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');let timer;try{await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('owned control service did not stop')),10000))]);}finally{clearTimeout(timer);}}
try{
 const require=createRequire(join(c.dir,'package.json')),{Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href),{StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
 const installed=dirname(require.resolve('farsight-sentinel/package.json')),bin=c.bin('farsight-sentinel'),scratch=realpathSync.native(c.scratch);
 writeFileSync(join(c.dir,'sentinel-public.mjs'),"export * from 'farsight-sentinel';\n");const {validateEnvelope}=await import(pathToFileURL(join(c.dir,'sentinel-public.mjs')).href);
 async function fixture(label,mode){
  const ws=join(scratch,label);mkdirSync(join(ws,'src'),{recursive:true});for(let i=0;i<16;i++)writeFileSync(join(ws,'src',`inert-${i}.ts`),'export const readInvoice = id => db.query("SELECT * FROM invoice WHERE id = " + id);\n');
  const env={...c.env,XDG_STATE_HOME:join(scratch,label+'-owner'),NODE_PATH:'',NODE_OPTIONS:''};
  const owner=async(...args)=>{try{return JSON.parse((await c.exec(bin,[...args,'--json'],{cwd:ws,env})).stdout);}catch(e){if(typeof e.code==='number'&&e.stdout)return JSON.parse(e.stdout);throw e;}};
  assert.equal((await owner('init')).outcome,'prepared');
  if(mode!=='deny'){const path=join(ws,'.farsight/sentinel/settings.json'),s=JSON.parse(readFileSync(path));s.agentActions=mode;s.grants.push({actions:['run.start','run.pause','run.cancel'],principals:['agent'],scope:{profiles:['static']}});writeFileSync(path,JSON.stringify(s));}
  assert.equal((await owner('settings','adopt','--confirm')).outcome,'prepared');assert.equal((await owner('rules','promote',join(installed,'rules/foundation-preview'),'--confirm')).outcome,'prepared');
  const planned=await owner('plan');assert.equal(planned.outcome,'prepared');const runId=planned.facts.planId;
  const service=spawn(bin,['serve','--workspace',ws,'--idle-ms','0'],{cwd:ws,env,stdio:['ignore','pipe','pipe']});services.add(service);let errors='';service.stderr.on('data',b=>errors+=b);
  async function connect(wrapper){const client=new Client({name:'installed-control-consumer',version:'1'},{capabilities:{}});clients.add(client);const transport=new StdioClientTransport({command:process.execPath,args:wrapper?[wrapper]:[bin,'mcp','--workspace',ws],cwd:ws,env,stderr:'pipe'});let diagnostic='';transport.stderr?.on('data',b=>{diagnostic=(diagnostic+b).slice(-4000);});try{await client.connect(transport);}catch(e){await client.close().catch(()=>{});clients.delete(client);throw Error('installed MCP startup: '+e.message+'; '+diagnostic+'; service: '+errors);}return client;}
  let client,last;for(let i=0;i<100;i++){try{client=await connect();break;}catch(e){last=e;await wait(50);}}if(!client)throw last;console.error(JSON.stringify({checkpoint:'connected',fixture:label}));
  const call=async(client,name,args)=>{const v=await client.callTool({name,arguments:args});assert.ok(!v.isError,JSON.stringify(v));return v.structuredContent;};
  const state=async(client,expected)=>{for(let i=0;i<200;i++){const v=await call(client,'sentinel_run_wait',{runId,timeoutMs:100});if(v.state===expected)return v;await wait(10);}assert.fail('did not reach '+expected+': '+errors);};
  return {ws,env,runId,client,connect,call,state,owner,service};
 }
 const denied=await fixture('denied','deny'),{client,call,runId}=denied;
 const names=(await client.listTools()).tools;assert.equal(names.length,11);for(const action of ['start','pause','cancel']){const t=names.find(x=>x.name==='sentinel_run_'+action);assert.equal(t.annotations.readOnlyHint,false);assert.equal(t.annotations.idempotentHint,false);}
 assert.equal((await call(client,'sentinel_service_info',{})).controlsSupported,false,'legacy document still negotiates only reads');
 for(const action of ['start','pause','cancel']){const v=await call(client,'sentinel_run_'+action,{[action==='start'?'planId':'runId']:runId});assert.equal(v.reasonCode,'sentinel.admission.noGrant');assert.ok(validateEnvelope('controloutcome',v).ok);}
 for(const extra of [{receiptId:'forged'},{confirm:true},{actor:'human'},{channel:'owner-cli'},{effects:[]}]){const v=await client.callTool({name:'sentinel_run_start',arguments:{planId:runId,...extra}});assert.equal(v.isError,true);assert.equal(v.structuredContent.error.code,'sentinel.service.requestInvalid');}
 assert.equal((await denied.owner('run',runId,'--detach','--confirm')).outcome,'submitted');await denied.state(client,'completed');
 const delivered=await call(client,'sentinel_report_open',{runId,format:'json'}),first=await call(client,'sentinel_delivery_read',{deliveryId:delivered.deliveryId,offset:0});
 assert.equal((await call(client,'sentinel_run_cancel',{runId})).reasonCode,'sentinel.admission.noGrant');assert.deepEqual(await call(client,'sentinel_delivery_read',{deliveryId:delivered.deliveryId,offset:0}),first);
 const confirmation=await fixture('confirmation','confirm');const before=await confirmation.call(confirmation.client,'sentinel_run_inspect',{runId:confirmation.runId});
 for(const action of ['start','pause','cancel'])assert.equal((await confirmation.call(confirmation.client,'sentinel_run_'+action,{[action==='start'?'planId':'runId']:confirmation.runId})).outcome,'awaiting-confirmation');
 const after=await confirmation.call(confirmation.client,'sentinel_run_inspect',{runId:confirmation.runId});assert.equal(after.counts.attempts.n,before.counts.attempts.n);
 const started=await confirmation.owner('run',confirmation.runId,'--detach','--confirm');assert.equal(started.outcome,'submitted');assert.equal(started.verdicts.policy.reasonCode,'sentinel.service.ownerReceipt');
 assert.equal((await confirmation.owner('pause',confirmation.runId,'--confirm')).outcome,'requested');await confirmation.state(confirmation.client,'paused');
 assert.equal((await confirmation.owner('run',confirmation.runId,'--detach','--confirm')).outcome,'submitted');assert.equal((await confirmation.owner('cancel',confirmation.runId,'--confirm')).outcome,'requested');await confirmation.state(confirmation.client,'canceled');
 const allowed=await fixture('allowed','allow'),a=allowed.client,id=allowed.runId,ask=(name,args)=>allowed.call(a,name,args);
 rmSync(join(allowed.ws,'src'),{recursive:true});
 assert.equal((await ask('sentinel_run_start',{planId:id})).outcome,'submitted');assert.equal((await ask('sentinel_run_start',{planId:id})).joined,true);
 assert.equal((await ask('sentinel_run_pause',{runId:id})).outcome,'requested');await allowed.state(a,'paused');
 assert.equal((await ask('sentinel_run_start',{planId:id})).outcome,'submitted');assert.equal((await ask('sentinel_run_cancel',{runId:id})).outcome,'requested');await allowed.state(a,'canceled');
 const ended=await ask('sentinel_run_inspect',{runId:id});assert.equal((await ask('sentinel_run_start',{planId:id})).state,'canceled');assert.equal((await ask('sentinel_run_inspect',{runId:id})).counts.attempts.n,ended.counts.attempts.n);
 const lost=await fixture('lost','allow');await lost.client.close();clients.delete(lost.client);
 // A transparent child wrapper withholds only an actual submitted result from the installed adapter. It never
 // touches the installed package, service, authority, publications or source inputs; its child PID is its own.
 const marker=join(scratch,'accepted-response.json'),wrapper=join(c.dir,'hold-response.mjs');
 writeFileSync(wrapper,String.raw`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
 const child=spawn(process.execPath,${JSON.stringify([bin,'mcp','--workspace',lost.ws])},{stdio:['pipe','pipe','inherit']});
 let buffered='';process.stdin.pipe(child.stdin);child.stdout.on('data',b=>{buffered+=b;for(;;){const i=buffered.indexOf('\n');if(i<0)break;const line=buffered.slice(0,i);buffered=buffered.slice(i+1);const v=JSON.parse(line);if(v.result?.structuredContent?.schema==='sentinel-control-outcome/draft-1'&&v.result.structuredContent.outcome==='submitted')writeFileSync(${JSON.stringify(marker)},JSON.stringify({accepted:true}));else process.stdout.write(line+'\n');}});
 process.stdin.on('end',()=>child.kill('SIGTERM'));process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',code=>process.exit(code??0));`);
 let l=await lost.connect(wrapper);const pending=l.callTool({name:'sentinel_run_start',arguments:{planId:lost.runId}});void pending.catch(()=>{});
 for(let i=0;!existsSync(marker);i++){assert.ok(i<300,'actual installed start returned submitted before response loss');await wait(10);}
 await l.close();clients.delete(l);await assert.rejects(pending);l=await lost.connect();await lost.state(l,'completed');
 const complete=await lost.call(l,'sentinel_run_inspect',{runId:lost.runId});await l.close();clients.delete(l);l=await lost.connect();
 const replay=await lost.call(l,'sentinel_run_inspect',{runId:lost.runId});assert.equal(replay.counts.attempts.n,complete.counts.attempts.n);
 const terminal=await lost.call(l,'sentinel_run_start',{planId:lost.runId});assert.equal(terminal.state,'completed');assert.equal(terminal.outcome,'required-coverage-incomplete');assert.equal((await lost.call(l,'sentinel_run_inspect',{runId:lost.runId})).counts.attempts.n,complete.counts.attempts.n);
 console.log(JSON.stringify({schema:'sentinel-mcp-controls-consumer/draft-1',npmOnly:true,artifactSha256:createHash('sha256').update(readFileSync(artifact)).digest('hex'),tools:11,legacyReadCapabilityPreserved:true,closedRuntimeArgs:true,defaultDenied:true,agentConfirmationNoWork:true,realOwnerCliConfirmation:true,adoptedAgentGrant:true,pauseResumeSameRun:true,cancelObserved:true,sourceGone:true,deliveryUnchanged:true,lostAcceptedResponse:true,reconnectNoAutoReplay:true,terminalReplayNoWork:true}));
}finally{for(const client of clients)await client.close().catch(()=>{});for(const service of services)await stop(service);c.cleanup();}
