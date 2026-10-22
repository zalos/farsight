// Recovery: what a new owner epoch does before it schedules anything, after an earlier coordinator stopped for any
// reason (crash, SIGKILL, power loss). It works only from durable facts: the ledger's ordered events, the attempt
// envelopes' recorded worker identities, the container runtime's ownership labels and the intent journal.
//
// - An attempt still running under an earlier epoch is interrupted: its worker is stopped only after its identity is
//   verified (a child by process id and start time, a container by exact ID and every ownership label), and the
//   coordinator later replaces it through the ledger's supersede, so the old attempt can never publish. A late
//   message from it is refused by the ledger's epoch fence.
// - A stage left open by an earlier epoch is aborted; its bytes become unreferenced and wait for collection.
// - A journaled container intent from an earlier epoch is looked for again. Found: removed by exact ID, settled.
//   Not found: kept as pending, because a create can still commit after a finite search; nothing assumes absence.
// Recovery never waits without bound and never kills by name or command line.
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Id, WorkRef } from '../contracts/common.js';
import type { AttemptWorker } from '../contracts/attempt.js';
import type { SentinelStore } from '../store/index.js';
import type { LedgerEvent } from '../store/store-types.js';
import type { ContainerBackend } from './isolation.js';
import { runBoundedSync, succeeded } from './processes.js';
import { stageIdFor } from './publication.js';
import type { ContainerIntent, IntentJournal } from './supervisor.js';

const INTENT_FIELDS = ['name', 'owner', 'store', 'attempt', 'epoch', 'invocation'] as const;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Owner-only intent files under `<store>/execution/intents/`, one per container create, named by its owner nonce.
 * Written and synced before the create; removed only once the container is confirmed removed.
 */
export class IntentFiles implements IntentJournal {
  readonly dir: string;

