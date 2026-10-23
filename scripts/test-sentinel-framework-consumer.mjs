#!/usr/bin/env node
// Public npm-only framework inspection: original inert source, owner promotion and retained evidence. The worker
// executes Sentinel's trusted code, never this application's code. Set FARSIGHT_NPM_OFFLINE_CACHE for offline use.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
 // An original guarded route beside an otherwise identical one with no control, and arbitrary application files
 // under .farsight: the canonical capture leaves out only the held store, so nothing here is a capture gap.
 writeFileSync(join(ws,'src/routes.ts'),"import express from 'express';\nconst app=express();\nfunction requireUser(req,res,next){ if(!req.user) return res.status(401).end(); next(); }\napp.get('/open', (_req,res)=>res.send('example'));\napp.get('/guarded', requireUser, (_req,res)=>res.send('example'));\n");
 mkdirSync(join(ws,'.farsight/custom'),{recursive:true});writeFileSync(join(ws,'.farsight/custom/notes.md'),'# original notes kept with the application\n');
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
 // The ordinary installed layout states the modeled answers with no capture gap: no control before /open's handler
 // (does-not-apply, never a missing-control finding), and /guarded's cited refusal the pack cannot prove (unknown).
 const inspection=before.inspections[0];
 assert.equal(JSON.stringify(inspection).includes('sourceIncomplete'),false,'no capture gap in the default installed layout');
 const answer=(route,property)=>inspection.rows.find(r=>r.surfaceId===`workspace::route::${route}`&&r.property===property);
 for(const p of ['authentication','authorization']){
  assert.deepEqual([answer('GET /open',p)?.state,answer('GET /open',p)?.verdict],['established','does-not-apply'],`/open ${p}`);
  assert.deepEqual([answer('GET /guarded',p)?.state,answer('GET /guarded',p)?.reasonCode],['partial','sentinel.express.refusalUnproven'],`/guarded ${p}`);
 }
 // The run's scratch lease lived inside the held store and was released once its consumers were proven stopped.
 assert.deepEqual(readdirSync(join(ws,'.farsight/sentinel/store/scratch')),[],'no scratch lease left after a clean run');
 assert.equal(existsSync(join(ws,'.farsight/sentinel/scratch')),false,'nothing beside the store');
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
 assert.ok(inFlight,'the real installed inspection reached an unpublished in-flight attempt');
 const storeScratch=join(ws,'.farsight/sentinel/store/scratch');
 const crashLeases=readdirSync(storeScratch,{withFileTypes:true}).filter(e=>e.isDirectory()).flatMap(epoch=>readdirSync(join(storeScratch,epoch.name),{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name.startsWith('w-')).map(e=>join(storeScratch,epoch.name,e.name)));
 assert.equal(crashLeases.length,1,'one active service lease before the owned crash');
 const crashedLease=crashLeases[0],leaseIdentity=lstatSync(crashedLease,{bigint:true});
 process.kill(pid,'SIGKILL');await gone(pid);servicePids.delete(pid);
 const resumed=await call('run',crashId);assert.equal(resumed.body.facts.state,'completed',JSON.stringify(resumed));
 let publications=0,attempts=0;cursor=beforeAttempt;for(;;){const status=await call('status',crashId,'--after',String(cursor),'--limit','1000');for(const e of status.body.facts.events){publications+=Number(e.kind==='work-published');attempts+=Number(e.kind==='attempt-started')}cursor=status.body.facts.cursor;if(!status.body.facts.more)break}
 assert.equal(publications,1,'the resumed inspection publishes once');assert.ok(attempts>=2,'the interrupted attempt is not reused as a success');
 assert.equal(JSON.parse(await full(crashId,'json')).inspections.length,1);
 const retainedLease=lstatSync(crashedLease,{bigint:true});assert.deepEqual([retainedLease.dev,retainedLease.ino],[leaseIdentity.dev,leaseIdentity.ino],'prior-epoch lease remains private after real service recovery');
 // CP-B: accepted retained reporting needs no worker asset; new registration and execution still require it.
 for(const owned of [...servicePids]){process.kill(owned,'SIGTERM');await gone(owned);servicePids.delete(owned)}
 renameSync(join(ws,'src'),join(scratch,'final-source-away'));
 const normalize=text=>text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g,'<report-time>').replace(/(as of )\S+( \(ledger sequence)/,'$1<report-time>$2');
 const legacy={};for(const format of ['json','md','html','sarif'])legacy[format]=normalize(await full(id,format));
 const minimalBefore=normalize(JSON.stringify(await call('report',id)));
 const workerPath=join(installed,'dist/frameworks/controls/worker.mjs'),gatePath=join(installed,'dist/execution/launch-gate.mjs');
 // The actual installed gate and registered closure entry, after registration. These child controls prove the
 // whole-dist/manifest startup fence, independently of the earlier pre-execution profile and resolver fences.
 for(const part of ['worker','gate','manifest']){
  const target=part==='worker'?workerPath:part==='gate'?gatePath:join(installed,'package.json'),original=readFileSync(target);
  try{
   if(part==='manifest'){const pkg=JSON.parse(original);pkg.description+=' startup verification probe';writeFileSync(target,JSON.stringify(pkg));}
   else writeFileSync(target,Buffer.concat([original,Buffer.from('\n// installed startup verification probe\n')]));
   const token=randomUUID();
   const child=spawnSync(process.execPath,['--import',gatePath,join(entries,name),'/unused-input','/unused-output',`--sentinel-token=${token}`],
    {cwd:ws,env:{SENTINEL_INPUT:'/unused-input',SENTINEL_OUTPUT:'/unused-output',SENTINEL_ADAPTER_ID:'framework-controls',SENTINEL_ADAPTER_DIGEST:'unused-before-hello'},
     input:`sentinel-launch ${token}\n`,encoding:'utf8',timeout:10000});
   assert.equal(child.error,undefined);assert.equal(child.status,71,part);assert.equal(child.signal,null);assert.equal(child.stdout,'',part+' has zero protocol bytes');assert.equal(child.stderr,'',part+' has no raw diagnostic');
  }finally{writeFileSync(target,original)}
 }

 const driverPath=join(installed,'dist/frameworks/controls/driver.mjs'),manifestPath=join(installed,'package.json');
 const manifestBytes=readFileSync(manifestPath),manifest=JSON.parse(manifestBytes);
 assert.ok(existsSync(driverPath)&&existsSync(workerPath)&&existsSync(gatePath));
 assert.ok(!Object.hasOwn(manifest.sentinel.assets,'frameworks/controls/driver'));
 const refusalDir=join(scratch,'refused-entries');mkdirSync(refusalDir,{mode:0o700});
 const registration=async()=>c.exec(process.execPath,['--input-type=module','-e',`
   import assert from 'node:assert/strict';import{readdirSync}from'node:fs';
   const{frameworkControlsAdapter}=await import(${JSON.stringify('file://'+driverPath)});
   assert.throws(()=>frameworkControlsAdapter({entryDir:${JSON.stringify(refusalDir)}}),e=>e.code==='sentinel.execution.adapterInvalid');
   assert.deepEqual(readdirSync(${JSON.stringify(refusalDir)}),[]);
 `],{cwd:ws,env});
 renameSync(workerPath,workerPath+'.held');writeFileSync(workerPath.replace(/\.mjs$/,'.js'),readFileSync(workerPath+'.held'));
 try{
  for(const format of ['json','md','html','sarif'])assert.equal(normalize(await full(id,format)),legacy[format],`missing-worker retained ${format}`);
  assert.equal(normalize(JSON.stringify(await call('report',id))),minimalBefore,'missing-worker minimal report');
  await registration();
 }finally{rmSync(workerPath.replace(/\.mjs$/,'.js'));renameSync(workerPath+'.held',workerPath)}
 for(const fault of ['missing-pin','wrong-path','wrong-sha']){
  const changed=JSON.parse(manifestBytes);if(fault==='missing-pin')delete changed.sentinel.assets['frameworks/controls/worker'];
  if(fault==='wrong-path')changed.sentinel.assets['frameworks/controls/worker'].path='dist/frameworks/controls/worker.js';
  if(fault==='wrong-sha')changed.sentinel.assets['frameworks/controls/worker'].sha256='0'.repeat(64);
  writeFileSync(manifestPath,JSON.stringify(changed));try{await registration()}finally{writeFileSync(manifestPath,manifestBytes)}
 }
 // Actual installed dist shadow/link and missing fixed-export controls keep the same whole-dist boundary.
 const freshRefusal=async()=>c.exec(process.execPath,['--input-type=module','-e',`
  import assert from 'node:assert/strict';let refused=false;
  try{const{frameworkControlsAdapter}=await import(${JSON.stringify('file://'+driverPath)});frameworkControlsAdapter({entryDir:${JSON.stringify(refusalDir)}})}catch{refused=true}
  assert.ok(refused,'the changed installed build cannot register');
 `],{cwd:ws,env});
 const shadow=join(installed,'dist/node_modules');mkdirSync(shadow);
 try{await c.exec(process.execPath,['--input-type=module','-e',`
  import assert from 'node:assert/strict';import{readdirSync}from'node:fs';
  const{frameworkControlsAdapter}=await import(${JSON.stringify('file://'+driverPath)});
  assert.throws(()=>frameworkControlsAdapter({entryDir:${JSON.stringify(refusalDir)}}),{message:'the shipped dist tree contains a dependency shadow'});
  assert.deepEqual(readdirSync(${JSON.stringify(refusalDir)}),[]);
 `],{cwd:ws,env})}finally{rmSync(shadow,{recursive:true})}
 const driverHeld=driverPath+'.held';renameSync(driverPath,driverHeld);
 try{await freshRefusal()}finally{renameSync(driverHeld,driverPath)}
 const workerOriginal=readFileSync(workerPath),withoutExport=workerOriginal.toString().replace(/^  runFrameworkControlsWorker\n/m,'');
 assert.notEqual(withoutExport,workerOriginal.toString(),'the real emitted fixed export was removed');
 const changedManifest=JSON.parse(manifestBytes);changedManifest.sentinel.assets['frameworks/controls/worker'].sha256=createHash('sha256').update(withoutExport).digest('hex');
 writeFileSync(workerPath,withoutExport);writeFileSync(manifestPath,JSON.stringify(changedManifest));
 try{
  const exportEntries=join(scratch,'missing-export-entries');mkdirSync(exportEntries,{mode:0o700});
  const created=await c.exec(process.execPath,['--input-type=module','-e',`const{frameworkControlsAdapter}=await import(${JSON.stringify('file://'+driverPath)});console.log(frameworkControlsAdapter({entryDir:${JSON.stringify(exportEntries)}}).definition.module)`],{cwd:ws,env});
  const refused=await c.exec(process.execPath,[created.stdout.trim()],{cwd:ws,env}).then(r=>({code:0,...r}),e=>e);
  assert.equal(refused.code,71);assert.equal(refused.stdout,'');
 }finally{writeFileSync(workerPath,workerOriginal);writeFileSync(manifestPath,manifestBytes)}
 // Genuine npm install nested inside a workspace-shaped consumer: malformed/wrong own manifests cannot select
 // the enclosing unpinned .js decoys. Import first so the assertion exercises our resolver, not Node's loader.
 await c.exec(process.execPath,['--input-type=module','-e',`
  import assert from 'node:assert/strict';import{readFileSync,writeFileSync,mkdirSync,rmSync,readdirSync}from'node:fs';import{join,dirname}from'node:path';
  const{frameworkControlsAdapter}=await import(${JSON.stringify('file://'+driverPath)});
  const own=${JSON.stringify(manifestPath)},outer=${JSON.stringify(join(c.dir,'package.json'))},outerDist=${JSON.stringify(join(c.dir,'dist'))};
  const ownBytes=readFileSync(own),outerBytes=readFileSync(outer);
  try{
   writeFileSync(outer,JSON.stringify({name:'@farsight/sentinel',type:'module'}));
   for(const stem of ['frameworks/controls/worker','frameworks/controls/driver','execution/launch-gate']){const p=join(outerDist,stem+'.js');mkdirSync(dirname(p),{recursive:true});writeFileSync(p,'// outer decoy\\n')}
   for(const broken of [null,'{invalid',JSON.stringify({name:'some-other-package',type:'module'})]){
    if(broken===null)rmSync(own);else writeFileSync(own,broken);assert.throws(()=>frameworkControlsAdapter({entryDir:${JSON.stringify(refusalDir)}}),e=>e.code==='sentinel.execution.adapterInvalid');
    assert.deepEqual(readdirSync(${JSON.stringify(refusalDir)}),[]);
   }
  }finally{writeFileSync(own,ownBytes);writeFileSync(outer,outerBytes);rmSync(outerDist,{recursive:true,force:true})}
 `],{cwd:ws,env});
 const hook=join(scratch,'import-audit.mjs');writeFileSync(hook,`
  import assert from 'node:assert/strict';import fs from'node:fs';import Module,{registerHooks,syncBuiltinESMExports}from'node:module';
  const read=fs.readFileSync;fs.readFileSync=function(path,...rest){assert.notEqual(String(path),${JSON.stringify(manifestPath)},'no installed Sentinel manifest read at import/help');return read.call(this,path,...rest)};syncBuiltinESMExports();
  const load=Module._load;Module._load=function(s,...rest){assert.ok(!String(s).includes('oxc-parser'));return load.call(this,s,...rest)};
  registerHooks({load(url,context,next){assert.ok(!/frameworks\\/controls\\/worker\\.mjs|oxc-parser/.test(url));return next(url,context)}});
 `);
 await c.exec(process.execPath,['--import',hook,bin,'--help'],{cwd:ws,env});
 // A fresh real plan/run qualifies the installed launch-gate path and rejects a .js substitute.
 renameSync(join(scratch,'final-source-away'),join(ws,'src'));
 writeFileSync(join(ws,'src/routes.ts'),"import express from 'express';const app=express();app.get('/gate',(_q,r)=>r.send('example'));\n");
 const gatePlan=await call('plan');assert.equal(gatePlan.status,0,JSON.stringify(gatePlan));
 renameSync(gatePath,gatePath+'.held');writeFileSync(gatePath.replace(/\.mjs$/,'.js'),readFileSync(gatePath+'.held'));
 try{
  const refused=await call('run',gatePlan.body.facts.planId);assert.equal(refused.body.outcome,'configuration-failure',JSON.stringify(refused));
  assert.ok(['sentinel.execution.adapterInvalid','sentinel.execution.planInvalid'].includes(refused.body.facts.error),JSON.stringify(refused));
  if(refused.body.facts.error==='sentinel.execution.planInvalid')assert.match(refused.body.facts.reason,/another digest than the profile recorded/);
  assert.equal(refused.body.facts.runOutcome,null,'no worker run is admitted through a .js substitute');
 }
 finally{rmSync(gatePath.replace(/\.mjs$/,'.js'));renameSync(gatePath+'.held',gatePath)}
 console.log(JSON.stringify({consumer:'framework',distFiles:files.length,closureEntries:closure.length,entryBytes:entry.length,runMs:Math.round(performance.now()-started),sourceRemovedSelected:true,crashRecovered:true,crashLeaseRetained:true,officialSarif:Boolean(official),strictAssets:true,missingWorkerLegacyReports:true,nestedManifestRefused:true,installedManifestImportPure:true,installedWorkerGateManifestStartupRefused:true}));
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
