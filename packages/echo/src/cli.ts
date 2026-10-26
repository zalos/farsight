#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  defaultConfig,
  loadContext,
  initConfig,
  trustConfig,
  updateConfig,
  validateConfig,
  submindSettings,
} from './config.js';
import {
  resolveInstallation,
  describeInstallation,
  readConnection,
  preflightConnection,
  writeConnection,
  removeConnection,
} from './installation.js';
import { listModels } from './models.js';
import { bindSession, contextFingerprint } from './sessions.js';
import { prepareHooks, type HookHost, HOOK_EVENTS } from './hooks.js';
import { disconnectWorkspaceHooks, installWorkspaceHooks } from './workspace-hooks.js';
import { startWeb } from './web.js';
import { startMemoryBridge, memoryRequest } from './memory.js';
import { hookContext, hookResearchContext, canFitHookResearch } from './hook-context.js';
import {
  installRuntime,
  startBackend,
  backendHealth,
  closeOwnedBackends,
  installedBackendVersion,
  runtimeInstalled,
  hasGlobalBackendConfig,
  AGENTMEMORY_VERSION,
  ENGINE_VERSION,
} from './runtime.js';
import { smoke } from './smoke.js';
import { word } from './words.js';
import { submindDemo } from './submind-demo.js';
import { discoverSetupModels, testSetupModel, ModelSetupFailure, modelSetupMessage } from './model-setup.js';
import { startPortalDemo } from './portal-demo.js';
import { createMemoryPortal, PortalFailure } from './portal.js';
import { echoSubmindWord } from '@farsight/core/dist/strings-echo-submind.js';
import type { EchoConfig, EchoContext, CheckResult, BackendConnection } from './types.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    profile: { type: 'string' },
    host: { type: 'string' },
    model: { type: 'string' },
    'with-model': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    install: { type: 'boolean' },
    workspace: { type: 'string' },
    content: { type: 'string' },
    query: { type: 'string' },
    topic: { type: 'string', multiple: true },
    limit: { type: 'string' },
    scope: { type: 'string' },
    port: { type: 'string' },
    'backend-port': { type: 'string' },
    request: { type: 'string' },
    'session-id': { type: 'string' },
    'wait-ms': { type: 'string' },
    'hook-research': { type: 'string' },
    'hook-wait-ms': { type: 'string' },
    'hook-timeout-ms': { type: 'string' },
    confirm: { type: 'boolean' },
    id: { type: 'string' },
    revision: { type: 'string' },
  },
});
const command = values.help ? 'help' : (positionals[0] ?? 'help');
const print = (data: unknown) =>
  process.stdout.write(`${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`);
const workspace = () => resolve(values.workspace ?? process.cwd());
const target = () =>
  resolveInstallation({
    cwd:
      command === 'connect' || (command === 'hooks' && values.install) || command === 'setup'
        ? workspace()
        : process.cwd(),
    configPath: values.config === undefined ? undefined : resolve(values.config),
    scope: values.scope,
    profileId: values.profile,
    ignoreConnection: command === 'trust',
  });

