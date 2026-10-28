// Fixed external Copilot distribution. The native launcher alone does not pin its extracted JavaScript/native modules.
// No vendor bytes are distributed by Sentinel; a bounded verified copy supplies one exact private runtime.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, realpath, opendir, mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname, relative } from 'node:path';
import { COPILOT_CODE_MANIFEST } from './cli-copilot-manifest.js';
import { COPILOT_1_0_105_CODE_MANIFEST } from './cli-copilot-manifest-1.0.105.js';
import { canonicalDigest } from '../../policy/digest.js';
import { fail, ProviderError } from './errors.js';
import type { NativeTiming } from './cli-native-profile.js';
import {
  seatbelt,
  seatbeltHead,
  seatbeltBaseReads,
  seatbeltProxyOnly,
  SEATBELT_PROCESS_INFO,
  SEATBELT_DIRECTORY_METADATA,
  SEATBELT_TASK_PORT,
  SEATBELT_SYSTEM_SERVICES,
  SEATBELT_DEVICE_IOCTL,
} from './sandboxed-cli.js';
export const COPILOT_NATIVE_PROFILE = Object.freeze({
  id: 'copilot-1.0.103-darwin-arm64-seatbelt-v6',
  version: '1.0.103',
  model: 'gpt-6-luna',
  executableDigest: 'sha256:1c81150e4bd7805c8470f4718bc8cb3c3a20c2379086f36309f7ae823e32ace6',
  executableBytes: 181807712,
  runtimeDigest: 'sha256:3d0df03e4145ef5a61c6e208cc4c80c6e56159a87b078b49ff2c91607397cc41',
  runtimeBytes: 212717731,
  runtimeFiles: 265,
  accountSelection: 'owner-selected-host-login/1',
  toolRestriction: 'exclude-builtin-mcp-custom/1',
  autoLogin: 'vendor-stored-oauth-detection',
  auth: 'vendor-native-keychain',
  authFileReads: '$HOME/Library/Keychains;/private/var/protected/trustd',
  authMachServices: 'com.apple.SecurityServer;com.apple.trustd;com.apple.trustd.agent',
  preferences: 'denied',
  proxyRejection: 'per-socket-unknown-connect/1',
  wire: 'sentinel-copilot-chat/v1',
  output: 'silent-text/1',
  reasoningEffort: 'model-default',
  decoder: 'fatal-utf8-visible-and-owned-usage/1',
  softAiCredits: 30,
  contextReservation: 272000,
});
/** The brokered v6 profile re-qualified on Copilot 1.0.105: same sandbox and flags, the 1.0.105 code pins. */
export const COPILOT_1_0_105_PROFILE = Object.freeze({
  ...COPILOT_NATIVE_PROFILE,
  id: 'copilot-1.0.105-darwin-arm64-seatbelt-v6',
  version: '1.0.105',
  executableDigest: 'sha256:5fd7d15ff02deb08a58593b1b488015bb52c1686014b80b5509e28263cb3ad70',
  executableBytes: 181873376,
  runtimeDigest: 'sha256:aad20f2ab2d430999091a36d937e6c667d3dbba16a86cd38d90bda609cbb34c7',
  runtimeBytes: 212852371,
  runtimeFiles: 265,
});
/**
 * The native agent mode on Copilot 1.0.105: the CLI runs its own loop over a scratch tree holding only the stage's
 * inputs, with only the read tools available, the JSONL event stream and the `--share` Markdown transcript retained.
 * Same sandbox, proxy and account projection as v6. The tool names come from the one debug dry run: `view` reads a
 * file and `glob` lists paths, both in-process; `rg` is left out because it executes the bundled ripgrep binary,
 * which the deny-default profile refuses (only the pinned executable may be executed).
 */
