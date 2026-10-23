// Private report-import preparation and fixed publication permits. Legacy pending-only permits cannot accept
// roots. Neither permit kind executes a producer or confers findings, coverage or mitigation authority.
import { randomUUID } from 'node:crypto';
import type { ActionIntent, AdmissionEnvelope, ReceiptEnvelope } from '../contracts/index.js';
import { normalizeImport } from '../imports/normalize.js';
import { IMPORT_CEILINGS } from '../imports/types.js';
import { readRetainedSourceProof, type ProofTiming, type RetainedSourceAncestor, type RetainedSourceProof } from '../execution/retained-source.js';
import { intentDigest, receiptAuthority, type ConsumedReceipt, type ReceiptBinding } from '../policy/receipts.js';
import { isEffectivePolicy, type EffectivePolicy } from '../policy/settings.js';
import { deepFreeze } from '../policy/immutable.js';
import type { SentinelStore } from '../store/index.js';
import { evidenceLedgerFor } from '../store/evidence-binding.js';
import { boundOwner } from '../store/owner-binding.js';
import { canonicalJson, digestOf } from '../store/ledger-json.js';
import { LedgerError, type LedgerOwner, type StagedArtifact } from '../store/store-types.js';

import { currentImportPolicy, ownerContextOf, type ImportOwnerContext } from './owner-context.js';
import { boundedAudit, verifyRetainedAudit } from './audit.js';

export const EVIDENCE_LIMITS = Object.freeze({ openOperations: 64, historyPerBinding: 256, stagesPerOperation: 1,
  artifacts: 6, closure: 2048, links: 4096, bytes: 40 * 1024 * 1024, identityBytes: 512 * 1024 });
