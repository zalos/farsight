#!/usr/bin/env node
// Actual npm-installed owner decisions, retained reports and optional native privacy.
// Uses public commands; read-only ledger queries select genuine work and verify owned cleanup.
// Does not claim service-owned decision writes or installed crash-window qualification.
import {npmConsumer} from './npm-consumer.mjs';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,renameSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {gunzipSync} from 'node:zlib';
const root=resolve(import.meta.dirname,'..'),version=JSON.parse(readFileSync(join(root,'packages/sentinel/package.json'))).version;
const artifact=resolve(process.argv[2]??join(root,'build/sentinel',`farsight-sentinel-${version}.tgz`));
const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const VALUE=['ghp','_','SentinelSynthetic','InertFixture','0000001'].join(''),GENERIC=['Sntl','Fxt9q2','Lr7Wv4','Zk8Jm3','Pd6Hy1','Tb5Qe0'].join('');
const check=(ok,label)=>{if(!ok)throw Error(label)};let stage='install',consumer,services=[];
const evidence={artifactDigest:digest(readFileSync(artifact)),offline:!!process.env.FARSIGHT_NPM_OFFLINE_CACHE,commands:[],sources:[],scans:[],cases:{}};
function absent(text,label){for(const v of [VALUE,GENERIC])check(!text.includes(v),label)}
try{
 consumer=await npmConsumer('sentinel-decisions-', [artifact]);evidence.consumerDir=consumer.dir;
 const canonical=realpathSync.native(consumer.scratch),ws=join(canonical,'workspace');mkdirSync(join(ws,'src'),{recursive:true});
 const env={...consumer.env,HOME:join(canonical,'home'),XDG_STATE_HOME:join(canonical,'owner-state')};mkdirSync(env.HOME);
 const bin=consumer.bin('farsight-sentinel');evidence.installedBin=bin;
 async function raw(...args){const start=performance.now();let status=0,stdout,stderr;try{({stdout,stderr}=await consumer.exec(bin,args,{cwd:ws,env,timeout:180000,maxBuffer:34*1024*1024}))}catch(e){if(typeof e.code!=='number')throw e;status=e.code;stdout=e.stdout;stderr=e.stderr}
  evidence.commands.push({stage,args:args.map(a=>[VALUE,GENERIC].some(v=>a.includes(v))?'[synthetic-withheld]':a),status,ms:performance.now()-start,stdoutBytes:Buffer.byteLength(stdout),stderrBytes:Buffer.byteLength(stderr)});return{status,stdout,stderr};}
 async function call(...args){const r=await raw(...args,'--json');let body;try{body=JSON.parse(r.stdout)}catch{throw Error('non-JSON executable response')};evidence.commands.at(-1).outcome=body.outcome;evidence.commands.at(-1).reasonCode=body.reasonCode??null;return{...r,body}}
 function source(name,content){writeFileSync(join(ws,name),content);evidence.sources.push({stage,path:name,bytes:Buffer.byteLength(content),content:digest(Buffer.from(content))})}
 function settings(){const path=join(ws,'.farsight/sentinel/settings.json');return{path,value:JSON.parse(readFileSync(path))}}
 async function adopt(){const r=await call('settings','adopt','--confirm');check(r.status===0,'settings adoption')}
 async function planRun(){const p=await call('plan');check(p.status===0,'plan');const id=p.body.facts.runId??p.body.facts.planId;check(typeof id==='string','plan ID');const r=await call('run',id,'--confirm');check(r.body.facts.state==='completed','run completion');evidence.scans.push({stage,runId:id,exit:r.status,observations:r.body.facts.observations??null});return id}
 async function report(id,baseline,disclosure='private',format='json'){const r=await raw('report',id,'--full','--format',format,'--disclosure',disclosure,...(baseline?['--baseline',baseline]:[]));check(r.status===0,'full report delivery');return r.stdout}
 // compare is the actual public baseline command, not a synthetic report option.
 async function comparison(id,baseline,disclosure='private',format='json'){const r=await raw('compare',id,baseline,'--format',format,'--disclosure',disclosure);check(r.status===0,'comparison delivery');return r.stdout}
 async function propose(run,finding,decision='accepted-risk',extra={}){const path=join(consumer.scratch,'proposal.json');writeFileSync(path,JSON.stringify({schema:'sentinel-decision-input/draft-1',decision,rationale:'Original owner <review> & `quoted` rationale',evidence:[],expiresAt:null,supersedes:null,...extra}));const r=await call('decision','propose',run,'--finding',finding,'--proposal',path);check(r.body.outcome==='proposed','proposal');return r.body.facts.decisionId}
 async function approve(id){const waiting=await call('decision','approve',id);check(waiting.status===4&&waiting.body.outcome==='awaiting-confirmation','approval waits');const a=await call('decision','approve',id,'--confirm');check(a.body.outcome==='applied'&&a.status===0,'approval applies');return a}
 stage='installed-clean';source('src/lookup.ts','export const lookup = (id) => db.query("SELECT * FROM invoice WHERE id = " + id);\n');check((await call('init')).status===0,'init');
 const s=settings();s.value.grants.push({actions:['disposition.propose','disposition.approve'],principals:['human'],scope:{profiles:['static-scanners'],effects:['local-artifacts']}});writeFileSync(s.path,JSON.stringify(s.value));await adopt();check((await call('rules','promote','builtin:foundation-preview','--confirm')).status===0,'preview rules');
 const initial=await planRun(),doc=JSON.parse(await report(initial));check(doc.findings.length===1,'one actual preview finding');const finding=doc.findings[0].id;
 const id=await propose(initial,finding),waitingRead=await call('decision','read',id);check(waitingRead.body.facts.document.decision.state==='open','unapproved stays open');await approve(id);
 const read=await call('decision','read',id);check(read.body.facts.document.decision.state==='accepted-risk','accepted risk');
 const page=await call('decision','list',initial);check(page.body.facts.document.items.length===1&&page.body.facts.document.count.n===1,'bounded actual list');
 for(const d of ['private','shareable'])for(const format of ['json','md','html','sarif']){const text=await report(initial,null,d,format);check(text.replaceAll('\\','').includes(id),'all renderers contain real decision');if(format==='json'){const v=JSON.parse(text);check(v.decisionEvaluation.status==='complete','complete decision section');check(v.decisions[0].rationale===(d==='private'?'Original owner <review> & `quoted` rationale':null),'disclosure rationale')}}
 const replacement=await propose(initial,finding,'false-positive',{supersedes:id});await approve(replacement);const superseded=await call('decision','read',id);check(superseded.body.facts.document.decision.reasonCode==='sentinel.decision.reason.superseded','supersession');
 const expired=await propose(initial,finding,'accepted-risk',{supersedes:replacement,expiresAt:new Date(Date.now()+10000).toISOString()});await approve(expired);await new Promise(r=>setTimeout(r,10500));check((await call('decision','read',expired)).body.facts.document.decision.validity==='expired','expiry reopens');
 evidence.cases.installedHappy={runId:initial,decision:id,replacement,expired,allFormats:true,privateAndShareable:true};
 // Actual service ownership. Local refusal must not renew or impersonate the owner.
 stage='installed-busy';source('src/lookup.ts','export const lookup = (id) => db.query("SELECT * FROM invoice WHERE id = " + id);\n// original detached generation\n');const planned=await call('plan'),detached=planned.body.facts.runId??planned.body.facts.planId;check((await call('run',detached,'--detach','--confirm')).body.outcome==='submitted','detached starts');check((await call('wait',detached,'--timeout','60000')).body.facts.state==='completed','detached completes');
 const descriptorDir=join(env.XDG_STATE_HOME,'farsight/sentinel/trust/services');for(const n of readdirSync(descriptorDir).filter(n=>n.endsWith('.json'))){const p=join(descriptorDir,n),bytes=readFileSync(p,'utf8'),v=JSON.parse(bytes);if(Number.isSafeInteger(v.pid))services.push({path:p,bytes,pid:v.pid})}
 const busy=await call('decision','propose',initial,'--finding',finding,'--proposal',join(consumer.scratch,'DO-NOT-READ'),'--confirm');check(busy.body.reasonCode==='sentinel.decision.ownerBusy','local owner busy before file');
 const until=Date.now()+90000;let released=false;while(Date.now()<until){await new Promise(r=>setTimeout(r,1000));const r=await call('decision','read',id);if(r.body.reasonCode!=='sentinel.decision.ownerBusy'){check(r.status===0,'natural owner release');released=true;break}}check(released,'natural release bound');evidence.cases.installedBusy={naturalRelease:true,noForcedStop:true};
 stage='installed-source-gone';renameSync(join(ws,'src'),join(consumer.scratch,'source-away'));check((await call('decision','read',id)).status===0,'retained sourcegone read');check(JSON.parse(await report(initial)).counts.findings.n===1,'retained sourcegone report');evidence.cases.sourceGone=true;
 if(process.env.SENTINEL_ISOLATION==='1'){
  stage='native-current';renameSync(join(consumer.scratch,'source-away'),join(ws,'src'));
  source('src/lookup.ts',`export const lookup = (id) => db.query("SELECT * FROM invoice WHERE api_key = '${GENERIC}' AND id = " + id);\n`);source('src/'+VALUE+'.ts','export const originalName = 1;\n');
  const installed=join(consumer.dir,'node_modules/farsight-sentinel'),secrets=JSON.parse(readFileSync(join(installed,'rules/secrets/sentinel-pack.json'))),preview=JSON.parse(readFileSync(join(installed,'rules/foundation-preview/sentinel-pack.json'))),setting=settings();setting.value.mandatoryRules=[...secrets.rules,...preview.rules].map(r=>r.familyId);writeFileSync(setting.path,JSON.stringify(setting.value));await adopt();check((await call('rules','promote','builtin:secrets','--confirm')).status===0,'secrets rules');check((await call('assets','adopt-tool','secrets-gitleaks','--confirm')).status===0,'adopt existing image');
  const secret=await planRun(),secretDoc=JSON.parse(await report(secret)),previewFinding=secretDoc.findings.find(f=>f.ruleFamilyId===preview.rules[0].familyId);check(previewFinding,'actual preview finding in secret run');
  const privateRationale=VALUE+' '+GENERIC+' original owner source rationale';
  const secretDecision=await propose(secret,previewFinding.id,'accepted-risk',{rationale:privateRationale});const secretApproval=await approve(secretDecision);absent(JSON.stringify(secretApproval.body),'secret approval privacy');
  const current=await call('decision','read',secretDecision);check(current.body.facts.document.withheld===true&&current.body.facts.document.decision.basisDigest===null&&current.body.facts.document.decision.rationale===null,'secret decision fields withheld');absent(JSON.stringify(current.body),'secret current read');
  for(const d of ['private','shareable'])for(const format of ['json','md','html','sarif'])absent(await report(secret,null,d,format),'secret current report');
  const ledger=join(ws,'.farsight/sentinel/store/ledger.sqlite'),db=new DatabaseSync(ledger,{readOnly:true});let previewUnit;try{const row=db.prepare('SELECT plan_id FROM plans WHERE run_id=? ORDER BY revision DESC LIMIT 1').get(secret),hex=row.plan_id.slice(7),base=join(ws,'.farsight/sentinel/store/objects/sha256',hex.slice(0,2),hex),bytes=existsSync(base+'.raw')?readFileSync(base+'.raw'):gunzipSync(readFileSync(base+'.gzip'),{maxOutputLength:8<<20});check(digest(bytes)===row.plan_id,'recorded plan hash');previewUnit=JSON.parse(bytes).units.find(w=>w.adapterId==='sentinel.preview.detector'&&w.inputs.some(i=>i.relativePath==='src/lookup.ts'))?.id}finally{db.close()}check(previewUnit,'real selected unit');
  stage='native-clean-baseline';source('src/lookup.ts','export const lookup = (id) => db.query("SELECT * FROM invoice WHERE id = " + id);\n');rmSync(join(ws,'src',VALUE+'.ts'));const clean=await planRun(),cleanDoc=JSON.parse(await report(clean)),cleanFinding=cleanDoc.findings.find(f=>f.ruleFamilyId===preview.rules[0].familyId);check(cleanFinding,'clean actual finding');
  // The initial clean source's expired approval is a predecessor only if the actual finding identity agrees.
  const cleanDecision=await propose(clean,cleanFinding.id,'accepted-risk',{rationale:privateRationale,supersedes:cleanFinding.id===finding?expired:null});await approve(cleanDecision);
  const normal=await call('decision','read',cleanDecision);check(normal.body.facts.document.withheld===false&&normal.body.facts.document.decision.rationale===privateRationale,'clean useful owner detail');
  const baseline=await call('decision','read',cleanDecision,'--baseline',secret);check(baseline.body.facts.document.withheld===true,'baseline decision withheld');absent(JSON.stringify(baseline.body),'baseline-only decision');
  for(const d of ['private','shareable'])for(const format of ['json','md','html','sarif'])absent(await comparison(clean,secret,d,format),'baseline report privacy');
  stage='native-selected';renameSync(join(ws,'src'),join(consumer.scratch,'source-away-native'));const childPlan=await call('rerun',secret,'--stage',previewUnit);check(childPlan.status===0,'retained selected child admission');const child=childPlan.body.facts.runId;check((await call('run',child,'--confirm')).body.facts.state==='completed','sourcegone selected executes');
  const childDoc=JSON.parse(await report(child)),childFinding=childDoc.findings.find(f=>f.ruleFamilyId===preview.rules[0].familyId);check(childFinding,'selected actual finding');
  const childDecision=await propose(child,childFinding.id,'accepted-risk',{rationale:privateRationale,supersedes:childFinding.id===previewFinding.id?secretDecision:null});await approve(childDecision);
  const childRead=await call('decision','read',childDecision);check(childRead.body.facts.document.withheld===true,'selected inherited privacy');absent(JSON.stringify(childRead.body),'selected owner decision');
  for(const d of ['private','shareable'])for(const format of ['json','md','html','sarif'])absent(await report(child,null,d,format),'selected report privacy');
  const observed=await call('report',child),rows=observed.body.facts.report.observations;check(!rows.some(o=>o.value.producer?.adapterId==='secrets-gitleaks'||o.value.adapter==='secrets-gitleaks'),'selected does not copy ancestor secret findings');
  const records=new DatabaseSync(ledger,{readOnly:true}),containers=[];let storeId;try{storeId=records.prepare('SELECT store_id FROM ledger_store WHERE singleton=1').get()?.store_id;check(typeof storeId==='string','actual store identity');for(const r of records.prepare('SELECT envelope,final_envelope FROM attempts').all()){const a=JSON.parse(r.final_envelope??r.envelope);if(a.worker.kind==='owned-container')containers.push({id:a.worker.containerId,labels:a.worker.ownershipLabels,attemptId:a.id,invocation:a.invocation})}}finally{records.close()}
  check(containers.length>=2,'actual Gitleaks container attempts');for(const own of containers){check(own.labels.store===storeId,'container belongs to exact test store');check(/^[0-9a-f]{64}$/.test(own.id),'owned container ID');check(execFileSync('docker',['container','ls','--all','--no-trunc','--filter','id='+own.id,'--format','{{.ID}}'],{encoding:'utf8',timeout:10000}).trim()==='','exact own container removed')}
  evidence.cases.nativePrivacy={secret,clean,child,secretDecision,cleanDecision,childDecision,current:true,baseline:true,selected:true,sourceGone:true,bothProfiles:true,allFourFormats:true,cleanUseful:true,noAncestorFindingsCopied:true,ownContainers:containers,cleanupConfirmed:true};
 }
 stage='done';evidence.success=true;
}catch(error){evidence.success=false;evidence.failedStage=stage;evidence.failure={code:typeof error?.code==='string'?error.code:null,message:String(error?.message??'qualification failure').replaceAll(VALUE,'[synthetic]').replaceAll(GENERIC,'[synthetic]').slice(0,2048)};if(consumer)writeFileSync(join(consumer.scratch,'decision-consumer-failure.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.error(JSON.stringify({success:false,stage,failure:evidence.failure}));process.exitCode=1}
finally{
 // Detached services own their natural idle shutdown. Never signal a descriptor pid.
 const alive=pid=>{try{process.kill(pid,0);return true}catch(error){return error?.code!=='ESRCH'}};
 const deadline=Date.now()+90000;
 while(services.some(service=>alive(service.pid))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,250));
 if(services.some(service=>alive(service.pid))){
  evidence.success=false;evidence.cleanup='natural-service-exit-unconfirmed';process.exitCode=1;
  if(consumer)writeFileSync(join(consumer.scratch,'decision-consumer-failure.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  console.error(JSON.stringify({success:false,stage:'cleanup',reason:'natural-service-exit-unconfirmed'}));
 }
 if(consumer&&evidence.success)consumer.cleanup();
}
if(evidence.success)console.log(JSON.stringify({success:true,artifact:evidence.artifactDigest,commands:evidence.commands.length,ownerDecisions:true,sourceGone:evidence.cases.sourceGone===true,nativePrivacy:!!evidence.cases.nativePrivacy}));
