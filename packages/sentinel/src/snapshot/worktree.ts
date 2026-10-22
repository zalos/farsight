// Working-copy enumeration: every entry under an authorised (canonical) root, read without following a link. Each
// read goes through the folders the walk has already seen: their identities (device, inode), from the root down, are
// checked again before a folder is listed and before and after every file is read, so a folder swapped for a link
// or another folder mid-capture raises CaptureChanged and the whole working copy is captured again (see capture.ts);
// it is never mixed into one snapshot. These checks detect a swap between observations; they are not an OS-level
// audit of every read, and a swap restored between two checks is not seen.
import { closeSync, constants as FS, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, type Stats } from 'node:fs';
import { CaptureChanged, Inventory, lfsPointer, resolveLfs } from './inventory.js';
import { beyondPathBounds, checkName, folderExclusion, joinPath, symlinkVerdict } from './policy.js';
import { SnapshotError, type CaptureReasonCode } from './errors.js';

export interface WorktreeSource {
  readonly sourceId: string;
  readonly root: string;
  /** The Sentinel store's folder relative to this root, when the store lies inside it. */
  readonly storeRel: string | undefined;
  /** An explicitly permitted local Git LFS object folder. */
  readonly lfsObjects: string | undefined;
}

const OPEN_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** The folders from the root to the one being read, each with the identity first seen. */
type Chain = readonly { readonly abs: Buffer; readonly st: Stats }[];

function verifyChain(chain: Chain): void {
  for (const link of chain) {
    let now: Stats;
    try { now = lstatSync(link.abs); } catch { throw new CaptureChanged('a folder disappeared during capture'); }
    if (now.isSymbolicLink() || !now.isDirectory() || !sameFile(now, link.st)) throw new CaptureChanged('a folder was replaced during capture');
  }
}
const errno = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

/** Reads a regular file whose lstat was `seen`, checking it is the same file and size; undefined when unreadable. */
export function readRegular(abs: Buffer | string, seen: Stats): Buffer | undefined {
  let fd: number;
  try { fd = openSync(abs, OPEN_FLAGS); } catch (e) {
    if (errno(e) === 'ELOOP' || errno(e) === 'ENOENT') throw new CaptureChanged('a file was replaced during capture');
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !sameFile(st, seen) || st.size !== seen.size) throw new CaptureChanged('a file changed during capture');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    if (off !== st.size || readSync(fd, Buffer.alloc(1), 0, 1, st.size) !== 0) throw new CaptureChanged('a file changed size during capture');
    return buf;
  } catch (e) {
    if (e instanceof CaptureChanged) throw e;
    return undefined;
  } finally { closeSync(fd); }
}

/** A file read with its folders checked before and after. */
function readThrough(chain: Chain, abs: Buffer, seen: Stats): Buffer | undefined {
  verifyChain(chain);
  const bytes = readRegular(abs, seen);
  verifyChain(chain);
  return bytes;
}

function lstatOrUndefined(p: Buffer | string): Stats | undefined {
  try { return lstatSync(p); } catch { return undefined; }
}

