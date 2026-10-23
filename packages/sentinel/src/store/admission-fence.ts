// Package-internal veto at two durable admission boundaries. This never supplies admission authority or
// changes a public ledger request. A genuine held facade binds the scope; callers may only add a refusal.
// The check is immediately before COMMIT, not a hard bound on how long the disk commit itself takes.
import { AsyncLocalStorage } from 'node:async_hooks';
import { boundOwner } from './owner-binding.js';
import type { LedgerOwner } from './store-types.js';
import { LedgerError } from './store-types.js';
interface Fence { readonly owner: LedgerOwner; readonly veto: () => void; closed: boolean; failure?: unknown }
const active = new AsyncLocalStorage<readonly Fence[]>();
export function admissionFenceCheckpoint(owner: LedgerOwner): void {
  const fences = (active.getStore() ?? []).filter(f => f.owner === owner);
  if (!fences.length) return;
  const first = fences.find(f => f.failure !== undefined);
  if (first) throw first.failure;
  try {
    owner.assertHeld();
    for (const f of fences) {
      if (f.closed) throw new LedgerError('sentinel.store.invalidInput', 'the internal admission fence is closed');
      f.veto();
    }
  } catch (error) {
    for (const f of fences) if (f.failure === undefined) f.failure = error;
    throw error;
  }
}
/** Synchronous ledger call only. Nested scopes add vetoes; unrelated stores/async contexts are untouched. */
export function withAdmissionFence<T>(store: object, veto: () => void, body: () => T): T {
  const owner = boundOwner(store); owner.assertHeld();
  const fence: Fence = { owner, veto, closed: false };
  return active.run([...(active.getStore() ?? []), fence], () => {
    try {
      admissionFenceCheckpoint(owner);
      const value = body();
      if (value && typeof (value as { then?: unknown }).then === 'function') {
        throw new LedgerError('sentinel.store.invalidInput', 'an internal admission fence body must be synchronous');
      }
      // A swallowed veto cannot turn a refused/rolled-back ledger call into success.
      if (fence.failure !== undefined) throw fence.failure;
      return value;
    } catch (error) {
      if (fence.failure !== undefined) throw fence.failure;
      throw error;
    } finally { fence.closed = true; }
  });
}

/** Preparation's asynchronous bootstrap context. Only accepted snapshot/plan/publication effects use its veto;
 * terminal failure records and cleanup remain writable after expiry. Detached callbacks lose this scope on close. */
export async function withAsyncAdmissionFence<T>(store: object, veto: () => void, body: () => Promise<T>): Promise<T> {
  const owner = boundOwner(store); owner.assertHeld();
  const fence: Fence = { owner, veto, closed: false };
  return active.run([...(active.getStore() ?? []), fence], async () => {
    try {
      admissionFenceCheckpoint(owner);
      const value = await body();
      admissionFenceCheckpoint(owner);
      return value;
    } catch (error) {
      if (fence.failure !== undefined) throw fence.failure;
      throw error;
    } finally { fence.closed = true; }
  });
}
