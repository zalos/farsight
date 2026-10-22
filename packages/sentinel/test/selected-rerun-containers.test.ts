// A selected rerun through the real pinned Semgrep container: with the workspace's source gone, the linked run starts
// exactly the selected unit's attempts over the parent's retained snapshot and leaves the parent's report as it was.
// Existing local images only; nothing is pulled and no target code runs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {PATTERN_SUPPORTED_RULES} from '../dist/adapters/drivers/index.js';
import {openStore} from '../dist/store/index.js';
import {workspaceOf} from '../dist/service/local.js';
import {unlock} from './snapshot-helpers.ts';
const CLI=fileURLToPath(new URL('../dist/cli.js',import.meta.url));

test('a selected rerun runs only the selected pinned container, over the retained snapshot, with the source gone', {skip:process.env.SENTINEL_ISOLATION!=='1'&&'requires an existing pinned Linux Semgrep image; no acquisition'},async t=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'sentinel-selected-rerun-')));t.after(()=>{unlock(dir);rmSync(dir,{recursive:true,force:true})});
 const ws=join(dir,'workspace');mkdirSync(join(ws,'src'),{recursive:true,mode:0o700});
 // More files than one scanner unit takes (32 scopes), so the plan has more than one unit to select from.
 for(let i=0;i<40;i++)writeFileSync(join(ws,'src',`m${String(i).padStart(2,'0')}.ts`),i%13===0
  ?`export function lookup${i}(id: string) { return db.query("SELECT * FROM t${i} WHERE id = " + id); }\n`
  :`export const value${i} = ${i};\n`);
 const env={PATH:process.env.PATH!,HOME:process.env.HOME!,XDG_STATE_HOME:join(dir,'state')};
 const cli=(...args:string[])=>{const r=spawnSync(process.execPath,[CLI,...args,'--json'],{cwd:ws,env,encoding:'utf8',timeout:300000,maxBuffer:8<<20});return{status:r.status,body:JSON.parse(r.stdout),stderr:r.stderr}};
 assert.equal(cli('init','--profile','scanners').status,0);
 const settingsPath=join(ws,'.farsight','sentinel','settings.json');const settings=JSON.parse(readFileSync(settingsPath,'utf8'));
 settings.mandatoryRules=PATTERN_SUPPORTED_RULES.map(r=>r.familyId);writeFileSync(settingsPath,JSON.stringify(settings),{mode:0o600});
 assert.equal(cli('settings','adopt','--confirm').status,0);
 assert.equal(cli('rules','promote','builtin:pattern','--confirm').status,0);
 assert.equal(cli('assets','adopt-tool','pattern-semgrep','--confirm').status,0);
 const planned=cli('plan');assert.equal(planned.status,0,JSON.stringify(planned.body));
 const parent=planned.body.facts.runId as string;const units=planned.body.facts.unitIds as string[];
 assert.ok(units.length>1,`a strict subset needs more than one unit: ${JSON.stringify(units)}`);
 const ran=cli('run',parent,'--confirm');assert.equal(ran.status,2,JSON.stringify(ran.body));assert.equal(ran.body.facts.state,'completed');
 const before=cli('report',parent).body.facts.report;assert.ok(before.observations.length>0);
 rmSync(join(ws,'src'),{recursive:true,force:true});
 const attempts=(runId:string)=>cli('status',runId,'--limit','500').body.facts.events.filter((e:any)=>e.kind==='attempt-started');
 const prepared=cli('rerun',parent,'--stage',units[0]!);assert.deepEqual([prepared.status,prepared.body.outcome,prepared.body.facts.parentId],[0,'prepared',parent],JSON.stringify(prepared.body));
 const preview=prepared.body.facts.preview;assert.deepEqual([preview.selected,preview.all,preview.held.length],[[units[0]],false,units.length-1]);
 const child=prepared.body.facts.runId as string;assert.equal(attempts(child).length,0,'preparing starts nothing');
 const reran=cli('run',child,'--confirm');assert.deepEqual([reran.status,reran.body.facts.state],[2,'completed'],JSON.stringify(reran.body));
 assert.ok(attempts(child).length>0);
 const store=await openStore(workspaceOf(ws,env).storePath);
 try{const events:any[]=[];for(let after=0;;){const page=store.ledger.readEvents({after,limit:500});events.push(...page.events.filter(e=>e.runId===child));if(!page.events.length)break;after=page.events.at(-1)!.sequence;}
  assert.deepEqual([...new Set(events.filter(e=>e.kind==='attempt-started').map(e=>e.work!.id))].sort(),[...preview.units].sort(),'only the previewed units started: nothing widened, no bootstrap or capture reran');
 }finally{store.close();}
 const after=cli('report',parent).body.facts.report;assert.deepEqual(after.observations,before.observations);assert.deepEqual(after.coverage,before.coverage);
 const childReport=cli('report',child).body.facts.report;assert.equal(childReport.schema,'sentinel-scanner-report/draft-1');assert.ok(childReport.observations.length<=before.observations.length);
});
