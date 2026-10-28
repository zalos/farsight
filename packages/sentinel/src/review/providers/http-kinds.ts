// The two HTTP provider kinds' wire formats (PR 21): Ollama's native API and an OpenAI-compatible chat-completions API.
// Each builds one non-streaming request from bounded messages and reads one reply strictly. A reply's model identity,
// usage and finish reason are read as reported, at their actual strength; nothing is inferred from response text.
// The registry (`registry.ts`) is the only reader of these functions.
import { fail } from './errors.js';
import type { ChatMessage, ParsedReply } from './kinds.js';

/** One HTTP kind's paths and strict codecs. */
export interface HttpKindWire {
  readonly chatPath: string;
  readonly listPath: string;
  body(model: string, messages: readonly ChatMessage[], maxOutputTokens: number, contextTokens: number): unknown;
  parse(reply: Record<string, unknown>): ParsedReply;
  /** Whether a listing names the model, and the immutable revision it states when it does. */
  listed(listing: Record<string, unknown> | null, model: string): { listed: boolean; revision: string | null };
}

const MAX_MODEL = 200;
const object = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const modelName = (v: unknown): string | null =>
  // eslint-disable-next-line no-control-regex -- Provider model names must exclude control characters.
  typeof v === 'string' && v.length > 0 && v.length <= MAX_MODEL && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
const bad = (d: string): never => fail('sentinel.provider.malformedResponse', d, 'possible');
const plain = (messages: readonly ChatMessage[]) => messages.map((m) => ({ role: m.role, content: m.content }));

export const OLLAMA_WIRE: HttpKindWire = Object.freeze({
  chatPath: '/api/chat',
  listPath: '/api/tags',
  body: (model: string, messages: readonly ChatMessage[], maxOutputTokens: number, contextTokens: number) => ({
    model,
    messages: plain(messages),
    stream: false,
    options: { num_predict: maxOutputTokens, num_ctx: contextTokens },
  }),
  parse(r: Record<string, unknown>): ParsedReply {
    if (r.done !== true) bad('the reply is not finished');
    const message = object(r.message) ?? bad('no message');
    if (typeof message.content !== 'string') bad('no message text');
    const reason = r.done_reason;
    return {
      content: message.content as string,
      returnedModel: modelName(r.model),
      usage: { inputTokens: count(r.prompt_eval_count), outputTokens: count(r.eval_count) },
      finish: reason === 'stop' ? 'complete' : reason === 'length' ? 'length' : 'unknown',
    };
  },
  listed(r: Record<string, unknown> | null, model: string) {
    const models = Array.isArray(r?.models)
      ? (r!.models as unknown[])
      : fail('sentinel.provider.malformedResponse', 'no model list');
    for (const m of models) {
      const o = object(m);
      if (o && (o.name === model || o.model === model))
        return {
          listed: true,
          revision: typeof o.digest === 'string' && /^[0-9a-f]{64}$/.test(o.digest) ? `sha256:${o.digest}` : null,
        };
    }
    return { listed: false, revision: null };
  },
});

export const OPENAI_COMPATIBLE_WIRE: HttpKindWire = Object.freeze({
  chatPath: '/v1/chat/completions',
  listPath: '/v1/models',
  body: (model: string, messages: readonly ChatMessage[], maxOutputTokens: number) => ({
    model,
    messages: plain(messages),
    stream: false,
    n: 1,
    max_tokens: maxOutputTokens,
  }),
  parse(r: Record<string, unknown>): ParsedReply {
    const choices = Array.isArray(r.choices) ? r.choices : bad('no choices');
    if (choices.length !== 1) bad('exactly one choice was asked for');
    const choice = object(choices[0]) ?? bad('no choice');
    const message = object(choice.message) ?? bad('no message');
    if (typeof message.content !== 'string') bad('no message text');
    const usage = object(r.usage);
    const reason = choice.finish_reason;
    return {
      content: message.content as string,
      returnedModel: modelName(r.model),
      usage: { inputTokens: count(usage?.prompt_tokens), outputTokens: count(usage?.completion_tokens) },
      finish: reason === 'stop' ? 'complete' : reason === 'length' ? 'length' : 'unknown',
    };
  },
  listed(r: Record<string, unknown> | null, model: string) {
    const data = Array.isArray(r?.data)
      ? (r!.data as unknown[])
      : fail('sentinel.provider.malformedResponse', 'no model list');
    return { listed: data.some((d) => object(d)?.id === model), revision: null };
  },
});
