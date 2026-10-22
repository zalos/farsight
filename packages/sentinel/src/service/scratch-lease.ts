// The owner's scratch, inside the exact store it holds: `<store>/scratch/<epoch>/w-<random>/`, one lease per
// operation. The capture's store boundary covers it, so nothing a run writes there is ever read back as source.
//
// A lease is created only from a store openStore() returned (a look-alike has no owner, so no lease). Each folder
// is made one level at a time (0700, this user, not a link); before and after each one the hold and every folder
// already recorded, from the store root down, are checked again, and the new folder must resolve to its own path.
// A folder replaced or turned into a link on the way refuses the lease; nothing is returned. A copy of the lease
// object is not a lease.
//
// Release removes only what the lease can tie to a consumer it watched stop, never by a name, a count or a ledger
// state alone:
//   - while any container client the lease's runner started is still running, nothing is removed;
//   - a container client configuration folder goes only when it is exactly the folder (path and identity) the
//     execution layer made for a client runner this lease wrapped, and every client of the lease has exited;
//   - anything else in the lease (an attempt's work or prep folder, a restore, a parser folder, an unknown name, a
//     file) keeps the whole lease. Their owners remove them when they stop (the supervisor its work folder, the
//     coordinator its restore and prep); one left behind is evidence of a consumer this lease cannot prove stopped.
//
// Release is bounded from its first read: entries visited (listing included), folder depth and wall time, with
// listings read incrementally. Before every destructive step (each chmod, unlink and rmdir) the hold, every
// recorded folder of the lease and the folder being changed are checked again; the first change seen stops the
// walk, and what is left stays, reported as partial when something was already removed. A folder's mode is set
// through a descriptor opened without following a link; unlink and rmdir are path-based. A process running as the
// same account that swaps paths between two checks is therefore detected only when a check observes it: this is
// the owner-only boundary of ADR 19, not a filesystem confinement.
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants as FS, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, realpathSync, rmdirSync, unlinkSync,
  type BigIntStats, type Dir,
} from 'node:fs';
import { join } from 'node:path';
import type { SentinelStore } from '../store/index.js';
import { StoreError } from '../store/errors.js';
import { boundOwner } from '../store/owner-binding.js';
import { identityOf, STORE_FILE_NAMES, type FileIdentity } from '../store/paths.js';
import { clientConfigOf, type DockerRunner } from '../execution/isolation.js';

const UID = typeof process.getuid === 'function' ? process.getuid() : undefined;
const DIR_FLAGS = FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0);
/** Release budget from its first read: entries visited (listings included), folder depth below the lease, wall time. */
export const LEASE_LIMITS = Object.freeze({ maxEntries: 100_000, maxDepth: 256, maxMs: 30_000 });
type Limits = { readonly maxEntries: number; readonly maxDepth: number; readonly maxMs: number };

export interface ScratchLease {
  /** The lease's folder: the scratch root its consumers are given. */
  readonly path: string;
  /** Wraps a container client runner so the lease knows its clients, and the configuration folder a real one made. */
  readonly wrapRunner: (runner: DockerRunner) => DockerRunner;
}

export type ScratchRetainReason =
  | 'ownerNotHeld' | 'leaseChanged' | 'consumerNotStopped' | 'consumerUnknown' | 'storeUncertain' | 'budgetExhausted' | 'removeFailed';

export type ScratchRelease =
  | { readonly removed: true }
  | { readonly removed: false; readonly reason: ScratchRetainReason; readonly partial: boolean; readonly lease: string };

interface Link { readonly path: string; readonly identity: FileIdentity }

interface LeaseState {
  readonly store: object;
  readonly epoch: string;
  /** store root → scratch → epoch → lease, each with the identity seen when it was made or found. */
  readonly chain: readonly Link[];
  /** Client configuration folders inside this lease, by exact path, as the execution layer made them. */
  readonly configs: Map<string, FileIdentity>;
  live: number;
  released: boolean;
}

const leases = new WeakMap<ScratchLease, LeaseState>();

const fail = (detail: Record<string, string>): never => { throw new StoreError('sentinel.store.scratchUnsafe', detail); };

function lstatOrUndefined(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); } catch { return undefined; }
}

/** Every recorded folder is still a real folder with its recorded identity. */
function chainIntact(chain: readonly Link[]): boolean {
  return chain.every(link => { const st = lstatOrUndefined(link.path); return !!st && !st.isSymbolicLink() && st.isDirectory() && identityOf(st) === link.identity; });
}

