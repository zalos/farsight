import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ECHO_PORTAL_STRINGS } from '@farsight/core/dist/strings-echo-portal.js';
import { contextFingerprint } from './sessions.js';
import { PortalFailure, validatePortalAsk, validatePortalBrowse, validatePortalExpand } from './portal.js';
import type { PortalCallbacks } from './portal-types.js';
import { discoverSetupModels, ModelSetupFailure, modelSetupMessage, testSetupModel } from './model-setup.js';
import type { ModelSetupDependencies } from './model-setup-types.js';
import { ECHO_UI_STRINGS } from '@farsight/core/dist/strings-echo-ui.js';
import { submindSettings, updateConfig, validateConfig } from './config.js';
import { requireFileTrust } from './trust.js';
import type { CheckResult, EchoConfig, EchoContext } from './types.js';

const BODY_LIMIT = 64 * 1024;
const text = (key: string): string => ECHO_UI_STRINGS[`echo.ui.${key}`]!.professional;
const html = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface WebInstallation {
  scope: 'workspace' | 'global' | 'custom';
  configPath: string;
  workspaceRoot?: string;
}

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
      model: { provider: p.model.provider, baseUrl: p.model.baseUrl, model: p.model.model, secretRef: p.model.secretRef, ...(p.model.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: p.model.allowInsecureHttp }), ...(p.model.ollama === undefined ? {} : { ollama: { contextTokens: p.model.ollama.contextTokens, keepAliveSeconds: p.model.ollama.keepAliveSeconds } }) },
      web: { port: p.web.port, farsightOrigin: p.web.farsightOrigin },
      hooks: { claude: p.hooks.claude, codex: p.hooks.codex, vscode: p.hooks.vscode ?? false },
      skills: { directories: [...p.skills.directories] },
      budget: { briefMaxChars: p.budget.briefMaxChars, modelMaxTokens: p.budget.modelMaxTokens, timeoutMs: p.budget.timeoutMs },
      ...(p.submind ? { submind: {
        mode: p.submind.mode, hookResearch: p.submind.hookResearch, hookWaitMs: p.submind.hookWaitMs, maxSteps: p.submind.maxSteps, maxSearches: p.submind.maxSearches,
        maxCandidates: p.submind.maxCandidates, evidenceMaxChars: p.submind.evidenceMaxChars,
        inputMaxChars: p.submind.inputMaxChars, lookbackDays: p.submind.lookbackDays,
        timeoutMs: p.submind.timeoutMs, expandedMaxChars: p.submind.expandedMaxChars,
      } } : {}),
    };
  }
  return { version: 1, defaultProfile: config.defaultProfile, profiles };
}