export const COPILOT_AGENT_PROFILE = Object.freeze({
  ...COPILOT_1_0_105_PROFILE,
  id: 'copilot-1.0.105-darwin-arm64-native-v1',
  mode: 'native' as const,
  toolRestriction: 'available-read-tools/1',
  readTools: 'view,glob',
  instructions: 'scratch-github-copilot-instructions/1',
  wire: 'sentinel-copilot-agent/v1',
  output: 'jsonl-events/1',
  transcript: 'jsonl-and-share-markdown/1',
  decoder: 'fatal-utf8-jsonl-final-answer-and-owned-usage/1',
});
export type CopilotProfile =
  typeof COPILOT_NATIVE_PROFILE | typeof COPILOT_1_0_105_PROFILE | typeof COPILOT_AGENT_PROFILE;
/** Every qualified Copilot profile; 1.0.103's record is kept beside the 1.0.105 re-qualification. */
export const COPILOT_PROFILES: readonly CopilotProfile[] = Object.freeze([
  COPILOT_NATIVE_PROFILE,
  COPILOT_1_0_105_PROFILE,
  COPILOT_AGENT_PROFILE,
]);
/** The mode a profile runs: the v6 profiles are brokered turns, native-v1 is the CLI's own loop. */
export const copilotProfileMode = (p: CopilotProfile): 'brokered' | 'native' =>
  'mode' in p && p.mode === 'native' ? 'native' : 'brokered';
export const copilotProfileById = (id: string): CopilotProfile | undefined => COPILOT_PROFILES.find((p) => p.id === id);
export interface NativeCopilotRuntime {
  readonly profileId: string;
  readonly executableDigest: string;
  readonly runtimeDigest: string;
  readonly profileDigest: string;
}
interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}
interface Member {
  path: string;
  bytes: number;
  digest: string;
}
const runtimes = new WeakMap<
    object,
    { executable: string; runtimeDir: string; identity: FileIdentity; profile: CopilotProfile; installation: string }
  >(),
  setups = new WeakMap<object, { root: string; profile: CopilotProfile }>();
const q = (s: string) => JSON.stringify(s);
interface CodeManifest {
  readonly members: ReadonlyMap<string, { path: string; bytes: number; digest: string }>;
  readonly directories: ReadonlySet<string>;
}
const manifestOf = (rows: readonly { path: string; bytes: number; digest: string }[]): CodeManifest => ({
  members: new Map(rows.map((row) => [row.path, row])),
  directories: new Set(
    rows.flatMap((row) => {
      const parts = row.path.split('/');
      return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
    }),
  ),
});
const MANIFESTS: ReadonlyMap<string, CodeManifest> = new Map([
  ['1.0.103', manifestOf(COPILOT_CODE_MANIFEST)],
  ['1.0.105', manifestOf(COPILOT_1_0_105_CODE_MANIFEST)],
]);
const manifestFor = (p: CopilotProfile) =>
  MANIFESTS.get(p.version) ?? fail('sentinel.provider.capabilityUntested', 'no code manifest for this Copilot');
