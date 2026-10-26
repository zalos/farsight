// One bounded HTTP exchange with an approved provider origin (PR 21). Built on node:http/https directly so every
// property is explicit: the URL is the binding's origin plus a fixed provider path and is re-checked; no redirect is
// followed (any 3xx is refused); no proxy, agent pool or environment TLS override applies (certificates are always
// verified); the request is size-checked before it is sent; the response is read to a byte cap and discarded past it;
// one deadline covers connect to last byte; a caller signal cancels. Errors carry a code and whether the request may
// have reached the provider, never a body, header, credential or provider error text.
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Secret } from './credentials.js';
import { ProviderError, fail, type Spend } from './errors.js';

export interface Exchange {
  readonly origin: string;
  readonly method: 'GET' | 'POST';
  /** A fixed provider path (`/api/chat`), never caller text. */
  readonly path: string;
  readonly body?: Uint8Array;
  readonly credential?: Secret | null;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ExchangeResult {
  readonly status: number;
  readonly json: unknown;
  readonly bytes: number;
}

const PATH = /^\/[A-Za-z0-9/_.-]{1,64}$/;

export function exchange(x: Exchange): Promise<ExchangeResult> {
  if (!PATH.test(x.path)) fail('sentinel.provider.invalidProfile', 'not a provider path');
  const url = new URL(x.path, x.origin);
  if (url.origin !== x.origin || url.pathname !== x.path || url.search || url.hash)
    fail('sentinel.provider.originRefused', 'the request URL left the approved origin');
  if (x.signal?.aborted) fail('sentinel.provider.canceled', 'before sending');
  const https = url.protocol === 'https:';
  const headers: Record<string, string> = {
    accept: 'application/json',
    'accept-encoding': 'identity',
    connection: 'close',
  };
  if (x.body) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(x.body.byteLength);
  }
  if (x.credential) headers.authorization = `Bearer ${x.credential.reveal()}`;

  return new Promise<ExchangeResult>((resolve, reject) => {
    let settled = false;
    // Whether request bytes may have reached the provider: after the (TLS) connection is up, assume they did.
    let reached = false;
    const finish = (error: ProviderError | null, value?: ExchangeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      x.signal?.removeEventListener('abort', onAbort);
      if (error) {
        req.destroy();
        reject(error);
      } else resolve(value!);
    };
    const spend = (): Spend => (reached ? 'possible' : 'none');
    const options = {
      method: x.method,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (https ? 443 : 80),
      path: url.pathname,
      headers,
      agent: false as const,
      ...(https ? { rejectUnauthorized: true, servername: url.hostname } : {}),
    };
    const req = (https ? httpsRequest : httpRequest)(options, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        finish(new ProviderError('sentinel.provider.redirectRefused', `status ${status}`, 'possible'));
        return res.destroy();
      }
      if (status < 200 || status >= 300) {
        finish(new ProviderError('sentinel.provider.httpStatus', `status ${status}`, 'possible'));
        return res.destroy();
      }
      if (!/^application\/json(\s*;|$)/i.test(String(res.headers['content-type'] ?? ''))) {
        finish(new ProviderError('sentinel.provider.malformedResponse', 'not a JSON response', 'possible'));
        return res.destroy();
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > x.maxResponseBytes) {
        finish(new ProviderError('sentinel.provider.responseTooLarge', `declared ${declared} bytes`, 'possible'));
        return res.destroy();
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (c: Buffer) => {
        bytes += c.byteLength;
        if (bytes > x.maxResponseBytes) {
          finish(
            new ProviderError('sentinel.provider.responseTooLarge', `over ${x.maxResponseBytes} bytes`, 'possible'),
          );
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          return finish(new ProviderError('sentinel.provider.malformedResponse', 'the body is not JSON', 'possible'));
        }
        finish(null, { status, json, bytes });
      });
      res.on('error', () =>
        finish(new ProviderError('sentinel.provider.malformedResponse', 'the response ended early', 'possible')),
      );
      res.on('aborted', () =>
        finish(new ProviderError('sentinel.provider.malformedResponse', 'the response ended early', 'possible')),
      );
    });
    req.on('socket', (s) => {
      s.once(https ? 'secureConnect' : 'connect', () => {
        reached = true;
      });
    });
    req.on('error', () =>
      finish(
        new ProviderError(
          reached ? 'sentinel.provider.malformedResponse' : 'sentinel.provider.unreachable',
          reached ? 'the connection failed after the request was sent' : 'no connection',
          spend(),
        ),
      ),
    );
    const timer = setTimeout(
      () => finish(new ProviderError('sentinel.provider.timeout', `after ${x.timeoutMs} ms`, spend())),
      x.timeoutMs,
    );
    const onAbort = () =>
      finish(new ProviderError('sentinel.provider.canceled', reached ? 'after sending' : 'before sending', spend()));
    x.signal?.addEventListener('abort', onAbort, { once: true });
    req.end(x.body ? Buffer.from(x.body) : undefined);
  });
}
