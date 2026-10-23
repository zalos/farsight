// Internal owner-to-domain binding. Nothing here exports a Ledger, SQL handle or mutation callback.
import type { EvidencePermit, EvidenceIdentity } from '../evidence/import-operation.js';
import type { LedgerOwner } from './store-types.js';
import { LedgerError } from './store-types.js';
import { boundOwner } from './owner-binding.js';

export interface EvidenceOperations {
  head(bindingDigest: string): string | null;
  begin(permit: EvidencePermit): { operationId: string; sequence: number };
  stage(permit: EvidencePermit): { stageId: string; sequence: number };
  abort(permit: EvidencePermit): { operationId: string; sequence: number };
  transfer(permit: EvidencePermit, predecessorId: string): { operationId: string; stageId: string; sequence: number };
  operation(id: string): { identity: EvidenceIdentity; state: string; epoch: string } | null;
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
    operation: (id: string) => { check(); return bound!.operations.operation(id); },
  });
}