export function copilotBoundary(t: NativeTiming) {
  if (t.signal?.aborted) fail('sentinel.provider.canceled', 'Copilot setup canceled');
  if (!Number.isSafeInteger(t.deadlineAt) || Date.now() >= t.deadlineAt)
    fail('sentinel.provider.timeout', 'original Copilot deadline elapsed');
}
const same = (a: FileIdentity, b: FileIdentity) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
async function checkedRoot(path: string) {
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    fail('sentinel.provider.capabilityUntested', 'Copilot runtime path is not exact');
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink())
    fail('sentinel.provider.capabilityUntested', 'Copilot runtime directory refused');
  return s;
}
async function readMember(path: string, t: NativeTiming, ceiling: number, copyTo?: string) {
  copilotBoundary(t);
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let out: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await f.stat();
    if (!before.isFile() || before.size > ceiling || before.nlink !== 1)
      fail('sentinel.provider.capabilityUntested', 'Copilot code member bounds');
    if (copyTo)
      out = await open(copyTo, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    const hash = createHash('sha256'),
      buf = Buffer.alloc(1048576);
    let at = 0;
    while (at < before.size) {
      copilotBoundary(t);
      const { bytesRead } = await f.read(buf, 0, Math.min(buf.length, before.size - at), at);
      if (!bytesRead) fail('sentinel.provider.capabilityUntested', 'Copilot code member ended early');
      hash.update(buf.subarray(0, bytesRead));
      if (out) {
        let written = 0;
        while (written < bytesRead) {
          const r = await out.write(buf, written, bytesRead - written, at + written);
          if (!r.bytesWritten) fail('sentinel.provider.capabilityUntested', 'Copilot runtime copy ended early');
          written += r.bytesWritten;
        }
      }
      at += bytesRead;
    }
    const after = await f.stat(),
      named = await lstat(path);
    copilotBoundary(t);
    if (!same(before, after) || !same(before, named) || named.isSymbolicLink())
      fail('sentinel.provider.capabilityUntested', 'Copilot code identity changed');
    return { bytes: at, digest: 'sha256:' + hash.digest('hex'), identity: after };
  } finally {
    await out?.close();
    await f.close();
  }
}
/** Fixed bounded manifest, never a caller-defined package or a user configuration directory. */
async function runtimeMembers(
  root: string,
  t: NativeTiming,
  profile: CopilotProfile,
  copyRoot?: string,
): Promise<Member[]> {
  const manifest = manifestFor(profile);
  const original = await checkedRoot(root),
    rows: Member[] = [];
  let seen = 0,
    total = 0;
  const walk = async (path: string) => {
    copilotBoundary(t);
    const before = await checkedRoot(path),
      dir = await opendir(path);
    try {
      for await (const e of dir) {
        copilotBoundary(t);
        if (++seen > 1024 || !e.name || e.name === '.' || e.name === '..')
          fail('sentinel.provider.capabilityUntested', 'Copilot package enumeration bound');
        const absolute = join(path, e.name),
          s = await lstat(absolute),
          member = relative(root, absolute);
        if (s.isSymbolicLink()) fail('sentinel.provider.capabilityUntested', 'Copilot package links refused');
        if (s.isDirectory()) {
          if (!manifest.directories.has(member))
            fail('sentinel.provider.capabilityUntested', 'unknown Copilot code directory');
          if (copyRoot) await mkdir(join(copyRoot, member), { mode: 0o700 });
          await walk(absolute);
        } else if (s.isFile()) {
          const expected = manifest.members.get(member);
          if (!expected || s.size !== expected.bytes)
            fail('sentinel.provider.capabilityUntested', 'unknown or changed Copilot code member');
          if (rows.length >= 512 || (total += s.size) > 268435456)
            fail('sentinel.provider.capabilityUntested', 'Copilot package byte/member bound');
          const value = await readMember(absolute, t, 134217728, copyRoot ? join(copyRoot, member) : undefined);
          if (value.digest !== expected!.digest)
            fail('sentinel.provider.capabilityUntested', 'Copilot code content changed');
          rows.push({ path: member.split('\\').join('/'), bytes: value.bytes, digest: value.digest });
        } else fail('sentinel.provider.capabilityUntested', 'Copilot package special member refused');
      }
    } finally {
      await dir.close().catch(() => {});
    }
    if (!same(before, await lstat(path)))
      fail('sentinel.provider.capabilityUntested', 'Copilot package directory changed');
  };
  await walk(root);
  if (!same(original, await lstat(root))) fail('sentinel.provider.capabilityUntested', 'Copilot package root changed');
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest =
    'sha256:' +
    createHash('sha256')
      .update(rows.map((r) => r.path + '\0' + r.bytes + '\0' + r.digest + '\n').join(''))
      .digest('hex');
  if (rows.length !== profile.runtimeFiles || total !== profile.runtimeBytes || digest !== profile.runtimeDigest)
    fail('sentinel.provider.capabilityUntested', 'Copilot complete code closure is unavailable or changed');
  return rows;
}
async function readExecutable(path: string, t: NativeTiming, profile: CopilotProfile) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size !== profile.executableBytes)
    fail('sentinel.provider.capabilityUntested', 'Copilot executable size/type not pinned');
  return readMember(path, t, 268435456);
}
export async function qualifyNativeCopilot(
  executablePath: string,
  runtimeDir: string,
  t: NativeTiming,
  profile: CopilotProfile = COPILOT_NATIVE_PROFILE,
  installation = 'explicit',
): Promise<NativeCopilotRuntime> {
  copilotBoundary(t);
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !isAbsolute(executablePath))
    return fail('sentinel.provider.capabilityUntested', 'Copilot platform unavailable');
  if (!COPILOT_PROFILES.includes(profile))
    return fail('sentinel.provider.capabilityUntested', 'unknown Copilot profile');
  try {
    const executable = await realpath(executablePath),
      code = await readExecutable(executable, t, profile);
    if (code.bytes !== profile.executableBytes || code.digest !== profile.executableDigest)
      fail('sentinel.provider.capabilityUntested', 'Copilot executable is not pinned');
    await runtimeMembers(runtimeDir, t, profile);
    const body = {
      ...profile,
      securityd: 'trusted-pinned-vendor-not-service-confinement',
      destinations: COPILOT_DESTINATIONS,
    };
    const runtime = Object.freeze({
      profileId: body.id,
      executableDigest: body.executableDigest,
      runtimeDigest: body.runtimeDigest,
      profileDigest: canonicalDigest(body),
    });
    runtimes.set(runtime, { executable, runtimeDir, identity: code.identity, profile, installation });
    return runtime;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    return fail('sentinel.provider.capabilityUntested', 'Copilot pinned external runtime unavailable');
  }
}
/** The profile a genuine qualification matched; undefined for anything else. */
export const copilotRuntimeProfile = (runtime: object): CopilotProfile | undefined => runtimes.get(runtime)?.profile;
/**
 * Which installation a genuine qualification matched (`configured`, `path`, `homebrew-cask`, `known-location`) and
 * the executable's path on this machine. Provenance data for the owner's private record; never an admission input.
 */
