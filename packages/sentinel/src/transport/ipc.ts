// The local service transport: one owner-only Unix socket per store owner, framed, bounded JSON, and a handshake
// that binds a connection to the store it expects. Nothing here decides policy; it carries requests to a handler
// with the requester the connection was granted, never one a request claims.
//
// Address: a short private runtime folder keyed by the canonical store path and the owner's nonce, under a validated
// $XDG_RUNTIME_DIR or $TMPDIR, else a fresh unpredictable 0700 folder under /tmp when those paths are too long. A
// Unix socket path is a fixed byte array (104 on macOS, 108 on Linux, each including the terminator), so the path's
// UTF-8 byte length is checked with room for the terminator before binding or connecting. The folder must be a real
// folder, this user's, closed to everyone else; the socket must be a socket, this user's, 0600. A stale socket of
// ours (nothing listening) is replaced; anything else is refused, never chmod-ed or followed.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, unlinkSync, type Stats } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';
import type { RequestedBy } from '../cli/actor.js';
import { refuseActorClaims, ActorError } from '../cli/actor.js';

export const SERVICE_PROTOCOL = 'sentinel-service/draft-1';
/** Each frame is a 4-byte big-endian length then that many bytes of UTF-8 JSON. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** `sun_path` sizes, terminator included. Any other platform has no qualified socket length and is refused. */
const SUN_PATH: Readonly<Record<string, number>> = { darwin: 104, linux: 108 };

export type IpcErrorCode =
  | 'sentinel.ipc.platformUnsupported' | 'sentinel.ipc.pathTooLong' | 'sentinel.ipc.runtimeDirUnsafe'
  | 'sentinel.ipc.socketUnsafe' | 'sentinel.ipc.socketInUse' | 'sentinel.ipc.frameTooLarge'
  | 'sentinel.ipc.frameMalformed' | 'sentinel.ipc.handshakeMismatch' | 'sentinel.ipc.notListening';

export class IpcError extends Error {
  constructor(readonly code: IpcErrorCode, readonly detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'IpcError';
  }
}

const UID = typeof process.getuid === 'function' ? process.getuid() : undefined;

/** The usable bytes of a socket path on this platform (the array size less its terminator). */
export function socketPathLimit(platform: string = process.platform): number {
  const size = SUN_PATH[platform];
  if (size === undefined) throw new IpcError('sentinel.ipc.platformUnsupported', platform);
  return size - 1;
}

export const fitsSocketPath = (path: string, platform: string = process.platform) =>
  Buffer.byteLength(path, 'utf8') <= socketPathLimit(platform);

function assertPrivateDir(path: string, st: Stats): void {
  if (st.isSymbolicLink() || !st.isDirectory()) throw new IpcError('sentinel.ipc.runtimeDirUnsafe', 'not a real folder');
  if (UID !== undefined && st.uid !== UID) throw new IpcError('sentinel.ipc.runtimeDirUnsafe', 'owned by another user');
  if ((st.mode & 0o077) !== 0) throw new IpcError('sentinel.ipc.runtimeDirUnsafe', 'open to other users');
  void path;
}

export interface RuntimeAddress {
  /** The private folder holding the socket. */
  readonly dir: string;
  readonly socket: string;
}

/** A usable base folder from the environment: absolute, canonical, a real folder. */
function baseOf(value: string | undefined): string | undefined {
  if (!value || !isAbsolute(value)) return undefined;
  try {
    const real = realpathSync.native(value);
    const st = lstatSync(real);
    return st.isDirectory() && !st.isSymbolicLink() ? real : undefined;
  } catch { return undefined; }
}

/**
 * Chooses (creating if needed) the private runtime folder and socket path for one store owner. Deterministic under a
 * base that fits; otherwise a new unpredictable folder under /tmp, which the store descriptor then records.
 */
export function runtimeAddress(options: { storePath: string; ownerNonce: string; env?: NodeJS.ProcessEnv; platform?: string }): RuntimeAddress {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const key = createHash('sha256').update(`${options.storePath}\u0000${options.ownerNonce}`).digest('hex').slice(0, 16);
  for (const base of [baseOf(env.XDG_RUNTIME_DIR), baseOf(env.TMPDIR)]) {
    if (!base) continue;
    const dir = join(base, `fss-${key}`);
    const socket = join(dir, 's');
    if (!fitsSocketPath(socket, platform)) continue;
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') continue;
    }
    assertPrivateDir(dir, lstatSync(dir));
    return Object.freeze({ dir, socket });
  }
  const tmp = baseOf('/tmp');
  if (!tmp) throw new IpcError('sentinel.ipc.runtimeDirUnsafe', 'no usable temporary folder');
  const dir = mkdtempSync(join(tmp, 'fss-'));
  chmodSync(dir, 0o700);
  assertPrivateDir(dir, lstatSync(dir));
  const socket = join(dir, 's');
  if (!fitsSocketPath(socket, platform)) throw new IpcError('sentinel.ipc.pathTooLong', `${Buffer.byteLength(socket)} bytes`);
  return Object.freeze({ dir, socket });
}

