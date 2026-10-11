import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ECHO_UI_STRINGS } from '@farsight/core/dist/strings-echo-ui.js';
import { saveConfig, validateConfig } from './config.js';
import type { CheckResult, EchoConfig, EchoContext } from './types.js';

const BODY_LIMIT = 64 * 1024;
const text = (key: string): string => ECHO_UI_STRINGS[`echo.ui.${key}`]!.professional;
const html = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

class RequestError extends Error {
  constructor(readonly status: number, readonly key: string) { super(key); }
}

/** Do not echo unknown fields from a manually edited configuration to the browser. */
function publicConfig(config: EchoConfig): EchoConfig {
  const profiles: EchoConfig['profiles'] = Object.create(null) as EchoConfig['profiles'];
  for (const [id, p] of Object.entries(config.profiles)) {
    profiles[id] = {
      identity: { individual: p.identity.individual, team: p.identity.team, project: p.identity.project },
      backend: { mode: p.backend.mode, url: p.backend.url, secretRef: p.backend.secretRef },
      model: { provider: p.model.provider, baseUrl: p.model.baseUrl, model: p.model.model, secretRef: p.model.secretRef },
      web: { port: p.web.port, farsightOrigin: p.web.farsightOrigin },
      hooks: { claude: p.hooks.claude, codex: p.hooks.codex, vscode: p.hooks.vscode ?? false },
      skills: { directories: [...p.skills.directories] },
      budget: { briefMaxChars: p.budget.briefMaxChars, modelMaxTokens: p.budget.modelMaxTokens, timeoutMs: p.budget.timeoutMs },
    };
  }
  return { version: 1, defaultProfile: config.defaultProfile, profiles };
}

async function snapshot(path: string): Promise<{ config: EchoConfig; revision: string }> {
  const source = await readFile(path, 'utf8');
  const config = publicConfig(validateConfig(JSON.parse(source)));
  return { config, revision: `"${createHash('sha256').update(source).digest('hex')}"` };
}

function permittedFrameOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const origin = new URL(value);
  if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || value !== origin.origin) {
    throw new Error(text('invalid'));
  }
  return origin.origin;
}

function guarded(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    // The public HTML shell must be navigable from an approved Farsight frame.
    // Its CSP enforces the parent origin; all data and assets still require
    // same-origin requests once the shell is loaded.
    const navigation = req.method === 'GET' && req.url?.split('?')[0] === '/' && req.headers['sec-fetch-mode'] === 'navigate' && ['iframe', 'document'].includes(String(req.headers['sec-fetch-dest']));
    if (!navigation) return false;
  }
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new RequestError(415, 'jsonOnly');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > BODY_LIMIT) throw new RequestError(413, 'tooLarge');
  const body = await new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let exceeded = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        exceeded = true;
        chunks.length = 0;
        reject(new RequestError(413, 'tooLarge'));
      } else if (!exceeded) chunks.push(chunk);
    });
    req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
    req.on('aborted', () => reject(new RequestError(400, 'invalid')));
  });
  try { return JSON.parse(body); } catch { throw new RequestError(400, 'invalid'); }
}

/** Settings only: every running dependency and session keeps its startup configuration. */
export async function startWeb(ctx: EchoContext, callbacks: { checks?: () => Promise<CheckResult[]> } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const frameOrigin = permittedFrameOrigin(ctx.profile.web.farsightOrigin);
  const activeProfile = ctx.profileId;
  const activeIdentity = structuredClone(ctx.profile.identity);
  let port = ctx.profile.web.port;
  let writes: Promise<void> = Promise.resolve();
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 20_000;
  server.headersTimeout = 15_000;

  const json = (res: ServerResponse, status: number, value: unknown, etag?: string): void => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(etag ? { ETag: etag } : {}) });
    res.end(JSON.stringify(value));
  };
  const fail = (res: ServerResponse, status: number, key: string): void => json(res, status, { error: text(key) });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'${frameOrigin ? ` ${frameOrigin}` : ''}`);
    if (!guarded(req, port)) { req.resume(); fail(res, 403, 'refused'); return; }
    const path = req.url?.split('?')[0];
    try {
      if (req.method === 'GET' && path === '/api/settings') {
        try {
          const current = await snapshot(ctx.configPath);
          json(res, 200, { ...current, running: { profileId: activeProfile, identity: activeIdentity } }, current.revision);
        } catch { fail(res, 503, 'unavailable'); }
        return;
      }
      if (req.method === 'PUT' && path === '/api/settings') {
        const revision = req.headers['if-match'];
        if (typeof revision !== 'string') throw new RequestError(428, 'revisionRequired');
        const input = await readJson(req);
        let config: EchoConfig;
        try { config = publicConfig(validateConfig(input)); } catch { throw new RequestError(400, 'invalid'); }
        // Serialize compare-and-save operations within this server. A stale browser
        // tab cannot replace a newer configuration from another request.
        const save = writes.then(async () => {
          const current = await snapshot(ctx.configPath);
          if (revision !== current.revision) throw new RequestError(409, 'conflict');
          await saveConfig(ctx.configPath, config);
          const saved = await snapshot(ctx.configPath);
          json(res, 200, { ...saved, restartRequired: true }, saved.revision);
        });
        writes = save.catch(() => {});
        await save;
        return;
      }
      if (req.method === 'GET' && path === '/api/checks') {
        if (!callbacks.checks) { json(res, 200, { available: false, checks: [] }); return; }
        let timer: NodeJS.Timeout | undefined;
        try {
          const checks = await Promise.race([
            callbacks.checks(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 15_000); timer.unref(); }),
          ]);
          json(res, 200, { available: true, checks });
        }
        catch { fail(res, 503, 'checkFailed'); }
        finally { if (timer) clearTimeout(timer); }
        return;
      }
      if (req.method === 'GET' && path === '/api/strings') { json(res, 200, ECHO_UI_STRINGS); return; }
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(text('title'))}</title><link rel="stylesheet" href="/style.css"></head><body><div id="app" data-error="${html(text('unavailable'))}"><p role="status">${html(text('loading'))}</p></div><script type="module" src="/app.js"></script></body></html>`);
        return;
      }
      if (req.method === 'GET' && (path === '/app.js' || path === '/style.css')) {
        const content = await readFile(new URL(`../public${path}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
        res.end(content);
        return;
      }
      req.resume();
      fail(res, 404, 'notFound');
    } catch (error) {
      req.resume();
      if (!res.headersSent) fail(res, error instanceof RequestError ? error.status : 500, error instanceof RequestError ? error.key : 'failed');
      else res.end();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error(text('failed'));
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await writes;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}
