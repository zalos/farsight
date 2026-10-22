// Staged rule packs: read a candidate pack's files without following links or executing anything, validate its
// manifest and every file it names, and compute the digests a lock pins. A pack is data for registered adapters;
// a rule implementation shaped like a script is refused, and nothing here imports, evaluates or spawns pack content.
import { closeSync, constants as FS, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { LockedPack, LockedRule, PackFile, RulePackManifest } from '../contracts/index.js';
import { isSafeRelativePath, validateEnvelope } from '../validate.js';
import { canonicalDigest, sha256Digest } from '../policy/digest.js';
import { policyFail } from '../policy/errors.js';
import { deepFreeze } from '../policy/immutable.js';

/** The manifest's name at a pack's root. */
export const PACK_MANIFEST = 'sentinel-pack.json';

/** The bounds of one pack. A caller may lower any of them, never raise one. */
export interface PackLimits {
  /** Regular files. */
  readonly files: number;
  /** Every entry met while walking: files and folders, empty or not. */
  readonly entries: number;
  /** Folder nesting below the pack root. */
  readonly depth: number;
  /** UTF-8 bytes of one pack-relative path. */
  readonly pathBytes: number;
  readonly fileBytes: number;
  readonly totalBytes: number;
}

export const PACK_LIMITS: PackLimits = Object.freeze({
  files: 4096, entries: 8192, depth: 16, pathBytes: 512, fileBytes: 1024 * 1024, totalBytes: 32 * 1024 * 1024,
});
export const MAX_PACK_FILES = PACK_LIMITS.files;
export const MAX_PACK_FILE_BYTES = PACK_LIMITS.fileBytes;
export const MAX_PACK_BYTES = PACK_LIMITS.totalBytes;

function limitsOf(given: Partial<PackLimits> = {}): PackLimits {
  const out = { ...PACK_LIMITS };
  for (const key of Object.keys(PACK_LIMITS) as (keyof PackLimits)[]) {
    const v = given[key];
    if (v !== undefined) {
      if (!Number.isSafeInteger(v) || v < 1) policyFail('sentinel.rules.packTooLarge', `the ${key} limit is a positive integer`);
      out[key] = Math.min(v, PACK_LIMITS[key]);
    }
  }
  return Object.freeze(out);
}

/** Extensions a rule implementation may not have: the pattern engine reads declarative rules, never code. */
const SCRIPT = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|py|rb|pl|php|ps1|bat|cmd|exe|dll|so|dylib|jar|class|wasm|node)$/i;

// O_NONBLOCK: a file swapped for a FIFO opens without waiting for a writer, and fstat then refuses it.
const OPEN_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);
const errno = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const changed = (what: string): never => policyFail('sentinel.rules.packChanged', `${what} changed while the pack was read; stage it again`);

/** The folders from the pack root down to the one being read, each with the identity first seen. */
type Chain = readonly { readonly abs: string; readonly st: Stats }[];

function verifyChain(chain: Chain): void {
  for (const link of chain) {
    let now: Stats;
    try { now = lstatSync(link.abs); } catch { return changed('a folder'); }
    if (now.isSymbolicLink() || !now.isDirectory() || !same(now, link.st)) changed('a folder');
  }
}

/**
 * Reads every regular file under a canonical pack folder, within `limits`. Each folder's identity (device, inode),
 * from the root down, is checked before it is listed, after the listing, and before and after every file read, so a
 * folder swapped for a link or another folder mid-read refuses the pack (`packChanged`) instead of reading outside
 * it. Listing is one entry at a time against the entry budget, so an enormous or deeply nested folder stops at the
 * limit rather than being enumerated. These checks detect a swap between observations; they are not an OS sandbox.
 */
export function readPackDirectory(root: string, limits: Partial<PackLimits> = {}): Map<string, Buffer> {
  return readPackDirectoryWith(root, limits, {});
}

/** Test seam (not exported from the package): runs between an entry's lstat and its guarded read or listing. */
export interface PackReadHooks { readonly beforeRead?: (rel: string) => void }

