// The chat message, reply and identity shapes every provider kind shares, and the HTTP entry points (PR 21). Each
// HTTP kind's own codec is in `http-kinds.ts`, reached through the registry; a CLI kind has no HTTP path, body or
// listing and is refused here. Compatibility is per endpoint: `probeCapability` lists what this origin offers, it
// does not assume a vendor.
import type { EndpointOrigin } from '../../contracts/index.js';
import { isEffectivePolicy, type EffectivePolicy } from '../../policy/settings.js';
import type { Secret } from './credentials.js';
import { ProviderError, fail } from './errors.js';
import type { CapabilityRecord, ProviderKind } from './profile.js';
import { exchange } from './transport.js';
import { httpKind } from './registry.js';

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

const object = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export const chatPath = (kind: ProviderKind) => httpKind(kind, 'native CLI has no HTTP chat path').chatPath;

/** The one request body for a chat call. */
export function chatBody(
  kind: ProviderKind,
  model: string,
  messages: readonly ChatMessage[],
  maxOutputTokens: number,
  contextTokens: number,
): unknown {
  return httpKind(kind, 'native CLI uses its retained versioned wire').body(
    model,
    messages,
    maxOutputTokens,
    contextTokens,
  );
}

/** Reads one chat reply. Throws malformedResponse for a shape that is not this kind's reply. */
export function parseReply(kind: ProviderKind, json: unknown): ParsedReply {
  const wire = httpKind(kind, 'native CLI uses its fixed stream decoder');
  return wire.parse(object(json) ?? fail('sentinel.provider.malformedResponse', 'not an object', 'possible'));
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
  const wire = httpKind(
    p.kind,
    'native CLI qualification uses fixed executable and helper bytes, not a listing',
    'sentinel.provider.capabilityUntested',
  );
  const { json } = await exchange({
    origin: p.origin,
    method: 'GET',
    path: wire.listPath,
    credential: p.credential ?? null,
    timeoutMs: p.timeoutMs,
    maxResponseBytes: p.maxResponseBytes,
    ...(p.signal ? { signal: p.signal } : {}),
  });
  const { listed, revision } = wire.listed(object(json), p.model);
  if (!listed) throw new ProviderError('sentinel.provider.capabilityMissing', p.model.slice(0, 64));
  return Object.freeze({
    schema: 'sentinel-model-capability/draft-1',
    kind: p.kind,
    origin: p.origin,
    model: p.model,
    listed: true,
    revision,
    probedAt: p.now.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z'),
  });
}

/**
 * The owner's probe of one configured model: origin and kind come from the adopted settings, never the caller. The
 * returned record is adopted only by the owner re-adopting settings that contain it.
 */
export async function probeConfigured(
  policy: EffectivePolicy,
  providerId: string,
  modelId: string,
  options: { credential?: Secret | null; timeoutMs: number; maxResponseBytes: number; signal?: AbortSignal; now: Date },
): Promise<CapabilityRecord> {
  if (!isEffectivePolicy(policy))
    fail('sentinel.provider.notTrusted', 'a probe is made only under effectivePolicy\u2019s own result');
  const p = policy.settings.providers.find((x) => x.id === providerId);
  const m = p?.models?.find((x) => x.id === modelId);
  if (!p || !m) return fail('sentinel.provider.notTrusted', 'the adopted settings define no such provider or model');
  return probeCapability({ kind: p.kind, origin: p.endpoint, model: m.model, ...options });
}
