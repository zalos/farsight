// Closed internal identities. A descriptor names only Sentinel's fixed shipped files and export, never caller code.
import type { CheckDriver } from './check-drivers.js';
import type { TrustedAdapter } from './registry.js';
import type { WorkerOutcome } from './supervisor.js';
import { deepFreeze } from '../policy/immutable.js';
import { ExecutionError } from './errors.js';

export const BUILTIN_WORKERS = deepFreeze({
  'framework-controls': { asset: 'frameworks/controls/worker', export: 'runFrameworkControlsWorker', driver: 'frameworks/controls/driver', closureRefusalExit: 71 },
  'bounded-paths': { asset: 'analysis/paths/worker', export: 'runBoundedPathsWorker', driver: 'analysis/paths/driver' },
} as const);
export type BuiltinWorkerId = keyof typeof BUILTIN_WORKERS;
export function builtinWorker(id: unknown) {
  if (typeof id !== 'string' || !Object.hasOwn(BUILTIN_WORKERS, id)) {
    throw new ExecutionError('sentinel.execution.adapterInvalid', { reason: 'not a shipped built-in worker identity' });
  }
  return BUILTIN_WORKERS[id as BuiltinWorkerId];
}


/** Classification only: the coordinator supplies its genuine trusted adapter, driver and raw supervisor outcome. */
export function closureRefusalOf(adapter: TrustedAdapter | null, driver: CheckDriver | undefined, outcome: WorkerOutcome) {
  if (!adapter || adapter.kind !== 'built-in' || adapter.isolation !== 'child' || !Object.hasOwn(BUILTIN_WORKERS, adapter.id)) return undefined;
  const descriptor = BUILTIN_WORKERS[adapter.id as BuiltinWorkerId];
  if (!('closureRefusalExit' in descriptor) || driver?.adapterId !== adapter.id || driver.implementationDigest !== adapter.digest
    || outcome.adapter.id !== adapter.id || outcome.adapter.digest !== adapter.digest
    || outcome.state !== 'failed' || outcome.code !== 'sentinel.execution.workerExited' || outcome.worker?.kind !== 'owned-child'
    || outcome.exit?.exitCode !== descriptor.closureRefusalExit || outcome.exit.exitSignal !== null
    || outcome.protocol.frames !== 0 || outcome.protocol.bytes !== 0 || outcome.result !== undefined || outcome.outputs.length !== 0) return undefined;
  return { code: 'sentinel.execution.closureRefused' as const, detail: {
    originalCode: outcome.code, exitCode: outcome.exit.exitCode, exitSignal: outcome.exit.exitSignal,
    phase: 'before-hello', adapter: { id: adapter.id, digest: adapter.digest },
  } };
}
