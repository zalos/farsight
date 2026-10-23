#!/usr/bin/env node
// npm-only real SDK -> installed stdio adapter -> existing installed owner service. No checkout runtime imports.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,existsSync,rmSync,realpathSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {npmConsumer} from './npm-consumer.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),version=JSON.parse(readFileSync(join(root,'packages/sentinel/package.json'))).version;
const artifact=resolve(process.argv[2]??join(root,'build/sentinel',`farsight-sentinel-${version}.tgz`));assert.ok(existsSync(artifact),'pack Sentinel first');
const c=await npmConsumer('sentinel-mcp-', [artifact]);
const services=new Set(),clients=new Set();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),wait(10000).then(()=>{throw Error('owned MCP service did not stop');})]);}
try{
 const require=createRequire(join(c.dir,'package.json'));
 const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
 const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
 const sentinel=await import(pathToFileURL(require.resolve('farsight-sentinel')).href),renderers=await import(pathToFileURL(require.resolve('farsight-sentinel/reports')).href);
 assert.equal(JSON.parse(readFileSync(resolve(dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js')),'../../..','package.json'))).version,'1.31.0');
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
 const serving=()=>{const child=spawn(bin,['serve','--workspace',ws,'--idle-ms','0'],{cwd:ws,env,stdio:['ignore','pipe','pipe']});services.add(child);return child;};
 async function connect(){const client=new Client({name:'sentinel-installed-readonly-consumer',version:'1'},{capabilities:{}});const transport=new StdioClientTransport({command:process.execPath,args:[bin,'mcp','--workspace',ws],cwd:ws,env,stderr:'pipe'});clients.add(client);let stderr='';transport.stderr?.on('data',b=>stderr+=b);await client.connect(transport);return{client,stderr:()=>stderr};}
 async function ready(){let last;for(let i=0;i<100;i++){try{return await connect();}catch(e){last=e;await wait(50);}}throw last;}
 let service=serving(),{client,stderr}=await ready();
 const tool=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent??JSON.parse(r.content[0].text);};
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['sentinel_service_info','sentinel_run_describe','sentinel_run_status','sentinel_run_wait','sentinel_run_inspect','sentinel_view_page','sentinel_report_open','sentinel_delivery_read'].sort());
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
  const rendered=format==='json'?canonical(expected)+'\n':format==='md'?renderers.renderMarkdown(expected):format==='html'?renderers.renderHtml(expected):JSON.stringify(renderers.toSarif(expected),null,2)+'\n';assert.equal(text,rendered);
  measure.push({format,bytes:Buffer.byteLength(text),elapsedMs:performance.now()-started});
 }
 const saved=await tool('sentinel_report_open',{runId:parent,format:'json'}),savedBytes=await bytes(saved);await client.close();clients.delete(client);
 ({client,stderr}=await connect());assert.equal(await bytes(saved),savedBytes,'reconnect preserves exact delivery');
 await client.close();clients.delete(client);await stop(service);services.delete(service);service=serving();({client,stderr}=await ready());
 const expired=await client.callTool({name:'sentinel_delivery_read',arguments:{deliveryId:saved.deliveryId,offset:0}});assert.equal(expired.isError,true);assert.equal(expired.structuredContent.error.code,'sentinel.service.deliveryExpired');
 const unavailable=await client.callTool({name:'sentinel_run_start',arguments:{planId:parent}});assert.equal(unavailable.isError,true);assert.equal(unavailable.structuredContent.error.code,'sentinel.service.operationUnavailable');
 assert.equal(stderr(),'');
 console.log(JSON.stringify({schema:'sentinel-mcp-consumer/draft-1',npmOnly:true,sdk:'1.31.0',sourceGone:true,selected:true,comparison:true,reconnect:true,restartExpired:true,controlsAbsent:true,inspectMs,formats:measure}));
}finally{
 for(const client of clients)await client.close().catch(()=>{});for(const child of services)await stop(child);
 c.cleanup();
}
