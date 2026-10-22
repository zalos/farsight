// The installed Next, React and React DOM packages, from captured lockfile bytes only (PR 14). A package is resolved
// only from an authoritative record of what the package manager installed, with the content identity it installed:
// an npm `package-lock.json` (lockfile versions 2 and 3) entry with its `integrity`, or a `pnpm-lock.yaml` (6.0/9.0)
// importer version and its package's `resolution.integrity`. A version string alone never qualifies: a local tarball,
// a link, a Git or URL source, an entry without an integrity, or a package whose integrity is not the pinned one for
// its version (a repacked or substituted package) is `unknown`. So is a version written only in package.json, a
// non-registry package.json specifier, an unread lockfile kind, two lockfiles that could both apply, a lockfile that
// disagrees with an exact pin, and any lockfile whose JSON or YAML is not the expected shape. The lockfile is
// untrusted input: every value is shape- and size-checked before it is read. Nothing runs a package manager.

export type PackageName = 'next' | 'react' | 'react-dom';
export const PACKAGES: readonly PackageName[] = Object.freeze(['next', 'react', 'react-dom']);

export type VersionReason =
  | 'no-lockfile' | 'lockfile-unsupported' | 'lockfile-ambiguous' | 'lockfile-invalid' | 'not-in-lockfile'
  | 'not-exact' | 'pin-disagrees' | 'too-large' | 'not-registry' | 'no-integrity' | 'identity-mismatch' | 'declared-nonregistry';

export interface LockfileRef {
  readonly relativePath: string;
  readonly content: string;
}

export type ResolvedVersion =
  | {
      readonly state: 'resolved';
      readonly version: string;
      /** The content identity the lockfile records (`sha512-…`). */
      readonly integrity: string;
      readonly lockfile: LockfileRef;
      /** The UTF-8 bytes in the lockfile that record it, when one occurrence can be named exactly. */
      readonly span?: { readonly startByte: number; readonly endByte: number };
    }
  | { readonly state: 'unknown'; readonly reason: VersionReason; readonly detail: string; readonly lockfile?: LockfileRef };

/** A pinned package: exact version and the integrity of the registry tarball that version was measured with. */
export interface PinnedPackage { readonly version: string; readonly integrity: string }

/** A captured file the resolver may read, by source-relative path. */
export interface CapturedFile { readonly relativePath: string; readonly content: string; readonly bytes: number }

