// Explicit foreground companion. Reuses the existing owner socket; never opens/acquires a store.
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import {
  companionOrigin,
  companionDirectory,
  companionWorkspaceDigest,
} from '@farsight/core/dist/sentinel-companion.js';
import { STRINGS } from '@farsight/core/dist/strings.js';
import { connectService } from '../service/owner-service.js';
import type { Workspace } from '../service/local.js';
import {
  preparationCapabilities,
  configurationPreview,
  preparationOutcome,
} from '../service/preparation-projection.js';
import {
  preparationClientFilename,
  readPreparationClientKey,
  savePreparationClientKey,
  absentPreparationKeyReplaceable,
  preparationDefinitivelyRefused,
} from '../service/preparation-client.js';
import { preparationKeyLock } from '../service/preparation-key-lock.js';
import { validateEnvelope } from '../validate.js';
import { MAX_PIPELINE_BYTES } from '../app/pipeline.js';
import { ownerHost } from './host.js';
import { OwnerUiSession, OwnerUiError } from './session.js';
import { publishOwnerCompanion } from './descriptor.js';
import { ownerUiHtml, ownerUiRecoveryHtml, ownerUiScript, ownerUiCss } from './view.js';
import {
  corsHeaders,
  isReadModelPath,
  preflightHeaders,
  readRoute,
  routeOperation,
  REPORT_MEDIA,
} from '../transport/http/routes.js';
const fields = (v: unknown, keys: readonly string[]) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !keys.includes(k)))
    throw new OwnerUiError();
  return v as Record<string, any>;
};
const digestId = (v: unknown) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)) throw new OwnerUiError();
  return v;
};
/** How long the companion polls for a service that is not answering yet, and how often. */
export const SERVICE_WAIT = Object.freeze({ defaultMs: 30_000, everyMs: 250 });

/**
 * The workspace's service, waiting up to `waitMs` for one that is still starting (its descriptor not yet written, or
 * its socket not yet listening): `onWaiting` is told once, before the first wait. Never starts a service. After the
 * wait, still no service refuses as before (`sentinel.service.operationUnavailable`).
 */
async function serviceFor(ws: Workspace, waitMs: number, onWaiting?: (waitMs: number) => void) {
  const until = Date.now() + waitMs;
  let told = false;
  for (;;) {
    const client = await connectService(ws, 'owner-ui');
    if (client) return client;
    if (Date.now() + SERVICE_WAIT.everyMs > until) throw new OwnerUiError('sentinel.service.operationUnavailable');
    if (!told) onWaiting?.(waitMs);
    told = true;
    await new Promise((r) => setTimeout(r, SERVICE_WAIT.everyMs));
  }
}

export interface StartOwnerUiOptions {
  /** Wait this long for a service that is still starting; 0 (the default) refuses at once when none answers. */
  readonly waitForServiceMs?: number;
  /** Told once when the companion starts waiting for the service. */
  readonly onWaiting?: (waitMs: number) => void;
}

