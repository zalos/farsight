#!/usr/bin/env node
// Public npm-only owner imports. Product work uses only the installed executable. Readonly SQLite below observes
// one real pending stage so this harness can SIGKILL its OWN import process; it never writes/mints store authority.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {npmConsumer} from './npm-consumer.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),version=JSON.parse(readFileSync(join(root,'packages/sentinel/package.json'))).version;
const artifact=resolve(process.argv[2]??join(root,'build/sentinel',`farsight-sentinel-${version}.tgz`));
assert.ok(existsSync(artifact),'pack Sentinel first');const c=await npmConsumer('sentinel-import-', [artifact]);
const ownedPids=new Set(),serviceRecords=new Map(),children=new Map();const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const dir=realpathSync.native(c.scratch),ws=join(dir,'workspace');mkdirSync(join(ws,'src'),{recursive:true});
 writeFileSync(join(ws,'src/original.ts'),'export const original = 1;\n');
 const env={...c.env,HOME:join(dir,'home'),XDG_STATE_HOME:join(dir,'owner-state')};mkdirSync(env.HOME);
 const bin=c.bin('farsight-sentinel'),settingsPath=join(ws,'.farsight/sentinel/settings.json'),ledger=join(ws,'.farsight/sentinel/store/ledger.sqlite');
 const call=async(...args)=>{try{const r=await c.exec(bin,[...args,'--json'],{cwd:ws,env,timeout:180000,maxBuffer:34*1024*1024});return{status:0,body:JSON.parse(r.stdout)}}catch(e){if(typeof e.code!=='number')throw e;return{status:e.code,body:JSON.parse(e.stdout)}}};
 assert.equal((await call('init')).status,0);const settings=JSON.parse(readFileSync(settingsPath));settings.grants.push({actions:['evidence.import','evidence.abandon'],principals:['human'],scope:{effects:['local-artifacts']}});writeFileSync(settingsPath,JSON.stringify(settings));
 assert.equal((await call('settings','adopt','--confirm')).status,0);assert.equal((await call('rules','promote','builtin:foundation-preview','--confirm')).status,0);
 const plan=await call('plan');assert.equal(plan.status,0);const run=plan.body.facts.planId;assert.equal((await call('run',run)).body.facts.state,'completed');
 const reportPath=join(dir,'original-report.json'),manifestPath=join(dir,'original-manifest.json');
 const original={version:'2.1.0',runs:[{tool:{driver:{name:'original-installed-report',version:'1'}},results:[{ruleId:'external-original',message:{text:'an external claim'}}]}]};
 writeFileSync(reportPath,JSON.stringify(original));writeFileSync(manifestPath,JSON.stringify({schema:'sentinel-import-manifest/draft-1',format:'sarif-2.1.0',producer:{name:null,version:null},tested:{origins:['https://example.test'],methods:['GET'],properties:['cookie-secure'],directions:['outbound']}}));
 const importing=id=>['evidence','import',id,'--source','workspace','--report',reportPath,'--manifest',manifestPath];
 const preview=await call(...importing(run));assert.equal(preview.status,4);const candidate=preview.body.facts.candidateDigest;
 assert.equal((await call(...importing(run),'--confirm','--expect-candidate','sha256:'+'f'.repeat(64))).body.reasonCode,'sentinel.evidence.confirmationStale');
 const accepted=await call(...importing(run),'--confirm','--expect-candidate',candidate);assert.equal(accepted.status,0,JSON.stringify(accepted));assert.equal(accepted.body.outcome,'accepted');assert.equal(accepted.body.facts.document.withheld,false);
 assert.equal((await call(...importing(run),'--confirm')).body.facts.reused,true);
 assert.equal((await call('evidence','list',run,'--source','workspace')).body.facts.document.items.length,1);
 const out=join(dir,'delivery.md');assert.equal((await call('evidence','read',candidate,'--format','md','--out',out)).status,0);assert.match(readFileSync(out,'utf8'),/Imported claims/);
 const fail=await call('evidence','read',candidate,'--out',out);assert.equal(fail.status,3);assert.equal(fail.body.outcome,'delivery-failed');assert.equal(fail.body.facts.acceptance,'retained');
 // A real detached service remains the sole owner. Import calls never connect to it or refresh its activity.
 writeFileSync(join(ws,'src/original.ts'),'export const original = 2;\n');const detached=await call('plan');assert.equal(detached.status,0);const detachedId=detached.body.facts.planId;
 assert.equal((await call('run',detachedId,'--detach','--confirm')).body.outcome,'submitted');assert.equal((await call('wait',detachedId,'--timeout','60000')).body.facts.state,'completed');
 const descriptors=join(env.XDG_STATE_HOME,'farsight/sentinel/trust/services');
 for(const name of readdirSync(descriptors).filter(n=>n.endsWith('.json'))){const d=JSON.parse(readFileSync(join(descriptors,name)));if(Number.isSafeInteger(d.pid)){ownedPids.add(d.pid);serviceRecords.set(d.pid,{path:join(descriptors,name),record:JSON.stringify(d)})}}
 const busy=await call(...importing(detachedId),'--confirm');assert.equal(busy.body.reasonCode,'sentinel.evidence.ownerBusy');
 renameSync(join(ws,'src'),join(dir,'source-away'));
 const end=Date.now()+90000;let after;
 do{await delay(1000);after=await call(...importing(detachedId));if(after.body.reasonCode!=='sentinel.evidence.ownerBusy')break}while(Date.now()<end);
 assert.equal(after.status,4,'natural owner release, without service activity or forced stop');
 const detachedAccepted=await call(...importing(detachedId),'--confirm');assert.equal(detachedAccepted.status,0);assert.equal((await call('evidence','read',candidate)).status,0,'source-gone parent read');
 // Original bounded report large enough to observe a real fixed stage before its asynchronous object writes end.
 const heavy={version:'2.1.0',runs:[{tool:{driver:{name:'original-interrupted-import'}},results:Array.from({length:5000},(_,i)=>({ruleId:`original-${i}`,message:{text:Array.from({length:8},(_,j)=>createHash('sha256').update(`original fixture ${i}:${j}`).digest('hex')).join('')}}))}]};
 writeFileSync(reportPath,JSON.stringify(heavy));
 const child=spawn(bin,[...importing(detachedId),'--confirm','--json'],{cwd:ws,env,stdio:['ignore','pipe','pipe']});ownedPids.add(child.pid);children.set(child.pid,child);
 child.stdout.resume();child.stderr.resume();let exit;const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{exit={code,signal};resolve(exit)})});
 const db=new DatabaseSync(ledger,{readOnly:true});let pending;
 try{const until=Date.now()+30000;while(Date.now()<until&&!exit){pending=db.prepare("SELECT o.id,o.identity FROM evidence_operations o JOIN staging s ON s.evidence_operation_id=o.id WHERE o.run_id=? AND o.state='open' ORDER BY o.created_at DESC LIMIT 1").get(detachedId);if(pending){child.kill('SIGKILL');break}await delay(1)}}finally{db.close()}
 if(!pending&&!exit)child.kill('SIGKILL');await exited;ownedPids.delete(child.pid);assert.ok(pending,'observed the actual import stage');assert.equal(exit.signal,'SIGKILL');
 const stopped=new DatabaseSync(ledger,{readOnly:true});try{assert.equal(stopped.prepare('SELECT state FROM evidence_operations WHERE id=?').get(pending.id).state,'open');assert.equal(stopped.prepare('SELECT count(*) AS n FROM evidence_acceptances WHERE operation_id=?').get(pending.id).n,0)}finally{stopped.close()}
 const identity=JSON.parse(pending.identity),receipt=join(env.XDG_STATE_HOME,'farsight/sentinel/trust/receipts',identity.receiptId+'.spent');assert.ok(existsSync(receipt),'genuine consumed receipt before process death');
 assert.equal((await call('evidence','abandon',pending.id)).status,4);const abandoned=await call('evidence','abandon',pending.id,'--confirm');assert.equal(abandoned.status,0);assert.equal(abandoned.body.facts.objectBytesDeleted,false);
 const checked=new DatabaseSync(ledger,{readOnly:true});try{assert.equal(checked.prepare('SELECT count(*) AS n FROM staging WHERE evidence_operation_id=?').get(pending.id).n,0);assert.equal(checked.prepare('SELECT state FROM evidence_operations WHERE id=?').get(pending.id).state,'aborted')}finally{checked.close()}
 // Optional native current/baseline/selected privacy through this same installed owner executable.
 let nativePrivacy=false,ownContainers=[];
 if(process.env.SENTINEL_ISOLATION==='1'){
  renameSync(join(dir,'source-away'),join(ws,'src'));const value=['Sntl','Fxt9q2','Lr7Wv4','Zk8Jm3','Pd6Hy1','Tb5Qe0'].join('');
  writeFileSync(join(ws,'src/original.ts'),`export const api_key = "${value}";\n`);
  const installed=join(realpathSync.native(c.dir),'node_modules/farsight-sentinel'),pack=JSON.parse(readFileSync(join(installed,'rules/secrets/sentinel-pack.json'))),previewPack=JSON.parse(readFileSync(join(installed,'rules/foundation-preview/sentinel-pack.json')));
  settings.mandatoryRules=[...pack.rules,...previewPack.rules].map(r=>r.familyId);writeFileSync(settingsPath,JSON.stringify(settings));assert.equal((await call('settings','adopt','--confirm')).status,0);
  assert.equal((await call('rules','promote','builtin:secrets','--confirm')).status,0);assert.equal((await call('assets','adopt-tool','secrets-gitleaks','--confirm')).status,0);
  const secretPlan=await call('plan');assert.equal(secretPlan.status,0);const secretId=secretPlan.body.facts.planId;assert.equal((await call('run',secretId)).body.facts.state,'completed');
  writeFileSync(reportPath,JSON.stringify({version:'2.1.0',runs:[{tool:{driver:{name:value}},results:[{ruleId:value,message:{text:value}}]}]}));
  const secretImport=await call(...importing(secretId),'--confirm');assert.equal(secretImport.status,0);assert.equal(secretImport.body.facts.document.document,null);assert.equal(JSON.stringify(secretImport).includes(value),false);
  // Readonly harness observation chooses the exact preview unit from actual planned work, never inventing a unit.
  const units=new DatabaseSync(ledger,{readOnly:true});let previewUnit;try{const rows=units.prepare('SELECT envelope FROM work_units WHERE run_id=?').all(secretId).map(r=>JSON.parse(r.envelope));previewUnit=rows.find(r=>r.stage?.contract==='sentinel.stage.check.sentinel.preview.detector')?.id}finally{units.close()}
  assert.ok(previewUnit,'actual preview unit for a strict selected child');
  const childPlan=await call('rerun',secretId,'--stage',previewUnit);assert.equal(childPlan.status,0);const selectedId=childPlan.body.facts.runId;assert.equal((await call('run',selectedId)).body.facts.state,'completed');
  const selectedImport=await call(...importing(selectedId),'--confirm');assert.equal(selectedImport.status,0);assert.equal(selectedImport.body.facts.document.document,null);assert.equal(JSON.stringify(selectedImport).includes(value),false);
  writeFileSync(join(ws,'src/original.ts'),'export const original = 3;\n');const cleanPlan=await call('plan');assert.equal(cleanPlan.status,0);assert.equal((await call('run',cleanPlan.body.facts.planId)).body.facts.state,'completed');
  const cleanImport=await call(...importing(cleanPlan.body.facts.planId),'--confirm');assert.equal(cleanImport.status,0);assert.equal(cleanImport.body.facts.document.withheld,false);
  renameSync(join(ws,'src'),join(dir,'source-away-again'));
  const baseline=await call('evidence','read',cleanImport.body.facts.candidateDigest,'--baseline',selectedId);assert.equal(baseline.status,0);assert.equal(baseline.body.facts.document.document,null);assert.equal(JSON.stringify(baseline).includes(value),false);
  for(const profile of ['private','shareable']){const read=await call('evidence','read',secretImport.body.facts.candidateDigest,'--disclosure',profile);assert.equal(read.status,0);assert.equal(JSON.stringify(read).includes(value),false)}
  const records=new DatabaseSync(ledger,{readOnly:true});try{for(const row of records.prepare('SELECT envelope,final_envelope FROM attempts').all()){const worker=JSON.parse(row.final_envelope??row.envelope).worker;if(worker.kind==='owned-container'){assert.equal(worker.ownershipLabels.store,JSON.parse(pending.identity).storeId);ownContainers.push(worker.containerId)}}}finally{records.close()}
  ownContainers=[...new Set(ownContainers)];assert.ok(ownContainers.length>=2);
  for(const id of ownContainers){assert.match(id,/^[0-9a-f]{64}$/);const listed=await c.exec('docker',['container','ls','--all','--no-trunc','--filter','id='+id,'--format','{{.ID}}']);assert.equal(listed.stdout.trim(),'','exact own accepted container was removed')}
  nativePrivacy=true;
 }
 console.log('sentinel evidence consumer ok: '+JSON.stringify({installed:true,sourceGone:true,detachedBusy:true,naturalRelease:true,interruptedPending:true,explicitAbandon:true,nativePrivacy,ownContainers}));
}finally{
 // Only processes whose handles/descriptors were recorded inside this consumer's own private workspace.
 for(const pid of ownedPids){
  const child=children.get(pid);if(child){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');continue}
  const retained=serviceRecords.get(pid);try{if(retained&&JSON.stringify(JSON.parse(readFileSync(retained.path)))===retained.record)process.kill(pid,'SIGTERM')}catch{}
 }
 for(const child of children.values())if(child.exitCode===null&&child.signalCode===null)await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);
 if([...children.values()].some(child=>child.exitCode===null&&child.signalCode===null))throw Error('owned consumer process cleanup unconfirmed; scratch retained');
 c.cleanup();
}
