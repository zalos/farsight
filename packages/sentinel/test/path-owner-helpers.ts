// Genuine adopted owner fixture for public retained path workflows; no task or source authority is manufactured.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {commitRepo,scratch} from './snapshot-helpers.ts';
import {scratchUnder,removeScratch} from './lease-helpers.ts';
import {PATHS_APP} from './paths-fixtures.ts';
import {openStore} from '../dist/store/index.js';
import {initWorkspace} from '../dist/cli/init.js';
import {workspaceOf,adoptWorkspaceSettings,adoptedPolicy,promoteRulePack,prepareWorkspacePaths} from '../dist/service/local.js';
import {planWorkspaceCanonical,executeRun} from '../dist/service/canonical.js';
import {builtinPackDir} from '../dist/service/package-paths.js';
import {Coordinator} from '../dist/execution/coordinator.js';
import {publicRegistry,scannerExecution} from '../dist/service/scanner-profile.js';
import {adoptScannerAsset} from '../dist/service/scanner-assets.js';
import {GITLEAKS_SUPPORTED_RULES} from '../dist/adapters/drivers/index.js';
import {loadPlan} from '../dist/execution/plans.js';
export async function pathOwnerFixture(t:any,options:{files?:Record<string,string>;secrets?:boolean;canceled?:boolean}={}){
 const dir=scratch(t,'path-owner-'),path=join(dir,'workspace');commitRepo(path,options.files??PATHS_APP);const ws=workspaceOf(path,{...process.env,XDG_STATE_HOME:join(dir,'owner')});initWorkspace({workspace:path});
 const settings=join(path,'.farsight/sentinel/settings.json'),value=JSON.parse(readFileSync(settings,'utf8'));
 value.mandatoryRules=['sentinel.paths.call-reachability','sentinel.fixture.required-security',...(options.secrets?GITLEAKS_SUPPORTED_RULES.map(r=>r.familyId):[])];value.grants=value.grants.map((g:any)=>g.actions.includes('capture.source')?{...g,confirm:'always'}:g);
 writeFileSync(settings,JSON.stringify(value));assert.equal(adoptWorkspaceSettings(ws,{confirm:true,now:new Date()}).outcome,'prepared');
 assert.equal(promoteRulePack(ws,{packDir:builtinPackDir('bounded-paths')!,confirm:true,now:new Date()}).outcome,'prepared');
 if(options.secrets){assert.equal(promoteRulePack(ws,{packDir:builtinPackDir('secrets')!,confirm:true,now:new Date()}).outcome,'prepared');assert.equal((await adoptScannerAsset(ws,{kind:'tool',id:'secrets-gitleaks',confirm:true,now:new Date()})).outcome,'prepared')}
 const adopted=adoptedPolicy(ws);assert.ok('policy'in adopted);
 const store=await openStore(ws.storePath),work=scratchUnder(store);let parent:any,plan:any;
 try{parent=await planWorkspaceCanonical(store,{workspace:path,trustDir:ws.trustDir,policy:adopted.policy,scratchRoot:work,now:new Date()});plan=await loadPlan(store,parent.disclosure.runId,parent.disclosure.revision);
  if(options.canceled){const registry=publicRegistry(ws.trustDir),unit=plan.plan.units.find((u:any)=>u.adapterId==='secrets-gitleaks');assert.ok(unit);let fired=0;const coordinator=await Coordinator.open({...await scannerExecution(store,parent.disclosure.runId,ws.trustDir,work,registry),store,runId:parent.disclosure.runId,registry,scratchRoot:work,hooks:{at(b,c){if(b==='after-publish'&&c.work.id===unit.id){fired++;coordinator.cancel()}}}});assert.equal((await coordinator.run()).state,'canceled');assert.equal(fired,1);assert.ok(store.ledger.getPublication(unit));}
  else assert.equal((await executeRun(store,parent.disclosure.runId,{scratchRoot:work,trustDir:ws.trustDir})).state,'completed');
 }finally{removeScratch(work);store.close()}
 rmSync(join(path,'src'),{recursive:true});
 const request={schema:'sentinel-path-request/draft-1',ancestor:{runId:parent.disclosure.runId,revision:plan.plan.revision,planDigest:plan.plan.digest},snapshotId:plan.plan.pins.snapshotId,sourceId:'workspace',
  queries:[{from:'workspace::src/routes.ts::getUser',to:'workspace::src/db.ts::query'}],bounds:{edgeKinds:['calls'],maxDepth:12,maxFanout:256,maxVisited:50000}};
 const requestFile=join(dir,'request.json');writeFileSync(requestFile,JSON.stringify(request),{mode:0o600});
 const call=(confirm=false)=>prepareWorkspacePaths(ws,{ancestorRunId:request.ancestor.runId,requestFile,confirm,now:new Date()});
 return{dir,path,ws,settings,value,request,requestFile,call,parent,plan};
}
