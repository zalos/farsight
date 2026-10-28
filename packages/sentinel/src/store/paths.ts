// Store paths: one canonical, local, owner-only folder per store, checked before anything inside it is opened.
//
// - The path must already be canonical: absolute, normalised, no link anywhere along it and the letter case the
//   file system stores (macOS temp folders live under /private/var, so callers pass realpath(tmpdir()), not
//   tmpdir()). An alias is refused with the canonical spelling in its detail, never followed.
// - Every existing folder above the store belongs to the user or root and cannot be renamed into by others
//   (no group/other write unless the sticky bit is set, as on /tmp).
// - The store folder is 0700 and its files 0600 when created; existing broader permissions are refused, never
//   widened or quietly narrowed.
// - The file system is identified by measurement: Linux statfs magic numbers against a list of local file
//   systems; on macOS, whose statfs type numbers are assigned at boot, the mount table entry whose mount point
//   has the store's device and reports `local` (apfs or hfs). Anything else, including network, FUSE and
//   overlay file systems, is refused.
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  realpathSync,
  statSync,
  statfsSync,
  constants,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { StoreError, ioFailure } from './errors.js';

/** The fixed names inside a store folder. Only owner.ts opens `owner` (see the hazard below). */
export interface StoreLayout {
  readonly root: string;
  /** The never-deleted lock database, held in rollback-journal mode for the owner's lifetime. */
  readonly owner: string;
  /** Informational: who holds the lock. Never authority; written and removed by the holder. */
  readonly descriptor: string;
  /** The WAL ledger (PR 03 ledger lane); opened only by a holder of the owner lock. */
  readonly ledger: string;
  /** Immutable content-addressed objects (PR 03 object lane). */
  readonly objects: string;
  /** The holder's scratch leases (`scratch/<epoch>/w-…`), inside the store so a capture never reads them as source. */
  readonly scratch: string;
}

/** The names of a store's files and folders. */
export const STORE_FILE_NAMES = Object.freeze({
  owner: 'owner.sqlite',
  descriptor: 'owner.json',
  ledger: 'ledger.sqlite',
  objects: 'objects',
  scratch: 'scratch',
});

// Hazard every lane must respect: POSIX advisory locks belong to the process, so closing *any* descriptor this
// process opened on owner.sqlite (a copy, a hash, a backup, a second connection) silently drops the owner lock.
// Nothing but owner.ts may open that file; backups copy the ledger, never the lock.

/** The paths of a store's files and folders under its root. */
export function storeLayout(root: string): StoreLayout {
  return Object.freeze({
    root,
    owner: join(root, STORE_FILE_NAMES.owner),
    descriptor: join(root, STORE_FILE_NAMES.descriptor),
    ledger: join(root, STORE_FILE_NAMES.ledger),
    objects: join(root, STORE_FILE_NAMES.objects),
    scratch: join(root, STORE_FILE_NAMES.scratch),
  });
}

/** `dev:ino` from bigint stats, so large inode numbers keep full precision. */
export type FileIdentity = string;

/** The file system a store lives on, as measured, and how it was measured. */
export interface FilesystemIdentity {
  readonly platform: NodeJS.Platform;
  /** The measured file system name, e.g. `apfs`, `ext4`. */
  readonly type: string;
  /** How it was measured: `statfs:0xef53`, or `mount:<mount point>` on macOS. */
  readonly evidence: string;
}

/** A store folder that passed its checks: its path, identity and file system, and whether this call created it. */
export interface CheckedStoreRoot {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly filesystem: FilesystemIdentity;
  /** True when this call created the folder. */
  readonly created: boolean;
}

/** A file's identity as `dev:ino`, from bigint stats so large inode numbers keep full precision. */
export const identityOf = (s: BigIntStats): FileIdentity => `${s.dev}:${s.ino}`;

const uid = (): number => {
  if (typeof process.getuid !== 'function')
    throw new StoreError('sentinel.store.platformUnqualified', { platform: process.platform });
  return process.getuid();
};

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw ioFailure('lstat', error);
  }
}

/**
 * Refuse a path that is not already canonical. Walks from the root: each existing component must be a real
 * folder (not a link) whose spelling equals what the file system reports.
 */
