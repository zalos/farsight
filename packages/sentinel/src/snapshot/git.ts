// A read-only Git object reader in plain TypeScript. It reads loose objects and version-2 pack indexes/packs of a
// local repository and nothing else: no `git` process, so no hook, filter, textconv, replace ref, fsmonitor,
// configured command, promisor (lazy) fetch or other network access can run. Objects that are not present
// locally (a partial clone, an unfollowed alternate, a pruned pack) are reported missing, never fetched.
// Every object read is hash-verified against its id and size-bounded before it is inflated.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, constants as FS } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { constants as zconstants, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export type GitHashAlgorithm = 'sha1' | 'sha256';

export class GitReadError extends Error {
  constructor(readonly code: 'unsupported' | 'corrupt' | 'notRepository' | 'unresolved', message: string) {
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
/** Delta chains longer than this are refused rather than followed (git's own default depth is 50). */
const MAX_DELTA_DEPTH = 128;
/** Commits, trees and tags are small; a larger one is refused before it is inflated. */
export const MAX_METADATA_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_FILE = 1024 * 1024;

interface Pack {
  readonly packPath: string;
  readonly names: Buffer;          // N × hash length
  readonly offsets: readonly number[]; // index order
  readonly sorted: readonly number[];  // ascending offsets, for span lengths
  readonly end: number;            // pack size minus trailer
  readonly fanout: Uint32Array;
  fd?: number;
}

function readSmallText(path: string): string | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_TEXT_FILE) return undefined;
    return readFileSync(path, 'utf8');
  } catch { return undefined; }
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

export class GitRepository {
  readonly gitDir: string;
  readonly commonDir: string;
  readonly algorithm: GitHashAlgorithm;
  readonly hexLength: number;
  readonly #packs: Pack[] = [];
  #packsLoaded = false;

  private constructor(gitDir: string, commonDir: string, algorithm: GitHashAlgorithm) {
    this.gitDir = gitDir;
    this.commonDir = commonDir;
    this.algorithm = algorithm;
    this.hexLength = algorithm === 'sha1' ? 40 : 64;
  }

