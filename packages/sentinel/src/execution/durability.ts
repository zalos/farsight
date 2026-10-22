// The durability policy for execution's own files (the intent and worker journals, attempt output folders).
//
// A file's bytes are fsynced and any failure is an error. A folder's entry (the rename that makes a record exist,
// or the unlink that settles it) is made durable by fsyncing the folder: on the qualified hosts (APFS, ext4) that
// is supported and an error from it is an error. Only a platform that does not support fsync on a folder at all
// (EINVAL, ENOTSUP, EOPNOTSUPP, EISDIR, EBADF) is allowed through, and is reported as such. An I/O error, a full
// disk or quota, or a read-only file system (EIO, ENOSPC, EDQUOT, EROFS and anything else) fails the step.
import { closeSync, constants, fsyncSync, openSync } from 'node:fs';
import { ExecutionError } from './errors.js';

const UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EBADF']);

export type DirectorySync = 'synced' | 'unsupported';

export function syncDirectory(path: string): DirectorySync {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY); } catch (e) {
    throw new ExecutionError('sentinel.execution.durabilityFailed', { path, osCode: (e as NodeJS.ErrnoException).code ?? 'unknown', operation: 'open' }, { cause: e });
  }
  try {
    fsyncSync(fd);
    return 'synced';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unknown';
    if (UNSUPPORTED.has(code)) return 'unsupported';
    throw new ExecutionError('sentinel.execution.durabilityFailed', { path, osCode: code, operation: 'fsync' }, { cause: e });
  } finally {
    closeSync(fd);
  }
}

/** fsync a file descriptor; every failure is an error (file data must be durable). */
export function syncFile(fd: number, path: string): void {
  try { fsyncSync(fd); } catch (e) {
    throw new ExecutionError('sentinel.execution.durabilityFailed', { path, osCode: (e as NodeJS.ErrnoException).code ?? 'unknown', operation: 'fsync' }, { cause: e });
  }
}
