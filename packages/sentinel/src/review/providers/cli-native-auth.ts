// Package-private native Claude credential transport. The broker may call the OS reader only after genuine
// admission, consumed disclosure receipt and durable call reservation. This module is not a public provider API.
// It never refreshes, logs in, writes credentials or reads any Claude settings/credential file.
import type { Writable } from 'node:stream';
import { fail, ProviderError } from './errors.js';

const MAX_ITEM_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 8192;
const SCOPES = new Set(['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload',
  'user:plugins', 'user:projects:read', 'user:projects:write', 'org:create_api_key', 'user:ccr_inference']);
const tokens = new WeakMap<object, { bytes: Buffer; expiresAt: number }>();

/** A one-send, redacted token handle. Parsing synthetic bytes grants no launch or admission authority. */
export interface NativeClaudeToken { readonly expiresAt: number }
class Token implements NativeClaudeToken {
  constructor(readonly expiresAt: number) {}
  toJSON() { return '[redacted]'; }
  toString() { return '[redacted]'; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return 'NativeClaudeToken([redacted])'; }
}
function deadline(at: number, signal?: AbortSignal) {
  if (signal?.aborted) fail('sentinel.provider.canceled', 'before native credential use');
  if (!Number.isSafeInteger(at) || at <= Date.now()) fail('sentinel.provider.timeout', 'the original native call deadline elapsed');
}

/** Pure bounded parser, also used by synthetic controls. Raw native JSON and account data are never retained. */
export function parseNativeClaudeToken(item: Uint8Array, deadlineAt: number, signal?: AbortSignal): NativeClaudeToken {
  deadline(deadlineAt, signal);
  if (item.byteLength === 0 || item.byteLength > MAX_ITEM_BYTES) fail('sentinel.provider.credentialUnavailable', 'native keychain item bounds');
  let oauth: any;
  try {
    const parsed = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(item));
    oauth = parsed && Object.hasOwn(parsed, 'claudeAiOauth') ? parsed.claudeAiOauth : null;
  } catch { fail('sentinel.provider.credentialUnavailable', 'native keychain item is not supported JSON'); }
  if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)
    || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0 || Buffer.byteLength(oauth.accessToken) > MAX_TOKEN_BYTES
    || /[^\x21-\x7e]/.test(oauth.accessToken) || !Number.isSafeInteger(oauth.expiresAt) || oauth.expiresAt <= deadlineAt + 5000
    || !Array.isArray(oauth.scopes) || oauth.scopes.length > SCOPES.size || !oauth.scopes.includes('user:inference')
    || new Set(oauth.scopes).size !== oauth.scopes.length
    || oauth.scopes.some((s: unknown) => typeof s !== 'string' || !SCOPES.has(s))) {
    return fail('sentinel.provider.credentialUnavailable', 'native OAuth is missing, expired or outside the qualified scope');
  }
  const handle = Object.freeze(new Token(oauth.expiresAt));
  tokens.set(handle, { bytes: Buffer.from(oauth.accessToken, 'utf8'), expiresAt: oauth.expiresAt });
  return handle;
}

// The fixed no-UI helper is the only native reader; the broker owns admission before that read.

/** Consumes the handle exactly once, delivering only to an already-created owned anonymous descriptor pipe. */
export async function sendNativeClaudeToken(token: NativeClaudeToken, pipe: Writable, deadlineAt: number, signal?: AbortSignal): Promise<void> {
  const held = tokens.get(token);
  if (!held) return fail('sentinel.provider.credentialUnavailable', 'native credential is not held or was already consumed');
  tokens.delete(token);
  try {
    deadline(deadlineAt, signal);
    if (held.expiresAt <= deadlineAt + 5000) return fail('sentinel.provider.credentialUnavailable', 'native credential expires during the admitted call');
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: ProviderError) => {
        if (done) return; done = true;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (error) { pipe.destroy(); reject(error); } else resolve();
      };
      const cancel = () => finish(new ProviderError('sentinel.provider.canceled', 'native descriptor delivery canceled'));
      const timer = setTimeout(() => finish(new ProviderError('sentinel.provider.timeout', 'original native descriptor deadline elapsed')), Math.max(1, deadlineAt - Date.now()));
      signal?.addEventListener('abort', cancel, { once: true });
      pipe.once('error', () => finish(new ProviderError('sentinel.provider.credentialUnavailable', 'native descriptor delivery failed')));
      if (signal?.aborted) { cancel(); return; }
      pipe.end(held.bytes, (error?: Error | null) => finish(error ? new ProviderError('sentinel.provider.credentialUnavailable', 'native descriptor delivery failed') : undefined));
    });
    deadline(deadlineAt, signal);
  } finally { held.bytes.fill(0); }
}

export function discardNativeClaudeToken(token: NativeClaudeToken): void {
  const held = tokens.get(token); tokens.delete(token); held?.bytes.fill(0);
}
