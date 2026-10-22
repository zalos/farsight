// A read-only Git object reader in plain TypeScript. It reads loose objects and version-2 pack indexes/packs of a
// local repository and nothing else: no `git` process, so no hook, filter, textconv, replace ref, fsmonitor,
// configured command, promisor (lazy) fetch or other network access can run. Objects that are not present
// locally (a partial clone, an unfollowed alternate, a pruned pack) are reported missing, never fetched.
// Every object read is hash-verified against its id and size-bounded before it is inflated.
//
// Read boundary. The reader is granted at most two canonical Git roots: the Git directory and, for a linked
// worktree, its common directory, each outside the source root only when the caller names it exactly. Every file
// is read beneath a granted root by walking real folders (a symbolic link at any level is refused), opening the
// last name without following a link and without blocking (a FIFO cannot stall the open), requiring a regular
// file of bounded size from fstat, reading through that one descriptor, and then re-checking that every folder
// and the file still have the identity they had. A detected change fails the read. This detects replacement; it
// is not an operating-system guarantee against a concurrent process that changes the tree between checks.
// Pack descriptors are opened per read and closed before it returns, so nothing stays open after close().
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, constants as FS, type BigIntStats } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { constants as zconstants, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export type GitHashAlgorithm = 'sha1' | 'sha256';

export class GitReadError extends Error {
  /** `limit`: the object may be intact, but reading it would exceed a bound this reader keeps (never `corrupt`). */
  constructor(readonly code: 'unsupported' | 'corrupt' | 'notRepository' | 'unresolved' | 'limit', message: string) {
    super(message);
    this.name = 'GitReadError';
  }
}

export interface GitObject { readonly type: GitObjectType; readonly data: Buffer }

/** One entry of a recursively listed tree, in tree order. `name` is the raw name bytes. */
export interface GitTreeEntry {
  readonly mode: string;
  readonly name: Buffer;
  readonly oid: string;
}

const TYPE_BY_NUMBER: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
/** Commits, trees and tags are small; a larger one is refused before it is inflated. */
export const MAX_METADATA_OBJECT_BYTES = 64 * 1024 * 1024;
/** HEAD, a ref, commondir, a .git file and config: larger is refused, not ignored. */
const MAX_TEXT_FILE = 1024 * 1024;
const MAX_PACKED_REFS = 16 * 1024 * 1024;
const MAX_LOOSE_FILE = MAX_METADATA_OBJECT_BYTES * 2;
const MAX_REF_NAME = 1024;

/** The reader's resource ceilings. A caller may lower any of them; none can be raised above its default. */
export interface GitReadLimits {
  /** Pack index files read from objects/pack. */
  readonly maxPacks: number;
  /** One pack index file, in bytes. */
  readonly maxIndexBytes: number;
  /** Objects one pack index may list. */
  readonly maxIndexObjects: number;
  /** Objects all pack indexes together may list. */
  readonly maxPackObjects: number;
  /** Bytes the reader keeps for all loaded indexes (names and offsets). */
  readonly maxIndexCacheBytes: number;
  /** Steps of one delta chain, across offset and object-id bases together (git's own default depth is 50). */
  readonly maxDeltaDepth: number;
  /** Inflated delta bytes one chain may hold at once. */
  readonly maxDeltaChainBytes: number;
}

export const DEFAULT_GIT_READ_LIMITS: GitReadLimits = Object.freeze({
  maxPacks: 1024,
  maxIndexBytes: 64 * 1024 * 1024,
  maxIndexObjects: 2_000_000,
  maxPackObjects: 3_000_000,
  maxIndexCacheBytes: 128 * 1024 * 1024,
  maxDeltaDepth: 128,
  maxDeltaChainBytes: 64 * 1024 * 1024,
});

function resolveLimits(given: Partial<GitReadLimits> | undefined): GitReadLimits {
  const out: Record<string, number> = { ...DEFAULT_GIT_READ_LIMITS };
  for (const [key, value] of Object.entries(given ?? {})) {
    const ceiling = (DEFAULT_GIT_READ_LIMITS as unknown as Record<string, number>)[key];
    if (ceiling === undefined) throw new RangeError(`unknown Git read limit ${key}`);
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > ceiling) {
      throw new RangeError(`${key} must be an integer from 1 to ${ceiling}`);
    }
    out[key] = value as number;
  }
  return Object.freeze(out) as unknown as GitReadLimits;
}

/** The shared ceilings of one GitReadBudget. A caller may lower them; none can be raised above its default. */
export interface GitReadBudgetLimits {
  /** Bytes every repository sharing the budget may hold at once: retained pack-index data plus an index being read. */
  readonly maxRetainedBytes: number;
  /** Pack objects every repository sharing the budget may index at once. */
  readonly maxPackObjects: number;
}

export const DEFAULT_GIT_READ_BUDGET: GitReadBudgetLimits = Object.freeze({
  maxRetainedBytes: 128 * 1024 * 1024,
  maxPackObjects: 3_000_000,
});

/**
 * One memory budget shared by the Git readers of one capture: every repository opened with it (primary, submodule,
 * both working-copy enumerations) reserves against it before it allocates pack-index memory, and releases on close()
 * or when a load fails. Exceeding it is a bounded refusal (`unsupported`), never eviction. It is a plain object the
 * caller owns; it grants nothing and is not shared across stores or processes.
 */
export class GitReadBudget {
  readonly limits: GitReadBudgetLimits;
  #bytes = 0;
  #objects = 0;

