// Explicit native controls only: real pinned local Gitleaks + shipped framework worker, no acquisition/target code.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {openStore} from '../dist/store/index.js';
import {initWorkspace} from '../dist/cli/init.js';
import {workspaceOf,adoptedPolicy,adoptWorkspaceSettings,promoteRulePack} from '../dist/service/local.js';
import {planWorkspaceCanonical,executeRun,rerunRun} from '../dist/service/canonical.js';
import {builtinPackDir} from '../dist/service/package-paths.js';
import {adoptScannerAsset} from '../dist/service/scanner-assets.js';
import {publicRegistry,scannerExecution} from '../dist/service/scanner-profile.js';
import {loadPlan} from '../dist/execution/plans.js';
import {Coordinator} from '../dist/execution/coordinator.js';
import {OwnerService} from '../dist/service/owner-service.js';
import {scratch,removeScratch as removeRoot} from './execution-helpers.ts';
import {scratchUnder,removeScratch} from './lease-helpers.ts';
import {GENERIC_VALUE,absent} from './secrets-helpers.ts';
import {requester} from './service-readonly-helpers.ts';
const native={skip:process.env.SENTINEL_ISOLATION!=='1'&&'requires the existing pinned local Gitleaks image; no acquisition'};
for(const cancel of[false,true])test(`readonly delivery preserves ${cancel?'canceled':'completed'} ancestor secret privacy in selected/current/baseline source-gone reports`,native,async t=>{
 const s=scratch('readonly-native'),path=join(s.root,'workspace');mkdirSync(join(path,'src'),{recursive:true});
 const routes=(value:string)=>`import express from 'express';const app=express();app.get('/${value}',(_req,res)=>res.send('example'));\n`;
 writeFileSync(join(path,'src/routes.ts'),routes(GENERIC_VALUE));writeFileSync(join(path,'.env'),`api_key = "${GENERIC_VALUE}"\n`);
 writeFileSync(join(path,'package.json'),JSON.stringify({name:'original-readonly-example',dependencies:{express:'4.21.2'}}));
 writeFileSync(join(path,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{express:'4.21.2'}},'node_modules/express':{version:'4.21.2',resolved:'https://registry.npmjs.org/express/-/express-4.21.2.tgz'}}}));
 const ws=workspaceOf(path,{...process.env,XDG_STATE_HOME:join(s.root,'state')});initWorkspace({workspace:path});
 const controls=['sentinel.controls.authentication','sentinel.controls.authorization','sentinel.controls.input-validation'],settings=join(path,'.farsight/sentinel/settings.json');
 const pack=JSON.parse(readFileSync(join(builtinPackDir('secrets')!,'sentinel-pack.json'),'utf8'));
 const configure=(rules:string[])=>{writeFileSync(settings,JSON.stringify({...JSON.parse(readFileSync(settings,'utf8')),mandatoryRules:rules}));assert.equal(adoptWorkspaceSettings(ws,{confirm:true,now:new Date()}).outcome,'prepared');const p=adoptedPolicy(ws);assert.ok('policy'in p);return p.policy;};
 let policy=configure([...controls,...pack.rules.map((r:any)=>r.familyId)]);
 for(const p of['framework-controls','secrets'])assert.equal(promoteRulePack(ws,{packDir:realpathSync.native(builtinPackDir(p)!),confirm:true,now:new Date()}).outcome,'prepared');
 assert.equal((await adoptScannerAsset(ws,{kind:'tool',id:'secrets-gitleaks',confirm:true,now:new Date()})).outcome,'prepared');
 const store=await openStore(ws.storePath),work=scratchUnder(store);let service:OwnerService|undefined;
 t.after(async()=>{await service?.stop();if(store.held)removeScratch(work);store.close();removeRoot(s.root);});
 const terms=()=>({workspace:path,trustDir:ws.trustDir,policy,scratchRoot:work,now:new Date()});
 const parent=(await planWorkspaceCanonical(store,terms())).disclosure.runId,plan=(await loadPlan(store,parent)).plan;
 const secretUnit=plan.units.find(u=>u.adapterId==='secrets-gitleaks')!,inspection=plan.units.find(u=>u.adapterId==='framework-controls')!;assert.ok(secretUnit&&inspection);
 const registry=publicRegistry(ws.trustDir),coordinator=await Coordinator.open({...await scannerExecution(store,parent,ws.trustDir,work,registry),store,runId:parent,registry,scratchRoot:work,hooks:{at(boundary,ctx){if(cancel&&boundary==='after-publish'&&ctx.work.id===secretUnit.id)coordinator.cancel();}}});
 assert.equal((await coordinator.run()).state,cancel?'canceled':'completed');assert.ok(store.ledger.getPublication(secretUnit));
 const selected:any=await rerunRun(store,parent,[inspection.id],terms());assert.equal(selected.outcome,'prepared');const child=selected.disclosure.runId;
 assert.equal((await executeRun(store,child,{scratchRoot:work,trustDir:ws.trustDir})).state,'completed');
 writeFileSync(join(path,'src/routes.ts'),routes('clean'));rmSync(join(path,'.env'));policy=configure(controls);
 const clean=(await planWorkspaceCanonical(store,terms())).disclosure.runId;assert.equal((await executeRun(store,clean,{scratchRoot:work,trustDir:ws.trustDir})).state,'completed');rmSync(join(path,'src'),{recursive:true});
 service=new OwnerService(store,ws);const call=(op:string,body:any)=>service!.handle(op,body,requester);
 const report=async(runId:string,format:string,baselineRunId?:string)=>{
  const m:any=await call('report.open',{runId,format,...(baselineRunId?{baselineRunId}:{})});let offset=0;const b:Buffer[]=[];
  for(;;){const c:any=await call('delivery.read',{deliveryId:m.deliveryId,offset,maxBytes:65536});b.push(Buffer.from(c.base64,'base64'));if(c.nextOffset===null)break;offset=c.nextOffset;}return Buffer.concat(b).toString();
 };
 const ordinary=JSON.parse(await report(clean,'json'));assert.ok(JSON.stringify(ordinary).includes('GET /clean'));
 for(const [runId,baseline]of[[child,undefined],[clean,child],...(!cancel?[[parent,undefined]]:[])]as const){
  for(const format of['json','md','html','sarif']){const text=await report(runId!,format,baseline);absent(text,'readonly genuine secret '+format,GENERIC_VALUE);if(format==='json')assert.match(JSON.parse(text).inspections[0].sourceId,/^withheld-/);}
 }
 const view:any=await call('run.inspect',{runId:child});for(const collection of['works','attempts','inputs','outputs'])absent(JSON.stringify(await call('view.page',{viewId:view.viewId,collection})),'readonly metadata '+collection,GENERIC_VALUE);
});
