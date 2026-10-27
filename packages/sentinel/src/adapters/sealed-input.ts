// Reading an attempt's sealed input copies: the bytes PR 07's supervisor hashed while copying them into the attempt
// and the worker actually saw. Adapters normalize from these, by artifact id, never from a caller's original path,
// which may have changed since. Shared by every adapter in this package.
import { closeSync, constants as FS, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId } from '../contracts/common.js';

/** One sealed input copy in `<workDir>/input`, without following a link; undefined when it is not there. */
export function readSealedInput(workDir: string, artifact: ArtifactId): Uint8Array | undefined {
  const m = /^sha256:([0-9a-f]{64})$/.exec(artifact);
  if (!m) return undefined;
  let fd: number;
  try {
    fd = openSync(join(workDir, 'input', m[1]!), FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return off === st.size ? buf : undefined;
  } finally {
    closeSync(fd);
  }
}