function refuse(): never { throw new LedgerError('sentinel.store.invalidInput', 'report import operation is unavailable or not authorized'); }
declare const preparedBrand: unique symbol;
export interface PreparedImport { readonly [preparedBrand]: true }
declare const permitBrand: unique symbol;
export interface EvidencePermit { readonly [permitBrand]: true }
export interface EvidenceIdentity {
  readonly schema: 'sentinel-report-import-operation/1';
  readonly id: string; readonly nonce: string; readonly storeId: string; readonly epoch: string;
  readonly ancestor: RetainedSourceAncestor; readonly bindingDigest: string; readonly candidateDigest: string;
  readonly priorHead: string | null; readonly policyRevision: string; readonly receiptId: string; readonly receiptDigest: string;
  readonly receipt: ConsumedReceipt['receipt']; readonly intent: ActionIntent; readonly stateDigest: string;
  readonly closure: readonly string[]; readonly artifacts: readonly StagedArtifact[];
  readonly publication?: ImportPublication;
}
export interface ImportPublication {
  readonly workspaceDigest: string; readonly adapter: { readonly id: string; readonly version: string };
  readonly root: string; readonly roles: ImportRoles; readonly admission: AdmissionEnvelope;
}
export interface ImportRoles {
  readonly raw: string; readonly manifest: string; readonly normalized: string; readonly candidate: string; readonly admission: string;
}
export interface AcceptedImportRoot {
  readonly schema: 'sentinel-accepted-evidence/1'; readonly domain: 'report-import'; readonly authority: 'owner-associated-imported-claims';
  readonly storeId: string; readonly workspaceDigest: string; readonly operationId: string; readonly epoch: string; readonly nonce: string;
  readonly ancestor: RetainedSourceAncestor; readonly bindingDigest: string; readonly candidateDigest: string; readonly priorHead: string | null;
  readonly adapter: { readonly id: string; readonly version: string }; readonly roles: ImportRoles;
  readonly sourceClosure: readonly string[]; readonly receiptDigest: string;
}
interface Preparation {
  store: SentinelStore; owner: LedgerOwner; proof: RetainedSourceProof; timing: ProofTiming;
  ancestor: RetainedSourceAncestor; binding: ReceiptBinding; bindingDigest: string; priorHead: string | null;
  context?: ImportOwnerContext;
  candidateDigest: string; closure: readonly string[]; artifacts: readonly StagedArtifact[]; bytes: ReadonlyMap<string, Buffer>;
}
const prepared = new WeakMap<object, Preparation>();
const permits = new WeakMap<object, { preparation: Preparation; identity: EvidenceIdentity; receipt: ConsumedReceipt }>();
function boundary(p: Preparation): void {
  const owner = boundOwner(p.store);
  if (owner !== p.owner || owner.storeId !== p.store.storeId || owner.epoch !== p.store.epoch) refuse();
  owner.assertHeld();
  if (p.context) currentImportPolicy(p.context, p.binding.policyRevision);
  readRetainedSourceProof(p.store, p.proof, p.ancestor, p.timing);
  if (evidenceLedgerFor(p.store).head(p.bindingDigest) !== p.priorHead) refuse();
}
/** No store writes. The caller must perform shared-policy preflight before caller-file reads in the later service. */
export function prepareReportImport(store: SentinelStore, proof: RetainedSourceProof, ancestor: RetainedSourceAncestor,
  policy: EffectivePolicy, timing: ProofTiming, report: Uint8Array, manifest: Uint8Array): PreparedImport {
  return prepare(store, proof, ancestor, policy, timing, report, manifest);
}
export function prepareOwnedReportImport(context: ImportOwnerContext, proof: RetainedSourceProof, ancestor: RetainedSourceAncestor,
  report: Uint8Array, manifest: Uint8Array): PreparedImport {
  const c = ownerContextOf(context), policy = currentImportPolicy(context);
  return prepare(c.store, proof, ancestor, policy, { signal: c.signal, deadlineAt: c.deadlineAt }, report, manifest, context);
}
function prepare(store: SentinelStore, proof: RetainedSourceProof, ancestor: RetainedSourceAncestor,
  policy: EffectivePolicy, timing: ProofTiming, report: Uint8Array, manifest: Uint8Array, context?: ImportOwnerContext): PreparedImport {
  if (!isEffectivePolicy(policy)) refuse();
  const owner = boundOwner(store);
  // Snapshot trusted timing once: accessors cannot change cancellation or extend its deadline after preparation.
  const fixedTiming = Object.freeze({ signal: timing.signal, deadlineAt: timing.deadlineAt, stillWithin: timing.stillWithin });
  const view = readRetainedSourceProof(store, proof, ancestor, fixedTiming);
  if (!(report instanceof Uint8Array) || !(manifest instanceof Uint8Array) || report.byteLength > IMPORT_CEILINGS.rawBytes || manifest.byteLength > IMPORT_CEILINGS.manifestBytes) refuse();
  const raw = Buffer.from(report), man = Buffer.from(manifest);
  const normalized = normalizeImport(raw, man);
  if (normalized.status !== 'normalized') refuse();
  const anchor = Object.freeze({ ...view.ancestor });
  const closure = Object.freeze([...new Set(view.closure.map(c => c.id))].sort());
  if (closure.length > EVIDENCE_LIMITS.closure) refuse();
  const bindingDigest = digestOf({ domain: 'report-import', storeId: store.storeId, ancestor: anchor });
  const candidate = { schema: 'sentinel-report-import-candidate/1', domain: 'report-import', storeId: store.storeId,
    ancestor: anchor, ...(context ? { workspaceDigest: ownerContextOf(context).workspaceDigest } : {}), sourceClosure: closure, adapter: normalized.document.adapter,
    raw: normalized.document.input.rawDigest, manifest: normalized.document.input.manifestDigest, normalized: normalized.digest,
    // Owner association is distinct from every producer, deployment or observation claim in the imported bytes.
    authority: 'owner-associated-imported-claims' };
  const candidateBytes = Buffer.from(canonicalJson(candidate)), candidateDigest = digestOf(candidate);
  const bytes = new Map<string, Buffer>();
  const artifacts: StagedArtifact[] = [];
  for (const [id, data, schema] of [[candidate.raw, raw, 'application/octet-stream'], [candidate.manifest, man, 'sentinel-import-manifest/draft-1'],
    [candidate.normalized, Buffer.from(normalized.canonical), 'sentinel-import-normalized/draft-1'], [candidateDigest, candidateBytes, candidate.schema]] as const) {
    if (!bytes.has(id)) { bytes.set(id, data); artifacts.push({ id, schema, privacy: 'source-derived', links: id === candidateDigest ? [...new Set([candidate.raw, candidate.manifest, candidate.normalized, ...closure])].filter(c => c !== id) : [] }); }
  }
  checkEvidenceBounds(artifacts.length, [...bytes.values()].reduce((n, b) => n + b.length, 0), closure.length, artifacts.reduce((n, a) => n + (a.links?.length ?? 0), 0));
  const run = store.ledger.getRun(anchor.runId);
  if (!run) refuse();
  // The source anchor retains the historical policy in its closure. This input supplies the separate admission
  // revision; its branding does not prove currentness. The later trusted service must obtain/recheck that policy.
  const policyRevision = policy.revision;
  const priorHead = evidenceLedgerFor(store).head(bindingDigest);
  const stateDigest = digestOf({ storeId: store.storeId, bindingDigest, candidateDigest, priorHead, ...(context ? { workspaceDigest: ownerContextOf(context).workspaceDigest, epoch: owner.epoch } : {}) });
  const intent: ActionIntent = { action: 'evidence.import', input: candidateDigest, effects: ['local-artifacts'], budget: { maxTokens: null, maxCost: null, currency: null },
    scope: { profile: run.envelope.requestedScope.profile, provider: null, targets: ['report-import', anchor.runId, `revision:${anchor.revision}`, anchor.sourceId] } };
  const p: Preparation = { ...(context ? { context } : {}), store, owner, proof, timing: fixedTiming, ancestor: anchor, binding: deepFreeze({ intent, stateDigest, policyRevision }), bindingDigest, priorHead, candidateDigest, closure, artifacts: deepFreeze(artifacts), bytes };
  boundary(p);
  const token = Object.freeze({}) as PreparedImport;
  prepared.set(token, p);
  return token;
}
/** Fixed measured cooperative caps; no caller can raise them. Separate from the 16MiB per-object store ceiling. */
export function checkEvidenceBounds(artifacts: number, bytes: number, closure: number, links: number): void {
  for (const [n, cap] of [[artifacts, EVIDENCE_LIMITS.artifacts], [bytes, EVIDENCE_LIMITS.bytes], [closure, EVIDENCE_LIMITS.closure], [links, EVIDENCE_LIMITS.links]] as const) {
    if (!Number.isSafeInteger(n) || n < 0 || n > cap!) refuse();
  }
}
export function reportImportBinding(value: PreparedImport): ReceiptBinding {
  const p = prepared.get(value); if (!p) refuse(); boundary(p);
  return structuredClone(p.binding);
}
/** Only a genuine receipt consumed for this exact prepared candidate/state/policy can create the private permit. */
export function authorizeReportImport(value: PreparedImport, receipt: ConsumedReceipt): EvidencePermit {
  const p = prepared.get(value); if (!p) refuse(); boundary(p);
  const authority = receiptAuthority(receipt);
  if (!authority || authority.action !== 'evidence.import' || authority.intentDigest !== intentDigest(p.binding.intent)
    || receipt.receipt.stateDigest !== p.binding.stateDigest || receipt.receipt.policyRevision !== p.binding.policyRevision) refuse();
  const nonce = randomUUID(), id = `evidence-${nonce}`;
  const identity: EvidenceIdentity = deepFreeze({ schema: 'sentinel-report-import-operation/1', id, nonce, storeId: p.store.storeId, epoch: p.store.epoch,
    ancestor: p.ancestor, bindingDigest: p.bindingDigest, candidateDigest: p.candidateDigest, priorHead: p.priorHead,
    policyRevision: p.binding.policyRevision, receiptId: receipt.receipt.id, receiptDigest: authority.digest, receipt: receipt.receipt,
    intent: p.binding.intent, stateDigest: p.binding.stateDigest, closure: p.closure, artifacts: p.artifacts });
  if (Buffer.byteLength(canonicalJson(identity)) > EVIDENCE_LIMITS.identityBytes) refuse();
  const permit = Object.freeze({}) as EvidencePermit;
  permits.set(permit, { preparation: p, identity, receipt });
  return permit;
}
/** Internal ledger guard. Returning immutable metadata does not export the private permit or an authority factory. */
export function readEvidencePermit(value: EvidencePermit, owner: LedgerOwner): EvidenceIdentity {
  const p = permits.get(value); if (!p || p.preparation.owner !== owner) refuse();
  boundary(p.preparation);
  if (receiptAuthority(p.receipt)?.digest !== p.identity.receiptDigest || p.identity.epoch !== owner.epoch || p.identity.storeId !== owner.storeId) refuse();
  return p.identity;
}

