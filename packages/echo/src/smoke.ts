import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EchoContext, CheckResult, BackendConnection } from './types.js';
import { startBackend, backendRequest, managedPorts } from './runtime.js';
import { summarize } from './models.js';
import { word } from './words.js';

/** Reserve both test blocks together while checking, then release for the owned runtime. */
async function isolatedProfile(ctx: EchoContext): Promise<EchoContext['profile']> {
  const excluded = new Set<number>();
  for (const profile of Object.values(ctx.config.profiles)) {
    excluded.add(profile.web.port);
    if (profile.backend.mode === 'managed') {
      for (const port of managedPorts({ ...ctx, profile })) excluded.add(port);
    }
    for (const endpoint of [profile.backend.url, profile.model.baseUrl]) {
      const url = new URL(endpoint);
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        excluded.add(Number(url.port || (url.protocol === 'https:' ? 443 : 80)));
      }
    }
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const profile = structuredClone(ctx.profile);
    const base = randomInt(12000, 19000);
    profile.backend.url = `http://127.0.0.1:${base}`;
    const ports = managedPorts({ ...ctx, profile });
    const bothBlocks = [...ports, ...ports.map((port) => port + 10)];
    if (bothBlocks.some((port) => excluded.has(port))) continue;
    const reservations: Server[] = [];
    try {
      for (const port of bothBlocks) {
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
        reservations.push(server);
      }
      return profile;
    } catch {
      // Another local process owns this block; try another without disturbing it.
    } finally {
      await Promise.all(reservations.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  }
  throw new Error(word('smokePorts'));
}

/** Synthetic data only, in a disposable managed store. Never writes into an external team backend. */
export async function smoke(ctx: EchoContext, withModel = false): Promise<CheckResult[]> {
  if (ctx.profile.backend.mode !== 'managed') throw new Error(word('smokeManaged'));
  const profile = await isolatedProfile(ctx);
  const directory = mkdtempSync(join(tmpdir(), 'farsight-echo-smoke-'));
  const probe: EchoContext = { ...ctx, profile, directory, dataDirectory: join(directory, 'data') };
  const marker = `echoverify${randomUUID().replaceAll('-', '')}`;
  const content = `${marker} Synthetic shipment used an insulated container with cold packs. Delivery arrived on time.`;
  const scope = { project: `echo-smoke-${marker}`, agentId: ctx.profile.identity.individual };
  let connection: BackendConnection | undefined;
  const checks: CheckResult[] = [];
  let passed = false;
  try {
    connection = await startBackend(probe);
    const saved = await backendRequest(connection, '/agentmemory/remember', {
      content,
      type: 'fact',
      concepts: ['echo-smoke'],
      ...scope,
    });
    if (!(saved as { success?: boolean })?.success) throw new Error(word('smokeSave'));
    const recall = async () =>
      backendRequest(connection!, '/agentmemory/search', { query: marker, limit: 5, format: 'full', ...scope });
    const first = JSON.stringify(await recall());
    if (!first.includes(marker)) throw new Error(word('smokeRecall'));
    checks.push({ name: 'remember-recall', ok: true, detail: word('smokeRoundtrip') });
    await connection.close();
    connection = undefined;
    // A saved connection change must also take effect, despite iii's cached worker definitions.
    const changedProfile = structuredClone(probe.profile);
    const changedUrl = new URL(changedProfile.backend.url);
    const oldPort = Number(changedUrl.port);
    changedUrl.port = String(oldPort + 10);
    changedProfile.backend.url = changedUrl.origin;
    probe.profile = changedProfile;
    connection = await startBackend(probe);
    if (!JSON.stringify(await recall()).includes(marker)) throw new Error(word('smokeRecall'));
    checks.push({ name: 'restart-persistence', ok: true, detail: word('smokePersistence') });
    await connection.close();
    connection = undefined;
    connection = await startBackend({ ...probe, dataDirectory: join(directory, 'other-profile') });
    if (JSON.stringify(await recall()).includes(marker)) throw new Error(word('smokeIsolation'));
    checks.push({ name: 'store-isolation', ok: true, detail: word('smokeSeparate') });
    if (withModel) {
      const result = await summarize(ctx.profile, content);
      if (!result.trim()) throw new Error(word('smokeModel'));
      checks.push({ name: 'model-summary', ok: true, detail: result });
    }
    passed = true;
    return checks;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : word('failed')} ${word('smokeDiagnostics', { directory })}`,
    );
  } finally {
    await connection?.close();
    if (passed) rmSync(directory, { recursive: true, force: true });
  }
}
