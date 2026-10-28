// Provider credentials: a `keychain:farsight/<account>` reference resolved in this process, at the moment of a call,
// for the binding it was approved with. The value lives in a Secret that prints, serializes and inspects as redacted;
// errors never carry it or the keychain tool's output. A CredentialSource is the seam: the default reads the OS
// keychain through core's reader (macOS `security`, Linux `secret-tool`), tests pass their own.
import { readKeychain } from '@farsight/core/dist/keychain.js';
import type { KeychainRef } from '../../contracts/index.js';
import { fail } from './errors.js';

const REF = /^keychain:farsight\/([a-z0-9][a-z0-9-]{0,62})$/;
const MAX_SECRET = 8192;

export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  /** The value, for the one header that carries it. */
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[redacted]';
  }
  toJSON(): string {
    return '[redacted]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'Secret([redacted])';
  }
}

/** Resolves one approved reference to its value. Must not fall back to environment variables or files. */
export type CredentialSource = (ref: KeychainRef) => Promise<string>;

/** Runs the OS keychain tool (core's reader runs `security` or `secret-tool`); a test passes its own. */
export type KeychainRunner = (command: string, args: string[]) => Promise<string>;

/** The OS keychain, service `farsight`, account from the reference. */
export function keychainSource(
  options: { runner?: KeychainRunner; platform?: NodeJS.Platform } = {},
): CredentialSource {
  return async (ref) => {
    const m = REF.exec(ref);
    if (!m) return fail('sentinel.provider.credentialUnavailable', 'not a keychain:farsight reference');
    return readKeychain({ service: 'farsight', account: m[1]! }, { ...options, timeoutMs: 10_000 });
  };
}

/** Reads and checks a credential; any failure is one coded error with no cause attached. */
export async function resolveCredential(source: CredentialSource, ref: KeychainRef | null): Promise<Secret | null> {
  if (ref === null) return null;
  if (!REF.test(ref)) return fail('sentinel.provider.credentialUnavailable', 'not a keychain:farsight reference');
  let value: string;
  try {
    value = await source(ref);
  } catch {
    return fail('sentinel.provider.credentialUnavailable', 'the keychain did not return it');
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SECRET ||
    // eslint-disable-next-line no-control-regex -- Credential values must not carry control characters into provider headers.
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('sentinel.provider.credentialUnavailable', 'the stored value is empty, too long or holds control characters');
  }
  return new Secret(value);
}
