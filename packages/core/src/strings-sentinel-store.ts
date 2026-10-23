import type { StringEntry } from './strings.js';

// Sentinel store errors (PR 03): the SQLite runtime gate, the storage path checks and the owner lock. Each key is
// the stable reason code a StoreError carries; the professional text is its message. Both registers carry the
// same words until the PR 09 vocabulary freeze, as in strings-sentinel-cli.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_STORE_STRINGS: Record<string, StringEntry> = {
  'sentinel.store.runtimeUnavailable': same('the built-in SQLite module is not available in this runtime', 'Sentinel keeps its records in the SQLite module built into Node. This runtime does not provide it, so no store was opened.'),
  'sentinel.store.runtimeUnqualified': same('SQLite {found} has not been qualified for the Sentinel store on {host} (qualified there: {qualified})', 'Qualification is one host with one SQLite release, measured by the store tests. Any other release on that host is refused until it is tested, even on a supported Node major, and a release qualified on one host qualifies no other.'),
  'sentinel.store.runtimeBehavior': same('the SQLite runtime failed a required check: {check}', 'Before any store is opened, the runtime is checked for the functions, table rules and settings the store relies on. One of them behaved differently, so nothing was opened.'),
  'sentinel.store.platformUnqualified': same('the Sentinel store has not been qualified on {platform} (qualified: {qualified})', 'File locking is trusted only on the operating system and processor combinations where the store tests were run. Any other host is refused rather than assumed to behave the same.'),
  'sentinel.store.pathNotAbsolute': same('the store path must be absolute', 'A relative store path would depend on the working directory, so two processes could disagree about which store they own.'),
  'sentinel.store.pathNotCanonical': same('the store path is not in canonical form; use {canonical}', 'The path reaches its folder through a link, a different letter case or a dot segment. Only the canonical spelling is accepted, so every process names the store the same way.'),
  'sentinel.store.pathSymlink': same('the store path or one of its files is a symbolic link', 'A link could point the store somewhere else between checks, so links are refused instead of followed.'),
  'sentinel.store.pathNotDirectory': same('the store path exists and is not a folder', 'The store is a folder of its own. An existing file at that path is left untouched.'),
  'sentinel.store.pathWrongOwner': same('the store folder or a file in it belongs to another user', 'The store must belong to the user running Sentinel, so no other account can read or replace its records.'),
  'sentinel.store.pathPermissions': same('the store folder or a file in it can be read or changed by other users', 'Store folders must be private to their owner and files readable only by their owner. Existing broader permissions are reported, never silently changed.'),
  'sentinel.store.ancestorUnsafe': same('a folder above the store can be changed by other users: {path}', 'Every folder above the store must belong to its user or the system and must not let other accounts rename its entries, so nobody can swap the store out from under its owner.'),
  'sentinel.store.filesystemUnsupported': same('the store is on a file system that has not been qualified for locking: {filesystem}', 'Ownership relies on the operating system locking a local file. Network, synchronised and unrecognised file systems are refused because their locks are not known to hold.'),
  'sentinel.store.fileUnsafe': same('a store file is not a private regular file with a single name', 'The lock file must be an ordinary file with one name, so a second name cannot give another process a separate lock on the same data.'),
  'sentinel.store.identityChanged': same('the store folder or its lock file was replaced while in use', 'The folder or lock file no longer is the one that was locked. Ownership is treated as lost rather than trusted.'),
  'sentinel.store.lockFileCorrupt': same('the store lock file is not a readable SQLite database', 'The lock file exists but SQLite cannot read it as a database. It is left exactly as found, never deleted or recreated, because replacing it would let a second process lock a different file. Move it aside yourself once no Sentinel process is running.'),
  'sentinel.store.ownedElsewhere': same('another Sentinel process owns this store', 'Only one process at a time may own a store. Stop the other process, or wait for it to finish, and try again.'),
  'sentinel.store.ownershipUncertain': same('ownership of the store could not be established', 'The lock could not be taken in a state that proves this process is the only owner, so the store was not used.'),
  'sentinel.store.ownerClosed': same('this store ownership has been released', 'The ownership handle was closed. A new owner must be acquired before the store is used again.'),
  'sentinel.store.ownerLost': same('this process no longer holds the store lock', 'The lock behind this ownership handle is no longer held, so work under it must stop.'),
  'sentinel.store.resourceCloseFailed': same('a store resource failed to close before the lock was released', 'Resources registered with the owner close before its lock is released. One of them failed; the lock was still released.'),
  'sentinel.store.ioFailure': same('the store could not be read or written ({operation})', 'An operating system error stopped a store operation. The error code is recorded; no partial ownership is kept.'),
  'sentinel.store.scratchUnsafe': same('the store\'s scratch folder is not a private folder of this user ({path})', 'Scratch for a run lives inside the store this process holds, in folders it makes itself, closed to everyone else. A link, another user\'s folder or one open to others is refused, never changed or followed.'),
};

export function sentinelStoreWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_STORE_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
