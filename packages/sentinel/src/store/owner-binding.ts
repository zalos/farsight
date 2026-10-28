// Internal: which owner lock a store returned by openStore() holds. The public SentinelStore deliberately has no
// owner, lock database or resource registration; package code that must bind work to the lock (worker
// execution) resolves it here. This module is not in the package's exports, so it is not part of the public API,
// and only a store this process opened through openStore() resolves: a look-alike object is refused.
import type { StoreOwner } from './owner.js';
import type { FileIdentity } from './paths.js';

const owners = new WeakMap<object, StoreOwner>();

/** Binds a store from openStore to its owner, once; a second binding throws. */
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

/** The exact folder a held store occupies: its canonical path, the identity it was acquired with, and its fence. */
export interface HeldStoreRoot {
  readonly path: string;
  readonly identity: FileIdentity;
  /** Throws unless this process still holds that store, at that folder, under the same epoch. */
  assertHeld(): void;
}

/**
 * The held root of a store from openStore(), after checking the hold; undefined for anything else. A look-alike
 * object (a copy, a spread, a parsed JSON) resolves to nothing, so it can never stand for a store's own folder.
 */
export function heldStoreRoot(store: object): HeldStoreRoot | undefined {
  const owner = owners.get(store);
  if (!owner) return undefined;
  owner.assertHeld();
  return Object.freeze({ path: owner.storePath, identity: owner.rootIdentity, assertHeld: () => owner.assertHeld() });
}
