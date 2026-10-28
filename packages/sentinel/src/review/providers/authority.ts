// The one-start call authorities the broker issues for a native CLI turn, and the checks a native call makes against
// them. Package-internal: only the broker's generate issues one, from its private envelope after a durable
// reservation is dispatched; no caller JSON or copied object can mint, reuse or widen one.
import { isConsumedReceipt, type ConsumedReceipt } from '../../policy/receipts.js';
import type { BudgetLedger } from './budget.js';
import { fail } from './errors.js';
import { nativeRuntimeHelper, type NativeClaudeRuntime, type NativeTiming } from './cli-native-profile.js';
import type { NativeCopilotRuntime } from './cli-copilot-profile.js';
import type { NativeReviewWire } from './cli-native-wire.js';

export type NativeLimits = NativeTiming & { maxResponseBytes: number; maxOutputTokens: number };

/** Package-internal opaque authority. No exported factory outside the broker: only generate issues it. */
export interface NativeCallAuthority {
  readonly nativeCall: 'closed-v1';
}
type NativeCallContext = { runtime: NativeClaudeRuntime; wire: NativeReviewWire; limits: NativeLimits };
const nativeCalls = new WeakMap<
  object,
  NativeCallContext & {
    ledger: BudgetLedger;
    reservationId: string;
    receipt: ConsumedReceipt;
    phase: 'issued' | 'started' | 'read';
  }
>();

/** Issued by the broker only, for one dispatched reservation under a consumed receipt. */
export function issueNativeCall(
  context: NativeCallContext & { ledger: BudgetLedger; reservationId: string; receipt: ConsumedReceipt },
): NativeCallAuthority {
  const authority = Object.freeze({ nativeCall: 'closed-v1' as const });
  nativeCalls.set(authority, { ...context, phase: 'issued' });
  return authority;
}
function activeNativeCall(value: object) {
  const held = nativeCalls.get(value);
  if (!held || !isConsumedReceipt(held.receipt) || held.ledger.reservation(held.reservationId).state !== 'dispatched')
    return fail('sentinel.provider.notAdmitted', 'native call has no live admitted reservation');
  if (held.limits.signal?.aborted) fail('sentinel.provider.canceled', 'native authority canceled');
  if (Date.now() >= held.limits.deadlineAt)
    fail('sentinel.provider.timeout', 'native authority original deadline elapsed');
  return held;
}
/** One start only, validated against broker-private state. A qualified executable alone grants nothing. */
export function beginNativeCall(value: NativeCallAuthority): NativeCallContext {
  const held = activeNativeCall(value);
  if (held.phase !== 'issued') return fail('sentinel.provider.notAdmitted', 'native call authority was already used');
  held.phase = 'started';
  return { runtime: held.runtime, wire: held.wire, limits: held.limits };
}
/** The helper additionally consumes its exact one-read authority before the fixed native query. */
export function claimNativeLogin(value: NativeCallAuthority, helper: object, timing: NativeTiming): void {
  const held = activeNativeCall(value);
  if (
    held.phase !== 'started' ||
    nativeRuntimeHelper(held.runtime) !== helper ||
    held.limits.deadlineAt !== timing.deadlineAt ||
    held.limits.signal !== timing.signal
  )
    return fail('sentinel.provider.notAdmitted', 'native login has no exact one-read authority');
  held.phase = 'read';
}
export function assertNativeLoginActive(value: NativeCallAuthority): void {
  const held = activeNativeCall(value);
  if (held.phase !== 'read') fail('sentinel.provider.notAdmitted', 'native login authority is not active');
}
export function finishNativeCall(value: NativeCallAuthority): void {
  nativeCalls.delete(value);
}

/** Separate private one-start capability for the fixed Copilot path; no caller JSON can mint one. */
export interface CopilotCallAuthority {
  readonly nativeCall: 'copilot-closed-v1';
}
type CopilotContext = { runtime: NativeCopilotRuntime; wire: NativeReviewWire; limits: NativeLimits };
const copilotCalls = new WeakMap<
  object,
  CopilotContext & { ledger: BudgetLedger; reservationId: string; receipt: ConsumedReceipt; started: boolean }
>();

/** Issued by the broker only, for one dispatched reservation under a consumed receipt. */
export function issueCopilotCall(
  context: CopilotContext & { ledger: BudgetLedger; reservationId: string; receipt: ConsumedReceipt },
): CopilotCallAuthority {
  const authority = Object.freeze({ nativeCall: 'copilot-closed-v1' as const });
  copilotCalls.set(authority, { ...context, started: false });
  return authority;
}
export function beginCopilotCall(value: CopilotCallAuthority): CopilotContext {
  const held = copilotCalls.get(value);
  if (
    !held ||
    held.started ||
    !isConsumedReceipt(held.receipt) ||
    held.ledger.reservation(held.reservationId).state !== 'dispatched'
  )
    return fail('sentinel.provider.notAdmitted', 'Copilot requires its exact unused dispatched authority');
  if (held.limits.signal?.aborted) return fail('sentinel.provider.canceled', 'Copilot authority canceled');
  if (Date.now() >= held.limits.deadlineAt)
    return fail('sentinel.provider.timeout', 'Copilot authority deadline elapsed');
  held.started = true;
  return { runtime: held.runtime, wire: held.wire, limits: held.limits };
}
export function finishCopilotCall(value: CopilotCallAuthority) {
  copilotCalls.delete(value);
}

/** The one-start capability for one native-mode Copilot run; the broker issues it after dispatching the reservation. */
export interface CopilotAgentAuthority {
  readonly nativeCall: 'copilot-agent-v1';
}
type CopilotAgentContext = {
  runtime: NativeCopilotRuntime;
  request: import('./cli-copilot-agent.js').CopilotAgentRequest;
  limits: NativeTiming;
};
const copilotAgentCalls = new WeakMap<
  object,
  CopilotAgentContext & { ledger: BudgetLedger; reservationId: string; receipt: ConsumedReceipt; started: boolean }
>();
export function issueCopilotAgentCall(
  context: CopilotAgentContext & { ledger: BudgetLedger; reservationId: string; receipt: ConsumedReceipt },
): CopilotAgentAuthority {
  const authority = Object.freeze({ nativeCall: 'copilot-agent-v1' as const });
  copilotAgentCalls.set(authority, { ...context, started: false });
  return authority;
}
export function beginCopilotAgentCall(value: CopilotAgentAuthority): CopilotAgentContext {
  const held = copilotAgentCalls.get(value);
  if (
    !held ||
    held.started ||
    !isConsumedReceipt(held.receipt) ||
    held.ledger.reservation(held.reservationId).state !== 'dispatched'
  )
    return fail('sentinel.provider.notAdmitted', 'Copilot native run requires its exact unused dispatched authority');
  if (held.limits.signal?.aborted) return fail('sentinel.provider.canceled', 'Copilot native authority canceled');
  if (Date.now() >= held.limits.deadlineAt)
    return fail('sentinel.provider.timeout', 'Copilot native authority deadline elapsed');
  held.started = true;
  return { runtime: held.runtime, request: held.request, limits: held.limits };
}
export function finishCopilotAgentCall(value: CopilotAgentAuthority) {
  copilotAgentCalls.delete(value);
}