async function snapshot(path: string): Promise<{ config: EchoConfig; revision: string }> {
  const source = await readFile(path, 'utf8');
  requireFileTrust('configs', path, source);
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

/** Settings and read-only memory access retain the process startup configuration. */
export async function startWeb(ctx: EchoContext, callbacks: { checks?: () => Promise<CheckResult[]>; installation?: WebInstallation; portal?: PortalCallbacks; demo?: boolean; modelSetup?: ModelSetupDependencies } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const startup = structuredClone(ctx);
  const fingerprint = contextFingerprint(startup);
  const requests = new Set<AbortController>();
  const frameOrigin = permittedFrameOrigin(ctx.profile.web.farsightOrigin);
  const activeProfile = ctx.profileId;
  const activeIdentity = structuredClone(ctx.profile.identity);
  const activeDataDirectory = ctx.dataDirectory;
  const activeSubmindMode = submindSettings(ctx.profile).mode;
  const defaults = { submind: submindSettings({ ...ctx.profile, submind: undefined }) };
  // Installation describes this process, never a value an editor may save or move.
  // Keep the actual opened path authoritative and copy only the public fields.
  const installation: WebInstallation = {
    scope: callbacks.installation?.scope ?? 'custom',
    configPath: ctx.configPath,
    ...(callbacks.installation?.workspaceRoot ? { workspaceRoot: callbacks.installation.workspaceRoot } : {}),
  };
  let port = ctx.profile.web.port;
  let writes: Promise<void> = Promise.resolve();
  let modelOperationInFlight = false;
  const restartRequired = (config: EchoConfig): boolean => {
    const profile = config.profiles[startup.profileId];
    return !profile || contextFingerprint({ ...startup, config, profile }) !== fingerprint
      || JSON.stringify(profile.web) !== JSON.stringify(startup.config.profiles[startup.profileId]?.web);
  };
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
          json(res, 200, { ...current, installation, defaults, restartRequired: restartRequired(current.config), modelSetup: { available: callbacks.demo !== true }, readOnly: callbacks.demo === true, portal: { available: !!callbacks.portal, synthetic: callbacks.demo === true }, running: { profileId: activeProfile, identity: activeIdentity, dataDirectory: activeDataDirectory, submindMode: activeSubmindMode, model: { provider: startup.profile.model.provider, baseUrl: startup.profile.model.baseUrl, model: startup.profile.model.model } } }, current.revision);
        } catch { fail(res, 503, 'unavailable'); }
        return;
      }
      if (req.method === 'PUT' && path === '/api/settings') {
        if (callbacks.demo) throw new RequestError(403, 'refused');
        const revision = req.headers['if-match'];
        if (typeof revision !== 'string') throw new RequestError(428, 'revisionRequired');
        const input = await readJson(req);
        let config: EchoConfig;
        try { config = publicConfig(validateConfig(input)); } catch { throw new RequestError(400, 'invalid'); }
        // Serialize compare-and-save operations within this server. A stale browser
        // tab cannot replace a newer configuration from another request.
        const save = writes.then(async () => {
          await updateConfig(ctx.configPath, async () => {
            const current = await snapshot(ctx.configPath);
            if (revision !== current.revision) throw new RequestError(409, 'conflict');
            return config;
          });
          const saved = await snapshot(ctx.configPath);
          json(res, 200, { ...saved, restartRequired: restartRequired(saved.config) }, saved.revision);
        });
        writes = save.catch(() => {});
        await save;
        return;
      }
      if (req.method === 'POST' && ['/api/model/models', '/api/model/test'].includes(path ?? '')) {
        if (callbacks.demo) throw new RequestError(403, 'refused');
        if (req.url !== path) throw new RequestError(400, 'invalid');
        const revision = req.headers['if-match'];
        if (typeof revision !== 'string') throw new RequestError(428, 'revisionRequired');
        const input = await readJson(req);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
          || !Object.hasOwn(input, 'profileId') || typeof (input as Record<string, unknown>).profileId !== 'string') throw new RequestError(400, 'invalid');
        const profileId = (input as { profileId: string }).profileId;
        const current = await snapshot(startup.configPath).catch(() => { throw new ModelSetupFailure('failed'); });
        if (current.revision !== revision) throw new RequestError(409, 'conflict');
        if (!Object.hasOwn(current.config.profiles, profileId)) throw new RequestError(400, 'invalid');
        const profile = current.config.profiles[profileId]!;
        const generation = path === '/api/model/test';
        if (generation && modelOperationInFlight) throw new ModelSetupFailure('busy');
        if (generation) modelOperationInFlight = true;
        const controller = new AbortController();
        requests.add(controller);
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        const deadline = Math.min(profile.budget.timeoutMs, submindSettings(profile).timeoutMs) + 1000;
        const timer = setTimeout(() => controller.abort(new ModelSetupFailure('timeout')), deadline);
        timer.unref();
        req.once('aborted', disconnected);
        res.once('close', disconnected);
        if (req.aborted || res.destroyed) controller.abort();
        let aborted: (() => void) | undefined;
        const operation = (async () => {
          controller.signal.throwIfAborted();
          const value = generation
            ? await testSetupModel(profileId, profile, controller.signal, callbacks.modelSetup)
            : await discoverSetupModels(profileId, profile, controller.signal, callbacks.modelSetup);
          const latest = await snapshot(startup.configPath).catch(() => { throw new ModelSetupFailure('failed'); });
          if (latest.revision !== revision) throw new RequestError(409, 'conflict');
          return value;
        })().finally(() => { if (generation) modelOperationInFlight = false; });
        try {
          const result = await Promise.race([
            operation,
            new Promise<never>((_, reject) => { aborted = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', aborted, { once: true }); }),
          ]);
          if (!controller.signal.aborted && !res.destroyed) json(res, 200, result);
        } catch (error) {
          if (error instanceof ModelSetupFailure || error instanceof RequestError) throw error;
          throw new ModelSetupFailure('failed');
        } finally {
          clearTimeout(timer);
          if (aborted) controller.signal.removeEventListener('abort', aborted);
          req.off('aborted', disconnected);
          res.off('close', disconnected);
          requests.delete(controller);
        }
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
      if (req.method === 'POST' && ['/api/memory/browse', '/api/memory/expand', '/api/memory/ask'].includes(path ?? '')) {
        if (!callbacks.portal) throw new PortalFailure('unavailable');
        const input = await readJson(req);
        const generation = path === '/api/memory/ask';
        if (generation && modelOperationInFlight) throw new ModelSetupFailure('busy');
        if (generation) modelOperationInFlight = true;
        const action = path === '/api/memory/browse' ? () => callbacks.portal!.browse(validatePortalBrowse(input), controller.signal)
          : path === '/api/memory/expand' ? () => callbacks.portal!.expand(validatePortalExpand(input), controller.signal)
          : () => callbacks.portal!.ask(validatePortalAsk(input), controller.signal);
        // Trust and selection are checked on both sides of an asynchronous read. A settings
        // save cannot make an in-flight response disclose evidence from the old selection.
        const checkSelection = async (): Promise<void> => {
          try {
            const current = await snapshot(startup.configPath);
            const profile = current.config.profiles[startup.profileId];
            if (!profile || contextFingerprint({ ...startup, config: current.config, profile }) !== fingerprint) throw new Error();
          } catch { throw new PortalFailure('stale'); }
        };
        const controller = new AbortController();
        requests.add(controller);
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        const deadline = path === '/api/memory/ask' ? submindSettings(startup.profile).timeoutMs + 1000 : 15000;
        const timer = setTimeout(() => controller.abort(new PortalFailure('timeout')), deadline);
        timer.unref();
        req.once('aborted', disconnected);
        res.once('close', disconnected);
        if (req.aborted || res.destroyed) controller.abort();
        let aborted: (() => void) | undefined;
        try {
          const result = await Promise.race([
            (async () => { await checkSelection(); if (controller.signal.aborted) throw controller.signal.reason; const value = await action(); await checkSelection(); return value; })().finally(() => { if (generation) modelOperationInFlight = false; }),
            new Promise<never>((_, reject) => { aborted = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', aborted, { once: true }); }),
          ]);
          if (!controller.signal.aborted && !res.destroyed) json(res, 200, result);
        } catch (error) {
          if (error instanceof PortalFailure || error instanceof RequestError) throw error;
          throw new PortalFailure('failed');
        } finally {
          clearTimeout(timer);
          if (aborted) controller.signal.removeEventListener('abort', aborted);
          req.off('aborted', disconnected);
          res.off('close', disconnected);
          requests.delete(controller);
        }
        return;
      }
      if (req.method === 'GET' && path === '/api/strings') { json(res, 200, { ...ECHO_UI_STRINGS, ...ECHO_PORTAL_STRINGS }); return; }
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(text('title'))}</title><link rel="stylesheet" href="/style.css"></head><body><div id="app" data-error="${html(text('unavailable'))}"><p role="status">${html(text('loading'))}</p></div><script type="module" src="/app.js"></script></body></html>`);
        return;
      }
      if (req.method === 'GET' && (path === '/app.js' || path === '/portal.js' || path === '/style.css')) {
        const content = await readFile(new URL(`../public${path}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
        res.end(content);
        return;
      }
      req.resume();
      fail(res, 404, 'notFound');
    } catch (error) {
      req.resume();
      if (res.destroyed) return;
      if (error instanceof ModelSetupFailure) {
        json(res, error.code === 'busy' ? 409 : error.code === 'timeout' ? 504 : 503, { error: modelSetupMessage(error), code: error.code });
        return;
      }
      if (error instanceof PortalFailure) { json(res, error.code === 'invalid' ? 400 : error.code === 'stale' ? 409 : error.code === 'timeout' ? 504 : 503, { error: ECHO_PORTAL_STRINGS[`echo.portal.${error.code}`]!.professional }); return; }
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
      for (const controller of requests) controller.abort();
      await writes;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}
