import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ECHO_HOOK_STRINGS } from '@farsight/core/dist/strings-echo-hooks.js';
import { HOOK_EVENTS, shellQuote, type HookHost } from './hooks.js';
import type { EchoContext } from './types.js';

type ObjectValue = Record<string, unknown>;
interface Plan { path: string; before?: string; after: string }
const HOSTS: readonly HookHost[] = ['claude', 'codex', 'vscode'];
const paths: Record<HookHost, string[]> = {
  claude: ['.claude', 'settings.local.json'], codex: ['.codex', 'hooks.json'], vscode: ['.github', 'hooks', 'echo.json'],
};
function words(key: string): string { return ECHO_HOOK_STRINGS[key]!.professional; }
function fail(key = 'echo.hooks.workspaceMalformed'): never { throw new Error(words(key)); }
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as ObjectValue;
}
function marker(host: HookHost): string { return ` # farsight-echo-workspace-v1:${host}`; }
function owned(value: unknown, host: HookHost): boolean {
  const hook = object(value);
  return hook.type === 'command' && typeof hook.command === 'string' && hook.command.endsWith(marker(host));
}
function command(ctx: EchoContext, host: HookHost, executable: string, workspace: string): ObjectValue {
  const args = [process.execPath, executable, 'hook', '--config', ctx.configPath, '--profile', ctx.profileId, '--host', host, '--workspace', workspace];
  return { type: 'command', command: args.map(shellQuote).join(' ') + marker(host), timeout: 5 };
}

function parseObject(text: string): ObjectValue {
  let result: ObjectValue;
  try { result = object(JSON.parse(text)); } catch { fail(); }
  // Native JSON parsing silently keeps the last duplicate key. Do not discard
  // an earlier hook/settings value when such a file is rewritten.
  const containers: ({ keys: Set<string>; expectingKey: boolean } | null)[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '{') containers.push({ keys: new Set(), expectingKey: true });
    else if (char === '[') containers.push(null);
    else if (char === '}' || char === ']') containers.pop();
    else if (char === ',') { const current = containers.at(-1); if (current) current.expectingKey = true; }
    else if (char === '"') {
      const start = index;
      for (index++; index < text.length; index++) {
        if (text[index] === '\\') index++;
        else if (text[index] === '"') break;
      }
      const current = containers.at(-1);
      if (current?.expectingKey) {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (current.keys.has(key)) fail();
        current.keys.add(key); current.expectingKey = false;
      }
    }
  }
  return result;
}

/** Read editor JSONC without changing its comments or formatting. Hook files remain strict JSON. */
function editorSettings(text: string): ObjectValue {
  let cleaned = '', index = 0, quoted = false;
  while (index < text.length) {
    const char = text[index]!, next = text[index + 1];
    if (quoted) {
      cleaned += char; index++;
      if (char === '\\') { cleaned += text[index] ?? ''; index++; }
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; cleaned += char; index++; }
    else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) fail();
      cleaned += ' '; index = end + 2;
    } else { cleaned += char; index++; }
  }
  // Strip only commas outside strings when the next token closes a container.
  let result = ''; quoted = false;
  for (let cursor = 0; cursor < cleaned.length; cursor++) {
    const char = cleaned[cursor]!;
    if (quoted) {
      result += char;
      if (char === '\\') result += cleaned[++cursor] ?? '';
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; result += char; }
    else if (char !== ',' || !/^\s*[}\]]/.test(cleaned.slice(cursor + 1))) result += char;
  }
  return parseObject(result.replace(/^\uFEFF/, ''));
}

async function contents(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) fail();
  return readFile(path, 'utf8');
}

async function defaultEditorSettingsPaths(): Promise<string[]> {
  const user = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Code', 'User')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Code', 'User');
  const profiles = await readdir(join(user, 'profiles'), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  return [join(user, 'settings.json'), ...profiles.filter(value => value.isDirectory()).map(value => join(user, 'profiles', value.name, 'settings.json'))];
}

async function preventDuplicateHooks(workspace: string, hosts: readonly HookHost[], userPaths?: string[]): Promise<void> {
  // Existing installs matter when the other host is requested in a later invocation.
  const claude = await contents(join(workspace, ...paths.claude));
  const vscode = await contents(join(workspace, ...paths.vscode));
  const hasClaude = hosts.includes('claude') || !!claude?.includes(marker('claude'));
  const hasVscode = hosts.includes('vscode') || !!vscode?.includes(marker('vscode'));
  if (!hasClaude || !hasVscode) return;
  const local = await contents(join(workspace, '.vscode', 'settings.json'));
  const localValue = local === undefined ? undefined : editorSettings(local)['chat.useClaudeHooks'];
  if (localValue !== undefined && typeof localValue !== 'boolean') fail();
  if (localValue === false) return;
  if (localValue === true) fail('echo.hooks.vscodeDuplicate');
  for (const path of userPaths ?? await defaultEditorSettingsPaths()) {
    const raw = await contents(path);
    if (raw !== undefined && editorSettings(raw)['chat.useClaudeHooks'] === true) fail('echo.hooks.vscodeDuplicate');
  }
}

