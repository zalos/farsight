// One closed, pinned native CLI profile. Vendor flags reinforce this whole-process OS boundary; they do not grant it.
// Machine-local executable paths are supplied only to qualification and accepted only by exact native bytes.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, mkdtemp, mkdir, rm, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fail } from './errors.js';
import { qualifyNativeHelper, type NativeHelper } from './cli-native-helper.js';
import { canonicalDigest } from '../../policy/digest.js';

export const CLAUDE_NATIVE_PROFILE = Object.freeze({
  id: 'claude-code-2.1.282-darwin-arm64-seatbelt-v1', version: '2.1.282',
  executableDigest: 'sha256:fcfd837103965c64de34a6b9b94370d77a347ea71819715a27d5f0ef01775ea4',
  destination: 'api.anthropic.com:443',
});
export interface NativeClaudeRuntime { readonly profileId: string; readonly executableDigest: string; readonly helperDigest: string; readonly profileDigest: string }
const runtimes = new WeakMap<object, { executable: string; dev: number; ino: number; size: number; mtimeMs: number; helper: NativeHelper }>();
export interface NativeTiming { readonly deadlineAt: number; readonly signal?: AbortSignal }
function boundary(t: NativeTiming) {
  if (t.signal?.aborted) fail('sentinel.provider.canceled', 'native setup canceled');
  if (!Number.isSafeInteger(t.deadlineAt) || t.deadlineAt <= Date.now()) fail('sentinel.provider.timeout', 'original native setup deadline elapsed');
}
const q = (v: string) => JSON.stringify(v);

export async function qualifyNativeClaude(executablePath: string, timing: NativeTiming = { deadlineAt: Date.now() + 5000 }): Promise<NativeClaudeRuntime> {
  boundary(timing);
  const localDeadline = Math.min(timing.deadlineAt, Date.now() + 5000);
  const check = () => boundary({ ...timing, deadlineAt: localDeadline });
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !isAbsolute(executablePath)) return fail('sentinel.provider.capabilityUntested', 'native CLI platform profile unavailable');
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const executable = await realpath(executablePath);
    fd = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await fd.stat();
    if (!before.isFile() || before.size !== 222245312) return fail('sentinel.provider.capabilityUntested', 'native CLI bytes are not qualified');
    const hash = createHash('sha256'); const bytes = Buffer.alloc(1024 * 1024); let position = 0;
    while (position < before.size) {
      check();
      const { bytesRead } = await fd.read(bytes, 0, Math.min(bytes.length, before.size - position), position);
      if (!bytesRead) return fail('sentinel.provider.capabilityUntested', 'native CLI read ended early');
      hash.update(bytes.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await fd.stat(); check();
    if (`sha256:${hash.digest('hex')}` !== CLAUDE_NATIVE_PROFILE.executableDigest || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return fail('sentinel.provider.capabilityUntested', 'native CLI identity changed');
    const helper = await qualifyNativeHelper(timing);
    const identity = { profileId: CLAUDE_NATIVE_PROFILE.id, executableDigest: CLAUDE_NATIVE_PROFILE.executableDigest, helperDigest: helper.digest, wire: 'sentinel-claude-chat/v1', auth: helper.protocol };
    const runtime = Object.freeze({ profileId: identity.profileId, executableDigest: identity.executableDigest, helperDigest: helper.digest, profileDigest: canonicalDigest(identity) });
    runtimes.set(runtime, { executable, dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, helper });
    return runtime;
  } catch { check(); return fail('sentinel.provider.capabilityUntested', 'native CLI bytes could not be qualified'); }
  finally { await fd?.close(); }
}

/** Internal process setup only; the returned data grants no admission, receipt, budget or model authority. */
export async function nativeClaudeSetup(runtime: NativeClaudeRuntime, proxyPort: number, timing: NativeTiming) {
  boundary(timing);
  const held = runtimes.get(runtime);
  if (!held || !Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) return fail('sentinel.provider.notTrusted', 'native CLI setup requires its qualified runtime');
  // Requalify exact bytes immediately before launch. A concurrent same-account host writer remains outside this boundary.
  await qualifyNativeClaude(held.executable, timing);
  boundary(timing);
  const ownedRoot = await realpath(await mkdtemp('/private/tmp/sentinel-claude-'));
  try {
  await mkdir(`${ownedRoot}/config`, { mode: 0o700 });
  boundary(timing);
  const policy = [
    '(version 1)(deny default)', '(allow process-fork)', `(allow process-exec (literal ${q(held.executable)}))`,
    '(allow process-info* (target same-sandbox))(allow signal (target same-sandbox))(allow sysctl-read)',
    `(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple") (literal ${q(held.executable)}) (subpath ${q(ownedRoot)}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`,
    '(allow file-read-metadata (vnode-type DIRECTORY))(allow file-write* (literal "/dev/null"))',
    '(allow mach-priv-task-port (target same-sandbox))(allow user-preference-read)',
    '(allow mach-lookup (global-name "com.apple.logd") (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
    `(allow network-outbound (remote ip "localhost:${proxyPort}"))`,
  ].join('\n');
  // Construct, never merge, the environment. No native keychain/home/config/env credential or alternate provider.
  const env = Object.freeze({ PATH: '/usr/bin:/bin', HOME: ownedRoot, CLAUDE_CONFIG_DIR: `${ownedRoot}/config`, TMPDIR: ownedRoot,
    TERM: 'dumb', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3',
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '' });
  const setup = Object.freeze({ executable: held.executable, policy, env, ownedRoot });
  setups.set(setup, ownedRoot);
  return setup;
  } catch (error) { await rm(ownedRoot, { recursive: true, force: true }); throw error; }
}

const setups = new WeakMap<object, string>();
export async function cleanupNativeClaudeSetup(setup: object): Promise<void> {
  const root = setups.get(setup); if (!root) return; setups.delete(setup);
  await rm(root, { recursive: true, force: true });
}


export function nativeRuntimeHelper(runtime: NativeClaudeRuntime): NativeHelper {
  const held = runtimes.get(runtime); if (!held) return fail('sentinel.provider.notTrusted', 'native runtime is not qualified'); return held.helper;
}

/** First installed fixed basename only; no command execution, alternate candidates or model/credential probe. */
export async function qualifyInstalledNativeClaude(timing: NativeTiming): Promise<NativeClaudeRuntime> {
  boundary(timing);
  const path = process.env.PATH ?? '';
  const dirs = path.split(':');
  if (path.length > 8192 || dirs.length > 32 || dirs.some(d => !isAbsolute(d))) return fail('sentinel.provider.capabilityUntested', 'native installed path is outside fixed discovery bounds');
  for (const dir of dirs) {
    boundary(timing); const candidate = join(dir, 'claude');
    try { await lstat(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return fail('sentinel.provider.capabilityUntested', 'first native CLI candidate unavailable'); }
    return qualifyNativeClaude(candidate, timing);
  }
  return fail('sentinel.provider.capabilityUntested', 'fixed native CLI is not installed');
}