/** Checks a recorded address before it is used: its folder private and ours, its length within the platform's. */
export function checkAddress(address: RuntimeAddress, platform: string = process.platform): void {
  if (!fitsSocketPath(address.socket, platform)) throw new IpcError('sentinel.ipc.pathTooLong', `${Buffer.byteLength(address.socket)} bytes`);
  if (join(address.dir, 's') !== address.socket) throw new IpcError('sentinel.ipc.socketUnsafe', 'the socket is not in its runtime folder');
  let st: Stats;
  try { st = lstatSync(address.dir); } catch { throw new IpcError('sentinel.ipc.notListening', 'no runtime folder'); }
  assertPrivateDir(address.dir, st);
}

function socketStat(path: string): Stats | undefined {
  try { return lstatSync(path); } catch { return undefined; }
}

function assertOwnSocket(st: Stats): void {
  if (!st.isSocket()) throw new IpcError('sentinel.ipc.socketUnsafe', 'not a socket');
  if (UID !== undefined && st.uid !== UID) throw new IpcError('sentinel.ipc.socketUnsafe', 'owned by another user');
  if ((st.mode & 0o077) !== 0) throw new IpcError('sentinel.ipc.socketUnsafe', 'open to other users');
}

// ---- frames ----

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new IpcError('sentinel.ipc.frameTooLarge', `${body.length} bytes`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into frames, holding at most one partial frame (bounded by MAX_FRAME_BYTES). */
export class FrameDecoder {
  #buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer | string): unknown[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, bytes]) : bytes;
    const out: unknown[] = [];
    while (this.#buf.length >= 4) {
      const n = this.#buf.readUInt32BE(0);
      if (n > MAX_FRAME_BYTES) throw new IpcError('sentinel.ipc.frameTooLarge', `${n} bytes`);
      if (this.#buf.length < 4 + n) break;
      const body = this.#buf.subarray(4, 4 + n);
      this.#buf = this.#buf.subarray(4 + n);
      try { out.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))); } catch {
        throw new IpcError('sentinel.ipc.frameMalformed');
      }
    }
    if (this.#buf.length > 4 + MAX_FRAME_BYTES) throw new IpcError('sentinel.ipc.frameTooLarge');
    return out;
  }
}

// ---- handshake and service ----

/** The client kinds a product entrypoint identifies itself as. Each maps to a fixed requester. */
export type ClientKind = 'cli' | 'mcp' | 'http-bridge';
const GRANTS: Readonly<Record<ClientKind, RequestedBy>> = Object.freeze({
  // The owner's command line talks to its own service as the owner; the channel stays the CLI's.
  'cli': Object.freeze({ principal: 'human', channel: 'owner-cli' }),
  'mcp': Object.freeze({ principal: 'agent', channel: 'mcp' }),
  'http-bridge': Object.freeze({ principal: 'agent', channel: 'http-bridge' }),
});

export interface ServiceIdentity {
  readonly storeId: string;
  readonly ownerNonce: string;
}

export interface ServiceRequest { readonly id: number; readonly op: string; readonly body: unknown }
export type ServiceHandler = (op: string, body: unknown, by: RequestedBy) => Promise<unknown>;

export interface OwnerSocket {
  readonly address: RuntimeAddress;
  close(): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Listens on the owner socket. A stale socket of ours is replaced; a live one, or anything that is not ours,
 * refuses. Each connection must open with a hello naming its client kind; the reply carries this service's identity.
 * Requests then run with the requester that kind maps to, and a body naming a requester is refused.
 */
export async function listenOwnerSocket(address: RuntimeAddress, identity: ServiceIdentity, handler: ServiceHandler): Promise<OwnerSocket> {
  checkAddress(address);
  const existing = socketStat(address.socket);
  if (existing) {
    assertOwnSocket(existing);
    if (await answers(address.socket)) throw new IpcError('sentinel.ipc.socketInUse');
    unlinkSync(address.socket); // ours, and nothing listens: stale
  }
  const server: Server = createServer(socket => serveConnection(socket, identity, handler));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address.socket, () => { server.off('error', reject); resolve(); });
  });
  chmodSync(address.socket, 0o600);
  assertOwnSocket(lstatSync(address.socket));
  return Object.freeze({
    address,
    close: () => new Promise<void>(resolve => server.close(() => {
      try { if (socketStat(address.socket)?.isSocket()) unlinkSync(address.socket); } catch { /* already gone */ }
      resolve();
    })),
  });
}

