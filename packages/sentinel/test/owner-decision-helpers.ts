// Genuine shipped preview executable, accepted publications and the trusted default Workspace; no forged attempts.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scratch,removeScratch} from './execution-helpers.ts';
import {openStore} from '../dist/store/index.js';
import {workspaceOf} from '../dist/service/local.js';
import {assessRun} from '../dist/service/full-report.js';
import {findingsOf} from '../dist/reports/document.js';
export const timing=()=>({signal:new AbortController().signal,deadlineAt:performance.now()+120000});
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
export async function ownerFixture(t:any,options:{granted?:boolean}={}){
  const s=scratch('owner-decisions'),path=join(s.root,'ws');mkdirSync(join(path,'src'),{recursive:true});
  writeFileSync(join(path,'src/lookup.ts'),'export const lookup = (id) => db.query("SELECT * FROM invoice WHERE id = " + id);\n');
  const env={...process.env,XDG_STATE_HOME:join(s.root,'state')},ws=workspaceOf(path,env);
  const raw=(...args:string[])=>spawnSync(process.execPath,[cli,...args,'--workspace',path],{env,encoding:'utf8',timeout:60000});
  const command=(...args:string[])=>{const r=spawnSync(process.execPath,[cli,...args,'--workspace',path,'--json'],{env,encoding:'utf8',timeout:60000});assert.equal(r.signal,null);let value:any;try{value=JSON.parse(r.stdout)}catch{assert.fail('command response unavailable: '+r.stderr)}return{...r,value};};
  assert.equal(command('init').status,0);
  const settings=join(path,'.farsight','sentinel','settings.json'),config=JSON.parse(readFileSync(settings,'utf8'));
  if(options.granted!==false)config.grants.push({actions:['disposition.propose','disposition.approve','evidence.import'],principals:['human'],scope:{profiles:['static-scanners'],effects:['local-artifacts']}});
  writeFileSync(settings,JSON.stringify(config),{mode:0o600});
  assert.equal(command('settings','adopt','--confirm').status,0);
  assert.equal(command('rules','promote','builtin:foundation-preview','--confirm').status,0);
  const planned=command('plan');assert.equal(planned.status,0,JSON.stringify(planned.value));const runId=planned.value.facts.planId;
  assert.equal(command('run',runId).status,2);
  let store=await openStore(ws.storePath);
  const assessment=await assessRun(store,runId,{trustDir:ws.trustDir}),findings=await findingsOf(assessment.observations,id=>store.readArtifact(id),{withheldKey:assessment.withheldKey});assert.equal(findings.length,1);
  t.after(()=>{if(store.held)store.close();removeScratch(s.root)});
  const reopen=async()=>{if(store.held)store.close();store=await openStore(ws.storePath);return store;};
  return{...s,ws,env,path,command,raw,runId,finding:findings[0]!,get store(){return store},reopen,sourceGone:()=>rmSync(join(path,'src'),{recursive:true})};
}
export const input=(decision:'accepted-risk'|'false-positive'|'mitigated'|'deferred'='accepted-risk',extra:Record<string,unknown>={})=>({schema:'sentinel-decision-input/draft-1' as const,decision,rationale:'Owner reviewed this exact captured source.',evidence:[],expiresAt:null,supersedes:null,...extra});
