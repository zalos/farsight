// Real pinned containers and canonical accepted publications. Imported claims are never scanner authority.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../dist/store/index.js';
import {workspaceOf,adoptWorkspaceSettings,adoptedPolicy,promoteRulePack} from '../dist/service/local.js';
import {initWorkspace} from '../dist/cli/init.js';
import {builtinPackDir} from '../dist/service/package-paths.js';
import {adoptScannerAsset} from '../dist/service/scanner-assets.js';
import {PATTERN_SUPPORTED_RULES,GITLEAKS_SUPPORTED_RULES} from '../dist/adapters/drivers/index.js';
import {planWorkspaceCanonical,executeRun,rerunRun} from '../dist/service/canonical.js';
import {loadPlan} from '../dist/execution/plans.js';
import {assessRun} from '../dist/service/full-report.js';
import {ReceiptBook} from '../dist/policy/receipts.js';
import {readAcceptedReportImport} from '../dist/evidence/reader.js';
import {scratchUnder,removeScratch} from './lease-helpers.ts';
import {VALUE,GENERIC_VALUE,absent} from './secrets-helpers.ts';
import {unlock} from './snapshot-helpers.ts';
import {timing,imported,manifest} from './evidence-acceptance-helpers.ts';
const native={skip:process.env.SENTINEL_ISOLATION!=='1'&&'requires existing pinned local Pattern and Gitleaks images; no acquisition'};
test('genuine current/baseline/selected accepted secret evidence withholds the whole imported payload after source removal and reopen; clean source keeps claims',native,async t=>{
  const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'sentinel-evidence-privacy-'))),path=join(dir,'workspace');mkdirSync(join(path,'src'),{recursive:true});
  const source=(secret:boolean)=>`export function lookup(id: string) { return db.query("SELECT * FROM invoice WHERE ${secret?`api_key = '${GENERIC_VALUE}' AND `:''}id = " + id); }\n`;
  writeFileSync(join(path,'src/lookup.ts'),source(true));writeFileSync(join(path,'src',VALUE+'.ts'),'export const named = 1;\n');
  const ws=workspaceOf(path,{...process.env,XDG_STATE_HOME:join(dir,'state')});initWorkspace({workspace:path,profile:'scanners'});
  const settingsPath=join(path,'.farsight/sentinel/settings.json'),settings=JSON.parse(readFileSync(settingsPath,'utf8'));
  settings.mandatoryRules=[...PATTERN_SUPPORTED_RULES,...GITLEAKS_SUPPORTED_RULES].map(r=>r.familyId);
  settings.grants.push({actions:['evidence.import','evidence.abandon'],principals:['human'],scope:{effects:['local-artifacts']}});writeFileSync(settingsPath,JSON.stringify(settings),{mode:0o600});
  assert.equal(adoptWorkspaceSettings(ws,{confirm:true,now:new Date()}).outcome,'prepared');
  for(const pack of ['pattern','secrets'])assert.equal(promoteRulePack(ws,{packDir:realpathSync.native(builtinPackDir(pack)!),confirm:true,now:new Date()}).outcome,'prepared');
  for(const id of ['pattern-semgrep','secrets-gitleaks'])assert.equal((await adoptScannerAsset(ws,{kind:'tool',id,confirm:true,now:new Date()})).outcome,'prepared');
  const adopted=adoptedPolicy(ws);assert.ok('policy'in adopted);let store=await openStore(ws.storePath);const work=scratchUnder(store);
  t.after(()=>{try{removeScratch(work);store.close();}finally{unlock(dir);rmSync(dir,{recursive:true,force:true});}});
  const terms={workspace:path,trustDir:ws.trustDir,policy:adopted.policy,scratchRoot:work,now:new Date()};
  const parent=(await planWorkspaceCanonical(store,terms)).disclosure.runId;assert.equal((await executeRun(store,parent,{scratchRoot:work,trustDir:ws.trustDir})).state,'completed');
  assert.ok((await assessRun(store,parent,{trustDir:ws.trustDir})).observations.some(o=>o.producer.kind==='scanner'&&o.producer.adapterId==='secrets-gitleaks'),'actual accepted secret evidence');
  const plan=(await loadPlan(store,parent)).plan,pattern=plan.units.find(u=>u.adapterId==='pattern-semgrep')!;assert.ok(pattern);
  const child=(await rerunRun(store,parent,[pattern.id],terms)).disclosure.runId;assert.equal((await executeRun(store,child,{scratchRoot:work,trustDir:ws.trustDir})).state,'completed');
  assert.ok(!(await assessRun(store,child,{trustDir:ws.trustDir})).observations.some(o=>o.producer.kind==='scanner'&&o.producer.adapterId==='secrets-gitleaks'),'no ancestor secret finding is copied into selected child');
  writeFileSync(join(path,'src/lookup.ts'),source(false));rmSync(join(path,'src',VALUE+'.ts'));
  const clean=(await planWorkspaceCanonical(store,terms)).disclosure.runId;assert.equal((await executeRun(store,clean,{scratchRoot:work,trustDir:ws.trustDir})).state,'completed');
  assert.ok(!(await assessRun(store,clean,{trustDir:ws.trustDir})).observations.some(o=>o.producer.kind==='scanner'&&o.producer.adapterId==='secrets-gitleaks'));
  rmSync(join(path,'src'),{recursive:true});const files={reportPath:join(dir,'original-report.json'),manifestPath:join(dir,'original-manifest.json')};
  // An imported producer field contains a detected synthetic value. Coarse withholding removes all caller data,
  // not just a field guessed to contain a value. No assertions print the value or raw report.
  writeFileSync(files.reportPath,JSON.stringify({version:'2.1.0',runs:[{tool:{driver:{name:GENERIC_VALUE}},results:[{ruleId:'external-original-rule',message:{text:VALUE}}]}]}));writeFileSync(files.manifestPath,JSON.stringify(manifest));
  const book=new ReceiptBook(join(ws.trustDir,'receipts')),candidates=new Map<string,string>();
  for(const id of [parent,child,clean]) {
    const run=store.ledger.getRun(id)!,record=store.ledger.getPlan(id,run.planRevision)!;
    const ancestor={runId:id,revision:run.planRevision,planDigest:record.digest,snapshotId:run.envelope.snapshotId,sourceId:run.envelope.requestedScope.sourceIds[0]!};
    const a=await imported({store,ws,ancestor,files,book});candidates.set(id,a.result.candidateDigest!);
    assert.equal(a.result.view!.withheld,id!==clean);if(id===clean)assert.ok(a.result.view!.document);else{assert.equal(a.result.view!.document,null);absent(JSON.stringify(a.result.view),'current/selected import',GENERIC_VALUE);}
  }
  const baseline=await readAcceptedReportImport(store,ws,candidates.get(clean)!,{timing:timing(),baselineRunId:child});assert.equal(baseline.withheld,true);assert.equal(baseline.document,null);absent(JSON.stringify(baseline),'baseline-only imported projection',GENERIC_VALUE);
  removeScratch(work);store.close();store=await openStore(ws.storePath);
  for(const id of [parent,child,clean]){const view=await readAcceptedReportImport(store,ws,candidates.get(id)!,{timing:timing()});assert.equal(view.withheld,id!==clean);if(id!==clean){absent(JSON.stringify(view),'reopened source-gone import',GENERIC_VALUE);absent(JSON.stringify(view),'reopened source-gone filename');}}
  const containers=new Set<string>();for(const runId of [parent,child,clean]){for(const unit of (await loadPlan(store,runId)).plan.units){const pub=store.ledger.getPublication(unit);if(!pub)continue;const worker=store.ledger.getAttempt(pub.attemptId)?.envelope.worker;if(worker?.kind==='owned-container'){assert.equal(worker.ownershipLabels.store,store.storeId);containers.add(worker.containerId);}}}
  assert.ok(containers.size>=5);for(const id of containers){const listed=spawnSync('docker',['container','ls','--all','--no-trunc','--filter','id='+id,'--format','{{.ID}}'],{encoding:'utf8',timeout:10000});assert.equal(listed.status,0,'exact own-container cleanup check reached the daemon');assert.equal(listed.stdout.trim(),'','the exact recorded own container was cleaned');}
  t.diagnostic(JSON.stringify({storeId:store.storeId,ownContainers:[...containers],cleaned:true,actualPinnedEngines:2,currentSecret:true,selectedInheritedSecret:true,baselineOnlySecret:true,cleanUseful:true,sourceRemoved:true,reopened:true}));
});
