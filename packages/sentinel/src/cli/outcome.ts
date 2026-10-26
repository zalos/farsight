// Typed command outcomes and their exit codes. The five policy results keep Sentinel's own codes (0 satisfied,
// 1 finding policy failed, 2 required coverage incomplete, 3 configuration failure, 4 awaiting confirmation); the
// remaining outcome words describe what a command did that is not a policy result, and reuse those codes without
// borrowing a policy word. JSON output always carries the outcome, the exit code and the three admission verdicts.
import { POLICY_EXIT_CODES } from '../validate.js';
import type { PolicyResult } from '../contracts/index.js';

/** What a command did when it was not a scan's final policy result. */
export type CommandEffectOutcome =
  /** `run --detach`: the run was admitted and handed to the coordinator; nothing about its result is known yet. */
  | 'submitted'
  /** pause, cancel: the service accepted the control; the run reaches the state when its work in flight ends. */
  | 'requested'
  /** A command this build does not run; nothing was started. */
  | 'unavailable'
  /** `init` wrote the private settings file. */
  | 'prepared'
  /** `init` found settings already there and left their bytes untouched. */
  | 'kept'
  /** help, version, capabilities, validate: answered locally, no store, scan or service involved. */
  | 'answered'
  /** The command line or a local input could not be used. */
  | 'refused'
  /** The owner import is retained; no scan or coverage verdict follows. */
  | 'proposed'
  | 'applied'
  | 'read'
  | 'accepted'
  /** Exactly one old import operation released its pending pins. */
  | 'abandoned'
  /** Delivery failed; acceptance metadata separately states whether publication already happened. */
  | 'delivery-failed';

export type CommandOutcome = PolicyResult | CommandEffectOutcome;

/** The exit code of each outcome. Only the five policy results own their codes; the others never claim one. */
export const OUTCOME_EXIT_CODES: Readonly<Record<CommandOutcome, number>> = Object.freeze({
  ...POLICY_EXIT_CODES,
  proposed: 0,
  applied: 0,
  read: 0,
  accepted: 0,
  abandoned: 0,
  'delivery-failed': 3,
  submitted: 0,
  requested: 0,
  answered: 0,
  prepared: 0,
  kept: 0,
  unavailable: 3,
  refused: 3,
});

/** One of the three ANDed admission verdicts, as printed. `asked: false` when nothing was admitted or contacted. */
export interface PrintedVerdict {
  readonly allowed: boolean;
  readonly asked: boolean;
  readonly reasonCode: string;
}

export interface PrintedVerdicts {
  readonly policy: PrintedVerdict;
  readonly capability: PrintedVerdict;
  readonly credential: PrintedVerdict;
}

/** Every verdict when a command admitted nothing: none was asked, none allowed. */
export const NOT_ASKED: PrintedVerdicts = Object.freeze({
  policy: Object.freeze({ allowed: false, asked: false, reasonCode: 'sentinel.verdict.notAsked' }),
  capability: Object.freeze({ allowed: false, asked: false, reasonCode: 'sentinel.verdict.notAsked' }),
  credential: Object.freeze({ allowed: false, asked: false, reasonCode: 'sentinel.verdict.notAsked' }),
});

export interface CommandResult {
  readonly command: string;
  readonly outcome: CommandOutcome;
  readonly exitCode: number;
  readonly verdicts: PrintedVerdicts;
  /** Every fact behind the outcome, kept even when a stronger one decided the exit code. */
  readonly facts: Readonly<Record<string, unknown>>;
  /** Catalog reason when the outcome is a refusal or unavailable. */
  readonly reasonCode?: string;
}

export function result(
  command: string,
  outcome: CommandOutcome,
  options: {
    verdicts?: PrintedVerdicts;
    facts?: Record<string, unknown>;
    reasonCode?: string;
  } = {},
): CommandResult {
  return Object.freeze({
    command,
    outcome,
    exitCode: OUTCOME_EXIT_CODES[outcome],
    verdicts: options.verdicts ?? NOT_ASKED,
    facts: Object.freeze({ ...(options.facts ?? {}) }),
    ...(options.reasonCode === undefined ? {} : { reasonCode: options.reasonCode }),
  });
}

/** Whether an outcome means the scan finished and its final policy result is known. */
export const isFinalPolicyResult = (o: CommandOutcome): o is Exclude<PolicyResult, 'awaiting-confirmation'> =>
  o === 'satisfied' || o === 'finding-policy-failed' || o === 'required-coverage-incomplete';