  constructor(limits: Partial<GitReadBudgetLimits> = {}) {
    const out: Record<string, number> = { ...DEFAULT_GIT_READ_BUDGET };
    for (const [key, value] of Object.entries(limits)) {
      const ceiling = (DEFAULT_GIT_READ_BUDGET as unknown as Record<string, number>)[key];
      if (ceiling === undefined) throw new RangeError(`unknown Git read budget ${key}`);
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > ceiling) {
        throw new RangeError(`${key} must be an integer from 1 to ${ceiling}`);
      }
      out[key] = value as number;
    }
    this.limits = Object.freeze(out) as unknown as GitReadBudgetLimits;
  }

  /** Bytes and objects currently reserved by every repository using this budget. */
  get usedBytes(): number { return this.#bytes; }
  get usedObjects(): number { return this.#objects; }

  /**
   * Reserves `bytes` and `objects` before they are allocated, or throws `unsupported`. Returns an idempotent
   * release. Used by GitRepository; exposed so a caller can see and test its accounting.
   */
  reserve(bytes: number, objects: number, what: string): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(objects) || objects < 0) throw new RangeError('a reservation is a non-negative integer');
    if (this.#bytes + bytes > this.limits.maxRetainedBytes) {
      throw unsafe(`${what} needs ${bytes} bytes; the shared Git read budget has ${this.limits.maxRetainedBytes - this.#bytes} of ${this.limits.maxRetainedBytes} left`);
    }
    if (this.#objects + objects > this.limits.maxPackObjects) {
      throw unsafe(`${what} lists ${objects} objects; the shared Git read budget has ${this.limits.maxPackObjects - this.#objects} of ${this.limits.maxPackObjects} left`);
    }
    this.#bytes += bytes;
    this.#objects += objects;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#bytes -= bytes;
      this.#objects -= objects;
    };
  }
}

interface Pack {
  readonly segments: readonly string[]; // objects/pack/<name>.pack under the common directory
  readonly identity: string;            // dev:ino of the pack when its index was loaded
  readonly size: number;
  readonly names: Buffer;               // N × hash length, strictly ascending
  readonly offsets: Float64Array;       // index order
  readonly sorted: Float64Array;        // strictly ascending offsets, for span lengths
  readonly end: number;                 // pack size minus trailer
  readonly fanout: Uint32Array;
  readonly index: number;
}

interface ParsedIndex {
  readonly n: number;
  /** Bytes reserved for what is kept. */
  readonly bytes: number;
  readonly fanout: Uint32Array;
  readonly names: Buffer;
  readonly offsets: Float64Array;
  readonly sorted: Float64Array;
  readonly packChecksum: Buffer;
}

/** One delta resolution: every step (an offset base or an object-id base) counts against one budget. */
interface Chain { steps: number; bytes: number; readonly seen: Set<string> }

const NOFOLLOW = FS.O_NOFOLLOW ?? 0;
const NONBLOCK = FS.O_NONBLOCK ?? 0;
const unsafe = (message: string) => new GitReadError('unsupported', message);
const idOf = (st: BigIntStats) => `${st.dev}:${st.ino}`;
const errno = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

function lstatBig(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); } catch (e) {
    if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') return undefined;
    throw unsafe(`cannot inspect a path in the Git directory (${errno(e) ?? 'error'})`);
  }
}

function checkSegments(segments: readonly string[]): void {
  if (segments.length === 0) throw unsafe('an empty path in the Git directory');
  for (const s of segments) {
    if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) {
      throw unsafe('an unsafe path segment in the Git directory');
    }
  }
}

/** The real folders from `root` to the parent of the last segment, or undefined when one is absent. */
function walkFolders(root: string, segments: readonly string[]): string[] | undefined {
  const ids: string[] = [];
  const rootSt = lstatBig(root);
  if (!rootSt || rootSt.isSymbolicLink() || !rootSt.isDirectory()) throw unsafe('a granted Git root is not a real folder');
  ids.push(idOf(rootSt));
  for (let i = 0; i < segments.length - 1; i++) {
    const st = lstatBig(join(root, ...segments.slice(0, i + 1)));
    if (!st) return undefined;
    if (st.isSymbolicLink()) throw unsafe('a symbolic link inside the Git directory is not followed');
    if (!st.isDirectory()) return undefined;
    ids.push(idOf(st));
  }
  return ids;
}

function sameFolders(root: string, segments: readonly string[], ids: readonly string[]): boolean {
  const now: (string | undefined)[] = [lstatBig(root)].map(st => (st && !st.isSymbolicLink() ? idOf(st) : undefined));
  for (let i = 0; i < segments.length - 1; i++) {
    const st = lstatBig(join(root, ...segments.slice(0, i + 1)));
    now.push(st && !st.isSymbolicLink() ? idOf(st) : undefined);
  }
  return now.length === ids.length && now.every((id, i) => id === ids[i]);
}

/**
 * Opens `root/segments` as a regular file without following a link or blocking, runs `body` with the descriptor
 * and its fstat, then verifies that the folders and the file were not replaced. Undefined when absent.
 */
function withFile<T>(root: string, segments: readonly string[], body: (fd: number, st: BigIntStats) => T): T | undefined {
  checkSegments(segments);
  const ids = walkFolders(root, segments);
  if (!ids) return undefined;
  const path = join(root, ...segments);
  let fd: number;
  try { fd = openSync(path, FS.O_RDONLY | NOFOLLOW | NONBLOCK); } catch (e) {
    if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') return undefined;
    if (errno(e) === 'ELOOP' || errno(e) === 'EMLINK') throw unsafe('a symbolic link inside the Git directory is not followed');
    throw unsafe(`cannot open a file in the Git directory (${errno(e) ?? 'error'})`);
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw unsafe('a Git file is not a regular file');
    const result = body(fd, st);
    const after = lstatBig(path);
    if (!after || after.isSymbolicLink() || idOf(after) !== idOf(st) || !sameFolders(root, segments, ids)) {
      throw unsafe('a Git file or folder changed while it was read');
    }
    return result;
  } finally { closeSync(fd); }
}

/** Reads exactly `length` bytes at `position`, or fails. */
function readExactly(fd: number, length: number, position: number, what: string): Buffer {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const n = readSync(fd, buf, off, length - off, position + off);
    if (n === 0) throw new GitReadError('corrupt', `${what} is truncated`);
    off += n;
  }
  return buf;
}

