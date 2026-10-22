import type { StringEntry } from './strings.js';

// Sentinel storage errors (PR 03) raised by the ledger, the object store and reachability inspection. Each key is
// the stable reason code a LedgerError, ObjectStoreError or inspection error carries; the owner lock and runtime
// gate codes are in strings-sentinel-store.ts. Both registers carry the same words until the PR 09 vocabulary
// freeze, as in strings-sentinel-cli.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_STORAGE_ERROR_STRINGS: Record<string, StringEntry> = {
  // The ledger.
  'sentinel.store.sqliteUnsupported': same('the ledger could not be opened with the settings it requires', 'The ledger needs write-ahead logging, full synchronous writes and foreign keys. The database refused one of them, so it was not used.'),
  'sentinel.store.notLedger': same('the ledger file is not a Sentinel ledger', 'A database at the ledger path holds tables Sentinel did not create. It is left untouched rather than adopted.'),
  'sentinel.store.unsafePath': same('a ledger file is not a private regular file of this user', 'The ledger and its companion files must be ordinary files with one name, readable only by their owner.'),
  'sentinel.store.newerSchema': same('the ledger was written by a newer build', 'The ledger schema is newer than this build understands. It is refused rather than downgraded; use the newer build.'),
  'sentinel.store.migrationMismatch': same('the ledger schema history does not match this build', 'A recorded schema change differs from the change this build ships, so the ledger is left as it is.'),
  'sentinel.store.migrationFailed': same('the ledger schema upgrade failed and was rolled back', 'Every pending schema change runs in one transaction. One failed, so none was applied and the ledger is as it was.'),
  'sentinel.store.backupFailed': same('the ledger could not be backed up before its upgrade', 'An existing ledger is copied and the copy checked before any schema change. The copy failed, so no change was made.'),
  'sentinel.store.storeMismatch': same('the ledger belongs to another store', 'The ledger names a different store identity than the folder it is in, so it is not used.'),
  'sentinel.store.ownerNotHeld': same('the store owner is no longer held', 'Every ledger change re-checks that this process still owns the store. It does not, so the change was refused.'),
  'sentinel.store.staleEpoch': same('the record belongs to an earlier owner of the store', 'Each owner of a store works under its own epoch. Work started under an earlier one cannot change or publish anything now.'),
  'sentinel.store.closed': same('the ledger is closed', 'The store was closed. Open it again to continue.'),
  'sentinel.store.invalidInput': same('the ledger refused a malformed request', 'An identifier, digest, timestamp, size or record did not have the required form, so nothing was written.'),
  'sentinel.store.notFound': same('the ledger has no such record', 'The run, work, attempt, stage or artifact named is not in the ledger.'),
  'sentinel.store.conflict': same('the ledger refused a change that conflicts with its records', 'A uniqueness or reference rule refused the change, such as a duplicate or a revision out of order.'),
  'sentinel.store.notActiveAttempt': same('the attempt is not the active attempt for that work', 'Only the current attempt of a work revision may publish or end it; a superseded or unrelated attempt cannot.'),
  'sentinel.store.wrongState': same('the record is not in a state that allows that change', 'The run, work or attempt has moved on, for example a run that is no longer accepting work.'),
  'sentinel.store.alreadyPublished': same('that work revision already has an accepted publication', 'Each work revision is accepted at most once. A second publication is refused, however often the work ran.'),
  'sentinel.store.idempotencyConflict': same('that request key was already used for a different request', 'A repeated key with the same request returns the first result. The same key with another request is refused.'),
  'sentinel.store.stagingMismatch': same('the publication does not match what was staged', 'A publication must name exactly the artifacts registered before their bytes were written, for the same attempt and epoch.'),
  'sentinel.store.objectMissing': same('an object named by the publication is absent or differs from its receipt', 'Before a publication is accepted, every object it names is re-read and hashed in this store. One was missing or different, so nothing was accepted.'),
  'sentinel.store.objectVerifierUnavailable': same('publication needs the object store to verify its objects', 'A ledger opened without the object store cannot accept a publication, because nothing could check that its bytes exist.'),
  'sentinel.store.asyncTransaction': same('a ledger transaction must finish without waiting', 'Ledger changes run in short synchronous transactions. A change that waits is refused and rolled back.'),
  'sentinel.store.snapshotStale': same('the ledger changed after the snapshot was taken', 'A reachability snapshot is valid only while nothing is committed after it. Take a new one.'),
  // The object store.
  'sentinel.object.invalidInput': same('the object store refused a malformed request', 'A digest, size, codec or receipt did not have the required form, so nothing was read or written.'),
  'sentinel.object.tooLarge': same('the object is larger than the store accepts', 'Objects above the size limit are refused before they are written, so one artifact cannot exhaust the disk or memory.'),
  'sentinel.object.digestMismatch': same('the bytes do not match the identity registered for them', 'Bytes are checked against the identity staged before the write. Different bytes are refused before anything is written.'),
  'sentinel.object.missing': same('the object is not in the store', 'No stored object has that identity and encoding.'),
  'sentinel.object.corrupt': same('the stored object does not match its identity', 'The stored bytes were read and hashed and did not match what was recorded, so they are not used.'),
  'sentinel.object.corruptExisting': same('an object already in the store is damaged', 'An object with the same identity was already stored, and its bytes no longer match it. It is reported, never overwritten.'),
  'sentinel.object.wrongStore': same('the object reference names another store', 'A receipt from one store is not accepted by another, even when the bytes are equal.'),
  'sentinel.object.unsafePath': same('an object folder or file is not a private, real path in this store', 'Object folders and files must be real entries owned by this user inside the store. Links and replaced entries are refused.'),
  'sentinel.object.notCanonical': same('the stored record is not in canonical JSON form', 'Structured records are stored in one canonical spelling so that equal content has one identity. Other spellings are refused.'),
  'sentinel.object.io': same('the object store could not be read or written', 'An operating system error stopped an object store operation. Nothing partial was published.'),
  // Reachability inspection and the dry-run prune plan.
  'sentinel.gc.incompleteSnapshot': same('the ledger snapshot did not list every root and link', 'An inspection that cannot see every root would call protected objects unreachable, so it reports no prune candidates.'),
  'sentinel.gc.wrongStore': same('the ledger snapshot belongs to another store', 'Roots from one store say nothing about another store\'s objects, so the inspection stops.'),
  'sentinel.gc.invalidSnapshot': same('the ledger snapshot is malformed', 'A root, link or recorded object in the snapshot did not have the required form, so no candidate is listed.'),
  'sentinel.gc.missingReachable': same('an object the ledger still needs is not in the store', 'An artifact reachable from a root has no stored object. This is an integrity failure and no prune candidate is listed.'),
  'sentinel.gc.missingRecorded': same('an object the ledger recorded is not in the store', 'The ledger accepted an object that cannot now be found. This is an integrity failure and no prune candidate is listed.'),
  'sentinel.gc.corruptObject': same('a stored object failed verification', 'A reachable or recorded object was read and hashed and did not match. No prune candidate is listed.'),
  'sentinel.gc.sequenceUnverified': same('the ledger position could not be re-read after the inspection', 'Candidates are valid only if the ledger did not move while objects were listed, and that could not be confirmed.'),
  'sentinel.gc.snapshotMoved': same('the ledger changed during the inspection', 'Something was committed while objects were being listed, so the result could be out of date and lists no candidate.'),
  'sentinel.gc.unreadableStore': same('the object folders could not be listed', 'An operating system error stopped the inspection from reading the object store, so it lists no candidate.'),
};

export function sentinelStorageErrorWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_STORAGE_ERROR_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