  /**
   * Opens the repository whose working tree is `root`. The Git directory is `root/.git`, or the path a `.git` file
   * names; a Git directory outside `root` is used only when `allowGitDir` names it exactly (a linked worktree).
   */
  static open(root: string, options: { gitDir?: string } = {}): GitRepository {
    const dotGit = join(root, '.git');
    let gitDir: string;
    let st;
    try { st = lstatSync(dotGit); } catch { throw new GitReadError('notRepository', 'no .git at the source root'); }
    if (st.isDirectory()) gitDir = dotGit;
    else if (st.isFile()) {
      const text = readSmallText(dotGit) ?? '';
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!m) throw new GitReadError('notRepository', 'the .git file does not name a Git directory');
      gitDir = resolve(root, m[1]!);
    } else throw new GitReadError('notRepository', '.git is neither a directory nor a gitdir file');
    gitDir = realpathSync.native(gitDir);
    const inside = gitDir === realpathSync.native(root) || gitDir.startsWith(realpathSync.native(root) + sep);
    if (!inside && (options.gitDir === undefined || realpathSync.native(options.gitDir) !== gitDir)) {
      throw new GitReadError('unsupported', 'the Git directory is outside the source root and was not explicitly permitted');
    }
    let commonDir = gitDir;
    const common = readSmallText(join(gitDir, 'commondir'));
    if (common !== undefined) {
      const named = common.trim();
      commonDir = realpathSync.native(isAbsolute(named) ? named : resolve(gitDir, named));
    }
    const config = readSmallText(join(commonDir, 'config')) ?? '';
    const format = (configValue(config, 'extensions', 'objectformat') ?? 'sha1').toLowerCase();
    if (format !== 'sha1' && format !== 'sha256') throw new GitReadError('unsupported', `object format ${format} is not supported`);
    const refStorage = configValue(config, 'extensions', 'refstorage');
    if (refStorage && refStorage.toLowerCase() !== 'files') throw new GitReadError('unsupported', `ref storage ${refStorage} is not supported`);
    return new GitRepository(gitDir, commonDir, format);
  }

  #isOid(text: string): boolean {
    return text.length === this.hexLength && /^[0-9a-f]+$/.test(text);
  }

  /** `HEAD`, a full ref name (`refs/heads/main`) or a full object id, resolved to a commit id. */
  resolveCommit(revision = 'HEAD'): string {
    let oid: string;
    if (this.#isOid(revision)) oid = revision;
    else if (revision === 'HEAD' || /^refs\/[A-Za-z0-9._/-]+$/.test(revision)) oid = this.#resolveRef(revision, 0);
    else throw new GitReadError('unsupported', 'a revision is HEAD, a full ref name or a full object id');
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
    // HEAD and worktree-private refs live in the worktree's own gitdir; shared refs in the common dir.
    const candidates = name === 'HEAD' ? [join(this.gitDir, 'HEAD')] : [join(this.gitDir, ...name.split('/')), join(this.commonDir, ...name.split('/'))];
    for (const path of candidates) {
      const text = readSmallText(path);
      if (text === undefined) continue;
      const line = text.trim();
      const sym = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)$/.exec(line);
      if (sym) return this.#resolveRef(sym[1]!, depth + 1);
      if (this.#isOid(line)) return line;
      throw new GitReadError('corrupt', `ref ${name} is not an object id`);
    }
    const packed = readSmallText(join(this.commonDir, 'packed-refs'));
    if (packed !== undefined) {
      for (const line of packed.split('\n')) {
        const m = /^([0-9a-f]+) (refs\/\S+)$/.exec(line.trim());
        if (m && m[2] === name && this.#isOid(m[1]!)) return m[1]!;
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
    const loose = this.#loosePath(oid);
    const bytes = this.#readLooseFile(loose);
    if (bytes) {
      // Inflate only a short compressed prefix, flushed without requiring the stream's end: the header is in it.
      const head = inflatePrefix(bytes, `loose object ${oid}`);
      const nul = head.indexOf(0);
      const m = /^(commit|tree|blob|tag) (\d+)$/.exec(head.toString('latin1', 0, nul < 0 ? head.length : nul));
      if (!m) throw new GitReadError('corrupt', `loose object ${oid} has no header`);
      return { type: m[1] as GitObjectType, size: Number(m[2]) };
    }
    const located = this.#locate(oid);
    if (!located) return undefined;
    return this.#packedHeader(located.pack, located.offset, 0);
  }

  /**
   * The verified object, or undefined when it is not present. Refused (corrupt) when its declared size exceeds
   * `maxBytes`, it does not inflate, or its bytes do not hash to its id.
   */
  readObject(oid: string, maxBytes: number): GitObject | undefined {
    if (!this.#isOid(oid)) throw new GitReadError('corrupt', 'not an object id');
    const loose = this.#readLooseFile(this.#loosePath(oid));
    let obj: GitObject | undefined;
    if (loose) {
      let raw: Buffer;
      try { raw = inflateSync(loose, { maxOutputLength: maxBytes + 64 }); } catch (e) {
        if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new GitReadError('corrupt', `object ${oid} exceeds the size limit`);
        throw new GitReadError('corrupt', `loose object ${oid} does not inflate`);
      }
      const nul = raw.indexOf(0);
      const m = nul < 0 ? null : /^(commit|tree|blob|tag) (\d+)$/.exec(raw.toString('latin1', 0, nul));
      if (!m || Number(m[2]) !== raw.length - nul - 1) throw new GitReadError('corrupt', `loose object ${oid} has a bad header`);
      if (Number(m[2]) > maxBytes) throw new GitReadError('corrupt', `object ${oid} exceeds the size limit`);
      obj = { type: m[1] as GitObjectType, data: raw.subarray(nul + 1) };
    } else {
      const located = this.#locate(oid);
      if (!located) return undefined;
      obj = this.#readPacked(located.pack, located.offset, maxBytes, 0);
    }
    if (this.hashObject(obj.type, obj.data) !== oid) throw new GitReadError('corrupt', `object ${oid} does not hash to its id`);
    return obj;
  }

  /** Git's object id of `data` as an object of `type`. */
  hashObject(type: GitObjectType, data: Uint8Array): string {
    return createHash(this.algorithm).update(`${type} ${data.byteLength}\0`).update(data).digest('hex');
  }

  #loosePath(oid: string): string {
    return join(this.commonDir, 'objects', oid.slice(0, 2), oid.slice(2));
  }

  #readLooseFile(path: string): Buffer | undefined {
    let fd: number;
    try { fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0)); } catch { return undefined; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return undefined;
      if (st.size > MAX_METADATA_OBJECT_BYTES * 2) throw new GitReadError('corrupt', 'loose object file is too large');
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
      return buf.subarray(0, off);
    } finally { closeSync(fd); }
  }

  #loadPacks(): void {
    if (this.#packsLoaded) return;
    this.#packsLoaded = true;
    const dir = join(this.commonDir, 'objects', 'pack');
    let names: string[];
    try { names = readdirSync(dir).filter(n => n.endsWith('.idx')).sort(); } catch { return; }
    for (const idxName of names) {
      const packPath = join(dir, idxName.replace(/\.idx$/, '.pack'));
      const idx = readFileSync(join(dir, idxName));
      const raw = this.hexLength / 2;
      if (idx.length < 8 + 1024 || idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) {
        throw new GitReadError('unsupported', `pack index ${idxName} is not version 2`);
      }
      const fanout = new Uint32Array(256);
      for (let i = 0; i < 256; i++) fanout[i] = idx.readUInt32BE(8 + i * 4);
      const n = fanout[255]!;
      const namesStart = 8 + 1024;
      const crcStart = namesStart + n * raw;
      const offStart = crcStart + n * 4;
      const largeStart = offStart + n * 4;
      if (idx.length < largeStart + 2 * raw) throw new GitReadError('corrupt', `pack index ${idxName} is truncated`);
      const offsets: number[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const v = idx.readUInt32BE(offStart + i * 4);
        if (v & 0x80000000) {
          const at = largeStart + (v & 0x7fffffff) * 8;
          if (at + 8 > idx.length - 2 * raw) throw new GitReadError('corrupt', `pack index ${idxName} has a bad large offset`);
          offsets[i] = Number(idx.readBigUInt64BE(at));
        } else offsets[i] = v;
      }
      let size: number;
      try { size = lstatSync(packPath).size; } catch { continue; } // an index without its pack holds nothing readable
      this.#packs.push({ packPath, names: idx.subarray(namesStart, crcStart), offsets, sorted: [...offsets].sort((a, b) => a - b), end: size - raw, fanout });
    }
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

  #span(pack: Pack, offset: number): Buffer {
    // The object's bytes run to the next object's offset (or the trailer).
    let lo = 0, hi = pack.sorted.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (pack.sorted[mid]! <= offset) lo = mid + 1; else hi = mid; }
    const next = lo < pack.sorted.length ? pack.sorted[lo]! : pack.end;
    if (next <= offset || next > pack.end) throw new GitReadError('corrupt', 'pack offsets are inconsistent');
    const length = next - offset;
    if (length > MAX_METADATA_OBJECT_BYTES * 2 + 64) throw new GitReadError('corrupt', 'packed object is too large');
    if (pack.fd === undefined) pack.fd = openSync(pack.packPath, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
    const buf = Buffer.alloc(length);
    let off = 0;
    while (off < length) { const n = readSync(pack.fd, buf, off, length - off, offset + off); if (n === 0) break; off += n; }
    if (off !== length) throw new GitReadError('corrupt', 'pack file is truncated');
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

  #packedHeader(pack: Pack, offset: number, depth: number): { type: GitObjectType; size: number } {
    if (depth > MAX_DELTA_DEPTH) throw new GitReadError('corrupt', 'delta chain too deep');
    const buf = this.#span(pack, offset);
    const h = this.#parseEntryHeader(buf);
    if (TYPE_BY_NUMBER[h.type]) return { type: TYPE_BY_NUMBER[h.type]!, size: h.size };
    // A delta's result size is the second varint of its inflated delta data; its type is the base's.
    const base = this.#deltaBase(pack, offset, buf, h);
    const inflated = inflatePrefix(buf.subarray(base.dataAt), 'a delta');
    const reader = { i: 0 };
    varint(inflated, reader);
    const size = varint(inflated, reader);
    const baseType = base.pack ? this.#packedHeader(base.pack, base.offset!, depth + 1).type : this.objectHeader(base.oid!)?.type;
    if (!baseType) throw new GitReadError('corrupt', 'delta base is missing');
    return { type: baseType, size };
  }

  #deltaBase(pack: Pack, offset: number, buf: Buffer, h: { type: number; at: number }):
    { pack?: Pack; offset?: number; oid?: string; dataAt: number } {
    if (h.type === 6) {
      let i = h.at;
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

  #readPacked(pack: Pack, offset: number, maxBytes: number, depth: number): GitObject {
    if (depth > MAX_DELTA_DEPTH) throw new GitReadError('corrupt', 'delta chain too deep');
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
    let delta: Buffer;
    try { delta = inflateSync(buf.subarray(base.dataAt), { maxOutputLength: Math.max(h.size, 1) }); } catch {
      throw new GitReadError('corrupt', 'delta does not inflate within its declared size');
    }
    const baseObj = base.pack
      ? this.#readPacked(base.pack, base.offset!, maxBytes, depth + 1)
      : this.#readBaseByOid(base.oid!, maxBytes, depth + 1);
    return { type: baseObj.type, data: applyDelta(baseObj.data, delta, maxBytes) };
  }

  #readBaseByOid(oid: string, maxBytes: number, depth: number): GitObject {
    const loose = this.#readLooseFile(this.#loosePath(oid));
    if (loose) {
      const obj = this.readObject(oid, maxBytes);
      if (obj) return obj;
    }
    const located = this.#locate(oid);
    if (!located) throw new GitReadError('corrupt', `delta base ${oid} is missing`);
    return this.#readPacked(located.pack, located.offset, maxBytes, depth);
  }

  close(): void {
    for (const p of this.#packs) if (p.fd !== undefined) { try { closeSync(p.fd); } catch { /* already closed */ } p.fd = undefined; }
  }
}

/** Inflates the first compressed bytes only (sync flush: a truncated stream is not an error). Bounded output. */
function inflatePrefix(compressed: Buffer, what: string): Buffer {
  try {
    return inflateSync(compressed.subarray(0, 64), { finishFlush: zconstants.Z_SYNC_FLUSH, maxOutputLength: 128 * 1024 });
  } catch {
    throw new GitReadError('corrupt', `${what} does not inflate`);
  }
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
