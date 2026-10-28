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
import type { ServiceGrant } from '../cli/actor.js';
import { refuseActorClaims, requestedByOf, ActorError } from '../cli/actor.js';

export const SERVICE_PROTOCOL = 'sentinel-service/draft-1';
/** Each frame is a 4-byte big-endian length then that many bytes of UTF-8 JSON. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** `sun_path` sizes, terminator included. Any other platform has no qualified socket length and is refused. */
const SUN_PATH: Readonly<Record<string, number>> = { darwin: 104, linux: 108 };

export type IpcErrorCode =
  | 'sentinel.ipc.platformUnsupported'
  | 'sentinel.ipc.pathTooLong'
  | 'sentinel.ipc.runtimeDirUnsafe'
  | 'sentinel.ipc.socketUnsafe'
  | 'sentinel.ipc.socketInUse'
  | 'sentinel.ipc.frameTooLarge'
  | 'sentinel.ipc.frameMalformed'
  | 'sentinel.ipc.handshakeMismatch'
  | 'sentinel.ipc.notListening'
  | 'sentinel.ipc.timeout'
  | 'sentinel.ipc.canceled'
  | 'sentinel.ipc.socketIndeterminate'
  | 'sentinel.ipc.runtimeDirInsideSource';

export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    readonly detail = '',
  ) {
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
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new IpcError('sentinel.ipc.runtimeDirUnsafe', 'not a real folder');
  if (UID !== undefined && st.uid !== UID) throw new IpcError('sentinel.ipc.runtimeDirUnsafe', 'owned by another user');
  if ((st.mode & 0o077) !== 0) throw new IpcError('sentinel.ipc.runtimeDirUnsafe', 'open to other users');
  void path;
}

export interface RuntimeAddress {
  /** The private folder holding the socket. */
  readonly dir: string;
  readonly socket: string;
}

