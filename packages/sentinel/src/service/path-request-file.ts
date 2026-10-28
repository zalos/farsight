// One bounded descriptor, opened only AFTER owner policy preflight. No-follow/nonblocking avoids link/FIFO waits;
// caller input is data, never actor, receipt or retained authority. The canonical in-memory request is parsed once.
import { constants as FS, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { parsePathRequest, MAX_PATH_REQUEST_BYTES, PathRequestError } from '../analysis/paths/request.js';
/**
 * Reads one path request file through a bounded no-follow descriptor (a single-link regular file, with no special mode
 * bits and not group- or world-writable, unchanged while read) and parses it. Anything else is `PathRequestError` with
 * `sentinel.paths.invalidInput`; `boundary` is checked between reads.
 */
export function readPathRequestFile(path: string, boundary: () => void) {
  boundary();
  let fd: number | undefined;
  try {
    fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_PATH_REQUEST_BYTES) ||
      (before.mode & 0o7022n) !== 0n
    )
      throw new PathRequestError('invalid');
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      boundary();
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw new PathRequestError('invalid');
      offset += n;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n ||
      after.mode !== before.mode ||
      readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0
    )
      throw new PathRequestError('invalid');
    boundary();
    return parsePathRequest(bytes);
  } catch (error) {
    if (error instanceof PathRequestError) throw error;
    boundary();
    throw new PathRequestError('invalid');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