async function connectWorkspace(ctx: EchoContext, host: HookHost | 'all', root: string): Promise<void> {
  // Refuse malformed or redirected binding files before changing host settings.
  preflightConnection(root, { configPath: ctx.configPath, profileId: ctx.profileId });
  const installed = await installWorkspaceHooks(ctx, host, fileURLToPath(import.meta.url), root);
  // Another workspace can connect while this process writes hook files. Preserve
  // the newest settings, and never carry an old identity/model snapshot forward.
  await updateConfig(ctx.configPath, (current) => {
    if (contextFingerprint(loadContext(ctx.configPath, ctx.profileId)) !== contextFingerprint(ctx))
      throw new Error(word('connectionChanged'));
    const hooks = current.profiles[ctx.profileId]!.hooks;
    if (!installed.hosts.some((selected) => !hooks[selected])) return;
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
    if (profile.backend.mode !== 'managed' || !/^\d+$/.test(values['backend-port']))
      throw new Error(word('managedPort'));
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
      installation = resolveInstallation({
        cwd: workspace(),
        scope: choice,
        profileId: values.profile ?? (choice === current ? installation.profileId : undefined),
      });
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
      await updateConfig(configPath, (config) => setupValues(config, ctx.profileId));
      ctx = loadContext(configPath, ctx.profileId);
      if (!ctx.profile.model.model) {
        let models: string[] = [];
        try {
          models = await listModels(ctx.profile);
        } catch {
          print(word('modelUnavailable'));
        }
        if (models.length) {
          print({ availableModels: models });
          const selected = (await prompt.question(word('selectModel', { model: models[0]! }))).trim() || models[0]!;
          if (!models.includes(selected)) throw new Error(word('modelUnavailable'));
          await updateConfig(configPath, (config) => {
            config.profiles[ctx.profileId]!.model.model = selected;
            return config;
          });
          ctx = loadContext(configPath, ctx.profileId);
        } else print(word('downloadModel'));
      }
      print({ installation: describeInstallation(ctx.configPath), profile: ctx.profileId, workspace: workspace() });
      for (const host of ['claude', 'codex', 'vscode'] as const) {
        if (/^y(es)?$/i.test((await prompt.question(word('askHooks', { host }))).trim()))
          await connectWorkspace(ctx, host, workspace());
      }
      if (
        ctx.profile.backend.mode === 'managed' &&
        /^y(es)?$/i.test((await prompt.question(word('askRuntime'))).trim())
      )
        print(await installRuntime(ctx));
    }
    print({
      configPath: ctx.configPath,
      installation: describeInstallation(ctx.configPath),
      profile: ctx.profileId,
      next: word('next'),
    });
  } finally {
    prompt?.close();
  }
}

async function checks(ctx: EchoContext, connection?: BackendConnection): Promise<CheckResult[]> {
  const checks: CheckResult[] = [
    { name: 'agentmemory', ok: installedBackendVersion() === AGENTMEMORY_VERSION, detail: installedBackendVersion() },
    {
      name: 'engine',
      ok: ctx.profile.backend.mode === 'external' || runtimeInstalled(ctx),
      detail: ctx.profile.backend.mode === 'external' ? 'external' : ENGINE_VERSION,
    },
  ];
  if (ctx.profile.backend.mode === 'managed')
    checks.push({
      name: 'backend-isolation',
      ok: !hasGlobalBackendConfig(),
      detail: hasGlobalBackendConfig() ? word('globalConfig') : word('isolated'),
    });
  if (submindSettings(ctx.profile).mode === 'model') {
    if (ctx.profile.model.provider === 'openai-compatible') {
      checks.push({ name: 'model-configuration', ok: !!ctx.profile.model.model, detail: word('compatibleCheck') });
    } else
      try {
        const models = await listModels(ctx.profile);
        checks.push({
          name: 'model',
          ok: !!ctx.profile.model.model && models.includes(ctx.profile.model.model),
          detail: ctx.profile.model.model || word('chooseModel'),
        });
      } catch {
        checks.push({ name: 'model', ok: false, detail: word('modelUnavailable') });
      }
  }
  if (connection) {
    try {
      await backendHealth(connection);
      checks.push({ name: 'backend', ok: true, detail: word('ready') });
    } catch {
      checks.push({ name: 'backend', ok: false, detail: word('backendUnavailable') });
    }
  }
  return checks;
}

async function hooks(ctx: EchoContext, host: HookHost): Promise<void> {
  const result = await prepareHooks(ctx, host, fileURLToPath(import.meta.url));
  await updateConfig(ctx.configPath, (config) => {
    if (config.profiles[ctx.profileId]!.hooks[host]) return;
    config.profiles[ctx.profileId]!.hooks[host] = true;
    return config;
  });
  print(result);
}

