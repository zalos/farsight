import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,unlinkSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {acceptReportImportFiles} from '../dist/evidence/accept.js';
import {readAcceptedReportImport} from '../dist/evidence/reader.js';
import {evidenceLedgerFor} from '../dist/store/evidence-binding.js';
import {openStore} from '../dist/store/index.js';
import {evidenceIo} from '../dist/evidence/test-hooks.js';
import {EVIDENCE_LIMITS,checkEvidenceBounds} from '../dist/evidence/import-operation.js';
import {abandonReportImport,readAbandonedReportImport} from '../dist/evidence/abandon.js';
import {needsStore} from './snapshot-helpers.ts';
import {acceptFixture,timing,imported,confirm,report} from './evidence-acceptance-helpers.ts';

const fails=(e:any)=>typeof e?.code==='string'&&e.code.startsWith('sentinel.');
test('actual owner import: waiting has no writes; atomic six-role acceptance survives source deletion/reopen and lost acknowledgement without re-spend',needsStore,async t=>{
  const s=await acceptFixture(t),seq=s.store.ledger.currentSequence();
  assert.equal(existsSync(s.repo),false);
  const preview=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing()});assert.equal(preview.status,'awaiting-confirmation');assert.equal(s.store.ledger.currentSequence(),seq);
  const receiptId=confirm(s,preview.binding!);evidenceIo.after=p=>{if(p==='before-reply')throw new Error('original lost acknowledgement');};
  let result;try{result=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing(),receiptId});}finally{evidenceIo.after=null;}
  assert.equal(result.status,'publicationUnknown',JSON.stringify(result));
  const record=evidenceLedgerFor(s.store).acceptance(preview.binding!.intent.input)!;
  assert.ok(record);assert.equal(record.identity.artifacts.length,6);assert.equal(s.store.ledger.listOpenStages(500,{domain:'evidence'}).length,0);
  assert.equal(s.store.checkIntegrity().foreignKeyViolations,0);
  const inspected=await s.store.inspect();assert.ok(inspected.ok,JSON.stringify(inspected.errors));assert.ok(inspected.reachable.includes(record.root));
  s.store.close();const store=await openStore(s.ws.storePath);t.after(()=>store.close());
  const view=await readAcceptedReportImport(store,s.ws,record.candidateDigest,{timing:timing()});
  assert.equal(view.withheld,false);assert.ok(view.document);assert.ok(JSON.stringify(view).includes('external-rule'));
  const before=store.ledger.currentSequence(),retry=await acceptReportImportFiles(store,s.ws,s.ancestor,s.files,{timing:timing(),receiptId:'does-not-exist'});
  assert.equal(retry.status,'accepted');assert.equal((retry as any).reused,true);assert.equal(store.ledger.currentSequence(),before,'idempotency checks accepted data before any fresh receipt read/spend');
  const db=new DatabaseSync(join(store.storePath,'ledger.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM evidence_acceptances').get()!.n,1);}finally{db.close();}
});

test('current shared policy denies before reading an absent input; settings changes and actor-mismatched receipt refuse before spend',needsStore,async t=>{
  const s=await acceptFixture(t);s.settings(['evidence.abandon']);
  const seq=s.store.ledger.currentSequence(),denied=await acceptReportImportFiles(s.store,s.ws,s.ancestor,{reportPath:'/missing-original-report',manifestPath:'/missing-original-manifest'},{timing:timing()});
  assert.equal(denied.status,'denied');assert.equal(s.store.ledger.currentSequence(),seq);
  s.settings(['evidence.import','evidence.abandon']);const preview=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing()});assert.ok(preview.binding);
  const receiptId=confirm(s,preview.binding,'different-owner');
  await assert.rejects(()=>acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing(),receiptId}),fails);
  assert.equal(existsSync(join(s.book.directory,receiptId+'.spent')),false,'actor mismatch is refused before spending');
  const genuine=confirm(s,preview.binding);s.settings(['evidence.import']);
  await assert.rejects(()=>acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing(),receiptId:genuine}),fails);
  assert.equal(existsSync(join(s.book.directory,genuine+'.spent')),false);assert.equal(s.store.ledger.currentSequence(),seq);
});

test('signal/deadline and actual commit rollback never manufacture acceptance or remove pending pins',needsStore,async t=>{
  const s=await acceptFixture(t),preview=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing()});assert.ok(preview.binding);
  const receiptId=confirm(s,preview.binding),abort=new AbortController();
  evidenceIo.after=p=>{if(p==='before-commit')abort.abort();};
  let result;try{result=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:{signal:abort.signal},receiptId});}finally{evidenceIo.after=null;}
  assert.ok(['spentNotPublished','publicationUnknown'].includes(result.status));assert.equal(evidenceLedgerFor(s.store).acceptance(preview.binding.intent.input),null);
  assert.equal(s.store.ledger.listOpenStages(500,{domain:'evidence'}).length,1,'all pending pins remain after rollback');
  const before=s.store.ledger.currentSequence();await assert.rejects(()=>acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:{signal:new AbortController().signal,deadlineAt:performance.now()}}),fails);
  assert.equal(s.store.ledger.currentSequence(),before,'the exact deadline is expired');
});

