// Internal: which owner lock a store returned by openStore() holds. The public SentinelStore deliberately has no
// owner, lock database or resource registration; package code that must bind work to the lock (worker
// execution) resolves it here. This module is not in the package's exports, so it is not part of the public API,
// and only a store this process opened through openStore() resolves: a look-alike object is refused.
import type { StoreOwner } from './owner.js';

const owners = new WeakMap<object, StoreOwner>();

export function bindOwner(store: object, owner: StoreOwner): void {
  if (owners.has(store)) throw new Error('a store is bound to its owner once');
  owners.set(store, owner);
}

/** The owner behind a store from openStore(); throws for anything else. */
export function boundOwner(store: object): StoreOwner {
  const owner = owners.get(store);
  if (!owner) throw new TypeError('not a store opened by openStore()');
  return owner;
}
