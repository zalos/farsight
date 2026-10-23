import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {acceptedFindingBasisFor,acceptedFindingOf,revalidateFindingRecord} from '../dist/findings/decision-basis.js';
import {prepareOwnerProposal,appendOwnerDecision,readOwnerHistory,ownerHistoryOf} from '../dist/findings/owner-journal.js';
import {decisionProjection} from '../dist/findings/owner-evaluation.js';
import {ownerContextOf} from '../dist/evidence/owner-context.js';
import {issueReceipt} from '../dist/policy/owner-receipts.js';
import {validateEnvelope} from '../dist/validate.js';
import {fullReport} from '../dist/service/full-report.js';
import {ownerFixture,input,timing} from './owner-decision-helpers.ts';
async function prepared(s:any,decision:any='accepted-risk',extra={}){
 const b=await acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,timing()),c=acceptedFindingOf(b).context,p=await prepareOwnerProposal(b,s.ws,input(decision,extra),new Date());
 return{b,c,p};
}
async function approve(s:any,x:any){
 const first=await appendOwnerDecision(x.c,x.b,s.ws,x.p,'disposition.approve',new Date());assert.equal(first.status,'awaiting-confirmation');assert.ok('binding'in first);
 const receipt=issueReceipt(ownerContextOf(x.c).receipts,{principal:'human',channel:'owner-cli'},first.binding!,{now:new Date(),ttlMs:60000});
 const done=await appendOwnerDecision(x.c,x.b,s.ws,x.p,'disposition.approve',new Date(),receipt.id);assert.equal(done.status,'applied');return receipt;
}
test('genuine accepted finding basis refuses structural copies, foreign workspace, canceled/deadline and closed epoch',{timeout:60000},async t=>{
 const s=await ownerFixture(t),x=await prepared(s);const r=acceptedFindingOf(x.b).record;
 assert.equal(r.profileId,'static-scanners');assert.equal(r.ancestor.revision,2);assert.equal(r.publications.length,1);assert.ok(r.publications[0]!.checks[0]!.definitionDigest.startsWith('sha256:'));
 await assert.rejects(acceptedFindingBasisFor({...s.store} as any,s.ws,s.runId,s.finding.id,timing()));
 for(const copied of [{},Object.assign({},x.b),new Proxy(x.b,{})])assert.throws(()=>acceptedFindingOf(copied as any),/authority/);
 await assert.rejects(acceptedFindingBasisFor(s.store,{...s.ws,storePath:join(s.root,'foreign')},s.runId,s.finding.id,timing()));
 const aborted=new AbortController();aborted.abort();await assert.rejects(acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,{signal:aborted.signal}));
 await assert.rejects(acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,{signal:new AbortController().signal,deadlineAt:performance.now()}));
 await s.reopen();assert.throws(()=>acceptedFindingOf(x.b));
 const fresh=await revalidateFindingRecord(s.store,s.ws,r,timing());assert.equal(acceptedFindingOf(fresh).record.findingId,s.finding.id);
});
test('proposal and real owner receipt produce source-only read and all report formats after source removal',{timeout:60000},async t=>{
 const s=await ownerFixture(t),x=await prepared(s);
 await assert.rejects(appendOwnerDecision(x.c,x.b,s.ws,{...x.p},'disposition.propose',new Date()),/prepared/);
 assert.equal((await appendOwnerDecision(x.c,x.b,s.ws,x.p,'disposition.propose',new Date())).status,'proposed');
 let h=readOwnerHistory(x.c),view=await decisionProjection(h,x.b,s.ws,x.p.id,new Date());assert.equal(view.decision.state,'open');assert.equal(view.decision.approval,'proposed');
 await approve(s,x);s.sourceGone();
 h=readOwnerHistory(x.c);view=await decisionProjection(h,x.b,s.ws,x.p.id,new Date());assert.ok(validateEnvelope('decisionview',view).ok);assert.equal(view.decision.state,'accepted-risk');
 assert.throws(()=>ownerHistoryOf({...h}),/history/);
 h.proposals.clear();h.approved.clear();const copiedState=ownerHistoryOf(h);copiedState.proposals.clear();copiedState.approved.clear();assert.equal((await decisionProjection(h,x.b,s.ws,x.p.id,new Date())).decision.state,'accepted-risk','caller mutations cannot remove private history authority');
 for(const disclosure of ['private','shareable'] as const){
  const report=await fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:s.runId,disclosure,now:new Date()});
  assert.equal(report.document.decisions[0].state,'accepted-risk');assert.equal(report.document.counts.findings.n,1);assert.equal(report.document.decisions[0].rationale,disclosure==='shareable'?null:x.p.input.rationale);
  for(const text of [report.json,report.markdown,report.html,JSON.stringify(report.sarif)])assert.ok(text.replaceAll('\\','').includes(x.p.id));
 }
});
test('mitigation assertion stays open, explicit expiry reopens and history does not mutate',{timeout:60000},async t=>{
 const s=await ownerFixture(t),expiresAt=new Date(Date.now()+60000).toISOString(),x=await prepared(s,'mitigated',{expiresAt});
 assert.equal((await appendOwnerDecision(x.c,x.b,s.ws,x.p,'disposition.propose',new Date())).status,'proposed');await approve(s,x);
 const h=readOwnerHistory(x.c),before=await decisionProjection(h,x.b,s.ws,x.p.id,new Date());assert.deepEqual([before.decision.state,before.decision.validity,before.decision.reasonCode],['open','invalidated','sentinel.decision.reason.assertionUnverified']);
 const historical=JSON.stringify(before),expired=await decisionProjection(h,x.b,s.ws,x.p.id,new Date(expiresAt));assert.equal(expired.decision.validity,'expired');assert.equal(JSON.stringify(before),historical);
});
test('owner CLI parser refuses actor and disclosure flags; denied/busy commands do not read files or spend',{timeout:60000},async t=>{
 const s=await ownerFixture(t,{granted:false});s.store.close();
 for(const extra of [['--actor','human'],['--disclosure','SECRET-UNSUPPORTED']]){
  const r=s.command('decision','propose',s.runId,'--finding',s.finding.id,'--proposal','missing',...extra);assert.equal(r.value.reasonCode,'sentinel.decision.inputRefused');assert.doesNotMatch(r.stdout+r.stderr,/SECRET-UNSUPPORTED/);
 }
 const denied=s.command('decision','propose',s.runId,'--finding',s.finding.id,'--proposal',join(s.root,'DO-NOT-READ'));
 assert.equal(denied.value.reasonCode,'sentinel.admission.noGrant');
 await s.reopen();const seq=s.store.ledger.currentSequence(),busy=s.command('decision','propose',s.runId,'--finding',s.finding.id,'--proposal',join(s.root,'DO-NOT-READ'),'--confirm');assert.equal(busy.value.reasonCode,'sentinel.decision.ownerBusy');assert.equal(s.store.ledger.currentSequence(),seq);
});
test('actual executable propose approve read list works after reopen without manufactured scope facts',{timeout:60000},async t=>{
 const s=await ownerFixture(t);s.store.close();const proposal=join(s.root,'proposal.json');writeFileSync(proposal,JSON.stringify(input('false-positive',{rationale:'Original owner rationale & < > ` text'})));
 const p=s.command('decision','propose',s.runId,'--finding',s.finding.id,'--proposal',proposal);assert.equal(p.value.outcome,'proposed',JSON.stringify(p.value));const id=p.value.facts.decisionId;
 const wait=s.command('decision','approve',id);assert.equal(wait.value.outcome,'awaiting-confirmation');
 const done=s.command('decision','approve',id,'--confirm');assert.equal(done.value.outcome,'applied',JSON.stringify(done.value));
 s.sourceGone();assert.equal(s.command('decision','read',id).value.facts.document.decision.state,'false-positive');
 const list=s.command('decision','list',s.runId);assert.equal(list.value.facts.document.items[0].id,id);assert.equal(list.value.facts.document.count.n,1);assert.equal(list.value.facts.document.authority,'metadata-only-not-evaluated');
 const report=s.raw('report',s.runId,'--full','--format','json');assert.equal(report.status,0,report.stderr);assert.equal(JSON.parse(report.stdout).decisions[0].state,'false-positive');
 const retained=s.command('decision','approve',id,'--confirm');assert.equal(retained.value.facts.reused,true);
 const settingsPath=join(s.path,'.farsight','sentinel','settings.json'),settings=JSON.parse(readFileSync(settingsPath,'utf8'));settings.grants=settings.grants.filter((g:any)=>!g.actions.includes('disposition.approve'));writeFileSync(settingsPath,JSON.stringify(settings));assert.equal(s.command('settings','adopt','--confirm').status,0);
 const denied=s.command('decision','approve',id,'--confirm');assert.equal(denied.value.reasonCode,'sentinel.admission.noGrant');assert.equal(s.command('decision','read',id).value.facts.document.decision.state,'false-positive');
});

