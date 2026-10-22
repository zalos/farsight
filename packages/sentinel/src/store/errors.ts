// The one error type the store raises. `code` is a stable reason code and a catalog key
// (packages/core/src/strings-sentinel-store.ts); `detail` is safe structured context (paths, versions, OS error
// codes), never a file's contents or a credential.
import { sentinelStoreWord } from '@farsight/core/dist/strings-sentinel-store.js';

export type StoreErrorCode =
  | 'sentinel.store.runtimeUnavailable'
  | 'sentinel.store.runtimeUnqualified'
  | 'sentinel.store.runtimeBehavior'
  | 'sentinel.store.platformUnqualified'
  | 'sentinel.store.pathNotAbsolute'
  | 'sentinel.store.pathNotCanonical'
  | 'sentinel.store.pathSymlink'
  | 'sentinel.store.pathNotDirectory'
  | 'sentinel.store.pathWrongOwner'
  | 'sentinel.store.pathPermissions'
  | 'sentinel.store.ancestorUnsafe'
  | 'sentinel.store.filesystemUnsupported'
  | 'sentinel.store.fileUnsafe'
  | 'sentinel.store.identityChanged'
  | 'sentinel.store.lockFileCorrupt'
  | 'sentinel.store.ownedElsewhere'
  | 'sentinel.store.ownershipUncertain'
  | 'sentinel.store.ownerClosed'
  | 'sentinel.store.ownerLost'
  | 'sentinel.store.resourceCloseFailed'
  | 'sentinel.store.ioFailure';

/** Every code, in catalog order; a test pins it against the catalog so the two cannot drift. */
export const STORE_ERROR_CODES: readonly StoreErrorCode[] = Object.freeze([
  'sentinel.store.runtimeUnavailable', 'sentinel.store.runtimeUnqualified', 'sentinel.store.runtimeBehavior',
  'sentinel.store.platformUnqualified', 'sentinel.store.pathNotAbsolute', 'sentinel.store.pathNotCanonical',
  'sentinel.store.pathSymlink', 'sentinel.store.pathNotDirectory', 'sentinel.store.pathWrongOwner',
  'sentinel.store.pathPermissions', 'sentinel.store.ancestorUnsafe', 'sentinel.store.filesystemUnsupported',
  'sentinel.store.fileUnsafe', 'sentinel.store.identityChanged', 'sentinel.store.lockFileCorrupt', 'sentinel.store.ownedElsewhere',
  'sentinel.store.ownershipUncertain', 'sentinel.store.ownerClosed', 'sentinel.store.ownerLost',
  'sentinel.store.resourceCloseFailed', 'sentinel.store.ioFailure',
] as const);

export type StoreErrorDetail = Record<string, string | number | boolean | null | readonly string[]>;

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly detail: Readonly<StoreErrorDetail>;

  constructor(code: StoreErrorCode, detail: StoreErrorDetail = {}, options?: { cause?: unknown }) {
    const values: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(detail)) {
      if (typeof v === 'string' || typeof v === 'number') values[k] = v;
      else if (Array.isArray(v)) values[k] = v.join(', ');
    }
    super(sentinelStoreWord(code, values), options);
    this.name = 'StoreError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

export function isStoreError(error: unknown, code?: StoreErrorCode): error is StoreError {
  return error instanceof StoreError && (code === undefined || error.code === code);
}

/** SQLite's primary result code for an error from node:sqlite (errcode carries extended codes). */
export function sqlitePrimaryCode(error: unknown): number | undefined {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === 'number' ? errcode & 0xff : undefined;
}

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6): another connection holds a conflicting lock. */
export function isSqliteBusy(error: unknown): boolean {
  const code = sqlitePrimaryCode(error);
  return code === 5 || code === 6;
}

/** Wrap an OS error with its code only; the message of a foreign error is never surfaced. */
export function ioFailure(operation: string, error: unknown): StoreError {
  const code = (error as { code?: unknown } | null)?.code;
  return new StoreError('sentinel.store.ioFailure', { operation, osCode: typeof code === 'string' ? code : null }, { cause: error });
}
