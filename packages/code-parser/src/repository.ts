// All built-in adapter reads pass through this context. Legacy low-level extraction keeps its old IO behavior.
import * as fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '@farsight/graph';
import type { Diagnostic, FileAnalysis, InputFingerprint, ParserLimits } from './types.js';

export const DEFAULT_LIMITS: Required<ParserLimits> = {
  maxFiles: 10_000, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 100_000, maxDurationMs: 60_000,
};
const context = new AsyncLocalStorage<RepositoryRead>();
export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** This failure already has a structured diagnostic; callers must not relabel it as an IO failure. */
export class ReportedReadError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

export class RepositoryRead {
  readonly root: string;
  readonly limits: Required<ParserLimits>;
  readonly diagnostics: Diagnostic[] = [];
  readonly files = new Map<string, FileAnalysis>();
  readonly inputs = new Map<string, InputFingerprint>();
  readonly selected = new Set<string>();
  selectionReady = false;
  discoveringSources = false;
  discoveryExtensions: readonly string[] = [];
  private readonly started = performance.now();
  private readonly bodies = new Map<string, Buffer>();
  private readonly stats = new Map<string, fs.Stats | Error>();
  private readonly directories = new Map<string, string[]>();
  private readonly diagnosticKeys = new Set<string>();
  private bytes = 0;
  private entries = 0;
  private halted = false;
  stopReason?: 'cancelled' | 'resource-limit';
  get stopped(): boolean { return this.halted; }

  constructor(root: string, readonly signal?: AbortSignal, limits: ParserLimits = {}) {
    this.root = fs.realpathSync(root);
    if (!fs.statSync(this.root).isDirectory()) throw new TypeError('root must be a directory');
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [name, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }

  run<T>(action: () => T): T { return context.run(this, action); }

  path(file: string): string {
    const path = relative(this.root, resolve(file)).split(sep).join('/');
    if (path === '..' || path.startsWith('../') || isAbsolute(path)) {
      this.report({ code: 'read-boundary', severity: 'error', message: 'An input resolves outside the source root.' });
      throw new ReportedReadError('outside-root');
    }
    return path || '.';
  }

  report(diagnostic: Diagnostic): void {
    const key = canonicalJson(diagnostic);
    if (!this.diagnosticKeys.has(key)) { this.diagnosticKeys.add(key); this.diagnostics.push(diagnostic); }
  }

  checkpoint(): void {
    if (this.signal?.aborted) {
      this.report({ code: 'cancelled', severity: 'warning', message: 'Analysis was cancelled.' });
      this.halted = true;
      this.stopReason = 'cancelled';
    } else if (!this.halted && performance.now() - this.started > this.limits.maxDurationMs) {
      this.report({ code: 'resource-limit', severity: 'warning', message: 'Analysis reached maxDurationMs.' });
      this.halted = true;
      this.stopReason = 'resource-limit';
    }
    if (this.halted) throw new ReportedReadError(this.stopReason!);
  }

  private guard(file: string): string {
    this.checkpoint();
    const path = this.path(file);
    let current = this.root;
    // Refuse every symlink component, including an in-root link, before following it.
    for (const part of path === '.' ? [] : path.split('/')) {
      current = resolve(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) {
        this.report({ code: 'read-boundary', severity: 'warning', path, reason: 'symlink', message: 'Symbolic links are not followed.' });
        throw new ReportedReadError('symlink');
      }
    }
    return path;
  }

  stat(file: string): fs.Stats {
    const path = this.path(file);
    this.checkpoint();
    if (!this.stats.has(path)) {
      try {
        this.guard(file);
        const stat = fs.statSync(file);
        this.stats.set(path, stat);
        this.record(path, 'metadata', stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special');
      } catch (error) {
        this.stats.set(path, error instanceof Error ? error : new Error('Input unavailable'));
        this.record(path, 'missing', 'unavailable');
      }
    }
    const stat = this.stats.get(path);
    if (stat instanceof Error) throw stat;
    return stat!;
  }

  directory(file: string): string[] {
    const path = this.path(file);
    this.checkpoint();
    if (!this.directories.has(path)) {
      this.guard(file);
      const entries = fs.readdirSync(file).sort();
      this.entries += entries.length;
      if (this.entries > this.limits.maxEntries) {
        this.report({ code: 'resource-limit', severity: 'warning', path, message: 'Discovery reached maxEntries.' });
        this.halted = true;
        this.stopReason = 'resource-limit';
        throw new ReportedReadError('resource-limit');
      }
      this.directories.set(path, entries);
      this.record(path, 'directory', canonicalJson(entries));
    }
    return this.directories.get(path)!;
  }

  read(file: string): Buffer {
    const path = this.path(file);
    this.checkpoint();
    const cached = this.bodies.get(path);
    if (cached) return cached;
    const stat = this.stat(file);
    if (!stat.isFile()) throw new Error('Input is not a regular file');
    if (stat.size > this.limits.maxFileBytes || this.bytes + stat.size > this.limits.maxTotalBytes) {
      this.report({ code: 'resource-limit', severity: 'warning', path, message: 'Input exceeds maxFileBytes or maxTotalBytes.' });
      throw new ReportedReadError('resource-limit');
    }
    this.guard(file);
    // Bound the actual read as well as the preceding stat (a file can grow between the two).
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const cap = Math.min(this.limits.maxFileBytes, this.limits.maxTotalBytes - this.bytes);
      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, cap - length + 1));
        const count = fs.readSync(fd, chunk);
        if (!count) break;
        length += count;
        if (length > cap) {
          this.report({ code: 'resource-limit', severity: 'warning', path, message: 'Input grew beyond the byte limit.' });
          throw new ReportedReadError('resource-limit');
        }
        chunks.push(chunk.subarray(0, count));
      }
      const body = Buffer.concat(chunks);
      this.bytes += body.length;
      this.bodies.set(path, body);
      this.record(path, 'content', body);
      return body;
    } finally { fs.closeSync(fd); }
  }

  private record(path: string, kind: InputFingerprint['kind'], bytes: string | Buffer): void {
    this.inputs.set(`${kind}:${path}`, { path, kind, digest: sha256(bytes) });
  }
}

