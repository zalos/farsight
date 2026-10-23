// One bounded read of a caller-named local file (an imported report or its manifest). The folder is resolved once to
// its canonical path; every folder of that path is then checked to be a real folder with the identity first seen,
// before and after the read, and the file itself is opened without following a link and without blocking (a FIFO
// cannot hold the open), must be a regular file with one link, no larger than the limit before anything is allocated,
// and unchanged from open to end: same identity, size and change times, nothing past the size, and the same file
// still at its name. These checks detect a swap between observations; they are not an OS-level audit of every read.
// Compressed or archived files are refused: nothing is decompressed.
import { closeSync, constants as FS, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { ImportBudget, ImportRefusal } from './types.js';

const OPEN_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);
const CHUNK = 1024 * 1024;
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;

/** Magic numbers of the compressed and archive formats an import never opens. */
const ARCHIVES: readonly (readonly number[])[] = [
  [0x1f, 0x8b], [0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x28, 0xb5, 0x2f, 0xfd], [0x42, 0x5a, 0x68],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
];
export function isArchive(bytes: Uint8Array): boolean {
  return ARCHIVES.some(m => bytes.length >= m.length && m.every((b, i) => bytes[i] === b));
}

type Chain = readonly { readonly path: string; readonly st: BigIntStats }[];

function chainOf(folder: string): Chain {
  const out: { path: string; st: BigIntStats }[] = [];
  const parts = folder.split(sep).filter(Boolean);
  let p: string = sep;
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) p = join(p, parts[i - 1]!);
    let st: BigIntStats;
    try { st = lstatSync(p, { bigint: true }); } catch { throw new ImportRefusal('sentinel.import.fileUnreadable'); }
    if (st.isSymbolicLink()) throw new ImportRefusal('sentinel.import.linkRefused');
    if (!st.isDirectory()) throw new ImportRefusal('sentinel.import.fileUnreadable');
    out.push({ path: p, st });
  }
  return out;
}

function verifyChain(chain: Chain): void {
  for (const link of chain) {
    let now: BigIntStats;
    try { now = lstatSync(link.path, { bigint: true }); } catch { throw new ImportRefusal('sentinel.import.fileChanged'); }
    if (now.isSymbolicLink() || !now.isDirectory() || !same(now, link.st)) throw new ImportRefusal('sentinel.import.fileChanged');
  }
}

/** Reads `path` (absolute) whole, within `maxBytes` and the budget's deadline; refuses rather than returning less. */
export function readImportFile(path: string, maxBytes: number, budget: ImportBudget): Buffer {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\u0000')) throw new ImportRefusal('sentinel.import.fileUnreadable');
  const name = basename(path);
  if (!name || name === '.' || name === '..') throw new ImportRefusal('sentinel.import.fileUnreadable');
  let folder: string;
  try { folder = realpathSync.native(dirname(path)); } catch { throw new ImportRefusal('sentinel.import.fileUnreadable'); }
  const chain = chainOf(folder);
  const leaf = join(folder, name);
  let named: BigIntStats;
  try { named = lstatSync(leaf, { bigint: true }); } catch { throw new ImportRefusal('sentinel.import.fileUnreadable'); }
  if (named.isSymbolicLink()) throw new ImportRefusal('sentinel.import.linkRefused');
  if (!named.isFile()) throw new ImportRefusal('sentinel.import.notRegularFile');
  budget.check();
  let fd: number;
  try { fd = openSync(leaf, OPEN_FLAGS); } catch (e) {
    throw new ImportRefusal((e as NodeJS.ErrnoException).code === 'ELOOP' ? 'sentinel.import.linkRefused' : 'sentinel.import.fileUnreadable');
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new ImportRefusal('sentinel.import.notRegularFile');
    if (!same(before, named)) throw new ImportRefusal('sentinel.import.fileChanged');
    if (before.nlink !== 1n) throw new ImportRefusal('sentinel.import.hardLinkRefused');
    if (before.size > BigInt(maxBytes)) throw new ImportRefusal('sentinel.import.tooLarge');
    const bytes = Buffer.alloc(Number(before.size));
    for (let off = 0; off < bytes.length;) {
      budget.check();
      let n: number;
      try { n = readSync(fd, bytes, off, Math.min(CHUNK, bytes.length - off), off); } catch { throw new ImportRefusal('sentinel.import.fileUnreadable'); }
      if (!n) throw new ImportRefusal('sentinel.import.fileChanged');
      off += n;
    }
    let extra: number;
    try { extra = readSync(fd, Buffer.alloc(1), 0, 1, bytes.length); } catch { throw new ImportRefusal('sentinel.import.fileUnreadable'); }
    const after = fstatSync(fd, { bigint: true });
    if (extra !== 0 || !same(after, before) || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n) throw new ImportRefusal('sentinel.import.fileChanged');
    let again: BigIntStats;
    try { again = lstatSync(leaf, { bigint: true }); } catch { throw new ImportRefusal('sentinel.import.fileChanged'); }
    if (again.isSymbolicLink() || !same(again, before)) throw new ImportRefusal('sentinel.import.fileChanged');
    verifyChain(chain);
    budget.check();
    if (isArchive(bytes)) throw new ImportRefusal('sentinel.import.archiveUnsupported');
    return bytes;
  } finally { closeSync(fd); }
}
