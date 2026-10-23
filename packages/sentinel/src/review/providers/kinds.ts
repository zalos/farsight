// The two provider kinds' wire formats (PR 21): Ollama's native API and an OpenAI-compatible chat-completions API.
// Each builds one non-streaming request from bounded messages and reads one reply strictly. A reply's model identity,
// usage and finish reason are read as reported, at their actual strength; nothing is inferred from response text.
// Compatibility is per endpoint: `probeCapability` lists what this origin offers, it does not assume a vendor.
import type { EndpointOrigin } from '../../contracts/index.js';
import { isEffectivePolicy, type EffectivePolicy } from '../../policy/settings.js';
import type { Secret } from './credentials.js';
import { ProviderError, fail } from './errors.js';
import type { CapabilityRecord, ProviderKind } from './profile.js';
import { exchange } from './transport.js';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** How a model's identity is known: host-reported names a local runtime's own report, provider-response a remote one. */
export type IdentityStrength = 'provider-response' | 'host-reported';

export interface ReplyIdentity {
  readonly requestedModel: string;
  readonly returnedModel: string;
  /** The revision the capability probe listed (Ollama's weight digest); a probe-time fact, not proof for this call. */
  readonly probedRevision: string | null;
  readonly source: IdentityStrength;
}

export interface ReportedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export type FinishReason = 'complete' | 'length' | 'unknown';

export interface ParsedReply {
  readonly content: string;
  /** null when the reply named no model, or not as text. */
  readonly returnedModel: string | null;
  readonly usage: ReportedUsage;
  readonly finish: FinishReason;
}

const MAX_MODEL = 200;
const PATHS = {
  ollama: { chat: '/api/chat', list: '/api/tags' },
  'openai-compatible': { chat: '/v1/chat/completions', list: '/v1/models' },
} as const;

export const chatPath = (kind: ProviderKind) => (kind === 'claude-cli' || kind === 'copilot-cli') ? fail('sentinel.provider.invalidProfile', 'native CLI has no HTTP chat path') : PATHS[kind].chat;

const object = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const modelName = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= MAX_MODEL && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);

/** The one request body for a chat call. */
export function chatBody(kind: ProviderKind, model: string, messages: readonly ChatMessage[], maxOutputTokens: number, contextTokens: number): unknown {
  if ((kind === 'claude-cli' || kind === 'copilot-cli')) return fail('sentinel.provider.invalidProfile', 'native CLI uses its retained versioned wire');
  const msgs = messages.map(m => ({ role: m.role, content: m.content }));
  if (kind === 'ollama') return { model, messages: msgs, stream: false, options: { num_predict: maxOutputTokens, num_ctx: contextTokens } };
  return { model, messages: msgs, stream: false, n: 1, max_tokens: maxOutputTokens };
}

/** Reads one chat reply. Throws malformedResponse for a shape that is not this kind's reply. */
export function parseReply(kind: ProviderKind, json: unknown): ParsedReply {
  if ((kind === 'claude-cli' || kind === 'copilot-cli')) return fail('sentinel.provider.invalidProfile', 'native CLI uses its fixed stream decoder');
  const bad = (d: string) => fail('sentinel.provider.malformedResponse', d, 'possible');
  const r = object(json) ?? bad('not an object');
  if (kind === 'ollama') {
    if (r.done !== true) bad('the reply is not finished');
    const message = object(r.message) ?? bad('no message');
    if (typeof message.content !== 'string') bad('no message text');
    const reason = r.done_reason;
    return {
      content: message.content as string, returnedModel: modelName(r.model),
      usage: { inputTokens: count(r.prompt_eval_count), outputTokens: count(r.eval_count) },
      finish: reason === 'stop' ? 'complete' : reason === 'length' ? 'length' : 'unknown',
    };
  }
  const choices = Array.isArray(r.choices) ? r.choices : bad('no choices');
  if (choices.length !== 1) bad('exactly one choice was asked for');
  const choice = object(choices[0]) ?? bad('no choice');
  const message = object(choice.message) ?? bad('no message');
  if (typeof message.content !== 'string') bad('no message text');
  const usage = object(r.usage);
  const reason = choice.finish_reason;
  return {
    content: message.content as string, returnedModel: modelName(r.model),
    usage: { inputTokens: count(usage?.prompt_tokens), outputTokens: count(usage?.completion_tokens) },
    finish: reason === 'stop' ? 'complete' : reason === 'length' ? 'length' : 'unknown',
  };
}

export interface ProbeRequest {
  readonly kind: ProviderKind;
  readonly origin: EndpointOrigin;
  readonly model: string;
  readonly credential?: Secret | null;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
  readonly now: Date;
}

/**
 * Asks the origin which models it offers (unpaid: a listing, no inference) and returns a capability record when the
 * model is listed. The caller must already be allowed to contact this origin; the probe sends no source.
 */
export async function probeCapability(p: ProbeRequest): Promise<CapabilityRecord> {
  if ((p.kind === 'claude-cli' || p.kind === 'copilot-cli')) return fail('sentinel.provider.capabilityUntested', 'native CLI qualification uses fixed executable and helper bytes, not a listing');
  const { json } = await exchange({ origin: p.origin, method: 'GET', path: PATHS[p.kind].list, credential: p.credential ?? null,
    timeoutMs: p.timeoutMs, maxResponseBytes: p.maxResponseBytes, ...(p.signal ? { signal: p.signal } : {}) });
  const r = object(json);
  let revision: string | null = null;
  let listed = false;
  if (p.kind === 'ollama') {
    const models = Array.isArray(r?.models) ? r!.models as unknown[] : fail('sentinel.provider.malformedResponse', 'no model list');
    for (const m of models) {
      const o = object(m);
      if (o && (o.name === p.model || o.model === p.model)) {
        listed = true;
        revision = typeof o.digest === 'string' && /^[0-9a-f]{64}$/.test(o.digest) ? `sha256:${o.digest}` : null;
        break;
      }
    }
  } else {
    const data = Array.isArray(r?.data) ? r!.data as unknown[] : fail('sentinel.provider.malformedResponse', 'no model list');
    listed = data.some(d => object(d)?.id === p.model);
  }
  if (!listed) throw new ProviderError('sentinel.provider.capabilityMissing', p.model.slice(0, 64));
  return Object.freeze({ schema: 'sentinel-model-capability/draft-1', kind: p.kind, origin: p.origin, model: p.model, listed: true, revision,
    probedAt: p.now.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z') });
}

/**
 * The owner's probe of one configured model: origin and kind come from the adopted settings, never the caller. The
 * returned record is adopted only by the owner re-adopting settings that contain it.
 */
export async function probeConfigured(policy: EffectivePolicy,
  providerId: string, modelId: string, options: { credential?: Secret | null; timeoutMs: number; maxResponseBytes: number; signal?: AbortSignal; now: Date }): Promise<CapabilityRecord> {
  if (!isEffectivePolicy(policy)) fail('sentinel.provider.notTrusted', 'a probe is made only under effectivePolicy\u2019s own result');
  const p = policy.settings.providers.find(x => x.id === providerId);
  const m = p?.models?.find(x => x.id === modelId);
  if (!p || !m) return fail('sentinel.provider.notTrusted', 'the adopted settings define no such provider or model');
  return probeCapability({ kind: p.kind, origin: p.endpoint, model: m.model, ...options });
}
