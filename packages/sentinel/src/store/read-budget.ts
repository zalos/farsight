// Internal retained-read limits, never a store/owner factory or a public capability. SQLite row reads and trust-
// folder files (rule words/pack/lock/report-key reads) are outside this object-body meter. Detached tasks created
// inside a scope inherit it and intentionally cannot read after it closes; delivery/cache work belongs outside.
// Every facade object read reserves its recorded encoded/decoded size before allocation; repeated/failed
// representations count again. A scope's first limit/cancel/deadline/owner failure survives callers' error mapping.
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { SentinelStore, StoredObject } from './index.js';
import { boundOwner } from './owner-binding.js';
import type { StoreOwner } from './owner.js';
import { ObjectStoreError } from './objects.js';
import { StoreError } from './errors.js';
import { LedgerError } from './store-types.js';
import { ExecutionError } from '../execution/errors.js';

export const READ_BUDGET_LIMITS = Object.freeze({ decodedBytes: 128 * 1024 * 1024, encodedBytes: 128 * 1024 * 1024, reads: 10_000, durationMs: 20_000 });
export interface ReadBudgetOptions {
  readonly decodedBytes?: number; readonly encodedBytes?: number; readonly reads?: number; readonly durationMs?: number;
  readonly signal?: AbortSignal;
}
export interface ReadBudgetUsage { readonly decodedBytes: number; readonly encodedBytes: number; readonly reads: number; readonly elapsedMs: number }
interface Scope {
  readonly store: SentinelStore; readonly owner: StoreOwner; readonly limits: { -readonly [K in keyof typeof READ_BUDGET_LIMITS]: number };
  readonly start: number; readonly deadline: number; readonly signal?: AbortSignal;
  decodedBytes: number; encodedBytes: number; reads: number; closed: boolean; failure?: unknown;
}
const active = new AsyncLocalStorage<readonly Scope[]>();
const scopesOf = (store: SentinelStore) => (active.getStore() ?? []).filter(s => s.store === store);
function latch(scopes: readonly Scope[], error: unknown): never {
  const first = scopes.find(s => s.failure !== undefined)?.failure ?? error;
  for (const s of scopes) if (s.failure === undefined) s.failure = first;
  throw first;
}
/** Check also after awaits/synchronous fold/render steps. Unrelated async contexts/stores are untouched. */
export function readBudgetCheckpoint(store: SentinelStore): void {
  const scopes = scopesOf(store);
  if (!scopes.length) return;
  const failed = scopes.find(s => s.failure !== undefined); if (failed) throw failed.failure;
  try {
    const owner = boundOwner(store);
    if (scopes.some(s => s.owner !== owner || s.closed)) throw new ObjectStoreError('sentinel.object.invalidInput', 'the retained-read scope is closed or belongs to another owner');
    owner.assertHeld();
    if (scopes.some(s => s.signal?.aborted)) throw new ExecutionError('sentinel.execution.canceled');
    if (scopes.some(s => performance.now() >= s.deadline)) throw new ExecutionError('sentinel.execution.deadlineExceeded');
  } catch (error) { latch(scopes, error); }
}
/** Preserve the original typed owner failure even when a caller would replace it with an evidence error. */
export function readBudgetFailure(store: SentinelStore, error: unknown): void {
  const scopes = scopesOf(store);
  if (!scopes.length) return;
  if ((error instanceof StoreError && ['sentinel.store.ownerClosed', 'sentinel.store.ownerLost', 'sentinel.store.ownershipUncertain', 'sentinel.store.identityChanged'].includes(error.code))
    || (error instanceof LedgerError && ['sentinel.store.closed', 'sentinel.store.ownerNotHeld', 'sentinel.store.staleEpoch', 'sentinel.store.storeMismatch'].includes(error.code))) latch(scopes, error);
  readBudgetCheckpoint(store);
}
/** Package-internal scope around the genuine facade; nesting can only add tighter counters/deadlines. */
export async function withStoreReadBudget<T>(store: SentinelStore, options: ReadBudgetOptions, body: () => Promise<T>): Promise<{ value: T; usage: ReadBudgetUsage }> {
  const owner = boundOwner(store); owner.assertHeld();
  const limits: { -readonly [K in keyof typeof READ_BUDGET_LIMITS]: number } = { ...READ_BUDGET_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    const value = options[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < (key === 'durationMs' ? 1 : 0) || value > READ_BUDGET_LIMITS[key]) throw new ObjectStoreError('sentinel.object.invalidInput', 'retained-read limits may only lower the built-in ceilings');
      limits[key] = value;
    }
  }
  const start = performance.now();
  const parents = active.getStore() ?? [];
  const deadline = Math.min(start + limits.durationMs, ...parents.filter(s => s.store === store).map(s => s.deadline));
  const scope: Scope = { store, owner, limits, start, deadline, signal: options.signal, decodedBytes: 0, encodedBytes: 0, reads: 0, closed: false };
  return active.run([...parents, scope], async () => {
    try {
      readBudgetCheckpoint(store);
      const value = await body();
      readBudgetCheckpoint(store);
      return { value, usage: Object.freeze({ decodedBytes: scope.decodedBytes, encodedBytes: scope.encodedBytes, reads: scope.reads, elapsedMs: performance.now() - start }) };
    } catch (error) {
      readBudgetFailure(store, error);
      readBudgetCheckpoint(store); // Restores the latched first failure even if a legacy reader replaced it.
      throw error;
    } finally { scope.closed = true; }
  });
}
/** Exactly one call of the underlying facade read. Do not wrap readArtifact itself as well as its attempts. */
export async function budgetedObjectRead<T>(store: SentinelStore, ref: Pick<StoredObject, 'rawSize' | 'storedSize'>, read: () => Promise<T>): Promise<T> {
  const scopes = scopesOf(store);
  if (!scopes.length) return read();
  readBudgetCheckpoint(store);
  if (![ref.rawSize, ref.storedSize].every(n => Number.isSafeInteger(n) && n >= 0)) throw new ObjectStoreError('sentinel.object.invalidInput', 'the stored read sizes are invalid');
  for (const s of scopes) {
    if (s.reads + 1 > s.limits.reads || s.decodedBytes + ref.rawSize > s.limits.decodedBytes || s.encodedBytes + ref.storedSize > s.limits.encodedBytes) {
      latch(scopes, new ObjectStoreError('sentinel.object.tooLarge', 'the retained-read budget is exhausted'));
    }
  }
  for (const s of scopes) { s.reads++; s.decodedBytes += ref.rawSize; s.encodedBytes += ref.storedSize; }
  try {
    const value = await read();
    readBudgetCheckpoint(store);
    return value;
  } catch (error) { readBudgetFailure(store, error); throw error; }
}