export function copilotRuntimeInstallation(runtime: object): Readonly<{ source: string; executable: string }> {
  const held = runtimes.get(runtime);
  if (!held) return fail('sentinel.provider.notTrusted', 'Copilot runtime is not qualified');
  return Object.freeze({ source: held.installation, executable: held.executable });
}
export const COPILOT_DESTINATIONS = Object.freeze([
  'api.github.com',
  'github.com',
  'api.githubcopilot.com',
  'api.individual.githubcopilot.com',
  'api.business.githubcopilot.com',
  'api.enterprise.githubcopilot.com',
  'copilot-proxy.githubusercontent.com',
]);
/** Machine locations a pinned Copilot executable is installed at besides PATH: Homebrew's cask and its links. */
function knownLocations(profile: CopilotProfile): readonly { path: string; source: string }[] {
  return [
    { path: `/opt/homebrew/Caskroom/copilot-cli/${profile.version}/copilot`, source: 'homebrew-cask' },
    { path: `/usr/local/Caskroom/copilot-cli/${profile.version}/copilot`, source: 'homebrew-cask' },
    { path: '/opt/homebrew/bin/copilot', source: 'known-location' },
    { path: '/usr/local/bin/copilot', source: 'known-location' },
  ];
}
/** The npm package installs a JavaScript loader that runs its sibling native launcher. */
async function nativeLauncher(candidate: string): Promise<string> {
  const executable = await realpath(candidate);
  return executable.endsWith('/npm-loader.js')
    ? join(dirname(executable), 'node_modules/@github/copilot-darwin-arm64/copilot')
    : executable;
}
/**
 * Discovery reads code only: no command, login, credential/config file or download. The executable is resolved by its
 * recorded digest, not by PATH order: an explicit `SENTINEL_COPILOT_EXECUTABLE`, then each `copilot` on PATH (npm's
 * loader resolved to its native launcher), then the known Homebrew locations. Only exact pinned bytes qualify, so a
 * candidate can never widen what runs; the first match is recorded as the installation used.
 */
