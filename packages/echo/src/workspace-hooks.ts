import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ECHO_HOOK_STRINGS } from '@farsight/core/dist/strings-echo-hooks.js';
import { HOOK_EVENTS, HOOK_TIMEOUT_MS, shellQuote, type HookHost } from './hooks.js';
import { withSettingsLock } from './settings-lock.js';
import type { EchoContext } from './types.js';

type ObjectValue = Record<string, unknown>;
interface Plan { host: HookHost; path: string; before?: string; after?: string }
const HOSTS: readonly HookHost[] = ['claude', 'codex', 'vscode'];
// Old releases installed the last three events. Upgrade/removal must clean them too.
const MANAGED_EVENTS = [...HOOK_EVENTS, 'PostToolUse', 'PreCompact', 'Stop'];
interface RestoreEntry { original: string | null; installedHash: string }
interface Journal { version: 1; workspace: string; files: Partial<Record<HookHost, RestoreEntry>> }
interface HookOptions { vscodeUserSettingsPaths?: string[]; stateDirectory?: string }
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
  const args = [process.execPath, executable, 'hook', '--config', ctx.configPath, '--profile', ctx.profileId, '--host', host, '--workspace', workspace, '--hook-timeout-ms', String(HOOK_TIMEOUT_MS)];
  return { type: 'command', command: args.map(shellQuote).join(' ') + marker(host), timeout: HOOK_TIMEOUT_MS / 1000 };
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
  const raw = await readFile(path);
  // Invalid UTF-8 cannot be restored byte for byte after a JSON edit.
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) fail();
  return text;
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

