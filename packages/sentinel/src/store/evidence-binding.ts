// Internal owner-to-domain binding. Nothing here exports a Ledger, SQL handle or mutation callback.
import type { EvidencePermit, EvidenceIdentity } from '../evidence/import-operation.js';
import type { ObjectReceipt, LedgerOwner } from './store-types.js';
import type { AbandonPermit } from '../evidence/abandon.js';
import { LedgerError } from './store-types.js';
import { boundOwner } from './owner-binding.js';

export interface EvidenceAcceptance {
  readonly candidateDigest: string; readonly operationId: string; readonly root: string; readonly bindingDigest: string;
  readonly previous: string | null; readonly sequence: number; readonly epoch: string; readonly acceptedAt: string;
  readonly identity: EvidenceIdentity; readonly event: { kind: string; epoch: string; payload: unknown };
  readonly links: readonly { parent: string; child: string }[];
  readonly floors: readonly { id: string; privacy: string }[];
}
export interface AbandonTarget {
  readonly identity: EvidenceIdentity; readonly state: string; readonly epoch: string; readonly stageDigest: string;
  readonly stages: readonly { stageId: string; epoch: string; artifacts: readonly { id: string; schema: string; privacy: string; links: readonly string[] }[] }[];
}
export interface EvidenceOperations {
  head(bindingDigest: string): string | null;
  begin(permit: EvidencePermit): { operationId: string; sequence: number };
  stage(permit: EvidencePermit): { stageId: string; sequence: number };
  abort(permit: EvidencePermit): { operationId: string; sequence: number };
  transfer(permit: EvidencePermit, predecessorId: string): { operationId: string; stageId: string; sequence: number };
  publish(permit: EvidencePermit, receipts: readonly ObjectReceipt[]): EvidenceAcceptance;
  acceptance(candidateDigest: string): EvidenceAcceptance | null;
  abandonTarget(id: string): AbandonTarget;
  abandon(permit: AbandonPermit): { operationId: string; sequence: number };
  operation(id: string): { identity: EvidenceIdentity; state: string; epoch: string; terminal: {sequence:number;kind:string;epoch:string;payload:unknown}|null } | null;
}
const bindings = new WeakMap<object, { operations: EvidenceOperations; storeId: string; epoch: string; closed: () => boolean }>();
const fail = (): never => { throw new LedgerError('sentinel.store.ownerNotHeld', 'no open evidence ledger belongs to this held store'); };
/** Called only by openLedger after construction, once per actual open owner. */
export function bindEvidenceLedger(owner: LedgerOwner, operations: EvidenceOperations, closed: () => boolean): void {
  owner.assertHeld();
  if (bindings.has(owner)) throw new LedgerError('sentinel.store.conflict', 'an open owner already has an evidence ledger');
  bindings.set(owner, { operations, storeId: owner.storeId, epoch: owner.epoch, closed });
}
export function unbindEvidenceLedger(owner: LedgerOwner, operations: EvidenceOperations): void {
  if (bindings.get(owner)?.operations === operations) bindings.delete(owner);
}
/** Only a genuine facade resolves. A retained operations view rechecks its live binding on every call. */
export function evidenceLedgerFor(store: object): EvidenceOperations {
  const owner = boundOwner(store), bound = bindings.get(owner);
  const check = () => {
    owner.assertHeld();
    if (!bound || bindings.get(owner) !== bound || bound.closed() || owner.storeId !== bound.storeId || owner.epoch !== bound.epoch) fail();
  };
  check();
  return Object.freeze({
    head: (binding: string) => { check(); return bound!.operations.head(binding); },
    begin: (permit: EvidencePermit) => { check(); return bound!.operations.begin(permit); },
    stage: (permit: EvidencePermit) => { check(); return bound!.operations.stage(permit); },
    abort: (permit: EvidencePermit) => { check(); return bound!.operations.abort(permit); },
    transfer: (permit: EvidencePermit, predecessor: string) => { check(); return bound!.operations.transfer(permit, predecessor); },
    publish: (permit: EvidencePermit, receipts: readonly ObjectReceipt[]) => { check(); return bound!.operations.publish(permit, receipts); },
    acceptance: (id: string) => { check(); return bound!.operations.acceptance(id); },
    abandonTarget: (id: string) => { check(); return bound!.operations.abandonTarget(id); },
    abandon: (permit: AbandonPermit) => { check(); return bound!.operations.abandon(permit); },
    operation: (id: string) => { check(); return bound!.operations.operation(id); },
  });
}