export interface VersionInputs {
  /** The project folder ('' for the source root). */
  readonly projectDir: string;
  /** Included captured files of this source, by path. */
  readonly files: ReadonlyMap<string, CapturedFile>;
  /** Paths of every captured entry of this source, included or recorded without bytes. */
  readonly recorded: ReadonlySet<string>;
  readonly read: (file: CapturedFile) => Promise<Uint8Array>;
  /** The project's package.json, already read; untrusted. */
  readonly packageJson: Record<string, unknown>;
  /** The supported packages: a package at a pinned version must carry exactly its pinned integrity. */
  readonly pins: Readonly<Record<PackageName, PinnedPackage>>;
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml'] as const;
const UNSUPPORTED_LOCKFILES = ['npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock'] as const;
/** Largest lockfile read; a larger one leaves every version unknown. */
export const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const EXACT = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,64})?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const REGISTRY_SPEC = /^[~^<>=v0-9 .x*|-]{1,128}$/;
const MAX_STRING = 2048;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const str = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_STRING;
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parent = (dir: string): string | null => (dir === '' ? null : dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');

/** Resolves all three packages from the nearest folder at or above the project that holds a lockfile. */
export async function resolveVersions(inputs: VersionInputs): Promise<Readonly<Record<PackageName, ResolvedVersion>>> {
  const all = (v: ResolvedVersion) => Object.freeze({ next: v, react: v, 'react-dom': v });
  for (let dir: string | null = inputs.projectDir; dir !== null; dir = parent(dir)) {
    const here = [...LOCKFILES, ...UNSUPPORTED_LOCKFILES].filter(n => inputs.recorded.has(join(dir!, n)));
    if (here.length === 0) continue;
    if (here.length > 1) return all({ state: 'unknown', reason: 'lockfile-ambiguous', detail: `${here.join(' and ')} both sit in ${dir || 'the source root'}` });
    const name = here[0]!;
    const path = join(dir, name);
    const file = inputs.files.get(path);
    if (!(LOCKFILES as readonly string[]).includes(name)) return all({ state: 'unknown', reason: 'lockfile-unsupported', detail: `${path} is not a lockfile kind this pack reads` });
    if (!file) return all({ state: 'unknown', reason: 'lockfile-unsupported', detail: `${path} was recorded without its bytes` });
    const ref = { relativePath: file.relativePath, content: file.content };
    if (file.bytes > MAX_LOCKFILE_BYTES) return all({ state: 'unknown', reason: 'too-large', detail: `${path} is larger than this pack reads`, lockfile: ref });
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await inputs.read(file)); } catch (e) {
      if (e instanceof TypeError) return all({ state: 'unknown', reason: 'lockfile-invalid', detail: `${path} is not valid UTF-8`, lockfile: ref });
      throw e;
    }
    const rel = dir === inputs.projectDir ? '' : inputs.projectDir.slice(dir ? dir.length + 1 : 0);
    const out = {} as Record<PackageName, ResolvedVersion>;
    const npm = name === 'package-lock.json' ? parsePackageLock(text) : null;
    for (const pkg of PACKAGES) {
      let found: Found;
      try {
        found = name === 'package-lock.json' ? fromPackageLock(npm!, text, rel, pkg) : fromPnpmLock(text, rel, pkg);
      } catch {
        // Defence in depth: any shape the readers did not anticipate is invalid input, never a crash.
        found = { state: 'unknown', reason: 'lockfile-invalid', detail: `${path} is not the expected shape` };
      }
      if (found.state === 'resolved') found = checkIdentity(found, pkg, inputs.pins[pkg]);
      out[pkg] = found.state === 'resolved' ? withDeclaration({ ...found, lockfile: ref }, inputs.packageJson, pkg) : { ...found, lockfile: ref };
    }
    return Object.freeze(out);
  }
  const declared = PACKAGES.map(p => declarationProblem(inputs.packageJson, p, null)).find(Boolean);
  return all(declared ? { state: 'unknown', reason: declared[0], detail: declared[1] }
    : { state: 'unknown', reason: 'no-lockfile', detail: 'no lockfile at or above the project; a package.json declaration is not what was installed' });
}

type Found = { state: 'resolved'; version: string; integrity: string; span?: { startByte: number; endByte: number } } | { state: 'unknown'; reason: VersionReason; detail: string };

/** The pinned version must be the pinned bytes: the same version with another integrity is a different package. */
function checkIdentity(found: Found & { state: 'resolved' }, pkg: PackageName, pin: PinnedPackage | undefined): Found {
  if (pin && found.version === pin.version && found.integrity !== pin.integrity) {
    return { state: 'unknown', reason: 'identity-mismatch', detail: `${pkg} ${found.version} is recorded with another integrity than the registry package` };
  }
  return found;
}

/** Why the package.json declaration disqualifies the lockfile's answer, or null. Untrusted input: shapes are checked. */
function declarationProblem(pkgJson: Record<string, unknown>, pkg: PackageName, locked: string | null): [VersionReason, string] | null {
  for (const field of DEP_FIELDS) {
    const deps = pkgJson[field];
    if (deps === undefined) continue;
    if (!plain(deps)) return ['declared-nonregistry', `package.json ${field} is not an object`];
    if (!Object.hasOwn(deps, pkg)) continue;
    const spec = deps[pkg];
    if (!str(spec)) return ['declared-nonregistry', `package.json declares ${pkg} as something other than a version`];
    // file:, link:, git, URLs, npm: aliases, workspace: and owner/repo shorthands are not the registry package.
    if (!REGISTRY_SPEC.test(spec)) return ['declared-nonregistry', `package.json declares ${pkg} from a non-registry source`];
    if (locked !== null && EXACT.test(spec) && spec !== locked) return ['pin-disagrees', `package.json pins ${pkg} ${spec}; the lockfile records ${locked}`];
  }
  return null;
}

function withDeclaration(found: ResolvedVersion & { state: 'resolved' }, pkgJson: Record<string, unknown>, pkg: PackageName): ResolvedVersion {
  const problem = declarationProblem(pkgJson, pkg, found.version);
  return problem ? { state: 'unknown', reason: problem[0], detail: problem[1], lockfile: found.lockfile } : found;
}

type NpmLock = { ok: true; packages: Record<string, unknown> } | { ok: false; reason: VersionReason; detail: string };

