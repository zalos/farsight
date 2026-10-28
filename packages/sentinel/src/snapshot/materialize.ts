// Reopen and restore: read an admitted snapshot back through the ledger's record of it, and write its included files
// and listed folders into a new private folder, byte for byte, from the store alone. The original source roots are
// never read. After writing, every file is read back and the tree listed again; any extra, missing, linked or
// changed entry fails the restore. No restored file is executable, whatever it was in the source: its original mode
// is provenance in the materialization, never applied, so restoring a snapshot cannot make project code runnable.
// The tree is read-only by default (files 0400, folders 0500); writable restores give files 0600, folders 0700.
import {
  chmodSync,
  closeSync,
  constants as FS,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { ArtifactId, IncludedFileEntry, SnapshotEnvelope } from '../contracts/index.js';
import type { SentinelStore, SnapshotRecord } from '../store/index.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { validateEnvelope } from '../validate.js';
import { SnapshotError } from './errors.js';
import { contentId } from './inventory.js';
import { inventoryDigestOf, validateMaterialization, type Materialization } from './materialization.js';
import { foldPath } from './policy.js';

/** How restore writes files: read-only by default, and never executable. */
export interface RestoreOptions {
  /** Leave files 0400 and folders 0500 (default true); otherwise files 0600 and folders 0700. Never executable. */
  readonly readOnly?: boolean;
}

/** One restored source: where it is and how many files and folders it holds. */
export interface RestoredSource {
  readonly sourceId: string;
  /** `<target>/<sourceId>`. */
  readonly root: string;
  readonly files: number;
  readonly directories: number;
}

/** A restored snapshot: its record, envelope and materialization, and where each source was written. */
export interface RestoredSnapshot {
  readonly record: SnapshotRecord;
  readonly snapshot: SnapshotEnvelope;
  readonly materialization: Materialization;
  readonly root: string;
  readonly sources: readonly RestoredSource[];
}

/** A snapshot read and verified from the store without being written out. */
export interface OpenedSnapshot {
  readonly record: SnapshotRecord;
  readonly snapshot: SnapshotEnvelope;
  readonly materialization: Materialization;
}

/** What restore reads from the store: artifacts and the ledger. */
export type RestoreStore = Pick<SentinelStore, 'readArtifact' | 'ledger'>;

async function readCanonical(store: RestoreStore, id: ArtifactId): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await store.readArtifact(id);
  } catch (e) {
    throw new SnapshotError('sentinel.capture.notSnapshot', 'its artifact cannot be read', { cause: e });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new SnapshotError('sentinel.capture.notSnapshot');
  }
  if (!canonicalJsonBytes(value).equals(bytes))
    throw new SnapshotError('sentinel.capture.notSnapshot', 'not canonical JSON');
  return value;
}

/** Reads and checks a stored snapshot manifest: canonical JSON that satisfies its contract. */
export async function readSnapshot(
  store: Pick<SentinelStore, 'readArtifact'>,
  manifest: ArtifactId,
): Promise<SnapshotEnvelope> {
  const valid = validateEnvelope('snapshot', await readCanonical(store as RestoreStore, manifest));
  if (!valid.ok) throw new SnapshotError('sentinel.capture.notSnapshot', 'the manifest does not satisfy its contract');
  return valid.value;
}

/**
 * An admitted snapshot by id: the ledger's record, the manifest and the materialization, each checked against the
 * others (same snapshot, same inventory, the sidecar's files exactly the manifest's included files).
 */
export async function openSnapshot(store: RestoreStore, snapshotId: string): Promise<OpenedSnapshot> {
  let record: SnapshotRecord | undefined;
  try {
    record = store.ledger.getSnapshot(snapshotId);
  } catch (e) {
    throw new SnapshotError('sentinel.capture.notSnapshot', '', { cause: e });
  }
  if (!record) throw new SnapshotError('sentinel.capture.notSnapshot', 'no admitted snapshot has that id');
  const snapshot = await readSnapshot(store, record.manifest);
  const materialization = validateMaterialization(await readCanonical(store, record.materialization));
  if (
    snapshot.id !== record.snapshotId ||
    snapshot.inventoryDigest !== record.inventoryDigest ||
    materialization.snapshotId !== record.snapshotId ||
    materialization.inventoryDigest !== record.inventoryDigest
  ) {
    throw new SnapshotError(
      'sentinel.capture.notSnapshot',
      'the manifest, the materialization and the record disagree',
    );
  }
  const included = snapshot.entries.filter(
    (e): e is IncludedFileEntry => e.kind === 'file' && e.disposition === 'included',
  );
  const expected = new Map(included.map((e) => [`${e.sourceId}\u0000${e.relativePath}`, e.content]));
  const sources = new Set(snapshot.sources.map((s) => s.sourceId));
  let files = 0;
  for (const s of materialization.sources) {
    if (!sources.has(s.sourceId))
      throw new SnapshotError('sentinel.capture.notSnapshot', 'the materialization names an uncaptured source');
    for (const f of s.files) {
      if (expected.get(`${s.sourceId}\u0000${f.path}`) !== f.content) {
        throw new SnapshotError(
          'sentinel.capture.notSnapshot',
          'the materialization and the manifest disagree on a file',
        );
      }
      files++;
    }
  }
  if (files !== expected.size)
    throw new SnapshotError('sentinel.capture.notSnapshot', 'the materialization omits an included file');
  // The recorded inventory identity must be exactly what these bytes and these facts hash to.
  const recomputed = inventoryDigestOf(
    snapshot.capture.mode,
    snapshot.capture.policyDigest,
    snapshot.sources,
    snapshot.entries,
    materialization.sources,
  );
  if (recomputed !== record.inventoryDigest)
    throw new SnapshotError(
      'sentinel.capture.notSnapshot',
      'the inventory digest does not match its manifest and materialization',
    );
  return Object.freeze({ record, snapshot, materialization });
}