/** A whole file under a granted root, refused (with `code`) when larger than `maxBytes`. Undefined when absent. */
function readUnder(root: string, segments: readonly string[], maxBytes: number, code: 'corrupt' | 'unsupported'): Buffer | undefined {
  return withFile(root, segments, (fd, st) => {
    if (st.size > BigInt(maxBytes)) throw new GitReadError(code, `${segments.join('/')} is larger than ${maxBytes} bytes`);
    const size = Number(st.size);
    const buf = readExactly(fd, size, 0, segments.join('/'));
    if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) throw unsafe(`${segments.join('/')} grew while it was read`);
    return buf;
  });
}

const readText = (root: string, segments: readonly string[], maxBytes = MAX_TEXT_FILE) =>
  readUnder(root, segments, maxBytes, 'unsupported')?.toString('utf8');

/** A folder's names under a granted root, every level a real folder. Undefined when absent. */
function listUnder(root: string, segments: readonly string[]): string[] | undefined {
  checkSegments(segments);
  const ids = walkFolders(root, [...segments, '.']);
  if (!ids) return undefined;
  const st = lstatBig(join(root, ...segments));
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw unsafe('a Git folder is not a real folder');
  let names: string[];
  try { names = readdirSync(join(root, ...segments)); } catch (e) { throw unsafe(`cannot list a Git folder (${errno(e) ?? 'error'})`); }
  if (!sameFolders(root, [...segments, '.'], ids)) throw unsafe('a Git folder changed while it was listed');
  return names;
}

/** A full ref name git itself would accept, restricted to safe characters: no `.`/`..` segment, no `.lock`. */
export function isSafeRefName(name: string): boolean {
  if (name.length > MAX_REF_NAME || !name.startsWith('refs/') || name.includes('..') || name.endsWith('/')) return false;
  return name.split('/').every(seg => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(seg) && !seg.endsWith('.') && !seg.endsWith('.lock'));
}

function canonicalDir(path: string, what: string): string {
  let real: string;
  try { real = realpathSync.native(path); } catch { throw new GitReadError('notRepository', `${what} does not exist`); }
  const st = lstatBig(real);
  if (!st || !st.isDirectory()) throw new GitReadError('notRepository', `${what} is not a folder`);
  return real;
}

/** The handful of config keys this reader needs, from the repository's own config file only. */
function configValue(text: string, section: string, key: string): string | undefined {
  let current = '';
  let found: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (head) { current = head[1]!.toLowerCase(); continue; }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (kv && current === section && kv[1]!.toLowerCase() === key) found = (kv[2] ?? 'true').trim().replace(/^"(.*)"$/, '$1');
  }
  return found;
}

export interface GitOpenOptions {
  /** The canonical Git directory, required when it lies outside the source root (a linked worktree). */
  readonly gitDir?: string;
  /**
   * The canonical common directory a linked worktree's `commondir` file names. Required whenever that directory
   * is not the Git directory itself: the reader never grants itself a second root from a file in the first.
   */
  readonly commonDir?: string;
  /** Lower any resource ceiling for this repository (DEFAULT_GIT_READ_LIMITS are the maxima). */
  readonly limits?: Partial<GitReadLimits>;
  /**
   * The memory budget to reserve pack-index memory from. Pass one budget to every repository a capture opens so
   * their total stays within it; without one, this repository gets a private budget with the default ceilings.
   */
  readonly budget?: GitReadBudget;
}

export class GitRepository {
  readonly gitDir: string;
  readonly commonDir: string;
  readonly algorithm: GitHashAlgorithm;
  readonly hexLength: number;
  readonly limits: GitReadLimits;
  readonly budget: GitReadBudget;
  #packs: Pack[] = [];
  #packsLoaded = false;
  /** Releases for the budget this repository's loaded indexes hold. */
  #held: Array<() => void> = [];

  private constructor(gitDir: string, commonDir: string, algorithm: GitHashAlgorithm, limits: GitReadLimits, budget: GitReadBudget) {
    this.gitDir = gitDir;
    this.commonDir = commonDir;
    this.algorithm = algorithm;
    this.hexLength = algorithm === 'sha1' ? 40 : 64;
    this.limits = limits;
    this.budget = budget;
  }