test('retained authority rejects changed issued/spent metadata and missing payload rather than crediting less',needsStore,async t=>{
  const s=await acceptFixture(t),a=await imported(s),id=a.result.candidateDigest!,record=evidenceLedgerFor(s.store).acceptance(id)!;
  const issued=join(s.book.directory,a.receiptId+'.json'),original=readFileSync(issued);const r=JSON.parse(original.toString());r.actor.principal='different-owner';writeFileSync(issued,JSON.stringify(r),{mode:0o600});
  await assert.rejects(()=>readAcceptedReportImport(s.store,s.ws,id,{timing:timing()}),fails);writeFileSync(issued,original,{mode:0o600});
  const spent=join(s.book.directory,a.receiptId+'.spent'),spentBytes=readFileSync(spent);writeFileSync(spent,'not-a-time',{mode:0o600});
  await assert.rejects(()=>readAcceptedReportImport(s.store,s.ws,id,{timing:timing()}),fails);writeFileSync(spent,spentBytes,{mode:0o600});
  const raw=record.identity.publication!.roles.raw,hex=raw.slice(7),folder=join(s.store.storePath,'objects','sha256',hex.slice(0,2));
  const names=(await import('node:fs')).readdirSync(folder).filter(n=>n.startsWith(hex+'.'));assert.ok(names.length);
  const files=names.map(n=>join(folder,n));const backup=files.map(p=>readFileSync(p));for(const p of files)unlinkSync(p);
  await assert.rejects(()=>readAcceptedReportImport(s.store,s.ws,id,{timing:timing()}),fails);for(let n=0;n<files.length;n++)writeFileSync(files[n]!,backup[n]!,{mode:0o600});
  assert.equal((await readAcceptedReportImport(s.store,s.ws,id,{timing:timing()})).withheld,false);
});

async function pending(s:any,point='after-objects') {
  const preview=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing()});assert.ok(preview.binding);
  const receiptId=confirm(s,preview.binding);evidenceIo.after=p=>{if(p===point)throw new Error('original interrupted import');};
  try { const result=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing(),receiptId});assert.equal(result.status,'spentNotPublished');assert.ok(result.operationId);return {operationId:result.operationId,receiptId,binding:preview.binding}; }
  finally {evidenceIo.after=null;}
}
async function reopen(s:any,t:any) {s.store.close();const store=await openStore(s.ws.storePath);t.after(()=>{if(store.held)store.close();});return {...s,store};}

test('explicit abandon releases only exact old pending pins without source proof or physical deletion; original full audit replays after restart',needsStore,async t=>{
  let s=await acceptFixture(t),p=await pending(s);const old=evidenceLedgerFor(s.store).operation(p.operationId)!;
  await assert.rejects(()=>abandonReportImport(s.store,s.ws,p.operationId,{timing:timing()}),fails,'current epoch operation is never abandoned by this action');
  s=await reopen(s,t);
  // Destroy only this fixture's source manifest bytes: abandoning unwanted pins must not require source proof.
  const manifestId=s.store.ledger.getSnapshot(s.snapshot.id)!.manifest,hex=manifestId.slice(7),folder=join(s.store.storePath,'objects','sha256',hex.slice(0,2));
  const file=(await import('node:fs')).readdirSync(folder).find(n=>n.startsWith(hex+'.'))!;const path=join(folder,file),backup=readFileSync(path);unlinkSync(path);
  const seq=s.store.ledger.currentSequence(),waiting=await abandonReportImport(s.store,s.ws,p.operationId,{timing:timing()});assert.equal(waiting.status,'awaiting-confirmation');assert.equal(s.store.ledger.currentSequence(),seq);
  s.settings(['evidence.import']);const denied=await abandonReportImport(s.store,s.ws,p.operationId,{timing:timing()});assert.equal(denied.status,'denied');assert.equal(s.store.ledger.listOpenStages(500,{domain:'evidence'}).length,1);
  s.settings(['evidence.import','evidence.abandon']);const preview=await abandonReportImport(s.store,s.ws,p.operationId,{timing:timing()});assert.ok(preview.binding);
  const receiptId=confirm(s,preview.binding!),raw=old.identity.publication!.roles.raw;
  const beforeRefs=s.store.ledger.objectsOf(raw); // Object bytes are deliberately not accepted yet.
  assert.equal(beforeRefs.length,0);
  const rawHex=raw.slice(7),rawFolder=join(s.store.storePath,'objects','sha256',rawHex.slice(0,2));const rawNames=(await import('node:fs')).readdirSync(rawFolder).filter(n=>n.startsWith(rawHex+'.'));assert.ok(rawNames.length);
  const result=await abandonReportImport(s.store,s.ws,p.operationId,{timing:timing(),receiptId});assert.equal(result.status,'abandoned',JSON.stringify(result));
  assert.equal(s.store.ledger.listOpenStages(500,{domain:'evidence'}).length,0);for(const n of rawNames)assert.ok(existsSync(join(rawFolder,n)),'release never physically deletes object bytes');
  writeFileSync(path,backup,{mode:0o600});s=await reopen(s,t);
  const retained=readAbandonedReportImport(s.store,s.ws,p.operationId,timing());assert.equal(retained.status,'abandoned');assert.ok(retained.auditBytes<=16384);
  await assert.rejects(()=>abandonReportImport(s.store,s.ws,p.operationId,{timing:timing(),receiptId}),fails,'terminal operation cannot consume again');
});

