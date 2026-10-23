// Original fixture: genuine owner/shared admission/import, killed at one private durable write boundary.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openStore} from '../../dist/store/index.js';
import {acceptReportImportFiles} from '../../dist/evidence/accept.js';
import {evidenceIo} from '../../dist/evidence/test-hooks.js';
import {ReceiptBook} from '../../dist/policy/receipts.js';
import {issueReceipt} from '../../dist/policy/owner-receipts.js';
const cfg=JSON.parse(readFileSync(process.argv[2],'utf8'));
const store=await openStore(cfg.ws.storePath),timing={signal:new AbortController().signal};
try {
  const p=await acceptReportImportFiles(store,cfg.ws,cfg.ancestor,cfg.files,{timing});
  if(p.status!=='awaiting-confirmation')throw new Error('original fixture did not await confirmation');
  const book=new ReceiptBook(join(cfg.ws.trustDir,'receipts'));
  const receipt=issueReceipt(book,{channel:'owner-cli',principal:'human'},p.binding,{now:new Date(),ttlMs:60000});
  writeFileSync(cfg.observed,JSON.stringify({candidate:p.binding.intent.input,receiptId:receipt.id}),{mode:0o600});
  evidenceIo.after=point=>{if(point===cfg.point)process.kill(process.pid,'SIGKILL');};
  await acceptReportImportFiles(store,cfg.ws,cfg.ancestor,cfg.files,{timing,receiptId:receipt.id});
  throw new Error('original fixture did not reach its kill boundary');
} finally {store.close();}