export async function qualifyInstalledNativeCopilot(
  t: NativeTiming,
  profile: CopilotProfile = COPILOT_NATIVE_PROFILE,
): Promise<NativeCopilotRuntime> {
  const path = process.env.PATH ?? '',
    dirs = path.split(':');
  if (path.length > 8192 || dirs.length > 32 || dirs.some((d) => !isAbsolute(d)))
    fail('sentinel.provider.capabilityUntested', 'Copilot discovery path bound');
  const configured = process.env.SENTINEL_COPILOT_EXECUTABLE;
  if (configured !== undefined && (!isAbsolute(configured) || configured.length > 4096))
    fail('sentinel.provider.capabilityUntested', 'configured Copilot executable is not an absolute path');
  const candidates = [
    ...(configured ? [{ path: configured, source: 'configured' }] : []),
    ...dirs.map((dir) => ({ path: join(dir, 'copilot'), source: 'path' })),
    ...knownLocations(profile),
  ];
  const tried = new Set<string>();
  for (const c of candidates) {
    copilotBoundary(t);
    let executable: string;
    try {
      await lstat(c.path);
      executable = await nativeLauncher(c.path);
      if (tried.has(executable)) continue;
      tried.add(executable);
      const s = await lstat(executable);
      if (!s.isFile() || s.isSymbolicLink() || s.size !== profile.executableBytes) continue;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      continue;
    }
    try {
      return await qualifyNativeCopilot(
        executable,
        join(homedir(), `Library/Caches/copilot/pkg/darwin-arm64/${profile.version}`),
        t,
        profile,
        c.source,
      );
    } catch (e) {
      if (
        e instanceof ProviderError &&
        (e.code === 'sentinel.provider.canceled' || e.code === 'sentinel.provider.timeout')
      )
        throw e;
      // Same size, other bytes, or its package cache is absent: keep looking for the exact pin.
    }
  }
  return fail('sentinel.provider.capabilityUntested', 'no installed Copilot matches the adopted pin');
}
/** Where one Copilot process runs: the pinned executable, its private owned root, the owner's HOME and the proxy. */
export interface CopilotLayout {
  readonly executable: string;
  readonly ownedRoot: string;
  readonly ownerHome: string;
  readonly proxyPort: number;
}
/**
 * The v6 seatbelt profile, built on the shared runner's rows. Exact text: the retained-wire control pins it.
 * Only the owned root is writable (home, state, tmp); vendor skills, builtin and plugins in the private runtime copy
 * stay unreadable; the native User keychain and trustd store are readable for the vendor's own authentication.
 */
