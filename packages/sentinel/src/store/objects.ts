// Immutable, content-addressed evidence objects. One physical file per (raw digest, codec):
//   <storePath>/objects/sha256/<first two hex>/<raw sha-256 hex>.<codec>
// The logical artifact id is `sha256:<hex of the uncompressed bytes>`. Schema, privacy class and every other
// per-reference fact belong to the ledger row that names the object, never to the file, so two references that
// share bytes cannot downgrade one another through deduplication. Publication is write → fsync → verify →
// link(2) (which refuses to overwrite) → fsync of every directory on the path; a receipt is returned only after
// all of it succeeded. Nothing here deletes a published object.
//
// Filesystem identity. The store root must be canonical (its real path, no symbolic link anywhere) and owner-only;
// every directory under it and every object file must be owned by this account, closed to other accounts, and not
// a symbolic link; an object file must have exactly one name (or extra names only inside `objects/tmp/`, the
// window between a writer's link and its unlink). Node exposes no openat/linkat, so a path cannot be pinned to a
// directory handle: these checks DETECT a swap, they cannot prevent one. Directory identities (device, inode) are
// captured before a write and compared after the link, at each directory fsync and before the receipt; any change
// refuses the receipt. A swap can still make link(2) create a name outside the store before it is detected; that
// name is reported, never removed. The checks are finite: a same-account process that swaps a path and restores
// it between two observations is not seen, and no check constrains what it does outside the store. That is the
// owner's own account and outside the threat model; within it, an observed change of any directory or object
// identity refuses the receipt.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

/** The largest decoded object the store writes or reads. */
export const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
/** Encoded files may exceed the raw size by the gzip header and incompressible-block overhead, never more. */
export const MAX_ENCODED_BYTES = MAX_OBJECT_BYTES + 64 * 1024;
/** The level new gzip files are written at. A winner written at another level is still a valid gzip file. */
export const GZIP_LEVEL = 6;
export const OBJECT_CODECS = ['raw', 'gzip'] as const;
export type ObjectCodec = typeof OBJECT_CODECS[number];
/** How the raw bytes were produced: preserved verbatim (source), or `canonicalJson()` of a structured value. */
export type ObjectCanonicalization = 'bytes' | 'canonical-json/1';

export type ObjectStoreErrorCode =
  | 'sentinel.object.invalidInput' | 'sentinel.object.tooLarge' | 'sentinel.object.digestMismatch'
  | 'sentinel.object.missing' | 'sentinel.object.corrupt' | 'sentinel.object.corruptExisting'
  | 'sentinel.object.wrongStore' | 'sentinel.object.unsafePath' | 'sentinel.object.notCanonical'
  | 'sentinel.object.io';

export class ObjectStoreError extends Error {
  constructor(readonly code: ObjectStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ObjectStoreError';
  }
}

/** The minimal seam this module needs from the store owner capability (PR 03 lane A). */
export interface ObjectStoreOwner {
  /** The store directory: it holds the ledger and `objects/`. */
  readonly storePath: string;
  readonly storeId: string;
  /** Throws when this process no longer owns the store. */
  assertHeld(): void | Promise<void>;
}

/** Identity of bytes before anything is written: what the ledger registers as a staging root before `put`. */
export interface ObjectIdentity {
  readonly artifactId: string;
  readonly rawDigest: string;
  readonly rawSize: number;
}

/** Proof that one representation of an object is durable in one store. */
export interface ObjectReceipt extends ObjectIdentity {
  readonly kind: 'sentinel-object-receipt';
  readonly version: 1;
  readonly storeId: string;
  readonly codec: ObjectCodec;
  readonly canonicalization: ObjectCanonicalization;
  /** Digest and size of the bytes actually on disk, which may be another writer's equally valid encoding. */
  readonly encodedDigest: string;
  readonly encodedSize: number;
  /** Relative to the store path, always forward slashes. */
  readonly relPath: string;
  /** False when an identical object was already published (by anyone); the receipt is equally durable. */
  readonly created: boolean;
}

/** What a reader names. A receipt satisfies it; the encoded and raw sizes are checked when given. */
export interface ObjectRef {
  readonly rawDigest: string;
  readonly codec: ObjectCodec;
  readonly rawSize?: number;
  readonly encodedDigest?: string;
  readonly encodedSize?: number;
  readonly storeId?: string;
}

