// The materialization sidecar: what a restore needs beyond the snapshot envelope, captured at the same moment.
// The envelope records each entry's disposition; this records every listed folder (empty ones too), each included
// file's executable bit and provenance (its Git mode and blob id, or the LFS pointer it was resolved from), each
// recorded link's target and every gitlink's commit. It is a canonical JSON artifact bound to its snapshot by the
// ledger's snapshot row, and stored as `source` (link targets are repository text).
import type { ArtifactId, CaptureEntry, Digest } from '../contracts/index.js';
import { SnapshotError } from './errors.js';
import type { Inventory } from './inventory.js';
import { foldPath, isRecordablePath } from './policy.js';

export const MATERIALIZATION_SCHEMA = 'sentinel-capture-materialization/draft-1';
/** A link target longer than this is not recorded (the link itself still is, in the envelope). */
const MAX_TARGET = 4096;

export interface MaterializedFile {
  readonly path: string;
  readonly content: ArtifactId;
  readonly executable: boolean;
  readonly git?: { readonly mode: string; readonly oid: string };
  readonly lfs?: { readonly oid: string; readonly size: number };
}

export interface MaterializedSource {
  readonly sourceId: string;
  /** Every listed folder below the root, sorted; restored even when empty. */
  readonly directories: readonly string[];
  readonly files: readonly MaterializedFile[];
  readonly symlinks: readonly { readonly path: string; readonly target: string }[];
  readonly gitlinks: readonly { readonly path: string; readonly commit: string }[];
}

export interface Materialization {
  readonly schema: typeof MATERIALIZATION_SCHEMA;
  readonly snapshotId: string;
  readonly inventoryDigest: Digest;
  readonly sources: readonly MaterializedSource[];
}

const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const key = (sourceId: string, path: string) => `${sourceId}\u0000${path}`;

/** The sidecar body for an inventory (without the snapshot's identity, which is added once it is known). */
export function materializationSources(inv: Inventory, sourceIds: readonly string[], entries: readonly CaptureEntry[]): MaterializedSource[] {
  return sourceIds.map(sourceId => {
    const mine = entries.filter(e => e.sourceId === sourceId);
    const files: MaterializedFile[] = [];
    for (const e of mine) {
      if (e.kind !== 'file' || e.disposition !== 'included') continue;
      const f = inv.facts.get(key(sourceId, e.relativePath));
      files.push({ path: e.relativePath, content: e.content, executable: f?.executable ?? false,
        ...(f?.git ? { git: f.git } : {}), ...(f?.lfs ? { lfs: f.lfs } : {}) });
    }
    // Folders that restore onto one name under case folding are dropped with everything below them; their files
    // were already refused as colliding.
    const listed = [...(inv.directories.get(sourceId) ?? [])];
    const folds = new Map<string, number>();
    for (const d of listed) folds.set(foldPath(d), (folds.get(foldPath(d)) ?? 0) + 1);
    const colliding = listed.filter(d => (folds.get(foldPath(d)) ?? 0) > 1);
    const directories = listed
      .filter(d => !colliding.some(c => d === c || d.startsWith(`${c}/`)))
      .sort();
    const symlinks = mine.filter(e => e.kind === 'symlink').flatMap(e => {
      const target = inv.symlinkTargets.get(key(sourceId, e.relativePath));
      return target !== undefined && target.length <= MAX_TARGET ? [{ path: e.relativePath, target }] : [];
    });
    const gitlinks = [...inv.gitlinks].filter(([k]) => k.startsWith(`${sourceId}\u0000`))
      .map(([k, commit]) => ({ path: k.slice(sourceId.length + 1), commit }));
    return { sourceId, directories, files: files.sort(byPath), symlinks: symlinks.sort(byPath), gitlinks: gitlinks.sort(byPath) };
  });
}

const fail = (detail: string): never => { throw new SnapshotError('sentinel.capture.notSnapshot', detail); };
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const asObject = (v: unknown, what: string): Record<string, unknown> => (isObject(v) ? v : fail(`${what} is not an object`));
const denseList = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) return fail(`${what} is not a list`);
  for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i)) fail(`${what} is sparse`);
  return v;
};
const onlyKeys = (o: Record<string, unknown>, allowed: string[], what: string) => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${what} has an unknown field ${k}`);
};
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Checks a parsed sidecar's shape and paths; refuses anything it does not recognise. */
export function validateMaterialization(value: unknown): Materialization {
  if (!isObject(value)) return fail('the materialization is not an object');
  onlyKeys(value, ['schema', 'snapshotId', 'inventoryDigest', 'sources'], 'the materialization');
  if (value.schema !== MATERIALIZATION_SCHEMA) fail('the materialization schema is not supported');
  if (typeof value.snapshotId !== 'string' || typeof value.inventoryDigest !== 'string' || !DIGEST.test(value.inventoryDigest)) {
    fail('the materialization does not name its snapshot');
  }
  const ids = new Set<string>();
  for (const s of denseList(value.sources, 'sources')) {
    if (!isObject(s)) fail('a source is not an object');
    const src = s as Record<string, unknown>;
    onlyKeys(src, ['sourceId', 'directories', 'files', 'symlinks', 'gitlinks'], 'a source');
    if (typeof src.sourceId !== 'string' || ids.has(src.sourceId)) fail('a source id is missing or repeated');
    ids.add(src.sourceId as string);
    const paths = new Set<string>();
    const path = (p: unknown, what: string) => {
      if (typeof p !== 'string' || !isRecordablePath(p)) fail(`${what} is not a safe path`);
      return p as string;
    };
    for (const d of denseList(src.directories, 'directories')) {
      const p = path(d, 'a directory');
      if (paths.has(p)) fail('a path is listed twice');
      paths.add(p);
    }
    for (const item of denseList(src.files, 'files')) {
      const f = asObject(item, 'a file');
      onlyKeys(f, ['path', 'content', 'executable', 'git', 'lfs'], 'a file');
      const p = path(f.path, 'a file');
      if (paths.has(p)) fail('a path is listed twice');
      paths.add(p);
      if (typeof f.content !== 'string' || !DIGEST.test(f.content) || typeof f.executable !== 'boolean') fail('a file is malformed');
      if (f.git !== undefined && (!isObject(f.git) || typeof f.git.mode !== 'string' || typeof f.git.oid !== 'string' || !OID.test(f.git.oid))) fail('a file\'s Git provenance is malformed');
      if (f.lfs !== undefined && (!isObject(f.lfs) || typeof f.lfs.oid !== 'string' || !/^[0-9a-f]{64}$/.test(f.lfs.oid) || !Number.isSafeInteger(f.lfs.size))) fail('a file\'s LFS provenance is malformed');
    }
    for (const item of denseList(src.symlinks, 'symlinks')) {
      const l = asObject(item, 'a link');
      onlyKeys(l, ['path', 'target'], 'a link');
      path(l.path, 'a link');
      if (typeof l.target !== 'string' || l.target.length > MAX_TARGET) fail('a link target is malformed');
    }
    for (const item of denseList(src.gitlinks, 'gitlinks')) {
      const g = asObject(item, 'a gitlink');
      onlyKeys(g, ['path', 'commit'], 'a gitlink');
      path(g.path, 'a gitlink');
      if (typeof g.commit !== 'string' || !OID.test(g.commit)) fail('a gitlink commit is malformed');
    }
  }
  return value as unknown as Materialization;
}
