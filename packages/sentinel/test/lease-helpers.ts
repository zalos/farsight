// Tests that drive the canonical functions directly take their scratch the way the owner commands do: a lease
// inside the exact store the test holds (service/scratch-lease.ts), released through the same proof.
import { openScratchLease, releaseScratchLease, type ScratchLease } from '../dist/service/scratch-lease.js';
import type { SentinelStore } from '../dist/store/index.js';

const leases = new Map<string, { store: SentinelStore; lease: ScratchLease }>();

/** A fresh lease's folder in `store`. */
export function scratchUnder(store: SentinelStore): string {
  const lease = openScratchLease(store);
  leases.set(lease.path, { store, lease });
  return lease.path;
}

/** Releases the lease behind `path` (kept, inside the store, when a consumer is not proven stopped). */
export function removeScratch(path: string) {
  const held = leases.get(path);
  if (!held) return undefined;
  leases.delete(path);
  return releaseScratchLease(held.store, held.lease);
}
