// The capture's running inventory: every enumerated entry, the bytes to store, the entry budget and the byte quota.
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId, CaptureEntry } from '../contracts/index.js';
import type { CaptureReasonCode } from './errors.js';
import { foldPath, isGenerated, lfsPointer, type CapturePolicy } from './policy.js';

/** Raised when bytes changed between two reads of one capture; a working copy is then captured again. */
export class CaptureChanged extends Error {
  constructor(detail: string) { super(detail); this.name = 'CaptureChanged'; }
}

/** What restore needs beyond the bytes: the executable bit, and where the bytes came from. */
export interface FileFacts {
  readonly executable: boolean;
  /** Committed capture: the tree entry's mode and blob id. */
  readonly git?: { readonly mode: string; readonly oid: string };
  /** The bytes are Git LFS content resolved from a pointer. */
  readonly lfs?: { readonly oid: string; readonly size: number };
}

/** Bytes that will be stored: their id is known now, and `read()` returns them again, verified. */
export interface PendingContent {
  readonly id: ArtifactId;
  readonly bytes: number;
  read(): Buffer;
}

export const contentId = (bytes: Uint8Array): ArtifactId => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export class Inventory {
  readonly entries: CaptureEntry[] = [];
  readonly contents = new Map<ArtifactId, PendingContent>();
  /** Per source, every folder that was listed (the root excluded), empty or not. */
  readonly directories = new Map<string, Set<string>>();
  /** `sourceId \0 path` → facts for included files. */
  readonly facts = new Map<string, FileFacts>();
  /** `sourceId \0 path` → a recorded link's target text. */
  readonly symlinkTargets = new Map<string, string>();
  /** `sourceId \0 path` → a gitlink's pinned commit. */
  readonly gitlinks = new Map<string, string>();
  #reserved = 0;
  #listed = 0;
  #totalBytes = 0;
  constructor(readonly policy: CapturePolicy) {}

  /**
   * Reserves room for a folder's children. The budget (`maxEntries`, shared by every source) counts every recorded
   * entry and every listed folder: each child takes one slot, kept as its entry, its boundary or its listing.
   */
  reserve(children: number): boolean {
    if (this.entries.length + this.#listed + this.#reserved + children > this.policy.maxEntries) return false;
    this.#reserved += children;
    return true;
  }

  /** Releases one reserved slot, before the entry it was reserved for is added or a sub-folder is listed. */
  release(n = 1): void { this.#reserved = Math.max(0, this.#reserved - n); }

  boundary(sourceId: string, relativePath: string, disposition: 'excluded' | 'refused' | 'unreadable', reasonCode: CaptureReasonCode): void {
    this.entries.push({ sourceId, relativePath, kind: 'directory-boundary', disposition, reasonCode, knownDescendants: null });
  }

  symlink(sourceId: string, relativePath: string, disposition: 'excluded' | 'refused', reasonCode: CaptureReasonCode, target?: string): void {
    this.entries.push({ sourceId, relativePath, kind: 'symlink', disposition, reasonCode });
    if (target !== undefined) this.symlinkTargets.set(`${sourceId}\u0000${relativePath}`, target);
  }

  /** A folder whose entries were listed. */
  listed(sourceId: string, relativePath: string): void {
    if (relativePath === '') return;
    this.#listed++;
    let set = this.directories.get(sourceId);
    if (!set) this.directories.set(sourceId, set = new Set());
    set.add(relativePath);
  }

  gitlink(sourceId: string, relativePath: string, commit: string): void {
    this.gitlinks.set(`${sourceId}\u0000${relativePath}`, commit);
  }

  recorded(sourceId: string, relativePath: string, disposition: 'excluded' | 'refused' | 'unreadable' | 'too-large',
    reasonCode: CaptureReasonCode, bytes?: number): void {
    this.entries.push({ sourceId, relativePath, kind: 'file', disposition, reasonCode, ...(bytes === undefined ? {} : { bytes }),
      generated: isGenerated(this.policy, relativePath, undefined) });
  }

  /** Size limits before a file is read: the per-file limit, then the remaining total quota. */
  sizeRefusal(size: number): CaptureReasonCode | undefined {
    if (size > this.policy.maxFileBytes) return 'sentinel.capture.tooLarge';
    if (this.#totalBytes + size > this.policy.maxTotalBytes) return 'sentinel.capture.quotaExceeded';
    return undefined;
  }

  /** An included file. `reread` returns the same bytes again (or throws CaptureChanged). */
  included(sourceId: string, relativePath: string, bytes: Buffer, reread: () => Buffer, facts: FileFacts): void {
    const id = contentId(bytes);
    this.facts.set(`${sourceId}\u0000${relativePath}`, facts);
    this.#totalBytes += bytes.length;
    this.entries.push({ sourceId, relativePath, kind: 'file', disposition: 'included', content: id, bytes: bytes.length,
      generated: isGenerated(this.policy, relativePath, bytes) });
    if (!this.contents.has(id)) {
      const size = bytes.length;
      this.contents.set(id, {
        id, bytes: size,
        read: () => {
          const again = reread();
          if (again.length !== size || contentId(again) !== id) throw new CaptureChanged(`${relativePath} changed during capture`);
          return again;
        },
      });
    }
  }

  /** Git's blob id for stored content, from bytes read again (so a change since enumeration is caught). */
  gitBlobIdOf(id: ArtifactId, repo: { hashObject(type: 'blob', data: Uint8Array): string }): string | undefined {
    const content = this.contents.get(id);
    return content ? repo.hashObject('blob', content.read()) : undefined;
  }

  /**
   * Refuses everything that would restore onto the same name as something else under case folding and Unicode
   * normalisation. The groups are built from every included file, every folder on its path and every listed folder
   * (empty ones too). An included file whose path or a folder on it collides is refused; a listed folder that
   * collides is recorded as a refused boundary (descendants unknown, though each is still recorded on its own) and is
   * not restored. Bytes no included file still needs stay unstored.
   */
  refuseCaseCollisions(): void {
    const keyOf = (sourceId: string, path: string) => `${sourceId}\u0000${foldPath(path)}`;
    const owners = new Map<string, Set<string>>();
    const add = (sourceId: string, path: string) => {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        const key = keyOf(sourceId, prefix);
        let set = owners.get(key);
        if (!set) owners.set(key, set = new Set());
        set.add(prefix);
      }
    };
    for (const e of this.entries) if (e.kind === 'file' && e.disposition === 'included') add(e.sourceId, e.relativePath);
    for (const [sourceId, dirs] of this.directories) for (const d of dirs) add(sourceId, d);
    const collides = (sourceId: string, path: string) => (owners.get(keyOf(sourceId, path))?.size ?? 0) > 1;
    const onCollidingPath = (sourceId: string, path: string) => {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) if (collides(sourceId, parts.slice(0, i).join('/'))) return true;
      return false;
    };
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.kind !== 'file' || e.disposition !== 'included' || !onCollidingPath(e.sourceId, e.relativePath)) continue;
      this.entries[i] = { sourceId: e.sourceId, relativePath: e.relativePath, kind: 'file', disposition: 'refused',
        reasonCode: 'sentinel.capture.caseCollision', bytes: e.bytes, generated: e.generated };
    }
    for (const [sourceId, dirs] of this.directories) {
      const refused = [...dirs].filter(d => collides(sourceId, d)).sort();
      for (const d of refused) {
        // Its descendants are each recorded on their own, but a subtree may hold unknown boundaries, so no exact
        // count is claimed.
        this.entries.push({ sourceId, relativePath: d, kind: 'directory-boundary', disposition: 'refused',
          reasonCode: 'sentinel.capture.caseCollision', knownDescendants: null });
      }
      for (const d of [...dirs]) if (onCollidingPath(sourceId, d)) dirs.delete(d);
    }
    const kept = new Set(this.entries.flatMap(e => (e.kind === 'file' && e.disposition === 'included' ? [e.content] : [])));
    for (const id of [...this.contents.keys()]) if (!kept.has(id)) this.contents.delete(id);
  }
}

