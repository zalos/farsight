import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext, saveConfig } from '../dist/config.js';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
test('unattended init saves the chosen model only in its selected profile and preserves existing settings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'echo-cli-'));
  const config = join(directory, 'settings.json');
  try {
    const args = [entry, 'init', '--config', config, '--profile', 'work', '--model', 'synthetic-local-model'];
    await run(process.execPath, args);
    const before = readFileSync(config, 'utf8');
    const value = JSON.parse(before);
    assert.equal(value.profiles.work.model.model, 'synthetic-local-model');
    assert.equal(value.profiles.personal.model.model, '');
    assert.equal(value.profiles.work.hooks.claude, false);
    assert.equal(value.profiles.work.hooks.codex, false);
    await assert.rejects(run(process.execPath, args));
    assert.equal(readFileSync(config, 'utf8'), before);
    const ctx = loadContext(config);
    ctx.config.profiles.personal!.backend = { mode: 'external', url: 'http://127.0.0.1:19998' };
    await saveConfig(config, ctx.config);
    await assert.rejects(run(process.execPath, [entry, 'doctor', '--config', config]), (error: any) => {
      const checks = JSON.parse(error.stdout);
      return checks.some((check: any) => check.name === 'backend' && !check.ok);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('global setup connects two workspaces without local packages and can switch one back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-shared-cli-'));
  const { mkdirSync, existsSync, writeFileSync } = await import('node:fs');
  const xdg = join(root, 'xdg');
  const env = { ...process.env, XDG_CONFIG_HOME: xdg };
  const a = join(root, 'workspace-a'), b = join(root, 'workspace-b');
  for (const workspace of [a, b]) {
    mkdirSync(workspace, { recursive: true });
    await run('git', ['init', '--quiet', workspace]);
    mkdirSync(join(workspace, '.vscode'));
    writeFileSync(join(workspace, '.vscode', 'settings.json'), '{"chat.useClaudeHooks":false}');
  }
  const cli = (cwd: string, args: string[]) => run(process.execPath, [entry, ...args], { cwd, env });
  try {
    const initial = JSON.parse((await cli(a, ['init', '--scope', 'global', '--model', 'shared-model', '--port', '4496', '--backend-port', '5411'])).stdout);
    const globalPath = join(xdg, 'farsight-echo', 'settings.json');
    assert.equal(initial.installation.scope, 'global');
    assert.equal(initial.configPath, loadContext(globalPath).configPath);
    const global = loadContext(globalPath);
    assert.equal(global.profile.identity.project, 'shared');
    assert.equal(global.profile.web.port, 4496);
    assert.equal(global.profile.backend.url, 'http://127.0.0.1:5411');
    await cli(a, ['init', '--scope', 'workspace', '--model', 'local-model']);
    const originalLocal = readFileSync(join(a, '.echo', 'settings.json'), 'utf8');
    for (const workspace of [a, b]) {
      await cli(workspace, ['connect', '--scope', 'global']);
      const connection = JSON.parse(readFileSync(join(workspace, '.echo', 'connection.json'), 'utf8'));
      assert.equal(connection.configPath, global.configPath);
      assert.equal(connection.profileId, 'personal');
      assert.equal(existsSync(join(workspace, 'node_modules')), false);
      assert.equal(existsSync(join(workspace, '.echo', 'profiles')), false);
    }
    assert.equal(readFileSync(join(a, '.echo', 'settings.json'), 'utf8'), originalLocal);
    assert.equal(existsSync(join(b, '.echo', 'settings.json')), false);
    mkdirSync(join(b, 'src'));
    const reconnect = JSON.parse((await cli(join(b, 'src'), ['connect', '--workspace', b])).stdout);
    assert.equal(reconnect.installation.scope, 'global');
    assert.equal(reconnect.connection.changed, false);
    const relative = JSON.parse((await cli(root, ['connect', '--config', 'xdg/farsight-echo/settings.json', '--workspace', b])).stdout);
    assert.equal(relative.installation.configPath, global.configPath, 'relative configuration is resolved from the caller, not the destination workspace');
    const originalHook = readFileSync(join(a, '.codex', 'hooks.json'), 'utf8');
    writeFileSync(join(a, '.echo', 'backups'), 'not a directory');
    await assert.rejects(cli(a, ['connect', '--scope', 'workspace']));
    assert.equal(readFileSync(join(a, '.codex', 'hooks.json'), 'utf8'), originalHook, 'invalid binding backup destination must fail before changing hooks');
    rmSync(join(a, '.echo', 'backups'));
    await cli(a, ['connect', '--scope', 'workspace', '--host', 'claude']);
    const localBinding = JSON.parse(readFileSync(join(a, '.echo', 'connection.json'), 'utf8'));
    assert.equal(localBinding.configPath, loadContext(join(a, '.echo', 'settings.json')).configPath);
    for (const [host, file] of [['claude', '.claude/settings.local.json'], ['codex', '.codex/hooks.json'], ['vscode', '.github/hooks/echo.json']]) {
      const hooks = JSON.parse(readFileSync(join(a, file!), 'utf8')).hooks;
      const command = host === 'vscode' ? hooks.SessionStart[0].command : hooks.SessionStart[0].hooks[0].command;
      assert.ok(command.includes(localBinding.configPath));
      assert.ok(!command.includes(global.configPath));
    }
    assert.equal(JSON.parse(readFileSync(join(b, '.echo', 'connection.json'), 'utf8')).configPath, global.configPath);
    await assert.rejects(cli(b, ['init', '--scope', 'global', '--config', 'conflict.json']));
    await assert.rejects(cli(b, ['setup', '--scope', 'workspace']));
    assert.equal(existsSync(join(b, '.echo', 'settings.json')), false, 'unattended setup never writes before refusing');
    const disconnected = JSON.parse((await cli(b, ['disconnect'])).stdout);
    assert.equal(disconnected.disconnected, true);
    assert.equal(existsSync(join(b, '.echo', 'connection.json')), false);
    assert.equal(existsSync(join(b, '.codex', 'hooks.json')), false);
    assert.equal(existsSync(globalPath), true, 'disconnect preserves shared configuration and memory');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prepared hooks share the workspace session boundary and reject stale pinned selections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-hook-boundary-'));
  const { mkdirSync } = await import('node:fs');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
    await run('git', ['init', '--quiet', workspace]);
  const localPath = join(workspace, '.echo', 'settings.json');
  const globalPath = join(root, 'global', 'settings.json');
  const { initConfig } = await import('../dist/config.js');
  const { writeConnection } = await import('../dist/installation.js');
  try {
    for (const path of [localPath, globalPath]) {
      await initConfig(path);
      const ctx = loadContext(path);
      ctx.config.profiles.personal!.hooks.claude = true;
      await saveConfig(path, ctx.config);
    }
    const invoke = async (path: string, id: string) => {
      const pending = run(process.execPath, [entry, 'hook', '--config', path, '--host', 'claude'], { cwd: root });
      pending.child.stdin!.end(JSON.stringify({ session_id: id, cwd: workspace, hook_event_name: 'SessionStart' }));
      return pending;
    };
    assert.ok((await invoke(localPath, 'prepared-same-session')).stdout.includes('additionalContext'));
    const blocked = await invoke(globalPath, 'prepared-same-session');
    assert.equal(blocked.stdout, ''); assert.match(blocked.stderr, /skipped this hook/);
    assert.ok((await invoke(globalPath, 'prepared-fresh-session')).stdout.includes('additionalContext'));
    const global = loadContext(globalPath);
    await writeConnection(workspace, { configPath: global.configPath, profileId: global.profileId });
    const stale = await invoke(localPath, 'fresh-but-stale-pinned-hook');
    assert.equal(stale.stdout, ''); assert.match(stale.stderr, /skipped this hook/);
    assert.ok((await invoke(globalPath, 'connected-fresh-session')).stdout.includes('additionalContext'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed hooks require a completed workspace connection without disabling prepared plugins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-hook-incomplete-'));
  const { mkdirSync, existsSync } = await import('node:fs');
  const { initConfig } = await import('../dist/config.js');
  const { writeConnection } = await import('../dist/installation.js');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
    await run('git', ['init', '--quiet', workspace]);
  const globalPath = join(root, 'global', 'settings.json');
  try {
    await initConfig(join(workspace, '.echo', 'settings.json'));
    await initConfig(globalPath);
    const ctx = loadContext(globalPath);
    ctx.config.profiles.personal!.hooks.claude = true;
    await saveConfig(globalPath, ctx.config);
    const invoke = async (installed: boolean, id: string) => {
      const args = [entry, 'hook', '--config', globalPath, '--host', 'claude', ...(installed ? ['--workspace', workspace] : [])];
      const pending = run(process.execPath, args, { cwd: root });
      pending.child.stdin!.end(JSON.stringify({ session_id: id, cwd: workspace, hook_event_name: 'SessionStart' }));
      return pending;
    };
    const incomplete = await invoke(true, 'incomplete-connection');
    assert.equal(incomplete.stdout, '');
    assert.match(incomplete.stderr, /skipped this hook/);
    assert.equal(existsSync(join(workspace, '.echo', 'sessions')), false, 'refused installation must not bind the session');
    assert.ok((await invoke(false, 'prepared-without-connection')).stdout.includes('additionalContext'));
    await writeConnection(workspace, { configPath: ctx.configPath, profileId: ctx.profileId });
    assert.ok((await invoke(true, 'incomplete-connection')).stdout.includes('additionalContext'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('existing settings need explicit trust and edited bytes invalidate approval', async () => {
  const { writeFileSync } = await import('node:fs');
  const { defaultConfig } = await import('../dist/config.js');
  const root = mkdtempSync(join(tmpdir(), 'echo-cli-trust-'));
  const path = join(root, 'settings.json');
  const cli = (args: string[]) => run(process.execPath, [entry, ...args, '--config', path]);
  try {
    writeFileSync(path, JSON.stringify(defaultConfig()));
    await assert.rejects(cli(['trust']));
    assert.throws(() => loadContext(path));
    assert.equal(JSON.parse((await cli(['trust', '--confirm'])).stdout).trusted, true);
    assert.equal(loadContext(path).profileId, 'personal');
    writeFileSync(path, readFileSync(path, 'utf8') + '\n');
    assert.throws(() => loadContext(path));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('model setup CLI uses saved selection without memory startup, changing settings or automatic generation', async () => {
  const { createServer } = await import('node:http');
  const { defaultConfig } = await import('../dist/config.js');
  const directory = mkdtempSync(join(tmpdir(), 'echo-cli-model-'));
  const calls: { url?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, body: body ? JSON.parse(body) : undefined });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ name: 'fixture-model' }] }));
    else if (req.url === '/api/chat') res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 9, message: { content: JSON.stringify({ status: 'ready', evidenceId: 'echo-model-test' }) } }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const configPath = join(directory, 'settings.json');
    const config = defaultConfig();
    config.profiles.work!.model = { provider: 'ollama', baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: 'fixture-model' };
    await saveConfig(configPath, config);
    const original = readFileSync(configPath, 'utf8');
    const invoke = async (command: string, extra: string[] = []) => JSON.parse((await run(process.execPath, [entry, command, '--config', configPath, '--profile', 'work', ...extra])).stdout);
    const discovery = await invoke('models');
    assert.deepEqual(discovery.models, ['fixture-model']);
    assert.deepEqual(calls.map(row => row.url), ['/api/tags']);
    const tested = await invoke('model-test');
    assert.equal(tested.status, 'ready'); assert.equal(tested.profileId, 'work');
    assert.deepEqual(tested.usage, { modelCalls: 1, inputTokens: 10, outputTokens: 9 });
    assert.deepEqual(calls.map(row => row.url), ['/api/tags', '/api/chat']);
    assert.equal(calls[1]!.body.model, 'fixture-model');
    assert.equal(calls[1]!.body.keep_alive, 0);
    assert.equal(calls[1]!.body.options.num_ctx, 4096);
    await assert.rejects(invoke('model-test', ['--query', 'Do not send arbitrary text']));
    assert.equal(calls.length, 2);
    assert.equal(readFileSync(configPath, 'utf8'), original);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('interrupting model-test cancels the request and preserves the interrupted exit status', { timeout: 15000 }, async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { defaultConfig } = await import('../dist/config.js');
  const directory = mkdtempSync(join(tmpdir(), 'echo-cli-interrupt-'));
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  const server = createServer((req, _res) => { req.resume(); started(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const configPath = join(directory, 'settings.json');
    const config = defaultConfig();
    config.profiles.personal!.model = { provider: 'ollama', baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: 'fixture-model' };
    await saveConfig(configPath, config);
    child = spawn(process.execPath, [entry, 'model-test', '--config', configPath], { stdio: 'ignore' });
    const exited = once(child, 'exit');
    await Promise.race([received, exited.then(() => { throw new Error('The CLI exited before sending its model request'); })]);
    child.kill('SIGINT');
    const [code, signal] = await exited;
    assert.equal(code, 130); assert.equal(signal, null);
  } finally {
    child?.kill('SIGTERM'); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});


test('configure changes only the selected prompt policy and rejects invalid updates atomically', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'echo-configure-'));
  const configPath = join(directory, 'settings.json');
  const cli = (...args: string[]) => run(process.execPath, [entry, ...args, '--config', configPath]);
  try {
    await cli('init');
    const before = loadContext(configPath).config;
    const result = JSON.parse((await cli('configure', '--profile', 'work', '--hook-research', 'wait', '--hook-wait-ms', '45000')).stdout);
    const after = loadContext(configPath).config;
    assert.deepEqual(after.profiles.personal, before.profiles.personal);
    assert.equal(after.profiles.work!.submind!.hookResearch, 'wait');
    assert.equal(after.profiles.work!.submind!.hookWaitMs, 45000);
    assert.equal(after.profiles.work!.submind!.mode, 'off');
    assert.match(result.next, /Restart Echo/);
    const saved = readFileSync(configPath, 'utf8');
    for (const args of [[], ['--hook-research', 'invalid'], ['--hook-wait-ms', '60001'], ['--hook-wait-ms', 'NaN'], ['--hook-research', 'wait', '--model', 'unexpected']]) {
      await assert.rejects(cli('configure', ...args));
      assert.equal(readFileSync(configPath, 'utf8'), saved);
    }
    await cli('configure', '--profile', 'work', '--hook-research', 'background');
    assert.equal(loadContext(configPath, 'work').profile.submind!.hookWaitMs, 45000);
    await assert.rejects(cli('cancel-brief', '--wait-ms', '1000'));
    await assert.rejects(cli('doctor', '--hook-research', 'background'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
