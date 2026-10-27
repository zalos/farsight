import { KeychainReadError, readKeychain, type KeychainRunner } from '@farsight/core/dist/keychain.js';
import { echoConfigWord } from '@farsight/core/dist/strings-echo-config.js';
import { requireCredentialOrigin } from './trust.js';

export interface KeychainRef {
  service: string;
  account: string;
}

export function parseKeychainRef(ref: unknown): KeychainRef | null {
  if (typeof ref !== 'string' || ref.length > 512 || /[\s\x00-\x1f\x7f]/.test(ref)) return null;
  const match = /^keychain:farsight-echo\/([A-Za-z0-9][A-Za-z0-9._@+-]*)$/.exec(ref);
  return match ? { service: 'farsight-echo', account: match[1]! } : null;
}

export interface SecretOptions {
  platform?: NodeJS.Platform;
  runner?: KeychainRunner;
  origin?: string;
}

/** Resolves only the selected reference; never falls back to inherited process credentials. */
export async function resolveSecret(ref?: string, options: SecretOptions = {}): Promise<string> {
  if (ref === undefined) return '';
  const parsed = parseKeychainRef(ref);
  if (!parsed) throw new Error(echoConfigWord('echo.config.secret'));
  requireCredentialOrigin(ref!, options.origin);
  try {
    const value = await readKeychain(parsed, { ...options, timeoutMs: 10_000 });
    if (!value || /[\r\n]/.test(value)) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof KeychainReadError && error.code === 'unsupported')
      throw new Error(echoConfigWord('echo.secret.platform'));
    throw new Error(echoConfigWord('echo.secret.unavailable'));
  }
}
