// Restore: write a stored snapshot's included files into a new private folder, byte for byte, from the store alone.
// The original source roots are never read. After writing, every file is read back and the tree listed again;
// any extra, missing, linked or changed entry fails the restore. The result is made read-only by default.
import { chmodSync, closeSync, constants as FS, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { ArtifactId, IncludedFileEntry, SnapshotEnvelope } from '../contracts/index.js';
import type { SentinelStore } from '../store/index.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { validateEnvelope } from '../validate.js';
import { SnapshotError } from './errors.js';
import { contentId } from './inventory.js';
import { foldPath, isRecordablePath } from './policy.js';

export interface RestoreOptions {
  /** Leave files 0400 and folders 0500 (default true). */
  readonly readOnly?: boolean;
}

export interface RestoredSource {
  readonly sourceId: string;
  /** `<target>/<sourceId>`. */
  readonly root: string;
  readonly files: number;
}

export interface RestoredSnapshot {
  readonly snapshot: SnapshotEnvelope;
  readonly root: string;
  readonly sources: readonly RestoredSource[];
  /** Every restored file: source id, path and the content artifact it was written from. */
  readonly files: readonly { readonly sourceId: string; readonly relativePath: string; readonly content: ArtifactId }[];
}

export type RestoreStore = Pick<SentinelStore, 'readArtifact'>;

/** Reads and checks a stored snapshot manifest: canonical JSON that satisfies its contract. */
export async function readSnapshot(store: RestoreStore, snapshotArtifact: ArtifactId): Promise<SnapshotEnvelope> {
  let bytes: Buffer;
  try { bytes = await store.readArtifact(snapshotArtifact); } catch (e) {
    throw new SnapshotError('sentinel.capture.notSnapshot', '', { cause: e });
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new SnapshotError('sentinel.capture.notSnapshot');
  }
  if (!canonicalJsonBytes(value).equals(bytes)) throw new SnapshotError('sentinel.capture.notSnapshot');
  const valid = validateEnvelope('snapshot', value);
  if (!valid.ok) throw new SnapshotError('sentinel.capture.notSnapshot');
  return valid.value;
}

function writeNew(path: string, bytes: Buffer): void {
  const fd = openSync(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW ?? 0), 0o600);
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off, off);
  } finally { closeSync(fd); }
}

function readBack(path: string): Buffer {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SnapshotError('sentinel.capture.restoreIntegrity', 'not a regular file');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    return buf.subarray(0, off);
  } finally { closeSync(fd); }
}

/** Lists every non-folder entry under `dir` (relative, `/`-separated), refusing any link or special file. */
function listFiles(dir: string, rel = '', out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const path = rel === '' ? name : `${rel}/${name}`;
    const st = lstatSync(abs);
    if (st.isDirectory()) listFiles(abs, path, out);
    else if (st.isFile()) out.push(path);
    else throw new SnapshotError('sentinel.capture.restoreIntegrity', `${path} is not a regular file`);
  }
  return out;
}

function folders(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (lstatSync(abs).isDirectory()) folders(abs, out);
  }
  out.push(dir);
  return out;
}

/**
 * Restores `snapshotArtifact` into `target`, which must not exist and whose parent must be a canonical folder.
 * Each source is written under `<target>/<sourceId>/`.
 */
export async function restoreSnapshot(store: RestoreStore, snapshotArtifact: ArtifactId, target: string, options: RestoreOptions = {}):
  Promise<RestoredSnapshot> {
  if (typeof target !== 'string' || !isAbsolute(target)) throw new SnapshotError('sentinel.capture.restoreTargetUnsafe');
  let parent: string;
  try { parent = realpathSync.native(dirname(target)); } catch { throw new SnapshotError('sentinel.capture.restoreTargetUnsafe'); }
  if (join(parent, basename(target)) !== target) throw new SnapshotError('sentinel.capture.restoreTargetUnsafe');
  const snapshot = await readSnapshot(store, snapshotArtifact);
  const files = snapshot.entries.filter((e): e is IncludedFileEntry => e.kind === 'file' && e.disposition === 'included');

  // A snapshot written by capture never holds these; one assembled elsewhere is refused before anything is written.
  const folded = new Map<string, string>();
  for (const f of files) {
    if (!isRecordablePath(f.relativePath)) throw new SnapshotError('sentinel.capture.restoreIntegrity', 'an unsafe path');
    const parts = f.relativePath.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      const key = `${f.sourceId}\u0000${foldPath(p)}`;
      const seen = folded.get(key);
      if (seen !== undefined && seen !== p) throw new SnapshotError('sentinel.capture.restoreIntegrity', 'paths that collide by letter case');
      folded.set(key, p);
    }
  }

  try { mkdirSync(target, { mode: 0o700 }); } catch { throw new SnapshotError('sentinel.capture.restoreTargetUnsafe'); }
  const sources: RestoredSource[] = [];
  for (const source of snapshot.sources) {
    const root = join(target, source.sourceId);
    mkdirSync(root, { mode: 0o700 });
    const mine = files.filter(f => f.sourceId === source.sourceId);
    for (const f of mine) {
      const bytes = await store.readArtifact(f.content);
      if (bytes.length !== f.bytes || contentId(bytes) !== f.content) {
        throw new SnapshotError('sentinel.capture.restoreIntegrity', `${f.relativePath}: stored bytes differ from the snapshot`);
      }
      const abs = join(root, ...f.relativePath.split('/'));
      mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
      try { writeNew(abs, bytes); } catch (e) {
        throw new SnapshotError('sentinel.capture.restoreIntegrity', `${f.relativePath}: ${(e as NodeJS.ErrnoException).code ?? 'write failed'}`);
      }
    }
    // The tree must be exactly the snapshot's files, each with its captured bytes.
    const listed = listFiles(root).sort();
    const expected = mine.map(f => f.relativePath).sort();
    if (JSON.stringify(listed) !== JSON.stringify(expected)) {
      throw new SnapshotError('sentinel.capture.restoreIntegrity', `${source.sourceId}: the restored tree differs from the snapshot`);
    }
    for (const f of mine) {
      if (contentId(readBack(join(root, ...f.relativePath.split('/')))) !== f.content) {
        throw new SnapshotError('sentinel.capture.restoreIntegrity', `${f.relativePath}: read back differently`);
      }
    }
    sources.push(Object.freeze({ sourceId: source.sourceId, root, files: mine.length }));
  }
  if (options.readOnly !== false) {
    for (const f of files) chmodSync(join(target, f.sourceId, ...f.relativePath.split('/')), 0o400);
    for (const dir of folders(target)) chmodSync(dir, 0o500);
  }
  return Object.freeze({
    snapshot, root: target, sources: Object.freeze(sources),
    files: Object.freeze(files.map(f => Object.freeze({ sourceId: f.sourceId, relativePath: f.relativePath, content: f.content }))),
  });
}
