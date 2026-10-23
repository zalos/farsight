// Bounded independent receipt/admission replay. Retained JSON is never rehydrated into a consumed capability.
import { closeSync, constants as FS, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionIntent, AdmissionEnvelope, ReceiptEnvelope } from '../contracts/index.js';
import { compareTimestamps, isCalendarTimestamp, validateEnvelope } from '../validate.js';
import { admit, type AdmissionRequest } from '../policy/admission.js';
import { intentDigest, type ReceiptBinding } from '../policy/receipts.js';
import { canonicalJson, digestOf } from '../store/ledger-json.js';
import { LedgerError } from '../store/store-types.js';
import { currentImportPolicy, ownerContextOf, type ImportOwnerContext } from './owner-context.js';

export const AUDIT_BYTES = 16384;
function readAuditFile(path:string,maxBytes:number):Buffer|undefined {
  // Read-only, nonblocking regular-file observations. We do not repair temporary aliases or reconstruct a spend.
  // A pending interrupted ReceiptBook write must first be resolved by that genuine owner path. This is not a
  // same-account filesystem confinement guarantee: identities are checked at the observed boundaries.
  let fd:number;
  try {fd=openSync(path,FS.O_RDONLY|(FS.O_NOFOLLOW??0)|(FS.O_NONBLOCK??0));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;return auditUnavailable();}
  try {
    const before=fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.nlink!==1n||(before.mode&0o077n)!==0n||(process.getuid&&before.uid!==BigInt(process.getuid()))
      ||before.size>BigInt(maxBytes)) auditUnavailable();
    const data=Buffer.alloc(Number(before.size));let off=0;
    while(off<data.length){const n=readSync(fd,data,off,data.length-off,off);if(!n)auditUnavailable();off+=n;}
    if(readSync(fd,Buffer.alloc(1),0,1,data.length)!==0)auditUnavailable();
    const after=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});
    if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs
      ||after.nlink!==1n||named.isSymbolicLink()||!named.isFile()||named.dev!==before.dev||named.ino!==before.ino)auditUnavailable();
    return data;
  }catch{return auditUnavailable();}finally{closeSync(fd);}
}
export function auditUnavailable(): never { throw new LedgerError('sentinel.store.corruptRecord', 'the retained import authority or payload is unavailable'); }
export function boundedAudit(value: unknown): void { if (Buffer.byteLength(canonicalJson(value)) > AUDIT_BYTES) auditUnavailable(); }
export function admissionRequest(context: ImportOwnerContext, binding: ReceiptBinding, now: Date): AdmissionRequest {
  const policy = currentImportPolicy(context, binding.policyRevision);
  return { intent: binding.intent, stateDigest: binding.stateDigest, policy, now, requestedBy: { principal: 'human', channel: 'owner-cli' },
    capability: () => ({ available: true, detail: 'bounded local report-import storage' }),
    credential: () => ({ basis: 'local-only', detail: 'no provider or target is contacted' }) };
}
/** Fixed metadata forecast is checked before spending. It has no authority; only consume returns a live capability. */
export function forecastAdmission(context: ImportOwnerContext, binding: ReceiptBinding, receiptId: string, now: Date): { receipt: ReceiptEnvelope; admission: AdmissionEnvelope } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receiptId)) auditUnavailable();
  const c = ownerContextOf(context), bytes = readAuditFile(join(c.receipts.directory, `${receiptId}.json`), AUDIT_BYTES);
  if (!bytes) auditUnavailable();
  let value: unknown; try { value = JSON.parse(bytes.toString('utf8')); } catch { return auditUnavailable(); }
  const result = validateEnvelope('receipt', value); if (!result.ok) auditUnavailable();
  const receipt = result.value;
  if (receipt.id !== receiptId || receipt.actor.principal !== 'human' || receipt.actor.channel !== 'owner-cli' || receipt.action !== binding.intent.action || receipt.intentDigest !== intentDigest(binding.intent)
    || receipt.stateDigest !== binding.stateDigest || receipt.policyRevision !== binding.policyRevision) auditUnavailable();
  const preview = admit(admissionRequest(context, binding, now));
  if (preview.record.outcome !== 'awaiting-confirmation') auditUnavailable();
  const admission = { ...preview.record, outcome: 'admitted' as const, receipt: digestOf(receipt) };
  if (!validateEnvelope('admission', admission).ok) auditUnavailable();
  boundedAudit({ receipt, admission });
  return { receipt, admission };
}
export function verifyRetainedAudit(context: ImportOwnerContext, value: { receipt: ReceiptEnvelope; receiptDigest: string;
  admission: AdmissionEnvelope; intent: ActionIntent; stateDigest: string; policyRevision: string }): void {
  const c = ownerContextOf(context), checked = validateEnvelope('receipt', value.receipt), record = validateEnvelope('admission', value.admission);
  if (!checked.ok || !record.ok) auditUnavailable();
  const r = checked.value, a = record.value;
  const bytes = readAuditFile(join(c.receipts.directory, `${r.id}.json`), AUDIT_BYTES);
  const spent = readAuditFile(join(c.receipts.directory, `${r.id}.spent`), 64);
  if (!bytes || !spent) auditUnavailable();
  let issued: unknown; try { issued = JSON.parse(bytes.toString('utf8')); } catch { return auditUnavailable(); }
  const when = spent.toString('utf8');
  if (canonicalJson(issued) !== canonicalJson(r) || digestOf(r) !== value.receiptDigest || !isCalendarTimestamp(when)
    || compareTimestamps(r.issuedAt, when) > 0 || compareTimestamps(when, r.expiresAt) >= 0
    || r.action !== value.intent.action || r.intentDigest !== intentDigest(value.intent) || r.stateDigest !== value.stateDigest
    || r.policyRevision !== value.policyRevision || a.action !== r.action || a.intentDigest !== r.intentDigest || a.policyRevision !== r.policyRevision
    || r.actor.principal !== a.requestedBy.principal || r.actor.channel !== a.requestedBy.channel
    || a.receipt !== value.receiptDigest || a.outcome !== 'admitted' || a.requestedBy.principal !== 'human' || a.requestedBy.channel !== 'owner-cli'
    || a.verdicts.policy.reasonCode !== 'sentinel.admission.granted' || a.verdicts.capability.reasonCode !== 'sentinel.admission.capabilityAvailable'
    || a.verdicts.credential.reasonCode !== 'sentinel.admission.credentialLocalOnly' || a.decidedAt !== when || !a.verdicts.policy.allowed || !a.verdicts.policy.asked || !a.verdicts.capability.allowed || !a.verdicts.capability.asked
    || !a.verdicts.credential.allowed || !a.verdicts.credential.asked || a.verdicts.credential.basis !== 'local-only') auditUnavailable();
  boundedAudit(value); ownerContextOf(context);
}
