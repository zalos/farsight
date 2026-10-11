import { echoConfigWord } from '@farsight/core/dist/strings-echo-config.js';
import { resolveSecret } from './secrets.js';
import type { EchoProfile } from './types.js';

const MAX_INPUT_CHARS = 24_000;
const MAX_RESPONSE_BYTES = 1_048_576;

function fail(key: string): never { throw new Error(echoConfigWord(key)); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('echo.model.response');
  return value as Record<string, unknown>;
}

async function request(profile: EchoProfile, path: string, body?: unknown): Promise<unknown> {
  const secret = await resolveSecret(profile.model.secretRef);
  let response: Response;
  try {
    response = await fetch(new URL(path, profile.model.baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(profile.budget.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); fail('echo.model.request'); }
  } catch { fail('echo.model.request'); }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body!.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('echo.model.response'); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { fail('echo.model.response'); } finally { reader.releaseLock(); }
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
    { role: 'system', content: echoConfigWord('echo.model.prompt') },
    { role: 'user', content: text.slice(0, MAX_INPUT_CHARS) },
  ];
  let content: unknown;
  if (profile.model.provider === 'ollama') {
    const response = object(await request(profile, '/api/chat', {
      model: profile.model.model, messages, stream: false, think: false,
      options: { num_predict: profile.budget.modelMaxTokens, temperature: 0 },
    }));
    content = object(response.message).content;
  } else if (profile.model.provider === 'openai-compatible') {
    const response = object(await request(profile, '/v1/chat/completions', {
      model: profile.model.model, messages, stream: false,
      max_tokens: profile.budget.modelMaxTokens, temperature: 0,
    }));
    if (!Array.isArray(response.choices) || !response.choices.length) fail('echo.model.response');
    content = object(object(response.choices[0]).message).content;
  } else fail('echo.model.request');
  if (typeof content !== 'string' || !content.trim()) fail('echo.model.response');
  // Cap the final text even when a provider ignores its generation limit.
  let brief = content.trim().slice(0, profile.budget.briefMaxChars);
  if (/[\uD800-\uDBFF]$/.test(brief)) brief = brief.slice(0, -1);
  return brief;
}