export function assertCanonicalStorePath(path: string): void {
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path))
    throw new StoreError('sentinel.store.pathNotAbsolute', {});
  const parts = path.split(sep).slice(1);
  if (path === sep || normalize(path) !== path || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new StoreError('sentinel.store.pathNotCanonical', { path, canonical: canonicalSpelling(path) });
  }
  let at: string = sep;
  for (const [i, part] of parts.entries()) {
    const next = join(at, part);
    const s = lstatOrNull(next);
    if (!s) return; // the rest is created by prepareStoreRoot
    if (s.isSymbolicLink()) {
      if (i === parts.length - 1) throw new StoreError('sentinel.store.pathSymlink', { path: next });
      throw new StoreError('sentinel.store.pathNotCanonical', { path, canonical: canonicalSpelling(path) });
    }
    let real: string;
    try {
      real = realpathSync.native(next);
    } catch (error) {
      throw ioFailure('realpath', error);
    }
    if (real !== next)
      throw new StoreError('sentinel.store.pathNotCanonical', { path, canonical: canonicalSpelling(path) });
    if (i < parts.length - 1 && !s.isDirectory())
      throw new StoreError('sentinel.store.pathNotDirectory', { path: next });
    at = next;
  }
}

/** The canonical spelling a caller should pass instead: realpath of the deepest existing ancestor plus the rest. */
export function canonicalSpelling(path: string): string {
  const rest: string[] = [];
  let at = normalize(path).replace(/[/\\]+$/, '') || sep;
  for (;;) {
    try {
      return join(realpathSync.native(at), ...rest.reverse());
    } catch {
      const parent = dirname(at);
      if (parent === at) return path;
      rest.push(at.slice(parent.length).replace(/^[/\\]/, ''));
      at = parent;
    }
  }
}

function assertSafeAncestors(root: string, me: number): void {
  for (let at = dirname(root); ; at = dirname(at)) {
    const s = lstatOrNull(at);
    if (s) {
      const mode = Number(s.mode);
      const owner = Number(s.uid);
      const sticky = (mode & 0o1000) !== 0;
      if (!s.isDirectory() || (owner !== 0 && owner !== me) || ((mode & 0o022) !== 0 && !sticky)) {
        throw new StoreError('sentinel.store.ancestorUnsafe', { path: at });
      }
    }
    if (dirname(at) === at) return;
  }
}

function assertPrivate(path: string, s: BigIntStats, me: number, kind: 'directory' | 'file'): void {
  if (s.isSymbolicLink()) throw new StoreError('sentinel.store.pathSymlink', { path });
  if (kind === 'directory' ? !s.isDirectory() : !s.isFile()) {
    throw new StoreError(kind === 'directory' ? 'sentinel.store.pathNotDirectory' : 'sentinel.store.fileUnsafe', {
      path,
    });
  }
  if (Number(s.uid) !== me) throw new StoreError('sentinel.store.pathWrongOwner', { path });
  if ((Number(s.mode) & 0o077) !== 0)
    throw new StoreError('sentinel.store.pathPermissions', { path, mode: (Number(s.mode) & 0o7777).toString(8) });
  if (kind === 'file' && s.nlink !== 1n)
    throw new StoreError('sentinel.store.fileUnsafe', { path, links: Number(s.nlink) });
}

// Linux magic numbers from linux/magic.h: a stable kernel ABI. Overlay is excluded (copy-up changes the
// inode the lock is bound to); FUSE, NFS, SMB/CIFS, 9p and anything unlisted are refused.
const LINUX_LOCAL: ReadonlyMap<number, string> = new Map([
  [0xef53, 'ext4'],
  [0x58465342, 'xfs'],
  [0x9123683e, 'btrfs'],
  [0x01021994, 'tmpfs'],
  [0x2fc12fc1, 'zfs'],
  [0xf2f52010, 'f2fs'],
]);
const DARWIN_LOCAL = new Set(['apfs', 'hfs']);

