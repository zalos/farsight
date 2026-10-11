#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { defaultConfig, loadContext, initConfig, trustConfig, updateConfig, validateConfig } from './config.js';
import { resolveInstallation, describeInstallation, readConnection, preflightConnection, writeConnection, removeConnection } from './installation.js';
import { listModels } from './models.js';
import { bindSession, contextFingerprint } from './sessions.js';
import { prepareHooks, type HookHost, HOOK_EVENTS } from './hooks.js';
import { installWorkspaceHooks } from './workspace-hooks.js';
import { startWeb } from './web.js';
import { startMemoryBridge, memoryRequest } from './memory.js';
import { hookContext } from './hook-context.js';
import { installRuntime, startBackend, backendHealth, closeOwnedBackends, installedBackendVersion, runtimeInstalled, hasGlobalBackendConfig, AGENTMEMORY_VERSION, ENGINE_VERSION } from './runtime.js';
import { smoke } from './smoke.js';
import { word } from './words.js';
import type { EchoConfig, EchoContext, CheckResult, BackendConnection } from './types.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, profile: { type: 'string' }, host: { type: 'string' }, model: { type: 'string' },
  'with-model': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  install: { type: 'boolean' }, workspace: { type: 'string' }, content: { type: 'string' },
  query: { type: 'string' }, topic: { type: 'string', multiple: true }, limit: { type: 'string' },
  scope: { type: 'string' }, port: { type: 'string' }, 'backend-port': { type: 'string' },
  confirm: { type: 'boolean' },
} });
const command = values.help ? 'help' : positionals[0] ?? 'help';
const print = (data: unknown) => process.stdout.write(`${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`);
const workspace = () => resolve(values.workspace ?? process.cwd());
const target = () => resolveInstallation({
  cwd: command === 'connect' || command === 'hooks' && values.install || command === 'setup' ? workspace() : process.cwd(),
  configPath: values.config === undefined ? undefined : resolve(values.config), scope: values.scope, profileId: values.profile,
  ignoreConnection: command === 'trust',
});

async function connectWorkspace(ctx: EchoContext, host: HookHost | 'all', root: string): Promise<void> {
  // Refuse malformed or redirected binding files before changing host settings.
  preflightConnection(root, { configPath: ctx.configPath, profileId: ctx.profileId });
  const installed = await installWorkspaceHooks(ctx, host, fileURLToPath(import.meta.url), root);
  // Another workspace can connect while this process writes hook files. Preserve
  // the newest settings, and never carry an old identity/model snapshot forward.
  await updateConfig(ctx.configPath, current => {
    if (contextFingerprint(loadContext(ctx.configPath, ctx.profileId)) !== contextFingerprint(ctx)) throw new Error(word('connectionChanged'));
    const hooks = current.profiles[ctx.profileId]!.hooks;
    if (!installed.hosts.some(selected => !hooks[selected])) return;
    for (const selected of installed.hosts) hooks[selected] = true;
    return current;
  });
  const connection = await writeConnection(root, { configPath: ctx.configPath, profileId: ctx.profileId });
  print({ ...installed, connection, installation: describeInstallation(ctx.configPath), profile: ctx.profileId });
}

function setupValues(config: EchoConfig, selected: string): EchoConfig {
  const profile = config.profiles[selected];
  if (!profile) throw new Error(word('profileRequired'));
  if (values.model !== undefined) profile.model.model = values.model;
  if (values.port !== undefined) profile.web.port = Number(values.port);
  if (values['backend-port'] !== undefined) {
    if (profile.backend.mode !== 'managed' || !/^\d+$/.test(values['backend-port'])) throw new Error(word('managedPort'));
    profile.backend.url = `http://127.0.0.1:${Number(values['backend-port'])}`;
  }
  return validateConfig(config);
}