  /**
   * Opens the repository whose working tree is `root`. The Git directory is `root/.git`, or the path a `.git` file
   * names; a Git directory outside `root` is used only when `gitDir` names it exactly, and a common directory other
   * than the Git directory only when `commonDir` names it exactly (a linked worktree).
   */
  static open(root: string, options: GitOpenOptions = {}): GitRepository {
    const limits = resolveLimits(options.limits);
    if (options.budget !== undefined && !(options.budget instanceof GitReadBudget)) throw new TypeError('budget must be a GitReadBudget');
    const rootReal = canonicalDir(root, 'the source root');
    const dotGit = lstatBig(join(rootReal, '.git'));
    if (!dotGit) throw new GitReadError('notRepository', 'no .git at the source root');
    let gitDir: string;
    if (dotGit.isDirectory()) gitDir = join(rootReal, '.git');
    else if (dotGit.isFile()) {
      const text = readText(rootReal, ['.git']) ?? '';
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!m) throw new GitReadError('notRepository', 'the .git file does not name a Git directory');
      gitDir = canonicalDir(resolve(rootReal, m[1]!), 'the Git directory');
    } else throw new GitReadError('notRepository', '.git is neither a directory nor a gitdir file');
    const inside = gitDir.startsWith(rootReal + sep);
    if (!inside && (options.gitDir === undefined || canonicalDir(options.gitDir, 'the permitted Git directory') !== gitDir)) {
      throw unsafe('the Git directory is outside the source root and was not explicitly permitted');
    }
    let commonDir = gitDir;
    const common = readText(gitDir, ['commondir']);
    if (common !== undefined) {
      const named = common.trim();
      if (!named) throw new GitReadError('corrupt', 'the commondir file is empty');
      commonDir = canonicalDir(isAbsolute(named) ? named : resolve(gitDir, named), 'the common Git directory');
    }
    const permitted = options.commonDir === undefined ? undefined : canonicalDir(options.commonDir, 'the permitted common directory');
    if (commonDir !== gitDir && permitted !== commonDir) {
      throw unsafe('the common Git directory is not the Git directory and was not explicitly permitted');
    }
    if (permitted !== undefined && permitted !== commonDir) throw unsafe('the permitted common directory is not the one the repository names');
    const config = readText(commonDir, ['config']) ?? '';
    const format = (configValue(config, 'extensions', 'objectformat') ?? 'sha1').toLowerCase();
    if (format !== 'sha1' && format !== 'sha256') throw new GitReadError('unsupported', `object format ${format} is not supported`);
    const refStorage = configValue(config, 'extensions', 'refstorage');
    if (refStorage && refStorage.toLowerCase() !== 'files') throw new GitReadError('unsupported', `ref storage ${refStorage} is not supported`);
    return new GitRepository(gitDir, commonDir, format, limits, options.budget ?? new GitReadBudget());
  }

  #isOid(text: string): boolean {
    return text.length === this.hexLength && /^[0-9a-f]+$/.test(text);
  }

  /** `HEAD`, a full ref name (`refs/heads/main`) or a full object id, resolved to a commit id. */
  resolveCommit(revision = 'HEAD'): string {
    let oid: string;
    if (this.#isOid(revision)) oid = revision;
    else if (revision === 'HEAD' || isSafeRefName(revision)) oid = this.#resolveRef(revision, 0);
    else throw new GitReadError('unsupported', 'a revision is HEAD, a safe full ref name or a full object id');
    // Peel annotated tags to the commit they name.
    for (let i = 0; i < 16; i++) {
      const obj = this.readObject(oid, MAX_METADATA_OBJECT_BYTES);
      if (!obj) throw new GitReadError('unresolved', `the revision's object ${oid} is not present`);
      if (obj.type === 'commit') return oid;
      if (obj.type !== 'tag') throw new GitReadError('unresolved', `the revision names a ${obj.type}, not a commit`);
      const m = /^object ([0-9a-f]+)$/m.exec(obj.data.toString('latin1'));
      if (!m || !this.#isOid(m[1]!)) throw new GitReadError('corrupt', 'a tag object has no target');
      oid = m[1]!;
    }
    throw new GitReadError('unresolved', 'tag chain too long');
  }

  #resolveRef(name: string, depth: number): string {
    if (depth > 8) throw new GitReadError('unresolved', 'symbolic ref chain too long');
    if (name !== 'HEAD' && !isSafeRefName(name)) throw new GitReadError('unsupported', 'an unsafe ref name');
    // HEAD and worktree-private refs live in the worktree's own gitdir; shared refs in the common dir.
    const segments = name.split('/');
    const roots = name === 'HEAD' || this.commonDir === this.gitDir ? [this.gitDir] : [this.gitDir, this.commonDir];
    for (const root of roots) {
      const text = readText(root, segments);
      if (text === undefined) continue;
      const line = text.trim();
      const sym = /^ref:\s*(\S+)$/.exec(line);
      if (sym) {
        if (!isSafeRefName(sym[1]!)) throw new GitReadError('unsupported', `ref ${name} names an unsafe ref`);
        return this.#resolveRef(sym[1]!, depth + 1);
      }
      if (this.#isOid(line)) return line;
      throw new GitReadError('corrupt', `ref ${name} is not an object id`);
    }
    if (name !== 'HEAD') {
      const packed = readText(this.commonDir, ['packed-refs'], MAX_PACKED_REFS);
      if (packed !== undefined) {
        for (const line of packed.split('\n')) {
          const m = /^([0-9a-f]+) (refs\/\S+)$/.exec(line.trim());
          if (m && m[2] === name && this.#isOid(m[1]!)) return m[1]!;
        }
      }
    }
    throw new GitReadError('unresolved', `ref ${name} does not exist`);
  }

  /** The tree id of a commit. */
  treeOf(commit: string): string {
    const obj = this.readObject(commit, MAX_METADATA_OBJECT_BYTES);
    if (!obj || obj.type !== 'commit') throw new GitReadError('unresolved', `commit ${commit} is not present`);
    const m = /^tree ([0-9a-f]+)$/m.exec(obj.data.toString('latin1'));
    if (!m || !this.#isOid(m[1]!)) throw new GitReadError('corrupt', 'a commit has no tree');
    return m[1]!;
  }

  /** The entries of one tree object, or undefined when the tree object is not present. */
  readTree(oid: string): GitTreeEntry[] | undefined {
    const obj = this.readObject(oid, MAX_METADATA_OBJECT_BYTES);
    if (!obj) return undefined;
    if (obj.type !== 'tree') throw new GitReadError('corrupt', `${oid} is a ${obj.type}, not a tree`);
    const out: GitTreeEntry[] = [];
    const data = obj.data;
    const raw = this.hexLength / 2;
    let i = 0;
    while (i < data.length) {
      const space = data.indexOf(0x20, i);
      const nul = data.indexOf(0x00, space + 1);
      if (space < 0 || nul < 0 || nul + 1 + raw > data.length) throw new GitReadError('corrupt', `tree ${oid} is malformed`);
      out.push({ mode: data.toString('latin1', i, space), name: Buffer.from(data.subarray(space + 1, nul)), oid: data.toString('hex', nul + 1, nul + 1 + raw) });
      i = nul + 1 + raw;
    }
    return out;
  }

  /** The declared size and type of an object without inflating its body, or undefined when it is not present. */
  objectHeader(oid: string): { type: GitObjectType; size: number } | undefined {
    if (!this.#isOid(oid)) throw new GitReadError('corrupt', 'not an object id');
    return this.#headerByOid(oid, this.#chain(), false);
  }

  /**
   * The verified object, or undefined when it is not present. Refused (corrupt) when its declared size exceeds
   * `maxBytes`, it does not inflate, or its bytes do not hash to its id.
   */
  readObject(oid: string, maxBytes: number): GitObject | undefined {
    if (!this.#isOid(oid)) throw new GitReadError('corrupt', 'not an object id');
    let obj = this.#readLoose(oid, maxBytes);
    if (!obj) {
      const located = this.#locate(oid);
      if (!located) return undefined;
      obj = this.#readPacked(located.pack, located.offset, maxBytes, this.#chain());
    }
    if (this.hashObject(obj.type, obj.data) !== oid) throw new GitReadError('corrupt', `object ${oid} does not hash to its id`);
    return obj;
  }

  /** Git's object id of `data` as an object of `type`. */
  hashObject(type: GitObjectType, data: Uint8Array): string {
    return createHash(this.algorithm).update(`${type} ${data.byteLength}\0`).update(data).digest('hex');
  }

  /**
   * Releases the loaded pack indexes and their share of the budget. No descriptor outlives a read, so a read after
   * close() (a capture's later re-read) still works: it reloads the indexes and reserves the budget again.
   */
  close(): void {
    for (const release of this.#held.splice(0)) release();
    this.#packs = [];
    this.#packsLoaded = false;
  }

  #chain(): Chain { return { steps: 0, bytes: 0, seen: new Set() }; }

  #step(chain: Chain, key: string): void {
    if (chain.seen.has(key)) throw new GitReadError('corrupt', 'a delta chain refers back to itself');
    chain.seen.add(key);
    if (++chain.steps > this.limits.maxDeltaDepth) throw new GitReadError('corrupt', 'delta chain too deep');
  }

  #looseFile(oid: string): Buffer | undefined {
    return readUnder(this.commonDir, ['objects', oid.slice(0, 2), oid.slice(2)], MAX_LOOSE_FILE, 'corrupt');
  }

  #readLoose(oid: string, maxBytes: number): GitObject | undefined {
    const loose = this.#looseFile(oid);
    if (!loose) return undefined;
    let raw: Buffer;
    try { raw = inflateSync(loose, { maxOutputLength: maxBytes + 64 }); } catch (e) {
      if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new GitReadError('corrupt', `object ${oid} exceeds the size limit`);
      throw new GitReadError('corrupt', `loose object ${oid} does not inflate`);
    }
    const header = looseHeader(raw);
    if (!header || header.size !== raw.length - header.end) throw new GitReadError('corrupt', `loose object ${oid} has a bad header`);
    if (header.size > maxBytes) throw new GitReadError('corrupt', `object ${oid} exceeds the size limit`);
    return { type: header.type, data: raw.subarray(header.end) };
  }

  #headerByOid(oid: string, chain: Chain, asBase: boolean): { type: GitObjectType; size: number } | undefined {
    if (asBase) this.#step(chain, `oid:${oid}`);
    const bytes = this.#looseFile(oid);
    if (bytes) {
      // Inflate only as much of the stream as the header needs: the header ends at the first NUL.
      const head = inflateHeader(bytes, out => out.indexOf(0) >= 0 || out.length > MAX_LOOSE_HEADER, `loose object ${oid}`);
      const header = looseHeader(head);
      if (!header) throw new GitReadError('corrupt', `loose object ${oid} has no header`);
      return { type: header.type, size: header.size };
    }
    const located = this.#locate(oid);
    if (!located) return undefined;
    return this.#packedHeader(located.pack, located.offset, chain);
  }

  /**
   * Loads every pack index, all or nothing: a failure releases what this load reserved and leaves the repository
   * unloaded, so the next read retries from the start instead of using a partial set.
   */
  #loadPacks(): void {
    if (this.#packsLoaded) return;
    const listed = listUnder(this.commonDir, ['objects', 'pack']);
    if (!listed) { this.#packsLoaded = true; return; }
    const names = listed.filter(n => /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.idx$/.test(n)).sort();
    if (names.length > this.limits.maxPacks) throw unsafe(`${names.length} pack indexes exceed the limit of ${this.limits.maxPacks}`);
    const raw = this.hexLength / 2;
    const loaded: Pack[] = [];
    const holds: Array<() => void> = [];
    let objects = 0;
    let cache = 0;
    try {
      for (const idxName of names) {
        const packName = idxName.replace(/\.idx$/, '.pack');
        // The index file is a temporary allocation: reserved before it is read, released once it is parsed.
        let releaseTemp: (() => void) | undefined;
        let parsed: ParsedIndex | undefined;
        try {
          const idx = withFile(this.commonDir, ['objects', 'pack', idxName], (fd, st) => {
            if (st.size > BigInt(this.limits.maxIndexBytes)) throw unsafe(`pack index ${idxName} is larger than ${this.limits.maxIndexBytes} bytes`);
            const size = Number(st.size);
            releaseTemp = this.budget.reserve(size, 0, `reading pack index ${idxName}`);
            const buf = readExactly(fd, size, 0, `pack index ${idxName}`);
            if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) throw unsafe(`pack index ${idxName} grew while it was read`);
            return buf;
          });
          if (!idx) continue;
          parsed = this.#parseIndex(idx, idxName, (n, bytes) => {
            // Checked before the parsed arrays are allocated: per repository, then against the shared budget.
            if (objects + n > this.limits.maxPackObjects) throw unsafe(`pack indexes list more than ${this.limits.maxPackObjects} objects`);
            if (cache + bytes > this.limits.maxIndexCacheBytes) throw unsafe(`pack indexes need more than ${this.limits.maxIndexCacheBytes} bytes of memory`);
            holds.push(this.budget.reserve(bytes, n, `pack index ${idxName}`));
            objects += n;
            cache += bytes;
          });
        } finally { releaseTemp?.(); }
        // The pack must exist, start with its header naming the same object count, and end with the checksum the
        // index records. An index without its pack holds nothing readable.
        const pack = withFile(this.commonDir, ['objects', 'pack', packName], (fd, st) => {
          const size = Number(st.size);
          if (size < 12 + raw) throw new GitReadError('corrupt', `pack ${packName} is truncated`);
          const head = readExactly(fd, 12, 0, `pack ${packName}`);
          const version = head.readUInt32BE(4);
          if (head.toString('latin1', 0, 4) !== 'PACK' || (version !== 2 && version !== 3)) throw new GitReadError('unsupported', `pack ${packName} is not version 2 or 3`);
          if (head.readUInt32BE(8) !== parsed!.n) throw new GitReadError('corrupt', `pack ${packName} and its index disagree on the object count`);
          if (!readExactly(fd, raw, size - raw, `pack ${packName}`).equals(parsed!.packChecksum)) {
            throw new GitReadError('corrupt', `pack ${packName} does not match its index`);
          }
          return { identity: idOf(st), size };
        });
        if (!pack) { holds.pop()?.(); objects -= parsed.n; cache -= parsed.bytes; continue; }
        const end = pack.size - raw;
        if (parsed.n > 0 && (parsed.sorted[0]! < 12 || parsed.sorted[parsed.n - 1]! >= end)) {
          throw new GitReadError('corrupt', `pack index ${idxName} has an offset outside its pack`);
        }
        loaded.push({ segments: ['objects', 'pack', packName], identity: pack.identity, size: pack.size, names: parsed.names,
          offsets: parsed.offsets, sorted: parsed.sorted, end, fanout: parsed.fanout, index: loaded.length });
      }
    } catch (error) {
      for (const release of holds) release();
      throw error;
    }
    this.#packs = loaded;
    this.#held.push(...holds);
    this.#packsLoaded = true;
  }

  /** Validates a version-2 pack index completely before anything from it is used. */
  #parseIndex(idx: Buffer, idxName: string, admit: (objects: number, bytes: number) => void): ParsedIndex {
    const raw = this.hexLength / 2;
    const bad = (why: string) => new GitReadError('corrupt', `pack index ${idxName} ${why}`);
    if (idx.length < 8 + 1024 + 2 * raw || idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) {
      throw new GitReadError('unsupported', `pack index ${idxName} is not version 2`);
    }
    const body = idx.subarray(0, idx.length - raw);
    if (!createHash(this.algorithm).update(body).digest().equals(idx.subarray(idx.length - raw))) throw bad('fails its checksum');
    const fanout = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      fanout[i] = idx.readUInt32BE(8 + i * 4);
      if (i > 0 && fanout[i]! < fanout[i - 1]!) throw bad('has a decreasing fan-out table');
    }
    const n = fanout[255]!;
    if (n > this.limits.maxIndexObjects) throw unsafe(`pack index ${idxName} lists more than ${this.limits.maxIndexObjects} objects`);
    const namesStart = 8 + 1024;
    const crcStart = namesStart + n * raw;
    const offStart = crcStart + n * 4;
    const largeStart = offStart + n * 4;
    if (idx.length < largeStart + 2 * raw) throw bad('is truncated');
    let large = 0;
    for (let i = 0; i < n; i++) if (idx.readUInt32BE(offStart + i * 4) & 0x80000000) large++;
    if (idx.length !== largeStart + large * 8 + 2 * raw) throw bad('has the wrong length for its object count');
    // Everything parsed is kept: names, two offset tables, the fan-out and the pack checksum. Admit it first.
    const bytes = n * (raw + 16) + 1024 + raw;
    admit(n, bytes);
    // Names strictly ascending, each inside the fan-out bucket of its first byte.
    let bucket = 0;
    for (let i = 0; i < n; i++) {
      const at = namesStart + i * raw;
      const first = idx[at]!;
      while (bucket < first) bucket++;
      if (i < (first === 0 ? 0 : fanout[first - 1]!) || i >= fanout[first]!) throw bad('has a name outside its fan-out bucket');
      if (i > 0 && Buffer.compare(idx.subarray(at - raw, at), idx.subarray(at, at + raw)) >= 0) throw bad('has unsorted or repeated names');
    }
    const offsets = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = idx.readUInt32BE(offStart + i * 4);
      if (v & 0x80000000) {
        const k = v & 0x7fffffff;
        if (k >= large) throw bad('has a bad large offset');
        const big = idx.readBigUInt64BE(largeStart + k * 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw bad('has an offset beyond the safe range');
        offsets[i] = Number(big);
      } else offsets[i] = v;
    }
    const sorted = Float64Array.from(offsets).sort();
    for (let i = 1; i < n; i++) if (sorted[i]! <= sorted[i - 1]!) throw bad('lists one pack offset twice');
    return { n, bytes, fanout, names: Buffer.from(idx.subarray(namesStart, crcStart)), offsets, sorted,
      packChecksum: Buffer.from(idx.subarray(idx.length - 2 * raw, idx.length - raw)) };
  }

  #locate(oid: string): { pack: Pack; offset: number } | undefined {
    this.#loadPacks();
    const raw = this.hexLength / 2;
    const key = Buffer.from(oid, 'hex');
    for (const pack of this.#packs) {
      let lo = key[0] === 0 ? 0 : pack.fanout[key[0]! - 1]!;
      let hi = pack.fanout[key[0]!]!;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const c = Buffer.compare(pack.names.subarray(mid * raw, mid * raw + raw), key);
        if (c === 0) return { pack, offset: pack.offsets[mid]! };
        if (c < 0) lo = mid + 1; else hi = mid;
      }
    }
    return undefined;
  }

  /** One object's bytes, through a descriptor opened for this read only and checked to be the indexed pack. */
  #span(pack: Pack, offset: number): Buffer {
    // The object's bytes run to the next object's offset (or the trailer).
    let lo = 0, hi = pack.sorted.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (pack.sorted[mid]! <= offset) lo = mid + 1; else hi = mid; }
    const next = lo < pack.sorted.length ? pack.sorted[lo]! : pack.end;
    if (offset < 12 || next <= offset || next > pack.end) throw new GitReadError('corrupt', 'pack offsets are inconsistent');
    const length = next - offset;
    if (length > MAX_LOOSE_FILE + 64) throw new GitReadError('corrupt', 'packed object is too large');
    const buf = withFile(this.commonDir, pack.segments, (fd, st) => {
      if (idOf(st) !== pack.identity || Number(st.size) !== pack.size) throw unsafe('a pack file changed after its index was read');
      return readExactly(fd, length, offset, 'a pack file');
    });
    if (!buf) throw new GitReadError('corrupt', 'a pack file disappeared after its index was read');
    return buf;
  }

  #parseEntryHeader(buf: Buffer): { type: number; size: number; at: number } {
    let i = 0;
    let byte = buf[i++]!;
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      if (i >= buf.length || shift > 49) throw new GitReadError('corrupt', 'pack entry header is malformed');
      byte = buf[i++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return { type, size, at: i };
  }

  #packedHeader(pack: Pack, offset: number, chain: Chain): { type: GitObjectType; size: number } {
    this.#step(chain, `pack:${pack.index}:${offset}`);
    const buf = this.#span(pack, offset);
    const h = this.#parseEntryHeader(buf);
    if (TYPE_BY_NUMBER[h.type]) return { type: TYPE_BY_NUMBER[h.type]!, size: h.size };
    // A delta's result size is the second varint of its inflated delta data; its type is the base's.
    const base = this.#deltaBase(pack, offset, buf, h);
    // The delta data opens with two varints (base size, result size): inflate only until both are complete.
    const inflated = inflateHeader(buf.subarray(base.dataAt), out => varintsComplete(out, 2), 'a delta');
    const reader = { i: 0 };
    varint(inflated, reader);
    const size = varint(inflated, reader);
    const baseType = base.pack ? this.#packedHeader(base.pack, base.offset!, chain).type : this.#headerByOid(base.oid!, chain, true)?.type;
    if (!baseType) throw new GitReadError('corrupt', 'delta base is missing');
    return { type: baseType, size };
  }

  #deltaBase(pack: Pack, offset: number, buf: Buffer, h: { type: number; at: number }):
    { pack?: Pack; offset?: number; oid?: string; dataAt: number } {
    if (h.type === 6) {
      let i = h.at;
      if (i >= buf.length) throw new GitReadError('corrupt', 'ofs-delta offset is malformed');
      let byte = buf[i++]!;
      let rel = byte & 0x7f;
      while (byte & 0x80) {
        if (i >= buf.length || rel > 2 ** 45) throw new GitReadError('corrupt', 'ofs-delta offset is malformed');
        byte = buf[i++]!;
        rel = (rel + 1) * 128 + (byte & 0x7f);
      }
      const baseOffset = offset - rel;
      if (baseOffset < 12 || baseOffset >= offset) throw new GitReadError('corrupt', 'ofs-delta base is outside the pack');
      return { pack, offset: baseOffset, dataAt: i };
    }
    if (h.type === 7) {
      const raw = this.hexLength / 2;
      if (h.at + raw > buf.length) throw new GitReadError('corrupt', 'ref-delta is truncated');
      return { oid: buf.toString('hex', h.at, h.at + raw), dataAt: h.at + raw };
    }
    throw new GitReadError('corrupt', `pack entry type ${h.type} is not supported`);
  }

  #readPacked(pack: Pack, offset: number, maxBytes: number, chain: Chain): GitObject {
    this.#step(chain, `pack:${pack.index}:${offset}`);
    const entry = this.#inflateEntry(pack, offset, maxBytes, chain);
    if ('data' in entry) return entry;
    const baseObj = entry.base.pack
      ? this.#readPacked(entry.base.pack, entry.base.offset!, maxBytes, chain)
      : this.#readBaseByOid(entry.base.oid!, maxBytes, chain);
    chain.bytes -= entry.delta.length;
    return { type: baseObj.type, data: applyDelta(baseObj.data, entry.delta, maxBytes) };
  }

  /** Inflates one entry; a delta's compressed span is released before its base is read. */
  #inflateEntry(pack: Pack, offset: number, maxBytes: number, chain: Chain):
    GitObject | { delta: Buffer; base: { pack?: Pack; offset?: number; oid?: string } } {
    const buf = this.#span(pack, offset);
    const h = this.#parseEntryHeader(buf);
    const direct = TYPE_BY_NUMBER[h.type];
    if (direct) {
      if (h.size > maxBytes) throw new GitReadError('corrupt', 'object exceeds the size limit');
      let data: Buffer;
      try { data = inflateSync(buf.subarray(h.at), { maxOutputLength: Math.max(h.size, 1) }); } catch {
        throw new GitReadError('corrupt', 'packed object does not inflate within its declared size');
      }
      if (data.length !== h.size) throw new GitReadError('corrupt', 'packed object size differs from its header');
      return { type: direct, data };
    }
    const base = this.#deltaBase(pack, offset, buf, h);
    if (h.size > maxBytes + 1024 * 1024) throw new GitReadError('corrupt', 'delta exceeds the size limit');
    if (chain.bytes + h.size > this.limits.maxDeltaChainBytes) throw new GitReadError('corrupt', 'delta chain exceeds its memory budget');
    let delta: Buffer;
    try { delta = inflateSync(buf.subarray(base.dataAt), { maxOutputLength: Math.max(h.size, 1) }); } catch {
      throw new GitReadError('corrupt', 'delta does not inflate within its declared size');
    }
    chain.bytes += delta.length;
    return { delta, base: { pack: base.pack, offset: base.offset, oid: base.oid } };
  }

  #readBaseByOid(oid: string, maxBytes: number, chain: Chain): GitObject {
    this.#step(chain, `oid:${oid}`);
    const loose = this.#readLoose(oid, maxBytes);
    if (loose) {
      if (this.hashObject(loose.type, loose.data) !== oid) throw new GitReadError('corrupt', `delta base ${oid} does not hash to its id`);
      return loose;
    }
    const located = this.#locate(oid);
    if (!located) throw new GitReadError('corrupt', `delta base ${oid} is missing`);
    return this.#readPacked(located.pack, located.offset, maxBytes, chain);
  }
}