test('same-ancestor accepted import supports adjudication but arbitrary objects and imported mitigation labels cannot close it',{timeout:60000},async t=>{
 const s=await ownerFixture(t),{acceptReportImportFiles}=await import('../dist/evidence/accept.js');
 const b=await acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,timing()),c=acceptedFindingOf(b).context,ancestor=acceptedFindingOf(b).record.ancestor;
 const reportPath=join(s.root,'support.sarif.json'),manifestPath=join(s.root,'support-manifest.json');
 writeFileSync(reportPath,JSON.stringify({version:'2.1.0',runs:[{tool:{driver:{name:'original-untrusted-import'}},results:[{ruleId:'caller-claim',message:{text:'runtime-observed mitigated approved'}}]}]}));
 writeFileSync(manifestPath,JSON.stringify({schema:'sentinel-import-manifest/draft-1',format:'sarif-2.1.0',producer:{name:null,version:null},tested:{origins:['https://example.test'],methods:['GET'],properties:['cookie-secure'],directions:['outbound']}}));
 const preview=await acceptReportImportFiles(s.store,s.ws,ancestor,{reportPath,manifestPath},{timing:timing()});assert.equal(preview.status,'awaiting-confirmation');assert.ok('binding'in preview);
 const issued=issueReceipt(ownerContextOf(c).receipts,{principal:'human',channel:'owner-cli'},preview.binding!,{now:new Date(),ttlMs:60000});
 const accepted=await acceptReportImportFiles(s.store,s.ws,ancestor,{reportPath,manifestPath},{timing:timing(),receiptId:issued.id});assert.equal(accepted.status,'accepted');assert.ok('candidateDigest'in accepted);
 const p=await prepareOwnerProposal(b,s.ws,input('mitigated',{evidence:[accepted.candidateDigest]}),new Date());assert.equal(p.support[0]!.kind,'accepted-import');
 const x={b,c,p};await appendOwnerDecision(c,b,s.ws,p,'disposition.propose',new Date());await approve(s,x);
 const view=await decisionProjection(readOwnerHistory(c),b,s.ws,p.id,new Date());assert.equal(view.decision.state,'open');assert.equal(view.decision.reasonCode,'sentinel.decision.reason.assertionUnverified');
 await assert.rejects(prepareOwnerProposal(b,s.ws,input('accepted-risk',{evidence:['sha256:'+'a'.repeat(64)]}),new Date()));
});

