// Package-private, one-connection Claude TLS egress gate. It never terminates TLS or sees OAuth/prompt plaintext.
// It cannot forward another host/port/protocol, resolve a caller name, contact loopback inference, or retry/fallback.
import { createServer, createConnection, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { fail } from './errors.js';
import type { NativeTiming } from './cli-native-profile.js';

export interface NativeProxyLimits extends NativeTiming {
  readonly maxUpstreamBytes: number;
  readonly maxDownstreamBytes: number;
  /**
   * Connections the gate accepts, each to the fixed authority only. Default 1: the brokered turn's one connection,
   * whose close ends the gate. A native run's own loop may open a few in turn; each closes on its own, and one more
   * than this refuses the gate.
   */
  readonly maxConnections?: number;
}
export type NativeProxyEnd = 'open' | 'closed' | 'refused' | 'bounds' | 'unreachable' | 'canceled' | 'deadline';
const HOST = 'api.anthropic.com';
const AUTHORITY = `${HOST}:443`;
const HEADER_LIMIT = 2048;
const WIRE_CEILING = 4 * 1024 * 1024 + 64 * 1024;

/** Public Internet unicast only; DNS identity is still TLS-verified by the pinned CLI with no trust override. */
export function isNativePublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  // No mapped IPv4, local/link-local/multicast or documentation space. Global unicast is 2000::/3.
  return isIP(address) === 6 && /^[23][0-9a-f]{0,3}:/i.test(address) && !/^2001:(db8|0(?::|$))/i.test(address);
}

/** Only the first, complete TLS ClientHello for the fixed authority; no hidden/ECH or alternate SNI. */
export function nativeClaudeClientHello(bytes: Uint8Array): 'incomplete' | 'matched' | 'refused' {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > 16384) return 'refused';
  if (b.length < 5) return 'incomplete';
  const length = b.readUInt16BE(3);
  if (b[0] !== 22 || b[1] !== 3 || b[2]! > 3 || length < 42 || length > 16379) return 'refused';
  if (b.length < 5 + length) return 'incomplete';
  if (b.length !== 5 + length || b[5] !== 1 || b.readUIntBE(6, 3) !== length - 4) return 'refused';
  try {
    let at = 43;
    at += 1 + b.readUInt8(at); // legacy session id
    const ciphers = b.readUInt16BE(at);
    at += 2 + ciphers;
    const compression = b.readUInt8(at);
    at += 1 + compression;
    const extensions = b.readUInt16BE(at);
    at += 2;
    if (at + extensions !== b.length) return 'refused';
    let sni = false;
    while (at < b.length) {
      const kind = b.readUInt16BE(at),
        size = b.readUInt16BE(at + 2);
      at += 4;
      const end = at + size;
      if (end > b.length || kind === 0xfe0d) return 'refused'; // encrypted ClientHello is outside this profile.
      if (kind === 0) {
        if (
          sni ||
          size < 5 ||
          b.readUInt16BE(at) !== size - 2 ||
          b[at + 2] !== 0 ||
          b.readUInt16BE(at + 3) !== size - 5 ||
          b.subarray(at + 5, end).toString('ascii') !== HOST
        )
          return 'refused';
        sni = true;
      }
      at = end;
    }
    return sni ? 'matched' : 'refused';
  } catch {
    return 'refused';
  }
}

