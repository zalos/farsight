#!/usr/bin/env node
// npm-only real SDK -> installed stdio adapter -> existing installed owner service. No checkout runtime imports.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,existsSync,rmSync,realpathSync,writeFileSync,renameSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {npmConsumer} from './npm-consumer.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),version=JSON.parse(readFileSync(join(root,'packages/sentinel/package.json'))).version;
const artifact=resolve(process.argv[2]??join(root,'build/sentinel',`farsight-sentinel-${version}.tgz`));assert.ok(existsSync(artifact),'pack Sentinel first');
const c=await npmConsumer('sentinel-mcp-', [artifact]);
const services=new Set(),clients=new Set();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');let timer;try{await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('owned MCP service did not stop')),10000))]);}finally{clearTimeout(timer);}}
try{
 const require=createRequire(join(c.dir,'package.json'));
 const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
 const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
 writeFileSync(join(c.dir,'sentinel-public.mjs'),"export * from 'farsight-sentinel';\n");writeFileSync(join(c.dir,'sentinel-reports.mjs'),"export * from 'farsight-sentinel/reports';\n");
 const sentinel=await import(pathToFileURL(join(c.dir,'sentinel-public.mjs')).href),renderers=await import(pathToFileURL(join(c.dir,'sentinel-reports.mjs')).href);
 assert.equal(JSON.parse(readFileSync(resolve(dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js')),'../../..','package.json'))).version,'1.31.0');
 const sdkPath=resolve(dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js')),'../../..'),sdkRequire=createRequire(join(sdkPath,'package.json'));
 assert.equal(JSON.parse(readFileSync(sdkRequire.resolve('zod/package.json'))).version,'3.25.76','the actual SDK resolves the exact required peer');
 renameSync(sdkPath,sdkPath+'.held');try{await c.exec(c.bin('farsight-sentinel'),['--help']);await c.exec(process.execPath,['--input-type=module','-e',"await import('farsight-sentinel');"]);}finally{renameSync(sdkPath+'.held',sdkPath);}
 const scratch=realpathSync.native(c.scratch),ws=join(scratch,'workspace');mkdirSync(join(ws,'src'),{recursive:true});
 for(let i=0;i<4;i++)writeFileSync(join(ws,'src',`private-lookup-${i}.ts`),'export const lookup = (id) => db.query("SELECT * FROM invoice WHERE id = " + id);\n');
 const env={...c.env,HOME:join(scratch,'home'),XDG_STATE_HOME:join(scratch,'owner'),NODE_PATH:'',NODE_OPTIONS:''};mkdirSync(env.HOME);
 const bin=c.bin('farsight-sentinel');
 const call=async(...args)=>{try{const r=await c.exec(bin,[...args,'--json'],{cwd:ws,env});return{status:0,body:JSON.parse(r.stdout)}}catch(e){if(typeof e.code!=='number')throw e;return{status:e.code,body:JSON.parse(e.stdout)}}};
 assert.equal((await call('init')).status,0);assert.equal((await call('settings','adopt','--confirm')).status,0);
 const pack=join(dirname(require.resolve('farsight-sentinel/package.json')),'rules/foundation-preview');
 assert.equal((await call('rules','promote',pack,'--confirm')).status,0);
 const plan=await call('plan');assert.equal(plan.status,0,JSON.stringify(plan));const parent=plan.body.facts.planId;
 assert.equal((await call('run',parent)).body.facts.state,'completed');
 rmSync(join(ws,'src'),{recursive:true});
 const selected=await call('rerun',parent,'--stage',plan.body.facts.unitIds[0],'--confirm');assert.equal(selected.status,0,JSON.stringify(selected));const childId=selected.body.facts.runId;
 assert.equal((await call('run',childId)).body.facts.state,'completed');
 const serving=(idleMs=0)=>{const child=spawn(bin,['serve','--workspace',ws,'--idle-ms',String(idleMs)],{cwd:ws,env,stdio:['ignore','pipe','pipe']});services.add(child);return child;};
 async function connect(){const client=new Client({name:'sentinel-installed-readonly-consumer',version:'1'},{capabilities:{}});const transport=new StdioClientTransport({command:process.execPath,args:[bin,'mcp','--workspace',ws],cwd:ws,env,stderr:'pipe'});clients.add(client);let stderr='';transport.stderr?.on('data',b=>stderr+=b);await client.connect(transport);return{client,stderr:()=>stderr};}
 async function ready(){let last;for(let i=0;i<100;i++){try{return await connect();}catch(e){last=e;await wait(50);}}throw last;}
 let service=serving(),{client,stderr}=await ready();
 const tool=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent??JSON.parse(r.content[0].text);};
 const toolList=(await client.listTools()).tools;assert.deepEqual(Object.keys(toolList.find(t=>t.name==='sentinel_run_status').inputSchema.properties),['runId']);
 const noEvents=await client.callTool({name:'sentinel_run_status',arguments:{runId:childId,after:0,limit:1}});assert.equal(noEvents.isError,true);assert.equal(noEvents.structuredContent.error.code,'sentinel.service.requestInvalid');
 const copies=await Promise.all([1,2].map(()=>client.callTool({name:'sentinel_run_inspect',arguments:{runId:childId}})));assert.equal(copies.filter(x=>!x.isError).length,1);const busy=copies.find(x=>x.isError);assert.equal(busy.structuredContent.error.code,'sentinel.service.inspectBusy');assert.equal(busy.structuredContent.error.retryable,true);
 assert.deepEqual(toolList.map(t=>t.name).sort(),['sentinel_service_info','sentinel_run_describe','sentinel_run_status','sentinel_run_wait','sentinel_run_inspect','sentinel_view_page','sentinel_report_open','sentinel_delivery_read'].sort());
 const caps=await tool('sentinel_service_info');assert.equal(caps.controlsSupported,false);assert.ok(sentinel.validateEnvelope('servicecapabilities',caps).ok);
 const start=performance.now(),view=await tool('sentinel_run_inspect',{runId:childId}),inspectMs=performance.now()-start;
 assert.ok(sentinel.validateEnvelope('runinspection',view).ok);let cursor,seen=0;
 do{const page=await tool('sentinel_view_page',{viewId:view.viewId,collection:'works',limit:1,...(cursor?{cursor}:{})});assert.ok(!JSON.stringify(page).includes('private-lookup'));assert.ok(page.rows.every(r=>r.prerequisites.every(d=>['in-view','reference-only'].includes(d.binding))));seen+=page.rows.length;cursor=page.nextCursor;}while(cursor);
 assert.equal(seen,view.counts.works.n);
 async function bytes(manifest){let offset=0;const chunks=[];for(;;){const p=await tool('sentinel_delivery_read',{deliveryId:manifest.deliveryId,offset,maxBytes:65536});chunks.push(Buffer.from(p.base64,'base64'));if(p.nextOffset===null)break;offset=p.nextOffset;}const b=Buffer.concat(chunks);assert.equal(b.length,manifest.formatBytes);assert.equal(`sha256:${createHash('sha256').update(b).digest('hex')}`,manifest.formatDigest);return b.toString();}
 const jsonManifest=await tool('sentinel_report_open',{runId:childId,baselineRunId:parent,format:'json'}),doc=JSON.parse(await bytes(jsonManifest));
 assert.equal(jsonManifest.current.runId,childId);assert.equal(jsonManifest.baseline.runId,parent);assert.equal(doc.disclosure.profile,'shareable');
 const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')}}`;
 const measure=[];
 for(const format of['json','md','html','sarif']){
  const started=performance.now(),m=await tool('sentinel_report_open',{runId:childId,baselineRunId:parent,format}),text=await bytes(m),expected={...doc,evaluatedAt:m.evaluatedAt};
  assert.equal(`sha256:${createHash('sha256').update(canonical(expected)).digest('hex')}`,m.documentDigest,'same canonical document at the explicit evaluation time');
  const rendered=format==='json'?canonical(expected)+'\n':format==='md'?renderers.renderMarkdown(expected):format==='html'?renderers.renderHtml(expected):JSON.stringify(renderers.toSarif(expected),null,2)+'\n';
  // Canonical JSON parsing changes record insertion order. SARIF values must agree;
  // the delivered bytes are independently checked against the manifest digest above.
  if(format==='sarif')assert.deepEqual(JSON.parse(text),JSON.parse(rendered));else assert.equal(text,rendered);
  measure.push({format,bytes:Buffer.byteLength(text),elapsedMs:performance.now()-started});
 }
 const saved=await tool('sentinel_report_open',{runId:parent,format:'json'}),savedBytes=await bytes(saved);await client.close();clients.delete(client);
 ({client,stderr}=await connect());assert.equal(await bytes(saved),savedBytes,'reconnect preserves exact delivery');
 await client.close();clients.delete(client);await stop(service);services.delete(service);service=serving();({client,stderr}=await ready());
 const expired=await client.callTool({name:'sentinel_delivery_read',arguments:{deliveryId:saved.deliveryId,offset:0}});assert.equal(expired.isError,true);assert.equal(expired.structuredContent.error.code,'sentinel.service.deliveryExpired');
 const unavailable=await client.callTool({name:'sentinel_run_start',arguments:{planId:parent}});assert.equal(unavailable.isError,true);assert.equal(unavailable.structuredContent.error.code,'sentinel.service.operationUnavailable');
 // A second genuine public plan uses the shipped framework worker; application bytes are never executed.
 await client.close();clients.delete(client);await stop(service);services.delete(service);
 mkdirSync(join(ws,'src'));writeFileSync(join(ws,'package.json'),JSON.stringify({name:'original-mcp-example',version:'1.0.0',dependencies:{express:'4.21.2'}}));
 writeFileSync(join(ws,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{express:'4.21.2'}},'node_modules/express':{version:'4.21.2',resolved:'https://registry.npmjs.org/express/-/express-4.21.2.tgz'}}}));
 const route=value=>`import express from 'express';const app=express();app.get('/${value}',(_req,res)=>res.send('example'));\n`;
 writeFileSync(join(ws,'src/routes.ts'),route('open'));
 const settings=join(ws,'.farsight/sentinel/settings.json'),controls=['sentinel.controls.authentication','sentinel.controls.authorization','sentinel.controls.input-validation'];
 const configure=rules=>writeFileSync(settings,JSON.stringify({...JSON.parse(readFileSync(settings)),mandatoryRules:rules}));
 configure(controls);assert.equal((await call('settings','adopt','--confirm')).status,0);assert.equal((await call('rules','promote','builtin:framework-controls','--confirm')).status,0);
 const framework=await call('plan');assert.equal(framework.status,0,JSON.stringify(framework));const frameworkId=framework.body.facts.planId;
 assert.equal((await call('run',frameworkId)).body.facts.state,'completed');rmSync(join(ws,'src'),{recursive:true});
 service=serving();({client,stderr}=await ready());
 const clean=JSON.parse(await bytes(await tool('sentinel_report_open',{runId:frameworkId,format:'json'})));
 assert.equal(clean.findings.length,0);assert.equal(clean.inspections.length,1);assert.equal(clean.inspections[0].assessment,'none');
 assert.ok(clean.inspections[0].rows.some(r=>r.state==='established'&&r.verdict==='does-not-apply'));assert.ok(JSON.stringify(clean).includes('GET /open'));
 for(const format of['md','html','sarif']){const text=await bytes(await tool('sentinel_report_open',{runId:frameworkId,format}));assert.ok(text.includes('Framework control inspection')||format==='sarif');}
 const frameworkView=await tool('sentinel_run_inspect',{runId:frameworkId});assert.ok(frameworkView.counts.outputs.n>0);
 let native=false;
 if(process.env.SENTINEL_ISOLATION==='1'){
  await client.close();clients.delete(client);await stop(service);services.delete(service);
  mkdirSync(join(ws,'src'));const value=['Sntl','Fxt9q2','Lr7Wv4','Zk8Jm3','Pd6Hy1','Tb5Qe0'].join('');
  writeFileSync(join(ws,'src/routes.ts'),route(value));writeFileSync(join(ws,'.env'),`api_key = "${value}"\n`);
  const installed=dirname(require.resolve('farsight-sentinel/package.json')),secrets=JSON.parse(readFileSync(join(installed,'rules/secrets/sentinel-pack.json')));
  configure([...controls,...secrets.rules.map(r=>r.familyId)]);assert.equal((await call('settings','adopt','--confirm')).status,0);
  assert.equal((await call('rules','promote','builtin:secrets','--confirm')).status,0);assert.equal((await call('assets','adopt-tool','secrets-gitleaks','--confirm')).status,0);
  const secretPlan=await call('plan');assert.equal(secretPlan.status,0,JSON.stringify(secretPlan));const secretId=secretPlan.body.facts.planId;
  assert.equal((await call('run',secretId)).body.facts.state,'completed');rmSync(join(ws,'src'),{recursive:true});rmSync(join(ws,'.env'));
  service=serving();({client,stderr}=await ready());
  const secret=JSON.parse(await bytes(await tool('sentinel_report_open',{runId:secretId,format:'json'})));
  assert.ok(secret.findings.length>0);assert.match(secret.inspections[0].sourceId,/^withheld-/);
  for(const format of['json','md','html','sarif'])assert.equal((await bytes(await tool('sentinel_report_open',{runId:secretId,format}))).includes(value),false,'current genuine secret withholding');
  await client.close();clients.delete(client);await stop(service);services.delete(service);
  // Select exactly the genuine published inspection, leaving the ancestor's secret scanner held.
  const secretChild=await call('rerun',secretId,'--stage',secret.inspections[0].work.id,'--confirm');assert.equal(secretChild.status,0,JSON.stringify(secretChild));const selectedId=secretChild.body.facts.runId;
  assert.equal((await call('run',selectedId)).body.facts.state,'completed');
  service=serving();({client,stderr}=await ready());
  for(const format of['json','md','html','sarif'])assert.equal((await bytes(await tool('sentinel_report_open',{runId:selectedId,baselineRunId:secretId,format}))).includes(value),false,'source-gone selected ancestry withholding');
  await client.close();clients.delete(client);await stop(service);services.delete(service);
  mkdirSync(join(ws,'src'));writeFileSync(join(ws,'src/routes.ts'),route('clean'));configure(controls);assert.equal((await call('settings','adopt','--confirm')).status,0);
  const cleanPlan=await call('plan');assert.equal(cleanPlan.status,0,JSON.stringify(cleanPlan));assert.equal((await call('run',cleanPlan.body.facts.planId)).body.facts.state,'completed');rmSync(join(ws,'src'),{recursive:true});
  service=serving();({client,stderr}=await ready());
  const ordinary=JSON.parse(await bytes(await tool('sentinel_report_open',{runId:cleanPlan.body.facts.planId,format:'json'})));assert.ok(JSON.stringify(ordinary).includes('GET /clean'));
  for(const format of['json','md','html','sarif']){const text=await bytes(await tool('sentinel_report_open',{runId:cleanPlan.body.facts.planId,baselineRunId:selectedId,format}));assert.equal(text.includes(value),false,'baseline selected ancestry withholding');if(format==='json')assert.match(JSON.parse(text).inspections[0].sourceId,/^withheld-/);}
  native=true;
 }
 // Real wall-clock control at the same 15s idle cutoff used by the detached launcher.
 await client.close();clients.delete(client);await stop(service);services.delete(service);service=serving(15000);({client,stderr}=await ready());
 const idleReport=await tool('sentinel_report_open',{runId:frameworkId,format:'json'}),idleBytes=await bytes(idleReport),idleView=await tool('sentinel_run_inspect',{runId:frameworkId});
 await wait(16000);assert.equal(service.exitCode,null,'actual saved buffers retain owner beyond detached idle cutoff');assert.equal(await bytes(idleReport),idleBytes);assert.equal((await tool('sentinel_view_page',{viewId:idleView.viewId,collection:'works'})).viewId,idleView.viewId);
 assert.equal(stderr(),'');
 console.log(JSON.stringify({schema:'sentinel-mcp-consumer/draft-1',npmOnly:true,sdk:'1.31.0',zod:'3.25.76',statusOnly:true,inspectBusy:true,ordinaryImportWithoutSdk:true,retainedPastDetachedIdle:true,sourceGone:true,selected:true,comparison:true,reconnect:true,restartExpired:true,controlsAbsent:true,frameworkSourceGone:true,nativeSecrets:native,sarifParity:'semantic',otherFormatParity:'exact',inspectMs,formats:measure}));
}finally{
 for(const client of clients)await client.close().catch(()=>{});for(const child of services)await stop(child);
 c.cleanup();
}