test('stale head refuses a previously issued receipt without spending; supersession changes only new evaluations',{timeout:60000},async t=>{
 const s=await ownerFixture(t),a=await prepared(s);
 await appendOwnerDecision(a.c,a.b,s.ws,a.p,'disposition.propose',new Date());
 const first=await appendOwnerDecision(a.c,a.b,s.ws,a.p,'disposition.approve',new Date());assert.ok('binding'in first);
 const receipt=issueReceipt(ownerContextOf(a.c).receipts,{principal:'human',channel:'owner-cli'},first.binding!,{now:new Date(),ttlMs:60000});
 const b=await prepared(s,'deferred');await appendOwnerDecision(b.c,b.b,s.ws,b.p,'disposition.propose',new Date());
 await assert.rejects(appendOwnerDecision(a.c,a.b,s.ws,a.p,'disposition.approve',new Date(),receipt.id));
 assert.equal(readdirSync(ownerContextOf(a.c).receipts.directory).includes(receipt.id+'.spent'),false);
 await approve(s,a);const old=await decisionProjection(readOwnerHistory(a.c),a.b,s.ws,a.p.id,new Date()),bytes=JSON.stringify(old);
 const replacement=await prepared(s,'false-positive',{supersedes:a.p.id});await appendOwnerDecision(replacement.c,replacement.b,s.ws,replacement.p,'disposition.propose',new Date());await approve(s,replacement);
 const next=await decisionProjection(readOwnerHistory(a.c),a.b,s.ws,a.p.id,new Date());assert.equal(next.decision.reasonCode,'sentinel.decision.reason.superseded');assert.equal(next.decision.state,'open');assert.equal(JSON.stringify(old),bytes);
});

