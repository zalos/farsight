// PR 21 fixtures: original, bounded local mock model endpoints on 127.0.0.1 and trusted settings that name them.
// Nothing here contacts a hosted provider, downloads a model or reads a real keychain entry.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, effectivePolicy } from '../dist/policy/index.js';

export const D = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
export const NOW = new Date('2026-10-22T12:00:00.000Z');

export interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: string }

/** A mock endpoint: every request is recorded; `handle` answers it (or not, to hang). */
export async function mockEndpoint(t: { after(fn: () => unknown): void }, handle: (req: Seen, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const s = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(s);
      handle(s, res);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  return { origin: `http://127.0.0.1:${port}`, seen, port, server };
}

export const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

export const ollamaReply = (over: Record<string, unknown> = {}) => ({
  model: 'review-model:1', created_at: '2026-10-22T12:00:00Z', message: { role: 'assistant', content: 'NO_FINDING' },
  done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 3, ...over,
});

export const openaiReply = (over: Record<string, unknown> = {}) => ({
  id: 'cmpl-1', object: 'chat.completion', model: 'review-model', choices: [{ index: 0, message: { role: 'assistant', content: 'NO_FINDING' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 50, completion_tokens: 4, total_tokens: 54 }, ...over,
});

/** A private scratch folder removed after the test. */
export function scratchDir(t: { after(fn: () => void): void }, prefix = 'sentinel-provider-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const LIMITS = { maxRequestBytes: 64 * 1024, maxResponseBytes: 16 * 1024, timeoutMs: 2000, maxOutputTokens: 256, contextTokens: 8192, maxMessages: 16, templateTokensPerMessage: 8 };

export const capability = (kind: 'ollama' | 'openai-compatible', origin: string, model: string, revision: string | null = null) =>
  ({ schema: 'sentinel-model-capability/draft-1' as const, kind, origin, model, listed: true as const, revision, probedAt: '2026-10-22T11:00:00.000000000Z' });

export const TERMS = { retention: 'synthetic: 30 days', training: 'not-used' as const, source: 'synthetic terms page', recordedAt: '2026-10-22' };

/** A configured model as the adopted settings hold it (`providers[].models[]`), plus the provider it belongs to. */
export const ollamaProfile = (origin: string, over: Record<string, unknown> = {}) => ({
  providerId: 'local-review', id: 'review', model: 'review-model:1', limits: LIMITS,
  pricing: { kind: 'no-fee' as const, basis: 'local-runtime' as const }, terms: null,
  capability: capability('ollama', origin, 'review-model:1', `sha256:${'a'.repeat(64)}`), ...over,
});

export const openaiProfile = (origin: string, over: Record<string, unknown> = {}) => ({
  providerId: 'local-openai', id: 'review', model: 'review-model', limits: LIMITS,
  pricing: { kind: 'rates' as const, currency: 'USD', inputPerMillion: '2.50', outputPerMillion: '10', source: 'synthetic test schedule', asOf: '2026-10-22' },
  terms: null, capability: capability('openai-compatible', origin, 'review-model'), ...over,
});

const HOSTED = 'https://models.example.com';
const modelOf = (p: Record<string, unknown>) => { const { providerId: _p, ...m } = p; void _p; return m; };

export interface TrustedOptions { ollama?: string; openai?: string; grants?: unknown[]; models?: Record<string, unknown[]> }

/**
 * Adopted settings naming the mock endpoints, each provider with its configured models: a local Ollama, a local
 * OpenAI-compatible server with a keychain reference, and a hosted provider that is never contacted.
 */
export function trustedPolicy(o: TrustedOptions = {}) {
  const ollama = o.ollama ?? 'http://127.0.0.1:9';
  const openai = o.openai ?? 'http://127.0.0.1:9';
  const models = (id: string, dflt: unknown[]) => o.models?.[id] ?? dflt;
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    grants: o.grants ?? [
      { actions: ['paid.admit'], principals: ['human', 'agent'], confirm: 'never', scope: { providers: ['local-review', 'local-openai'] } },
      { actions: ['paid.admit'], principals: ['human', 'agent'], confirm: 'always', scope: { providers: ['hosted-review'] } },
      { actions: ['tool.acquire'], principals: ['human'] },
    ],
    providers: [
      { id: 'local-review', kind: 'ollama', endpoint: ollama, credential: null, disclosure: 'local-only',
        budget: { maxTokens: 100000, maxCost: '0', currency: 'USD' }, models: models('local-review', [modelOf(ollamaProfile(ollama))]) },
      { id: 'local-openai', kind: 'openai-compatible', endpoint: openai, credential: 'keychain:farsight/sentinel-review',
        disclosure: 'local-only', budget: { maxTokens: 100000, maxCost: '1.00', currency: 'USD' }, models: models('local-openai', [modelOf(openaiProfile(openai))]) },
      { id: 'hosted-review', kind: 'openai-compatible', endpoint: HOSTED, credential: 'keychain:farsight/sentinel-review',
        disclosure: 'hosted', budget: { maxTokens: 100000, maxCost: '5.00', currency: 'USD' },
        models: models('hosted-review', [modelOf(openaiProfile(HOSTED, { terms: TERMS }))]) },
      { id: 'named-local', kind: 'ollama', endpoint: 'http://localhost:11434', credential: null, disclosure: 'local-only',
        budget: { maxTokens: 1000, maxCost: '0', currency: 'USD' }, models: models('named-local', []) },
      { id: 'plain-hosted', kind: 'openai-compatible', endpoint: 'http://models.example.com', credential: null, disclosure: 'hosted',
        budget: { maxTokens: 1000, maxCost: '1.00', currency: 'USD' }, models: models('plain-hosted', []) },
    ],
  };
  return effectivePolicy({ trust: 'adopted', settings: settings as any, settingsDigest: D('settings'), repoConfig: null, repoConfigDigest: null });
}

/** A policy whose provider `profile.providerId` holds exactly `profile` as its only model, bound by id. */
export async function withModel(o: TrustedOptions, profile: Record<string, unknown>) {
  const { bindProvider } = await import('../dist/review/providers/index.js');
  const providerId = profile.providerId as string;
  const policy = trustedPolicy({ ...o, models: { ...(o.models ?? {}), [providerId]: [modelOf(profile)] } });
  return { policy, bind: () => bindProvider(policy, providerId, profile.id as string) };
}
