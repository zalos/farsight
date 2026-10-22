// Bounded local processes. Every process Sentinel starts goes through here: an absolute executable, an argument
// list (never a shell), an explicit environment (nothing inherited), stdout and stderr captured separately under
// their own byte limits, a deadline and an abort signal. A process is stopped through its own handle, never by
// searching for a command line.
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface BoundedOptions {
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
  /** Bytes written to stdin, which is then closed. Without it stdin is closed at once. */
  input?: Uint8Array;
}

export interface BoundedResult {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutExceeded: boolean;
  stderrExceeded: boolean;
  timedOut: boolean;
  canceled: boolean;
  /** The spawn error code (ENOENT, EACCES, …), or null when the process started. */
  spawnError: string | null;
}

export const succeeded = (r: BoundedResult): boolean =>
  r.exitCode === 0 && !r.exitSignal && !r.timedOut && !r.canceled && !r.stdoutExceeded && !r.stderrExceeded && !r.spawnError;

/** Run to completion under the limits. Exceeding a byte limit stops the process (SIGKILL). */
export function runBounded(program: string, args: readonly string[], options: BoundedOptions): Promise<BoundedResult> {
  return new Promise(resolve => {
    const child = spawn(program, [...args], {
      env: options.env, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    const out: Buffer[] = [], err: Buffer[] = [];
    let outBytes = 0, errBytes = 0;
    const r: BoundedResult = {
      exitCode: null, exitSignal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      stdoutExceeded: false, stderrExceeded: false, timedOut: false, canceled: false, spawnError: null,
    };
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    child.stdout.on('data', (b: Buffer) => {
      if (outBytes + b.byteLength > options.maxStdoutBytes) { out.push(b.subarray(0, Math.max(0, options.maxStdoutBytes - outBytes))); outBytes = options.maxStdoutBytes; r.stdoutExceeded = true; kill(); return; }
      out.push(b); outBytes += b.byteLength;
    });
    child.stderr.on('data', (b: Buffer) => {
      if (errBytes + b.byteLength > options.maxStderrBytes) { err.push(b.subarray(0, Math.max(0, options.maxStderrBytes - errBytes))); errBytes = options.maxStderrBytes; r.stderrExceeded = true; kill(); return; }
      err.push(b); errBytes += b.byteLength;
    });
    child.stdin.on('error', () => { /* the process may exit before reading */ });
    child.stdin.end(options.input ? Buffer.from(options.input) : undefined);
    const onAbort = () => { r.canceled = true; kill(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timer = setTimeout(() => { r.timedOut = true; kill(); }, options.timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => { r.spawnError = e.code ?? 'spawn-error'; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      r.exitCode = code; r.exitSignal = signal;
      r.stdout = Buffer.concat(out); r.stderr = Buffer.concat(err);
      resolve(r);
    });
  });
}

/** Synchronous bounded run, for cleanup paths that must finish before a lock is released. */
export function runBoundedSync(program: string, args: readonly string[], options: Omit<BoundedOptions, 'signal' | 'input'>): BoundedResult {
  const s = spawnSync(program, [...args], {
    env: options.env, cwd: options.cwd, timeout: options.timeoutMs, killSignal: 'SIGKILL', shell: false, windowsHide: true,
    maxBuffer: Math.max(options.maxStdoutBytes, options.maxStderrBytes), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = (s.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    exitCode: s.status, exitSignal: s.signal, stdout: s.stdout ?? Buffer.alloc(0), stderr: s.stderr ?? Buffer.alloc(0),
    stdoutExceeded: code === 'ENOBUFS', stderrExceeded: false, timedOut: code === 'ETIMEDOUT', canceled: false,
    spawnError: code && code !== 'ETIMEDOUT' && code !== 'ENOBUFS' ? code : null,
  };
}

/** A long-lived worker process: stdin for coordinator frames, stdout for worker frames, stderr for diagnostics. */
export interface WorkerProcess {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly startedAt: Date;
  /** Resolves once the process has exited and its streams have closed. */
  readonly exited: Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null; spawnError: string | null }>;
  kill(): void;
}

export function spawnWorker(program: string, args: readonly string[], options: { env: Record<string, string>; cwd?: string }): WorkerProcess {
  const child = spawn(program, [...args], { env: options.env, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let spawnError: string | null = null;
  child.on('error', (e: NodeJS.ErrnoException) => { spawnError = e.code ?? 'spawn-error'; });
  child.stdin.on('error', () => { /* a worker that exits early closes its stdin */ });
  const exited = new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null; spawnError: string | null }>(resolve => {
    child.on('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal, spawnError }));
  });
  return {
    child, startedAt: new Date(), exited,
    kill: () => { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } } },
  };
}

/** Collects a stream up to a byte limit and counts what it drops; never stops the process by itself. */
export class BoundedCapture {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #kept = 0;
  #seen = 0;
  constructor(limit: number) { this.#limit = limit; }
  push(b: Buffer): void {
    this.#seen += b.byteLength;
    const room = this.#limit - this.#kept;
    if (room <= 0) return;
    const keep = b.byteLength <= room ? b : b.subarray(0, room);
    this.#chunks.push(Buffer.from(keep)); this.#kept += keep.byteLength;
  }
  get bytes(): number { return this.#seen; }
  get truncated(): boolean { return this.#seen > this.#kept; }
  text(): string { return Buffer.concat(this.#chunks).toString('utf8'); }
}
