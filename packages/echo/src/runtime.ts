import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { EchoContext, BackendConnection } from './types.js';
import { resolveSecret } from './secrets.js';
import { word } from './words.js';

export const AGENTMEMORY_VERSION = '0.9.30';
export const ENGINE_VERSION = '0.22.1';
const activeConnections = new Set<BackendConnection>();
export async function closeOwnedBackends(): Promise<void> {
  await Promise.all([...activeConnections].map(connection => connection.close()));
}
// Published iii/v0.22.1 archive checksums, also pinned by agentmemory's installer.
const archives: Record<string, [string, string]> = {
  'darwin-arm64': ['iii-aarch64-apple-darwin.tar.gz', '2b309019b909a896cae874dc947e2cdf877b4f3c51dd026b79850af858517fa4'],
  'darwin-x64': ['iii-x86_64-apple-darwin.tar.gz', '6d33940db2d3ad6a9aef9837aa5b89bf5c5e4acd0679e8178fec258af229d7e1'],
  'linux-x64': ['iii-x86_64-unknown-linux-gnu.tar.gz', '34d4bd2ec1873e6114bb836be7db9cb3f410d0d63353d240917f0bc9c30df13b'],
  'linux-arm64': ['iii-aarch64-unknown-linux-gnu.tar.gz', '87efc60210c1580ef2e11b13c679a4dad91917a9d80f737c5ba7e3475b3ca413'],
};

export const enginePath = (ctx: EchoContext): string => join(ctx.directory, 'runtime', ENGINE_VERSION, 'iii');
export function installedBackendVersion(): string {
  const require = createRequire(import.meta.url);
  return JSON.parse(readFileSync(require.resolve('@agentmemory/agentmemory/package.json'), 'utf8')).version;
}

/** Explicit installation, never an npm lifecycle script or an implicit download during serve. */
export async function installRuntime(ctx: EchoContext): Promise<string> {
  const binary = enginePath(ctx);
  if (existsSync(binary)) { verifyEngine(binary); return binary; }
  const archive = archives[`${process.platform}-${process.arch}`];
  if (!archive) throw new Error(word('unsupported'));
  mkdirSync(dirname(binary), { recursive: true, mode: 0o700 });
  const [asset, expected] = archive;
  const response = await fetch(`https://github.com/iii-hq/iii/releases/download/iii/v${ENGINE_VERSION}/${asset}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(word('download'));
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 100_000_000) throw new Error(word('download'));
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(word('checksum'));
  const path = join(dirname(binary), `${randomBytes(8).toString('hex')}.tar.gz`);
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  try {
    const names = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split('\n');
    if (!names.includes('iii') || names.some(n => n.startsWith('/') || n.split('/').includes('..'))) throw new Error(word('checksum'));
    execFileSync('tar', ['-xzf', path, '-C', dirname(binary), 'iii']);
    chmodSync(binary, 0o700);
    verifyEngine(binary);
  } finally { rmSync(path, { force: true }); }
  return binary;
}

function verifyEngine(binary: string): void {
  let version: string;
  try { version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { throw new Error(word('engineMissing')); }
  if (!new RegExp(`\\b${ENGINE_VERSION.replaceAll('.', '\\.')}\\b`).test(version)) throw new Error(word('engineVersion'));
}
export function runtimeInstalled(ctx: EchoContext): boolean {
  try { verifyEngine(enginePath(ctx)); return true; } catch { return false; }
}
export function hasGlobalBackendConfig(): boolean { return existsSync(join(homedir(), '.agentmemory', '.env')); }

export async function backendHealth(connection: BackendConnection, timeout = 10_000): Promise<void> {
  const result = await backendRequest(connection, '/agentmemory/health', undefined, timeout) as { service?: string; version?: string };
  if (!result || result.service !== 'agentmemory' || result.version !== AGENTMEMORY_VERSION) throw new Error(word('backendVersion'));
}

export function managedPorts(ctx: EchoContext): number[] {
  const rest = Number(new URL(ctx.profile.backend.url).port);
  return [rest, rest + 1, rest + 2, rest + 46023];
}

/** Process credentials, proxy settings and third-party model configuration are deliberately not inherited. */
export function workerEnvironment(ctx: EchoContext, secret: string): NodeJS.ProcessEnv {
  const [rest, stream, viewer, engine] = managedPorts(ctx);
  return {
    PATH: process.env.PATH, LANG: 'en_US.UTF-8',
    AGENTMEMORY_SECRET: secret,
    AGENTMEMORY_RUNTIME_DIR: ctx.dataDirectory,
    AGENTMEMORY_DATA_DIR: ctx.dataDirectory,
    AGENTMEMORY_VIEWER_HOST: '127.0.0.1',
    III_REST_PORT: String(rest), III_STREAM_PORT: String(stream), III_VIEWER_PORT: String(viewer),
    III_ENGINE_URL: `ws://127.0.0.1:${engine}`,
    AGENT_ID: ctx.profile.identity.individual,
    TEAM_MODE: 'private',
    AGENTMEMORY_AGENT_SCOPE: 'isolated',
    AGENTMEMORY_ALLOW_AGENT_SDK: 'false',
    AGENTMEMORY_AUTO_COMPRESS: 'false',
    AGENTMEMORY_INJECT_CONTEXT: 'false',
    CONSOLIDATION_ENABLED: 'false',
    SNAPSHOT_ENABLED: 'false', CLAUDE_MEMORY_BRIDGE: 'false',
    OTEL_SDK_DISABLED: 'true',
  };
}

