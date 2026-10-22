import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {PATTERN_SUPPORTED_RULES} from '../dist/adapters/drivers/index.js';
import {openStore} from '../dist/store/index.js';
import {OwnerService} from '../dist/service/owner-service.js';
import {workspaceOf,confirmForService,runWriteBinding} from '../dist/service/local.js';
import {currentPlan} from '../dist/service/canonical.js';
import {unlock} from './snapshot-helpers.ts';
const CLI=fileURLToPath(new URL('../dist/cli.js',import.meta.url));

test('actual scanner effects bind foreground, detached receipts, direct agent admission and reruns', {skip:process.env.SENTINEL_ISOLATION!=='1'&&'requires an existing pinned Linux Semgrep image; no acquisition'},async t=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'sol-scanner-effects-')));t.after(()=>{unlock(dir);rmSync(dir,{recursive:true,force:true})});
 const ws=join(dir,'workspace');mkdirSync(ws,{mode:0o700});mkdirSync(join(ws,'src'));
 writeFileSync(join(ws,'src','bad.ts'),'export function lookup(id: string) { return db.query("SELECT * FROM users WHERE id = " + id); }\n');
 const env={PATH:process.env.PATH!,HOME:process.env.HOME!,XDG_STATE_HOME:join(dir,'state')};
 const cli=(...args:string[])=>{const r=spawnSync(process.execPath,[CLI,...args,'--json'],{cwd:ws,env,encoding:'utf8',timeout:180000,maxBuffer:8<<20});return{status:r.status,body:JSON.parse(r.stdout),stderr:r.stderr}};
 assert.equal(cli('init','--profile','scanners').status,0);
 const settingsPath=join(ws,'.farsight','sentinel','settings.json');const settings=JSON.parse(readFileSync(settingsPath,'utf8'));
 settings.mandatoryRules=PATTERN_SUPPORTED_RULES.map(r=>r.familyId);settings.agentActions='allow';settings.grants.push({actions:['run.start'],principals:['agent'],scope:{profiles:['static'],effects:['local-artifacts']}});
 for(const grant of settings.grants)if(grant.actions.includes('run.start'))grant.scope.effects=['local-artifacts'];
 writeFileSync(settingsPath,JSON.stringify(settings),{mode:0o600});
 assert.equal(cli('settings','adopt','--confirm').status,0);
 assert.equal(cli('rules','promote','builtin:pattern','--confirm').status,0);
 assert.equal(cli('assets','adopt-tool','pattern-semgrep','--confirm').status,0);
 const planned=cli('plan');assert.equal(planned.status,0,JSON.stringify(planned.body));
 const id=planned.body.facts.runId;assert.deepEqual(planned.body.facts.effects,['local-artifacts','tool-execution']);
 const attempts=()=>cli('status',id,'--limit','500').body.facts.events.filter((event:any)=>event.kind==='attempt-started').length;
 const before=attempts();
 for(const flags of [[],['--detach']]){const run=cli('run',id,...flags,'--confirm');assert.deepEqual([run.status,run.body.reasonCode],[3,'sentinel.admission.noGrant']);assert.deepEqual(run.body.facts.effects,['local-artifacts','tool-execution']);assert.equal(attempts(),before,'denied start creates no scanner attempt');}
 const workspace=workspaceOf(ws,env);const store=await openStore(workspace.storePath);
 try{const plan=(await currentPlan(store,id))!;assert.deepEqual(plan.effects,['local-artifacts','tool-execution']);
  const confirmed=confirmForService(workspace,{command:'run',action:'run.start',plan,planId:id,confirm:true,now:new Date(),storeId:store.storeId});assert.ok('result' in confirmed);assert.equal(confirmed.result.reasonCode,'sentinel.admission.noGrant');
  for(const action of ['run.pause','run.cancel'] as const)assert.deepEqual(runWriteBinding(workspace,action,plan,{storeId:store.storeId,runId:id}).intent.effects,['local-artifacts']);
  const service=new OwnerService(store,workspace);const denied:any=await service.handle('run.start',{planId:id},{principal:'agent',channel:'mcp'});
  assert.deepEqual([denied.exitCode,denied.reasonCode],[3,'sentinel.admission.noGrant']);assert.deepEqual(denied.facts.effects,['local-artifacts','tool-execution']);
 }finally{store.close();}
 for(const grant of settings.grants)if(grant.actions.includes('run.start'))grant.scope.effects=['local-artifacts','tool-execution'];
 writeFileSync(settingsPath,JSON.stringify(settings),{mode:0o600});assert.equal(cli('settings','adopt','--confirm').status,0);
 const allowed=cli('plan');assert.equal(allowed.status,0);const ran=cli('run',allowed.body.facts.runId,'--confirm');assert.equal(ran.status,2,JSON.stringify(ran.body));assert.equal(ran.body.facts.state,'completed');assert.ok(ran.body.facts.observations>0,'a sufficient adopted grant permits the real pinned scanner');
 for(const grant of settings.grants)if(grant.actions.includes('run.start'))grant.scope.effects=['local-artifacts'];
 writeFileSync(settingsPath,JSON.stringify(settings),{mode:0o600});assert.equal(cli('settings','adopt','--confirm').status,0);
 const rerun=cli('rerun',allowed.body.facts.runId,'--confirm');assert.equal(rerun.status,0,JSON.stringify(rerun.body));assert.deepEqual(rerun.body.facts.effects,['local-artifacts','tool-execution']);assert.deepEqual(rerun.body.facts.preview.effects,['local-artifacts','tool-execution']);
 const refused=cli('run',rerun.body.facts.runId,'--confirm');assert.deepEqual([refused.status,refused.body.reasonCode],[3,'sentinel.admission.noGrant']);
});