export function readPackDirectoryWith(root: string, limits: Partial<PackLimits>, hooks: PackReadHooks): Map<string, Buffer> {
  const L = limitsOf(limits);
  if (!isAbsolute(root) || normalize(root) !== root) policyFail('sentinel.rules.packUnsafe', 'a pack folder is an absolute, normalised path');
  let real: string;
  try { real = realpathSync.native(root); } catch (e) { return policyFail('sentinel.rules.packUnreadable', `the pack folder cannot be resolved (${errno(e) ?? 'error'})`, e); }
  if (real !== root) policyFail('sentinel.rules.packUnsafe', 'the pack folder passes through a link or is not its canonical spelling');
  const rootSt = lstatSync(root);
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) policyFail('sentinel.rules.packUnsafe', 'the pack root is not a folder');

  const files = new Map<string, Buffer>();
  let entries = 0;
  let total = 0;
  const walk = (rel: string, abs: string, chain: Chain, depth: number) => {
    if (depth > L.depth) policyFail('sentinel.rules.packTooLarge', `a pack nests at most ${L.depth} folders deep`);
    verifyChain(chain);
    const names: string[] = [];
    let dir;
    try { dir = opendirSync(abs); } catch (e) { return policyFail('sentinel.rules.packUnreadable', `cannot list ${rel || '.'} (${errno(e) ?? 'error'})`, e); }
    try {
      for (let d = dir.readSync(); d !== null; d = dir.readSync()) {
        if (++entries > L.entries) policyFail('sentinel.rules.packTooLarge', `a pack holds at most ${L.entries} entries`);
        names.push(d.name);
      }
    } finally { dir.closeSync(); }
    verifyChain(chain);
    names.sort();
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (Buffer.byteLength(childRel) > L.pathBytes) policyFail('sentinel.rules.packTooLarge', `a pack path is at most ${L.pathBytes} bytes`);
      if (!isSafeRelativePath(childRel)) policyFail('sentinel.rules.packUnsafe', 'a pack file has an unsafe name');
      const childAbs = join(abs, name);
      let st: Stats;
      try { st = lstatSync(childAbs); } catch { return changed(childRel); }
      if (st.isSymbolicLink()) policyFail('sentinel.rules.packUnsafe', `${childRel} is a symbolic link`);
      hooks.beforeRead?.(childRel);
      if (st.isDirectory()) { walk(childRel, childAbs, [...chain, { abs: childAbs, st }], depth + 1); continue; }
      if (!st.isFile()) policyFail('sentinel.rules.packUnsafe', `${childRel} is not a regular file`);
      if (files.size >= L.files) policyFail('sentinel.rules.packTooLarge', `a pack holds at most ${L.files} files`);
      if (st.size > L.fileBytes) policyFail('sentinel.rules.packTooLarge', `${childRel} is larger than ${L.fileBytes} bytes`);
      if (total + st.size > L.totalBytes) policyFail('sentinel.rules.packTooLarge', `a pack holds at most ${L.totalBytes} bytes`);
      verifyChain(chain);
      const bytes = readFile(childAbs, childRel, st);
      verifyChain(chain);
      total += bytes.length;
      files.set(childRel, bytes);
    }
  };
  walk('', root, [{ abs: root, st: rootSt }], 0);
  return files;
}

function readFile(path: string, rel: string, seen: Stats): Buffer {
  let fd: number;
  try { fd = openSync(path, OPEN_FLAGS); } catch (e) {
    if (errno(e) === 'ELOOP' || errno(e) === 'ENOENT') return changed(rel);
    return policyFail('sentinel.rules.packUnreadable', `cannot open ${rel} (${errno(e) ?? 'error'})`, e);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !same(st, seen) || st.size !== seen.size) changed(rel);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    if (off !== st.size || readSync(fd, Buffer.alloc(1), 0, 1, st.size) !== 0) changed(rel);
    return buf;
  } finally { closeSync(fd); }
}

/**
 * A validated candidate: deep-frozen, and recognised by `isValidatedPack` only when `validatePack` produced it, so a
 * structural copy or an edited object cannot stand in for one. `entry` is exactly what promotion writes into the lock.
 */
export interface ValidatedPack {
  readonly manifest: RulePackManifest;
  readonly packDigest: string;
  readonly files: readonly PackFile[];
  readonly rules: readonly LockedRule[];
  /** The lock entry this pack becomes, without its promotion record. */
  readonly entry: Readonly<Omit<LockedPack, 'promotion'>>;
}

const validated = new WeakSet<object>();

/** True only for an object `validatePack` returned in this process. */
export function isValidatedPack(value: unknown): value is ValidatedPack {
  return typeof value === 'object' && value !== null && validated.has(value);
}