export function enumerateWorktree(inv: Inventory, src: WorktreeSource): void {
  const rootStat = lstatOrUndefined(src.root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new SnapshotError('sentinel.capture.rootUnreadable', src.sourceId);
  const abs = Buffer.from(src.root);
  walk(inv, src, '', abs, rootStat, [{ abs, st: rootStat }]);
}

function walk(inv: Inventory, src: WorktreeSource, rel: string, abs: Buffer, dirStat: Stats, chain: Chain): void {
  verifyChain(chain);
  let names: Buffer[];
  try {
    names = readdirSync(abs, { encoding: 'buffer' }) as unknown as Buffer[];
  } catch (e) {
    if (rel === '') throw new SnapshotError('sentinel.capture.rootUnreadable', `${src.sourceId} (${errno(e) ?? 'error'})`);
    inv.boundary(src.sourceId, rel, 'unreadable', 'sentinel.capture.unreadable');
    return;
  }
  const after = lstatOrUndefined(abs);
  if (!after || after.isSymbolicLink() || !after.isDirectory() || !sameFile(after, dirStat)) throw new CaptureChanged(`${rel || '.'} was replaced during capture`);
  verifyChain(chain);

  const children = names
    .map(raw => ({ raw, check: checkName(raw, false), abs: Buffer.concat([abs, Buffer.from('/'), raw]) }))
    .sort((a, b) => (a.check.name < b.check.name ? -1 : a.check.name > b.check.name ? 1 : 0));
  if (rel !== '' && beyondPathBounds(rel, children.map(c => c.check.name))) {
    inv.boundary(src.sourceId, rel, 'refused', 'sentinel.capture.pathLimit');
    return;
  }
  if (!inv.reserve(children.length)) {
    if (rel === '') throw new SnapshotError('sentinel.capture.manifestTooLarge', src.sourceId);
    inv.boundary(src.sourceId, rel, 'refused', 'sentinel.capture.entryLimit');
    return;
  }
  inv.listed(src.sourceId, rel);

  for (const child of children) {
    const path = joinPath(rel, child.check.name);
    const st = lstatOrUndefined(child.abs);
    inv.release();
    if (!st) throw new CaptureChanged(`${path} disappeared during capture`);
    const refuse = (reason: CaptureReasonCode) => {
      if (st.isDirectory()) inv.boundary(src.sourceId, path, 'refused', reason);
      else if (st.isSymbolicLink()) inv.symlink(src.sourceId, path, 'refused', reason);
      else inv.recorded(src.sourceId, path, 'refused', reason, st.isFile() ? st.size : undefined);
    };
    if (child.check.refused) { refuse(child.check.refused); continue; }
    if (child.check.name === '.git') {
      if (st.isDirectory()) inv.boundary(src.sourceId, path, 'excluded', 'sentinel.capture.excludedGitInternals');
      else if (st.isSymbolicLink()) inv.symlink(src.sourceId, path, 'excluded', 'sentinel.capture.excludedGitInternals');
      else inv.recorded(src.sourceId, path, 'excluded', 'sentinel.capture.excludedGitInternals', st.isFile() ? st.size : undefined);
      continue;
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try { target = readlinkSync(child.abs, 'utf8'); } catch { inv.symlink(src.sourceId, path, 'refused', 'sentinel.capture.unreadable'); continue; }
      const verdict = symlinkVerdict(path, target);
      inv.symlink(src.sourceId, path, verdict === 'sentinel.capture.symlinkEscapes' ? 'refused' : 'excluded', verdict, target);
      continue;
    }
    if (st.isDirectory()) {
      const excluded = folderExclusion(inv.policy, src.sourceId, path, src.storeRel);
      if (excluded) { inv.boundary(src.sourceId, path, 'excluded', excluded); continue; }
      walk(inv, src, path, child.abs, st, [...chain, { abs: child.abs, st }]);
      continue;
    }
    if (!st.isFile()) { inv.recorded(src.sourceId, path, 'refused', 'sentinel.capture.specialFile'); continue; }
    if (folderExclusion(inv.policy, src.sourceId, path, undefined) === 'sentinel.capture.excludedByPolicy') {
      inv.recorded(src.sourceId, path, 'excluded', 'sentinel.capture.excludedByPolicy', st.size);
      continue;
    }
    const tooBig = inv.sizeRefusal(st.size);
    if (tooBig) { inv.recorded(src.sourceId, path, 'too-large', tooBig, st.size); continue; }
    const bytes = readThrough(chain, child.abs, st);
    if (!bytes) { inv.recorded(src.sourceId, path, 'unreadable', 'sentinel.capture.unreadable', st.size); continue; }
    const executable = (st.mode & 0o100) !== 0;
    const pointer = lfsPointer(bytes);
    if (pointer) {
      const big = inv.sizeRefusal(pointer.size);
      if (big) { inv.recorded(src.sourceId, path, 'too-large', big, pointer.size); continue; }
      const lfs = resolveLfs(pointer, src.lfsObjects);
      if ('reason' in lfs) { inv.recorded(src.sourceId, path, 'unreadable', lfs.reason, pointer.size); continue; }
      inv.included(src.sourceId, path, lfs.bytes, () => {
        const again = resolveLfs(pointer, src.lfsObjects);
        if ('reason' in again) throw new CaptureChanged(`${path}'s LFS content changed during capture`);
        return again.bytes;
      }, { executable, lfs: pointer });
      continue;
    }
    const abs2 = child.abs;
    inv.included(src.sourceId, path, bytes, () => {
      verifyChain(chain);
      const now = lstatOrUndefined(abs2);
      if (!now || !now.isFile()) throw new CaptureChanged(`${path} changed during capture`);
      const again = readThrough(chain, abs2, now);
      if (!again) throw new CaptureChanged(`${path} became unreadable during capture`);
      return again;
    }, { executable });
  }
}