export async function startOwnerUi(ws: Workspace, farsightOrigin: string, options: StartOwnerUiOptions = {}) {
  companionOrigin(farsightOrigin);
  const host = await ownerHost(farsightOrigin),
    session = new OwnerUiSession(host.instance),
    client = await serviceFor(ws, Math.max(0, options.waitForServiceMs ?? 0), options.onWaiting);
  try {
    preparationCapabilities(await client.request('service.preparation-capabilities', {}));
    const caps: any = await client.request('service.owner-ui-capabilities', {});
    if (
      caps?.schema !== 'sentinel-owneruicapabilities/draft-1' ||
      caps.storeId !== client.storeId ||
      caps.settingsSave !== false ||
      caps.modelAdmission !== false
    )
      throw new OwnerUiError();
  } catch (error) {
    client.close();
    throw error;
  }
  const processNonce = randomBytes(32).toString('hex');
  let origin = '',
    proof: string | null = null,
    closed = false,
    pendingPreview: any = null,
    lastRun: string | null = null,
    lastKey: string | null = null,
    effect = false;
  try {
    lastKey = readPreparationClientKey(ws, client.storeId);
  } catch (error) {
    client.close();
    throw error;
  }
  /** The run the last preparation made: the Scan flow previews its start once it is prepared. */
  const choose = (runId: string | null) => {
    lastRun = runId;
  };
  let challenge: {
    id: string;
    resolve: () => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let eventResponse: ServerResponse | null = null;
  const sockets = new Set<import('node:net').Socket>();
  const ask = (op: string, body: Record<string, unknown>, signal?: AbortSignal) => client.request(op, body, { signal });
  const auth = (cap: string) => {
    descriptor.assertCurrent();
    return session.authenticate(cap);
  };
  const ui = (op: string, body: Record<string, unknown>, cap: string, signal?: AbortSignal) => {
    const view = auth(cap);
    if (!proof) throw new OwnerUiError();
    return ask(op, { proof, revision: view.revision, ...body }, signal);
  };
  const send = (res: ServerResponse, status: number, value: unknown) => {
    if (!res.destroyed) {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(JSON.stringify(value));
    }
  };
  const current = (cap: string, revision: number, signal: AbortSignal) => {
    if (signal.aborted) throw new OwnerUiError('sentinel.preparation.canceled');
    auth(cap);
    session.writable(cap, revision);
  };
  async function freshContext(cap: string, signal: AbortSignal) {
    const revision = auth(cap).revision;
    current(cap, revision, signal);
    const actual = await ownerHost(farsightOrigin, host.instance);
    current(cap, revision, signal);
    if (actual.readOnly) throw new OwnerUiError('sentinel.ownerUi.readOnly');
    if (challenge) throw new OwnerUiError('sentinel.ownerUi.busy');
    await new Promise<void>((resolve, reject) => {
      const id = randomBytes(32).toString('hex'),
        fail = (e: unknown) => {
          if (challenge?.id === id) {
            clearTimeout(challenge.timer);
            challenge = null;
          }
          reject(e);
        };
      const timer = setTimeout(() => fail(new OwnerUiError('sentinel.ownerUi.changed')), 1500);
      challenge = {
        id,
        timer,
        resolve: () => {
          clearTimeout(timer);
          challenge = null;
          signal.removeEventListener('abort', aborted);
          resolve();
        },
        reject: fail,
      };
      const aborted = () => fail(new OwnerUiError('sentinel.preparation.canceled'));
      signal.addEventListener('abort', aborted, { once: true });
      if (eventResponse) {
        const res = eventResponse;
        eventResponse = null;
        send(res, 200, { challenge: id });
      }
    });
    current(cap, revision, signal);
    return revision;
  }
  // The viewer's read model on this loopback origin (transport/http/): GET only, from the exact paired Farsight
  // origin, with the read pass the paired frame handed its parent. The answers come from the closed owner-ui read
  // operations under this session's proof and view revision; nothing here can preview, confirm or write.
  const readStatus: Record<string, number> = {
    'sentinel.viewer.notPaired': 401,
    'sentinel.ownerUi.expired': 401,
    'sentinel.ownerUi.replaced': 401,
    'sentinel.viewer.readOnly': 405,
    'sentinel.viewer.scanUnknown': 404,
    'sentinel.viewer.stageUnknown': 404,
    'sentinel.viewer.unitUnknown': 404,
    'sentinel.viewer.absent.notFinished': 409,
  };
  async function readModel(
    req: import('node:http').IncomingMessage,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const cors = corsHeaders(req.headers.origin, farsightOrigin);
    const answer = (status: number, value: unknown) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method === 'OPTIONS') {
        const headers = preflightHeaders(req.headers.origin, farsightOrigin);
        if (!headers) throw new OwnerUiError('sentinel.viewer.notPaired');
        res.writeHead(204, headers);
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET, OPTIONS');
        throw new OwnerUiError('sentinel.viewer.readOnly');
      }
      const route = readRoute(req.url ?? '');
      if (!route) throw new OwnerUiError('sentinel.ownerUi.invalid');
      const header = req.headers.authorization;
      if (typeof header !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(header))
        throw new OwnerUiError('sentinel.viewer.notPaired');
      descriptor.assertCurrent();
      const view = session.authenticateRead(header.slice(7));
      if (!proof) throw new OwnerUiError('sentinel.viewer.notPaired');
      const { op, body } = routeOperation(route);
      const value: any = await ask(op, { proof, revision: view.revision, ...body }, signal);
      if (route.kind !== 'report') {
        answer(200, value);
        return;
      }
      // The rendering, read whole from the retained delivery and checked against its digest before it is sent.
      const chunks: Buffer[] = [];
      let offset = 0;
      for (let i = 0; i < 4096 && offset < value.formatBytes; i++) {
        const chunk: any = await ask('delivery.read', { deliveryId: value.deliveryId, offset }, signal);
        const bytes = Buffer.from(String(chunk.base64), 'base64');
        if (!bytes.length) break;
        chunks.push(bytes);
        offset += bytes.length;
      }
      const text = Buffer.concat(chunks);
      if (
        text.length !== value.formatBytes ||
        'sha256:' + createHash('sha256').update(text).digest('hex') !== value.formatDigest
      )
        throw new OwnerUiError('sentinel.service.deliveryInvalid');
      res.writeHead(200, {
        'content-type': REPORT_MEDIA[route.format],
        'content-disposition': `attachment; filename="sentinel-scan-${Number.isSafeInteger(value.number) ? value.number : 'report'}.${route.format === 'sarif' ? 'sarif.json' : route.format}"`,
        'content-security-policy': "sandbox; default-src 'none'",
        'x-sentinel-format-digest': value.formatDigest,
        ...cors,
      });
      res.end(text);
    } catch (error) {
      const candidate = (error as { code?: unknown })?.code,
        code =
          typeof candidate === 'string' && Object.hasOwn(STRINGS, candidate) ? candidate : 'sentinel.ownerUi.failed';
      answer(readStatus[code] ?? 400, { error: code, message: STRINGS[code]?.professional });
    }
  }
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      if (closed || req.headers.host !== origin.slice(7) || req.url?.includes('?')) throw new OwnerUiError();
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      const csp = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors ${farsightOrigin}; base-uri 'none'; form-action 'none'; object-src 'none'`;
      if (isReadModelPath(req.url)) {
        await readModel(req, res, abort.signal);
        return;
      }
      if (req.method === 'GET') {
        if (req.url === '/bootstrap') {
          const code = session.bootstrap();
          res.writeHead(303, { location: '/frame#launch=' + code, 'content-security-policy': csp });
          res.end();
          return;
        }
        if (req.url === '/frame') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp });
          res.end(ownerUiHtml(farsightOrigin, host.instance));
          return;
        }
        if (req.url === '/client.js') {
          res.writeHead(200, { 'content-type': 'text/javascript' });
          res.end(ownerUiScript());
          return;
        }
        if (req.url === '/style.css') {
          res.writeHead(200, { 'content-type': 'text/css' });
          res.end(ownerUiCss);
          return;
        }
        if (req.url === '/words.json') {
          send(
            res,
            200,
            Object.fromEntries(
              Object.entries(STRINGS)
                .filter(([k]) => k.startsWith('sentinel.') || k === 'nav.sentinel')
                .map(([k, v]) => [k, { hud: v.hud, professional: v.professional, define: v.define }]),
            ),
          );
          return;
        }
        send(res, 404, { error: 'sentinel.ownerUi.invalid' });
        return;
      }
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json')
        throw new OwnerUiError();
      let size = 0;
      const chunks: Buffer[] = [];
      // A pipeline the owner edited travels whole (the file's own 256 KiB bound, with room for its JSON quoting); every
      // other request is a few small fields.
      const limit = req.url === '/pipeline-preview' ? 2 * MAX_PIPELINE_BYTES : 16384;
      for await (const raw of req) {
        const bytes = Buffer.from(raw);
        size += bytes.length;
        if (size > limit) throw new OwnerUiError();
        chunks.push(bytes);
      }
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (req.url === '/session') {
        const f = fields(body, ['kind', 'secret', 'view']);
        const active = session.activate(f.kind, f.secret, f.view);
        try {
          const pair: any = await ask(
            'owner-ui.pair',
            { farsightOrigin, hostInstance: host.instance, processNonce },
            abort.signal,
          );
          if (typeof pair.proof !== 'string' || !/^[a-f0-9]{64}$/.test(pair.proof)) throw new OwnerUiError();
          proof = pair.proof;
          await ask('owner-ui.context', { proof, view: session.authenticate(active.capability) }, abort.signal);
          if (abort.signal.aborted) throw new OwnerUiError();
          send(res, 200, { ...active, readOnly: host.readOnly });
        } catch (error) {
          session.revoke();
          throw error;
        }
        return;
      }
      const cap = typeof req.headers.authorization === 'string' ? req.headers.authorization.slice(7) : '';
      if (req.headers.authorization !== `Bearer ${cap}`) throw new OwnerUiError();
      auth(cap);
      if (req.url === '/context') {
        const f = fields(body, ['view']);
        session.update(cap, f.view);
        await ask('owner-ui.context', { proof, view: session.authenticate(cap) }, abort.signal);
        if (challenge && session.authenticate(cap).mode !== 'live')
          challenge.reject(new OwnerUiError('sentinel.ownerUi.readOnly'));
        send(res, 200, { revision: session.authenticate(cap).revision });
        return;
      }
      if (req.url === '/viewer-pass') {
        fields(body, []);
        // A read pass for the parent page: the read model's GET routes and nothing else (transport/http/).
        send(res, 200, session.readPass(cap));
        return;
      }
      if (req.url === '/events') {
        fields(body, []);
        if (eventResponse) throw new OwnerUiError('sentinel.ownerUi.busy');
        if (challenge) {
          send(res, 200, { challenge: challenge.id });
          return;
        }
        eventResponse = res;
        const timer = setTimeout(() => {
          if (eventResponse === res) {
            eventResponse = null;
            send(res, 200, { challenge: null });
          }
        }, 1000);
        res.once('close', () => {
          clearTimeout(timer);
          if (eventResponse === res) eventResponse = null;
        });
        return;
      }
      if (req.url === '/ack') {
        const f = fields(body, ['id', 'view']);
        if (!challenge || challenge.id !== f.id) throw new OwnerUiError();
        session.update(cap, f.view);
        await ask('owner-ui.context', { proof, view: session.authenticate(cap) }, abort.signal);
        auth(cap);
        const pending = challenge;
        if (!pending || pending.id !== f.id) throw new OwnerUiError();
        pending.resolve();
        send(res, 200, { acknowledged: true });
        return;
      }
      if (req.url === '/preview') {
        fields(body, []);
        const requestKey = 'request-' + randomBytes(16).toString('hex'),
          preview = configurationPreview(await ui('owner-ui.preview', { requestKey }, cap, abort.signal));
        const confirm = session.challenge(cap, 'prepare');
        pendingPreview = {
          kind: 'prepare',
          requestKey,
          previewId: preview.id,
          parentId: null,
          challenge: confirm,
        };
        send(res, 200, { preview, confirmation: confirm });
        return;
      }
      if (req.url === '/control-preview') {
        // A run's start, pause or cancel: the run the viewer names (by its run id, as the read model addresses it), or
        // the run the Scan flow just prepared.
        const f = fields(body, ['action', 'runId']);
        const runId = f.runId === undefined ? lastRun : digestId(f.runId);
        if (!runId || typeof f.action !== 'string' || !['start', 'pause', 'cancel'].includes(f.action))
          throw new OwnerUiError();
        const preview: any = await ui('owner-ui.control-preview', { runId, action: f.action }, cap, abort.signal);
        if (preview.unavailable) {
          send(res, 200, preview);
          return;
        }
        const confirm = session.challenge(cap, 'control');
        pendingPreview = { kind: 'control', previewId: preview.id, challenge: confirm };
        send(res, 200, { preview: { ...preview, runId }, confirmation: confirm });
        return;
      }
      if (req.url === '/pipeline-preview') {
        // The viewer's edited pipeline, handed to this frame by its exact paired parent: the service checks it and
        // previews what running it would do; the owner confirms the write here, and adoption stays the CLI owner's.
        const f = fields(body, ['pipeline', 'expectDigest']);
        const preview: any = await ui(
          'owner-ui.pipeline-preview',
          { pipeline: f.pipeline, expectDigest: f.expectDigest },
          cap,
          abort.signal,
        );
        if (preview.unavailable || typeof preview.id !== 'string') {
          send(res, 200, { ...preview, unavailable: true });
          return;
        }
        const confirm = session.challenge(cap, 'pipeline');
        pendingPreview = { kind: 'pipeline', previewId: preview.id, challenge: confirm };
        send(res, 200, { preview, confirmation: confirm });
        return;
      }
      if (req.url === '/confirm') {
        const f = fields(body, ['id', 'revision']);
        if (effect || !pendingPreview) throw new OwnerUiError('sentinel.ownerUi.busy');
        effect = true;
        const pending = pendingPreview;
        pendingPreview = null;
        try {
          session.consume(cap, f.id, pending.kind, f.revision);
          let lock: Awaited<ReturnType<typeof preparationKeyLock>> | undefined;
          try {
            if (pending.kind === 'prepare') {
              lock = await preparationKeyLock(ws.trustDir, preparationClientFilename(ws, client.storeId));
              const previous = readPreparationClientKey(ws, client.storeId);
              if (previous) {
                const old = preparationOutcome(await ask('prepare.status', { requestKey: previous }, abort.signal));
                if (old.status?.found === false && absentPreparationKeyReplaceable(ws, client.storeId, previous)) {
                  /* no dispatch or a definitive refusal */
                } else {
                  if (!old.status?.found) throw new OwnerUiError('sentinel.preparation.unavailable');
                  const status = old.status,
                    allowed =
                      status.phase === 'prepared' ||
                      (pending.parentId === null &&
                        (['failed', 'canceled'].includes(status.phase) ||
                          (status.phase === 'interrupted' && status.resumeAvailable === false)));
                  if (!allowed) throw new OwnerUiError('sentinel.preparation.busy');
                }
              }
            }
            await freshContext(cap, abort.signal);
            if (pending.kind === 'prepare') {
              lock!.assertHeld();
              savePreparationClientKey(ws, client.storeId, pending.requestKey, 'unsent');
              lock!.assertHeld();
              savePreparationClientKey(ws, client.storeId, pending.requestKey, 'unknown');
              lastKey = pending.requestKey;
              const checked = validateEnvelope(
                'preparationoutcome',
                await ui('owner-ui.accept', { requestKey: lastKey, previewId: pending.previewId }, cap, abort.signal),
              );
              if (!checked.ok) throw new OwnerUiError('sentinel.preparation.outcomeUnknown');
              const answer = checked.value;
              if (preparationDefinitivelyRefused(answer)) {
                lock!.assertHeld();
                savePreparationClientKey(ws, client.storeId, pending.requestKey, 'refused');
              }
              if (answer.status?.found) choose(answer.status.runId);
              send(res, 200, answer);
            } else if (pending.kind === 'pipeline')
              send(res, 200, await ui('owner-ui.pipeline-write', { previewId: pending.previewId }, cap, abort.signal));
            else send(res, 200, await ui('owner-ui.control', { previewId: pending.previewId }, cap, abort.signal));
          } finally {
            lock?.close();
          }
        } finally {
          effect = false;
        }
        return;
      }
      if (req.url === '/status') {
        // The Scan flow's wait for its preparation: the phase the service records, and the run it made.
        fields(body, []);
        lastKey = readPreparationClientKey(ws, client.storeId);
        if (!lastKey) {
          choose(null);
          send(res, 200, { status: null });
          return;
        }
        const status = preparationOutcome(await ask('prepare.status', { requestKey: lastKey }, abort.signal));
        choose(status.status?.found ? status.status.runId : null);
        send(res, 200, status);
        return;
      }
      throw new OwnerUiError();
    } catch (error) {
      if (session.revoked && proof) {
        const revoked = proof;
        proof = null;
        await client.request('owner-ui.revoke', { proof: revoked }, { timeoutMs: 1500 }).catch(() => {});
      }
      const candidate = (error as { code?: unknown })?.code,
        code =
          typeof candidate === 'string' && Object.hasOwn(STRINGS, candidate) ? candidate : 'sentinel.ownerUi.failed';
      if (req.method === 'GET' && req.url === '/bootstrap' && code === 'sentinel.ownerUi.expired') {
        res.writeHead(400, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': `default-src 'none'; style-src 'self'; frame-ancestors ${farsightOrigin}; base-uri 'none'; form-action 'none'; object-src 'none'`,
        });
        res.end(
          ownerUiRecoveryHtml(
            STRINGS['sentinel.ownerUi.pairingUnavailable']!.professional,
            STRINGS['sentinel.ownerUi.pairingRecovery']!.professional,
          ),
        );
        return;
      }
      send(res, 400, { error: code, message: STRINGS[code]?.professional });
    }
  });
  server.maxConnections = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  } catch (error) {
    client.close();
    throw error;
  }
  let descriptor: Awaited<ReturnType<typeof publishOwnerCompanion>>;
  try {
    descriptor = await publishOwnerCompanion(companionDirectory(), {
      schema: 'farsight-sentinel-companion/1',
      ownerOrigin: origin,
      farsightOrigin,
      workspaceDigest: companionWorkspaceDigest(ws.path),
      hostInstance: host.instance,
      processNonce,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  } catch (error) {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    throw error;
  }
  const controller = {
    origin,
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(expiryTimer);
      session.revoke();
      if (challenge) challenge.reject(new OwnerUiError('sentinel.ownerUi.expired'));
      if (eventResponse) send(eventResponse, 200, { challenge: null });
      try {
        if (proof) await client.request('owner-ui.revoke', { proof }, { timeoutMs: 1500 }).catch(() => {});
      } finally {
        client.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((r) => server.close(() => r()));
        await descriptor.close();
      }
    },
  };
  const expiryTimer = setTimeout(
    () => {
      void controller.close().catch(() => {});
    },
    Math.max(1, session.expiresAt - Date.now()),
  );
  return controller;
}
export async function runOwnerUi(ws: Workspace, origin: string) {
  // Started beside a service that is still opening, the companion waits for it and says so, instead of exiting.
  const running = await startOwnerUi(ws, origin, {
    waitForServiceMs: SERVICE_WAIT.defaultMs,
    onWaiting: (ms) =>
      process.stdout.write(
        `${STRINGS['sentinel.ownerUi.waitingForService']!.professional.split('{s}').join(String(Math.round(ms / 1000)))}\n`,
      ),
  });
  // The door: the Sentinel view in the paired Farsight, where the owner panel lives now (no page of its own).
  process.stdout.write(
    `${STRINGS['sentinel.ownerUi.openSentinel']!.professional.split('{url}').join(origin + '/#/sentinel')}\n`,
  );
  const stop = new AbortController(),
    onSignal = () => stop.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await new Promise<void>((r) => stop.signal.addEventListener('abort', () => r(), { once: true }));
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await running.close();
  }
  return 0;
}