test('decision metadata pagination is stable-ID ordered and refuses copied cross-head cursors',{timeout:60000},async t=>{
 const s=await ownerFixture(t);const x=await prepared(s),y=await prepared(s,'deferred');
 await appendOwnerDecision(x.c,x.b,s.ws,x.p,'disposition.propose',new Date());await appendOwnerDecision(y.c,y.b,s.ws,y.p,'disposition.propose',new Date());s.store.close();
 const first=s.command('decision','list',s.runId,'--limit','1').value.facts.document;assert.equal(first.items.length,1);assert.ok(first.next);assert.ok(validateEnvelope('decisionpage',first).ok);
 const second=s.command('decision','list',s.runId,'--limit','1','--after',first.next).value.facts.document;assert.equal(second.items.length,1);assert.ok(second.items[0].id>first.items[0].id);assert.equal(second.next,null);
 const foreign=s.command('decision','list',s.runId,'--after',Buffer.from(JSON.stringify({schema:'decision-page/1',binding:'sha256:'+'0'.repeat(64),after:first.items[0].id})).toString('base64url'));assert.equal(foreign.value.outcome,'refused');
 await s.reopen();const z=await prepared(s);await appendOwnerDecision(z.c,z.b,s.ws,z.p,'disposition.propose',new Date());s.store.close();assert.equal(s.command('decision','list',s.runId,'--after',first.next).value.outcome,'refused');
});

test('real same-capture rerun keeps exact source adjudication while a changed citation reopens only new report evaluations',{timeout:60000},async t=>{
 const s=await ownerFixture(t),x=await prepared(s);await appendOwnerDecision(x.c,x.b,s.ws,x.p,'disposition.propose',new Date());await approve(s,x);
 const old=await decisionProjection(readOwnerHistory(x.c),x.b,s.ws,x.p.id,new Date()),oldBytes=JSON.stringify(old);s.store.close();
 const rerun=s.command('rerun',s.runId);assert.equal(rerun.status,0);const unchanged=rerun.value.facts.runId;assert.equal(s.command('run',unchanged).status,2);
 await s.reopen();let report=await fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:unchanged,disclosure:'private',now:new Date()});
 assert.equal(report.document.decisions[0].state,'accepted-risk');s.store.close();
 writeFileSync(join(s.path,'src/lookup.ts'),'export const lookup = (id) => db.query("SELECT * FROM invoice_archive WHERE id = " + id);\n');
 const planned=s.command('plan');assert.equal(planned.status,0);const changed=planned.value.facts.runId??planned.value.facts.planId;assert.equal(s.command('run',changed).status,2);
 await s.reopen();report=await fullReport({store:s.store,workspace:s.ws.path,trustDir:s.ws.trustDir,runId:changed,disclosure:'private',now:new Date()});
 assert.deepEqual([report.document.decisions[0].state,report.document.decisions[0].reasonCode],['open','sentinel.decision.reason.sourceChanged']);assert.equal(JSON.stringify(old),oldBytes);
});