export async function openNativeClaudeProxy(limits: NativeProxyLimits) {
  const remaining = limits.deadlineAt - Date.now();
  if (limits.signal?.aborted) return fail('sentinel.provider.canceled', 'native egress canceled before listening');
  if (!Number.isSafeInteger(limits.deadlineAt) || remaining <= 0 || remaining > 600_000)
    return fail('sentinel.provider.timeout', 'native egress requires the original bounded deadline');
  for (const cap of [limits.maxUpstreamBytes, limits.maxDownstreamBytes]) {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > WIRE_CEILING)
      return fail('sentinel.provider.invalidProfile', 'native egress byte bounds');
  }
  const maxConnections = limits.maxConnections ?? 1;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 16)
    return fail('sentinel.provider.invalidProfile', 'native egress connection bound');
  const sockets = new Set<Socket>();
  /** A client socket and the upstream it relays to, so a closed connection ends only its own pair. */
  const pairs = new Map<Socket, Socket>();
  let connections = 0,
    upstreamWireBytes = 0,
    downstreamWireBytes = 0,
    endedBy: NativeProxyEnd = 'open',
    closed = false;
  let ready = false;
  const shutdown = (reason: NativeProxyEnd) => {
    if (closed) return;
    closed = true;
    endedBy = reason;
    clearTimeout(timer);
    limits.signal?.removeEventListener('abort', abort);
    for (const socket of sockets) socket.destroy();
    if (ready) server.close();
  };
  const abort = () => shutdown('canceled');
  const alive = () => {
    if (closed) return false;
    if (limits.signal?.aborted) {
      shutdown('canceled');
      return false;
    }
    if (Date.now() >= limits.deadlineAt) {
      shutdown('deadline');
      return false;
    }
    return true;
  };
  const own = (s: Socket) => {
    sockets.add(s);
    s.on('error', () => shutdown('unreachable'));
    s.once('close', () => {
      sockets.delete(s);
      if (closed) return;
      if (maxConnections === 1) return shutdown('closed');
      // Several connections: a closed socket ends its own pair, never the gate.
      for (const [client, upstream] of pairs)
        if (client === s || upstream === s) {
          pairs.delete(client);
          client.destroy();
          upstream.destroy();
        }
    });
    return s;
  };
  const relay = (source: Socket, destination: Socket, upstream: boolean) => {
    source.on('data', (data: Buffer) => {
      if (!alive()) return;
      if (upstream) upstreamWireBytes += data.byteLength;
      else downstreamWireBytes += data.byteLength;
      if (upstreamWireBytes > limits.maxUpstreamBytes || downstreamWireBytes > limits.maxDownstreamBytes) {
        shutdown('bounds');
        return;
      }
      if (!destination.write(data)) source.pause();
    });
    destination.on('drain', () => {
      if (alive()) source.resume();
    });
    source.once('end', () => destination.end());
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    own(socket);
    if (!alive() || ++connections > maxConnections) {
      shutdown('refused');
      return;
    }
    let header = Buffer.alloc(0);
    const readHeader = (chunk: Buffer) => {
      if (!alive()) return;
      header = Buffer.concat([header, chunk]);
      const split = header.indexOf('\r\n\r\n');
      if ((split < 0 && header.length > HEADER_LIMIT) || split > HEADER_LIMIT) {
        shutdown('bounds');
        return;
      }
      if (split < 0) return;
      socket.removeListener('data', readHeader);
      socket.pause();
      const lines = header.subarray(0, split).toString('ascii').split('\r\n');
      const hosts = lines.slice(1).filter((x) => /^host:/i.test(x));
      if (
        lines[0] !== `CONNECT ${AUTHORITY} HTTP/1.1` ||
        hosts.length !== 1 ||
        hosts[0]!.replace(/^host:\s*/i, '') !== AUTHORITY ||
        lines.slice(1).some((x) => !/^[A-Za-z0-9-]+:[\x20-\x7e]*$/.test(x))
      ) {
        shutdown('refused');
        return;
      }
      const head = Buffer.from(header.subarray(split + 4));
      header = Buffer.alloc(0);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let hello = Buffer.alloc(0);
      const readHello = (chunk: Buffer) => {
        if (!alive()) return;
        if (hello.length + chunk.length > 16384) {
          shutdown('bounds');
          return;
        }
        hello = Buffer.concat([hello, chunk]);
        const result = nativeClaudeClientHello(hello);
        if (result === 'incomplete') return;
        if (result === 'refused') {
          shutdown('refused');
          return;
        }
        socket.removeListener('data', readHello);
        socket.pause();
        void lookup(HOST, { all: true })
          .then((addresses) => {
            if (!alive()) return;
            // One resolved public address, no retry across DNS records and no caller-controlled destination.
            const candidate = addresses.find((x) => isNativePublicAddress(x.address));
            if (!candidate) {
              shutdown('refused');
              return;
            }
            const upstream = own(createConnection({ host: candidate.address, port: 443, family: candidate.family }));
            pairs.set(socket, upstream);
            upstream.once('connect', () => {
              if (!alive()) return;
              relay(socket, upstream, true);
              relay(upstream, socket, false);
              if (hello.length) {
                upstreamWireBytes += hello.length;
                if (upstreamWireBytes > limits.maxUpstreamBytes) {
                  shutdown('bounds');
                  return;
                }
                if (!upstream.write(hello))
                  upstream.once('drain', () => {
                    if (alive()) socket.resume();
                  });
                else socket.resume();
              } else socket.resume();
            });
          })
          .catch(() => shutdown('unreachable'));
      };
      socket.on('data', readHello);
      if (head.length) readHello(head);
      if (alive() && nativeClaudeClientHello(hello) === 'incomplete') socket.resume();
    };
    socket.on('data', readHeader);
  });
  const timer = setTimeout(() => shutdown('deadline'), remaining);
  limits.signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        ready = true;
        resolve();
      });
    });
    if (!alive()) {
      server.close();
      return fail(
        limits.signal?.aborted ? 'sentinel.provider.canceled' : 'sentinel.provider.timeout',
        'native egress closed during setup',
      );
    }
  } catch {
    shutdown('unreachable');
    return fail('sentinel.provider.unreachable', 'owned native egress listener unavailable');
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    shutdown('unreachable');
    return fail('sentinel.provider.unreachable', 'owned native egress listener unavailable');
  }
  return Object.freeze({
    port: address.port,
    observation: () => Object.freeze({ connections, upstreamWireBytes, downstreamWireBytes, endedBy }),
    async close() {
      shutdown('closed');
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
