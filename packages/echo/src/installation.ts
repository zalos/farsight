import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { chmod, link, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { echoInstallationWord } from '@farsight/core/dist/strings-echo-installation.js';

export type InstallScope = 'workspace' | 'global';
export interface WorkspaceConnection { version: 1; configPath: string; profileId: string }
export interface Installation {
  configPath: string;
  profileId?: string;
  scope: InstallScope | 'custom';
  connectionPath?: string;
  workspaceRoot?: string;
}
export interface InstallationOptions {
  cwd?: string;
  scope?: string;
  configPath?: string;
  profileId?: string;
  ignoreConnection?: boolean;
  /** A deterministic override for embedding and tests; no environment mutation is needed. */
  globalPath?: string;
}

const MAX_CONNECTION_BYTES = 16_384;
function fail(key = 'echo.installation.connection'): never { throw new Error(echoInstallationWord(key)); }
function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function pathValue(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail();
  return value;
}
function profile(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) fail('echo.installation.profile');
  return value;
}
function canonical(path: string): string {
  const absolute = resolve(pathValue(path));
  try { return realpathSync(absolute); } catch { return absolute; }
}

/** Global selection is explicit; a relative XDG setting does not redirect it into the current workspace. */
export function globalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? pathValue(xdg) : join(homedir(), '.config'), 'farsight-echo', 'settings.json');
}

export function connectionPath(workspace: string): string {
  return join(resolve(pathValue(workspace)), '.echo', 'connection.json');
}

function localDirectory(workspace: string, name?: string): string {
  const root = resolve(pathValue(workspace));
  const rootInfo = stat(root);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) fail('echo.installation.workspace');
  let current = root;
  for (const part of ['.echo', ...(name ? [name] : [])]) {
    current = join(current, part);
    const info = stat(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) fail('echo.installation.workspace');
  }
  return current;
}

/** Validate a flat, unambiguous binding, including JSON keys spelled with escapes. */
function parseConnection(text: string): WorkspaceConnection {
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const object = value as Record<string, unknown>;
  const keys: string[] = [];
  // Parsing has already established valid JSON. Walk complete string tokens so
  // punctuation inside a path cannot be mistaken for another property.
  let depth = 0, expectingKey = true;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '{') { if (++depth > 1) fail(); }
    else if (char === '}') depth--;
    else if (char === '[') fail();
    else if (char === ',') expectingKey = true;
    else if (char === '"') {
      const start = index;
      for (index++; index < text.length; index++) {
        if (text[index] === '\\') index++;
        else if (text[index] === '"') break;
      }
      if (expectingKey) { keys.push(JSON.parse(text.slice(start, index + 1)) as string); expectingKey = false; }
    }
  }
  if (keys.length !== 3 || new Set(keys).size !== 3 || keys.some(key => !['version', 'configPath', 'profileId'].includes(key)) || object.version !== 1) fail();
  const configPath = pathValue(object.configPath);
  if (!isAbsolute(configPath)) fail();
  return { version: 1, configPath: resolve(configPath), profileId: profile(object.profileId) };
}

