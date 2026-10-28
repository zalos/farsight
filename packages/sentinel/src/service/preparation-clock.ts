// Internal cooperative preparation clock. Persisted times are data, never admission or a caller-supplied clock.
// One original ceiling spans discovery, capture, bootstrap, inspection delay and the prepared analysis run.
import { performance } from 'node:perf_hooks';
import type { SentinelStore } from '../store/index.js';
import { boundOwner } from '../store/owner-binding.js';
import { SentinelError } from '../kernel/errors.js';

/** The longest a preparation may run from acceptance: ten minutes. */
export const PREPARATION_LIMIT_MS = 600_000;
/** Why a preparation stopped. */
export type PreparationErrorCode =
  | 'sentinel.preparation.expired'
  | 'sentinel.preparation.canceled'
  | 'sentinel.preparation.changed'
  | 'sentinel.preparation.unavailable'
  | 'sentinel.preparation.invalid'
  | 'sentinel.preparation.retentionRequired'
  | 'sentinel.preparation.busy'
  | 'sentinel.preparation.ownerRestarted';
/** A preparation that stopped, by its `PreparationErrorCode`; its message is the code itself. */
export class PreparationError extends SentinelError<PreparationErrorCode> {
  constructor(code: PreparationErrorCode) {
    super(code, code);
    this.name = 'PreparationError';
  }
}
/** One preparation's clock: its acceptance time and deadlines, and a check that it may still run. */
export interface PreparationClock {
  readonly acceptedAt: string;
  readonly deadlineAt: string;
  /** The preparation's absolute ceiling; an existing run may tighten it further. */
  readonly runDeadlineAt: string;
  stillWithin(): void;
}
const clocks = new WeakMap<object, { store: SentinelStore; epoch: string; tighten: (deadline: number) => void }>();

/**
 * A cooperative clock over one preparation's original window, bound to the held store. `stillWithin` throws
 * `sentinel.preparation.canceled` once `signal` aborts (or the expiry the abort carries),
 * `sentinel.preparation.expired` past the earlier of the deadline and the run deadline, and
 * `sentinel.preparation.invalid` when the wall clock goes back; it keeps throwing the first failure. Refuses
 * `sentinel.preparation.invalid` for times that are malformed, out of order, longer than `PREPARATION_LIMIT_MS` or in
 * the future.
 */
export function preparationClock(
  store: SentinelStore,
  given: {
    readonly acceptedAt: string;
    readonly deadlineAt: string;
    readonly runDeadlineAt?: string;
  },
  signal?: AbortSignal,
): PreparationClock {
  boundOwner(store).assertHeld();
  if (
    typeof given.acceptedAt !== 'string' ||
    typeof given.deadlineAt !== 'string' ||
    (given.runDeadlineAt !== undefined && typeof given.runDeadlineAt !== 'string')
  )
    throw new PreparationError('sentinel.preparation.invalid');
  const accepted = Date.parse(given.acceptedAt),
    expiry = Date.parse(given.deadlineAt);
  const runExpiry = given.runDeadlineAt === undefined ? expiry : Date.parse(given.runDeadlineAt);
  const started = Date.now(),
    mono = performance.now();
  if (
    ![accepted, expiry, runExpiry].every(Number.isSafeInteger) ||
    expiry <= accepted ||
    expiry - accepted > PREPARATION_LIMIT_MS ||
    runExpiry > expiry ||
    runExpiry <= accepted ||
    started < accepted
  ) {
    throw new PreparationError('sentinel.preparation.invalid');
  }
  let ceiling = Math.min(expiry, runExpiry);
  let lastWall = started,
    first: unknown;
  const out: PreparationClock = Object.freeze({
    acceptedAt: new Date(accepted).toISOString(),
    deadlineAt: new Date(expiry).toISOString(),
    get runDeadlineAt() {
      return new Date(ceiling).toISOString();
    },
    stillWithin() {
      if (first) throw first;
      try {
        store.assertHeld();
        if (signal?.aborted) {
          if (signal.reason instanceof PreparationError && signal.reason.code === 'sentinel.preparation.expired')
            throw signal.reason;
          throw new PreparationError('sentinel.preparation.canceled');
        }
        const wall = Date.now();
        if (wall < lastWall) throw new PreparationError('sentinel.preparation.invalid');
        lastWall = wall;
        if (wall >= ceiling || performance.now() - mono >= ceiling - started)
          throw new PreparationError('sentinel.preparation.expired');
      } catch (error) {
        first = error;
        throw error;
      }
    },
  });
  clocks.set(out, {
    store,
    epoch: store.epoch,
    tighten(deadline) {
      out.stillWithin();
      if (!Number.isSafeInteger(deadline) || deadline > ceiling)
        throw new PreparationError('sentinel.preparation.invalid');
      ceiling = deadline;
      out.stillWithin();
    },
  });
  out.stillWithin();
  return out;
}

/** JSON, a spread or a clock from another hold cannot stand for the original preparation boundary. */
export function checkPreparationClock(store: SentinelStore, clock: PreparationClock): void {
  const bound = clocks.get(clock);
  if (!bound || bound.store !== store || bound.epoch !== store.epoch)
    throw new PreparationError('sentinel.preparation.invalid');
  clock.stillWithin();
}

/** Tightening retains the ORIGINAL monotonic origin and acceptedAt; it never starts a fresh duration. */
export function tightenPreparationClock(store: SentinelStore, clock: PreparationClock, runDeadlineAt: string): void {
  checkPreparationClock(store, clock);
  if (typeof runDeadlineAt !== 'string') throw new PreparationError('sentinel.preparation.invalid');
  clocks.get(clock)!.tighten(Date.parse(runDeadlineAt));
}
