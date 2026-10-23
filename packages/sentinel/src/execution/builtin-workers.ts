// Closed internal identities. A descriptor names only Sentinel's fixed shipped files and export, never caller code.
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