async function setup(): Promise<void> {
  if (command === 'setup' && !process.stdin.isTTY) throw new Error(word('interactive'));
  const prompt = command === 'setup' ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    let installation = target();
    if (prompt && values.scope === undefined && values.config === undefined) {
      const current = installation.scope === 'global' ? 'global' : 'workspace';
      const choice = (await prompt.question(word('askScope', { scope: current }))).trim() || current;
      installation = resolveInstallation({ cwd: workspace(), scope: choice, profileId: values.profile ?? (choice === current ? installation.profileId : undefined) });
    }
    const configPath = installation.configPath;
    if (!existsSync(configPath)) {
      const initial = defaultConfig();
      if (installation.scope === 'global') {
        for (const [index, profile] of Object.values(initial.profiles).entries()) {
          profile.web.port = 4490 + index;
          profile.backend.url = `http://127.0.0.1:${5211 + index * 100}`;
          profile.identity.project = 'shared';
        }
      }
      await initConfig(configPath, setupValues(initial, installation.profileId ?? initial.defaultProfile));
    } else if (command === 'init') throw new Error(word('configExists'));
    let ctx = loadContext(configPath, installation.profileId);
    if (prompt) {
      await updateConfig(configPath, config => setupValues(config, ctx.profileId));
      ctx = loadContext(configPath, ctx.profileId);
      if (!ctx.profile.model.model) {
        let models: string[] = [];
        try { models = await listModels(ctx.profile); } catch { print(word('modelUnavailable')); }
        if (models.length) {
          print({ availableModels: models });
          const selected = (await prompt.question(word('selectModel', { model: models[0]! }))).trim() || models[0]!;
          if (!models.includes(selected)) throw new Error(word('modelUnavailable'));
          await updateConfig(configPath, config => { config.profiles[ctx.profileId]!.model.model = selected; return config; });
          ctx = loadContext(configPath, ctx.profileId);
        } else print(word('downloadModel'));
      }
      print({ installation: describeInstallation(ctx.configPath), profile: ctx.profileId, workspace: workspace() });
      for (const host of ['claude', 'codex', 'vscode'] as const) {
        if (/^y(es)?$/i.test((await prompt.question(word('askHooks', { host }))).trim())) await connectWorkspace(ctx, host, workspace());
      }
      if (ctx.profile.backend.mode === 'managed' && /^y(es)?$/i.test((await prompt.question(word('askRuntime'))).trim())) print(await installRuntime(ctx));
    }
    print({ configPath: ctx.configPath, installation: describeInstallation(ctx.configPath), profile: ctx.profileId, next: word('next') });
  } finally { prompt?.close(); }
}

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
  await updateConfig(ctx.configPath, config => {
    if (config.profiles[ctx.profileId]!.hooks[host]) return;
    config.profiles[ctx.profileId]!.hooks[host] = true;
    return config;
  });
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
    const payload = JSON.parse(input) as { session_id?: unknown; hook_event_name?: unknown; prompt?: unknown; cwd?: unknown };
    if (typeof payload.session_id !== 'string' || !payload.session_id || payload.session_id.length > 512) return;
    if (!(HOOK_EVENTS as readonly unknown[]).includes(payload.hook_event_name)) return;
    const installation = target();
    const ctx = loadContext(installation.configPath, installation.profileId);
    if (!ctx.profile.hooks[values.host]) return;
    const hostCwd = typeof payload.cwd === 'string' && isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
    const root = values.workspace ?? resolveInstallation({ cwd: hostCwd, scope: 'workspace' }).workspaceRoot!;
    const connection = readConnection(root);
    // Installed runners require the completed connection; a failed first install
    // must not expose a different store while ordinary workspace commands stay local.
    if (values.workspace !== undefined && !connection) throw new Error(word('connectionChanged'));
    if (connection) {
      const connected = loadContext(connection.configPath, connection.profileId);
      if (connected.configPath !== ctx.configPath || connected.profileId !== ctx.profileId) throw new Error(word('connectionChanged'));
    }
    await bindSession(ctx, values.host, payload.session_id, { workspace: root });
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
  if (command === 'trust') {
    if (!values.confirm) throw new Error(word('trustConfirm'));
    const selection = target();
    await trustConfig(selection.configPath);
    print({ configPath: selection.configPath, trusted: true }); return;
  }
  if (command === 'init' || command === 'setup') { await setup(); return; }
  if (values.port !== undefined || values['backend-port'] !== undefined) throw new Error(word('setupOptions'));
  const installation = target();
  const ctx = loadContext(installation.configPath, installation.profileId);
  if (command === 'connect') {
    const host = values.host ?? 'all';
    if (host !== 'claude' && host !== 'codex' && host !== 'vscode' && host !== 'all') throw new Error(word('hostRequired'));
    await connectWorkspace(ctx, host, workspace()); return;
  }
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
      await connectWorkspace(ctx, values.host, workspace()); return;
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
  const web = await startWeb(ctx, { installation: describeInstallation(ctx.configPath), checks: async () => [
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