function parsePackageLock(text: string): NpmLock {
  let lock: unknown;
  try { lock = JSON.parse(text); } catch { return { ok: false, reason: 'lockfile-invalid', detail: 'package-lock.json is not JSON' }; }
  if (!plain(lock)) return { ok: false, reason: 'lockfile-invalid', detail: 'package-lock.json is not a JSON object' };
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) return { ok: false, reason: 'lockfile-unsupported', detail: 'only package-lock.json lockfileVersion 2 or 3 is read' };
  if (!plain(lock.packages)) return { ok: false, reason: 'lockfile-invalid', detail: 'package-lock.json has no packages object' };
  return { ok: true, packages: lock.packages };
}

/** npm lockfile v2/v3: Node resolution from the importer's own node_modules up to the lockfile's. */
function fromPackageLock(lock: NpmLock, text: string, rel: string, pkg: PackageName): Found {
  if (!lock.ok) return { state: 'unknown', reason: lock.reason, detail: lock.detail };
  const packages = lock.packages;
  if (!Object.hasOwn(packages, rel) || !plain(packages[rel])) return { state: 'unknown', reason: 'not-in-lockfile', detail: `the lockfile has no entry for the project folder "${rel || '.'}"` };
  for (let dir: string | null = rel; dir !== null; dir = parent(dir)) {
    const key = join(dir, `node_modules/${pkg}`);
    if (!Object.hasOwn(packages, key)) continue;
    const entry = packages[key];
    if (!plain(entry)) return { state: 'unknown', reason: 'lockfile-invalid', detail: `${key} is not an object` };
    if (entry.link === true) return { state: 'unknown', reason: 'not-registry', detail: `${key} is a link to a local folder` };
    if (!str(entry.version) || !EXACT.test(entry.version)) return { state: 'unknown', reason: 'not-exact', detail: `${key} has no exact version` };
    const resolved = entry.resolved;
    if (!str(resolved) || resolved !== `https://registry.npmjs.org/${pkg}/-/${pkg}-${entry.version}.tgz`) {
      return { state: 'unknown', reason: 'not-registry', detail: `${key} was not installed from the public registry tarball for its version` };
    }
    if (!str(entry.integrity) || !INTEGRITY.test(entry.integrity)) return { state: 'unknown', reason: 'no-integrity', detail: `${key} records no sha512 integrity` };
    return { state: 'resolved', version: entry.version, integrity: entry.integrity, ...spanOf(text, JSON.stringify(key), entry.version) };
  }
  return { state: 'unknown', reason: 'not-in-lockfile', detail: `${pkg} is not installed for this project` };
}

/** The bytes from a key's only occurrence to the end of the first `"version"` value after it. */
function spanOf(text: string, key: string, version: string): { span?: { startByte: number; endByte: number } } {
  const at = text.indexOf(`${key}:`);
  if (at < 0 || text.indexOf(`${key}:`, at + 1) >= 0) return {};
  const needle = `"version": ${JSON.stringify(version)}`;
  const v = text.indexOf(needle, at);
  const close = text.indexOf('}', at);
  if (v < 0 || (close >= 0 && v > close)) return {};
  return { span: { startByte: Buffer.byteLength(text.slice(0, at)), endByte: Buffer.byteLength(text.slice(0, v + needle.length)) } };
}

/**
 * pnpm lockfile 6.0/9.0: `importers.<rel>.(dependencies|devDependencies|optionalDependencies).<pkg>.version`, then the
 * package's `resolution: {integrity: …}` under `packages`. Read line by line from block-style YAML with two-space
 * indentation. Flow style elsewhere, tabs, a tarball or Git resolution, or a layout outside that shape is unknown.
 */
