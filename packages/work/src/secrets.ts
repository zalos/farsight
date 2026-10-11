// Secret references → values, in this process only (the owner, 2026-09-30:
// secrets live in the keychain; the tool reads them itself and prints only
// outcomes). A resolved value is returned to the caller and nowhere else: it
// is never logged, never put in an error message, never written to disk.
// Errors name the REFERENCE (`keychain:farsight/jira-example`), not the value.
//
//   keychain:<service>/<account>   macOS `security`, Linux `secret-tool`
//   env:<NAME>                     the process environment (tests, CI)
import { KeychainReadError, readKeychain, type KeychainRunner } from '@farsight/core/dist/keychain.js';

/** A reference could not be resolved. `message` names the ref and why — never a value. */
export class SecretUnavailable extends Error {
  constructor(readonly ref: string, readonly why: string) {
    super(`secret ${ref} unavailable: ${why}`);
    this.name = 'SecretUnavailable';
  }
}

export interface KeychainRef { service: string; account: string }

/** Parse `keychain:<service>/<account>`; the account is everything after the LAST slash. */
export function parseKeychainRef(ref: string): KeychainRef | null {
  const m = /^keychain:(.+)\/([^/]+)$/.exec(ref);
  return m ? { service: m[1]!, account: m[2]! } : null;
}

/** True when a settings value is a secret reference rather than a literal. */
export function isSecretRef(value: string | undefined): boolean {
  return typeof value === 'string' && /^(keychain|env):/.test(value);
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** injectable for tests; defaults to execFile */
  runner?: KeychainRunner;
}

export async function resolveSecret(ref: string, opts: ResolveOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const value = name ? env[name] : undefined;
    if (!value) throw new SecretUnavailable(ref, 'the environment variable is not set');
    return value;
  }
  if (ref.startsWith('keychain:')) {
    const k = parseKeychainRef(ref);
    if (!k) throw new SecretUnavailable(ref, 'expected keychain:<service>/<account>');
    try {
      return await readKeychain(k, opts);
    } catch (error) {
      if (error instanceof KeychainReadError) {
        if (error.code === 'unsupported') throw new SecretUnavailable(ref, error.platform === 'win32'
          ? 'the Windows credential store (DPAPI) is not built yet' : `no keychain support on ${error.platform}`);
        if (error.code === 'missing-tool') throw new SecretUnavailable(ref, `${error.command} is not installed`);
        if (error.code === 'empty') throw new SecretUnavailable(ref, 'the keychain entry is empty');
      }
      throw new SecretUnavailable(ref, 'not found in the keychain, or access was refused');
    }
  }
  // not a reference: it may BE a pasted secret, so it is never echoed
  throw new SecretUnavailable('(a literal value)', 'not a secret reference (expected keychain: or env:) — secrets never go in settings');
}

/** Resolve a value that may be a reference or a literal (e.g. `auth.user`). */
export async function resolveMaybeSecret(value: string | undefined, opts: ResolveOptions = {}): Promise<string | undefined> {
  if (value === undefined) return undefined;
  return isSecretRef(value) ? resolveSecret(value, opts) : value;
}
