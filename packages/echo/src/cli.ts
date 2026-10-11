#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadContext, initConfig, saveConfig } from './config.js';
import { listModels } from './models.js';
import { bindSession } from './sessions.js';
import { prepareHooks } from './hooks.js';
import { startWeb } from './web.js';
import { installRuntime, startBackend, backendHealth, closeOwnedBackends, installedBackendVersion, runtimeInstalled, hasGlobalBackendConfig, AGENTMEMORY_VERSION, ENGINE_VERSION } from './runtime.js';
import { smoke } from './smoke.js';
import { word } from './words.js';
import type { EchoContext, CheckResult, BackendConnection } from './types.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, profile: { type: 'string' }, host: { type: 'string' }, model: { type: 'string' },
  'with-model': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });
const configPath = resolve(values.config ?? '.echo/settings.json');
const command = values.help ? 'help' : positionals[0] ?? 'help';
const print = (data: unknown) => process.stdout.write(`${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`);

async function checks(ctx: EchoContext, connection?: BackendConnection): Promise<CheckResult[]> {
  const checks: CheckResult[] = [
    { name: 'agentmemory', ok: installedBackendVersion() === AGENTMEMORY_VERSION, detail: installedBackendVersion() },
    { name: 'engine', ok: ctx.profile.backend.mode === 'external' || runtimeInstalled(ctx), detail: ctx.profile.backend.mode === 'external' ? 'external' : ENGINE_VERSION },
  ];
  if (ctx.profile.backend.mode === 'managed') checks.push({ name: 'backend-isolation', ok: !hasGlobalBackendConfig(), detail: hasGlobalBackendConfig() ? word('globalConfig') : word('isolated') });
  if (ctx.profile.model.provider === 'openai-compatible') {
    checks.push({ name: 'model-configuration', ok: !!ctx.profile.model.model, detail: word('compatibleCheck') });
  } else try {
    const models = await listModels(ctx.profile);
    checks.push({ name: 'model', ok: !!ctx.profile.model.model && models.includes(ctx.profile.model.model), detail: ctx.profile.model.model || word('chooseModel') });
  } catch { checks.push({ name: 'model', ok: false, detail: word('modelUnavailable') }); }
  if (connection) {
    try { await backendHealth(connection); checks.push({ name: 'backend', ok: true, detail: word('ready') }); }
    catch { checks.push({ name: 'backend', ok: false, detail: word('backendUnavailable') }); }
  }
  return checks;
}

async function hooks(ctx: EchoContext, host: 'claude' | 'codex'): Promise<void> {
  const result = await prepareHooks(ctx, host, fileURLToPath(import.meta.url));
  ctx.config.profiles[ctx.profileId]!.hooks[host] = true;
  await saveConfig(ctx.configPath, ctx.config);
  print(result);
}

async function hook(): Promise<void> {
  // Hooks remain fast, fail open for the host, and discard prompt/tool content in this foundation.
  try {
    if (values.host !== 'claude' && values.host !== 'codex') return;
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 1_000_000) return;
    }
    const payload = JSON.parse(input) as { session_id?: unknown };
    if (typeof payload.session_id !== 'string' || !payload.session_id || payload.session_id.length > 512) return;
    const ctx = await loadContext(configPath, values.profile);
    if (!ctx.profile.hooks[values.host]) return;
    await bindSession(ctx, values.host, payload.session_id);
  } catch { process.stderr.write(`${word('hookRefused')}\n`); }
}

async function main(): Promise<void> {
  if (command === 'help') { print(word('help')); return; }
  if (command === 'hook') { await hook(); return; }
  if (positionals.length > 1) throw new Error(word('unknownCommand'));
  if (command === 'init' || command === 'setup') {
    if (!existsSync(configPath)) await initConfig(configPath);
    else if (command === 'init') throw new Error(word('configExists'));
    const ctx = await loadContext(configPath, values.profile);
    if (values.model) {
      ctx.profile.model.model = values.model;
      ctx.config.profiles[ctx.profileId]!.model.model = values.model;
      await saveConfig(configPath, ctx.config);
    }
    if (command === 'init') { print({ configPath, profile: ctx.profileId, next: word('next') }); return; }
    if (!process.stdin.isTTY) throw new Error(word('interactive'));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!ctx.profile.model.model) {
        let models: string[] = [];
        try { models = await listModels(ctx.profile); } catch { print(word('modelUnavailable')); }
        if (models.length) {
          print({ availableModels: models });
          const selected = (await prompt.question(word('selectModel', { model: models[0]! }))).trim() || models[0]!;
          if (!models.includes(selected)) throw new Error(word('modelUnavailable'));
          ctx.profile.model.model = selected;
          ctx.config.profiles[ctx.profileId]!.model.model = selected;
        } else print(word('downloadModel'));
      }
      for (const host of ['claude', 'codex'] as const) {
        if (/^y(es)?$/i.test((await prompt.question(word('askHooks', { host }))).trim())) await hooks(ctx, host);
      }
      await saveConfig(configPath, ctx.config);
      if (ctx.profile.backend.mode === 'managed' && /^y(es)?$/i.test((await prompt.question(word('askRuntime'))).trim())) print(await installRuntime(ctx));
    } finally { prompt.close(); }
    print({ configPath, profile: ctx.profileId, next: word('next') });
    return;
  }
  const ctx = await loadContext(configPath, values.profile);
  if (command === 'install-runtime') { print(await installRuntime(ctx)); return; }
  if (command === 'doctor') {
    let connection: BackendConnection | undefined;
    let failure: CheckResult | undefined;
    if (ctx.profile.backend.mode === 'external') {
      try { connection = await startBackend(ctx); }
      catch { failure = { name: 'backend', ok: false, detail: word('backendUnavailable') }; }
    }
    const result = [...await checks(ctx, connection), ...(failure ? [failure] : [])];
    await connection?.close();
    print(result); if (result.some(c => !c.ok)) process.exitCode = 1; return;
  }
  if (command === 'smoke') {
    const interrupted = () => { void closeOwnedBackends().finally(() => process.exit(130)); };
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
    try { print(await smoke(ctx, !!values['with-model'])); }
    finally { process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted); }
    return;
  }
  if (command === 'hooks') {
    if (values.host !== 'claude' && values.host !== 'codex') throw new Error(word('hostRequired'));
    await hooks(ctx, values.host); return;
  }
  if (command !== 'serve') throw new Error(word('unknownCommand'));
  let backend: BackendConnection | undefined;
  let startup: string | undefined;
  // Settings remain reachable even if a backend or model needs configuration.
  const web = await startWeb(ctx, { checks: async () => [
    ...await checks(ctx, backend),
    ...(startup ? [{ name: 'backend', ok: false, detail: startup }] : []),
  ] });
  print({ url: web.url, profile: ctx.profileId, scope: ctx.profile.identity, phase: 'setup' });
  let stopping = false;
  let starting: Promise<void>;
  const close = async () => {
    if (stopping) return; stopping = true;
    await closeOwnedBackends(); await starting;
    await web.close(); await backend?.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  starting = startBackend(ctx).then(result => { backend = result; }).catch(error => { startup = error instanceof Error ? error.message : word('backendUnavailable'); print({ backend: startup }); });
  await starting;
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : word('failed')}\n`); process.exitCode = 1; });
