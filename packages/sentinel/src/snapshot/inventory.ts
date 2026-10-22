// The capture's running inventory: every enumerated entry, the bytes to store, the entry budget and the byte quota.
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, openSync, readSync } from 'node:fs';
import type { ArtifactId, CaptureEntry } from '../contracts/index.js';
import type { CaptureReasonCode } from './errors.js';
import { foldPath, isGenerated, lfsPointer, type CapturePolicy } from './policy.js';

/** Raised when bytes changed between two reads of one capture; a working copy is then captured again. */
export class CaptureChanged extends Error {
  constructor(detail: string) { super(detail); this.name = 'CaptureChanged'; }
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
  #reserved = 0;
  #totalBytes = 0;
  constructor(readonly policy: CapturePolicy) {}

  /** Reserves room for a folder's children (each sub-folder holds one slot for a possible boundary). */
  reserve(children: number): boolean {
    if (this.entries.length + this.#reserved + children > this.policy.maxEntries) return false;
    this.#reserved += children;
    return true;
  }

  /** Releases one reserved slot, before the entry it was reserved for is added or a sub-folder is listed. */
  release(n = 1): void { this.#reserved = Math.max(0, this.#reserved - n); }

  boundary(sourceId: string, relativePath: string, disposition: 'excluded' | 'refused' | 'unreadable', reasonCode: CaptureReasonCode): void {
    this.entries.push({ sourceId, relativePath, kind: 'directory-boundary', disposition, reasonCode, knownDescendants: null });
  }

  symlink(sourceId: string, relativePath: string, disposition: 'excluded' | 'refused', reasonCode: CaptureReasonCode): void {
    this.entries.push({ sourceId, relativePath, kind: 'symlink', disposition, reasonCode });
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
  included(sourceId: string, relativePath: string, bytes: Buffer, reread: () => Buffer): void {
    const id = contentId(bytes);
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
   * Refuses every included file whose path, or a folder on it, restores onto the same name as another's under
   * case folding and Unicode normalisation. Their bytes stay unstored unless another included file shares them.
   */
  refuseCaseCollisions(): void {
    const owners = new Map<string, Set<string>>();
    const keyOf = (sourceId: string, path: string) => `${sourceId}\u0000${foldPath(path)}`;
    const included = this.entries.filter(e => e.kind === 'file' && e.disposition === 'included');
    for (const e of included) {
      const parts = e.relativePath.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        const key = keyOf(e.sourceId, prefix);
        let set = owners.get(key);
        if (!set) owners.set(key, set = new Set());
        set.add(prefix);
      }
    }
    const colliding = (sourceId: string, path: string) => {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) if ((owners.get(keyOf(sourceId, parts.slice(0, i).join('/')))?.size ?? 0) > 1) return true;
      return false;
    };
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.kind !== 'file' || e.disposition !== 'included' || !colliding(e.sourceId, e.relativePath)) continue;
      this.entries[i] = { sourceId: e.sourceId, relativePath: e.relativePath, kind: 'file', disposition: 'refused',
        reasonCode: 'sentinel.capture.caseCollision', bytes: e.bytes, generated: e.generated };
    }
    const kept = new Set(this.entries.flatMap(e => (e.kind === 'file' && e.disposition === 'included' ? [e.content] : [])));
    for (const id of [...this.contents.keys()]) if (!kept.has(id)) this.contents.delete(id);
  }
}

/**
 * The bytes for an LFS pointer from an explicitly permitted local LFS object folder, or the reason it is unavailable.
 * The folder layout is Git LFS's own (`<oid[0:2]>/<oid[2:4]>/<oid>`). Nothing is downloaded.
 */
export function resolveLfs(pointer: { oid: string; size: number }, lfsObjects: string | undefined):
  { bytes: Buffer } | { reason: CaptureReasonCode } {
  if (!lfsObjects) return { reason: 'sentinel.capture.lfsObjectMissing' };
  const path = `${lfsObjects}/${pointer.oid.slice(0, 2)}/${pointer.oid.slice(2, 4)}/${pointer.oid}`;
  let fd: number;
  try { fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0)); } catch { return { reason: 'sentinel.capture.lfsObjectMissing' }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== pointer.size) return { reason: 'sentinel.capture.lfsObjectMismatch' };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    if (off !== st.size || createHash('sha256').update(buf).digest('hex') !== pointer.oid) return { reason: 'sentinel.capture.lfsObjectMismatch' };
    return { bytes: buf };
  } catch {
    return { reason: 'sentinel.capture.lfsObjectMissing' };
  } finally { closeSync(fd); }
}

export { lfsPointer };