/** A loose object's header (`<type> <size>\0`) is at most this long; longer output without a NUL is corrupt. */
const MAX_LOOSE_HEADER = 32;

/**
 * `<type> <size>\0` at the start of a decoded loose object: a known type and a decimal size with no leading zero that
 * is a safe integer, within {@link MAX_LOOSE_HEADER} bytes. `end` is the offset just past the NUL.
 */
function looseHeader(buf: Buffer): { type: GitObjectType; size: number; end: number } | undefined {
  const nul = buf.subarray(0, MAX_LOOSE_HEADER + 1).indexOf(0);
  if (nul < 0) return undefined;
  const m = /^(commit|tree|blob|tag) (0|[1-9]\d{0,15})$/.exec(buf.toString('latin1', 0, nul));
  if (!m) return undefined;
  const size = Number(m[2]);
  return Number.isSafeInteger(size) ? { type: m[1] as GitObjectType, size, end: nul + 1 } : undefined;
}
/**
 * The most compressed bytes read to find one header. A legal zlib stream may open with any number of empty DEFLATE
 * blocks (5 bytes each) before its first output byte, so no fixed prefix is enough; this budget bounds the search, and
 * a header not found within it is a `limit`, never `corrupt`.
 */
export const HEADER_COMPRESSED_BUDGET = 1024 * 1024;
/** The most output any one header probe may decode. A header is at most a few dozen bytes. */
const HEADER_OUTPUT_CAP = 64 * 1024;

