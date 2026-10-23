// Private report-import preparation and spending boundary. This checkpoint only pins pending bytes: it cannot
// publish an acceptance, execute a producer or confer findings/coverage/mitigation authority.
import { randomUUID } from 'node:crypto';
import type { ActionIntent } from '../contracts/index.js';
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

export const EVIDENCE_LIMITS = Object.freeze({ openOperations: 64, historyPerBinding: 256, stagesPerOperation: 1,
  artifacts: 4, closure: 2048, links: 4096, bytes: 40 * 1024 * 1024, identityBytes: 512 * 1024 });
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
}
interface Preparation {
  store: SentinelStore; owner: LedgerOwner; proof: RetainedSourceProof; timing: ProofTiming;
  ancestor: RetainedSourceAncestor; binding: ReceiptBinding; bindingDigest: string; priorHead: string | null;
  candidateDigest: string; closure: readonly string[]; artifacts: readonly StagedArtifact[]; bytes: ReadonlyMap<string, Buffer>;
}
const prepared = new WeakMap<object, Preparation>();
const permits = new WeakMap<object, { preparation: Preparation; identity: EvidenceIdentity; receipt: ConsumedReceipt }>();
function boundary(p: Preparation): void {
  const owner = boundOwner(p.store);
  if (owner !== p.owner || owner.storeId !== p.store.storeId || owner.epoch !== p.store.epoch) refuse();
  owner.assertHeld();
  readRetainedSourceProof(p.store, p.proof, p.ancestor, p.timing);
  if (evidenceLedgerFor(p.store).head(p.bindingDigest) !== p.priorHead) refuse();
}
/** No store writes. The caller must perform shared-policy preflight before caller-file reads in the later service. */
export function prepareReportImport(store: SentinelStore, proof: RetainedSourceProof, ancestor: RetainedSourceAncestor,
  policy: EffectivePolicy, timing: ProofTiming, report: Uint8Array, manifest: Uint8Array): PreparedImport {
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
    ancestor: anchor, sourceClosure: closure, adapter: normalized.document.adapter,
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
  const stateDigest = digestOf({ storeId: store.storeId, bindingDigest, candidateDigest, priorHead });
  const intent: ActionIntent = { action: 'evidence.import', input: candidateDigest, effects: ['local-artifacts'], budget: { maxTokens: null, maxCost: null, currency: null },
    scope: { profile: run.envelope.requestedScope.profile, provider: null, targets: ['report-import', anchor.runId, `revision:${anchor.revision}`, anchor.sourceId] } };
  const p: Preparation = { store, owner, proof, timing: fixedTiming, ancestor: anchor, binding: deepFreeze({ intent, stateDigest, policyRevision }), bindingDigest, priorHead, candidateDigest, closure, artifacts: deepFreeze(artifacts), bytes };
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