export function readFileSync(file: string): Buffer;
export function readFileSync(file: string, encoding: 'utf8'): string;
export function readFileSync(file: string, encoding?: 'utf8'): Buffer | string {
  const scope = context.getStore();
  const body = scope ? scope.read(file) : fs.readFileSync(file);
  return encoding ? body.toString(encoding) : body;
}
export const statSync = (file: string): fs.Stats => context.getStore()?.stat(file) ?? fs.statSync(file);
export const readdirSync = (file: string): string[] => context.getStore()?.directory(file) ?? fs.readdirSync(file);
export const currentRead = (): RepositoryRead | undefined => context.getStore();
export const checkpoint = (): void => context.getStore()?.checkpoint();
export function fileReadError(file: string, adapter: string, error: unknown): boolean {
  const scope = context.getStore();
  const reason = scope?.stopReason ?? (error instanceof ReportedReadError ? error.reason : 'read-error');
  fileStatus(file, scope?.stopped || error instanceof ReportedReadError ? 'skipped' : 'failed', adapter, reason);
  if (scope && !scope.stopped && !(error instanceof ReportedReadError)) {
    scope.report({ code: 'read-error', severity: 'error', path: scope.path(file), adapter, message: 'Source bytes could not be read.' });
  }
  return scope?.stopped ?? false;
}
export function fileStatus(file: string, status: FileAnalysis['status'], adapter: string, reason?: string): void {
  const scope = context.getStore();
  if (!scope) return;
  const path = scope.path(file);
  scope.files.set(path, { path, status, adapter, ...(reason ? { reason } : {}),
    ...(scope.inputs.get(`content:${path}`) ? { digest: scope.inputs.get(`content:${path}`)!.digest } : {}) });
}
export function parseError(file: string, adapter: string, message: string, line?: number): void {
  const scope = context.getStore();
  if (!scope) return;
  scope.report({ code: 'parse-error', severity: 'error', path: scope.path(file), adapter, message, ...(line ? { line } : {}) });
  fileStatus(file, 'failed', adapter, 'parse-error');
}
