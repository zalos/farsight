import assert from 'node:assert/strict';
import {mkdirSync,renameSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Coordinator} from '../dist/execution/coordinator.js';
import {openStore} from '../dist/store/index.js';
import {workspaceOf} from '../dist/service/local.js';
import {DEFAULT_SETTINGS} from '../dist/policy/settings.js';
import {adoptionIntent,adoptSettings} from '../dist/policy/adoption.js';
import {ReceiptBook} from '../dist/policy/receipts.js';
import {issueReceipt} from '../dist/policy/owner-receipts.js';
import {acceptReportImportFiles} from '../dist/evidence/accept.js';
import {retainedFixture} from './retained-analysis-helpers.ts';

export const timing=()=>({signal:new AbortController().signal});
export const report={version:'2.1.0',runs:[{tool:{driver:{name:'original-import-fixture',version:'1'}},results:[{ruleId:'external-rule',message:{text:'original imported claim'}}]}]};
export const manifest={schema:'sentinel-import-manifest/draft-1',format:'sarif-2.1.0',producer:{name:null,version:null},tested:{origins:['https://example.test'],methods:['GET'],properties:['cookie-secure'],directions:['outbound']}};
export async function acceptFixture(t:any) {
  const s=await retainedFixture(t,{otherSource:true});
  const done=await(await Coordinator.open({store:s.store,runId:s.run.id,registry:s.registry,scratchRoot:s.work})).run();assert.equal(done.state,'completed',JSON.stringify(done.failures));
  const run=s.store.ledger.getRun(s.run.id)!;
  const ancestor={runId:s.run.id,revision:run.planRevision,planDigest:s.store.ledger.getPlan(s.run.id,run.planRevision)!.digest,snapshotId:s.snapshot.id,sourceId:'app'};
  const path=join(s.dir,'owner-workspace');mkdirSync(join(path,'.farsight','sentinel'),{recursive:true,mode:0o700});
  const ws=workspaceOf(path,{...process.env,XDG_STATE_HOME:join(s.dir,'owner-state')});
  s.store.close();renameSync(join(s.dir,'store'),ws.storePath);
  const store=await openStore(ws.storePath);t.after(()=>{if(store.held)store.close();});
  const book=new ReceiptBook(join(ws.trustDir,'receipts'));
  function settings(actions:string[]) {
    const value={...structuredClone(DEFAULT_SETTINGS),grants:[{actions,principals:['human'],scope:{effects:['local-artifacts']}}]};
    writeFileSync(join(path,'.farsight','sentinel','settings.json'),JSON.stringify(value),{mode:0o600});
    const binding={...adoptionIntent(path),stateDigest:'',policyRevision:`sha256:${'a'.repeat(64)}`};
    binding.stateDigest=binding.settingsDigest;
    const now=new Date(),issued=issueReceipt(book,{channel:'owner-cli',principal:'human'},binding,{now,ttlMs:60000});
    adoptSettings({workspace:path,trustDir:ws.trustDir,receipt:book.consume(issued.id,binding,now),now});
  }
  settings(['evidence.import','evidence.abandon']);
  const files={reportPath:join(s.dir,'original-report.json'),manifestPath:join(s.dir,'original-manifest.json')};
  writeFileSync(files.reportPath,JSON.stringify(report));writeFileSync(files.manifestPath,JSON.stringify(manifest));
  return {...s,store,ws,ancestor,files,book,settings};
}
export function confirm(s:any,binding:any,principal='human') {
  return issueReceipt(s.book,{channel:'owner-cli',principal},binding,{now:new Date(),ttlMs:60000}).id;
}
export async function imported(s:any) {
  const preview=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing()});assert.equal(preview.status,'awaiting-confirmation');assert.ok(preview.binding);
  const receiptId=confirm(s,preview.binding),result=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing(),receiptId});
  assert.equal(result.status,'accepted',JSON.stringify(result));return {preview,receiptId,result};
}
