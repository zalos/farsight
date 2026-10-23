// Owner-only files in user state outside the checkout: adoption records and receipts. Every folder created here is
// 0700 and every file 0600; an existing link, a file owned by another account or one open to other accounts is
// refused, never followed or widened. Writes go to a fresh temporary name and are renamed into place after fsync,
// so a reader sees a whole record or none. These checks protect against other accounts and mistakes; code running
// as the owner can change user state, and that is outside this boundary (as for the store, ADR 19).
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants as FS, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync,
  writeSync, type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { policyFail, type PolicyErrorCode } from './errors.js';

const UID = typeof process.getuid === 'function' ? process.getuid() : undefined;
const NOFOLLOW = FS.O_NOFOLLOW ?? 0;
const errno = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

function assertOwnerOnly(st: Stats, what: string, code: PolicyErrorCode): void {
  if (UID !== undefined && st.uid !== UID) policyFail(code, `${what} belongs to another account`);
  if ((st.mode & 0o077) !== 0) policyFail(code, `${what} is open to other accounts`);
}

/** Creates the folder (and missing parents) 0700, then checks that the folder itself is a private directory. */
export function ensurePrivateDir(dir: string, code: PolicyErrorCode): void {
  if (!isAbsolute(dir) || normalize(dir) !== dir) policyFail(code, 'a user-state folder is an absolute, normalised path');
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { policyFail(code, `the user-state folder cannot be created (${errno(e) ?? 'error'})`, e); }
  assertPrivateDir(dir, code);
}

/** Requires an existing private directory, without making or repairing anything. */
export function assertPrivateDir(dir: string, code: PolicyErrorCode): void {
  let st: Stats;
  try { st = lstatSync(dir); } catch (e) { return policyFail(code, `the user-state folder cannot be inspected (${errno(e) ?? 'error'})`, e); }
  if (st.isSymbolicLink() || !st.isDirectory()) policyFail(code, 'the user-state folder is not a directory');
  assertOwnerOnly(st, 'the user-state folder', code);
}

/** Reads a private regular file, or undefined when it does not exist. Never follows a link. */
export function readPrivateFile(path: string, maxBytes: number, code: PolicyErrorCode, options: {
  /** Pure preflight must refuse a pending alias instead of repairing a prior writer's publication. */
  readonly repairTemporaryAliases?: boolean;
} = {}): Buffer | undefined {
  let fd: number;
  try { fd = openSync(path, FS.O_RDONLY | NOFOLLOW | (options.repairTemporaryAliases === false ? (FS.O_NONBLOCK ?? 0) : 0)); } catch (e) {
    if (errno(e) === 'ENOENT') return undefined;
    if (errno(e) === 'ELOOP') return policyFail(code, 'a user-state file is a symbolic link');
    return policyFail(code, `a user-state file cannot be opened (${errno(e) ?? 'error'})`, e);
  }
  try {
    let st = fstatSync(fd);
    if (!st.isFile()) policyFail(code, 'a user-state entry is not a regular file');
    if (st.nlink > 1 && options.repairTemporaryAliases !== false) {
      // createPrivateFileOnce links a synced temporary name to the final one and then removes it; between the two,
      // or after a crash there, the record also has that temporary name. Only that exact alias of this same file is
      // removed; any other second name is refused.
      removeTemporaryAliases(dirname(path), basename(path), st);
      st = fstatSync(fd);
    }
    if (st.nlink !== 1) policyFail(code, 'a user-state file has another name');
    assertOwnerOnly(st, 'a user-state file', code);
    if (st.size > maxBytes) policyFail(code, `a user-state file is larger than ${maxBytes} bytes`);
    return readExactly(fd, st.size, code);
  } finally { closeSync(fd); }
}

/** Reads a regular file of a checkout (settings), refusing links; owner checks do not apply to checkout files. */
export function readCheckoutFile(path: string, maxBytes: number, code: PolicyErrorCode, options: { readonly nonblocking?: boolean } = {}): Buffer | undefined {
  let fd: number;
  try { fd = openSync(path, FS.O_RDONLY | NOFOLLOW | (options.nonblocking ? (FS.O_NONBLOCK ?? 0) : 0)); } catch (e) {
    if (errno(e) === 'ENOENT') return undefined;
    if (errno(e) === 'ELOOP') return policyFail(code, 'the file is a symbolic link');
    return policyFail(code, `the file cannot be opened (${errno(e) ?? 'error'})`, e);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) policyFail(code, 'not a regular file');
    if (st.size > maxBytes) policyFail(code, `larger than ${maxBytes} bytes`);
    return readExactly(fd, st.size, code);
  } finally { closeSync(fd); }
}

