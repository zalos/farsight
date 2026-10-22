// Immutable, content-addressed evidence objects. One physical file per (raw digest, codec):
//   <storePath>/objects/sha256/<first two hex>/<raw sha-256 hex>.<codec>
// The logical artifact id is `sha256:<hex of the uncompressed bytes>`. Schema, privacy class and every other
// per-reference fact belong to the ledger row that names the object, never to the file, so two references that
// share bytes cannot downgrade one another through deduplication. Publication is write → fsync → verify →
// link(2) (which refuses to overwrite) → fsync of every directory on the path; a receipt is returned only after
// all of it succeeded. Nothing here deletes a published object.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
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
  stat(): Promise<{ size: number; isFile(): boolean }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface ObjectStat { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number }
export interface ObjectStoreIo {
  open(path: string, flags: number, mode?: number): Promise<ObjectFileHandle>;
  mkdir(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<ObjectStat>;
  link(existing: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

export const NODE_OBJECT_IO: ObjectStoreIo = {
  open: (path, flags, mode) => fsp.open(path, flags, mode) as Promise<ObjectFileHandle>,
  mkdir: async (path, mode) => { await fsp.mkdir(path, { mode }); },
  lstat: path => fsp.lstat(path),
  link: (a, b) => fsp.link(a, b),
  unlink: path => fsp.unlink(path),
  readdir: path => fsp.readdir(path),
};

const NOFOLLOW = FS.O_NOFOLLOW ?? 0;
const DIRECTORY = FS.O_DIRECTORY ?? 0;
const HEX64 = /^[0-9a-f]{64}$/;
const OBJECT_FILE = /^([0-9a-f]{64})\.(raw|gzip)$/;
const SHARD = /^[0-9a-f]{2}$/;

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

export class ObjectStore {
  readonly #owner: ObjectStoreOwner;
  readonly #io: ObjectStoreIo;
  readonly #root: string;

  constructor(owner: ObjectStoreOwner, options: ObjectStoreOptions = {}) {
    if (!owner || typeof owner.storePath !== 'string' || !owner.storePath || typeof owner.storeId !== 'string' || !owner.storeId
      || typeof owner.assertHeld !== 'function') {
      fail('sentinel.object.invalidInput', 'an object store needs an owner with storePath, storeId and assertHeld');
    }
    this.#owner = owner;
    this.#io = { ...NODE_OBJECT_IO, ...options.io };
    this.#root = owner.storePath;
  }

  get storeId(): string { return this.#owner.storeId; }

  #abs(rel: string): string { return join(this.#root, ...rel.split('/')); }

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
    const shardRel = `objects/sha256/${id.rawDigest.slice(0, 2)}`;
    await this.#ensureDir('objects');
    await this.#ensureDir('objects/sha256');
    await this.#ensureDir(shardRel);
    await this.#ensureDir('objects/tmp');

    const finalPath = this.#abs(rel);
    let winner = await this.#existing(finalPath, codec, id);
    let created = false;
    if (!winner) {
      const tmpPath = this.#abs(`objects/tmp/${id.rawDigest}.${codec}.${randomBytes(8).toString('hex')}.partial`);
      try {
        await this.#writeStaged(tmpPath, encoded, encodedDigest);
        try {
          await this.#io.link(tmpPath, finalPath); // link(2) never replaces an existing name.
          created = true;
          winner = { encodedDigest, encodedSize: encoded.length };
        } catch (e) {
          if (errno(e) !== 'EEXIST') ioFail('publishing the object', e);
          winner = await this.#existing(finalPath, codec, id);
          if (!winner) fail('sentinel.object.io', 'the object name existed and then vanished during publication');
        }
      } finally {
        try { await this.#io.unlink(tmpPath); } catch { /* the staged copy is inert; listObjects() reports it */ }
      }
    }
    if (!winner) return fail('sentinel.object.io', 'publication produced no verified object');
    // Make the name durable: the file itself (a no-op for our own fsynced inode), then every directory on its path.
    if (!created) await this.#syncFile(finalPath);
    await this.#syncDir(shardRel);
    await this.#syncDir('objects/sha256');
    await this.#syncDir('objects');
    await this.#syncDir('.');
    await this.#owner.assertHeld();
    return Object.freeze({
      kind: 'sentinel-object-receipt', version: 1, storeId: this.#owner.storeId,
      artifactId: id.artifactId, rawDigest: id.rawDigest, rawSize: id.rawSize,
      codec, canonicalization, encodedDigest: winner.encodedDigest, encodedSize: winner.encodedSize, relPath: rel, created,
    } satisfies ObjectReceipt);
  }

  async #ensureDir(rel: string): Promise<void> {
    const path = this.#abs(rel);
    try {
      await this.#io.mkdir(path, 0o700);
    } catch (e) {
      if (errno(e) !== 'EEXIST') ioFail(`creating ${rel}`, e);
    }
    let st: ObjectStat;
    try { st = await this.#io.lstat(path); } catch (e) { return ioFail(`inspecting ${rel}`, e); }
    if (st.isSymbolicLink() || !st.isDirectory()) fail('sentinel.object.unsafePath', `${rel} is not a directory`);
  }

  async #writeStaged(path: string, encoded: Buffer, encodedDigest: string): Promise<void> {
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
    } catch (e) {
      if (e instanceof ObjectStoreError) throw e;
      ioFail('writing the staged object', e);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /** The existing representation, verified; undefined when absent; throws when it is anything else. */
  async #existing(path: string, codec: ObjectCodec, id: ObjectIdentity): Promise<{ encodedDigest: string; encodedSize: number } | undefined> {
    let encoded: Buffer;
    try {
      encoded = await this.#readEncoded(path, undefined);
    } catch (e) {
      if (e instanceof ObjectStoreError && e.code === 'sentinel.object.missing') return undefined;
      if (e instanceof ObjectStoreError && (e.code === 'sentinel.object.corrupt' || e.code === 'sentinel.object.unsafePath')) {
        fail('sentinel.object.corruptExisting', `an object already published under this name is invalid: ${e.message}; it was left in place`, e);
      }
      throw e;
    }
    try {
      await decode(encoded, codec, id.rawDigest, id.rawSize);
    } catch (e) {
      return fail('sentinel.object.corruptExisting', `an object already published under this name is invalid: ${(e as Error).message}; it was left in place`, e);
    }
    return { encodedDigest: sha256(encoded), encodedSize: encoded.length };
  }

  async #readEncoded(path: string, expectedSize: number | undefined): Promise<Buffer> {
    let fh: ObjectFileHandle;
    try {
      fh = await this.#io.open(path, FS.O_RDONLY | NOFOLLOW);
    } catch (e) {
      if (errno(e) === 'ENOENT') return fail('sentinel.object.missing', 'object not found');
      if (errno(e) === 'ELOOP' || errno(e) === 'EMLINK') return fail('sentinel.object.unsafePath', 'object path is a symbolic link');
      return ioFail('opening the object', e);
    }
    try {
      let st: { size: number; isFile(): boolean };
      try { st = await fh.stat(); } catch (e) { return ioFail('inspecting the object', e); }
      if (!st.isFile()) fail('sentinel.object.unsafePath', 'object path is not a regular file');
      if (st.size > MAX_ENCODED_BYTES) fail('sentinel.object.corrupt', `object file is ${st.size} bytes; the limit is ${MAX_ENCODED_BYTES}`);
      if (expectedSize !== undefined && st.size !== expectedSize) fail('sentinel.object.corrupt', `object file is ${st.size} bytes; expected ${expectedSize}`);
      let bytes: Buffer;
      try { bytes = await readAll(fh, st.size, MAX_ENCODED_BYTES); } catch (e) {
        if (e instanceof ObjectStoreError) throw e;
        return ioFail('reading the object', e);
      }
      if (bytes.length !== st.size) fail('sentinel.object.corrupt', 'object file changed size while it was read');
      return bytes;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async #syncFile(path: string): Promise<void> {
    let fh: ObjectFileHandle;
    try { fh = await this.#io.open(path, FS.O_RDONLY | NOFOLLOW); } catch (e) { return ioFail('opening the object for fsync', e); }
    try { await fh.sync(); } catch (e) { ioFail('fsync of the object', e); } finally { await fh.close().catch(() => {}); }
  }

  async #syncDir(rel: string): Promise<void> {
    const path = rel === '.' ? this.#root : this.#abs(rel);
    let fh: ObjectFileHandle;
    try { fh = await this.#io.open(path, FS.O_RDONLY | DIRECTORY); } catch (e) { return ioFail(`opening ${rel} for fsync`, e); }
    try { await fh.sync(); } catch (e) { ioFail(`fsync of ${rel}`, e); } finally { await fh.close().catch(() => {}); }
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

  /** The raw bytes, after checking encoded size/digest (when known), the decode bound, raw size and raw digest. */
  async read(ref: ObjectRef): Promise<Buffer> {
    this.#checkRef(ref);
    const path = this.#abs(objectRelPath(ref.rawDigest, ref.codec));
    await this.#checkParents(ref.rawDigest);
    const encoded = await this.#readEncoded(path, ref.encodedSize);
    if (ref.encodedDigest !== undefined && sha256(encoded) !== ref.encodedDigest) fail('sentinel.object.corrupt', 'encoded bytes do not match the recorded digest');
    return decode(encoded, ref.codec, ref.rawDigest, ref.rawSize);
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

  /** Integrity check for one reference; never throws for missing or corrupt objects. */
  async check(ref: ObjectRef): Promise<ObjectCheck> {
    try {
      await this.read(ref);
      return { status: 'ok' };
    } catch (e) {
      if (!(e instanceof ObjectStoreError)) throw e;
      if (e.code === 'sentinel.object.missing') return { status: 'missing', code: e.code, detail: e.message };
      if (e.code === 'sentinel.object.corrupt') return { status: 'corrupt', code: e.code, detail: e.message };
      if (e.code === 'sentinel.object.unsafePath') return { status: 'unsafe', code: e.code, detail: e.message };
      throw e;
    }
  }

  /**
   * The same verification as `check()`, synchronously and always against the real filesystem, for callers that
   * must decide inside a database transaction. It reads and hashes the bytes on disk every time; a receipt is
   * never trusted on its own. Cost is one bounded read and decode of the object (at most 16 MiB).
   */
  checkSync(ref: ObjectRef): ObjectCheck {
    try {
      this.#checkRef(ref);
      for (const rel of ['objects', 'objects/sha256', `objects/sha256/${ref.rawDigest.slice(0, 2)}`]) {
        let st: ObjectStat;
        try { st = lstatSync(this.#abs(rel)); } catch (e) {
          if (errno(e) === 'ENOENT') fail('sentinel.object.missing', 'object not found');
          return ioFail(`inspecting ${rel}`, e);
        }
        if (st.isSymbolicLink() || !st.isDirectory()) fail('sentinel.object.unsafePath', `${rel} is not a directory`);
      }
      const encoded = readEncodedSync(this.#abs(objectRelPath(ref.rawDigest, ref.codec)), ref.encodedSize);
      if (ref.encodedDigest !== undefined && sha256(encoded) !== ref.encodedDigest) fail('sentinel.object.corrupt', 'encoded bytes do not match the recorded digest');
      decodeSync(encoded, ref.codec, ref.rawDigest, ref.rawSize);
      return { status: 'ok' };
    } catch (e) {
      if (!(e instanceof ObjectStoreError)) throw e;
      if (e.code === 'sentinel.object.missing') return { status: 'missing', code: e.code, detail: e.message };
      if (e.code === 'sentinel.object.corrupt') return { status: 'corrupt', code: e.code, detail: e.message };
      if (e.code === 'sentinel.object.unsafePath') return { status: 'unsafe', code: e.code, detail: e.message };
      throw e;
    }
  }

  async #checkParents(rawDigest: string): Promise<void> {
    for (const rel of ['objects', 'objects/sha256', `objects/sha256/${rawDigest.slice(0, 2)}`]) {
      let st: ObjectStat;
      try { st = await this.#io.lstat(this.#abs(rel)); } catch (e) {
        if (errno(e) === 'ENOENT') fail('sentinel.object.missing', 'object not found');
        return ioFail(`inspecting ${rel}`, e);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) fail('sentinel.object.unsafePath', `${rel} is not a directory`);
    }
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

function readEncodedSync(path: string, expectedSize: number | undefined): Buffer {
  let fd: number;
  try { fd = openSync(path, FS.O_RDONLY | NOFOLLOW); } catch (e) {
    if (errno(e) === 'ENOENT') return fail('sentinel.object.missing', 'object not found');
    if (errno(e) === 'ELOOP' || errno(e) === 'EMLINK') return fail('sentinel.object.unsafePath', 'object path is a symbolic link');
    return ioFail('opening the object', e);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) fail('sentinel.object.unsafePath', 'object path is not a regular file');
    if (st.size > MAX_ENCODED_BYTES) fail('sentinel.object.corrupt', `object file is ${st.size} bytes; the limit is ${MAX_ENCODED_BYTES}`);
    if (expectedSize !== undefined && st.size !== expectedSize) fail('sentinel.object.corrupt', `object file is ${st.size} bytes; expected ${expectedSize}`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== st.size) fail('sentinel.object.corrupt', 'object file is shorter than it claimed');
    if (readSync(fd, Buffer.alloc(1), 0, 1, st.size) !== 0) fail('sentinel.object.corrupt', 'object file grew while it was read');
    return buf;
  } catch (e) {
    if (e instanceof ObjectStoreError) throw e;
    return ioFail('reading the object', e);
  } finally {
    closeSync(fd);
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
