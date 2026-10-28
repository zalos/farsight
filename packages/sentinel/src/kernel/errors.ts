// The one base every Sentinel error class extends (README §6, L0): a stable reason code and safe structured detail.
// A module's own error class keeps its name, its constructor and its codes; extending this base is what lets one
// `outcomeOf(error)` read any of them later.

/** Structured context an error carries: paths, versions, counts, OS error codes. Never file contents or a credential. */
export type SentinelErrorDetail = Readonly<Record<string, unknown>>;

/** What a Sentinel error carries beyond its message. */
export interface SentinelErrorOptions {
  /** Safe structured context, copied and frozen. */
  readonly detail?: Record<string, unknown>;
  /** The error that caused this one, kept as the standard `cause`. */
  readonly cause?: unknown;
}

/**
 * An error with a stable reason code. `code` is a catalog key (`sentinel.<area>.<reason>`) or a module's documented
 * code; `message` is the sentence a reader sees. `detail` is a frozen shallow copy of what the caller passed, empty
 * when nothing was, so a later change to the caller's object cannot alter a raised error.
 */
export class SentinelError<C extends string = string> extends Error {
  readonly code: C;
  readonly detail: SentinelErrorDetail;

  constructor(code: C, message: string, options: SentinelErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SentinelError';
    this.code = code;
    this.detail = Object.freeze({ ...(options.detail ?? {}) });
  }
}

/** True when `error` is a Sentinel error, and, when `code` is given, carries exactly that code. */
export function isSentinelError(error: unknown, code?: string): error is SentinelError {
  return error instanceof SentinelError && (code === undefined || error.code === code);
}