/** Digest of a sorted file inventory: any changed, added, removed or renamed file changes it. */
export const inventoryDigest = (files: readonly PackFile[]) => canonicalDigest({ kind: 'sentinel-pack-inventory/1', files });

/**
 * Validates a candidate pack's files within `limits`. Pure over the given bytes: nothing is read, imported or run.
 * The count, path, per-file and total limits are checked on the map itself before anything is decoded or hashed,
 * so a caller that skips `readPackDirectory` meets the same bounds.
 */
export function validatePack(files: ReadonlyMap<string, Uint8Array>, limits: Partial<PackLimits> = {}): ValidatedPack {
  const L = limitsOf(limits);
  if (!(files instanceof Map)) policyFail('sentinel.rules.manifestInvalid', 'a pack is a map of relative paths to bytes');
  if (files.size > L.files) policyFail('sentinel.rules.packTooLarge', `a pack holds at most ${L.files} files`);
  const copy = new Map<string, Buffer>();
  let total = 0;
  for (const [path, bytes] of files) {
    if (typeof path !== 'string' || !(bytes instanceof Uint8Array)) policyFail('sentinel.rules.manifestInvalid', 'a pack is a map of relative paths to bytes');
    if (Buffer.byteLength(path) > L.pathBytes) policyFail('sentinel.rules.packTooLarge', `a pack path is at most ${L.pathBytes} bytes`);
    if (!isSafeRelativePath(path)) policyFail('sentinel.rules.packUnsafe', 'a pack file has an unsafe name');
    if (path.split('/').length - 1 > L.depth) policyFail('sentinel.rules.packTooLarge', `a pack nests at most ${L.depth} folders deep`);
    if (bytes.byteLength > L.fileBytes) policyFail('sentinel.rules.packTooLarge', `${path} is larger than ${L.fileBytes} bytes`);
    total += bytes.byteLength;
    if (total > L.totalBytes) policyFail('sentinel.rules.packTooLarge', `a pack holds at most ${L.totalBytes} bytes`);
    copy.set(path, Buffer.from(bytes)); // the caller's buffers can change after this; the copy cannot
  }

  const manifestBytes = copy.get(PACK_MANIFEST);
  if (!manifestBytes) return policyFail('sentinel.rules.manifestInvalid', `a pack has ${PACK_MANIFEST} at its root`);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); } catch {
    return policyFail('sentinel.rules.manifestInvalid', `${PACK_MANIFEST} is not UTF-8 JSON`);
  }
  const checked = validateEnvelope('rulepack', value);
  if (!checked.ok) return policyFail('sentinel.rules.manifestInvalid', `${checked.errors[0]?.path || '/'}: ${checked.errors[0]?.message ?? 'invalid'}`);
  const manifest = checked.value;

  const inventory: PackFile[] = [...copy].map(([path, bytes]) => ({ path, digest: sha256Digest(bytes), size: bytes.byteLength }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath = new Map(inventory.map(f => [f.path, f]));
  const need = (path: string, what: string) => {
    const f = byPath.get(path);
    if (!f) policyFail('sentinel.rules.fileMissing', `${what} ${path} is not in the pack`);
    return f!;
  };
  if (manifest.rights.licenseFile) need(manifest.rights.licenseFile, 'the license file');

  const rules: LockedRule[] = manifest.rules.map(rule => {
    if (SCRIPT.test(rule.implementation.rulePath)) policyFail('sentinel.rules.executableRule', `${rule.familyId}: a rule implementation is declarative data, not a script`);
    const named = [
      need(rule.implementation.rulePath, `${rule.familyId}: the rule file`),
      ...rule.fixtures.positive.map(f => need(f, `${rule.familyId}: the positive fixture`)),
      ...rule.fixtures.negative.map(f => need(f, `${rule.familyId}: the negative fixture`)),
    ];
    return { familyId: rule.familyId, revision: rule.revision, definitionDigest: canonicalDigest({ kind: 'sentinel-rule/1', rule, files: named }) };
  });
  const packDigest = inventoryDigest(inventory);
  const pack: ValidatedPack = deepFreeze(structuredClone({
    manifest, packDigest, files: inventory, rules,
    entry: { packId: manifest.packId, version: manifest.version, packDigest, rights: manifest.rights, files: inventory, rules },
  }));
  validated.add(pack);
  return pack;
}
