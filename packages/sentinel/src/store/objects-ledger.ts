// The adapter between this object store and the ledger's seam (`store-types.ts`). The ledger names a
// representation by artifact id and codec (`identity` | `gzip`); this store names it by raw digest and codec
// (`raw` | `gzip`). Everything the ledger is told about stored bytes is measured here, from the bytes, at the
// moment it asks; nothing is echoed from a receipt or a caller.
import {
  type ObjectCodec, type ObjectReceipt as StoreReceipt, type ObjectRef, type ObjectStore, rawDigestOf,
} from './objects.js';
import { type PrunePlan, type ReachabilitySnapshot, planPrune } from './gc.js';
import type { ArtifactCodec, GcSnapshot, ObjectReceipt, ObjectVerifier, VerifiedObject } from './store-types.js';

const TO_LEDGER: Readonly<Record<ObjectCodec, ArtifactCodec>> = Object.freeze({ raw: 'identity', gzip: 'gzip' });
const FROM_LEDGER: Readonly<Record<ArtifactCodec, ObjectCodec>> = Object.freeze({ identity: 'raw', gzip: 'gzip' });
const DIGEST = /^sha256:([0-9a-f]{64})$/;

const storeCodec = (codec: unknown): ObjectCodec | undefined =>
  typeof codec === 'string' && Object.hasOwn(FROM_LEDGER, codec) ? FROM_LEDGER[codec as ArtifactCodec] : undefined;

/** The ledger's receipt for a publication this store just made. */
export function toLedgerReceipt(receipt: StoreReceipt): ObjectReceipt {
  return Object.freeze({
    id: receipt.artifactId,
    codec: TO_LEDGER[receipt.codec],
    storedDigest: `sha256:${receipt.encodedDigest}`,
    rawSize: receipt.rawSize,
    storedSize: receipt.encodedSize,
  });
}

/** The object reference a ledger receipt names, or undefined when it is not one this store could have issued. */
export function refFromLedgerReceipt(receipt: ObjectReceipt): ObjectRef | undefined {
  if (!receipt || typeof receipt !== 'object') return undefined;
  const codec = storeCodec(receipt.codec);
  const stored = typeof receipt.storedDigest === 'string' ? DIGEST.exec(receipt.storedDigest) : null;
  if (!codec || !stored || typeof receipt.id !== 'string' || !DIGEST.test(receipt.id)) return undefined;
  if (!Number.isSafeInteger(receipt.rawSize) || !Number.isSafeInteger(receipt.storedSize)) return undefined;
  return { rawDigest: rawDigestOf(receipt.id), codec, rawSize: receipt.rawSize, encodedDigest: stored[1]!, encodedSize: receipt.storedSize };
}

/**
 * The ledger's object verifier. `verify({ id, codec })` re-reads this store's bytes and returns what it measured
 * (stored digest and size, decoded size, this store's id), or null when the object is absent, corrupt, unsafe or
 * the reference is malformed. The ledger compares the measurement with its receipt; this side never sees one.
 */
export function ledgerObjectVerifier(store: ObjectStore): ObjectVerifier {
  return Object.freeze({
    verify(ref: { id: string; codec: ArtifactCodec }): VerifiedObject | null {
      const codec = storeCodec(ref?.codec);
      if (!codec || typeof ref.id !== 'string' || !DIGEST.test(ref.id)) return null;
      const m = store.measureSync(rawDigestOf(ref.id), codec);
      if (!m) return null;
      return Object.freeze({
        id: ref.id,
        codec: TO_LEDGER[m.codec],
        storedDigest: `sha256:${m.encodedDigest}`,
        rawSize: m.rawSize,
        storedSize: m.encodedSize,
        storeId: store.storeId,
      });
    },
  });
}

/**
 * The ledger's one-transaction snapshot as a reachability snapshot. The store id and completeness are the
 * ledger's own assertions, carried through unchanged. Absent or non-list parts make it incomplete; a recorded
 * receipt that does not parse becomes an invalid entry rather than being skipped.
 */
export function reachabilityFromLedger(snapshot: GcSnapshot): ReachabilitySnapshot {
  const list = <T>(v: readonly T[] | undefined): readonly T[] | undefined => (Array.isArray(v) ? v : undefined);
  const parts = {
    referenced: list(snapshot?.referenced), retained: list(snapshot?.retained), active: list(snapshot?.active),
    staged: list(snapshot?.staged),
    report: list(snapshot?.reports), links: list(snapshot?.links), objects: list(snapshot?.objects),
  };
  const complete = snapshot?.complete === true && Object.values(parts).every(p => p !== undefined);
  // Every list is a root kind; a missing one makes the snapshot incomplete, a sparse one makes it invalid.
  const roots = (['referenced', 'retained', 'active', 'staged', 'report'] as const)
    .map(kind => ({ kind, id: `ledger:${kind}`, artifacts: [...(parts[kind] ?? [])] }));
  const links = (parts.links ?? []).map(l => (Array.isArray(l) && l.length === 2 ? { from: l[0], to: l[1] } : { from: '', to: '' }));
  const recorded = (parts.objects ?? []).map(r => refFromLedgerReceipt(r) ?? { rawDigest: '', codec: 'raw' as const });
  return { storeId: snapshot?.storeId as string, sequence: snapshot?.sequence as number, complete, roots, links, recorded };
}

/** The part of the ledger a dry-run prune reads. */
export interface GcLedger {
  gcSnapshot(): GcSnapshot;
  currentSequence(): number;
}

/** Snapshot, inspect and plan against one ledger; the plan fails closed if the ledger committed anything meanwhile. */
export function planPruneFromLedger(store: ObjectStore, ledger: GcLedger): Promise<PrunePlan> {
  const snapshot = ledger.gcSnapshot();
  return planPrune(store, reachabilityFromLedger(snapshot), { readSequence: () => ledger.currentSequence() });
}
