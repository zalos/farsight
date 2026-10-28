// One sandboxed CLI runner for both native model CLIs (Claude Code and Copilot CLI).
//
// What every native call shares lives here and nowhere else: the seatbelt profile's common rows, the fixed shell that
// lowers the core limit and execs `sandbox-exec`, the supervised child process (its own process group, one original
// deadline, cancellation, a bounded stderr, a stdout consumer that may refuse), the read of a file the CLI wrote into
// the owned root, and a bounded transcript capture. Each CLI's wrapper (`cli-copilot-call.ts`, `cli-native-call.ts`)
// supplies only what differs: its rows, argv, environment, child proxy and how it delivers input. The broker alone
// admits, reserves and settles; nothing here grants a call.
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { ProviderError } from './errors.js';
import type { NativeTiming } from './cli-native-profile.js';

/** Fixed shell text only lowers the core limit and execs sandbox-exec; every caller byte is a separate argv entry. */
export const SANDBOX_SHELL = 'ulimit -H -c 0 && ulimit -S -c 0 && exec /usr/bin/sandbox-exec "$@"';

const q = (v: string) => JSON.stringify(v);

/** The seatbelt rows both CLIs start from: deny by default, fork, and exec of the one pinned executable only. */
export function seatbeltHead(executable: string): readonly string[] {
  return ['(version 1)(deny default)', '(allow process-fork)', `(allow process-exec (literal ${q(executable)}))`];
}
export const SEATBELT_PROCESS_INFO =
  '(allow process-info* (target same-sandbox))(allow signal (target same-sandbox))(allow sysctl-read)';
/** The system libraries, the executable itself, the owned root and the three device nodes; nothing under HOME. */
export function seatbeltBaseReads(executable: string, ownedRoot: string): string {
  return `(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple") (literal ${q(executable)}) (subpath ${q(ownedRoot)}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`;
}
export const SEATBELT_DIRECTORY_METADATA = '(allow file-read-metadata (vnode-type DIRECTORY))';
export const SEATBELT_TASK_PORT = '(allow mach-priv-task-port (target same-sandbox))';
/** Logging and directory-service lookups every native CLI needs to start. */
export const SEATBELT_SYSTEM_SERVICES =
  '(global-name "com.apple.logd") (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership")';
export const SEATBELT_DEVICE_IOCTL =
  '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))';
/** The only network the process gets: the owned loopback child proxy. */
export const seatbeltProxyOnly = (proxyPort: number) => `(allow network-outbound (remote ip "localhost:${proxyPort}"))`;
export const seatbelt = (rows: readonly string[]) => rows.join('\n');

/** `/bin/sh` argv for one sandboxed launch: the label names the process in a listing; the policy is argv, not a file. */
export function sandboxArgv(
  label: string,
  policy: string,
  executable: string,
  args: readonly string[],
): readonly string[] {
  return Object.freeze(['-c', SANDBOX_SHELL, label, '-p', policy, executable, ...args]);
}

/** The CLI's name in a refusal's detail; the detail never holds native output. */
export interface SandboxWords {
  readonly canceled: string;
  readonly timeout: string;
  readonly stream: string;
  readonly stderr: string;
  readonly stdin: string;
  readonly unavailable: string;
}

/** What the supervision observed, for a caller's closed diagnostic. */
export interface SandboxedState {
  spawned: boolean;
  pid: number | undefined;
  stderrBytes: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The supervision's own reason when it stopped the process; undefined when the CLI decided its exit. */
  reason: 'canceled' | 'stdin-error' | 'process-error' | undefined;
}

export interface SandboxedLaunch {
  readonly label: string;
  readonly policy: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Extra anonymous pipes after stdio (the Claude token descriptor); default none. */
  readonly extraPipes?: number;
  readonly timing: NativeTiming;
  readonly stderrLimit: number;
  readonly words: SandboxWords;
  /** Each stdout chunk while no failure is recorded; a throw stops the process. */
  readonly onStdout: (bytes: Buffer) => void;
  readonly onStderr?: (bytes: Buffer) => void;
  /** After a spawn inside the deadline: deliver the input. `stop` ends the process group with the first failure. */
  readonly deliver: (child: ChildProcess, control: SandboxControl) => void;
  /** Called once the child exists, before delivery; a caller's diagnostic phase moves here. */
  readonly onSpawned?: () => void;
  /** Bounded retained copy of stdout (the native transcript); omitted for the brokered text path. */
  readonly transcript?: TranscriptCapture;
}

export interface SandboxControl {
  stop(error: ProviderError): void;
  cancel(): void;
  failed(): boolean;
  readonly signal?: AbortSignal;
  readonly deadlineAt: number;
}