/** Measure the file system holding `path` (an existing folder). Refuses anything not known to be local. */
export function measureFilesystem(path: string): FilesystemIdentity {
  let type: number;
  try {
    type = Number(statfsSync(path).type) >>> 0;
  } catch (error) {
    throw ioFailure('statfs', error);
  }
  const hex = `0x${type.toString(16)}`;
  if (process.platform === 'linux') {
    const name = LINUX_LOCAL.get(type);
    if (!name) throw new StoreError('sentinel.store.filesystemUnsupported', { filesystem: `statfs ${hex}` });
    return Object.freeze({ platform: process.platform, type: name, evidence: `statfs:${hex}` });
  }
  if (process.platform === 'darwin') {
    const mount = darwinLocalMountOf(path);
    if (!mount)
      throw new StoreError('sentinel.store.filesystemUnsupported', { filesystem: `unidentified (statfs ${hex})` });
    return Object.freeze({ platform: process.platform, type: mount.type, evidence: `mount:${mount.point}` });
  }
  throw new StoreError('sentinel.store.platformUnqualified', { platform: process.platform });
}

/**
 * macOS: read the mount table with /sbin/mount (no shell, empty environment, bounded) and find a local
 * apfs/hfs mount whose mount point is on the same device as `path`. Only such candidates are stat'ed, so an
 * automounted or network mount point is never touched.
 */
function darwinLocalMountOf(path: string): { type: string; point: string } | null {
  const dev = statSync(path, { bigint: true }).dev;
  const out = spawnSync('/sbin/mount', [], {
    encoding: 'utf8',
    env: {},
    timeout: 5_000,
    maxBuffer: 1 << 20,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (out.status !== 0 || typeof out.stdout !== 'string')
    throw new StoreError('sentinel.store.filesystemUnsupported', { filesystem: 'mount table unreadable' });
  for (const line of out.stdout.split('\n')) {
    const m = / on (\/.*) \(([a-z0-9]+)((?:, [^()]*)?)\)$/.exec(line);
    if (!m || !DARWIN_LOCAL.has(m[2]!) || !m[3]!.split(', ').includes('local')) continue;
    try {
      if (statSync(m[1]!, { bigint: true }).dev === dev) return { type: m[2]!, point: m[1]! };
    } catch {
      /* a vanished mount is not a match */
    }
  }
  return null;
}

/**
 * Check (and, when absent, create) the store folder. Synchronous by design: the owner re-checks identity
 * inside ledger transactions, which node:sqlite runs synchronously.
 */
export function prepareStoreRoot(path: string, options: { create?: boolean } = {}): CheckedStoreRoot {
  const me = uid();
  assertCanonicalStorePath(path);
  assertSafeAncestors(path, me);
  let created = false;
  if (!lstatOrNull(path)) {
    if (options.create === false) throw ioFailure('stat', Object.assign(new Error('absent'), { code: 'ENOENT' }));
    try {
      created = mkdirSync(path, { recursive: true, mode: 0o700 }) !== undefined;
    } catch (error) {
      throw ioFailure('mkdir', error);
    }
    // Folders created above the store are checked like any other ancestor; a concurrent creator is fine.
    assertCanonicalStorePath(path);
    assertSafeAncestors(path, me);
  }
  const s = lstatOrNull(path);
  if (!s) throw new StoreError('sentinel.store.identityChanged', { path });
  assertPrivate(path, s, me, 'directory');
  const filesystem = measureFilesystem(path);
  return Object.freeze({ path, identity: identityOf(s), filesystem, created });
}

/**
 * Check a private regular file in a checked store folder, creating it 0600 when absent. An existing file is
 * only lstat'ed, never opened: opening and closing a descriptor on a locked file drops this process's lock.
 */
export function preparePrivateFile(
  path: string,
  options: { create?: boolean } = {},
): { identity: FileIdentity; created: boolean } {
  const me = uid();
  let created = false;
  if (!lstatOrNull(path) && options.create !== false) {
    try {
      closeSync(openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      created = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') throw new StoreError('sentinel.store.pathSymlink', { path });
      if (code !== 'EEXIST') throw ioFailure('create', error);
    }
  }
  const s = lstatOrNull(path);
  if (!s) throw new StoreError('sentinel.store.identityChanged', { path });
  assertPrivate(path, s, me, 'file');
  return { identity: identityOf(s), created };
}

/** An optional private file (such as a hot journal): absent is fine; present must be private and regular. */
export function assertPrivateFileIfPresent(path: string): void {
  const s = lstatOrNull(path);
  if (s) assertPrivate(path, s, uid(), 'file');
}

/** True when `path` still names the same inode; false when it is gone or replaced. Never opens the file. */
export function hasIdentity(path: string, identity: FileIdentity): boolean {
  try {
    return identityOf(lstatSync(path, { bigint: true })) === identity;
  } catch {
    return false;
  }
}