function answers(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect(path);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

function serveConnection(socket: Socket, identity: ServiceIdentity, handler: ServiceHandler): void {
  const decoder = new FrameDecoder();
  let by: RequestedBy | undefined;
  const send = (v: unknown) => { if (!socket.destroyed) socket.write(encodeFrame(v)); };
  const refuse = (code: string) => { send({ type: 'error', code }); socket.end(); };
  socket.on('data', chunk => {
    let frames: unknown[];
    try { frames = decoder.push(chunk); } catch (e) { refuse(e instanceof IpcError ? e.code : 'sentinel.ipc.frameMalformed'); return; }
    for (const f of frames) {
      if (!isRecord(f)) { refuse('sentinel.ipc.frameMalformed'); return; }
      if (!by) {
        if (f.protocol !== SERVICE_PROTOCOL || f.type !== 'hello' || typeof f.client !== 'string' || !Object.hasOwn(GRANTS, f.client)) {
          refuse('sentinel.ipc.handshakeMismatch');
          return;
        }
        // The hello names a client kind and nothing else: any requester claim in it is refused too.
        try { refuseActorClaims({ ...f, client: undefined }); } catch (e) { refuse((e as ActorError).code); return; }
        by = GRANTS[f.client as ClientKind];
        send({ protocol: SERVICE_PROTOCOL, type: 'welcome', storeId: identity.storeId, ownerNonce: identity.ownerNonce });
        continue;
      }
      const id = typeof f.id === 'number' && Number.isSafeInteger(f.id) ? f.id : undefined;
      if (id === undefined || typeof f.op !== 'string' || f.type !== 'request') { refuse('sentinel.ipc.frameMalformed'); return; }
      const granted = by;
      Promise.resolve()
        .then(() => handler(f.op as string, refuseActorClaims(f.body), granted))
        .then(value => send({ type: 'response', id, ok: true, value }),
          error => send({ type: 'response', id, ok: false, code: typeof error?.code === 'string' ? error.code : 'sentinel.ipc.requestFailed' }));
    }
  });
  socket.on('error', () => socket.destroy());
}

export interface ServiceClient {
  request(op: string, body: unknown): Promise<unknown>;
  close(): void;
}

/**
 * Connects to a recorded address as `client`, after checking the folder and the socket are ours and private, and
 * proceeds only when the service's welcome names the store and owner nonce the caller expects.
 */
export async function connectOwnerSocket(address: RuntimeAddress, expect: ServiceIdentity, client: ClientKind): Promise<ServiceClient> {
  checkAddress(address);
  const st = socketStat(address.socket);
  if (!st) throw new IpcError('sentinel.ipc.notListening');
  assertOwnSocket(st);
  const socket = connect(address.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', e => reject(new IpcError('sentinel.ipc.notListening', (e as NodeJS.ErrnoException).code ?? '')));
  });
  const decoder = new FrameDecoder();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let welcomed: ((ok: boolean) => void) | undefined;
  const welcome = new Promise<boolean>(r => { welcomed = r; });
  socket.on('data', chunk => {
    let frames: unknown[];
    try { frames = decoder.push(chunk); } catch { socket.destroy(); return; }
    for (const f of frames) {
      if (!isRecord(f)) continue;
      if (f.type === 'welcome') {
        welcomed?.(f.protocol === SERVICE_PROTOCOL && f.storeId === expect.storeId && f.ownerNonce === expect.ownerNonce);
        welcomed = undefined;
      } else if (f.type === 'response' && typeof f.id === 'number' && pending.has(f.id)) {
        const p = pending.get(f.id)!;
        pending.delete(f.id);
        if (f.ok === true) p.resolve(f.value); else p.reject(new IpcError(String(f.code ?? 'sentinel.ipc.requestFailed') as IpcErrorCode));
      } else if (f.type === 'error') {
        welcomed?.(false);
        welcomed = undefined;
      }
    }
  });
  socket.on('close', () => {
    welcomed?.(false);
    for (const p of pending.values()) p.reject(new IpcError('sentinel.ipc.notListening', 'connection closed'));
    pending.clear();
  });
  socket.write(encodeFrame({ protocol: SERVICE_PROTOCOL, type: 'hello', client }));
  if (!(await welcome)) { socket.destroy(); throw new IpcError('sentinel.ipc.handshakeMismatch'); }
  let next = 1;
  return Object.freeze({
    request(op: string, body: unknown): Promise<unknown> {
      refuseActorClaims(body);
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(encodeFrame({ type: 'request', id, op, body }));
      });
    },
    close: () => socket.destroy(),
  });
}

/** A fresh, unpredictable owner nonce for one acquisition (recorded in the store descriptor beside the address). */
export const newOwnerNonce = () => randomBytes(16).toString('hex');
