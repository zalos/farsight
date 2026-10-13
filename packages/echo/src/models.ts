import { echoConfigWord } from '@farsight/core/dist/strings-echo-config.js';
import { resolveSecret } from './secrets.js';
import { submindSettings, validateModelSettings } from './config.js';
import type { SubmindModelRequest, SubmindModelResponse } from './submind-types.js';
import type { EchoProfile } from './types.js';

const MAX_INPUT_CHARS = 24_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 1_048_576;

function fail(key: string): never { throw new Error(echoConfigWord(key)); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('echo.model.response');
  return value as Record<string, unknown>;
}

function aborted(signal: AbortSignal): never {
  // Never pass through an arbitrary caller/provider abort reason (it may contain private data).
  const error = new Error(echoConfigWord('echo.model.request'));
  error.name = signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
  throw error;
}
function checkAbort(signal: AbortSignal): void { if (signal.aborted) aborted(signal); }

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  let listener: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () => { try { aborted(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', listener!); }
}

async function request(profile: EchoProfile, path: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
  const model = validateModelSettings(profile.model);
  const timeoutMs = options.timeoutMs ?? profile.budget.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) fail('echo.model.input');
  let encoded: string | undefined;
  try { encoded = body === undefined ? undefined : JSON.stringify(body); } catch { fail('echo.model.input'); }
  if (encoded !== undefined && Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) fail('echo.model.input');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('', 'TimeoutError')), timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    checkAbort(signal);
    const secret = await withAbort(resolveSecret(model.secretRef, { origin: model.baseUrl }), signal);
    checkAbort(signal);
    let response: Response;
    try {
      response = await fetch(new URL(path, model.baseUrl), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: encoded, signal, redirect: 'error',
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); fail('echo.model.request'); }
    } catch { if (signal.aborted) aborted(signal); fail('echo.model.request'); }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    reader = response.body!.getReader();
    try {
      for (;;) {
        checkAbort(signal);
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('echo.model.response'); }
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { if (signal.aborted) aborted(signal); fail('echo.model.response'); }
  } finally { clearTimeout(timer); reader?.releaseLock(); }
}

export async function listModels(profile: EchoProfile): Promise<string[]> {
  if (profile.model.provider !== 'ollama') fail('echo.model.list');
  const payload = object(await request(profile, '/api/tags'));
  if (!Array.isArray(payload.models)) fail('echo.model.response');
  const names = payload.models.map(model => {
    const value = object(model).name;
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) fail('echo.model.response');
    return value;
  });
  return [...new Set(names)].sort();
}