function writeNew(path: string, bytes: Buffer): void {
  const fd = openSync(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW ?? 0), 0o600);
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off, off);
  } finally {
    closeSync(fd);
  }
}

function readBack(path: string): Buffer {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SnapshotError('sentinel.capture.restoreIntegrity', 'not a regular file');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/** Every entry under `dir`: files and folders separately, refusing any link or special file. */
function listTree(dir: string, rel = '', out = { files: [] as string[], dirs: [] as string[] }) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const path = rel === '' ? name : `${rel}/${name}`;
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      out.dirs.push(path);
      listTree(abs, path, out);
    } else if (st.isFile()) out.files.push(path);
    else throw new SnapshotError('sentinel.capture.restoreIntegrity', `${path} is not a regular file`);
  }
  return out;
}

const ancestors = (p: string) =>
  p
    .split('/')
    .slice(0, -1)
    .map((_, i, parts) => parts.slice(0, i + 1).join('/'));

/**
 * Restores an admitted snapshot into `target`, which must not exist and whose parent must be a canonical folder.
 * Each source is written under `<target>/<sourceId>/`: its listed folders (empty ones too) and its included files.
 */
export async function restoreSnapshot(
  store: RestoreStore,
  snapshotId: string,
  target: string,
  options: RestoreOptions = {},
): Promise<RestoredSnapshot> {
  if (typeof target !== 'string' || !isAbsolute(target))
    throw new SnapshotError('sentinel.capture.restoreTargetUnsafe');
  let parent: string;
  try {
    parent = realpathSync.native(dirname(target));
  } catch {
    throw new SnapshotError('sentinel.capture.restoreTargetUnsafe');
  }
  if (join(parent, basename(target)) !== target) throw new SnapshotError('sentinel.capture.restoreTargetUnsafe');
  const opened = await openSnapshot(store, snapshotId);
  const { snapshot, materialization } = opened;

  // A snapshot written by capture never holds these; one assembled elsewhere is refused before anything is written.
  for (const s of materialization.sources) {
    const folded = new Map<string, string>();
    for (const p of [...s.directories, ...s.files.map((f) => f.path)].flatMap((p) => [...ancestors(p), p])) {
      const seen = folded.get(foldPath(p));
      if (seen !== undefined && seen !== p)
        throw new SnapshotError('sentinel.capture.restoreIntegrity', 'paths that collide by letter case');
      folded.set(foldPath(p), p);
    }
  }

  try {
    mkdirSync(target, { mode: 0o700 });
  } catch {
    throw new SnapshotError('sentinel.capture.restoreTargetUnsafe');
  }
  const sources: RestoredSource[] = [];
  for (const source of snapshot.sources) {
    const root = join(target, source.sourceId);
    mkdirSync(root, { mode: 0o700 });
    const m = materialization.sources.find((s) => s.sourceId === source.sourceId);
    const files = m?.files ?? [];
    const dirs = new Set(m?.directories ?? []);
    for (const f of files) for (const a of ancestors(f.path)) dirs.add(a);
    for (const d of [...dirs].sort()) mkdirSync(join(root, ...d.split('/')), { recursive: true, mode: 0o700 });
    for (const f of files) {
      const bytes = await store.readArtifact(f.content);
      if (contentId(bytes) !== f.content)
        throw new SnapshotError(
          'sentinel.capture.restoreIntegrity',
          `${f.path}: stored bytes differ from the snapshot`,
        );
      try {
        writeNew(join(root, ...f.path.split('/')), bytes);
      } catch (e) {
        throw new SnapshotError(
          'sentinel.capture.restoreIntegrity',
          `${f.path}: ${(e as NodeJS.ErrnoException).code ?? 'write failed'}`,
        );
      }
    }
    // The tree must be exactly the snapshot's folders and files, each file with its captured bytes.
    const listed = listTree(root);
    if (
      JSON.stringify(listed.files.sort()) !== JSON.stringify(files.map((f) => f.path).sort()) ||
      JSON.stringify(listed.dirs.sort()) !== JSON.stringify([...dirs].sort())
    ) {
      throw new SnapshotError(
        'sentinel.capture.restoreIntegrity',
        `${source.sourceId}: the restored tree differs from the snapshot`,
      );
    }
    for (const f of files) {
      if (contentId(readBack(join(root, ...f.path.split('/')))) !== f.content) {
        throw new SnapshotError('sentinel.capture.restoreIntegrity', `${f.path}: read back differently`);
      }
    }
    if (options.readOnly !== false) {
      for (const f of files) chmodSync(join(root, ...f.path.split('/')), 0o400);
      for (const d of [...dirs].sort().reverse()) chmodSync(join(root, ...d.split('/')), 0o500);
      chmodSync(root, 0o500);
    }
    sources.push(Object.freeze({ sourceId: source.sourceId, root, files: files.length, directories: dirs.size }));
  }
  if (options.readOnly !== false) chmodSync(target, 0o500);
  return Object.freeze({ ...opened, root: target, sources: Object.freeze(sources) });
}