/** The folder's identity when it is a real folder of this user closed to others, seen through one no-follow descriptor. */
function checkedDir(path: string): FileIdentity | undefined {
  let fd: number;
  try { fd = openSync(path, DIR_FLAGS); } catch { return undefined; }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isDirectory() || (UID !== undefined && Number(st.uid) !== UID) || (Number(st.mode) & 0o077) !== 0) return undefined;
    const seen = lstatOrUndefined(path);
    if (!seen || seen.isSymbolicLink() || identityOf(seen) !== identityOf(st)) return undefined;
    return identityOf(st);
  } finally { closeSync(fd); }
}

/**
 * Makes one folder under the recorded chain (or accepts an existing private one), checking the hold and the whole
 * chain before and after, and that the new folder resolves to its own path (no ancestor became a link).
 */
function childDir(owner: { assertHeld(): void }, chain: readonly Link[], path: string, fresh: boolean): Link {
  owner.assertHeld();
  if (!chainIntact(chain)) fail({ path, reason: 'a folder above it changed' });
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (fresh || code !== 'EEXIST') fail({ path, reason: code === 'EEXIST' ? 'exists' : 'create' });
  }
  owner.assertHeld();
  if (!chainIntact(chain)) fail({ path, reason: 'a folder above it changed' });
  let real: string;
  try { real = realpathSync.native(path); } catch { return fail({ path, reason: 'unresolvable' }); }
  if (real !== path) fail({ path, reason: 'not its own canonical path' });
  const identity = checkedDir(path) ?? fail({ path, reason: 'not a private folder of this user' });
  return Object.freeze({ path, identity });
}

/** Opens a fresh lease under the exact store this process holds. Refuses anything openStore() did not return. */
export function openScratchLease(store: SentinelStore): ScratchLease {
  const owner = boundOwner(store);
  owner.assertHeld();
  const root: Link = Object.freeze({ path: owner.storePath, identity: owner.rootIdentity });
  const scratch = childDir(owner, [root], join(owner.storePath, STORE_FILE_NAMES.scratch), false);
  const epoch = childDir(owner, [root, scratch], join(scratch.path, owner.epoch), false);
  let leaf: Link | undefined;
  for (let i = 0; i < 8 && !leaf; i++) {
    try { leaf = childDir(owner, [root, scratch, epoch], join(epoch.path, `w-${randomBytes(12).toString('hex')}`), true); } catch (e) {
      if (!(e instanceof StoreError && e.detail?.reason === 'exists')) throw e;
    }
  }
  if (!leaf) return fail({ path: epoch.path, reason: 'no fresh name' });
  const leafPath = leaf.path;
  const chain = Object.freeze([root, scratch, epoch, leaf]);
  // The last check before the capability exists: the hold and every folder it names.
  owner.assertHeld();
  if (!chainIntact(chain)) fail({ path: leafPath, reason: 'a folder of the lease changed' });
  const state: LeaseState = { store, epoch: owner.epoch, chain, configs: new Map(), live: 0, released: false };
  const wrapRunner = (runner: DockerRunner): DockerRunner => {
    // Only the folder the execution layer itself made for this exact runner is ever associated, and only as a direct
    // child of this lease; a caller's runner, or a folder elsewhere, associates nothing.
    const config = clientConfigOf(runner);
    if (config && config.path.startsWith(`${leafPath}/`) && !config.path.slice(leafPath.length + 1).includes('/')) state.configs.set(config.path, config.identity);
    return Object.freeze({
      run: async (args: readonly string[], signal?: AbortSignal) => {
        state.live++;
        // runBounded resolves only once the client process closed, so the count falls after it exited.
        try { return await runner.run(args, signal); } finally { state.live--; }
      },
      runSync: (args: readonly string[]) => { state.live++; try { return runner.runSync(args); } finally { state.live--; } },
      start: (id: string) => {
        state.live++;
        let proc: ReturnType<DockerRunner['start']>;
        try { proc = runner.start(id); } catch (e) { state.live--; throw e; }
        void proc.exited.finally(() => { state.live--; });
        return proc;
      },
    });
  };
  const lease: ScratchLease = Object.freeze({ path: leafPath, wrapRunner });
  leases.set(lease, state);
  return lease;
}

/** A caller's budget can only tighten the defaults; anything not a positive safe integer leaves the default. */
function budgetOf(limits: Partial<Limits> | undefined): Limits {
  const tight = (v: unknown, d: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? Math.min(v, d) : d);
  return { maxEntries: tight(limits?.maxEntries, LEASE_LIMITS.maxEntries), maxDepth: tight(limits?.maxDepth, LEASE_LIMITS.maxDepth), maxMs: tight(limits?.maxMs, LEASE_LIMITS.maxMs) };
}

