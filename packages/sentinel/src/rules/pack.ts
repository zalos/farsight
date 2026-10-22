// Staged rule packs: read a candidate pack's files without following links or executing anything, validate its
// manifest and every file it names, and compute the digests a lock pins. A pack is data for registered adapters;
// a rule implementation shaped like a script is refused, and nothing here imports, evaluates or spawns pack content.
import { closeSync, constants as FS, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { LockedRule, PackFile, RulePackManifest } from '../contracts/index.js';
import { isSafeRelativePath, validateEnvelope } from '../validate.js';
import { canonicalDigest, sha256Digest } from '../policy/digest.js';
import { policyFail } from '../policy/errors.js';

/** The manifest's name at a pack's root. */
export const PACK_MANIFEST = 'sentinel-pack.json';
export const MAX_PACK_FILES = 4096;
export const MAX_PACK_FILE_BYTES = 1024 * 1024;
export const MAX_PACK_BYTES = 32 * 1024 * 1024;

/** Extensions a rule implementation may not have: the pattern engine reads declarative rules, never code. */
const SCRIPT = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|py|rb|pl|php|ps1|bat|cmd|exe|dll|so|dylib|jar|class|wasm|node)$/i;

const NOFOLLOW = FS.O_NOFOLLOW ?? 0;
const errno = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

/** Reads every regular file under a canonical pack folder. A link, device or anything else is refused. */
export function readPackDirectory(root: string): Map<string, Buffer> {
  if (!isAbsolute(root) || normalize(root) !== root) policyFail('sentinel.rules.packUnsafe', 'a pack folder is an absolute, normalised path');
  let real: string;
  try { real = realpathSync.native(root); } catch (e) { return policyFail('sentinel.rules.packUnreadable', `the pack folder cannot be resolved (${errno(e) ?? 'error'})`, e); }
  if (real !== root) policyFail('sentinel.rules.packUnsafe', 'the pack folder passes through a link or is not its canonical spelling');
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = (rel: string) => {
    const abs = rel ? join(root, ...rel.split('/')) : root;
    let names: string[];
    try { names = readdirSync(abs).sort(); } catch (e) { return policyFail('sentinel.rules.packUnreadable', `cannot list ${rel || '.'} (${errno(e) ?? 'error'})`, e); }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (!isSafeRelativePath(childRel)) policyFail('sentinel.rules.packUnsafe', 'a pack file has an unsafe name');
      const st = lstatSync(join(abs, name));
      if (st.isSymbolicLink()) policyFail('sentinel.rules.packUnsafe', `${childRel} is a symbolic link`);
      if (st.isDirectory()) { walk(childRel); continue; }
      if (!st.isFile()) policyFail('sentinel.rules.packUnsafe', `${childRel} is not a regular file`);
      if (files.size >= MAX_PACK_FILES) policyFail('sentinel.rules.packTooLarge', `a pack holds at most ${MAX_PACK_FILES} files`);
      if (st.size > MAX_PACK_FILE_BYTES) policyFail('sentinel.rules.packTooLarge', `${childRel} is larger than ${MAX_PACK_FILE_BYTES} bytes`);
      const bytes = readFile(join(abs, name), childRel);
      total += bytes.length;
      if (total > MAX_PACK_BYTES) policyFail('sentinel.rules.packTooLarge', `a pack holds at most ${MAX_PACK_BYTES} bytes`);
      files.set(childRel, bytes);
    }
  };
  walk('');
  return files;
}

function readFile(path: string, rel: string): Buffer {
  let fd: number;
  try { fd = openSync(path, FS.O_RDONLY | NOFOLLOW); } catch (e) { return policyFail('sentinel.rules.packUnreadable', `cannot open ${rel} (${errno(e) ?? 'error'})`, e); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_PACK_FILE_BYTES) policyFail('sentinel.rules.packUnsafe', `${rel} changed while it was read`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    if (off !== st.size || readSync(fd, Buffer.alloc(1), 0, 1, st.size) !== 0) policyFail('sentinel.rules.packUnsafe', `${rel} changed while it was read`);
    return buf;
  } finally { closeSync(fd); }
}

/** A validated candidate: immutable, with the digests a lock pins. */
export interface ValidatedPack {
  readonly manifest: RulePackManifest;
  readonly packDigest: string;
  readonly files: readonly PackFile[];
  readonly rules: readonly LockedRule[];
}

/** Digest of a sorted file inventory: any changed, added, removed or renamed file changes it. */
export const inventoryDigest = (files: readonly PackFile[]) => canonicalDigest({ kind: 'sentinel-pack-inventory/1', files });

/** Validates a candidate pack's files. Pure over the given bytes: nothing is read, imported or run. */
export function validatePack(files: ReadonlyMap<string, Uint8Array>): ValidatedPack {
  const manifestBytes = files.get(PACK_MANIFEST);
  if (!manifestBytes) return policyFail('sentinel.rules.manifestInvalid', `a pack has ${PACK_MANIFEST} at its root`);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); } catch {
    return policyFail('sentinel.rules.manifestInvalid', `${PACK_MANIFEST} is not UTF-8 JSON`);
  }
  const checked = validateEnvelope('rulepack', value);
  if (!checked.ok) return policyFail('sentinel.rules.manifestInvalid', `${checked.errors[0]?.path || '/'}: ${checked.errors[0]?.message ?? 'invalid'}`);
  const manifest = checked.value;

  const inventory: PackFile[] = [...files].map(([path, bytes]) => {
    if (!isSafeRelativePath(path)) policyFail('sentinel.rules.packUnsafe', 'a pack file has an unsafe name');
    return { path, digest: sha256Digest(bytes), size: bytes.byteLength };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
  return Object.freeze({
    manifest: Object.freeze(manifest), packDigest: inventoryDigest(inventory),
    files: Object.freeze(inventory), rules: Object.freeze(rules),
  });
}
