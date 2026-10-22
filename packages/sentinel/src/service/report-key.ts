// The per-store secret that keys a withheld citation's location identity (full-report.ts). The store id is public (it
// labels the store's containers, names it in owner records and in a bundle's provenance), so it can never be a key.
// This is 32 random bytes, one per store id, created on first need in the owner's private trust folder: outside the
// store directory, so no store copy or bundle export carries it, and never written to a receipt, a result, a report,
// a log or the service's socket. It lives in memory only while a report is built.
//
// Creation is the existing no-overwrite publication (publish-once.ts): racing creators converge on the one key that was
// linked first, and the final name never holds partial bytes. Reading requires a private regular file of this account
// with exactly one name and exactly 32 bytes; anything else refuses rather than minting a different key, so the
// identity of a file never silently changes for the same store.
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureDurableDir, publishOnce, readPublished, UnsafeRecordError } from './publish-once.js';

const KEY_BYTES = 32;
const FOLDER = 'report-keys';

export class ReportKeyError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'ReportKeyError'; }
}

const nameOf = (storeId: string) => `${createHash('sha256').update(`sentinel-report-key-name/1\u0000${storeId}`).digest('hex').slice(0, 40)}.key`;

/** The store's withheld-location key, created once if it does not exist yet. */
export function withheldLocationKey(trustDir: string, storeId: string): Buffer {
  const dir = join(trustDir, FOLDER);
  const name = nameOf(storeId);
  const read = () => {
    let bytes: Buffer | undefined;
    try { bytes = readPublished(dir, name, KEY_BYTES); } catch (e) {
      if (e instanceof UnsafeRecordError) throw new ReportKeyError(`the report key is unsafe: ${e.reason}`);
      throw e;
    }
    if (bytes !== undefined && bytes.length !== KEY_BYTES) throw new ReportKeyError('the report key is not 32 bytes');
    return bytes;
  };
  try { ensureDurableDir(dir, trustDir); } catch (e) {
    if (e instanceof UnsafeRecordError) throw new ReportKeyError(`the report key folder is unsafe: ${e.reason}`);
    throw e;
  }
  const existing = read();
  if (existing) return existing;
  publishOnce(dir, name, randomBytes(KEY_BYTES));
  const key = read();
  if (!key) throw new ReportKeyError('the report key could not be kept');
  return key;
}
