// The coordinator's own scratch: input restores and attempt work folders under its scratch root, removed only when
// nothing can still be using them.
//
// - An input restore (`inputs.<epoch>.<uuid>`) is read only by the coordinator that made it, while it copies an
//   attempt's inputs. That coordinator removes it when its drive ends with nothing in flight. A restore of an earlier
//   epoch belongs to an owner that is gone (this one holds the store lock), so recovery removes it.
// - An attempt work folder (`<attempt id>-<uuid>`) is removed by the supervisor once its worker is reaped. One left
//   by a crash is removed only when its attempt is this store's and ended in the ledger (or was never recorded and its
//   worker record was settled by this recovery), and recovery holds no obligation, pending create, uncertain container,
//   unreadable record or terminal-unknown record (an acknowledgement is not a stop): its worker is confirmed stopped
//   or unable to act. Anything else (an
//   unknown folder, another store's attempt, a live or unconfirmed worker) is left as it is.
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SentinelStore } from '../store/index.js';
import { RESTORE_PREFIX } from './plan.js';
import type { RecoveryReport } from './recovery.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A check driver's prepared files for one attempt: `prep.<attempt id>.<uuid>`, kept and removed like its work folder. */
export const PREP_PREFIX = 'prep.';

/** Remove a tree this coordinator owns, reopening the read-only folders a restore or an attempt seals. */
export function removeOwned(path: string): void {
  const open = (dir: string) => {
    try {
      chmodSync(dir, 0o700);
    } catch {
      return;
    }
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let s;
      try {
        s = lstatSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) open(p);
    }
  };
  open(path);
  rmSync(path, { recursive: true, force: true });
}

export interface ScratchReconciliation {
  removedRestores: string[];
  removedWorkDirs: string[];
  kept: string[];
}

/** After recovery: remove what dead owners left that is provably no longer in use; keep everything else. */
export function reconcileScratch(
  scratchRoot: string,
  store: SentinelStore,
  recovery: RecoveryReport,
  /** Records acknowledged as terminal-unknown: kept for audit, and never proof that anything stopped. */
  terminalUnknown: readonly string[],
): ScratchReconciliation {
  const out: ScratchReconciliation = { removedRestores: [], removedWorkDirs: [], kept: [] };
  let names: string[];
  try {
    names = readdirSync(scratchRoot);
  } catch {
    return out;
  }
  const held = new Set<string>([
    ...recovery.obligations.map((o) => o.attempt),
    ...recovery.pendingIntents.map((i) => i.attempt),
  ]);
  // An acknowledgement that cleanup will not be confirmed is not a stop: while any terminal-unknown record exists,
  // the worker it describes may still be alive and using its folder, so every attempt folder is kept.
  const uncertain = recovery.uncertain.length > 0 || recovery.unresolved.length > 0 || terminalUnknown.length > 0;
  const settled = new Set(recovery.settledWorkers);
  for (const name of names) {
    const path = join(scratchRoot, name);
    if (name.startsWith(RESTORE_PREFIX)) {
      const epoch = name.slice(RESTORE_PREFIX.length, name.lastIndexOf('.'));
      if (epoch && epoch !== store.epoch && UUID.test(name.slice(name.lastIndexOf('.') + 1))) {
        removeOwned(path);
        out.removedRestores.push(name);
      } else out.kept.push(name);
      continue;
    }
    const cut = name.length - 37;
    const prep = name.startsWith(PREP_PREFIX);
    const attemptId =
      cut > 0 && name[cut] === (prep ? '.' : '-') && UUID.test(name.slice(cut + 1))
        ? name.slice(prep ? PREP_PREFIX.length : 0, cut)
        : null;
    const attempt = attemptId ? store.ledger.getAttempt(attemptId) : null;
    // An attempt never recorded (its owner died before recording it) is ours only through its worker record, settled
    // by this recovery. A container whose removal is unconfirmed or an unreadable record could belong to any attempt.
    const ended = attempt ? attempt.state !== 'running' : attemptId !== null && settled.has(attemptId);
    if (!ended || held.has(attemptId!) || uncertain) {
      out.kept.push(name);
      continue;
    }
    removeOwned(path);
    out.removedWorkDirs.push(name);
  }
  return out;
}