/** Read a fixed upper bound; a growing file or special file cannot cause an unbounded read. */
function connectionContents(workspace: string): string | undefined {
  localDirectory(workspace);
  const path = connectionPath(workspace);
  const before = stat(path);
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CONNECTION_BYTES) fail();
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > MAX_CONNECTION_BYTES) fail();
    const bytes = Buffer.alloc(MAX_CONNECTION_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > MAX_CONNECTION_BYTES) fail();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
  } catch { fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readConnection(workspace: string): WorkspaceConnection | undefined {
  try {
    const text = connectionContents(workspace);
    return text === undefined ? undefined : parseConnection(text);
  } catch { fail(); }
}

/** No settings are loaded here: the caller must validate the exact selected file and profile. */
export function describeInstallation(configPath: string, globalPath = globalConfigPath()): Pick<Installation, 'scope' | 'configPath' | 'workspaceRoot'> {
  const path = canonical(configPath);
  if (path === canonical(globalPath)) return { scope: 'global', configPath: path };
  if (basename(path) === 'settings.json' && basename(dirname(path)) === '.echo') {
    return { scope: 'workspace', configPath: path, workspaceRoot: dirname(dirname(path)) };
  }
  return { scope: 'custom', configPath: path };
}

/** Nearest local settings or binding define a workspace, bounded by the nearest Git root. */
function discoverWorkspace(cwd: string): string {
  const starting = resolve(pathValue(cwd));
  const info = stat(starting);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('echo.installation.workspace');
  let current = starting;
  for (;;) {
    const directory = join(current, '.echo');
    const echo = stat(directory);
    if (echo?.isSymbolicLink() || echo && !echo.isDirectory()) fail('echo.installation.workspace');
    if (stat(connectionPath(current)) || stat(join(directory, 'settings.json')) || stat(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return starting;
    current = parent;
  }
}

export function resolveInstallation(options: InstallationOptions = {}): Installation {
  if (options.scope !== undefined && options.configPath !== undefined || options.scope !== undefined && !['workspace', 'global'].includes(options.scope)) fail('echo.installation.selection');
  const selectedProfile = options.profileId === undefined ? undefined : profile(options.profileId);
  const cwd = resolve(options.cwd ?? process.cwd());
  const globalPath = options.globalPath ?? globalConfigPath();
  if (options.configPath !== undefined) {
    return { ...describeInstallation(resolve(cwd, pathValue(options.configPath)), globalPath), ...(selectedProfile ? { profileId: selectedProfile } : {}) };
  }
  if (options.scope === 'global') {
    return { scope: 'global', configPath: canonical(globalPath), ...(selectedProfile ? { profileId: selectedProfile } : {}) };
  }
  const workspaceRoot = discoverWorkspace(cwd);
  if (options.scope !== 'workspace' && !options.ignoreConnection) {
    const binding = readConnection(workspaceRoot);
    if (binding) return {
      ...describeInstallation(binding.configPath, globalPath), profileId: selectedProfile ?? binding.profileId,
      connectionPath: connectionPath(workspaceRoot), workspaceRoot,
    };
  }
  return { scope: 'workspace', configPath: join(workspaceRoot, '.echo', 'settings.json'), workspaceRoot, ...(selectedProfile ? { profileId: selectedProfile } : {}) };
}

/** Persist a pointer only: no settings, memory or credential material is copied into a workspace. */
export async function writeConnection(
  workspace: string, binding: Pick<WorkspaceConnection, 'configPath' | 'profileId'>,
): Promise<{ path: string; changed: boolean; backupPath?: string }> {
  const selected = parseConnection(JSON.stringify({ version: 1, ...binding }));
  const path = connectionPath(workspace);
  const directory = localDirectory(workspace);
  const before = connectionContents(workspace);
  if (before !== undefined) {
    const old = parseConnection(before);
    if (old.configPath === selected.configPath && old.profileId === selected.profileId) return { path, changed: false };
  }
  const temporary = join(directory, `.echo-connection-${randomUUID()}.tmp`);
  let backupPath: string | undefined;
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    localDirectory(workspace);
    await chmod(directory, 0o700);
    if (before !== undefined) {
      const backups = localDirectory(workspace, 'backups');
      await mkdir(backups, { recursive: false, mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      localDirectory(workspace, 'backups');
      await chmod(backups, 0o700);
      backupPath = join(backups, `connection-${Date.now()}-${randomUUID()}.json`);
      await writeFile(backupPath, before, { flag: 'wx', mode: 0o600 });
    }
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(selected, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    if (connectionContents(workspace) !== before) fail('echo.installation.changed');
    if (before === undefined) await link(temporary, path);
    else await rename(temporary, path);
    return { path, changed: true, ...(backupPath ? { backupPath } : {}) };
  } catch (error) {
    if (error instanceof Error && error.message === echoInstallationWord('echo.installation.changed')) throw error;
    fail('echo.installation.write');
  } finally { await unlink(temporary).catch(() => {}); }
}
