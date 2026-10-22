// Recovery: what a new owner epoch does before it schedules anything, after an earlier coordinator stopped for any
// reason (crash, SIGKILL, power loss). It works only from durable facts: the ledger (typed reads, and its fenced
// interruptStaleAttempts), the worker and intent journals, and the container runtime's ownership labels.
//
// - Attempts still running under an earlier epoch are interrupted by the ledger under this epoch's fence, so none
//   can publish; their work becomes ready again while the run can still admit work, failed once it cannot.
// - A worker of an earlier epoch is stopped only when it is proven to be that worker: its process carries the
//   random token it was started with (read from the kernel's argument list), and on Linux its kernel start time
//   (boot id and start ticks) equals the one recorded at spawn. A process that is provably someone else's means
//   ours has exited. When neither can be established, the obligation is kept in the journal and reported, and
//   every later recovery checks it again; nothing is killed on a time estimate.
// - A container labelled with this store under an earlier epoch is removed by exact ID and every label.
// - A journaled create intent is looked for again; not found is kept as pending, never assumed absent.
// - Stages left open by an earlier epoch are aborted.
// - A journal record that cannot be read (a link, not a regular file, too large, not the expected JSON) is kept
//   untouched and reported; recovery is then not clean.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Id, WorkRef } from '../contracts/common.js';
import type { SentinelStore } from '../store/index.js';
import { syncDirectory, syncFile } from './durability.js';
import { ExecutionError } from './errors.js';
import type { ContainerBackend } from './isolation.js';
import { runBoundedSync, succeeded } from './processes.js';
import type { ContainerIntent, IntentJournal } from './supervisor.js';

export const MAX_JOURNAL_RECORDS = 4096;
export const MAX_JOURNAL_RECORD_BYTES = 4096;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface UnresolvedRecord { journal: string; file: string; reason: string }

/**
 * Owner-only records under `<store>/execution/<name>/`, one small JSON file per key. A record is written to a
 * temporary file, synced, renamed into place and the folder synced, before the effect it describes. Reading is
 * bounded: at most MAX_JOURNAL_RECORDS entries, each a private regular file (opened without following links and
 * without blocking) of at most MAX_JOURNAL_RECORD_BYTES with every expected field.
 */
export class JournalDir<T extends Record<string, string | number>> {
  readonly dir: string;
  readonly #name: string;
  readonly #fields: readonly (keyof T & string)[];

