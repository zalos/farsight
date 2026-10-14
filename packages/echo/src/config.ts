import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { SubmindSettings } from './submind-types.js';
import { echoConfigWord } from '@farsight/core/dist/strings-echo-config.js';
import { parseKeychainRef } from './secrets.js';
import { withSettingsLock } from './settings-lock.js';
import { withConfigCredentialPins, recordFileTrust, requireFileTrust } from './trust.js';
import type { EchoConfig, EchoContext, EchoProfile, OllamaSettings } from './types.js';

function fail(key = 'echo.config.shape'): never { throw new Error(echoConfigWord(key)); }
function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const object = value as Record<string, unknown>;
  if (fields && Object.keys(object).some(key => !fields.includes(key))) fail();
  return object;
}
function label(value: unknown, key = 'echo.config.shape', empty = false): string {
  if (typeof value !== 'string' || value !== value.trim() || (!empty && !value) || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) fail(key);
  return value;
}
function identity(value: unknown): string {
  const text = label(value, 'echo.config.identity');
  if (text.includes('*')) fail('echo.config.identity');
  return text;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value; }
function integer(value: unknown, min: number, max: number, key = 'echo.config.shape'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(key);
  return value;
}
function secret(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!parseKeychainRef(value)) fail('echo.config.secret');
  return value as string;
}
function profileName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) fail('echo.config.profile');
  return value;
}

