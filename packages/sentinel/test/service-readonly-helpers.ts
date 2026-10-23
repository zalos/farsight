// Genuine shipped preview worker/Coordinator publications; no fabricated accepted evidence.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { initWorkspace } from '../dist/cli/init.js';
import { workspaceOf, adoptedPolicy, adoptWorkspaceSettings, promoteRulePack } from '../dist/service/local.js';
import { planWorkspaceCanonical, executeRun } from '../dist/service/canonical.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { OwnerService } from '../dist/service/owner-service.js';
import { scratch, removeScratch as removeRoot } from './execution-helpers.ts';
export const requester=Object.freeze({principal:'agent' as const,channel:'mcp' as const});
export async function publishedReadonly(t:any,options:any={}){
 const s=scratch('service-readonly'),path=join(s.root,'workspace');mkdirSync(join(path,'src'),{recursive:true});
 for(let i=0;i<4;i++)writeFileSync(join(path,'src',`PRIVATE-FILE-${i}.ts`),'export const lookup = (id: string) => db.query("SELECT * FROM invoice WHERE id = " + id);\n');
 const ws=workspaceOf(path,{...process.env,XDG_STATE_HOME:join(s.root,'state')});initWorkspace({workspace:path});
 assert.equal(adoptWorkspaceSettings(ws,{confirm:true,now:new Date()}).outcome,'prepared');
 assert.equal(promoteRulePack(ws,{packDir:realpathSync.native(builtinPackDir('foundation-preview')!),confirm:true,now:new Date()}).outcome,'prepared');
 const adopted=adoptedPolicy(ws);assert.ok('policy'in adopted);const store=await openStore(ws.storePath),work=scratchUnder(store);
 const p=await planWorkspaceCanonical(store,{workspace:path,trustDir:ws.trustDir,policy:adopted.policy,scratchRoot:work,now:new Date()});
 assert.equal((await executeRun(store,p.disclosure.runId,{scratchRoot:work,trustDir:ws.trustDir})).state,'completed');
 const service=new OwnerService(store,ws,options);
 t.after(async()=>{await service.stop();if(store.held)removeScratch(work);store.close();removeRoot(s.root);});
 return {root:s.root,store,ws,work,policy:adopted.policy,runId:p.disclosure.runId,service,call:(op:string,body:unknown={})=>service.handle(op,body,requester)};
}