class Stop extends Error { constructor(readonly reason: ScratchRetainReason) { super(reason); } }

/**
 * Removes the lease when the module comment's conditions hold; otherwise retains it and says why. Never throws over
 * a caller's own error; idempotent.
 */
export function releaseScratchLease(store: SentinelStore, lease: ScratchLease, limits?: Partial<Limits>): ScratchRelease {
  const s = leases.get(lease);
  if (!s || s.store !== store) return { removed: false, reason: 'consumerUnknown', partial: false, lease: '' };
  if (s.released) return { removed: true };
  const name = `${s.epoch}/${lease.path.slice(lease.path.lastIndexOf('/') + 1)}`;
  let partial = false;
  const retain = (reason: ScratchRetainReason): ScratchRelease => Object.freeze({ removed: false, reason, partial, lease: name });
  const budget = budgetOf(limits);
  const deadline = Date.now() + budget.maxMs;
  let entries = 0;
  const spend = () => { if (++entries > budget.maxEntries || Date.now() > deadline) throw new Stop('budgetExhausted'); };
  // A client still running may be using anything in the lease, whatever the lease holds.
  if (s.live > 0) return retain('consumerNotStopped');
  const fence = (below: readonly Link[] = []) => {
    if (s.live > 0) throw new Stop('consumerNotStopped');
    try { store.assertHeld(); } catch { throw new Stop('ownerNotHeld'); }
    if (!chainIntact([...s.chain, ...below])) throw new Stop('leaseChanged');
    if (Date.now() > deadline) throw new Stop('budgetExhausted');
  };
  try {
    fence();
    const leaf = s.chain[s.chain.length - 1]!;
    // The lease's own listing, read incrementally within the budget: the first child the lease cannot tie to a
    // stopped consumer keeps the whole lease, before anything is removed.
    const children: Link[] = [];
    eachEntry(leaf.path, entry => {
      spend();
      const path = join(leaf.path, entry);
      const identity = s.configs.get(path);
      const st = lstatOrUndefined(path);
      if (!identity || !st || st.isSymbolicLink() || !st.isDirectory() || identityOf(st) !== identity) throw new Stop('consumerUnknown');
      children.push(Object.freeze({ path, identity }));
    });
    for (const child of children) removeTree([child], budget, spend, fence, () => { partial = true; });
    fence();
    rmdirSync(leaf.path); // never recursive: anything that appeared since keeps the lease
  } catch (e) {
    if (e instanceof Stop) return retain(e.reason);
    return retain('removeFailed');
  }
  s.released = true;
  // The epoch folder goes too once empty; another lease of this epoch keeps it.
  try { store.assertHeld(); if (chainIntact(s.chain.slice(0, 3))) rmdirSync(s.chain[2]!.path); } catch { /* still in use, or not ours to judge */ }
  return { removed: true };
}

/** Each entry name of a folder, read incrementally through one directory handle. */
function eachEntry(path: string, visit: (name: string) => void): void {
  let dir: Dir;
  try { dir = opendirSync(path, { bufferSize: 16 }); } catch { throw new Stop('leaseChanged'); }
  try { for (let e = dir.readSync(); e; e = dir.readSync()) visit(e.name); } finally { dir.closeSync(); }
}

/**
 * Post-order removal of the last folder of `below` (the folders from the lease down to it, each with its known
 * identity), fenced before every destructive step against the hold, the lease and every one of those folders.
 */
function removeTree(below: readonly Link[], budget: Limits, spend: () => void, fence: (below?: readonly Link[]) => void, removed: () => void): void {
  const dir = below[below.length - 1]!;
  if (below.length > budget.maxDepth) throw new Stop('budgetExhausted');
  fence(below);
  let fd: number;
  try { fd = openSync(dir.path, DIR_FLAGS); } catch { throw new Stop('leaseChanged'); }
  try {
    if (identityOf(fstatSync(fd, { bigint: true })) !== dir.identity) throw new Stop('leaseChanged');
    fence(below);
    // Through the descriptor: a sealed folder is reopened without following a path that may have changed.
    fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
  eachEntry(dir.path, name => {
    spend();
    const path = join(dir.path, name);
    const st = lstatOrUndefined(path);
    if (!st) return;
    if (st.isDirectory()) { removeTree([...below, Object.freeze({ path, identity: identityOf(st) })], budget, spend, fence, removed); return; }
    // A link, file, socket or pipe: unlinked, never followed, and only after the fence holds.
    fence(below);
    unlinkSync(path);
    removed();
  });
  fence(below);
  rmdirSync(dir.path);
  removed();
}