function fromPnpmLock(text: string, rel: string, pkg: PackageName): Found {
  const lines = text.split('\n');
  const unq = (s: string) => s.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  const lv = lines.find(l => l.startsWith('lockfileVersion:'));
  const version = lv ? unq(lv.slice('lockfileVersion:'.length)) : '';
  if (version !== '6.0' && version !== '9.0') return { state: 'unknown', reason: 'lockfile-unsupported', detail: 'only pnpm lockfileVersion 6.0 or 9.0 is read' };
  if (lines.some(l => l.includes('\t'))) return { state: 'unknown', reason: 'lockfile-invalid', detail: 'pnpm-lock.yaml holds tabs' };
  const indent = (l: string) => l.length - l.trimStart().length;
  const blockOf = (from: number, depth: number): [number, number] => {
    let end = from + 1;
    while (end < lines.length && (lines[end]!.trim() === '' || indent(lines[end]!) > depth)) end++;
    return [from + 1, end];
  };
  const findKeys = (range: [number, number], depth: number, match: (key: string) => boolean): number[] => {
    const out: number[] = [];
    for (let i = range[0]; i < range[1]; i++) {
      const l = lines[i]!;
      if (indent(l) !== depth || !l.trimEnd().endsWith(':')) continue;
      if (match(unq(l.trim().slice(0, -1)))) out.push(i);
    }
    return out;
  };
  const findKey = (range: [number, number], depth: number, key: string) => findKeys(range, depth, k => k === key)[0] ?? -1;
  const top: [number, number] = [0, lines.length];
  const importers = findKey(top, 0, 'importers');
  if (importers < 0) return { state: 'unknown', reason: 'lockfile-unsupported', detail: 'pnpm-lock.yaml has no importers section' };
  const imp = findKey(blockOf(importers, 0), 2, rel || '.');
  if (imp < 0) return { state: 'unknown', reason: 'not-in-lockfile', detail: `pnpm-lock.yaml has no importer "${rel || '.'}"` };
  const hits: number[] = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const s = findKey(blockOf(imp, 2), 4, section);
    if (s < 0) continue;
    const p = findKey(blockOf(s, 4), 6, pkg);
    if (p >= 0) hits.push(p);
  }
  if (hits.length === 0) return { state: 'unknown', reason: 'not-in-lockfile', detail: `${pkg} is not a direct dependency of this importer` };
  if (hits.length > 1) return { state: 'unknown', reason: 'lockfile-ambiguous', detail: `${pkg} appears in two dependency sections` };
  const [from, to] = blockOf(hits[0]!, 6);
  let found: { v: string; line: number } | null = null;
  for (let i = from; i < to; i++) {
    const l = lines[i]!;
    if (indent(l) !== 8 || !l.trim().startsWith('version:')) continue;
    const raw = unq(l.trim().slice('version:'.length));
    if (raw.length > MAX_STRING) return { state: 'unknown', reason: 'lockfile-invalid', detail: `${pkg} has an oversized version line` };
    const v = raw.includes('(') ? raw.slice(0, raw.indexOf('(')) : raw;
    if (!EXACT.test(v)) return { state: 'unknown', reason: raw.startsWith('file:') || raw.startsWith('link:') ? 'not-registry' : 'not-exact', detail: `${pkg} is recorded as "${raw.slice(0, 120)}"` };
    found = { v, line: i };
    break;
  }
  if (!found) return { state: 'unknown', reason: 'lockfile-invalid', detail: `${pkg} has no version line` };
  // The package's own entry: `next@14.2.25:` (9.0) or `/next@14.2.25:` / `/next@14.2.25(…):` (6.0), exactly one.
  const packages = findKey(top, 0, 'packages');
  if (packages < 0) return { state: 'unknown', reason: 'no-integrity', detail: 'pnpm-lock.yaml has no packages section' };
  const prefix = version === '9.0' ? `${pkg}@${found.v}` : `/${pkg}@${found.v}`;
  const entries = findKeys(blockOf(packages, 0), 2, k => k === prefix || (version === '6.0' && k.startsWith(`${prefix}(`)));
  if (entries.length !== 1) return { state: 'unknown', reason: entries.length ? 'lockfile-ambiguous' : 'no-integrity', detail: `${pkg}@${found.v} has ${entries.length} package entries` };
  const [pf, pt] = blockOf(entries[0]!, 2);
  const res = lines.slice(pf, pt).filter(l => indent(l) === 4 && l.trim().startsWith('resolution:'));
  const m = res.length === 1 ? /^resolution: \{integrity: (sha512-[A-Za-z0-9+/]{86}==)\}$/.exec(res[0]!.trim()) : null;
  if (!m) return { state: 'unknown', reason: res.length === 1 && /tarball|repo|directory/.test(res[0]!) ? 'not-registry' : 'no-integrity', detail: `${pkg}@${found.v} records no registry integrity` };
  const startLine = lines.slice(0, hits[0]!).join('\n').length + (hits[0]! > 0 ? 1 : 0);
  const endLine = lines.slice(0, found.line + 1).join('\n').length;
  return { state: 'resolved', version: found.v, integrity: m[1]!, span: { startByte: Buffer.byteLength(text.slice(0, startLine)), endByte: Buffer.byteLength(text.slice(0, endLine)) } };
}