export function renderEngineConfig(ctx: EchoContext): string {
  const [rest, stream, , engine] = managedPorts(ctx);
  // JSON is valid YAML and avoids interpolating paths into executable commands.
  return JSON.stringify({ workers: [
    { name: 'iii-worker-manager', config: { port: engine, host: '127.0.0.1' } },
    { name: 'iii-http', config: { port: rest, host: '127.0.0.1', default_timeout: 30000 } },
    { name: 'iii-state', config: { adapter: { name: 'kv', config: { store_method: 'file_based', save_interval_ms: 1000, file_path: join(ctx.dataDirectory, 'state_store.db') } } } },
    { name: 'iii-queue', config: { adapter: { name: 'builtin' } } },
    { name: 'iii-pubsub', config: { adapter: { name: 'local' } } },
    { name: 'iii-cron', config: { adapter: { name: 'kv' } } },
    { name: 'iii-stream', config: { port: stream, host: '127.0.0.1', adapter: { name: 'kv', config: { store_method: 'file_based', save_interval_ms: 1000, file_path: join(ctx.dataDirectory, 'stream_store') } } } },
    { name: 'iii-observability', config: { enabled: false } },
  ] }, null, 2);
}

function clearEngineConfiguration(ctx: EchoContext): void {
  // iii caches built-in worker definitions. Those definitions contain ports and
  // storage paths; retaining them would make a saved settings change ineffective.
  // Only remove engine-generated definitions in this owned profile, never state.
  for (const name of ['iii-worker-manager', 'iii-http', 'iii-state', 'iii-queue', 'iii-pubsub', 'iii-cron', 'iii-stream', 'iii-observability']) {
    const path = join(ctx.dataDirectory, 'config', `${name}.yaml`);
    if (!existsSync(path)) continue;
    const first = readFileSync(path, 'utf8').split('\n').find(line => line.trim());
    if (first?.trim() !== `id: ${name}`) throw new Error(word('engineConfig'));
    rmSync(path);
  }
}

async function available(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(word('portBusy', { port }))));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => { child.kill('SIGKILL'); }, 12_000);
    child.once('exit', () => { clearTimeout(kill); resolve(); });
    child.kill('SIGTERM');
  });
}