async function hook(): Promise<void> {
  // Only the trusted wait policy may extend a prompt callback. Legacy runners
  // keep their original short deadline until their hook definitions are refreshed.
  const started = Date.now();
  let expiresAt = started + 3500;
  let deadline = setTimeout(() => process.exit(0), 3500);
  deadline.unref();
  try {
    if (values.host !== 'claude' && values.host !== 'codex' && values.host !== 'vscode') return;
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 1_000_000) return;
    }
    const payload = JSON.parse(input) as {
      session_id?: unknown;
      hook_event_name?: unknown;
      prompt?: unknown;
      cwd?: unknown;
    };
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
      if (connected.configPath !== ctx.configPath || connected.profileId !== ctx.profileId)
        throw new Error(word('connectionChanged'));
    }
    await bindSession(ctx, values.host, payload.session_id, { workspace: root });
    if (payload.hook_event_name === 'SessionStart') {
      print(hookContext(ctx, fileURLToPath(import.meta.url), 'SessionStart'));
    } else if (
      payload.hook_event_name === 'UserPromptSubmit' &&
      typeof payload.prompt === 'string' &&
      payload.prompt.trim()
    ) {
      const policy = submindSettings(ctx.profile);
      if (policy.hookResearch !== 'manual') {
        if (policy.hookResearch === 'wait' && values['hook-timeout-ms'] !== undefined) {
          const capacity = Number(values['hook-timeout-ms']);
          if (!/^\d+$/.test(values['hook-timeout-ms']) || capacity < 1000 || capacity > 65000) return;
          expiresAt = started + Math.min(policy.hookWaitMs + 3500, capacity - 500);
          clearTimeout(deadline);
          deadline = setTimeout(() => process.exit(0), Math.max(1, expiresAt - Date.now()));
          deadline.unref();
        }
        const binding = {
          workspace: await realpath(root),
          host: values.host as HookHost,
          sessionId: payload.session_id,
        };
        if (!canFitHookResearch(ctx, binding)) {
          print({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: word('hookCuratorTooSmall') },
          });
          return;
        }
        let result = await memoryRequest(
          ctx,
          'prepare',
          { query: payload.prompt.slice(0, 2000), ...binding },
          { timeoutMs: 1800 },
        );
        const waitMs = Math.floor(Math.min(policy.hookWaitMs, expiresAt - Date.now() - 700));
        if (policy.hookResearch === 'wait' && result.status === 'pending' && result.requestId && waitMs > 0) {
          try {
            result = await memoryRequest(
              ctx,
              'brief',
              { ...binding, requestId: result.requestId, waitMs },
              { timeoutMs: waitMs + 400 },
            );
          } catch {
            /* Keep the accepted handle if the wait connection fails. */
          }
        }
        print(hookResearchContext(ctx, result));
        return;
      }
      const result = await memoryRequest(
        ctx,
        'recall',
        { query: payload.prompt.slice(0, 2000), limit: 5 },
        { timeoutMs: 1800 },
      );
      if (result.memories.length || result.truncated)
        print(hookContext(ctx, fileURLToPath(import.meta.url), 'UserPromptSubmit', result));
    }
  } catch {
    process.stderr.write(`${word('hookRefused')}\n`);
  } finally {
    clearTimeout(deadline);
  }
}

