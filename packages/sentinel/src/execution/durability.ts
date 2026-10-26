// The durability policy for execution's own files (the intent and worker journals, attempt output folders).
//
// A file's bytes are fsynced and any failure is an error. A folder's entry (the rename that makes a record exist,
// or the unlink that settles it) is made durable by fsyncing the folder: on the qualified hosts (APFS, ext4) that
// is supported and an error from it is an error. Only the documented "this file system does not support fsync on
// this object" answers (EINVAL on Linux, ENOTSUP / EOPNOTSUPP) are allowed through, and reported as unsupported.
// Everything else fails: an invalid descriptor (EBADF) is a bug, not proof that durability is unsupported, and an
// I/O error, a full disk or quota, or a read-only file system (EIO, ENOSPC, EDQUOT, EROFS) fails the step.
import { closeSync, constants, fsyncSync, openSync } from 'node:fs';
import { ExecutionError } from './errors.js';

const UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * Package-internal fault-injection seam for the tests; production never replaces it. `trace` sees each folder
 * path just before its sync, so a test can check the order of syncs.
 */
export const durabilityIo: { fsyncSync: typeof fsyncSync; trace?: (path: string) => void } = { fsyncSync };

export type DirectorySync = 'synced' | 'unsupported';

/**
 * Sync a folder. By default a durable sync is required, so an "unsupported" answer is a failure too: the qualified
 * hosts (APFS, ext4) support it, and a degradation must never pass as durable success. A caller that can live
 * without it passes `allowUnsupported` and gets an explicit 'unsupported' back to report.
 */
export function syncDirectory(path: string, options: { allowUnsupported?: boolean } = {}): DirectorySync {
  durabilityIo.trace?.(path);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (e) {
    throw new ExecutionError(
      'sentinel.execution.durabilityFailed',
      { path, osCode: (e as NodeJS.ErrnoException).code ?? 'unknown', operation: 'open' },
      { cause: e },
    );
  }
  try {
    durabilityIo.fsyncSync(fd);
    return 'synced';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unknown';
    if (UNSUPPORTED.has(code) && options.allowUnsupported) return 'unsupported';
    throw new ExecutionError(
      'sentinel.execution.durabilityFailed',
      { path, osCode: code, operation: 'fsync' },
      { cause: e },
    );
  } finally {
    closeSync(fd);
  }
}

/** fsync a file descriptor; every failure is an error (file data must be durable). */
export function syncFile(fd: number, path: string): void {
  try {
    durabilityIo.fsyncSync(fd);
  } catch (e) {
    throw new ExecutionError(
      'sentinel.execution.durabilityFailed',
      { path, osCode: (e as NodeJS.ErrnoException).code ?? 'unknown', operation: 'fsync' },
      { cause: e },
    );
  }
}