/** Own both child processes in the foreground. Never attach to or stop an unrelated daemon. */
export async function startBackend(ctx: EchoContext, binary = enginePath(ctx)): Promise<BackendConnection> {
  if (ctx.profile.backend.mode === 'external') {
    const secret = await resolveSecret(ctx.profile.backend.secretRef);
    const connection = { url: ctx.profile.backend.url, secret, close: async () => {} };
    await backendHealth(connection);
    return connection;
  }
  if (hasGlobalBackendConfig()) throw new Error(word('globalConfig'));
  if (installedBackendVersion() !== AGENTMEMORY_VERSION) throw new Error(word('backendVersion'));
  verifyEngine(binary);
  mkdirSync(ctx.dataDirectory, { recursive: true, mode: 0o700 });
  const lock = join(ctx.dataDirectory, 'echo-owner.json');
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error(word('locked')); }
  let engine: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const secret = randomBytes(32).toString('hex');
  const connection: BackendConnection = {
    url: ctx.profile.backend.url, secret,
    async close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await stopChild(worker);
        // File-backed iii state flushes on a timer. Allow the final worker writes to reach disk.
        if (engine) await delay(1600);
        await stopChild(engine);
        rmSync(lock, { force: true });
        activeConnections.delete(connection);
      })();
      return closing;
    },
  };
  activeConnections.add(connection);
  try {
    for (const port of managedPorts(ctx)) { await available(port); if (closed) throw new Error(word('stopped')); }
    const config = join(ctx.dataDirectory, 'iii-config.runtime.yaml');
    clearEngineConfiguration(ctx);
    writeFileSync(config, renderEngineConfig(ctx), { mode: 0o600 });
    const env = workerEnvironment(ctx, secret);
    const options = { cwd: ctx.dataDirectory, env, stdio: ['ignore', 'ignore', 'pipe'] as ['ignore', 'ignore', 'pipe'] };
    engine = spawn(binary, ['--config', config, '--no-update-check'], options);
    let failed = false;
    engine.on('error', () => { failed = true; });
    // Keep a bounded diagnostic tail without exposing bearer credentials.
    let diagnostics = '';
    const collect = (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000).replaceAll(secret, '[redacted]'); };
    engine.stderr?.on('data', collect);
    await delay(500);
    if (closed) throw new Error(word('stopped'));
    const require = createRequire(import.meta.url);
    const entry = join(dirname(require.resolve('@agentmemory/agentmemory/package.json')), 'dist', 'index.mjs');
    worker = spawn(process.execPath, [entry], options);
    worker.on('error', () => { failed = true; });
    worker.stderr?.on('data', collect);
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      if (closed || failed || engine.exitCode !== null || worker.exitCode !== null) break;
      try {
        await backendHealth(connection, 1500);
        if (closed) throw new Error(word('stopped'));
        engine.once('exit', () => { if (!closed) void connection.close(); });
        worker.once('exit', () => { if (!closed) void connection.close(); });
        return connection;
      }
      catch { await delay(250); }
    }
    // Local process diagnostics stay outside HTTP responses and contain no configured credentials.
    writeFileSync(join(ctx.dataDirectory, 'startup-error.log'), diagnostics, { mode: 0o600 });
    throw new Error(word('startup'));
  } catch (error) { await connection.close(); throw error; }
}

export async function backendRequest(connection: BackendConnection, path: string, body?: unknown, timeout = 10_000): Promise<unknown> {
  let response: Response;
  try { response = await fetch(new URL(path, connection.url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(connection.secret ? { authorization: `Bearer ${connection.secret}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout), redirect: 'error',
  }); } catch { throw new Error(word('backendUnavailable')); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(word('backendRequest', { status: response.status })); }
  if (!response.body) throw new Error(word('backendResponse'));
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new Error(word('backendResponse')); }
  finally { reader.releaseLock(); }
}