/**
 * The bytes for an LFS pointer from an explicitly permitted local LFS object folder, or the reason they are not
 * captured. The folder layout is Git LFS's own (`<oid[0:2]>/<oid[2:4]>/<oid>`). Each folder below the permitted
 * (canonical) root must be a real folder, not a link, with the same identity before and after the read, and the
 * file is opened without following a link; anything else is refused, never followed. Nothing is downloaded.
 */
export function resolveLfs(pointer: { oid: string; size: number }, lfsObjects: string | undefined):
  { bytes: Buffer } | { reason: CaptureReasonCode } {
  if (!lfsObjects) return { reason: 'sentinel.capture.lfsObjectMissing' };
  const dirs = [lfsObjects, join(lfsObjects, pointer.oid.slice(0, 2)), join(lfsObjects, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4))];
  const seen: { dev: number; ino: number }[] = [];
  for (const d of dirs) {
    let st;
    try { st = lstatSync(d); } catch { return { reason: 'sentinel.capture.lfsObjectMissing' }; }
    if (st.isSymbolicLink() || !st.isDirectory()) return { reason: 'sentinel.capture.lfsStoreUnsafe' };
    seen.push({ dev: st.dev, ino: st.ino });
  }
  const path = join(dirs[2]!, pointer.oid);
  let fd: number;
  try { fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0)); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { reason: code === 'ELOOP' || code === 'EMLINK' ? 'sentinel.capture.lfsStoreUnsafe' : 'sentinel.capture.lfsObjectMissing' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { reason: 'sentinel.capture.lfsStoreUnsafe' };
    if (st.size !== pointer.size) return { reason: 'sentinel.capture.lfsObjectMismatch' };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    // The folders read through must still be the ones checked, and the name must still be this file.
    for (let i = 0; i < dirs.length; i++) {
      const again = lstatSync(dirs[i]!);
      if (again.isSymbolicLink() || again.dev !== seen[i]!.dev || again.ino !== seen[i]!.ino) return { reason: 'sentinel.capture.lfsStoreUnsafe' };
    }
    const named = lstatSync(path);
    if (named.isSymbolicLink() || named.dev !== st.dev || named.ino !== st.ino) return { reason: 'sentinel.capture.lfsStoreUnsafe' };
    if (off !== st.size || createHash('sha256').update(buf).digest('hex') !== pointer.oid) return { reason: 'sentinel.capture.lfsObjectMismatch' };
    return { bytes: buf };
  } catch {
    return { reason: 'sentinel.capture.lfsStoreUnsafe' };
  } finally { closeSync(fd); }
}

export { lfsPointer };
