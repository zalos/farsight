import { execFile } from 'node:child_process';

/** Transport only: callers own reference parsing, authorization and error wording. */
export interface KeychainEntry {
  service: string;
  account: string;
}
export type KeychainRunner = (command: string, args: string[]) => Promise<string>;
export interface KeychainOptions {
  platform?: NodeJS.Platform;
  runner?: KeychainRunner;
  timeoutMs?: number;
}
type Command = 'security' | 'secret-tool';
type Failure = 'unsupported' | 'missing-tool' | 'refused' | 'empty';

/** Safe diagnostic metadata only. No cause, stdout, stderr, or resolved value escapes. */
export class KeychainReadError extends Error {
  constructor(
    readonly code: Failure,
    readonly platform: NodeJS.Platform,
    readonly command?: Command,
  ) {
    super(code);
    this.name = 'KeychainReadError';
  }
}

export async function readKeychain(entry: KeychainEntry, options: KeychainOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  let command: Command;
  let args: string[];
  if (platform === 'darwin') {
    command = 'security';
    args = ['find-generic-password', '-s', entry.service, '-a', entry.account, '-w'];
  } else if (platform === 'linux') {
    command = 'secret-tool';
    args = ['lookup', 'service', entry.service, 'account', entry.account];
  } else throw new KeychainReadError('unsupported', platform);

  // Both OS tools print one trailing newline. Preserve the remaining bytes;
  // callers can apply stricter value rules without changing other consumers.
  const run: KeychainRunner =
    options.runner ??
    ((cmd, argv) =>
      new Promise((resolve, reject) => {
        execFile(cmd, argv, { timeout: options.timeoutMs ?? 15_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(String(stdout).replace(/\r?\n$/, ''));
        });
      }));
  let value: string;
  try {
    value = await run(command, args);
  } catch (error) {
    throw new KeychainReadError(
      (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing-tool' : 'refused',
      platform,
      command,
    );
  }
  if (!value) throw new KeychainReadError('empty', platform, command);
  return value;
}
