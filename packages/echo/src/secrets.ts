import { execFile } from 'node:child_process';
import { echoConfigWord } from '@farsight/core/dist/strings-echo-config.js';
import { requireCredentialOrigin } from './trust.js';

export interface KeychainRef { service: string; account: string }

export function parseKeychainRef(ref: unknown): KeychainRef | null {
  if (typeof ref !== 'string' || ref.length > 512 || /[\s\x00-\x1f\x7f]/.test(ref)) return null;
  const match = /^keychain:farsight-echo\/([A-Za-z0-9][A-Za-z0-9._@+-]*)$/.exec(ref);
  return match ? { service: 'farsight-echo', account: match[1]! } : null;
}

type Runner = (command: string, args: string[]) => Promise<string>;
export interface SecretOptions { platform?: NodeJS.Platform; runner?: Runner; origin?: string }

const run: Runner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
    if (error) reject(new Error(echoConfigWord('echo.secret.unavailable')));
    else resolve(String(stdout).replace(/\r?\n$/, ''));
  });
});

/** Resolves only the selected reference; never falls back to inherited process credentials. */
export async function resolveSecret(ref?: string, options: SecretOptions = {}): Promise<string> {
  if (ref === undefined) return '';
  const parsed = parseKeychainRef(ref);
  if (!parsed) throw new Error(echoConfigWord('echo.config.secret'));
  requireCredentialOrigin(ref!, options.origin);
  const platform = options.platform ?? process.platform;
  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'security';
    args = ['find-generic-password', '-s', parsed.service, '-a', parsed.account, '-w'];
  } else if (platform === 'linux') {
    command = 'secret-tool';
    args = ['lookup', 'service', parsed.service, 'account', parsed.account];
  } else throw new Error(echoConfigWord('echo.secret.platform'));
  try {
    const value = await (options.runner ?? run)(command, args);
    if (!value || /[\r\n]/.test(value)) throw new Error();
    return value;
  } catch {
    throw new Error(echoConfigWord('echo.secret.unavailable'));
  }
}