  constructor(storePath: string, name: string, fields: readonly (keyof T & string)[]) {
    this.#name = name;
    this.#fields = fields;
    const base = join(storePath, 'execution');
    this.dir = join(base, name);
    for (const d of [base, this.dir]) {
      try { mkdirSync(d, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const s = lstatSync(d);
      if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.()) {
        throw new ExecutionError('sentinel.execution.journalUnreadable', { reason: `${name} folder is not private` });
      }
    }
  }

  /** Write (or replace) one record durably: temporary file, sync, rename, folder sync. */
  record(key: string, value: T): void {
    const file = this.#file(key);
    const tmp = `${file}.tmp`;
    try { unlinkSync(tmp); } catch { /* none left from an earlier write */ }
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.byteLength > MAX_JOURNAL_RECORD_BYTES) throw new ExecutionError('sentinel.execution.journalUnreadable', { reason: 'record too large' });
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, bytes); syncFile(fd, tmp); } finally { closeSync(fd); }
    renameSync(tmp, file);
    syncDirectory(this.dir);
  }

  settle(key: string): void {
    try { unlinkSync(this.#file(key)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    syncDirectory(this.dir);
  }

  list(): { records: T[]; unresolved: UnresolvedRecord[] } {
    const records: T[] = [], unresolved: UnresolvedRecord[] = [];
    const dir = opendirSync(this.dir);
    try {
      let seen = 0;
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++seen > MAX_JOURNAL_RECORDS) { unresolved.push({ journal: this.#name, file: '*', reason: `more than ${MAX_JOURNAL_RECORDS} records` }); break; }
        const name = entry.name;
        // A temporary file was never renamed into place, so the effect it would have described never started.
        if (name.endsWith('.json.tmp')) { try { unlinkSync(join(this.dir, name)); } catch { /* reported below if it persists */ } continue; }
        if (!name.endsWith('.json')) { unresolved.push({ journal: this.#name, file: name, reason: 'unexpected entry' }); continue; }
        const read = readRecord(join(this.dir, name));
        if (typeof read === 'string') { unresolved.push({ journal: this.#name, file: name, reason: read }); continue; }
        const v = (read ?? {}) as Record<string, unknown>;
        if (!this.#fields.every(k => typeof v[k] === 'string' || typeof v[k] === 'number')) { unresolved.push({ journal: this.#name, file: name, reason: 'missing fields' }); continue; }
        records.push(Object.fromEntries(this.#fields.map(k => [k, v[k]])) as T);
      }
    } finally { dir.closeSync(); }
    return { records, unresolved };
  }

  #file(key: string): string {
    if (!SAFE.test(key)) throw new ExecutionError('sentinel.execution.journalUnreadable', { reason: 'unsafe record key' });
    return join(this.dir, `${key}.json`);
  }
}

/** Read one record without following a link or blocking, bounded; a string is the reason it was refused. */
function readRecord(path: string): unknown {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ELOOP' ? 'a link' : `unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  try {
    const s = fstatSync(fd);
    if (!s.isFile()) return 'not a regular file';
    if (s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) return 'not private';
    if (s.size > MAX_JOURNAL_RECORD_BYTES) return 'too large';
    const buf = Buffer.alloc(MAX_JOURNAL_RECORD_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_JOURNAL_RECORD_BYTES) return 'too large';
    try { return JSON.parse(buf.subarray(0, n).toString('utf8')); } catch { return 'not JSON'; }
  } finally { closeSync(fd); }
}

const INTENT_FIELDS = ['name', 'owner', 'store', 'attempt', 'epoch', 'invocation'] as const;

/** Container create intents, by owner nonce. */
export class IntentFiles implements IntentJournal {
  readonly #journal: JournalDir<ContainerIntent>;
  constructor(storePath: string) { this.#journal = new JournalDir<ContainerIntent>(storePath, 'intents', INTENT_FIELDS); }
  get dir(): string { return this.#journal.dir; }
  record(intent: ContainerIntent): void { this.#journal.record(intent.owner, intent); }
  settle(intent: ContainerIntent): void { this.#journal.settle(intent.owner); }
  list() { return this.#journal.list(); }
}

/** A built-in worker's identity, recorded after spawn and before it may act. */
export interface WorkerIdentity extends Record<string, string | number> {
  attempt: Id;
  store: Id;
  epoch: Id;
  pid: number;
  /** Random per worker, passed as the `--sentinel-token=` argument; only this journal and the process hold it. */
  token: string;
  /** Linux: `<boot id>:<start ticks>` from /proc; '' where the kernel offers no exact start identity. */
  kernelStart: string;
}

export interface WorkerJournal {
  record(identity: WorkerIdentity): void;
  settle(identity: WorkerIdentity): void;
}

const WORKER_FIELDS = ['attempt', 'store', 'epoch', 'pid', 'token', 'kernelStart'] as const;

export class WorkerFiles implements WorkerJournal {
  readonly #journal: JournalDir<WorkerIdentity>;
  constructor(storePath: string) { this.#journal = new JournalDir<WorkerIdentity>(storePath, 'workers', WORKER_FIELDS); }
  get dir(): string { return this.#journal.dir; }
  record(identity: WorkerIdentity): void { this.#journal.record(identity.attempt, identity); }
  settle(identity: WorkerIdentity): void { this.#journal.settle(identity.attempt); }
  list() { return this.#journal.list(); }
}

export const tokenArgument = (token: string): string => `--sentinel-token=${token}`;

/** Linux: the process's exact start identity, `<boot id>:<start ticks>`. null elsewhere or when it is gone. */
export function kernelStartOf(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  const stat = readSmall(`/proc/${pid}/stat`, 4096);
  const boot = readSmall('/proc/sys/kernel/random/boot_id', 64);
  if (stat === null || boot === null) return null;
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = rest[19]; // field 22 (starttime), counting from field 3 after the command
  return ticks && /^\d+$/.test(ticks) ? `${boot.trim()}:${ticks}` : null;
}

/** The process's argument list from the kernel; null when it is gone, undefined when it cannot be read. */
export function argumentsOf(pid: number): string[] | null | undefined {
  if (process.platform === 'linux') {
    const cmd = readSmall(`/proc/${pid}/cmdline`, 256 * 1024);
    if (cmd === null) return null;
    return cmd.split('\0').filter(Boolean);
  }
  // macOS: ps reads the argument area from the kernel; -ww keeps it whole.
  const r = runBoundedSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeoutMs: 5_000, maxStdoutBytes: 256 * 1024, maxStderrBytes: 4096 });
  if (r.exitCode === 1 && r.stdout.byteLength === 0 && !r.stdoutExceeded) return null;
  if (!succeeded(r)) return undefined;
  return r.stdout.toString('utf8').trim().split(/\s+/);
}

function readSmall(path: string, limit: number): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY); } catch { return null; }
  try {
    const buf = Buffer.alloc(limit);
    const n = readSync(fd, buf, 0, limit, null);
    return buf.subarray(0, n).toString('utf8');
  } catch { return null; } finally { closeSync(fd); }
}

/**
 * Every live process whose kernel argument list carries this exact token, read without a shell: /proc on Linux,
 * `ps -ww -A` on macOS. undefined when the process table cannot be read.
 */
export function processesCarrying(token: string): number[] | undefined {
  const arg = tokenArgument(token);
  if (process.platform === 'linux') {
    let dir;
    try { dir = opendirSync('/proc'); } catch { return undefined; }
    const found: number[] = [];
    try {
      for (let e = dir.readSync(), n = 0; e && n < 1_000_000; e = dir.readSync(), n++) {
        if (!/^\d+$/.test(e.name)) continue;
        const cmd = readSmall(`/proc/${e.name}/cmdline`, 256 * 1024);
        if (cmd !== null && cmd.split('\0').includes(arg)) found.push(Number(e.name));
      }
    } finally { dir.closeSync(); }
    return found;
  }
  const r = runBoundedSync('/bin/ps', ['-ww', '-A', '-o', 'pid=,command='], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeoutMs: 10_000, maxStdoutBytes: 64 * 1024 * 1024, maxStderrBytes: 4096 });
  if (!succeeded(r)) return undefined;
  const found: number[] = [];
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2]!.split(/\s+/).includes(arg)) found.push(Number(m[1]));
  }
  return found;
}

export type WorkerVerdict = 'ours' | 'gone' | 'someone-else' | 'unverifiable';

/** Is the process with this pid the recorded worker? Exact where the kernel allows; never a time estimate. */
export function verifyWorker(id: WorkerIdentity): WorkerVerdict {
  const argv = argumentsOf(id.pid);
  if (argv === null) return 'gone';
  if (argv === undefined) return 'unverifiable';
  const carries = argv.includes(tokenArgument(id.token));
  if (process.platform === 'linux') {
    const start = kernelStartOf(id.pid);
    if (start === null) return 'gone';
    if (id.kernelStart && start !== id.kernelStart) return 'someone-else';
  }
  return carries ? 'ours' : 'someone-else';
}

export interface RecoveryReport {
  /** Attempts the ledger interrupted under this epoch's fence. */
  interrupted: Array<{ attemptId: Id; work: WorkRef; epoch: Id; workState: 'ready' | 'failed' }>;
  stoppedWorkers: number[];
  /** Workers whose obligation is kept: their identity could not be established, or the stop not confirmed. */
  obligations: Array<{ attempt: Id; pid: number; reason: string }>;
  removedContainers: string[];
  abortedStages: Id[];
  settledIntents: string[];
  /** Kept: a create that may still commit, or a container whose removal is not confirmed. */
  pendingIntents: ContainerIntent[];
  unresolved: UnresolvedRecord[];
  uncertain: string[];
  /** Nothing is outstanding: no obligation, pending intent, unreadable record or uncertain container. */
  clean: boolean;
}

export async function recoverStore(store: SentinelStore, options: { intents: IntentFiles; workers: WorkerFiles; backend?: ContainerBackend }): Promise<RecoveryReport> {
  store.assertHeld();
  const epoch = store.epoch;
  const report: RecoveryReport = {
    interrupted: [], stoppedWorkers: [], obligations: [], removedContainers: [], abortedStages: [], settledIntents: [], pendingIntents: [],
    unresolved: [], uncertain: [], clean: false,
  };
  // 1. The ledger ends every earlier epoch's running attempt under this epoch's fence.
  report.interrupted = store.ledger.interruptStaleAttempts();
  // 2. Built-in workers of earlier epochs, by proven identity only.
  const workers = options.workers.list();
  report.unresolved.push(...workers.unresolved);
  for (const w of workers.records) {
    if (w.epoch === epoch || w.store !== store.storeId) continue;
    if (!w.pid) {
      // Journaled before spawn, never given its pid: find it by its token (twice, so a child between fork and
      // exec when its parent died has carried the token into its argument list by the second look).
      const first = processesCarrying(w.token);
      await new Promise(r => setTimeout(r, 200));
      const second = processesCarrying(w.token);
      if (first === undefined || second === undefined) { report.obligations.push({ attempt: w.attempt, pid: 0, reason: 'process table could not be read' }); continue; }
      const pids = [...new Set([...first, ...second])];
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      const left = pids.length ? await waitAbsent(w.token) : true;
      if (left) { report.stoppedWorkers.push(...pids); options.workers.settle(w); }
      else report.obligations.push({ attempt: w.attempt, pid: 0, reason: 'stop not confirmed' });
      continue;
    }
    const verdict = verifyWorker(w);
    if (verdict === 'gone' || verdict === 'someone-else') { options.workers.settle(w); continue; }
    if (verdict === 'unverifiable') { report.obligations.push({ attempt: w.attempt, pid: w.pid, reason: 'identity could not be read' }); continue; }
    try { process.kill(w.pid, 'SIGKILL'); } catch { /* exited in between: confirmed below */ }
    if (await confirmGone(w)) { report.stoppedWorkers.push(w.pid); options.workers.settle(w); }
    else report.obligations.push({ attempt: w.attempt, pid: w.pid, reason: 'stop not confirmed' });
  }
  // 3. Containers labelled with this store under an earlier epoch.
  const removedOwners = new Set<string>();
  if (options.backend) {
    for (const c of await options.backend.listStoreContainers(store.storeId)) {
      if (c.epoch === epoch) continue;
      const state = await options.backend.remove(c.id, { owner: c.owner, store: store.storeId, attempt: c.attempt, epoch: c.epoch }).catch(() => 'cleanup-failed' as const);
      if (state === 'cleanup-failed') report.uncertain.push(c.id); else { report.removedContainers.push(c.id); removedOwners.add(c.owner); }
    }
  }
  // 4. Journaled container intents from earlier epochs.
  const intents = options.intents.list();
  report.unresolved.push(...intents.unresolved);
  for (const intent of intents.records) {
    if (intent.epoch === epoch) continue;
    if (removedOwners.has(intent.owner)) { options.intents.settle(intent); report.settledIntents.push(intent.name); continue; }
    if (!options.backend) { report.pendingIntents.push(intent); continue; }
    const r = await options.backend.settleIntent(intent).catch(() => 'uncertain' as const);
    if (r === 'removed') { options.intents.settle(intent); report.settledIntents.push(intent.name); }
    else report.pendingIntents.push(intent);
  }
  // 5. Stages left open by earlier epochs.
  for (;;) {
    const stale = store.ledger.listOpenStages(500).filter(s => s.epoch !== epoch);
    if (stale.length === 0) break;
    for (const s of stale) { store.ledger.abortStaging(s.stageId); report.abortedStages.push(s.stageId); }
  }
  report.clean = report.obligations.length === 0 && report.pendingIntents.length === 0 && report.unresolved.length === 0 && report.uncertain.length === 0;
  return report;
}

/** Wait (bounded, up to 2 s) until no process carries the token. */
async function waitAbsent(token: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const left = processesCarrying(token);
    if (left !== undefined && left.length === 0) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

/** Wait (bounded, up to 2 s) for a killed worker to be gone. */
async function confirmGone(w: WorkerIdentity): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const v = verifyWorker(w);
    if (v === 'gone' || v === 'someone-else') return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

/**
 * The terminal-unknown journal: records whose cleanup was explicitly acknowledged as unconfirmable. They are moved
 * here byte for byte (never deleted), listed in every summary, and keep the store from ever reporting clean.
 */
export class UnknownCleanup {
  readonly dir: string;

  constructor(storePath: string) {
    this.dir = new JournalDir<Record<string, string>>(storePath, 'unknown', []).dir;
  }

  acknowledge(dirs: readonly string[], report: RecoveryReport): string[] {
    const wanted = new Set<string>([
      ...report.pendingIntents.map(i => `intents/${i.owner}.json`),
      ...report.obligations.map(o => `workers/${o.attempt}.json`),
      ...report.unresolved.map(u => `${u.journal}/${u.file}`),
    ]);
    const moved: string[] = [];
    for (const dir of dirs) {
      const journal = dir.slice(dir.lastIndexOf('/') + 1);
      for (const key of wanted) {
        if (!key.startsWith(`${journal}/`)) continue;
        const name = key.slice(journal.length + 1);
        if (name === '*' || !name || name.includes('/')) continue;
        try { renameSync(join(dir, name), join(this.dir, `${journal}.${name}`)); moved.push(key); } catch { /* already gone */ }
      }
      syncDirectory(dir);
    }
    syncDirectory(this.dir);
    return moved;
  }

  list(): string[] {
    const names: string[] = [];
    const d = opendirSync(this.dir);
    try { for (let e = d.readSync(), n = 0; e && n < MAX_JOURNAL_RECORDS; e = d.readSync(), n++) names.push(e.name); } finally { d.closeSync(); }
    return names.sort();
  }
}