export function copilotSeatbeltPolicy(l: CopilotLayout): string {
  return seatbelt([
    ...seatbeltHead(l.executable),
    SEATBELT_PROCESS_INFO,
    seatbeltBaseReads(l.executable, l.ownedRoot),
    `(deny file-read* (subpath ${q(join(l.ownedRoot, 'runtime/builtin-skills'))}) (subpath ${q(join(l.ownedRoot, 'runtime/builtin'))}) (subpath ${q(join(l.ownedRoot, 'runtime/plugins'))}))`,
    SEATBELT_DIRECTORY_METADATA,
    `(allow file-write* (subpath ${q(join(l.ownedRoot, 'home'))}) (subpath ${q(join(l.ownedRoot, 'state'))}) (subpath ${q(join(l.ownedRoot, 'tmp'))}) (literal "/dev/null"))`,
    SEATBELT_TASK_PORT,
    // Native User-keychain lookup requires real HOME identity, not general HOME access.
    `(allow file-read* (subpath ${q(join(l.ownerHome, 'Library/Keychains'))}) (subpath "/private/var/protected/trustd"))`,
    // Shared OS APIs trust pinned vendor use; trustd may fetch trust data outside our application proxy.
    '(allow mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent"))',
    `(allow mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") ${SEATBELT_SYSTEM_SERVICES})`,
    SEATBELT_DEVICE_IOCTL,
    seatbeltProxyOnly(l.proxyPort),
  ]);
}
/** Constructed, never merged: no token variable, no alternate provider, only the owned proxy for egress. */
export function copilotEnvironment(l: Omit<CopilotLayout, 'executable'>): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: '/usr/bin:/bin',
    HOME: l.ownerHome,
    COPILOT_HOME: join(l.ownedRoot, 'state'),
    COPILOT_CLI_DIST_DIR: join(l.ownedRoot, 'runtime'),
    TMPDIR: join(l.ownedRoot, 'tmp'),
    XDG_CACHE_HOME: join(l.ownedRoot, 'state'),
    CI: '1',
    TERM: 'dumb',
    NO_COLOR: '1',
    COPILOT_AUTO_UPDATE: 'false',
    USE_TGREP: 'false',
    HTTPS_PROXY: `http://127.0.0.1:${l.proxyPort}`,
    HTTP_PROXY: `http://127.0.0.1:${l.proxyPort}`,
    NO_PROXY: '',
  });
}
export async function nativeCopilotSetup(runtime: NativeCopilotRuntime, proxyPort: number, t: NativeTiming) {
  const held = runtimes.get(runtime);
  if (!held || !Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)
    return fail('sentinel.provider.notTrusted', 'Copilot setup requires genuine qualification');
  copilotBoundary(t);
  const before = await readExecutable(held.executable, t, held.profile);
  if (before.digest !== runtime.executableDigest || !same(before.identity, held.identity))
    fail('sentinel.provider.capabilityUntested', 'Copilot executable changed');
  const ownerHome = homedir();
  await checkedRoot(ownerHome);
  const ownedRoot = await realpath(await mkdtemp('/private/tmp/sentinel-copilot-'));
  try {
    for (const d of ['runtime', 'home', 'state', 'tmp']) await mkdir(join(ownedRoot, d), { mode: 0o700 });
    await runtimeMembers(held.runtimeDir, t, held.profile, join(ownedRoot, 'runtime'));
    const policy = copilotSeatbeltPolicy({ executable: held.executable, ownedRoot, ownerHome, proxyPort });
    const env = copilotEnvironment({ ownedRoot, ownerHome, proxyPort });
    const setup = Object.freeze({ executable: held.executable, policy, env, ownedRoot });
    setups.set(setup, { root: ownedRoot, profile: held.profile });
    return setup;
  } catch (e) {
    await rm(ownedRoot, { recursive: true, force: true });
    throw e;
  }
}
/** Recheck the complete private copy and executable immediately before process creation. */
export async function verifyNativeCopilotSetup(setup: object, t: NativeTiming) {
  const held = setups.get(setup);
  if (!held) return fail('sentinel.provider.notAdmitted', 'Copilot setup is not genuine');
  await runtimeMembers(join(held.root, 'runtime'), t, held.profile);
  const code = await readExecutable((setup as { executable: string }).executable, t, held.profile);
  if (code.digest !== held.profile.executableDigest || code.bytes !== held.profile.executableBytes)
    fail('sentinel.provider.capabilityUntested', 'Copilot executable changed before launch');
  copilotBoundary(t);
}
export async function cleanupNativeCopilotSetup(setup: object) {
  const held = setups.get(setup);
  if (!held) return;
  setups.delete(setup);
  await chmod(join(held.root, 'runtime'), 0o700).catch(() => {});
  await rm(held.root, { recursive: true, force: true, maxRetries: 0 });
}

/** Data-only projection. Native machine state is credential-free by vendor schema; only the selected identity survives. */
export interface NativeCopilotSelector {
  readonly host: 'https://github.com';
  readonly login: string;
}
const selectorFailure = (): never =>
  fail('sentinel.provider.credentialUnavailable', 'native selected account metadata unavailable');