export type ObjectCheck =
  | { readonly status: 'ok' }
  | { readonly status: 'missing' | 'corrupt' | 'unsafe'; readonly code: ObjectStoreErrorCode; readonly detail: string };

export interface PhysicalObject {
  readonly rawDigest: string;
  readonly codec: ObjectCodec;
  readonly relPath: string;
  readonly encodedSize: number;
}

export interface ObjectListing {
  readonly objects: readonly PhysicalObject[];
  /** Partial files left in `objects/tmp/` by an interrupted write. Never objects, never pruned here. */
  readonly staging: readonly string[];
  /** Anything under `objects/` that this layout does not produce. Reported, never touched. */
  readonly unexpected: readonly string[];
}

// ---- filesystem seam (tests inject failures through it) ----

export interface ObjectFileHandle {
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  stat(): Promise<ObjectStat>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface ObjectStat {
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
  size: number; dev: number; ino: number; nlink: number; uid: number; mode: number;
}
export interface ObjectStoreIo {
  open(path: string, flags: number, mode?: number): Promise<ObjectFileHandle>;
  mkdir(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<ObjectStat>;
  link(existing: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
}

export const NODE_OBJECT_IO: ObjectStoreIo = {
  open: (path, flags, mode) => fsp.open(path, flags, mode) as Promise<ObjectFileHandle>,
  mkdir: async (path, mode) => { await fsp.mkdir(path, { mode }); },
  lstat: path => fsp.lstat(path),
  link: (a, b) => fsp.link(a, b),
  unlink: path => fsp.unlink(path),
  readdir: path => fsp.readdir(path),
  realpath: path => fsp.realpath(path),
};

const NOFOLLOW = FS.O_NOFOLLOW ?? 0;
const DIRECTORY = FS.O_DIRECTORY ?? 0;
const HEX64 = /^[0-9a-f]{64}$/;
const OBJECT_FILE = /^([0-9a-f]{64})\.(raw|gzip)$/;
const SHARD = /^[0-9a-f]{2}$/;

const UID = typeof process.getuid === 'function' ? process.getuid() : undefined;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const errno = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;
const fail = (code: ObjectStoreErrorCode, message: string, cause?: unknown): never => {
  throw new ObjectStoreError(code, message, cause === undefined ? undefined : { cause });
};
const ioFail = (what: string, cause: unknown): never => fail('sentinel.object.io', `${what} failed (${errno(cause) ?? 'error'})`, cause);

/** The logical id of a byte string. */
export function identify(bytes: Uint8Array): ObjectIdentity {
  if (!(bytes instanceof Uint8Array)) fail('sentinel.object.invalidInput', 'object bytes must be a Uint8Array');
  if (bytes.byteLength > MAX_OBJECT_BYTES) fail('sentinel.object.tooLarge', `object is ${bytes.byteLength} bytes; the limit is ${MAX_OBJECT_BYTES}`);
  const rawDigest = sha256(bytes);
  return Object.freeze({ artifactId: `sha256:${rawDigest}`, rawDigest, rawSize: bytes.byteLength });
}

export function artifactIdOf(rawDigest: string): string {
  if (!HEX64.test(rawDigest)) fail('sentinel.object.invalidInput', 'a raw digest is 64 lower-case hex characters');
  return `sha256:${rawDigest}`;
}

export function rawDigestOf(artifactId: string): string {
  const m = /^sha256:([0-9a-f]{64})$/.exec(artifactId);
  if (!m) fail('sentinel.object.invalidInput', 'an artifact id is sha256:<64 lower-case hex>');
  return m![1]!;
}

/** Relative path of one representation, forward slashes, under the store path. */
export function objectRelPath(rawDigest: string, codec: ObjectCodec): string {
  if (!HEX64.test(rawDigest)) fail('sentinel.object.invalidInput', 'a raw digest is 64 lower-case hex characters');
  if (!OBJECT_CODECS.includes(codec)) fail('sentinel.object.invalidInput', `unknown codec ${String(codec)}`);
  return `objects/sha256/${rawDigest.slice(0, 2)}/${rawDigest}.${codec}`;
}

/**
 * Deterministic JSON for structured artifacts: object keys sorted by UTF-16 code unit, no whitespace,
 * `JSON.stringify` scalars. Refuses what JSON cannot round-trip (undefined, non-finite numbers, bigint,
 * functions, symbols, non-plain objects, cycles). Source bytes never pass through here.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): string => {
    if (depth > 256) fail('sentinel.object.notCanonical', 'structure is nested deeper than 256 levels');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail('sentinel.object.notCanonical', 'non-finite number');
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    }
    if (typeof v !== 'object') return fail('sentinel.object.notCanonical', `${typeof v} has no JSON form`);
    if (seen.has(v)) fail('sentinel.object.notCanonical', 'cyclic structure');
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      out = `[${Array.from(v, item => walk(item, depth + 1)).join(',')}]`;
    } else {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) fail('sentinel.object.notCanonical', 'only plain objects have a canonical form');
      if (Object.getOwnPropertySymbols(v).length) fail('sentinel.object.notCanonical', 'symbol keys have no JSON form');
      const keys = Object.keys(v).sort();
      out = `{${keys.map(k => `${JSON.stringify(k)}:${walk((v as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
    }
    seen.delete(v);
    return out;
  };
  return walk(value, 0);
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

async function encode(raw: Uint8Array, codec: ObjectCodec): Promise<Buffer> {
  return codec === 'raw' ? Buffer.from(raw) : gzipAsync(raw, { level: GZIP_LEVEL });
}

/** Decodes with the output bounded before allocation, then checks length and digest. */
async function decode(encoded: Buffer, codec: ObjectCodec, rawDigest: string, rawSize: number | undefined): Promise<Buffer> {
  const limit = Math.min(rawSize ?? MAX_OBJECT_BYTES, MAX_OBJECT_BYTES);
  let decoded: Buffer;
  if (codec === 'raw') {
    if (encoded.length > limit) fail('sentinel.object.corrupt', 'raw object is larger than its recorded size');
    decoded = encoded;
  } else {
    try {
      // maxOutputLength stops inflation at the limit: a gzip bomb cannot allocate past it.
      decoded = await gunzipAsync(encoded, { maxOutputLength: Math.max(limit, 1) });
    } catch (e) {
      return fail('sentinel.object.corrupt', `gzip object does not decode within ${limit} bytes (${errno(e) ?? 'error'})`, e);
    }
  }
  return checkDecoded(decoded, rawDigest, rawSize);
}

function decodeSync(encoded: Buffer, codec: ObjectCodec, rawDigest: string, rawSize: number | undefined): Buffer {
  const limit = Math.min(rawSize ?? MAX_OBJECT_BYTES, MAX_OBJECT_BYTES);
  let decoded: Buffer;
  if (codec === 'raw') {
    if (encoded.length > limit) fail('sentinel.object.corrupt', 'raw object is larger than its recorded size');
    decoded = encoded;
  } else {
    try {
      decoded = zlib.gunzipSync(encoded, { maxOutputLength: Math.max(limit, 1) });
    } catch (e) {
      return fail('sentinel.object.corrupt', `gzip object does not decode within ${limit} bytes (${errno(e) ?? 'error'})`, e);
    }
  }
  return checkDecoded(decoded, rawDigest, rawSize);
}

function checkDecoded(decoded: Buffer, rawDigest: string, rawSize: number | undefined): Buffer {
  if (rawSize !== undefined && decoded.length !== rawSize) fail('sentinel.object.corrupt', `decoded ${decoded.length} bytes; expected ${rawSize}`);
  if (decoded.length > MAX_OBJECT_BYTES) fail('sentinel.object.corrupt', 'decoded object exceeds the size limit');
  if (sha256(decoded) !== rawDigest) fail('sentinel.object.corrupt', 'decoded bytes do not match the raw digest');
  return decoded;
}

export interface ObjectStoreOptions {
  readonly io?: Partial<ObjectStoreIo>;
}

export interface PutOptions {
  readonly codec?: ObjectCodec;
  /** The identity registered as a staging root before the write; a mismatch refuses the put. */
  readonly expect?: ObjectIdentity;
}

interface Ident { readonly dev: number; readonly ino: number }
/** Relative directory → identity captured when it was checked. '.' is the store root. */
type Chain = Map<string, Ident>;
const sameIdent = (a: Ident | undefined, b: { dev: number; ino: number }) => !!a && a.dev === b.dev && a.ino === b.ino;

/** Owned by this account and closed to every other one. */
function assertOwnerOnly(st: ObjectStat, what: string): void {
  if (UID !== undefined && st.uid !== UID) fail('sentinel.object.unsafePath', `${what} is not owned by this account`);
  if ((st.mode & 0o077) !== 0) fail('sentinel.object.unsafePath', `${what} is accessible to other accounts`);
}

function assertSafeDir(st: ObjectStat, rel: string): void {
  if (st.isSymbolicLink() || !st.isDirectory()) fail('sentinel.object.unsafePath', `${rel} is not a directory`);
  assertOwnerOnly(st, rel);
}

const shardOf = (rawDigest: string) => `objects/sha256/${rawDigest.slice(0, 2)}`;
const readChain = (rawDigest: string) => ['.', 'objects', 'objects/sha256', shardOf(rawDigest)];

interface Verified { readonly decoded: Buffer; readonly encodedDigest: string; readonly encodedSize: number; readonly ident: Ident }

export class ObjectStore {
  readonly #owner: ObjectStoreOwner;
  readonly #io: ObjectStoreIo;
  readonly #root: string;

  constructor(owner: ObjectStoreOwner, options: ObjectStoreOptions = {}) {
    if (!owner || typeof owner.storePath !== 'string' || !owner.storePath || typeof owner.storeId !== 'string' || !owner.storeId
      || typeof owner.assertHeld !== 'function') {
      fail('sentinel.object.invalidInput', 'an object store needs an owner with storePath, storeId and assertHeld');
    }
    if (!isAbsolute(owner.storePath)) fail('sentinel.object.unsafePath', 'the store path must be absolute');
    this.#owner = owner;
    this.#io = { ...NODE_OBJECT_IO, ...options.io };
    this.#root = owner.storePath;
  }

  get storeId(): string { return this.#owner.storeId; }

  #abs(rel: string): string { return rel === '.' ? this.#root : join(this.#root, ...rel.split('/')); }

  /** Publishes verbatim bytes (source files and other raw evidence). */
  put(bytes: Uint8Array, options: PutOptions = {}): Promise<ObjectReceipt> {
    return this.#put(bytes, 'bytes', options);
  }

  /** Publishes the canonical JSON of a structured value. */
  putCanonicalJson(value: unknown, options: PutOptions = {}): Promise<ObjectReceipt> {
    return this.#put(canonicalJsonBytes(value), 'canonical-json/1', options);
  }

  async #put(bytes: Uint8Array, canonicalization: ObjectCanonicalization, options: PutOptions): Promise<ObjectReceipt> {
    const codec = options.codec ?? 'gzip';
    if (!OBJECT_CODECS.includes(codec)) fail('sentinel.object.invalidInput', `unknown codec ${String(codec)}`);
    const id = identify(bytes);
    if (options.expect && (options.expect.rawDigest !== id.rawDigest || options.expect.rawSize !== id.rawSize)) {
      fail('sentinel.object.digestMismatch', 'bytes do not match the registered identity');
    }
    await this.#owner.assertHeld();
    const encoded = await encode(bytes, codec);
    if (encoded.length > MAX_ENCODED_BYTES) fail('sentinel.object.tooLarge', 'encoded object exceeds the encoded size limit');
    // The encoding we are about to write must itself decode back to the same bytes.
    await decode(encoded, codec, id.rawDigest, id.rawSize);
    const encodedDigest = sha256(encoded);

    const rel = objectRelPath(id.rawDigest, codec);
    const finalPath = this.#abs(rel);
    const chain = await this.#ensureChain([...readChain(id.rawDigest), 'objects/tmp']);

    let winner: Omit<Verified, 'decoded'> | undefined = this.#existing(rel, codec, id);
    let created = false;
    if (!winner) {
      const tmpPath = this.#abs(`objects/tmp/${id.rawDigest}.${codec}.${randomBytes(8).toString('hex')}.partial`);
      try {
        const staged = await this.#writeStaged(tmpPath, encoded, encodedDigest);
        await this.#recheck(chain);
        try {
          await this.#io.link(tmpPath, finalPath); // link(2) never replaces an existing name.
          created = true;
        } catch (e) {
          if (errno(e) !== 'EEXIST') {
            await this.#recheck(chain); // a swapped directory is reported as such, not as a plain I/O failure
            ioFail('publishing the object', e);
          }
        }
        // Whatever happened, the directories must still be the ones checked, or the name may be elsewhere.
        await this.#recheck(chain);
        if (created) {
          const st = await this.#lstatOrFail(rel);
          if (st.isSymbolicLink() || !st.isFile() || !sameIdent(staged, st)) {
            fail('sentinel.object.unsafePath', 'the published name does not refer to the staged file');
          }
          winner = { encodedDigest, encodedSize: encoded.length, ident: staged };
        } else {
          winner = this.#existing(rel, codec, id);
          if (!winner) fail('sentinel.object.io', 'the object name existed and then vanished during publication');
        }
      } finally {
        try { await this.#io.unlink(tmpPath); } catch { /* an inert staged copy; listObjects() reports it */ }
      }
    }
    if (!winner) return fail('sentinel.object.io', 'publication produced no verified object');
    // Make the name durable: the file (a no-op for our own fsynced inode), then every directory on its path,
    // each opened without following a link and compared with the identity checked before the write.
    await this.#syncFile(rel, winner.ident);
    for (const dir of [shardOf(id.rawDigest), 'objects/sha256', 'objects', '.']) await this.#syncDir(dir, chain);
    await this.#recheck(chain);
    let real: string;
    try { real = await this.#io.realpath(finalPath); } catch (e) { return ioFail('resolving the published object', e); }
    if (real !== finalPath) fail('sentinel.object.unsafePath', 'the published object no longer resolves inside the store');
    const last = await this.#lstatOrFail(rel);
    if (!sameIdent(winner.ident, last)) fail('sentinel.object.unsafePath', 'the published name changed before the receipt');
    await this.#owner.assertHeld();
    return Object.freeze({
      kind: 'sentinel-object-receipt', version: 1, storeId: this.#owner.storeId,
      artifactId: id.artifactId, rawDigest: id.rawDigest, rawSize: id.rawSize,
      codec, canonicalization, encodedDigest: winner.encodedDigest, encodedSize: winner.encodedSize, relPath: rel, created,
    } satisfies ObjectReceipt);
  }

  async #lstatOrFail(rel: string): Promise<ObjectStat> {
    try { return await this.#io.lstat(this.#abs(rel)); } catch (e) { return ioFail(`inspecting ${rel}`, e); }
  }

  /** Checks the root, then creates (0700) and checks each directory, recording its identity. */
  async #ensureChain(rels: readonly string[]): Promise<Chain> {
    let real: string;
    try { real = await this.#io.realpath(this.#root); } catch (e) { return ioFail('resolving the store path', e); }
    if (real !== this.#root) fail('sentinel.object.unsafePath', 'the store path is not canonical (it passes through a symbolic link or is not its real path)');
    const chain: Chain = new Map();
    for (const rel of rels) {
      if (rel !== '.') {
        try { await this.#io.mkdir(this.#abs(rel), 0o700); } catch (e) {
          if (errno(e) !== 'EEXIST') ioFail(`creating ${rel}`, e);
        }
      }
      const st = await this.#lstatOrFail(rel);
      assertSafeDir(st, rel === '.' ? 'the store directory' : rel);
      chain.set(rel, { dev: st.dev, ino: st.ino });
    }
    return chain;
  }

  async #recheck(chain: Chain): Promise<void> {
    for (const [rel, ident] of chain) {
      let st: ObjectStat;
      try { st = await this.#io.lstat(this.#abs(rel)); } catch (e) {
        return fail('sentinel.object.unsafePath', `${rel} disappeared during the operation`, e);
      }
      if (st.isSymbolicLink() || !st.isDirectory() || !sameIdent(ident, st)) fail('sentinel.object.unsafePath', `${rel} was replaced during the operation`);
    }
  }

  async #writeStaged(path: string, encoded: Buffer, encodedDigest: string): Promise<Ident> {
    let fh: ObjectFileHandle;
    try {
      fh = await this.#io.open(path, FS.O_RDWR | FS.O_CREAT | FS.O_EXCL | NOFOLLOW, 0o600);
    } catch (e) { return ioFail('creating the staged object', e); }
    try {
      let off = 0;
      while (off < encoded.length) {
        const { bytesWritten } = await fh.write(encoded, off, encoded.length - off, off);
        if (bytesWritten <= 0) fail('sentinel.object.io', 'writing the staged object made no progress');
        off += bytesWritten;
      }
      await fh.sync();
      const back = await readAll(fh, encoded.length, MAX_ENCODED_BYTES);
      if (back.length !== encoded.length || sha256(back) !== encodedDigest) fail('sentinel.object.io', 'the staged object did not read back as written');
      const st = await fh.stat();
      assertOwnerOnly(st, 'the staged object');
      if (!st.isFile() || st.nlink !== 1) fail('sentinel.object.unsafePath', 'the staged object is not a single-link regular file');
      return { dev: st.dev, ino: st.ino };
    } catch (e) {
      if (e instanceof ObjectStoreError) throw e;
      return ioFail('writing the staged object', e);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /** The existing representation, verified; undefined when absent; throws (never overwrites) otherwise. */
  #existing(rel: string, codec: ObjectCodec, id: ObjectIdentity): Verified | undefined {
    try {
      return this.#readVerifiedSync({ rawDigest: id.rawDigest, codec, rawSize: id.rawSize });
    } catch (e) {
      if (e instanceof ObjectStoreError && e.code === 'sentinel.object.missing') return undefined;
      if (e instanceof ObjectStoreError && e.code === 'sentinel.object.corrupt') {
        fail('sentinel.object.corruptExisting', `an object already published as ${rel} is invalid: ${e.message}; it was left in place`, e);
      }
      throw e;
    }
  }

  async #syncFile(rel: string, ident: Ident): Promise<void> {
    let fh: ObjectFileHandle;
    try { fh = await this.#io.open(this.#abs(rel), FS.O_RDONLY | NOFOLLOW); } catch (e) { return ioFail('opening the object for fsync', e); }
    try {
      const st = await fh.stat();
      if (!sameIdent(ident, st)) fail('sentinel.object.unsafePath', 'the object was replaced before its fsync');
      await fh.sync();
    } catch (e) {
      if (e instanceof ObjectStoreError) throw e;
      ioFail('fsync of the object', e);
    } finally { await fh.close().catch(() => {}); }
  }

  async #syncDir(rel: string, chain: Chain): Promise<void> {
    let fh: ObjectFileHandle;
    try { fh = await this.#io.open(this.#abs(rel), FS.O_RDONLY | DIRECTORY | NOFOLLOW); } catch (e) {
      if (errno(e) === 'ELOOP' || errno(e) === 'ENOTDIR') return fail('sentinel.object.unsafePath', `${rel} was replaced during the operation`, e);
      return ioFail(`opening ${rel} for fsync`, e);
    }
    try {
      const st = await fh.stat();
      if (!sameIdent(chain.get(rel), st)) fail('sentinel.object.unsafePath', `${rel} was replaced during the operation`);
      await fh.sync();
    } catch (e) {
      if (e instanceof ObjectStoreError) throw e;
      ioFail(`fsync of ${rel}`, e);
    } finally { await fh.close().catch(() => {}); }
  }

  #checkRef(ref: ObjectRef): void {
    if (!ref || !HEX64.test(ref.rawDigest) || !OBJECT_CODECS.includes(ref.codec)) fail('sentinel.object.invalidInput', 'an object reference needs a raw digest and a codec');
    if (ref.storeId !== undefined && ref.storeId !== this.#owner.storeId) fail('sentinel.object.wrongStore', 'the reference names another store');
    if (ref.rawSize !== undefined && (!Number.isSafeInteger(ref.rawSize) || ref.rawSize < 0 || ref.rawSize > MAX_OBJECT_BYTES)) {
      fail('sentinel.object.invalidInput', 'raw size out of range');
    }
    if (ref.encodedSize !== undefined && (!Number.isSafeInteger(ref.encodedSize) || ref.encodedSize < 0 || ref.encodedSize > MAX_ENCODED_BYTES)) {
      fail('sentinel.object.invalidInput', 'encoded size out of range');
    }
    if (ref.encodedDigest !== undefined && !HEX64.test(ref.encodedDigest)) fail('sentinel.object.invalidInput', 'an encoded digest is 64 lower-case hex characters');
  }

  #chainSync(rels: readonly string[]): Chain {
    let real: string;
    try { real = realpathSync.native(this.#root); } catch (e) {
      if (errno(e) === 'ENOENT') return fail('sentinel.object.missing', 'object not found');
      return ioFail('resolving the store path', e);
    }
    if (real !== this.#root) fail('sentinel.object.unsafePath', 'the store path is not canonical (it passes through a symbolic link or is not its real path)');
    const chain: Chain = new Map();
    for (const rel of rels) {
      let st: ObjectStat;
      try { st = lstatSync(this.#abs(rel)); } catch (e) {
        if (errno(e) === 'ENOENT') return fail('sentinel.object.missing', 'object not found');
        return ioFail(`inspecting ${rel}`, e);
      }
      assertSafeDir(st, rel === '.' ? 'the store directory' : rel);
      chain.set(rel, { dev: st.dev, ino: st.ino });
    }
    return chain;
  }

  #recheckSync(chain: Chain): void {
    for (const [rel, ident] of chain) {
      let st: ObjectStat;
      try { st = lstatSync(this.#abs(rel)); } catch (e) { return fail('sentinel.object.unsafePath', `${rel} disappeared during the read`, e); }
      if (st.isSymbolicLink() || !st.isDirectory() || !sameIdent(ident, st)) fail('sentinel.object.unsafePath', `${rel} was replaced during the read`);
    }
  }

  /**
   * An object file may carry extra names only inside `objects/tmp/` (a writer between link and unlink). Any other
   * alias could be written through from outside the store, so it is refused. Re-stats until the count is stable.
   */
  #aliasesAllowedSync(fd: number, first: ObjectStat): boolean {
    let st = first;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (st.nlink === 1) return true;
      let staged = 0;
      try {
        const tmp = lstatSync(this.#abs('objects/tmp'));
        if (!tmp.isSymbolicLink() && tmp.isDirectory()) {
          for (const name of readdirSync(this.#abs('objects/tmp'))) {
            try {
              const s = lstatSync(this.#abs(`objects/tmp/${name}`));
              if (s.isFile() && s.dev === st.dev && s.ino === st.ino) staged++;
            } catch { /* removed meanwhile */ }
          }
        }
      } catch { /* no staging directory: no allowed aliases */ }
      const again = fstatSync(fd);
      if (again.nlink === st.nlink && 1 + staged === st.nlink) return true;
      st = again;
    }
    return false;
  }

  /** Every check a read makes, synchronously; returns the decoded bytes. */
  #readVerifiedSync(ref: ObjectRef): Verified {
    this.#checkRef(ref);
    const rel = objectRelPath(ref.rawDigest, ref.codec);
    const chain = this.#chainSync(readChain(ref.rawDigest));
    const path = this.#abs(rel);
    let fd: number;
    try { fd = openSync(path, FS.O_RDONLY | NOFOLLOW); } catch (e) {
      if (errno(e) === 'ENOENT') return fail('sentinel.object.missing', 'object not found');
      if (errno(e) === 'ELOOP' || errno(e) === 'EMLINK') return fail('sentinel.object.unsafePath', 'object path is a symbolic link');
      return ioFail('opening the object', e);
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) fail('sentinel.object.unsafePath', 'object path is not a regular file');
      assertOwnerOnly(st, 'the object file');
      if (!this.#aliasesAllowedSync(fd, st)) fail('sentinel.object.unsafePath', 'the object file has another name outside the store');
      if (st.size > MAX_ENCODED_BYTES) fail('sentinel.object.corrupt', `object file is ${st.size} bytes; the limit is ${MAX_ENCODED_BYTES}`);
      if (ref.encodedSize !== undefined && st.size !== ref.encodedSize) fail('sentinel.object.corrupt', `object file is ${st.size} bytes; expected ${ref.encodedSize}`);
      const encoded = Buffer.alloc(st.size);
      let off = 0;
      try {
        while (off < st.size) {
          const n = readSync(fd, encoded, off, st.size - off, off);
          if (n === 0) break;
          off += n;
        }
        if (off === st.size && readSync(fd, Buffer.alloc(1), 0, 1, st.size) !== 0) fail('sentinel.object.corrupt', 'object file grew while it was read');
      } catch (e) {
        if (e instanceof ObjectStoreError) throw e;
        return ioFail('reading the object', e);
      }
      if (off !== st.size) fail('sentinel.object.corrupt', 'object file is shorter than it claimed');
      const encodedDigest = sha256(encoded);
      if (ref.encodedDigest !== undefined && encodedDigest !== ref.encodedDigest) fail('sentinel.object.corrupt', 'encoded bytes do not match the recorded digest');
      const decoded = decodeSync(encoded, ref.codec, ref.rawDigest, ref.rawSize);
      // The name must still be this file, in the same directories.
      let named: ObjectStat;
      try { named = lstatSync(path); } catch (e) { return fail('sentinel.object.unsafePath', 'the object name changed during the read', e); }
      if (named.isSymbolicLink() || !sameIdent(st, named)) fail('sentinel.object.unsafePath', 'the object name changed during the read');
      this.#recheckSync(chain);
      return { decoded, encodedDigest, encodedSize: st.size, ident: { dev: st.dev, ino: st.ino } };
    } finally {
      closeSync(fd);
    }
  }

  /** The raw bytes, after every identity, size, decode-bound and digest check. */
  async read(ref: ObjectRef): Promise<Buffer> {
    return this.#readVerifiedSync(ref).decoded;
  }

  /** Reads a structured artifact and refuses bytes that are not the canonical form of what they parse to. */
  async readCanonicalJson(ref: ObjectRef): Promise<unknown> {
    const bytes = await this.read(ref);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (e) {
      return fail('sentinel.object.notCanonical', 'object is not UTF-8 JSON', e);
    }
    if (!canonicalJsonBytes(value).equals(bytes)) fail('sentinel.object.notCanonical', 'object is JSON but not in canonical form');
    return value;
  }

  /**
   * Integrity check for one reference, synchronous so a caller can decide inside a database transaction. It reads
   * and hashes the bytes on disk on every call; a receipt is never trusted on its own. Never throws for a missing,
   * corrupt or unsafe object. Cost: one bounded read and decode (at most 16 MiB).
   */
  checkSync(ref: ObjectRef): ObjectCheck {
    try {
      this.#readVerifiedSync(ref);
      return { status: 'ok' };
    } catch (e) {
      if (!(e instanceof ObjectStoreError)) throw e;
      if (e.code === 'sentinel.object.missing') return { status: 'missing', code: e.code, detail: e.message };
      if (e.code === 'sentinel.object.corrupt') return { status: 'corrupt', code: e.code, detail: e.message };
      if (e.code === 'sentinel.object.unsafePath') return { status: 'unsafe', code: e.code, detail: e.message };
      throw e;
    }
  }

  async check(ref: ObjectRef): Promise<ObjectCheck> {
    return this.checkSync(ref);
  }

  /** Read-only enumeration of everything under `objects/`. Follows no symbolic link. */
  async list(): Promise<ObjectListing> {
    const objects: PhysicalObject[] = [];
    const staging: string[] = [];
    const unexpected: string[] = [];
    const entries = async (rel: string): Promise<string[] | undefined> => {
      let st: ObjectStat;
      try { st = await this.#io.lstat(this.#abs(rel)); } catch (e) {
        if (errno(e) === 'ENOENT') return undefined;
        return ioFail(`inspecting ${rel}`, e);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) { unexpected.push(rel); return undefined; }
      try { return (await this.#io.readdir(this.#abs(rel))).sort(); } catch (e) { return ioFail(`listing ${rel}`, e); }
    };
    const top = await entries('objects');
    for (const name of top ?? []) {
      if (name === 'sha256' || name === 'tmp') continue;
      unexpected.push(`objects/${name}`);
    }
    if (top?.includes('tmp')) for (const name of await entries('objects/tmp') ?? []) staging.push(`objects/tmp/${name}`);
    if (top?.includes('sha256')) {
      for (const shard of await entries('objects/sha256') ?? []) {
        const shardRel = `objects/sha256/${shard}`;
        if (!SHARD.test(shard)) { unexpected.push(shardRel); continue; }
        for (const name of await entries(shardRel) ?? []) {
          const rel = `${shardRel}/${name}`;
          const m = OBJECT_FILE.exec(name);
          if (!m || m[1]!.slice(0, 2) !== shard) { unexpected.push(rel); continue; }
          let st: ObjectStat;
          try { st = await this.#io.lstat(this.#abs(rel)); } catch (e) { return ioFail(`inspecting ${rel}`, e); }
          if (st.isSymbolicLink() || !st.isFile()) { unexpected.push(rel); continue; }
          objects.push(Object.freeze({ rawDigest: m[1]!, codec: m[2] as ObjectCodec, relPath: rel, encodedSize: st.size }));
        }
      }
    }
    return Object.freeze({ objects: Object.freeze(objects), staging: Object.freeze(staging), unexpected: Object.freeze(unexpected) });
  }
}

/** Reads exactly `size` bytes from position 0 and confirms there is nothing after them. */
async function readAll(fh: ObjectFileHandle, size: number, cap: number): Promise<Buffer> {
  if (size > cap) fail('sentinel.object.corrupt', 'object exceeds the read limit');
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const { bytesRead } = await fh.read(buf, off, size - off, off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  if (off !== size) fail('sentinel.object.corrupt', 'object file is shorter than it claimed');
  const extra = Buffer.alloc(1);
  const { bytesRead } = await fh.read(extra, 0, 1, size);
  if (bytesRead !== 0) fail('sentinel.object.corrupt', 'object file grew while it was read');
  return buf;
}