  constructor(storePath: string) {
    const base = join(storePath, 'execution');
    this.dir = join(base, 'intents');
    for (const d of [base, this.dir]) {
      try { mkdirSync(d, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const s = lstatSync(d);
      if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.()) throw new Error('the intent journal folder is not private');
    }
  }

  record(intent: ContainerIntent): void {
    const file = this.#file(intent.owner);
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, `${JSON.stringify(pick(intent))}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    this.#syncDir();
  }

  settle(intent: ContainerIntent): void {
    try { unlinkSync(this.#file(intent.owner)); this.#syncDir(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }

  list(): ContainerIntent[] {
    const out: ContainerIntent[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const v = JSON.parse(readFileSync(join(this.dir, name), 'utf8'));
        if (INTENT_FIELDS.every(k => typeof v[k] === 'string')) out.push(pick(v));
      } catch { /* an unreadable record is reported by its absence from the list; the file is kept */ }
    }
    return out;
  }

  #file(owner: string): string {
    if (!SAFE.test(owner)) throw new Error('an intent owner nonce is not a safe name');
    return join(this.dir, `${owner}.json`);
  }

  #syncDir(): void {
    try { const fd = openSync(this.dir, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* best effort on platforms without directory sync */ }
  }
}

const pick = (v: Record<string, unknown>): ContainerIntent =>
  Object.fromEntries(INTENT_FIELDS.map(k => [k, String(v[k])])) as ContainerIntent;

/** What the ledger's events say about attempts, stages and runs, folded once. */
export interface LedgerHistory {
  attempts: Map<Id, { work: WorkRef; epoch: Id; state: 'running' | 'ended' | 'published' | 'superseded' }>;
  /** Started attempts per work revision (`id@revision`). */
  attemptCount: Map<string, number>;
  /** Stages still open, with the epoch that registered them. */
  openStages: Map<Id, { epoch: Id; work: WorkRef | null }>;
  runs: Map<Id, string>;
}

export function readHistory(store: SentinelStore): LedgerHistory {
  const h: LedgerHistory = { attempts: new Map(), attemptCount: new Map(), openStages: new Map(), runs: new Map() };
  let after = 0;
  for (;;) {
    const page = store.ledger.readEvents({ after, limit: 500 });
    for (const e of page.events) fold(h, e);
    if (!page.more) break;
    after = page.cursor;
  }
  return h;
}

function fold(h: LedgerHistory, e: LedgerEvent): void {
  const p = e.payload as Record<string, unknown>;
  switch (e.kind) {
    case 'run-created': h.runs.set(String(e.runId), String(p.state)); break;
    case 'run-state': h.runs.set(String(e.runId), String(p.to)); break;
    case 'attempt-started': {
      const id = String(p.attemptId);
      if (typeof p.superseded === 'string') {
        const old = h.attempts.get(p.superseded);
        if (old) old.state = 'superseded';
      }
      h.attempts.set(id, { work: e.work!, epoch: e.epoch, state: 'running' });
      const k = `${e.work!.id}@${e.work!.revision}`;
      h.attemptCount.set(k, (h.attemptCount.get(k) ?? 0) + 1);
      break;
    }
    case 'attempt-ended': { const a = h.attempts.get(String(p.attemptId)); if (a) a.state = 'ended'; break; }
    case 'work-published': {
      const a = h.attempts.get(String(p.attemptId));
      if (a) a.state = 'published';
      h.openStages.delete(stageIdFor(String(p.attemptId)));
      break;
    }
    case 'staging-registered': h.openStages.set(String(p.stageId), { epoch: e.epoch, work: e.work }); break;
    case 'staging-aborted': h.openStages.delete(String(p.stageId)); break;
    default: break;
  }
}

export interface RecoveryReport {
  /** Attempts from earlier epochs still marked running; the coordinator supersedes them when it re-admits the work. */
  staleAttempts: Array<{ attemptId: Id; work: WorkRef; epoch: Id }>;
  stoppedChildren: number[];
  /** Child workers whose process id is now another process (start time differs): left alone. */
  reusedPids: number[];
  removedContainers: string[];
  abortedStages: Id[];
  settledIntents: string[];
  /** Kept: a create that may still commit, or a container whose removal is not confirmed. */
  pendingIntents: ContainerIntent[];
  uncertain: string[];
}

/**
 * Process start time from the kernel's elapsed-time column (`ps -o etime=`, the same on macOS and Linux and free of
 * time zones), read by the fixed `ps` with no shell. null when the process is gone. Whole-second precision.
 */
export function processStartTime(pid: number): number | null {
  const r = runBoundedSync('/bin/ps', ['-o', 'etime=', '-p', String(pid)], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeoutMs: 5_000, maxStdoutBytes: 4096, maxStderrBytes: 4096 });
  if (!succeeded(r)) return null;
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(r.stdout.toString('utf8'));
  if (!m) return null;
  const [days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4]].map(v => Number(v ?? 0));
  return Date.now() - (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1000;
}

/** Stop a recorded child worker only if the process with that id started when the attempt recorded it did. */
export function stopOwnedChild(worker: Extract<AttemptWorker, { kind: 'owned-child' }>): 'stopped' | 'gone' | 'reused' {
  const started = processStartTime(worker.pid);
  if (started === null) return 'gone';
  // ps reports whole seconds (and is read a moment after); the attempt records the spawn instant.
  if (Math.abs(started - Date.parse(worker.processStartedAt)) > 3_000) return 'reused';
  try { process.kill(worker.pid, 'SIGKILL'); } catch { return 'gone'; }
  return 'stopped';
}

export async function recoverStore(store: SentinelStore, options: { journal: IntentFiles; backend?: ContainerBackend; history?: LedgerHistory }): Promise<RecoveryReport> {
  store.assertHeld();
  const epoch = store.epoch;
  const h = options.history ?? readHistory(store);
  const report: RecoveryReport = {
    staleAttempts: [], stoppedChildren: [], reusedPids: [], removedContainers: [], abortedStages: [], settledIntents: [], pendingIntents: [], uncertain: [],
  };
  // 1. Workers of attempts left running by earlier epochs.
  for (const [attemptId, a] of h.attempts) {
    if (a.state !== 'running' || a.epoch === epoch) continue;
    report.staleAttempts.push({ attemptId, work: a.work, epoch: a.epoch });
    const worker = store.ledger.getAttempt(attemptId)?.envelope.worker;
    if (worker?.kind === 'owned-child') {
      const r = stopOwnedChild(worker);
      if (r === 'stopped') report.stoppedChildren.push(worker.pid);
      if (r === 'reused') report.reusedPids.push(worker.pid);
    }
  }
  // 2. Containers labelled with this store under an earlier epoch: removed by exact ID and every label.
  const removedOwners = new Set<string>();
  if (options.backend) {
    for (const c of await options.backend.listStoreContainers(store.storeId)) {
      if (c.epoch === epoch) continue;
      const state = await options.backend.remove(c.id, { owner: c.owner, store: store.storeId, attempt: c.attempt, epoch: c.epoch }).catch(() => 'cleanup-failed' as const);
      if (state === 'cleanup-failed') report.uncertain.push(c.id); else { report.removedContainers.push(c.id); removedOwners.add(c.owner); }
    }
  }
  // 3. Journaled intents from earlier epochs.
  for (const intent of options.journal.list()) {
    if (intent.epoch === epoch) continue;
    if (removedOwners.has(intent.owner)) { options.journal.settle(intent); report.settledIntents.push(intent.name); continue; }
    if (!options.backend) { report.pendingIntents.push(intent); continue; }
    const r = await options.backend.settleIntent(intent).catch(() => 'uncertain' as const);
    if (r === 'removed') { options.journal.settle(intent); report.settledIntents.push(intent.name); }
    else report.pendingIntents.push(intent);
  }
  // 4. Stages left open by earlier epochs.
  for (const [stageId, s] of h.openStages) {
    if (s.epoch === epoch) continue;
    store.ledger.abortStaging(stageId);
    report.abortedStages.push(stageId);
  }
  return report;
}