export function projectNativeCopilotSelector(bytes: Uint8Array): Readonly<NativeCopilotSelector> {
  if (bytes.byteLength === 0 || bytes.byteLength > 262144) return selectorFailure();
  let text: string;
  try {
    text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } catch {
    return selectorFailure();
  }
  // JSONC comments only, outside strings. No eval, trailing-comma repair or borrowing of unrelated state.
  let json = '',
    quoted = false,
    escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      json += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      json += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      json += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return selectorFailure();
      json += ' ';
      i = end + 1;
      continue;
    }
    json += c;
  }
  if (quoted) return selectorFailure();
  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch {
    return selectorFailure();
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return selectorFailure();
  const value = state as Record<string, unknown>;
  const account = (v: unknown): v is NativeCopilotSelector =>
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).sort().join() === 'host,login' &&
    (v as NativeCopilotSelector).host === 'https://github.com' &&
    typeof (v as NativeCopilotSelector).login === 'string' &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test((v as NativeCopilotSelector).login) &&
    !(v as NativeCopilotSelector).login.includes('--');
  const selected = value.lastLoggedInUser,
    accounts = value.loggedInUsers;
  if (
    !account(selected) ||
    !Array.isArray(accounts) ||
    accounts.length < 1 ||
    accounts.length > 64 ||
    accounts.some((a) => !account(a)) ||
    accounts.filter((a) => a.host === selected.host && a.login === selected.login).length !== 1
  )
    return selectorFailure();
  return Object.freeze({ host: selected.host, login: selected.login });
}
/** Called only after admitted native authority. Never used by capabilities/code discovery. No raw state escapes. */
export async function readNativeCopilotSelector(t: NativeTiming): Promise<Readonly<NativeCopilotSelector>> {
  copilotBoundary(t);
  const selected = process.env.COPILOT_HOME ?? join(homedir(), '.copilot');
  if (!isAbsolute(selected) || selected.length > 4096) return selectorFailure();
  try {
    const directory = await checkedRoot(selected),
      path = join(selected, 'config.json'),
      named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > 262144) return selectorFailure();
    const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await f.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 262144 || !same(before, named))
        return selectorFailure();
      const bytes = Buffer.alloc(before.size);
      let at = 0;
      while (at < bytes.length) {
        copilotBoundary(t);
        const r = await f.read(bytes, at, bytes.length - at, at);
        if (!r.bytesRead) return selectorFailure();
        at += r.bytesRead;
      }
      const after = await f.stat();
      copilotBoundary(t);
      if (
        after.nlink !== 1 ||
        !same(before, after) ||
        !same(before, await lstat(path)) ||
        !same(directory, await lstat(selected))
      )
        return selectorFailure();
      return projectNativeCopilotSelector(bytes);
    } finally {
      await f.close();
    }
  } catch (e) {
    if (
      e instanceof ProviderError &&
      (e.code === 'sentinel.provider.canceled' || e.code === 'sentinel.provider.timeout')
    )
      throw e;
    return selectorFailure();
  }
}

/** Whether the vendor's native login can be reached from this process: never a token, only two closed classes. */
export interface CopilotCredentialPath {
  /** The selected account metadata (host and login) projects uniquely from the Copilot home. */
  readonly selector: 'selected' | 'unavailable';
  /** The owner's login keychain answers from this process's session (a service child in the login session does). */
  readonly keychain: 'reachable' | 'locked' | 'unavailable';
}
/**
 * Probes the credential path once, for a qualification record: the selector projection (metadata only) and whether
 * the login keychain answers here, through `security show-keychain-info`, which reports lock state and reads no item.
 * Its output is discarded; only the exit class is kept. Nothing here reads, copies or prints a credential.
 */
export async function probeCopilotCredentialPath(t: NativeTiming): Promise<CopilotCredentialPath> {
  let selector: CopilotCredentialPath['selector'] = 'selected';
  try {
    await readNativeCopilotSelector(t);
  } catch (e) {
    if (
      e instanceof ProviderError &&
      (e.code === 'sentinel.provider.canceled' || e.code === 'sentinel.provider.timeout')
    )
      throw e;
    selector = 'unavailable';
  }
  const keychainFile = join(homedir(), 'Library/Keychains/login.keychain-db');
  const probe = spawnSync('/usr/bin/security', ['show-keychain-info', keychainFile], {
    env: { PATH: '/usr/bin:/bin', HOME: homedir() },
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: Math.max(1, Math.min(5000, t.deadlineAt - Date.now())),
    shell: false,
  });
  const keychain: CopilotCredentialPath['keychain'] =
    probe.status === 0 ? 'reachable' : probe.status === 36 || probe.status === 51 ? 'locked' : 'unavailable';
  return Object.freeze({ selector, keychain });
}
