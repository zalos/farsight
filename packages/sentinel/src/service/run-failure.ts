// The last fatal service error of an accepted run, kept outside temporary scratch. The store owner writes one
// bounded private record through execution's durable journal (write, fsync, rename, directory fsync). Only known
// catalog codes are retained: raw exceptions, provider text, credentials and source bytes never enter this record.
import { join } from 'node:path';
import { EXECUTION_ERROR_CODES, ExecutionError } from '../execution/errors.js';
import { JournalDir, isDigest, isId } from '../execution/recovery.js';
import { STORAGE_ERROR_CODES, type SentinelStore } from '../store/index.js';
import { readPrivateFile } from '../policy/user-state.js';

const SCHEMA = 'sentinel-service-run-failure/draft-1';
const CODES: ReadonlySet<string> = new Set([
  'sentinel.service.executionFailed',
  ...EXECUTION_ERROR_CODES,
  ...Object.values(STORAGE_ERROR_CODES).flat(),
]);
export type RunFailure = {
  schema: string;
  storeId: string;
  runId: string;
  planRevision: number;
  planDigest: string;
  epoch: string;
  code: string;
  at: string;
};
const FIELDS = {
  schema: (v: unknown) => v === SCHEMA,
  storeId: isId,
  runId: isId,
  planRevision: (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0,
  planDigest: isDigest,
  epoch: isId,
  code: (v: unknown) => typeof v === 'string' && CODES.has(v),
  at: (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)),
};

/** A bounded catalog code, never a raw exception's message or arbitrary code string. */
export function runFailureCode(error: unknown): string {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' && CODES.has(value) ? value : 'sentinel.service.executionFailed';
}

/** Persist only a run and revision already admitted in this store, under its current owner epoch. */
export function recordRunFailure(store: SentinelStore, runId: string, error: unknown, at = new Date()): RunFailure {
  store.assertHeld();
  const run = store.ledger.getRun(runId);
  const plan = run && store.ledger.getPlan(runId, run.planRevision);
  if (!run || !plan)
    throw new ExecutionError('sentinel.execution.planInvalid', {
      reason: 'a service failure names an admitted run revision',
    });
  const code = runFailureCode(error);
  const failure: RunFailure = {
    schema: SCHEMA,
    storeId: store.storeId,
    runId,
    planRevision: plan.revision,
    planDigest: plan.digest,
    epoch: store.epoch,
    code,
    at: at.toISOString(),
  };
  new JournalDir<RunFailure>(store.storePath, 'service-errors', FIELDS, { key: 'runId' }).record(runId, failure);
  return failure;
}

/** Read only this store/run's current admitted revision; another store's or older revision's record is no authority. */
export function runFailureFacts(
  store: SentinelStore,
  runId: string,
): { error?: string; lastFailure?: Readonly<RunFailure> } {
  store.assertHeld();
  if (!isId(runId)) return {};
  const bytes = readPrivateFile(
    join(store.storePath, 'execution', 'service-errors', `${runId}.json`),
    4096,
    'sentinel.receipt.storeUnsafe',
  );
  if (!bytes) return {};
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ExecutionError('sentinel.execution.journalUnreadable', {
      reason: 'a service failure record is not JSON',
    });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== Object.keys(FIELDS).length ||
    Object.entries(FIELDS).some(([key, check]) => !check(value[key]))
  ) {
    throw new ExecutionError('sentinel.execution.journalUnreadable', { reason: 'a service failure record is invalid' });
  }
  const run = store.ledger.getRun(runId);
  const plan = run && store.ledger.getPlan(runId, run.planRevision);
  if (
    !plan ||
    value.storeId !== store.storeId ||
    value.runId !== runId ||
    value.planRevision !== plan.revision ||
    value.planDigest !== plan.digest
  )
    return {};
  const lastFailure = Object.freeze(value as unknown as RunFailure);
  return {
    ...(run!.state === 'completed' || run!.state === 'canceled' ? {} : { error: lastFailure.code }),
    lastFailure,
  };
}
