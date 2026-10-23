// Genuine process deaths against the actual owner, receipt book, object store and SQLite transactions.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {openStore} from '../dist/store/index.js';
import {evidenceLedgerFor} from '../dist/store/evidence-binding.js';
import {readAcceptedReportImport} from '../dist/evidence/reader.js';
import {needsStore} from './snapshot-helpers.ts';
import {acceptFixture,timing} from './evidence-acceptance-helpers.ts';
const points=['after-spend','after-operation','after-stage','after-objects','before-commit','after-commit','before-reply'] as const;
for(const point of points)test(`SIGKILL at ${point}: original spend, exact pending pins or one complete retained acceptance`,needsStore,async t=>{
  const s=await acceptFixture(t),cfg=join(s.dir,'original-crash.json'),observed=join(s.dir,'original-observed.json');
  writeFileSync(cfg,JSON.stringify({ws:s.ws,ancestor:s.ancestor,files:s.files,point,observed}),{mode:0o600});s.store.close();
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',new URL('./fixtures/evidence-import-crash.mjs',import.meta.url).pathname,cfg],{timeout:20000,encoding:'utf8'});
  assert.equal(child.error,undefined);assert.equal(child.signal,'SIGKILL',`${point}: ${child.stderr}`);assert.ok(existsSync(observed));
  const actual=JSON.parse(readFileSync(observed,'utf8'));assert.ok(existsSync(join(s.book.directory,actual.receiptId+'.spent')),'real receipt was consumed before this boundary');
  const store=await openStore(s.ws.storePath);t.after(()=>store.close());const ops=evidenceLedgerFor(store),accepted=ops.acceptance(actual.candidate);
  const published=point==='after-commit'||point==='before-reply';
  if(published){assert.ok(accepted);assert.equal(accepted.identity.artifacts.length,6);assert.equal((await readAcceptedReportImport(store,s.ws,actual.candidate,{timing:timing()})).withheld,false);}
  else assert.equal(accepted,null,'no partial publication is accepted');
  const pending=store.ledger.listOpenStages(500,{domain:'evidence'});
  assert.equal(pending.length,['after-stage','after-objects','before-commit'].includes(point)?1:0);
  if(pending.length){const db=new DatabaseSync(join(store.storePath,'ledger.sqlite'),{readOnly:true});let id:string;try{id=String(db.prepare('SELECT evidence_operation_id FROM staging WHERE stage_id=?').get(pending[0]!.stageId)!.evidence_operation_id);}finally{db.close();}const operation=ops.operation(id!);assert.ok(operation);assert.equal(operation.state,'open');assert.equal(operation.identity.artifacts.length,6);}
  assert.equal(store.checkIntegrity().foreignKeyViolations,0);
});
