// Exact native wire and bounded final-visible-result decoder. This is data, never admission or launch authority.
import { canonicalJsonBytes } from '../../store/objects.js';
import type { ChatMessage, ParsedReply } from './kinds.js';
import { fail } from './errors.js';
export type { NativeReviewWire } from '../../contracts/instructions.js';
import type { NativeReviewWire } from '../../contracts/instructions.js';
export function renderNativeClaudeWire(
  model: string,
  messages: readonly ChatMessage[],
  maxOutputTokens: number,
): NativeReviewWire {
  if (messages.length < 2 || messages[0]?.role !== 'system' || messages.slice(1).some((m) => m.role === 'system'))
    return fail('sentinel.provider.invalidProfile', 'native wire has exactly one leading system message');
  return Object.freeze({
    encoding: 'sentinel-claude-chat/v1',
    system: messages[0].content,
    // One print-mode user prompt explicitly carries retained role-tagged history. It is not a native chat API array.
    stdin: Buffer.from(
      canonicalJsonBytes({
        encoding: 'sentinel-claude-chat/v1',
        messages: messages.slice(1).map((m) => ({ role: m.role, content: m.content })),
        maxOutputTokens,
      }),
    ).toString('utf8'),
    requestedModel: model,
  });
}
const object = (v: unknown): Record<string, any> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export class NativeClaudeDecoder {
  #pending = Buffer.alloc(0);
  #total = 0;
  #frames = 0;
  #result: ParsedReply | undefined;
  #model: string | undefined;
  constructor(readonly maxBytes: number) {}
  push(chunk: Uint8Array): void {
    this.#total += chunk.byteLength;
    if (this.#total > this.maxBytes)
      return fail('sentinel.provider.responseTooLarge', 'native stream byte bound', 'possible');
    this.#pending = Buffer.concat([this.#pending, chunk]);
    let at: number;
    while ((at = this.#pending.indexOf(10)) !== -1) {
      const line = this.#pending.subarray(0, at);
      this.#pending = this.#pending.subarray(at + 1);
      this.#line(line);
    }
  }
  #line(bytes: Uint8Array): void {
    if (bytes.byteLength === 0 || ++this.#frames > 128 || this.#result)
      return fail('sentinel.provider.malformedResponse', 'native stream framing', 'possible');
    let e: Record<string, any> | null;
    try {
      e = object(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)));
    } catch {
      return fail('sentinel.provider.malformedResponse', 'native stream JSON', 'possible');
    }
    if (!e || typeof e.type !== 'string')
      return fail('sentinel.provider.malformedResponse', 'native stream event', 'possible');
    if (e.type === 'system' && e.subtype === 'init') {
      if (this.#model !== undefined || typeof e.model !== 'string' || e.model.length > 200)
        return fail('sentinel.provider.identityMalformed', 'native initialization identity', 'possible');
      this.#model = e.model;
    }
    if (
      e.type === 'assistant' &&
      Array.isArray(e.message?.content) &&
      e.message.content.some((c: any) => c?.type === 'tool_use')
    )
      return fail('sentinel.provider.malformedResponse', 'native tool use is outside this profile', 'possible');
    // Never retain assistant thinking/events/status. Only the vendor's final visible result is exposed.
    if (e.type !== 'result') return;
    if (
      e.subtype !== 'success' ||
      e.is_error !== false ||
      e.num_turns !== 1 ||
      typeof e.result !== 'string' ||
      !['end_turn', 'max_tokens'].includes(e.stop_reason)
    )
      return fail(
        'sentinel.provider.malformedResponse',
        'native final result was not one successful bounded turn',
        'possible',
      );
    const usage = object(e.usage),
      models = object(e.modelUsage);
    if (!usage || !models || Object.keys(models).length !== 1)
      return fail('sentinel.provider.malformedResponse', 'native usage or model identity is unavailable', 'possible');
    const model = Object.keys(models)[0]!;
    if (!this.#model || this.#model !== model)
      return fail(
        'sentinel.provider.identityMalformed',
        'native initialization and result identities differ',
        'possible',
      );
    const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
    if (fields.some((k) => !count(usage[k])))
      return fail('sentinel.provider.malformedResponse', 'native token consumption is unobserved', 'possible');
    const input = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    if (!Number.isSafeInteger(input))
      return fail('sentinel.provider.malformedResponse', 'native token total bounds', 'possible');
    this.#result = {
      content: e.result,
      returnedModel: model,
      usage: { inputTokens: input, outputTokens: usage.output_tokens },
      finish: e.stop_reason === 'max_tokens' ? 'length' : 'complete',
    };
  }
  finish(): ParsedReply {
    if (this.#pending.length) {
      const last = this.#pending;
      this.#pending = Buffer.alloc(0);
      this.#line(last);
    }
    if (!this.#result)
      return fail('sentinel.provider.malformedResponse', 'native EOF without a final result', 'possible');
    return this.#result;
  }
}
