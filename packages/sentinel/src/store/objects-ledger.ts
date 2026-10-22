// The adapter between this object store and the ledger's draft seam (PR 03 lane B, `store-types.ts`). The ledger
// types are mirrored structurally here, so neither side imports the other while both drafts move; once the
// ledger's types are committed, root integration can replace the mirrors with type imports unchanged.
import { type ObjectCodec, type ObjectReceipt, type ObjectRef, type ObjectStore, rawDigestOf } from './objects.js';
import type { ReachabilitySnapshot } from './gc.js';

/**
 * The ledger's codec names. At 8d50f14 they are `identity` / `gzip-6`; root has decided the names describe the
 * stored format (`raw` / `gzip`, level 6 being writer policy), and the ledger will normalize to them. Both are
 * read; `toLedgerReceipt` emits the ledger's current names until that change lands, then `LEDGER_NAMES` flips.
 */
export type LedgerCodec = 'identity' | 'gzip-6' | 'raw' | 'gzip';

export interface LedgerObjectReceipt {
  readonly id: string;
  readonly codec: LedgerCodec;
  /** `sha256:<hex>` of the stored (possibly compressed) bytes. */
  readonly storedDigest: string;
  readonly rawSize: number;
  readonly storedSize: number;
}

export interface LedgerObjectPresence {
  isDurable(receipt: LedgerObjectReceipt): boolean;
}

export interface LedgerGcSnapshot {
  /** The store the ledger is bound to, asserted by the ledger itself; never filled in by a caller. */
  readonly storeId: string;
  /** Asserted by the ledger: true only when every list was read whole in the one snapshot transaction. */
  readonly complete: boolean;
  readonly sequence: number;
  readonly referenced: readonly string[];
  readonly staged: readonly string[];
  readonly reports: readonly string[];
  readonly active: readonly string[];
  readonly links: readonly (readonly [string, string])[];
  readonly objects: readonly LedgerObjectReceipt[];
}

const LEDGER_NAMES: Record<ObjectCodec, LedgerCodec> = { raw: 'identity', gzip: 'gzip-6' };
const FROM_LEDGER: Record<LedgerCodec, ObjectCodec> = { identity: 'raw', 'gzip-6': 'gzip', raw: 'raw', gzip: 'gzip' };
const DIGEST = /^sha256:([0-9a-f]{64})$/;

export function toLedgerReceipt(receipt: ObjectReceipt): LedgerObjectReceipt {
  return Object.freeze({
    id: receipt.artifactId,
    codec: LEDGER_NAMES[receipt.codec],
    storedDigest: `sha256:${receipt.encodedDigest}`,
    rawSize: receipt.rawSize,
    storedSize: receipt.encodedSize,
  });
}

/** The object reference a ledger receipt names, or undefined when it is not one this store could have issued. */
export function refFromLedgerReceipt(receipt: LedgerObjectReceipt): ObjectRef | undefined {
  if (!receipt || typeof receipt !== 'object') return undefined;
  const codec = Object.hasOwn(FROM_LEDGER, receipt.codec) ? FROM_LEDGER[receipt.codec] : undefined;
  const stored = typeof receipt.storedDigest === 'string' ? DIGEST.exec(receipt.storedDigest) : null;
  if (!codec || !stored || typeof receipt.id !== 'string' || !DIGEST.test(receipt.id)) return undefined;
  if (!Number.isSafeInteger(receipt.rawSize) || !Number.isSafeInteger(receipt.storedSize)) return undefined;
  return { rawDigest: rawDigestOf(receipt.id), codec, rawSize: receipt.rawSize, encodedDigest: stored[1]!, encodedSize: receipt.storedSize };
}

/**
 * The ledger's synchronous presence check. Each call re-reads and hashes this store's bytes on disk; a receipt
 * is never trusted on its own, and anything it cannot verify (missing, corrupt, unsafe, malformed) is not durable.
 */
export function ledgerObjectPresence(store: ObjectStore): LedgerObjectPresence {
  return Object.freeze({
    isDurable(receipt: LedgerObjectReceipt): boolean {
      const ref = refFromLedgerReceipt(receipt);
      if (!ref) return false;
      try {
        return store.checkSync(ref).status === 'ok';
      } catch {
        return false;
      }
    },
  });
}

/**
 * The ledger's one-transaction snapshot as a reachability snapshot for `inspectReachability`/`planPrune`.
 * The store id and completeness are the ledger's own assertions, carried through unchanged: a snapshot without
 * them fails the inspection closed (wrong store, incomplete). Absent or non-list parts also make it incomplete;
 * a recorded receipt that does not parse becomes an invalid entry rather than being skipped.
 */
export function reachabilityFromLedger(snapshot: LedgerGcSnapshot): ReachabilitySnapshot {
  const list = <T>(v: readonly T[] | undefined): readonly T[] | undefined => (Array.isArray(v) ? v : undefined);
  const parts = {
    referenced: list(snapshot?.referenced), active: list(snapshot?.active), staged: list(snapshot?.staged),
    report: list(snapshot?.reports), links: list(snapshot?.links), objects: list(snapshot?.objects),
  };
  const complete = snapshot?.complete === true && Object.values(parts).every(p => p !== undefined);
  const roots = (['referenced', 'active', 'staged', 'report'] as const)
    .map(kind => ({ kind, id: `ledger:${kind}`, artifacts: [...(parts[kind] ?? [])] }));
  const links = (parts.links ?? []).map(l => (Array.isArray(l) && l.length === 2 ? { from: l[0], to: l[1] } : { from: '', to: '' }));
  const recorded = (parts.objects ?? []).map(r => refFromLedgerReceipt(r) ?? { rawDigest: '', codec: 'raw' as const });
  return {
    storeId: snapshot?.storeId as string,
    sequence: snapshot?.sequence as number,
    complete,
    roots,
    links,
    recorded,
  };
}