/** A bounded, stateless summary call. This does not perform retrieval or run an autonomous agent. */
export async function summarize(profile: EchoProfile, text: string): Promise<string> {
  if (!profile.model.model) fail('echo.model.choose');
  if (typeof text !== 'string') fail('echo.model.response');
  const messages = [
    { role: 'system', content: echoConfigWord(profile.model.provider === 'ollama' ? 'echo.model.structuredPrompt' : 'echo.model.prompt') },
    { role: 'user', content: text.slice(0, MAX_INPUT_CHARS) },
  ];
  let content: unknown;
  if (profile.model.provider === 'ollama') {
    const response = object(await request(profile, '/api/chat', {
      model: profile.model.model, messages, stream: false, think: false,
      format: {
        type: 'object', properties: { summary: { type: 'string', minLength: 1, maxLength: profile.budget.briefMaxChars } },
        required: ['summary'], additionalProperties: false,
      },
      options: { num_predict: profile.budget.modelMaxTokens, temperature: 0 },
    }));
    if (response.done_reason === 'length' || response.done === false) fail('echo.model.incomplete');
    const raw = object(response.message).content;
    if (typeof raw !== 'string') fail('echo.model.response');
    let summary: Record<string, unknown>;
    try { summary = object(JSON.parse(raw)); } catch { fail('echo.model.response'); }
    if (Object.keys(summary).length !== 1 || !Object.hasOwn(summary, 'summary')) fail('echo.model.response');
    content = summary.summary;
  } else if (profile.model.provider === 'openai-compatible') {
    const response = object(await request(profile, '/v1/chat/completions', {
      model: profile.model.model, messages, stream: false,
      max_tokens: profile.budget.modelMaxTokens, temperature: 0,
    }));
    if (!Array.isArray(response.choices) || !response.choices.length) fail('echo.model.response');
    const choice = object(response.choices[0]);
    if (choice.finish_reason === 'length') fail('echo.model.incomplete');
    content = object(choice.message).content;
  } else fail('echo.model.request');
  if (typeof content !== 'string' || !content.trim()) fail('echo.model.response');
  // Cap the final text even when a provider ignores its generation limit.
  let brief = content.trim().slice(0, profile.budget.briefMaxChars);
  if (/[\uD800-\uDBFF]$/.test(brief)) brief = brief.slice(0, -1);
  return brief;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** One structured generation only. Research tools, citation validation and write policy belong to Echo. */
export async function generateSubmind(profile: EchoProfile, input: SubmindModelRequest): Promise<SubmindModelResponse> {
  const model = validateModelSettings(profile.model);
  if (!model.model) fail('echo.model.choose');
  const settings = submindSettings(profile);
  if (!input || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 64) fail('echo.model.input');
  let inputChars = 0;
  const messages = input.messages.map(message => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') fail('echo.model.input');
    inputChars += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (inputChars > settings.inputMaxChars) fail('echo.model.input');
  if (!input.schema || typeof input.schema !== 'object' || Array.isArray(input.schema)) fail('echo.model.input');
  let schemaText: string;
  try { schemaText = JSON.stringify(input.schema); } catch { fail('echo.model.input'); }
  if (!schemaText || schemaText.length > 32_768) fail('echo.model.input');
  const schemaInstruction = `${echoConfigWord('echo.model.jsonPrompt')}\n${schemaText}`;
  const schemaChars = model.provider === 'ollama' ? schemaText.length : schemaInstruction.length;
  if (inputChars + schemaChars > settings.inputMaxChars) fail('echo.model.input');
  const budgetTokens = profile.budget.modelMaxTokens;
  const outputTokens = input.maxOutputTokens ?? budgetTokens;
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 32 || budgetTokens > 4096 || !Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > budgetTokens) fail('echo.model.input');
  const timeoutMs = Math.min(settings.timeoutMs, profile.budget.timeoutMs);
  const options = { signal: input.signal, timeoutMs };
  let raw: unknown;
  let usage: SubmindModelResponse['usage'];
  let finishReason: unknown;
  if (model.provider === 'ollama') {
    const response = object(await request(profile, '/api/chat', {
      model: model.model, messages, stream: false, think: false, format: input.schema,
      options: { num_predict: outputTokens, temperature: 0 },
    }, options));
    finishReason = response.done_reason;
    if (response.done !== true || finishReason !== 'stop') fail('echo.model.incomplete');
    raw = object(response.message).content;
    usage = { inputTokens: tokenCount(response.prompt_eval_count), outputTokens: tokenCount(response.eval_count) };
  } else {
    // JSON mode has wider compatible-server support than strict JSON-schema response_format.
    // The contract is included as a system instruction; Echo validates the returned object separately.
    const schemaMessage = { role: 'system', content: schemaInstruction };
    const response = object(await request(profile, '/v1/chat/completions', {
      model: model.model, messages: [schemaMessage, ...messages], stream: false,
      response_format: { type: 'json_object' }, max_tokens: outputTokens, temperature: 0,
    }, options));
    if (!Array.isArray(response.choices) || response.choices.length !== 1) fail('echo.model.response');
    const choice = object(response.choices[0]);
    finishReason = choice.finish_reason;
    if (finishReason !== 'stop') fail('echo.model.incomplete');
    const message = object(choice.message);
    if (message.refusal || message.tool_calls || message.function_call) fail('echo.model.response');
    raw = message.content;
    const counts = response.usage && typeof response.usage === 'object' && !Array.isArray(response.usage) ? response.usage as Record<string, unknown> : {};
    usage = { inputTokens: tokenCount(counts.prompt_tokens), outputTokens: tokenCount(counts.completion_tokens) };
  }
  if (typeof raw !== 'string' || !raw.trim()) fail('echo.model.response');
  let content: Record<string, unknown>;
  try { content = object(JSON.parse(raw)); } catch { fail('echo.model.response'); }
  return { content, model: model.model, finishReason: finishReason as string, usage };
}