test('malformed principal receipt refuses before spend and late source-proof cancellation produces no proposal',{timeout:60000},async t=>{
 const s=await ownerFixture(t),x=await prepared(s);await appendOwnerDecision(x.c,x.b,s.ws,x.p,'disposition.propose',new Date());
 const first=await appendOwnerDecision(x.c,x.b,s.ws,x.p,'disposition.approve',new Date());assert.ok('binding'in first);
 const receipt=issueReceipt(ownerContextOf(x.c).receipts,{principal:'human',channel:'owner-cli'},first.binding!,{now:new Date(),ttlMs:60000});
 const path=join(ownerContextOf(x.c).receipts.directory,receipt.id+'.json'),issued=JSON.parse(readFileSync(path,'utf8'));issued.actor.principal='different-principal';writeFileSync(path,JSON.stringify(issued),{mode:0o600});
 await assert.rejects(appendOwnerDecision(x.c,x.b,s.ws,x.p,'disposition.approve',new Date(),receipt.id));assert.equal(readdirSync(ownerContextOf(x.c).receipts.directory).includes(receipt.id+'.spent'),false);
 const head=readOwnerHistory(x.c).head,abort=new AbortController();let checks=0;
 await assert.rejects(acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,{signal:abort.signal,stillWithin:()=>{if(++checks===8)abort.abort()}}));assert.ok(checks>=8);assert.equal(readOwnerHistory(x.c).head,head);
});

test('a later approval requires explicit exact supersession instead of leaving conflicting approvals effective',{timeout:60000},async t=>{
 const s=await ownerFixture(t),a=await prepared(s),b=await prepared(s,'false-positive');
 await appendOwnerDecision(a.c,a.b,s.ws,a.p,'disposition.propose',new Date());await appendOwnerDecision(b.c,b.b,s.ws,b.p,'disposition.propose',new Date());await approve(s,a);
 const head=readOwnerHistory(a.c).head;
 await assert.rejects(appendOwnerDecision(b.c,b.b,s.ws,b.p,'disposition.approve',new Date()),/superseded explicitly/);assert.equal(readOwnerHistory(a.c).head,head);
 const extra=await prepared(s,'deferred');await assert.rejects(appendOwnerDecision(extra.c,extra.b,s.ws,extra.p,'disposition.propose',new Date()),/superseded explicitly/);
 const view=await decisionProjection(readOwnerHistory(a.c),a.b,s.ws,a.p.id,new Date());assert.equal(view.decision.state,'accepted-risk');
});

test('receipt expiry is sampled after genuine asynchronous source/support checks, never from the action-start clock',{timeout:60000},async t=>{
 const s=await ownerFixture(t);let waitUntil=0;
 const b=await acceptedFindingBasisFor(s.store,s.ws,s.runId,s.finding.id,{...timing(),stillWithin:()=>{
  const remaining=waitUntil-Date.now();if(remaining>0)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,remaining);
 }}),c=acceptedFindingOf(b).context,p=await prepareOwnerProposal(b,s.ws,input(),new Date());
 await appendOwnerDecision(c,b,s.ws,p,'disposition.propose',new Date());
 const first=await appendOwnerDecision(c,b,s.ws,p,'disposition.approve',new Date());assert.ok('binding'in first);
 const started=new Date(),receipt=issueReceipt(ownerContextOf(c).receipts,{principal:'human',channel:'owner-cli'},first.binding!,{now:started,ttlMs:10});
 waitUntil=Date.now()+40;
 await assert.rejects(appendOwnerDecision(c,b,s.ws,p,'disposition.approve',started,receipt.id));
 assert.equal(readdirSync(ownerContextOf(c).receipts.directory).includes(receipt.id+'.spent'),false);
 assert.equal(readOwnerHistory(c).approved.has(p.id),false);
});