/** Canonical loopback aliases cannot bypass profile separation or port collisions. */
function origin(value: unknown, localOnly = false, allowPrivateHttp = false): { url: string; exactUrl: string; local: boolean; port: number } {
  if (typeof value !== 'string' || value !== value.trim() || /[\x00-\x20\x7f\\]/.test(value) || !/^https?:\/\/[^/?#]+\/?$/i.test(value)) fail('echo.config.url');
  let parsed: URL;
  try { parsed = new URL(value); } catch { fail('echo.config.url'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || value.includes('?') || value.includes('#')) fail('echo.config.url');
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  // The HTTP exception is deliberately literal-only: DNS names and alternate numeric forms cannot qualify.
  const rawHostname = value.match(/^https?:\/\/([^/:]+)(?::[0-9]+)?\/?$/i)?.[1];
  const octets = hostname.split('.').map(Number);
  const privateLiteral = isIP(hostname) === 4 && rawHostname === hostname && (octets[0] === 10 || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31 || octets[0] === 192 && octets[1] === 168);
  if (localOnly && !local || !local && parsed.protocol !== 'https:' && !(allowPrivateHttp && privateLiteral)) fail('echo.config.url');
  const exactUrl = parsed.origin;
  parsed.hostname = local ? '127.0.0.1' : hostname;
  return { url: parsed.origin, exactUrl, local, port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) };
}

/** Effective native Ollama resource limits without adding fields to legacy settings. */
export function ollamaSettings(model: Pick<EchoProfile['model'], 'ollama'>): OllamaSettings {
  if (model.ollama === undefined) return { contextTokens: 4096, keepAliveSeconds: 0 };
  const settings = record(model.ollama, ['contextTokens', 'keepAliveSeconds']);
  return {
    contextTokens: integer(settings.contextTokens, 2048, 131_072),
    keepAliveSeconds: integer(settings.keepAliveSeconds, 0, 3600),
  };
}

/** Validate at dispatch as well as settings load; exported adapters cannot bypass transport policy. */
export function validateModelSettings(value: unknown): EchoProfile['model'] {
  const model = record(value, ['provider', 'baseUrl', 'model', 'secretRef', 'allowInsecureHttp', 'ollama']);
  if (model.provider !== 'ollama' && model.provider !== 'openai-compatible') fail();
  const allowInsecureHttp = model.allowInsecureHttp === undefined ? false : bool(model.allowInsecureHttp);
  const address = origin(model.baseUrl, false, allowInsecureHttp);
  const modelSecret = secret(model.secretRef);
  if (!address.local && address.exactUrl.startsWith('http:') && modelSecret !== undefined) fail('echo.config.modelHttpSecret');
  return {
    provider: model.provider, baseUrl: address.exactUrl, model: label(model.model, 'echo.config.shape', true),
    ...(modelSecret === undefined ? {} : { secretRef: modelSecret }),
    ...(model.allowInsecureHttp === undefined ? {} : { allowInsecureHttp }),
    ...(model.ollama === undefined ? {} : { ollama: ollamaSettings({ ollama: model.ollama as OllamaSettings }) }),
  };
}

const SUBMIND_DEFAULTS: Readonly<SubmindSettings> = Object.freeze({
  mode: 'off', hookResearch: 'manual', maxSteps: 3, maxSearches: 3, maxCandidates: 12,
  evidenceMaxChars: 12_000, inputMaxChars: 48_000, lookbackDays: 90,
  timeoutMs: 30_000, expandedMaxChars: 12_000,
});

/** Legacy profiles stay off. Partial settings receive the same limits at load, dispatch and fingerprinting. */
export function submindSettings(profile: Pick<EchoProfile, 'submind'>): SubmindSettings {
  const settings = profile.submind === undefined ? {} : record(profile.submind, Object.keys(SUBMIND_DEFAULTS));
  const mode = settings.mode === undefined ? SUBMIND_DEFAULTS.mode : settings.mode;
  if (mode !== 'off' && mode !== 'mock' && mode !== 'model') fail('echo.config.submind');
  const hookResearch = settings.hookResearch === undefined ? SUBMIND_DEFAULTS.hookResearch : settings.hookResearch;
  if (hookResearch !== 'manual' && hookResearch !== 'background') fail('echo.config.submind');
  const limit = (key: Exclude<keyof SubmindSettings, 'mode' | 'hookResearch'>, min: number, max: number) =>
    integer(settings[key] === undefined ? SUBMIND_DEFAULTS[key] : settings[key], min, max, 'echo.config.submind');
  return {
    mode, hookResearch, maxSteps: limit('maxSteps', 1, 8), maxSearches: limit('maxSearches', 1, 8),
    maxCandidates: limit('maxCandidates', 1, 50), evidenceMaxChars: limit('evidenceMaxChars', 128, 64_000),
    inputMaxChars: limit('inputMaxChars', 1024, 256_000), lookbackDays: limit('lookbackDays', 1, 3650),
    timeoutMs: limit('timeoutMs', 100, 300_000), expandedMaxChars: limit('expandedMaxChars', 128, 64_000),
  };
}

function defaultProfile(index: number): EchoProfile {
  return {
    identity: { individual: 'local', project: 'default', ...(index ? { team: 'team' } : {}) },
    backend: { mode: 'managed', url: `http://127.0.0.1:${4611 + index * 100}` },
    model: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: '' },
    web: { port: 4480 + index },
    hooks: { claude: false, codex: false, vscode: false },
    skills: { directories: [] },
    budget: { briefMaxChars: 1200, modelMaxTokens: 384, timeoutMs: 60_000 },
    submind: submindSettings({}),
  };
}

export function defaultConfig(): EchoConfig {
  return { version: 1, defaultProfile: 'personal', profiles: { personal: defaultProfile(0), work: defaultProfile(1) } };
}

/** Returns a normalized object, refusing unknown fields and never echoing values in errors. */
export function validateConfig(value: unknown): EchoConfig {
  const input = record(value, ['version', 'defaultProfile', 'profiles']);
  if (input.version !== 1) fail();
  const selected = profileName(input.defaultProfile);
  const profiles = record(input.profiles);
  if (!Object.hasOwn(profiles, selected) || Object.keys(profiles).length > 32) fail('echo.config.profile');
  const result: EchoConfig = { version: 1, defaultProfile: selected, profiles: {} };
  const addresses = new Set<string>();
  const ports = new Set<number>();
  const modelPorts = new Set<number>();
  function reserve(port: number): void {
    if (ports.has(port)) fail('echo.config.ports');
    ports.add(port);
  }
  for (const [name, value] of Object.entries(profiles)) {
    profileName(name);
    const profile = record(value, ['identity', 'backend', 'model', 'web', 'hooks', 'skills', 'budget', 'submind']);
    const id = record(profile.identity, ['individual', 'team', 'project']);
    const backend = record(profile.backend, ['mode', 'url', 'secretRef']);
    if (backend.mode !== 'managed' && backend.mode !== 'external') fail();
    const address = origin(backend.url, backend.mode === 'managed');
    if (backend.mode === 'managed' && !address.url.startsWith('http:')) fail('echo.config.url');
    if (addresses.has(address.url)) fail('echo.config.ports');
    addresses.add(address.url);
    if (backend.mode === 'managed') {
      integer(address.port, 1024, 65535 - 46023, 'echo.config.ports');
      // agentmemory's REST, stream, viewer and engine ports must all be free.
      for (const port of [address.port, address.port + 1, address.port + 2, address.port + 46023]) reserve(port);
    } else if (address.local) reserve(address.port);
    const model = validateModelSettings(profile.model);
    const modelAddress = origin(model.baseUrl, false, model.allowInsecureHttp);
    if (modelAddress.local) modelPorts.add(modelAddress.port);
    const web = record(profile.web, ['port', 'farsightOrigin']);
    const webPort = integer(web.port, 1024, 65535, 'echo.config.ports');
    reserve(webPort);
    const hooks = record(profile.hooks, ['claude', 'codex', 'vscode']);
    const skills = record(profile.skills, ['directories']);
    if (!Array.isArray(skills.directories) || skills.directories.length > 64) fail();
    const directories = skills.directories.map(value => {
      if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail();
      return value;
    });
    const budget = record(profile.budget, ['briefMaxChars', 'modelMaxTokens', 'timeoutMs']);
    const backendSecret = secret(backend.secretRef);
    // Managed instances use runtime-owned ephemeral authentication, never a user credential.
    if (backend.mode === 'managed' && backendSecret !== undefined) fail('echo.config.managedSecret');
    result.profiles[name] = {
      identity: { individual: identity(id.individual), project: identity(id.project), ...(id.team === undefined ? {} : { team: identity(id.team) }) },
      backend: { mode: backend.mode, url: backend.mode === 'managed' ? address.url : address.exactUrl, ...(backendSecret === undefined ? {} : { secretRef: backendSecret }) },
      model,
      ...(profile.submind === undefined ? {} : { submind: submindSettings({ submind: profile.submind as SubmindSettings }) }),
      web: { port: webPort, ...(web.farsightOrigin === undefined ? {} : { farsightOrigin: origin(web.farsightOrigin, true).exactUrl }) },
      hooks: { claude: bool(hooks.claude), codex: bool(hooks.codex), vscode: hooks.vscode === undefined ? false : bool(hooks.vscode) },
      skills: { directories },
      budget: { briefMaxChars: integer(budget.briefMaxChars, 128, 16_384), modelMaxTokens: integer(budget.modelMaxTokens, 32, 4096), timeoutMs: integer(budget.timeoutMs, 100, 300_000) },
    };
  }
  if ([...modelPorts].some(port => ports.has(port))) fail('echo.config.ports');
  return result;
}

export function loadContext(configPath: string, profileId?: string): EchoContext {
  let path: string;
  let raw: unknown;
  let contents: string;
  try {
    const info = lstatSync(resolve(configPath));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) fail('echo.config.read');
    path = realpathSync(resolve(configPath));
    contents = readFileSync(path, 'utf8');
    raw = JSON.parse(contents);
  } catch { fail('echo.config.read'); }
  requireFileTrust('configs', path, contents);
  const config = validateConfig(raw);
  const selected = profileName(profileId ?? config.defaultProfile);
  if (!Object.hasOwn(config.profiles, selected)) fail('echo.config.profile');
  const directory = dirname(path);
  const profile = structuredClone(config.profiles[selected]!);
  profile.skills.directories = profile.skills.directories.map(path => isAbsolute(path) ? resolve(path) : resolve(directory, path));
  return { configPath: path, config, profileId: selected, profile, directory, dataDirectory: join(directory, 'profiles', selected) };
}

