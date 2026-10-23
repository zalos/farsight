#!/usr/bin/env node
// Fresh npm-only owner paths -> separate confirmed run -> accepted structural report after source removal.
// No target execution, external image, download or deep engine. FARSIGHT_NPM_OFFLINE_CACHE uses genuine held bytes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync,renameSync,existsSync,lstatSync,chmodSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {npmConsumer} from './npm-consumer.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),version=JSON.parse(readFileSync(join(root,'packages/sentinel/package.json'))).version;
const c=await npmConsumer('sentinel-paths-',[resolve(process.argv[2]??join(root,'build/sentinel',`farsight-sentinel-${version}.tgz`))]),owned=new Set();
const scratch=realpathSync.native(c.scratch);
const gone=async pid=>{for(let n=0;n<200;n++){try{process.kill(pid,0)}catch{return}await new Promise(r=>setTimeout(r,25))}throw Error('the owned path service did not stop')};
try{
 const official=process.env.SENTINEL_SARIF_SCHEMA?new(createRequire(join(c.dir,'package.json'))('ajv').Ajv)({strict:false,validateFormats:false,unicodeRegExp:false}).compile(JSON.parse(readFileSync(process.env.SENTINEL_SARIF_SCHEMA))):null;
 const ws=join(scratch,'workspace');mkdirSync(join(ws,'src'),{recursive:true});
 writeFileSync(join(ws,'package.json'),JSON.stringify({name:'original-structural-query-example',private:true,type:'module'}));
 writeFileSync(join(ws,'src/entry.ts'),"import {middle} from './middle.js';\nexport function start(){return middle()}\n");
 writeFileSync(join(ws,'src/middle.ts'),"import {finish} from './sink.js';\nexport function middle(){return finish()}\n");
 writeFileSync(join(ws,'src/sink.ts'),"export function finish(){return 'original example'}\n");
 const env={...c.env,HOME:join(scratch,'home'),XDG_STATE_HOME:join(scratch,'owner')};mkdirSync(env.HOME);
 const call=async(...args)=>{try{const r=await c.exec(c.bin('farsight-sentinel'),[...args,'--json'],{cwd:ws,env});return{status:0,body:JSON.parse(r.stdout)}}catch(error){if(typeof error.code!=='number')throw error;return{status:error.code,body:JSON.parse(error.stdout)}}};
 const full=async(id,format,baseline)=>{try{return(await c.exec(c.bin('farsight-sentinel'),[...(baseline?['compare',id,baseline]:['report',id,'--full']),'--format',format],{cwd:ws,env})).stdout}catch(error){if(![0,2].includes(error.code))throw error;return error.stdout}};
 assert.equal((await call('init')).status,0);
 const settings=join(ws,'.farsight/sentinel/settings.json'),value=JSON.parse(readFileSync(settings));
 value.mandatoryRules=['sentinel.paths.call-reachability','sentinel.example.required-security'];value.grants=value.grants.map(g=>g.actions.includes('capture.source')?{...g,confirm:'always'}:g);
 writeFileSync(settings,JSON.stringify(value));const adopted=await call('settings','adopt','--confirm');assert.equal(adopted.status,0,JSON.stringify(adopted));
 assert.equal((await call('rules','promote','builtin:bounded-paths','--confirm')).status,0);
 const ancestor=await call('plan','--confirm');assert.equal(ancestor.status,0,JSON.stringify(ancestor));const parent=ancestor.body.facts;
 assert.equal((await call('run',parent.runId,'--confirm')).body.facts.state,'completed');
 const request={schema:'sentinel-path-request/draft-1',ancestor:{runId:parent.runId,revision:parent.revision,planDigest:parent.planDigest},snapshotId:parent.snapshotId,sourceId:'workspace',
  queries:[{from:'workspace::src/entry.ts::start',to:'workspace::src/sink.ts::finish'}],bounds:{edgeKinds:['calls'],maxDepth:12,maxFanout:256,maxVisited:50000}};
 const file=join(scratch,'canonical-request.json');writeFileSync(file,JSON.stringify(request),{mode:0o600});
 renameSync(join(ws,'src'),join(scratch,'source-away'));
 const waiting=await call('paths',parent.runId,'--request',file);assert.equal(waiting.status,4,JSON.stringify(waiting));assert.deepEqual(waiting.body.facts.preview.queries,request.queries);
 const planned=await call('paths',parent.runId,'--request',file,'--confirm');assert.equal(planned.status,0,JSON.stringify(planned));assert.equal(planned.body.facts.runId,waiting.body.facts.runId);const id=planned.body.facts.runId;
 const kept=await call('paths',parent.runId,'--request',file,'--confirm');assert.equal(kept.body.outcome,'kept');assert.equal(kept.body.facts.runId,id);
 const completed=await call('run',id,'--confirm');assert.equal(completed.status,2,JSON.stringify(completed));assert.equal(completed.body.facts.state,'completed');
 const minimal=await call('report',id);assert.equal(minimal.body.facts.report.structuralPaths.length,1);assert.equal(minimal.body.facts.report.structuralPaths[0].evidence.results[0].outcome,'reached');assert.equal(minimal.body.facts.report.observations.length,0);
 for(const format of ['json','md','html','sarif']){const text=await full(id,format);if(format==='json'){const report=JSON.parse(text);assert.equal(report.counts.pathQueries.n,1);assert.equal(report.findings.length,0);assert.ok(report.gaps.length);assert.equal(report.structuralPaths[0].evidence.results[0].paths[0].steps.length,2)}else if(format==='sarif'){const report=JSON.parse(text);if(official)assert.equal(official(report),true,JSON.stringify(official.errors));assert.equal(report.runs[0].properties.structuralPaths.length,1);assert.equal(report.runs[0].results.length,0)}else assert.match(text,/Structural call reachability/)}
 assert.equal((await call('retry',id,'--confirm')).body.reasonCode,'sentinel.service.nothingToRetry');
 const rerun=await call('rerun',id,'--stage',planned.body.facts.unitIds[0],'--confirm');assert.equal(rerun.status,0,JSON.stringify(rerun));const child=rerun.body.facts.runId;
 const detached=await call('run',child,'--detach','--confirm');assert.equal(detached.body.outcome,'submitted',JSON.stringify(detached));
 const services=join(env.XDG_STATE_HOME,'farsight/sentinel/trust/services'),descriptors=readdirSync(services).filter(n=>n.endsWith('.json'));assert.equal(descriptors.length,1);
 const pid=JSON.parse(readFileSync(join(services,descriptors[0]))).pid;assert.ok(Number.isSafeInteger(pid)&&pid>0);owned.add(pid);
 const waited=await call('wait',child,'--timeout','30000');assert.equal(waited.body.facts.state,'completed',JSON.stringify(waited));
 process.kill(pid,'SIGTERM');await gone(pid);owned.delete(pid);
 const replay=await call('report',child);assert.equal(replay.body.facts.report.structuralPaths[0].ancestor.runId,id);assert.equal(replay.body.facts.report.structuralPaths[0].evidence.results[0].outcome,'reached');
 const compare=JSON.parse(await full(child,'json',id));assert.equal(compare.structuralPaths.length,1);assert.equal(compare.findings.length,0);assert.ok(compare.gaps.length);
 const next=await call('paths',parent.runId,'--request',file,'--confirm');assert.equal(next.body.facts.generation,1);assert.notEqual(next.body.facts.runId,id);
 const installed=join(c.dir,'node_modules/farsight-sentinel'),worker=join(installed,'dist/analysis/paths/worker.mjs');assert.ok(existsSync(join(installed,'dist/analysis/paths/driver.mjs')));
 renameSync(worker,worker+'.held');writeFileSync(worker.replace(/\.mjs$/,'.js'),'// a .js decoy cannot replace the installed worker\n');
 try{
  assert.equal((await call('report',id)).body.facts.report.structuralPaths[0].evidence.results[0].outcome,'reached');
  for(const format of ['json','md','html','sarif'])assert.ok((await full(id,format)).length);
  const refused=await call('run',next.body.facts.runId,'--confirm');assert.equal(refused.status,3,JSON.stringify(refused));assert.equal(refused.body.reasonCode,'sentinel.execution.adapterInvalid',JSON.stringify(refused));
 }finally{rmSync(worker.replace(/\.mjs$/,'.js'));renameSync(worker+'.held',worker)}
 console.log(JSON.stringify({consumer:'paths',ownerPreparation:true,separateRunAdmission:true,sourceRemoved:true,pendingJoin:true,terminalGeneration:true,selectedPathRerun:true,detachedAndServiceStopped:true,reports:['minimal','json','md','html','sarif','compare'],findings:0,requiredSecurityGapsRemain:true,strictInstalledAssets:true,acceptedReportWithoutWorker:true,officialSarif:Boolean(official),scope:'genuine owner workflow; native secret privacy and exact crash-window qualification are separate controls'}));
}finally{
 for(const pid of owned){try{process.kill(pid,'SIGTERM')}catch{}await gone(pid)}
 const orphan=join(scratch,'workspace/.farsight/sentinel/store/scratch');let entries=0;
 const unlock=p=>{if(++entries>100000)throw Error('owned scratch cleanup bound');const st=lstatSync(p);if(st.isSymbolicLink())return;if(st.isDirectory()){chmodSync(p,0o700);for(const n of readdirSync(p))unlock(join(p,n))}else chmodSync(p,0o600)};
 if(existsSync(orphan))unlock(orphan);rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
