// The one error type worker execution raises, and the reason codes a worker outcome carries. `code` is a stable
// catalog key (packages/core/src/strings-sentinel-execution.ts); `detail` is safe structured context, never a
// worker's raw output, an input's contents or a credential.
import { sentinelExecutionWord } from '@farsight/core/dist/strings-sentinel-execution.js';

export const EXECUTION_ERROR_CODES = Object.freeze([
  'sentinel.execution.isolationUnavailable', 'sentinel.execution.backendUnqualified', 'sentinel.execution.imageMissing',
  'sentinel.execution.imageMismatch', 'sentinel.execution.isolationMismatch', 'sentinel.execution.adapterUnknown',
  'sentinel.execution.adapterInvalid', 'sentinel.execution.adapterIsolationRefused', 'sentinel.execution.inputMismatch',
  'sentinel.execution.frameTooLarge', 'sentinel.execution.frameMalformed', 'sentinel.execution.messageInvalid',
  'sentinel.execution.protocolViolation', 'sentinel.execution.versionRefused', 'sentinel.execution.adapterIdentityMismatch',
  'sentinel.execution.resultMismatch', 'sentinel.execution.outputMismatch', 'sentinel.execution.outputTooLarge',
  'sentinel.execution.stdoutBudget', 'sentinel.execution.deadlineExceeded', 'sentinel.execution.canceled',
  'sentinel.execution.resourceExceeded', 'sentinel.execution.workerExited', 'sentinel.execution.cleanupFailed',
  'sentinel.execution.commandFailed', 'sentinel.execution.scratchUnsafe', 'sentinel.execution.reconciliationPending',
  'sentinel.execution.stderrBudget', 'sentinel.execution.planInvalid', 'sentinel.execution.durabilityFailed',
  'sentinel.execution.journalUnreadable', 'sentinel.execution.cleanupObligation', 'sentinel.execution.dependencyFailed',
  'sentinel.execution.runDeadline',
  'sentinel.execution.bootstrapEvidence',
] as const);

export type ExecutionErrorCode = typeof EXECUTION_ERROR_CODES[number];
export type ExecutionErrorDetail = Record<string, string | number | boolean | null | readonly string[]>;

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly detail: Readonly<ExecutionErrorDetail>;

  constructor(code: ExecutionErrorCode, detail: ExecutionErrorDetail = {}, options?: { cause?: unknown }) {
    const values: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(detail)) {
      if (typeof v === 'string' || typeof v === 'number') values[k] = v;
      else if (Array.isArray(v)) values[k] = v.join(', ');
    }
    super(sentinelExecutionWord(code, values), options);
    this.name = 'ExecutionError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

export function isExecutionError(error: unknown, code?: ExecutionErrorCode): error is ExecutionError {
  return error instanceof ExecutionError && (code === undefined || error.code === code);
}
