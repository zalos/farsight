#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadContext, initConfig, saveConfig } from './config.js';
import { listModels } from './models.js';
import { bindSession } from './sessions.js';
import { prepareHooks, type HookHost, HOOK_EVENTS } from './hooks.js';
import { installWorkspaceHooks } from './workspace-hooks.js';
import { startWeb } from './web.js';
import { startMemoryBridge, memoryRequest } from './memory.js';
import { hookContext } from './hook-context.js';
import { installRuntime, startBackend, backendHealth, closeOwnedBackends, installedBackendVersion, runtimeInstalled, hasGlobalBackendConfig, AGENTMEMORY_VERSION, ENGINE_VERSION } from './runtime.js';
import { smoke } from './smoke.js';
import { word } from './words.js';
import type { EchoContext, CheckResult, BackendConnection } from './types.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, profile: { type: 'string' }, host: { type: 'string' }, model: { type: 'string' },
  'with-model': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  install: { type: 'boolean' }, workspace: { type: 'string' }, content: { type: 'string' },
  query: { type: 'string' }, topic: { type: 'string', multiple: true }, limit: { type: 'string' },
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

async function hooks(ctx: EchoContext, host: HookHost): Promise<void> {
  const result = await prepareHooks(ctx, host, fileURLToPath(import.meta.url));
  ctx.config.profiles[ctx.profileId]!.hooks[host] = true;
  await saveConfig(ctx.configPath, ctx.config);
  print(result);
}

async function hook(): Promise<void> {
  // Hooks remain fast and fail open. Only a prompt query is read; transcripts and
  // tool output are never captured by this explicit-memory iteration.
  const deadline = setTimeout(() => process.exit(0), 3500);
  deadline.unref();
  try {
    if (values.host !== 'claude' && values.host !== 'codex' && values.host !== 'vscode') return;
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 1_000_000) return;
    }
    const payload = JSON.parse(input) as { session_id?: unknown; hook_event_name?: unknown; prompt?: unknown };
    if (typeof payload.session_id !== 'string' || !payload.session_id || payload.session_id.length > 512) return;
    if (!(HOOK_EVENTS as readonly unknown[]).includes(payload.hook_event_name)) return;
    const ctx = await loadContext(configPath, values.profile);
    if (!ctx.profile.hooks[values.host]) return;
    await bindSession(ctx, values.host, payload.session_id);
    if (payload.hook_event_name === 'SessionStart') {
      print(hookContext(ctx, fileURLToPath(import.meta.url), 'SessionStart'));
    } else if (payload.hook_event_name === 'UserPromptSubmit' && typeof payload.prompt === 'string' && payload.prompt.trim()) {
      const result = await memoryRequest(ctx, 'recall', { query: payload.prompt.slice(0, 2000), limit: 5 }, { timeoutMs: 1800 });
      if (result.memories.length) print(hookContext(ctx, fileURLToPath(import.meta.url), 'UserPromptSubmit', result));
    }
  } catch { process.stderr.write(`${word('hookRefused')}\n`); }
  finally { clearTimeout(deadline); }
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
      for (const host of ['claude', 'codex', 'vscode'] as const) {
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
    if (values.host !== 'claude' && values.host !== 'codex' && values.host !== 'vscode' && values.host !== 'all') throw new Error(word('hostRequired'));
    if (values.install) {
      if (!values.workspace) throw new Error(word('workspaceRequired'));
      const result = await installWorkspaceHooks(ctx, values.host, fileURLToPath(import.meta.url), resolve(values.workspace));
      const installedHosts: readonly HookHost[] = values.host === 'all' ? ['claude', 'codex', 'vscode'] : [values.host];
      for (const host of installedHosts) ctx.config.profiles[ctx.profileId]!.hooks[host] = true;
      await saveConfig(ctx.configPath, ctx.config);
      print(result); return;
    }
    if (values.host === 'all') { for (const host of ['claude', 'codex', 'vscode'] as const) await hooks(ctx, host); return; }
    await hooks(ctx, values.host); return;
  }
  if (command === 'remember') {
    if (!values.content?.trim()) throw new Error(word('contentRequired'));
    print(await memoryRequest(ctx, 'remember', { content: values.content, topics: values.topic })); return;
  }
  if (command === 'recall') {
    if (!values.query?.trim()) throw new Error(word('queryRequired'));
    print(await memoryRequest(ctx, 'recall', { query: values.query, ...(values.limit === undefined ? {} : { limit: Number(values.limit) }) })); return;
  }
  if (command !== 'serve') throw new Error(word('unknownCommand'));
  let backend: BackendConnection | undefined;
  let memory: { close(): Promise<void> } | undefined;
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
    await memory?.close(); await closeOwnedBackends(); await starting;
    await memory?.close();
    await web.close(); await backend?.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  starting = startBackend(ctx).then(async result => {
    try {
      if (!stopping) memory = await startMemoryBridge(ctx, result);
      backend = result;
    } catch (error) { await result.close(); throw error; }
  }).catch(async error => {
    startup = error instanceof Error ? error.message : word('backendUnavailable');
    await backend?.close(); backend = undefined;
    print({ backend: startup });
  });
  await starting;
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : word('failed')}\n`); process.exitCode = 1; });