type Probe = { kind: 'out'; out: Buffer } | { kind: 'big' } | { kind: 'invalid' };

function probe(compressed: Buffer, length: number): Probe {
  try {
    return { kind: 'out', out: inflateSync(compressed.subarray(0, length), { finishFlush: zconstants.Z_SYNC_FLUSH, maxOutputLength: HEADER_OUTPUT_CAP }) };
  } catch (e) {
    return (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? { kind: 'big' } : { kind: 'invalid' };
  }
}

/**
 * The decoded start of a zlib stream, from the shortest compressed prefix whose output satisfies `complete`. Each probe
 * decodes a prefix with a sync flush (a stream cut short is not an error) and at most 64 KiB of output; the shortest
 * sufficient prefix is found by doubling and then bisecting, within {@link HEADER_COMPRESSED_BUDGET}. Bisection is sound
 * because a prefix's output only grows with its length, and data that does not decode stays undecodable in every
 * longer prefix. Outcomes:
 * - the header completes before any undecodable byte: its output, which is small because the prefix is minimal;
 * - the stream stops decoding first: `corrupt`;
 * - the whole stream decodes without completing the header: its output, which the caller refuses as corrupt;
 * - the budget is spent first: `limit`, since the object may be intact.
 */
export function inflateHeader(compressed: Buffer, complete: (out: Buffer) => boolean, what: string): Buffer {
  const limit = Math.min(compressed.length, HEADER_COMPRESSED_BUDGET);
  const settled = (p: Probe) => p.kind !== 'out' || complete(p.out);
  // Find a settled prefix by doubling (the common case settles at 64 bytes), then the shortest one by bisection.
  let lo = 0;
  let hi = Math.min(64, limit);
  let at = probe(compressed, hi);
  while (!settled(at) && hi < limit) { lo = hi; hi = Math.min(hi * 2, limit); at = probe(compressed, hi); }
  if (!settled(at)) {
    if (limit < compressed.length) throw new GitReadError('limit', `${what}: no header within the first ${limit} compressed bytes`);
    return (at as { out: Buffer }).out;
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const p = probe(compressed, mid);
    if (settled(p)) { hi = mid; at = p; } else lo = mid;
  }
  if (at.kind === 'invalid') throw new GitReadError('corrupt', `${what} does not inflate`);
  if (at.kind === 'big') throw new GitReadError('limit', `${what}: the header's prefix decodes past ${HEADER_OUTPUT_CAP} bytes`);
  return at.out;
}

/** Whether `buf` begins with `count` complete varints (7 bits per byte, high bit continues; at most 10 bytes each). */
function varintsComplete(buf: Buffer, count: number): boolean {
  let i = 0;
  for (let n = 0; n < count; n++) {
    let len = 0;
    for (;;) {
      if (i >= buf.length) return false;
      if (++len > 10) return true; // malformed: the reader refuses it
      if ((buf[i++]! & 0x80) === 0) break;
    }
  }
  return true;
}

function varint(buf: Buffer, r: { i: number }): number {
  let result = 0, shift = 0, byte: number;
  do {
    if (r.i >= buf.length || shift > 49) throw new GitReadError('corrupt', 'delta varint is malformed');
    byte = buf[r.i++]!;
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}

function applyDelta(base: Buffer, delta: Buffer, maxBytes: number): Buffer {
  const r = { i: 0 };
  const baseSize = varint(delta, r);
  const resultSize = varint(delta, r);
  if (baseSize !== base.length) throw new GitReadError('corrupt', 'delta base size mismatch');
  if (resultSize > maxBytes) throw new GitReadError('corrupt', 'object exceeds the size limit');
  const out = Buffer.alloc(resultSize);
  let o = 0;
  while (r.i < delta.length) {
    const op = delta[r.i++]!;
    if (op & 0x80) {
      let off = 0, len = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) { if (r.i >= delta.length) throw new GitReadError('corrupt', 'delta copy truncated'); off += delta[r.i++]! * 2 ** (8 * b); }
      for (let b = 0; b < 3; b++) if (op & (1 << (4 + b))) { if (r.i >= delta.length) throw new GitReadError('corrupt', 'delta copy truncated'); len += delta[r.i++]! * 2 ** (8 * b); }
      if (len === 0) len = 0x10000;
      if (off + len > base.length || o + len > resultSize) throw new GitReadError('corrupt', 'delta copy out of range');
      base.copy(out, o, off, off + len);
      o += len;
    } else if (op > 0) {
      if (r.i + op > delta.length || o + op > resultSize) throw new GitReadError('corrupt', 'delta insert out of range');
      delta.copy(out, o, r.i, r.i + op);
      r.i += op;
      o += op;
    } else throw new GitReadError('corrupt', 'delta opcode 0 is reserved');
  }
  if (o !== resultSize) throw new GitReadError('corrupt', 'delta result size mismatch');
  return out;
}
