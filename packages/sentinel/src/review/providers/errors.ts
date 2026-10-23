// Why a model call was refused or failed. Each code is a catalog key in packages/core/src/strings-sentinel-providers.ts.
// `spend` says whether the request may have reached the provider: `possible` keeps its reservation held as
// uncertain, never released, because a failed or abandoned call does not prove a provider stopped computing or billing.
import { sentinelProviderWord } from '@farsight/core/dist/strings-sentinel-providers.js';

export const PROVIDER_ERROR_CODES = Object.freeze([
  'sentinel.provider.invalidProfile', 'sentinel.provider.notTrusted', 'sentinel.provider.originRefused',
  'sentinel.provider.termsRequired', 'sentinel.provider.unpriced', 'sentinel.provider.capabilityUntested',
  'sentinel.provider.capabilityMissing', 'sentinel.provider.featureDisabled', 'sentinel.provider.nativeClaudeDisabled', 'sentinel.provider.notAdmitted', 'sentinel.provider.receiptRequired',
  'sentinel.provider.bindingChanged', 'sentinel.provider.budgetExhausted', 'sentinel.provider.envelopeOverdrawn',
  'sentinel.provider.contextExceeded', 'sentinel.provider.requestTooLarge', 'sentinel.provider.responseTooLarge',
  'sentinel.provider.redirectRefused', 'sentinel.provider.httpStatus', 'sentinel.provider.malformedResponse',
  'sentinel.provider.identityMalformed', 'sentinel.provider.identityMismatch', 'sentinel.provider.timeout',
  'sentinel.provider.canceled', 'sentinel.provider.unreachable', 'sentinel.provider.credentialUnavailable',
  'sentinel.provider.operationConflict', 'sentinel.provider.reservationState', 'sentinel.provider.ledgerInvalid', 'sentinel.provider.epochFenced',
] as const);
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number];

export type Spend = 'none' | 'possible';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly spend: Spend;
  /** `detail` must never hold a credential, a request or response body, or a provider's own error text. */
  constructor(code: ProviderErrorCode, detail = '', spend: Spend = 'none') {
    super(sentinelProviderWord(code, { detail }));
    this.name = 'ProviderError';
    this.code = code;
    this.spend = spend;
  }
}

export const fail = (code: ProviderErrorCode, detail = '', spend: Spend = 'none'): never => { throw new ProviderError(code, detail, spend); };

/** Closed nonsecret native refusal metadata. Diagnostic only; never permission, identity or spend evidence. */
export interface NativeAuthDiagnostic {
  readonly schema: 'sentinel-native-auth-refusal/1';
  readonly phase: 'no-ui' | 'lookup' | 'validate' | 'transport';
  readonly reason: 'unavailable' | 'interaction-required' | 'authorization-failed' | 'missing' | 'expired' | 'unsupported';
  readonly osStatus: number | null;
}
export function parseNativeAuthDiagnostic(bytes: Uint8Array): Readonly<NativeAuthDiagnostic> | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > 256) return undefined;
  try {
    const d = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
    if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).sort().join() !== 'osStatus,phase,reason,schema'
      || d.schema !== 'sentinel-native-auth-refusal/1' || !['no-ui','lookup','validate','transport'].includes(d.phase)
      || !['unavailable','interaction-required','authorization-failed','missing','expired','unsupported'].includes(d.reason)
      || (d.osStatus !== null && (!Number.isInteger(d.osStatus) || d.osStatus < -2147483648 || d.osStatus > 2147483647))) return undefined;
    return Object.freeze({ schema: d.schema, phase: d.phase, reason: d.reason, osStatus: d.osStatus });
  } catch { return undefined; }
}
export class NativeCredentialError extends ProviderError {
  readonly nativeAuth: Readonly<NativeAuthDiagnostic>;
  constructor(diagnostic: NativeAuthDiagnostic) {
    super('sentinel.provider.credentialUnavailable', 'native login unavailable without interaction');
    this.nativeAuth = Object.freeze({ ...diagnostic });
  }
}

/** Fixed diagnostic metadata only. Never the native event/error text, paths, hosts or authentication data. */
export interface NativeCopilotDiagnostic {
 readonly schema:'sentinel-copilot-failure/1';readonly phase:'setup'|'spawn'|'stream'|'exit'|'usage-read'|'usage';
 readonly reason:'output-unavailable'|'process-error'|'process-exit'|'stdin-error'|'canceled'|'deadline'|'response-bound'|'invalid-json'|'invalid-event'|'disallowed-event'|'session-identity'|'visible-message'|'result'|'usage-file'|'usage-shape'|'usage-model'|'usage-count'|'usage-tokens';
 readonly exitCode:number|null;readonly signal:null|'SIGKILL'|'SIGTERM'|'SIGABRT'|'SIGSEGV'|'other';
 readonly eventClass:'none'|'session-start'|'visible'|'result'|'lifecycle'|'unknown';readonly frames:number;readonly stdoutBytes:number;readonly stderrBytes:number;
 readonly connections:number;readonly upstreamBytes:number;readonly downstreamBytes:number;readonly proxyEnded:'open'|'closed'|'canceled'|'deadline'|'bounds'|'refused'|'unreachable';
}
export class NativeCopilotError extends ProviderError {
 readonly nativeCopilot:Readonly<NativeCopilotDiagnostic>;
 constructor(code:ProviderErrorCode,spend:Spend,diagnostic:NativeCopilotDiagnostic){super(code,'closed Copilot failure diagnostic',spend);
 const d=diagnostic;if(!d||Object.keys(d).sort().join()!=='connections,downstreamBytes,eventClass,exitCode,frames,phase,proxyEnded,reason,schema,signal,stderrBytes,stdoutBytes,upstreamBytes'||d.schema!=='sentinel-copilot-failure/1'||!['setup','spawn','stream','exit','usage-read','usage'].includes(d.phase)||!['output-unavailable','process-error','process-exit','stdin-error','canceled','deadline','response-bound','invalid-json','invalid-event','disallowed-event','session-identity','visible-message','result','usage-file','usage-shape','usage-model','usage-count','usage-tokens'].includes(d.reason)||!['none','session-start','visible','result','lifecycle','unknown'].includes(d.eventClass)||!['open','closed','canceled','deadline','bounds','refused','unreachable'].includes(d.proxyEnded)||(d.exitCode!==null&&(!Number.isInteger(d.exitCode)||d.exitCode<0||d.exitCode>255))||(d.signal!==null&&!['SIGKILL','SIGTERM','SIGABRT','SIGSEGV','other'].includes(d.signal))||[d.frames,d.stdoutBytes,d.stderrBytes,d.connections,d.upstreamBytes,d.downstreamBytes].some(n=>!Number.isInteger(n)||n<0||n>2147483647))throw new ProviderError('sentinel.provider.malformedResponse','invalid closed diagnostic',spend);
 this.nativeCopilot=Object.freeze({...d})}
}
/** Bounded existing ledger event, not a second log or authority channel. */
export function copilotFailureEvent(error:NativeCopilotError):string {
 const d=error.nativeCopilot;
 const value=error.code+'|copilot1:'+JSON.stringify([d.phase,d.reason,d.exitCode,d.signal,d.eventClass,d.frames,d.stdoutBytes,d.stderrBytes,d.connections,d.upstreamBytes,d.downstreamBytes,d.proxyEnded]);
 if(value.length>200)return error.code+'|copilot1:diagnostic-bound';return value;
}