/** A bounded, append-only copy of what the CLI printed: the transcript a native stage retains. */
export class TranscriptCapture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;
  constructor(readonly maxBytes: number) {}
  push(bytes: Buffer): void {
    if (this.#truncated) return;
    const room = this.maxBytes - this.#bytes;
    if (bytes.length > room) {
      this.#chunks.push(Buffer.from(bytes.subarray(0, room)));
      this.#bytes = this.maxBytes;
      this.#truncated = true;
      return;
    }
    this.#chunks.push(Buffer.from(bytes));
    this.#bytes += bytes.length;
  }
  get bytes(): number {
    return this.#bytes;
  }
  get truncated(): boolean {
    return this.#truncated;
  }
  content(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

/**
 * Launches one sandboxed CLI in its own process group under the original deadline. Resolves on a close the
 * supervision did not stop (the caller then judges the exit); rejects with the first recorded failure. `state`
 * is filled as the process runs so a failing caller can still report its closed diagnostic.
 */
export function superviseSandboxedCli(launch: SandboxedLaunch, state: SandboxedState): Promise<void> {
  const { timing, words } = launch;
  return new Promise<void>((resolve, reject) => {
    let failure: ProviderError | undefined;
    const child = spawn('/bin/sh', [...sandboxArgv(launch.label, launch.policy, launch.executable, launch.args)], {
      cwd: launch.cwd,
      env: { ...launch.env },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', ...Array<'pipe'>(launch.extraPipes ?? 0).fill('pipe')],
    });
    state.pid = child.pid;
    const stop = (e: ProviderError) => {
      failure ??= e;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* this exact owned group may already have exited */
        }
      }
    };
    const cancel = () => {
      state.reason = 'canceled';
      stop(new ProviderError('sentinel.provider.canceled', words.canceled, 'possible'));
    };
    const control: SandboxControl = Object.freeze({
      stop,
      cancel,
      failed: () => failure !== undefined,
      deadlineAt: timing.deadlineAt,
      ...(timing.signal ? { signal: timing.signal } : {}),
    });
    const timer = setTimeout(
      () => stop(new ProviderError('sentinel.provider.timeout', words.timeout, 'possible')),
      Math.max(1, timing.deadlineAt - Date.now()),
    );
    timing.signal?.addEventListener('abort', cancel, { once: true });
    child.stdout!.on('data', (bytes: Buffer) => {
      if (failure) return;
      try {
        launch.transcript?.push(bytes);
        launch.onStdout(bytes);
      } catch (e) {
        stop(
          e instanceof ProviderError
            ? e
            : new ProviderError('sentinel.provider.malformedResponse', words.stream, 'possible'),
        );
      }
    });
    child.stderr!.on('data', (bytes: Buffer) => {
      launch.onStderr?.(bytes);
      state.stderrBytes = Math.min(state.stderrBytes + bytes.length, 2147483647);
      if (state.stderrBytes > launch.stderrLimit)
        stop(new ProviderError('sentinel.provider.responseTooLarge', words.stderr, 'possible'));
    });
    child.stdin!.on('error', () => {
      state.reason = 'stdin-error';
      stop(new ProviderError('sentinel.provider.unreachable', words.stdin, 'possible'));
    });
    child.once('spawn', () => {
      state.spawned = true;
      launch.onSpawned?.();
      if (timing.signal?.aborted) return cancel();
      if (Date.now() >= timing.deadlineAt)
        return stop(new ProviderError('sentinel.provider.timeout', words.timeout, 'possible'));
      launch.deliver(child, control);
    });
    child.once('error', () => {
      state.reason = 'process-error';
      failure ??= new ProviderError(
        'sentinel.provider.unreachable',
        words.unavailable,
        state.spawned ? 'possible' : 'none',
      );
    });
    child.once('close', (code, signal) => {
      state.code = code;
      state.signal = signal;
      clearTimeout(timer);
      timing.signal?.removeEventListener('abort', cancel);
      if (timing.signal?.aborted) failure = new ProviderError('sentinel.provider.canceled', words.canceled, 'possible');
      else if (Date.now() >= timing.deadlineAt)
        failure = new ProviderError('sentinel.provider.timeout', words.timeout, 'possible');
      if (failure) return reject(failure);
      resolve();
    });
    if (timing.signal?.aborted) cancel();
  });
}

export const freshSandboxedState = (): SandboxedState => ({
  spawned: false,
  pid: undefined,
  stderrBytes: 0,
  code: null,
  signal: null,
  reason: undefined,
});

/** Words for a refused read of a file the CLI wrote into the owned root. */
export interface OwnedFileWords {
  readonly bound: string;
  readonly changed: string;
}

/**
 * Reads one file the sandboxed CLI wrote under the owned root: never through a link, one regular single-link file
 * within `maxBytes`, and the same identity before and after the read. `boundary` re-checks the original deadline.
 */
export async function readOwnedFile(
  path: string,
  maxBytes: number,
  boundary: () => void,
  words: OwnedFileWords,
): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes)
      throw new ProviderError('sentinel.provider.responseTooLarge', words.bound, 'possible');
    const bytes = await fd.readFile(),
      after = await fd.stat();
    boundary();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    )
      throw new ProviderError('sentinel.provider.malformedResponse', words.changed, 'possible');
    return bytes;
  } finally {
    await fd.close();
  }
}

/** The CLI runner both wrappers build on; the names are the module's exports, gathered for a reader. */
export const SandboxedCliRunner = Object.freeze({
  argv: sandboxArgv,
  policy: seatbelt,
  supervise: superviseSandboxedCli,
  readOwnedFile,
  freshState: freshSandboxedState,
});