/** True when canonical `inner` is `outer` or below it. */
const within = (inner: string, outer: string) =>
  inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`);

/** A usable base folder from the environment: absolute, canonical, a real folder. */
function baseOf(value: string | undefined): string | undefined {
  if (!value || !isAbsolute(value)) return undefined;
  try {
    const real = realpathSync.native(value);
    const st = lstatSync(real);
    return st.isDirectory() && !st.isSymbolicLink() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Chooses (creating if needed) the private runtime folder and socket path for one store owner. Deterministic under a
 * base that fits; otherwise a new unpredictable folder under /tmp, which the store descriptor then records.
 */
export function runtimeAddress(options: {
  storePath: string;
  ownerNonce: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** The canonical roots the owner captures: the runtime folder is never made inside one. */
  sources?: readonly string[];
}): RuntimeAddress {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const sources = options.sources ?? [];
  const key = createHash('sha256').update(`${options.storePath}\u0000${options.ownerNonce}`).digest('hex').slice(0, 16);
  // Each candidate in order, checked before anything is made. A selected folder that would sit inside a captured
  // source is refused, never quietly replaced by another; a candidate whose socket path is too long falls through.
  for (const base of [baseOf(env.XDG_RUNTIME_DIR), baseOf(env.TMPDIR)]) {
    if (!base) continue;
    const dir = join(base, `fss-${key}`);
    if (sources.some((s) => within(dir, s) || within(s, dir)))
      throw new IpcError('sentinel.ipc.runtimeDirInsideSource', dir);
    const socket = join(dir, 's');
    if (!fitsSocketPath(socket, platform)) continue;
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') continue;
    }
    assertPrivateDir(dir, lstatSync(dir));
    return Object.freeze({ dir, socket });
  }
  const tmp = baseOf('/tmp');
  if (!tmp) throw new IpcError('sentinel.ipc.runtimeDirUnsafe', 'no usable temporary folder');
  // A fresh child of /tmp is inside a source only when /tmp itself is (a source under /tmp gets a new sibling).
  if (sources.some((s) => within(tmp, s))) throw new IpcError('sentinel.ipc.runtimeDirInsideSource', tmp);
  const dir = mkdtempSync(join(tmp, 'fss-'));
  chmodSync(dir, 0o700);
  assertPrivateDir(dir, lstatSync(dir));
  const socket = join(dir, 's');
  if (!fitsSocketPath(socket, platform))
    throw new IpcError('sentinel.ipc.pathTooLong', `${Buffer.byteLength(socket)} bytes`);
  return Object.freeze({ dir, socket });
}

/** Checks a recorded address before it is used: its folder private and ours, its length within the platform's. */
export function checkAddress(address: RuntimeAddress, platform: string = process.platform): void {
  if (!fitsSocketPath(address.socket, platform))
    throw new IpcError('sentinel.ipc.pathTooLong', `${Buffer.byteLength(address.socket)} bytes`);
  if (join(address.dir, 's') !== address.socket)
    throw new IpcError('sentinel.ipc.socketUnsafe', 'the socket is not in its runtime folder');
  let st: Stats;
  try {
    st = lstatSync(address.dir);
  } catch {
    throw new IpcError('sentinel.ipc.notListening', 'no runtime folder');
  }
  assertPrivateDir(address.dir, st);
}

function socketStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
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
      try {
        out.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
      } catch {
        throw new IpcError('sentinel.ipc.frameMalformed');
      }
    }
    if (this.#buf.length > 4 + MAX_FRAME_BYTES) throw new IpcError('sentinel.ipc.frameTooLarge');
    return out;
  }
}

// ---- handshake and service ----

/**
 * The client kinds a product entrypoint identifies itself as. A kind only labels the channel a connection is
 * recorded under: every one is a non-owner agent, so no hello can select owner authority. The owner's CLI is a
 * `local-service` client like any other; owner authority travels only as a receipt its own process minted.
 */
export type ClientKind = 'cli' | 'mcp' | 'http-bridge' | 'owner-ui';
const GRANTS: Readonly<Record<ClientKind, ServiceGrant>> = Object.freeze({
  'cli': Object.freeze({ principal: 'agent', channel: 'local-service' }),
  'mcp': Object.freeze({ principal: 'agent', channel: 'mcp' }),
  'owner-ui': Object.freeze({ principal: 'agent', channel: 'owner-ui' }),
  'http-bridge': Object.freeze({ principal: 'agent', channel: 'http-bridge' }),
});

export interface ServiceIdentity {
  readonly storeId: string;
  readonly ownerNonce: string;
}

export interface ServiceRequest {
  readonly id: number;
  readonly op: string;
  readonly body: unknown;
}
export type ServiceHandler = (
  op: string,
  body: unknown,
  by: ReturnType<typeof requestedByOf>,
  context?: { readonly signal: AbortSignal },
) => Promise<unknown>;

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
export interface ListenOptions {
  /** Test seam: how the existing socket is probed. Production uses node:net's connect. */
  readonly connect?: (path: string) => Socket;
}

export async function listenOwnerSocket(
  address: RuntimeAddress,
  identity: ServiceIdentity,
  handler: ServiceHandler,
  options: ListenOptions = {},
): Promise<OwnerSocket> {
  checkAddress(address);
  const existing = socketStat(address.socket);
  if (existing) {
    assertOwnSocket(existing);
    const probe = await probeSocket(address.socket, options.connect ?? connect);
    if (probe === 'live') throw new IpcError('sentinel.ipc.socketInUse');
    // Only a refused connection (or a vanished name) proves nothing listens. Any other error (EMFILE, EACCES, a
    // timeout) says nothing about the service, so its socket is left exactly as it is.
    if (probe !== 'stale') throw new IpcError('sentinel.ipc.socketIndeterminate', probe.slice('unknown:'.length));
    // Removed only if the name is still the very socket that refused, not one a new service bound meanwhile.
    const now = socketStat(address.socket);
    if (now) {
      if (!now.isSocket() || now.dev !== existing.dev || now.ino !== existing.ino)
        throw new IpcError('sentinel.ipc.socketIndeterminate', 'the socket changed while it was checked');
      unlinkSync(address.socket);
    }
  }
  const accepted = new Set<Socket>();
  let closing = false;
  const server: Server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
    serveConnection(socket, identity, handler);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address.socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(address.socket, 0o600);
  assertOwnSocket(lstatSync(address.socket));
  return Object.freeze({
    address,
    close: () =>
      new Promise<void>((resolve) => {
        closing = true;
        server.close(() => {
          try {
            if (socketStat(address.socket)?.isSocket()) unlinkSync(address.socket);
          } catch {
            /* already gone */
          }
          resolve();
        });
        // These sockets were accepted by this listener only. A connected idle reader cannot retain the owner
        // after its buffers expire; service.stop has already waited for accepted run tasks to settle.
        for (const socket of accepted) socket.destroy();
      }),
  });
}

/** `live` when something accepts, `stale` only on a refused connection or a missing name, else `unknown:<code>`. */
function probeSocket(path: string, open: (path: string) => Socket): Promise<'live' | 'stale' | `unknown:${string}`> {
  return new Promise((resolve) => {
    let s: Socket;
    try {
      s = open(path);
    } catch (e) {
      resolve(`unknown:${(e as NodeJS.ErrnoException).code ?? 'error'}`);
      return;
    }
    const timer = setTimeout(() => {
      s.destroy();
      resolve('unknown:ETIMEDOUT');
    }, 2000);
    s.once('connect', () => {
      clearTimeout(timer);
      s.destroy();
      resolve('live');
    });
    s.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? 'stale' : `unknown:${e.code ?? 'error'}`);
    });
  });
}

function serveConnection(socket: Socket, identity: ServiceIdentity, handler: ServiceHandler): void {
  const decoder = new FrameDecoder();
  // Cancellation addresses only this socket's unsettled new read preparation. No run control is canceled here.
  const reads = new Map<number, AbortController>();
  const inflight = new Set<number>();
  let by: ReturnType<typeof requestedByOf> | undefined;
  // One connection's failure never reaches the daemon: an unencodable value (too large, not JSON) becomes a bounded,
  // typed error for that request, and a write to a closed connection is dropped.
  const send = (v: unknown) => {
    if (socket.destroyed) return;
    let frame: Buffer;
    try {
      frame = encodeFrame(v);
    } catch (e) {
      const id = isRecord(v) ? v.id : undefined;
      try {
        frame = encodeFrame({
          type: 'response',
          id,
          ok: false,
          code: e instanceof IpcError ? e.code : 'sentinel.ipc.frameMalformed',
        });
      } catch {
        socket.destroy();
        return;
      }
    }
    try {
      socket.write(frame);
    } catch {
      socket.destroy();
    }
  };
  const refuse = (code: string) => {
    send({ type: 'error', code });
    socket.end();
  };
  socket.on('data', (chunk) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch (e) {
      refuse(e instanceof IpcError ? e.code : 'sentinel.ipc.frameMalformed');
      return;
    }
    for (const f of frames) {
      if (!isRecord(f)) {
        refuse('sentinel.ipc.frameMalformed');
        return;
      }
      if (!by) {
        if (
          f.protocol !== SERVICE_PROTOCOL ||
          f.type !== 'hello' ||
          typeof f.client !== 'string' ||
          !Object.hasOwn(GRANTS, f.client)
        ) {
          refuse('sentinel.ipc.handshakeMismatch');
          return;
        }
        // The hello names a client kind and nothing else: any requester claim in it is refused too.
        try {
          refuseActorClaims({ ...f, client: undefined });
        } catch (e) {
          refuse((e as ActorError).code);
          return;
        }
        // Through the one actor rule: a service connection is a non-owner, whatever it asked for.
        by = requestedByOf({ kind: 'service-connection', granted: GRANTS[f.client as ClientKind] });
        send({
          protocol: SERVICE_PROTOCOL,
          type: 'welcome',
          storeId: identity.storeId,
          ownerNonce: identity.ownerNonce,
        });
        continue;
      }
      if (f.type === 'cancel') {
        if (Object.keys(f).length !== 2 || typeof f.id !== 'number' || !Number.isSafeInteger(f.id)) {
          refuse('sentinel.ipc.frameMalformed');
          return;
        }
        reads.get(f.id)?.abort();
        continue;
      }
      const id = typeof f.id === 'number' && Number.isSafeInteger(f.id) ? f.id : undefined;
      if (
        id === undefined ||
        typeof f.op !== 'string' ||
        f.type !== 'request' ||
        inflight.has(id) ||
        inflight.size >= 128
      ) {
        refuse('sentinel.ipc.frameMalformed');
        return;
      }
      const granted = by;
      inflight.add(id);
      const read =
        f.op === 'run.inspect' || f.op === 'report.open' || f.op === 'prepare.resume'
          ? new AbortController()
          : undefined;
      if (read) reads.set(id, read);
      Promise.resolve()
        .then(() =>
          handler(f.op as string, refuseActorClaims(f.body), granted, read ? { signal: read.signal } : undefined),
        )
        .then(
          (value) => send({ type: 'response', id, ok: true, value }),
          (error) =>
            send({
              type: 'response',
              id,
              ok: false,
              code:
                typeof error?.code === 'string' && /^sentinel\.[a-zA-Z.]{1,120}$/.test(error.code)
                  ? error.code
                  : 'sentinel.ipc.requestFailed',
            }),
        )
        .catch(() => socket.destroy())
        .finally(() => {
          inflight.delete(id);
          reads.delete(id);
        });
    }
  });
  const abortReads = () => {
    for (const read of reads.values()) read.abort();
  };
  socket.on('end', abortReads); // A peer can finish its read channel before the full socket close event.
  socket.on('close', () => {
    abortReads();
    reads.clear();
  });
  socket.on('error', () => socket.destroy());
}

export interface RequestOptions {
  /** Rejects with `sentinel.ipc.timeout` when no response arrives in time (default 30 s). */
  readonly timeoutMs?: number;
  /** Rejects with `sentinel.ipc.canceled` when aborted. */
  readonly signal?: AbortSignal;
}

export interface ServiceClient {
  /** A closed client rejects at once; every pending request rejects when the connection closes. */
  request(op: string, body: unknown, options?: RequestOptions): Promise<unknown>;
  readonly closed: boolean;
  /** The store the service's welcome named: the one the caller expected, checked before the client existed. */
  readonly storeId: string;
  close(): void;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface ConnectOptions {
  /** Rejects with `sentinel.ipc.timeout` unless the connection is established and welcomed in time (default 5 s). */
  readonly timeoutMs?: number;
  /** Rejects with `sentinel.ipc.canceled` when aborted before the welcome. */
  readonly signal?: AbortSignal;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Connects to a recorded address as `client`, after checking the folder and the socket are ours and private, and
 * proceeds only when the service's welcome names the store and owner nonce the caller expects. One deadline (and the
 * optional signal) covers both the connection and the welcome: a peer that accepts and never answers cannot hold the
 * caller. Whatever ends the handshake, its timer and listeners are removed and, unless it succeeded, only this
 * connection is destroyed; the listening endpoint and its other clients are untouched.
 */
export async function connectOwnerSocket(
  address: RuntimeAddress,
  expect: ServiceIdentity,
  client: ClientKind,
  options: ConnectOptions = {},
): Promise<ServiceClient> {
  checkAddress(address);
  const st = socketStat(address.socket);
  if (!st) throw new IpcError('sentinel.ipc.notListening');
  assertOwnSocket(st);
  if (options.signal?.aborted) throw new IpcError('sentinel.ipc.canceled');
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const socket = connect(address.socket);
  const decoder = new FrameDecoder();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  // The handshake settles exactly once: welcomed, refused, closed, failed, timed out or canceled.
  let settle: ((outcome: true | IpcError) => void) | undefined;
  const handshake = new Promise<true | IpcError>((resolve) => {
    settle = resolve;
  });
  const finish = (outcome: true | IpcError) => {
    const s = settle;
    settle = undefined;
    s?.(outcome);
  };
  const timer = setTimeout(() => finish(new IpcError('sentinel.ipc.timeout', 'no welcome in time')), timeoutMs);
  const onAbort = () => finish(new IpcError('sentinel.ipc.canceled'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  socket.once('connect', () => {
    try {
      socket.write(encodeFrame({ protocol: SERVICE_PROTOCOL, type: 'hello', client }));
    } catch {
      finish(new IpcError('sentinel.ipc.frameMalformed'));
    }
  });
  socket.on('data', (chunk) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const f of frames) {
      if (!isRecord(f)) continue;
      if (f.type === 'welcome') {
        finish(
          f.protocol === SERVICE_PROTOCOL && f.storeId === expect.storeId && f.ownerNonce === expect.ownerNonce
            ? true
            : new IpcError('sentinel.ipc.handshakeMismatch'),
        );
      } else if (f.type === 'response' && typeof f.id === 'number' && pending.has(f.id)) {
        const p = pending.get(f.id)!;
        pending.delete(f.id);
        if (f.ok === true) p.resolve(f.value);
        else p.reject(new IpcError(String(f.code ?? 'sentinel.ipc.requestFailed') as IpcErrorCode));
      } else if (f.type === 'error') {
        finish(new IpcError('sentinel.ipc.handshakeMismatch'));
      }
    }
  });
  let closed = false;
  let connected = false;
  socket.once('connect', () => {
    connected = true;
  });
  socket.on('close', () => {
    closed = true;
    finish(
      new IpcError(connected ? 'sentinel.ipc.handshakeMismatch' : 'sentinel.ipc.notListening', 'connection closed'),
    );
    for (const p of pending.values()) p.reject(new IpcError('sentinel.ipc.notListening', 'connection closed'));
    pending.clear();
  });
  socket.on('error', (e) => {
    if (!connected) finish(new IpcError('sentinel.ipc.notListening', (e as NodeJS.ErrnoException).code ?? ''));
    socket.destroy();
  });
  const outcome = await handshake;
  clearTimeout(timer);
  options.signal?.removeEventListener('abort', onAbort);
  if (outcome !== true) {
    socket.destroy();
    throw outcome;
  }
  let next = 1;
  return Object.freeze({
    request(op: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
      refuseActorClaims(body);
      if (closed || socket.destroyed)
        return Promise.reject(new IpcError('sentinel.ipc.notListening', 'connection closed'));
      if (options.signal?.aborted) return Promise.reject(new IpcError('sentinel.ipc.canceled'));
      const frame = encodeFrame({ type: 'request', id: next, op, body }); // too large: refused before it is pending
      const id = next++;
      const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const settle = (fn: () => void) => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          pending.delete(id);
          fn();
        };
        const cancelRead = () => {
          if ((op === 'run.inspect' || op === 'report.open' || op === 'prepare.resume') && !socket.destroyed) {
            try {
              socket.write(encodeFrame({ type: 'cancel', id }));
            } catch {
              /* connection failure already rejects */
            }
          }
        };
        const timer = setTimeout(() => {
          cancelRead();
          settle(() => reject(new IpcError('sentinel.ipc.timeout')));
        }, timeoutMs);
        const onAbort = () => {
          cancelRead();
          settle(() => reject(new IpcError('sentinel.ipc.canceled')));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, { resolve: (v) => settle(() => resolve(v)), reject: (e) => settle(() => reject(e)) });
        socket.write(frame);
      });
    },
    get closed() {
      return closed || socket.destroyed;
    },
    storeId: expect.storeId,
    close: () => socket.destroy(),
  });
}

/** A fresh, unpredictable owner nonce for one acquisition (recorded in the store descriptor beside the address). */
export const newOwnerNonce = () => randomBytes(16).toString('hex');