test('abandon transaction rollback retains exact old pins and requires a fresh receipt; accepted operations cannot be abandoned',needsStore,async t=>{
  let s=await acceptFixture(t),p=await pending(s);s=await reopen(s,t);
  const preview=await abandonReportImport(s.store,s.ws,p.operationId,{timing:timing()}),receiptId=confirm(s,preview.binding!),abort=new AbortController();
  evidenceIo.after=point=>{if(point==='abandon-before-commit')abort.abort();};
  let result;try{result=await abandonReportImport(s.store,s.ws,p.operationId,{timing:{signal:abort.signal},receiptId});}finally{evidenceIo.after=null;}
  assert.equal(result.status,'applicationUnknown','canceled context cannot establish whether the transaction applied');
  assert.equal(evidenceLedgerFor(s.store).operation(p.operationId)!.state,'open');assert.equal(s.store.ledger.listOpenStages(500,{domain:'evidence'}).length,1);
  await assert.rejects(()=>abandonReportImport(s.store,s.ws,p.operationId,{timing:timing(),receiptId}),fails,'spent receipt is not reconstructed after rollback');
  const fresh=await abandonReportImport(s.store,s.ws,p.operationId,{timing:timing()}),done=await abandonReportImport(s.store,s.ws,p.operationId,{timing:timing(),receiptId:confirm(s,fresh.binding!)});assert.equal(done.status,'abandoned');
  const a=await imported(s);s=await reopen(s,t);const op=evidenceLedgerFor(s.store).acceptance(a.result.candidateDigest!)!.operationId;
  await assert.rejects(()=>abandonReportImport(s.store,s.ws,op,{timing:timing()}),fails);
});

test('six-role restart transfer keeps four original pins continuous, replaces receipt audit/root atomically, and accepts exactly once',needsStore,async t=>{
  let s=await acceptFixture(t),p=await pending(s);const old=evidenceLedgerFor(s.store).operation(p.operationId)!.identity;s=await reopen(s,t);
  const preview=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing()}),receiptId=confirm(s,preview.binding!);
  const db=new DatabaseSync(join(s.store.storePath,'ledger.sqlite'));
  db.exec(`CREATE TRIGGER original_dual_pin_control AFTER INSERT ON staging_artifacts
    WHEN (SELECT count(*) FROM staging WHERE evidence_operation_id IS NOT NULL)=2 AND (SELECT count(*) FROM staging_artifacts WHERE stage_id=NEW.stage_id)=6
    BEGIN SELECT RAISE(ABORT,'original dual pin rollback'); END;`);db.close();
  const failed=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing(),receiptId,predecessorId:p.operationId});assert.equal(failed.status,'spentNotPublished');
  assert.equal(evidenceLedgerFor(s.store).operation(p.operationId)!.state,'open');assert.equal(s.store.ledger.listOpenStages(500,{domain:'evidence'}).length,1);
  const remove=new DatabaseSync(join(s.store.storePath,'ledger.sqlite'));remove.exec('DROP TRIGGER original_dual_pin_control');remove.close();
  const fresh=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing()}),done=await acceptReportImportFiles(s.store,s.ws,s.ancestor,s.files,{timing:timing(),receiptId:confirm(s,fresh.binding!),predecessorId:p.operationId});assert.equal(done.status,'accepted',JSON.stringify(done));
  const accepted=evidenceLedgerFor(s.store).acceptance(done.candidateDigest!)!;assert.equal(evidenceLedgerFor(s.store).operation(p.operationId)!.state,'superseded');
  for(const role of ['raw','manifest','normalized','candidate'] as const)assert.equal(old.publication!.roles[role],accepted.identity.publication!.roles[role]);
  assert.notEqual(old.publication!.roles.admission,accepted.identity.publication!.roles.admission);assert.notEqual(old.publication!.root,accepted.root);
  assert.equal(s.store.ledger.listOpenStages(500,{domain:'evidence'}).length,0);assert.equal((await readAcceptedReportImport(s.store,s.ws,done.candidateDigest!,{timing:timing()})).withheld,false);
});