async function main(): Promise<void> {
  if (command === 'help') {
    print(word('help'));
    return;
  }
  if (command === 'hook') {
    await hook();
    return;
  }
  if (command === 'portal-demo') {
    if (
      positionals.length > 1 ||
      Object.keys(values).some((key) => key !== 'port') ||
      (values.port !== undefined && !/^\d+$/.test(values.port))
    )
      throw new Error(echoSubmindWord('input'));
    const demo = await startPortalDemo(values.port === undefined ? undefined : Number(values.port));
    process.once('SIGINT', () => {
      void demo.close();
    });
    process.once('SIGTERM', () => {
      void demo.close();
    });
    print({ url: demo.url, synthetic: true, mode: 'mock', modelCalls: 0 });
    return;
  }
  if (command === 'submind-demo') {
    if (positionals.length > 1 || Object.keys(values).some((key) => key !== 'query'))
      throw new Error(echoSubmindWord('input'));
    print(await submindDemo(values.query));
    return;
  }
  if (positionals.length > 1) throw new Error(word('unknownCommand'));
  if (
    values['hook-timeout-ms'] !== undefined ||
    (values['wait-ms'] !== undefined && command !== 'brief') ||
    ((values['hook-research'] !== undefined || values['hook-wait-ms'] !== undefined) && command !== 'configure')
  )
    throw new Error(echoSubmindWord('input'));
  if (command === 'trust') {
    if (!values.confirm) throw new Error(word('trustConfirm'));
    const selection = target();
    await trustConfig(selection.configPath);
    print({ configPath: selection.configPath, trusted: true });
    return;
  }
  if (command === 'disconnect') {
    const root = resolveInstallation({ cwd: workspace(), scope: 'workspace' }).workspaceRoot!;
    // Validate the pointer before removing any owned host configuration.
    readConnection(root);
    const result = await disconnectWorkspaceHooks(root);
    await removeConnection(root);
    print({ ...result, workspace: root, disconnected: true });
    return;
  }
  if (command === 'init' || command === 'setup') {
    await setup();
    return;
  }
  if (values.port !== undefined || values['backend-port'] !== undefined) throw new Error(word('setupOptions'));
  const installation = target();
  const ctx = loadContext(installation.configPath, installation.profileId);
  if (command === 'configure') {
    if (
      Object.keys(values).some(
        (key) => !['config', 'scope', 'profile', 'hook-research', 'hook-wait-ms'].includes(key),
      ) ||
      (values['hook-research'] === undefined && values['hook-wait-ms'] === undefined)
    )
      throw new Error(word('configureRequired'));
    await updateConfig(ctx.configPath, (current) => {
      const profile = current.profiles[ctx.profileId];
      if (!profile) throw new Error(word('profileRequired'));
      const policy = {
        ...submindSettings(profile),
        ...(values['hook-research'] === undefined ? {} : { hookResearch: values['hook-research'] }),
        ...(values['hook-wait-ms'] === undefined ? {} : { hookWaitMs: Number(values['hook-wait-ms']) }),
      };
      profile.submind = submindSettings({ submind: policy as EchoContext['profile']['submind'] });
      return current;
    });
    const saved = loadContext(ctx.configPath, ctx.profileId);
    print({
      configPath: saved.configPath,
      profile: saved.profileId,
      submind: submindSettings(saved.profile),
      next: word('configureSaved'),
    });
    return;
  }
  if (command === 'models' || command === 'model-test') {
    if (Object.keys(values).some((key) => !['config', 'scope', 'profile'].includes(key)))
      throw new Error(echoSubmindWord('input'));
    const controller = new AbortController();
    const interrupted = () => {
      process.exitCode = 130;
      controller.abort();
    };
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ctx.profile.budget.timeoutMs)]);
    try {
      print(await (command === 'models' ? discoverSetupModels : testSetupModel)(ctx.profileId, ctx.profile, signal));
    } finally {
      process.off('SIGINT', interrupted);
      process.off('SIGTERM', interrupted);
    }
    return;
  }
  if (command === 'connect') {
    const host = values.host ?? 'all';
    if (host !== 'claude' && host !== 'codex' && host !== 'vscode' && host !== 'all')
      throw new Error(word('hostRequired'));
    await connectWorkspace(ctx, host, workspace());
    return;
  }
  if (command === 'install-runtime') {
    print(await installRuntime(ctx));
    return;
  }
  if (command === 'doctor') {
    let connection: BackendConnection | undefined;
    let failure: CheckResult | undefined;
    if (ctx.profile.backend.mode === 'external') {
      try {
        connection = await startBackend(ctx);
      } catch {
        failure = { name: 'backend', ok: false, detail: word('backendUnavailable') };
      }
    }
    const result = [...(await checks(ctx, connection)), ...(failure ? [failure] : [])];
    await connection?.close();
    print(result);
    if (result.some((c) => !c.ok)) process.exitCode = 1;
    return;
  }
  if (command === 'smoke') {
    const interrupted = () => {
      void closeOwnedBackends().finally(() => process.exit(130));
    };
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    try {
      print(await smoke(ctx, !!values['with-model']));
    } finally {
      process.off('SIGINT', interrupted);
      process.off('SIGTERM', interrupted);
    }
    return;
  }
  if (command === 'hooks') {
    if (values.host !== 'claude' && values.host !== 'codex' && values.host !== 'vscode' && values.host !== 'all')
      throw new Error(word('hostRequired'));
    if (values.install) {
      if (!values.workspace) throw new Error(word('workspaceRequired'));
      await connectWorkspace(ctx, values.host, workspace());
      return;
    }
    if (values.host === 'all') {
      for (const host of ['claude', 'codex', 'vscode'] as const) await hooks(ctx, host);
      return;
    }
    await hooks(ctx, values.host);
    return;
  }
  if (command === 'remember') {
    if (!values.content?.trim()) throw new Error(word('contentRequired'));
    print(await memoryRequest(ctx, 'remember', { content: values.content, topics: values.topic }));
    return;
  }
  if (command === 'ask') {
    if (!values.query?.trim()) throw new Error(word('queryRequired'));
    print(await memoryRequest(ctx, 'ask', { query: values.query }));
    return;
  }
  if (command === 'brief' || command === 'cancel-brief') {
    if (
      !values.request ||
      !values.workspace ||
      !values['session-id'] ||
      !['claude', 'codex', 'vscode'].includes(values.host ?? '')
    )
      throw new Error(word('briefRequired'));
    const input = {
      requestId: values.request,
      workspace: workspace(),
      host: values.host as HookHost,
      sessionId: values['session-id'],
    };
    print(
      command === 'brief'
        ? await memoryRequest(ctx, 'brief', {
            ...input,
            ...(values['wait-ms'] === undefined ? {} : { waitMs: Number(values['wait-ms']) }),
          })
        : await memoryRequest(ctx, 'cancel-brief', input),
    );
    return;
  }
  if (command === 'expand') {
    if (!values.id || !values.revision) throw new Error(echoSubmindWord('reference'));
    print(await memoryRequest(ctx, 'expand', { id: values.id, revision: values.revision }));
    return;
  }
  if (command === 'recall') {
    if (!values.query?.trim()) throw new Error(word('queryRequired'));
    print(
      await memoryRequest(ctx, 'recall', {
        query: values.query,
        ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      }),
    );
    return;
  }
  if (command !== 'serve') throw new Error(word('unknownCommand'));
  let backend: BackendConnection | undefined;
  let memory: { close(): Promise<void> } | undefined;
  let startup: string | undefined;
  let portal: ReturnType<typeof createMemoryPortal> | undefined;
  // Settings remain reachable even if a backend or model needs configuration.
  const web = await startWeb(ctx, {
    installation: describeInstallation(ctx.configPath),
    portal: {
      browse: (input, signal) => {
        if (!portal) throw new PortalFailure('unavailable');
        return portal.browse(input, signal);
      },
      ask: (input, signal) => memoryRequest(ctx, 'ask', input, { signal }),
      expand: (input, signal) => memoryRequest(ctx, 'expand', input, { signal }),
    },
    checks: async () => [
      ...(await checks(ctx, backend)),
      ...(startup ? [{ name: 'backend', ok: false, detail: startup }] : []),
    ],
  });
  print({ url: web.url, profile: ctx.profileId, scope: ctx.profile.identity, phase: 'setup' });
  let stopping = false;
  let starting: Promise<void>;
  const close = async () => {
    if (stopping) return;
    stopping = true;
    await memory?.close();
    await closeOwnedBackends();
    await starting;
    await memory?.close();
    await web.close();
    await backend?.close();
  };
  process.once('SIGINT', () => {
    void close();
  });
  process.once('SIGTERM', () => {
    void close();
  });
  starting = startBackend(ctx)
    .then(async (result) => {
      try {
        if (!stopping) memory = await startMemoryBridge(ctx, result);
        backend = result;
        if (!stopping) portal = createMemoryPortal(ctx, result);
      } catch (error) {
        await result.close();
        throw error;
      }
    })
    .catch(async (error) => {
      startup = error instanceof Error ? error.message : word('backendUnavailable');
      await backend?.close();
      backend = undefined;
      print({ backend: startup });
    });
  await starting;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof ModelSetupFailure ? modelSetupMessage(error) : error instanceof Error ? error.message : word('failed')}\n`,
  );
  if (process.exitCode !== 130) process.exitCode = 1;
});
