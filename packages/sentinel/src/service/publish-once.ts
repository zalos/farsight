// Publishing an immutable owner-private record exactly once, whole or not at all. The bytes are written and synced
// under a fresh private temporary name in the same folder, then linked to the final name. link(2) creates the name
// only if it does not exist and never replaces one, so racing writers have exactly one winner, and the final name
// never exists with partial or missing content: a reader sees the whole record or none. The temporary name is then
// removed (only the one this call created) and the folder synced so the publication survives a crash. A failure or a
// crash before the link leaves nothing at the final name; a crash after it leaves a complete record whose temporary
// alias readPublished removes (only that exact name, only for that same file) before reading. Node offers no
// rename-without-replace, so link-then-unlink is the no-overwrite publication here.
import { randomBytes } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const NOFOLLOW = FS.O_NOFOLLOW ?? 0;

/** The boundaries a crash or failure test stops at. Production passes none. */
export type PublishBoundary = 'temp-opened' | 'temp-written' | 'linked' | 'temp-removed';
export interface PublishHooks { readonly at?: (boundary: PublishBoundary, name: string) => void }

/** Temporary names: a leading dot and a `.tmp` suffix, never a name a reader looks up. */
export const isTemporaryName = (name: string) => name.startsWith('.') && name.endsWith('.tmp');

/**
 * Makes `dir` durable below `base`: every missing level is created as a private folder (0700), and the parent of
 * every level from `base` down is synced on every call, created now or earlier. A sync that failed after a folder
 * was created is therefore repeated by the next call rather than skipped because the folder already exists.
 * `base` must be an existing ancestor of `dir`; folders above it are the caller's.
 */
export function ensureDurableDir(dir: string, base: string): void {
  const rel = relative(base, dir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new UnsafeRecordError('the folder is not below its base');
  let parent = base;
  for (const part of rel.split(sep)) {
    const level = join(parent, part);
    let st;
    try { st = lstatSync(level); } catch (e) {
      if (errno(e) !== 'ENOENT') throw new UnsafeRecordError(`a folder cannot be inspected (${errno(e) ?? 'error'})`);
      try { mkdirSync(level, { mode: 0o700 }); } catch (e2) { if (errno(e2) !== 'EEXIST') throw e2; }
      st = lstatSync(level);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafeRecordError('not a folder');
    if (UID !== undefined && st.uid !== UID) throw new UnsafeRecordError('a folder of another account');
    syncDir(parent);
    parent = level;
  }
}

function syncDir(dir: string): void {
  const fd = openSync(dir, FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Publishes `bytes` as `dir/name` (0600) only if `name` does not exist. Returns true when this call published it,
 * false when the name already existed (its content is the caller's to check). `dir` must already be a private folder.
 */
export function publishOnce(dir: string, name: string, bytes: Uint8Array, hooks: PublishHooks = {}): boolean {
  const temp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(temp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | NOFOLLOW, 0o600);
  let linked = false;
  try {
    try {
      hooks.at?.('temp-opened', name);
      for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off, off);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    hooks.at?.('temp-written', name);
    try {
      linkSync(temp, join(dir, name));
      linked = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (linked) hooks.at?.('linked', name);
  } finally {
    // Only the name this call created; never a name another writer chose.
    try { unlinkSync(temp); } catch { /* already gone */ }
  }
  hooks.at?.('temp-removed', name);
  syncDir(dir);
  return linked;
}

const UID = typeof process.getuid === 'function' ? process.getuid() : undefined;
const errno = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

/** A published record that cannot be trusted: a link, not a file, another account's, open to others, too large. */
export class UnsafeRecordError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'UnsafeRecordError'; }
}

/**
 * Reads a record publishOnce wrote: a private regular file of this account with exactly one name. Between the link
 * and the removal of its temporary name (or after a crash in that gap) a record also has that temporary name; such
 * an alias, recognised by its exact temporary pattern and the same file, is removed here. Any other second name is
 * refused. Returns undefined when the record does not exist.
 */
export function readPublished(dir: string, name: string, maxBytes: number, options: {
  /** Pure preparation preflight refuses an unfinished publication, without deleting its alias. */
  readonly repairTemporaryAliases?: boolean;
} = {}): Buffer | undefined {
  const path = join(dir, name);
  let fd: number;
  // Inspect the opened object before reading. A substituted FIFO must not wait for a writer before fstat can refuse it.
  try { fd = openSync(path, FS.O_RDONLY | NOFOLLOW | (FS.O_NONBLOCK ?? 0)); } catch (e) {
    if (errno(e) === 'ENOENT') return undefined;
    throw new UnsafeRecordError(errno(e) === 'ELOOP' ? 'a symbolic link' : `cannot be opened (${errno(e) ?? 'error'})`);
  }
  try {
    let st = fstatSync(fd);
    if (!st.isFile()) throw new UnsafeRecordError('not a regular file');
    if (UID !== undefined && st.uid !== UID) throw new UnsafeRecordError('another account\'s');
    if ((st.mode & 0o077) !== 0) throw new UnsafeRecordError('open to other accounts');
    if (st.nlink > 1) {
      if (options.repairTemporaryAliases === false) throw new UnsafeRecordError('the record has another name');
      const temp = new RegExp(`^\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]{16}\\.tmp$`);
      for (const entry of readdirSync(dir)) {
        if (!temp.test(entry)) continue;
        try {
          const other = lstatSync(join(dir, entry));
          if (other.isFile() && other.dev === st.dev && other.ino === st.ino) unlinkSync(join(dir, entry));
        } catch { /* removed by its writer meanwhile */ }
      }
      st = fstatSync(fd);
      if (st.nlink !== 1) throw new UnsafeRecordError('the record has another name');
    }
    if (st.size > maxBytes) throw new UnsafeRecordError(`larger than ${maxBytes} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    if (off !== st.size) throw new UnsafeRecordError('changed while it was read');
    return buf;
  } finally { closeSync(fd); }
}
