// The installed Next, React and React DOM versions, from captured lockfile bytes only (PR 14). A version is resolved
// only from an authoritative record of what the package manager installed: an npm `package-lock.json` (lockfile
// versions 2 and 3) or a `pnpm-lock.yaml` (lockfile versions 6 and 9, importer form). A version written only in
// package.json, a lockfile kind this pack does not read, two lockfiles that could both apply, a lockfile that
// disagrees with an exact package.json pin, or a linked/local package is `unknown`, with its reason. Nothing runs
// the package manager; nothing reads node_modules.

export type PackageName = 'next' | 'react' | 'react-dom';
export const PACKAGES: readonly PackageName[] = Object.freeze(['next', 'react', 'react-dom']);

export type VersionReason =
  | 'no-lockfile' | 'lockfile-unsupported' | 'lockfile-ambiguous' | 'lockfile-invalid' | 'not-in-lockfile'
  | 'not-exact' | 'pin-disagrees' | 'too-large';

export interface LockfileRef {
  readonly relativePath: string;
  readonly content: string;
}

export type ResolvedVersion =
  | {
      readonly state: 'resolved';
      readonly version: string;
      readonly lockfile: LockfileRef;
      /** The UTF-8 bytes in the lockfile that record it, when one occurrence can be named exactly. */
      readonly span?: { readonly startByte: number; readonly endByte: number };
    }
  | { readonly state: 'unknown'; readonly reason: VersionReason; readonly detail: string; readonly lockfile?: LockfileRef };

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
  /** The project's package.json, already read. */
  readonly packageJson: Record<string, unknown>;
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml'] as const;
const UNSUPPORTED_LOCKFILES = ['npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock'] as const;
/** Largest lockfile read; a larger one leaves every version unknown. */
export const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

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
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await inputs.read(file)); } catch {
      return all({ state: 'unknown', reason: 'lockfile-invalid', detail: `${path} is not valid UTF-8`, lockfile: ref });
    }
    const rel = dir === inputs.projectDir ? '' : inputs.projectDir.slice(dir ? dir.length + 1 : 0);
    const out = {} as Record<PackageName, ResolvedVersion>;
    for (const pkg of PACKAGES) {
      const found = name === 'package-lock.json' ? fromPackageLock(text, rel, pkg) : fromPnpmLock(text, rel, pkg);
      out[pkg] = found.state === 'resolved' ? withPin({ ...found, lockfile: ref }, inputs.packageJson, pkg) : { ...found, lockfile: ref };
    }
    return Object.freeze(out);
  }
  return all({ state: 'unknown', reason: 'no-lockfile', detail: 'no lockfile at or above the project; a package.json declaration is not what was installed' });
}

/** An exact package.json pin that names another version than the lockfile means the lockfile is stale. */
function withPin(found: ResolvedVersion & { state: 'resolved' }, pkgJson: Record<string, unknown>, pkg: PackageName): ResolvedVersion {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkgJson[field];
    if (!deps || typeof deps !== 'object') continue;
    const spec = (deps as Record<string, unknown>)[pkg];
    if (typeof spec === 'string' && EXACT.test(spec) && spec !== found.version) {
      return { state: 'unknown', reason: 'pin-disagrees', detail: `package.json pins ${pkg} ${spec}; the lockfile records ${found.version}`, lockfile: found.lockfile };
    }
  }
  return found;
}

type Found = { state: 'resolved'; version: string; span?: { startByte: number; endByte: number } } | { state: 'unknown'; reason: VersionReason; detail: string };

/** npm lockfile v2/v3: Node resolution from the importer's own node_modules up to the lockfile's. */
function fromPackageLock(text: string, rel: string, pkg: PackageName): Found {
  let lock: unknown;
  try { lock = JSON.parse(text); } catch { return { state: 'unknown', reason: 'lockfile-invalid', detail: 'package-lock.json is not JSON' }; }
  const l = lock as { lockfileVersion?: unknown; packages?: unknown };
  if ((l.lockfileVersion !== 2 && l.lockfileVersion !== 3) || !l.packages || typeof l.packages !== 'object') {
    return { state: 'unknown', reason: 'lockfile-unsupported', detail: 'only package-lock.json lockfileVersion 2 or 3 is read' };
  }
  const packages = l.packages as Record<string, unknown>;
  if (!(rel in packages)) return { state: 'unknown', reason: 'not-in-lockfile', detail: `the lockfile has no entry for the project folder "${rel || '.'}"` };
  for (let dir: string | null = rel; dir !== null; dir = parent(dir)) {
    const key = join(dir, `node_modules/${pkg}`);
    const entry = packages[key] as { version?: unknown; link?: unknown } | undefined;
    if (!entry) continue;
    if (entry.link === true || typeof entry.version !== 'string' || !EXACT.test(entry.version)) {
      return { state: 'unknown', reason: 'not-exact', detail: `${key} is linked or has no exact version` };
    }
    return { state: 'resolved', version: entry.version, ...spanOf(text, JSON.stringify(key), entry.version) };
  }
  return { state: 'unknown', reason: 'not-in-lockfile', detail: `${pkg} is not installed for this project` };
}

/** The bytes from a key's only occurrence to the end of the first `"version"` value after it. */
function spanOf(text: string, key: string, version: string): { span?: { startByte: number; endByte: number } } {
  const at = text.indexOf(`${key}:`);
  if (at < 0 || text.indexOf(`${key}:`, at + 1) >= 0) return {};
  const v = text.indexOf(`"version": ${JSON.stringify(version)}`, at);
  const close = text.indexOf('}', at);
  if (v < 0 || (close >= 0 && v > close)) return {};
  const end = v + `"version": ${JSON.stringify(version)}`.length;
  return { span: { startByte: Buffer.byteLength(text.slice(0, at)), endByte: Buffer.byteLength(text.slice(0, end)) } };
}

/**
 * pnpm lockfile 6.0/9.0: `importers.<rel>.(dependencies|devDependencies|optionalDependencies).<pkg>.version`, read
 * line by line from block-style YAML with two-space indentation. Flow style, tabs, aliases or a layout outside that
 * shape leave the version unknown rather than read loosely.
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
  const findKey = (range: [number, number], depth: number, key: string): number => {
    for (let i = range[0]; i < range[1]; i++) {
      const l = lines[i]!;
      if (indent(l) !== depth || !l.trimEnd().endsWith(':')) continue;
      if (unq(l.trim().slice(0, -1)) === key) return i;
    }
    return -1;
  };
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
  for (let i = from; i < to; i++) {
    const l = lines[i]!;
    if (indent(l) !== 8 || !l.trim().startsWith('version:')) continue;
    const raw = unq(l.trim().slice('version:'.length));
    const v = raw.includes('(') ? raw.slice(0, raw.indexOf('(')) : raw;
    if (!EXACT.test(v)) return { state: 'unknown', reason: 'not-exact', detail: `${pkg} is recorded as "${raw}"` };
    const startLine = lines.slice(0, hits[0]!).join('\n').length + (hits[0]! > 0 ? 1 : 0);
    const endLine = lines.slice(0, i + 1).join('\n').length;
    return { state: 'resolved', version: v, span: { startByte: Buffer.byteLength(text.slice(0, startLine)), endByte: Buffer.byteLength(text.slice(0, endLine)) } };
  }
  return { state: 'unknown', reason: 'lockfile-invalid', detail: `${pkg} has no version line` };
}