async function writeConfig(configPath: string, value: unknown, exclusive: boolean): Promise<EchoConfig> {
  const config = validateConfig(value);
  const destination = resolve(configPath);
  const directory = dirname(destination);
  const temporary = join(directory, `.echo-settings-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const current = await lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (current?.isSymbolicLink() || current && !current.isFile()) fail('echo.config.write');
    const file = await open(temporary, 'wx', 0o600);
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await withConfigCredentialPins(config, async () => {
      if (exclusive) await link(temporary, destination);
      else await rename(temporary, destination);
      recordFileTrust('configs', destination, contents);
    });
    return config;
  } catch (error) {
    if (exclusive && (error as NodeJS.ErrnoException).code === 'EEXIST') fail('echo.config.exists');
    if (error instanceof Error && error.message === echoConfigWord('echo.secret.origin')) throw error;
    fail('echo.config.write');
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Explicit adoption only; callers must obtain confirmation before trusting existing settings. */
export async function trustConfig(configPath: string): Promise<EchoConfig> {
  return withSettingsLock(configPath, async () => {
    const info = lstatSync(resolve(configPath));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) fail('echo.config.read');
    const path = realpathSync(resolve(configPath));
    const contents = readFileSync(path, 'utf8');
    const config = validateConfig(JSON.parse(contents));
    return withConfigCredentialPins(config, () => {
      recordFileTrust('configs', path, contents);
      return config;
    });
  });
}

export async function saveConfig(configPath: string, config: EchoConfig): Promise<void> {
  await withSettingsLock(configPath, () => writeConfig(configPath, config, false));
}

export async function initConfig(configPath: string, config: EchoConfig = defaultConfig()): Promise<EchoConfig> {
  return withSettingsLock(configPath, () => writeConfig(configPath, config, true));
}

/** Merge a fresh snapshot while holding the same lock used by every settings writer. */
export async function updateConfig(configPath: string, update: (config: EchoConfig) => EchoConfig | undefined | Promise<EchoConfig | undefined>): Promise<void> {
  await withSettingsLock(configPath, async () => {
    const next = await update(loadContext(configPath).config);
    if (next !== undefined) await writeConfig(configPath, next, false);
  });
}