// A predicted layout carries no spend/permission. It lets every byte/role/audit bound be checked BEFORE consume.
declare const draftBrand: unique symbol;
export interface ImportPublicationDraft { readonly [draftBrand]: true }
interface Draft { readonly p: Preparation; readonly receipt: ReceiptEnvelope; readonly identity: EvidenceIdentity;
  readonly bytes: ReadonlyMap<string, Buffer>; readonly root: AcceptedImportRoot }
const drafts = new WeakMap<object, Draft>();
const publicationPermits = new WeakMap<object, Draft>();
export function rootOf(i: EvidenceIdentity): AcceptedImportRoot {
  const p = i.publication; if (!p) refuse();
  return { schema: 'sentinel-accepted-evidence/1', domain: 'report-import', authority: 'owner-associated-imported-claims',
    storeId: i.storeId, workspaceDigest: p.workspaceDigest, operationId: i.id, epoch: i.epoch, nonce: i.nonce,
    ancestor: i.ancestor, bindingDigest: i.bindingDigest, candidateDigest: i.candidateDigest, priorHead: i.priorHead,
    adapter: p.adapter, roles: p.roles, sourceClosure: i.closure, receiptDigest: i.receiptDigest };
}
export function admissionOf(i: EvidenceIdentity) {
  const p = i.publication; if (!p) refuse();
  return { schema: 'sentinel-evidence-admission/1', operationId: i.id, storeId: i.storeId, epoch: i.epoch,
    workspaceDigest: p.workspaceDigest, candidateDigest: i.candidateDigest, intent: i.intent, stateDigest: i.stateDigest,
    policyRevision: i.policyRevision, receipt: i.receipt, receiptDigest: i.receiptDigest, admission: p.admission };
}
export function draftReportPublication(value: PreparedImport, receipt: ReceiptEnvelope, admission: AdmissionEnvelope): ImportPublicationDraft {
  const p = prepared.get(value); if (!p?.context) refuse(); boundary(p);
  const c = ownerContextOf(p.context), nonce = randomUUID(), id = `evidence-${nonce}`, receiptDigest = digestOf(receipt);
  if (receipt.intentDigest !== intentDigest(p.binding.intent) || receipt.stateDigest !== p.binding.stateDigest || receipt.policyRevision !== p.binding.policyRevision
    || admission.receipt !== receiptDigest || admission.outcome !== 'admitted' || admission.action !== 'evidence.import' || admission.policyRevision !== receipt.policyRevision) refuse();
  boundedAudit({ receipt, admission, intent: p.binding.intent, stateDigest: p.binding.stateDigest, policyRevision: p.binding.policyRevision });
  const candidateBytes = p.bytes.get(p.candidateDigest)!;
  const candidate = JSON.parse(candidateBytes.toString('utf8'));
  const base = { schema: 'sentinel-report-import-operation/1' as const, id, nonce, storeId: p.store.storeId, epoch: p.store.epoch,
    ancestor: p.ancestor, bindingDigest: p.bindingDigest, candidateDigest: p.candidateDigest, priorHead: p.priorHead,
    policyRevision: p.binding.policyRevision, receiptId: receipt.id, receiptDigest, receipt, intent: p.binding.intent,
    stateDigest: p.binding.stateDigest, closure: p.closure };
  const pub = { workspaceDigest: c.workspaceDigest, adapter: candidate.adapter,
    roles: { raw: candidate.raw, manifest: candidate.manifest, normalized: candidate.normalized, candidate: p.candidateDigest, admission: '' },
    admission, root: '' };
  const provisional = { ...base, publication: pub, artifacts: [] } as EvidenceIdentity;
  const audit = admissionOf(provisional); boundedAudit(audit);
  const auditBytes = Buffer.from(canonicalJson(audit));
  pub.roles.admission = digestOf(audit);
  const root = rootOf(provisional), rootBytes = Buffer.from(canonicalJson(root)); pub.root = digestOf(root);
  const bytes = new Map(p.bytes); bytes.set(pub.roles.admission, auditBytes); bytes.set(pub.root, rootBytes);
  const artifacts = [...p.artifacts, { id: pub.roles.admission, schema: 'sentinel-evidence-admission/1', privacy: 'source-derived' as const, links: [] },
    { id: pub.root, schema: 'sentinel-accepted-evidence/1', privacy: 'source-derived' as const, links: [p.candidateDigest, pub.roles.admission] }];
  checkEvidenceBounds(artifacts.length, [...bytes.values()].reduce((n,b) => n+b.length,0), p.closure.length, artifacts.reduce((n,a) => n+(a.links?.length ?? 0),0));
  const identity = deepFreeze({ ...base, publication: pub, artifacts });
  if (Buffer.byteLength(canonicalJson(identity)) > EVIDENCE_LIMITS.identityBytes) refuse();
  const token = Object.freeze({}) as ImportPublicationDraft; drafts.set(token, { p, receipt: deepFreeze(structuredClone(receipt)), identity, bytes, root: deepFreeze(root) });
  return token;
}
/** Only the real consumed receipt and the exact shared-admission result can seal the premeasured owned layout. */
export function sealReportPublication(value: ImportPublicationDraft, receipt: ConsumedReceipt, admission: AdmissionEnvelope): EvidencePermit {
  const d = drafts.get(value); if (!d) refuse(); boundary(d.p);
  const authority = receiptAuthority(receipt);
  if (!authority || authority.action !== 'evidence.import' || authority.digest !== d.identity.receiptDigest
    || authority.intentDigest !== intentDigest(d.identity.intent) || canonicalJson(receipt.receipt) !== canonicalJson(d.receipt)
    || canonicalJson(admission) !== canonicalJson(d.identity.publication!.admission)) refuse();
  const token = Object.freeze({}) as EvidencePermit;
  permits.set(token, { preparation: d.p, identity: d.identity, receipt }); publicationPermits.set(token, d); return token;
}
export function readPublicationPermit(value: EvidencePermit, owner: LedgerOwner): EvidenceIdentity {
  const d = publicationPermits.get(value); if (!d || d.p.owner !== owner || !d.p.context) refuse();
  readEvidencePermit(value, owner); return d.identity;
}
export function publicationCommitBoundary(value: EvidencePermit, owner: LedgerOwner): void {
  const d = publicationPermits.get(value); if (!d?.p.context || d.p.owner !== owner) refuse();
  currentImportPolicy(d.p.context, d.identity.policyRevision, false);
}
export function publicationBytes(value: EvidencePermit): ReadonlyMap<string, Buffer> {
  const d = publicationPermits.get(value); if (!d) refuse(); boundary(d.p);
  return new Map([...d.bytes].map(([id,b]) => [id,Buffer.from(b)]));
}
/** Old immutable ledger audit is independently replayed; obsolete unaccepted audit blob bytes are not authority. */
export function verifyPredecessorAudit(value: EvidencePermit, old: EvidenceIdentity): void {
  if (!old.publication) return;
  const d = publicationPermits.get(value); if (!d?.p.context || !d.identity.publication
    || old.publication.workspaceDigest !== d.identity.publication.workspaceDigest) refuse();
  verifyRetainedAudit(d.p.context, { receipt: old.receipt, receiptDigest: old.receiptDigest, admission: old.publication.admission,
    intent: old.intent, stateDigest: old.stateDigest, policyRevision: old.policyRevision });
}