function readExactly(fd: number, size: number, code: PolicyErrorCode): Buffer {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off);
    if (n === 0) break;
    off += n;
  }
  if (off !== size || readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) policyFail(code, 'the file changed while it was read');
  return buf;
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let off = 0;
  while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off, off);
  fsyncSync(fd);
}

function syncDir(dir: string): void {
  const fd = openSync(dir, FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Replaces `name` in a private folder with exactly `bytes`, atomically. */
export function writePrivateFileAtomic(dir: string, name: string, bytes: Uint8Array, code: PolicyErrorCode): void {
  ensurePrivateDir(dir, code);
  const tmp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number;
  try { fd = openSync(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | NOFOLLOW, 0o600); } catch (e) {
    return policyFail(code, `a user-state file cannot be created (${errno(e) ?? 'error'})`, e);
  }
  try {
    writeAll(fd, bytes);
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return policyFail(code, `a user-state file cannot be written (${errno(e) ?? 'error'})`, e);
  }
  closeSync(fd);
  try { renameSync(tmp, join(dir, name)); syncDir(dir); } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    policyFail(code, `a user-state file cannot be published (${errno(e) ?? 'error'})`, e);
  }
}

/** Creates `name` with `bytes` only if it does not exist yet. Returns false when it already existed. */
export function createPrivateFileOnce(dir: string, name: string, bytes: Uint8Array, code: PolicyErrorCode): boolean {
  ensurePrivateDir(dir, code);
  // Whole or not at all: the bytes are written and synced under a fresh temporary name, then linked to the final
  // name. link(2) never replaces a name, so exactly one creator wins, and the final name never exists with partial
  // or missing content: a failure or crash before the link leaves nothing there.
  const temp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number;
  try { fd = openSync(temp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | NOFOLLOW, 0o600); } catch (e) {
    return policyFail(code, `a user-state file cannot be created (${errno(e) ?? 'error'})`, e);
  }
  let linked = false;
  try {
    try { writeAll(fd, bytes); } finally { closeSync(fd); }
    try { linkSync(temp, join(dir, name)); linked = true; } catch (e) {
      if (errno(e) !== 'EEXIST') return policyFail(code, `a user-state file cannot be published (${errno(e) ?? 'error'})`, e);
    }
  } finally {
    try { unlinkSync(temp); } catch { /* removed already */ }
  }
  syncDir(dir);
  return linked;
}

/** Removes the temporary names createPrivateFileOnce uses for `name` that are this very file; nothing else. */
function removeTemporaryAliases(dir: string, name: string, file: Stats): void {
  const pattern = new RegExp(`^\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]{16}\\.tmp$`);
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    try {
      const other = lstatSync(join(dir, entry));
      if (other.isFile() && other.dev === file.dev && other.ino === file.ino) unlinkSync(join(dir, entry));
    } catch { /* removed by its writer meanwhile */ }
  }
}

/**
 * The canonical path a folder would have, without creating anything: its deepest existing ancestor must be a real
 * folder spelled canonically (no link, the case the file system stores), and the rest is joined normalised. A link
 * or a non-folder on the way is refused, so a check made here holds for what a later create makes.
 */
export function prospectiveCanonical(path: string, code: PolicyErrorCode): string {
  if (!isAbsolute(path) || normalize(path) !== path) policyFail(code, 'a user-state folder is an absolute, normalised path');
  const parts = path.split(sep).filter(Boolean);
  let existing: string = sep;
  let i = 0;
  for (; i < parts.length; i++) {
    const next = join(existing, parts[i]!);
    let st: Stats;
    try { st = lstatSync(next); } catch (e) {
      if (errno(e) === 'ENOENT') break;
      return policyFail(code, `a user-state folder cannot be inspected (${errno(e) ?? 'error'})`, e);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) policyFail(code, 'a user-state folder passes through a link or a file');
    existing = next;
  }
  let real: string;
  try { real = realpathSync.native(existing); } catch (e) { return policyFail(code, 'a user-state folder cannot be resolved', e); }
  if (real !== existing) policyFail(code, 'a user-state folder is not spelled canonically');
  return parts.length === i ? existing : join(existing, ...parts.slice(i));
}

/** True when either canonical path is the other or lies below it. */
export const overlaps = (a: string, b: string): boolean => isWithin(a, b) || isWithin(b, a);

/** True when `inner` is `outer` or below it, comparing canonical absolute paths. */
export function isWithin(inner: string, outer: string): boolean {
  if (inner === outer) return true;
  const prefix = outer.endsWith('/') ? outer : `${outer}/`;
  return inner.startsWith(prefix);
}