function merge(before: string | undefined, host: HookHost, next: ObjectValue): string {
  let document: ObjectValue;
  document = before === undefined ? {} : parseObject(before);
  const hooks = document.hooks === undefined ? {} : object(document.hooks);
  document.hooks = hooks;
  // Preserve unknown events as-is. Validate known events before mutating any file.
  for (const event of HOOK_EVENTS) {
    const existing = hooks[event] === undefined ? [] : hooks[event];
    if (!Array.isArray(existing)) fail();
    const kept: unknown[] = [];
    for (const value of existing) {
      if (host === 'vscode') {
        if (!owned(value, host)) kept.push(value);
      } else {
        const group = object(value);
        if (!Array.isArray(group.hooks)) fail();
        const remaining = group.hooks.filter(hook => !owned(hook, host));
        if (remaining.length || !group.hooks.length) kept.push({ ...group, hooks: remaining });
      }
    }
    kept.push(host === 'vscode' ? next : { hooks: [next] });
    hooks[event] = kept;
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function ensureLocalPath(workspace: string, destination: string): Promise<void> {
  const parts = relative(workspace, destination).split(sep);
  let current = workspace;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (info?.isSymbolicLink() || info && current !== destination && !info.isDirectory()) fail('echo.hooks.workspaceInvalid');
  }
}

/** Explicit, local workspace installation. Never edits host-global settings or grants host trust. */
export async function installWorkspaceHooks(
  ctx: EchoContext, host: HookHost | 'all', executable: string, workspaceRoot: string,
  options: { vscodeUserSettingsPaths?: string[] } = {},
): Promise<{ changedPaths: string[]; hosts: HookHost[]; instructions: string }> {
  if (process.platform === 'win32') fail('echo.hooks.platform');
  if (host !== 'all' && !HOSTS.includes(host)) fail('echo.hooks.invalidHost');
  if (![ctx.configPath, ctx.directory, executable, workspaceRoot].every(isAbsolute)) fail('echo.hooks.absolutePaths');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(ctx.profileId)) fail('echo.hooks.invalidProfile');
  const workspace = resolve(workspaceRoot);
  if (!(await lstat(workspace).catch(() => undefined))?.isDirectory() || !(await lstat(executable).catch(() => undefined))?.isFile()) fail('echo.hooks.workspaceInvalid');
  // A workspace has one Echo connection. Retarget any previously installed Echo
  // host as well, so a partial host selection cannot silently split its memories.
  const requested = host === 'all' ? HOSTS : [host];
  const installed: HookHost[] = [];
  for (const selected of HOSTS) {
    const path = join(workspace, ...paths[selected]);
    await ensureLocalPath(workspace, path);
    const raw = await contents(path);
    if (raw === undefined) continue;
    const document = parseObject(raw);
    if (document.hooks === undefined) continue;
    const events = object(document.hooks);
    for (const event of HOOK_EVENTS) {
      const definitions = events[event];
      if (definitions === undefined) continue;
      if (!Array.isArray(definitions)) fail();
      const commands = selected === 'vscode' ? definitions : definitions.flatMap(value => {
        const group = object(value);
        if (!Array.isArray(group.hooks)) fail();
        return group.hooks;
      });
      if (commands.some(value => owned(value, selected))) { installed.push(selected); break; }
    }
  }
  const hosts = HOSTS.filter(selected => requested.includes(selected) || installed.includes(selected));
  await preventDuplicateHooks(workspace, hosts, options.vscodeUserSettingsPaths);
  const plan: Plan[] = [];
  for (const selected of hosts) {
    const path = join(workspace, ...paths[selected]);
    await ensureLocalPath(workspace, path);
    const before = await contents(path);
    const after = merge(before, selected, command(ctx, selected, executable, workspace));
    if (before !== after) plan.push({ path, before, after });
  }
  const backups = join(ctx.directory, 'backups', `hooks-${Date.now()}-${randomUUID()}`);
  for (const item of plan) {
    if (await contents(item.path) !== item.before) fail('echo.hooks.workspaceChanged');
  }
  try {
    if (plan.some(item => item.before !== undefined)) {
      await mkdir(backups, { recursive: true, mode: 0o700 });
      await chmod(backups, 0o700);
      for (const item of plan) {
        if (item.before === undefined) continue;
        const backup = join(backups, relative(workspace, item.path));
        await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
        await writeFile(backup, item.before, { mode: 0o600, flag: 'wx' });
      }
    }
    for (const item of plan) {
      await mkdir(dirname(item.path), { recursive: true, mode: 0o700 });
      await ensureLocalPath(workspace, item.path);
      if (await contents(item.path) !== item.before) fail('echo.hooks.workspaceChanged');
      const temporary = join(dirname(item.path), `.echo-hooks-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(item.after); await file.sync(); } finally { await file.close(); }
        await rename(temporary, item.path);
      } finally { await unlink(temporary).catch(() => {}); }
    }
  } catch (error) {
    if (error instanceof Error && error.message === words('echo.hooks.workspaceChanged')) throw error;
    fail('echo.hooks.workspaceWrite');
  }
  return {
    changedPaths: plan.map(item => item.path),
    hosts,
    instructions: [words('echo.hooks.installed'), ...hosts.map(selected => words(`echo.hooks.installed${selected === 'vscode' ? 'Vscode' : selected === 'claude' ? 'Claude' : 'Codex'}`)), words('echo.hooks.singleProfile'), words('echo.hooks.keepPaths')].join('\n\n'),
  };
}
