#!/usr/bin/env node
// Public npm-only framework inspection: original inert source, owner promotion and retained evidence. The worker
// executes Sentinel's trusted code, never this application's code. Set FARSIGHT_NPM_OFFLINE_CACHE for offline use.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmConsumer } from './npm-consumer.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(readFileSync(join(root,'packages/sentinel/package.json'))).version;
const artifact=resolve(process.argv[2]??join(root,'build/sentinel',`farsight-sentinel-${version}.tgz`));
assert.ok(existsSync(artifact),'pack Sentinel first');
const c=await npmConsumer('sentinel-framework-', [artifact]);
const servicePids=new Set();
const gone=async(pid)=>{for(let i=0;i<200;i++){try{process.kill(pid,0)}catch{return}await new Promise(r=>setTimeout(r,25))}throw new Error('the owned framework service did not stop')};
try {
 const official=process.env.SENTINEL_SARIF_SCHEMA?new(createRequire(join(c.dir,'package.json'))('ajv').Ajv)({strict:false,validateFormats:false,unicodeRegExp:false}).compile(JSON.parse(readFileSync(process.env.SENTINEL_SARIF_SCHEMA))):null;
 const checkSarif=doc=>{if(official)assert.equal(official(doc),true,JSON.stringify(official.errors))};
 const scratch=realpathSync.native(c.scratch);
 const ws=join(scratch,'workspace');mkdirSync(join(ws,'src'),{recursive:true});
 writeFileSync(join(ws,'package.json'),JSON.stringify({name:'original-inspection-example',version:'1.0.0',dependencies:{express:'4.21.2'}}));
 writeFileSync(join(ws,'package-lock.json'),JSON.stringify({name:'original-inspection-example',lockfileVersion:3,packages:{'':{dependencies:{express:'4.21.2'}},'node_modules/express':{version:'4.21.2',resolved:'https://registry.npmjs.org/express/-/express-4.21.2.tgz'}}}));
 writeFileSync(join(ws,'src/routes.ts'),"import express from 'express'; const app=express(); app.get('/original', (_req,res)=>res.send('example'));\n");
 const env={...c.env,HOME:join(scratch,'home'),XDG_STATE_HOME:join(scratch,'owner')};mkdirSync(env.HOME);
 const bin=c.bin('farsight-sentinel');
 const call=async(...args)=>{try{const r=await c.exec(bin,[...args,'--json'],{cwd:ws,env});return{status:0,body:JSON.parse(r.stdout)}}catch(e){if(typeof e.code!=='number')throw e;return{status:e.code,body:JSON.parse(e.stdout)}}};
 assert.equal((await call('init')).status,0);
 const settings=join(ws,'.farsight/sentinel/settings.json');
 writeFileSync(settings,JSON.stringify({...JSON.parse(readFileSync(settings)),mandatoryRules:['sentinel.controls.authentication','sentinel.controls.authorization','sentinel.controls.input-validation']}));
 const adopted=await call('settings','adopt','--confirm');assert.equal(adopted.status,0,JSON.stringify(adopted));
 assert.equal((await call('rules','promote','builtin:framework-controls','--confirm')).status,0);
 const plan=await call('plan');assert.equal(plan.status,0,JSON.stringify(plan));
 const id=plan.body.facts.planId;assert.equal(plan.body.facts.unitIds.length,1);
 const full=async(run,format)=>{try{return(await c.exec(bin,['report',run,'--full','--format',format],{cwd:ws,env})).stdout}catch(e){if(![0,2].includes(e.code))throw e;return e.stdout}};
 const started=performance.now();const run=await call('run',id);
 assert.equal(run.status,2,JSON.stringify(run));assert.equal(run.body.facts.state,'completed');
 const cleanJson=await full(id,'json'),cleanHtml=await full(id,'html');
 if(process.env.FARSIGHT_FRAMEWORK_EVIDENCE){mkdirSync(process.env.FARSIGHT_FRAMEWORK_EVIDENCE,{recursive:true,mode:0o700});writeFileSync(join(process.env.FARSIGHT_FRAMEWORK_EVIDENCE,'clean.json'),cleanJson,{mode:0o600});writeFileSync(join(process.env.FARSIGHT_FRAMEWORK_EVIDENCE,'clean.html'),cleanHtml,{mode:0o600});}
 const before=JSON.parse(cleanJson);assert.equal(before.inspections.length,1);assert.equal(before.findings.length,0);assert.equal(before.inspections[0].assessment,'none');
 assert.match(await full(id,'md'),/Framework control inspection/);assert.match(await full(id,'html'),/Framework control inspection/);const sarif=JSON.parse(await full(id,'sarif'));checkSarif(sarif);assert.deepEqual(sarif.runs[0].properties.inspections,before.inspections);assert.equal(sarif.runs[0].results.length,0);
 const entries=join(env.XDG_STATE_HOME,'farsight/sentinel/trust/adapters/framework-controls');
 const names=readdirSync(entries).filter(n=>n.endsWith('.mjs'));assert.equal(names.length,1);
 const name=names[0],entry=readFileSync(join(entries,name));
 assert.equal(name,`framework-controls-${createHash('sha256').update(entry).digest('hex')}.mjs`);
 const closure=JSON.parse(/const CLOSURE = (.*);/.exec(entry.toString())[1]);
 const installed=join(realpathSync.native(c.dir),'node_modules/farsight-sentinel');
 const files=[];const walk=p=>{for(const n of readdirSync(p,{withFileTypes:true})){const f=join(p,n.name);if(n.isDirectory())walk(f);else files.push(f)}};walk(join(installed,'dist'));
 for(const p of files)assert.ok(closure.some(([f,k])=>f===p&&k==='file'),`entire emitted dist file pinned: ${p}`);
 assert.equal(closure.some(([p,k])=>k==='file'&&p===join(realpathSync.native(c.dir),'package.json')),false,'consumer package is outside the pinned installation');
 const changed=files.find(p=>p.includes('/chunks/')&&p.endsWith('.mjs'));assert.ok(changed);const original=readFileSync(changed);
 writeFileSync(changed,Buffer.concat([original,Buffer.from('\n// installed drift probe\n')]));
 try{const refused=await c.exec(process.execPath,[join(entries,name)],{cwd:ws,env}).then(r=>({code:0,...r}),e=>e);assert.equal(refused.code,71);assert.equal(refused.stdout,'','no protocol before closure refusal')}finally{writeFileSync(changed,original)}
 const dependency=join(realpathSync.native(c.dir),'node_modules/ajv/dist/compile/index.js'),depOriginal=readFileSync(dependency);writeFileSync(dependency,Buffer.concat([depOriginal,Buffer.from('\n// transitive drift probe\n')]));
 try{const refused=await c.exec(process.execPath,[join(entries,name)],{cwd:ws,env}).then(r=>({code:0,...r}),e=>e);assert.equal(refused.code,71);assert.equal(refused.stdout,'')}finally{writeFileSync(dependency,depOriginal)}
 const status=await call('status',id);assert.equal(status.body.facts.state,'completed',JSON.stringify(status));
 assert.deepEqual(readdirSync(entries).filter(n=>n.endsWith('.mjs')),names,'same installed build in a second process reuses exact entry');
 renameSync(join(ws,'src'),join(scratch,'source-away'));
 const child=await call('rerun',id,'--stage',plan.body.facts.unitIds[0]);assert.equal(child.status,0,JSON.stringify(child));
 const reran=await call('run',child.body.facts.runId);assert.equal(reran.body.facts.state,'completed',JSON.stringify(reran));
 const replay=JSON.parse(await full(id,'json'));assert.deepEqual({...replay,evaluatedAt:null},{...before,evaluatedAt:null},'read-only source-removed parent replay');
 const childReport=JSON.parse(await full(child.body.facts.runId,'json'));assert.deepEqual(childReport.inspections[0].rows,before.inspections[0].rows);
 renameSync(join(scratch,'source-away'),join(ws,'src'));
 // Optional native privacy acceptance uses only the already provisioned pinned Gitleaks image. No acquisition.
 if(process.env.SENTINEL_ISOLATION==='1'){
  const value=['Sntl','Fxt9q2','Lr7Wv4','Zk8Jm3','Pd6Hy1','Tb5Qe0'].join('');
  const secretPack=JSON.parse(readFileSync(join(installed,'rules/secrets/sentinel-pack.json')));
  writeFileSync(settings,JSON.stringify({...JSON.parse(readFileSync(settings)),mandatoryRules:['sentinel.controls.authentication','sentinel.controls.authorization','sentinel.controls.input-validation',...secretPack.rules.map(r=>r.familyId)]}));
  writeFileSync(join(ws,'.env'),`api_key = "${value}"\n`);writeFileSync(join(ws,'src/routes.ts'),`import express from 'express';const app=express();app.get('/${value}',(_req,res)=>res.send('example'));\n`);
  assert.equal((await call('settings','adopt','--confirm')).status,0);assert.equal((await call('rules','promote','builtin:secrets','--confirm')).status,0);
  const tool=await call('assets','adopt-tool','secrets-gitleaks','--confirm');assert.equal(tool.status,0,JSON.stringify(tool));
  const secretPlan=await call('plan');assert.equal(secretPlan.status,0,JSON.stringify(secretPlan));const secretRun=await call('run',secretPlan.body.facts.planId);assert.equal(secretRun.body.facts.state,'completed',JSON.stringify(secretRun));
  const secretJson=await full(secretPlan.body.facts.planId,'json'),secretHtml=await full(secretPlan.body.facts.planId,'html'),secretDoc=JSON.parse(secretJson);
  assert.ok(secretDoc.findings.length>0,'genuine accepted secret scan');assert.match(secretDoc.inspections[0].sourceId,/^withheld-/);
  for(const format of ['json','md','html','sarif']){const text=await full(secretPlan.body.facts.planId,format);assert.equal(text.includes(value),false,'installed inspection privacy in '+format);if(format==='sarif')checkSarif(JSON.parse(text))}
  const minimal=await call('report',secretPlan.body.facts.planId);assert.equal(JSON.stringify(minimal).includes(value),false,'minimal report privacy');
  if(process.env.FARSIGHT_FRAMEWORK_EVIDENCE){writeFileSync(join(process.env.FARSIGHT_FRAMEWORK_EVIDENCE,'secret.json'),secretJson,{mode:0o600});writeFileSync(join(process.env.FARSIGHT_FRAMEWORK_EVIDENCE,'secret.html'),secretHtml,{mode:0o600});}
  rmSync(join(ws,'.env'));writeFileSync(settings,JSON.stringify({...JSON.parse(readFileSync(settings)),mandatoryRules:['sentinel.controls.authentication','sentinel.controls.authorization','sentinel.controls.input-validation']}));assert.equal((await call('settings','adopt','--confirm')).status,0);
 }
 // Actual service death while a shipped inspection attempt is running. The original wide source is parsed, never
 // executed; its size makes the in-flight boundary observable without replacing the production worker or driver.
 writeFileSync(join(ws,'src/routes.ts'),"import express from 'express';const app=express();\n"+Array.from({length:2048},(_,i)=>`app.get('/item${i}',(_req,res)=>res.send('example'));`).join('\n')+'\n');
 const crashPlan=await call('plan');assert.equal(crashPlan.status,0,JSON.stringify(crashPlan));const crashId=crashPlan.body.facts.planId;
 let cursor=0;for(;;){const status=await call('status',crashId,'--after',String(cursor),'--limit','1000');cursor=status.body.facts.cursor;if(!status.body.facts.more)break}
 const beforeAttempt=cursor;
 const detached=await call('run',crashId,'--detach','--confirm');assert.equal(detached.body.outcome,'submitted',JSON.stringify(detached));
 const services=join(env.XDG_STATE_HOME,'farsight/sentinel/trust/services');const descriptors=readdirSync(services).filter(n=>n.endsWith('.json'));assert.equal(descriptors.length,1);
 const pid=JSON.parse(readFileSync(join(services,descriptors[0]))).pid;assert.ok(Number.isSafeInteger(pid)&&pid>0);servicePids.add(pid);
 let inFlight=false;for(let i=0;i<100;i++){const status=await call('status',crashId,'--after',String(beforeAttempt),'--limit','1000');const events=status.body.facts.events;
  if(events.some(e=>e.kind==='attempt-started')&&!events.some(e=>e.kind==='work-published')&&status.body.facts.state==='running'){inFlight=true;break}
  if(status.body.facts.state==='completed')break;await new Promise(r=>setTimeout(r,10));}
 assert.ok(inFlight,'the real installed inspection reached an unpublished in-flight attempt');process.kill(pid,'SIGKILL');await gone(pid);servicePids.delete(pid);
 const resumed=await call('run',crashId);assert.equal(resumed.body.facts.state,'completed',JSON.stringify(resumed));
 let publications=0,attempts=0;cursor=beforeAttempt;for(;;){const status=await call('status',crashId,'--after',String(cursor),'--limit','1000');for(const e of status.body.facts.events){publications+=Number(e.kind==='work-published');attempts+=Number(e.kind==='attempt-started')}cursor=status.body.facts.cursor;if(!status.body.facts.more)break}
 assert.equal(publications,1,'the resumed inspection publishes once');assert.ok(attempts>=2,'the interrupted attempt is not reused as a success');
 assert.equal(JSON.parse(await full(crashId,'json')).inspections.length,1);
 console.log(JSON.stringify({consumer:'framework',distFiles:files.length,closureEntries:closure.length,entryBytes:entry.length,runMs:Math.round(performance.now()-started),sourceRemovedSelected:true,crashRecovered:true,officialSarif:Boolean(official)}));
}finally{
 for(const pid of servicePids){try{process.kill(pid,'SIGTERM')}catch{}await gone(pid)}
 // A killed service can leave sealed readonly inputs in its retained scratch lease, inside the store. Only this
 // consumer's store scratch is unlocked, after its exact recorded services stopped; links are never followed and a
 // bounded rm retry handles delayed directory removal.
 const orphan=join(realpathSync.native(c.scratch),'workspace/.farsight/sentinel/store/scratch');
 const unlock=p=>{const st=lstatSync(p);if(st.isSymbolicLink())return;if(st.isDirectory()){chmodSync(p,0o700);for(const n of readdirSync(p))unlock(join(p,n))}else chmodSync(p,0o600)};
 if(existsSync(orphan))unlock(orphan);
 rmSync(c.scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
