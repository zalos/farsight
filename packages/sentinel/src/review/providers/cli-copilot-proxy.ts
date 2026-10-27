// Fixed Copilot authentication/model TLS destinations. It never terminates TLS or sees credential/prompt plaintext.
// It cannot forward another host/port/protocol, resolve a caller name, contact loopback inference, or retry/fallback.
import { createServer, createConnection, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { fail } from './errors.js';
import { COPILOT_DESTINATIONS } from './cli-copilot-profile.js';
import { canonicalDigest } from '../../policy/digest.js';
import type { NativeTiming } from './cli-native-profile.js';

export interface NativeProxyLimits extends NativeTiming {
  readonly maxUpstreamBytes: number;
  readonly maxDownstreamBytes: number;
}
export type NativeProxyEnd = 'open' | 'closed' | 'refused' | 'bounds' | 'unreachable' | 'canceled' | 'deadline';
const hosts = new Set<string>(COPILOT_DESTINATIONS);
const MAX_CONNECTIONS = 12;
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
export function nativeCopilotClientHello(bytes: Uint8Array, host: string): 'incomplete' | 'matched' | 'refused' {
  if (!hosts.has(host)) return 'refused';
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
          b.subarray(at + 5, end).toString('ascii') !== host
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

export async function openNativeCopilotProxy(limits: NativeProxyLimits) {
  const remaining = limits.deadlineAt - Date.now();
  if (limits.signal?.aborted) return fail('sentinel.provider.canceled', 'native egress canceled before listening');
  if (!Number.isSafeInteger(limits.deadlineAt) || remaining <= 0 || remaining > 600_000)
    return fail('sentinel.provider.timeout', 'native egress requires the original bounded deadline');
  for (const cap of [limits.maxUpstreamBytes, limits.maxDownstreamBytes]) {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > WIRE_CEILING)
      return fail('sentinel.provider.invalidProfile', 'native egress byte bounds');
  }
  // Closed structural diagnostics only. Never retain raw headers, unlisted hosts, TLS payloads or auth data.
  const diagnostics: Readonly<Record<string, string | number | boolean>>[] = [];
  const note = (value: Readonly<Record<string, string | number | boolean>>) => {
    if (diagnostics.length < 24) diagnostics.push(Object.freeze({ ...value }));
  };
  const sockets = new Set<Socket>();
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
    source.once('close', () => destination.destroy());
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    own(socket);
    if (!alive() || ++connections > MAX_CONNECTIONS) {
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
      const hostHeaders = lines.slice(1).filter((x) => /^host:/i.test(x));
      const target = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.1$/.exec(lines[0] ?? '');
      const host = target?.[1];
      const publicHost = host && hosts.has(host) ? host : 'unlisted';
      const authorityShape =
        hostHeaders.length === 0
          ? 'missing'
          : hostHeaders.length !== 1
            ? 'multiple'
            : hostHeaders[0]!.replace(/^host:\s*/i, '') === host + ':443'
              ? 'host-port'
              : hostHeaders[0]!.replace(/^host:\s*/i, '') === host
                ? 'host-only'
                : 'other';
      note({
        phase: 'connect',
        target: publicHost,
        ...(host && publicHost === 'unlisted' ? { unlistedTargetDigest: canonicalDigest({ host }) } : {}),
        requestIsConnect: lines[0]?.startsWith('CONNECT ') === true,
        http11: lines[0]?.endsWith(' HTTP/1.1') === true,
        hostHeaders: hostHeaders.length,
        hostShape: authorityShape,
        headerLines: lines.length - 1,
      });
      if (!host) {
        note({ phase: 'refusal', reason: 'connect-target' });
        shutdown('refused');
        return;
      }
      // An unlisted connection has no destination authority. Refuse that socket without DNS
      // or forwarding, while independently validated allowlisted TLS connections retain their original bounds.
      if (!hosts.has(host)) {
        note({ phase: 'refusal', reason: 'connect-target' });
        socket.destroy();
        return;
      }
      const authority = host + ':443';
      if (
        lines[0] !== `CONNECT ${authority} HTTP/1.1` ||
        hostHeaders.length !== 1 ||
        hostHeaders[0]!.replace(/^host:\s*/i, '') !== authority ||
        lines.slice(1).some((x) => !/^[A-Za-z0-9-]+:[\x20-\x7e]*$/.test(x))
      ) {
        note({
          phase: 'refusal',
          reason: authorityShape === 'host-port' ? 'connect-header-syntax' : 'connect-host-shape',
        });
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
        const result = nativeCopilotClientHello(hello, host);
        if (result === 'incomplete') return;
        if (result === 'refused') {
          note({
            phase: 'refusal',
            reason: 'tls-client-hello',
            bytes: hello.length,
            contentType: hello[0] ?? -1,
            recordMajor: hello[1] ?? -1,
            recordMinor: hello[2] ?? -1,
            recordBytes: hello.length >= 5 ? hello.readUInt16BE(3) : -1,
            handshakeType: hello[5] ?? -1,
          });
          shutdown('refused');
          return;
        }
        socket.removeListener('data', readHello);
        socket.pause();
        void lookup(host, { all: true })
          .then((addresses) => {
            if (!alive()) return;
            // One resolved public address, no retry across DNS records and no caller-controlled destination.
            const candidate = addresses.find((x) => isNativePublicAddress(x.address));
            if (!candidate) {
              shutdown('refused');
              return;
            }
            const upstream = own(createConnection({ host: candidate.address, port: 443, family: candidate.family }));
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
      if (alive() && nativeCopilotClientHello(hello, host) === 'incomplete') socket.resume();
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
    observation: () =>
      Object.freeze({
        connections,
        upstreamWireBytes,
        downstreamWireBytes,
        endedBy,
        diagnostics: Object.freeze([...diagnostics]),
      }),
    async close() {
      shutdown('closed');
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
