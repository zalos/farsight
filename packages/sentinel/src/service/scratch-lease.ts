// The owner's scratch, inside the exact store it holds: `<store>/scratch/<epoch>/w-<random>/`, one lease per
// operation. The capture's store boundary covers it, so nothing a run writes there is ever read back as source.
//
// A lease is created only from a store openStore() returned (a look-alike has no owner, so no lease), with the hold
// checked before and after, every folder made one level at a time (0700, this user, not a link) and their identities
// recorded privately. A copy of the lease object is not a lease.
//
// Release removes the lease only when every consumer that could still use it is proven stopped by the existing
// lifecycle records, never by a promise settling, a path or a name alone:
//   - an attempt's work or prep folder: its attempt is this store's and this epoch's, ended in the ledger (the
//     coordinator ends an attempt only after the supervisor reaped its worker, whose journal record is settled only
//     after the process exited, and whose container intent is settled only after its removal was confirmed), and
//     neither the worker journal, the intent journal nor the terminal-unknown journal still names it;
//   - a container client configuration folder: every Docker client this lease's runner started has exited, and
//     the lease saw every connection that made one;
//   - anything else (a restore still present, a parser folder, an unknown name, a file): its consumers are not
//     known, so the lease is retained.
// Store-wide uncertainty that cannot be tied to this lease's attempts (an unreadable journal record, a
// terminal-unknown entry naming no attempt) retains it too; it is never evidence that the lease is safe to remove.
//
// Removal is itself bounded: a post-order walk of at most MAX_ENTRIES entries, MAX_DEPTH levels and MAX_MS, each
// folder opened without following a link, its identity compared and its mode set through that descriptor, then
// each entry unlinked and each folder removed with a non-recursive rmdir. Running out of budget or seeing an
// identity change stops there and retains what is left; entries already removed stay removed and the result says
// so. The descriptor checks keep a chmod from following a link that was observed in place; the later path-based
// unlink and rmdir are not descriptor-relative, so a process running as the same account that swaps paths between
// two checks is detected only when the swap is observed. That is the owner-only boundary of ADR 19, not a
// filesystem confinement.
import { randomBytes } from 'node:crypto';
import { closeSync, constants as FS, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import type { SentinelStore } from '../store/index.js';
import { StoreError } from '../store/errors.js';
import { boundOwner } from '../store/owner-binding.js';
import { identityOf, STORE_FILE_NAMES, type FileIdentity } from '../store/paths.js';
import type { DockerRunner } from '../execution/isolation.js';
import { IntentFiles, UnknownCleanup, WorkerFiles } from '../execution/recovery.js';
import { PREP_PREFIX } from '../execution/scratch.js';
import { RESTORE_PREFIX } from '../execution/plan.js';

const UID = typeof process.getuid === 'function' ? process.getuid() : undefined;
const DIR_FLAGS = FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0);
/** Deletion budget: entries visited, folder depth below the lease, and wall time. */
export const LEASE_LIMITS = Object.freeze({ maxEntries: 100_000, maxDepth: 256, maxMs: 30_000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONFIG_PREFIX = 'docker-config-';

export interface ScratchLease {
  /** The lease's folder: the scratch root its consumers are given. */
  readonly path: string;
  /** Wraps a container client runner so the lease knows every client process it started has exited. */
  readonly wrapRunner: (runner: DockerRunner) => DockerRunner;
}

export type ScratchRetainReason =
  | 'ownerNotHeld' | 'leaseChanged' | 'consumerNotStopped' | 'consumerUnknown' | 'storeUncertain' | 'budgetExhausted' | 'removeFailed';

export type ScratchRelease =
  | { readonly removed: true }
  | { readonly removed: false; readonly reason: ScratchRetainReason; readonly partial: boolean; readonly lease: string };

interface LeaseState {
  readonly store: object;
  readonly epoch: string;
  readonly storeRoot: string;
  /** store root → scratch → epoch → lease, each with the identity seen when it was made or found. */
  readonly chain: readonly { readonly path: string; readonly identity: FileIdentity }[];
  live: number;
  connects: number;
  released: boolean;
}

const leases = new WeakMap<ScratchLease, LeaseState>();

const fail = (detail: Record<string, string>): never => { throw new StoreError('sentinel.store.scratchUnsafe', detail); };

/** Creates one level (never parents) or accepts an existing private real folder; returns its identity. */
function privateDir(path: string): FileIdentity {
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') fail({ path, reason: 'create' }); }
  return checkedDir(path) ?? fail({ path, reason: 'not a private folder of this user' });
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

function lstatOrUndefined(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); } catch { return undefined; }
}

/** Opens a fresh lease under the exact store this process holds. Refuses anything openStore() did not return. */
export function openScratchLease(store: SentinelStore): ScratchLease {
  const owner = boundOwner(store);
  owner.assertHeld();
  const scratch = join(owner.storePath, STORE_FILE_NAMES.scratch);
  const scratchId = privateDir(scratch);
  const epochDir = join(scratch, owner.epoch);
  const epochId = privateDir(epochDir);
  let path = '';
  for (let i = 0; i < 8 && !path; i++) {
    const candidate = join(epochDir, `w-${randomBytes(12).toString('hex')}`);
    try { mkdirSync(candidate, { mode: 0o700 }); path = candidate; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') fail({ path: candidate, reason: 'create' }); }
  }
  if (!path) fail({ path: epochDir, reason: 'no fresh name' });
  const leaseId = checkedDir(path) ?? fail({ path, reason: 'not a private folder of this user' });
  owner.assertHeld();
  const state: LeaseState = {
    store, epoch: owner.epoch, storeRoot: owner.storePath, live: 0, connects: 0, released: false,
    chain: Object.freeze([{ path: owner.storePath, identity: owner.rootIdentity }, { path: scratch, identity: scratchId },
      { path: epochDir, identity: epochId }, { path, identity: leaseId }]),
  };
  const wrapRunner = (runner: DockerRunner): DockerRunner => {
    state.connects++;
    return Object.freeze({
      run: async (args: readonly string[], signal?: AbortSignal) => {
        state.live++;
        // runBounded resolves only once the client process closed, so the count falls after it exited.
        try { return await runner.run(args, signal); } finally { state.live--; }
      },
      runSync: (args: readonly string[]) => { state.live++; try { return runner.runSync(args); } finally { state.live--; } },
      start: (id: string) => {
        state.live++;
        const proc = runner.start(id);
        void proc.exited.finally(() => { state.live--; });
        return proc;
      },
    });
  };
  const lease: ScratchLease = Object.freeze({ path, wrapRunner });
  leases.set(lease, state);
  return lease;
}

/** Why a lease child may not be removed yet, or undefined when its consumers are proven stopped. */
function childVerdict(store: SentinelStore, s: LeaseState, name: string, journals: Journals): ScratchRetainReason | undefined {
  if (name.startsWith(CONFIG_PREFIX)) return s.live === 0 ? undefined : 'consumerNotStopped';
  if (name.startsWith(RESTORE_PREFIX)) return 'consumerUnknown';
  const attempt = attemptOf(name);
  if (!attempt) return 'consumerUnknown';
  const row = store.ledger.getAttempt(attempt);
  if (!row || row.epoch !== s.epoch) return 'consumerUnknown';
  if (row.state === 'running') return 'consumerNotStopped';
  if (journals.attempts.has(attempt)) return 'consumerNotStopped';
  return undefined;
}

/** The attempt a supervisor work folder (`<attempt>-<uuid>`) or a driver's prep folder (`prep.<attempt>.<uuid>`) is for. */
export function attemptOf(name: string): string | undefined {
  const cut = name.length - 37;
  if (cut <= 0 || !UUID.test(name.slice(cut + 1))) return undefined;
  if (name.startsWith(PREP_PREFIX)) return name[cut] === '.' ? name.slice(PREP_PREFIX.length, cut) || undefined : undefined;
  return name[cut] === '-' ? name.slice(0, cut) : undefined;
}

interface Journals { readonly attempts: ReadonlySet<string>; readonly uncertain: boolean }

/** Every attempt the store's lifecycle journals still hold open; `uncertain` when one cannot be tied to an attempt. */
function readJournals(store: SentinelStore): Journals {
  const attempts = new Set<string>();
  const workers = new WorkerFiles(store.storePath).list();
  const intents = new IntentFiles(store.storePath).list();
  for (const w of workers.records) attempts.add(String(w.attempt));
  for (const i of intents.records) attempts.add(String(i.attempt));
  let uncertain = workers.unresolved.length > 0 || intents.unresolved.length > 0;
  for (const name of new UnknownCleanup(store.storePath).list()) {
    const m = /^workers\.(.+)\.json$/.exec(name);
    if (m) attempts.add(m[1]!); else uncertain = true;
  }
  return { attempts, uncertain };
}

function chainIntact(s: LeaseState): boolean {
  return s.chain.every(link => { const st = lstatOrUndefined(link.path); return !!st && !st.isSymbolicLink() && st.isDirectory() && identityOf(st) === link.identity; });
}

/**
 * Removes the lease when every consumer is proven stopped (see the module comment); otherwise retains it and says
 * why. Never throws over a caller's own error; idempotent.
 */
export function releaseScratchLease(store: SentinelStore, lease: ScratchLease, limits: Readonly<typeof LEASE_LIMITS> = LEASE_LIMITS): ScratchRelease {
  const s = leases.get(lease);
  if (!s || s.store !== store) return { removed: false, reason: 'consumerUnknown', partial: false, lease: '' };
  const name = `${s.epoch}/${lease.path.slice(lease.path.lastIndexOf('/') + 1)}`;
  const retain = (reason: ScratchRetainReason, partial = false): ScratchRelease => Object.freeze({ removed: false, reason, partial, lease: name });
  if (s.released) return { removed: true };
  try { store.assertHeld(); } catch { return retain('ownerNotHeld'); }
  if (!chainIntact(s)) return retain('leaseChanged');
  let names: string[];
  try { names = readdirSync(lease.path); } catch { return retain('leaseChanged'); }
  let journals: Journals;
  try { journals = readJournals(store); } catch { return retain('storeUncertain'); }
  const configs = names.filter(n => n.startsWith(CONFIG_PREFIX)).length;
  if (configs > s.connects) return retain('consumerUnknown');
  for (const child of names) {
    const verdict = childVerdict(store, s, child, journals);
    if (verdict) return retain(verdict);
  }
  if (journals.uncertain) return retain('storeUncertain');
  const budget = { entries: 0, deadline: Date.now() + limits.maxMs, maxEntries: limits.maxEntries, maxDepth: limits.maxDepth };
  const leaf = s.chain[s.chain.length - 1]!;
  let removedAny = false;
  try {
    const outcome = removeTree(leaf.path, leaf.identity, 0, budget, () => { removedAny = true; }, () => { store.assertHeld(); return chainIntact(s); });
    if (outcome !== 'removed') return retain(outcome, removedAny);
  } catch { return retain('removeFailed', removedAny); }
  s.released = true;
  // The epoch folder goes too once empty; another lease of this epoch keeps it.
  try { rmdirSync(s.chain[2]!.path); } catch { /* still in use, or not ours to judge */ }
  return { removed: true };
}

type TreeOutcome = 'removed' | 'budgetExhausted' | 'leaseChanged' | 'ownerNotHeld';

/** Post-order removal of one folder with its identity checked through a no-follow descriptor; bounded by `budget`. */
function removeTree(path: string, identity: FileIdentity, depth: number, budget: { entries: number; deadline: number; readonly maxEntries: number; readonly maxDepth: number },
  removed: () => void, fence: () => boolean): TreeOutcome {
  if (depth > budget.maxDepth || Date.now() > budget.deadline) return 'budgetExhausted';
  let fd: number;
  try { fd = openSync(path, DIR_FLAGS); } catch { return 'leaseChanged'; }
  try {
    if (identityOf(fstatSync(fd, { bigint: true })) !== identity) return 'leaseChanged';
    // Through the descriptor: a sealed folder is reopened without following a path that may have changed.
    fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
  let names: string[];
  try { names = readdirSync(path); } catch { return 'leaseChanged'; }
  const again = lstatOrUndefined(path);
  if (!again || again.isSymbolicLink() || identityOf(again) !== identity) return 'leaseChanged';
  for (const name of names) {
    if (++budget.entries > budget.maxEntries || Date.now() > budget.deadline) return 'budgetExhausted';
    const child = join(path, name);
    const st = lstatOrUndefined(child);
    if (!st) continue;
    if (st.isDirectory()) {
      const inner = removeTree(child, identityOf(st), depth + 1, budget, removed, fence);
      if (inner !== 'removed') return inner;
    } else {
      // A link, file, socket or pipe: unlinked, never followed.
      unlinkSync(child);
      removed();
    }
  }
  if (depth === 0) {
    try { if (!fence()) return 'leaseChanged'; } catch { return 'ownerNotHeld'; }
  }
  const last = lstatOrUndefined(path);
  if (!last || last.isSymbolicLink() || identityOf(last) !== identity) return 'leaseChanged';
  rmdirSync(path);
  removed();
  return 'removed';
}