function merge(before: string | undefined, host: HookHost, next?: ObjectValue): string | undefined {
  let document: ObjectValue;
  document = before === undefined ? {} : parseObject(before);
  const hooks = document.hooks === undefined ? {} : object(document.hooks);
  if (document.hooks === undefined && !next) return before;
  document.hooks = hooks;
  // Preserve unknown events as-is. Validate known events before mutating any file.
  for (const event of MANAGED_EVENTS) {
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
    if (next && (HOOK_EVENTS as readonly string[]).includes(event)) kept.push(host === 'vscode' ? next : { hooks: [next] });
    if (kept.length || Array.isArray(hooks[event]) && !existing.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete document.hooks;
  if (!Object.keys(document).length) return undefined;
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

function hasOwned(before: string, host: HookHost): boolean {
  const document = parseObject(before);
  if (document.hooks === undefined) return false;
  const events = object(document.hooks);
  let found = false;
  for (const event of MANAGED_EVENTS) {
    const definitions = events[event];
    if (definitions === undefined) continue;
    if (!Array.isArray(definitions)) fail();
    const commands = host === 'vscode' ? definitions : definitions.flatMap(value => {
      const group = object(value);
      if (!Array.isArray(group.hooks)) fail();
      return group.hooks;
    });
    if (commands.some(value => owned(value, host))) found = true;
  }
  return found;
}

function git(workspace: string, args: string[]) {
  return spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
}

/** Local excludes never change a team's ignore rules; tracked files are never rewritten. */
async function ignoreLocalFiles(workspace: string, destinations: string[]): Promise<void> {
  const top = git(workspace, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    // A non-Git scratch folder is supported. A broken repository is not ignored.
    let current = workspace;
    while (true) {
      if (await lstat(join(current, '.git')).catch(() => undefined)) fail('echo.hooks.workspaceIgnore');
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
  const root = top.stdout.trim();
  const missing: string[] = [];
  for (const destination of destinations) {
    const path = relative(root, destination).split(sep).join('/');
    if (path.startsWith('../') || /[\r\n]/.test(path)) fail('echo.hooks.workspaceIgnore');
    const tracked = git(root, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path]);
    if (tracked.status === 0) fail('echo.hooks.workspaceTracked');
    if (tracked.status !== 1) fail('echo.hooks.workspaceIgnore');
    const ignored = git(root, ['check-ignore', '--quiet', '--', path]);
    if (ignored.status === 1) missing.push(path);
    else if (ignored.status !== 0) fail('echo.hooks.workspaceIgnore');
  }
  const echoDirectory = relative(root, join(workspace, '.echo')).split(sep).join('/');
  const stateIgnored = git(root, ['check-ignore', '--quiet', '--', `${echoDirectory}/echo-private-state`]);
  if (stateIgnored.status !== 0 && stateIgnored.status !== 1) fail('echo.hooks.workspaceIgnore');
  if (!missing.length && stateIgnored.status === 0) return;
  const excluded = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (excluded.status !== 0) fail('echo.hooks.workspaceIgnore');
  const path = resolve(root, excluded.stdout.trim());
  // The repository's local exclude is shared by linked worktrees. Append owned
  // paths/state rules and preserve all existing bytes, including concurrent appends.
  await ensureLocalPath(dirname(dirname(path)), path);
  const before = await contents(path);
  await mkdir(dirname(path), { recursive: true });
  const escape = (value: string) => value.replace(/[\\*?\[\]#! ]/g, '\\$&');
  const patterns = missing.filter(value => !value.startsWith(`${echoDirectory}/`)).map(value => `/${escape(value)}`);
  if (stateIgnored.status === 1) patterns.push(`/${escape(echoDirectory)}/*`, `!/${escape(echoDirectory)}/settings.example.json`, `!/${escape(echoDirectory)}/connection.example.json`);
  const handle = await open(path, 'a', 0o600);
  try { await handle.writeFile(`${before && !before.endsWith('\n') ? '\n' : ''}# Echo local configuration and hooks\n${patterns.join('\n')}\n`); }
  finally { await handle.close(); }
  for (const destination of destinations) {
    if (git(root, ['check-ignore', '--quiet', '--', relative(root, destination)]).status !== 0) fail('echo.hooks.workspaceIgnore');
  }
  if (git(root, ['check-ignore', '--quiet', '--', `${echoDirectory}/echo-private-state`]).status !== 0) fail('echo.hooks.workspaceIgnore');
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

async function privateDirectory(path: string): Promise<void> {
  const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== process.getuid?.() || (existing.mode & 0o077) !== 0) fail('echo.hooks.workspaceInvalid');
    return;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const created = await lstat(path);
  if (!created.isDirectory() || created.isSymbolicLink() || created.uid !== process.getuid?.() || (created.mode & 0o077) !== 0) fail('echo.hooks.workspaceInvalid');
}

async function journalState(workspace: string, stateDirectory?: string): Promise<{ path: string; value: Journal }> {
  const xdg = process.env.XDG_STATE_HOME;
  const stateHome = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'state');
  const directory = stateDirectory ?? join(stateHome, 'farsight-echo', 'hooks');
  if (!isAbsolute(directory)) fail('echo.hooks.absolutePaths');
  // Resolve the user-selected state root; reject links in Echo's own directories.
  if (!stateDirectory) {
    await mkdir(stateHome, { recursive: true, mode: 0o700 });
    await privateDirectory(join(await realpath(stateHome), 'farsight-echo'));
  }
  await privateDirectory(directory);
  const path = join(directory, `${digest(workspace)}.json`);
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  const empty: Journal = { version: 1, workspace, files: {} };
  if (!info) return { path, value: empty };
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 8 * 1024 * 1024) fail('echo.hooks.workspaceInvalid');
  const value = parseObject(await readFile(path, 'utf8'));
  if (value.version !== 1 || value.workspace !== workspace || Object.keys(value).some(key => !['version', 'workspace', 'files'].includes(key))) fail();
  const files = object(value.files);
  for (const [host, data] of Object.entries(files)) {
    if (!(HOSTS as readonly string[]).includes(host)) fail();
    const entry = object(data);
    if (Object.keys(entry).length !== 2 || typeof entry.installedHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.installedHash)
      || entry.original !== null && typeof entry.original !== 'string') fail();
  }
  return { path, value: value as unknown as Journal };
}

async function replaceFile(path: string, value: string): Promise<void> {
  const temporary = join(dirname(path), `.echo-hooks-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Explicit, local workspace installation. Never edits host-global settings or grants host trust. */
export async function installWorkspaceHooks(
  ctx: EchoContext, host: HookHost | 'all', executable: string, workspaceRoot: string,
  options: HookOptions = {},
): Promise<{ changedPaths: string[]; hosts: HookHost[]; instructions: string }> {
  if (!isAbsolute(workspaceRoot)) fail('echo.hooks.absolutePaths');
  const workspace = await realpath(resolve(workspaceRoot));
  const journal = await journalState(workspace, options.stateDirectory);
  return withSettingsLock(journal.path, () => installWorkspaceHooksLocked(ctx, host, executable, workspace, options));
}

async function installWorkspaceHooksLocked(
  ctx: EchoContext, host: HookHost | 'all', executable: string, workspaceRoot: string, options: HookOptions,
): Promise<{ changedPaths: string[]; hosts: HookHost[]; instructions: string }> {
  if (process.platform === 'win32') fail('echo.hooks.platform');
  if (host !== 'all' && !HOSTS.includes(host)) fail('echo.hooks.invalidHost');
  if (![ctx.configPath, ctx.directory, executable, workspaceRoot].every(isAbsolute)) fail('echo.hooks.absolutePaths');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(ctx.profileId)) fail('echo.hooks.invalidProfile');
  const workspace = await realpath(resolve(workspaceRoot));
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
    if (hasOwned(raw, selected)) installed.push(selected);
  }
  const hosts = HOSTS.filter(selected => requested.includes(selected) || installed.includes(selected));
  await preventDuplicateHooks(workspace, hosts, options.vscodeUserSettingsPaths);
  const journal = await journalState(workspace, options.stateDirectory);
  const plan: Plan[] = [];
  for (const selected of hosts) {
    const path = join(workspace, ...paths[selected]);
    await ensureLocalPath(workspace, path);
    const before = await contents(path);
    const after = merge(before, selected, command(ctx, selected, executable, workspace));
    const prior = journal.value.files[selected];
    // Reconnect keeps the first exact restore point. If someone edited a managed
    // file afterward, carry those changes into the new restore point instead.
    const original = prior && before !== undefined && prior.installedHash === digest(before)
      ? prior.original : before !== undefined && hasOwned(before, selected) ? merge(before, selected) ?? null : before ?? null;
    journal.value.files[selected] = { original, installedHash: digest(after!) };
    if (before !== after) plan.push({ host: selected, path, before, after });
  }
  await ignoreLocalFiles(workspace, [...hosts.map(selected => join(workspace, ...paths[selected])), join(workspace, '.echo', 'settings.json'), join(workspace, '.echo', 'connection.json')]);
  for (const item of plan) {
    if (await contents(item.path) !== item.before) fail('echo.hooks.workspaceChanged');
  }
  try {
    // Persist restoration data before touching a hook file, so interrupted writes
    // can still be disconnected without relying on repository-supplied metadata.
    await replaceFile(journal.path, `${JSON.stringify(journal.value, null, 2)}\n`);
    for (const item of plan) {
      await mkdir(dirname(item.path), { recursive: true, mode: 0o700 });
      await ensureLocalPath(workspace, item.path);
      if (await contents(item.path) !== item.before) fail('echo.hooks.workspaceChanged');
      await replaceFile(item.path, item.after!);
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

/** Remove only Echo-owned commands; restore exact prior bytes when nothing else changed. */
export async function disconnectWorkspaceHooks(
  workspaceRoot: string, options: Pick<HookOptions, 'stateDirectory'> = {},
): Promise<{ changedPaths: string[]; hosts: HookHost[] }> {
  if (!isAbsolute(workspaceRoot)) fail('echo.hooks.absolutePaths');
  const workspace = await realpath(resolve(workspaceRoot));
  const journal = await journalState(workspace, options.stateDirectory);
  return withSettingsLock(journal.path, () => disconnectWorkspaceHooksLocked(workspace, options));
}

async function disconnectWorkspaceHooksLocked(
  workspace: string, options: Pick<HookOptions, 'stateDirectory'>,
): Promise<{ changedPaths: string[]; hosts: HookHost[] }> {
  if (!(await lstat(workspace)).isDirectory()) fail('echo.hooks.workspaceInvalid');
  const journal = await journalState(workspace, options.stateDirectory);
  const plan: Plan[] = [];
  for (const host of HOSTS) {
    const path = join(workspace, ...paths[host]);
    await ensureLocalPath(workspace, path);
    const before = await contents(path);
    if (before === undefined || !hasOwned(before, host)) continue;
    const entry = journal.value.files[host];
    const after = entry?.installedHash === digest(before) ? entry.original ?? undefined : merge(before, host);
    if (before !== after) plan.push({ host, path, before, after });
  }
  for (const item of plan) {
    if (await contents(item.path) !== item.before) fail('echo.hooks.workspaceChanged');
  }
  for (const item of plan) {
    await ensureLocalPath(workspace, item.path);
    if (await contents(item.path) !== item.before) fail('echo.hooks.workspaceChanged');
    if (item.after === undefined) await unlink(item.path);
    else await replaceFile(item.path, item.after);
  }
  await unlink(journal.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return { changedPaths: plan.map(item => item.path), hosts: plan.map(item => item.host) };
}
